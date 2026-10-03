import mongoose from 'mongoose';
import { ProductStock, Order } from './lib/shared-db/index.js';

async function check() {
    await mongoose.connect('mongodb+srv://moza:store@apprem.kbpp8u2.mongodb.net/MannDB_V2?retryWrites=true&w=majority');
    
    const order = await Order.findOne({ isGuest: true, status: 'completed' }).sort({ createdAt: -1 });
    console.log("Order Items:", order.items.map(i => ({ productId: i.productId, type: typeof i.productId })));
    
    const allStocks = await ProductStock.find({ orderId: order.orderId }).lean();
    console.log("Stock Products:", allStocks.map(i => ({ productId: i.productId, type: typeof i.productId })));
    
    process.exit(0);
}
check();