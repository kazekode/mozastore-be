import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true, index: true },
        productId: { type: String, required: true, index: true },
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        original_price: { type: Number, default: null },
        desc: { type: String, default: "" },
        snk: { type: String, default: "" },
        image_url: { type: String, default: null },
        login_instructions: { type: String, default: null },
        min_order: { type: Number, default: 1 },
        max_order: { type: Number, default: 1000 },
        sort_order: { type: Number, default: 0 },
        stats: {
            soldQuantity: { type: Number, default: 0 },
            revenue: { type: Number, default: 0 }
        }
    },
    { timestamps: true }
);

productSchema.index({ botId: 1, productId: 1 }, { unique: true });
productSchema.index({ "stats.soldQuantity": -1 });

export const Product = mongoose.model("Product", productSchema);
