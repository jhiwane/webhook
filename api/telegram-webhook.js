import admin from 'firebase-admin';

// --- BAGIAN INI YANG MEMPERBAIKI MASALAH CRASH ---
if (!admin.apps.length) {
  try {
    // 1. Ambil Variable dari Vercel
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    
    if (!serviceAccountRaw) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT kosong/tidak terbaca!");
    }

    // 2. Parsing JSON (dengan penanganan error jika format salah)
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountRaw);
    } catch (parseError) {
      // Jika error, coba bersihkan tanda kutip ganda yang mungkin berlebihan
      console.error("JSON Parse Error, mencoba mode raw...");
      throw new Error("Format JSON Service Account Rusak. Pastikan copy full dari { sampai }");
    }

    // 3. JURUS KUNCI: Perbaiki format Private Key (Masalah \n vs \\n)
    // Vercel sering merusak format ini, baris ini memperbaikinya:
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    // 4. Inisialisasi Firebase
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    console.log("✅ Firebase Admin Berhasil Terhubung!");

  } catch (error) {
    console.error("❌ FATAL ERROR SAAT INIT FIREBASE:", error.message);
    // Kita simpan errornya di variable global biar bisa ditampilkan di browser
    global.initError = error.message;
  }
}

const db = admin.apps.length ? admin.firestore() : null;

export default async function handler(req, res) {
  // --- DEBUG MODE (GET REQUEST) ---
  // Buka URL ini di browser untuk cek status server tanpa crash
  if (req.method === 'GET') {
    if (global.initError || !db) {
      return res.status(500).json({ 
        status: "CRITICAL ERROR", 
        message: "Firebase gagal login", 
        detail: global.initError || "Unknown Error" 
      });
    }
    return res.status(200).json({ 
      status: "ONLINE", 
      message: "Webhook siap menerima data Telegram" 
    });
  }

  // Cek apakah DB siap sebelum lanjut
  if (!db) {
    return res.status(500).json({ error: "Server Database Mati", detail: global.initError });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;

  // --- LOGIC BOT (SAMA SEPERTI SEBELUMNYA) ---
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    if (data.startsWith('ACC_')) {
      const orderId = data.split('_')[1];
      try {
        await db.collection('orders').doc(orderId).update({ status: 'paid' });
        
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
      } catch (e) { console.error(e); }
    }
    // Hapus loading
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
       method: 'POST', headers: {'Content-Type': 'application/json'},
       body: JSON.stringify({ callback_query_id: callback.id, text: "Done" })
    });
  }
  
  // Logic /isi
  else if (req.body.message && req.body.message.text && req.body.message.text.startsWith('/isi')) {
     const text = req.body.message.text;
     const chatId = req.body.message.chat.id;
     const parts = text.split(' ');
     const orderId = parts[1];
     const content = parts.slice(2).join(' ');

     if(orderId && content) {
        try {
            await db.collection('orders').doc(orderId).update({
                adminMessage: `DATA PESANAN:\n${content}`,
                status: 'paid'
            });
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ chat_id: chatId, text: `✅ Terkirim ke ${orderId}` })
            });
        } catch(e) {
            // Error handling silent
        }
     }
  }

  return res.status(200).send('OK');
}
