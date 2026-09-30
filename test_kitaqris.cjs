const axios = require('axios');

async function testKitaQris() {
    try {
        const merchantId = "178753767150";
        const apiKey = "DsuTmOfKxaQ7Uwt5RVar7Y9gJ5iWhPVxvYtQ8ZM0";
        
        console.log("Testing CreateQR...");
        const createRes = await axios.post(
            'https://klikqris.com/api/qris/create',
            {
                order_id: "TEST-INV-" + Date.now(),
                amount: 1500,
                id_merchant: merchantId
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'id_merchant': merchantId
                }
            }
        );
        
        console.log("CreateQR Response:", createRes.data);
        
        if (createRes.data.status && createRes.data.data) {
            const orderId = createRes.data.data.order_id;
            console.log("\nTesting CheckQR for", orderId, "...");
            const checkRes = await axios.get(`https://klikqris.com/api/qris/status/${orderId}`, {
                headers: {
                    'x-api-key': apiKey,
                    'id_merchant': merchantId
                }
            });
            console.log("CheckQR Response:", checkRes.data);
        }
    } catch (e) {
        console.error("Error:", e.response ? e.response.data : e.message);
    }
}

testKitaQris();