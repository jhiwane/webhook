import admin from 'firebase-admin';

// --- CONFIGURATION ---
const MAX_MSG_AGE = 120; // Abaikan pesan > 2 menit (Cegah loop saat restart)
const FETCH_TIMEOUT = 8000; // 8 Detik timeout (Agar Vercel tidak kill process)

// --- 1. FIREBASE INITIALIZATION (SINGLETON PATTERN) ---
if (!admin.apps.length) {
    try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (raw) {
            const serviceAccount = JSON.parse(raw);
            if (serviceAccount.private_key) {
                // Fix newline error pada Environment Variable Vercel
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("🔥 Firebase Initialized");
        }
    } catch (e) {
        console.error("❌ Firebase Init Error:", e.message);
    }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- 2. NETWORK HELPERS (ANTI-CRASH) ---
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');

// Wrapper Fetch dengan AbortController untuk mencegah Hanging
async function safeFetch(url, options) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return res;
    } catch (error) {
        clearTimeout(id);
        console.error(`⚠️ Network/Timeout Error (${url}):`, error.message);
        return null; // Return null, jangan throw error agar bot tetap hidup
    }
}

async function apiCall(method, token, payload) {
    return await safeFetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

// Shortcut functions
const reply = (token, chatId, text) => apiCall('sendMessage', token, { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
const editMenu = (token, chatId, msgId, text, keyboard) => apiCall('editMessageText', token, { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
const replyMenu = (token, chatId, text, keyboard) => apiCall('sendMessage', token, { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
const deleteMsg = (token, chatId, msgId) => apiCall('deleteMessage', token, { chat_id: chatId, message_id: msgId });
const answerCallback = (token, id) => apiCall('answerCallbackQuery', token, { callback_query_id: id });

// --- 3. STATE MANAGEMENT (SESSION) ---
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
    // A. CEK KESEHATAN DB
    if (!db) {
        console.error("❌ DB Not Connected");
        return res.status(200).send('DB Error'); // Tetap 200 agar Tele tidak retry
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const body = req.body;

    try {
        // ==========================================
        //  BAGIAN 1: HANDLE TOMBOL (CALLBACK QUERY)
        // ==========================================
        if (body.callback_query) {
            const cb = body.callback_query;
            const data = cb.data;
            const chatId = cb.message.chat.id;
            const msgId = cb.message.message_id;
            const parts = data.split('|');
            const action = parts[0];

            // Stop loading indicator di Telegram user
            await answerCallback(token, cb.id);

            // 1. MENU UTAMA
            if (action === 'MAIN_MENU') {
                const keyboard = [
                    [{ text: "⏳ Order Masuk", callback_data: "MENU_PENDING" }, { text: "📦 Produk & Stok", callback_data: "MENU_PRODUK" }],
                    [{ text: "🔎 Lacak TRX", callback_data: "ASK_TRACK" }, { text: "📜 Riwayat Filter", callback_data: "MENU_HISTORY_FILTER" }]
                ];
                await editMenu(token, chatId, msgId, "🔥 <b>PANEL ADMIN V3.5 (ULTIMATE)</b>\nSistem siap. Silakan pilih menu:", keyboard);
            }

            // 2. MENU PENDING (Hanya menampilkan yang butuh tindakan)
            else if (action === 'MENU_PENDING') {
                const snaps = await db.collection('orders')
                    .where('status', 'in', ['manual_verification', 'manual_pending', 'processing', 'manual_check'])
                    .limit(5).get();

                if (snaps.empty) {
                    await editMenu(token, chatId, msgId, "✅ <b>Aman! Tidak ada antrian pending.</b>", [[{ text: "🔙 Menu Utama", callback_data: "MAIN_MENU" }]]);
                } else {
                    let keyboard = [];
                    snaps.forEach(doc => {
                        const o = doc.data();
                        let icon = "⏳";
                        if (o.status === 'manual_verification') icon = "💰"; // User klaim sudah transfer
                        else if (o.status === 'processing') icon = "⚡"; // Midtrans masuk
                        keyboard.push([{ text: `${icon} ${fmtRp(o.total)} | ${o.items[0].name.substring(0, 15)}...`, callback_data: `ORDER_DETAIL|${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔄 Refresh", callback_data: "MENU_PENDING" }, { text: "🔙 Menu", callback_data: "MAIN_MENU" }]);
                    await editMenu(token, chatId, msgId, "⏳ <b>DAFTAR ANTRIAN ORDER:</b>", keyboard);
                }
            }

            // 3. DETAIL ORDER & EKSEKUSI
            else if (action === 'ORDER_DETAIL') {
                const oid = parts[1];
                const snap = await db.collection('orders').doc(oid).get();
                if (snap.exists) {
                    const o = snap.data();
                    const item = o.items[0];
                    const contact = item.note || "No Data";
                    let txt = `🧾 <b>ORDER: ${oid}</b>\n📦 Item: <b>${item.name}</b>\n👤 Data: <code>${contact}</code>\n💰 Total: ${fmtRp(o.total)}\n📊 Status: <b>${o.status}</b>`;

                    if (o.paymentMethod === 'MANUAL') txt += `\n⚠️ <i>Cek Mutasi Rekening sebelum ACC!</i>`;

                    let keyboard = [];
                    // Tombol ACC/Tolak hanya jika belum selesai
                    if (!['completed', 'paid', 'cancelled'].includes(o.status)) {
                        keyboard.push([{ text: "✅ PROSES / KIRIM SN", callback_data: `ACC_ASK_DATA|${oid}` }]);
                        keyboard.push([{ text: "❌ TOLAK", callback_data: `REJECT_ORDER|${oid}` }]);
                    }
                    keyboard.push([{ text: "🛡️ Balas Komplain", callback_data: `REPLY_COMPLAIN|${oid}` }]);
                    keyboard.push([{ text: "🔙 Kembali", callback_data: "MENU_PENDING" }]);

                    await editMenu(token, chatId, msgId, txt, keyboard);
                } else {
                    await reply(token, chatId, "❌ Data order tidak ditemukan (mungkin dihapus).");
                }
            }

            // 4. LOGIC ACC (PERSIAPAN INPUT SN)
            else if (action === 'ACC_ASK_DATA') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_SN', { oid: oid });
                await reply(token, chatId, `✍️ <b>INPUT SN / KODE VOUCHER:</b>\n\nTarget Order: <code>${oid}</code>\n\n<i>Ketik '-' jika produk otomatis masuk (injeksi) atau tanpa SN.</i>`);
                await deleteMsg(token, chatId, msgId);
            }

            // 5. LOGIC TOLAK
            else if (action === 'REJECT_ORDER') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({
                    status: 'cancelled',
                    adminMessage: "Dibatalkan Admin: Stok kosong atau pembayaran tidak valid."
                });
                await reply(token, chatId, `❌ Order ${oid} berhasil DITOLAK.`);
                await deleteMsg(token, chatId, msgId);
            }

            // 6. LOGIC KOMPLAIN
            else if (action === 'REPLY_COMPLAIN') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_COMPLAIN_REPLY', { oid: oid });
                await reply(token, chatId, `🛡️ <b>BALAS PESAN USER:</b>\nKetik pesan solusi yang akan muncul di web user:`);
                await deleteMsg(token, chatId, msgId);
            }

            // 7. MANAJEMEN PRODUK
            else if (action === 'MENU_PRODUK') {
                const snaps = await db.collection('products').limit(10).get(); // Limit 10 agar ringan
                let keyboard = [];
                snaps.forEach(doc => {
                    const p = doc.data();
                    keyboard.push([{ text: `${p.name} (${fmtRp(p.price)})`, callback_data: `VIEW_PROD|${doc.id}` }]);
                });
                keyboard.push([{ text: "➕ Produk Baru", callback_data: "START_WIZARD" }, { text: "🔍 Cari Manual", callback_data: "ASK_SEARCH_PROD" }]);
                keyboard.push([{ text: "🔙 Menu Utama", callback_data: "MAIN_MENU" }]);
                await editMenu(token, chatId, msgId, "📦 <b>MANAJEMEN PRODUK:</b>\nPilih produk untuk edit stok/harga:", keyboard);
            }

            else if (action === 'VIEW_PROD') {
                const pid = parts[1];
                const doc = await db.collection('products').doc(pid).get();
                if (doc.exists) {
                    const p = doc.data();
                    const stock = p.variations?.length > 0
                        ? `Variasi: ${p.variations.length} Jenis`
                        : `Stok Utama: ${p.items?.length || 0}`;

                    const info = `📦 <b>${p.name}</b>\n💰 ${fmtRp(p.price)}\n📊 ${stock}\n📂 Kategori: ${p.category}`;
                    const keyboard = [
                        [{ text: "➕ Tambah Stok", callback_data: `ADD_STOCK_SELECT|${pid}` }, { text: "💰 Ubah Harga", callback_data: `EDIT_PRICE|${pid}` }],
                        [{ text: "🖼 Ganti Gambar", callback_data: `EDIT_IMG|${pid}` }, { text: "📝 Deskripsi", callback_data: `EDIT_DESC|${pid}` }],
                        [{ text: "❌ HAPUS PRODUK", callback_data: `CONFIRM_DEL|${pid}` }, { text: "🔙 List", callback_data: "MENU_PRODUK" }]
                    ];
                    await editMenu(token, chatId, msgId, info, keyboard);
                }
            }

            // Sub-Menu Produk: Pilih Stok (Varian/Utama)
            else if (action === 'ADD_STOCK_SELECT') {
                const pid = parts[1];
                const doc = await db.collection('products').doc(pid).get();
                const p = doc.data();
                let keyboard = [];
                if (p.variations?.length > 0) {
                    p.variations.forEach((v, idx) => {
                        keyboard.push([{ text: `Varian: ${v.name}`, callback_data: `INPUT_STOCK|${pid}|VAR|${idx}` }]);
                    });
                } else {
                    keyboard.push([{ text: "Stok Utama", callback_data: `INPUT_STOCK|${pid}|MAIN|0` }]);
                }
                keyboard.push([{ text: "🔙 Batal", callback_data: `VIEW_PROD|${pid}` }]);
                await editMenu(token, chatId, msgId, "➕ <b>Pilih Target Stok:</b>", keyboard);
            }

            else if (action === 'CONFIRM_DEL') {
                const pid = parts[1];
                const keyboard = [[{ text: "✅ YA, HAPUS", callback_data: `EXEC_DEL|${pid}` }], [{ text: "🔙 BATAL", callback_data: `VIEW_PROD|${pid}` }]];
                await editMenu(token, chatId, msgId, "⚠️ <b>PERINGATAN!</b>\nProduk akan dihapus permanen. Lanjut?", keyboard);
            }
            else if (action === 'EXEC_DEL') {
                const pid = parts[1];
                await db.collection('products').doc(pid).delete();
                await editMenu(token, chatId, msgId, "🗑️ Produk berhasil dihapus.", [[{ text: "🔙 Menu Produk", callback_data: "MENU_PRODUK" }]]);
            }

            // 8. MENU HISTORY FILTER (BARU!)
            else if (action === 'MENU_HISTORY_FILTER') {
                const keyboard = [
                    [{ text: "✅ Sukses (10 Terakhir)", callback_data: "HIST_SHOW|paid" }],
                    [{ text: "❌ Gagal/Batal", callback_data: "HIST_SHOW|cancelled" }, { text: "📅 Hari Ini", callback_data: "HIST_SHOW|today" }],
                    [{ text: "🔙 Menu Utama", callback_data: "MAIN_MENU" }]
                ];
                await editMenu(token, chatId, msgId, "📜 <b>FILTER RIWAYAT TRANSAKSI:</b>\nPilih kategori riwayat yang ingin dilihat:", keyboard);
            }

            else if (action === 'HIST_SHOW') {
                const filterType = parts[1];
                let query = db.collection('orders').orderBy('date', 'desc').limit(10);

                if (filterType === 'paid') query = query.where('status', 'in', ['paid', 'completed']);
                else if (filterType === 'cancelled') query = query.where('status', 'in', ['cancelled', 'failed', 'expired']);
                // Note: Filter 'today' butuh logic date range yg kompleks di firestore, kita handle simple limit 10 aja untuk 'today' lalu filter manual di array kalau mau, tapi disini kita tampilkan raw latest 10 dulu biar cepat.

                const snaps = await query.get();
                let msg = `📜 <b>RIWAYAT (${filterType.toUpperCase()}):</b>\n\n`;
                if (snaps.empty) msg += "<i>Belum ada data.</i>";

                snaps.forEach(doc => {
                    const o = doc.data();
                    const statusIcon = o.status === 'paid' || o.status === 'completed' ? '✅' : '❌';
                    // Cek tanggal untuk filter 'today' manual sederhana
                    if (filterType === 'today') {
                        const d = new Date(o.date);
                        const now = new Date();
                        if (d.getDate() !== now.getDate()) return; // Skip jika bukan hari ini
                    }
                    msg += `${statusIcon} <code>/trx ${doc.id}</code>\n   ${fmtRp(o.total)}\n`;
                });

                await editMenu(token, chatId, msgId, msg, [[{ text: "🔙 Filter", callback_data: "MENU_HISTORY_FILTER" }]]);
            }

            // 9. TRIGGER INPUT LAINNYA
            else if (action === 'START_WIZARD') { await setUserState(chatId, 'WIZARD_NAME', {}); await reply(token, chatId, "1️⃣ Masukkan <b>NAMA PRODUK</b>:"); await deleteMsg(token, chatId, msgId); }
            else if (action === 'ASK_TRACK') { await setUserState(chatId, 'WAITING_TRACK'); await reply(token, chatId, "🔎 Masukkan <b>ID ORDER</b> (TRX-...):"); await deleteMsg(token, chatId, msgId); }
            else if (action === 'ASK_SEARCH_PROD') { await setUserState(chatId, 'WAITING_SEARCH'); await reply(token, chatId, "🔍 Ketik Nama Produk:"); await deleteMsg(token, chatId, msgId); }
            else if (action === 'INPUT_STOCK') { await setUserState(chatId, 'WAITING_STOCK_DATA', { pid: parts[1], type: parts[2], idx: parseInt(parts[3]) }); await reply(token, chatId, "📦 Kirim Data Stok (Pisahkan baris/koma):"); await deleteMsg(token, chatId, msgId); }
            else if (action === 'EDIT_PRICE') { await setUserState(chatId, 'WAITING_PRICE', { pid: parts[1] }); await reply(token, chatId, "💰 Kirim Harga Baru (Angka):"); await deleteMsg(token, chatId, msgId); }
            else if (action === 'EDIT_DESC') { await setUserState(chatId, 'WAITING_DESC', { pid: parts[1] }); await reply(token, chatId, "📝 Kirim Deskripsi Baru:"); await deleteMsg(token, chatId, msgId); }
            else if (action === 'EDIT_IMG') { await setUserState(chatId, 'WAITING_IMG_URL', { pid: parts[1] }); await reply(token, chatId, "🖼 Kirim URL Gambar Baru:"); await deleteMsg(token, chatId, msgId); }

        }

        // ==========================================
        //  BAGIAN 2: HANDLE PESAN TEKS (INPUT USER)
        // ==========================================
        else if (body.message && body.message.text) {
            const msg = body.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            // 1. Filter Pesan Lama (Anti Loop)
            if ((Date.now() / 1000) - msg.date > MAX_MSG_AGE) {
                return res.status(200).send('OK');
            }

            // 2. Global Cancel/Reset Command
            if (['/start', '/menu', 'batal', 'cancel'].includes(text.toLowerCase())) {
                await clearUserState(chatId);
                const keyboard = [[{ text: "⏳ Cek Orderan", callback_data: "MENU_PENDING" }]];
                await replyMenu(token, chatId, "🤖 <b>ADMIN PANEL READY.</b>", keyboard);
                return res.status(200).send('OK');
            }

            // 3. Shortcut Cek TRX (/trx ID)
            if (text.toLowerCase().startsWith('/trx')) {
                const oid = text.replace(/\/trx/i, '').trim();
                const snap = await db.collection('orders').doc(oid).get();
                if (snap.exists) {
                    const o = snap.data();
                    await reply(token, chatId, `🧾 <b>${oid}</b>\nStatus: ${o.status}\nTotal: ${fmtRp(o.total)}`);
                } else {
                    await reply(token, chatId, "❌ ID tidak ditemukan.");
                }
                return res.status(200).send('OK');
            }

            // 4. State Machine (Memproses Input berdasarkan State)
            const userState = await getUserState(chatId);
            if (userState) {
                const s = userState.state;
                const d = userState.data;

                // --- LOGIC ACC SINKRON DENGAN APP.JSX ---
                if (s === 'WAITING_SN') {
                    let finalSN = text;
                    // Format khusus agar App.jsx membacanya bersih
                    let adminMsg = `SUKSES SN: ${text}`;

                    if (text === '-') {
                        finalSN = "Processed";
                        adminMsg = "SUKSES: Pesanan telah diproses otomatis ke akun tujuan.";
                    }

                    // UPDATE DB
                    await db.collection('orders').doc(d.oid).update({
                        status: 'paid',         // PENTING: Ubah ke paid/completed
                        sn: finalSN,            // Simpan SN murni
                        adminMessage: adminMsg, // Simpan pesan display
                        completedAt: new Date().toISOString()
                    });

                    await reply(token, chatId, `✅ <b>BERHASIL DI-ACC!</b>\nOrder <code>${d.oid}</code> selesai.\nSN terkirim ke web user.`);
                    await clearUserState(chatId);
                }

                // --- LOGIC BALAS KOMPLAIN ---
                else if (s === 'WAITING_COMPLAIN_REPLY') {
                    await db.collection('orders').doc(d.oid).update({ complaintReply: text });
                    await reply(token, chatId, `✅ Balasan terkirim ke Dashboard User.`);
                    await clearUserState(chatId);
                }

                // --- LOGIC TAMBAH STOK ---
                else if (s === 'WAITING_STOCK_DATA') {
                    const newItems = text.split(/\n|,/).map(x => x.trim()).filter(x => x);
                    const docRef = db.collection('products').doc(d.pid);
                    const docSnap = await docRef.get();
                    if (docSnap.exists) {
                        const p = docSnap.data();
                        if (d.type === 'VAR') {
                            const vars = [...p.variations];
                            vars[d.idx].items = [...(vars[d.idx].items || []), ...newItems];
                            await docRef.update({ variations: vars });
                        } else {
                            await docRef.update({ items: [...(p.items || []), ...newItems] });
                        }
                        await reply(token, chatId, `✅ <b>${newItems.length} Stok</b> berhasil ditambahkan.`);
                    }
                    await clearUserState(chatId);
                }

                // --- LOGIC TRACKING ---
                else if (s === 'WAITING_TRACK') {
                    const snap = await db.collection('orders').doc(text).get();
                    if (snap.exists) {
                        const o = snap.data();
                        await reply(token, chatId, `🧾 <b>Order Ditemukan:</b>\nID: ${text}\nStatus: ${o.status}\nTotal: ${fmtRp(o.total)}`);
                    } else {
                        await reply(token, chatId, "❌ ID tidak valid.");
                    }
                    await clearUserState(chatId);
                }

                // --- LOGIC EDIT LAINNYA ---
                else if (s === 'WAITING_PRICE') {
                    const pr = parseInt(text.replace(/\D/g, '')) || 0;
                    await db.collection('products').doc(d.pid).update({ price: pr });
                    await reply(token, chatId, "✅ Harga Updated.");
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_DESC') {
                    await db.collection('products').doc(d.pid).update({ description: text, longDescription: text });
                    await reply(token, chatId, "✅ Deskripsi Updated.");
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_IMG_URL') {
                    await db.collection('products').doc(d.pid).update({ image: text });
                    await reply(token, chatId, "✅ Gambar Updated.");
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_SEARCH') {
                    const snaps = await db.collection('products').get();
                    let found = [];
                    snaps.forEach(doc => {
                        const p = doc.data();
                        if (p.name.toLowerCase().includes(text.toLowerCase())) {
                            found.push([{ text: `${p.name}`, callback_data: `VIEW_PROD|${doc.id}` }]);
                        }
                    });
                    if (found.length > 0) {
                        found.push([{ text: "🔙 Menu", callback_data: "MENU_PRODUK" }]);
                        await replyMenu(token, chatId, `🔍 Hasil Pencarian "${text}":`, found.slice(0, 5));
                    } else {
                        await reply(token, chatId, "❌ Produk tidak ditemukan.");
                    }
                    await clearUserState(chatId);
                }

                // --- LOGIC WIZARD PRODUK BARU (SIMPLE) ---
                else if (s === 'WIZARD_NAME') { await setUserState(chatId, 'WIZARD_PRICE', { ...d, name: text }); await reply(token, chatId, "2️⃣ Masukkan Harga (Angka saja):"); }
                else if (s === 'WIZARD_PRICE') {
                    const pr = parseInt(text.replace(/\D/g, '')) || 0;
                    await db.collection('products').add({
                        name: d.name, price: pr, category: 'Digital', items: [], variations: [],
                        isManual: false, processType: 'MANUAL', createdAt: new Date().toISOString()
                    });
                    await reply(token, chatId, `✅ <b>Produk Dibuat!</b>\n${d.name}\nSilakan edit stok/gambar di menu Produk.`);
                    await clearUserState(chatId);
                }
            }
        }
    } catch (e) {
        console.error("🔥 Fatal Bot Error:", e);
    }

    // WAJIB: SELALU RETURN 200 DI AKHIR
    return res.status(200).send('OK');
}
