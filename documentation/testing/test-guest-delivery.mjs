import fetch from 'node-fetch';

const PORT = 8000;
const URL = `http://localhost:${PORT}`;

async function runTest() {
    try {
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
        const guestToken = checkoutData.guestToken;
        const orderId = checkoutData.orderId;
        console.log("Order ID:", orderId);
        
        console.log("4. Check-payment flow...");
        const checkRes = await fetch(`${URL}/api/orders/${orderId}/check-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guestToken })
        });
        const checkData = await checkRes.json();
        console.log("Check-payment:", checkData.status);
        
        console.log("5. Fetch Payment Page Again...");
        const finalOrderRes = await fetch(`${URL}/api/orders/${orderId}?guestToken=${guestToken}`);
        const finalOrderData = await finalOrderRes.json();
        
        console.log(JSON.stringify(finalOrderData, null, 2));
    } catch (e) {
        console.error("Error during test:", e);
    }
}

runTest();