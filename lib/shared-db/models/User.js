import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
    {
        userId: { type: Number, required: true, unique: true }, // Telegram ID
        name: { type: String, default: "No Name" },
        username: { type: String, default: null },
        email: { type: String, unique: true, sparse: true },
        phone: { type: String, unique: true, sparse: true },
        password: { type: String }, // For web
        googleId: { type: String, unique: true, sparse: true }, // For web login
        role: { type: String, default: "member" },
        is_admin: { type: Boolean, default: false }, // From WebUser
        balance: { type: Number, default: 0 },
        isTelegram: { type: Boolean, default: true },
        banned: { type: Boolean, default: false },
        isBanned: { type: Boolean, default: false },
        stats: {
            totalSpent: { type: Number, default: 0 },
            totalTransactions: { type: Number, default: 0 },
            totalItems: { type: Number, default: 0 }
        }
    },
    { timestamps: true }
);

// We merge authUser/webUser logic here
userSchema.pre("save", async function () {
    if (this.isModified("password") && this.password) {
        const bcrypt = await import("bcryptjs");
        this.password = await bcrypt.default.hash(this.password, 10);
    }
});

userSchema.methods.comparePassword = async function (candidatePassword) {
    if (!this.password) return false;
    const bcrypt = await import("bcryptjs");
    return bcrypt.default.compare(candidatePassword, this.password);
};

export const User = mongoose.model("User", userSchema);
