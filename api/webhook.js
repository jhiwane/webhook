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
    const amountPaid = Number(amount);
    
    console.log(`[PAYMENT] Masuk: Rp ${amountPaid} | Pesan: ${message}`);

    const ordersRef = db.collection('orders');
    let matchedOrder = null;

    // STRATEGI 1: Cari berdasarkan Kode TRX di Pesan (Paling Akurat)
    const trxMatch = message ? message.match(/TRX-\d+-\d+/) : null;
    if (trxMatch) {
      const orderId = trxMatch[0];
      const docSnap = await ordersRef.doc(orderId).get();
      if (docSnap.exists && docSnap.data().status === 'pending') {
        matchedOrder = { id: orderId, ref: docSnap.ref, data: docSnap.data() };
      }
    }

    // STRATEGI 2: Jika pesan dihapus user, cari berdasarkan Nominal yang MENDEKATI
    if (!matchedOrder) {
      const snapshot = await ordersRef.where('status', '==', 'pending').get();
      
      let bestMatch = null;
      let minDiff = 5000; // Toleransi maksimal selisih Rp 5.000 (untuk biaya admin bank)

      snapshot.forEach(doc => {
        const order = doc.data();
        const diff = amountPaid - Number(order.total);

        // Jika uang masuk >= tagihan DAN selisihnya di bawah 5000
        if (diff >= 0 && diff < minDiff) {
          minDiff = diff;
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
            received: amountPaid, 
            donator: donator_name,
            original: matchedOrder.data.total
        }
      });
      console.log(`[SUKSES] Order ${matchedOrder.id} LUNAS Otomatis!`);
      return res.status(200).json({ status: 'success', id: matchedOrder.id });
    }

    console.log(`[FAILED] Tidak ada pesanan yang cocok untuk nominal Rp ${amountPaid}`);
    return res.status(200).json({ status: 'ignored' });

  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).json({ error: error.message });
  }
};
