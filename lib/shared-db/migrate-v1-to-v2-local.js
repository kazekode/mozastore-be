import mongoose from "mongoose";
import * as V2 from "./index.js";
import fs from "fs";
import path from "path";

if (process.env.NODE_ENV === "production" && process.argv.indexOf("--confirm-production-migration") === -1) {
    console.error("❌ ERROR: Production environment detected. You must pass --confirm-production-migration to execute this script.");
    process.exit(1);
}

const v2Connection = mongoose.createConnection(process.env.MONGODB_V2_URI || "mongodb+srv://moza:store@apkprem.0hkn542.mongodb.net/MannDB_V2?retryWrites=true&w=majority");

async function runMigrationLocal() {
    console.log("Starting Migration from V1 Backup (JSON) to V2 Production...");
    
    // Bind V2 models to V2 connection
    const V2User = v2Connection.model("User", V2.User.schema);
    const V2Bot = v2Connection.model("Bot", V2.Bot.schema);
    const V2Category = v2Connection.model("Category", V2.Category.schema);
    const V2Product = v2Connection.model("Product", V2.Product.schema);
    const V2ProductStock = v2Connection.model("ProductStock", V2.ProductStock.schema);
    const V2Order = v2Connection.model("Order", V2.Order.schema);
    const V2Transaction = v2Connection.model("Transaction", V2.Transaction.schema);
    const V2DailySalesSummary = v2Connection.model("DailySalesSummary", V2.DailySalesSummary.schema);

    console.log("Wiping V2 Production Target...");
    await Promise.all([
        V2User.deleteMany({}), V2Bot.deleteMany({}), V2Category.deleteMany({}),
        V2Product.deleteMany({}), V2ProductStock.deleteMany({}),
        V2Order.deleteMany({}), V2Transaction.deleteMany({}), V2DailySalesSummary.deleteMany({})
    ]);

    const backupDir = path.resolve("./v1_backup");
    
    console.log("Loading V1 JSON...");
    const v1Users = JSON.parse(fs.readFileSync(path.join(backupDir, "users.json")));
    const v1Bots = JSON.parse(fs.readFileSync(path.join(backupDir, "bots.json")));
    const v1Cats = JSON.parse(fs.readFileSync(path.join(backupDir, "categories.json")));
    const v1Prods = JSON.parse(fs.readFileSync(path.join(backupDir, "products.json")));
    const v1Stocks = JSON.parse(fs.readFileSync(path.join(backupDir, "productstocks.json")));
    const v1Txs = JSON.parse(fs.readFileSync(path.join(backupDir, "transactions.json")));

    console.log("1. Migrating Users...");
    const newUsers = v1Users.map(u => ({
        userId: u.userId, name: u.name, username: u.username, role: u.role, balance: u.balance,
        isTelegram: u.isTelegram, banned: u.banned, isBanned: u.isBanned,
        stats: { totalSpent: u.total_nominal_transaksi || 0, totalTransactions: u.transaksi || 0, totalItems: u.membeli || 0 }
    }));
    // Bulk insert
    for(let i=0; i<newUsers.length; i+=500) await V2User.insertMany(newUsers.slice(i, i+500), {ordered: false}).catch(e=>console.log("ignoring user dupes"));
    
    console.log("2. Migrating Bots...");
    for(const b of v1Bots) {
        await V2Bot.create({
            botId: b.botId, name: b.name,
            stats: { lifetimeRevenue: b.total_nominal_transaksi || 0, lifetimeTransactions: b.transaksi || 0, lifetimeSold: b.terjual || 0 }
        }).catch(e=>console.log("ignoring bot dupes"));
    }

    console.log("3. Migrating Categories & Products...");
    const categoryIdMap = {};
    for (const c of v1Cats) {
        const newCat = await V2Category.create({ botId: c.botId, name: c.name, image_url: c.image_url, sort_order: c.sort_order });
        categoryIdMap[c.name] = newCat._id;
    }
    const prodToCatMap = {};
    for (const c of v1Cats) {
        if (c.products && Array.isArray(c.products)) {
            for (const p of c.products) prodToCatMap[p] = c.name;
        }
    }
    const newProds = v1Prods.map(p => ({
        botId: p.botId, productId: p.productId, categoryId: prodToCatMap[p.productId] ? categoryIdMap[prodToCatMap[p.productId]] : null,
        name: p.name, price: p.price, original_price: p.original_price, desc: p.desc, snk: p.snk, image_url: p.image_url,
        login_instructions: p.login_instructions, min_order: p.min_order, max_order: p.max_order, sort_order: p.sort_order,
        stats: { soldQuantity: p.terjual || 0, revenue: (p.terjual || 0) * (p.price || 0) }
    }));
    await V2Product.insertMany(newProds, {ordered:false}).catch(e=>console.log("ignoring product dupes"));

    console.log("4. Migrating ProductStocks...");
    let batch = [];
    for(let i=0; i<v1Stocks.length; i++) {
        const s = v1Stocks[i];
        batch.push({
            botId: s.botId, productId: s.productId, accountData: s.accountData,
            status: s.isSold ? 'sold' : 'available', orderId: s.trxRefId || null,
            soldAt: s.isSold ? s.createdAt : null, createdAt: s.createdAt
        });
        if(batch.length >= 5000) {
            await V2ProductStock.insertMany(batch, {ordered: false}).catch(e=>{});
            batch = [];
            process.stdout.write(`\rStocks: ${i+1}/${v1Stocks.length}`);
        }
    }
    if(batch.length > 0) await V2ProductStock.insertMany(batch, {ordered: false}).catch(e=>{});

    console.log("\n5. Migrating Orders & Transactions...");
    const dailyMap = {};
    let batchO = [];
    let batchT = [];
    for(let i=0; i<v1Txs.length; i++) {
        const tx = v1Txs[i];
        const orderId = tx.orderId || tx.reffId;
        const totalAmount = tx.totalAmount || (tx.quantity * tx.price);
        
        batchO.push({
            orderId: orderId, botId: tx.botId || 1, userId: typeof tx.userId === 'number' ? tx.userId : 0,
            source: tx.source || 'telegram', isGuest: tx.isGuest || false, guestEmail: tx.guestEmail || null,
            items: [{ productId: tx.productId, productName: tx.productName || 'Unknown', quantity: tx.quantity || 1, price: tx.price || 0, subtotal: totalAmount }],
            totalAmount: totalAmount, status: tx.status === 'completed' || tx.status === 'paid' ? 'completed' : 'pending',
            paymentMethod: tx.paymentMethod || 'balance', paymentReference: tx.reffId,
            paidAt: tx.status === 'completed' ? tx.createdAt : null, completedAt: tx.status === 'completed' ? tx.createdAt : null, createdAt: tx.createdAt
        });

        batchT.push({
            transactionId: tx.reffId, orderId: orderId, botId: tx.botId || 1, userId: typeof tx.userId === 'number' ? tx.userId : 0,
            type: 'order_payment', amount: totalAmount, status: tx.status === 'completed' ? 'success' : 'failed',
            paymentMethod: tx.paymentMethod || 'balance', reference: tx.reffId, createdAt: tx.createdAt
        });

        if (tx.status === 'completed') {
            const dateStr = new Date(tx.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
            const key = `${tx.botId || 1}_${dateStr}`;
            if (!dailyMap[key]) dailyMap[key] = { botId: tx.botId || 1, date: dateStr, revenue: 0, trx: 0, items: 0 };
            dailyMap[key].revenue += totalAmount;
            dailyMap[key].trx += 1;
            dailyMap[key].items += (tx.quantity || 1);
        }

        if(batchO.length >= 2000) {
            await V2Order.insertMany(batchO, {ordered: false}).catch(e=>{});
            await V2Transaction.insertMany(batchT, {ordered: false}).catch(e=>{});
            batchO = []; batchT = [];
            process.stdout.write(`\rTxs: ${i+1}/${v1Txs.length}`);
        }
    }
    if(batchO.length > 0) {
        await V2Order.insertMany(batchO, {ordered: false}).catch(e=>{});
        await V2Transaction.insertMany(batchT, {ordered: false}).catch(e=>{});
    }

    console.log("\n6. Building DailySalesSummary...");
    const summaryDocs = Object.values(dailyMap).map(d => ({
        botId: d.botId, date: d.date, totalRevenue: d.revenue, totalTransactions: d.trx, totalItemsSold: d.items
    }));
    if (summaryDocs.length > 0) await V2DailySalesSummary.insertMany(summaryDocs, {ordered: false});

    console.log("Migration Complete.");
    process.exit(0);
}

runMigrationLocal().catch(e => {
    console.error(e);
    process.exit(1);
});
