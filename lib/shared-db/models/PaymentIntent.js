import mongoose from "mongoose";

const paymentIntentSchema = new mongoose.Schema(
    {
        refId: { type: String, required: true, unique: true },
        userId: { type: Number, required: true, index: true },
        amount: { type: Number, required: true },
        kind: { type: String, enum: ["order", "deposit"], required: true },
        status: { type: String, enum: ["pending", "paid", "expired", "cancelled"], default: "pending" },
        mutationId: { type: String, default: null },
        paidAt: { type: Date, default: null },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);

paymentIntentSchema.index(
    { amount: 1 },
    { name: "uniquePendingPaymentAmount", unique: true, partialFilterExpression: { status: "pending" } }
);
paymentIntentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PaymentIntent = mongoose.model("PaymentIntent", paymentIntentSchema);
