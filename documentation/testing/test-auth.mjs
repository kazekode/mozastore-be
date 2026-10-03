import { spawn } from 'child_process';
import fetch from 'node-fetch';

const PORT = 8000;
const URL = `http://localhost:${PORT}`;

const server = spawn('node', ['index.js'], { cwd: '.', stdio: 'inherit' });

async function runTest() {
    console.log("Waiting for server...");
    await new Promise(r => setTimeout(r, 3000));
    
    try {
        console.log("1. Auth Checkout...");
        const checkoutRes = await fetch(`${URL}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: "101", // Or some numeric user id if you want to test numeric 
                // Wait, I need a valid user from the DB. I'll just use a random number that probably doesn't exist.
                // Wait, if it doesn't exist, it might fail.
            })
        });
        
    } catch (e) {
    } finally {
        server.kill();
        process.exit(0);
    }
}