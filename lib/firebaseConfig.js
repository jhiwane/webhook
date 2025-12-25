const admin = require('firebase-admin');

// --- METODE KONEKSI PECAHAN (LEBIH STABIL DI VERCEL) ---
try {
    if (!admin.apps.length) {
        // 1. Ambil 3 Kunci Utama Secara Terpisah
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

        // 2. Validasi Kunci
        if (!projectId || !clientEmail || !privateKeyRaw) {
            throw new Error("FATAL: Salah satu variabel environment (Project ID, Email, atau Key) HILANG.");
        }

        // 3. Format Private Key (Ubah \n jadi enter asli)
        const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

        // 4. Inisialisasi
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: projectId,
                clientEmail: clientEmail,
                privateKey: privateKey
            })
        });

        console.log("✅ DATABASE TERHUBUNG (METODE TERPISAH)");
    }
} catch (error) {
    console.error("❌ GAGAL INIT FIREBASE:", error.message);
    throw error; // Paksa crash biar ketahuan di log
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db, admin };
