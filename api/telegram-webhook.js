import admin from 'firebase-admin';

// --- CONFIG ---
const MAX_MSG_AGE = 60; // Batas toleransi pesan 60 detik

// --- 1. FIREBASE INIT (MODEL RINGAN) ---
// Inisialisasi di luar handler agar Vercel me-reuse koneksi (Lebih Cepat)
if (!admin.apps.length) {
    try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (raw) {
            const serviceAccount = JSON.parse(raw);
            if (serviceAccount.private_key) {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("🔥 DB Ready (Lite Mode)");
        }
    } catch (e) {
        console.error("DB Init Error:", e.message);
    }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- 2. HELPER SIMPEL ---
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');

// Fungsi kirim pesan tanpa menunggu respon (Fire & Forget) agar bot terasa cepat
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

    // Fast return jika DB mati
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

            // 1. Matikan loading icon di HP admin secepat mungkin
            sendTele('answerCallbackQuery', token, { callback_query_id: cb.id });

            // 2. MENU UTAMA (Cek Orderan)
            if (action === 'MENU_PENDING' || action === 'MAIN_MENU') {
                // Ambil orderan yg statusnya belum selesai
                const snaps = await db.collection('orders')
                    .where('status', 'in', ['manual_verification', 'manual_pending', 'processing'])
                    .orderBy('date', 'desc')
                    .limit(8) 
                    .get();

                if (snaps.empty) {
                    sendTele('editMessageText', token, {
                        chat_id: chatId, message_id: msgId, text: "✅ <b>Aman! Tidak ada antrian.</b>", parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "MENU_PENDING" }]] }
                    });
                } else {
                    let keyboard = [];
                    snaps.forEach(doc => {
                        const o = doc.data();
                        let icon = "⏳";
                        if (o.status === 'manual_verification') icon = "💰"; // User sudah transfer
                        
                        const itemName = o.items && o.items[0] ? o.items[0].name.substring(0, 15) : "Item";
                        keyboard.push([{ text: `${icon} ${fmtRp(o.total)} | ${itemName}`, callback_data: `DETAIL|${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔄 Refresh", callback_data: "MENU_PENDING" }]);
                    
                    sendTele('editMessageText', token, {
                        chat_id: chatId, message_id: msgId, text: "🔥 <b>DAFTAR ORDER MASUK:</b>", parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    });
                }
            }

            // 3. DETAIL ORDER
            else if (action === 'DETAIL') {
                const oid = parts[1];
                const snap = await db.collection('orders').doc(oid).get();
                
                if (snap.exists) {
                    const o = snap.data();
                    const item = o.items[0];
                    const contact = item.note || "-";
                    
                    let txt = `🧾 <b>ORDER: ${oid}</b>\n📦 ${item.name}\n👤 Data: <code>${contact}</code>\n💰 ${fmtRp(o.total)}\nStatus: <b>${o.status}</b>`;
                    if (o.paymentMethod === 'MANUAL') txt += `\n⚠️ <i>Cek Mutasi Rekening Dulu!</i>`;

                    // Tombol Aksi
                    let kbd = [];
                    kbd.push([{ text: "✅ TERIMA & INPUT SN", callback_data: `ACC|${oid}` }]);
                    kbd.push([{ text: "❌ TOLAK", callback_data: `REJECT|${oid}` }]);
                    kbd.push([{ text: "🔙 Kembali", callback_data: "MENU_PENDING" }]);

                    sendTele('editMessageText', token, {
                        chat_id: chatId, message_id: msgId, text: txt, parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: kbd }
                    });
                } else {
                    sendTele('sendMessage', token, { chat_id: chatId, text: "❌ Data order hilang." });
                }
            }

            // 4. KLIK ACC (Minta Input SN)
            else if (action === 'ACC') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_SN', { oid: oid });
                
                // Hapus pesan menu lama agar bersih
                sendTele('deleteMessage', token, { chat_id: chatId, message_id: msgId });
                
                // Kirim pesan baru minta input
                sendTele('sendMessage', token, { 
                    chat_id: chatId, 
                    text: `✍️ <b>INPUT SN / KODE VOUCHER:</b>\n\nUntuk Order: <code>${oid}</code>\n\n<i>Ketik '-' jika produk otomatis/inject langsung.</i>`, 
                    parse_mode: 'HTML' 
                });
            }

            // 5. KLIK TOLAK
            else if (action === 'REJECT') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({ status: 'cancelled', adminMessage: "Dibatalkan Admin." });
                sendTele('editMessageText', token, {
                    chat_id: chatId, message_id: msgId, text: `❌ Order ${oid} Ditolak.`, parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: "🔙 Menu", callback_data: "MENU_PENDING" }]] }
                });
            }
        }

        // ==========================================
        //  BAGIAN B: INPUT TEKS (ADMIN KETIK SN)
        // ==========================================
        else if (body.message && body.message.text) {
            const msg = body.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            // Abaikan pesan lama (Anti Lag)
            if ((Date.now() / 1000) - msg.date > MAX_MSG_AGE) return res.status(200).send('OK');

            // Reset Command
            if (text === '/start' || text.toLowerCase() === 'batal') {
                await clearUserState(chatId);
                sendTele('sendMessage', token, {
                    chat_id: chatId, text: "🤖 <b>PANEL ADMIN READY</b>", parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: "⏳ Cek Orderan", callback_data: "MENU_PENDING" }]] }
                });
                return res.status(200).send('OK');
            }

            // Cek apakah Admin sedang dalam mode input SN
            const userState = await getUserState(chatId);
            
            if (userState && userState.state === 'WAITING_SN') {
                const oid = userState.data.oid;
                let finalSN = text;
                // Format agar App.jsx membacanya dengan benar
                let adminMsg = `SUKSES SN: ${text}`;

                if (text === '-') {
                    finalSN = "Processed";
                    adminMsg = "SUKSES: Pesanan telah diproses ke akun tujuan.";
                }

                // --- EKSEKUSI DATABASE (PENTING) ---
                await db.collection('orders').doc(oid).update({
                    status: 'paid',         // PENTING: Trigger warna hijau di web
                    sn: finalSN,            // Simpan SN murni
                    adminMessage: adminMsg, // Pesan untuk ditampilkan di web
                    completedAt: new Date().toISOString()
                });

                // Beri respon ke admin
                sendTele('sendMessage', token, { 
                    chat_id: chatId, 
                    text: `✅ <b>BERHASIL!</b>\nOrder <code>${oid}</code> sudah aktif.\nUser sudah bisa lihat kode.`, 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: "⏳ Cek Lainnya", callback_data: "MENU_PENDING" }]] }
                });

                await clearUserState(chatId);
            }
        }
    } catch (e) {
        console.error("Handler Error:", e);
    }

    // SELALU & LANGSUNG Return 200 agar Telegram tidak mengulang request (Loop)
    return res.status(200).send('OK');
}
