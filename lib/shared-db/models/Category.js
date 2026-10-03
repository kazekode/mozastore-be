import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true, index: true },
        name: { type: String, required: true },
        image_url: { type: String, default: null },
        sort_order: { type: Number, default: 0 }
    },
    { timestamps: true }
);

categorySchema.index({ botId: 1, name: 1 }, { unique: true });

export const Category = mongoose.model("Category", categorySchema);
