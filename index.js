import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB, Product, Category, User, Transaction, AuthUser, WebUser, getProductList, PaymentGatewaySetting, takeProductAccount, ProductStock, SmtpSetting } from "./database.js";
import { getTransporter, testSmtpConnection, sendOrderEmail } from "./mailer.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import axios from "axios";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Alias middleware for Koyeb: if Koyeb strips '/api', this restores it.
app.use((req, res, next) => {
    if (!req.url.startsWith('/api') && !req.url.startsWith('/health') && req.url !== '/') {
        req.url = '/api' + req.url;
    }
    next();
});

const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL
);

connectDB().then(() => console.log("MongoDB Connected")).catch(console.error);

// ======== HELPER ========
const generateQRIS = (qrisString, amount) => {
    return `${qrisString}`; 
};

const mapTransactionsToOrder = (transactions) => {
    if (!transactions || transactions.length === 0) return null;
    const first = transactions[0];
    const items = transactions.map(t => ({
        id: t._id,
        productId: t.productId,
        quantity: t.quantity,
        priceAtTime: t.price,
        stockId: t.stockIds && t.stockIds.length > 0 ? t.stockIds[0] : null,
        products: { name: t.productName } // basic mapping, can be enriched
    }));
    const totalPrice = transactions.reduce((sum, t) => sum + t.totalAmount, 0);
    
    return {
        _id: first.orderId,
        id: first.orderId,
        userId: first.userId,
        user_id: first.userId,
        guestEmail: first.guestEmail,
        guest_email: first.guestEmail,
        isGuest: first.isGuest,
        totalPrice: totalPrice,
        total_price: totalPrice,
        paymentUrl: first.paymentUrl,
        payment_url: first.paymentUrl,
        paymentReference: first.paymentReference,
        payment_reference: first.paymentReference,
        createdAt: first.createdAt,
        created_at: first.createdAt,
        status: first.status,
        guestTokenHash: first.guestTokenHash,
        guestTokenExpires: first.guestTokenExpires,
        emailSent: first.emailSent,
        items: items
    };
};

// ======== ORDER PROCESS ROUTES ========
app.get("/api/orders/:id", async (req, res) => {
    try {
        const transactions = await Transaction.find({ orderId: req.params.id });
        if (!transactions || transactions.length === 0) return res.status(404).json({ error: "Order not found" });

        const order = mapTransactionsToOrder(transactions);

        // Access Control Logic
        let hasAccess = false;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
                const token = authHeader.split(" ")[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
                if (decoded.is_admin || (order.user_id && order.user_id.toString() === decoded.id)) {
                    hasAccess = true;
                }
            } catch (err) {
                // Ignore JWT error and fallback to guest token
            }
        }

        if (!hasAccess && order.isGuest) {
            const { guestToken } = req.query;
            if (guestToken && order.guestTokenHash) {
                const isMatch = await bcrypt.compare(guestToken, order.guestTokenHash);
                if (isMatch) {
                    if (order.guestTokenExpires && order.guestTokenExpires > new Date()) {
                        hasAccess = true;
                    } else {
                        return res.status(403).json({ error: "Akses transaksi telah berakhir", expired: true });
                    }
                }
            }
        }

        if (!hasAccess) {
            return res.status(403).json({ error: "Akses Ditolak", expired: order.isGuest });
        }

        // Enrich items with product & stock details
        const enrichedItems = await Promise.all(transactions.map(async item => {
            const product = await Product.findOne({ productId: item.productId }) || await Product.findById(item.productId).catch(() => null);
            let stockContent = null;
            if (item.stockIds && item.stockIds.length > 0) {
                const stock = await ProductStock.findById(item.stockIds[0]);
                if (stock) stockContent = stock.accountData;
            }
            return {
                id: item._id,
                quantity: item.quantity,
                price: item.price,
                product_id: item.productId,
                stock_id: item.stockIds && item.stockIds.length > 0 ? item.stockIds[0] : null,
                products: product ? { name: product.name, login_instructions: product.loginInstructions || product.desc } : { name: item.productName },
                product_stocks: stockContent ? { content: stockContent } : null
            };
        }));

        res.json({ 
            ...order,
            items: enrichedItems 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/orders/:id/create-payment", async (req, res) => {
    try {
        const transactions = await Transaction.find({ orderId: req.params.id });
        if (!transactions || transactions.length === 0) return res.status(404).json({ error: "Order not found" });
        const order = mapTransactionsToOrder(transactions);
        if (order.status !== 'pending') return res.status(400).json({ error: "Order is not pending" });
        if (order.paymentUrl && order.paymentUrl !== "MOCK_QRIS_URL_FOR_NOW") {
            return res.json({ success: true, paymentUrl: order.paymentUrl, paymentReference: order.paymentReference, totalPrice: order.totalPrice });
        }

        const setting = await PaymentGatewaySetting.findOne({ is_active: true });
        const gateway = setting ? setting.gateway_name : 'tokopay';

        let paymentUrl = null;
        let paymentReference = order.id.toString();
        let newTotalPrice = order.totalPrice;

        if (gateway === 'tokopay') {
            const mId = setting?.settings?.merchant_id || process.env.TOKOPAY_MERCHANT;
            const sKey = setting?.settings?.secret_key || process.env.TOKOPAY_SECRET;
            if (mId && sKey) {
                const url = `https://api.tokopay.id/v1/order?merchant=${mId}&secret=${sKey}&ref_id=${order.id}&nominal=${order.totalPrice}`;
                const { data } = await axios.get(url);
                if (data.status === 'Success' && data.data?.qr_link) {
                    paymentUrl = data.data.qr_link;
                    paymentReference = data.data.trx_id;
                    if (data.data.total_pay) {
                        newTotalPrice = Number(data.data.total_pay);
                    } else if (data.data.amount) {
                        newTotalPrice = Number(data.data.amount);
                    }
                }
            }
        } else if (gateway === 'orderkuota') {
            const qString = setting?.settings?.qris_string;
            if (qString) {
                paymentUrl = generateQRIS(qString, order.totalPrice); 
            }
        } else if (gateway === 'kazepay') {
            const apiId = setting?.settings?.api_id || process.env.KAZEPAY_API_ID;
            const apiKey = setting?.settings?.api_key || process.env.KAZEPAY_API_KEY;
            if (apiId && apiKey) {
                try {
                    const response = await axios.post(
                        'https://kazepay-api.vercel.app/api/deposit',
                        { amount: order.totalPrice },
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                'x-api-id': apiId,
                                'x-api-key': apiKey,
                            },
                        }
                    );
                    const responseData = response.data.data || response.data;
                    paymentUrl = responseData.qr_string || responseData.qr_url || responseData.qr_image || responseData.qr_link || responseData.qris_url || responseData.qris || responseData.qris_string;
                    paymentReference = responseData.ref_id || responseData.reference_id || responseData.trx_id;
                    if (responseData.amount) {
                        newTotalPrice = Number(responseData.amount);
                    } else if (responseData.total_amount) {
                        newTotalPrice = Number(responseData.total_amount);
                    } else if (responseData.total_pay) {
                        newTotalPrice = Number(responseData.total_pay);
                    }
                } catch (apiErr) {
                    console.error('KazePay create-payment error:', apiErr.response?.data || apiErr.message);
                }
            }
        } else if (gateway === 'kitaqris') {
            const merchantId = setting?.settings?.merchant_id || process.env.KITAQRIS_MERCHANT_ID || "178753767150";
            const apiKey = setting?.settings?.api_key || process.env.KITAQRIS_API_KEY || "DsuTmOfKxaQ7Uwt5RVar7Y9gJ5iWhPVxvYtQ8ZM0";
            if (merchantId && apiKey) {
                try {
                    const response = await axios.post(
                        'https://klikqris.com/api/qris/create',
                        {
                            order_id: order.id.toString(),
                            amount: order.totalPrice,
                            id_merchant: merchantId
                        },
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                'x-api-key': apiKey,
                                'id_merchant': merchantId
                            }
                        }
                    );
                    const responseData = response.data.data;
                    if (response.data.status && responseData) {
                        paymentUrl = responseData.qris_url || responseData.qris_image;
                        paymentReference = responseData.order_id;
                        if (responseData.total_amount) {
                            newTotalPrice = Number(responseData.total_amount);
                        }
                    }
                } catch (apiErr) {
                    console.error('KitaQris create-payment error:', apiErr.response?.data || apiErr.message);
                }
            }
        }

        paymentUrl = paymentUrl || "MOCK_QRIS_URL_FOR_NOW";
        
        await Transaction.updateMany(
            { orderId: req.params.id },
            { 
                $set: { 
                    paymentUrl, 
                    paymentReference 
                } 
            }
        );
        // Note: we don't update individual transaction totalAmount if the total gateway amount slightly differs to avoid complexity. 
        // We just return the newTotalPrice for UI.

        res.json({ success: true, paymentUrl, paymentReference, totalPrice: newTotalPrice });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/orders/:id/check-payment", async (req, res) => {
    try {
        const transactions = await Transaction.find({ orderId: req.params.id });
        if (!transactions || transactions.length === 0) return res.status(404).json({ error: "Order not found" });
        const order = mapTransactionsToOrder(transactions);

        if (order.status === 'completed' || order.status === 'paid') return res.json({ status: order.status });

        const setting = await PaymentGatewaySetting.findOne({ is_active: true });
        const gateway = setting ? setting.gateway_name : 'tokopay';

        let isPaid = false;
        let isExpired = false;

        if (gateway === 'tokopay') {
            const mId = setting?.settings?.merchant_id || process.env.TOKOPAY_MERCHANT;
            const sKey = setting?.settings?.secret_key || process.env.TOKOPAY_SECRET;
            if (mId && sKey) {
                const url = `https://api.tokopay.id/v1/transaction?merchant=${mId}&secret=${sKey}&ref_id=${order.paymentReference || order.id}`;
                const { data } = await axios.get(url);
                if (data.status === 'Success' && data.data) {
                    const st = data.data.status?.toLowerCase();
                    isPaid = st === 'success' || st === 'paid';
                    isExpired = st === 'expired' || st === 'failed';
                }
            } else {
                isPaid = true; 
            }
        } else if (gateway === 'kazepay') {
            const apiId = setting?.settings?.api_id || process.env.KAZEPAY_API_ID;
            const apiKey = setting?.settings?.api_key || process.env.KAZEPAY_API_KEY;
            if (apiId && apiKey && order.paymentReference) {
                try {
                    const response = await axios.get('https://kazepay-api.vercel.app/api/deposit', {
                        params: { ref_id: order.paymentReference },
                        headers: {
                            'x-api-id': apiId,
                            'x-api-key': apiKey,
                        },
                    });
                    const responseData = response.data.data || response.data;
                    const st = responseData.status?.toLowerCase();
                    isPaid = st === 'success' || st === 'paid' || st === 'settlement';
                    isExpired = st === 'expired' || st === 'failed' || st === 'cancel';
                } catch (apiErr) {
                    console.error('KazePay check-payment error:', apiErr.response?.data || apiErr.message);
                }
            } else {
                isPaid = true; // MOCK if no credentials
            }
        } else if (gateway === 'kitaqris') {
            const merchantId = setting?.settings?.merchant_id || process.env.KITAQRIS_MERCHANT_ID || "178753767150";
            const apiKey = setting?.settings?.api_key || process.env.KITAQRIS_API_KEY || "DsuTmOfKxaQ7Uwt5RVar7Y9gJ5iWhPVxvYtQ8ZM0";
            if (merchantId && apiKey && order.paymentReference) {
                try {
                    const response = await axios.get(`https://klikqris.com/api/qris/status/${order.paymentReference}`, {
                        headers: {
                            'x-api-key': apiKey,
                            'id_merchant': merchantId
                        }
                    });
                    const responseData = response.data.data;
                    if (response.data.status && responseData) {
                        const st = responseData.status?.toLowerCase();
                        isPaid = st === 'success' || st === 'paid' || st === 'settlement';
                        isExpired = st === 'expired' || st === 'failed' || st === 'cancel';
                    }
                } catch (apiErr) {
                    console.error('KitaQris check-payment error:', apiErr.response?.data || apiErr.message);
                }
            } else {
                isPaid = true; // MOCK if no credentials
            }
        } else {
             isPaid = true; 
        }

        if (isExpired) {
            await Transaction.updateMany({ orderId: req.params.id }, { $set: { status: 'expired' } });
            return res.json({ status: 'expired' });
        }

        if (isPaid) {
            // ALLOCATE STOCK SECURELY
            const botId = parseInt(process.env.DEFAULT_BOT_ID) || 1;
            
            for (const item of transactions) {
                // If this item was not already allocated
                if (!item.stockIds || item.stockIds.length === 0) {
                    const result = await takeProductAccount(botId, item.productId, item.quantity, req.params.id);
                    if (result.success) {
                        // find the allocated stock ids for this trxRefId to store in Transaction
                        const allocatedStocks = await ProductStock.find({ trxRefId: req.params.id, productId: item.productId });
                        const stockIds = allocatedStocks.map(s => s._id);
                        await Transaction.findByIdAndUpdate(item._id, {
                            $set: { stockIds: stockIds }
                        });
                    }
                }
            }

            await Transaction.updateMany({ orderId: req.params.id }, { $set: { status: 'completed' } });
            
            // Send Email Notification Idempotently
            if (!order.emailSent) {
                let toEmail = order.isGuest ? order.guestEmail : null;
                let recipientName = "Pelanggan";
                if (!order.isGuest && order.userId) {
                    const wUser = await WebUser.findById(order.userId);
                    if (wUser && wUser.email) {
                        toEmail = wUser.email;
                        recipientName = wUser.name;
                    }
                }
                
                if (toEmail) {
                    let orderItemsForEmail = [];
                    for (const item of transactions) {
                        const prod = await Product.findOne({ productId: item.productId });
                        const soldStocks = await ProductStock.find({ trxRefId: req.params.id, productId: item.productId });
                        
                        let accountData = soldStocks.map(st => st.accountData).filter(Boolean).join('\n\n---\n\n');
                        
                        orderItemsForEmail.push({
                            name: prod ? prod.name : item.productName,
                            quantity: item.quantity,
                            price: item.price,
                            accountData: accountData || null
                        });
                        
                        console.log(`[Order Email Debug] OrderID: ${req.params.id} | Item: ${prod ? prod.name : item.productId} | Account Details Found: ${soldStocks.length} | AccountData Available: ${!!accountData}`);
                    }
                    
                    const orderData = {
                        orderId: req.params.id,
                        date: new Date(order.createdAt).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                        totalAmount: order.totalPrice,
                        items: orderItemsForEmail,
                        recipientName
                    };
                    
                    console.log(`[Order Email Debug] Sending email to ${toEmail} for OrderID: ${req.params.id} with ${orderItemsForEmail.length} items.`);
                    
                    const emailResult = await sendOrderEmail(toEmail, orderData);
                    if (emailResult && emailResult.success) {
                        console.log(`[Order Email Debug] Email sent successfully for OrderID: ${req.params.id}`);
                        await Transaction.updateMany({ orderId: req.params.id }, { $set: { emailSent: true, emailSentAt: new Date() } });
                    } else {
                        console.error("Gagal mengirim email notifikasi:", emailResult ? emailResult.error : 'Unknown');
                    }
                }
            }

            return res.json({ status: 'completed' });
        }

        res.json({ status: order.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/orders/:id/cancel", async (req, res) => {
    try {
        await Transaction.updateMany({ orderId: req.params.id }, { $set: { status: 'cancelled' } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======== AUTH ROUTES ========
app.post("/api/auth/login", async (req, res) => {
    try {
        const { identifier, password } = req.body;
        const isEmail = identifier.includes('@');
        const query = isEmail ? { email: identifier } : { phone: identifier };
        
        const user = await WebUser.findOne(query);
        if (!user) return res.status(401).json({ error: "Akun tidak ditemukan" });

        const isMatch = await user.comparePassword(password);
        if (!isMatch) return res.status(401).json({ error: "Password salah" });

        const token = jwt.sign({ id: user._id, is_admin: user.is_admin }, process.env.JWT_SECRET || "secret", { expiresIn: "7d" });
        res.json({ token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, is_admin: user.is_admin } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/auth/register", async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;
        
        const existingPhone = await WebUser.findOne({ phone });
        if (existingPhone) return res.status(400).json({ error: "Nomor HP sudah terdaftar" });

        const existingEmail = await WebUser.findOne({ email });
        if (existingEmail && email) return res.status(400).json({ error: "Email sudah terdaftar" });

        const user = await WebUser.create({ name, email, phone, password, is_admin: false });
        const token = jwt.sign({ id: user._id, is_admin: user.is_admin }, process.env.JWT_SECRET || "secret", { expiresIn: "7d" });
        
        res.json({ token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, is_admin: user.is_admin } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/auth/google", (req, res) => {
    const url = googleClient.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email"],
    });
    res.redirect(url);
});

app.get("/api/auth/google/callback", async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) {
              return res.redirect(`${process.env.FRONTEND_URL || "http://localhost:8080"}/auth?error=GoogleAuthFailed`);
        }

        const { tokens } = await googleClient.getToken(code);
        const ticket = await googleClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        
        let user = await WebUser.findOne({ googleId: payload.sub });
        
        if (!user) {
            user = await WebUser.findOne({ email: payload.email });
            if (user) {
                user.googleId = payload.sub;
                await user.save();
            } else {
                user = await WebUser.create({
                    name: payload.name,
                    email: payload.email,
                    googleId: payload.sub,
                    is_admin: false,
                    phone: undefined,
                    password: undefined,
                });
            }
        }

        const token = jwt.sign({ id: user._id, is_admin: user.is_admin }, process.env.JWT_SECRET || "secret", { expiresIn: "7d" });
        
        const userData = {
            id: user._id,
            name: user.name,
            email: user.email,
            phone: user.phone || "",
            is_admin: user.is_admin
        };
        const encodedUser = encodeURIComponent(JSON.stringify(userData));
        
        res.redirect(`${process.env.FRONTEND_URL || "http://localhost:8080"}/auth/callback?token=${token}&user=${encodedUser}`);
      } catch (err) {
          console.error("Google OAuth error:", err);
          res.redirect(`${process.env.FRONTEND_URL || "http://localhost:8080"}/auth?error=GoogleAuthFailed`);
      }
});

app.post("/api/auth/merge-guest", async (req, res) => {
    try {
        const { userId, guestId, userEmail } = req.body;
        
        if (guestId && userEmail) {
            await Transaction.updateMany(
                { isGuest: true, guestId: guestId, guestEmail: userEmail, source: "website" }, 
                { $set: { userId: userId, isGuest: false } }
            );
        } else if (guestId) {
            await Transaction.updateMany(
                { isGuest: true, guestId: guestId, source: "website" }, 
                { $set: { userId: userId, isGuest: false } }
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======== PRODUCT ROUTES ========
app.get("/api/products", async (req, res) => {
    try {
        const botId = parseInt(req.query.botId) || parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const result = await getProductList(botId);
        if (result.success) {
            // Map to frontend expected format
            const mapped = result.data.map(p => ({
                id: p.productId,
                name: p.name,
                description: p.desc,
                price: p.price,
                stock: p.stock,
                category: p.category,
                image_url: p.image_url,
                original_price: p.original_price,
                login_instructions: p.login_instructions,
                min_order: p.min_order,
                max_order: p.max_order
            }));
            res.json(mapped);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/categories", async (req, res) => {
    try {
        const botId = parseInt(req.query.botId) || parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const categories = await Category.find({ botId }).sort({ sort_order: 1 }).lean();
        
        // Enrich with product data
        const products = await Product.find({ botId }).sort({ sort_order: 1 }).lean();
        const stockAgg = await ProductStock.aggregate([
            { $match: { botId, isSold: false } },
            { $group: { _id: "$productId", count: { $sum: 1 } } }
        ]);
        const stockMap = {};
        stockAgg.forEach(s => stockMap[s._id] = s.count);
        
        const result = categories.map(cat => {
            // Because products are already sorted by sort_order: 1, 
            // the filtered list will maintain this order.
            const catProducts = products.filter(p => cat.products && cat.products.includes(p.productId)).map(p => ({
                id: p.productId,
                name: p.name,
                description: p.desc,
                price: p.price,
                stock: stockMap[p.productId] || 0,
                original_price: p.original_price,
                login_instructions: p.login_instructions,
                min_order: p.min_order,
                max_order: p.max_order,
                sort_order: p.sort_order || 0
            }));
            
            const totalStock = catProducts.reduce((sum, p) => sum + p.stock, 0);
            const startingPrice = catProducts.length > 0 ? Math.min(...catProducts.map(p => p.price)) : 0;
            
            return {
                id: cat._id,
                name: cat.name,
                image_url: cat.image_url || null,
                sort_order: cat.sort_order || 0,
                total_stock: totalStock,
                starting_price: startingPrice,
                variants_count: catProducts.length,
                products: catProducts
            };
        });
        
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======== STOCK ROUTES ========
app.get("/api/stock/:productId", async (req, res) => {
    try {
        const { productId } = req.params;
        const botId = parseInt(req.query.botId) || parseInt(process.env.DEFAULT_BOT_ID) || 1;
        const stockCount = await ProductStock.countDocuments({ botId, productId, isSold: false });
        res.json({ stock: stockCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======== SETTINGS ROUTES ========
app.get("/api/settings/payment-gateway", async (req, res) => {
    try {
        const settings = await PaymentGatewaySetting.find();
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======== ORDER ROUTES ========
app.post("/api/orders", async (req, res) => {
    try {
        const { userId, isGuest, guestEmail, guestId, items } = req.body;
        
        let calculatedTotal = 0;
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        
        const validatedItems = [];
        for (const item of items) {
            const product = await Product.findOne({ botId, productId: item.productId });
            if (!product) return res.status(400).json({ error: `Produk ${item.productId} tidak ditemukan` });
            
            const availableStock = await ProductStock.countDocuments({ botId, productId: item.productId, isSold: false });
            if (availableStock < item.quantity) {
                return res.status(400).json({ error: `Stok untuk ${product.name} tidak mencukupi (Sisa: ${availableStock})` });
            }
            
            const itemTotal = product.price * item.quantity;
            calculatedTotal += itemTotal;
            
            validatedItems.push({
                productId: item.productId,
                productName: product.name,
                quantity: item.quantity,
                price: product.price,
                totalAmount: itemTotal
            });
        }
        
        const frontendTotal = req.body.total_price || calculatedTotal;
        const diff = frontendTotal - calculatedTotal;
        if (diff > 0 && diff <= 999) {
            calculatedTotal = frontendTotal; 
            // adjust totalAmount of the first item to match frontend exact total
            validatedItems[0].totalAmount += diff;
        } else if (diff !== 0) {
            return res.status(400).json({ error: "Terjadi ketidaksesuaian harga dengan database. Silakan muat ulang halaman." });
        }
        
        let guestToken = null;
        let guestTokenHash = null;
        let guestTokenExpires = null;
        
        if (isGuest) {
            guestToken = crypto.randomBytes(32).toString("hex");
            guestTokenHash = await bcrypt.hash(guestToken, 10);
            guestTokenExpires = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3 hours
        }

        const newOrderId = `ORD-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        
        const transactionsToInsert = [];
        for (let i = 0; i < validatedItems.length; i++) {
            const item = validatedItems[i];
            for (let j = 0; j < item.quantity; j++) {
                transactionsToInsert.push({
                    userId: isGuest ? null : userId,
                    botId,
                    productId: item.productId,
                    productName: item.productName,
                    quantity: 1,
                    price: item.price,
                    totalAmount: item.price,
                    status: 'pending',
                    reffId: `${newOrderId}-${i}-${j}`,
                    source: 'website',
                    orderId: newOrderId,
                    isGuest,
                    guestEmail,
                    guestId,
                    guestTokenHash,
                    guestTokenExpires,
                    paymentMethod: 'qris'
                });
            }
        }
        // Apply frontend total diff to the very first item if any
        if (diff > 0 && diff <= 999 && transactionsToInsert.length > 0) {
            transactionsToInsert[0].totalAmount += diff;
        }

        await Transaction.insertMany(transactionsToInsert);

        res.json({ success: true, orderId: newOrderId, guestToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ======== USER ORDERS ROUTES ========
app.get('/api/orders', async (req, res) => {
    try {
        const { userId, isGuest, guestId } = req.query;
        let query = { source: 'website' };
        if (userId && userId !== 'undefined') query.userId = userId;
        else if (isGuest === 'true' && guestId) query.guestId = guestId;
        
        // Find distinct orders
        const transactions = await Transaction.find(query).sort({ createdAt: -1 });
        
        // Group by orderId
        const orderMap = {};
        for (const t of transactions) {
            if (!orderMap[t.orderId]) orderMap[t.orderId] = [];
            orderMap[t.orderId].push(t);
        }
        
        const mapped = Object.values(orderMap).map(grouped => mapTransactionsToOrder(grouped)).filter(Boolean);
        // Sort by created_at desc
        mapped.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
        res.json(mapped);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======== SMTP SETTINGS ========
app.get('/api/admin/smtp', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        if (!decoded.is_admin) return res.status(403).json({ error: "Forbidden" });

        const setting = await SmtpSetting.findOne({});
        if (!setting) {
            return res.json({ configured: false });
        }
        res.json({
            configured: true,
            email: setting.email,
            host: setting.host,
            port: setting.port,
            secure: setting.secure
            // Never send the password back!
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/smtp', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        if (!decoded.is_admin) return res.status(403).json({ error: "Forbidden" });

        const { email, password, host, port, secure } = req.body;
        let setting = await SmtpSetting.findOne({});
        if (setting) {
            setting.email = email;
            if (password && password.trim() !== "") {
                setting.password = password;
            }
            setting.host = host || 'smtp.gmail.com';
            setting.port = port || 465;
            setting.secure = secure !== undefined ? secure : true;
            await setting.save();
        } else {
            if (!password) return res.status(400).json({ error: "Password is required for new setup" });
            setting = await SmtpSetting.create({
                email, password,
                host: host || 'smtp.gmail.com',
                port: port || 465,
                secure: secure !== undefined ? secure : true
            });
        }
        res.json({ success: true, message: "Pengaturan SMTP berhasil disimpan" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/smtp/test', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        if (!decoded.is_admin) return res.status(403).json({ error: "Forbidden" });

        const { email, password, host, port, secure } = req.body;
        const configToTest = {
            email, host, port, secure
        };

        if (password && password.trim() !== "") {
            configToTest.password = password;
        } else {
            const setting = await SmtpSetting.findOne({});
            if (!setting) return res.status(400).json({ error: "Password SMTP belum dikonfigurasi" });
            configToTest.password = setting.password;
        }

        const result = await testSmtpConnection(configToTest);
        if (result.success) {
            res.json({ success: true, message: "Koneksi SMTP berhasil" });
        } else {
            res.status(400).json({ error: "Gagal terhubung ke SMTP: " + result.error });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/smtp/send-test', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        if (!decoded.is_admin) return res.status(403).json({ error: "Forbidden" });

        const { testEmail } = req.body;
        if (!testEmail) return res.status(400).json({ error: "Email percobaan diperlukan" });

        const transporter = await getTransporter();
        if (!transporter) return res.status(400).json({ error: "SMTP belum dikonfigurasi" });

        const setting = await SmtpSetting.findOne({});
        await transporter.sendMail({
            from: `"Admin" <${setting.email}>`,
            to: testEmail,
            subject: "Test Koneksi Email",
            text: "Ini adalah email percobaan untuk memastikan SMTP berfungsi."
        });

        res.json({ success: true, message: "Email percobaan berhasil dikirim" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ======== ADMIN ROUTES ========
app.get('/api/admin/transactions', async (req, res) => {
    try {
        const transactions = await Transaction.find().sort({ createdAt: -1 }).limit(500); // Batasi 500 untuk performa admin list
        res.json(transactions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const productsCount = await Product.countDocuments();
        
        // --- ALL STATS ---
        const allTransactions = await Transaction.find();
        
        let website = {
            orders: 0, revenue: 0, pending: 0, completed: 0, items_sold: 0
        };
        let telegram = {
            orders: 0, revenue: 0, pending: 0, completed: 0, items_sold: 0
        };
        
        // Helper to count orders for web based on unique orderId
        const webOrderIds = new Set();
        
        for (const t of allTransactions) {
            const isWeb = t.source === 'website';
            const stat = isWeb ? website : telegram;
            
            if (isWeb && t.orderId) {
                if (!webOrderIds.has(t.orderId)) {
                    webOrderIds.add(t.orderId);
                    stat.orders++;
                    if (t.status === 'pending') stat.pending++;
                    if (t.status === 'completed' || t.status === 'paid') stat.completed++;
                }
                // we aggregate revenue/items on every row
                if (t.status === 'completed' || t.status === 'paid') {
                    stat.revenue += t.totalAmount;
                    stat.items_sold += t.quantity;
                }
            } else {
                // Telegram (1 row = 1 transaction)
                stat.orders++;
                if (t.status === 'pending') stat.pending++;
                if (t.status === 'completed' || t.status === 'paid') stat.completed++;
                if (t.status === 'completed' || t.status === 'paid') {
                    stat.revenue += t.totalAmount;
                    stat.items_sold += t.quantity;
                }
            }
        }
        
        // Recent web orders (grouped)
        const recentWebRows = await Transaction.find({ source: 'website' }).sort({ createdAt: -1 }).limit(100);
        const orderGroups = {};
        for (const r of recentWebRows) {
            if (!r.orderId) continue;
            if (!orderGroups[r.orderId]) {
                orderGroups[r.orderId] = {
                    id: r.orderId,
                    userId: r.userId,
                    totalPrice: 0,
                    status: r.status,
                    createdAt: r.createdAt
                };
            }
            orderGroups[r.orderId].totalPrice += r.totalAmount;
        }
        
        const recentWebOrders = Object.values(orderGroups)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 5);

        res.json({
            products: productsCount,
            website,
            telegram,
            total: {
                orders: website.orders + telegram.orders,
                revenue: website.revenue + telegram.revenue,
                pending: website.pending + telegram.pending,
                completed: website.completed + telegram.completed,
                items_sold: website.items_sold + telegram.items_sold
            },
            recentOrders: recentWebOrders
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/categories/reorder', async (req, res) => {
    try {
        const { order } = req.body; // Array of { id: categoryId, sort_order: index }
        for (const item of order) {
            await Category.findByIdAndUpdate(item.id, { sort_order: item.sort_order });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/products/reorder', async (req, res) => {
    try {
        const { order } = req.body; // Array of { id: productId, sort_order: index }
        for (const item of order) {
            await Product.findOneAndUpdate({ productId: item.id }, { sort_order: item.sort_order });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/categories', async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const c = await Category.create({ ...req.body, botId });
        res.json(c);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/categories/:id', async (req, res) => {
    try {
        await Category.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/categories/:id', async (req, res) => {
    try {
        await Category.findByIdAndUpdate(req.params.id, req.body);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/products', async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const p = await Product.create({ ...req.body, botId });
        
        if (req.body.category) {
            await Category.findOneAndUpdate(
                { botId, name: req.body.category },
                { $addToSet: { products: p.productId } },
                { upsert: true }
            );
        }
        
        res.json(p);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/products/:id', async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const oldP = await Product.findById(req.params.id);
        const p = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
        
        if (req.body.category && oldP) {
            // Remove from all categories first
            await Category.updateMany(
                { botId },
                { $pull: { products: oldP.productId } }
            );
            // Add to new category
            await Category.findOneAndUpdate(
                { botId, name: req.body.category },
                { $addToSet: { products: p.productId } },
                { upsert: true }
            );
        }

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/products/:id', async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const p = await Product.findById(req.params.id);
        if (p) {
            await Category.updateMany(
                { botId },
                { $pull: { products: p.productId } }
            );
        }
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stocks/stats', async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const available = await ProductStock.countDocuments({ botId, isSold: false });
        const sold = await ProductStock.countDocuments({ botId, isSold: true });
        res.json({ available, sold });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stocks', async (req, res) => {
    try {
        const { productId } = req.query;
        const q = productId ? { productId } : {};
        const stocks = await ProductStock.find(q).sort({ createdAt: -1 });
        res.json(stocks);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/stocks', async (req, res) => {
    try {
        const { productId, contents } = req.body;
        const docs = contents.map(c => ({ botId: parseInt(process.env.DEFAULT_BOT_ID)||1, productId, accountData: c, isSold: false }));
        await ProductStock.insertMany(docs);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/stocks', async (req, res) => {
    try {
        await ProductStock.deleteMany({ _id: { $in: req.body.ids } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/stocks/mark-sold', async (req, res) => {
    try {
        await ProductStock.updateMany({ _id: { $in: req.body.ids } }, { $set: { isSold: true } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/payment-gateway', async (req, res) => {
    try {
        await PaymentGatewaySetting.updateMany({}, { is_active: false });
        await PaymentGatewaySetting.findOneAndUpdate(
            { gateway_name: req.body.gateway_name },
            { is_active: true, settings: req.body.settings },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings/theme', (req, res) => res.json({}));
app.post('/api/settings/theme', (req, res) => res.json({ success: true }));

// Default health check endpoint and root route
app.get('/health', (req, res) => res.json({ status: 'ok', message: 'API is running' }));
app.get('/', (req, res) => res.json({ status: 'ok', message: 'API is running. Access endpoints via /api/...' }));

// Catch-all route to help debug 404s
app.use((req, res, next) => {
    console.log(`[404] Cannot GET/POST: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => {
    console.log("Backend running on port " + PORT);
});


