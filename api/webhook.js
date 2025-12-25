const { bot } = require('../lib/botConfig');

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            // VERCEL: Kita WAJIB await ini sampai selesai agar DB Transaction tidak mati
            await bot.handleUpdate(req.body);
        }
        res.status(200).send('OK');
    } catch (e) {
        console.error("Webhook Error:", e);
        res.status(500).send('Error');
    }
};
