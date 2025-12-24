import admin from 'firebase-admin';

// --- CONFIG ---
const MAX_MSG_AGE = 60; // 60 Detik toleransi

// --- 1. FIREBASE INIT ---
if (!admin.apps.length) {
    try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (raw) {
            const serviceAccount = JSON.parse(raw);
            if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log("🔥 DB Ready (Multi-Item Mode)");
        }
    } catch (e) { console.error("DB Error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- 2. HELPERS ---
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');
const sendTele = (method, token, data) => {
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch(e => console.error("Tele Error:", e.message));
};

// --- 3. STATE MANAGEMENT ---
async function setUserState(chatId, state, data = {}) {
    if (!db) return;
    await db.collection('bot_states').doc(String(chatId)).set({ state, data, timestamp: new Date() });
}
async function getUserState(chatId) {
    if (!db) return null;
    const doc = await db.collection('bot_states').doc(String(chatId)).get();
    return doc.exists ? doc.data() : null;
}
async function clearUserState(chatId) {
    if (!db) return;
    await db.collection('bot_states').doc(String(chatId)).delete();
}

// --- 4. MAIN HANDLER ---
export default async function handler(req, res) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!db) return res.status(200).send('DB Error');

    const body = req.body;

    try {
        // ==========================================
        //  BAGIAN A: TOMBOL (CALLBACK)
        // ==========================================
        if (body.callback_query) {
            const cb = body.callback_query;
            const chatId = cb.message.chat.id;
            const msgId = cb.message.message_id;
            const data = cb.data;
            const parts = data.split('|');
            const action = parts[0];

            sendTele('answerCallbackQuery', token, { callback_query_id: cb.id });

            // 1. MENU UTAMA / REFRESH
            if (action === 'MENU_PENDING' || action === 'MAIN_MENU') {
                const snaps = await db.collection('orders')
                    .where('status', 'in', ['manual_verification', 'manual_pending', 'processing'])
                    .orderBy('date', 'desc').limit(8).get();

                if (snaps.empty) {
                    sendTele('editMessageText', token, {
                        chat_id: chatId, message_id: msgId, text: "✅ <b>Aman! Tidak ada antrian.</b>", parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "MENU_PENDING" }]] }
                    });
                } else {
                    let keyboard = [];
                    snaps.forEach(doc => {
                        const o = doc.data();
                        let icon = o.status === 'manual_verification' ? "💰" : "⏳";
                        // Hitung jumlah item
                        const count = o.items ? o.items.length : 0;
                        const itemName = o.items && o.items[0] ? o.items[0].name.substring(0, 10) : "Item";
                        keyboard.push([{ text: `${icon} ${fmtRp(o.total)} | ${count}x ${itemName}...`, callback_data: `DETAIL|${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔄 Refresh", callback_data: "MENU_PENDING" }]);
                    
                    sendTele('editMessageText', token, {
                        chat_id: chatId, message_id: msgId, text: "🔥 <b>ANTRIAN ORDER:</b>", parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    });
                }
            }

            // 2. DETAIL ORDER
            else if (action === 'DETAIL') {
                const oid = parts[1];
                const snap = await db.collection('orders').doc(oid).get();
                if (snap.exists) {
                    const o = snap.data();
                    let itemsTxt = "";
                    o.items.forEach((it, idx) => {
                        itemsTxt += `\n${idx+1}. <b>${it.name}</b>\n   Data: <code>${it.note || '-'}</code>`;
                    });

                    let txt = `🧾 <b>ORDER: ${oid}</b>${itemsTxt}\n\n💰 Total: ${fmtRp(o.total)}\nStatus: <b>${o.status}</b>`;
                    if (o.paymentMethod === 'MANUAL') txt += `\n⚠️ <i>Cek Mutasi Dulu!</i>`;

                    let kbd = [
                        [{ text: "✅ PROSES (INPUT SATU-SATU)", callback_data: `START_PROCESS|${oid}` }],
                        [{ text: "❌ TOLAK", callback_data: `REJECT|${oid}` }],
                        [{ text: "🔙 Kembali", callback_data: "MENU_PENDING" }]
                    ];

                    sendTele('editMessageText', token, {
                        chat_id: chatId, message_id: msgId, text: txt, parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: kbd }
                    });
                }
            }

            // 3. MULAI PROSES INPUT (INIT LOOP)
            else if (action === 'START_PROCESS') {
                const oid = parts[1];
                const snap = await db.collection('orders').doc(oid).get();
                
                if(snap.exists) {
                    const o = snap.data();
                    const items = o.items || [];
                    
                    if(items.length === 0) {
                        sendTele('sendMessage', token, { chat_id: chatId, text: "❌ Error: Item kosong." });
                        return;
                    }

                    // Simpan state awal: Index 0 (Item pertama)
                    await setUserState(chatId, 'PROCESSING_ITEMS', { 
                        oid: oid, 
                        items: items, // Simpan array item ke state sementara
                        idx: 0,       // Mulai dari index 0
                        total: items.length
                    });

                    sendTele('deleteMessage', token, { chat_id: chatId, message_id: msgId });
                    
                    // Minta input item pertama
                    const firstItem = items[0];
                    sendTele('sendMessage', token, { 
                        chat_id: chatId, 
                        text: `✍️ <b>INPUT SN / KODE (1/${items.length}):</b>\n\nProduk: <b>${firstItem.name}</b>\nData User: <code>${firstItem.note}</code>\n\n<i>Ketik '-' jika otomatis.</i>`, 
                        parse_mode: 'HTML' 
                    });
                }
            }

            // 4. TOLAK
            else if (action === 'REJECT') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({ status: 'cancelled' });
                sendTele('editMessageText', token, {
                    chat_id: chatId, message_id: msgId, text: `❌ Order ${oid} Dibatalkan.`, parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Menu", callback_data: "MENU_PENDING" }]] }
                });
            }
        }

        // ==========================================
        //  BAGIAN B: INPUT TEKS (LOOPING ITEM)
        // ==========================================
        else if (body.message && body.message.text) {
            const msg = body.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            if ((Date.now() / 1000) - msg.date > MAX_MSG_AGE) return res.status(200).send('OK');

            if (text === '/start' || text.toLowerCase() === 'batal') {
                await clearUserState(chatId);
                sendTele('sendMessage', token, {
                    chat_id: chatId, text: "🤖 <b>RESET.</b>", parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: "⏳ Cek Orderan", callback_data: "MENU_PENDING" }]] }
                });
                return res.status(200).send('OK');
            }

            // CEK STATE
            const userState = await getUserState(chatId);
            
            // --- LOGIKA UTAMA LOOPING ---
            if (userState && userState.state === 'PROCESSING_ITEMS') {
                let { oid, items, idx, total } = userState.data;

                // 1. Simpan input ke Item saat ini
                let snValue = text;
                if(text === '-') snValue = "Processed Automatically";
                
                // Update array item di memory sementara
                // Di App.jsx, data ditampilkan dari field 'data' (array)
                if(!items[idx].data) items[idx].data = [];
                items[idx].data.push(snValue);
                
                // Tambahkan note juga biar admin gampang lihat di DB
                items[idx].adminNote = snValue; 

                // 2. Cek apakah masih ada item selanjutnya?
                const nextIdx = idx + 1;

                if (nextIdx < total) {
                    // MASIH ADA SISA -> Update State & Minta Input Lagi
                    await setUserState(chatId, 'PROCESSING_ITEMS', { oid, items, idx: nextIdx, total });
                    
                    const nextItem = items[nextIdx];
                    sendTele('sendMessage', token, { 
                        chat_id: chatId, 
                        text: `✅ Tersimpan.\n\n✍️ <b>INPUT SN / KODE (${nextIdx + 1}/${total}):</b>\n\nProduk: <b>${nextItem.name}</b>\nData User: <code>${nextItem.note}</code>`, 
                        parse_mode: 'HTML' 
                    });

                } else {
                    // SUDAH SELESAI SEMUA -> Update Database Sekaligus
                    let adminMsgDisplay = "✅ Order Completed";
                    if(total === 1) adminMsgDisplay = `SUKSES SN: ${text}`; // Format single item
                    else adminMsgDisplay = "✅ Semua Item Terkirim (Cek Rincian)";

                    await db.collection('orders').doc(oid).update({
                        status: 'paid',         // PENTING: Hijaukan status
                        items: items,           // Simpan semua item yang sudah diisi SN
                        adminMessage: adminMsgDisplay,
                        completedAt: new Date().toISOString()
                    });

                    sendTele('sendMessage', token, { 
                        chat_id: chatId, 
                        text: `🎉 <b>SELESAI!</b>\nSemua (${total}) item telah diproses.\nOrder <code>${oid}</code> status PAID.`, 
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: "⏳ Cek Lainnya", callback_data: "MENU_PENDING" }]] }
                    });

                    await clearUserState(chatId);
                }
            }
        }
    } catch (e) { console.error("Err:", e); }

    return res.status(200).send('OK');
}
