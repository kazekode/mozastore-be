require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://Moza:Store@moza.gfzmtfc.mongodb.net/?appName=Moza";

async function createAdmin() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");

    const db = mongoose.connection.db;
    const webusers = db.collection("webusers");

    // Check if an admin exists
    const admin = await webusers.findOne({ phone: "08123456789" });
    if (admin) {
      console.log("Admin account with phone '08123456789' already exists. Updating password to 'admin123' and ensuring is_admin = true.");
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await webusers.updateOne({ _id: admin._id }, { $set: { password: hashedPassword, is_admin: true } });
      console.log("Admin account updated.");
    } else {
      console.log("Creating new admin account...");
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await webusers.insertOne({
        name: "Super Admin",
        email: "admin@shop.com",
        phone: "08123456789",
        password: hashedPassword,
        is_admin: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log("Admin account created successfully.");
    }
    console.log("\nYou can now login with:\nEmail/Phone: 08123456789\nPassword: admin123\n");
    process.exit(0);
  } catch (error) {
    console.error("Error creating admin:", error);
    process.exit(1);
  }
}

createAdmin();
