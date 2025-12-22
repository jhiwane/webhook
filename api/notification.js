// api/notification.js (V64 - DEBUGGER & ANTI-SILENT)
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto');
// const cryptoJS = require('crypto-js'); // Opsional, nyalakan jika perlu sign MD5
const { db } = require('../lib/firebase'); 
const { HttpsProxyAgent } = require('https-proxy-agent');

// --- FUNGSI TELEGRAM (ANTI ERROR) ---
async function sendTelegramAlert(message, useHtml = true) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) return console.error("❌ Token/ChatID Kosong!");

    try {
        const payload = {
            chat_id: chatId, 
            text: message
        };
        if (useHtml) payload.parse_mode = 'HTML';

        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, payload);
    } catch (e) { 
        console.error("Gagal kirim Tele:", e.message); 
    }
}

// --- HANDLER UTAMA ---
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const notificationJson = req.body;
    const { order_id, status_code, gross_amount, signature_key, transaction_status, custom_field1 } = notificationJson;

    // 1. VALIDASI KEAMANAN
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const inputString = order_id + status_code + gross_amount + serverKey;
    const mySignature = crypto.createHash('sha512').update(inputString).digest('hex');

    if (signature_key !== mySignature) {
       await sendTelegramAlert(`🚨 <b>BAHAYA:</b> Hack Signature di ID: ${order_id}`);
       return res.status(403).json({ message: "Invalid Signature" });
    }

    // 2. CEK STATUS
    let newStatus = 'pending';
    if (transaction_status == 'capture' || transaction_status == 'settlement') newStatus = 'paid';
    else if (transaction_status == 'cancel' || transaction_status == 'expire') newStatus = 'failed';

    const orderRef = db.collection('orders').doc(order_id);
    await orderRef.update({ status: newStatus, last_updated: new Date().toISOString() });

    // 3. LOGIKA EKSEKUSI (KHUSUS PAID)
    if (newStatus === 'paid') {
        
        // [DEBUG V64] KIRIM SINYAL PERTAMA (Tanpa Logika)
        // Jika pesan ini masuk, berarti Midtrans & Bot AMAN.
        await sendTelegramAlert(`🔔 <b>Pembayaran Masuk!</b>\nID: ${order_id}\nRp ${gross_amount}\n<i>Memproses data...</i>`);

        try {
            // Ambil Data Order
            const orderSnap = await orderRef.get();
            if (!orderSnap.exists) throw new Error("Data Order tidak ditemukan di Firebase");
            
            const orderData = orderSnap.data();
            const mainItem = orderData.items?.[0] || { name: 'Unknown Item', processType: 'MANUAL' };
            const userNote = mainItem.note || '-';
            
            // Cek Tipe: API atau MANUAL
            const isProcessApi = mainItem.processType === 'EXTERNAL_API';

            // --- JALUR OTOMATIS (API) ---
            if (isProcessApi) {
                let apiData = null;
                try { apiData = JSON.parse(custom_field1); } catch(e) {}

                // Jika data API rusak, JANGAN ERROR, tapi pindah ke Manual
                if (!apiData || !apiData.target_url) {
                    throw new Error("Data API (custom_field1) tidak valid, alihkan ke Manual.");
                }

                // ... (Logika Proxy VIP Reseller Disini - Dipersingkat agar tidak error syntax) ...
                // Anda bisa paste logika proxy V60 disini jika perlu, 
                // TAPI saran saya tes dulu tanpa proxy kompleks di V64 ini untuk memastikan notif jalan.
                
                // SEMENTARA KITA BUAT SIMPLE UNTUK TES V64:
                // Jika ingin full proxy, replace blok ini dengan V60 nanti setelah V64 sukses.
                await orderRef.update({ adminMessage: "⚠️ Fitur API sedang maintenance, cek manual." });
                throw new Error("Mode Debug: Paksa pindah ke notif Manual untuk tes.");

            } 
            
            // --- JALUR MANUAL (ATAU JIKA API GAGAL) ---
            else {
                // Notif Manual
                await orderRef.update({ adminMessage: "📦 Order Manual Lunas. Menunggu proses..." });

                await sendTelegramAlert(
                    `📦 <b>ORDER MANUAL / CEK ADMIN</b>\n` +
                    `---------------------------\n` +
                    `Order ID: <code>${order_id}</code>\n` +
                    `Item: <b>${mainItem.name}</b>\n` +
                    `Data User: <code>${userNote}</code>\n` +
                    `Nominal: Rp ${gross_amount}\n` +
                    `---------------------------\n` +
                    `⚡ <b>UANG SUDAH MASUK!</b>`
                );
            }

        } catch (err) {
            // ERROR HANDLER (Tanpa HTML agar tidak ditolak Telegram)
            console.error("Logic Error:", err);
            
            // Fallback terakhir: Kirim notif error sebagai tanda ada order
            await sendTelegramAlert(
                `⚠️ ORDER MASUK (LOGIC ERROR)\n` + 
                `ID: ${order_id}\n` +
                `Err: ${err.message}\n` +
                `Uang sudah masuk, tolong cek database/midtrans manual.`, 
                false // False = Jangan pakai HTML Mode (Plain text)
            );
        }
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error("Global Error:", e);
    return res.status(500).send('Internal Server Error');
  }
}
