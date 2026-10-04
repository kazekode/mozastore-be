import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { connectDB, Order, Product, ProductStock } from "./lib/shared-db/index.js";

async function run() {
    await connectDB();
    const orderDoc = await Order.findOne({ status: { $in: ['paid', 'completed'] } }).sort({ createdAt: -1 });
    const allAllocatedStocks = await ProductStock.find({ orderId: orderDoc.orderId }).lean();
    let emailItemsMap = {};
    for (const item of orderDoc.items) {
        if (!emailItemsMap[item.productId]) {
            emailItemsMap[item.productId] = {
                productName: item.productName,
                quantity: 0,
                price: item.price
            };
        }
        emailItemsMap[item.productId].quantity += item.quantity;
    }
    
    let orderItemsForEmail = [];
    for (const pId in emailItemsMap) {
        const group = emailItemsMap[pId];
        const prod = await Product.findOne({ productId: pId });
        const name = prod ? prod.name : group.productName;
        
        const productStocks = allAllocatedStocks.filter(st => st.productId === pId);
        const accountData = productStocks.map(st => st.accountData).filter(Boolean).join('\n\n---\n\n');
        
        orderItemsForEmail.push({
            name: name,
            quantity: group.quantity,
            price: group.price,
            accountData: accountData || null,
            snk: prod ? prod.snk : null
        });
    }
    
    const orderDataForEmail = {
        orderId: orderDoc.orderId,
        date: new Date(orderDoc.createdAt).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        totalAmount: orderDoc.totalAmount,
        items: orderItemsForEmail,
        recipientName: "Test"
    };
    
    console.log(JSON.stringify(orderDataForEmail, null, 2));
    process.exit(0);
}

run();