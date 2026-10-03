const axios = require('axios');
async function run() {
    const { spawn } = require('child_process');
    const server = spawn('node', ['index.js'], { stdio: 'pipe' });
    
    await new Promise(r => setTimeout(r, 2000));
    
    try {
        const login = await axios.post('http://localhost:8000/api/auth/login', { identifier: 'moza@me.id', password: 'moza2020' });
        const res = await axios.get('http://localhost:8000/api/admin/stats?heavy=true', {
            headers: { Authorization: `Bearer ${login.data.token}` }
        });
        console.log(JSON.stringify(res.data, null, 2));
    } catch(e) {
        console.error(e.message);
    }
    
    server.kill();
}
run();