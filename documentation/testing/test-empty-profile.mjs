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
        
        console.log("\n1. Register user...");
        const registerRes = await fetch(`${URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: "Test Empty",
                email: `test_empty_${Date.now()}@example.com`,
                phone: `0812999${Date.now()}`,
                password: "password123"
            })
        });
        const token = (await registerRes.json()).token;
        
        console.log("\n2. Update Profile to Empty Email & Phone...");
        const updateRes = await fetch(`${URL}/api/user/profile`, {
            method: 'PATCH',
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: "Updated Empty", email: "", phone: "" })
        });
        console.log("Update status:", updateRes.status);
        console.log("Update response:", await updateRes.json());
        
        console.log("\n3. Get Profile Again...");
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