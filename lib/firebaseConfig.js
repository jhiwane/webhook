const admin = require('firebase-admin');

try {
    if (!admin.apps.length) {
        // Ambil variable terpisah agar aman dari error parsing JSON
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

        if (!projectId || !clientEmail || !privateKeyRaw) {
            throw new Error("FATAL: Konfigurasi Firebase (ProjectID/Email/Key) belum lengkap di Vercel!");
        }

        // Perbaiki format private key (\n)
        const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId,
                clientEmail,
                privateKey
            })
        });
        console.log("✅ Database Terhubung.");
    }
} catch (error) {
    console.error("❌ Gagal Init Firebase:", error.message);
    throw error;
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db, admin };
