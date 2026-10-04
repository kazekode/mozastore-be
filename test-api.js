import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import { connectDB, Order, Product, ProductStock } from "./lib/shared-db/index.js";

async function run() {
    await connectDB();
    const orderDoc = await Order.findOne({ status: { $in: ['paid', 'completed'] } }).sort({ createdAt: -1 });
    
    const enrichedItems = await Promise.all(orderDoc.items.map(async item => {
        const product = await Product.findOne({ productId: item.productId }) || await Product.findById(item.productId).catch(() => null);
        let stockContent = null;
        let stockId = null;

        const allStocks = await ProductStock.find({ orderId: orderDoc.orderId }).lean();
        const itemStocks = allStocks.filter(s => s.productId === item.productId);
        
        if (itemStocks.length > 0) {
            stockContent = itemStocks.map(s => s.accountData).join('\n\n---\n\n');
            stockId = itemStocks[0]._id;
        } else if (item.stockIds && item.stockIds.length > 0) {
            const stock = await ProductStock.findById(item.stockIds[0]);
            if (stock) {
                stockContent = stock.accountData;
                stockId = stock._id;
            }
        }
        return {
            id: item._id, // if any
            quantity: item.quantity,
            price: item.price,
            product_id: item.productId,
            stock_id: stockId,
            products: product ? { name: product.name, snk: product.snk } : { name: item.productName },
            product_stocks: stockContent ? { content: stockContent } : null
        };
    }));

    console.log(JSON.stringify(enrichedItems, null, 2));
    process.exit(0);
}

run();