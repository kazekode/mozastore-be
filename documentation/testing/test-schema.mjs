import mongoose from 'mongoose';
import { Order } from './be/lib/shared-db/models/Order.js';

async function testSchema() {
    // Just instantiate an in-memory document
    const orderDoc = new Order({
        orderId: 'TEST-123',
        botId: 1,
        totalAmount: 1000,
        isGuest: true,
        guestId: 'guest-xyz',
        guestTokenHash: 'hash-abc',
        guestTokenExpires: new Date()
    });
    
    // If strict is working, the toObject() representation will include these fields
    const obj = orderDoc.toObject();
    console.log('Fields retained:', Object.keys(obj));
    console.log('guestTokenHash:', obj.guestTokenHash);
    
    process.exit(0);
}
testSchema().catch(console.error);
