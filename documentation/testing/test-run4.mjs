import express from 'express';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import mongoose from 'mongoose';

async function runTest() {
    console.log('Starting BE server...');
    const server = spawn('node', ['index.js'], { cwd: './be', env: { ...process.env, PORT: 8081, JWT_SECRET: 'testsecret' } });
    
    await new Promise(r => setTimeout(r, 4000));
    
    // First, let's create a User (if not exist)
    const jwt = (await import('jsonwebtoken')).default;
    const token = jwt.sign({ id: '6abe9fb6427f649362af299e', is_admin: true }, 'testsecret');
    
    console.log('1. Checking payment-gateway as public...');
    let res = await fetch('http://localhost:8081/api/settings/payment-gateway');
    let data = await res.json();
    console.log('Public GW Data:', JSON.stringify(data));
    
    console.log('2. Checking payment-gateway as admin...');
    res = await fetch('http://localhost:8081/api/settings/payment-gateway', { headers: { 'Authorization': 'Bearer ' + token }});
    data = await res.json();
    console.log('Admin GW Data keys:', data.map(d => Object.keys(d.settings || {}).join(',')));
    
    // Test Checkout Guest
    console.log('3. Test Checkout Guest');
    res = await fetch('http://localhost:8081/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            isGuest: true,
            guestEmail: 'test@example.com',
            items: []
        })
    });
    console.log('Guest checkout empty cart:', await res.text());
    
    // Test Checkout Auth with string ID
    console.log('4. Test Checkout Auth with MongoDB ObjectId string');
    res = await fetch('http://localhost:8081/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: '6abe9fb6427f649362af299e',
            isGuest: false,
            items: []
        })
    });
    console.log('Auth checkout empty cart:', await res.text());
    
    server.kill();
    process.exit(0);
}
runTest().catch(console.error);
