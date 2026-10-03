import mongoose from "mongoose";

export * from "./models/User.js";
export * from "./models/Bot.js";
export * from "./models/Category.js";
export * from "./models/Product.js";
export * from "./models/ProductStock.js";
export * from "./models/Order.js";
export * from "./models/Transaction.js";
export * from "./models/DailySalesSummary.js";
export * from "./models/ProductSalesSummary.js";
export * from "./models/PaymentIntent.js";
export * from "./models/Settings.js";
export * from "./statistics.js";

export const connectDB = async (url, options = {}) => {
    if (mongoose.connection.readyState !== 1) {
        const poolSize = parseInt(process.env.MONGO_POOL_SIZE) || 50;
        await mongoose.connect(url || process.env.MONGODB_URI, {
            dbName: process.env.MONGO_DBNAME || "MannDB_V2",
            serverSelectionTimeoutMS: 5000,
            family: 4,
            maxPoolSize: poolSize,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 45000,
            ...options
        });
    }
};

export const getNativeDb = () => {
    return mongoose.connection.db;
};

if (mongoose.connection.listeners("disconnected").length === 0) {
    mongoose.connection.on("disconnected", () => {
        if (process.env.MONGODB_URI) {
            setTimeout(() => connectDB(process.env.MONGODB_URI), 5000);
        }
    });
}
