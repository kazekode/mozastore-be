import { spawn } from 'child_process';
import fetch from 'node-fetch';

const PORT = 8000;
const URL = `http://localhost:${PORT}`;

const server = spawn('node', ['index.js'], { cwd: '.', stdio: 'inherit' });

async function runTest() {
    console.log("Waiting for server to start...");
    await new Promise(r => setTimeout(r, 3000));
    
    try {
        console.log("1. Fetching product 'tes'...");
        const prodRes = await fetch(`${URL}/api/products`);
        const products = await prodRes.json();
        const tesProduct = products.find(p => p.id === 'tes');
        if (!tesProduct) {
            console.error("FAIL: Product 'tes' not found in API response");
            return;
        }
        console.log(`Product found: ${tesProduct.name} - Stock: ${tesProduct.stock}`);
        
        console.log("2. Guest Checkout...");
        const checkoutRes = await fetch(`${URL}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                isGuest: true,
                guestEmail: 'test@example.com',
                guestId: 'guest-' + Date.now(),
                items: [
                    { productId: 'tes', quantity: 1 }
                ]
            })
        });
        const checkoutData = await checkoutRes.json();
        if (!checkoutData.success) {
            console.error("FAIL: Guest checkout failed:", checkoutData);
            return;
        }
        console.log(`Checkout success. Order ID: ${checkoutData.orderId}`);
        const guestToken = checkoutData.guestToken;
        
        console.log("3. Fetch Payment Page (Check order)...");
        const orderRes = await fetch(`${URL}/api/orders/${checkoutData.orderId}?guestToken=${guestToken}`);
        const orderData = await orderRes.json();
        if (orderData.error) {
            console.error("FAIL: Fetching order failed:", orderData.error);
            return;
        }
        console.log("Payment page order fetched successfully. Status:", orderData.status);
        
        console.log("4. Check-payment flow (simulating frontend polling)...");
        const checkRes = await fetch(`${URL}/api/orders/${checkoutData.orderId}/check-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guestToken })
        });
        const checkData = await checkRes.json();
        console.log("Check-payment response:", checkData);
        
        if (checkData.status === 'completed' || checkData.status === 'pending') {
            console.log("PASS: check-payment didn't fail with userId required!");
        } else if (checkData.status === 'paid_but_stock_failed') {
            console.error("FAIL: still paid_but_stock_failed!", checkData);
        }
        
    } catch (e) {
        console.error("Error during test:", e);
    } finally {
        server.kill();
        process.exit(0);
    }
}

runTest();