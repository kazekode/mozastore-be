require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGO_DBNAME });
    const db = mongoose.connection.db;
    const products = await db.collection('products').find({}).toArray();
    let withCat = 0;
    let withoutCat = 0;
    products.forEach(p => {
        if (p.categoryId) withCat++;
        else withoutCat++;
    });
    console.log(`Products with categoryId: ${withCat}`);
    console.log(`Products without categoryId: ${withoutCat}`);
    await mongoose.disconnect();
}
run();