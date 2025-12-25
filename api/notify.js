const { bot } = require('../lib/botConfig');
const NOTIF_CHAT_ID = process.env.ADMIN_ID; 

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { orderId, total, items, type, buyerContact, message } = req.body;
        const safeId = String(orderId).substring(0, 50);

        // --- HANDLING KOMPLAIN ---
        if (type === 'complaint') {
            const text = `🚨 <b>KOMPLAIN MASUK</b>\n\n🆔 <code>${safeId}</code>\n👤 ${buyerContact}\n\n💬 Pesan:\n"${message}"`;
            
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        // Tombol ini memicu ForceReply di botConfig
                        { text: `↩️ BALAS PESAN`, callback_data: `reply_complain_${safeId}` }
                    ]]
                }
            });
            return res.status(200).json({ success: true });
        }

        // --- HANDLING ORDER BARU ---
        const isManual = type === 'manual';
        let text = `⚡ <b>PESANAN BARU (${isManual ? 'MANUAL' : 'AUTO'})</b>\n\n`;
        text += `🆔 <code>${safeId}</code>\n`;
        text += `💰 Rp ${parseInt(total).toLocaleString('id-ID')}\n`;
        text += `👤 ${buyerContact || '-'}\n`;
        text += `📦 ${items.length} Item(s)`;

        if (isManual) {
            text += `\n\n👇 <i>Cek mutasi lalu klik ACC:</i>`;
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `✅ ACC SEKARANG`, callback_data: `acc_${safeId}` }
                    ]]
                }
            });
        } else {
            // Jika Auto, info saja (opsional kasih tombol cek stok)
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, text, { parse_mode: 'HTML' });
        }

        res.status(200).json({ success: true });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
};
