// File: api/approve-manual.js

export default async function handler(req, res) {
  // 1. Cek Metode Request (Harus POST)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. Ambil data dari body request
  const { orderId, items, buyerPhone, adminToken } = req.body;

  // (Opsional) Security Check Sederhana
  // Anda bisa membuat password sederhana di env vercel agar tidak sembarang orang bisa tembak API ini
  const SECRET_KEY = process.env.ADMIN_SECRET_KEY || "kunci_rahasia_jisaeshin"; 
  if (adminToken !== SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 3. Konfigurasi Bot Telegram
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Masukkan di Vercel Environment Variables
  // Chat ID Admin atau Group Log (Untuk laporan)
  const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID; 

  try {
    // 4. Susun Pesan untuk Bot
    const messageText = `
✅ *PESANAN MANUAL DI-ACC!*
---------------------------
🆔 Order ID: ${orderId}
📱 Buyer: ${buyerPhone}

📦 *Item:*
${items.map(i => `- ${i.name} (x${i.qty})`).join('\n')}

_Sistem telah memverifikasi pembayaran manual._
    `.trim();

    // 5. Kirim ke Telegram Admin/Group (Sebagai Laporan)
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text: messageText,
        parse_mode: 'Markdown'
      })
    });

    // --- DISINI LOGIKA "BOT BEKERJA" ---
    // Jika bot harus mengirim produk ke user, Anda butuh Chat ID User.
    // Karena manual payment biasanya via WA, bot Telegram mungkin hanya kirim notif ke Admin
    // atau jika user punya ID Telegram yg disimpan di order, kirim ke sana.

    return res.status(200).json({ status: 'Success', message: 'Notifikasi Terkirim' });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Gagal mengirim notifikasi' });
  }
}
