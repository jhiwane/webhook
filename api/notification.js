// api/notification.js (V65 - INSTANT NOTIFICATION FIRST)
const midtransClient = require('midtrans-client');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../lib/firebase'); 
const { HttpsProxyAgent } = require('https-proxy-agent');

// --- FUNGSI KIRIM TELEGRAM (ANTI GAGAL) ---
async function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    // Jangan biarkan script mati cuma gara-gara token kosong
    if (!token || !chatId) {
        console.error("❌ Telegram Config Missing");
        return; 
    }

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, 
            text: message,
            parse_mode: 'HTML'
        });
        console.log("✅ Telegram Sent!");
    } catch (e) { 
        console.error("Gagal Tele:", e.message); 
    }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const notificationJson = req.body;
    const { order_id, status_code, gross_amount, signature_key, transaction_status, custom_field1 } = notificationJson;

    // 1. CEK STATUS BAYAR (SEDERHANA)
    let isPaid = false;
    if (transaction_status == 'capture' || transaction_status == 'settlement') isPaid = true;
    
    // Jika belum lunas, update DB saja dan stop.
    if (!isPaid) {
        let status = (transaction_status == 'cancel' || transaction_status == 'expire') ? 'failed' : 'pending';
        await db.collection('orders').doc(order_id).update({ status: status });
        return res.status(200).send('OK');
    }

    // 2. VALIDASI SIGNATURE (WAJIB DEMI KEAMANAN)
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const inputString = order_id + status_code + gross_amount + serverKey;
    const mySignature = crypto.createHash('sha512').update(inputString).digest('hex');

    if (signature_key !== mySignature) {
       await sendTelegramAlert(`🚨 <b>HACK DETECTED!</b> ID: ${order_id}`);
       return res.status(403).json({ message: "Invalid Signature" });
    }

    // ============================================================
    // 3. ZONA NOTIFIKASI INSTAN (V65)
    // Apapun yang terjadi di bawah, Pesan ini WAJIB TERKIRIM DULUAN
    // ============================================================
    
    // Coba ambil nama barang dari Firebase dulu biar notifnya cantik
    let itemName = "Produk Manual/Unknown";
    let buyerData = "Cek Dashboard";
    let isApi = false;
    let apiData = null;

    try {
        const orderSnap = await db.collection('orders').doc(order_id).get();
        if (orderSnap.exists) {
            const data = orderSnap.data();
            if (data.items && data.items.length > 0) {
                itemName = data.items[0].name;
                buyerData = data.items[0].note || "-";
                // Cek tipe dari database langsung
                if (data.items[0].processType === 'EXTERNAL_API') isApi = true;
            }
        }
        
        // Cek juga dari custom_field1 sebagai backup
        if (custom_field1) {
            apiData = JSON.parse(custom_field1);
            if (apiData.is_api) isApi = true;
        }
    } catch (e) {
        console.log("Gagal baca detail order, kirim notif basic aja.");
    }

    // ---> KIRIM TELEGRAM SEKARANG! (Jangan tunggu proxy/vip) <---
    await sendTelegramAlert(
        `💰 <b>UANG MASUK BOS!</b>\n` +
        `---------------------------\n` +
        `ID: <code>${order_id}</code>\n` +
        `Item: <b>${itemName}</b>\n` +
        `Data: <code>${buyerData}</code>\n` +
        `Rp ${gross_amount}\n` +
        `---------------------------\n` +
        `<i>Status: ${isApi ? 'Memproses Otomatis...' : '⚡ MANUAL (PROSES SEKARANG!)'}</i>`
    );

    // ============================================================
    // 4. UPDATE DATABASE & EKSEKUSI API (BARU JALAN SETELAH NOTIF)
    // ============================================================
    
    const orderRef = db.collection('orders').doc(order_id);
    await orderRef.update({ status: 'paid', last_updated: new Date().toISOString() });

    // HANYA JIKA API, KITA JALANKAN LOGIKA RIBET (PROXY DLL)
    if (isApi && apiData && apiData.target_url) {
        
        await orderRef.update({ adminMessage: "🤖 Memproses API Otomatis..." });

        let isSuccess = false;
        let lastError = "";
        
        // Logic Proxy Singkat & Padat
        const proxyList = process.env.PROXY_URL ? process.env.PROXY_URL.split(',') : [null];
        
        // Bersihkan ID Pelanggan
        let cleanDataNo = apiData.target_data;
        let cleanZone = '';
        if (cleanDataNo.includes('(')) {
            const parts = cleanDataNo.replace(/[()]/g, ' ').trim().split(/\s+/);
            if (parts.length >= 2) { cleanDataNo = parts[0]; cleanZone = parts[1]; }
        }

        for (let i = 0; i < proxyList.length; i++) {
            if (isSuccess) break;
            const currentProxy = proxyList[i] ? proxyList[i].trim() : null;
            
            try {
                let axiosConfig = { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 25000 };
                if (currentProxy) {
                    axiosConfig.httpsAgent = new HttpsProxyAgent(currentProxy);
                    axiosConfig.proxy = false;
                }

                // VIP Reseller Logic
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
                    let sn = vipRes.data.data.sn || vipRes.data.data.note || vipRes.data.data.trxid;
                    await orderRef.update({ adminMessage: `✅ SUKSES API! SN: ${sn}`, status: 'completed' });
                    // Kirim notif kedua (Laporan Sukses API)
                    await sendTelegramAlert(`🤖 <b>API SUKSES TERKIRIM!</b>\nSN: <code>${sn}</code>`);
                } else {
                    lastError = vipRes.data.message;
                }
            } catch (err) {
                lastError = err.message;
            }
        }

        if (!isSuccess) {
            await orderRef.update({ adminMessage: `❌ GAGAL AUTO: ${lastError}`, status: 'manual_check' });
            await sendTelegramAlert(`⚠️ <b>API GAGAL!</b> Silakan proses manual.\nErr: ${lastError}`);
        }
    } else {
        // JIKA MANUAL, UPDATE PESAN AGAR USER TIDAK PANIK
        await orderRef.update({ adminMessage: "📦 Pembayaran diterima. Menunggu admin memproses pesanan..." });
    }

    return res.status(200).send('OK');

  } catch (e) {
    console.error("FATAL ERROR:", e);
    // Jika crash parah, setidaknya coba kirim sinyal
    await sendTelegramAlert(`🔥 <b>SYSTEM CRASH</b> saat proses order! Cek Vercel Log.`);
    return res.status(500).send('Internal Server Error');
  }
}
