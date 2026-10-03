import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true, default: 1 },
    price: { type: Number, required: true },
    subtotal: { type: Number, required: true }
}, { _id: false });

const orderSchema = new mongoose.Schema(
    {
        orderId: { type: String, required: true, unique: true },
        botId: { type: Number, required: true, index: true },
        userId: { type: Number, index: true },
        source: { type: String, enum: ['telegram', 'web'], default: 'telegram' },
        isGuest: { type: Boolean, default: false },
        guestEmail: { type: String, default: null },
        guestId: { type: String, default: null, index: true },
        guestTokenHash: { type: String, default: null },
        guestTokenExpires: { type: Date, default: null },
        items: [orderItemSchema],
        totalAmount: { type: Number, required: true },
        status: { type: String, enum: ['pending', 'paid', 'completed', 'cancelled'], default: 'pending' },
        paymentMethod: { type: String, default: 'balance' },
        paymentUrl: { type: String, default: null },
        paymentReference: { type: String, default: null },
        paidAt: { type: Date, default: null },
        completedAt: { type: Date, default: null }
    },
    { timestamps: true }
);

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ botId: 1, status: 1 });
orderSchema.index({ createdAt: -1 });

export const Order = mongoose.model("Order", orderSchema);
