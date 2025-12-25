const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("CRITICAL: BOT_TOKEN missing in Vercel!");

const bot = new Telegraf(token);

// --- FUNGSI CEK STOK OTOMATIS (AUTO-FULFILL) ---
async function tryAutoFulfill(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    return await db.runTransaction(async (t) => {
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) return { success: false, msg: "Order tidak ditemukan", items: [] };
        
        const orderData = orderDoc.data();
        let items = orderData.items;
        let isFullyFilled = true;
        let logs = [];

        for (let i = 0; i < items.length; i++) {
            let item = items[i];
            
            // Skip jika data sudah terisi
            if (item.data && item.data.length >= item.qty) continue;

            const pid = item.isVariant ? item.originalId : item.id;
            const pRef = db.collection('products').doc(pid);
            const pDoc = await t.get(pRef);

            if (pDoc.exists) {
                const pData = pDoc.data();
                
                // Cek apakah produk ini tipe otomatis (bukan manual/joki)
                if (!pData.isManual && pData.processType !== 'EXTERNAL_API') {
                    let stockAvailable = [];
                    let newVariations = pData.variations || [];
                    let newMainItems = pData.items || [];
                    let takenData = [];

                    // Ambil stok dari Variasi atau Main Items
                    if (item.isVariant) {
                        const vIndex = newVariations.findIndex(v => v.name === item.variantName);
                        if (vIndex > -1) {
                            stockAvailable = newVariations[vIndex].items || [];
                            if (stockAvailable.length >= item.qty) {
                                takenData = stockAvailable.slice(0, item.qty);
                                newVariations[vIndex].items = stockAvailable.slice(item.qty);
                            }
                        }
                    } else {
                        stockAvailable = newMainItems;
                        if (stockAvailable.length >= item.qty) {
                            takenData = stockAvailable.slice(0, item.qty);
                            newMainItems = stockAvailable.slice(item.qty);
                        }
                    }

                    // Jika stok cukup, potong dan simpan
                    if (takenData.length === item.qty) {
                        items[i].data = takenData;
                        // Update stok produk
                        t.update(pRef, { 
                            variations: newVariations, 
                            items: newMainItems,
                            realSold: (pData.realSold || 0) + item.qty
                        });
                        logs.push(`✅ ${item.name}: Stok Otomatis Diambil.`);
                    } else {
                        isFullyFilled = false;
                        logs.push(`⚠️ ${item.name}: Stok Habis/Kurang.`);
                    }
                } else {
                    isFullyFilled = false; // Produk Manual (Joki)
                    logs.push(`ℹ️ ${item.name}: Produk Manual (Butuh Input).`);
                }
            } else {
                isFullyFilled = false;
                logs.push(`❌ ${item.name}: Produk Hilang dari Database.`);
            }
        }

        // Update Order dengan data baru
        t.update(orderRef, { items: items });
        
        return { success: isFullyFilled, logs, items };
    });
}

// --- LOGIC BOT ---

bot.start((ctx) => ctx.reply('Sistem Bot Jisaeshin Aktif 🚀'));

// 1. HANDLER SAAT ADMIN KLIK "ACC / PROSES"
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery("Memproses...");

    try {
        // Coba isi otomatis dulu
        const result = await tryAutoFulfill(orderId);
        
        let msg = `⚙️ *LOG PROSES ${orderId}*\n\n` + result.logs.join('\n');

        if (result.success) {
            // Jika semua sukses otomatis
            await db.collection('orders').doc(orderId).update({ status: 'paid' });
            msg += `\n\n✅ *SEMUA DATA TERISI OTOMATIS!*`;
            
            await ctx.reply(msg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🏁 Selesai / Tutup', `finish_${orderId}`)]
                ])
            });
        } else {
            // Jika butuh input manual
            msg += `\n\n⚠️ *ITEM BUTUH INPUT MANUAL:*`;
            const buttons = [];
            
            // Buat tombol hanya untuk item yang belum beres
            result.items.forEach((item, idx) => {
                if (!item.data || item.data.length < item.qty) {
                    buttons.push([Markup.button.callback(`✍️ Input: ${item.name}`, `fill_${orderId}_${idx}`)]);
                }
            });
            
            buttons.push([Markup.button.callback('🔄 Refresh Cek Stok', `acc_${orderId}`)]);
            buttons.push([Markup.button.callback('🏁 Selesai Manual', `finish_${orderId}`)]);

            await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        }
    } catch (e) {
        console.error(e);
        ctx.reply(`Error System: ${e.message}`);
    }
});

// 2. HANDLER SAAT KLIK INPUT MANUAL
bot.action(/fill_(.+)_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const idx = ctx.match[2];
    
    // Force Reply agar admin tinggal ketik
    await ctx.reply(
        `✍️ *INPUT DATA*\nSilakan Reply pesan ini.\nJika qty banyak, kirim per baris (Enter).\nRef: ${orderId} | Idx: ${idx}`,
        { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
});

// 3. HANDLER SAAT ADMIN MEMBALAS PESAN (TEXT)
bot.on('text', async (ctx) => {
    const reply = ctx.message.reply_to_message;
    if (reply && reply.text && reply.text.includes('Ref:')) {
        const match = reply.text.match(/Ref: (.+) \| Idx: (\d+)/);
        if (match) {
            const orderId = match[1];
            const idx = parseInt(match[2]);
            const text = ctx.message.text;

            // Pecah paragraf menjadi array
            const dataArray = text.split('\n').filter(line => line.trim() !== '');

            try {
                const ref = db.collection('orders').doc(orderId);
                await db.runTransaction(async (t) => {
                    const doc = await t.get(ref);
                    if (!doc.exists) throw "Order hilang";
                    
                    let items = doc.data().items;
                    // Simpan data ke item tersebut
                    items[idx].data = dataArray;

                    t.update(ref, { items: items });
                });
                ctx.reply(`✅ Data tersimpan (${dataArray.length} baris). User bisa melihatnya di web.`);
            } catch (e) {
                console.error(e);
                ctx.reply("Gagal menyimpan: " + e.message);
            }
        }
    }
});

// 4. HANDLER FINISH
bot.action(/finish_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'paid' }); 
    await ctx.reply(`✅ Order ${orderId} status -> PAID (Selesai).`);
});

module.exports = bot;
