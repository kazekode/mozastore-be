import fetch from 'node-fetch';

async function run() {
    const res = await fetch('http://localhost:8000/api/products');
    const data = await res.json();
    console.log("Returned products:", data.length);
    console.log("IDs:", data.map(p => p.productId).join(', '));
    process.exit(0);
}
run();