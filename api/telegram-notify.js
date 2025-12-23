export default async function handler(req, res) {
  // --- 1. SETTING CORS ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // --- 2. AMBIL TOKEN DARI ENV VERCEL (AMAN) ---
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  if (!token || !chatId) {
    return res.status(500).json({ error: 'Environment Variables belum disetting di Vercel!' });
  }

  // --- 3. PROSES DATA ---
  const { orderId, total, items, buyerContact, type = 'manual' } = req.body;

  // Logika Cerdas Mencari Kontak (WA atau Email)
  let contactInfo = "-";
  if (buyerContact) {
      contactInfo = buyerContact; 
  } else if (items && items.length > 0 && items[0].data && items[0].data.length > 0) {
      contactInfo = items[0].data[0]; 
  }

  // Format list item
  const itemList = items ? items.map(i => `- ${i.name} (x${i.qty})`).join('\n') : '- Item tidak terdeteksi';

  // Logika Judul Pesan
  let title = type === 'auto' ? "💰 *LUNAS (MIDTRANS)*" : "🔔 *CEK MUTASI (MANUAL)*";
  let buttonText = type === 'auto' ? "🚀 ISI DATA" : "✅ ACC & ISI DATA";

  const text = `
${title}
--------------------------------
🆔 \`${orderId}\`
💰 *Rp ${parseInt(total).toLocaleString()}*
👤 *Kontak:* \`${contactInfo}\`

📦 *Item:*
${itemList}

👇 *AKSI ADMIN:*
${type === 'auto' ? 'Data belum dikirim. Klik tombol di bawah.' : 'Cek uang masuk, lalu klik tombol di bawah.'}
  `.trim();

  try {
    // Kirim ke Telegram
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
              // Tombol membawa ID dan Kontak untuk diproses Webhook
              { text: buttonText, callback_data: `ACC|${orderId}|${contactInfo}` }
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
