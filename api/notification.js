const admin = require('firebase-admin');
const midtransClient = require('midtrans-client');

// 1. Inisialisasi Firebase Admin (MENGGUNAKAN JSON FULL)
if (!admin.apps.length) {
    // Parsing JSON dari Environment Variable Vercel
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}
const db = admin.firestore();

// 2. Inisialisasi Midtrans Core API
const apiClient = new midtransClient.CoreApi({
    isProduction: true, 
    serverKey: process.env.MIDTRANS_SERVER_KEY, // Pastikan Variable ini ada di Vercel!
    clientKey: process.env.MIDTRANS_CLIENT_KEY  // Pastikan Variable ini ada di Vercel!
});

module.exports = async (req, res) => {
    // Handle CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const notificationJson = req.body;

        // Cek status transaksi ke Server Midtrans
        const statusResponse = await apiClient.transaction.notification(notificationJson);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;
        const grossAmount = parseFloat(statusResponse.gross_amount); // Uang yang masuk

        console.log(`[MIDTRANS] ${orderId} | Status: ${transactionStatus} | Amount: ${grossAmount}`);

        const orderRef = db.collection('orders').doc(orderId);
        
        // --- 🛡️ FITUR KEAMANAN BARU (ANTI HACK RP 1) ---
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) {
             return res.status(404).send('Order Not Found in DB');
        }

        const realTotal = parseFloat(orderDoc.data().total); // Harga asli di Database

        // Jika uang yang dibayar LEBIH KECIL dari harga asli (Toleransi 100 perak)
        if (grossAmount < (realTotal - 100)) {
            console.error(`🚨 FRAUD DETECTED! Order: ${orderId}, Paid: ${grossAmount}, Real: ${realTotal}`);
            await orderRef.update({ 
                status: 'fraud_attempt',
                adminMessage: `SYSTEM ALERT: Pembayaran Rp ${grossAmount} tidak sesuai tagihan Rp ${realTotal}. JANGAN PROSES!`
            });
            return res.status(200).json({ status: 'fraud_detected' });
        }
        // ---------------------------------------------------

        // Logika Update Status Normal
        if (transactionStatus == 'capture') {
            if (fraudStatus == 'challenge') {
                await orderRef.update({ status: 'pending_review' });
            } else if (fraudStatus == 'accept') {
                await orderRef.update({ status: 'paid', verifiedAt: new Date().toISOString() });
            }
        } else if (transactionStatus == 'settlement') {
            await orderRef.update({ status: 'paid', verifiedAt: new Date().toISOString() });
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            await orderRef.update({ status: 'failed' });
        } else if (transactionStatus == 'pending') {
            await orderRef.update({ status: 'pending_payment' });
        }

        return res.status(200).json({ status: 'ok' });

    } catch (error) {
        console.error("Webhook Error:", error);
        return res.status(500).send('Internal Server Error');
    }
};
