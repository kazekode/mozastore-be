import mongoose from "mongoose";

const botSchema = new mongoose.Schema(
    {
        botId: { type: Number, required: true, unique: true },
        name: { type: String, required: true },
        stats: {
            lifetimeRevenue: { type: Number, default: 0 },
            lifetimeTransactions: { type: Number, default: 0 },
            lifetimeSold: { type: Number, default: 0 }
        }
    },
    { timestamps: true }
);

export const Bot = mongoose.model("Bot", botSchema);
