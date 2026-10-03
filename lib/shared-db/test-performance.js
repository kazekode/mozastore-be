import mongoose from "mongoose";
import * as V2 from "./index.js";
import { generateData } from "./generate-load-test-data.js";

const TEST_URI = "mongodb+srv://moza:store@apkprem.0hkn542.mongodb.net/MannDB_V2_Test?retryWrites=true&w=majority";

async function measureQuery(name, queryFn, iterations = 3) {
    let totalTime = 0;
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await queryFn();
        totalTime += (performance.now() - start);
    }
    const avg = totalTime / iterations;
    console.log(`[Query] ${name}: ~${avg.toFixed(2)}ms`);
    return avg;
}

async function runExplain(name, query) {
    const explain = await query.explain("executionStats");
    const stats = explain.executionStats;
    const plan = explain.queryPlanner.winningPlan;
    
    let isCollScan = false;
    if (plan.stage === 'COLLSCAN' || (plan.inputStage && plan.inputStage.stage === 'COLLSCAN')) {
        isCollScan = true;
    }
    
    console.log(`\n[Explain] ${name}`);
    console.log(`  Winning Plan: ${plan.stage} ${isCollScan ? '⚠️ COLLSCAN' : '(Indexed)'}`);
    console.log(`  Execution Time: ${stats.executionTimeMillis} ms`);
    console.log(`  Docs Examined: ${stats.totalDocsExamined}`);
    console.log(`  Keys Examined: ${stats.totalKeysExamined}`);
    console.log(`  nReturned: ${stats.nReturned}`);
    
    return { name, plan: plan.stage, collScan: isCollScan, time: stats.executionTimeMillis, docs: stats.totalDocsExamined, keys: stats.totalKeysExamined };
}

async function simulateApiLoad(name, concurrency, requestFn) {
    console.log(`\n[API Load] ${name} (Concurrency: ${concurrency})`);
    const promises = [];
    let success = 0;
    let fail = 0;
    const start = performance.now();
    for (let i = 0; i < concurrency; i++) {
        promises.push(
            requestFn().then(() => success++).catch(() => fail++)
        );
    }
    await Promise.all(promises);
    const duration = performance.now() - start;
    console.log(`  Success: ${success}, Fail: ${fail}, Total Time: ${duration.toFixed(2)}ms`);
    console.log(`  Avg latency per parallel batch: ${(duration / concurrency).toFixed(2)}ms`);
}

async function runBenchmark(size) {
    await V2.connectDB(TEST_URI, { maxPoolSize: 200 });

    const args = process.argv;
    if (!args.includes('--skip-data')) {
        await generateData(size);
    }

    console.log(`\n=== STARTING PERFORMANCE TESTS (Dataset: ${size}) ===\n`);

    // 1. Order History
    await measureQuery("Get Recent Orders (Limit 20)", () => V2.Order.find({ botId: 1 }).sort({ createdAt: -1 }).limit(20).lean());
    await runExplain("Explain: Get Recent Orders", V2.Order.find({ botId: 1 }).sort({ createdAt: -1 }).limit(20));

    // 2. User Order History
    await measureQuery("User Order History", () => V2.Order.find({ userId: 1 }).sort({ createdAt: -1 }).limit(20).lean());
    await runExplain("Explain: User Order History", V2.Order.find({ userId: 1 }).sort({ createdAt: -1 }).limit(20));

    // 3. Transactions List
    await measureQuery("Transaction List Pagination", () => V2.Transaction.find({ botId: 1 }).sort({ createdAt: -1 }).skip(1000).limit(50).lean());
    await runExplain("Explain: Transaction List", V2.Transaction.find({ botId: 1 }).sort({ createdAt: -1 }).skip(1000).limit(50));

    // 4. Dashboard Stats (The big one!)
    // V1 used to do Transaction.aggregate. V2 reads stats.
    await measureQuery("Dashboard: Total Revenue & Tx", async () => {
        const bot = await V2.Bot.findOne({ botId: 1 }).select('stats').lean();
    });
    await runExplain("Explain: Dashboard Bot Stats", V2.Bot.findOne({ botId: 1 }).select('stats'));

    await measureQuery("Dashboard: Top Products", async () => {
        await V2.Product.find({ botId: 1 }).sort({ 'stats.soldQuantity': -1 }).limit(10).lean();
    });
    await runExplain("Explain: Top Products", V2.Product.find({ botId: 1 }).sort({ 'stats.soldQuantity': -1 }).limit(10));

    await measureQuery("Dashboard: Daily Sales (Last 30 Days)", async () => {
        await V2.DailySalesSummary.find({ botId: 1 }).sort({ date: -1 }).limit(30).lean();
    });
    await runExplain("Explain: Daily Sales", V2.DailySalesSummary.find({ botId: 1 }).sort({ date: -1 }).limit(30));

    // 5. Stock Lookups
    await measureQuery("Check Available Stock", async () => {
        await V2.ProductStock.countDocuments({ productId: "PROD-10", status: 'available' });
    });
    await runExplain("Explain: Check Stock", V2.ProductStock.find({ productId: "PROD-10", status: 'available' }));

    // 6. API Load Simulation
    await simulateApiLoad("Dashboard Stats Fetch", 100, async () => {
        await Promise.all([
            V2.Bot.findOne({ botId: 1 }).select('stats').lean(),
            V2.Product.find({ botId: 1 }).sort({ 'stats.soldQuantity': -1 }).limit(10).lean(),
            V2.DailySalesSummary.find({ botId: 1 }).sort({ date: -1 }).limit(7).lean()
        ]);
    });

    await simulateApiLoad("User Profile Fetch", 250, async () => {
        const uid = Math.floor(Math.random() * 10) + 1;
        await Promise.all([
            V2.User.findOne({ userId: uid }).lean(),
            V2.Order.find({ userId: uid }).sort({ createdAt: -1 }).limit(10).lean()
        ]);
    });

    console.log("\n=== PERFORMANCE TESTS COMPLETE ===");
    process.exit(0);
}

const args = process.argv.slice(2);
let size = 10000;
args.forEach(arg => {
    if (arg.startsWith('--size=')) size = parseInt(arg.split('=')[1]);
});

runBenchmark(size).catch(e => {
    console.error(e);
    process.exit(1);
});
