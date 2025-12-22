// api/manual.js (BACKEND KHUSUS NOTIF MANUAL)
const axios = require('axios');

export default async function handler(req, res) {
    // Ijinkan akses dari mana saja
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { order_id, total, item_name, sender_name } = req.body;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) return res.status(500).json({ error: "Config Missing" });

    try {
        const message = 
            `🔔 <b>KONFIRMASI PEMBAYARAN MANUAL!</b>\n` +
            `---------------------------\n` +
            `🆔 ID: <code>${order_id}</code>\n` +
            `📦 Item: <b>${item_name}</b>\n` +
            `💰 Nominal: <b>Rp ${parseInt(total).toLocaleString()}</b>\n` +
            `👤 Pengirim: ${sender_name || 'Tanpa Nama'}\n` +
            `---------------------------\n` +
            `<i>User mengaku sudah transfer. Cek mutasi rekening Anda sekarang!</i>\n` +
            `👉 <b>Jika masuk, Klik ACC di Admin Panel.</b>`;

        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });

        return res.status(200).json({ status: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
