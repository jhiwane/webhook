// api/notification.js (V60 - ULTIMATE: MANUAL NOTIF, PROXY, SECURE DATA)
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto');
const cryptoJS = require('crypto-js');
// Pastikan path ini benar sesuai struktur folder Vercel Anda
const { db } = require('../lib/firebase'); 
const { HttpsProxyAgent } = require('https-proxy-agent');

// --- FUNGSI KIRIM TELEGRAM ---
async function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    // Validasi token agar tidak crash jika env belum diisi
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

    // 1. VALIDASI KEAMANAN (Signature Key Midtrans)
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const inputString = order_id + status_code + gross_amount + serverKey;
    const mySignature = crypto.createHash('sha512').update(inputString).digest('hex');

    if (signature_key !== mySignature) {
       await sendTelegramAlert(`🚨 <b>BAHAYA:</b> Percobaan Hack terdeteksi di Order ID: <code>${order_id}</code>`);
       return res.status(403).json({ message: "Invalid Signature" });
    }

    // 2. CEK STATUS PEMBAYARAN MIDTRANS
    let newStatus = 'pending';
    if (transaction_status == 'capture' || transaction_status == 'settlement') newStatus = 'paid';
    else if (transaction_status == 'cancel' || transaction_status == 'expire') newStatus = 'failed';

    const orderRef = db.collection('orders').doc(order_id);
    // Update status dasar dulu agar user tahu pembayaran masuk
    await orderRef.update({ status: newStatus, last_updated: new Date().toISOString() });

    // 3. LOGIKA EKSEKUSI (Hanya jika Status PAID)
    if (newStatus === 'paid' && custom_field1) {
      try {
        const apiData = JSON.parse(custom_field1);

        // ==========================================
        // CABANG LOGIKA: API (AUTO) VS MANUAL
        // ==========================================

        if (apiData.is_api && apiData.target_url) {
            // ---> KASUS 1: PRODUK API / OTOMATIS (VIP RESELLER)
            
            // A. LOGIKA PEMBERSIH NOMOR (Smart ID)
            let cleanDataNo = apiData.target_data;
            let cleanZone = '';
            if (cleanDataNo.includes('(') || cleanDataNo.includes(' ')) {
                const parts = cleanDataNo.replace(/[()]/g, ' ').trim().split(/\s+/);
                if (parts.length >= 2) {
                    cleanDataNo = parts[0]; 
                    cleanZone = parts[1];
                }
            }

            await orderRef.update({ adminMessage: "🤖 System: Pembayaran diterima. Memproses pesanan..." });

            // B. LOGIKA ROTASI PROXY (Anti-Limit)
            let isSuccess = false;
            let lastErrorMsg = "";
            // Ambil list proxy dari ENV, pisahkan dengan koma
            const proxyList = process.env.PROXY_URL ? process.env.PROXY_URL.split(',') : [null];
            
            for (let i = 0; i < proxyList.length; i++) {
                if (isSuccess) break; // Jika sudah sukses, berhenti loop
                
                const currentProxy = proxyList[i] ? proxyList[i].trim() : null;
                const attemptLog = currentProxy ? `Proxy #${i+1}` : "Direct Connection";

                try {
                    // Config Axios dengan Proxy
                    let axiosConfig = { 
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 30000 // 30 Detik timeout
                    };

                    if (currentProxy) {
                        axiosConfig.httpsAgent = new HttpsProxyAgent(currentProxy);
                        axiosConfig.proxy = false; 
                    }

                    // Cek Provider (VIP Reseller)
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

                        // TEMBAK API VIP
                        const vipRes = await axios.post(apiData.target_url, formData, axiosConfig);
                        
                        // Cek Respon VIP
                        if(vipRes.data && vipRes.data.result) {
                            isSuccess = true;
                            const resData = vipRes.data.data;

                            // >>> SMART DATA CAPTURE (Prioritas SN > Note > TRXID) <<<
                            let contentData = resData.sn || resData.note || resData.trxid || "Data terkirim";
                            contentData = contentData.replace(/^Sukses\s+/i, '');

                            // Update ke Firebase (Data ini dibaca Frontend V56)
                            await orderRef.update({ 
                                adminMessage: `✅ SUKSES via ${attemptLog}! SN: ${contentData}`, 
                                status: 'completed' 
                            });

                            // TELEGRAM: Notif Sukses API
                            await sendTelegramAlert(
                                `🤖 <b>ORDER AUTO SUKSES!</b>\n` +
                                `Order ID: <code>${order_id}</code>\n` +
                                `Produk: ${apiData.service_code}\n` +
                                `Tujuan: ${cleanDataNo}\n` +
                                `---------------------------\n` +
                                `<b>DATA / SN:</b>\n<code>${contentData}</code>\n` +
                                `---------------------------\n` +
                                `Rp ${gross_amount}`
                            );
                        } else {
                            // Tangani Error dari VIP
                            lastErrorMsg = vipRes.data.message;
                            console.warn(`VIP Error (${attemptLog}):`, lastErrorMsg);
                            
                            // Jika error Saldo/Produk, stop proxy loop
                            if(lastErrorMsg.toLowerCase().includes('saldo') || lastErrorMsg.toLowerCase().includes('produk')) break; 
                        }
                    }
                } catch (err) {
                    console.warn(`${attemptLog} Network Error: ${err.message}`);
                    lastErrorMsg = "Jaringan/Proxy Error: " + err.message;
                }
            } // End Loop Proxy

            // C. JIKA SEMUA PROXY GAGAL
            if (!isSuccess) {
                await orderRef.update({ adminMessage: `❌ GAGAL. Pesan Provider: ${lastErrorMsg}`, status: 'manual_check' });
                
                // TELEGRAM: Notif Gagal API
                await sendTelegramAlert(
                    `⚠️ <b>ORDER AUTO GAGAL!</b>\n` +
                    `Order ID: <code>${order_id}</code>\n` +
                    `Produk: ${apiData.service_code}\n` +
                    `Error: ${lastErrorMsg}\n` +
                    `<i>Silakan cek manual!</i>`
                );
            }

        } else {
            // ---> KASUS 2: PRODUK MANUAL (INI YANG ANDA MINTA!)
            // Code ini jalan jika produk diset MANUAL di Admin Panel
            
            await orderRef.update({ adminMessage: "📦 Order Manual Lunas. Menunggu proses admin..." });

            // TELEGRAM: Notif Order Manual Masuk
            await sendTelegramAlert(
                `📦 <b>ORDER MANUAL MASUK!</b>\n` +
                `---------------------------\n` +
                `Order ID: <code>${order_id}</code>\n` +
                `Item: <b>${apiData.name || 'Produk Manual'}</b>\n` +
                `Data User: <code>${apiData.target_data || '-'}</code>\n` +
                `Nominal: Rp ${gross_amount}\n` +
                `---------------------------\n` +
                `⚡ <b>UANG SUDAH MASUK, SEGERA PROSES!</b>`
            );
        }

      } catch (err) {
        console.error("System Crash:", err);
        await orderRef.update({ status: 'manual_check', adminMessage: "System Backend Error" });
      }
    }
    return res.status(200).send('OK');
  } catch (e) {
    console.error("Global Error:", e);
    return res.status(500).send('Internal Server Error');
  }
}
