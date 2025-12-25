const midtransClient = require('midtrans-client');

const snap = new midtransClient.Snap({
    isProduction: true,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

const allowCors = (fn) => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    return await fn(req, res);
};

const handler = async (req, res) => {
    try {
        const { order_id, total, items } = req.body;

        // Sanitasi Data untuk Midtrans (Wajib Qty -> Quantity)
        let midtransItems = [];
        if (items && Array.isArray(items)) {
            midtransItems = items.map(item => ({
                id: "ITEM",
                price: parseInt(item.price),
                quantity: parseInt(item.qty), // STANDARISASI
                name: (item.name || "Item").substring(0, 50)
            }));
        }

        const parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: Math.round(total)
            },
            credit_card: { secure: true },
            item_details: midtransItems,
            customer_details: {
                first_name: "Customer",
                email: "customer@example.com" // Dummy email required
            }
        };

        const transaction = await snap.createTransaction(parameter);
        return res.status(200).json({ token: transaction.token });

    } catch (error) {
        console.error("Midtrans Error:", error);
        return res.status(500).json({ error: error.message });
    }
};

module.exports = allowCors(handler);
