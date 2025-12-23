export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  if (!token || !chatId) return res.status(500).json({ error: 'Env Var Missing' });

  // --- AMBIL DATA ---
  // type: 'manual', 'auto', atau 'complaint'
  // message: Isi pesan komplain dari user
  const { orderId, total, items, buyerContact, type = 'manual', message = '' } = req.body;

  // Cari Kontak
  let contactInfo = "-";
  if (buyerContact) contactInfo = buyerContact;
  else if (items?.[0]?.data?.[0]) contactInfo = items[0].data[0];

  // --- LOGIKA JUDUL & TOMBOL ---
  let title = "";
  let bodyText = "";
  let buttons = [];

  if (type === 'complaint') {
      // --- LOGIKA KOMPLAIN ---
      title = "⚠️ *ADA KOMPLAIN MASUK!*";
      bodyText = `🗣️ *Keluhan User:*\n"${message}"\n\n👇 Segera cek dan balas solusi di bawah.`;
      
      buttons = [[
          // Tombol Khusus Komplain (Format: COMPLAIN|ID|KONTAK)
          { text: "💬 BALAS KOMPLAIN", callback_data: `COMPLAIN|${orderId}|${contactInfo}` }
      ]];
  } else {
      // --- LOGIKA ORDER BARU (MANUAL/AUTO) ---
      title = type === 'auto' ? "💰 *LUNAS (MIDTRANS)*" : "🔔 *CEK MUTASI (MANUAL)*";
      const itemList = items ? items.map(i => `- ${i.name} (x${i.qty})`).join('\n') : '-';
      
      bodyText = `📦 *Item:*\n${itemList}\n\n👇 *AKSI ADMIN:*`;
      
      buttons = [[
          { text: type === 'auto' ? "🚀 ISI DATA" : "✅ ACC & ISI DATA", callback_data: `ACC|${orderId}|${contactInfo}` }
      ]];
  }

  const text = `
${title}
--------------------------------
🆔 \`${orderId}\`
💰 *Rp ${parseInt(total || 0).toLocaleString()}*
👤 *Kontak:* \`${contactInfo}\`

${bodyText}
  `.trim();

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      })
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
