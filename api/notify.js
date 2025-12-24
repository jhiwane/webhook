const { bot } = require('../lib/botConfig');
const NOTIF_CHAT_ID = process.env.ADMIN_ID; // Notif masuk ke chat Admin/Group

module.exports = async (req, res) => {
    // Setting CORS (Agar Frontend Firebase bisa akses Vercel)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const { orderId, total, items, type, buyerContact, message } = req.body;

        // 1. Handle Tipe KOMPLAIN
        if (type === 'complaint') {
            const text = `🚨 <b>KOMPLAIN MASUK</b>\n\n🆔 Order: <code>${orderId}</code>\n👤 Kontak: ${buyerContact}\n\n💬 Pesan:\n"${message}"`;
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, text, { parse_mode: 'HTML' });
            return res.status(200).json({ success: true });
        }

        // 2. Handle Tipe ORDER (Manual/Auto)
        const isManual = type === 'manual';
        let text = `⚡ <b>PESANAN BARU (${isManual ? 'MANUAL' : 'AUTO'})</b>\n\n`;
        text += `🆔 <code>${orderId}</code>\n`;
        text += `💰 <b>Rp ${parseInt(total).toLocaleString('id-ID')}</b>\n`;
        text += `👤 Kontak: ${buyerContact}\n\n`;
        text += `🛒 <b>ITEM:</b>\n${items.map(i => `▫ ${i.name} x${i.qty} ${i.note ? `(${i.note})` : ''}`).join('\n')}`;

        if (isManual) {
            // Jika Manual, sertakan Tombol ACC
            text += `\n\n👇 <i>Cek mutasi, lalu klik ACC:</i>`;
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `✅ ACC PESANAN (${orderId})`, callback_data: `acc_${orderId}` }
                    ]]
                }
            });
        } else {
            // Jika Auto, info saja
            text += `\n\n✅ <i>Pembayaran via Gateway Berhasil.</i>`;
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, text, { parse_mode: 'HTML' });
        }

        res.status(200).json({ success: true });

    } catch (e) {
        console.error("Notify Error:", e);
        res.status(500).json({ error: e.message });
    }
};
