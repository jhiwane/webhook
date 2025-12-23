export default async function handler(req, res) {
  // --- SETTING CORS ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // --- SETTING TOKEN ---
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  if (!token || !chatId) return res.status(500).json({ error: 'Env Var Missing' });

  // --- AMBIL DATA ---
  // Kita tambah parameter 'type' untuk membedakan Manual vs Auto
  const { orderId, total, items, buyerContact, type = 'manual' } = req.body;

  // Cari Nomor HP
  let buyerPhone = "0";
  if (buyerContact) {
      buyerPhone = buyerContact; 
  } else if (items && items.length > 0 && items[0].data && items[0].data.length > 0) {
      buyerPhone = items[0].data[0]; 
  }

  const itemList = items ? items.map(i => `- ${i.name} (x${i.qty})`).join('\n') : '- Item tidak terdeteksi';

  // --- LOGIKA PESAN BEDA TIPE ---
  let title = "";
  let actionText = "";
  let buttonText = "";

  if (type === 'auto') {
      // Skenario Midtrans
      title = "💰 *PEMBAYARAN LUNAS (MIDTRANS)*";
      actionText = "✅ Uang sudah masuk otomatis.\n👇 Klik tombol di bawah untuk input data produk.";
      buttonText = "🚀 ISI DATA PRODUK";
  } else {
      // Skenario Manual
      title = "🔔 *KONFIRMASI PEMBAYARAN MANUAL*";
      actionText = "1. Cek Mutasi Bank/E-Wallet.\n2. Jika masuk, klik ACC di bawah.";
      buttonText = "✅ ACC PAID & ISI DATA";
  }

  const text = `
${title}
--------------------------------
🆔 *${orderId}*
💰 *Rp ${parseInt(total).toLocaleString()}*
📞 *Kontak:* \`${buyerPhone}\`

📦 *Item:*
${itemList}

👇 *AKSI ADMIN:*
${actionText}
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
              // Tombol ini akan memicu "Force Reply" di Webhook yang sudah kita buat sebelumnya
              { text: buttonText, callback_data: `ACC_${orderId}_${buyerPhone}` }
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
