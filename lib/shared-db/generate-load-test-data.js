import mongoose from "mongoose";
import * as V2 from "./index.js";

export async function generateData(size) {
    console.log(`Generating test data for size: ${size}`);
    const numUsers = Math.max(10, Math.floor(size / 100));
    const numProducts = 50;
    const numCategories = 5;

    console.log("Wiping previous test data...");
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

    await V2.Bot.create({ botId: 1, name: "Load Test Bot", stats: { lifetimeRevenue: 0, lifetimeTransactions: 0, lifetimeSold: 0 } });

    console.log(`Creating ${numUsers} users...`);
    const users = [];
    for (let i = 0; i < numUsers; i++) {
        users.push({ userId: i + 1, name: `User ${i}`, role: "member", isTelegram: true, stats: { totalSpent: 0, totalTransactions: 0, totalItems: 0 } });
    }
    await V2.User.insertMany(users, { ordered: false });

    console.log(`Creating ${numCategories} categories & ${numProducts} products...`);
    const cats = [];
    for (let i = 0; i < numCategories; i++) cats.push({ botId: 1, name: `Cat ${i}`, sort_order: i });
    const insertedCats = await V2.Category.insertMany(cats);

    const prods = [];
    for (let i = 0; i < numProducts; i++) {
        const cId = insertedCats[i % numCategories]._id;
        prods.push({
            botId: 1, productId: `PROD-${i}`, categoryId: cId, name: `Product ${i}`, price: 1000 + (i * 100),
            stats: { soldQuantity: 0, revenue: 0 }
        });
    }
    await V2.Product.insertMany(prods);

    console.log(`Creating ProductStock...`);
    // Stock is proportional to order size to allow successful processing if needed
    // But we'll just insert a large chunk of available stock
    const batchSize = 10000;
    const stockToInsert = Math.min(size, 500000); 
    for(let i=0; i<stockToInsert; i+=batchSize) {
        const stocks = [];
        const limit = Math.min(batchSize, stockToInsert - i);
        for(let j=0; j<limit; j++) {
            const pIndex = (i+j) % numProducts;
            stocks.push({ botId: 1, productId: `PROD-${pIndex}`, accountData: `ACC-${i+j}`, status: 'available' });
        }
        await V2.ProductStock.insertMany(stocks, { ordered: false });
    }

    console.log(`Creating ${size} Orders & Transactions...`);
    
    let dailyMap = {};
    for (let i = 0; i < size; i += batchSize) {
        const orders = [];
        const txs = [];
        const limit = Math.min(batchSize, size - i);
        
        for (let j = 0; j < limit; j++) {
            const index = i + j;
            const uId = (index % numUsers) + 1;
            const pIndex = index % numProducts;
            const price = 1000 + (pIndex * 100);
            const date = new Date(Date.now() - (index % 365) * 86400000); // spread over 1 year
            
            orders.push({
                orderId: `ORD-${index}`, botId: 1, userId: uId, source: 'telegram',
                items: [{ productId: `PROD-${pIndex}`, productName: `Product ${pIndex}`, quantity: 1, price, subtotal: price }],
                totalAmount: price, status: 'completed', paymentMethod: 'qris', createdAt: date, paidAt: date, completedAt: date
            });

            txs.push({
                transactionId: `TRX-${index}`, orderId: `ORD-${index}`, botId: 1, userId: uId,
                type: 'order_payment', amount: price, status: 'success', paymentMethod: 'qris', createdAt: date
            });

            const dateStr = date.toISOString().split('T')[0];
            if (!dailyMap[dateStr]) dailyMap[dateStr] = { revenue: 0, trx: 0, items: 0 };
            dailyMap[dateStr].revenue += price;
            dailyMap[dateStr].trx += 1;
            dailyMap[dateStr].items += 1;
        }

        await V2.Order.insertMany(orders, { ordered: false });
        await V2.Transaction.insertMany(txs, { ordered: false });
        process.stdout.write(`\rInserted ${i + limit} records...`);
    }
    console.log("\nOrders & Transactions generated.");

    console.log("Generating DailySalesSummary...");
    const summaries = Object.keys(dailyMap).map(dateStr => ({
        botId: 1, date: dateStr,
        totalRevenue: dailyMap[dateStr].revenue,
        totalTransactions: dailyMap[dateStr].trx,
        totalItemsSold: dailyMap[dateStr].items
    }));
    await V2.DailySalesSummary.insertMany(summaries, { ordered: false });

    console.log("Data generation complete.");
}

// Allow running from CLI directly
if (process.argv[1].endsWith('generate-load-test-data.js')) {
    const TEST_URI = "mongodb+srv://moza:store@apkprem.0hkn542.mongodb.net/MannDB_V2_Test?retryWrites=true&w=majority";
    const args = process.argv.slice(2);
    let size = 10000;
    args.forEach(arg => {
        if (arg.startsWith('--size=')) size = parseInt(arg.split('=')[1]);
    });
    
    V2.connectDB(TEST_URI).then(async () => {
        await generateData(size);
        process.exit(0);
    }).catch(console.error);
}
