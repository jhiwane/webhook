// File: api/telegram-webhook.js
import admin from 'firebase-admin';

// Fungsi Helper untuk membersihkan JSON
const getServiceAccount = () => {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT kosong di Vercel!");
    
    // Jika formatnya sudah object (jarang terjadi di env), kembalikan langsung
    if (typeof raw === 'object') return raw;

    // Bersihkan string dari potensi masalah formatting
    return JSON.parse(raw);
  } catch (e) {
    console.error("Gagal parsing Service Account:", e.message);
    return null;
  }
};

// Inisialisasi Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = getServiceAccount();
  
  if (serviceAccount) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("Firebase Admin Berhasil Init!");
    } catch (e) {
      console.error("Firebase Admin Init Error:", e.message);
    }
  }
}

// Gunakan try-catch agar tidak crash total jika db belum siap
let db;
try {
  db = admin.firestore();
} catch (e) {
  console.error("Firestore belum siap");
}

export default async function handler(req, res) {
  // Cek apakah DB siap
  if (!db) {
    return res.status(500).json({ error: "Database Connection Failed (Check Logs)" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  // 1. Handle Callback Query (Saat Tombol ACC Ditekan)
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data; 
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    if (data.startsWith('ACC_')) {
      const orderId = data.split('_')[1];

      try {
        console.log(`Mencoba ACC Order: ${orderId}`);
        await db.collection('orders').doc(orderId).update({ status: 'paid' });

        // Edit Pesan Telegram
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `✅ *SUKSES ACC: ${orderId}*\nStatus Web: PAID\n\nSilahkan lanjut kirim data (jika ada).`,
            parse_mode: 'Markdown'
          })
        });
      } catch (error) {
        console.error("Gagal Update Firestore:", error);
      }
    }
    
    // Hilangkan loading di tombol
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callback.id, text: "Processing..." }) 
    });
  }

  // 2. Handle Text Message (/isi)
  else if (req.body.message && req.body.message.text) {
    const text = req.body.message.text;
    const chatId = req.body.message.chat.id;

    if (text.startsWith('/isi')) {
      const parts = text.split(' ');
      const orderId = parts[1];
      const content = parts.slice(2).join(' ');

      if (orderId && content) {
        try {
          console.log(`Mengisi Konten Order: ${orderId}`);
          await db.collection('orders').doc(orderId).update({
            adminMessage: `DATA PESANAN:\n${content}`,
            status: 'paid'
          });

          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `✅ *DATA TERKIRIM KE WEB*\nOrder: ${orderId}`,
              parse_mode: 'Markdown'
            })
          });
        } catch (error) {
            console.error("Gagal Isi Konten:", error);
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: `❌ Gagal: ${error.message}` })
            });
        }
      }
    }
  }

  return res.status(200).send('OK');
}
