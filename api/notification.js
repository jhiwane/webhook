// api/notification.js (V58 - FINAL: SMART DATA & PROXY)
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto');
const cryptoJS = require('crypto-js');
// Pastikan path firebase ini sesuai dengan struktur folder project Vercel kamu
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

    // 3. LOGIKA EKSEKUSI KE VIP RESELLER (Hanya jika Status PAID)
    if (newStatus === 'paid' && custom_field1) {
      try {
        const apiData = JSON.parse(custom_field1);

        // Pastikan ini transaksi otomatis (API)
        if (apiData.is_api && apiData.target_url) {
            
            // A. LOGIKA PEMBERSIH NOMOR (Smart ID)
            // Memisahkan Zone ID jika ada (contoh: 12345 (6789))
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
            
            // Loop untuk mencoba proxy satu per satu jika gagal
            for (let i = 0; i < proxyList.length; i++) {
                if (isSuccess) break; // Jika sudah sukses, berhenti loop
                
                const currentProxy = proxyList[i] ? proxyList[i].trim() : null;
                const attemptLog = currentProxy ? `Proxy #${i+1}` : "Direct Connection";

                try {
                    // Config Axios dengan Proxy
                    let axiosConfig = { 
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 30000 // 30 Detik timeout (VIP kadang lambat)
                    };

                    if (currentProxy) {
                        axiosConfig.httpsAgent = new HttpsProxyAgent(currentProxy);
                        axiosConfig.proxy = false; // Disable default proxy axios
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

                            // >>> FITUR KUNCI: AMBIL DATA SN / NOTE (Bukan Cuma TRXID) <<<
                            // Prioritas: SN > Note > TrxID
                            // Ini agar email/pass Canva terbaca dan masuk ke adminMessage
                            let contentData = resData.sn || resData.note || resData.trxid || "Data terkirim";
                            
                            // Bersihkan jika ada kata "Sukses" berulang dari provider
                            contentData = contentData.replace(/^Sukses\s+/i, '');

                            // Update ke Firebase
                            // Format ini akan dibaca oleh cleanSnMessage di Frontend V56
                            await orderRef.update({ 
                                adminMessage: `✅ SUKSES via ${attemptLog}! SN: ${contentData}`, 
                                status: 'completed' 
                            });

                            // KIRIM TELEGRAM KE ADMIN (Lengkap dengan data)
                            await sendTelegramAlert(
                                `💰 <b>ORDER SUKSES!</b>\n` +
                                `Order ID: <code>${order_id}</code>\n` +
                                `Produk: ${apiData.service_code}\n` +
                                `Status: <b>TERKIRIM</b>\n` +
                                `---------------------------\n` +
                                `<b>DATA / SN:</b>\n<code>${contentData}</code>\n` +
                                `---------------------------\n` +
                                `Via: ${attemptLog}`
                            );
                        } else {
                            // Tangani Error dari VIP (Saldo habis, Gangguan, dll)
                            lastErrorMsg = vipRes.data.message;
                            console.warn(`VIP Error (${attemptLog}):`, lastErrorMsg);
                            
                            // Jika errornya bukan masalah koneksi (misal Saldo Habis), jangan coba proxy lain, percuma.
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
                
                // Alert Admin untuk Cek Manual
                await sendTelegramAlert(
                    `⚠️ <b>ORDER GAGAL (PROSES MANUAL)</b>\n` +
                    `Order ID: <code>${order_id}</code>\n` +
                    `Produk: ${apiData.service_code}\n` +
                    `Tujuan: ${cleanDataNo} ${cleanZone}\n` +
                    `Error: ${lastErrorMsg}\n\n` +
                    `<i>Silakan proses manual lewat web provider!</i>`
                );
            }
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
