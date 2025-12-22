export default async function handler(req, res) {
  // Hanya izinkan POST dari Website
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { orderId, total, items } = req.body;
  
  // Ambil Token dari Vercel
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  if (!token || !chatId) {
    return res.status(500).json({ error: 'Token/ChatID belum disetting di Vercel' });
  }

  // Format Daftar Barang
  const itemList = items ? items.map(i => `- ${i.name} (x${i.qty})`).join('\n') : '- Item tidak terdeteksi';

  // Isi Pesan Laporan
  const text = `
🔔 *KONFIRMASI PEMBAYARAN MANUAL*
--------------------------------
🆔 *${orderId}*
💰 *Rp ${parseInt(total).toLocaleString()}*

📦 *Item:*
${itemList}

👇 *AKSI ADMIN:*
1. Cek Mutasi Bank/E-Wallet.
2. Jika Uang Masuk, klik tombol di bawah.
3. Gunakan fitur balasan untuk kirim Data.
  `.trim();

  try {
    // Kirim Pesan dengan Tombol Inline (ACC)
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
              // Tombol ini akan mengirim sinyal 'ACC_[ORDER_ID]' ke Webhook
              { text: "✅ ACC PAID (VERIFIKASI)", callback_data: `ACC_${orderId}` }
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
