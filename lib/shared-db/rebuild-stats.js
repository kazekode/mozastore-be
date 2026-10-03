import mongoose from "mongoose";
import * as V2 from "./index.js"; 

if (process.env.NODE_ENV === "production" && process.argv.indexOf("--confirm-production-rebuild") === -1) {
    console.error("❌ ERROR: Production environment detected. You must pass --confirm-production-rebuild to execute this script.");
    process.exit(1);
}

const TEST_URI = process.env.MONGODB_V2_URI || "mongodb+srv://moza:store@apkprem.0hkn542.mongodb.net/MannDB_V2_Migration_Rehearsal?retryWrites=true&w=majority";

async function runRebuild() {
    await V2.connectDB(TEST_URI);
    console.log("Starting Stats Rebuild...");

    // 1. Reset all stats
    await V2.User.updateMany({}, { $set: { "stats.totalSpent": 0, "stats.totalTransactions": 0, "stats.totalItems": 0 } });
    await V2.Bot.updateMany({}, { $set: { "stats.lifetimeRevenue": 0, "stats.lifetimeTransactions": 0, "stats.lifetimeSold": 0 } });
    await V2.Product.updateMany({}, { $set: { "stats.soldQuantity": 0, "stats.revenue": 0 } });
    await V2.DailySalesSummary.deleteMany({});
    
    // 2. Aggregate from Orders
    const orders = await V2.Order.find({ status: 'completed' }).lean();
    
    const dailyMap = {};
    const userMap = {};
    const botMap = {};
    const prodMap = {};

    for (const order of orders) {
        const qty = order.items.reduce((s, item) => s + item.quantity, 0);

        if (!userMap[order.userId]) userMap[order.userId] = { spent: 0, trx: 0, items: 0 };
        userMap[order.userId].spent += order.totalAmount;
        userMap[order.userId].trx += 1;
        userMap[order.userId].items += qty;

        if (!botMap[order.botId]) botMap[order.botId] = { rev: 0, trx: 0, items: 0 };
        botMap[order.botId].rev += order.totalAmount;
        botMap[order.botId].trx += 1;
        botMap[order.botId].items += qty;

        for (const item of order.items) {
            const pKey = `${order.botId}_${item.productId}`;
            if (!prodMap[pKey]) prodMap[pKey] = { botId: order.botId, pId: item.productId, qty: 0, rev: 0 };
            prodMap[pKey].qty += item.quantity;
            prodMap[pKey].rev += item.subtotal;
        }

        const dateStr = new Date(order.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
        const key = `${order.botId}_${dateStr}`;
        if (!dailyMap[key]) dailyMap[key] = { botId: order.botId, date: dateStr, rev: 0, trx: 0, items: 0 };
        
        dailyMap[key].rev += order.totalAmount;
        dailyMap[key].trx += 1;
        dailyMap[key].items += qty;
    }

    // 3. Bulk Updates
    const userBulk = Object.keys(userMap).map(uId => ({
        updateOne: { filter: { userId: uId }, update: { $set: { "stats.totalSpent": userMap[uId].spent, "stats.totalTransactions": userMap[uId].trx, "stats.totalItems": userMap[uId].items } } }
    }));
    if (userBulk.length > 0) await V2.User.bulkWrite(userBulk);

    const botBulk = Object.keys(botMap).map(bId => ({
        updateOne: { filter: { botId: bId }, update: { $set: { "stats.lifetimeRevenue": botMap[bId].rev, "stats.lifetimeTransactions": botMap[bId].trx, "stats.lifetimeSold": botMap[bId].items } } }
    }));
    if (botBulk.length > 0) await V2.Bot.bulkWrite(botBulk);

    const prodBulk = Object.keys(prodMap).map(pKey => ({
        updateOne: { filter: { botId: prodMap[pKey].botId, productId: prodMap[pKey].pId }, update: { $set: { "stats.soldQuantity": prodMap[pKey].qty, "stats.revenue": prodMap[pKey].rev } } }
    }));
    if (prodBulk.length > 0) await V2.Product.bulkWrite(prodBulk);

    const summaries = Object.values(dailyMap).map(d => ({
        botId: d.botId, date: d.date, totalRevenue: d.rev, totalTransactions: d.trx, totalItemsSold: d.items
    }));
    if (summaries.length > 0) await V2.DailySalesSummary.insertMany(summaries);

    console.log("Stats Rebuild Complete.");
    process.exit(0);
}

runRebuild().catch(console.error);
