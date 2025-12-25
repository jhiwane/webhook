const bot = require('../lib/botConfig'); // Import bot yang sudah dicoding di atas

// Wrapper CORS
const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    return await fn(req, res);
};

const handler = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { orderId, total, items, buyerContact, type } = req.body;
        const adminId = process.env.TELEGRAM_ADMIN_ID;

        // Format List Item
        const itemsList = items.map((i, idx) => `${idx + 1}. ${i.name} x${i.qty}`).join('\n');
        
        let message = "";
        let keyboard = null;

        // --- LOGIC PEMISAH (MANUAL vs AUTO) ---

        if (type === 'manual') {
            // SKENARIO MANUAL: Ada tombol ACC
            message = `⚡ *ORDER BARU (MANUAL)*\n` +
                      `🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}\n` +
                      `👤 ${buyerContact}\n\n🛒 *Items:*\n${itemsList}\n\n` +
                      `_Segera cek mutasi. Klik ACC jika dana masuk._`;
            
            keyboard = {
                inline_keyboard: [[{ text: "✅ ACC ADMIN / PROSES", callback_data: `acc_${orderId}` }]]
            };

        } else {
            // SKENARIO AUTO (Midtrans): Info saja
            message = `✅ *PEMBAYARAN SUKSES (AUTO)*\n` +
                      `🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}\n` +
                      `👤 ${buyerContact}\n\n🛒 *Items:*\n${itemsList}\n\n` +
                      `_Stok otomatis terpotong._`;
             // Tidak perlu tombol ACC karena sudah lunas otomatis
        }

        // Kirim ke Telegram
        await bot.telegram.sendMessage(adminId, message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

        res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("Notify Error:", e);
        res.status(500).json({ error: e.message });
    }
};

module.exports = allowCors(handler);
