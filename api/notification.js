const midtransClient = require('midtrans-client');
const { Telegraf } = require('telegraf');

// 1. SETUP BOT (Sesuai koreksi Anda: BOT_TOKEN)
const bot = new Telegraf(process.env.BOT_TOKEN);

// PENTING: Ganti 'ADMIN_ID' di bawah ini sesuai nama variable di .env Anda
// Ini adalah ID akun Telegram Anda (angka) tempat bot akan melapor.
const ADMIN_CHAT_ID = process.env.ADMIN_ID; 

module.exports = async (req, res) => {
    // CORS & Method Check
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 2. SETUP MIDTRANS CORE (Verifikator)
        let apiClient = new midtransClient.CoreApi({
            isProduction: true,
            serverKey: process.env.MIDTRANS_SERVER_KEY,
            clientKey: process.env.MIDTRANS_CLIENT_KEY
        });

        // 3. TERIMA NOTIFIKASI
        const notificationJson = req.body;
        
        // Cek status ke server Midtrans (Double Check Security)
        let statusResponse = await apiClient.transaction.notification(notificationJson);

        let orderId = statusResponse.order_id;
        let transactionStatus = statusResponse.transaction_status;
        let fraudStatus = statusResponse.fraud_status;
        let grossAmount = statusResponse.gross_amount;
        let paymentType = statusResponse.payment_type;

        console.log(`Notif Masuk: Order ${orderId} | Status: ${transactionStatus}`);

        // 4. LOGIKA STATUS & PESAN TELEGRAM
        let message = '';
        
        // Template Pesan Rapi
        const formatMessage = (statusEmoji, title, detailStatus) => {
            return `${statusEmoji} <b>${title}</b>\n` +
                   `📦 Order ID: <code>${orderId}</code>\n` +
                   `💰 Total: Rp ${parseInt(grossAmount).toLocaleString('id-ID')}\n` +
                   `💳 Metode: ${paymentType}\n` +
                   `ℹ️ Status: ${detailStatus}`;
        };

        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                message = formatMessage('⚠️', 'Pembayaran Perlu Tinjauan', 'Challenge (Cek Dashboard Midtrans)');
            } else if (fraudStatus == 'accept') {
                message = formatMessage('✅', 'Pembayaran Sukses (Kartu)', 'Lunas / Settlement');
            }
        } else if (transactionStatus == 'settlement') {
            message = formatMessage('✅', 'Pembayaran Diterima', 'Lunas / Settlement');
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            message = formatMessage('❌', 'Pembayaran Gagal/Batal', transactionStatus.toUpperCase());
        } else if (transactionStatus == 'pending') {
            // Opsional: Aktifkan jika ingin notif saat user baru klik "Bayar" tapi belum transfer
            // message = formatMessage('⏳', 'Menunggu Pembayaran', 'Pending');
        }

        // 5. KIRIM KE TELEGRAM (Jika ada pesan)
        if (message) {
            if (!ADMIN_CHAT_ID) {
                console.error("ADMIN_ID belum diset di .env, pesan tidak terkirim.");
            } else {
                await bot.telegram.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'HTML' });
            }
        }

        // 6. RESPON KE MIDTRANS (Wajib 200 OK)
        res.status(200).json({ status: 'OK' });

    } catch (e) {
        console.error("Webhook Error:", e.message);
        res.status(200).json({ status: 'Error handled', error: e.message });
    }
};
