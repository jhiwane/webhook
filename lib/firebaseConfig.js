const admin = require('firebase-admin');

// Mencegah error "App already exists" di lingkungan serverless
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            // Parsing JSON dari Environment Variable
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } catch (error) {
            console.error('Firebase Init Error: Cek format JSON di Env Var!', error);
        }
    } else {
        console.error('FATAL: FIREBASE_SERVICE_ACCOUNT tidak ditemukan di Env Var.');
    }
}

const db = admin.firestore();
module.exports = { db, admin };
