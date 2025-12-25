const midtransClient = require('midtrans-client');

module.exports = async (req, res) => {
    // 1. CORS Headers (Wajib untuk produksi agar bisa diakses dari frontend mana saja)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 2. Setup Midtrans Snap
    const snap = new midtransClient.Snap({
        isProduction: true, // Pastikan ini true untuk Production
        serverKey: process.env.MIDTRANS_SERVER_KEY,
        clientKey: process.env.MIDTRANS_CLIENT_KEY
    });

    try {
        const { order_id, total, items, customer_details } = req.body;

        // Validasi input dasar
        if (!order_id || !total || !items) {
            throw new Error("Data order_id, total, atau items tidak lengkap.");
        }

        // 3. Parameter Transaksi (Disusun Rapi)
        const parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: parseInt(total) // Pastikan integer
            },
            credit_card: {
                secure: true
            },
            item_details: items.map(item => ({
                id: (item.id || item.name).substring(0, 50),
                price: parseInt(item.price),
                quantity: parseInt(item.qty),
                name: item.name.substring(0, 50)
            })),
            // Opsional: Tambahkan data customer agar muncul di dashboard Midtrans
            customer_details: customer_details || {} 
        };

        // 4. Buat Transaksi
        const transaction = await snap.createTransaction(parameter);
        
        // Return Token
        return res.status(200).json({ 
            status: 'success',
            token: transaction.token,
            redirect_url: transaction.redirect_url
        });

    } catch (e) {
        console.error("Midtrans Token Error:", e.message);
        return res.status(500).json({ error: e.message });
    }
};
