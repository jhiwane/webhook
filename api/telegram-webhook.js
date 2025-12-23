import admin from 'firebase-admin';

// --- CONFIG ---
// Mengabaikan pesan yang lebih tua dari 120 detik (2 menit) untuk memutus loop
const MAX_MSG_AGE = 120; 

// --- 1. INITIALIZE FIREBASE (OPTIMIZED) ---
// Kita cek global var agar tidak init ulang setiap request (mempercepat respon)
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
            console.log("Firebase Initialized");
        }
    } catch (e) {
        console.error("Firebase Init Error:", e.message);
    }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- 2. HELPERS ---
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');

async function reply(token, chatId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
        });
    } catch (e) { console.error("Reply Error:", e.message); }
}

async function editMenu(token, chatId, msgId, text, keyboard) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML', disable_web_page_preview: true,
                reply_markup: { inline_keyboard: keyboard }
            })
        });
    } catch (e) { console.error("Edit Error:", e.message); }
}

async function replyMenu(token, chatId, text, keyboard) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true,
                reply_markup: { inline_keyboard: keyboard }
            })
        });
    } catch (e) { console.error("ReplyMenu Error:", e.message); }
}

async function deleteMsg(token, chatId, msgId) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: msgId })
        });
    } catch (e) {}
}

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
    // PENTING: Selalu return 200 OK di akhir, apapun errornya, agar Telegram tidak Loop.
    
    const token = process.env.TELEGRAM_BOT_TOKEN;
    
    // Cek Database Kritis
    if (!db) {
        console.error("DB Not Connected");
        return res.status(200).send('DB Error (Handled)'); // Return 200 to stop retry
    }

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

            // Jawab loading agar tombol tidak muter-muter
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callback.id })
            });

            // 1. MENU UTAMA
            if (action === 'MAIN_MENU') {
                const keyboard = [
                    [{ text: "📦 Produk & Stok", callback_data: "MENU_PRODUK" }, { text: "➕ Produk Baru", callback_data: "START_WIZARD" }],
                    [{ text: "⏳ Order Pending", callback_data: "MENU_PENDING" }, { text: "📜 Riwayat Order", callback_data: "MENU_HISTORY" }],
                    [{ text: "🔎 Lacak Order", callback_data: "ASK_TRACK" }]
                ];
                await editMenu(token, chatId, msgId, "🔥 <b>ADMIN PANEL V2.0 (FULL POWER)</b>\nSilakan pilih menu:", keyboard);
            }

            // 2. MENU PRODUK
            else if (action === 'MENU_PRODUK') {
                const snaps = await db.collection('products').limit(10).get(); // Hapus orderBy sementara utk performa
                let keyboard = [];
                snaps.forEach(doc => {
                    const p = doc.data();
                    keyboard.push([{ text: `${p.name} (${fmtRp(p.price)})`, callback_data: `VIEW_PROD|${doc.id}` }]);
                });
                keyboard.push([{ text: "🔍 Cari Manual", callback_data: "ASK_SEARCH_PROD" }, { text: "🔙 Kembali", callback_data: "MAIN_MENU" }]);
                await editMenu(token, chatId, msgId, "📦 <b>DAFTAR PRODUK (TERBARU)</b>\nKlik untuk kelola:", keyboard);
            }

            // 3. DETAIL PRODUK
            else if (action === 'VIEW_PROD') {
                const pid = parts[1];
                const doc = await db.collection('products').doc(pid).get();
                if (!doc.exists) {
                    await reply(token, chatId, "Produk tidak ditemukan.");
                } else {
                    const p = doc.data();
                    let stockInfo = "";
                    if (p.variations && p.variations.length > 0) {
                        stockInfo = `Variasi: ${p.variations.length} Tipe`;
                    } else {
                        stockInfo = `Stok Utama: ${p.items ? p.items.length : 0}`;
                    }

                    let info = `📦 <b>${p.name}</b>\n💰 ${fmtRp(p.price)}\n🔑 Kode: <code>${p.serviceCode || '-'}</code>\n📊 ${stockInfo}`;
                    if(p.image) info += `\n🖼 <a href="${p.image}">Gambar</a>`;

                    const keyboard = [
                        [{ text: "➕ Isi Stok", callback_data: `ADD_STOCK_SELECT|${pid}` }, { text: "💰 Ubah Harga", callback_data: `EDIT_PRICE|${pid}` }],
                        [{ text: "📝 Deskripsi", callback_data: `EDIT_DESC|${pid}` }, { text: "🖼 Ganti Gambar", callback_data: `EDIT_IMG|${pid}` }],
                        [{ text: "❌ HAPUS", callback_data: `CONFIRM_DEL|${pid}` }, { text: "🔙 Kembali", callback_data: "MENU_PRODUK" }]
                    ];
                    await editMenu(token, chatId, msgId, info, keyboard);
                }
            }

            // 4. PILIH STOK (VAR/MAIN)
            else if (action === 'ADD_STOCK_SELECT') {
                const pid = parts[1];
                const doc = await db.collection('products').doc(pid).get();
                const p = doc.data();
                let keyboard = [];
                if (p.variations && p.variations.length > 0) {
                    p.variations.forEach((v, idx) => {
                        keyboard.push([{ text: `Varian: ${v.name}`, callback_data: `INPUT_STOCK|${pid}|VAR|${idx}` }]);
                    });
                } else {
                    keyboard.push([{ text: "Stok Utama", callback_data: `INPUT_STOCK|${pid}|MAIN|0` }]);
                }
                keyboard.push([{ text: "🔙 Batal", callback_data: `VIEW_PROD|${pid}` }]);
                await editMenu(token, chatId, msgId, "➕ <b>Pilih Target Stok:</b>", keyboard);
            }

            // 5. WIZARD START
            else if (action === 'START_WIZARD') {
                await setUserState(chatId, 'WIZARD_NAME', {});
                await reply(token, chatId, "✨ <b>PRODUK BARU</b>\n\n1️⃣ Masukkan <b>NAMA PRODUK</b>:");
                await deleteMsg(token, chatId, msgId);
            }

            // 6. HAPUS PRODUK
            else if (action === 'CONFIRM_DEL') {
                const pid = parts[1];
                const keyboard = [
                    [{ text: "✅ YA, HAPUS PERMANEN", callback_data: `EXEC_DEL|${pid}` }],
                    [{ text: "🔙 JANGAN", callback_data: `VIEW_PROD|${pid}` }]
                ];
                await editMenu(token, chatId, msgId, "⚠️ <b>Yakin Hapus?</b> Data tidak bisa kembali.", keyboard);
            }
            else if (action === 'EXEC_DEL') {
                const pid = parts[1];
                await db.collection('products').doc(pid).delete();
                await editMenu(token, chatId, msgId, "🗑️ <b>Produk Dihapus.</b>", [[{ text: "🔙 Menu", callback_data: "MAIN_MENU" }]]);
            }

            // 7. MENU PENDING & ORDER DETAIL
            else if (action === 'MENU_PENDING') {
                const snaps = await db.collection('orders')
                    .where('status', 'in', ['manual_verification', 'manual_pending'])
                    .limit(5).get();
                
                if (snaps.empty) {
                    await editMenu(token, chatId, msgId, "✅ <b>Tidak ada pesanan pending.</b>", [[{text:"🔙 Menu", callback_data:"MAIN_MENU"}]]);
                } else {
                    let keyboard = [];
                    snaps.forEach(doc => {
                        const o = doc.data();
                        keyboard.push([{ text: `${fmtRp(o.total)} | ${o.items[0].name.substring(0,15)}...`, callback_data: `ORDER_DETAIL|${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔙 Menu", callback_data: "MAIN_MENU" }]);
                    await editMenu(token, chatId, msgId, "⏳ <b>ORDERAN PENDING:</b>", keyboard);
                }
            }

            else if (action === 'ORDER_DETAIL') {
                const oid = parts[1];
                const snap = await db.collection('orders').doc(oid).get();
                if(snap.exists) {
                    const o = snap.data();
                    const contact = o.items[0].note || "-";
                    let txt = `🧾 <b>ORDER: ${oid}</b>\n👤 ${contact}\n💰 ${fmtRp(o.total)}\nStatus: ${o.status}`;
                    
                    let keyboard = [];
                    if(o.status !== 'paid' && o.status !== 'cancelled') {
                        keyboard.push([{ text: "✅ ACC", callback_data: `ACC_ASK_DATA|${oid}` }, { text: "❌ TOLAK", callback_data: `REJECT_ORDER|${oid}` }]);
                    }
                    keyboard.push([{ text: "🛡️ Jawab Komplain", callback_data: `REPLY_COMPLAIN|${oid}` }]);
                    keyboard.push([{ text: "🔙 Kembali", callback_data: "MENU_PENDING" }]);
                    
                    await editMenu(token, chatId, msgId, txt, keyboard);
                }
            }
            
            else if (action === 'REJECT_ORDER') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({ status: 'cancelled' });
                await reply(token, chatId, `❌ Order ${oid} Ditolak.`);
                await deleteMsg(token, chatId, msgId);
            }

            else if (action === 'ACC_ASK_DATA') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_SN', { oid: oid });
                await reply(token, chatId, `✍️ <b>INPUT DATA/SN UNTUK USER:</b>\nKetik '-' jika tidak ada data.`);
                await deleteMsg(token, chatId, msgId);
            }

            else if (action === 'REPLY_COMPLAIN') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_COMPLAIN_REPLY', { oid: oid });
                await reply(token, chatId, `🛡️ <b>BALAS KOMPLAIN:</b>\nKetik pesan balasan untuk user:`);
                await deleteMsg(token, chatId, msgId);
            }

            // --- INPUT TRIGGERS ---
            else if (action === 'ASK_SEARCH_PROD') {
                await setUserState(chatId, 'WAITING_SEARCH');
                await reply(token, chatId, "🔍 <b>Ketik Nama/Kode Produk:</b>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'ASK_TRACK') {
                await setUserState(chatId, 'WAITING_TRACK');
                await reply(token, chatId, "🔎 <b>Ketik ID Order (TRX-...):</b>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'INPUT_STOCK') {
                await setUserState(chatId, 'WAITING_STOCK_DATA', { pid: parts[1], type: parts[2], idx: parseInt(parts[3]) });
                await reply(token, chatId, "📦 <b>Kirim Data Stok (Bisa banyak baris):</b>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'EDIT_PRICE') {
                await setUserState(chatId, 'WAITING_PRICE', { pid: parts[1] });
                await reply(token, chatId, "💰 <b>Ketik Harga Baru (Angka):</b>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'EDIT_DESC') {
                await setUserState(chatId, 'WAITING_DESC', { pid: parts[1] });
                await reply(token, chatId, "📝 <b>Ketik Deskripsi Baru:</b>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'EDIT_IMG') {
                await setUserState(chatId, 'WAITING_IMG_URL', { pid: parts[1] });
                await reply(token, chatId, "🖼 <b>Kirim Link Gambar:</b>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'MENU_HISTORY') {
                const snaps = await db.collection('orders').orderBy('date', 'desc').limit(8).get();
                let msg = "📜 <b>HISTORY 8 TRX:</b>\n\n";
                snaps.forEach(doc => {
                    const o = doc.data();
                    msg += `${o.status==='paid'?'✅':'⏳'} <code>/trx ${doc.id}</code>\n   ${fmtRp(o.total)}\n`;
                });
                await editMenu(token, chatId, msgId, msg, [[{text:"🔙 Menu", callback_data:"MAIN_MENU"}]]);
            }
        }

        // --- B. HANDLE TEXT MESSAGE ---
        else if (body.message && body.message.text) {
            const msg = body.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            // --- ANTI LOOP / ANTI LAG FILTER ---
            // Abaikan pesan yang lebih tua dari 2 menit (menghapus backlog)
            const msgDate = msg.date; 
            const now = Math.floor(Date.now() / 1000);
            if (now - msgDate > MAX_MSG_AGE) {
                console.log("Ignored old message:", text);
                return res.status(200).send('OK'); 
            }

            // --- COMMAND RESET ---
            if (['/start', '/menu', '/help', 'batal', 'cancel'].includes(text.toLowerCase())) {
                await clearUserState(chatId);
                const keyboard = [
                    [{ text: "📦 Produk & Stok", callback_data: "MENU_PRODUK" }, { text: "➕ Produk Baru", callback_data: "START_WIZARD" }],
                    [{ text: "⏳ Order Pending", callback_data: "MENU_PENDING" }, { text: "📜 Riwayat Order", callback_data: "MENU_HISTORY" }],
                    [{ text: "🔎 Lacak Order", callback_data: "ASK_TRACK" }]
                ];
                await replyMenu(token, chatId, "🤖 <b>PANEL ADMIN</b>\nStatus: <i>Ready</i>", keyboard);
                return res.status(200).send('OK');
            }

            // --- SHORTCUT TRX ---
            if (text.startsWith('/trx')) {
                const oid = text.replace('/trx', '').trim();
                const snap = await db.collection('orders').doc(oid).get();
                if(snap.exists) {
                    const o = snap.data();
                    await reply(token, chatId, `🧾 <b>${oid}</b>\nStatus: ${o.status}\nTotal: ${fmtRp(o.total)}`);
                } else {
                    await reply(token, chatId, "❌ ID tidak ditemukan.");
                }
                return res.status(200).send('OK');
            }

            // --- STATE MACHINE PROCESSOR ---
            const userState = await getUserState(chatId);
            if (userState) {
                const s = userState.state;
                const d = userState.data;

                // WIZARD
                if (s === 'WIZARD_NAME') {
                    await setUserState(chatId, 'WIZARD_CODE', { ...d, name: text });
                    await reply(token, chatId, "2️⃣ Masukkan <b>SERVICE CODE</b> (Unik):");
                }
                else if (s === 'WIZARD_CODE') {
                    await setUserState(chatId, 'WIZARD_PRICE', { ...d, code: text });
                    await reply(token, chatId, "3️⃣ Masukkan <b>HARGA</b> (Angka):");
                }
                else if (s === 'WIZARD_PRICE') {
                    const price = parseInt(text.replace(/[^0-9]/g, ''));
                    await setUserState(chatId, 'WIZARD_STOCK', { ...d, price: price });
                    await reply(token, chatId, "4️⃣ Masukkan <b>STOK AWAL</b> (Kirim data / '0'):");
                }
                else if (s === 'WIZARD_STOCK') {
                    const items = text === '0' ? [] : text.split(/\n|,/).map(x=>x.trim()).filter(x=>x);
                    await setUserState(chatId, 'WIZARD_DESC', { ...d, items: items });
                    await reply(token, chatId, "5️⃣ Masukkan <b>DESKRIPSI</b>:");
                }
                else if (s === 'WIZARD_DESC') {
                    await setUserState(chatId, 'WIZARD_IMG', { ...d, desc: text });
                    await reply(token, chatId, "6️⃣ Masukkan <b>URL GAMBAR</b> ('-' jika tidak ada):");
                }
                else if (s === 'WIZARD_IMG') {
                    const img = text === '-' ? '' : text;
                    await setUserState(chatId, 'WIZARD_FAKE', { ...d, img: img });
                    await reply(token, chatId, "7️⃣ Masukkan <b>FAKE SOLD & VIEWS</b> (Cth: 100,500):");
                }
                else if (s === 'WIZARD_FAKE') {
                    const [sold, views] = text.split(',').map(x => parseInt(x) || 0);
                    await db.collection('products').add({
                        name: d.name, serviceCode: d.code, price: d.price, items: d.items,
                        description: d.desc, longDescription: d.desc, image: d.img,
                        fakeSold: sold || 0, fakeViews: views || 0, category: "Digital",
                        isManual: false, processType: "MANUAL", createdAt: new Date().toISOString(), variations: []
                    });
                    await reply(token, chatId, `✅ <b>PRODUK DIBUAT!</b>\n${d.name}`);
                    await clearUserState(chatId);
                }

                // PROCESS ACC
                else if (s === 'WAITING_SN') {
                    let msg = text;
                    if (text === '-') msg = "Pesanan sedang diproses.";
                    await db.collection('orders').doc(d.oid).update({ status: 'paid', adminMessage: msg });
                    await reply(token, chatId, `✅ <b>Order ${d.oid} Beres!</b>`);
                    await clearUserState(chatId);
                }

                // PROCESS COMPLAIN
                else if (s === 'WAITING_COMPLAIN_REPLY') {
                    await db.collection('orders').doc(d.oid).update({ complaintReply: text });
                    await reply(token, chatId, `🛡️ <b>Terkirim!</b>`);
                    await clearUserState(chatId);
                }

                // ISI STOK
                else if (s === 'WAITING_STOCK_DATA') {
                    const newItems = text.split(/\n|,/).map(x=>x.trim()).filter(x=>x);
                    const docRef = db.collection('products').doc(d.pid);
                    const docSnap = await docRef.get();
                    if(docSnap.exists) {
                        const p = docSnap.data();
                        if (d.type === 'VAR') {
                            const vars = [...p.variations];
                            const old = vars[d.idx].items || [];
                            vars[d.idx].items = [...old, ...newItems];
                            await docRef.update({ variations: vars });
                        } else {
                            const old = p.items || [];
                            await docRef.update({ items: [...old, ...newItems] });
                        }
                        await reply(token, chatId, `✅ <b>${newItems.length} Stok Masuk!</b>`);
                    }
                    await clearUserState(chatId);
                }

                // EDIT LAINNYA
                else if (s === 'WAITING_PRICE') {
                    const price = parseInt(text.replace(/[^0-9]/g, ''));
                    if(!isNaN(price)) {
                        await db.collection('products').doc(d.pid).update({ price: price });
                        await reply(token, chatId, `✅ Harga updated.`);
                    }
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_DESC') {
                    await db.collection('products').doc(d.pid).update({ description: text, longDescription: text });
                    await reply(token, chatId, `✅ Deskripsi updated.`);
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_IMG_URL') {
                    await db.collection('products').doc(d.pid).update({ image: text });
                    await reply(token, chatId, `✅ Gambar updated.`);
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_SEARCH') {
                    const snaps = await db.collection('products').get();
                    let found = [];
                    snaps.forEach(doc => {
                        const p = doc.data();
                        if(p.name.toLowerCase().includes(text.toLowerCase()) || p.serviceCode?.toLowerCase().includes(text.toLowerCase())) {
                            found.push([{ text: `${p.name}`, callback_data: `VIEW_PROD|${doc.id}` }]);
                        }
                    });
                    if (found.length > 0) {
                        found.push([{ text: "🔙 Menu", callback_data: "MENU_PRODUK" }]);
                        await replyMenu(token, chatId, `🔍 Hasil: "${text}"`, found.slice(0, 10));
                    } else {
                        await reply(token, chatId, "❌ Tidak ditemukan.");
                    }
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_TRACK') {
                    const snap = await db.collection('orders').doc(text.trim()).get();
                    if(snap.exists) {
                         const o = snap.data();
                         await reply(token, chatId, `🧾 <b>${text}</b>\nStatus: ${o.status}\nTotal: ${fmtRp(o.total)}`);
                    } else {
                        await reply(token, chatId, "❌ ID salah.");
                    }
                    await clearUserState(chatId);
                }

            } else {
                // JIKA TIDAK ADA STATE, DIAM (ANTI SPAM LOOP)
                // Kecuali perintah diawali slash /
                if (text.startsWith('/')) {
                    // Logic command tambahan bisa disini
                }
            }
        }
    } catch (e) {
        console.error("Bot Handler Error:", e);
        // Tetap return 200 agar tidak loop
    }

    // FINAL: RETURN 200 OK SELALU
    return res.status(200).send('OK');
}
