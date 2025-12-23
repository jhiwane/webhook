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
  } catch (e) { console.error("Firebase Error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl = "https://" + req.headers.host; // Mendapatkan URL website otomatis

  if (!db) return res.status(500).send("DB Error");

  // ============================================================
  // 1. HANDLE KLIK TOMBOL (CALLBACK QUERY)
  // ============================================================
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    const parts = data.split('|');
    const action = parts[0];
    const orderId = parts[1];
    // Variabel extra (bisa index item atau kontak buyer)
    const extra = parts[2]; 

    // --- SKENARIO 1: ADMIN KLIK "ACC" (MANUAL) ---
    if (action === 'ACC') {
        const buyerContact = extra; // Diambil dari tombol ACC|ID|KONTAK

        // 1. Update DB jadi PAID
        const orderRef = db.collection('orders').doc(orderId);
        const docSnap = await orderRef.get();
        if(docSnap.exists) {
            await orderRef.update({ status: 'paid' });
            const items = docSnap.data().items;

            // 2. Panggil API Notify lagi untuk memunculkan Tombol Input Item
            // Kita "pura-pura" jadi sistem auto payment yang memanggil notifikasi
            await fetch(`${baseUrl}/api/telegram-notify`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    orderId: orderId,
                    total: docSnap.data().total,
                    items: items,
                    buyerContact: buyerContact,
                    type: 'auto' // Trik: Set ke auto agar muncul tombol input
                })
            });

            // 3. Hapus/Edit pesan "Cek Mutasi" biar tidak menuhin chat
            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            });
            
            // Atau cukup kirim notif kecil
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ callback_query_id: callback.id, text: "✅ Pesanan di-ACC. Menu Input muncul..." })
            });
        }
    }

    // --- SKENARIO 2: ADMIN KLIK "ISI ITEM #X" ---
    else if (action === 'INPUT') {
        const itemIndex = parseInt(extra);
        
        // Ambil nama item dari DB untuk label
        const docSnap = await db.collection('orders').doc(orderId).get();
        const itemName = docSnap.exists ? docSnap.data().items[itemIndex].name : "Item";

        // Kirim Force Reply (Agar admin bisa ngetik)
        // Kita selipkan ID dan Index di teks agar bisa diparsing nanti
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `✍️ <b>INPUT DATA KONTEN</b>\n\nProduk: <b>${itemName}</b>\nOrder: <code>${orderId}</code>\nIndex: ${itemIndex}\n\n<i>Silahkan Reply/Paste data (Email/Pass/Kode) untuk item ini:</i>`,
                parse_mode: 'HTML',
                reply_markup: {
                    force_reply: true,
                    input_field_placeholder: `Data untuk ${itemName}...`
                }
            })
        });

        // Tutup loading jam pasir
        await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ callback_query_id: callback.id })
        });
    }
  }

  // ============================================================
  // 2. HANDLE BALASAN ADMIN (TEXT REPLY) - SINKRONISASI WEB
  // ============================================================
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyOrigin = msg.reply_to_message.text;
    const adminContent = msg.text;
    const chatId = msg.chat.id;

    // Parsing ID dan Index dari teks pancingan bot
    const orderIdMatch = replyOrigin.match(/Order: ([^\s\n]+)/);
    const indexMatch = replyOrigin.match(/Index: (\d+)/);

    const orderId = orderIdMatch ? orderIdMatch[1] : null;
    const itemIndex = indexMatch ? parseInt(indexMatch[1]) : null;

    if (orderId && itemIndex !== null && adminContent) {
        try {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await orderRef.get();
            if (!doc.exists) throw new Error("Order tidak ditemukan");

            let items = doc.data().items;
            const buyerContact = items[0]?.note || "Pembeli"; // Ambil kontak dari note item pertama

            // --- INI KUNCI SINKRONISASINYA ---
            // 1. Masukkan data admin ke array item
            items[itemIndex].data = [adminContent]; 
            
            // 2. Ubah status Manual jadi FALSE
            // Ini yang membuat Web User berubah dari "Menunggu" jadi "Data Muncul"
            items[itemIndex].isManual = false; 
            items[itemIndex].note = "✅ Data Terkirim";

            // 3. Simpan ke DB
            await orderRef.update({ items: items, status: 'paid' });

            // 4. Siapkan Link Kirim ke User (WA & Email)
            let sendLinks = "";
            let cleanPhone = buyerContact.replace(/[^0-9]/g, '');
            if(cleanPhone.startsWith('08')) cleanPhone = '62' + cleanPhone.slice(1);
            
            // Link WA
            if(cleanPhone.length > 6) {
                const waMsg = `Halo, pesanan *${items[itemIndex].name}* (ID: ${orderId}) sudah diproses:\n\n${adminContent}\n\nTerima kasih!`;
                sendLinks += `📱 <a href="https://wa.me/${cleanPhone}?text=${encodeURIComponent(waMsg)}">Kirim ke WhatsApp</a>\n`;
            }
            // Link Email (Jika terdeteksi email)
            if(buyerContact.includes('@')) {
                const mailSub = `Pesanan Selesai: ${items[itemIndex].name}`;
                const mailBody = `Halo,\n\nBerikut data pesanan Anda:\n\n${adminContent}\n\nTerima kasih.`;
                sendLinks += `📧 <a href="mailto:${buyerContact}?subject=${encodeURIComponent(mailSub)}&body=${encodeURIComponent(mailBody)}">Kirim Email</a>`;
            }

            // 5. Beri Konfirmasi ke Admin & Link Forward
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `✅ <b>DATA TERSIMPAN KE WEB!</b>\nItem: ${items[itemIndex].name}\n\nForward ke Pembeli:\n${sendLinks || "<i>(Tidak ada kontak valid terdeteksi)</i>"}`,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            });

        } catch (e) {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ chat_id: chatId, text: `❌ Gagal Simpan: ${e.message}` })
            });
        }
    }
  }

  return res.status(200).send('OK');
}
