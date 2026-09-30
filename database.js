import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const processingLocks = { lock: () => true, unlock: () => {} };
const addDailyStats = () => {};

const url = process.env.MONGODB_URI;

const connect = async () => {
    try {
        const poolSize = parseInt(process.env.MONGO_POOL_SIZE) || 50;
        await mongoose.connect(url, {
            dbName: process.env.MONGO_DBNAME || "MannDB",
            serverSelectionTimeoutMS: 5000,
            family: 4,
            maxPoolSize: poolSize,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
    } catch (err) {
        const retryDelay = Math.min(
            60000,
            (global.mongoReconnectDelay || 5000) * 2
        );
        global.mongoReconnectDelay = retryDelay;
        setTimeout(connect, retryDelay);
    }
};

if (mongoose.connection.listeners("disconnected").length === 0) {
    mongoose.connection.on("disconnected", () => {
        connect();
    });
}

export async function connectDB() {
    if (mongoose.connection.readyState !== 1) {
        await connect();
    }
}

export function getNativeDb() {
    return mongoose.connection.db;
}

const userSchema = new mongoose.Schema(
    {
        userId: { type: Number, required: true, unique: true },
        name: { type: String, default: "No Name" },
        username: { type: String, default: null },
        role: { type: String, default: "member" },
        balance: { type: Number, default: 0 },
        transaksi: { type: Number, default: 0 },
        membeli: { type: Number, default: 0 },
        isTelegram: { type: Boolean, default: true },
        total_nominal_transaksi: { type: Number, default: 0 },
        banned: { type: Boolean, default: false },
        isBanned: { type: Boolean, default: false },
    },
    { timestamps: true }
);

const botSchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true, unique: true },
        name: { type: String, required: true },
        terjual: { type: Number, default: 0 },
        transaksi: { type: Number, default: 0 },
        soldtoday: { type: Number, default: 0 },
        trxtoday: { type: Number, default: 0 },
        total_nominal_transaksi: { type: Number, default: 0 },
        nominaltoday: { type: Number, default: 0 },
    },
    { timestamps: true }
);

const productSchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true, index: true },
        productId: { type: String, required: true, index: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        desc: { type: String, default: "" },
        snk: { type: String, default: "" },
        terjual: { type: Number, default: 0 },
        // Added for web shop support
        image_url: { type: String, default: null },
        original_price: { type: Number, default: null },
        login_instructions: { type: String, default: null },
        min_order: { type: Number, default: 1 },
        max_order: { type: Number, default: 1000 },
        sort_order: { type: Number, default: 0 }
    },
    { timestamps: true }
);
productSchema.index({ botId: 1, productId: 1 }, { unique: true });
productSchema.index({ botId: 1, terjual: -1 });

const productStockSchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true, index: true },
        productId: { type: String, required: true, index: true },
        accountData: { type: String, required: true },
        isSold: { type: Boolean, default: false, index: true },
        trxRefId: { type: String, default: null },
    },
    { timestamps: true }
);

productStockSchema.index({ botId: 1, productId: 1, isSold: 1, createdAt: 1 });
productStockSchema.index(
    { trxRefId: 1 },
    { name: "uniqueTrxRefId", sparse: true }
);

const categorySchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true, index: true },
        name: { type: String, required: true },
        products: [String],
        image_url: { type: String, default: null },
        sort_order: { type: Number, default: 0 }
    },
    { timestamps: true }
);
categorySchema.index({ botId: 1, name: 1 }, { unique: true });

const transactionSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.Mixed, required: false, index: true },
        botId: { type: Number, required: false, index: true },
        productId: { type: String, required: true },
        productName: { type: String, required: true },
        quantity: { type: Number, required: true, default: 1 },
        price: { type: Number, required: true },
        status: { type: String, default: "completed" },
        totalAmount: { type: Number, required: true },
        paymentMethod: { type: String, default: "balance" },
        snk: { type: String, default: "" },
        reffId: { type: String, required: true, unique: true },
        
        // --- INTEGRASI WEBSITE ---
        source: { type: String, default: "telegram", index: true },
        orderId: { type: String, index: true, default: null }, 
        isGuest: { type: Boolean, default: false },
        guestEmail: { type: String, default: null },
        guestId: { type: String, default: null },
        guestTokenHash: { type: String, default: null },
        guestTokenExpires: { type: Date, default: null },
        paymentUrl: { type: String, default: null },
        paymentReference: { type: String, default: null },
        emailSent: { type: Boolean, default: false },
        emailSentAt: { type: Date, default: null },
        stockIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ProductStock' }]
    },
    { timestamps: true }
);
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ botId: 1, createdAt: -1 });

const paymentIntentSchema = new mongoose.Schema(
    {
        refId: { type: String, required: true, unique: true },
        userId: { type: Number, required: true, index: true },
        amount: { type: Number, required: true },
        kind: { type: String, enum: ["order", "deposit"], required: true },
        status: { type: String, enum: ["pending", "paid", "expired", "cancelled"], default: "pending" },
        mutationId: { type: String, default: null },
        paidAt: { type: Date, default: null },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);
paymentIntentSchema.index(
    { amount: 1 },
    { name: "uniquePendingPaymentAmount", unique: true, partialFilterExpression: { status: "pending" } }
);
paymentIntentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const authUserSchema = new mongoose.Schema(
    {
        username: { type: String, required: true, unique: true, sparse: true },
        email: { type: String, required: true, unique: true, sparse: true },
        password: { type: String, required: true },
        telegramId: { type: Number, required: true, unique: true },
    },
    { timestamps: true }
);

authUserSchema.pre("save", async function () {
    if (this.isModified("password") && this.password) {
        this.password = await bcrypt.hash(this.password, 10);
    }
});

authUserSchema.methods.comparePassword = function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

const webUserSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        email: { type: String, unique: true, sparse: true },
        phone: { type: String, unique: true, sparse: true },
        password: { type: String },
        is_admin: { type: Boolean, default: false },
        googleId: { type: String, unique: true, sparse: true },
    },
    { timestamps: true }
);

webUserSchema.pre("save", async function () {
    if (this.isModified("password") && this.password) {
        this.password = await bcrypt.hash(this.password, 10);
    }
});

webUserSchema.methods.comparePassword = function (candidatePassword) {
    if (!this.password) return false;
    return bcrypt.compare(candidatePassword, this.password);
};

export const WebUser = mongoose.models.WebUser || mongoose.model("WebUser", webUserSchema);

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const Bot = mongoose.models.Bot || mongoose.model("Bot", botSchema);
export const Product =
    mongoose.models.Product || mongoose.model("Product", productSchema);
export const Category =
    mongoose.models.Category || mongoose.model("Category", categorySchema);
export const Transaction =
    mongoose.models.Transaction ||
    mongoose.model("Transaction", transactionSchema);
export const AuthUser =
    mongoose.models.AuthUser || mongoose.model("AuthUser", authUserSchema);
export const ProductStock =
    mongoose.models.ProductStock ||
    mongoose.model("ProductStock", productStockSchema);

export async function startInit() {
    await User.init();
    await Bot.init();
    await Product.init();
    await Category.init();
    await Transaction.init();
    await ProductStock.init();
    await PaymentIntent.init();
}

export async function checkUser(id) {
    try {
        const exist = await User.exists({ userId: id });
        return { success: true, data: !!exist };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function dbUser(id) {
    try {
        const user = await User.findOne({ userId: id }).lean();
        return { success: true, data: user };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function userRegister(id, name, username) {
    try {
        const exist = await User.exists({ userId: id });
        if (exist) return { success: false, error: "ID sudah digunakan." };

        const create = await User.create({ userId: id, name, username });
        return { success: true, data: create };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function updateUserProfile(id, name, username) {
    try {
        const update = await User.findOneAndUpdate(
            { userId: id },
            { $set: { name: name, username: username } },
            { new: true }
        ).lean();

        if (!update) return { success: false, error: "ID tidak ditemukan." };
        return { success: true, data: update };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function editBalance(id, amount) {
    try {
        if (!id || amount == null || isNaN(amount))
            throw new Error("Input tidak valid!");

        const update = await User.findOneAndUpdate(
            { userId: id },
            { $inc: { balance: amount } },
            { new: true }
        ).lean();

        if (!update) return { success: false, error: "ID tidak ditemukan." };
        return { success: true, data: update };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function deductBalanceIfEnough(id, amount) {
    try {
        if (!id || amount == null || isNaN(amount) || amount < 0)
            throw new Error("Input tidak valid!");
        const update = await User.findOneAndUpdate(
            { userId: id, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: true }
        ).lean();

        if (!update) return { success: false, error: "Saldo tidak mencukupi." };
        return { success: true, data: update };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function refundBalance(id, amount) {
    return editBalance(id, amount);
}

export async function banUser(id) {
    try {
        const update = await User.findOneAndUpdate(
            { userId: id },
            { $set: { isBanned: true } },
            { new: true }
        ).lean();
        if (!update) return { success: false, error: "User tidak ditemukan" };
        return { success: true, data: update };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function unbanUser(id) {
    try {
        const update = await User.findOneAndUpdate(
            { userId: id },
            { $set: { isBanned: false } },
            { new: true }
        ).lean();
        if (!update) return { success: false, error: "User tidak ditemukan" };
        return { success: true, data: update };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function editRole(id, role) {
    try {
        if (!id || !role) throw new Error("Masukan data id dan role!");
        const update = await User.findOneAndUpdate(
            { userId: id },
            { $set: { role } },
            { new: true }
        ).lean();
        if (!update) return { success: false, error: "ID tidak ditemukan." };
        return { success: true, data: update };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getAllUsers() {
    try {
        const users = await User.find({}).select("-__v").lean();
        return { success: true, data: users };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function deleteUser(userId) {
    try {
        const user = await User.findOneAndDelete({ userId });
        if (!user) return { success: false, error: "User tidak ditemukan." };
        await AuthUser.deleteOne({ telegramId: userId });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getTelegramUsers() {
    try {
        let data = await User.find({ isTelegram: true })
            .select("userId name")
            .lean();
        return data;
    } catch (error) {
        return [];
    }
}

export async function checkDbBot(id) {
    try {
        const exist = await Bot.exists({ botId: id });
        return { success: true, data: !!exist };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function createDbBot(id, name) {
    try {
        const exist = await Bot.findOne({ botId: id });
        if (exist) return { success: false, error: "ID bot sudah terdaftar." };
        const create = await Bot.create({ botId: id, name });
        return { success: true, data: create };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getBotSimple(botId) {
    try {
        const bot = await Bot.findOne({ botId }).lean();
        if (!bot) return { success: false, error: "Bot tidak ditemukan" };
        return { success: true, data: bot };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function dbBot(botId) {
    try {
        const botPromise = Bot.findOne({ botId }).lean();
        const productsPromise = Product.find({ botId }).lean();
        const categoriesPromise = Category.find({ botId }).lean();

        const stockPromise = ProductStock.aggregate([
            { $match: { botId: botId, isSold: false } },
            { $group: { _id: "$productId", count: { $sum: 1 } } },
        ]);

        const [bot, products, categories, stockAgg] = await Promise.all([
            botPromise,
            productsPromise,
            categoriesPromise,
            stockPromise,
        ]);

        if (!bot) return { success: false, message: "Bot not found" };

        const stockMap = {};
        stockAgg.forEach((s) => (stockMap[s._id] = s.count));

        const productMap = new Map();
        products.forEach((p) => {
            productMap.set(p.productId, {
                ...p,
                stock: stockMap[p.productId] || 0,
            });
        });

        const viewMap = new Map();
        categories.forEach((c) => {
            viewMap.set(c.name, { id: c.products });
        });

        const resultBot = { ...bot };
        resultBot.product = productMap;
        resultBot.product_view = viewMap;

        return { success: true, data: resultBot };
    } catch (e) {
        return { success: false, message: e.message };
    }
}

export async function getCategory(botId) {
    try {
        const categories = await Category.find({ botId }).lean();
        const catObj = {};
        categories.forEach((c) => {
            catObj[c.name] = c.products;
        });
        return { success: true, data: catObj };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function getProductList(botId) {
    try {
        const [products, stockAgg, categories] = await Promise.all([
            Product.find({ botId }).lean(),
            ProductStock.aggregate([
                { $match: { botId: botId, isSold: false } },
                { $group: { _id: "$productId", count: { $sum: 1 } } },
            ]),
            Category.find({ botId }).lean()
        ]);

        const stockMap = {};
        stockAgg.forEach((s) => (stockMap[s._id] = s.count));
        
        // Map product to category
        const categoryMap = {};
        categories.forEach(cat => {
            if (cat.products && Array.isArray(cat.products)) {
                cat.products.forEach(pid => {
                    categoryMap[pid] = cat.name;
                });
            }
        });

        const result = products.map((p) => ({
            ...p,
            stock: stockMap[p.productId] || 0,
            category: categoryMap[p.productId] || "Lainnya"
        }));

        return { success: true, data: result };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function getProductDetails(botId, productId) {
    try {
        const [product, stockCount] = await Promise.all([
            Product.findOne({ botId, productId }).lean(),
            ProductStock.countDocuments({ botId, productId, isSold: false }),
        ]);

        if (!product) return { success: false, error: "Produk tidak ditemukan." };

        return { success: true, data: { ...product, stock: stockCount } };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function takeProductAccount(
    botId,
    productId,
    total = 1,
    trxRefId = null
) {
    await connectDB();
    if (!trxRefId) throw new Error("trxRefId wajib.");
    if (total <= 0) return { success: false, error: "Jumlah harus > 0." };

    const lockKey = `alloc:${botId}:${productId}`;
    if (!processingLocks.lock(lockKey, 20000)) {
        return {
            success: false,
            error: "Sedang diproses, coba lagi sebentar lagi.",
        };
    }

    try {
        const candidates = await ProductStock.find({
            botId,
            productId,
            isSold: false,
        })
            .sort({ createdAt: 1 })
            .limit(total)
            .select("_id accountData")
            .lean();

        if (!candidates || candidates.length < total) {
            return { success: false, error: "Stok tidak mencukupi." };
        }

        const ids = candidates.map((d) => d._id);
        const chunkSize = 2000;
        const chunkedIds = [];
        for (let i = 0; i < ids.length; i += chunkSize) {
            chunkedIds.push(ids.slice(i, i + chunkSize));
        }

        const updatePromises = chunkedIds.map((chunk) =>
            ProductStock.updateMany(
                { _id: { $in: chunk }, isSold: false },
                { $set: { isSold: true, trxRefId: trxRefId } }
            )
        );

        await Promise.all(updatePromises);
        const takenAccounts = candidates.map((d) => d.accountData);
        return { success: true, data: takenAccounts, trxRefId };
    } catch (err) {
        try {
            if (trxRefId)
                await ProductStock.updateMany(
                    { trxRefId: trxRefId },
                    { $set: { isSold: false, trxRefId: null } }
                );
        } catch (e) { }
        return { success: false, error: err.message };
    } finally {
        processingLocks.unlock(lockKey);
    }
}

export async function addTransactionHistory(
    userId,
    botId,
    productId,
    productName,
    quantity,
    price,
    status,
    paymentMethod,
    snk,
    reffId
) {
    try {
        const totalAmount = price * quantity;
        const newTrx = await Transaction.create({
            userId,
            botId,
            productId,
            productName,
            quantity,
            price,
            status: status || "completed",
            totalAmount,
            paymentMethod: paymentMethod || "balance",
            snk: snk || "",
            reffId,
        });
        return { success: true, data: newTrx };
    } catch (e) {
        if (e.code === 11000)
            return { success: false, error: "Duplicate transaction (reffId)." };
        return { success: false, error: e.message };
    }
}

export async function addUserTransaction(
    userId,
    totalTransaksi,
    totalMembeli,
    nominal
) {
    try {
        const update = await User.findOneAndUpdate(
            { userId },
            {
                $inc: {
                    transaksi: totalTransaksi,
                    membeli: totalMembeli,
                    total_nominal_transaksi: nominal,
                },
            },
            { new: true }
        );
        return { success: true, data: update };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function addBotTransaction(
    botId,
    totalTransaksi = 1,
    totalNominal = 0
) {
    try {
        const update = await Bot.findOneAndUpdate(
            { botId },
            {
                $inc: {
                    transaksi: totalTransaksi,
                    total_nominal_transaksi: totalNominal,
                },
            },
            { new: true }
        );
        return { success: true, data: update };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function addProductSold(botId, productId, totalTerjual) {
    try {
        await Bot.findOneAndUpdate({ botId }, { $inc: { terjual: totalTerjual } });
        const updated = await Product.findOneAndUpdate(
            { botId, productId },
            { $inc: { terjual: totalTerjual } },
            { new: true }
        );
        return { success: true, data: updated };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function recordSale(botId, productCode, quantity, finalPrice) {
    try {
        await Product.updateOne(
            { botId, productId: productCode },
            { $inc: { terjual: quantity } }
        );
        await Bot.findOneAndUpdate(
            { botId },
            { $inc: { terjual: quantity, soldtoday: quantity, trxtoday: finalPrice } }
        );

        addDailyStats(quantity, finalPrice);
    } catch (dbError) {
        console.error("Stats update error:", dbError);
    }
}

export async function addProduct(botId, productData) {
    try {
        const exists = await Product.exists({ botId, productId: productData.id });
        if (exists) return { success: false, error: "ID produk sudah ada." };

        const newProduct = await Product.create({
            botId,
            productId: productData.id,
            name: productData.name,
            price: productData.price,
            desc: productData.desc || "",
            snk: productData.snk || "",
            terjual: 0,
        });
        return { success: true, data: newProduct };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function addStock(botId, productId, accounts = []) {
    try {
        const productExists = await Product.exists({ botId, productId });
        if (!productExists)
            return { success: false, error: "Produk tidak ditemukan." };

        const stockDocs = accounts.map((accountData) => ({
            botId,
            productId,
            accountData,
            isSold: false,
        }));
        const result = await ProductStock.insertMany(stockDocs);
        return { success: true, data: { insertedCount: result.length } };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function addProductStock(botId, productId, accounts) {
    const res = await addStock(botId, productId, accounts);
    if (res.success) {
        const stockCount = await ProductStock.countDocuments({
            botId,
            productId,
            isSold: false,
        });
        return { success: true, data: { stock: stockCount } };
    }
    return res;
}

export async function deleteProduct(botId, productId) {
    try {
        const result = await Product.deleteOne({ botId, productId });
        if (result.deletedCount === 0)
            return { success: false, error: "Produk tidak ditemukan." };

        await ProductStock.deleteMany({ botId, productId });
        await Category.updateMany({ botId }, { $pull: { products: productId } });

        return { success: true, data: `Produk ${productId} berhasil dihapus.` };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function editProductName(botId, productId, newName) {
    try {
        const product = await Product.findOneAndUpdate(
            { botId, productId },
            { name: newName },
            { new: true }
        );
        if (!product) return { success: false, error: "Produk tidak ditemukan." };
        return { success: true, data: product };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function editProductPrice(botId, productId, newPrice) {
    try {
        const product = await Product.findOneAndUpdate(
            { botId, productId },
            { price: Number(newPrice) },
            { new: true }
        );
        if (!product) return { success: false, error: "Produk tidak ditemukan." };
        return { success: true, data: product };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function editProductDesk(botId, productId, newDesc) {
    try {
        const product = await Product.findOneAndUpdate(
            { botId, productId },
            { desc: newDesc },
            { new: true }
        );
        if (!product) return { success: false, error: "Produk tidak ditemukan." };
        return { success: true, data: product };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function editProductSnk(botId, productId, newSnk) {
    try {
        const product = await Product.findOneAndUpdate(
            { botId, productId },
            { snk: newSnk },
            { new: true }
        );
        if (!product) return { success: false, error: "Produk tidak ditemukan." };
        return { success: true, data: product };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function editProductID(botId, oldId, newId) {
    try {
        const checkNew = await Product.findOne({ botId, productId: newId });
        if (checkNew) return { success: false, error: "ID baru sudah digunakan." };

        const product = await Product.findOneAndUpdate(
            { botId, productId: oldId },
            { productId: newId },
            { new: true }
        );
        if (!product) return { success: false, error: "Produk tidak ditemukan." };

        await ProductStock.updateMany(
            { botId, productId: oldId },
            { $set: { productId: newId } }
        );

        const cats = await Category.find({ botId, products: oldId });
        for (let cat of cats) {
            const idx = cat.products.indexOf(oldId);
            if (idx !== -1) {
                cat.products[idx] = newId;
                await cat.save();
            }
        }
        return { success: true, data: product };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getProductAccount(botId, productId, total = 1) {
    try {
        const accounts = await ProductStock.find({
            botId,
            productId,
            isSold: false,
        })
            .select("accountData")
            .limit(total)
            .lean();
        const accountStrings = accounts.map((doc) => doc.accountData);
        return { success: true, data: accountStrings };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function addCategory(botId, categoryName, productIds) {
    try {
        const botExists = await Bot.exists({ botId });
        if (!botExists) return { success: false, error: "Bot tidak ditemukan." };
        const exist = await Category.exists({ botId, name: categoryName });
        if (exist) return { success: false, error: "Kategori sudah ada." };
        await Category.create({ botId, name: categoryName, products: productIds });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function updateCategory(botId, categoryName, productIds) {
    try {
        const category = await Category.findOneAndUpdate(
            { botId, name: categoryName },
            { products: productIds },
            { new: true }
        );
        if (!category)
            return { success: false, error: "Kategori tidak ditemukan." };
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function deleteCategory(botId, categoryName) {
    try {
        const res = await Category.deleteOne({ botId, name: categoryName });
        if (res.deletedCount === 0)
            return { success: false, error: "Kategori tidak ditemukan." };
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getPublicStats(botId) {
    try {
        const bot = await Bot.findOne({ botId })
            .select("total_nominal_transaksi terjual")
            .lean();
        if (!bot) return { success: false, error: "Bot stats not ready" };
        return {
            success: true,
            data: {
                totalRevenue: bot.total_nominal_transaksi || 0,
                totalProductsSold: bot.terjual || 0,
            },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function getAdminStats(botId) {
    try {
        const [totalUsers, totalTransactions, totalProducts, bot] =
            await Promise.all([
                User.countDocuments({}),
                Transaction.countDocuments({ botId }),
                Product.countDocuments({ botId }),
                Bot.findOne({ botId }).select("total_nominal_transaksi terjual").lean(),
            ]);
        return {
            success: true,
            data: {
                totalUsers,
                totalTransactions,
                totalProducts,
                totalRevenue: bot ? bot.total_nominal_transaksi : 0,
                totalProductsSold: bot ? bot.terjual : 0,
            },
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function addBotTransactionDetailed(
    botId,
    totalTransaksi,
    totalTerjual,
    totalSoldToday,
    totalTrxToday,
    nominalLifetime,
    nominalToday
) {
    try {
        const update = await Bot.findOneAndUpdate(
            { botId },
            {
                $inc: {
                    transaksi: totalTransaksi,
                    terjual: totalTerjual,
                    soldtoday: totalSoldToday,
                    trxtoday: totalTrxToday,
                    total_nominal_transaksi: nominalLifetime,
                    nominaltoday: nominalToday,
                },
            },
            { new: true }
        );
        if (!update) return { success: false, error: "ID Bot tidak ditemukan." };
        return { success: true, data: update };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getTransactionDetails(reffId) {
    try {
        const transaction = await Transaction.findOne({ reffId }).lean();
        if (!transaction)
            return { success: false, error: "Transaksi tidak ditemukan." };
        const soldAccounts = await ProductStock.find({ trxRefId: reffId })
            .select("accountData")
            .lean();
        transaction.accounts = soldAccounts.map((doc) => doc.accountData);
        return { success: true, data: transaction };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getAllTransactions(botId) {
    try {
        const transactions = await Transaction.find({ botId })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
        return { success: true, data: transactions };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function calculateTotalRevenue() {
    try {
        const result = await Transaction.aggregate([
            { $match: { status: "completed" } },
            { $group: { _id: null, total: { $sum: "$totalAmount" } } },
        ]);
        return result[0]?.total || 0;
    } catch (err) {
        return 0;
    }
}

export async function getRevenueByDate(startDate, endDate) {
    try {
        const result = await Transaction.aggregate([
            {
                $match: {
                    status: "completed",
                    createdAt: { $gte: startDate, $lte: endDate },
                },
            },
            { $group: { _id: null, total: { $sum: "$totalAmount" } } },
        ]);
        return result[0]?.total || 0;
    } catch (err) {
        return 0;
    }
}

export async function calculateTotalPcs() {
    try {
        const result = await Transaction.aggregate([
            { $match: { status: "completed" } },
            { $group: { _id: null, totalPcs: { $sum: "$quantity" } } },
        ]);
        return result[0]?.totalPcs || 0;
    } catch (err) {
        return 0;
    }
}

export async function getPcsPerProduk() {
    try {
        const result = await Transaction.aggregate([
            { $match: { status: "completed" } },
            {
                $group: {
                    _id: "$productId",
                    productName: { $first: "$productName" },
                    totalPcs: { $sum: "$quantity" },
                    totalRevenue: { $sum: "$totalAmount" },
                },
            },
            { $sort: { totalPcs: -1 } },
        ]);
        return result;
    } catch (err) {
        return [];
    }
}

export async function getPcsTerjualPerProduk(productId) {
    try {
        const result = await Transaction.aggregate([
            { $match: { status: "completed", productId } },
            { $group: { _id: "$productId", totalPcs: { $sum: "$quantity" } } },
        ]);
        return result[0]?.totalPcs || 0;
    } catch (err) {
        return 0;
    }
}

async function pcsPerProdukDariTransaksi(botId) {
    const hasil = await Transaction.aggregate([
        { $match: { status: "completed", botId } },
        {
            $group: {
                _id: "$productId",
                namaProduk: { $first: "$productName" },
                totalPcs: { $sum: "$quantity" },
                totalPendapatan: { $sum: "$totalAmount" },
            },
        },
        { $sort: { totalPcs: -1 } },
    ]);
    return hasil;
}

export async function totalTransaksi(botId) {
    try {
        let data = await pcsPerProdukDariTransaksi(botId);
        let totalPcs = 0;
        let totalPendapatan = 0;
        data.forEach((item) => {
            totalPcs += item.totalPcs;
            totalPendapatan += item.totalPendapatan;
        });
        return { totalPcs, totalPendapatan };
    } catch (e) {
        return { totalPcs: 0, totalPendapatan: 0 };
    }
}

export async function getProdukPopuler(botId, limit = 10) {
    try {
        const popular = await Product.find({ botId })
            .sort({ terjual: -1 })
            .limit(limit)
            .select("productId name terjual price")
            .lean();

        const formatted = popular.map((p) => ({
            _id: p.productId,
            productName: p.name,
            totalSold: p.terjual,
            totalRevenue: p.terjual * p.price,
            lastTransaction: null,
        }));

        return { success: true, data: formatted };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function getUserTransactionHistory(userId, limit = 10, skip = 0) {
    try {
        const history = await Transaction.find({ userId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .skip(skip);
        return { success: true, data: history };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getBotGlobalTransactionHistory(
    botId,
    limit = 10,
    skip = 0
) {
    try {
        const history = await Transaction.find({ botId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .skip(skip);
        return { success: true, data: history };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export async function getDBData(fn, ...args) {
    try {
        const result = await fn(...args);
        if (!result.success) throw new Error(result.message);
        return result.data;
    } catch (e) {
        return null;
    }
}

export async function getLeaderboard(botId, limit = 10) {
    try {
        const topUsers = await Transaction.aggregate([
            { $match: { botId: botId, status: "completed" } },
            {
                $group: {
                    _id: "$userId",
                    totalRevenue: { $sum: "$totalAmount" },
                    totalTransactions: { $sum: 1 },
                    totalPcs: { $sum: "$quantity" },
                },
            },
            { $sort: { totalRevenue: -1 } },
            { $limit: limit },
        ]);

        const formattedResult = topUsers.map((user) => ({
            userId: user._id,
            totalRevenue: user.totalRevenue,
            totalTransactions: user.totalTransactions,
            totalPcs: user.totalPcs,
        }));

        return { success: true, data: formattedResult };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

const paymentGatewaySettingSchema = new mongoose.Schema({
    gateway_name: { type: String, required: true, unique: true },
    is_active: { type: Boolean, default: false },
    settings: { type: Object, default: {} }
}, { timestamps: true });

export const PaymentGatewaySetting = mongoose.models.PaymentGatewaySetting || mongoose.model('PaymentGatewaySetting', paymentGatewaySettingSchema);

const smtpSettingSchema = new mongoose.Schema({
    email: { type: String, required: true },
    password: { type: String, required: true },
    host: { type: String, default: 'smtp.gmail.com' },
    port: { type: Number, default: 465 },
    secure: { type: Boolean, default: true }
}, { timestamps: true });

export const SmtpSetting = mongoose.models.SmtpSetting || mongoose.model('SmtpSetting', smtpSettingSchema);

