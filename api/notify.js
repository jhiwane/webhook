const { bot } = require('../lib/botConfig');
const NOTIF_CHAT_ID = process.env.ADMIN_ID; 

module.exports = async (req, res) => {
    // Setup CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { orderId, total, items, type, buyerContact } = req.body;

        // Validasi ID agar tombol Telegram tidak rusak
        // Telegram limit callback_data cuma 64 karakter!
        // format 'acc_' memakan 4 char, sisa 60 char untuk ID.
        const safeOrderId = String(orderId).substring(0, 50); 

        let msg = `⚡ <b>PESANAN BARU (${type})</b>\n`;
        msg += `🆔 <code>${safeOrderId}</code>\n`;
        msg += `💰 Rp ${parseInt(total).toLocaleString()}\n`;
        msg += `👤 ${buyerContact || 'No Contact'}\n`;
        msg += `📦 ${items.length} Item(s)`;

        if (type === 'manual') {
            msg += `\n\n👇 <i>Cek mutasi lalu klik ACC:</i>`;
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, msg, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        // Data ini yang dikirim ke bot.action. Harus 'acc_' + ID
                        { text: `✅ ACC SEKARANG`, callback_data: `acc_${safeOrderId}` }
                    ]]
                }
            });
        } else {
            // Notif Auto (Midtrans)
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, msg, { parse_mode: 'HTML' });
        }

        res.status(200).json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
};
