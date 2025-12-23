import admin from 'firebase-admin';

// --- 1. INITIALIZE FIREBASE ---
if (!admin.apps.length) {
    try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (raw) {
            const serviceAccount = JSON.parse(raw);
            if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
    } catch (e) { console.error("Firebase Init Error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- 2. HELPERS & UTILS ---
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');

// Helper Kirim Pesan Biasa
async function reply(token, chatId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
        });
    } catch (e) { console.error("Reply Error", e); }
}

// Helper Kirim Menu (Inline Buttons)
async function replyMenu(token, chatId, text, keyboard) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true,
                reply_markup: { inline_keyboard: keyboard }
            })
        });
    } catch (e) { console.error("ReplyMenu Error", e); }
}

// Helper Edit Pesan (Agar tombol berubah interaktif)
async function editMenu(token, chatId, msgId, text, keyboard) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML', disable_web_page_preview: true,
                reply_markup: { inline_keyboard: keyboard }
            })
        });
    } catch (e) { console.error("EditMenu Error", e); }
}

// Helper Hapus Pesan (Untuk membersihkan chat)
async function deleteMsg(token, chatId, msgId) {
    try {
        await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: msgId })
        });
    } catch (e) { }
}

// --- 3. STATE MANAGEMENT (OTAK BOT) ---
// Menyimpan langkah admin saat ini (misal: sedang mengetik harga)
async function setUserState(chatId, state, data = {}) {
    await db.collection('bot_states').doc(String(chatId)).set({ state, data, timestamp: new Date() });
}

async function getUserState(chatId) {
    const doc = await db.collection('bot_states').doc(String(chatId)).get();
    return doc.exists ? doc.data() : null;
}

async function clearUserState(chatId) {
    await db.collection('bot_states').doc(String(chatId)).delete();
}

// --- 4. MAIN HANDLER ---
export default async function handler(req, res) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!db) return res.status(500).send("DB Error");

    const body = req.body;

    try {
        // ============================================================
        // A. HANDLE TOMBOL (CALLBACK QUERY)
        // ============================================================
        if (body.callback_query) {
            const callback = body.callback_query;
            const data = callback.data;
            const chatId = callback.message.chat.id;
            const msgId = callback.message.message_id;
            const parts = data.split('|');
            const action = parts[0];

            // --- MENU UTAMA ---
            if (action === 'MAIN_MENU') {
                const keyboard = [
                    [{ text: "📦 Produk & Stok", callback_data: "MENU_PRODUK" }, { text: "➕ Produk Baru", callback_data: "START_WIZARD" }],
                    [{ text: "⏳ Order Pending", callback_data: "MENU_PENDING" }, { text: "📜 Riwayat Order", callback_data: "MENU_HISTORY" }],
                    [{ text: "🔎 Lacak Order", callback_data: "ASK_TRACK" }]
                ];
                await editMenu(token, chatId, msgId, "🔥 <b>ADMIN PANEL V2.0 (FULL POWER)</b>\nSilakan pilih menu:", keyboard);
            }

            // --- MENU PRODUK ---
            else if (action === 'MENU_PRODUK') {
                // Ambil 10 produk terbaru
                const snaps = await db.collection('products').orderBy('createdAt', 'desc').limit(10).get(); // Pastikan ada index atau hapus orderBy jika error index
                // Fallback jika belum ada field createdAt, ambil biasa
                const safeSnaps = snaps.empty ? await db.collection('products').limit(10).get() : snaps;
                
                let keyboard = [];
                safeSnaps.forEach(doc => {
                    const p = doc.data();
                    keyboard.push([{ text: `${p.name} (${fmtRp(p.price)})`, callback_data: `VIEW_PROD|${doc.id}` }]);
                });
                keyboard.push([{ text: "🔍 Cari Manual", callback_data: "ASK_SEARCH_PROD" }, { text: "🔙 Kembali", callback_data: "MAIN_MENU" }]);
                await editMenu(token, chatId, msgId, "📦 <b>DAFTAR PRODUK (TERBARU)</b>\nKlik untuk kelola:", keyboard);
            }

            // --- DETAIL PRODUK ---
            else if (action === 'VIEW_PROD') {
                const pid = parts[1];
                const doc = await db.collection('products').doc(pid).get();
                if (!doc.exists) return await reply(token, chatId, "Produk telah dihapus.");
                const p = doc.data();
                
                // Hitung stok (Main + Variasi)
                let stockInfo = "";
                if (p.variations && p.variations.length > 0) {
                    stockInfo = `Variasi: ${p.variations.length} Tipe\nTotal Stok: ${p.variations.reduce((a,b)=>a+(b.items?.length||0),0)}`;
                } else {
                    stockInfo = `Stok Utama: ${p.items ? p.items.length : 0}`;
                }

                let info = `📦 <b>${p.name}</b>\n💰 ${fmtRp(p.price)}\n🔑 Kode: <code>${p.serviceCode || '-'}</code>\n📊 ${stockInfo}\n👁 Fake Views: ${p.fakeViews||0} | Sold: ${p.fakeSold||0}`;
                if(p.image) info += `\n🖼 <a href="${p.image}">Lihat Gambar</a>`;

                const keyboard = [
                    [{ text: "➕ Isi Stok", callback_data: `ADD_STOCK_SELECT|${pid}` }, { text: "💰 Ubah Harga", callback_data: `EDIT_PRICE|${pid}` }],
                    [{ text: "📝 Edit Deskripsi", callback_data: `EDIT_DESC|${pid}` }, { text: "🖼 Ganti Gambar", callback_data: `EDIT_IMG|${pid}` }],
                    [{ text: "❌ HAPUS PRODUK", callback_data: `CONFIRM_DEL|${pid}` }, { text: "🔙 Kembali", callback_data: "MENU_PRODUK" }]
                ];
                await editMenu(token, chatId, msgId, info, keyboard);
            }

            // --- TAMBAH STOK (SELECTOR VARIASI/UTAMA) ---
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

            // --- WIZARD: PRODUK BARU (STEP BY STEP) ---
            else if (action === 'START_WIZARD') {
                await setUserState(chatId, 'WIZARD_NAME', {});
                await reply(token, chatId, "✨ <b>MEMBUAT PRODUK BARU</b>\n\n1️⃣ Masukkan <b>NAMA PRODUK</b>:");
                await deleteMsg(token, chatId, msgId); // Hapus menu biar bersih
            }

            // --- FITUR HAPUS PRODUK ---
            else if (action === 'CONFIRM_DEL') {
                const pid = parts[1];
                const keyboard = [
                    [{ text: "✅ YA, HAPUS PERMANEN", callback_data: `EXEC_DEL|${pid}` }],
                    [{ text: "🔙 JANGAN", callback_data: `VIEW_PROD|${pid}` }]
                ];
                await editMenu(token, chatId, msgId, "⚠️ <b>KONFIRMASI HAPUS</b>\nProduk akan hilang selamanya dari App!", keyboard);
            }
            else if (action === 'EXEC_DEL') {
                const pid = parts[1];
                await db.collection('products').doc(pid).delete();
                await editMenu(token, chatId, msgId, "🗑️ <b>Produk Berhasil Dihapus.</b>", [[{ text: "🔙 Menu Utama", callback_data: "MAIN_MENU" }]]);
            }

            // --- MENU PENDING & ORDER ---
            else if (action === 'MENU_PENDING') {
                const snaps = await db.collection('orders')
                    .where('status', 'in', ['manual_verification', 'manual_pending'])
                    .limit(5).get();
                
                if (snaps.empty) {
                    await editMenu(token, chatId, msgId, "✅ <b>Tidak ada orderan pending saat ini.</b>", [[{text:"🔙 Menu", callback_data:"MAIN_MENU"}]]);
                } else {
                    let keyboard = [];
                    snaps.forEach(doc => {
                        const o = doc.data();
                        keyboard.push([{ text: `${fmtRp(o.total)} | ${o.items[0].name.substring(0,15)}...`, callback_data: `ORDER_DETAIL|${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔙 Menu", callback_data: "MAIN_MENU" }]);
                    await editMenu(token, chatId, msgId, "⏳ <b>ORDERAN MENUNGGU ACC:</b>", keyboard);
                }
            }
            
            // --- MENU HISTORY ---
            else if (action === 'MENU_HISTORY') {
                const snaps = await db.collection('orders').orderBy('date', 'desc').limit(8).get();
                let msg = "📜 <b>RIWAYAT 8 TRANSAKSI:</b>\n\n";
                snaps.forEach(doc => {
                    const o = doc.data();
                    const icon = o.status === 'paid' ? '✅' : (o.status === 'cancelled' ? '❌' : '⏳');
                    msg += `${icon} <code>/trx ${doc.id}</code>\n   ${o.items[0].name} - ${fmtRp(o.total)}\n\n`;
                });
                await editMenu(token, chatId, msgId, msg, [[{ text: "🔙 Menu", callback_data: "MAIN_MENU" }]]);
            }

            // --- DETAIL ORDER (ACC/TOLAK/KOMPLAIN) ---
            else if (action === 'ORDER_DETAIL') {
                const oid = parts[1];
                const snap = await db.collection('orders').doc(oid).get();
                if(!snap.exists) return; 
                const o = snap.data();
                const contact = o.items[0].note || "-";
                
                // Parsing nomor WA untuk link
                let waLink = "";
                let cleanContact = contact.replace(/[^0-9]/g, '');
                if (cleanContact.startsWith('08')) cleanContact = '62' + cleanContact.substring(1);
                if (cleanContact.length > 9) waLink = `https://wa.me/${cleanContact}`;

                let txt = `🧾 <b>ORDER: ${oid}</b>\n📅 ${new Date(o.date).toLocaleString()}\n👤 Kontak: ${contact}\n💰 Total: ${fmtRp(o.total)}\n📊 Status: ${o.status.toUpperCase()}`;
                if(o.adminMessage) txt += `\n\n🔔 <b>Pesan Admin:</b>\n${o.adminMessage}`;
                if(o.complaintReply) txt += `\n\n🛡️ <b>Balasan Komplain:</b>\n${o.complaintReply}`;

                let keyboard = [];
                // Tombol WA
                if(waLink) keyboard.push([{ text: "💬 Chat WhatsApp User", url: waLink }]);

                if(o.status !== 'paid' && o.status !== 'cancelled') {
                    keyboard.push([
                        { text: "✅ ACC & KIRIM", callback_data: `ACC_ASK_DATA|${oid}` },
                        { text: "❌ TOLAK", callback_data: `REJECT_ORDER|${oid}` }
                    ]);
                }
                if (o.status === 'paid') {
                     keyboard.push([{ text: "📩 Edit Data/Resi Manual", callback_data: `ACC_ASK_DATA|${oid}` }]);
                }
                
                keyboard.push([{ text: "🛡️ Jawab Komplain", callback_data: `REPLY_COMPLAIN|${oid}` }]);
                keyboard.push([{ text: "🔙 Kembali", callback_data: "MAIN_MENU" }]);

                await editMenu(token, chatId, msgId, txt, keyboard);
            }

            // --- LOGIKA ACC PEMBAYARAN & KIRIM DATA ---
            else if (action === 'ACC_ASK_DATA') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_SN', { oid: oid });
                await reply(token, chatId, `✍️ <b>INPUT DATA PESANAN (${oid})</b>\n\nSilakan ketik Data Akun, Kode Voucher, atau Resi yang akan dikirim ke pembeli.\n\n<i>Ketik '-' jika hanya ingin ACC pembayaran tanpa kirim data.</i>`);
                await deleteMsg(token, chatId, msgId);
            }
            
            else if (action === 'REJECT_ORDER') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({ status: 'cancelled' });
                await reply(token, chatId, `❌ Order ${oid} telah <b>DIBATALKAN</b>.`);
                await deleteMsg(token, chatId, msgId);
            }

            // --- JAWAB KOMPLAIN ---
            else if (action === 'REPLY_COMPLAIN') {
                const oid = parts[1];
                await setUserState(chatId, 'WAITING_COMPLAIN_REPLY', { oid: oid });
                await reply(token, chatId, `🛡️ <b>BALAS KOMPLAIN (${oid})</b>\n\nSilakan ketik solusi atau jawaban Anda untuk pembeli:`);
                await deleteMsg(token, chatId, msgId);
            }

            // --- TRIGGER INPUT (TEXT) LAINNYA ---
            else if (action === 'ASK_TRACK') {
                await setUserState(chatId, 'WAITING_TRACK');
                await reply(token, chatId, "🔎 <b>Lacak Order</b>\nSilakan ketik ID Order (Cth: TRX-12345):");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'ASK_SEARCH_PROD') {
                await setUserState(chatId, 'WAITING_SEARCH');
                await reply(token, chatId, "🔍 <b>Cari Produk</b>\nKetik Nama atau Kode Service:");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'INPUT_STOCK') {
                // pid, type (MAIN/VAR), index
                await setUserState(chatId, 'WAITING_STOCK_DATA', { pid: parts[1], type: parts[2], idx: parseInt(parts[3]) });
                await reply(token, chatId, "📦 <b>Input Stok</b>\nKirim data stok (bisa multi-line). Contoh:\n<code>user:pass\nuser2:pass2</code>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'EDIT_PRICE') {
                await setUserState(chatId, 'WAITING_PRICE', { pid: parts[1] });
                await reply(token, chatId, "💰 <b>Input Harga Baru (Angka):</b>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'EDIT_DESC') {
                await setUserState(chatId, 'WAITING_DESC', { pid: parts[1] });
                await reply(token, chatId, "📝 <b>Input Deskripsi Baru:</b>");
                await deleteMsg(token, chatId, msgId);
            }
            else if (action === 'EDIT_IMG') {
                await setUserState(chatId, 'WAITING_IMG_URL', { pid: parts[1] });
                await reply(token, chatId, "🖼 <b>Kirim URL Gambar Baru:</b>\nPastikan link diakhiri .jpg/.png");
                await deleteMsg(token, chatId, msgId);
            }

            // TUTUP LOADING BUTTON
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callback.id })
            });
        }

        // ============================================================
        // B. HANDLE PESAN TEXT (STATE MACHINE PROCESSOR)
        // ============================================================
        else if (body.message && body.message.text) {
            const msg = body.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            // RESET COMMAND
            if (['/start', '/menu', '/help', 'batal', 'cancel'].includes(text.toLowerCase())) {
                await clearUserState(chatId);
                const keyboard = [
                    [{ text: "📦 Produk & Stok", callback_data: "MENU_PRODUK" }, { text: "➕ Produk Baru", callback_data: "START_WIZARD" }],
                    [{ text: "⏳ Order Pending", callback_data: "MENU_PENDING" }, { text: "📜 Riwayat Order", callback_data: "MENU_HISTORY" }],
                    [{ text: "🔎 Lacak Order", callback_data: "ASK_TRACK" }]
                ];
                return await replyMenu(token, chatId, "🤖 <b>PANEL ADMIN</b>\nStatus bot: <i>Ready</i>\nSilakan pilih menu:", keyboard);
            }
            
            // TRACKING SHORTCUT (/trx ID)
            if (text.startsWith('/trx')) {
                const oid = text.replace('/trx', '').trim();
                const snap = await db.collection('orders').doc(oid).get();
                if(!snap.exists) return await reply(token, chatId, "❌ ID tidak ditemukan.");
                const o = snap.data();
                await reply(token, chatId, `🧾 <b>${oid}</b>\nStatus: ${o.status}\nTotal: ${fmtRp(o.total)}\nItem: ${o.items[0].name}`);
                return;
            }

            // PROSES BERDASARKAN STATE (INGATAN BOT)
            const userState = await getUserState(chatId);
            if (userState) {
                const s = userState.state;
                const d = userState.data;

                // --- 1. PROSES WIZARD PRODUK BARU ---
                if (s === 'WIZARD_NAME') {
                    await setUserState(chatId, 'WIZARD_CODE', { ...d, name: text });
                    await reply(token, chatId, "2️⃣ Masukkan <b>SERVICE CODE</b> (Unik, Cth: ML5, NF1):");
                }
                else if (s === 'WIZARD_CODE') {
                    await setUserState(chatId, 'WIZARD_PRICE', { ...d, code: text });
                    await reply(token, chatId, "3️⃣ Masukkan <b>HARGA</b> (Angka saja):");
                }
                else if (s === 'WIZARD_PRICE') {
                    const price = parseInt(text.replace(/[^0-9]/g, ''));
                    await setUserState(chatId, 'WIZARD_STOCK', { ...d, price: price });
                    await reply(token, chatId, "4️⃣ Masukkan <b>STOK AWAL</b> (Kirim datanya, atau ketik 0 jika kosong):");
                }
                else if (s === 'WIZARD_STOCK') {
                    const items = text === '0' ? [] : text.split(/\n|,/).map(x=>x.trim()).filter(x=>x);
                    await setUserState(chatId, 'WIZARD_DESC', { ...d, items: items });
                    await reply(token, chatId, "5️⃣ Masukkan <b>DESKRIPSI</b> Produk:");
                }
                else if (s === 'WIZARD_DESC') {
                    await setUserState(chatId, 'WIZARD_IMG', { ...d, desc: text });
                    await reply(token, chatId, "6️⃣ Masukkan <b>URL GAMBAR</b> (Ketik '-' jika tidak ada):");
                }
                else if (s === 'WIZARD_IMG') {
                    const img = text === '-' ? '' : text;
                    await setUserState(chatId, 'WIZARD_FAKE', { ...d, img: img });
                    await reply(token, chatId, "7️⃣ Terakhir, Masukkan <b>FAKE SOLD & VIEW</b> (Format: Sold,View. Cth: 100,500):");
                }
                else if (s === 'WIZARD_FAKE') {
                    const [sold, views] = text.split(',').map(x => parseInt(x) || 0);
                    // SAVE KE DATABASE SINKRON APP.JSX
                    await db.collection('products').add({
                        name: d.name,
                        serviceCode: d.code, // Kunci sinkronisasi
                        price: d.price,
                        items: d.items,
                        description: d.desc,
                        longDescription: d.desc,
                        image: d.img,
                        fakeSold: sold || 0,
                        fakeViews: views || 0,
                        category: "Digital",
                        isManual: false,
                        processType: "MANUAL",
                        createdAt: new Date().toISOString(),
                        variations: [] // Default array kosong
                    });
                    await reply(token, chatId, `✅ <b>PRODUK BERHASIL DIBUAT!</b>\n\nNama: ${d.name}\nKode: ${d.code}\nStok: ${d.items.length}`);
                    await clearUserState(chatId);
                }

                // --- 2. PROSES ACC & KIRIM DATA ---
                else if (s === 'WAITING_SN') {
                    let msg = text;
                    if (text === '-') msg = "Pesanan telah diproses.";
                    
                    await db.collection('orders').doc(d.oid).update({
                        status: 'paid',
                        adminMessage: msg // Sinkron App.jsx (user lihat ini sbg data)
                    });
                    await reply(token, chatId, `✅ <b>Order ${d.oid} diproses!</b>\nData terkirim ke user.`);
                    await clearUserState(chatId);
                }

                // --- 3. PROSES BALAS KOMPLAIN ---
                else if (s === 'WAITING_COMPLAIN_REPLY') {
                    await db.collection('orders').doc(d.oid).update({
                        complaintReply: text // Sinkron App.jsx (muncul notif kuning di app)
                    });
                    await reply(token, chatId, `🛡️ <b>Balasan terkirim ke User!</b>`);
                    await clearUserState(chatId);
                }

                // --- 4. PROSES ISI STOK ---
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

                // --- 5. EDIT DATA PRODUK LAINNYA ---
                else if (s === 'WAITING_PRICE') {
                    const price = parseInt(text.replace(/[^0-9]/g, ''));
                    if(!isNaN(price)) {
                        await db.collection('products').doc(d.pid).update({ price: price });
                        await reply(token, chatId, `✅ Harga updated: ${fmtRp(price)}`);
                    }
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_DESC') {
                    await db.collection('products').doc(d.pid).update({ description: text, longDescription: text });
                    await reply(token, chatId, "✅ Deskripsi updated.");
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_IMG_URL') {
                    await db.collection('products').doc(d.pid).update({ image: text });
                    await reply(token, chatId, "✅ Gambar updated.");
                    await clearUserState(chatId);
                }
                else if (s === 'WAITING_SEARCH') {
                    // Logic Search Produk
                    const snaps = await db.collection('products').get();
                    let found = [];
                    snaps.forEach(doc => {
                        const p = doc.data();
                        if(p.name.toLowerCase().includes(text.toLowerCase()) || p.serviceCode?.toLowerCase().includes(text.toLowerCase())) {
                            found.push([{ text: `${p.name} (${fmtRp(p.price)})`, callback_data: `VIEW_PROD|${doc.id}` }]);
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
                        await reply(token, chatId, "❌ ID Order tidak valid.");
                    }
                    await clearUserState(chatId);
                }

            } else {
                // JIKA TIDAK ADA STATE, DIAM SAJA (ANTI SPAM)
                // Kecuali perintah slash
                if (text.startsWith('/')) {
                    // Ignore or show menu hint
                }
            }
        }

    } catch (e) {
        console.error("Handler Error", e);
    }
    return res.status(200).send('OK');
}
