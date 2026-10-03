import mongoose from "mongoose";

const productSalesSummarySchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true },
        productId: { type: String, required: true },
        date: { type: String, required: true }, // Format YYYY-MM
        soldQuantity: { type: Number, default: 0 },
        revenue: { type: Number, default: 0 }
    },
    { timestamps: true }
);

productSalesSummarySchema.index({ botId: 1, productId: 1, date: 1 }, { unique: true });

export const ProductSalesSummary = mongoose.model("ProductSalesSummary", productSalesSummarySchema);
