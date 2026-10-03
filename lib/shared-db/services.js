import mongoose from "mongoose";
import { ProductStock } from "./models/ProductStock.js";
import { Order } from "./models/Order.js";
import { Transaction } from "./models/Transaction.js";
import { User } from "./models/User.js";
import { Bot } from "./models/Bot.js";
import { Product } from "./models/Product.js";
import { DailySalesSummary } from "./models/DailySalesSummary.js";

/**
 * Atomic stock allocation avoiding in-memory locks.
 * Reserves exact quantity of available stock.
 */
export async function reserveStockAtomic(botId, productId, quantity, orderId) {
    if (quantity <= 0) return { success: false, error: "Jumlah harus > 0." };

    const reservedIds = [];
    try {
        for (let i = 0; i < quantity; i++) {
            const stock = await ProductStock.findOneAndUpdate(
                { botId, productId, status: 'available' },
                { $set: { status: 'reserved', orderId, reservedAt: new Date() } },
                { sort: { createdAt: 1 }, new: true }
            );
            if (!stock) {
                // Insufficient stock, rollback what we have reserved so far
                if (reservedIds.length > 0) {
                    await ProductStock.updateMany(
                        { _id: { $in: reservedIds } },
                        { $set: { status: 'available', orderId: null, reservedAt: null } }
                    );
                }
                return { success: false, error: "Stok tidak mencukupi." };
            }
            reservedIds.push(stock._id);
        }
        
        // Fetch the account data for the reserved stocks
        const reservedStocks = await ProductStock.find({ _id: { $in: reservedIds } }).lean();
        const accountDataList = reservedStocks.map(s => s.accountData);
        
        return { success: true, data: accountDataList, orderId };
    } catch (err) {
        if (reservedIds.length > 0) {
            await ProductStock.updateMany(
                { _id: { $in: reservedIds } },
                { $set: { status: 'available', orderId: null, reservedAt: null } }
            );
        }
        return { success: false, error: err.message };
    }
}

/**
 * Release reserved stock if payment fails or expires.
 */
export async function releaseReservedStock(orderId) {
    try {
        await ProductStock.updateMany(
            { orderId, status: 'reserved' },
            { $set: { status: 'available', orderId: null, reservedAt: null } }
        );
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Mark stock as sold.
 */
export async function commitSoldStock(orderId) {
    try {
        await ProductStock.updateMany(
            { orderId, status: 'reserved' },
            { $set: { status: 'sold', soldAt: new Date() } }
        );
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Idempotent Order Payment Success
 */
export async function processOrderPaymentSuccess(orderId, paymentMethod, paymentReference) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        // Idempotency check: Find order that is still 'pending'
        const order = await Order.findOneAndUpdate(
            { orderId, status: 'pending' },
            { $set: { status: 'completed', paidAt: new Date(), completedAt: new Date(), paymentMethod, paymentReference } },
            { new: true, session }
        );

        // If order not found or already paid/completed, just return (idempotent)
        if (!order) {
            await session.abortTransaction();
            session.endSession();
            return { success: true, message: "Order already processed or not found." };
        }

        // 1. Commit stock
        await ProductStock.updateMany(
            { orderId: order.orderId, status: 'reserved' },
            { $set: { status: 'sold', soldAt: new Date() } },
            { session }
        );

        // 2. Create financial transaction record
        const trxPayload = {
            transactionId: `TRX-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            orderId: order.orderId,
            botId: order.botId,
            type: 'order_payment',
            amount: order.totalAmount,
            status: 'success',
            paymentMethod,
            reference: paymentReference
        };

        if (order.isGuest) {
            trxPayload.isGuest = true;
            trxPayload.guestId = order.guestId;
        } else {
            trxPayload.userId = order.userId;
        }

        await Transaction.create([trxPayload], { session });

        // 3. Update User Stats
        const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
        if (!order.isGuest && order.userId != null) {
            await User.updateOne(
                { userId: order.userId },
                { $inc: { 
                    "stats.totalSpent": order.totalAmount, 
                    "stats.totalTransactions": 1,
                    "stats.totalItems": totalQuantity 
                }},
                { session }
            );
        }

        // 4. Update Product Stats
        for (const item of order.items) {
            await Product.updateOne(
                { productId: item.productId, botId: order.botId },
                { $inc: { "stats.soldQuantity": item.quantity, "stats.revenue": item.subtotal } },
                { session }
            );
        }

        // 5. Update Bot Stats
        await Bot.updateOne(
            { botId: order.botId },
            { $inc: { 
                "stats.lifetimeRevenue": order.totalAmount,
                "stats.lifetimeTransactions": 1,
                "stats.lifetimeSold": totalQuantity
            }},
            { session }
        );

        // 6. Update Daily Sales Summary
        // Create YYYY-MM-DD string according to local time
        const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); 
        await DailySalesSummary.updateOne(
            { botId: order.botId, date: dateStr },
            { $inc: { 
                totalRevenue: order.totalAmount,
                totalTransactions: 1,
                totalItemsSold: totalQuantity
            }},
            { upsert: true, session }
        );

        await session.commitTransaction();
        session.endSession();
        return { success: true, order };
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, error: err.message };
    }
}
