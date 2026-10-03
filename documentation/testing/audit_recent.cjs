require('dotenv').config();
const mongoose = require('mongoose');
const { Order } = require('./lib/shared-db/index.js');

async function run() {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGO_DBNAME });
    
    const recent = await Order.find().sort({ createdAt: -1 }).limit(5).lean();
    console.log("=== 5 MOST RECENT ORDERS ===");
    recent.forEach(o => {
        console.log(`_id: ${o._id}, orderId: ${o.orderId}, source: ${o.source}, status: ${o.status}, amount: ${o.totalAmount}, items: ${o.items?.length}`);
    });
    
    const txs = await mongoose.connection.db.collection('transactions').find().sort({ createdAt: -1 }).limit(5).toArray();
    console.log("\n=== 5 MOST RECENT TRANSACTIONS ===");
    txs.forEach(t => {
        console.log(`_id: ${t._id}, transactionId: ${t.transactionId}, type: ${t.type}, source: ${t.source}, amount: ${t.amount}`);
    });

    await mongoose.disconnect();
}
run().catch(console.error);