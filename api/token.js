// api/token.js
const midtransClient = require('midtrans-client');

// --- 1. SETTING MIDTRANS ---
// Pastikan Server Key benar
const snap = new midtransClient.Snap({
    isProduction: false, // Ubah ke true jika sudah production
    serverKey: process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-xxxxxxxxx', // Masukkan Key di Environment Vercel
    clientKey: process.env.MIDTRANS_CLIENT_KEY || 'SB-Mid-client-xxxxxxxxx'
});

// --- 2. FUNGSI UTAMA HANDLER ---
const handler = async (req, res) => {
    // Tangani Request Utama
    try {
        const { order_id, total, items, customer_details } = req.body;

        if (!order_id || !total) {
            return res.status(400).json({ error: "Data order_id atau total tidak lengkap" });
        }

        const parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: total
            },
            credit_card: {
                secure: true
            },
            item_details: items || [], // Opsional, tapi bagus ada
            customer_details: customer_details || {}
        };

        const transaction = await snap.createTransaction(parameter);
        
        // Berhasil
        return res.status(200).json({ token: transaction.token });

    } catch (error) {
        console.error("Midtrans Error:", error);
        return res.status(500).json({ error: error.message || "Gagal membuat transaksi" });
    }
};

// --- 3. WRAPPER CORS "ANTI GAGAL" ---
// Ini adalah kuncinya. Function ini membungkus logic di atas agar kebal CORS.
const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); // Boleh diakses dari mana saja
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // Jika browser cuma tanya "Boleh masuk gak?" (OPTIONS), langsung jawab "BOLEH" dan stop.
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Jika bukan OPTIONS, jalankan logic handler di atas
    return await fn(req, res);
};

// Export function yang sudah dibungkus
module.exports = allowCors(handler);
