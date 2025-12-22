// File: api/telegram-notify.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { orderId, total, items } = req.body;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  if (!token || !chatId) return res.status(500).json({error: 'Missing Env Vars'});

  // Format Pesan
  const itemList = items.map(i => `- ${i.name} (x${i.qty})`).join('\n');
  const text = `
🔔 *KONFIRMASI PEMBAYARAN MANUAL*
🆔 *${orderId}*
💰 Rp ${total.toLocaleString()}

📦 Item:
${itemList}

👇 *AKSI CEPAT:*
1. Cek Mutasi Bank/E-Wallet.
2. Klik *ACC PAID* jika uang masuk.
3. Balas dengan \`/isi ${orderId} [DATA]\` untuk kirim akun/voucher.
  `.trim();

  // Kirim ke Telegram dengan Inline Keyboard (Tombol)
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ ACC PAID (OTOMATIS)", callback_data: `ACC_${orderId}` }
            ]
          ]
        }
      })
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
