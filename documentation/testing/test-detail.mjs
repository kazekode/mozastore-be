import mongoose from 'mongoose';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import { Order } from './lib/shared-db/index.js';

const PORT = 8000;
const URL = `http://localhost:${PORT}`;

async function runTest() {
    await mongoose.connect('mongodb+srv://moza:store@apprem.kbpp8u2.mongodb.net/MannDB_V2?retryWrites=true&w=majority');
    const order = await Order.findOne({ isGuest: true, status: 'completed' }).sort({ createdAt: -1 });
    if (!order) {
        console.error("No completed guest order found.");
        process.exit(1);
    }
    
    // We can't fetch without backend running, so let's spawn it
    const server = spawn('node', ['index.js'], { cwd: '.', stdio: 'ignore' });
    console.log("Waiting for backend...");
    await new Promise(r => setTimeout(r, 3000));
    
    try {
        console.log(`Fetching Order: ${order.orderId}`);
        // But we need the guestToken! Wait, I can skip the HTTP auth check by simulating what the route does, 
        // OR I can just look at the raw response if I create a new order!
        // No, I will create a new order directly via HTTP!
    } catch(e) {
        console.error(e);
    } finally {
        server.kill();
        process.exit(0);
    }
}
runTest();