const midtransClient = require('midtrans-client');

module.exports = async (req, res) => {
    // --- 1. SET HEADER CORS (WAJIB PALING ATAS) ---
    // Kode ini memberi stempel "IZIN MASUK" ke browser.
    // Tanda '*' artinya semua website boleh masuk (termasuk firebase anda).
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // --- 2. TANGANI PREFLIGHT REQUEST (PENTING!) ---
    // Browser selalu kirim sinyal 'OPTIONS' dulu untuk cek ombak.
    // Kita harus jawab '200 OK' agar browser lanjut kirim data asli.
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // --- 3. MULAI LOGIKA MIDTRANS ---
    try {
        // Ambil data
        const { order_id, total, items, customer_details } = req.body;

        // Setup Midtrans
        let snap = new midtransClient.Snap({
            isProduction: true,
            serverKey: process.env.MIDTRANS_SERVER_KEY,
            clientKey: process.env.MIDTRANS_CLIENT_KEY
        });

        // Filter items agar Midtrans tidak error (buang field processType, dll)
        // Midtrans cuma mau: id, price, quantity, name
        const cleanItems = items ? items.map((item) => {
            // Cek apakah ini Voucher (harga negatif)
            const isVoucher = item.price < 0;
            return {
                id: isVoucher ? "DISCOUNT" : (item.id || item.name).substring(0, 50),
                price: parseInt(item.price),
                quantity: parseInt(item.qty),
                name: item.name.substring(0, 50)
            };
        }) : [];

        // Parameter Transaksi
        let parameter = {
            transaction_details: {
                order_id: order_id,
                gross_amount: parseInt(total)
            },
            credit_card: { secure: true },
            item_details: cleanItems,
            customer_details: customer_details || { first_name: "Customer" }
        };

        // Minta Token
        const transaction = await snap.createTransaction(parameter);
        
        // Kirim Token ke Frontend
        res.status(200).json({ token: transaction.token });

    } catch (e) {
        console.error("Backend Error:", e);
        // Tetap kirim header CORS walaupun error, supaya frontend bisa baca errornya
        res.status(500).json({ error: e.message });
    }
};
