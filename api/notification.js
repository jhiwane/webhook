// api/notification.js
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto'); // Security Native
const cryptoJS = require('crypto-js'); // MD5 VIP
const { db } = require('../lib/firebase'); // Panggil Kunci Database

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const notificationJson = req.body;
    const { order_id, status_code, gross_amount, signature_key, transaction_status, fraud_status, custom_field1 } = notificationJson;

    // --- LEVEL 1: VERIFIKASI KEAMANAN (ANTI HACK) ---
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const inputString = order_id + status_code + gross_amount + serverKey;
    const mySignature = crypto.createHash('sha512').update(inputString).digest('hex');

    if (signature_key !== mySignature) {
      console.warn(`🚨 FAKE NOTIFICATION BLOCKED: ${order_id}`);
      return res.status(403).json({ message: "Invalid Signature" });
    }

    console.log(`✅ Valid Notif: ${order_id} | Status: ${transaction_status}`);

    // --- LEVEL 2: UPDATE FIREBASE ---
    const orderRef = db.collection('orders').doc(order_id);

    let newStatus = 'pending';
    if (transaction_status == 'capture' || transaction_status == 'settlement') {
      newStatus = 'paid';
    } else if (transaction_status == 'cancel' || transaction_status == 'expire') {
      newStatus = 'failed';
    }

    // Update status dasar dulu ke Firebase
    await orderRef.update({ 
        status: newStatus,
        last_updated: new Date().toISOString()
    });

    // --- LEVEL 3: EKSEKUSI API MITRA (JIKA PAID) ---
    if (newStatus === 'paid' && custom_field1) {
      try {
        const apiData = JSON.parse(custom_field1);

        // Cek apakah ini produk otomatis (VIP/Digi)
        if (apiData.is_api && apiData.target_url) {
            
            console.log(`🚀 AUTO PROCESS: ${apiData.service_code} -> ${apiData.target_data}`);
            
            // A. LOGIKA VIP RESELLER
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
                const vipRes = await axios.post(apiData.target_url, formData);
                console.log("VIP RESPONSE:", vipRes.data);

                // Update Firebase dengan pesan dari VIP
                // VIP biasanya mengembalikan { result: true, data: { trxid: '...', message: '...' } }
                if(vipRes.data && vipRes.data.result) {
                    await orderRef.update({
                        adminMessage: `AUTO SUCCESS! TRX ID: ${vipRes.data.data.trxid}\n${vipRes.data.message}`,
                        status: 'completed' // Tandai selesai otomatis
                    });
                } else {
                    await orderRef.update({
                        adminMessage: `AUTO FAILED: ${vipRes.data.message}`,
                        status: 'manual_check' // Biar admin cek manual
                    });
                }
            }
            // B. LOGIKA DIGIFLAZZ (Future Proof)
            // Bisa ditambahkan disini nanti...
        }
      } catch (err) {
        console.error("Auto Process Failed:", err.message);
        await orderRef.update({ adminMessage: "SYSTEM ERROR: Auto process failed. Checking manual." });
      }
    }

    return res.status(200).send('OK');

  } catch (e) {
    console.error("Backend Error:", e);
    return res.status(500).send('Internal Server Error');
  }
}
