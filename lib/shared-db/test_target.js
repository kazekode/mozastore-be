import mongoose from "mongoose";

const targetUri = "mongodb+srv://moza:store@apkprem.0hkn542.mongodb.net/?appName=apkprem";

async function retry() {
    try {
        console.log("Connecting to target...");
        const conn = await mongoose.createConnection(targetUri, { 
            dbName: "MannDB_V2", 
            serverSelectionTimeoutMS: 5000 
        }).asPromise();
        console.log("Success");
        process.exit(0);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
retry();
