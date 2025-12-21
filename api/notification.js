// api/notification.js (V55 - DIAGNOSTIC MODE)
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto'); 
const cryptoJS = require('crypto-js'); 
const { db } = require('../lib/firebase');
const { HttpsProxyAgent } = require('https-proxy-agent');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const notificationJson = req.body;
    const { order_id, status_code, gross_amount, signature_key, transaction_status, fraud_status, custom_field1 } = notificationJson;

    // 1. Verifikasi Signature Midtrans
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const inputString = order_id + status_code + gross_amount + serverKey;
    const mySignature = crypto.createHash('sha512').update(inputString).digest('hex');

    if (signature_key !== mySignature) {
      console.warn(`🚨 FAKE NOTIFICATION: ${order_id}`);
      return res.status(403).json({ message: "Invalid Signature" });
    }

    // 2. Cek Status Pembayaran
    let newStatus = 'pending';
    if (transaction_status == 'capture' || transaction_status == 'settlement') {
      newStatus = 'paid';
    } else if (transaction_status == 'cancel' || transaction_status == 'expire') {
      newStatus = 'failed';
    }

    // Update Status Awal ke Firebase
    const orderRef = db.collection('orders').doc(order_id);
    await orderRef.update({ status: newStatus, last_updated: new Date().toISOString() });

    // 3. LOGIKA EKSEKUSI OTOMATIS (Hanya jika status PAID)
    if (newStatus === 'paid' && custom_field1) {
      try {
        const apiData = JSON.parse(custom_field1);

        if (apiData.is_api && apiData.target_url) {
            
            // --- DIAGNOSTIC LOG: Mulai Proses ---
            await orderRef.update({ adminMessage: "🤖 System: Memulai proses ke VIP Reseller..." });

            // Setup Proxy
            let axiosConfig = { 
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30000 // 30 Detik Timeout
            };
            
            if (process.env.PROXY_URL && apiData.target_url.includes('vip-reseller')) {
                const httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL);
                axiosConfig.httpsAgent = httpsAgent;
                axiosConfig.proxy = false; 
            }

            // Eksekusi VIP Reseller
            if (apiData.target_url.includes('vip-reseller')) {
                const vipId = process.env.VIP_API_ID;
                const vipKey = process.env.VIP_API_KEY;
                const sign = cryptoJS.MD5(vipId + vipKey).toString();

                const formData = new URLSearchParams();
                formData.append('key', vipKey);
                formData.append('sign', sign);
                formData.append('type', 'order');
                formData.append('service', apiData.service_code);
                formData.append('data_no', apiData.target_data);

                // TEMBAK!
                const vipRes = await axios.post(apiData.target_url, formData, axiosConfig);
                
                // ANALISA RESPON VIP
                if(vipRes.data && vipRes.data.result) {
                    // SUKSES
                    await orderRef.update({
                        adminMessage: `✅ SUKSES VIP! SN: ${vipRes.data.data.trxid}. Pesan: ${vipRes.data.message}`,
                        status: 'completed'
                    });
                } else {
                    // GAGAL DARI VIP (Saldo habis / Produk Gangguan)
                    await orderRef.update({
                        adminMessage: `❌ GAGAL DARI VIP: ${vipRes.data.message}`,
                        status: 'manual_check'
                    });
                }
            }
        }
      } catch (err) {
        // --- CATCH ERROR (Koneksi / Proxy Bermasalah) ---
        console.error("Auto Process Failed:", err.message);
        
        let errorMsg = err.message;
        if (err.code === 'ECONNREFUSED') errorMsg = "Koneksi ke Proxy Ditolak";
        if (err.code === 'ETIMEDOUT') errorMsg = "Koneksi Timeout (Proxy Lemot)";
        
        await orderRef.update({ 
            adminMessage: `⚠️ SYSTEM ERROR: ${errorMsg}. Cek Proxy/Saldo.`,
            status: 'manual_check'
        });
      }
    }

    return res.status(200).send('OK');

  } catch (e) {
    return res.status(500).send('Internal Server Error');
  }
}
