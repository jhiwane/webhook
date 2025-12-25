const { Telegraf, Markup } = require('telegraf');
const { db, admin } = require('./firebaseConfig');

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("CRITICAL: BOT_TOKEN missing!");

const bot = new Telegraf(token);

// --- HELPER: CEK STOK & POTONG OTOMATIS ---
async function tryAutoFulfill(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    return await db.runTransaction(async (t) => {
        const orderDoc = await t.get(orderRef);
        if (!orderDoc.exists) return { success: false, msg: "Order hilang" };
        
        const orderData = orderDoc.data();
        let items = orderData.items;
        let isFullyFilled = true;
        let logs = [];

        // Loop setiap item di order
        for (let i = 0; i < items.length; i++) {
            let item = items[i];
            
            // Jika data sudah terisi, skip
            if (item.data && item.data.length === item.qty) continue;

            const pid = item.isVariant ? item.originalId : item.id;
            const pRef = db.collection('products').doc(pid);
            const pDoc = await t.get(pRef);

            if (pDoc.exists) {
                const pData = pDoc.data();
                
                // --- LOGIKA POTONG STOK ---
                if (!pData.isManual && pData.processType !== 'EXTERNAL_API') {
                    let stockAvailable = [];
                    let newVariations = pData.variations || [];
                    let newMainItems = pData.items || [];
                    let takenData = [];

                    if (item.isVariant) {
                        const vIndex = newVariations.findIndex(v => v.name === item.variantName);
                        if (vIndex > -1) {
                            stockAvailable = newVariations[vIndex].items || [];
                            if (stockAvailable.length >= item.qty) {
                                takenData = stockAvailable.slice(0, item.qty);
                                newVariations[vIndex].items = stockAvailable.slice(item.qty); // Sisa stok
                            }
                        }
                    } else {
                        stockAvailable = newMainItems;
                        if (stockAvailable.length >= item.qty) {
                            takenData = stockAvailable.slice(0, item.qty);
                            newMainItems = stockAvailable.slice(item.qty); // Sisa stok
                        }
                    }

                    // Jika stok cukup, masukkan ke order
                    if (takenData.length === item.qty) {
                        items[i].data = takenData;
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
                logs.push(`❌ ${item.name}: Produk Database Hilang.`);
            }
        }

        // Update Order dengan data yang berhasil diambil (jika ada)
        t.update(orderRef, { items: items });
        
        return { success: isFullyFilled, logs, items };
    });
}

// --- COMMAND START ---
bot.start((ctx) => ctx.reply('Sistem Bot Jisaeshin Aktif vFinal 🚀'));

// --- HANDLER ACC / PROSES ---
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery("Memproses & Mengecek Stok...");

    try {
        // 1. COBA AUTO FULFILL DULU
        const result = await tryAutoFulfill(orderId);
        
        let msg = `⚙️ *HASIL PROSES ${orderId}*\n\n` + result.logs.join('\n');

        if (result.success) {
            // Jika semua sukses terisi otomatis
            await db.collection('orders').doc(orderId).update({ status: 'processing' }); // atau 'paid'
            msg += `\n\n✅ *SEMUA DATA TERISI OTOMATIS!*`;
            
            await ctx.reply(msg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🏁 Selesaikan Order (Kirim WA/Email)', `finish_${orderId}`)]
                ])
            });

        } else {
            // Jika masih ada yang kosong (Manual/Stok Habis)
            msg += `\n\n⚠️ *BEBERAPA ITEM BUTUH INPUT MANUAL*`;
            
            // Buat tombol HANYA untuk item yang belum ada datanya
            const buttons = [];
            result.items.forEach((item, idx) => {
                if (!item.data || item.data.length < item.qty) {
                    buttons.push([Markup.button.callback(`✍️ Input: ${item.name} (x${item.qty})`, `fill_${orderId}_${idx}`)]);
                }
            });
            buttons.push([Markup.button.callback('🔄 Cek Stok Lagi (Refresh)', `acc_${orderId}`)]);
            buttons.push([Markup.button.callback('🏁 Selesaikan Order', `finish_${orderId}`)]);

            await ctx.reply(msg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            });
        }
    } catch (e) {
        console.error(e);
        ctx.reply(`Error System: ${e.message}`);
    }
});

// --- HANDLER INPUT MANUAL (FILL) ---
bot.action(/fill_(.+)_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const idx = ctx.match[2];
    
    // Ambil info qty
    const doc = await db.collection('orders').doc(orderId).get();
    const item = doc.data().items[idx];

    await ctx.reply(
        `✍️ *INPUT DATA MANUAL*\n\n` +
        `Item: *${item.name}*\nJumlah: *${item.qty}*\n\n` +
        `Silakan Reply pesan ini dengan data.\n` +
        `_Tips: Jika jumlah 5, Anda bisa kirim 5 baris (Enter), bot akan membaginya otomatis._\n\n` +
        `Ref: ${orderId} | Idx: ${idx}`,
        { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
});

// --- HANDLER TEXT (PEMBAGI PARAGRAF OTOMATIS) ---
bot.on('text', async (ctx) => {
    const reply = ctx.message.reply_to_message;
    if (reply && reply.text && reply.text.includes('Ref:')) {
        const match = reply.text.match(/Ref: (.+) \| Idx: (\d+)/);
        if (match) {
            const orderId = match[1];
            const idx = parseInt(match[2]);
            const text = ctx.message.text;

            // LOGIKA PEMECAH PARAGRAF (ENTER)
            // Jika admin kirim:
            // Akun1
            // Akun2
            // Maka akan jadi array ["Akun1", "Akun2"]
            const dataArray = text.split('\n').filter(line => line.trim() !== '');

            try {
                const ref = db.collection('orders').doc(orderId);
                await db.runTransaction(async (t) => {
                    const doc = await t.get(ref);
                    if (!doc.exists) throw "Order hilang";
                    
                    let items = doc.data().items;
                    
                    // Update data
                    // Jika data sebelumnya kosong, inisialisasi array
                    // Jika admin kirim data parsial, kita append atau replace? 
                    // Sesuai request: "diisi satu per satu... otomatis muncul sisanya" -> Kita Replace/Append Logic
                    
                    // Simplifikasi: Kita anggap input admin adalah data FINAL untuk item itu
                    items[idx].data = dataArray;

                    t.update(ref, { items: items });
                });

                ctx.reply(`✅ Data tersimpan! (${dataArray.length} baris data).\nPembeli sekarang bisa melihatnya di web.`);
            } catch (e) {
                console.error(e);
                ctx.reply("Gagal menyimpan: " + e.message);
            }
        }
    }
});

// --- HANDLER FINISH (OPSI WA/EMAIL) ---
bot.action(/finish_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    // Update status jadi LUNAS/SELESAI biar muncul hijau di web user
    await db.collection('orders').doc(orderId).update({ status: 'paid' }); 
    
    await ctx.reply(
        `✅ Order ${orderId} ditandai SELESAI.`,
        Markup.inlineKeyboard([
            [Markup.button.url('💬 Chat Customer (WA)', `https://wa.me/628?text=Halo Kak, pesanan ${orderId} sudah selesai.`)], // Ganti 628 dengan logika ambil nomor hp jika ada
            [Markup.button.callback('Tutup Menu', 'close_menu')]
        ])
    );
});

bot.action('close_menu', (ctx) => ctx.deleteMessage());

module.exports = bot;
