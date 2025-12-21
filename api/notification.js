// api/notification.js (V58 - FINAL TELEGRAM & PROXY)
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto');
const cryptoJS = require('crypto-js');
const { db } = require('../lib/firebase');
const { HttpsProxyAgent } = require('https-proxy-agent');

// FUNGSI TELEGRAM PENGIRIM PESAN
async function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    // Cek apakah token ada, kalau tidak ada (lupa setting env), skip aja biar gak error
    if (!token || !chatId) return; 

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, 
            text: message,
            parse_mode: 'HTML' // Biar bisa bold/italic
        });
    } catch (e) { 
        console.error("Gagal kirim Telegram:", e.message); 
    }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const notificationJson = req.body;
    const { order_id, status_code, gross_amount, signature_key, transaction_status, custom_field1 } = notificationJson;

    // 1. Validasi Keamanan
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const inputString = order_id + status_code + gross_amount + serverKey;
    const mySignature = crypto.createHash('sha512').update(inputString).digest('hex');

    if (signature_key !== mySignature) {
       await sendTelegramAlert(`🚨 <b>BAHAYA:</b> Percobaan Hack terdeteksi di Order ID: <code>${order_id}</code>`);
       return res.status(403).json({ message: "Invalid Signature" });
    }

    // 2. Cek Status Pembayaran
    let newStatus = 'pending';
    if (transaction_status == 'capture' || transaction_status == 'settlement') newStatus = 'paid';
    else if (transaction_status == 'cancel' || transaction_status == 'expire') newStatus = 'failed';

    const orderRef = db.collection('orders').doc(order_id);
    await orderRef.update({ status: newStatus, last_updated: new Date().toISOString() });

    // 3. LOGIKA EKSEKUSI (Hanya jika PAID)
    if (newStatus === 'paid' && custom_field1) {
      try {
        const apiData = JSON.parse(custom_field1);

        if (apiData.is_api && apiData.target_url) {
            
            // LOGIKA PEMBERSIH ID (Smart ID)
            let cleanDataNo = apiData.target_data;
            let cleanZone = '';
            if (cleanDataNo.includes('(') || cleanDataNo.includes(' ')) {
                const parts = cleanDataNo.replace(/[()]/g, ' ').trim().split(/\s+/);
                if (parts.length >= 2) {
                    cleanDataNo = parts[0]; 
                    cleanZone = parts[1];
                }
            }

            await orderRef.update({ adminMessage: "🤖 System: Memulai proses..." });

            // LOGIKA UNSTOPPABLE PROXY
            let isSuccess = false;
            let lastErrorMsg = "";
            const proxyList = process.env.PROXY_URL ? process.env.PROXY_URL.split(',') : [null];
            
            for (let i = 0; i < proxyList.length; i++) {
                if (isSuccess) break;
                
                const currentProxy = proxyList[i] ? proxyList[i].trim() : null;
                const attemptLog = currentProxy ? `Proxy #${i+1}` : "Direct Connection";

                try {
                    let axiosConfig = { 
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 20000 // 20 Detik timeout
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
                            // Update Firebase
                            await orderRef.update({ 
                                adminMessage: `✅ SUKSES via ${attemptLog}! SN: ${vipRes.data.data.trxid}`, 
                                status: 'completed' 
                            });
                            // KIRIM TELEGRAM SUKSES
                            await sendTelegramAlert(
                                `💰 <b>CUAN MASUK BOS!</b>\n` +
                                `Order ID: <code>${order_id}</code>\n` +
                                `Item: ${apiData.service_code}\n` +
                                `Status: <b>SUKSES KIRIM</b> (SN: ${vipRes.data.data.trxid})\n` +
                                `Nominal: Rp ${gross_amount}`
                            );
                        } else {
                            lastErrorMsg = vipRes.data.message;
                            if(lastErrorMsg.includes('Saldo') || lastErrorMsg.includes('Produk')) break; 
                            throw new Error(`VIP Error: ${lastErrorMsg}`);
                        }
                    }
                } catch (err) {
                    console.warn(`${attemptLog} Failed: ${err.message}`);
                    lastErrorMsg = err.message;
                }
            }

            if (!isSuccess) {
                await orderRef.update({ adminMessage: `❌ GAGAL TOTAL. Error: ${lastErrorMsg}`, status: 'manual_check' });
                // KIRIM TELEGRAM GAGAL
                await sendTelegramAlert(
                    `⚠️ <b>ORDER GAGAL (BUTUH CEK)</b>\n` +
                    `Order ID: <code>${order_id}</code>\n` +
                    `Error: ${lastErrorMsg}\n` +
                    `Mohon cek Admin Panel segera!`
                );
            }
        }
      } catch (err) {
        await orderRef.update({ status: 'manual_check', adminMessage: "System Crash" });
      }
    }
    return res.status(200).send('OK');
  } catch (e) {
    return res.status(500).send('Internal Server Error');
  }
}
