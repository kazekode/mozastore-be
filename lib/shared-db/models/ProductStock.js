import mongoose from "mongoose";

const productStockSchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true, index: true },
        productId: { type: String, required: true, index: true },
        accountData: { type: String, required: true },
        status: { type: String, enum: ['available', 'reserved', 'sold'], default: 'available', index: true },
        orderId: { type: String, default: null, index: true },
        reservedAt: { type: Date, default: null },
        soldAt: { type: Date, default: null }
    },
    { timestamps: true }
);

productStockSchema.index({ botId: 1, productId: 1, status: 1 });

export const ProductStock = mongoose.model("ProductStock", productStockSchema);
