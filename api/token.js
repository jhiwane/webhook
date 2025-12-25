// file: api/token.js
const midtransClient = require('midtrans-client');

module.exports = async (req, res) => {
    // CORS (Agar frontend bisa akses)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { order_id, total, items } = req.body;

        // --- 1. SETUP MIDTRANS ---
        let snap = new midtransClient.Snap({
            isProduction: true, // Pastikan true
            serverKey: process.env.MIDTRANS_SERVER_KEY,
            clientKey: process.env.MIDTRANS_CLIENT_KEY
        });

        // --- 2. BERSIHKAN ITEM (PENTING!) ---
        // Frontend Anda mengirim field 'processType', 'serverRoute', dll.
        // Midtrans AKAN ERROR jika menerima field itu. Kita harus memfilter cuma ambil id, price, quantity, name.
        const cleanItems = items.map((item) => {
            // Jika item itu voucher (harga negatif), biarkan
            if (item.price < 0) {
                return {
                    id: "DISCOUNT",
                    price: parseInt(item.price),
                    quantity: 1,
                    name: "Diskon Voucher"
                };
            }
            // Item normal
            return {
                id: item.name.substring(0, 50), // Midtrans max 50 char
                price: parseInt(item.price),
                quantity: parseInt(item.qty),
                name: item.name.substring(0, 50)
            };
        });

        // --- 3. BUAT PARAMETER ---
        let parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: parseInt(total)
            },
            credit_card: { secure: true },
            item_details: cleanItems
        };

        // --- 4. MINTA TOKEN ---
        const transaction = await snap.createTransaction(parameter);
        
        // Balikin token ke Frontend sesuai permintaan kode Anda
        res.status(200).json({ token: transaction.token });

    } catch (e) {
        console.error("Midtrans Error:", e.message);
        res.status(500).json({ error: e.message });
    }
};
