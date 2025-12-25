const { Telegraf } = require('telegraf');
const { db } = require('./firebaseConfig');

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- MATIKAN PROTEKSI ADMIN (DEBUG MODE) ---
// Bot akan merespon siapa saja.

bot.start((ctx) => ctx.reply('SYSTEM ONLINE (DEBUG MODE)'));

// --- LOGIC TOMBOL ACC (LANGSUNG JALAN) ---
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];

    // 1. LANGSUNG RESPON TELEGRAM (Biar gak loading)
    // "answerCbQuery" adalah kunci agar tombol tidak diam
    await ctx.answerCbQuery("Proses...").catch(() => {});
    await ctx.reply(`🚀 Sedang memproses Order: ${orderId}`);

    try {
        await db.runTransaction(async (t) => {
            const orderRef = db.collection('orders').doc(orderId);
            const docSnap = await t.get(orderRef);
            
            // Kalau order ga ada, skip
            if (!docSnap.exists) return; 
            const data = docSnap.data();
            if (data.status === 'paid') return;

            let updatedItems = [];
            // Loop item simple
            for (const item of data.items) {
                // Logic potong stok sederhana
                if (item.originalId) {
                    const pRef = db.collection('products').doc(item.originalId);
                    const pDoc = await t.get(pRef);
                    if (pDoc.exists) {
                        const pData = pDoc.data();
                        // Ambil stok jika bukan manual
                        if (!pData.isManual && pData.processType !== 'EXTERNAL_API') {
                            let stock = pData.items || [];
                            if (item.isVariant) {
                                // Logic varian simple
                                const vIndex = pData.variations?.findIndex(v => v.name === item.variantName);
                                if (vIndex > -1) stock = pData.variations[vIndex].items || [];
                            }
                            
                            // Jika ada stok, ambil
                            if (stock.length >= item.qty) {
                                const codes = stock.slice(0, item.qty);
                                item.data = codes; 
                                item.note = "AUTO SENT";
                                // Update DB (Cut Stock)
                                if (item.isVariant) {
                                    pData.variations[pData.variations.findIndex(v => v.name === item.variantName)].items = stock.slice(item.qty);
                                    t.update(pRef, { variations: pData.variations });
                                } else {
                                    t.update(pRef, { items: stock.slice(item.qty) });
                                }
                            }
                        }
                    }
                }
                updatedItems.push(item);
            }

            // SET STATUS PAID
            t.update(orderRef, { status: 'paid', items: updatedItems });
        });

        ctx.reply(`✅ Order ${orderId} SUKSES DI-ACC.`);

    } catch (e) {
        console.error(e);
        ctx.reply(`⚠️ Eror DB: ${e.message}`);
    }
});

module.exports = { bot };
