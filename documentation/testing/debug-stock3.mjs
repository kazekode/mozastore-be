import mongoose from 'mongoose';
import { ProductStock, Order } from './lib/shared-db/index.js';

async function check() {
    await mongoose.connect('mongodb+srv://moza:store@apprem.kbpp8u2.mongodb.net/MannDB_V2?retryWrites=true&w=majority');
    
    const orderId = 'ORD-1790998328184-35200fe6'; // ID dari test terakhir
    const order = await Order.findOne({ orderId });
    console.log("Order items:", order.items.map(i => i.productId));
    
    const allStocks = await ProductStock.find({ orderId }).lean();
    console.log("All stocks count:", allStocks.length);
    console.log("Stocks productId:", allStocks.map(s => s.productId));
    
    const enrichedItems = order.items.map(item => {
        const itemStocks = allStocks.filter(s => s.productId === item.productId);
        console.log("Match length:", itemStocks.length);
        return itemStocks.length;
    });
    
    process.exit(0);
}
check();