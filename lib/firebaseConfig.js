const admin = require('firebase-admin');

if (!admin.apps.length) {
    try {
        // Membersihkan format Private Key untuk Vercel
        const privateKey = process.env.FIREBASE_PRIVATE_KEY 
            ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
            : undefined;

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: privateKey
            })
        });
    } catch (error) {
        console.error('Firebase Init Error:', error);
    }
}

const db = admin.firestore();
module.exports = { admin, db };
