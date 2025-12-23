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
  const baseUrl = "https://" + req.headers.host; 

  if (!db) return res.status(500).send("DB Error");

  // ============================================================
  // 1. HANDLE KLIK TOMBOL (CALLBACK QUERY)
  // ============================================================
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    // Format Data: ACTION|ORDER_ID|EXTRA|INDEX
    const parts = data.split('|');
    const action = parts[0];
    const orderId = parts[1];
    const extra = parts[2]; // Bisa Kontak atau Index
    const indexParam = parts[3]; // Opsional (Index Item)

    // --- SKENARIO 1: ADMIN KLIK "ACC" (MANUAL) ---
    if (action === 'ACC') {
        const buyerContact = extra; 
        const orderRef = db.collection('orders').doc(orderId);
        const docSnap = await orderRef.get();
        
        if(docSnap.exists) {
            await orderRef.update({ status: 'paid' });
            const items = docSnap.data().items;

            // Trigger Notify lagi untuk memunculkan tombol Input
            await fetch(`${baseUrl}/api/telegram-notify`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    orderId: orderId,
                    total: docSnap.data().total,
                    items: items,
                    buyerContact: buyerContact,
                    type: 'paid_trigger' 
                })
            });

            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            });
        }
    }

    // --- SKENARIO 2: ADMIN KLIK "ISI ITEM" (NORMAL) ---
    else if (action === 'INPUT') {
        const itemIndex = parseInt(extra); // Di tombol INPUT, parameter ke-3 adalah Index
        const docSnap = await db.collection('orders').doc(orderId).get();
        const itemName = docSnap.exists ? docSnap.data().items[itemIndex].name : "Item";

        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                // PENTING: Teks pancingan mengandung kata "INPUT DATA"
                text: `✍️ <b>INPUT DATA KONTEN</b>\n\nProduk: <b>${itemName}</b>\nOrder: <code>${orderId}</code>\nIndex: ${itemIndex}\n\n<i>Silahkan Reply/Paste data (Email/Pass/Kode) untuk item ini:</i>`,
                parse_mode: 'HTML',
                reply_markup: {
                    force_reply: true,
                    input_field_placeholder: `Data untuk ${itemName}...`
                }
            })
        });
    }

    // --- SKENARIO 3: ADMIN KLIK "BALAS KOMPLAIN" (BARU) ---
    else if (action === 'COMPLAIN') {
        // Cek apakah komplain ini spesifik item (ada index) atau global
        const itemIdx = indexParam ? parseInt(indexParam) : null;
        const label = itemIdx !== null ? `ITEM #${itemIdx+1}` : "UMUM";

        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                // PENTING: Teks pancingan mengandung kata "BALAS KOMPLAIN"
                text: `🛡️ <b>BALAS KOMPLAIN (${label})</b>\n\nOrder: <code>${orderId}</code>\nIndex: ${itemIdx !== null ? itemIdx : '-'}\n\n<i>Silahkan ketik solusi atau pesan balasan untuk pembeli:</i>`,
                parse_mode: 'HTML',
                reply_markup: {
                    force_reply: true,
                    input_field_placeholder: `Solusi komplain...`
                }
            })
        });
    }

    // Tutup loading jam pasir
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id })
    });
  }

  // ============================================================
  // 2. HANDLE BALASAN ADMIN (TEXT REPLY)
  // ============================================================
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyOrigin = msg.reply_to_message.text; // Teks Pancingan Bot
    const adminContent = msg.text;
    const chatId = msg.chat.id;

    // Parsing ID dan Index
    const orderIdMatch = replyOrigin.match(/Order: ([^\s\n]+)/);
    const indexMatch = replyOrigin.match(/Index: (\d+|-)/);

    const orderId = orderIdMatch ? orderIdMatch[1] : null;
    let itemIndex = (indexMatch && indexMatch[1] !== '-') ? parseInt(indexMatch[1]) : null;

    if (orderId && adminContent) {
        try {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await orderRef.get();
            if (!doc.exists) throw new Error("Order tidak ditemukan");

            let items = doc.data().items || [];
            let updateData = {};
            let replyTitle = "";

            // --- CEK TIPE BALASAN: APAKAH INI KOMPLAIN ATAU INPUT DATA? ---
            const isComplaintReply = replyOrigin.includes("BALAS KOMPLAIN");

            if (isComplaintReply) {
                // >>> LOGIKA BALAS KOMPLAIN <<<
                replyTitle = "SOLUSI KOMPLAIN";
                
                // Jika komplain spesifik item (Index ada), simpan di Note item tersebut
                if (itemIndex !== null && items[itemIndex]) {
                    const oldNote = items[itemIndex].note || "";
                    items[itemIndex].note = `[ADMIN]: ${adminContent} | ${oldNote}`;
                    updateData = { items: items };
                } else {
                    // Jika komplain umum (Index '-'), simpan di field complaintReply global
                    updateData = { complaintReply: adminContent };
                }

            } else {
                // >>> LOGIKA INPUT DATA NORMAL (INPUT KONTEN) <<<
                replyTitle = "DATA TERSIMPAN";
                if (itemIndex !== null && items[itemIndex]) {
                    items[itemIndex].data = [adminContent];
                    items[itemIndex].isManual = false; // Matikan status manual agar muncul di web
                    items[itemIndex].note = "✅ Data Terkirim";
                    updateData = { items: items, status: 'paid' };
                }
            }

            // EKSEKUSI UPDATE KE FIREBASE
            await orderRef.update(updateData);

            // KONFIRMASI KE ADMIN
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `✅ <b>${replyTitle} BERHASIL!</b>\nOrder: ${orderId}\n\nPesan: "${adminContent}"\n\n<i>Sudah muncul di web pembeli.</i>`,
                    parse_mode: 'HTML'
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
