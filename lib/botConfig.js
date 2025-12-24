const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

// Inisialisasi Bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

// --- MIDDLEWARE KEAMANAN ---
bot.use(async (ctx, next) => {
    // Hanya respon jika user adalah Admin
    if (ctx.from && (ctx.from.id.toString() === ADMIN_ID || ctx.chat?.id.toString() === ADMIN_ID)) {
        return next();
    }
    // Silent ignore untuk user asing
});

// --- MENU UTAMA ---
bot.start((ctx) => {
    ctx.replyWithHTML(
        `🤖 <b>JISAESHIN SYSTEM ONLINE (VERCEL)</b>\n\nSelamat datang, Admin. Sistem berjalan dalam mode <b>Webhook (Realtime)</b>.`,
        Markup.inlineKeyboard([
            [Markup.button.callback('📦 Cek Stok Gudang', 'cek_stok')],
            [Markup.button.callback('💾 Backup Data', 'backup_data')],
            [Markup.button.url('🌍 Buka Toko', 'https://jsn-02.web.app')] // Ganti URL tokomu
        ])
    );
});

// --- FITUR 1: CEK STOK ---
bot.action('cek_stok', async (ctx) => {
    await ctx.answerCbQuery("Mengambil data...");
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
        
        // Split pesan jika kepanjangan (Telegram limit 4096 char)
        if (msg.length > 4000) {
            await ctx.replyWithHTML(msg.substring(0, 4000));
            await ctx.replyWithHTML(msg.substring(4000));
        } else {
            await ctx.replyWithHTML(msg);
        }
    } catch (e) { ctx.reply(`Error: ${e.message}`); }
});

// --- FITUR 2: BACKUP DATA ---
bot.action('backup_data', async (ctx) => {
    await ctx.answerCbQuery("Generating Backup...");
    ctx.reply("⏳ Sedang mengambil data database...");
    
    try {
        const pSnap = await db.collection('products').get();
        const vSnap = await db.collection('vouchers').get();
        // Limit order 100 terakhir agar Vercel tidak timeout
        const oSnap = await db.collection('orders').orderBy('date', 'desc').limit(100).get();

        const data = {
            date: new Date().toISOString(),
            source: 'Jisaeshin Vercel Backup',
            products: pSnap.docs.map(d => ({id: d.id, ...d.data()})),
            vouchers: vSnap.docs.map(d => ({id: d.id, ...d.data()})),
            latest_orders: oSnap.docs.map(d => ({id: d.id, ...d.data()}))
        };

        // Kirim sebagai file Buffer (tanpa simpan ke disk karena Vercel Read-Only)
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
bot.action(/^acc_(.+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.answerCbQuery("Memproses Transaksi...");
    ctx.reply(`⚙️ Memproses Order ID: ${orderId}...`);

    try {
        await db.runTransaction(async (t) => {
            // 1. Ambil Data Order
            const orderRef = db.collection('orders').doc(orderId);
            const orderDoc = await t.get(orderRef);
            if (!orderDoc.exists) throw new Error("Order tidak ditemukan di DB!");
            
            const oData = orderDoc.data();
            if (oData.status === 'paid') throw new Error("Order ini sudah Lunas/Diproses!");

            let updatedItems = [];

            // 2. Loop Item untuk Potong Stok
            for (const item of oData.items) {
                // Cari produk asli di database berdasarkan Nama atau ID (fallback)
                // Disarankan App.jsx mengirim originalId. Jika tidak, kita cari by Name.
                let pRef;
                let pDoc;
                
                if (item.originalId) {
                    pRef = db.collection('products').doc(item.originalId);
                    pDoc = await t.get(pRef);
                } else {
                    // Fallback search by name (kurang akurat tapi works)
                    const q = await db.collection('products').where('name', '==', item.name.split(' - ')[0]).limit(1).get();
                    if (!q.empty) {
                        pDoc = q.docs[0];
                        pRef = pDoc.ref;
                    }
                }

                if (!pDoc || !pDoc.exists) {
                    // Produk sudah dihapus admin, tandai manual
                    item.note = (item.note || "") + " [Produk Hilang - Proses Manual]";
                    updatedItems.push(item);
                    continue;
                }

                const pData = pDoc.data();
                
                // Cek Tipe Produk
                if (pData.isManual || pData.processType === 'EXTERNAL_API') {
                    // Tidak perlu potong stok fisik
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
                                pData.variations[vIndex].items = stock.slice(item.qty); // Sisa stok
                                t.update(pRef, { variations: pData.variations });
                            }
                        }
                    } else {
                        // Logika Produk Biasa
                        const stock = pData.items || [];
                        if (stock.length >= item.qty) {
                            acquiredData = stock.slice(0, item.qty);
                            t.update(pRef, { items: stock.slice(item.qty) });
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

            // 3. Update Status Order
            t.update(orderRef, {
                status: 'paid',
                items: updatedItems,
                adminMessage: 'Pembayaran dikonfirmasi Admin.'
            });
        });

        ctx.reply(`✅ <b>SUKSES!</b>\nOrder <code>${orderId}</code> berhasil di-ACC.\nStok terpotong & Kode terkirim ke User (jika ada).`, {parse_mode:'HTML'});

    } catch (e) {
        console.error(e);
        ctx.reply(`❌ <b>GAGAL:</b> ${e.message}`);
    }
});

module.exports = { bot };
