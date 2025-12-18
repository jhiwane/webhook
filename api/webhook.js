const admin = require('firebase-admin');

// Kita akan mengambil kredensial dari Environment Variables Vercel (Agar Aman)
// Jangan taruh file JSON asli disini agar tidak dicuri orang di GitHub
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Trik khusus Vercel: Mengubah \n string menjadi newline asli
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  // 1. Cek Metode Request (Harus POST dari Saweria)
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const { amount, message, donator_name } = req.body;
    
    console.log(`Saweria masuk: Rp ${amount} dari ${donator_name}. Pesan: ${message}`);

    // 2. Validasi Pesan (Harus ada Kode TRX)
    // Asumsi user menulis: "TRX-12345" atau "Bayar TRX-12345"
    // Kita cari string yang diawali TRX-
    const trxMatch = message.match(/TRX-\d+-\d+/);
    
    if (!trxMatch) {
      console.log("Tidak ada kode TRX valid di pesan.");
      return res.status(200).json({ status: 'ignored', reason: 'No TRX code found' });
    }

    const orderId = trxMatch[0]; // Contoh: TRX-5821-998

    // 3. Cari Order di Firebase
    const orderRef = db.collection('orders').doc(orderId);
    const docSnap = await orderRef.get();

    if (!docSnap.exists) {
      console.log(`Order ID ${orderId} tidak ditemukan.`);
      return res.status(404).json({ status: 'failed', reason: 'Order not found' });
    }

    const orderData = docSnap.data();

    // 4. Validasi Nominal (Opsional: Cek apakah uang cukup)
    if (parseInt(amount) < orderData.total) {
      console.log("Uang kurang.");
      return res.status(200).json({ status: 'partial', reason: 'Underpaid' });
    }

    // 5. UPDATE STATUS JADI 'PAID' (LUNAS)
    await orderRef.update({
      status: 'paid',
      paymentMethod: 'saweria_auto',
      updatedAt: new Date().toISOString(),
      saweriaData: {
        donator: donator_name,
        amount: amount
      }
    });

    console.log(`Sukses! Order ${orderId} lunas.`);
    return res.status(200).json({ status: 'success', order_id: orderId });

  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).send('Internal Server Error');
  }
};
