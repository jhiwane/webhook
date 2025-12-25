const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 1. HANDLE TOMBOL "ACC" (AUTO + TOMBOL MANUAL) ---
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    
    // Matikan loading dulu
    await ctx.answerCbQuery("Cek Stok...").catch(()=>{});

    try {
        await db.runTransaction(async (t) => {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await t.get(orderRef);
            if (!doc.exists) throw new Error("Order hilang.");
            
            const data = doc.data();
            let updatedItems = [...data.items];
            let needManual = false;
            let manualButtons = [];

            // Loop Items
            for (let i = 0; i < updatedItems.length; i++) {
                let item = updatedItems[i];
                
                // Skip jika sudah ada data
                if (item.data && item.data.length > 0) continue;

                // Coba Ambil Stok Otomatis
                let filled = false;
                if (item.originalId) {
                    const pRef = db.collection('products').doc(item.originalId);
                    const pDoc = await t.get(pRef);
                    if (pDoc.exists) {
                        const pData = pDoc.data();
                        if (!pData.isManual && pData.processType !== 'EXTERNAL_API') {
                            // Logic Stok (Simplified for brevity)
                            let stock = pData.items || [];
                            let varIndex = -1;
                            if (item.isVariant) {
                                varIndex = pData.variations?.findIndex(v => v.name === item.variantName);
                                if (varIndex > -1) stock = pData.variations[varIndex].items || [];
                            }

                            if (stock.length >= item.qty) {
                                const codes = stock.slice(0, item.qty);
                                item.data = codes;
                                item.note = "✅ AUTO SEND";
                                filled = true;
                                // Update DB Stok (Cut)
                                if (item.isVariant) {
                                    pData.variations[varIndex].items = stock.slice(item.qty);
                                    t.update(pRef, { variations: pData.variations });
                                } else {
                                    t.update(pRef, { items: stock.slice(item.qty) });
                                }
                            }
                        }
                    }
                }

                if (!filled) {
                    needManual = true;
                    item.note = "⚠️ MENUNGGU INPUT ADMIN";
                    // Buat tombol khusus untuk item ini
                    // Format Callback: manual_ORDERID_INDEXITEM
                    manualButtons.push([
                        Markup.button.callback(`✍️ Isi Manual: ${item.name}`, `manual_${orderId}_${i}`)
                    ]);
                }
            }

            // Update Order Status
            const nextStatus = needManual ? (data.status === 'paid' ? 'paid' : 'manual_verification') : 'paid';
            t.update(orderRef, { 
                items: updatedItems, 
                status: nextStatus,
                adminMessage: needManual ? "Menunggu Admin memproses item manual..." : "Transaksi Sukses." 
            });

            // Respon ke Telegram
            if (!needManual) {
                await ctx.reply(`✅ <b>ORDER ${orderId} SELESAI!</b>\nSemua stok terkirim otomatis.`, {parse_mode:'HTML'});
            } else {
                manualButtons.push([Markup.button.callback(`✅ PAKSA LUNAS (TANPA ISI)`, `forcepaid_${orderId}`)]);
                await ctx.replyWithHTML(
                    `⚠️ <b>STOK KOSONG / MANUAL</b>\nOrder <code>${orderId}</code> butuh input manual.\nKlik tombol di bawah untuk mengisi konten per item:`,
                    Markup.inlineKeyboard(manualButtons)
                );
            }
        });
    } catch (e) {
        ctx.reply(`Error: ${e.message}`);
    }
});

// --- 2. HANDLE KLIK TOMBOL "ISI MANUAL" ---
bot.action(/manual_(.+)_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const itemIndex = ctx.match[2];
    
    await ctx.answerCbQuery();
    
    // Kirim pesan FORCE REPLY
    // Pesan ini memiliki "Hidden Metadata" di teksnya agar bot tau mau ngisi ke mana
    await ctx.reply(
        `✍️ <b>INPUT DATA MANUAL</b>\n` +
        `🆔 Order: <code>${orderId}</code>\n` +
        `📦 Item Index: <code>${itemIndex}</code>\n\n` +
        `👇 <b>Balas pesan ini dengan kode/akun yang ingin dikirim:</b>`, 
        { 
            parse_mode: 'HTML', 
            ...Markup.forceReply() // Ini bikin keyboard user otomatis mode reply
        }
    );
});

// --- 3. HANDLE KLIK "BALAS KOMPLAIN" ---
bot.action(/reply_complain_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.reply(
        `💬 <b>BALAS KOMPLAIN USER</b>\n` +
        `🆔 Order: <code>${orderId}</code>\n\n` +
        `👇 <b>Balas pesan ini dengan jawaban Anda:</b>`, 
        { parse_mode: 'HTML', ...Markup.forceReply() }
    );
});

// --- 4. HANDLE PAKSA LUNAS ---
bot.action(/forcepaid_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'paid', adminMessage: 'Pesanan diselesaikan Admin.' });
    await ctx.reply(`✅ Order ${orderId} ditandai LUNAS.`);
});

// --- 5. OTAK UTAMA: MENGOLAH BALASAN TEKS ADMIN ---
bot.on('text', async (ctx) => {
    const replyMsg = ctx.message.reply_to_message;
    
    // Cek apakah ini adalah "Reply" terhadap pesan bot?
    if (replyMsg && replyMsg.from.id === ctx.botInfo.id) {
        const text = replyMsg.text || replyMsg.caption;
        const inputContent = ctx.message.text;

        // --- SKENARIO A: ISI KONTEN MANUAL ---
        if (text.includes("INPUT DATA MANUAL")) {
            // Ekstrak ID dan Index dari teks pesan sebelumnya pakai Regex
            const idMatch = text.match(/Order: (TRX-\d+)/); // Ambil TRX-...
            const idxMatch = text.match(/Item Index: (\d+)/);
            
            if (idMatch && idxMatch) {
                const orderId = idMatch[1];
                const itemIndex = parseInt(idxMatch[1]);

                try {
                    await db.runTransaction(async (t) => {
                        const ref = db.collection('orders').doc(orderId);
                        const doc = await t.get(ref);
                        if(!doc.exists) throw "Order hilang";
                        
                        const data = doc.data();
                        const items = [...data.items];
                        
                        // Update item spesifik
                        items[itemIndex].data = [inputContent];
                        items[itemIndex].note = "✅ SENT MANUAL";
                        
                        // Cek apakah semua sudah terisi?
                        const allFilled = items.every(i => i.data && i.data.length > 0);
                        
                        t.update(ref, {
                            items: items,
                            status: allFilled ? 'paid' : data.status,
                            adminMessage: 'Data produk dikirim manual oleh Admin.'
                        });
                        
                        ctx.reply(`✅ <b>Terkirim!</b>\nIsi: ${inputContent}\nStatus: ${allFilled ? 'PAID (Lunas)' : 'Masih ada item kosong.'}`, {parse_mode:'HTML'});
                    });
                } catch(e) { ctx.reply(`Gagal: ${e.message}`); }
            }
        }

        // --- SKENARIO B: BALAS KOMPLAIN ---
        else if (text.includes("BALAS KOMPLAIN USER")) {
            const idMatch = text.match(/Order: (TRX-\d+)/);
            if (idMatch) {
                const orderId = idMatch[1];
                await db.collection('orders').doc(orderId).update({ complaintReply: inputContent });
                ctx.reply(`✅ Balasan terkirim ke web user:\n"${inputContent}"`);
            }
        }
    }
});

module.exports = { bot };
