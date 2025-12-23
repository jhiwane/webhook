import admin from 'firebase-admin';

// --- INIT FIREBASE ---
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      const serviceAccount = JSON.parse(raw);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
  } catch (e) { console.error("Init Error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!db) return res.status(500).json({ error: "Database Error" });

  // 1. HANDLE TOMBOL (CALLBACK QUERY)
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data; 
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    if (data.startsWith('ACC')) {
      const separator = data.includes('|') ? '|' : '_';
      const parts = data.split(separator);
      const orderId = parts[1];
      // Gabungkan sisa parts jika ada pemisah di dalam nama/email
      const contactInfo = parts.slice(2).join(separator); 

      try {
        await db.collection('orders').doc(orderId).update({ status: 'paid' });

        // Update Pesan Jadi PROCESSED (Pakai HTML)
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `✅ <b>PROSES DATA INPUT</b>\n🆔 Order: <code>${orderId}</code>\n👤 Kontak: <b>${contactInfo}</b>\n\n<i>Silahkan balas pesan di bawah ini...</i> 👇`,
            parse_mode: 'HTML' // GANTI KE HTML
          })
        });

        // Kirim Prompt Reply
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `📝 <b>INPUT DATA PRODUK</b>\n\nSilahkan balas pesan ini dengan data (Akun/Voucher) untuk:\nOrder ID: #${orderId}\nBuyer: ${contactInfo}`,
            parse_mode: 'HTML', // GANTI KE HTML
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Ketik data disini..."
            }
          })
        });

      } catch (e) { console.error("Webhook Error:", e); }
    }
    
    // Hapus loading
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id }) 
    });
  }

  // 2. HANDLE BALASAN ADMIN (REPLY)
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyText = msg.reply_to_message.text;
    const adminContent = msg.text; // Data yang diketik admin
    const chatId = msg.chat.id;

    if (replyText.includes("INPUT DATA PRODUK") && replyText.includes("Order ID: #")) {
        
        const orderIdMatch = replyText.match(/Order ID: #([^\s]+)/);
        const buyerMatch = replyText.match(/Buyer: (.*)/);
        
        const orderId = orderIdMatch ? orderIdMatch[1] : null;
        let contactInfo = buyerMatch ? buyerMatch[1].trim() : "";

        if (orderId && adminContent) {
            try {
                // A. UPDATE WEB
                await db.collection('orders').doc(orderId).update({
                    adminMessage: adminContent,
                    status: 'paid'
                });

                // B. DETEKSI KONTAK & BUAT LINK (LOGIKA UTAMA)
                let linkAction = "";
                let labelAction = "";

                // Cek apakah Email atau WA
                if (contactInfo.includes("@")) {
                    // --- OPSI 1: EMAIL (Paling Aman pakai HTML) ---
                    const subject = `Pesanan Jisaeshin: ${orderId}`;
                    const body = `Halo,\n\nBerikut data pesanan Anda (${orderId}):\n\n${adminContent}\n\nTerima kasih!`;
                    
                    // Encode untuk URL tapi jangan double encode simbol aneh
                    linkAction = `mailto:${contactInfo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                    labelAction = "📧 KLIK UNTUK KIRIM EMAIL";
                } else {
                    // --- OPSI 2: WHATSAPP ---
                    let phone = contactInfo.replace(/[^0-9]/g, '');
                    if (phone.startsWith("08")) phone = "62" + phone.slice(1);
                    
                    if (phone.length > 5) {
                        const waText = `Halo, pesanan *${orderId}* sudah selesai!\n\n*DATA PESANAN:*\n${adminContent}\n\nTerima kasih!`;
                        linkAction = `https://wa.me/${phone}?text=${encodeURIComponent(waText)}`;
                        labelAction = "📱 KLIK UNTUK KIRIM WA";
                    }
                }

                // C. LAPORAN DENGAN LINK HTML YANG RAPI
                let responseText = `✅ <b>TERKIRIM KE WEB!</b> 🌐\nData untuk <code>${orderId}</code> sudah masuk database.`;
                
                if (linkAction) {
                    // Syntax HTML Link: <a href="url">Teks</a>
                    responseText += `\n\n👇 <b>Kirim ke Pelanggan:</b> \n<a href="${linkAction}">${labelAction}</a>`;
                } else {
                    responseText += `\n\n⚠️ Kontak tidak valid, data hanya disimpan di Web.`;
                }

                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: responseText,
                        parse_mode: 'HTML', // PENTING: Mode HTML agar link Email jalan
                        disable_web_page_preview: true
                    })
                });

            } catch (e) { console.error("DB Error:", e); }
        }
    }
  }

  return res.status(200).send('OK');
}
