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

  // --- 1. HANDLE TOMBOL (CALLBACK QUERY) ---
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data; 
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    // Deteksi Pemisah Data
    const separator = data.includes('|') ? '|' : '_';
    const parts = data.split(separator);
    const action = parts[0]; 
    const orderId = parts[1];
    const contactInfo = parts.slice(2).join(separator);

    // --- LOGIKA UTAMA ---
    if (action === 'ACC' || action === 'REVISI') {
        // 1. Update Status ke PAID (Aman diulang-ulang)
        await db.collection('orders').doc(orderId).update({ status: 'paid' });

        // 2. Ambil Data Order untuk Contekan Item (Solusi Poin 3)
        let itemListText = "Detail Item tidak terbaca.";
        try {
            const orderDoc = await db.collection('orders').doc(orderId).get();
            if (orderDoc.exists) {
                const items = orderDoc.data().items || [];
                // Buat daftar item untuk admin
                itemListText = items.map((i, idx) => `${idx+1}. ${i.name} (x${i.qty})`).join('\n');
            }
        } catch (e) { console.error("Gagal ambil detail item"); }

        // 3. EDIT PESAN ASLI (TAPI TETAPKAN TOMBOL REVISI DISANA!)
        // Ini Solusi Poin 2: Tombol tidak akan hilang selamanya.
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                // Tampilkan daftar item biar admin gak lupa
                text: `✅ <b>STATUS: PAID / LUNAS</b>\n🆔 Order: <code>${orderId}</code>\n👤 Buyer: ${contactInfo}\n\n📦 <b>DAFTAR BARANG:</b>\n<pre>${itemListText}</pre>\n\n👇 <i>Klik tombol di bawah untuk isi/edit data:</i>`,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        // TOMBOL INI ADALAH PENYELAMAT JIKA KEYBOARD KE-CLOSE
                        { text: "📝 ISI / EDIT KONTEN", callback_data: `REVISI|${orderId}|${contactInfo}` }
                    ]]
                }
            })
        });

        // 4. MUNCULKAN KEYBOARD INPUT (FORCE REPLY)
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `⌨️ <b>MODE INPUT DATA</b>\n\nSilahkan ketik data untuk Order #${orderId}.\n\n<b>Tips Multi-Item:</b>\nGunakan Enter untuk pemisah.\nContoh:\n<i>ML: 12345\nFF: 67890</i>`,
                parse_mode: 'HTML',
                reply_markup: { 
                    force_reply: true, 
                    input_field_placeholder: "Ketik data disini..." 
                }
            })
        });
    } 
    
    // Logika Komplain (Sama seperti sebelumnya)
    else if (action === 'COMPLAIN') {
         await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `🛡️ <b>BALAS KOMPLAIN #${orderId}</b>\nSilahkan ketik solusinya:`,
                parse_mode: 'HTML',
                reply_markup: { force_reply: true }
            })
        });
    }

    // Hapus loading
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

    // Deteksi apakah ini balasan input data
    if (replyOrigin.includes("MODE INPUT DATA") || replyOrigin.includes("BALAS KOMPLAIN")) {
        
        // Kita ambil ID dari Pesan Asli yang di-Reply (Bot harus kirim ID di pesan replynya)
        // Agar lebih aman, kita ambil ID dari text "Order #..." di prompt
        const orderIdMatch = replyOrigin.match(/Order #([^\s\.]+)/);
        const orderId = orderIdMatch ? orderIdMatch[1] : null;

        if (orderId && adminContent) {
            try {
                // Cek apakah ini komplain atau input biasa
                const isComplain = replyOrigin.includes("BALAS KOMPLAIN");
                
                // Update DB
                const updateData = isComplain 
                    ? { complaintReply: adminContent, hasComplaint: false }
                    : { adminMessage: adminContent, status: 'paid' };
                
                await db.collection('orders').doc(orderId).update(updateData);

                // Kirim Konfirmasi Sukses ke Admin
                // TAPI JANGAN LUPA SERTAKAN TOMBOL REVISI LAGI (JAGA-JAGA TYPO)
                
                // Ambil data buyer phone lagi dari DB biar akurat (opsional, atau ambil dari logic sebelumnya klo disimpan)
                // Disini kita sederhanakan response suksesnya
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: `✅ <b>DATA TERSIMPAN!</b>\nOrder: <code>${orderId}</code>\n\nIsi: <pre>${adminContent}</pre>`,
                        parse_mode: 'HTML'
                    })
                });

            } catch (e) { console.error(e); }
        }
    }
  }
  return res.status(200).send('OK');
}
