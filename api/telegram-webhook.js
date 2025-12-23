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
  } catch (e) { console.error("Firebase Error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!db) return res.status(500).json({ error: "Database Error" });

  // 1. HANDLE TOMBOL ACC
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
            text: `✅ <b>PROSES DATA INPUT</b>\n🆔 Order: <code>${orderId}</code>\n👤 Kontak: <b>${contactInfo}</b>\n\n<i>Silahkan balas pesan di bawah ini...</i> 👇`,
            parse_mode: 'HTML'
          })
        });

        // Prompt Force Reply
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

      } catch (e) { console.error("Webhook Error:", e); }
    }
    
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id }) 
    });
  }

  // 2. HANDLE BALASAN ADMIN (LOGIKA LINK GMAIL + COPY)
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

                // B. SIAPKAN PESAN HASIL
                let messageResult = `✅ <b>DATA TERKIRIM KE WEB!</b> 🌐\nData untuk <code>${orderId}</code> sudah aman.\n\n`;
                
                // --- FITUR BARU: DATA DALAM KOTAK COPY ---
                // Tag <pre> membuat teks bisa dicopy dengan satu klik di Telegram
                messageResult += `📦 <b>DATA PRODUK (Tap untuk Copy):</b>\n<pre>${adminContent}</pre>\n\n`;

                // C. GENERATE LINK OTOMATIS
                if (contactInfo.includes("@")) {
                    // --- OPSI EMAIL (GMAIL LINK) ---
                    // Kita pakai Link HTTPS Gmail agar PASTI DIBACA sebagai link oleh Telegram
                    const subject = `Pesanan Anda: ${orderId}`;
                    const body = `Halo,\n\nBerikut data pesanan Anda (${orderId}):\n\n${adminContent}\n\nTerima kasih!`;
                    
                    const gmailLink = `https://mail.google.com/mail/?view=cm&fs=1&to=${contactInfo}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                    
                    messageResult += `📧 <b>KIRIM KE PELANGGAN:</b>\n<a href="${gmailLink}">👉 KLIK DISINI (Buka Gmail Otomatis)</a>`;

                } else {
                    // --- OPSI WHATSAPP ---
                    let phone = contactInfo.replace(/[^0-9]/g, '');
                    if (phone.startsWith("08")) phone = "62" + phone.slice(1);
                    
                    if (phone.length > 5) {
                        const waText = `Halo, pesanan *${orderId}* sudah selesai!\n\n*DATA PESANAN:*\n${adminContent}\n\nTerima kasih!`;
                        const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(waText)}`;
                        
                        messageResult += `📱 <b>KIRIM KE WHATSAPP:</b>\n<a href="${waUrl}">👉 KLIK DISINI (Buka WA Otomatis)</a>`;
                    } else {
                        messageResult += `⚠️ Nomor WA tidak valid.`;
                    }
                }

                // Kirim Pesan Final
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: messageResult,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    })
                });

            } catch (e) { console.error(e); }
        }
    }
  }

  return res.status(200).send('OK');
}
