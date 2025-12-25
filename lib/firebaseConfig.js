const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// --- DEBUGGER: Cek apakah klik tombol masuk? ---
bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
        console.log(`[BOT AKTIF] Tombol diklik: ${ctx.callbackQuery.data}`);
    }
    await next();
});

bot.start((ctx) => ctx.reply('SYSTEM ONLINE.'));

// --- LOGIKA ACC (HANTAM KROMO V2) ---
// Regex diperluas agar menangkap semua karakter setelah acc_
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];

    // 1. WAJIB: Matikan Loading Spinner Telegram DETIK ITU JUGA
    // Jika ini gagal/telat, tombol akan "diam" selamanya.
    try {
        await ctx.answerCbQuery("🔄 Memproses...").catch(e => console.log("Ignore CB Error"));
    } catch (e) {}

    // 2. Kirim pesan "Sedang diproses" biar admin tenang
    await ctx.reply(`⚙️ Sedang memproses Order ${orderId}... Tunggu sebentar.`);

    try {
        // 3. Eksekusi Database (Dipaksa Await agar Vercel tidak tidur)
        await db.runTransaction(async (t) => {
            const orderRef = db.collection('orders').doc(orderId);
            const orderDoc = await t.get(orderRef);
            
            if (!orderDoc.exists) throw new Error("Order Hilang/Tidak Ditemukan");
            if (orderDoc.data().status === 'paid') throw new Error("Sudah Lunas Sebelumnya");

            const oData = orderDoc.data();
            let updatedItems = [];

            // Logic Potong Stok & Ambil Kode
            for (const item of oData.items) {
                // Cari produk (Prioritas ID, Fallback Nama)
                let pRef;
                let pDoc;
                
                if (item.originalId) {
                    pRef = db.collection('products').doc(item.originalId);
                    pDoc = await t.get(pRef);
                } 
                
                // Jika tidak ketemu by ID, cari by Nama
                if (!pDoc || !pDoc.exists) {
                    const cleanName = item.name.split(' - ')[0];
                    const q = await db.collection('products').where('name', '==', cleanName).limit(1).get();
                    if (!q.empty) {
                        pDoc = q.docs[0];
                        pRef = pDoc.ref;
                    }
                }

                if (pDoc && pDoc.exists) {
                    const pData = pDoc.data();
                    
                    // Cek apakah ini produk otomatis (bukan manual/api)
                    if (!pData.isManual && pData.processType !== 'EXTERNAL_API') {
                        let acquired = [];
                        
                        // Handle Variasi vs Main Item
                        if (item.isVariant) {
                            const vIndex = pData.variations?.findIndex(v => v.name === item.variantName);
                            if (vIndex > -1) {
                                const stokVarian = pData.variations[vIndex].items || [];
                                if (stokVarian.length >= item.qty) {
                                    acquired = stokVarian.slice(0, item.qty);
                                    // Update sisa stok di memory
                                    pData.variations[vIndex].items = stokVarian.slice(item.qty);
                                    t.update(pRef, { variations: pData.variations });
                                }
                            }
                        } else {
                            const stokMain = pData.items || [];
                            if (stokMain.length >= item.qty) {
                                acquired = stokMain.slice(0, item.qty);
                                t.update(pRef, { items: stokMain.slice(item.qty) });
                            }
                        }

                        // Jika dapat kode, masukkan ke order user
                        if (acquired.length > 0) {
                            item.data = acquired;
                            item.note = (item.note || "") + " [AUTO]";
                        }
                    }
                }
                updatedItems.push(item);
            }

            // Finalisasi Status
            t.update(orderRef, { 
                status: 'paid', 
                items: updatedItems,
                adminMessage: 'ACC Manual Sukses.'
            });
        });

        // 4. Lapor Sukses
        await ctx.reply(`✅ <b>SUKSES!</b> Order ${orderId} LUNAS.`, { parse_mode: 'HTML' });

    } catch (error) {
        console.error("DB Error:", error);
        await ctx.reply(`❌ <b>GAGAL:</b> ${error.message}`, { parse_mode: 'HTML' });
    }
});

module.exports = { bot };
