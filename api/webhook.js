const bot = require('../lib/botConfig');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        if (req.body) await bot.handleUpdate(req.body);
        res.status(200).json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
};
