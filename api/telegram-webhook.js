import admin from 'firebase-admin';

// --- INIT FIREBASE ---
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      const serviceAccount = JSON.parse(raw);
      // Fix format key Vercel
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
      // Deteksi pemisah data (bisa _ atau |)
      const separator = data.includes('|') ? '|' : '_';
      const parts = data.split(separator);
      const orderId = parts[1];
      const contactInfo = parts.slice(2).join(separator); // Gabung sisanya jaga-jaga email panjang

      try {
        // Update Firebase -> Paid
        await db.collection('orders').doc(orderId).update({ status: 'paid' });

        // Edit Pesan Jadi "PROCESSED"
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `✅ *PROSES DATA INPUT*\n🆔 Order: \`${orderId}\`\n👤 Kontak: ${contactInfo}\n\n_Silahkan balas pesan di bawah ini..._ 👇`,
            parse_mode: 'Markdown'
          })
        });

        // Kirim Prompt Force Reply (Memaksa keyboard muncul)
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `📝 *INPUT DATA PRODUK*\n\nSilahkan balas pesan ini dengan data (Akun/Voucher) untuk:\nOrder ID: #${orderId}\nBuyer: ${contactInfo}`,
            parse_mode: 'Markdown',
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Ketik data disini..."
            }
          })
        });

      } catch (e) { console.error("Webhook Error:", e); }
    }
    
    // Hapus loading jam pasir
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id }) 
    });
  }

  // 2. HANDLE BALASAN ADMIN (REPLY)
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyText = msg.reply_to_message.text; // Teks bot yg direply
    const adminContent = msg.text; // Jawaban admin
    const chatId = msg.chat.id;

    // Pastikan ini balasan untuk prompt input data
    if (replyText.includes("INPUT DATA PRODUK") && replyText.includes("Order ID: #")) {
        
        // Ambil ID dan Kontak dari teks pesan bot
        const orderIdMatch = replyText.match(/Order ID: #([^\s]+)/);
        const buyerMatch = replyText.match(/Buyer: (.*)/); // Ambil sampai akhir baris
        
        const orderId = orderIdMatch ? orderIdMatch[1] : null;
        let contactInfo = buyerMatch ? buyerMatch[1].trim() : "";

        if (orderId && adminContent) {
            try {
                // A. UPDATE WEB (FIRESTORE)
                await db.collection('orders').doc(orderId).update({
                    adminMessage: adminContent,
                    status: 'paid'
                });

                // B. DETEKSI TIPE KONTAK (WA vs EMAIL)
                let linkAction = "";
                let labelAction = "";

                if (contactInfo.includes("@")) {
                    // --- LOGIKA EMAIL ---
                    const subject = encodeURIComponent(`Pesanan Jisaeshin: ${orderId}`);
                    const body = encodeURIComponent(`Halo,\n\nBerikut adalah data pesanan Anda (${orderId}):\n\n${adminContent}\n\nTerima kasih!`);
                    linkAction = `mailto:${contactInfo}?subject=${subject}&body=${body}`;
                    labelAction = "📧 KIRIM VIA EMAIL";
                } else {
                    // --- LOGIKA WHATSAPP ---
                    // Bersihkan nomor (hanya ambil angka)
                    let phone = contactInfo.replace(/[^0-9]/g, '');
                    // Ganti 08 jadi 62
                    if (phone.startsWith("08")) phone = "62" + phone.slice(1);
                    
                    if (phone.length > 5) {
                        const waText = encodeURIComponent(`Halo, pesanan *${orderId}* sudah selesai!\n\n*DATA PESANAN:*\n${adminContent}\n\nTerima kasih!`);
                        linkAction = `https://wa.me/${phone}?text=${waText}`;
                        labelAction = "📱 KIRIM VIA WHATSAPP";
                    }
                }

                // C. LAPORAN SUKSES + LINK
                let responseText = `✅ *TERKIRIM KE WEB!* 🌐\nData untuk ${orderId} sudah masuk database.`;
                
                if (linkAction) {
                    responseText += `\n\n👇 *Klik untuk kirim ke Pelanggan:* \n[${labelAction}](${linkAction})`;
                } else {
                    responseText += `\n\n⚠️ Kontak tidak valid, data hanya disimpan di Web.`;
                }

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

            } catch (e) { console.error("DB Update Failed:", e); }
        }
    }
  }

  return res.status(200).send('OK');
}
