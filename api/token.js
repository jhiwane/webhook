const midtransClient = require('midtrans-client');

module.exports = async (req, res) => {
    // --- AREA WAJIB (JANGAN DIUBAH) ---
    // Header ini mengizinkan frontend manapun untuk masuk tanpa error "CORS"
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); // '*' artinya semua boleh masuk
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // Jika browser "bertanya" dulu (Preflight), langsung jawab OK
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    // ----------------------------------

    try {
        // Setup Midtrans
        const snap = new midtransClient.Snap({
            isProduction: true,
            serverKey: process.env.MIDTRANS_SERVER_KEY,
            clientKey: process.env.MIDTRANS_CLIENT_KEY
        });

        const { order_id, total, items, customer_details } = req.body;

        // Validasi data tidak boleh kosong
        if (!order_id || !total) {
            return res.status(400).json({ error: "Data order_id atau total kosong" });
        }

        const parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: parseInt(total)
            },
            credit_card: { secure: true },
            item_details: items, // Pastikan format items dari frontend sudah benar
            customer_details: customer_details
        };

        const transaction = await snap.createTransaction(parameter);
        
        // Kirim Token ke Frontend
        res.status(200).json({ token: transaction.token });

    } catch (e) {
        console.error("Error Backend:", e);
        res.status(500).json({ error: e.message });
    }
};
