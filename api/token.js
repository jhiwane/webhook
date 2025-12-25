const midtransClient = require('midtrans-client');

// --- KONFIGURASI PRODUCTION ---
const snap = new midtransClient.Snap({
    isProduction: true, // <--- WAJIB TRUE UNTUK LIVE
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// --- LOGIC UTAMA ---
const handler = async (req, res) => {
    try {
        const { order_id, total, items, customer_details } = req.body;

        // Validasi dasar
        if (!order_id || !total) {
            return res.status(400).json({ error: "Data order_id atau total kurang" });
        }

        const parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: Math.round(total) // Pastikan bulat tanpa koma
            },
            credit_card: {
                secure: true
            },
            item_details: items || [],
            customer_details: customer_details || {}
        };

        const transaction = await snap.createTransaction(parameter);
        console.log(`Token created for Order ID: ${order_id}`); // Log sukses di Vercel
        
        return res.status(200).json({ token: transaction.token });

    } catch (error) {
        console.error("Midtrans Error:", error);
        return res.status(500).json({ error: error.message || "Gagal membuat transaksi" });
    }
};

// --- WRAPPER CORS (Anti Failed to Fetch) ---
const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    return await fn(req, res);
};

module.exports = allowCors(handler);
