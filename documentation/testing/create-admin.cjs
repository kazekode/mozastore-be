require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://moza:store@apprem.kbpp8u2.mongodb.net/?appName=apprem";

async function createAdmin() {
  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: process.env.MONGO_DBNAME || "MannDB_V2",
    });
    console.log("Connected to MongoDB");

    const db = mongoose.connection.db;
    const webusers = db.collection("webusers");

    const adminEmail = "admin@shop.com";
    const adminPhone = "08123456789";
    const adminPassword = "admin123";

    // Cek berdasarkan email ATAU nomor telepon agar tidak kena duplicate key
    const existingAdmin = await webusers.findOne({
      $or: [{ email: adminEmail }, { phone: adminPhone }],
    });

    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    if (existingAdmin) {
      console.log(
        `Admin account found (ID: ${existingAdmin._id}). Updating credentials...`
      );
      await webusers.updateOne(
        { _id: existingAdmin._id },
        {
          $set: {
            email: adminEmail,
            phone: adminPhone,
            password: hashedPassword,
            is_admin: true,
            updatedAt: new Date(),
          },
        }
      );
      console.log("Admin account updated successfully.");
    } else {
      console.log("Creating new admin account...");
      await webusers.insertOne({
        name: "Super Admin",
        email: adminEmail,
        phone: adminPhone,
        password: hashedPassword,
        is_admin: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log("Admin account created successfully.");
    }

    console.log(
      `\nYou can now login at /auth with:\nEmail: \({adminEmail}\nPhone:\){adminPhone}\nPassword: ${adminPassword}\n`
    );
    process.exit(0);
  } catch (error) {
    console.error("Error creating/updating admin:", error);
    process.exit(1);
  }
}

createAdmin();