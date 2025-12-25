const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 1. HANDLE TOMBOL "ACC" (OTAK UTAMA) ---
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    
    // Matikan loading spinner segera
    await ctx.answerCbQuery("⚙️ Mengecek detail order...").catch(()=>{});

    try {
        await db.runTransaction(async (t) => {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await t.get(orderRef);
            
            if (!doc.exists) throw new Error("Order tidak ditemukan.");
            const data = doc.data();
            
            // Kita clone item agar bisa dimodifikasi
            let updatedItems = [...data.items];
            let pendingItems = []; // List item yang butuh input manual
            let isModified = false;

            // --- FASE 1: PROSES OTOMATIS (Cek Stok DB) ---
            for (let i = 0; i < updatedItems.length; i++) {
                let item = updatedItems[i];

                // Jika item sudah ada isinya (data tidak kosong), skip
                if (item.data && item.data.length > 0) continue;

                let filled = false;

                // Cek Stok di Database Produk
                if (item.originalId) {
                    const pRef = db.collection('products').doc(item.originalId);
                    const pDoc = await t.get(pRef);
                    
                    if (pDoc.exists) {
                        const pData = pDoc.data();
                        // Hanya proses auto jika BUKAN manual & BUKAN API
                        if (!pData.isManual && pData.processType !== 'EXTERNAL_API') {
                            let availableStock = [];
                            let isVariant = false;
                            let varIndex = -1;

                            if (item.isVariant) {
                                isVariant = true;
                                varIndex = pData.variations?.findIndex(v => v.name === item.variantName);
                                if (varIndex > -1) availableStock = pData.variations[varIndex].items || [];
                            } else {
                                availableStock = pData.items || [];
                            }

                            // JIKA STOK CUKUP -> POTONG & MASUKKAN
                            if (availableStock.length >= item.qty) {
                                const codes = availableStock.slice(0, item.qty);
                                item.data = codes;
                                item.note = "✅ AUTO SEND";
                                filled = true;
                                isModified = true;

                                // Update Sisa Stok Gudang
                                if (isVariant) {
                                    pData.variations[varIndex].items = availableStock.slice(item.qty);
                                    t.update(pRef, { variations: pData.variations });
                                } else {
                                    t.update(pRef, { items: availableStock.slice(item.qty) });
                                }
                            }
                        }
                    }
                }

                // Jika GAGAL otomatis (Stok habis / Produk Manual), masukkan ke antrian manual
                if (!filled) {
                    // Simpan index array-nya biar nanti admin gampang ngisinya
                    pendingItems.push({ index: i, name: item.name, qty: item.qty });
                    if (!item.note) item.note = "⚠️ MENUNGGU INPUT ADMIN";
                }
            }

            // --- FASE 2: KEPUTUSAN STATUS ---
            // Jika tidak ada lagi item pending, maka LUNAS (PAID)
            // Jika masih ada pending, status TETAP (jangan di-paid-kan dulu)
            const allComplete = pendingItems.length === 0;
            const nextStatus = allComplete ? 'paid' : (data.status === 'paid' ? 'paid' : 'manual_verification');
            
            t.update(orderRef, { 
                items: updatedItems,
                status: nextStatus,
                adminMessage: allComplete ? "Pesanan Selesai." : "Menunggu Admin mengisi item..."
            });

            // --- FASE 3: LAPORAN KE TELEGRAM ---
            if (allComplete) {
                // Skenario: Semua otomatis terisi
                await ctx.reply(`✅ <b>ORDER ${orderId} SELESAI!</b>\nSemua item stok otomatis terkirim.`, {parse_mode:'HTML'});
            } else {
                // Skenario: Ada item manual / stok habis
                // KITA BUAT TOMBOL UNTUK SETIAP ITEM YG KOSONG
                const buttons = pendingItems.map(p => [
                    Markup.button.callback(`✍️ Isi: ${p.name} (x${p.qty})`, `fill_${orderId}_${p.index}`)
                ]);

                // Tambah tombol paksa lunas (opsional)
                buttons.push([Markup.button.callback(`✅ PAKSA SELESAI (Tanpa Isi)`, `force_paid_${orderId}`)]);

                await ctx.replyWithHTML(
                    `⚠️ <b>BUTUH INPUT MANUAL</b>\nOrder <code>${orderId}</code> memiliki item yang stoknya kosong/manual.\nKlik item di bawah untuk mengisi datanya:`,
                    Markup.inlineKeyboard(buttons)
                );
            }
        });

    } catch (e) {
        console.error(e);
        ctx.reply(`❌ Error System: ${e.message}`);
    }
});

// --- 2. HANDLE SAAT TOMBOL ITEM DIKLIK (Minta Input) ---
bot.action(/fill_(.+)_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const itemIndex = ctx.match[2];

    await ctx.answerCbQuery();
    
    // Kirim pesan dengan ForceReply
    // Pesan ini mengandung "metadata" di teksnya yang akan kita baca nanti
    await ctx.replyWithHTML(
        `📝 <b>INPUT DATA PRODUK</b>\n` +
        `🆔 Order: <code>${orderId}</code>\n` +
        `🔢 Index: <code>${itemIndex}</code>\n\n` +
        `👇 <b>Balas pesan ini dengan Akun/Voucher/Kode untuk item tersebut:</b>`,
        Markup.forceReply()
    );
});

// --- 3. HANDLE SAAT ADMIN MEMBALAS PESAN (Simpan ke DB) ---
bot.on('text', async (ctx) => {
    const replyTo = ctx.message.reply_to_message;
    
    // Cek apakah ini balasan untuk bot?
    if (replyTo && replyTo.from.id === ctx.botInfo.id) {
        const replyText = replyTo.text || "";
        const inputText = ctx.message.text;

        // Cek apakah balasan untuk Input Data Produk?
        if (replyText.includes("INPUT DATA PRODUK")) {
            // Parsing ID dan Index dari teks pesan bot sebelumnya
            const idMatch = replyText.match(/Order: (TRX-[\w-]+)/);
            const idxMatch = replyText.match(/Index: (\d+)/);

            if (idMatch && idxMatch) {
                const orderId = idMatch[1];
                const itemIndex = parseInt(idxMatch[1]);

                try {
                    await db.runTransaction(async (t) => {
                        const ref = db.collection('orders').doc(orderId);
                        const doc = await t.get(ref);
                        if (!doc.exists) throw "Order hilang!";

                        const data = doc.data();
                        let items = [...data.items];

                        // Masukkan teks admin ke dalam data item
                        // Kita masukkan sebagai array string
                        items[itemIndex].data = [inputText];
                        items[itemIndex].note = "✅ DIKIRIM MANUAL";

                        // Cek apakah sekarang semua item sudah terisi?
                        const allFilled = items.every(i => i.data && i.data.length > 0);
                        const nextStatus = allFilled ? 'paid' : data.status;

                        t.update(ref, {
                            items: items,
                            status: nextStatus,
                            adminMessage: allFilled ? "Pesanan selesai diproses manual." : "Sebagian item terkirim."
                        });

                        // Feedback ke Admin
                        if (allFilled) {
                            ctx.reply(`✅ <b>BERHASIL!</b>\nItem terisi. Semua item lengkap.\nOrder <code>${orderId}</code> status: <b>PAID</b>.`, {parse_mode:'HTML'});
                        } else {
                            ctx.reply(`✅ <b>ITEM TERISI!</b>\nMasih ada item lain yang kosong. Silakan klik tombol item lainnya di chat sebelumnya.`, {parse_mode:'HTML'});
                        }
                    });
                } catch (e) {
                    ctx.reply(`❌ Gagal simpan: ${e.message}`);
                }
            }
        }
    }
});

// --- 4. HANDLE PAKSA LUNAS (Opsional) ---
bot.action(/force_paid_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'paid' });
    await ctx.reply(`✅ Order ${orderId} dipaksa status: <b>PAID</b>.`, {parse_mode:'HTML'});
});

// Default Handler agar bot tidak bengong
bot.on('message', (ctx) => {
    // Silent
});

module.exports = { bot };
