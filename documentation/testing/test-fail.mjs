import fetch from 'node-fetch';

async function check() {
    const res = await fetch('http://localhost:8000/api/orders/ORD-1790998219789-da97aaf7');
    console.log(await res.json());
}
check();