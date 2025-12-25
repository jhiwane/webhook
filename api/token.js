const midtransClient = require('midtrans-client');

// --- KONFIGURASI PRODUCTION ---
const snap = new midtransClient.Snap({
    isProduction: true, // SUDAH LIVE
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

const handler = async (req, res) => {
    try {
        const { order_id, total, items, customer_details } = req.body;

        // 1. Validasi Input Dasar
        if (!order_id || !total) {
            return res.status(400).json({ error: "Data order_id atau total kurang" });
        }

        // 2. PERBAIKAN FORMAT ITEM (SANITIZATION)
        // Midtrans sangat ketat. Kita harus map ulang data dari Frontend ('qty') menjadi standar Midtrans ('quantity').
        // Kita juga membuang field aneh-aneh (processType, data, dll) agar tidak ditolak.
        let midtransItems = [];
        if (items && Array.isArray(items)) {
            midtransItems = items.map(item => {
                return {
                    id: item.id || "ITEM", // ID Optional
                    price: parseInt(item.price), // Pastikan Angka Bulat
                    quantity: parseInt(item.qty), // <--- INI KUNCINYA (qty -> quantity)
                    name: (item.name || "Item").substring(0, 50) // Batasi panjang nama max 50 char biar aman
                };
            });
        }

        // 3. Pastikan Gross Amount Sinkron
        // Kadang hitungan di JS meleset dikit, kita hitung ulang total dari item biar Midtrans gak marah.
        const calculatedGross = midtransItems.reduce((acc, curr) => acc + (curr.price * curr.quantity), 0);

        // Jika ada Voucher (harga negatif), item di atas mungkin tidak mencakup voucher jika strukturnya beda.
        // Jadi kita tetap gunakan 'total' dari frontend, tapi pastikan bulat.
        const finalGrossAmount = Math.round(total);

        // 4. Susun Parameter Akhir
        const parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: finalGrossAmount
            },
            credit_card: {
                secure: true
            },
            item_details: midtransItems, // Kirim data yang sudah dibersihkan
            customer_details: customer_details || {
                first_name: "Customer",
                email: "customer@example.com" // Email dummy wajib ada di beberapa settingan Midtrans
            }
        };

        // 5. Minta Token
        const transaction = await snap.createTransaction(parameter);
        console.log(`Success Token: ${transaction.token} for Order: ${order_id}`);
        
        return res.status(200).json({ token: transaction.token });

    } catch (error) {
        console.error("Midtrans Error:", error);
        // Tampilkan pesan error detail dari Midtrans jika ada
        const message = error.ApiResponse ? JSON.stringify(error.ApiResponse) : error.message;
        return res.status(500).json({ error: message });
    }
};

// --- WRAPPER CORS ---
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
