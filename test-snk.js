import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { connectDB, Order, Product } from "./lib/shared-db/index.js";

async function run() {
    await connectDB();
    const order = await Order.findOne({ status: { $in: ['paid', 'completed'] } }).sort({ createdAt: -1 });
    if (!order) {
        console.log("No paid/completed orders found");
        process.exit(0);
    }
    console.log(`Found order: ${order.orderId}`);
    
    for (const item of order.items) {
        console.log(`Item: ${item.productId}`);
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
            console.log(`Product found: ${product.name}, SNK: ${product.snk}`);
        } else {
            console.log(`Product not found via productId: ${item.productId}`);
            const p2 = await Product.findById(item.productId).catch(() => null);
            console.log(`Product found via _id: ${p2 ? p2.name : 'no'}, SNK: ${p2 ? p2.snk : 'N/A'}`);
        }
    }
    process.exit(0);
}

run();