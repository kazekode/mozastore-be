import mongoose from 'mongoose';
import { Transaction, Order, ProductStock } from './lib/shared-db/index.js';

async function verify() {
    await mongoose.connect('mongodb+srv://moza:store@apprem.kbpp8u2.mongodb.net/MannDB_V2?retryWrites=true&w=majority');
    
    // Find latest order
    const order = await Order.findOne({ isGuest: true }).sort({ createdAt: -1 });
    console.log("Latest Guest Order:", order.orderId, "Status:", order.status);
    
    // Find transaction
    const trx = await Transaction.findOne({ orderId: order.orderId });
    if (trx) {
        console.log("Transaction found! ID:", trx.transactionId, "isGuest:", trx.isGuest);
    } else {
        console.log("FAIL: Transaction not found for order", order.orderId);
    }
    
    // Check stock
    const stock = await ProductStock.find({ orderId: order.orderId });
    console.log(`Stock items bound to order: ${stock.length}`);
    stock.forEach(s => console.log(" - Stock ID:", s._id, "Status:", s.status));
    
    process.exit(0);
}

verify().catch(console.error);