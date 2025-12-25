const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

// Inisialisasi Bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// --- MIDDLEWARE LOGGING (PENTING BUAT DEBUG) ---
bot.use(async (ctx, next) => {
    // Log setiap aktivitas ke Vercel Logs
    if (ctx.callbackQuery) {
        console.log(`[BOT CLICK] Data: ${ctx.callbackQuery.data} | From: ${ctx.from.id}`);
    }
    await next();
});

// --- MIDDLEWARE KEAMANAN ---
bot.use(async (ctx, next) => {
    // Izinkan jika ID cocok, atau abaikan
    if (ctx.from && (ctx.from.id.toString() === ADMIN_ID || ctx.chat?.id.toString() === ADMIN_ID)) {
        return next();
    }
    console.log(`[UNAUTHORIZED] Akses ditolak untuk ID: ${ctx.from?.id}`);
});

// --- MENU UTAMA ---
bot.start((ctx) => {
    ctx.replyWithHTML(
        `🤖 <b>JISAESHIN SYSTEM ONLINE</b>\n\nSelamat datang, Admin. Sistem siap.`,
        Markup.inlineKeyboard([
            [Markup.button.callback('📦 Cek Stok Gudang', 'cek_stok')],
            [Markup.button.callback('💾 Backup Data', 'backup_data')],
        ])
    );
});

// --- FITUR 1: CEK STOK ---
bot.action('cek_stok', async (ctx) => {
    // 1. Jawab dulu biar loading hilang (Instant Feedback)
    await ctx.answerCbQuery("Mengambil data gudang...").catch(e => console.log(e));
    
    try {
        const snapshot = await db.collection('products').get();
        if (snapshot.empty) return ctx.reply("Gudang Kosong.");

        let msg = "📦 <b>STATUS STOK TERKINI</b>\n\n";
        snapshot.forEach(doc => {
            const p = doc.data();
            let stok = "";
            if (p.isManual) stok = "♾️ MANUAL";
            else if (p.processType === 'EXTERNAL_API') stok = "🌐 API SERVER";
            else if (p.variations && p.variations.length > 0) {
                stok = p.variations.map(v => `   └ ${v.name}: ${v.items?.length || 0}`).join('\n');
            } else {
                stok = `   └ Stok: ${p.items?.length || 0}`;
            }
            msg += `🔹 <b>${p.name}</b>\n${stok}\n`;
        });
        
        // Kirim pesan (Split jika kepanjangan)
        if (msg.length > 4000) {
            await ctx.replyWithHTML(msg.substring(0, 4000));
            await ctx.replyWithHTML(msg.substring(4000));
        } else {
            await ctx.replyWithHTML(msg);
        }
    } catch (e) { 
        console.error(e);
        ctx.reply(`Error Cek Stok: ${e.message}`); 
    }
});

// --- FITUR 2: BACKUP DATA ---
bot.action('backup_data', async (ctx) => {
    await ctx.answerCbQuery("Generating Backup...").catch(() => {});
    ctx.reply("⏳ Sedang menyusun database...");
    
    try {
        const pSnap = await db.collection('products').get();
        const vSnap = await db.collection('vouchers').get();
        const oSnap = await db.collection('orders').orderBy('date', 'desc').limit(50).get();

        const data = {
            date: new Date().toISOString(),
            source: 'Jisaeshin Vercel Backup',
            products: pSnap.docs.map(d => ({id: d.id, ...d.data()})),
            vouchers: vSnap.docs.map(d => ({id: d.id, ...d.data()})),
            latest_orders: oSnap.docs.map(d => ({id: d.id, ...d.data()}))
        };

        const buffer = Buffer.from(JSON.stringify(data, null, 2));
        await ctx.replyWithDocument({ 
            source: buffer, 
            filename: `BACKUP_JSN_${Date.now()}.json` 
        });

    } catch (e) {
        ctx.reply(`Gagal Backup: ${e.message}`);
    }
});

// --- FITUR 3: ACC PESANAN MANUAL (THE CORE) ---
// Regex ini menangkap "acc_APAPUN"
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    console.log(`[ACC ACTION] Memproses Order ID: ${orderId}`);

    // PENTING: Jawab Telegram SEGERA agar tombol tidak macet/loading terus
    await ctx.answerCbQuery("⚙️ Memproses Transaksi...").catch(e => console.log("AnswerCB Error:", e));
    
    // Beri info visual chat
    await ctx.reply(`⚙️ Memproses Order ID: ${orderId}... Mohon tunggu.`);

    try {
        await db.runTransaction(async (t) => {
            // 1. Ambil Data Order
            const orderRef = db.collection('orders').doc(orderId);
            const orderDoc = await t.get(orderRef);
            
            if (!orderDoc.exists) throw new Error(`Order ${orderId} tidak ditemukan di DB!`);
            
            const oData = orderDoc.data();
            if (oData.status === 'paid') throw new Error("Order ini sudah Lunas/Diproses sebelumnya!");

            let updatedItems = [];

            // 2. Loop Item untuk Potong Stok
            for (const item of oData.items) {
                let pRef;
                let pDoc;
                
                // Cari produk (Prioritas ID, Fallback Nama)
                if (item.originalId) {
                    pRef = db.collection('products').doc(item.originalId);
                    pDoc = await t.get(pRef);
                } else {
                    // Cari manual by name (Rawan error jika nama diganti, tapi dicoba)
                    const cleanName = item.name.split(' - ')[0];
                    const q = await db.collection('products').where('name', '==', cleanName).limit(1).get();
                    if (!q.empty) {
                        pDoc = q.docs[0];
                        pRef = pDoc.ref;
                    }
                }

                if (!pDoc || !pDoc.exists) {
                    item.note = (item.note || "") + " [Produk Hilang - Proses Manual]";
                    updatedItems.push(item);
                    continue;
                }

                const pData = pDoc.data();
                
                // Cek Tipe Produk
                if (pData.isManual || pData.processType === 'EXTERNAL_API') {
                    item.note = (item.note || "") + " [ACC ADMIN]";
                } else {
                    // PRODUK OTOMATIS (Voucher/Akun)
                    let acquiredData = [];
                    
                    if (item.isVariant) {
                        // Logika Variasi
                        const vIndex = pData.variations.findIndex(v => v.name === item.variantName);
                        if (vIndex > -1) {
                            const stock = pData.variations[vIndex].items || [];
                            if (stock.length >= item.qty) {
                                acquiredData = stock.slice(0, item.qty);
                                pData.variations[vIndex].items = stock.slice(item.qty); // Update sisa stok di memory
                                t.update(pRef, { variations: pData.variations });
                            }
                        }
                    } else {
                        // Logika Produk Biasa
                        const stock = pData.items || [];
                        if (stock.length >= item.qty) {
                            acquiredData = stock.slice(0, item.qty);
                            t.update(pRef, { items: stock.slice(item.qty) }); // Update sisa stok
                        }
                    }

                    if (acquiredData.length > 0) {
                        item.data = acquiredData; // Masukkan kode ke order user
                        item.note = (item.note || "") + " [AUTO SENT]";
                    } else {
                        item.note = (item.note || "") + " [STOK HABIS - REFILL NEEDED]";
                    }
                }
                updatedItems.push(item);
            }

            // 3. Update Status Order jadi PAID
            t.update(orderRef, {
                status: 'paid',
                items: updatedItems,
                adminMessage: 'Pembayaran dikonfirmasi Admin.'
            });
        });

        await ctx.replyWithHTML(`✅ <b>SUKSES!</b>\nOrder <code>${orderId}</code> berhasil di-ACC.\nStatus: PAID.\nStok otomatis terpotong (jika ada).`);

    } catch (e) {
        console.error("[ACC ERROR]", e);
        await ctx.reply(`❌ <b>GAGAL:</b> ${e.message}`);
    }
});

// Handle text biasa (buat cek bot hidup atau nggak)
bot.on('text', (ctx) => {
    ctx.reply(`Echo: ${ctx.message.text}`);
});

module.exports = { bot };
