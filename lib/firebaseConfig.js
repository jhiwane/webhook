const admin = require('firebase-admin');

console.log("🔥 Memulai Inisialisasi Firebase...");

try {
    if (!admin.apps.length) {
        // 1. Cek Keberadaan Env Var
        const envVar = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!envVar) {
            throw new Error("FATAL: Environment Variable FIREBASE_SERVICE_ACCOUNT KOSONG/TIDAK DITEMUKAN!");
        }

        console.log(`✅ Env Var ditemukan. Panjang karakter: ${envVar.length}`);

        // 2. Coba Parsing JSON
        let serviceAccount;
        try {
            serviceAccount = JSON.parse(envVar);
            console.log("✅ JSON Parse Berhasil.");
            console.log(`ℹ️ Project ID: ${serviceAccount.project_id}`);
            console.log(`ℹ️ Client Email: ${serviceAccount.client_email}`);
        } catch (e) {
            console.error("❌ JSON Parse GAGAL! Pastikan format JSON valid di Vercel Settings.");
            throw e;
        }

        // 3. Perbaikan Private Key (Sering bermasalah disini)
        if (serviceAccount.private_key) {
            // Cek apakah key rusak?
            const keyPreview = serviceAccount.private_key.substring(0, 30);
            console.log(`ℹ️ Private Key Check (Awal): ${keyPreview}...`);
            
            // Fix newlines
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        } else {
            throw new Error("FATAL: 'private_key' tidak ditemukan dalam JSON!");
        }

        // 4. Koneksi
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        
        console.log("🚀 FIREBASE ADMIN BERHASIL INIT!");
    }
} catch (error) {
    console.error("❌ KRITIS: Gagal Init Firebase:", error.message);
    // Kita biarkan db undefined biar ketahuan crash-nya
}

const db = admin.firestore();
module.exports = { db, admin };
