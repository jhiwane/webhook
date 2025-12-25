// api/firebaseConfig.js
const admin = require('firebase-admin');

// ⚠️ PENTING: Ganti ini dengan Service Account Key dari Firebase Console > Project Settings > Service Accounts
// Simpan sebagai Environment Variable di Vercel agar aman
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();
module.exports = { db, admin };
