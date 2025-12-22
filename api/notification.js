// api/notification.js (V61 - ULTIMATE HYBRID: DATABASE BACKUP NOTIF)
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto');
const cryptoJS = require('crypto-js');
const { db } = require('../lib/firebase'); 
const { HttpsProxyAgent } = require('https-proxy-agent');

// --- FUNGSI KIRIM TELEGRAM ---
async function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) return; 

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, 
            text: message,
            parse_mode: 'HTML'
        });
    } catch (e) { 
        console.error("Gagal kirim Telegram:", e.message); 
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
       await sendTelegramAlert(`🚨 <b>BAHAYA:</b> Percobaan Hack di Order ID: <code>${order_id}</code>`);
       return res.status(403).json({ message: "Invalid Signature" });
    }

    // 2. CEK STATUS & UPDATE DATABASE
    let newStatus = 'pending';
    if (transaction_status == 'capture' || transaction_status == 'settlement') newStatus = 'paid';
    else if (transaction_status == 'cancel' || transaction_status == 'expire') newStatus = 'failed';

    const orderRef = db.collection('orders').doc(order_id);
    await orderRef.update({ status: newStatus, last_updated: new Date().toISOString() });

    // 3. LOGIKA NOTIFIKASI & EKSEKUSI (Hanya jika LUNAS / PAID)
    if (newStatus === 'paid') {
      try {
        // --- [V61 FITUR BARU] AMBIL DATA LANGSUNG DARI FIREBASE ---
        // Ini menjamin kita punya data produk walau custom_field1 kosong
        const orderSnap = await orderRef.get();
        if (!orderSnap.exists) throw new Error("Order data not found in DB");
        const orderData = orderSnap.data();
        
        // Ambil item pertama sebagai referensi info
        const mainItem = orderData.items && orderData.items.length > 0 ? orderData.items[0] : { name: 'Unknown Item' };
        const userNote = mainItem.note || '-';

        // Cek apakah ada instruksi API di custom_field1
        let isApiTransaction = false;
        let apiData = null;

        if (custom_field1) {
            try {
                apiData = JSON.parse(custom_field1);
                if (apiData.is_api && apiData.target_url) {
                    isApiTransaction = true;
                }
            } catch (e) {
                console.log("Not API Json");
            }
        }

        // ==========================================
        // JALUR 1: TRANSAKSI API (OTOMATIS)
        // ==========================================
        if (isApiTransaction) {
            
            let cleanDataNo = apiData.target_data;
            let cleanZone = '';
            // Smart Cleaner ID
            if (cleanDataNo.includes('(') || cleanDataNo.includes(' ')) {
                const parts = cleanDataNo.replace(/[()]/g, ' ').trim().split(/\s+/);
                if (parts.length >= 2) { cleanDataNo = parts[0]; cleanZone = parts[1]; }
            }

            await orderRef.update({ adminMessage: "🤖 System: Pembayaran diterima. Memproses otomatis..." });

            // Proxy Logic
            let isSuccess = false;
            let lastErrorMsg = "";
            const proxyList = process.env.PROXY_URL ? process.env.PROXY_URL.split(',') : [null];
            
            for (let i = 0; i < proxyList.length; i++) {
                if (isSuccess) break;
                const currentProxy = proxyList[i] ? proxyList[i].trim() : null;
                const attemptLog = currentProxy ? `Proxy #${i+1}` : "Direct";

                try {
                    let axiosConfig = { 
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 30000 
                    };
                    if (currentProxy) {
                        axiosConfig.httpsAgent = new HttpsProxyAgent(currentProxy);
                        axiosConfig.proxy = false; 
                    }

                    if (apiData.target_url.includes('vip-reseller')) {
                        const vipId = process.env.VIP_API_ID;
                        const vipKey = process.env.VIP_API_KEY;
                        const sign = cryptoJS.MD5(vipId + vipKey).toString();
                        const formData = new URLSearchParams();
                        formData.append('key', vipKey);
                        formData.append('sign', sign);
                        formData.append('type', 'order');
                        formData.append('service', apiData.service_code);
                        formData.append('data_no', cleanDataNo);
                        if(cleanZone) formData.append('data_zone', cleanZone);

                        const vipRes = await axios.post(apiData.target_url, formData, axiosConfig);
                        
                        if(vipRes.data && vipRes.data.result) {
                            isSuccess = true;
                            const resData = vipRes.data.data;
                            let contentData = resData.sn || resData.note || resData.trxid || "Data terkirim";
                            contentData = contentData.replace(/^Sukses\s+/i, '');

                            await orderRef.update({ 
                                adminMessage: `✅ SUKSES via ${attemptLog}! SN: ${contentData}`, 
                                status: 'completed' 
                            });

                            await sendTelegramAlert(
                                `🤖 <b>ORDER AUTO SUKSES!</b>\n` +
                                `ID: <code>${order_id}</code>\n` +
                                `Item: ${mainItem.name}\n` +
                                `Data: <code>${contentData}</code>\n` +
                                `Rp ${gross_amount}`
                            );
                        } else {
                            lastErrorMsg = vipRes.data.message;
                            if(lastErrorMsg.toLowerCase().includes('saldo') || lastErrorMsg.toLowerCase().includes('produk')) break; 
                        }
                    }
                } catch (err) {
                    lastErrorMsg = err.message;
                }
            } 

            if (!isSuccess) {
                await orderRef.update({ adminMessage: `❌ GAGAL AUTO. ${lastErrorMsg}`, status: 'manual_check' });
                await sendTelegramAlert(
                    `⚠️ <b>AUTO GAGAL!</b>\nID: <code>${order_id}</code>\nErr: ${lastErrorMsg}\n<i>Cek Manual!</i>`
                );
            }

        } 
        // ==========================================
        // JALUR 2: TRANSAKSI MANUAL (FALLBACK & NORMAL)
        // ==========================================
        else {
            // Ini akan jalan jika:
            // 1. Produk memang manual
            // 2. ATAU custom_field1 hilang/error (Backup Plan)
            
            await orderRef.update({ adminMessage: "📦 Order Manual Lunas. Menunggu proses admin..." });

            await sendTelegramAlert(
                `📦 <b>ORDER MANUAL MASUK!</b>\n` +
                `---------------------------\n` +
                `Order ID: <code>${order_id}</code>\n` +
                `Item: <b>${mainItem.name}</b>\n` +
                `Qty: ${mainItem.qty}\n` +
                `Catatan/Data: <code>${userNote}</code>\n` +
                `Total: Rp ${gross_amount}\n` +
                `---------------------------\n` +
                `⚡ <b>UANG SUDAH MASUK, SEGERA PROSES!</b>`
            );
        }

      } catch (err) {
        console.error("System Crash:", err);
        // Notif jika backend crash total pun akan dikirim
        await sendTelegramAlert(`🔥 <b>SYSTEM ERROR</b> di Order: ${order_id}\n${err.message}`);
      }
    }
    return res.status(200).send('OK');
  } catch (e) {
    console.error("Global Error:", e);
    return res.status(500).send('Internal Server Error');
  }
}
