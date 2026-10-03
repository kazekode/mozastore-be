import mongoose from 'mongoose';
import { User, Order, Transaction, ProductStock } from './lib/shared-db/index.js';
import { reserveStockAtomic, processOrderPaymentSuccess } from './lib/shared-db/services.js';
import crypto from 'crypto';

async function verifyAuth() {
    await mongoose.connect('mongodb+srv://moza:store@apprem.kbpp8u2.mongodb.net/MannDB_V2?retryWrites=true&w=majority');
    
    // Find any user
    const user = await User.findOne({});
    if (!user) {
        console.log("No user found, skip auth test");
        process.exit(0);
    }
    
    console.log("Found user:", user.userId, user.name);
    
    const orderId = `ORD-TEST-${Date.now()}`;
    const botId = 8374872044;
    
    // reserve stock (botId, productId, quantity, orderId)
    const reserveResult = await reserveStockAtomic(botId, 'tes', 1, orderId);
    if (!reserveResult.success) {
        console.error("Reserve stock failed:", reserveResult.error);
        process.exit(1);
    }
    
    // Create order
    const order = await Order.create({
        orderId,
        botId,
        userId: user.userId,
        isGuest: false,
        source: 'web',
        items: [{ productId: 'tes', productName: 'TES GW', quantity: 1, price: 100, subtotal: 100 }],
        totalAmount: 100,
        status: 'pending'
    });
    console.log("Order created:", order.orderId);
    
    // Process payment
    const paymentResult = await processOrderPaymentSuccess(orderId, 'qris', 'REF-TEST');
    if (!paymentResult.success) {
        console.error("Payment process failed:", paymentResult.error);
        process.exit(1);
    }
    
    const trx = await Transaction.findOne({ orderId });
    console.log("Auth Transaction created:", trx.transactionId, "userId:", trx.userId);
    
    const stock = await ProductStock.findOne({ orderId });
    console.log("Stock status:", stock.status);
    
    process.exit(0);
}

verifyAuth().catch(console.error);