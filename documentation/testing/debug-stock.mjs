import mongoose from 'mongoose';
import { ProductStock, Order } from './lib/shared-db/index.js';

async function check() {
    await mongoose.connect('mongodb+srv://moza:store@apprem.kbpp8u2.mongodb.net/MannDB_V2?retryWrites=true&w=majority');
    
    const order = await Order.findOne({ isGuest: true, status: 'completed' }).sort({ createdAt: -1 });
    console.log("Order ID:", order.orderId);
    
    const allStocks = await ProductStock.find({ orderId: order.orderId }).lean();
    console.log(`[DEBUG] Found ${allStocks.length} stocks for order ${order.orderId}`);
    console.log(`[DEBUG] Stocks:`, allStocks.map(s => ({ id: s._id, product: s.productId, orderId: s.orderId })));
    
    process.exit(0);
}
check();