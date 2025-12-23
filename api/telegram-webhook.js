import admin from 'firebase-admin';

// --- 1. INIT FIREBASE ---
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

// --- 2. CONFIG & HELPERS ---
const LOW_STOCK_THRESHOLD = 3;

// Helper: Kirim Pesan Biasa
async function reply(token, chatId, text) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
}

// Helper: Kirim Pesan dengan Tombol (Menu)
async function replyMenu(token, chatId, text, keyboard) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId, text: text, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        })
    });
}

// Helper: Edit Pesan (Agar tombol berubah tanpa nyepam chat baru)
async function editMenu(token, chatId, msgId, text, keyboard) {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        })
    });
}

// Helper: Format Rupiah
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');

// --- 3. STATE MANAGEMENT (OTAK BOT) ---
// Kita simpan "Admin sedang ngapain" di Firestore sementara
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
        // A. HANDLE TOMBOL (CALLBACK QUERY) -> NAVIGASI MENU
        // ============================================================
        if (body.callback_query) {
            const callback = body.callback_query;
            const data = callback.data;
            const chatId = callback.message.chat.id;
            const msgId = callback.message.message_id;
            const parts = data.split('|');
            const action = parts[0];

            // 1. MENU UTAMA
            if (action === 'MAIN_MENU') {
                const menuKeyboard = [
                    [{ text: "📦 Kelola Stok", callback_data: "MENU_PRODUK" }, { text: "⏳ Order Pending", callback_data: "MENU_PENDING" }],
                    [{ text: "📜 Riwayat Order", callback_data: "MENU_HISTORY" }, { text: "🔎 Lacak ID", callback_data: "ASK_TRACK" }],
                    [{ text: "➕ Produk Baru", callback_data: "ASK_NEW_PROD" }]
                ];
                await editMenu(token, chatId, msgId, "🤖 <b>PANEL ADMIN JISAESHIN</b>\nSilakan pilih menu di bawah:", menuKeyboard);
            }

            // 2. MENU PRODUK (LIST)
            else if (action === 'MENU_PRODUK') {
                // Ambil 10 produk pertama
                const snaps = await db.collection('products').limit(10).get();
                let keyboard = [];
                snaps.forEach(doc => {
                    const p = doc.data();
                    keyboard.push([{ text: `${p.name} (${p.serviceCode || '-'})`, callback_data: `VIEW|${doc.id}` }]);
                });
                keyboard.push([{ text: "🔍 Cari Manual", callback_data: "ASK_SEARCH" }, { text: "🔙 Kembali", callback_data: "MAIN_MENU" }]);
                await editMenu(token, chatId, msgId, "📦 <b>DAFTAR PRODUK (Top 10)</b>\nKlik produk untuk edit:", keyboard);
            }

            // 3. DETAIL PRODUK & OPSI EDIT
            else if (action === 'VIEW') {
                const pid = parts[1];
                const docSnap = await db.collection('products').doc(pid).get();
                if (!docSnap.exists) { return await reply(token, chatId, "Produk hilang."); }
                
                const p = docSnap.data();
                const totalStok = p.items ? p.items.length : 0;
                let detail = `📦 <b>${p.name}</b>\n\n💰 Harga: ${fmtRp(p.price)}\n🔑 Kode: <code>${p.serviceCode}</code>\n📊 Stok Utama: ${totalStok}`;

                let keyboard = [
                    [{ text: "💰 Ubah Harga", callback_data: `EDIT_PRICE|${pid}` }, { text: "➕ Isi Stok", callback_data: `ADD_STOCK|${pid}` }],
                    [{ text: "📝 +Deskripsi", callback_data: `EDIT_DESC|${pid}` }, { text: "❌ Hapus Produk", callback_data: `DEL_PROD|${pid}` }],
                    [{ text: "🔙 Kembali", callback_data: "MENU_PRODUK" }]
                ];
                await editMenu(token, chatId, msgId, detail, keyboard);
            }

            // 4. MENU PENDING (ACC ORDER)
            else if (action === 'MENU_PENDING') {
                const snaps = await db.collection('orders').where('status', 'in', ['manual_verification', 'manual_pending']).limit(5).get();
                if (snaps.empty) {
                    await editMenu(token, chatId, msgId, "✅ <b>Tidak ada pesanan pending!</b>", [[{ text: "🔙 Kembali", callback_data: "MAIN_MENU" }]]);
                } else {
                    let keyboard = [];
                    snaps.forEach(doc => {
                        const o = doc.data();
                        keyboard.push([{ text: `${fmtRp(o.total)} - ${o.items[0].name}`, callback_data: `TRX_DETAIL|${doc.id}` }]);
                    });
                    keyboard.push([{ text: "🔙 Kembali", callback_data: "MAIN_MENU" }]);
                    await editMenu(token, chatId, msgId, "⏳ <b>DAFTAR PENDING:</b>", keyboard);
                }
            }

            // 5. DETAIL TRX (UNTUK ACC/TOLAK)
            else if (action === 'TRX_DETAIL') {
                const oid = parts[1];
                const docSnap = await db.collection('orders').doc(oid).get();
                if(!docSnap.exists) return; // Handle error silent
                const o = docSnap.data();
                
                const txt = `🧾 <b>ORDER: ${oid}</b>\n👤 Kontak: ${o.items[0].note || '-'}\n💰 Total: ${fmtRp(o.total)}\nStatus: ${o.status}`;
                const keyboard = [
                    [{ text: "✅ ACC SEKARANG", callback_data: `ACC_ORDER|${oid}` }],
                    [{ text: "❌ TOLAK", callback_data: `REJECT_ORDER|${oid}` }],
                    [{ text: "🔙 Kembali", callback_data: "MENU_PENDING" }]
                ];
                await editMenu(token, chatId, msgId, txt, keyboard);
            }

            // 6. ACTION ACC ORDER
            else if (action === 'ACC_ORDER') {
                const oid = parts[1];
                await db.collection('orders').doc(oid).update({ status: 'paid' });
                // Note: Logic potong stok bisa ditambahkan disini, tapi untuk ringkas kita update status dulu
                await editMenu(token, chatId, msgId, `✅ <b>ORDER ${oid} SUKSES DI-ACC!</b>`, [[{ text: "🔙 Menu", callback_data: "MAIN_MENU" }]]);
            }

            // 7. MENU RIWAYAT (HISTORY)
            else if (action === 'MENU_HISTORY') {
                const snaps = await db.collection('orders').orderBy('date', 'desc').limit(8).get();
                let msg = "📜 <b>8 TRANSAKSI TERAKHIR:</b>\n\n";
                snaps.forEach(doc => {
                    const o = doc.data();
                    const statusIcon = o.status === 'paid' ? '✅' : '⏳';
                    msg += `${statusIcon} <code>/trx ${doc.id}</code>\n   ${o.items[0]?.name} (${fmtRp(o.total)})\n\n`;
                });
                await editMenu(token, chatId, msgId, msg, [[{ text: "🔙 Kembali", callback_data: "MAIN_MENU" }]]);
            }

            // ============================================================
            // TRIGGER INPUT (MENGAKTIFKAN MODE "MENUNGGU KETIKAN")
            // ============================================================
            
            // A. Trigger Search
            else if (action === 'ASK_SEARCH') {
                await setUserState(chatId, 'WAITING_SEARCH');
                await reply(token, chatId, "🔍 <b>Ketik Nama Produk / Kode:</b>\nBot akan mencari data...");
            }
            
            // B. Trigger Edit Harga
            else if (action === 'EDIT_PRICE') {
                await setUserState(chatId, 'WAITING_PRICE', { pid: parts[1] });
                await reply(token, chatId, "💰 <b>Ketik Harga Baru (Angka Saja):</b>\nContoh: 150000");
            }
            
            // C. Trigger Isi Stok
            else if (action === 'ADD_STOCK') {
                await setUserState(chatId, 'WAITING_STOCK', { pid: parts[1] });
                await reply(token, chatId, "📦 <b>Kirim Data Stok (Akun/Kode):</b>\nBisa kirim banyak baris sekaligus.");
            }
            
            // D. Trigger Produk Baru
            else if (action === 'ASK_NEW_PROD') {
                await setUserState(chatId, 'WAITING_NEW_PROD');
                await reply(token, chatId, "✨ <b>Format: KODE NAMA HARGA</b>\nContoh:\n<code>NF1 Netflix_Premium 35000</code>\n\nSilakan ketik sekarang:");
            }

             // E. Trigger Lacak ID
             else if (action === 'ASK_TRACK') {
                await setUserState(chatId, 'WAITING_TRACK_ID');
                await reply(token, chatId, "🔎 <b>Ketik ID Order:</b>\nContoh: TRX-12345678");
            }

            // F. Trigger Edit Deskripsi
            else if (action === 'EDIT_DESC') {
                await setUserState(chatId, 'WAITING_DESC', { pid: parts[1] });
                await reply(token, chatId, "📝 <b>Ketik Deskripsi Tambahan:</b>\nTeks ini akan ditambahkan ke deskripsi lama.");
            }

            // Jangan lupa answerCallbackQuery agar loading di tombol hilang
            await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callback.id })
            });
        }

        // ============================================================
        // B. HANDLE PESAN TEKS (INPUT MANUAL & RESPON STATE)
        // ============================================================
        else if (body.message && body.message.text) {
            const msg = body.message;
            const text = msg.text.trim();
            const chatId = msg.chat.id;

            // 1. COMMAND UTAMA (UNTUK RESET/MULAI)
            if (text === '/start' || text === '/menu' || text === '/help') {
                await clearUserState(chatId); // Reset state jika user bingung
                const menuKeyboard = [
                    [{ text: "📦 Kelola Stok", callback_data: "MENU_PRODUK" }, { text: "⏳ Order Pending", callback_data: "MENU_PENDING" }],
                    [{ text: "📜 Riwayat Order", callback_data: "MENU_HISTORY" }, { text: "🔎 Lacak ID", callback_data: "ASK_TRACK" }],
                    [{ text: "➕ Produk Baru", callback_data: "ASK_NEW_PROD" }]
                ];
                return await replyMenu(token, chatId, "🤖 <b>PANEL ADMIN</b>\nHalo Kawan! Gunakan tombol di bawah ini agar lebih cepat.", menuKeyboard);
            }

            // 2. CEK APAKAH USER SEDANG DALAM "MODE INPUT"?
            const userState = await getUserState(chatId);

            if (userState) {
                // --- MODE: SEARCH PRODUK ---
                if (userState.state === 'WAITING_SEARCH') {
                    const snaps = await db.collection('products').get();
                    let results = [];
                    snaps.forEach(doc => {
                        const p = doc.data();
                        // Cari match nama atau kode
                        if (p.name.toLowerCase().includes(text.toLowerCase()) || (p.serviceCode && p.serviceCode.toLowerCase() === text.toLowerCase())) {
                            results.push([{ text: `${p.name} (${fmtRp(p.price)})`, callback_data: `VIEW|${doc.id}` }]);
                        }
                    });

                    if (results.length > 0) {
                        results.push([{ text: "🔙 Kembali", callback_data: "MENU_PRODUK" }]);
                        await replyMenu(token, chatId, `🔍 Hasil pencarian "${text}":`, results.slice(0, 10)); // Max 10 button
                    } else {
                        await reply(token, chatId, "❌ Tidak ditemukan. Coba kata kunci lain atau ketik /menu");
                    }
                    await clearUserState(chatId); // Selesai search
                }

                // --- MODE: EDIT HARGA ---
                else if (userState.state === 'WAITING_PRICE') {
                    const newPrice = parseInt(text.replace(/[^0-9]/g, ''));
                    if (isNaN(newPrice)) {
                        return await reply(token, chatId, "❌ Harap masukkan angka saja.");
                    }
                    await db.collection('products').doc(userState.data.pid).update({ price: newPrice });
                    await reply(token, chatId, `✅ Harga berhasil diubah jadi: <b>${fmtRp(newPrice)}</b>`);
                    await clearUserState(chatId);
                }

                // --- MODE: ISI STOK ---
                else if (userState.state === 'WAITING_STOCK') {
                    const newItems = text.split(/\n|,/).map(s => s.trim()).filter(s => s);
                    const docRef = db.collection('products').doc(userState.data.pid);
                    const docSnap = await docRef.get();
                    if(docSnap.exists) {
                        const current = docSnap.data().items || [];
                        await docRef.update({ items: [...current, ...newItems] });
                        await reply(token, chatId, `✅ <b>${newItems.length} Stok Masuk!</b>\nTotal Stok: ${current.length + newItems.length}`);
                    }
                    await clearUserState(chatId);
                }

                // --- MODE: PRODUK BARU ---
                else if (userState.state === 'WAITING_NEW_PROD') {
                    const parts = text.split(' ');
                    if(parts.length < 3) return await reply(token, chatId, "⚠️ Format salah. Gunakan: KODE NAMA HARGA");
                    
                    const code = parts[0];
                    const price = parseInt(parts[parts.length-1].replace(/[^0-9]/g, ''));
                    const name = parts.slice(1, parts.length-1).join(' ');

                    await db.collection('products').add({
                        serviceCode: code, name: name, price: price, category: 'Digital',
                        items: [], description: 'Produk via Bot', createdAt: new Date().toISOString()
                    });
                    await reply(token, chatId, `✅ <b>Produk Terbuat!</b>\n${name} - ${fmtRp(price)}`);
                    await clearUserState(chatId);
                }

                 // --- MODE: TRACKING ---
                 else if (userState.state === 'WAITING_TRACK_ID') {
                    const docSnap = await db.collection('orders').doc(text.trim()).get();
                    if(!docSnap.exists) {
                        await reply(token, chatId, "❌ ID Order tidak ditemukan.");
                    } else {
                        const o = docSnap.data();
                        await reply(token, chatId, `🧾 <b>DATA ORDER</b>\nStatus: ${o.status}\nItem: ${o.items[0].name}\nTotal: ${fmtRp(o.total)}`);
                    }
                    await clearUserState(chatId);
                 }
                 
                 // --- MODE: EDIT DESKRIPSI ---
                 else if (userState.state === 'WAITING_DESC') {
                    const docRef = db.collection('products').doc(userState.data.pid);
                    const p = (await docRef.get()).data();
                    const newDesc = (p.description || "") + "\n\n" + text;
                    await docRef.update({ description: newDesc });
                    await reply(token, chatId, "✅ Deskripsi ditambahkan!");
                    await clearUserState(chatId);
                 }

            } else {
                // 3. JIKA TIDAK ADA STATE & BUKAN COMMAND -> DIAM (ANTI SPAM)
                // Kita tidak melakukan apa-apa di sini agar bot tidak "bawel" menjawab "Format Salah" terus menerus.
                // Kecuali jika text diawali slash (/) tapi bukan command dikenal, bisa kita beri hint kecil.
                if (text.startsWith('/')) {
                   // Optional: reply(token, chatId, "Perintah tidak dikenal. Klik /menu");
                }
            }
        }

    } catch (e) {
        console.error("Bot Error:", e);
        // Jangan reply error ke user agar tidak spam, cukup console log di server
    }

    return res.status(200).send('OK');
}
