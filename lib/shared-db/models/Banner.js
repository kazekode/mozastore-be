import mongoose from "mongoose";

const bannerSchema = new mongoose.Schema({
    image_url: { type: String, required: true },
    alt: { type: String, default: "" },
    is_active: { type: Boolean, default: true },
    sort_order: { type: Number, default: 0 },
    filename: { type: String, default: "" }, // for cpanel delete
    folder: { type: String, default: "banners" },
}, { timestamps: true });

export const Banner = mongoose.model("Banner", bannerSchema);
