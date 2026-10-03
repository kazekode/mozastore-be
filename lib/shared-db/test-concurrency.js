import mongoose from "mongoose";
import * as V2 from "../shared-db/index.js";
import { reserveStockAtomic, processOrderPaymentSuccess } from "../shared-db/services.js";

const TEST_URI = "mongodb+srv://moza:store@apkprem.0hkn542.mongodb.net/MannDB_V2_Test?retryWrites=true&w=majority";

const generateStock = (botId, productId, count, prefix) => {
    return Array.from({ length: count }, (_, i) => ({
        botId, productId, accountData: `${prefix}-${i}`, status: 'available'
    }));
};

async function wipeDb() {
    await Promise.all([
        V2.User.deleteMany({}),
        V2.Bot.deleteMany({}),
        V2.Category.deleteMany({}),
        V2.Product.deleteMany({}),
        V2.ProductStock.deleteMany({}),
        V2.Order.deleteMany({}),
        V2.Transaction.deleteMany({}),
        V2.DailySalesSummary.deleteMany({})
    ]);
}

async function setupBasicEntities() {
    await V2.Bot.create({ botId: 1, name: "Stress Bot" });
    await V2.User.create({ userId: 1, name: "User 1" });
    await V2.Category.create({ botId: 1, name: "Stress Category" });
}

async function runStockConcurrency(testName, stockCount, reqCount) {
    console.log(`\n--- Running: ${testName} (Stock: ${stockCount}, Reqs: ${reqCount}) ---`);
    await wipeDb();
    await setupBasicEntities();
    const prodId = "PROD-CONC-1";
    await V2.Product.create({ botId: 1, productId: prodId, name: "Conc Prod", price: 1000 });
    await V2.ProductStock.insertMany(generateStock(1, prodId, stockCount, "ACC"));

    const start = Date.now();
    const promises = [];
    for (let i = 0; i < reqCount; i++) {
        promises.push(reserveStockAtomic(1, prodId, 1, `ORD-${i}`));
    }
    const results = await Promise.all(promises);
    const duration = Date.now() - start;

    const successes = results.filter(r => r.success).length;
    const fails = results.filter(r => !r.success).length;
    const soldCount = await V2.ProductStock.countDocuments({ productId: prodId, status: 'sold' });
    const reservedCount = await V2.ProductStock.countDocuments({ productId: prodId, status: 'reserved' });
    const availCount = await V2.ProductStock.countDocuments({ productId: prodId, status: 'available' });

    console.log(`Duration: ${duration}ms, Success: ${successes}, Fail: ${fails}`);
    console.log(`Stock -> Avail: ${availCount}, Reserved: ${reservedCount}, Sold: ${soldCount}`);

    const expectedSuccess = Math.min(stockCount, reqCount);
    if (successes !== expectedSuccess) throw new Error(`${testName}: Expected ${expectedSuccess} success, got ${successes}`);
    if (reservedCount !== expectedSuccess) throw new Error(`${testName}: Expected ${expectedSuccess} reserved, got ${reservedCount}`);
    if (availCount !== Math.max(0, stockCount - reqCount)) throw new Error(`${testName}: Available mismatch`);
    return { duration, successes, fails };
}

async function runPaymentIdempotency(callCount) {
    console.log(`\n--- Running: Payment Idempotency (${callCount}x concurrent calls) ---`);
    await wipeDb();
    await setupBasicEntities();
    const prodId = "PROD-IDEMP";
    await V2.Product.create({ botId: 1, productId: prodId, name: "Idemp Prod", price: 10000 });
    await V2.ProductStock.insertMany(generateStock(1, prodId, 10, "IDEMP"));

    const orderId = "ORD-IDEMP-1";
    await reserveStockAtomic(1, prodId, 1, orderId);
    await V2.Order.create({
        orderId, botId: 1, userId: 1, source: 'web',
        items: [{ productId: prodId, productName: "Idemp Prod", quantity: 1, price: 10000, subtotal: 10000 }],
        totalAmount: 10000, status: 'pending'
    });

    const start = Date.now();
    const promises = [];
    for (let i = 0; i < callCount; i++) {
        promises.push(processOrderPaymentSuccess(orderId, "qris", "REF-X"));
    }
    const results = await Promise.all(promises);
    const duration = Date.now() - start;

    const successCalls = results.filter(r => r.success && r.order).length; // Only 1 should actually perform the logic
    // The rest should return { success: true, message: "Order already processed..." } which does not have `order` property
    
    const bot = await V2.Bot.findOne({ botId: 1 });
    const p = await V2.Product.findOne({ productId: prodId });
    const u = await V2.User.findOne({ userId: 1 });
    const summary = await V2.DailySalesSummary.findOne({ botId: 1 });
    const soldStocks = await V2.ProductStock.countDocuments({ status: 'sold' });

    console.log(`Duration: ${duration}ms`);
    console.log(`Bot Rev: ${bot.stats.lifetimeRevenue}, Prod Sold: ${p.stats.soldQuantity}, User Spent: ${u.stats.totalSpent}, Summary Rev: ${summary.totalRevenue}`);
    console.log(`Sold Stocks: ${soldStocks}`);

    if (bot.stats.lifetimeRevenue !== 10000) throw new Error("Bot revenue mismatch");
    if (p.stats.soldQuantity !== 1) throw new Error("Product sold mismatch");
    if (summary.totalRevenue !== 10000) throw new Error("Summary revenue mismatch");
    if (soldStocks !== 1) throw new Error("Sold stocks mismatch");
}

async function runVariableQuantityConcurrency() {
    console.log(`\n--- Running: Variable Quantity Concurrency ---`);
    await wipeDb();
    await setupBasicEntities();
    const prodId = "PROD-VAR";
    const stockCount = 100;
    await V2.Product.create({ botId: 1, productId: prodId, name: "Var Prod", price: 1000 });
    await V2.ProductStock.insertMany(generateStock(1, prodId, stockCount, "VAR"));

    const qtys = [1, 2, 3, 5, 10];
    const promises = [];
    for (let i = 0; i < 200; i++) {
        const q = qtys[i % qtys.length];
        promises.push(reserveStockAtomic(1, prodId, q, `ORD-VAR-${i}`));
    }
    const results = await Promise.all(promises);

    let totalAllocated = 0;
    results.forEach(r => {
        if (r.success) totalAllocated += r.data.length;
    });

    const avail = await V2.ProductStock.countDocuments({ productId: prodId, status: 'available' });
    const reserved = await V2.ProductStock.countDocuments({ productId: prodId, status: 'reserved' });

    console.log(`Allocated: ${totalAllocated}, Reserved in DB: ${reserved}, Avail: ${avail}`);
    if (totalAllocated > stockCount) throw new Error(`Over-allocated: ${totalAllocated}`);
    if (reserved !== totalAllocated) throw new Error("Reserved count mismatch with allocated");
    if (avail !== stockCount - totalAllocated) throw new Error("Available stock calculation mismatch");
}

async function checkIntegrity() {
    console.log("\n--- Checking Database Integrity ---");
    // Ensure no stock is in "reserved" without a valid Order
    // (Assuming our test created mock orders for successful reservations)
    // Actually, in the concurrency test we didn't create Orders for the reserved stock, but we did provide an orderId.
    // Let's check for duplicate accountData inside ProductStock across the same botId/productId
    
    const duplicateAccounts = await V2.ProductStock.aggregate([
        { $group: { _id: "$accountData", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }
    ]);
    if (duplicateAccounts.length > 0) throw new Error("Duplicate account data found in stock!");
    
    console.log("No duplicate account data found.");
    console.log("Integrity check passed.");
}

async function main() {
    await V2.connectDB(TEST_URI, { maxPoolSize: 200 }); // Increase pool size for heavy stress tests

    try {
        await runStockConcurrency("500 reqs on 100 stock", 100, 500);
        await runStockConcurrency("100 reqs on 10 stock", 10, 100);
        await runStockConcurrency("1000 reqs on 500 stock", 500, 1000);
        
        await runVariableQuantityConcurrency();
        
        await runPaymentIdempotency(10);
        await runPaymentIdempotency(50);
        await runPaymentIdempotency(100);

        await checkIntegrity();
        
        console.log("\n✅ ALL CONCURRENCY AND IDEMPOTENCY TESTS PASSED.");
        process.exit(0);
    } catch (e) {
        console.error("\n❌ TEST FAILED:", e.message);
        console.error(e.stack);
        process.exit(1);
    }
}

main();
