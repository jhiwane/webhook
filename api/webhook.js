const admin = require('firebase-admin');

// Inisialisasi Firebase Admin menggunakan Environment Variables
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Mengubah string newline (\n) kembali ke format asli key
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  // Hanya menerima method POST dari Saweria
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Hanya menerima metode POST' });
  }

  try {
    const { amount, donator_name, message } = req.body;
    
    // Konversi amount ke angka (Saweria mengirim angka murni)
    const amountPaid = parseInt(amount);

    console.log(`[PAYMENT] Masuk Rp ${amountPaid} dari ${donator_name}`);

    // MENCARI ORDER BERDASARKAN NOMINAL PERSIS (UNIQUE AMOUNT)
    // Kita mencari di koleksi 'orders' yang statusnya masih 'pending'
    const ordersRef = db.collection('orders');
    const snapshot = await ordersRef
      .where('total', '==', amountPaid)
      .where('status', '==', 'pending')
      .get();

    if (snapshot.empty) {
      console.log(`[FAILED] Tidak ada order pending dengan nominal Rp ${amountPaid}`);
      // Kita tetap beri respon 200 ke Saweria agar tidak terus-menerus mengirim ulang
      return res.status(200).json({ 
        status: 'ignored', 
        message: 'No matching pending order found for this amount' 
      });
    }

    // Jika ditemukan pesanan yang cocok (Harusnya hanya 1 karena ada kode unik)
    const orderDoc = snapshot.docs[0];
    const orderId = orderDoc.id;
    const orderData = orderDoc.data();

    // UPDATE STATUS JADI PAID
    await orderDoc.ref.update({
      status: 'paid',
      updatedAt: new Date().toISOString(),
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentDetail: {
        source: 'saweria_auto',
        donator: donator_name,
        raw_amount: amountPaid
      }
    });

    console.log(`[SUCCESS] Order ${orderId} otomatis LUNAS!`);
    
    return res.status(200).json({ 
      status: 'success', 
      order_id: orderId,
      message: 'Order has been verified and marked as paid' 
    });

  } catch (error) {
    console.error("[ERROR] Webhook Error:", error);
    return res.status(500).json({ error: 'Terjadi kesalahan internal server' });
  }
};
