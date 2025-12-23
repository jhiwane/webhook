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

    const separator = data.includes('|') ? '|' : '_';
    const parts = data.split(separator);
    const action = parts[0]; 
    const orderId = parts[1];
    const contactInfo = parts.slice(2).join(separator);

    let replyText = "";
    let placeholder = "";

    // JIKA ADMIN MAU ISI DATA / REVISI DATA UTAMA
    if (action === 'ACC' || action === 'REVISI') {
        await db.collection('orders').doc(orderId).update({ status: 'paid' });
        
        // Pancingan Text Harus Unik
        replyText = `📝 <b>MODE INPUT DATA UTAMA</b>\n\nSilahkan ketik data untuk Order: #${orderId}\nBuyer: ${contactInfo}`;
        placeholder = "Paste data akun disini...";
        
        try {
          await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  chat_id: chatId, message_id: callback.message.message_id,
                  text: `✅ <b>DIPROSES</b> (Order: ${orderId})`, parse_mode: 'HTML'
              })
          });
        } catch(e) {}
    } 
    // JIKA ADMIN MAU BALAS KOMPLAIN (HANYA ITEM EROR)
    else if (action === 'COMPLAIN') {
        // Pancingan Text Harus Unik
        replyText = `🛠️ <b>MODE BALAS KOMPLAIN</b>\n\nKetik solusi/pengganti untuk Order: #${orderId}\nBuyer: ${contactInfo}\n\n<i>Tips: Cukup ketik item yang eror saja.</i>`;
        placeholder = "Contoh: Capcut: email|pass baru";
    }

    // KIRIM FORM INPUT (FORCE REPLY)
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

  // --- 2. HANDLE JAWABAN ADMIN (REPLY) ---
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyOrigin = msg.reply_to_message.text; // Teks Pancingan
    const adminContent = msg.text; // Jawaban Admin
    const chatId = msg.chat.id;

    // KITA CARI ID ORDER DARI TEKS PANCINGAN
    const orderIdMatch = replyOrigin.match(/Order: #([^\s]+)/);
    const orderId = orderIdMatch ? orderIdMatch[1] : null;

    if (orderId && adminContent) {
        try {
            // DETEKSI: INI REVISI UTAMA ATAU BALAS KOMPLAIN?
            const isComplainReply = replyOrigin.includes("MODE BALAS KOMPLAIN");

            // A. UPDATE DATABASE
            let updateData = {};
            if (isComplainReply) {
                // Jika balasan komplain, Update field KHUSUS 'complaintReply'
                updateData = { complaintReply: adminContent, hasComplaint: false };
            } else {
                // Jika input data utama, Update 'adminMessage' dan 'status'
                updateData = { adminMessage: adminContent, status: 'paid', complaintReply: admin.firestore.FieldValue.delete() }; 
                // Note: complaintReply dihapus biar bersih kalau admin revisi ulang semua
            }
            
            await db.collection('orders').doc(orderId).update(updateData);

            // B. KIRIM KONFIRMASI KE TELEGRAM
            let messageResult = `✅ <b>${isComplainReply ? 'SOLUSI TERKIRIM' : 'DATA TERSIMPAN'}!</b>\nID: <code>${orderId}</code>\n\n`;
            messageResult += `Isi: <pre>${adminContent}</pre>`;

            // Tombol Revisi Selalu Ada
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: messageResult,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "✏️ REVISI DATA UTAMA", callback_data: `REVISI|${orderId}|-` }
                        ]]
                    }
                })
            });

        } catch (e) { console.error(e); }
    }
  }
  return res.status(200).send('OK');
}
