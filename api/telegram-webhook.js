// File: api/telegram-webhook.js
import admin from 'firebase-admin';

// Inisialisasi Firebase Admin (Hanya sekali)
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error("Firebase Admin Init Error:", error);
  }
}
const db = admin.firestore();

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  // 1. Handle Callback Query (Saat Tombol ACC Ditekan)
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data; // Format: "ACC_TRX-12345"
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    if (data.startsWith('ACC_')) {
      const orderId = data.split('_')[1];

      try {
        // Update Firestore ke 'paid'
        await db.collection('orders').doc(orderId).update({ status: 'paid' });

        // Edit Pesan Telegram biar Admin tau sudah sukses
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `✅ *SUKSES ACC: ${orderId}*\nStatus Web: PAID\nJangan lupa kirim data jika produk manual!`,
            parse_mode: 'Markdown'
          })
        });
      } catch (error) {
        console.error(error);
      }
    }
    // Respon agar loading di tombol telegram hilang
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callback.id, text: "Processing..." }) 
    });
  }

  // 2. Handle Text Message (Untuk Fitur Isi Konten /isi)
  else if (req.body.message && req.body.message.text) {
    const text = req.body.message.text; // Contoh: "/isi TRX-12345678 sn:blabla"
    const chatId = req.body.message.chat.id;

    if (text.startsWith('/isi')) {
      // Parsing pesan
      const parts = text.split(' ');
      const orderId = parts[1]; // TRX-XXXX
      const content = parts.slice(2).join(' '); // Sisanya adalah konten

      if (orderId && content) {
        try {
          // Update Firestore: Masukkan data ke adminMessage atau Items
          await db.collection('orders').doc(orderId).update({
            adminMessage: `DATA PESANAN:\n${content}`,
            status: 'paid' // Sekalian tandai paid jika belum
          });

          // Balas Admin
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `✅ *DATA TERKIRIM KE WEB*\nOrder: ${orderId}\nKonten: ${content}`,
              parse_mode: 'Markdown'
            })
          });
        } catch (error) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: `❌ Gagal Update: ${error.message}` })
            });
        }
      } else {
         await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: `⚠️ Format Salah.\nGunakan: \`/isi ID_ORDER DATA_KONTEN\``, parse_mode: 'Markdown' })
        });
      }
    }
  }

  return res.status(200).send('OK');
}
