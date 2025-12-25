const bot = require('../lib/botConfig');

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
        
        // --- PERBAIKAN DI SINI ---
        // Menggunakan variabel generic ADMIN_ID. 
        // Jika ini kosong di Vercel, maka error chat_id empty muncul lagi.
        const adminId = process.env.ADMIN_ID; 

        if (!adminId) {
            console.error("ADMIN_ID belum di-set di Vercel!");
            return res.status(500).json({ error: "Server Configuration Error: ADMIN_ID missing" });
        }

        const itemsList = items.map((i, idx) => `${idx + 1}. ${i.name} x${i.qty}`).join('\n');
        
        let message = "";
        let keyboard = null;

        if (type === 'manual') {
            message = `⚡ *ORDER BARU (MANUAL)*\n` +
                      `🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}\n` +
                      `👤 ${buyerContact}\n\n🛒 *Items:*\n${itemsList}\n\n` +
                      `_Segera cek mutasi. Klik ACC jika dana masuk._`;
            
            keyboard = {
                inline_keyboard: [[{ text: "✅ ACC ADMIN / PROSES", callback_data: `acc_${orderId}` }]]
            };

        } else {
            message = `✅ *PEMBAYARAN SUKSES (AUTO)*\n` +
                      `🆔 \`${orderId}\`\n💰 Rp ${parseInt(total).toLocaleString()}\n` +
                      `👤 ${buyerContact}\n\n🛒 *Items:*\n${itemsList}\n\n` +
                      `_Stok otomatis terpotong._`;
        }

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
