const midtransClient = require('midtrans-client');

module.exports = async (req, res) => {
    // CORS Setup
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { order_id, total, items } = req.body;

        let snap = new midtransClient.Snap({
            isProduction: true, // Ganti false jika masih sandbox
            serverKey: process.env.MIDTRANS_SERVER_KEY,
            clientKey: process.env.MIDTRANS_CLIENT_KEY
        });

        let parameter = {
            transaction_details: { order_id: order_id, gross_amount: total },
            credit_card: { secure: true },
            item_details: items.map(item => ({
                id: item.name.substring(0, 50),
                price: parseInt(item.price),
                quantity: item.qty,
                name: item.name.substring(0, 50)
            }))
        };

        const transaction = await snap.createTransaction(parameter);
        res.status(200).json({ token: transaction.token });

    } catch (e) {
        console.error("Midtrans Error:", e);
        res.status(500).json({ error: e.message });
    }
};
