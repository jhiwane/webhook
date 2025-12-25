const admin = require('firebase-admin');

// Mencegah inisialisasi ganda
if (!admin.apps.length) {
    try {
        // 1. Ambil Env Variable
        const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
        
        if (!serviceAccountRaw) {
            throw new Error("FATAL: Environment Variable FIREBASE_SERVICE_ACCOUNT tidak ditemukan!");
        }

        // 2. Parsing JSON dengan penanganan error
        let serviceAccount;
        try {
            serviceAccount = JSON.parse(serviceAccountRaw);
        } catch (e) {
            console.error("Isi Env Var (Awal):", serviceAccountRaw.substring(0, 50) + "...");
            throw new Error("FATAL: JSON Service Account rusak/tidak valid. Pastikan copy-paste dari JSON Minifier benar.");
        }

        // 3. AUTO-REPAIR PRIVATE KEY (Sangat Penting untuk Vercel)
        // Mengubah string "\n" (literal) menjadi karakter baris baru yang asli
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        } else {
            throw new Error("FATAL: 'private_key' tidak ada dalam JSON!");
        }

        // 4. Inisialisasi Firebase
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        console.log("✅ FIREBASE DATABASE TERHUBUNG!");

    } catch (error) {
        console.error("❌ GAGAL KONEKSI FIREBASE:", error.message);
        // Kita throw error agar Vercel merestart function dan kita sadar ada masalah konfigurasi
        throw error;
    }
}

// Inisialisasi Firestore
const db = admin.firestore();

// Matikan log error timestamp firestore yang mengganggu (opsional)
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db, admin };
