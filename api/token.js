// api/token.js
const midtransClient = require('midtrans-client');

export default async function handler(req, res) {
  // 1. Keamanan CORS (Hanya izinkan web kamu)
  res.setHeader('Access-Control-Allow-Origin', '*'); // Ubah ke domain aslimu saat production
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { order_id, total, items } = req.body;

    // 2. Setup Midtrans
    const snap = new midtransClient.Snap({
      isProduction: true, // Ubah false jika testing Sandbox
      serverKey: process.env.MIDTRANS_SERVER_KEY,
    });

    // 3. Deteksi Item API (VIP Reseller / Digiflazz)
    // Kita cari item yang processType-nya 'EXTERNAL_API'
    const apiItem = items.find(i => i.processType === 'EXTERNAL_API');
    
    // 4. Bungkus Data Penting ke Metadata Midtrans
    // Agar saat notifikasi balik, kita tahu harus kirim ke mana
    let customPayload = null;
    if (apiItem) {
      customPayload = JSON.stringify({
        target_url: apiItem.serverRoute,   // URL VIP
        service_code: apiItem.serviceCode, // Kode Barang (ML86)
        target_data: apiItem.data ? apiItem.data[0] : null, // ID Player / No HP
        is_api: true
      });
    }

    // 5. Buat Transaksi
    const parameter = {
      transaction_details: { order_id: order_id, gross_amount: total },
      item_details: items.map(item => ({
        id: Math.random().toString(36).substring(7),
        price: item.price,
        quantity: item.qty,
        name: item.name.substring(0, 50).replace(/[^\w\s]/gi, '')
      })),
      custom_field1: customPayload, // <--- Data Titipan Disimpan Disini
      credit_card: { secure: true }
    };

    const transaction = await snap.createTransaction(parameter);
    res.status(200).json({ token: transaction.token });

  } catch (error) {
    console.error("Token Error:", error);
    res.status(500).json({ error: "System Busy" });
  }
}
