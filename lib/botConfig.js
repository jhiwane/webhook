const { Telegraf, Markup } = require('telegraf');
const { db } = require('./firebaseConfig');

// --- GUNAKAN VARIABLE BOT_TOKEN SESUAI PERMINTAAN ---
const token = process.env.BOT_TOKEN;

if (!token) {
    throw new Error("CRITICAL: BOT_TOKEN tidak ditemukan di Vercel!");
}

const bot = new Telegraf(token);

// --- LOGIC BOT ---

bot.start((ctx) => ctx.reply('Bot Jisaeshin Store Ready! ⚡'));

// Handler Tombol ACC
bot.action(/acc_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    try {
        const doc = await db.collection('orders').doc(orderId).get();
        if (!doc.exists) return ctx.reply(`❌ Order ${orderId} hilang.`);

        const data = doc.data();
        const items = data.items || [];

        const buttons = items.map((item, idx) => 
            [Markup.button.callback(`📦 Isi: ${item.name}`, `fill_${orderId}_${idx}`)]
        );
        buttons.push([Markup.button.callback('✅ Tandai Lunas', `paid_${orderId}`)]);

        await ctx.reply(
            `⚡ *PROSES ORDER: ${orderId}*\nUser: ${data.voucher || '-'}\nPilih item yang mau diisi:`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
        );
        await db.collection('orders').doc(orderId).update({ status: 'processing' });
    } catch (e) {
        console.error(e);
        ctx.reply("Error database.");
    }
});

// Handler Isi Data
bot.action(/fill_(.+)_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const itemIdx = ctx.match[2];
    await ctx.reply(
        `✍️ *INPUT DATA*\nReply pesan ini dengan data akun.\nRef: ${orderId} | Idx: ${itemIdx}`, 
        { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
});

// Handler Lunas
bot.action(/paid_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await db.collection('orders').doc(orderId).update({ status: 'paid' });
    await ctx.reply(`✅ Order ${orderId} -> PAID.`);
});

// Handler Reply Text
bot.on('text', async (ctx) => {
    const reply = ctx.message.reply_to_message;
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
                    if(items[itemIdx]) {
                        if(!items[itemIdx].data) items[itemIdx].data = [];
                        items[itemIdx].data.push(adminInput);
                    }
                    await ref.update({ items: items });
                    ctx.reply(`✅ Data tersimpan untuk Item #${itemIdx+1}`);
                }
            } catch (e) {
                console.error(e);
                ctx.reply("Gagal save data.");
            }
        }
    }
});

module.exports = bot;
