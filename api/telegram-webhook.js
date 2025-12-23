import admin from 'firebase-admin';

// --- INIT FIREBASE (SUPPORTS VERCEL ENV FORMAT) ---
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      const serviceAccount = JSON.parse(raw);
      // Fix Vercel's newline formatting issue
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
  
  // Cek DB Connection
  if (!db) return res.status(500).json({ error: "Database Connection Failed" });

  // --- 1. HANDLE TOMBOL (CALLBACK QUERY) ---
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data; 
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    // Deteksi Pemisah Data (| atau _)
    const separator = data.includes('|') ? '|' : '_';
    const parts = data.split(separator);
    const action = parts[0];       // ACC, REVISI, atau COMPLAIN
    const orderId = parts[1];      // TRX-XXXX
    const contactInfo = parts.slice(2).join(separator); // Email/WA

    let replyText = "";
    let placeholder = "";

    // --- LOGIKA A: INPUT DATA UTAMA (ACC / REVISI) ---
    if (action === 'ACC' || action === 'REVISI') {
        // 1. Update Status Web jadi PAID
        await db.collection('orders').doc(orderId).update({ status: 'paid' });
        
        // 2. Siapkan Pesan Pancingan (Prompt)
        replyText = `📝 <b>MODE INPUT DATA UTAMA</b>\n\nSilahkan ketik/paste data produk untuk:\nOrder: #${orderId}\nBuyer: ${contactInfo}`;
        placeholder = "Paste data akun lengkap disini...";
        
        // 3. Edit Pesan Tombol Jadi 'DIPROSES' (Biar rapi)
        try {
          await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  chat_id: chatId,
                  message_id: messageId,
                  // Tampilkan lagi tombol Revisi disana, JAGA-JAGA kalau admin close keyboard
                  text: `✅ <b>STATUS: DIPROSES</b>\nOrder: <code>${orderId}</code>\nBuyer: ${contactInfo}\n\n👇 <i>Klik tombol lagi jika keyboard tertutup:</i>`,
                  parse_mode: 'HTML',
                  reply_markup: {
                      inline_keyboard: [[
                          { text: "📝 LANJUT INPUT / REVISI", callback_data: `REVISI|${orderId}|${contactInfo}` }
                      ]]
                  }
              })
          });
        } catch(e) {} // Abaikan error jika pesan terlalu tua
    } 
    
    // --- LOGIKA B: BALAS KOMPLAIN ---
    else if (action === 'COMPLAIN') {
        replyText = `🛠️ <b>MODE BALAS KOMPLAIN</b>\n\nKetik solusi/pengganti untuk:\nOrder: #${orderId}\nBuyer: ${contactInfo}\n\n<i>Tips: Cukup ketik item yang bermasalah saja.</i>`;
        placeholder = "Contoh: Capcut baru: email|pass";
    }

    // --- 4. KIRIM KEYBOARD INPUT (FORCE REPLY) ---
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText,
        parse_mode: 'HTML',
        reply_markup: {
          force_reply: true, // Memaksa keyboard muncul
          input_field_placeholder: placeholder
        }
      })
    });
    
    // Matikan loading jam pasir
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id }) 
    });
  }

  // --- 2. HANDLE BALASAN ADMIN (REPLY MESSAGE) ---
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyOrigin = msg.reply_to_message.text; // Teks Pancingan dari Bot
    const adminContent = msg.text; // Apa yang diketik admin
    const chatId = msg.chat.id;

    // Ambil Order ID dari teks pancingan
    const orderIdMatch = replyOrigin.match(/Order: #([^\s]+)/);
    const orderId = orderIdMatch ? orderIdMatch[1] : null;

    // Ambil Info Kontak (jika ada)
    const buyerMatch = replyOrigin.match(/Buyer: (.*)/);
    let contactInfo = buyerMatch ? buyerMatch[1].split('\n')[0].trim() : "";

    if (orderId && adminContent) {
        try {
            // DETEKSI: INI REVISI UTAMA ATAU BALAS KOMPLAIN?
            const isComplainReply = replyOrigin.includes("MODE BALAS KOMPLAIN");

            // A. UPDATE DATABASE
            let updateData = {};
            if (isComplainReply) {
                // Update Kotak Kuning (Komplain)
                updateData = { complaintReply: adminContent, hasComplaint: false };
            } else {
                // Update Kotak Utama + Bersihkan kotak komplain lama
                updateData = { adminMessage: adminContent, status: 'paid', complaintReply: admin.firestore.FieldValue.delete() }; 
            }
            
            await db.collection('orders').doc(orderId).update(updateData);

            // B. GENERATE LINK (EMAIL & WA)
            let messageResult = `✅ <b>${isComplainReply ? 'SOLUSI TERKIRIM' : 'DATA TERSIMPAN'}!</b> 🌐\nID: <code>${orderId}</code>\n\n`;
            
            // Tampilkan Data dalam Kotak Copy
            messageResult += `📦 <b>ISI PESAN (Tap Copy):</b>\n<pre>${adminContent}</pre>\n\n`;

            // Logic Pembuatan Link
            if (contactInfo.includes("@")) {
                // --- MODE EMAIL ---
                const subject = `Info Pesanan: ${orderId}`;
                const body = `Halo,\n\n${isComplainReply ? 'Tanggapan masalah:' : 'Data pesanan Anda:'}\n\n${adminContent}\n\nTerima kasih!`;
                
                // Link Gmail Web (PC)
                const gmailWeb = `https://mail.google.com/mail/?view=cm&fs=1&to=${contactInfo}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                // Link Mailto (HP)
                const mailtoApp = `mailto:${contactInfo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

                messageResult += `📧 <b>KIRIM EMAIL:</b>\n1. <a href="${mailtoApp}">👉 Buka APP HP (Mailto)</a>\n2. <a href="${gmailWeb}">👉 Buka WEB PC (Gmail)</a>`;
            } else {
                // --- MODE WA ---
                let phone = contactInfo.replace(/[^0-9]/g, '');
                if (phone.startsWith("08")) phone = "62" + phone.slice(1);
                
                if (phone.length > 5) {
                    const waText = `Halo, ${isComplainReply ? 'terkait komplain' : 'pesanan'} *${orderId}*:\n\n${adminContent}\n\nTerima kasih!`;
                    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(waText)}`;
                    messageResult += `📱 <b>KIRIM WHATSAPP:</b>\n<a href="${waUrl}">👉 KLIK DISINI</a>`;
                } else {
                    messageResult += `⚠️ Nomor WA tidak valid.`;
                }
            }

            // C. KIRIM PESAN FINAL (+ TOMBOL REVISI LAGI)
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: messageResult,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: {
                        inline_keyboard: [[
                            // Tombol ini selalu ada, jadi Admin bisa revisi kapan saja
                            { text: "✏️ REVISI / EDIT LAGI", callback_data: `REVISI|${orderId}|${contactInfo}` }
                        ]]
                    }
                })
            });

        } catch (e) {
            console.error("Error Processing Reply:", e);
        }
    }
  }

  return res.status(200).send('OK');
}
