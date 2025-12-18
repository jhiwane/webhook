const midtransClient = require('midtrans-client');

// Inisialisasi Snap (Mode Production)
const snap = new midtransClient.Snap({
    isProduction: true, // Pastikan ini true untuk Production
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

module.exports = async (req, res) => {
    // Setup CORS agar bisa diakses dari domain mana saja
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // Handle Preflight Request
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const { order_id, total, items, customer_details } = req.body;

        // Parameter Transaksi Standar Midtrans
        const parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: parseInt(total)
            },
            credit_card: {
                secure: true
            },
            // Detail Item (Opsional tapi bagus untuk struk user)
            item_details: items.map(item => ({
                id: "ITEM",
                price: parseInt(item.price),
                quantity: parseInt(item.qty),
                name: item.name.substring(0, 49) // Midtrans batasi nama item max 50 char
            })),
            // Data Customer (Dummy/Default agar tidak error)
            customer_details: {
                first_name: "Customer",
                email: "customer@jisaeshin.store",
                phone: "08123456789"
            }
        };

        // Minta Token ke Midtrans
        const transaction = await snap.createTransaction(parameter);
        
        // Kirim Token ke Frontend
        res.status(200).json({ token: transaction.token });

    } catch (error) {
        console.error("Midtrans Token Error:", error);
        res.status(500).json({ error: error.message });
    }
};
