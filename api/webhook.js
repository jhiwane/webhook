const admin = require('firebase-admin');

// Inisialisasi Firebase
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

module.exports = async (req, res) => {
  // Hanya terima POST dari Saweria
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { amount, donator_name, message } = req.body;
    const amountPaid = parseInt(amount);
    
    console.log(`[PEMBAYARAN] Masuk: Rp ${amountPaid} | Donatur: ${donator_name} | Pesan: ${message}`);

    const ordersRef = db.collection('orders');
    let matchedOrder = null;

    // LOGIKA 1: Cari berdasarkan Kode TRX di Pesan (Paling Akurat)
    // Mencari pola TRX- angka- angka
    const trxMatch = message ? message.match(/TRX-\d+-\d+/) : null;
    
    if (trxMatch) {
      const orderId = trxMatch[0];
      const docRef = await ordersRef.doc(orderId).get();
      if (docRef.exists && docRef.data().status === 'pending') {
        matchedOrder = { id: orderId, ref: ordersRef.doc(orderId), data: docRef.data() };
      }
    }

    // LOGIKA 2: Jika pesan dihapus user, cari berdasarkan Nominal Unik
    if (!matchedOrder) {
      const snapshot = await ordersRef.where('status', '==', 'pending').get();
      snapshot.forEach(doc => {
        const order = doc.data();
        // Cek jika nominal pas (toleransi selisih biaya admin bank pembeli max 5000)
        const selisih = amountPaid - order.total;
        if (selisih >= 0 && selisih <= 5000) {
          matchedOrder = { id: doc.id, ref: doc.ref, data: order };
        }
      });
    }

    if (matchedOrder) {
      // OTOMATIS JADIKAN LUNAS
      await matchedOrder.ref.update({
        status: 'paid',
        paymentMethod: 'saweria_auto',
        verifiedAt: new Date().toISOString(),
        saweriaData: {
          donator: donator_name,
          amount_received: amountPaid,
          original_bill: matchedOrder.data.total
        }
      });

      console.log(`[SUKSES] Pesanan ${matchedOrder.id} LUNAS otomatis.`);
      return res.status(200).json({ status: 'success', id: matchedOrder.id });
    }

    console.log(`[PENDING] Tidak ada pesanan yang cocok dengan nominal Rp ${amountPaid}`);
    return res.status(200).json({ status: 'ignored', reason: 'No matching order' });

  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).json({ error: error.message });
  }
};
