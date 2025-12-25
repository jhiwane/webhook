const bot = require('../lib/botConfig');

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
        const adminId = process.env.ADMIN_ID; 

        if (!adminId) return res.status(500).json({ error: "ADMIN_ID missing in Vercel" });

        const itemsList = items.map((i, idx) => `${idx + 1}. ${i.name} x${i.qty}`).join('\n');
        
        let message = "";
        let buttonText = "";

        // ALUR HYBRID: KEDUANYA BUTUH PROSES BOT
        if (type === 'manual') {
            message = `⚡ *ORDER BARU (MANUAL)*\n` +
                      `🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}\n` +
                      `👤 ${buyerContact}\n\n🛒 *Items:*\n${itemsList}\n\n` +
                      `_User konfirmasi sudah transfer. Klik tombol untuk Cek Stok & Proses._`;
            buttonText = "✅ ACC / PROSES DATA";
        } else {
            message = `✅ *PEMBAYARAN LUNAS (AUTO)*\n` +
                      `🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}\n` +
                      `👤 ${buyerContact}\n\n🛒 *Items:*\n${itemsList}\n\n` +
                      `_Midtrans sukses. Klik tombol untuk Cek Stok & Alokasi Data._`;
             buttonText = "🔍 PROSES / CEK STOK";
        }

        await bot.telegram.sendMessage(adminId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: buttonText, callback_data: `acc_${orderId}` }]]
            }
        });

        res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error("Notify Error:", e);
        res.status(500).json({ error: e.message });
    }
};

module.exports = allowCors(handler);
