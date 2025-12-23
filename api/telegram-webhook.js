import admin from 'firebase-admin';

// --- CONFIG ---
const MAX_MSG_AGE = 120; // Abaikan pesan > 2 menit lalu (Hapus antrian nyangkut)

// --- INIT FIREBASE (OPTIMIZED) ---
if (!admin.apps.length) {
    try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (raw) {
            const serviceAccount = JSON.parse(raw);
            // Fix newline character yang sering rusak saat copy-paste ke Vercel Env
            if (serviceAccount.private_key) {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
    } catch (e) { console.error("Firebase Init Error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- HELPERS ---
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');

// Wrapper Fetch dengan Timeout (PENTING AGAR TIDAK HANG)
async function safeFetch(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return res;
    } catch (error) {
        clearTimeout(id);
        // Jangan throw error, cukup log saja agar flow utama lanjut
        console.log("Fetch Error/Timeout:", url); 
        return null; 
    }
}

async function reply(token, chatId, text) {
    await safeFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
}

async function editMenu(token, chatId, msgId, text, keyboard) {
    await safeFetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: keyboard }
        })
    });
}

async function deleteMsg(token, chatId, msgId) {
    await safeFetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: msgId })
    });
}

// --- STATE MANAGEMENT ---
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

// --- MAIN HANDLER ---
export default async function handler(req, res) {
    // 1. CEK DB
    if (!db) { console.error("DB Not Ready"); return res.status(200).send('DB Error'); }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const body = req.body;

    try {
        // --- A. HANDLE CALLBACK QUERY (TOMBOL) ---
        if (body.callback_query) {
            const callback = body.callback_query;
            const data = callback.data;
            const chatId = callback.message.chat.id;
            const msgId = callback.message.message_id;
            const parts = data.split('|');
            const action = parts[0];

            // Jawab callback agar loading stop
            safeFetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ callback_query_id: callback.id })
            });

            // MENU UTAMA
            if (action === 'MAIN_MENU') {
                const keyboard = [
                    [{ text: "⏳ Pesanan Masuk", callback_data: "MENU_PENDING" }],
                    [{ text: "📦 Produk", callback_data: "MENU_PRODUK" }, { text: "🔎 Cek TRX", callback_data: "ASK_TRACK" }]
                ];
                await editMenu(token, chatId, msgId, "🔥 <b>JISAESHIN ADMIN v2</b>\nSiap memproses data.", keyboard);
            }

            // MENU PENDING (Hanya ambil yg status processing/manual_verification)
            else if (action === 'MENU_PENDING') {
                const snaps = await db.collection('orders')
                    .where('status', 'in', ['processing', 'manual_verification', 'manual_pending'])
                    .limit(5).get();

                if (snaps.empty) {
                    await editMenu(token, chatId, msgId, "✅ <b>Semua Beres!</b> Tidak ada antrian.", [[{text:"🔙 Menu", callback_data:"MAIN_MENU"}]]);
                } else {
                    let keyboard = [];
                    snaps.forEach(doc => {
                        const o = doc.data();
                        const item = o.items ? o.items[0].name.substring(0, 15) : "Unknown";
                        // Tampilkan status dengan emoji biar admin cepat paham
                        let statIcon = "⏳";
                        if (o.status === 'manual_verification') statIcon = "💰"; // User klaim sudah bayar
                        keyboard.push([{ text: `${statIcon} ${fmtRp(o.total)} | ${item}`, callback_data: `ORDER_DETAIL|${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔙 Menu", callback_data: "MAIN_MENU" }]);
                    await editMenu(token, chatId, msgId, "⏳ <b>DAFTAR ANTRIAN:</b>", keyboard);
                }
            }

            // DETAIL ORDER
            else if (action === 'ORDER_DETAIL') {
                const oid = parts[1];
                const snap = await db.collection('orders').doc(oid).get();
                if (snap.exists) {
                    const o = snap.data();
                    const item = o.items[0];
                    const note = item.note || "-";
                    
                    let txt = `🧾 <b>ORDER: ${oid}</b>\n\n📦 <b>${item.name}</b>\n👤 Data: <code>${note}</code>\n💰 Total: ${fmtRp(o.total)}\nStatus: <b>${o.status}</b>`;
                    if (o.paymentMethod === 'MANUAL') txt += `\n\n⚠️ <i>Cek Mutasi Bank/E-Wallet Dulu!</i>`;

                    let keyboard = [];
                    // Tombol ACC hanya jika belum completed
                    if (o.status !== 'completed' && o.status !== 'cancelled' && o.status !== 'paid') {
                        keyboard.push([{ text: "✅ PROSES / KIRIM SN", callback_data: `ACC_ASK_DATA|${oid}` }]);
                        keyboard.push([{ text: "❌ TOLAK / BATALKAN", callback_data: `REJECT_ORDER|${oid}` }]);
                    }
                    keyboard.push([{ text: "🛡️ Balas Komplain", callback_data: `REPLY_COMPLAIN|${oid}` }]);
                    keyboard.push([{ text: "🔙 Kembali", callback_data: "MENU_PENDING" }]);

                    await editMenu(token, chatId, msgId, txt, keyboard);
                } else {
                    await reply(token, chatId, "Data order tidak ditemukan/sudah dihapus.");
                }
            }

            // AKSI ACC (Minta Input SN)
            else if (action === 'ACC_ASK_DATA') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_SN', { oid: oid });
                await reply(token, chatId, `✍️ <b>INPUT SN / KODE VOUCHER:</b>\nUntuk Order ID: <code>${oid}</code>\n\n<i>(Ketik '-' jika produk otomatis masuk/tanpa SN)</i>`);
                await deleteMsg(token, chatId, msgId);
            }

            // AKSI TOLAK
            else if (action === 'REJECT_ORDER') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({ status: 'cancelled', adminMessage: 'Pesanan dibatalkan admin (Stok/Gangguan).' });
                await reply(token, chatId, `❌ Order ${oid} Ditolak.`);
                await deleteMsg(token, chatId, msgId);
            }

             // AKSI BALAS KOMPLAIN
             else if (action === 'REPLY_COMPLAIN') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_COMPLAIN_REPLY', { oid: oid });
                await reply(token, chatId, `🛡️ <b>TULIS BALASAN KE USER:</b>\nUntuk Order: <code>${oid}</code>`);
                await deleteMsg(token, chatId, msgId);
            }
            
            // ... (Kode Menu Produk dll biarkan seperti semula/sesuai kebutuhan) ...
        }

        // --- B. HANDLE TEXT MESSAGE ---
        else if (body.message && body.message.text) {
            const msg = body.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            // ANTI LOOP: Cek umur pesan
            const now = Math.floor(Date.now() / 1000);
            if (now - msg.date > MAX_MSG_AGE) {
                return res.status(200).send('OK'); // Pesan basi, abaikan
            }

            // RESET COMMAND
            if (['/start', '/menu', 'batal'].includes(text.toLowerCase())) {
                await clearUserState(chatId);
                const keyboard = [[{ text: "⏳ Cek Orderan", callback_data: "MENU_PENDING" }]];
                await reply(token, chatId, "🤖 <b>ADMIN PANEL READY</b>", keyboard);
                return res.status(200).send('OK');
            }

            // STATE HANDLER
            const userState = await getUserState(chatId);
            if (userState) {
                const s = userState.state;
                const d = userState.data;

                // --- PROSES INPUT SN (SINKRONISASI KE APP.JSX) ---
                if (s === 'WAITING_SN') {
                    let finalSN = text;
                    let displayMsg = `SUKSES SN: ${text}`; // Format ini dikenali App.jsx (cleanSnMessage)

                    if (text === '-') {
                        finalSN = "Processed";
                        displayMsg = "SUKSES: Pesanan telah diproses masuk ke akun tujuan.";
                    }

                    // UPDATE DATABASE
                    // 1. Status 'paid' -> Agar muncul notif sukses "TRANSAKSI SUKSES"
                    // 2. adminMessage -> Berisi SN agar dirender fungsi renderContent()
                    // 3. sn -> Field backup
                    await db.collection('orders').doc(d.oid).update({
                        status: 'paid', // App.jsx mengecek status==='paid' utk menampilkan sukses
                        sn: finalSN,
                        adminMessage: displayMsg, 
                        completedAt: new Date().toISOString()
                    });

                    await reply(token, chatId, `✅ <b>BERHASIL DIKIRIM!</b>\nOrder ${d.oid} selesai.\nUser sudah bisa lihat kode di web.`);
                    await clearUserState(chatId);
                }

                // --- PROSES BALAS KOMPLAIN ---
                else if (s === 'WAITING_COMPLAIN_REPLY') {
                    await db.collection('orders').doc(d.oid).update({
                        complaintReply: text // Field ini dibaca App.jsx di kotak kuning
                    });
                    await reply(token, chatId, `✅ <b>Balasan Terkirim!</b>`);
                    await clearUserState(chatId);
                }
            }
        }
    } catch (e) {
        console.error("Webhook Logic Error:", e);
        // Tetap diam agar Telegram tidak retry
    } finally {
        // SELALU RETURN 200 DI AKHIR
        return res.status(200).send('OK');
    }
}
