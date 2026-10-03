import mongoose from "mongoose";

const dailySalesSummarySchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true },
        date: { type: String, required: true }, // Format YYYY-MM-DD
        totalRevenue: { type: Number, default: 0 },
        totalTransactions: { type: Number, default: 0 },
        totalItemsSold: { type: Number, default: 0 }
    },
    { timestamps: true }
);

dailySalesSummarySchema.index({ botId: 1, date: 1 }, { unique: true });

export const DailySalesSummary = mongoose.model("DailySalesSummary", dailySalesSummarySchema);
