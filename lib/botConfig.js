const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 1. PROSES TOMBOL ACC (OTOMATIS & MANUAL HYBRID) ---
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    
    // Respon cepat agar tombol tidak loading terus
    await ctx.answerCbQuery("⏳ Mengecek ketersediaan stok...").catch(()=>{});

    try {
        await db.runTransaction(async (t) => {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await t.get(orderRef);
            
            if (!doc.exists) throw new Error("Data Order Hilang!");
            const data = doc.data();
            
            let updatedItems = [...data.items];
            let itemsToFillManual = []; // Daftar item yang stoknya habis

            // A. LOOPING CEK STOK
            for (let i = 0; i < updatedItems.length; i++) {
                let item = updatedItems[i];

                // Skip jika item ini sudah pernah diisi sebelumnya
                if (item.data && item.data.length > 0) continue;

                let filled = false;

                // Cek Stok di Gudang (Produk Asli)
                if (item.originalId) {
                    const pRef = db.collection('products').doc(item.originalId);
                    const pDoc = await t.get(pRef);
                    
                    if (pDoc.exists) {
                        const pData = pDoc.data();
                        
                        // HANYA PROSES AUTO JIKA BUKAN MANUAL
                        if (!pData.isManual && pData.processType !== 'EXTERNAL_API') {
                            let stock = pData.items || [];
                            let isVar = false;
                            let vIdx = -1;

                            // Handle Variasi
                            if (item.isVariant) {
                                isVar = true;
                                vIdx = pData.variations?.findIndex(v => v.name === item.variantName);
                                if (vIdx > -1) stock = pData.variations[vIdx].items || [];
                            }

                            // JIKA STOK CUKUP -> AMBIL
                            if (stock.length >= item.qty) {
                                const codes = stock.slice(0, item.qty);
                                item.data = codes; // Masukkan kode ke order
                                item.note = "✅ AUTO SEND";
                                filled = true;

                                // Kurangi Stok Gudang
                                if (isVar) {
                                    pData.variations[vIdx].items = stock.slice(item.qty);
                                    t.update(pRef, { variations: pData.variations });
                                } else {
                                    t.update(pRef, { items: stock.slice(item.qty) });
                                }
                            }
                        }
                    }
                }

                // JIKA GAGAL AUTO (Stok Habis / Produk Manual)
                if (!filled) {
                    // Masukkan ke daftar "Perlu Input Manual"
                    // Kita simpan Index Array-nya agar nanti pas admin balas, bot tau item mana yg dimaksud
                    itemsToFillManual.push({ index: i, name: item.name, qty: item.qty });
                    if (!item.note) item.note = "⚠️ MENUNGGU INPUT ADMIN";
                }
            }

            // B. TENTUKAN STATUS AKHIR
            const allComplete = itemsToFillManual.length === 0;
            const nextStatus = allComplete ? 'paid' : (data.status === 'paid' ? 'paid' : 'manual_verification');

            // C. SIMPAN PERUBAHAN KE DB
            t.update(orderRef, { 
                items: updatedItems,
                status: nextStatus,
                adminMessage: allComplete ? "Pesanan Selesai." : "Menunggu Admin mengisi item..."
            });

            // D. KIRIM PESAN KE TELEGRAM
            if (allComplete) {
                // Kasus: Semua Stok Ada & Terkirim
                await ctx.reply(`✅ <b>ORDER ${orderId} SELESAI!</b>\nSemua item berhasil dikirim otomatis dari stok.`, {parse_mode:'HTML'});
            } else {
                // Kasus: Ada item kosong/manual
                // Buat tombol untuk setiap item yang kosong
                const buttons = itemsToFillManual.map(p => [
                    Markup.button.callback(`✍️ Isi: ${p.name}`, `fill_${orderId}_${p.index}`)
                ]);

                // Tambah tombol paksa lunas
                buttons.push([Markup.button.callback(`✅ PAKSA SELESAI (Tanpa Isi)`, `force_paid_${orderId}`)]);

                await ctx.replyWithHTML(
                    `⚠️ <b>STOK KOSONG / MANUAL DETECTED</b>\nOrder <code>${orderId}</code> belum lengkap.\nKlik tombol di bawah untuk input data item:`,
                    Markup.inlineKeyboard(buttons)
                );
            }
        });

    } catch (e) {
        console.error("Bot Error:", e);
        ctx.reply(`❌ System Error: ${e.message}`);
    }
});

// --- 2. SAAT TOMBOL "ISI MANUAL" DIKLIK ---
bot.action(/fill_(.+)_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const itemIndex = ctx.match[2];

    await ctx.answerCbQuery();
    
    // Paksa user membalas pesan ini (ForceReply)
    await ctx.replyWithHTML(
        `📝 <b>INPUT DATA PRODUK</b>\n` +
        `🆔 Ref: <code>${orderId}::${itemIndex}</code>\n` + // Kita sembunyikan index di sini
        `👇 <b>Balas pesan ini dengan Akun/Kode untuk item tersebut:</b>`,
        Markup.forceReply()
    );
});

// --- 3. SAAT ADMIN MEMBALAS PESAN (MENERIMA INPUT) ---
bot.on('text', async (ctx) => {
    const replyTo = ctx.message.reply_to_message;
    
    // Pastikan ini balasan ke bot
    if (replyTo && replyTo.from.id === ctx.botInfo.id) {
        const replyText = replyTo.text || "";
        const inputContent = ctx.message.text;

        // --- HANDLER INPUT PRODUK ---
        if (replyText.includes("INPUT DATA PRODUK")) {
            // Ambil ID dan Index dari teks "Ref: ..."
            const refMatch = replyText.match(/Ref: (TRX-[\w-]+)::(\d+)/);
            
            if (refMatch) {
                const orderId = refMatch[1];
                const itemIndex = parseInt(refMatch[2]);

                try {
                    await db.runTransaction(async (t) => {
                        const ref = db.collection('orders').doc(orderId);
                        const doc = await t.get(ref);
                        if (!doc.exists) throw "Order tidak ditemukan";

                        const data = doc.data();
                        let items = [...data.items];

                        // Isi data manual ke item yang dipilih
                        items[itemIndex].data = [inputContent];
                        items[itemIndex].note = "✅ DIKIRIM MANUAL";

                        // Cek apakah sekarang semua item sudah penuh?
                        const allFilled = items.every(i => i.data && i.data.length > 0);
                        
                        t.update(ref, {
                            items: items,
                            status: allFilled ? 'paid' : data.status, // Auto Paid jika lengkap
                            adminMessage: "Item manual ditambahkan Admin."
                        });

                        ctx.reply(`✅ <b>Tersimpan!</b>\nIsi: ${inputContent}\nStatus Order: ${allFilled ? 'PAID (Selesai)' : 'Masih ada item lain yg kosong.'}`, {parse_mode:'HTML'});
                    });
                } catch(e) {
                    ctx.reply(`❌ Gagal Simpan: ${e.message}`);
                }
            }
        }
        
        // --- HANDLER BALAS KOMPLAIN ---
        else if (replyText.includes("BALAS KOMPLAIN")) {
            const idMatch = replyText.match(/Order: (TRX-\d+)/);
            if (idMatch) {
                const orderId = idMatch[1];
                await db.collection('orders').doc(orderId).update({ complaintReply: inputContent });
                ctx.reply("✅ Jawaban Anda sudah dikirim ke Web User.");
            }
        }
    }
});

// --- 4. TOMBOL PEMBANTU LAIN ---
bot.action(/force_paid_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'paid' });
    ctx.reply(`✅ Order ${orderId} dipaksa LUNAS.`);
});

bot.action(/reply_complain_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.reply(`💬 <b>BALAS KOMPLAIN</b>\nOrder: <code>${orderId}</code>\n👇 Balas pesan ini dengan jawaban Anda:`, {parse_mode:'HTML', ...Markup.forceReply()});
});

module.exports = { bot };
