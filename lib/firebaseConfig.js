const admin = require('firebase-admin');

try {
    if (!admin.apps.length) {
        // 1. Cek apakah Environment Variable ada?
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            throw new Error("FATAL: Environment Variable FIREBASE_SERVICE_ACCOUNT Hilang!");
        }

        // 2. Parsing JSON
        let serviceAccount;
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } catch (e) {
            throw new Error("FATAL: Format JSON di Vercel Rusak/Invalid! Cek koma atau kurung kurawal.");
        }

        // 3. FITUR PENTING: Perbaiki format Private Key yang sering rusak di Vercel
        // Vercel sering mengubah "enter" (\n) menjadi tulisan "\n" biasa. Kita kembalikan fungsinya.
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }

        // 4. Koneksikan
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        
        console.log("✅ FIREBASE DATABASE TERHUBUNG!");
    }
} catch (error) {
    console.error("❌ ERROR KONEKSI FIREBASE:", error.message);
    // Kita throw error agar Vercel merestart functionnya daripada jalan tapi error
    throw error;
}

const db = admin.firestore();
module.exports = { db, admin };
