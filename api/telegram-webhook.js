import admin from 'firebase-admin';

// --- 1. INIT FIREBASE (Auto-Fix Key Vercel) ---
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
  } catch (e) { console.error("Firebase Error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!db) return res.status(500).json({ error: "Database Error" });

  // --- 2. HANDLE TOMBOL ACC (CALLBACK QUERY) ---
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data; 
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    if (data.startsWith('ACC')) {
      const separator = data.includes('|') ? '|' : '_';
      const parts = data.split(separator);
      const orderId = parts[1];
      const contactInfo = parts.slice(2).join(separator); 

      try {
        await db.collection('orders').doc(orderId).update({ status: 'paid' });

        // Update Pesan Lama
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `✅ <b>PEMBAYARAN DITERIMA</b>\n🆔 Order: <code>${orderId}</code>\n👤 Kontak: <b>${contactInfo}</b>\n\n<i>Silahkan balas pesan di bawah ini untuk isi data...</i> 👇`,
            parse_mode: 'HTML'
          })
        });

        // Kirim Pesan Force Reply
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `📝 <b>INPUT DATA PRODUK</b>\n\nSilahkan balas pesan ini dengan data (Akun/Voucher) untuk:\nOrder ID: #${orderId}\nBuyer: ${contactInfo}`,
            parse_mode: 'HTML',
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Paste data akun disini..."
            }
          })
        });

      } catch (e) { console.error("Webhook ACC Error:", e); }
    }
    
    // Hapus loading
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id }) 
    });
  }

  // --- 3. HANDLE BALASAN ADMIN (LOGIKA LINK POWERFULL) ---
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyText = msg.reply_to_message.text;
    const adminContent = msg.text; 
    const chatId = msg.chat.id;

    if (replyText.includes("INPUT DATA PRODUK") && replyText.includes("Order ID: #")) {
        
        const orderIdMatch = replyText.match(/Order ID: #([^\s]+)/);
        const buyerMatch = replyText.match(/Buyer: (.*)/);
        
        const orderId = orderIdMatch ? orderIdMatch[1] : null;
        let contactInfo = buyerMatch ? buyerMatch[1].trim() : "";

        if (orderId && adminContent) {
            try {
                // A. Update Database
                await db.collection('orders').doc(orderId).update({
                    adminMessage: adminContent,
                    status: 'paid'
                });

                // B. GENERATE LINK (HTML STRICT MODE)
                let messageResult = `✅ <b>DATA TERKIRIM KE WEB!</b> 🌐\nData untuk <code>${orderId}</code> sudah masuk database.`;
                
                // Cek Tipe Kontak
                if (contactInfo.includes("@")) {
                    // --- MODE EMAIL ---
                    const subject = `Pesanan Jisaeshin: ${orderId}`;
                    // Tips: Email butuh \r\n untuk baris baru
                    const body = `Halo,\n\nBerikut data pesanan Anda (${orderId}):\n\n${adminContent}\n\nTerima kasih!`.replace(/\n/g, "\r\n");
                    
                    // RAKIT LINK MAILTO DENGAN BENAR
                    const mailtoUrl = `mailto:${contactInfo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                    
                    // Masukkan ke Tag HTML
                    messageResult += `\n\n📧 <b>Kirim ke Email Pelanggan:</b>\n<a href="${mailtoUrl}">👉 KLIK DISINI UNTUK BUKA GMAIL</a>`;
                    messageResult += `\n\n<i>(Jika link tidak bisa diklik, copy email ini: <code>${contactInfo}</code>)</i>`;

                } else {
                    // --- MODE WHATSAPP ---
                    let phone = contactInfo.replace(/[^0-9]/g, '');
                    if (phone.startsWith("08")) phone = "62" + phone.slice(1);
                    
                    if (phone.length > 5) {
                        const waText = `Halo, pesanan *${orderId}* sudah selesai!\n\n*DATA PESANAN:*\n${adminContent}\n\nTerima kasih!`;
                        const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(waText)}`;
                        
                        messageResult += `\n\n📱 <b>Kirim ke WhatsApp Pelanggan:</b>\n<a href="${waUrl}">👉 KLIK DISINI UNTUK BUKA WA</a>`;
                    } else {
                        messageResult += `\n\n⚠️ Nomor kontak tidak valid untuk WA.`;
                    }
                }

                // C. Kirim Pesan Final ke Admin
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: messageResult,
                        parse_mode: 'HTML', // Wajib HTML agar <a href> jalan
                        disable_web_page_preview: true
                    })
                });

            } catch (e) { 
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ chat_id: chatId, text: `❌ Error: ${e.message}` })
                });
            }
        }
    }
  }

  return res.status(200).send('OK');
}
