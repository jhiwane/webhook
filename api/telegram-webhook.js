import admin from 'firebase-admin';

// --- INIT FIREBASE ---
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      const serviceAccount = JSON.parse(raw);
      if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
  } catch (e) { console.error(e); }
}
const db = admin.apps.length ? admin.firestore() : null;

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!db) return res.status(500).json({ error: "DB Error" });

  // --- 1. HANDLE TOMBOL (ACC / COMPLAIN / REVISI) ---
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data; 
    const chatId = callback.message.chat.id;

    // Deteksi Pemisah
    const separator = data.includes('|') ? '|' : '_';
    const parts = data.split(separator);
    const action = parts[0]; 
    const orderId = parts[1];
    const contactInfo = parts.slice(2).join(separator);

    let replyText = "";
    let placeholder = "";

    // JIKA TOMBOL ACC (ATAU TOMBOL REVISI DITEKAN)
    if (action === 'ACC') {
        // Update status (Aman dilakukan berulang)
        await db.collection('orders').doc(orderId).update({ status: 'paid' });
        
        replyText = `📝 <b>INPUT DATA PRODUK</b>\n\nBalas pesan ini dengan Data Akun/Voucher untuk:\nOrder ID: #${orderId}\nBuyer: ${contactInfo}\nTipe: ORDER_BARU`;
        placeholder = "Paste data akun revisi disini...";
        
        // Update pesan tombol jadi "PROCESSED" agar rapi
        try {
          await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  chat_id: chatId, message_id: callback.message.message_id,
                  text: `✅ <b>DIPROSES</b> (Order: ${orderId})`, parse_mode: 'HTML'
              })
          });
        } catch(e) {} // Abaikan error jika pesan terlalu tua
    } 
    else if (action === 'COMPLAIN') {
        replyText = `🛡️ <b>BALAS KOMPLAIN</b>\n\nBalas pesan ini dengan SOLUSI untuk:\nOrder ID: #${orderId}\nBuyer: ${contactInfo}\nTipe: KOMPLAIN_USER`;
        placeholder = "Ketik solusi...";
    }

    // KIRIM PROMPT (FORCE REPLY)
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText,
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: placeholder }
      })
    });
    
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id }) 
    });
  }

  // --- 2. HANDLE BALASAN ADMIN (REPLY) ---
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyOrigin = msg.reply_to_message.text;
    const adminContent = msg.text;
    const chatId = msg.chat.id;

    if (replyOrigin.includes("Order ID: #")) {
        const orderIdMatch = replyOrigin.match(/Order ID: #([^\s]+)/);
        const buyerMatch = replyOrigin.match(/Buyer: (.*)/);
        const isComplainReply = replyOrigin.includes("Tipe: KOMPLAIN_USER");
        
        const orderId = orderIdMatch ? orderIdMatch[1] : null;
        let contactInfo = buyerMatch ? buyerMatch[1].split('\n')[0].trim() : "";

        if (orderId && adminContent) {
            try {
                // A. UPDATE DATABASE (OVERWRITE DATA LAMA)
                const updateData = isComplainReply 
                    ? { complaintReply: adminContent, hasComplaint: false }
                    : { adminMessage: adminContent, status: 'paid' }; // INI KUNCINYA: Data lama tertimpa
                
                await db.collection('orders').doc(orderId).update(updateData);

                // B. GENERATE LINKS
                let messageResult = `✅ <b>${isComplainReply ? 'SOLUSI TERKIRIM' : 'DATA TERUPDATE'}!</b> 🌐\nID: <code>${orderId}</code>\n\n`;
                
                messageResult += `📦 <b>DATA SAAT INI (Tap Copy):</b>\n<pre>${adminContent}</pre>\n\n`;

                if (contactInfo.includes("@")) {
                    // LINK EMAIL
                    const subject = `Info Pesanan: ${orderId}`;
                    const body = `Halo,\n\n${isComplainReply ? 'Tanggapan komplain:' : 'Data pesanan Anda:'}\n\n${adminContent}\n\nTerima kasih!`;
                    const gmailWeb = `https://mail.google.com/mail/?view=cm&fs=1&to=${contactInfo}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                    const mailtoApp = `mailto:${contactInfo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

                    messageResult += `📧 <b>KIRIM EMAIL:</b>\n1. <a href="${mailtoApp}">👉 Buka APP HP</a>\n2. <a href="${gmailWeb}">👉 Buka WEB PC</a>`;
                } else {
                    // LINK WA
                    let phone = contactInfo.replace(/[^0-9]/g, '');
                    if (phone.startsWith("08")) phone = "62" + phone.slice(1);
                    const waText = `Halo, ${isComplainReply ? 'mengenai komplain' : 'pesanan'} *${orderId}*:\n\n${adminContent}\n\nTerima kasih!`;
                    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(waText)}`;
                    messageResult += `📱 <b>KIRIM WHATSAPP:</b>\n<a href="${waUrl}">👉 KLIK DISINI</a>`;
                }

                // C. KIRIM PESAN FINAL + TOMBOL REVISI (FITUR BARU)
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: messageResult,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                        reply_markup: {
                            inline_keyboard: [[
                                // TOMBOL INI MEMUNGKINKAN EDIT TANPA BATAS
                                { text: "✏️ TYPO? REVISI DATA", callback_data: `ACC|${orderId}|${contactInfo}` }
                            ]]
                        }
                    })
                });

            } catch (e) { console.error(e); }
        }
    }
  }
  return res.status(200).send('OK');
}
