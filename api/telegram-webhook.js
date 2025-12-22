import admin from 'firebase-admin';

// --- INIT FIREBASE (Sama seperti sebelumnya) ---
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      const serviceAccount = JSON.parse(raw);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
  } catch (e) {
    console.error("Firebase Init Error:", e.message);
  }
}
const db = admin.apps.length ? admin.firestore() : null;

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  // Cek Koneksi DB
  if (!db) return res.status(500).json({ error: "Database Error" });

  // 1. HANDLE TOMBOL (CALLBACK QUERY)
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data; // Contoh: "ACC_TRX-123_08123456"
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    // --- FITUR 1: TOMBOL ACC DITEKAN ---
    if (data.startsWith('ACC_')) {
      const parts = data.split('_');
      const orderId = parts[1];
      const buyerPhone = parts[2] || ""; // Simpan nomor HP pembeli dari callback

      try {
        // Update Firebase ke PAID
        await db.collection('orders').doc(orderId).update({ status: 'paid' });

        // 1. Edit pesan lama jadi "SUKSES"
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `✅ *PEMBAYARAN DITERIMA*\n🆔 Order: \`${orderId}\`\n📞 Buyer: ${buyerPhone}\n\nStatus Web: *PAID (Hijau)*`,
            parse_mode: 'Markdown'
          })
        });

        // 2. KIRIM PESAN BARU UNTUK MINTA KONTEN (FORCE REPLY)
        // Ini kuncinya! Bot akan "memaksa" user membalas pesan ini.
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            // Kita selipkan ID & No HP di teks agar nanti bisa diambil lagi
            text: `📝 *SILAHKAN ISI DATA PRODUK*\n\nBalas pesan ini dengan data akun/voucher untuk:\nOrder ID: #${orderId}\nBuyer: ${buyerPhone}`,
            parse_mode: 'Markdown',
            reply_markup: {
              force_reply: true, // Keyboard admin akan otomatis pop-up
              input_field_placeholder: "Contoh: Akun: user | Pass: 123"
            }
          })
        });

      } catch (e) {
        console.error(e);
      }
    }
    
    // Matikan loading jam pasir di tombol
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id }) 
    });
  }

  // 2. HANDLE PESAN TEKS (REPLY DARI ADMIN)
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyText = msg.reply_to_message.text; // Teks bot yang dibalas admin
    const adminContent = msg.text; // Konten yang diketik admin
    const chatId = msg.chat.id;

    // Cek apakah admin membalas pesan "SILAHKAN ISI DATA PRODUK"
    if (replyText.includes("ISI DATA PRODUK") && replyText.includes("Order ID: #")) {
        
        // Ekstrak ID dan No HP dari teks pesan bot sebelumnya
        // Regex ini mencari teks setelah "Order ID: #" dan "Buyer: "
        const orderIdMatch = replyText.match(/Order ID: #([^\s]+)/);
        const buyerMatch = replyText.match(/Buyer: ([^\s]+)/);
        
        const orderId = orderIdMatch ? orderIdMatch[1] : null;
        let buyerPhone = buyerMatch ? buyerMatch[1].trim() : "";

        // Bersihkan nomor WA (buang 08 ganti 62, buang karakter aneh)
        if(buyerPhone.startsWith("08")) buyerPhone = "62" + buyerPhone.slice(1);
        buyerPhone = buyerPhone.replace(/[^0-9]/g, '');

        if (orderId && adminContent) {
            try {
                // A. UPDATE WEB (FIRESTORE)
                await db.collection('orders').doc(orderId).update({
                    adminMessage: adminContent,
                    status: 'paid' // Jaga-jaga biar pasti paid
                });

                // B. BUAT LINK WA OTOMATIS
                let waLink = "";
                if (buyerPhone && buyerPhone.length > 5) {
                    const waText = encodeURIComponent(`Halo, pesanan *${orderId}* kamu sudah diproses ya!\n\n*DATA PESANAN:*\n${adminContent}\n\nTerima kasih!`);
                    waLink = `https://wa.me/${buyerPhone}?text=${waText}`;
                }

                // C. LAPOR BALIK KE ADMIN
                const responseText = `✅ *TERKIRIM KE WEB!* 🌐\nData untuk ${orderId} sudah masuk.\n\n` + 
                                     (waLink ? `👇 *Kirim ke WA Pelanggan:* \n[KLIK UNTUK CHAT WA](${waLink})` : `⚠️ Tidak ada nomor WA valid.`);

                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: responseText,
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    })
                });

            } catch (e) {
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ chat_id: chatId, text: `❌ ERROR DB: ${e.message}` })
                });
            }
        }
    }
  }

  return res.status(200).send('OK');
}
