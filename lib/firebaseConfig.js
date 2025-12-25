const { Telegraf } = require('telegraf');
const { db } = require('./firebaseConfig');

const bot = new Telegraf(process.env.BOT_TOKEN);

// 1. DIAGNOSTIK: Tangkap SEMUA klik tombol, apapun itu.
// Kalau ini jalan, berarti Bot konek ke Telegram.
bot.on('callback_query', async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    console.log(`[DEBUG] Tombol diklik: ${data}`);
    
    // Matikan loading spinner DETIK ITU JUGA
    try {
        await ctx.answerCbQuery("⚠️ Sinyal Diterima!").catch(() => {});
    } catch (e) {}

    // Lanjut ke logic berikutnya
    return next();
});

// 2. LOGIC ACC
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    
    // LAPORAN TAHAP 1: Bot Hidup
    await ctx.reply(`[1/3] 🟢 Sinyal masuk. Mencari Order ID: ${orderId}...`);

    try {
        // Cek Database tanpa Transaksi dulu (biar cepat & ringan)
        const docRef = db.collection('orders').doc(orderId);
        const docSnap = await docRef.get();

        // LAPORAN TAHAP 2: Koneksi Database
        if (!docSnap.exists) {
            return ctx.reply(`❌ [STOP] Order ID ${orderId} TIDAK DITEMUKAN di Database! Cek apakah ID di tombol sama dengan di Firestore.`);
        }
        
        if (docSnap.data().status === 'paid') {
            return ctx.reply(`⚠️ [INFO] Order ini statusnya sudah PAID.`);
        }

        await ctx.reply(`[2/3] 🟡 Data ditemukan. Memulai proses potong stok...`);

        // Mulai Transaksi Berat
        await db.runTransaction(async (t) => {
            const currentDoc = await t.get(docRef);
            const data = currentDoc.data();
            let updatedItems = [];

            // Proses Item (Simple Version)
            if (data.items && Array.isArray(data.items)) {
                for (const item of data.items) {
                    // Logic potong stok DISIMPLEKAN biar gak error dulu
                    if (item.originalId) {
                        const pRef = db.collection('products').doc(item.originalId);
                        const pDoc = await t.get(pRef);
                        if (pDoc.exists) {
                            const pData = pDoc.data();
                            // Update Stok (Hardcode logic: Kurangi 1 dari main items jika ada)
                            // Ini hanya tes agar transaksi jalan
                            if (!pData.isManual && pData.items?.length > 0) {
                                const newItems = pData.items.slice(item.qty || 1);
                                t.update(pRef, { items: newItems });
                                item.note = "AUTO-PROCESSED BY BOT";
                            }
                        }
                    }
                    updatedItems.push(item);
                }
            }

            t.update(docRef, { 
                status: 'paid', 
                items: updatedItems,
                adminMessage: "ACC via Bot Telegram (Diagnostic Mode)"
            });
        });

        // LAPORAN TAHAP 3: Selesai
        await ctx.reply(`[3/3] ✅ SUKSES! Database Updated. Order Lunas.`);

    } catch (e) {
        // JIKA ERROR, LAPOR ERRORNYA
        console.error("ERROR BOT:", e);
        await ctx.reply(`❌ [CRASH] Error di Tahap Proses: ${e.message}`);
    }
});

// Respon standar kalau ada yang chat manual
bot.on('message', (ctx) => ctx.reply("Bot Aktif. Klik tombol di notifikasi order untuk tes."));

module.exports = { bot };
