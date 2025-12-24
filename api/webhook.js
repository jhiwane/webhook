const { bot } = require('../lib/botConfig');

module.exports = async (req, res) => {
    try {
        // Handle GET request (untuk testing di browser)
        if (req.method === 'GET') {
            return res.status(200).send('Jisaeshin Webhook is Active! ⚡');
        }

        // Handle Update dari Telegram
        if (req.body) {
            await bot.handleUpdate(req.body);
        }
        
        // WAJIB response 200 OK cepat agar Telegram tidak mengirim ulang
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(200).send('Error but OK'); // Tetap 200 biar ga looping error di telegram
    }
};
