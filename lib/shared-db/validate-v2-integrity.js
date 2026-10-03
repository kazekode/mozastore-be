import mongoose from "mongoose";
import * as V2 from "./index.js";

const TEST_URI = "mongodb+srv://moza:store@apkprem.0hkn542.mongodb.net/MannDB_V2_Migration_Rehearsal?retryWrites=true&w=majority";

async function runIntegrityCheck() {
    console.log("Connecting to V2 TEST DB...");
    await V2.connectDB(TEST_URI);
    console.log("Connected.");

    let errors = 0;
    const assert = (condition, msg) => {
        if (!condition) {
            console.error(`❌ FAIL: ${msg}`);
            errors++;
        } else {
            console.log(`✅ PASS: ${msg}`);
        }
    };

    console.log("\n--- 1. CALCULATING SOURCE OF TRUTH ---");
    
    // Aggregate Orders
    const orderAgg = await V2.Order.aggregate([
        { $match: { status: 'completed' } },
        { $unwind: "$items" },
        { $group: {
            _id: null,
            totalRevenue: { $sum: "$totalAmount" },
            totalItems: { $sum: "$items.quantity" },
            totalOrders: { $sum: 1 } // Note: Since we unwound items, this counts items arrays. Let's fix this.
        }}
    ]);

    // Better Order Aggregation
    const orderStats = await V2.Order.aggregate([
        { $match: { status: 'completed' } },
        { $group: {
            _id: null,
            totalRevenue: { $sum: "$totalAmount" },
            totalOrders: { $sum: 1 },
            itemsArray: { $push: "$items" }
        }}
    ]);
    
    let sotRevenue = orderStats[0]?.totalRevenue || 0;
    let sotOrders = orderStats[0]?.totalOrders || 0;
    let sotItems = 0;
    if (orderStats[0] && orderStats[0].itemsArray) {
        orderStats[0].itemsArray.forEach(items => {
            items.forEach(item => { sotItems += item.quantity; });
        });
    }

    console.log(`SoT -> Revenue: ${sotRevenue}, Orders: ${sotOrders}, Items: ${sotItems}`);

    console.log("\n--- 2. BOT RECONCILIATION ---");
    const bot = await V2.Bot.findOne({ botId: 1 });
    assert(bot.stats.lifetimeRevenue === sotRevenue, `Bot Revenue (${bot.stats.lifetimeRevenue}) == SoT (${sotRevenue})`);
    assert(bot.stats.lifetimeTransactions === sotOrders, `Bot Transactions (${bot.stats.lifetimeTransactions}) == SoT (${sotOrders})`);
    assert(bot.stats.lifetimeSold === sotItems, `Bot Items (${bot.stats.lifetimeSold}) == SoT (${sotItems})`);

    console.log("\n--- 3. USER RECONCILIATION ---");
    // Precise user SoT
    const userSoT = await V2.Order.aggregate([
        { $match: { status: 'completed' } },
        { $group: {
            _id: "$userId",
            spent: { $sum: "$totalAmount" },
            trx: { $sum: 1 },
            itemsArr: { $push: "$items" }
        }}
    ]);

    for (const u of userSoT) {
        let uItems = 0;
        u.itemsArr.forEach(arr => arr.forEach(i => uItems += i.quantity));
        const userDoc = await V2.User.findOne({ userId: u._id });
        if (userDoc) {
            assert(userDoc.stats.totalSpent === u.spent, `User ${u._id} spent match`);
            assert(userDoc.stats.totalTransactions === u.trx, `User ${u._id} trx match`);
            assert(userDoc.stats.totalItems === uItems, `User ${u._id} items match`);
        }
    }

    console.log("\n--- 4. PRODUCT RECONCILIATION ---");
    const prodSoT = await V2.Order.aggregate([
        { $match: { status: 'completed' } },
        { $unwind: "$items" },
        { $group: {
            _id: "$items.productId",
            soldQty: { $sum: "$items.quantity" },
            rev: { $sum: "$items.subtotal" }
        }}
    ]);

    for (const p of prodSoT) {
        const prodDoc = await V2.Product.findOne({ productId: p._id });
        if (prodDoc) {
            assert(prodDoc.stats.soldQuantity === p.soldQty, `Product ${p._id} sold qty match`);
            assert(prodDoc.stats.revenue === p.rev, `Product ${p._id} revenue match`);
        }
    }

    console.log("\n--- 5. DAILY SUMMARY RECONCILIATION ---");
    const summaryAgg = await V2.DailySalesSummary.aggregate([
        { $group: {
            _id: null,
            totalRev: { $sum: "$totalRevenue" },
            totalTrx: { $sum: "$totalTransactions" },
            totalItems: { $sum: "$totalItemsSold" }
        }}
    ]);
    const sumRev = summaryAgg[0]?.totalRev || 0;
    const sumTrx = summaryAgg[0]?.totalTrx || 0;
    const sumItems = summaryAgg[0]?.totalItems || 0;
    
    assert(sumRev === sotRevenue, `Summary Revenue (${sumRev}) == SoT (${sotRevenue})`);
    assert(sumTrx === sotOrders, `Summary Trx (${sumTrx}) == SoT (${sotOrders})`);
    assert(sumItems === sotItems, `Summary Items (${sumItems}) == SoT (${sotItems})`);

    console.log("\n--- 6. STOCK INTEGRITY ---");
    const orphanReserved = await V2.ProductStock.countDocuments({ status: 'reserved', orderId: null });
    assert(orphanReserved === 0, "No orphan reserved stock");

    // Check duplicate accountData per product
    const duplicateAccounts = await V2.ProductStock.aggregate([
        { $group: { _id: { pId: "$productId", acc: "$accountData" }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }
    ]);
    assert(duplicateAccounts.length === 0, "No duplicate account data per product");

    console.log(`\nIntegrity Check Finished. Errors: ${errors}`);
    if (errors > 0) process.exit(1);
}

runIntegrityCheck().catch(e => {
    console.error(e);
    process.exit(1);
});
