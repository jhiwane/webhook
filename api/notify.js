const { Telegraf } = require('telegraf');
// Pastikan token bot disimpan di Environment Variable Vercel dengan nama TELEGRAM_BOT_TOKEN
// Dan ID Admin di TELEGRAM_ADMIN_ID
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Wrapper CORS agar aman dipanggil dari Frontend
const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    return await fn(req, res);
};

const handler = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { orderId, total, items, buyerContact, type } = req.body;
        const adminId = process.env.TELEGRAM_ADMIN_ID; // ID Telegram Admin kamu

        let message = "";
        let keyboard = null;

        // --- FORMAT PESAN ITEM ---
        const itemsList = items.map((i, idx) => 
            `${idx + 1}. ${i.name} x${i.qty}`
        ).join('\n');

        // ==========================================
        // SKENARIO 1: MANUAL (Order Baru Masuk)
        // ==========================================
        if (type === 'manual') {
            message = `⚡ *ORDER BARU (MANUAL)*\n` +
                      `🆔 \`${orderId}\`\n\n` +
                      `💰 Rp ${parseInt(total).toLocaleString('id-ID')}\n` +
                      `👤 ${buyerContact}\n\n` +
                      `🛒 *Item Dibeli:*\n${itemsList}\n\n` +
                      `_Segera cek mutasi bank/e-wallet. Klik tombol di bawah jika dana sudah masuk._`;
            
            // Tombol "Acc Admin" (Callback Data: acc_ORDERID)
            keyboard = {
                inline_keyboard: [
                    [
                        { text: "✅ ACC ADMIN / PROSES", callback_data: `acc_${orderId}` }
                    ]
                ]
            };
        } 
        
        // ==========================================
        // SKENARIO 2: AUTO (Pembayaran Sukses via Midtrans)
        // ==========================================
        else {
            message = `✅ *PEMBAYARAN SUKSES (AUTO)*\n` +
                      `🆔 Order ID: \`${orderId}\`\n\n` +
                      `💰 Total: Rp ${parseInt(total).toLocaleString('id-ID')}\n` +
                      `👤 Kontak: ${buyerContact}\n\n` +
                      `🛒 *Item Dibeli:*\n${itemsList}\n\n` +
                      `_Stok otomatis terpotong (jika tersedia). Cek dashboard untuk detail._`;
            
            // Auto biasanya tidak butuh tombol ACC, tapi bisa ditambah tombol cek
            keyboard = {
                inline_keyboard: [
                    [{ text: "🔍 Cek Detail", callback_data: `cek_${orderId}` }]
                ]
            };
        }

        // KIRIM KE TELEGRAM
        await bot.telegram.sendMessage(adminId, message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

        res.status(200).json({ status: 'Notification Sent' });

    } catch (error) {
        console.error("Telegram Error:", error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = allowCors(handler);
