import fetch from 'node-fetch';

const PORT = 8000;
const URL = `http://localhost:${PORT}`;

async function runTest() {
    try {
        console.log("1. Checkout Quantity = 3...");
        const checkoutRes = await fetch(`${URL}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                isGuest: true,
                guestEmail: 'test.email.kaze@example.com',
                guestId: 'guest-' + Date.now(),
                items: [
                    { productId: 'tes', quantity: 3 }
                ]
            })
        });
        const checkoutData = await checkoutRes.json();
        const guestToken = checkoutData.guestToken;
        const orderId = checkoutData.orderId;
        console.log("Order ID:", orderId);
        
        console.log("2. Check-payment flow (simulating frontend polling)...");
        const checkRes = await fetch(`${URL}/api/orders/${orderId}/check-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guestToken })
        });
        const checkData = await checkRes.json();
        console.log("Check-payment status:", checkData.status);
    } catch (e) {
        console.error("Error during test:", e);
    }
}
runTest();