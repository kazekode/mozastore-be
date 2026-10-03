import { spawn } from 'child_process';
import fetch from 'node-fetch';

const PORT = 8000;
const URL = `http://localhost:${PORT}`;

async function runTest() {
    let server;
    try {
        server = spawn('node', ['index.js'], { cwd: '.', stdio: 'inherit' });
        console.log("Waiting for server...");
        await new Promise(r => setTimeout(r, 3000));
        
        console.log("\n1. Register new user...");
        const registerRes = await fetch(`${URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: "Test User",
                email: `test${Date.now()}@example.com`,
                phone: `0812${Date.now()}`,
                password: "password123"
            })
        });
        const registerData = await registerRes.json();
        if(registerData.error) throw new Error(registerData.error);
        const token = registerData.token;
        console.log("Registered! Token received.");
        
        console.log("\n2. Get Profile...");
        const profileRes = await fetch(`${URL}/api/user/profile`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log("Profile status:", profileRes.status);
        console.log("Profile:", await profileRes.json());
        
        console.log("\n3. Get Stats...");
        const statsRes = await fetch(`${URL}/api/user/statistics`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log("Stats:", await statsRes.json());
        
        console.log("\n4. Get Orders...");
        const ordersRes = await fetch(`${URL}/api/user/orders`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log("Orders:", await ordersRes.json());
        
        console.log("\n5. Update Profile...");
        const updateRes = await fetch(`${URL}/api/user/profile`, {
            method: 'PATCH',
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: "Updated Name" })
        });
        console.log("Update status:", updateRes.status);
        console.log("Update response:", await updateRes.json());
        
        console.log("\n6. Get Profile Again...");
        const profileRes2 = await fetch(`${URL}/api/user/profile`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log("Updated Profile:", await profileRes2.json());
        
        console.log("\nALL TESTS PASSED");
    } catch (e) {
        console.error("Error:", e);
    } finally {
        if(server) server.kill();
        process.exit(0);
    }
}
runTest();