const midtransClient = require('midtrans-client');
const { Telegraf } = require('telegraf');

// Inisialisasi Bot Telegram (Gunakan Token dari @BotFather)
const bot = new Telegraf(process.env.BOT_TOKEN);
// ID Admin atau Group tempat notifikasi akan dikirim
const ADMIN_CHAT_ID = process.env.ADMIN_ID; 

module.exports = async (req, res) => {
    // CORS Setup (Standard)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 1. Inisialisasi Core API untuk verifikasi notifikasi
        let apiClient = new midtransClient.CoreApi({
            isProduction: true,
            serverKey: process.env.MIDTRANS_SERVER_KEY,
            clientKey: process.env.MIDTRANS_CLIENT_KEY
        });

        // 2. Terima Notifikasi dari Midtrans
        const notificationJson = req.body;
        
        // Cek status transaksi langsung dari Server Midtrans (Verifikasi Keamanan)
        // Ini mencegah hacker memalsukan status bayar.
        let statusResponse = await apiClient.transaction.notification(notificationJson);

        let orderId = statusResponse.order_id;
        let transactionStatus = statusResponse.transaction_status;
        let fraudStatus = statusResponse.fraud_status;
        let grossAmount = statusResponse.gross_amount;

        console.log(`Transaction notification received. Order: ${orderId}. Status: ${transactionStatus}`);

        // 3. Logika Status Pembayaran
        let message = '';
        let isSuccess = false;

        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                message = `⚠️ <b>Pembayaran Challenge</b>\nOrder ID: ${orderId}\nPerlu tinjauan manual.`;
            } else if (fraudStatus == 'accept') {
                isSuccess = true;
                message = `✅ <b>Pembayaran Sukses (Card)</b>\nOrder ID: <code>${orderId}</code>\nTotal: Rp ${grossAmount}\nStatus: Lunas`;
            }
        } else if (transactionStatus == 'settlement') {
            isSuccess = true;
            message = `✅ <b>Pembayaran Sukses</b>\nOrder ID: <code>${orderId}</code>\nTotal: Rp ${grossAmount}\nStatus: Lunas (Settlement)`;
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            message = `❌ <b>Pembayaran Gagal/Batal</b>\nOrder ID: ${orderId}\nStatus: ${transactionStatus}`;
        } else if (transactionStatus == 'pending') {
            message = `⏳ <b>Menunggu Pembayaran</b>\nOrder ID: ${orderId}\nStatus: Pending`;
        }

        // 4. Kirim ke Telegram (Hanya jika ada pesan yang relevan)
        if (message) {
            try {
                // Mengirim ke Admin/Group Toko
                await bot.telegram.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'HTML' });
                
                // Jika ingin mengirim ke customer (jika Order ID mengandung ID telegram, contoh format: ORDER-123-USERID)
                // const userId = orderId.split('-')[2]; 
                // if(userId) await bot.telegram.sendMessage(userId, "Pembayaran Anda telah kami terima!");
                
            } catch (tgError) {
                console.error("Gagal kirim ke Telegram:", tgError);
            }
        }

        // 5. Response OK ke Midtrans (Wajib, agar Midtrans tidak mengirim ulang notifikasi terus menerus)
        res.status(200).json({ status: 'OK' });

    } catch (e) {
        console.error("Webhook Error:", e);
        // Tetap return 200 agar Midtrans tidak menganggap server kita mati, tapi catat errornya di logs
        res.status(200).json({ status: 'Error processed', detail: e.message });
    }
};
