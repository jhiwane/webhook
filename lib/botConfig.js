const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig'); // Ambil DB dari file sebelah

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// --- LOGIC BOT DITANAM DI SINI ---

// 1. Cek status
bot.start((ctx) => ctx.reply('Bot Jisaeshin Store Ready! ⚡'));

// 2. Handler Tombol "✅ ACC ADMIN" (Dipanggil dari Notifikasi Manual)
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    
    try {
        const doc = await db.collection('orders').doc(orderId).get();
        if (!doc.exists) return ctx.reply(`❌ Order ${orderId} tidak ditemukan.`);

        const data = doc.data();
        const items = data.items || [];

        // Buat tombol untuk setiap item
        const buttons = items.map((item, idx) => 
            [Markup.button.callback(`📦 Isi: ${item.name}`, `fill_${orderId}_${idx}`)]
        );
        
        // Tambah tombol Lunas
        buttons.push([Markup.button.callback('✅ Tandai Lunas (Selesai)', `paid_${orderId}`)]);

        await ctx.reply(
            `⚡ *PROSES ORDER: ${orderId}*\nUser: ${data.voucher || '-'}\nSilakan pilih item yang mau diisi:`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );
        
        // Update status biar user tau sedang diproses
        await db.collection('orders').doc(orderId).update({ status: 'processing' });

    } catch (e) {
        console.error(e);
        ctx.reply("Error database.");
    }
});

// 3. Handler Klik "Isi Item"
bot.action(/fill_(.+)_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const itemIdx = ctx.match[2];

    // Minta Admin Membalas Pesan (Force Reply)
    // Kita selipkan ID dan Index di teks agar bisa ditangkap nanti
    await ctx.reply(
        `✍️ *INPUT DATA AKUN/VOUCHER*\n\nSilakan Reply pesan ini dengan data untuk item tersebut.\nRef: ${orderId} | Idx: ${itemIdx}`, 
        { 
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true } 
        }
    );
});

// 4. Handler Klik "Tandai Lunas"
bot.action(/paid_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'paid' });
    await ctx.reply(`✅ Order ${orderId} status -> PAID.`);
});

// 5. Handler Menerima Text (Reply dari Admin)
bot.on('text', async (ctx) => {
    const reply = ctx.message.reply_to_message;
    // Cek apakah ini balasan dari bot yang berisi "Ref: ..."
    if (reply && reply.text && reply.text.includes('Ref:')) {
        const match = reply.text.match(/Ref: (.+) \| Idx: (\d+)/);
        if (match) {
            const orderId = match[1];
            const itemIdx = parseInt(match[2]);
            const adminInput = ctx.message.text;

            try {
                const ref = db.collection('orders').doc(orderId);
                const doc = await ref.get();
                if(doc.exists) {
                    let items = doc.data().items;
                    // Masukkan data ke array 'data' di item tersebut
                    if(items[itemIdx]) {
                        if(!items[itemIdx].data) items[itemIdx].data = [];
                        items[itemIdx].data.push(adminInput);
                    }
                    await ref.update({ items: items });
                    ctx.reply(`✅ Data tersimpan untuk Item #${itemIdx+1}`);
                }
            } catch (e) {
                console.error(e);
                ctx.reply("Gagal menyimpan data.");
            }
        }
    }
});

module.exports = bot;
