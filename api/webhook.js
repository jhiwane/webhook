const { bot } = require('../lib/botConfig');

module.exports = async (req, res) => {
    try {
        if (req.body) {
            // Wajib Await agar tidak mati di tengah jalan
            await bot.handleUpdate(req.body);
        }
    } catch (e) {
        console.error("Webhook Error:", e);
    }
    // Selalu balas OK biar Telegram tidak mengulang request
    res.status(200).send('OK');
};
