// lib/firebase.js
const admin = require('firebase-admin');

// Mencegah inisialisasi ganda (Singleton Pattern)
if (!admin.apps.length) {
  try {
    // Trik membersihkan Private Key dari error format string
    const privateKey = process.env.FIREBASE_PRIVATE_KEY 
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
      : undefined;

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      }),
    });
    console.log("🔥 Firebase Admin Initialized");
  } catch (error) {
    console.error("Firebase Admin Error:", error.message);
  }
}

const db = admin.firestore();
export { db };
