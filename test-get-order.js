import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { connectDB, Order } from "./lib/shared-db/index.js";

async function run() {
    await connectDB();
    const order = await Order.findOne({ status: { $in: ['paid', 'completed'] } }).sort({ createdAt: -1 });
    console.log(order.orderId);
    process.exit(0);
}
run();