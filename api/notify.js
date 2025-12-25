// api/notify.js
const { db, admin } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');

// Ganti dengan Chat ID Admin kamu (bisa grup atau personal)
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID; 

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { orderId, type, buyerContact, message } = req.body;

    try {
        // 1. Handle Komplain
        if (type === 'complaint') {
            const text = `⚠️ <b>KOMPLAIN BARU!</b>\nOrder ID: <code>${orderId}</code>\nKontak: ${buyerContact}\nPesan: ${message}\n\n👉 <i>Reply pesan ini untuk membalas ke web pembeli.</i>`;
            await sendMessage(ADMIN_CHAT_ID, text);
            return res.status(200).json({ status: 'ok' });
        }

        // 2. Ambil Data Order
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found' });
        const orderData = orderSnap.data();

        // 3. Logic Notifikasi Pembayaran Manual
        if (type === 'manual') {
            const itemsList = orderData.items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
            const msg = `💸 <b>PEMBAYARAN MANUAL MASUK</b>\n` +
                        `ID: <code>${orderId}</code>\n` +
                        `Total: Rp ${orderData.total.toLocaleString()}\n` +
                        `Kontak: ${buyerContact}\n\n` +
                        `🛒 <b>Items:</b>\n${itemsList}\n\n` +
                        `👇 <b>TINDAKAN:</b>\nCek mutasi bank/e-wallet. Jika masuk, klik ACC di bawah.`;

            // Kirim pesan dengan tombol ACC ke Telegram
            await sendMessage(ADMIN_CHAT_ID, msg, {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "✅ ACC PEMBAYARAN", callback_data: `ACC_${orderId}` },
                        { text: "❌ TOLAK", callback_data: `REJECT_${orderId}` }
                    ]]
                }
            });
        } 
        
        // Logic 'auto' (saat user sudah bayar QRIS tapi stok habis/manual proses) akan dihandle via Midtrans Webhook atau trigger manual acc
        
        return res.status(200).json({ success: true });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}
