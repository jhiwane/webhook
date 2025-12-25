const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');
const { processVipTransaction } = require('./vipReseller');

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 1. HANDLE TOMBOL ACC ---
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery("⚙️ Memproses...").catch(()=>{});

    try {
        await db.runTransaction(async (t) => {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await t.get(orderRef);
            
            if (!doc.exists) throw new Error("Order hilang.");
            const data = doc.data();
            
            let updatedItems = [...data.items];
            let manualQueue = []; // Item yang gagal auto (masuk antrian manual)

            // LOOP SEMUA ITEM
            for (let i = 0; i < updatedItems.length; i++) {
                let item = updatedItems[i];
                
                // Skip jika sudah ada isinya
                if (item.data && item.data.length > 0) continue;

                let filled = false;

                // Cek Data Produk di DB
                if (item.originalId) {
                    const pDoc = await db.collection('products').doc(item.originalId).get();
                    if (pDoc.exists) {
                        const pData = pDoc.data();

                        // === JALUR VIP RESELLER (API) ===
                        if (pData.processType === 'EXTERNAL_API') {
                            try {
                                await ctx.reply(`📡 Menembak Server VIP: ${item.name}...`);
                                
                                // Cari Service Code (Cek Varian dulu)
                                let serviceCode = pData.serviceCode;
                                if (item.isVariant) {
                                    const v = pData.variations.find(va => va.name === item.variantName);
                                    if (v) serviceCode = v.serviceCode;
                                }

                                if (!serviceCode) throw new Error("Kode Layanan (Service Code) Kosong!");

                                // EKSEKUSI API
                                const vipResult = await processVipTransaction(orderId, serviceCode, item.note || "");
                                
                                // Sukses
                                item.data = [`SN: ${vipResult.sn}`];
                                item.note = "✅ SUKSES API VIP";
                                filled = true;

                            } catch (apiErr) {
                                // Gagal API -> Masuk Manual
                                ctx.reply(`⚠️ Gagal API (${item.name}): ${apiErr.message}`);
                                item.note = `❌ API ERROR: ${apiErr.message}`;
                            }
                        }

                        // === JALUR STOK LOKAL (AUTO) ===
                        else if (!pData.isManual) {
                            let stock = pData.items || [];
                            let vIdx = -1;
                            
                            if (item.isVariant) {
                                vIdx = pData.variations?.findIndex(v => v.name === item.variantName);
                                if (vIdx > -1) stock = pData.variations[vIdx].items || [];
                            }

                            if (stock.length >= item.qty) {
                                const codes = stock.slice(0, item.qty);
                                item.data = codes;
                                item.note = "✅ AUTO STOK";
                                filled = true;

                                // Update Stok Gudang
                                if (item.isVariant) {
                                    pData.variations[vIdx].items = stock.slice(item.qty);
                                    t.update(pDoc.ref, { variations: pData.variations });
                                } else {
                                    t.update(pDoc.ref, { items: stock.slice(item.qty) });
                                }
                            }
                        }
                    }
                }

                // Jika Gagal Auto (Stok habis / API Error / Produk Manual)
                if (!filled) {
                    manualQueue.push({ index: i, name: item.name });
                    if (!item.note.includes("ERROR")) item.note = "⚠️ MENUNGGU INPUT ADMIN";
                }
            }

            // --- FINALISASI STATUS ---
            const allComplete = manualQueue.length === 0;
            // Jika Manual Payment: Status jadi PAID hanya jika semua lengkap
            // Jika Midtrans: Status biasanya sudah PAID dari awal, jadi tetap PAID
            const nextStatus = allComplete ? 'paid' : (data.status === 'paid' ? 'paid' : 'manual_verification');

            t.update(orderRef, { 
                items: updatedItems,
                status: nextStatus,
                adminMessage: allComplete ? "Transaksi Selesai." : "Menunggu penanganan admin."
            });

            // --- LAPOR KE ADMIN ---
            if (allComplete) {
                await ctx.reply(`✅ <b>SUKSES!</b> Order ${orderId} selesai diproses.`, {parse_mode:'HTML'});
            } else {
                // Tampilkan Tombol Manual untuk item yang belum selesai
                const buttons = manualQueue.map(p => [
                    Markup.button.callback(`✍️ Isi Manual: ${p.name}`, `fill_${orderId}_${p.index}`)
                ]);
                buttons.push([Markup.button.callback(`✅ PAKSA SELESAI`, `force_paid_${orderId}`)]);

                await ctx.replyWithHTML(
                    `⚠️ <b>BUTUH INPUT MANUAL</b>\nAda item gagal API atau Stok kosong.\nKlik tombol di bawah untuk input manual:`,
                    Markup.inlineKeyboard(buttons)
                );
            }
        });

    } catch (e) {
        ctx.reply(`❌ System Error: ${e.message}`);
    }
});

// --- 2. TOMBOL INPUT MANUAL ---
bot.action(/fill_(.+)_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
        `📝 <b>INPUT DATA</b>\n🆔 Ref: <code>${ctx.match[1]}::${ctx.match[2]}</code>\n👇 Balas kode di sini:`, 
        Markup.forceReply()
    );
});

// --- 3. HANDLE TEXT (REPLY ADMIN) ---
bot.on('text', async (ctx) => {
    const replyTo = ctx.message.reply_to_message;
    if (replyTo && replyTo.from.id === ctx.botInfo.id) {
        const text = replyTo.text;
        
        // Handle Input Barang
        if (text.includes("INPUT DATA")) {
            const refMatch = text.match(/Ref: (TRX-[\w-]+)::(\d+)/);
            if (refMatch) {
                const [_, orderId, idx] = refMatch;
                const orderRef = db.collection('orders').doc(orderId);
                
                try {
                    await db.runTransaction(async (t) => {
                        const doc = await t.get(orderRef);
                        if(doc.exists) {
                            const items = doc.data().items;
                            // Isi data
                            items[idx].data = [ctx.message.text];
                            items[idx].note = "✅ MANUAL FIX";
                            
                            const allDone = items.every(i => i.data && i.data.length > 0);
                            
                            t.update(orderRef, { items, status: allDone ? 'paid' : doc.data().status });
                            ctx.reply(allDone ? "✅ Data tersimpan. Order LUNAS." : "✅ Data tersimpan. Masih ada yg kosong.");
                        }
                    });
                } catch(e) { ctx.reply(`Gagal: ${e.message}`); }
            }
        }
        
        // Handle Balas Komplain
        if (text.includes("BALAS KOMPLAIN")) {
            const idMatch = text.match(/Order: (TRX-[\w-]+)/);
            if (idMatch) {
                await db.collection('orders').doc(idMatch[1]).update({ complaintReply: ctx.message.text });
                ctx.reply("✅ Jawaban terkirim ke User.");
            }
        }
    }
});

// --- 4. TOMBOL LAINNYA ---
bot.action(/force_paid_(.+)/, async (ctx) => {
    await db.collection('orders').doc(ctx.match[1]).update({ status: 'paid' });
    ctx.reply("✅ Status dipaksa LUNAS.");
});

bot.action(/reply_complain_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(`💬 <b>BALAS KOMPLAIN</b>\nOrder: <code>${ctx.match[1]}</code>\n👇 Ketik balasan:`, Markup.forceReply());
});

module.exports = { bot };
