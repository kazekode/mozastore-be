import mongoose from "mongoose";
import * as V2 from "../shared-db/index.js";
import { reserveStockAtomic, processOrderPaymentSuccess } from "../shared-db/services.js";

const TEST_URI = "mongodb+srv://moza:store@apkprem.0hkn542.mongodb.net/MannDB_V2_Test?retryWrites=true&w=majority";

async function runTests() {
    console.log("Connecting to V2 TEST DB...");
    await V2.connectDB(TEST_URI);
    console.log("Connected.");

    console.log("\n--- Wiping old test data ---");
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

    console.log("\n--- STEP 2: CREATE CONTROLLED TEST DATA ---");
    const bot = await V2.Bot.create({ botId: 1, name: "Test Bot" });
    const userWeb = await V2.User.create({ userId: 101, email: "web@test.com", isTelegram: false });
    const userTele = await V2.User.create({ userId: 102, isTelegram: true });
    
    const cat = await V2.Category.create({ botId: 1, name: "Premium Accounts" });
    const prodA = await V2.Product.create({ botId: 1, productId: "PROD-A", categoryId: cat._id, name: "Netflix", price: 50000 });
    const prodB = await V2.Product.create({ botId: 1, productId: "PROD-B", categoryId: cat._id, name: "Spotify", price: 20000 });
    
    // Create stock
    const stocksA = Array.from({ length: 10 }, (_, i) => ({ botId: 1, productId: "PROD-A", accountData: `NF-${i}`, status: 'available' }));
    const stocksB = Array.from({ length: 5 }, (_, i) => ({ botId: 1, productId: "PROD-B", accountData: `SP-${i}`, status: 'available' }));
    await V2.ProductStock.insertMany([...stocksA, ...stocksB]);
    console.log("Test data created.");

    const results = { passed: [], failed: [] };
    const assert = (condition, name) => {
        if (condition) {
            console.log(`✅ PASS: ${name}`);
            results.passed.push(name);
        } else {
            console.error(`❌ FAIL: ${name}`);
            results.failed.push(name);
        }
    };

    console.log("\n--- STEP 3: WEBSHOP FUNCTIONAL TEST ---");
    
    // 3A. Product List & Stock
    const pList = await V2.Product.find({ botId: 1 }).lean();
    assert(pList.length === 2, "Product list fetched");
    const stockAvail = await V2.ProductStock.countDocuments({ productId: "PROD-A", status: 'available' });
    assert(stockAvail === 10, "Stock availability is correct (10)");

    // 3B. Checkout flow
    const orderId = "ORD-WEB-01";
    // 1. Reserve stock
    const reserveResult = await reserveStockAtomic(1, "PROD-A", 1, orderId);
    assert(reserveResult.success === true, "Stock reserved successfully");
    assert(reserveResult.data.length === 1, "Got 1 account from stock");
    
    // 2. Create order
    const orderWeb = await V2.Order.create({
        orderId, botId: 1, userId: userWeb.userId, source: 'web',
        items: [{ productId: "PROD-A", productName: "Netflix", quantity: 1, price: 50000, subtotal: 50000 }],
        totalAmount: 50000, status: 'pending'
    });
    assert(orderWeb != null, "Web order created");

    // 3. Process payment
    const paymentResult = await processOrderPaymentSuccess(orderId, "qris", "REF-001");
    assert(paymentResult.success === true, "Payment processed successfully");
    
    // 4. Verify stats
    const uCheck = await V2.User.findOne({ userId: 101 });
    assert(uCheck.stats.totalSpent === 50000, "User stats updated");
    
    const pCheck = await V2.Product.findOne({ productId: "PROD-A" });
    assert(pCheck.stats.soldQuantity === 1, "Product stats updated");
    
    const sCheck = await V2.DailySalesSummary.findOne({ botId: 1 });
    assert(sCheck.totalRevenue === 50000, "DailySalesSummary updated");

    console.log("\n--- STEP 7/8/9: EDGE CASE & CONCURRENCY TESTS ---");
    
    // Idempotency: call processOrderPaymentSuccess again!
    const paymentResult2 = await processOrderPaymentSuccess(orderId, "qris", "REF-001");
    assert(paymentResult2.success === true, "Duplicate payment call succeeds (idempotent)");
    
    // Ensure stats did not double count
    const uCheck2 = await V2.User.findOne({ userId: 101 });
    assert(uCheck2.stats.totalSpent === 50000, "User stats NOT double counted");

    // Concurrency Stock Test: PROD-B has 5 stock. Try 20 simultaneous reserves.
    const promises = [];
    for (let i = 0; i < 20; i++) {
        promises.push(reserveStockAtomic(1, "PROD-B", 1, `ORD-CONC-${i}`));
    }
    const concResults = await Promise.all(promises);
    const successCount = concResults.filter(r => r.success).length;
    const failCount = concResults.filter(r => !r.success).length;
    
    assert(successCount === 5, `Concurrency: Exact 5 reserves succeeded (got ${successCount})`);
    assert(failCount === 15, `Concurrency: Exact 15 reserves failed (got ${failCount})`);
    
    const bCheck = await V2.ProductStock.countDocuments({ productId: "PROD-B", status: 'available' });
    assert(bCheck === 0, "No available stock left for PROD-B");
    const bResCheck = await V2.ProductStock.countDocuments({ productId: "PROD-B", status: 'reserved' });
    assert(bResCheck === 5, "Exactly 5 stock are reserved");

    console.log("\n--- STEP 10: INTEGRITY CHECK ---");
    // Verify no negative or orphaned states
    const orphans = await V2.ProductStock.countDocuments({ status: 'reserved', orderId: null });
    assert(orphans === 0, "No orphan reserved stock");

    console.log("\nAll Tests finished.");
    console.log(`Passed: ${results.passed.length}, Failed: ${results.failed.length}`);
    process.exit(results.failed.length > 0 ? 1 : 0);
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
