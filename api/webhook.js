const admin = require('firebase-admin');

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
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { amount, donator_name, message } = req.body;
    const amountPaid = parseInt(amount); // Nominal bersih yang diterima Saweria
    
    console.log(`[MASUK] Rp ${amountPaid} | Msg: ${message}`);

    const ordersRef = db.collection('orders');
    let matchedOrder = null;

    // 1. CARI BERDASARKAN KODE TRX DI PESAN (Prioritas Utama)
    const trxMatch = message ? message.match(/TRX-\d+-\d+/) : null;
    if (trxMatch) {
      const orderId = trxMatch[0];
      const docSnap = await ordersRef.doc(orderId).get();
      if (docSnap.exists && docSnap.data().status === 'pending') {
        matchedOrder = { id: orderId, ref: docSnap.ref, data: docSnap.data() };
      }
    }

    // 2. CARI BERDASARKAN NOMINAL (Backup jika user hapus pesan)
    // Toleransi: Uang masuk boleh lebih besar sedikit (maks 5000) dari tagihan
    if (!matchedOrder) {
      const snapshot = await ordersRef.where('status', '==', 'pending').get();
      
      let bestMatch = null;
      // Cari selisih terkecil
      snapshot.forEach(doc => {
        const order = doc.data();
        const tagihan = parseInt(order.total);
        const selisih = amountPaid - tagihan;

        // Syarat: Uang Masuk >= Tagihan DAN Selisih <= 5000 Perak
        if (selisih >= 0 && selisih <= 5000) {
          bestMatch = { id: doc.id, ref: doc.ref, data: order };
        }
      });
      matchedOrder = bestMatch;
    }

    if (matchedOrder) {
      await matchedOrder.ref.update({
        status: 'paid',
        paymentMethod: 'saweria_auto',
        verifiedAt: new Date().toISOString(),
        saweriaData: { 
            amount_received: amountPaid, 
            donator: donator_name
        }
      });
      console.log(`[LUNAS] Order ${matchedOrder.id}`);
      return res.status(200).json({ status: 'success', id: matchedOrder.id });
    }

    return res.status(200).json({ status: 'ignored', msg: 'No match found' });

  } catch (error) {
    console.error(error);
    return res.status(500).send('Server Error');
  }
};
