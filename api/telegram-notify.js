export default async function handler(req, res) {
  // --- 1. SETTING CORS (IZIN LINTAS DOMAIN) ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // --- 2. LOGIKA UTAMA ---
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Ambil data yang dikirim dari Frontend
  const { orderId, total, items, buyerContact } = req.body;
  
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  if (!token || !chatId) {
    return res.status(500).json({ error: 'Token/ChatID belum disetting di Vercel' });
  }

  // --- 3. LOGIKA CARI NOMOR HP (UPDATE BARU DISINI) ---
  // Kita coba cari nomor HP agar nanti Bot bisa kasih Link WA otomatis
  let buyerPhone = "0";

  if (buyerContact) {
      // Prioritas 1: Jika frontend mengirim data kontak spesifik
      buyerPhone = buyerContact;
  } else if (items && items.length > 0 && items[0].data && items[0].data.length > 0) {
      // Prioritas 2: Ambil dari inputan user di item pertama (biasanya No HP/ID)
      buyerPhone = items[0].data[0];
  }

  // Format list item untuk pesan
  const itemList = items ? items.map(i => `- ${i.name} (x${i.qty})`).join('\n') : '- Item tidak terdeteksi';

  const text = `
🔔 *KONFIRMASI PEMBAYARAN MANUAL*
--------------------------------
🆔 *${orderId}*
💰 *Rp ${parseInt(total).toLocaleString()}*
📞 *Kontak:* \`${buyerPhone}\`

📦 *Item:*
${itemList}

👇 *AKSI ADMIN:*
1. Cek Mutasi Bank/E-Wallet.
2. Jika Uang Masuk, klik tombol di bawah.
3. Gunakan fitur balasan untuk kirim Data.
  `.trim();

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              // UPDATE: Kita sisipkan buyerPhone ke dalam callback_data
              // Format: ACC_IDORDER_NOHP
              { text: "✅ ACC PAID (VERIFIKASI)", callback_data: `ACC_${orderId}_${buyerPhone}` }
            ]
          ]
        }
      })
    });

    const result = await response.json();
    if (!result.ok) throw new Error(result.description);

    return res.status(200).json({ success: true });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
