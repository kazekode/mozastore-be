import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB, Product, Category, User, PaymentGatewaySetting, ProductStock, SmtpSetting, Order, Bot, DailySalesSummary, getAdminStats, Banner } from "./lib/shared-db/index.js";
import { reserveStockAtomic, processOrderPaymentSuccess, releaseReservedStock } from "./lib/shared-db/services.js";
import { getTransporter, testSmtpConnection, sendOrderEmail } from "./mailer.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import axios from "axios";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import multer from "multer";

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
const generateQRIS = (qris, amount) => {
    if (!qris) return "";
    if (!amount) return qris;
    try {
        function convertCRC16(str) {
            let crc = 0xffff;
            for (let c = 0; c < str.length; c++) {
                crc ^= str.charCodeAt(c) << 8;
                for (let i = 0; i < 8; i++) {
                    crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
                }
            }
            crc &= 0xffff;
            let hex = crc.toString(16).toUpperCase();
            while (hex.length < 4) hex = "0" + hex;
            return hex;
        }

        let q = String(qris).trim();
        q = q.slice(0, -4);
        const step1 = q.replace("010211", "010212");
        const step2 = step1.split("5802ID");
        if (step2.length < 2) return qris;
        const nominalStr = String(parseInt(amount, 10));
        const nominalData = "54" + nominalStr.length.toString().padStart(2, "0") + nominalStr;
        let hasil = step2[0] + nominalData + "5802ID" + step2[1];
        hasil += convertCRC16(hasil);
        return hasil;
    } catch {
        return qris;
    }
};

// ======== AUTH & UPLOAD HELPERS ========
const adminAuth = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized: Token tidak disediakan" });
        }
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        if (!decoded || !decoded.is_admin) {
            return res.status(403).json({ error: "Forbidden: Akses ditolak, khusus admin" });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Unauthorized: Token tidak valid atau sesi berakhir" });
    }
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const getVerifiedImageExt = (buffer) => {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'gif';
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp';
    return null;
};

const verifyOrderAccess = async (orderDoc, req) => {
    if (!orderDoc) return { hasAccess: false };

    // 1. Check Admin or Authenticated User JWT
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
            const token = authHeader.split(" ")[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
            if (decoded && decoded.is_admin) {
                return { hasAccess: true, isAdmin: true };
            }
            if (orderDoc.userId) {
                if (orderDoc.userId.toString() === decoded.id) {
                    return { hasAccess: true, isUser: true };
                }
                const userDoc = await User.findById(decoded.id);
                if (userDoc && userDoc.userId === orderDoc.userId) {
                    return { hasAccess: true, isUser: true };
                }
            }
        } catch {
            // Token invalid, continue to guest check
        }
    }

    // 2. Check Guest Order Token
    if (orderDoc.isGuest) {
        const guestToken = req.headers['x-guest-token'] || req.query.guestToken || req.body?.guestToken;
        if (guestToken && orderDoc.guestTokenHash) {
            try {
                const isMatch = await bcrypt.compare(guestToken, orderDoc.guestTokenHash);
                if (isMatch) {
                    if (orderDoc.guestTokenExpires && orderDoc.guestTokenExpires > new Date()) {
                        return { hasAccess: true, isGuest: true };
                    } else {
                        return { hasAccess: false, expired: true, isGuest: true };
                    }
                }
            } catch {
                // bcrypt compare error
            }
        }
    }

    return { hasAccess: false };
};


// ======== ORDER PROCESS ROUTES ========
app.get("/api/orders/:id", async (req, res) => {
    try {
        const orderDoc = await Order.findOne({ orderId: req.params.id });
        if (!orderDoc) return res.status(404).json({ error: "Order not found" });

        const access = await verifyOrderAccess(orderDoc, req);
        if (!access.hasAccess) {
            return res.status(403).json({ error: access.expired ? "Akses transaksi telah berakhir" : "Akses Ditolak", expired: !!access.expired });
        }

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

        // Enrich items
        const allStocks = await ProductStock.find({ orderId: req.params.id }).lean();
        console.log(`[DEBUG] Found ${allStocks.length} stocks for order ${req.params.id}`);
        console.log(`[DEBUG] Stocks:`, allStocks.map(s => ({ id: s._id, product: s.productId, orderId: s.orderId })));

        const enrichedItems = await Promise.all(orderDoc.items.map(async item => {
            const product = await Product.findOne({ botId: orderDoc.botId, productId: item.productId }) || await Product.findById(item.productId).catch(() => null);
            console.log(`[SNK DEBUG] orderId: ${req.params.id}`);
            console.log(`[SNK DEBUG] item productId: ${item.productId}`);
            console.log(`[SNK DEBUG] product found: ${!!product}`);
            console.log(`[SNK DEBUG] product.snk exists: ${!!(product && product.snk)}`);

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
            const itemPayload = {
                id: item._id, // if any
                quantity: item.quantity,
                price: item.price,
                product_id: item.productId,
                stock_id: stockId,
                products: product ? { name: product.name, snk: product.snk } : { name: item.productName },
                product_stocks: stockContent ? { content: stockContent } : null
            };
            console.log(`[SNK DEBUG] response item.snk exists: ${!!itemPayload.products.snk}`);
            return itemPayload;
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

        const access = await verifyOrderAccess(orderDoc, req);
        if (!access.hasAccess) {
            return res.status(403).json({ error: "Akses Ditolak" });
        }

        if (orderDoc.status !== 'pending') {
            return res.status(400).json({ error: `Order is not pending (status: ${orderDoc.status})` });
        }

        if (orderDoc.paymentUrl && orderDoc.paymentUrl !== "MOCK_QRIS_URL_FOR_NOW") {
            return res.json({ 
                success: true, 
                paymentUrl: orderDoc.paymentUrl, 
                paymentReference: orderDoc.paymentReference, 
                totalPrice: orderDoc.totalAmount 
            });
        }

        const setting = await PaymentGatewaySetting.findOne({ is_active: true });
        const gateway = setting ? setting.gateway_name : 'tokopay';

        let paymentUrl = null;
        let paymentReference = orderDoc.orderId.toString();
        let newTotalPrice = orderDoc.totalAmount;

        if (gateway === 'tokopay') {
            const mId = setting?.settings?.merchant_id || process.env.TOKOPAY_MERCHANT;
            const sKey = setting?.settings?.secret_key || process.env.TOKOPAY_SECRET;
            if (mId && sKey) {
                try {
                    const url = `https://api.tokopay.id/v1/order?merchant=${mId}&secret=${sKey}&ref_id=${orderDoc.orderId}&nominal=${orderDoc.totalAmount}`;
                    const { data } = await axios.get(url, { timeout: 20000 });
                    if (data.status === 'Success' && data.data?.qr_link) {
                        paymentUrl = data.data.qr_link;
                        paymentReference = data.data.trx_id || orderDoc.orderId.toString();
                        if (data.data.total_pay) {
                            newTotalPrice = Number(data.data.total_pay);
                        } else if (data.data.amount) {
                            newTotalPrice = Number(data.data.amount);
                        }
                    }
                } catch (apiErr) {
                    console.error('[TokoPay create-payment error]:', apiErr.response?.data || apiErr.message);
                }
            }
        } else if (gateway === 'orderkuota') {
            const qString = setting?.settings?.qris_string;
            if (qString) {
                paymentUrl = generateQRIS(qString, orderDoc.totalAmount);
                paymentReference = orderDoc.orderId.toString();
            }
        } else if (gateway === 'kazepay') {
            const apiId = setting?.settings?.api_id || process.env.KAZEPAY_API_ID;
            const apiKey = setting?.settings?.api_key || process.env.KAZEPAY_API_KEY;
            if (apiId && apiKey) {
                try {
                    const response = await axios.post(
                        'https://kazepay-api.vercel.app/api/deposit',
                        { amount: orderDoc.totalAmount },
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                'x-api-id': apiId,
                                'x-api-key': apiKey,
                            },
                            timeout: 20000
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
                    console.error('[KazePay create-payment error]:', apiErr.response?.data || apiErr.message);
                }
            }
        } else if (gateway === 'klikqris' || gateway === 'kitaqris') {
            const merchantId = setting?.settings?.mypg_merchant || setting?.settings?.merchant_id || process.env.KLIKQRIS_MERCHANT_ID || process.env.MYPG_MERCHANT || process.env.KITAQRIS_MERCHANT_ID;
            const apiKey = setting?.settings?.mypg_api_key || setting?.settings?.api_key || process.env.KLIKQRIS_API_KEY || process.env.MYPG_API_KEY || process.env.KITAQRIS_API_KEY;
            const qString = setting?.settings?.qris_string || setting?.settings?.mypg_qris || process.env.MYPG_QRIS || "00020101021126610016ID.CO.SHOPEE.WWW01189360091800235569850208235569850303UMI51440014ID.CO.QRIS.WWW0215ID10265761463480303UMI5204581653033605802ID5914SUKA SUKA CELL6006MALANG61056539162070703A0163042E60";
            if (merchantId && apiKey) {
                try {
                    const response = await axios.post(
                        'https://klikqris.com/api/qrisv2/create',
                        {
                            order_id: String(orderDoc.orderId),
                            amount: parseInt(orderDoc.totalAmount, 10),
                            id_merchant: String(merchantId)
                        },
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                'x-api-key': apiKey,
                                'id_merchant': String(merchantId)
                            },
                            timeout: 20000
                        }
                    );
                    const orderResponse = response.data;
                    if (orderResponse && orderResponse.status === true && orderResponse.data) {
                        paymentUrl = orderResponse.data.qris_url || orderResponse.data.direct_url || orderResponse.data.qris_image;
                        paymentReference = orderResponse.data.order_id || orderDoc.orderId.toString();
                        if (orderResponse.data.total_amount) {
                            newTotalPrice = Number(orderResponse.data.total_amount);
                        } else if (orderResponse.data.amount) {
                            newTotalPrice = Number(orderResponse.data.amount);
                        }
                    }
                } catch (apiErr) {
                    console.error('[KlikQRIS create-payment error]:', apiErr.response?.data || apiErr.message);
                }
            }
            if (!paymentUrl && qString) {
                paymentUrl = generateQRIS(qString, orderDoc.totalAmount);
                paymentReference = orderDoc.orderId.toString();
            }
        }

        if (!paymentUrl) {
            console.error(`[PAYMENT ERROR] Gagal generate QRIS untuk order ${orderDoc.orderId} via gateway ${gateway}`);
            return res.status(502).json({ error: "Gagal membuat pembayaran QRIS dari payment gateway. Silakan hubungi admin atau coba lagi." });
        }
        
        await Order.updateOne(
            { orderId: req.params.id },
            { 
                $set: { 
                    paymentUrl, 
                    paymentReference,
                    paymentMethod: 'qris'
                } 
            }
        );

        res.json({ success: true, paymentUrl, paymentReference, totalPrice: newTotalPrice });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/orders/:id/check-payment", async (req, res) => {
    try {
        const orderDoc = await Order.findOne({ orderId: req.params.id });
        if (!orderDoc) return res.status(404).json({ error: "Order not found" });

        const access = await verifyOrderAccess(orderDoc, req);
        if (!access.hasAccess) {
            return res.status(403).json({ error: "Akses Ditolak" });
        }

        // Return immediately if order is already resolved
        if (orderDoc.status !== 'pending') {
            return res.json({ status: orderDoc.status });
        }

        // If paymentReference is missing, cannot check with gateway yet
        if (!orderDoc.paymentReference) {
            return res.json({ status: 'pending' });
        }

        const setting = await PaymentGatewaySetting.findOne({ is_active: true });
        const gateway = setting ? setting.gateway_name : 'tokopay';

        let isPaid = false;
        let isExpired = false;

        if (gateway === 'tokopay') {
            const mId = setting?.settings?.merchant_id || process.env.TOKOPAY_MERCHANT;
            const sKey = setting?.settings?.secret_key || process.env.TOKOPAY_SECRET;
            if (mId && sKey && orderDoc.paymentReference) {
                try {
                    const url = `https://api.tokopay.id/v1/transaction?merchant=${mId}&secret=${sKey}&ref_id=${orderDoc.paymentReference}`;
                    const { data } = await axios.get(url, { timeout: 15000 });
                    if (data.status === 'Success' && data.data) {
                        const st = data.data.status?.toLowerCase();
                        if (st === 'success' || st === 'paid') {
                            const paidAmount = Number(data.data.total_pay || data.data.amount || 0);
                            if (!paidAmount || paidAmount >= orderDoc.totalAmount) {
                                isPaid = true;
                            } else {
                                console.warn(`[TokoPay] Amount mismatch for ${orderDoc.orderId}: expected >= ${orderDoc.totalAmount}, got ${paidAmount}`);
                            }
                        } else if (st === 'expired' || st === 'failed') {
                            isExpired = true;
                        }
                    }
                } catch (apiErr) {
                    console.error('[TokoPay check-payment error]:', apiErr.response?.data || apiErr.message);
                }
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
                        timeout: 15000
                    });
                    const responseData = response.data.data || response.data;
                    const st = responseData?.status?.toLowerCase();
                    if (st === 'success' || st === 'paid' || st === 'settlement') {
                        const paidAmount = Number(responseData.amount || responseData.total_amount || responseData.total_pay || 0);
                        if (!paidAmount || paidAmount >= orderDoc.totalAmount) {
                            isPaid = true;
                        } else {
                            console.warn(`[KazePay] Amount mismatch for ${orderDoc.orderId}: expected >= ${orderDoc.totalAmount}, got ${paidAmount}`);
                        }
                    } else if (st === 'expired' || st === 'failed' || st === 'cancel') {
                        isExpired = true;
                    }
                } catch (apiErr) {
                    console.error('[KazePay check-payment error]:', apiErr.response?.data || apiErr.message);
                }
            }
        } else if (gateway === 'klikqris' || gateway === 'kitaqris') {
            const merchantId = setting?.settings?.mypg_merchant || setting?.settings?.merchant_id || process.env.KLIKQRIS_MERCHANT_ID || process.env.MYPG_MERCHANT || process.env.KITAQRIS_MERCHANT_ID;
            const apiKey = setting?.settings?.mypg_api_key || setting?.settings?.api_key || process.env.KLIKQRIS_API_KEY || process.env.MYPG_API_KEY || process.env.KITAQRIS_API_KEY;
            const checkRef = orderDoc.paymentReference || orderDoc.orderId;
            if (merchantId && apiKey && checkRef) {
                try {
                    const response = await axios.get(`https://klikqris.com/api/qrisv2/status/${merchantId}/${checkRef}`, {
                        headers: {
                            'x-api-key': apiKey,
                            'id_merchant': String(merchantId)
                        },
                        timeout: 15000
                    });
                    const statusResponse = response.data;
                    if (statusResponse && statusResponse.status === true && statusResponse.data) {
                        const st = statusResponse.data.status?.toLowerCase();
                        if (st === 'success' || st === 'paid' || st === 'settlement') {
                            isPaid = true;
                        } else if (st === 'expired' || st === 'failed' || st === 'cancel') {
                            isExpired = true;
                        }
                    }
                } catch (apiErr) {
                    console.error('[KlikQRIS check-payment error]:', apiErr.response?.data || apiErr.message);
                }
            }
        }

        // Strict security: isPaid remains false if not explicitly verified by gateway

        if (isExpired) {
            const updated = await Order.findOneAndUpdate(
                { orderId: req.params.id, status: 'pending' },
                { $set: { status: 'expired' } },
                { new: true }
            );
            if (updated) {
                await releaseReservedStock(req.params.id);
            }
            return res.json({ status: 'expired' });
        }

        if (isPaid) {
            console.log(`[PAYMENT VERIFIED] Order ${req.params.id} confirmed paid via ${gateway}. Processing order completion...`);
            const result = await processOrderPaymentSuccess(req.params.id, 'qris', orderDoc.paymentReference || req.params.id);
            if (result.success) {
                const orderData = result.order;
                
                if (orderData && !result.alreadyCompleted && !orderData.emailSent) {
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
                                    const prod = await Product.findOne({ botId: orderData.botId, productId: pId }) || await Product.findById(pId).catch(() => null);
                                    const name = prod ? prod.name : group.productName;
                                    
                                    const productStocks = allAllocatedStocks.filter(st => st.productId === pId);
                                    const accountData = productStocks.map(st => st.accountData).filter(Boolean).join('\n\n---\n\n');
                                    
                                    const itemSnk = prod ? prod.snk : null;

                                    orderItemsForEmail.push({
                                        name: name,
                                        quantity: group.quantity,
                                        price: group.price,
                                        accountData: accountData || null,
                                        snk: itemSnk
                                    });
                                }
                                
                                const orderDataForEmail = {
                                    orderId: req.params.id,
                                    date: new Date(orderData.createdAt).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                                    totalAmount: orderData.totalAmount,
                                    items: orderItemsForEmail,
                                    recipientName
                                };
                                
                                const emailResult = await sendOrderEmail(toEmail, orderDataForEmail);
                                if (emailResult && emailResult.success) {
                                    await Order.updateOne({ orderId: req.params.id }, { $set: { emailSent: true, emailSentAt: new Date() } });
                                }
                            } catch (err) {
                                console.error("[Order Email Error] Background email error:", err.message);
                            }
                        })();
                    }
                }
                return res.json({ status: 'completed' });
            } else {
                console.error(`[PAYMENT ERROR] processOrderPaymentSuccess failed for ${req.params.id}:`, result.error);
                return res.json({ status: orderDoc.status, error: result.error });
            }
        }

        res.json({ status: orderDoc.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/orders/:id/cancel", async (req, res) => {
    try {
        const orderDoc = await Order.findOne({ orderId: req.params.id });
        if (!orderDoc) return res.status(404).json({ error: "Order not found" });

        const access = await verifyOrderAccess(orderDoc, req);
        if (!access.hasAccess) {
            return res.status(403).json({ error: "Akses Ditolak" });
        }

        if (orderDoc.status !== 'pending') {
            return res.status(400).json({ error: `Pesanan berstatus '${orderDoc.status}', tidak dapat dibatalkan.` });
        }

        const updated = await Order.findOneAndUpdate(
            { orderId: req.params.id, status: 'pending' },
            { $set: { status: 'cancelled' } },
            { new: true }
        );

        if (!updated) {
            return res.status(400).json({ error: "Pesanan sudah diproses atau tidak berstatus pending." });
        }

        await releaseReservedStock(req.params.id);
        res.json({ success: true, message: "Pesanan berhasil dibatalkan" });
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
                snk: p.snk,
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
                snk: p.snk,
                image_url: p.image_url || null,
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
    let newOrderId = null;
    try {
        const { userId, isGuest, guestEmail, guestId, items } = req.body;
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;

        if (!items || !Array.isArray(items) || items.length === 0 || items.length > 50) {
            return res.status(400).json({ error: "Keranjang kosong atau item melebihi batas (maks 50)" });
        }

        // Validate each item structure and quantity
        for (const item of items) {
            if (!item.productId || typeof item.productId !== 'string') {
                return res.status(400).json({ error: "Item productId tidak valid" });
            }
            const qty = parseInt(item.quantity, 10);
            if (isNaN(qty) || qty <= 0 || qty > 1000) {
                return res.status(400).json({ error: "Jumlah produk harus berupa angka bulat 1 - 1000" });
            }
        }
        
        let numericUserId = null;
        if (!isGuest) {
            // Check if JWT token is present to strictly bind user identity
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith("Bearer ")) {
                try {
                    const token = authHeader.split(" ")[1];
                    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
                    const userDoc = await User.findById(decoded.id);
                    if (userDoc) numericUserId = userDoc.userId;
                } catch {}
            }
            // Fallback to body userId if no valid JWT was verified
            if (numericUserId === null && userId) {
                if (typeof userId === 'string' && userId.length === 24) {
                    const userDoc = await User.findById(userId);
                    if (!userDoc) return res.status(400).json({ error: "User tidak ditemukan" });
                    numericUserId = userDoc.userId;
                } else {
                    numericUserId = Number(userId);
                    if (isNaN(numericUserId)) return res.status(400).json({ error: "userId tidak valid" });
                }
            }
        }

        let guestToken = null;
        let guestTokenHash = null;
        let guestTokenExpires = null;
        
        if (isGuest) {
            guestToken = crypto.randomBytes(32).toString("hex");
            guestTokenHash = await bcrypt.hash(guestToken, 10);
            guestTokenExpires = new Date(Date.now() + 3 * 60 * 60 * 1000); 
        }

        newOrderId = `ORD-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        
        let totalAmount = 0;
        let orderItems = [];

        // Loop over items and validate prices & reserve stock
        for (const item of items) {
            const qty = parseInt(item.quantity, 10);
            const product = await Product.findOne({ botId, productId: item.productId });
            if (!product) {
                await releaseReservedStock(newOrderId);
                return res.status(400).json({ error: `Produk tidak ditemukan: ${item.productId}` });
            }

            const subtotal = product.price * qty;
            totalAmount += subtotal;

            orderItems.push({
                productId: product.productId,
                productName: product.name,
                quantity: qty,
                price: product.price,
                subtotal: subtotal
            });

            const stockRes = await reserveStockAtomic(botId, product.productId, qty, newOrderId);
            if (!stockRes.success) {
                await releaseReservedStock(newOrderId);
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
        if (newOrderId) {
            await releaseReservedStock(newOrderId).catch(() => {});
        }
        res.status(500).json({ error: err.message });
    }
});


// ======== USER ORDERS ROUTES ========
app.get('/api/orders', async (req, res) => {
    try {
        const { userId, isGuest, guestId } = req.query;
        let query = { source: 'web' };
        
        if (userId && userId !== 'undefined') {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith("Bearer ")) {
                try {
                    const token = authHeader.split(" ")[1];
                    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
                    if (!decoded.is_admin) {
                        const userDoc = await User.findById(decoded.id);
                        if (!userDoc) return res.status(401).json({ error: "User tidak ditemukan" });
                        query.userId = userDoc.userId;
                    } else {
                        if (typeof userId === 'string' && userId.length === 24) {
                            const userDoc = await User.findById(userId);
                            query.userId = userDoc ? userDoc.userId : -1;
                        } else {
                            query.userId = Number(userId);
                        }
                    }
                } catch {
                    return res.status(401).json({ error: "Token tidak valid" });
                }
            } else {
                return res.status(401).json({ error: "Unauthorized: Silakan login terlebih dahulu" });
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
app.get('/api/admin/smtp', adminAuth, async (req, res) => {
    try {
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

app.post('/api/admin/smtp', adminAuth, async (req, res) => {
    try {
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

app.post('/api/admin/smtp/test', adminAuth, async (req, res) => {
    try {
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

app.post('/api/admin/smtp/send-test', adminAuth, async (req, res) => {
    try {
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
app.get('/api/admin/transactions', adminAuth, async (req, res) => {
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

app.get('/api/admin/stats', adminAuth, async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const statsRes = await getAdminStats(botId);
        if (!statsRes.success) return res.status(500).json({ error: statsRes.error });
        res.json(statsRes.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======== ADMIN IMAGE UPLOAD (PROXY KE CPANEL) ========
app.post('/api/admin/upload', adminAuth, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: "Ukuran file terlalu besar (maksimal 5MB)" });
            }
            return res.status(400).json({ error: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "File gambar tidak ditemukan dalam request" });
        }

        // Validasi format file via magic bytes
        const detectedExt = getVerifiedImageExt(req.file.buffer);
        if (!detectedExt) {
            return res.status(400).json({ error: "Format file tidak valid. Hanya JPG, PNG, WEBP, dan GIF yang diizinkan." });
        }

        const cpanelUploadUrl = process.env.CPANEL_UPLOAD_URL;
        const cpanelUploadToken = process.env.CPANEL_UPLOAD_TOKEN;

        if (!cpanelUploadUrl || !cpanelUploadToken) {
            return res.status(500).json({ 
                error: "Konfigurasi cPanel belum diatur di Koyeb backend (CPANEL_UPLOAD_URL atau CPANEL_UPLOAD_TOKEN belum diset)" 
            });
        }

        const folder = (req.body.folder || 'categories').replace(/[^a-zA-Z0-9_-]/g, '');

        // Buat FormData untuk dikirim via HTTPS ke cPanel endpoint
        const fd = new FormData();
        fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || `image.${detectedExt}`);
        fd.append('folder', folder);
        fd.append('token', cpanelUploadToken);

        const response = await axios.post(cpanelUploadUrl, fd, {
            headers: {
                'Authorization': `Bearer ${cpanelUploadToken}`
            },
            timeout: 30000
        });

        if (!response.data || !response.data.success || !response.data.url) {
            return res.status(502).json({ 
                error: response.data?.error || "Gagal mengunggah gambar ke cPanel hosting" 
            });
        }

        res.json({
            success: true,
            url: response.data.url,
            filename: response.data.filename,
            folder: response.data.folder || folder
        });
    } catch (err) {
        console.error("[Upload Error]", err.response?.data || err.message);
        const errMsg = err.response?.data?.error || err.message || "Gagal menghubungi endpoint upload cPanel";
        res.status(502).json({ error: `Upload cPanel gagal: ${errMsg}` });
    }
});

app.delete('/api/admin/upload', adminAuth, async (req, res) => {
    try {
        const { filename, folder } = req.body;
        if (!filename) return res.status(400).json({ error: "Parameter filename wajib diisi" });

        const cpanelUploadUrl = process.env.CPANEL_UPLOAD_URL;
        const cpanelUploadToken = process.env.CPANEL_UPLOAD_TOKEN;

        if (!cpanelUploadUrl || !cpanelUploadToken) {
            return res.status(500).json({ error: "Konfigurasi cPanel belum diset" });
        }

        const fd = new FormData();
        fd.append('action', 'delete');
        fd.append('filename', filename);
        if (folder) fd.append('folder', folder);
        fd.append('token', cpanelUploadToken);

        const response = await axios.post(cpanelUploadUrl, fd, {
            headers: { 'Authorization': `Bearer ${cpanelUploadToken}` },
            timeout: 15000
        });

        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.response?.data?.error || err.message });
    }
});

app.post('/api/admin/categories/reorder', adminAuth, async (req, res) => {
    try {
        const { order } = req.body; // Array of { id: categoryId, sort_order: index }
        for (const item of order) {
            await Category.findByIdAndUpdate(item.id, { sort_order: item.sort_order });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/products/reorder', adminAuth, async (req, res) => {
    try {
        const { order } = req.body; // Array of { id: productId, sort_order: index }
        for (const item of order) {
            await Product.findOneAndUpdate({ productId: item.id }, { sort_order: item.sort_order });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/categories', adminAuth, async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const c = await Category.create({ ...req.body, botId });
        res.json(c);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
    try {
        await Product.updateMany({ categoryId: req.params.id }, { $unset: { categoryId: "" } });
        await Category.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
    try {
        await Category.findByIdAndUpdate(req.params.id, req.body);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/products', adminAuth, async (req, res) => {
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
app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
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
app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stocks/stats', adminAuth, async (req, res) => {
    try {
        const botId = parseInt(process.env.DEFAULT_BOT_ID) || 8374872044;
        const available = await ProductStock.countDocuments({ botId, status: 'available' });
        const sold = await ProductStock.countDocuments({ botId, status: 'sold' });
        res.json({ available, sold });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stocks', adminAuth, async (req, res) => {
    try {
        const { productId } = req.query;
        const q = productId ? { productId } : {};
        const stocks = await ProductStock.find(q).sort({ createdAt: -1 }).limit(1000);
        res.json(stocks);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/stocks', adminAuth, async (req, res) => {
    try {
        const { productId, contents } = req.body;
        if (!Array.isArray(contents)) return res.status(400).json({ error: "contents harus berupa array" });
        const docs = contents.map(c => ({ botId: parseInt(process.env.DEFAULT_BOT_ID)||8374872044, productId, accountData: c, status: 'available' }));
        await ProductStock.insertMany(docs);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/stocks', adminAuth, async (req, res) => {
    try {
        await ProductStock.deleteMany({ _id: { $in: req.body.ids } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/stocks/mark-sold', adminAuth, async (req, res) => {
    try {
        await ProductStock.updateMany({ _id: { $in: req.body.ids } }, { $set: { status: 'sold', soldAt: new Date() } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/payment-gateway', adminAuth, async (req, res) => {
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

// ======== BANNER ROUTES ========

// Public: hanya banner aktif, diurut sort_order
app.get('/api/banners', async (req, res) => {
    try {
        const banners = await Banner.find({ is_active: true, image_url: { $nin: [null, ""] } }).sort({ sort_order: 1 }).lean();
        res.json(banners.map(b => ({
            id: b._id,
            image_url: b.image_url,
            alt: b.alt,
            sort_order: b.sort_order,
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: semua banner
app.get('/api/admin/banners', adminAuth, async (req, res) => {
    try {
        const banners = await Banner.find().sort({ sort_order: 1 }).lean();
        res.json(banners);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: tambah banner (image_url sudah diupload, simpan metadata saja)
app.post('/api/admin/banners', adminAuth, async (req, res) => {
    try {
        const { image_url, alt, filename, folder } = req.body;
        if (!image_url) return res.status(400).json({ error: "image_url wajib diisi" });
        const count = await Banner.countDocuments();
        const banner = await Banner.create({
            image_url,
            alt: alt || "",
            filename: filename || "",
            folder: folder || "banners",
            is_active: true,
            sort_order: count,
        });
        res.json({ success: true, banner });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update banner (ganti gambar / alt / status)
app.put('/api/admin/banners/:id', adminAuth, async (req, res) => {
    try {
        const allowed = ['image_url', 'alt', 'is_active', 'sort_order', 'filename', 'folder'];
        const update = {};
        for (const k of allowed) {
            if (req.body[k] !== undefined) update[k] = req.body[k];
        }
        const banner = await Banner.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!banner) return res.status(404).json({ error: "Banner tidak ditemukan" });
        res.json({ success: true, banner });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: reorder (terima array [{ id, sort_order }])
app.post('/api/admin/banners/reorder', adminAuth, async (req, res) => {
    try {
        const { order } = req.body;
        if (!Array.isArray(order)) return res.status(400).json({ error: "order harus array" });
        for (const item of order) {
            await Banner.findByIdAndUpdate(item.id, { sort_order: item.sort_order });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: hapus banner
app.delete('/api/admin/banners/:id', adminAuth, async (req, res) => {
    try {
        const banner = await Banner.findByIdAndDelete(req.params.id);
        if (!banner) return res.status(404).json({ error: "Banner tidak ditemukan" });
        res.json({ success: true, filename: banner.filename, folder: banner.folder });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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


