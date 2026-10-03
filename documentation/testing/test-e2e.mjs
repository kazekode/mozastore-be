import express from 'express';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

async function runE2E() {
    console.log('[*] Starting BE server on port 8085 for E2E testing...');
    const server = spawn('node', ['index.js'], { 
        cwd: './', 
        shell: true,
        env: { ...process.env, PORT: 8085, JWT_SECRET: 'testsecret', DEFAULT_BOT_ID: '8374872044' } 
    });
    
    await new Promise(r => setTimeout(r, 4000));
    console.log('[*] Server ready. Connecting to DB directly to verify states...');
    
    const url = 'mongodb+srv://moza:store@apprem.kbpp8u2.mongodb.net/MannDB_V2';
    await mongoose.connect(url);
    const Order = mongoose.connection.collection('orders');
    
    try {
        console.log('\n--- 1. GUEST CHECKOUT TEST ---');
        const Product = mongoose.connection.collection('products');
        const product = await Product.findOne({ botId: 8374872044 });
        if (!product) throw new Error('No product found for testing');
        
        console.log('Using product:', product.name, product.price);
        
        const guestCheckoutReq = await fetch('http://localhost:8085/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                isGuest: true,
                guestEmail: 'e2e@example.com',
                guestId: 'guest-e2e-123',
                items: [{ productId: product.productId, productName: product.name, quantity: 1, price: product.price }]
            })
        });
        
        const guestRes = await guestCheckoutReq.json();
        console.log('Guest checkout response:', guestRes);
        if (!guestRes.success || !guestRes.orderId || !guestRes.guestToken) {
            throw new Error('Guest checkout failed to return expected fields');
        }
        
        const { orderId, guestToken } = guestRes;
        
        console.log('\n--- 2. VERIFY DB SCHEMA PERSISTENCE ---');
        const dbOrder = await Order.findOne({ orderId });
        console.log('DB Order guestTokenHash:', !!dbOrder.guestTokenHash);
        console.log('DB Order guestTokenExpires:', !!dbOrder.guestTokenExpires);
        console.log('Is guestTokenHash same as plaintext token?', dbOrder.guestTokenHash === guestToken);
        if (!dbOrder.guestTokenHash) throw new Error('Schema fix failed: guestTokenHash missing');
        
        console.log('\n--- 3. PAYMENT PAGE (GET ORDER) TEST ---');
        const getOrderReq = await fetch(`http://localhost:8085/api/orders/${orderId}?guestToken=${guestToken}`);
        console.log('GET Order HTTP Status:', getOrderReq.status);
        const getOrderRes = await getOrderReq.json();
        
        if (getOrderReq.status !== 200) {
            console.error('GET Order failed:', getOrderRes);
            throw new Error('GET Order returned non-200');
        }
        
        console.log('Total Price returned:', getOrderRes.total_price);
        if (getOrderRes.total_price !== product.price) throw new Error('Price mismatch');
        
        console.log('\n--- 4. CREATE PAYMENT TEST ---');
        const createPaymentReq = await fetch(`http://localhost:8085/api/orders/${orderId}/create-payment`, { method: 'POST' });
        const createPaymentRes = await createPaymentReq.json();
        console.log('Create Payment Response keys:', Object.keys(createPaymentRes));
        
        console.log('\n--- 5. REFRESH TEST ---');
        const refreshReq = await fetch(`http://localhost:8085/api/orders/${orderId}?guestToken=${guestToken}`);
        console.log('Refresh HTTP Status:', refreshReq.status);
        if (refreshReq.status !== 200) throw new Error('Refresh test failed');
        
        console.log('\n--- 6. EXPIRED TOKEN TEST ---');
        // Manually expire the token in DB
        await Order.updateOne({ orderId }, { $set: { guestTokenExpires: new Date(Date.now() - 10000) } });
        const expiredReq = await fetch(`http://localhost:8085/api/orders/${orderId}?guestToken=${guestToken}`);
        console.log('Expired Token HTTP Status:', expiredReq.status);
        const expiredRes = await expiredReq.json();
        console.log('Expired Response:', expiredRes);
        if (expiredReq.status !== 403 || !expiredRes.expired) throw new Error('Expiry test failed');
        
        console.log('\n--- 7. AUTHENTICATED USER TEST ---');
        const User = mongoose.connection.collection('users');
        const userDoc = await User.findOne({});
        const token = jwt.sign({ id: userDoc._id.toString(), is_admin: false }, 'testsecret');
        
        const authCheckoutReq = await fetch('http://localhost:8085/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userDoc._id.toString(),
                isGuest: false,
                items: [{ productId: product.productId, productName: product.name, quantity: 1, price: product.price }]
            })
        });
        const authRes = await authCheckoutReq.json();
        const authOrderId = authRes.orderId;
        
        const authGetReq = await fetch(`http://localhost:8085/api/orders/${authOrderId}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        console.log('Auth GET Status:', authGetReq.status);
        if (authGetReq.status !== 200) throw new Error('Auth GET failed');
        
        // Clean up test orders
        await Order.deleteMany({ orderId: { $in: [orderId, authOrderId] } });
        console.log('\n[PASS] All E2E tests succeeded! Cleanup done.');
        
    } catch (e) {
        console.error('Test Failed:', e);
    } finally {
        server.kill();
        process.exit(0);
    }
}

runE2E();