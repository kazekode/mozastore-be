import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { WebUser, connectDB } from "./database.js";

async function test() {
    await connectDB();
    try {
        const payload = {
            name: "Test User",
            email: "testuser2@example.com",
            sub: "google-12345"
        };
        const user = await WebUser.create({
            name: payload.name,
            email: payload.email,
            googleId: payload.sub,
            is_admin: false,
            phone: undefined,
            password: undefined,
        });
        console.log("Success:", user.email);
        
        await WebUser.deleteOne({ _id: user._id });
        console.log("Cleanup done");
    } catch (e) {
        console.error("Error:", e);
    } finally {
        mongoose.connection.close();
    }
}

test();
