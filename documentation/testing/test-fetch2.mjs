import fetch from 'node-fetch';

async function check() {
    const res = await fetch('http://localhost:8000/api/orders/ORD-1790998328184-35200fe6?guestToken=a49e6fbc66c5d6f519541a0ddb945d9472e3914a1e5069f59f63566144eebffc');
    const data = await res.json();
    console.log("Status Code:", res.status);
    if(data.items && data.items.length > 0) {
       console.log("product_stocks:", data.items[0].product_stocks);
    }
}
check();