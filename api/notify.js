const { bot } = require('../lib/botConfig');
const { db } = require('../lib/firebaseConfig'); // Opsional jika mau update DB di sini
const NOTIF_CHAT_ID = process.env.ADMIN_ID; 

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const body = req.body;

        // --- A. JIKA DARI MIDTRANS (Webhook Pembayaran) ---
        if (body.transaction_status) {
            const orderId = body.order_id;
            const status = body.transaction_status;
            
            // Jika sukses bayar
            if (status === 'capture' || status === 'settlement') {
                // Update DB jadi PAID
                await db.collection('orders').doc(orderId).update({ 
                    status: 'paid',
                    paymentMethod: 'MIDTRANS'
                });
                
                // Kirim notif ke Admin (Opsional: Trigger VIP disini kalau mau Auto-Instant)
                // Untuk sekarang kita notif saja, admin bisa klik ACC untuk proses VIP
                await bot.telegram.sendMessage(NOTIF_CHAT_ID, 
                    `💰 <b>PEMBAYARAN DITERIMA (MIDTRANS)</b>\n🆔 ${orderId}\nStatus: PAID\n\n👇 Klik untuk proses item:`, 
                    {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: "🚀 PROSES ORDER", callback_data: `acc_${orderId}` }]] }
                    }
                );
            }
            return res.status(200).send('OK');
        }

        // --- B. JIKA DARI FRONTEND (Manual Order / Komplain) ---
        const { orderId, total, items, type, buyerContact, message } = body;
        const safeId = String(orderId).substring(0, 50);

        if (type === 'complaint') {
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, 
                `🚨 <b>KOMPLAIN USER</b>\n🆔 ${safeId}\n👤 ${buyerContact}\n💬 "${message}"`, 
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "↩️ BALAS", callback_data: `reply_complain_${safeId}` }]] } }
            );
        } 
        else {
            // Notifikasi Order Baru (Manual)
            let msg = `⚡ <b>ORDER BARU (MANUAL)</b>\n🆔 <code>${safeId}</code>\n💰 Rp ${parseInt(total).toLocaleString()}\n👤 ${buyerContact}`;
            await bot.telegram.sendMessage(NOTIF_CHAT_ID, msg, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "✅ ACC SEKARANG", callback_data: `acc_${safeId}` }]] }
            });
        }

        res.status(200).json({ success: true });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
};
