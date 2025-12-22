// api/notification.js (V63 - FIXED MANUAL NOTIF)
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto');
const cryptoJS = require('crypto-js');
const { db } = require('../lib/firebase'); 
const { HttpsProxyAgent } = require('https-proxy-agent');

// FUNGSI KIRIM TELEGRAM
async function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; 
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML'
        });
    } catch (e) { console.error("Tele Error:", e.message); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const notificationJson = req.body;
    const { order_id, status_code, gross_amount, signature_key, transaction_status, custom_field1 } = notificationJson;

    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const inputString = order_id + status_code + gross_amount + serverKey;
    const mySignature = crypto.createHash('sha512').update(inputString).digest('hex');

    if (signature_key !== mySignature) return res.status(403).json({ message: "Invalid Signature" });

    let newStatus = 'pending';
    if (transaction_status == 'capture' || transaction_status == 'settlement') newStatus = 'paid';
    else if (transaction_status == 'cancel' || transaction_status == 'expire') newStatus = 'failed';

    const orderRef = db.collection('orders').doc(order_id);
    await orderRef.update({ status: newStatus, last_updated: new Date().toISOString() });

    // --- LOGIKA UTAMA V63 ---
    // Perhatikan: HANYA cek newStatus === 'paid'. HAPUS "&& custom_field1"!
    if (newStatus === 'paid') {
      try {
        const orderSnap = await orderRef.get();
        if (!orderSnap.exists) throw new Error("Order not found in DB");
        
        const orderData = orderSnap.data();
        const mainItem = orderData.items?.[0] || { name: 'Unknown', processType: 'MANUAL' };
        const userNote = mainItem.note || '-';
        
        // Cek apakah API atau Manual DARI DATABASE, bukan dari Midtrans
        const isProcessApi = mainItem.processType === 'EXTERNAL_API';

        if (isProcessApi) {
            // ... (LOGIKA API / PROXY SAMA SEPERTI SEBELUMNYA) ...
            // Pastikan custom_field1 ada karena API butuh target_url
            let apiData = null;
            try { apiData = JSON.parse(custom_field1); } catch(e) {}

            if (apiData && apiData.target_url) {
                // ... Jalankan logika Proxy & VIP Reseller disini ...
                // (Kode proxy v60/v61 bisa dipaste disini)
                
                // CONTOH SINGKAT (Bisa pakai full code V60 di bagian ini):
                await orderRef.update({ adminMessage: "🤖 Memproses API..." });
                // ... logic proxy ...
                // Jika sukses: sendTelegramAlert("ORDER AUTO SUKSES...");
            }
        } 
        else {
            // === JALUR MANUAL (YANG SEBELUMNYA GAGAL) ===
            // Code ini sekarang PASTI JALAN karena tidak dicegah oleh custom_field1
            await orderRef.update({ adminMessage: "📦 Order Manual Lunas. Menunggu proses admin..." });

            await sendTelegramAlert(
                `📦 <b>ORDER MANUAL MASUK!</b>\n` +
                `---------------------------\n` +
                `Order ID: <code>${order_id}</code>\n` +
                `Item: <b>${mainItem.name}</b>\n` +
                `Data: <code>${userNote}</code>\n` +
                `Rp ${gross_amount}\n` +
                `---------------------------\n` +
                `⚡ <b>UANG SUDAH MASUK!</b>`
            );
        }
      } catch (err) {
        await sendTelegramAlert(`🔥 <b>SYSTEM ERROR</b> ${order_id}: ${err.message}`);
      }
    }
    return res.status(200).send('OK');
  } catch (e) {
    return res.status(500).send('Server Error');
  }
}
