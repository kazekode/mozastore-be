import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
    {
        transactionId: { type: String, required: true, unique: true },
        orderId: { type: String, index: true },
        botId: { type: Number, required: true, index: true },
        userId: { type: Number, index: true }, // Not required for guest transactions
        isGuest: { type: Boolean, default: false },
        guestId: { type: String, index: true },
        type: { type: String, enum: ['order_payment', 'deposit', 'refund'], required: true },
        amount: { type: Number, required: true },
        status: { type: String, enum: ['success', 'failed', 'pending'], default: 'success' },
        paymentMethod: { type: String, default: 'balance' },
        reference: { type: String, default: null }
    },
    { timestamps: true }
);

transactionSchema.index({ botId: 1, createdAt: -1 });

export const Transaction = mongoose.model("Transaction", transactionSchema);
