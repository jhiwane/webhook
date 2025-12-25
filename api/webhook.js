const bot = require('../lib/botConfig');

module.exports = async (req, res) => {
    // 1. Setup CORS standar Vercel
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 2. Oper data dari Telegram ke Bot Config
        if (req.body) {
            await bot.handleUpdate(req.body);
        }
        res.status(200).json({ ok: true });
    } catch (e) {
        console.error("Webhook Error:", e);
        res.status(500).json({ error: e.message });
    }
};
