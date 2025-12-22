export default async function handler(req, res) {
  // --- 1. SETTING CORS (IZIN LINTAS DOMAIN) ---
  // Kita paksa server bilang "BOLEH" ke siapapun yang minta data
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Boleh dari mana saja
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Menangani "Preflight Request" dari Browser (PENTING!)
  // Browser suka nanya dulu "Boleh gak?" sebelum kirim data. Kita jawab "Boleh (200 OK)"
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // --- 2. LOGIKA UTAMA ---
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { orderId, total, items } = req.body;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  if (!token || !chatId) {
    return res.status(500).json({ error: 'Token/ChatID belum disetting di Vercel' });
  }

  const itemList = items ? items.map(i => `- ${i.name} (x${i.qty})`).join('\n') : '- Item tidak terdeteksi';

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
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ ACC PAID (VERIFIKASI)", callback_data: `ACC_${orderId}` }]
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
