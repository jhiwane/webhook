const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// --- JALAN DULU BARU MIKIR (MIDDLEWARE) ---
bot.use(async (ctx, next) => {
    // Apapun yang terjadi, kalau ada tombol diklik, matikan loading-nya DETIK ITU JUGA.
    if (ctx.callbackQuery) {
        await ctx.answerCbQuery().catch(() => {}); 
    }
    return next();
});

// --- MENU UTAMA ---
bot.start((ctx) => ctx.reply('⚡ SYSTEM READY.'));

// --- LOGIC ACC PALING BAR-BAR (ANTI-LEMOT) ---
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];

    // 1. LANGSUNG RESPON KE ADMIN (Supaya tidak dianggap gagal/timeout)
    await ctx.reply(`🚀 Perintah diterima! Memproses Order ${orderId}...`);

    // 2. BARU KERJA DATABASE (Di belakang layar)
    try {
        await db.runTransaction(async (t) => {
            const orderRef = db.collection('orders').doc(orderId);
            const orderDoc = await t.get(orderRef);
            
            // Kalau order ga ada atau udah lunas, skip aja biar ga ribet
            if (!orderDoc.exists || orderDoc.data().status === 'paid') return;

            const oData = orderDoc.data();
            let updatedItems = [];

            // Loop item sesimpel mungkin
            for (const item of oData.items) {
                // Cari produk
                let pRef = db.collection('products').doc(item.originalId || 'unknown');
                let pDoc = await t.get(pRef);

                // Fallback cari nama kalau ID ga ketemu
                if (!pDoc.exists) {
                    const q = await db.collection('products').where('name', '==', item.name.split(' - ')[0]).limit(1).get();
                    if (!q.empty) { pDoc = q.docs[0]; pRef = pDoc.ref; }
                }

                if (pDoc.exists) {
                    const pData = pDoc.data();
                    // Logika Potong Stok (Hanya jalan kalau bukan Manual/API)
                    if (!pData.isManual && pData.processType !== 'EXTERNAL_API') {
                        let acquired = [];
                        if (item.isVariant) {
                            const vIndex = pData.variations?.findIndex(v => v.name === item.variantName);
                            if (vIndex > -1 && pData.variations[vIndex].items?.length >= item.qty) {
                                acquired = pData.variations[vIndex].items.slice(0, item.qty);
                                pData.variations[vIndex].items = pData.variations[vIndex].items.slice(item.qty);
                                t.update(pRef, { variations: pData.variations });
                            }
                        } else if (pData.items?.length >= item.qty) {
                            acquired = pData.items.slice(0, item.qty);
                            t.update(pRef, { items: pData.items.slice(item.qty) });
                        }
                        
                        if (acquired.length > 0) {
                            item.data = acquired;
                            item.note = (item.note || "") + " [AUTO]";
                        }
                    }
                }
                updatedItems.push(item);
            }

            // Update status LUNAS
            t.update(orderRef, { status: 'paid', items: updatedItems });
        });

        // Info balik kalau sukses (opsional, kalau gagal ya udah)
        await ctx.reply(`✅ Order ${orderId} SELESAI.`);

    } catch (error) {
        console.error("Error Database:", error);
        // Tetap lapor error biar tau kenapa
        await ctx.reply(`⚠️ Sukses terima perintah, tapi DB error: ${error.message}`);
    }
});

// --- FITUR CEK STOK & BACKUP (Simpel) ---
bot.action('cek_stok', async (ctx) => {
    ctx.reply("📦 Cek Gudang..."); // Respon dulu
    const snap = await db.collection('products').get();
    let msg = "STOK:\n";
    snap.forEach(d => { const p=d.data(); msg += `- ${p.name}: ${p.isManual?'Manual':(p.items?.length||0)}\n`});
    if(msg.length > 4000) msg = msg.substring(0,4000);
    ctx.reply(msg);
});

bot.action('backup_data', async (ctx) => {
    ctx.reply("📂 OTW Backup...");
    // Logic backup standar... (disederhanakan biar ga menuhin tempat)
});

module.exports = { bot };
