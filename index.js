import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB, Product, Category, User, PaymentGatewaySetting, ProductStock, SmtpSetting, Order, Bot, DailySalesSummary, getAdminStats } from "./lib/shared-db/index.js";
import { reserveStockAtomic, processOrderPaymentSuccess } from "./lib/shared-db/services.js";
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
        const orderDoc = await Order.findOne({ orderId: req.params.id });
        if (!orderDoc) return res.status(404).json({ error: "Order not found" });

        const order = {
            _id: orderDoc.orderId,
            id: orderDoc.orderId,
            userId: orderDoc.userId,
            user_id: orderDoc.userId,
            guestEmail: orderDoc.guestEmail,
            guest_email: orderDoc.guestEmail,
            isGuest: orderDoc.isGuest,
            totalPrice: orderDoc.totalAmount,
            total_price: orderDoc.totalAmount,
            paymentUrl: orderDoc.paymentUrl,
            payment_url: orderDoc.paymentUrl,
            paymentReference: orderDoc.paymentReference,
            payment_reference: orderDoc.paymentReference,
            createdAt: orderDoc.createdAt,
            created_at: orderDoc.createdAt,
            status: orderDoc.status,
            guestTokenHash: orderDoc.guestTokenHash,
            guestTokenExpires: orderDoc.guestTokenExpires,
            emailSent: orderDoc.emailSent
        };

        // Access Control Logic
        let hasAccess = false;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
                const token = authHeader.split(" ")[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
                if (decoded.is_admin) {
                    hasAccess = true;
                } else if (order.user_id) {
                    if (order.user_id.toString() === decoded.id) {
                        hasAccess = true;
                    } else {
                        const userDoc = await User.findById(decoded.id);
                        if (userDoc && userDoc.userId === order.user_id) {
                            hasAccess = true;
                        }
                    }
                }
            } catch (err) {
                // Ignore
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

        // Enrich items
        const allStocks = await ProductStock.find({ orderId: req.params.id }).lean();
        console.log(`[DEBUG] Found ${allStocks.length} stocks for order ${req.params.id}`);
        console.log(`[DEBUG] Stocks:`, allStocks.map(s => ({ id: s._id, product: s.productId, orderId: s.orderId })));

        const enrichedItems = await Promise.all(orderDoc.items.map(async item => {
            const product = await Product.findOne({ productId: item.productId }) || await Product.findById(item.productId).catch(() => null);
            let stockContent = null;
            let stockId = null;

            const itemStocks = allStocks.filter(s => s.productId === item.productId);
            console.log(`[DEBUG] Item ${item.productId} mapped to ${itemStocks.length} stocks`);
            
            if (itemStocks.length > 0) {
                stockContent = itemStocks.map(s => s.accountData).join('\n\n---\n\n');
                stockId = itemStocks[0]._id;
            } else if (item.stockIds && item.stockIds.length > 0) {
                const stock = await ProductStock.findById(item.stockIds[0]);
                if (stock) {
                    stockContent = stock.accountData;
                    stockId = stock._id;
                }
            }
            return {
                id: item._id, // if any
                quantity: item.quantity,
                price: item.price,
                product_id: item.productId,
                stock_id: stockId,
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
        const orderDoc = await Order.findOne({ orderId: req.params.id });
        if (!orderDoc) return res.status(404).json({ error: "Order not found" });
        const order = {
            id: orderDoc.orderId,
            status: orderDoc.status,
            totalPrice: orderDoc.totalAmount,
            paymentUrl: orderDoc.paymentUrl,
            paymentReference: orderDoc.paymentReference
        };
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
            const merchantId = setting?.settings?.merchant_id || process.env.KITAQRIS_MERCHANT_ID;
            const apiKey = setting?.settings?.api_key || process.env.KITAQRIS_API_KEY;
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
        
        await Order.updateOne(
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
        const orderDoc = await Order.findOne({ orderId: req.params.id });
        if (!orderDoc) return res.status(404).json({ error: "Order not found" });

        if (orderDoc.status === 'completed' || orderDoc.status === 'paid') return res.json({ status: orderDoc.status });

        const setting = await PaymentGatewaySetting.findOne({ is_active: true });
        const gateway = setting ? setting.gateway_name : 'tokopay';

        let isPaid = false;
        let isExpired = false;

        if (gateway === 'tokopay') {
            const mId = setting?.settings?.merchant_id || process.env.TOKOPAY_MERCHANT;
            const sKey = setting?.settings?.secret_key || process.env.TOKOPAY_SECRET;
            if (mId && sKey) {
                const url = `https://api.tokopay.id/v1/transaction?merchant=${mId}&secret=${sKey}&ref_id=${orderDoc.paymentReference || orderDoc.orderId}`;
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
            if (apiId && apiKey && orderDoc.paymentReference) {
                try {
                    const response = await axios.get('https://kazepay-api.vercel.app/api/deposit', {
                        params: { ref_id: orderDoc.paymentReference },
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
                isPaid = true;
            }
        } else if (gateway === 'kitaqris') {
            const merchantId = setting?.settings?.merchant_id || process.env.KITAQRIS_MERCHANT_ID;
            const apiKey = setting?.settings?.api_key || process.env.KITAQRIS_API_KEY;
            if (merchantId && apiKey && orderDoc.paymentReference) {
                try {
                    const response = await axios.get(`https://klikqris.com/api/qris/status/${orderDoc.paymentReference}`, {
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
                isPaid = true;
            }
        } else {
             isPaid = true; 
        }

        if (isExpired) {
            await Order.updateOne({ orderId: req.params.id }, { $set: { status: 'expired' } });
            await releaseReservedStock(req.params.id);
            return res.json({ status: 'expired' });
        }

        if (isPaid) {
            const result = await processOrderPaymentSuccess(req.params.id);
            if (result.success) {
                const orderData = result.order;
                
                if (!orderData.emailSent) {
                    let toEmail = orderData.isGuest ? orderData.guestEmail : null;
                    let recipientName = "Pelanggan";
                    if (!orderData.isGuest && orderData.userId) {
                        const wUser = await User.findById(orderData.userId);
                        if (wUser && wUser.email) {
                            toEmail = wUser.email;
                            recipientName = wUser.name;
                        }
                    }
                    
                    if (toEmail) {
                        (async () => {
                            try {
                                const allAllocatedStocks = await ProductStock.find({ orderId: req.params.id });
                                const emailItemsMap = {};
                                for (const item of orderData.items) {
                                    if (!emailItemsMap[item.productId]) {
                                        emailItemsMap[item.productId] = {
                                            productId: item.productId,
                                            productName: item.productName,
                                            quantity: 0,
                                            price: item.price
                                        };
                                    }
                                    emailItemsMap[item.productId].quantity += item.quantity;
                                }
                                
                                let orderItemsForEmail = [];
                                for (const pId in emailItemsMap) {
                                    const group = emailItemsMap[pId];
                                    const prod = await Product.findOne({ productId: pId });
                                    const name = prod ? prod.name : group.productName;
                                    
                                    const productStocks = allAllocatedStocks.filter(st => st.productId === pId);
                                    const accountData = productStocks.map(st => st.accountData).filter(Boolean).join('\n\n---\n\n');
                                    
                                    orderItemsForEmail.push({
                                        name: name,
                                        quantity: group.quantity,
                                        price: group.price,
                                        accountData: accountData || null
                                    });
                                }
                                
                                const orderDataForEmail = {
                                    orderId: req.params.id,
                                    date: new Date(orderData.createdAt).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                                    totalAmount: orderData.totalAmount,
                                    items: orderItemsForEmail,
                                    recipientName
                                };
                                console.log("[EMAIL PAYLOAD TEST]", JSON.stringify(orderDataForEmail, null, 2));
                                
                                const emailResult = await sendOrderEmail(toEmail, orderDataForEmail);
                                if (emailResult && emailResult.success) {
                                    await Order.updateOne({ orderId: req.params.id }, { $set: { emailSent: true, emailSentAt: new Date() } });
                                }
                            } catch (err) {
                                console.error("[Order Email Debug] Background email error:", err.message);
                            }
                        })();
                    }
                }
                return res.json({ status: 'completed' });
            } else {
                return res.json({ status: 'paid_but_stock_failed', error: result.error });
            }
        }

        res.json({ status: orderDoc.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/orders/:id/cancel", async (req, res) => {
    try {
        await Order.updateOne({ orderId: req.params.id }, { $set: { status: 'cancelled' } });
        await releaseReservedStock(req.params.id);
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
        
        const user = await User.findOne(query);
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
        
        const existingPhone = await User.findOne({ phone });
        if (existingPhone) return res.status(400).json({ error: "Nomor HP sudah terdaftar" });

        const existingEmail = await User.findOne({ email });
        if (existingEmail && email) return res.status(400).json({ error: "Email sudah terdaftar" });

        const user = await User.create({ userId: Date.now(), isTelegram: false, name, email, phone, password, is_admin: false });
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
        
        let user = await User.findOne({ googleId: payload.sub });
        
        if (!user) {
            user = await User.findOne({ email: payload.email });
            if (user) {
                user.googleId = payload.sub;
                await user.save();
            } else {
                user = await User.create({ userId: Date.now(), isTelegram: false,
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
            await Order.updateMany(
                { isGuest: true, guestId: guestId, guestEmail: userEmail, source: "website" }, 
                { $set: { userId: userId, isGuest: false } }
            );
        } else if (guestId) {
            await Order.updateMany(
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
        const products = await Product.find({ botId }).sort({ sort_order: 1 }).lean();
        
        const categories = await Category.find({ botId }).lean();
        const stockAgg = await ProductStock.aggregate([
            { $match: { botId, status: 'available' } },
            { $group: { _id: "$productId", count: { $sum: 1 } } }
        ]);
        const stockMap = {};
        stockAgg.forEach(s => stockMap[s._id] = s.count);

        const mapped = products.map(p => {
            const cat = categories.find(c => p.categoryId && c._id.toString() === p.categoryId.toString());
            return {
                id: p.productId,
                name: p.name,
                description: p.desc,
                price: p.price,
                stock: stockMap[p.productId] || 0,
                category: cat ? cat.name : "Uncategorized",
                image_url: p.image_url,
                original_price: p.original_price,
                login_instructions: p.login_instructions,
                min_order: p.min_order,
                max_order: p.max_order
            };
        });
        res.json(mapped);
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
            { $match: { botId, status: 'available' } },
            { $group: { _id: "$productId", count: { $sum: 1 } } }
        ]);
        const stockMap = {};
        stockAgg.forEach(s => stockMap[s._id] = s.count);
        
        const result = categories.map(cat => {
            const catProducts = products.filter(p => p.categoryId && p.categoryId.toString() === cat._id.toString()).map(p => ({
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
        const stockCount = await ProductStock.countDocuments({ botId, productId, status: 'available' });
        res.json({ stock: stockCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======== SETTINGS ROUTES ========
app.get("/api/settings/payment-gateway", async (req, res) => {
    try {
        let isAdmin = false;
        try {
            const authHeader = req.headers.authorization;
            if (authHeader) {
                const token = authHeader.split(" ")[1];
                const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
                if (decoded && decoded.is_admin) isAdmin = true;
            }
        } catch(e) {}

        const settings = await PaymentGatewaySetting.find();
        if (isAdmin) {
            res.json(settings);
        } else {
            const safeSettings = settings.map(s => {
                const obj = s.toObject ? s.toObject() : s;
                return {
                    _id: obj._id,
                    gateway_name: obj.gateway_name,
                    is_active: obj.is_active,
                };
            });
            res.json(safeSettings);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======== ORDER ROUTES ========
app.post("/api/orders", async (req, res) => {
    try {
        const { userId, isGuest, guestEmail, guestId, items } = req.body;
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        
        let numericUserId = null;
        if (!isGuest && userId) {
            // Check if userId is a 24-char hex string (MongoDB ObjectId)
            if (typeof userId === 'string' && userId.length === 24) {
                const userDoc = await User.findById(userId);
                if (!userDoc) return res.status(400).json({ error: "User tidak ditemukan" });
                numericUserId = userDoc.userId;
            } else {
                numericUserId = Number(userId);
                if (isNaN(numericUserId)) return res.status(400).json({ error: "userId tidak valid" });
            }
        }

        if (!items || items.length === 0) return res.status(400).json({ error: "Keranjang kosong" });

        let guestToken = null;
        let guestTokenHash = null;
        let guestTokenExpires = null;
        
        if (isGuest) {
            guestToken = crypto.randomBytes(32).toString("hex");
            guestTokenHash = await bcrypt.hash(guestToken, 10);
            guestTokenExpires = new Date(Date.now() + 3 * 60 * 60 * 1000); 
        }

        const newOrderId = `ORD-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        
        let totalAmount = 0;
        let orderItems = [];

        // Loop over items and validate prices & reserve stock
        for (const item of items) {
            const product = await Product.findOne({ botId, productId: item.productId });
            if (!product) return res.status(400).json({ error: `Produk tidak ditemukan: ${item.productId}` });

            const subtotal = product.price * item.quantity;
            totalAmount += subtotal;

            orderItems.push({
                productId: product.productId,
                productName: product.name,
                quantity: item.quantity,
                price: product.price,
                subtotal: subtotal
            });

            const stockRes = await reserveStockAtomic(botId, product.productId, item.quantity, newOrderId);
            if (!stockRes.success) {
                // If any reservation fails, we should release all previously reserved stocks for this order
                await ProductStock.updateMany(
                    { orderId: newOrderId, status: 'reserved' },
                    { $set: { status: 'available', orderId: null, reservedAt: null } }
                );
                return res.status(400).json({ error: `Stok tidak mencukupi untuk ${product.name}` });
            }
        }

        // Create the actual order
        await Order.create({
            orderId: newOrderId,
            botId,
            userId: isGuest ? null : numericUserId,
            source: 'web',
            isGuest,
            guestEmail,
            guestId,
            guestTokenHash,
            guestTokenExpires,
            items: orderItems,
            totalAmount,
            status: 'pending',
            paymentMethod: 'qris'
        });

        res.json({ success: true, orderId: newOrderId, guestToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ======== USER ORDERS ROUTES ========
app.get('/api/orders', async (req, res) => {
    try {
        const { userId, isGuest, guestId } = req.query;
        let query = { source: 'web' };
        
        if (userId && userId !== 'undefined') {
            if (typeof userId === 'string' && userId.length === 24) {
                const userDoc = await User.findById(userId);
                query.userId = userDoc ? userDoc.userId : -1;
            } else {
                query.userId = Number(userId);
            }
        } else if (isGuest === 'true' && guestId) {
            query.guestId = guestId;
        } else {
            return res.json([]);
        }
        
        const orders = await Order.find(query).sort({ createdAt: -1 }).limit(100);
        
        const mapped = orders.map(orderDoc => ({
            _id: orderDoc.orderId,
            id: orderDoc.orderId,
            userId: orderDoc.userId,
            user_id: orderDoc.userId,
            guestEmail: orderDoc.guestEmail,
            guest_email: orderDoc.guestEmail,
            isGuest: orderDoc.isGuest,
            totalPrice: orderDoc.totalAmount,
            total_price: orderDoc.totalAmount,
            paymentUrl: orderDoc.paymentUrl,
            payment_url: orderDoc.paymentUrl,
            paymentReference: orderDoc.paymentReference,
            payment_reference: orderDoc.paymentReference,
            createdAt: orderDoc.createdAt,
            created_at: orderDoc.createdAt,
            status: orderDoc.status,
            guestTokenHash: orderDoc.guestTokenHash,
            guestTokenExpires: orderDoc.guestTokenExpires,
            emailSent: orderDoc.emailSent,
            items: orderDoc.items.map(t => ({
                id: t._id,
                productId: t.productId,
                quantity: t.quantity,
                priceAtTime: t.price,
                stockId: t.stockIds && t.stockIds.length > 0 ? t.stockIds[0] : null,
                products: { name: t.productName }
            }))
        }));
        
        // Sort by created_at desc
        mapped.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        
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
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const source = req.query.source || 'all';
        const status = req.query.status || 'all';
        const search = req.query.search || '';
        
        let query = {};
        if (source !== 'all') {
            if (source === 'telegram') {
                query.source = { $ne: 'website' };
            } else {
                query.source = source;
            }
        }
        if (status !== 'all') {
            if (status === 'completed') {
                query.status = { $in: ['completed', 'paid'] };
            } else {
                query.status = status;
            }
        }
        
        if (search) {
            query.$or = [
                { orderId: { $regex: search, $options: 'i' } },
                { 'items.productName': { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (page - 1) * limit;

        const transactions = await Order.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit + 1)
            .lean();

        const hasNextPage = transactions.length > limit;
        if (hasNextPage) {
            transactions.pop();
        }

        // Map back to the expected shape (array of transactions vs array of orders)
        // If frontend expects flat transactions, we flatten it, but for V2, frontend might just accept orders.
        // Let's return the orders. Wait, the frontend might be expecting flat transactions.
        // Assuming frontend handles 'transactions' as orders if they contain orderId, totalAmount, etc.
        const mappedData = transactions.map(order => {
             // to maintain compatibility, return order-like objects
             return {
                 ...order,
                 _id: order.orderId, // map _id to orderId for compatibility
                 reffId: order.orderId,
                 productName: order.items.map(i => i.productName).join(', '),
                 quantity: order.items.reduce((s, i) => s + i.quantity, 0),
                 price: order.totalAmount
             };
        });

        res.json({
            data: mappedData,
            pagination: {
                page,
                limit,
                hasNextPage,
                hasPreviousPage: page > 1
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const statsRes = await getAdminStats(botId);
        if (!statsRes.success) return res.status(500).json({ error: statsRes.error });
        res.json(statsRes.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
        await Product.updateMany({ categoryId: req.params.id }, { $unset: { categoryId: "" } });
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
        let categoryId = null;
        if (req.body.category) {
            const cat = await Category.findOne({ botId, name: req.body.category });
            if (cat) {
                categoryId = cat._id;
            } else {
                const newCat = await Category.create({ botId, name: req.body.category });
                categoryId = newCat._id;
            }
        }
        const p = await Product.create({ ...req.body, botId, categoryId });
        res.json(p);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/products/:id', async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        let categoryId = undefined;
        if (req.body.category) {
            const cat = await Category.findOne({ botId, name: req.body.category });
            if (cat) {
                categoryId = cat._id;
            } else {
                const newCat = await Category.create({ botId, name: req.body.category });
                categoryId = newCat._id;
            }
        }
        const updateData = { ...req.body };
        if (categoryId !== undefined) {
            updateData.categoryId = categoryId;
        }
        const p = await Product.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stocks/stats', async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const available = await ProductStock.countDocuments({ botId, status: 'available' });
        const sold = await ProductStock.countDocuments({ botId, isSold: true });
        res.json({ available, sold });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stocks', async (req, res) => {
    try {
        const { productId } = req.query;
        const q = productId ? { productId } : {};
        const stocks = await ProductStock.find(q).sort({ createdAt: -1 }).limit(1000);
        res.json(stocks);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/stocks', async (req, res) => {
    try {
        const { productId, contents } = req.body;
        const docs = contents.map(c => ({ botId: parseInt(process.env.DEFAULT_BOT_ID)||1, productId, accountData: c, status: 'available' }));
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
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        if (!decoded.is_admin) return res.status(403).json({ error: "Forbidden" });

        await PaymentGatewaySetting.updateMany({}, { is_active: false });
        await PaymentGatewaySetting.findOneAndUpdate(
            { gateway_name: req.body.gateway_name },
            { is_active: true, settings: req.body.settings },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======== USER DASHBOARD ROUTES ========

const requireUserAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        
        const user = await User.findById(decoded.id);
        if (!user) {
            return res.status(401).json({ error: "User tidak ditemukan" });
        }
        
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Sesi telah berakhir atau tidak valid" });
    }
};

app.get("/api/user/profile", requireUserAuth, async (req, res) => {
    try {
        const { _id, name, email, phone, createdAt, isTelegram, role } = req.user;
        res.json({
            id: _id,
            name,
            email,
            phone,
            createdAt,
            isTelegram,
            role
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch("/api/user/profile", requireUserAuth, async (req, res) => {
    try {
        const { name, email, phone } = req.body;
        
        if (!name || name.trim() === "") {
            return res.status(400).json({ error: "Nama tidak boleh kosong" });
        }

        // Cek duplikasi email
        if (email && email.trim() !== "" && email !== req.user.email) {
            const existingEmail = await User.findOne({ email });
            if (existingEmail) return res.status(400).json({ error: "Email sudah digunakan oleh akun lain" });
        }

        // Cek duplikasi phone
        if (phone && phone.trim() !== "" && phone !== req.user.phone) {
            const existingPhone = await User.findOne({ phone });
            if (existingPhone) return res.status(400).json({ error: "Nomor HP sudah digunakan oleh akun lain" });
        }

        req.user.name = name;
        if (email !== undefined) req.user.email = email.trim() === "" ? null : email;
        if (phone !== undefined) req.user.phone = phone.trim() === "" ? null : phone;

        await req.user.save();

        res.json({ success: true, message: "Profil berhasil diperbarui" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/user/statistics", requireUserAuth, async (req, res) => {
    try {
        const totalPending = await Order.countDocuments({ userId: req.user.userId, status: 'pending' });
        
        res.json({
            totalTransactions: req.user.stats.totalTransactions,
            totalSpent: req.user.stats.totalSpent,
            totalItems: req.user.stats.totalItems,
            totalPending
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/user/orders", requireUserAuth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const status = req.query.status;

        const query = { userId: req.user.userId };
        if (status && status !== 'semua') {
            query.status = status;
        }

        const total = await Order.countDocuments(query);
        const orders = await Order.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        res.json({
            data: orders,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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


