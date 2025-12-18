const admin = require('firebase-admin');
const midtransClient = require('midtrans-client');

// 1. Inisialisasi Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// 2. Inisialisasi Midtrans Core API (Untuk Verifikasi Signature)
const apiClient = new midtransClient.CoreApi({
    isProduction: true, // Pastikan ini true untuk Production
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

module.exports = async (req, res) => {
    // Handle CORS (Penting untuk webhook)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const notificationJson = req.body;

        // Cek status transaksi ke Server Midtrans (Verifikasi Keamanan)
        const statusResponse = await apiClient.transaction.notification(notificationJson);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;

        console.log(`[MIDTRANS LOG] ${orderId} | Status: ${transactionStatus} | Fraud: ${fraudStatus}`);

        // Referensi Dokumen Order di Firebase
        const orderRef = db.collection('orders').doc(orderId);

        // Logika Status Midtrans -> Firebase Status
        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                // Transaksi ditahan/perlu review
                await orderRef.update({ status: 'pending_review' });
            } else if (fraudStatus == 'accept') {
                // Transaksi Kartu Kredit Sukses
                await orderRef.update({ 
                    status: 'paid', 
                    verifiedAt: new Date().toISOString(),
                    paymentMethod: 'credit_card'
                });
            }
        } else if (transactionStatus == 'settlement') {
            // Transaksi Sukses (QRIS, VA, Gopay, dll)
            await orderRef.update({ 
                status: 'paid', 
                verifiedAt: new Date().toISOString(),
                paymentMethod: statusResponse.payment_type 
            });
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            // Transaksi Gagal/Kadaluarsa
            await orderRef.update({ status: 'failed' });
        } else if (transactionStatus == 'pending') {
            // Menunggu Pembayaran
            await orderRef.update({ status: 'pending_payment' });
        }

        // Wajib return 200 OK ke Midtrans
        return res.status(200).json({ status: 'ok' });

    } catch (error) {
        console.error("Webhook Error:", error);
        return res.status(500).send('Internal Server Error');
    }
};
