import admin from 'firebase-admin';

// --- CONFIGURATION ---
const MAX_MSG_AGE = 120; // 2 Menit (Cegah loop pesan basi)
const FETCH_TIMEOUT = 9000; // 9 Detik (Agar Vercel tidak kill process)

// --- 1. FIREBASE INIT (SINGLETON) ---
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
            console.log("🔥 DB Connected");
        }
    } catch (e) {
        console.error("❌ DB Init Error:", e.message);
    }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- 2. HELPERS ---
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');

// Safe Fetch (Anti-Crash)
async function safeFetch(url, options) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return res;
    } catch (error) {
        clearTimeout(id);
        console.error(`⚠️ Network Error: ${error.message}`);
        return null;
    }
}

async function apiCall(method, token, payload) {
    return await safeFetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

// Shortcuts
const reply = (token, chatId, text) => apiCall('sendMessage', token, { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
const editMenu = (token, chatId, msgId, text, keyboard) => apiCall('editMessageText', token, { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
const deleteMsg = (token, chatId, msgId) => apiCall('deleteMessage', token, { chat_id: chatId, message_id: msgId });
const answerCallback = (token, id, text = "") => apiCall('answerCallbackQuery', token, { callback_query_id: id, text: text });

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
    if (!db) return res.status(200).send('DB Error');

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const body = req.body;

    try {
        // ==========================================
        //  A. HANDLE TOMBOL (CALLBACK)
        // ==========================================
        if (body.callback_query) {
            const cb = body.callback_query;
            const data = cb.data;
            const chatId = cb.message.chat.id;
            const msgId = cb.message.message_id;
            const parts = data.split('|');
            const action = parts[0];

            await answerCallback(token, cb.id);

            // 1. MENU UTAMA
            if (action === 'MAIN_MENU') {
                const keyboard = [
                    [{ text: "⏳ Order Masuk", callback_data: "MENU_PENDING" }, { text: "📦 Produk & Variasi", callback_data: "MENU_PRODUK" }],
                    [{ text: "🔎 Lacak TRX", callback_data: "ASK_TRACK" }, { text: "📜 Riwayat", callback_data: "MENU_HISTORY" }]
                ];
                await editMenu(token, chatId, msgId, "🔥 <b>PANEL ADMIN PRO</b>\nSistem siap. Silakan kelola toko:", keyboard);
            }

            // 2. MENU PENDING (Cari manual_verification/pending)
            else if (action === 'MENU_PENDING') {
                const snaps = await db.collection('orders')
                    .where('status', 'in', ['manual_verification', 'manual_pending', 'processing'])
                    .orderBy('date', 'desc') // Biar yang baru diatas
                    .limit(8).get();

                if (snaps.empty) {
                    await editMenu(token, chatId, msgId, "✅ <b>Aman! Tidak ada pesanan pending.</b>", [[{ text: "🔙 Menu Utama", callback_data: "MAIN_MENU" }]]);
                } else {
                    let keyboard = [];
                    snaps.forEach(doc => {
                        const o = doc.data();
                        let icon = "⏳";
                        if (o.status.includes('manual')) icon = "💰"; // Icon Uang untuk Manual Transfer
                        const itemName = o.items && o.items[0] ? o.items[0].name.substring(0, 15) : "Unknown";
                        keyboard.push([{ text: `${icon} ${fmtRp(o.total)} | ${itemName}`, callback_data: `ORDER_DETAIL|${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔄 Refresh", callback_data: "MENU_PENDING" }, { text: "🔙 Menu", callback_data: "MAIN_MENU" }]);
                    await editMenu(token, chatId, msgId, "⏳ <b>DAFTAR ANTRIAN ORDER:</b>", keyboard);
                }
            }

            // 3. DETAIL ORDER & SMART ACC
            else if (action === 'ORDER_DETAIL') {
                const oid = parts[1];
                const snap = await db.collection('orders').doc(oid).get();
                if (snap.exists) {
                    const o = snap.data();
                    const item = o.items[0];
                    const contact = item.note || "No Data";
                    
                    // Cek apakah data/voucher SUDAH ADA (Produk Otomatis)
                    const hasAutoData = item.data && item.data.length > 0;
                    
                    let txt = `🧾 <b>ORDER: ${oid}</b>\n📦 Item: <b>${item.name}</b>\n👤 Data: <code>${contact}</code>\n💰 Total: ${fmtRp(o.total)}\nStatus: <b>${o.status}</b>`;
                    
                    if(hasAutoData) txt += `\n\n🤖 <i>Produk Otomatis: Kode Voucher sudah di-booking sistem. Klik ACC untuk rilis ke user.</i>`;
                    else txt += `\n\n⚡ <i>Produk Manual/Kosong: Klik ACC untuk input SN/Bukti.</i>`;

                    if (o.paymentMethod === 'MANUAL') txt += `\n⚠️ <i>Pastikan Uang Masuk Mutasi Dulu!</i>`;

                    let keyboard = [];
                    if (!['completed', 'paid', 'cancelled'].includes(o.status)) {
                        // Tombol ACC Cerdas
                        if (hasAutoData) {
                            // Jika data sudah ada, langsung ACC tanpa input
                            keyboard.push([{ text: "✅ ACC (AUTO RELEASE)", callback_data: `ACC_AUTO_EXEC|${oid}` }]);
                        } else {
                            // Jika data kosong, minta input SN
                            keyboard.push([{ text: "✅ ACC (INPUT SN)", callback_data: `ACC_MANUAL_INPUT|${oid}` }]);
                        }
                        keyboard.push([{ text: "❌ TOLAK", callback_data: `REJECT_ORDER|${oid}` }]);
                    }
                    keyboard.push([{ text: "🛡️ Balas Komplain", callback_data: `REPLY_COMPLAIN|${oid}` }]);
                    keyboard.push([{ text: "🔙 Kembali", callback_data: "MENU_PENDING" }]);

                    await editMenu(token, chatId, msgId, txt, keyboard);
                } else {
                    await reply(token, chatId, "❌ Data order hilang.");
                }
            }

            // --- SMART ACC LOGIC ---
            
            // KASUS 1: ACC OTOMATIS (Barang sudah ada di DB order)
            else if (action === 'ACC_AUTO_EXEC') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({
                    status: 'paid', // App.jsx akan menampilkan data yang sudah ada
                    completedAt: new Date().toISOString(),
                    adminMessage: "Pembayaran Diterima. Kode Voucher Rilis."
                });
                await reply(token, chatId, `✅ <b>SUKSES!</b>\nOrder ${oid} di-ACC.\nKode Voucher otomatis muncul di web user.`);
                await deleteMsg(token, chatId, msgId); // Hapus pesan menu biar bersih
            }

            // KASUS 2: ACC MANUAL (Barang kosong/Joki, perlu input SN)
            else if (action === 'ACC_MANUAL_INPUT') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_SN', { oid: oid });
                await reply(token, chatId, `✍️ <b>INPUT SN / BUKTI:</b>\n\nTarget: <code>${oid}</code>\n\n<i>Ketik SN, Kode Voucher, atau Kata-kata konfirmasi.</i>`);
                await deleteMsg(token, chatId, msgId);
            }

            // --- TOLAK & KOMPLAIN ---
            else if (action === 'REJECT_ORDER') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({ 
                    status: 'cancelled', 
                    adminMessage: "Dibatalkan Admin (Pembayaran tidak valid/Stok habis)."
                });
                await reply(token, chatId, `❌ Order ${oid} Ditolak.`);
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'REPLY_COMPLAIN') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_COMPLAIN_REPLY', { oid: oid });
                await reply(token, chatId, `🛡️ <b>BALAS PESAN USER:</b>\nKetik pesan solusi:`);
                await deleteMsg(token, chatId, msgId);
            }

            // --- PRODUK & VARIASI ---
            else if (action === 'MENU_PRODUK') {
                const snaps = await db.collection('products').limit(10).get();
                let keyboard = [];
                snaps.forEach(doc => {
                    const p = doc.data();
                    // Tanda jika ada variasi
                    const label = p.variations && p.variations.length > 0 ? `📂 ${p.name}` : `📦 ${p.name}`;
                    keyboard.push([{ text: `${label}`, callback_data: `VIEW_PROD|${doc.id}` }]);
                });
                keyboard.push([{ text: "➕ Produk Baru", callback_data: "START_WIZARD" }, { text: "🔍 Cari Manual", callback_data: "ASK_SEARCH_PROD" }]);
                keyboard.push([{ text: "🔙 Menu Utama", callback_data: "MAIN_MENU" }]);
                await editMenu(token, chatId, msgId, "📦 <b>MANAJEMEN PRODUK</b>\nPilih produk untuk kelola stok/variasi:", keyboard);
            }

            else if (action === 'VIEW_PROD') {
                const pid = parts[1];
                const doc = await db.collection('products').doc(pid).get();
                if (doc.exists) {
                    const p = doc.data();
                    let stockInfo = "";
                    
                    // Logic Display Stok Variasi vs Utama
                    if (p.variations && p.variations.length > 0) {
                        stockInfo = `\n📋 <b>List Variasi:</b>\n`;
                        p.variations.forEach((v, i) => {
                           const stokVar = v.items ? v.items.length : 0;
                           stockInfo += `- ${v.name} (Stok: ${stokVar})\n`;
                        });
                    } else {
                        stockInfo = `\n📊 Stok Utama: ${p.items ? p.items.length : 0} pcs`;
                    }

                    const info = `📦 <b>${p.name}</b>\n💰 Base Price: ${fmtRp(p.price)}${stockInfo}`;
                    
                    const keyboard = [
                        [{ text: "➕ Tambah Stok", callback_data: `ADD_STOCK_SELECT|${pid}` }],
                        [{ text: "💰 Ubah Harga", callback_data: `EDIT_PRICE|${pid}` }, { text: "❌ Hapus", callback_data: `CONFIRM_DEL|${pid}` }],
                        [{ text: "🔙 List Produk", callback_data: "MENU_PRODUK" }]
                    ];
                    await editMenu(token, chatId, msgId, info, keyboard);
                }
            }

            // PILIH TARGET STOK (VAR/MAIN)
            else if (action === 'ADD_STOCK_SELECT') {
                const pid = parts[1];
                const doc = await db.collection('products').doc(pid).get();
                const p = doc.data();
                let keyboard = [];
                
                // Jika punya variasi, tampilkan tombol per variasi
                if (p.variations && p.variations.length > 0) {
                    p.variations.forEach((v, idx) => {
                        keyboard.push([{ text: `➕ Stok: ${v.name}`, callback_data: `INPUT_STOCK|${pid}|VAR|${idx}` }]);
                    });
                } else {
                    keyboard.push([{ text: "➕ Isi Stok Utama", callback_data: `INPUT_STOCK|${pid}|MAIN|0` }]);
                }
                
                keyboard.push([{ text: "🔙 Batal", callback_data: `VIEW_PROD|${pid}` }]);
                await editMenu(token, chatId, msgId, "🎯 <b>Pilih Target Stok:</b>\nMau isi stok ke varian mana?", keyboard);
            }

            else if (action === 'CONFIRM_DEL') {
                const pid = parts[1];
                await editMenu(token, chatId, msgId, "⚠️ <b>YAKIN HAPUS?</b>\nData hilang permanen.", [[{ text: "✅ YA HAPUS", callback_data: `EXEC_DEL|${pid}` }], [{ text: "🔙 BATAL", callback_data: `VIEW_PROD|${pid}` }]]);
            }
            else if (action === 'EXEC_DEL') {
                const pid = parts[1];
                await db.collection('products').doc(pid).delete();
                await editMenu(token, chatId, msgId, "🗑️ Produk Dihapus.", [[{ text: "🔙 Menu Produk", callback_data: "MENU_PRODUK" }]]);
            }

            // RIWAYAT (HISTORY)
            else if (action === 'MENU_HISTORY') {
                const snaps = await db.collection('orders').orderBy('date', 'desc').limit(10).get();
                let msg = "📜 <b>10 TRANSAKSI TERAKHIR:</b>\n\n";
                snaps.forEach(doc => {
                    const o = doc.data();
                    const statusIcon = (o.status === 'paid' || o.status === 'completed') ? '✅' : (o.status === 'cancelled' ? '❌' : '⏳');
                    msg += `${statusIcon} <code>/trx ${doc.id}</code>\n   ${fmtRp(o.total)}\n`;
                });
                await editMenu(token, chatId, msgId, msg, [[{ text: "🔙 Menu Utama", callback_data: "MAIN_MENU" }]]);
            }

            // INPUT HANDLERS
            else if (action === 'START_WIZARD') { await setUserState(chatId, 'WIZARD_NAME'); await reply(token, chatId, "1️⃣ Masukkan Nama Produk:"); await deleteMsg(token, chatId, msgId); }
            else if (action === 'ASK_TRACK') { await setUserState(chatId, 'WAITING_TRACK'); await reply(token, chatId, "🔎 Masukkan ID Order (TRX-...):"); await deleteMsg(token, chatId, msgId); }
            else if (action === 'ASK_SEARCH_PROD') { await setUserState(chatId, 'WAITING_SEARCH'); await reply(token, chatId, "🔍 Masukkan Kata Kunci Produk:"); await deleteMsg(token, chatId, msgId); }
            else if (action.startsWith('INPUT_STOCK')) { await setUserState(chatId, 'WAITING_STOCK_DATA', { pid: parts[1], type: parts[2], idx: parseInt(parts[3]) }); await reply(token, chatId, "📦 <b>Kirim Data Stok:</b>\n(Pisahkan dengan Enter atau Koma untuk banyak stok sekaligus)"); await deleteMsg(token, chatId, msgId); }
            else if (action.startsWith('EDIT_PRICE')) { await setUserState(chatId, 'WAITING_PRICE', { pid: parts[1] }); await reply(token, chatId, "💰 Masukkan Harga Baru (Angka):"); await deleteMsg(token, chatId, msgId); }
        }

        // ==========================================
        //  B. HANDLE TEXT (INPUT USER)
        // ==========================================
        else if (body.message && body.message.text) {
            const msg = body.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            // Filter Pesan Lama
            if ((Date.now() / 1000) - msg.date > MAX_MSG_AGE) return res.status(200).send('OK');

            // Global Commands
            if (['/start', '/menu', 'batal'].includes(text.toLowerCase())) {
                await clearUserState(chatId);
                await replyMenu(token, chatId, "🤖 <b>ADMIN PANEL REFRESHED</b>", [[{ text: "Menu Utama", callback_data: "MAIN_MENU" }]]);
                return res.status(200).send('OK');
            }
            if (text.toLowerCase().startsWith('/trx')) {
                const oid = text.replace(/\/trx/i, '').trim();
                const snap = await db.collection('orders').doc(oid).get();
                if (snap.exists) {
                    const o = snap.data();
                    await reply(token, chatId, `🧾 <b>${oid}</b>\nStatus: ${o.status}\nTotal: ${fmtRp(o.total)}`);
                } else await reply(token, chatId, "❌ ID salah.");
                return res.status(200).send('OK');
            }

            const userState = await getUserState(chatId);
            if (userState) {
                const s = userState.state;
                const d = userState.data;

                // --- ACC MANUAL (INPUT SN) ---
                if (s === 'WAITING_SN') {
                    // Format khusus agar App.jsx bisa membacanya
                    // "SUKSES SN: ..." adalah trigger untuk cleanSnMessage di App.jsx
                    let adminMsg = `SUKSES SN: ${text}`;
                    
                    await db.collection('orders').doc(d.oid).update({
                        status: 'paid',         // PENTING: Trigger 'Success' di App.jsx
                        sn: text,               // Simpan SN Murni
                        adminMessage: adminMsg, // Pesan tampilan
                        completedAt: new Date().toISOString()
                    });
                    await reply(token, chatId, `✅ <b>BERHASIL ACC!</b>\nOrder ${d.oid} selesai.\nSN terkirim ke user.`);
                    await clearUserState(chatId);
                }

                // --- BALAS KOMPLAIN ---
                else if (s === 'WAITING_COMPLAIN_REPLY') {
                    await db.collection('orders').doc(d.oid).update({ complaintReply: text });
                    await reply(token, chatId, "✅ Balasan terkirim.");
                    await clearUserState(chatId);
                }

                // --- ISI STOK (SMART VARIATION) ---
                else if (s === 'WAITING_STOCK_DATA') {
                    const newItems = text.split(/\n|,/).map(x => x.trim()).filter(x => x);
                    const docRef = db.collection('products').doc(d.pid);
                    const docSnap = await docRef.get();
                    
                    if(docSnap.exists) {
                        const p = docSnap.data();
                        let msg = "";
                        
                        if (d.type === 'VAR') {
                            // Isi stok ke VARIASI spesifik
                            const vars = [...p.variations];
                            if(vars[d.idx]) {
                                vars[d.idx].items = [...(vars[d.idx].items || []), ...newItems];
                                await docRef.update({ variations: vars });
                                msg = `ke Variasi <b>${vars[d.idx].name}</b>`;
                            }
                        } else {
                            // Isi stok UTAMA
                            await docRef.update({ items: [...(p.items || []), ...newItems] });
                            msg = `ke Stok Utama`;
                        }
                        await reply(token, chatId, `✅ <b>${newItems.length} Stok Masuk</b> ${msg}`);
                    }
                    await clearUserState(chatId);
                }

                // --- CARI PRODUK ---
                else if (s === 'WAITING_SEARCH') {
                    const snaps = await db.collection('products').get();
                    let found = [];
                    const kw = text.toLowerCase();
                    snaps.forEach(doc => {
                        const p = doc.data();
                        // Cari di Nama Produk ATAU Nama Variasi
                        let match = p.name.toLowerCase().includes(kw);
                        if (!match && p.variations) {
                            match = p.variations.some(v => v.name.toLowerCase().includes(kw));
                        }
                        
                        if (match) found.push([{ text: p.name, callback_data: `VIEW_PROD|${doc.id}` }]);
                    });
                    
                    if (found.length > 0) {
                        found.push([{ text: "🔙 Menu", callback_data: "MENU_PRODUK" }]);
                        await replyMenu(token, chatId, `🔍 Hasil: "${text}"`, found.slice(0, 5));
                    } else await reply(token, chatId, "❌ Tidak ditemukan.");
                    await clearUserState(chatId);
                }

                // --- LAINNYA ---
                else if (s === 'WAITING_PRICE') {
                    const pr = parseInt(text.replace(/\D/g, '')) || 0;
                    await db.collection('products').doc(d.pid).update({ price: pr });
                    await reply(token, chatId, "✅ Harga Updated.");
                    await clearUserState(chatId);
                }
                else if (s === 'WIZARD_NAME') { await setUserState(chatId, 'WIZARD_PRICE', { ...d, name: text }); await reply(token, chatId, "2️⃣ Masukkan Harga (Angka):"); }
                else if (s === 'WIZARD_PRICE') {
                    const pr = parseInt(text.replace(/\D/g, '')) || 0;
                    await db.collection('products').add({ name: d.name, price: pr, category: 'Digital', items: [], variations: [], isManual: false, processType: 'MANUAL', createdAt: new Date().toISOString() });
                    await reply(token, chatId, `✅ Produk <b>${d.name}</b> Dibuat!`);
                    await clearUserState(chatId);
                }
            }
        }
    } catch (e) {
        console.error("Bot Error:", e);
    }
    return res.status(200).send('OK');
}
