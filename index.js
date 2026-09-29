import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB, Product, Category, User, Transaction, AuthUser, WebUser, getProductList, Order, OrderItem, PaymentGatewaySetting, takeProductAccount, ProductStock, SmtpSetting } from "./database.js";
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

// ======== ORDER PROCESS ROUTES ========
app.get("/api/orders/:id", async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ error: "Order not found" });

        // Access Control Logic
        let hasAccess = false;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
                const token = authHeader.split(" ")[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
                if (decoded.is_admin || (order.userId && order.userId.toString() === decoded.id)) {
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

        const items = await OrderItem.find({ orderId: order._id });
        
        // Populate products and stocks
        const enrichedItems = await Promise.all(items.map(async item => {
            const product = await Product.findOne({ productId: item.productId }) || await Product.findById(item.productId).catch(() => null);
            let stockContent = null;
            if (item.stockId) {
                const stock = await ProductStock.findById(item.stockId);
                if (stock) stockContent = stock.accountData;
            }
            return {
                ...item.toObject(),
                id: item._id,
                price: item.priceAtTime,
                product_id: item.productId,
                stock_id: item.stockId,
                products: product ? { name: product.name, login_instructions: product.loginInstructions || product.desc } : null,
                product_stocks: stockContent ? { content: stockContent } : null
            };
        }));

        const o = order.toObject();
        res.json({ 
            ...o, 
            id: o._id, 
            user_id: o.userId,
            guest_email: o.guestEmail,
            isGuest: o.isGuest,
            total_price: o.totalPrice, 
            payment_url: o.paymentUrl, 
            payment_reference: o.paymentReference, 
            created_at: o.createdAt,
            items: enrichedItems 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/orders/:id/create-payment", async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ error: "Order not found" });
        if (order.status !== 'pending') return res.status(400).json({ error: "Order is not pending" });
        if (order.paymentUrl && order.paymentUrl !== "MOCK_QRIS_URL_FOR_NOW") {
            return res.json({ success: true, paymentUrl: order.paymentUrl, paymentReference: order.paymentReference, totalPrice: order.totalPrice });
        }

        const setting = await PaymentGatewaySetting.findOne({ is_active: true });
        const gateway = setting ? setting.gateway_name : 'tokopay';

        let paymentUrl = null;
        let paymentReference = order._id.toString();

        if (gateway === 'tokopay') {
            const mId = setting?.settings?.merchant_id || process.env.TOKOPAY_MERCHANT;
            const sKey = setting?.settings?.secret_key || process.env.TOKOPAY_SECRET;
            if (mId && sKey) {
                const url = `https://api.tokopay.id/v1/order?merchant=${mId}&secret=${sKey}&ref_id=${order._id}&nominal=${order.totalPrice}`;
                const { data } = await axios.get(url);
                if (data.status === 'Success' && data.data?.qr_link) {
                    paymentUrl = data.data.qr_link;
                    paymentReference = data.data.trx_id;
                    if (data.data.total_pay) {
                        order.totalPrice = Number(data.data.total_pay);
                    } else if (data.data.amount) {
                        order.totalPrice = Number(data.data.amount);
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
                        order.totalPrice = Number(responseData.amount);
                    } else if (responseData.total_amount) {
                        order.totalPrice = Number(responseData.total_amount);
                    } else if (responseData.total_pay) {
                        order.totalPrice = Number(responseData.total_pay);
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
                            order_id: order._id.toString(),
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
                            order.totalPrice = Number(responseData.total_amount);
                        }
                    }
                } catch (apiErr) {
                    console.error('KitaQris create-payment error:', apiErr.response?.data || apiErr.message);
                }
            }
        }

        order.paymentUrl = paymentUrl || "MOCK_QRIS_URL_FOR_NOW";
        order.paymentReference = paymentReference;
        await order.save();

        res.json({ success: true, paymentUrl: order.paymentUrl, paymentReference: order.paymentReference, totalPrice: order.totalPrice });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/orders/:id/check-payment", async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ error: "Order not found" });
        if (order.status === 'completed' || order.status === 'paid') return res.json({ status: order.status });

        const setting = await PaymentGatewaySetting.findOne({ is_active: true });
        const gateway = setting ? setting.gateway_name : 'tokopay';

        let isPaid = false;
        let isExpired = false;

        if (gateway === 'tokopay') {
            const mId = setting?.settings?.merchant_id || process.env.TOKOPAY_MERCHANT;
            const sKey = setting?.settings?.secret_key || process.env.TOKOPAY_SECRET;
            if (mId && sKey) {
                const url = `https://api.tokopay.id/v1/transaction?merchant=${mId}&secret=${sKey}&ref_id=${order.paymentReference || order._id}`;
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
            order.status = 'expired';
            await order.save();
            return res.json({ status: 'expired' });
        }

        if (isPaid) {
            order.status = 'paid';
            await order.save();
            
            // ALLOCATE STOCK SECURELY
            const items = await OrderItem.find({ orderId: order._id });
            const botId = parseInt(process.env.DEFAULT_BOT_ID) || 1;
            
            for (const item of items) {
                const stocksToTake = await ProductStock.find({ productId: item.productId, isSold: false }).limit(item.quantity);
                if (stocksToTake.length >= item.quantity) {
                    const stockIds = stocksToTake.map(s => s._id);
                    await ProductStock.updateMany({ _id: { $in: stockIds } }, { $set: { isSold: true, trxRefId: order._id.toString() } });
                    item.stockId = stockIds[0]; 
                    await item.save();
                }
            }

            order.status = 'completed';
            await order.save();
            
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
                    for (const item of items) {
                        const prod = await Product.findOne({ productId: item.productId });
                        const soldStocks = await ProductStock.find({ trxRefId: order._id.toString(), productId: item.productId });
                        
                        let accountData = soldStocks.map(st => st.accountData).filter(Boolean).join('\n\n---\n\n');
                        
                        orderItemsForEmail.push({
                            name: prod ? prod.name : item.productId,
                            quantity: item.quantity,
                            price: item.priceAtTime,
                            accountData: accountData || null
                        });
                        
                        console.log(`[Order Email Debug] OrderID: ${order._id} | Item: ${prod ? prod.name : item.productId} | Account Details Found: ${soldStocks.length} | AccountData Available: ${!!accountData}`);
                    }
                    
                    const orderData = {
                        orderId: order._id.toString(),
                        date: new Date(order.createdAt).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                        totalAmount: order.totalPrice,
                        items: orderItemsForEmail,
                        recipientName
                    };
                    
                    console.log(`[Order Email Debug] Sending email to ${toEmail} for OrderID: ${order._id} with ${orderItemsForEmail.length} items.`);
                    
                    const emailResult = await sendOrderEmail(toEmail, orderData);
                    if (emailResult && emailResult.success) {
                        console.log(`[Order Email Debug] Email sent successfully for OrderID: ${order._id}`);
                        order.emailSent = true;
                        order.emailSentAt = new Date();
                        await order.save();
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
        await Order.findByIdAndUpdate(req.params.id, { status: 'cancelled' });
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
        
        // Match both guestId (session proof) and guestEmail (email proof)
        if (guestId && userEmail) {
            await Order.updateMany(
                { isGuest: true, guestId: guestId, guestEmail: userEmail }, 
                { $set: { userId: userId, isGuest: false } }
            );
        } else if (guestId) {
            await Order.updateMany(
                { isGuest: true, guestId: guestId }, 
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
        
        // Re-validate prices securely from DB
        const validatedItems = [];
        for (const item of items) {
            const product = await Product.findOne({ botId, productId: item.productId });
            if (!product) return res.status(400).json({ error: `Produk ${item.productId} tidak ditemukan` });
            
            // Check stock availability securely
            const availableStock = await ProductStock.countDocuments({ botId, productId: item.productId, isSold: false });
            if (availableStock < item.quantity) {
                return res.status(400).json({ error: `Stok untuk ${product.name} tidak mencukupi (Sisa: ${availableStock})` });
            }
            
            const itemTotal = product.price * item.quantity;
            calculatedTotal += itemTotal;
            
            validatedItems.push({
                productId: item.productId,
                quantity: item.quantity,
                priceAtTime: product.price
            });
        }
        
        // Allow unique code margin from frontend (up to 999 IDR max difference) for manual gateways
        const frontendTotal = req.body.total_price || calculatedTotal;
        const diff = frontendTotal - calculatedTotal;
        if (diff > 0 && diff <= 999) {
            calculatedTotal = frontendTotal; 
        } else if (diff !== 0) {
            // Price mismatch detected
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
        
        const order = await Order.create({
            userId: isGuest ? null : userId,
            isGuest,
            guestEmail,
            guestId,
            guestTokenHash,
            guestTokenExpires,
            totalPrice: calculatedTotal,
            status: 'pending'
        });

        const orderItemsToInsert = [];
        validatedItems.forEach(item => {
            for (let i = 0; i < item.quantity; i++) {
                orderItemsToInsert.push({
                    orderId: order._id,
                    productId: item.productId,
                    quantity: 1, // Store as individual items for stock tracking
                    priceAtTime: item.priceAtTime
                });
            }
        });

        await OrderItem.insertMany(orderItemsToInsert);

        res.json({ success: true, orderId: order._id, guestToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ======== USER ORDERS ROUTES ========
app.get('/api/orders', async (req, res) => {
    try {
        const { userId, isGuest, guestId } = req.query;
        let query = {};
        if (userId && userId !== 'undefined') query.userId = userId;
        else if (isGuest === 'true' && guestId) query.guestId = guestId;
        
        const orders = await Order.find(query).sort({ createdAt: -1 });
        const mapped = orders.map(o => {
            const obj = o.toObject();
            return { ...obj, id: obj._id, total_price: obj.totalPrice, created_at: obj.createdAt };
        });
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
app.get('/api/admin/stats', async (req, res) => {
    try {
        const productsCount = await Product.countDocuments();
        const ordersCount = await Order.countDocuments();
        const revenueAgg = await Order.aggregate([
            { $match: { status: { $in: ['paid', 'completed'] } } },
            { $group: { _id: null, total: { $sum: '$totalPrice' } } }
        ]);
        const pendingCount = await Order.countDocuments({ status: 'pending' });
        const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(5);

        res.json({
            products: productsCount,
            orders: ordersCount,
            revenue: revenueAgg[0]?.total || 0,
            pending: pendingCount,
            recentOrders
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


