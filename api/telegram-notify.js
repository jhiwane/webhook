export default async function handler(req, res) {
  // --- 1. SETTING CORS (WAJIB AGAR TIDAK DI-BLOKIR BROWSER) ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Mengizinkan akses dari mana saja (Firebase)
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Jika browser melakukan "Pengecekan Awal" (Preflight), langsung jawab OK
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Hanya terima POST
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // --- 2. AMBIL TOKEN DARI ENV VERCEL ---
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  // Cek apakah Token ada
  if (!token || !chatId) {
    console.error("ERROR: Env Vars Missing in Vercel");
    return res.status(500).json({ 
      error: 'Konfigurasi Server Belum Lengkap', 
      details: 'TELEGRAM_BOT_TOKEN atau TELEGRAM_ADMIN_ID belum terbaca di Vercel Settings.' 
    });
  }

  // --- 3. PROSES DATA ---
  const { orderId, total, items, buyerContact } = req.body;

  // Logika Cerdas Mencari Nomor HP (Untuk fitur WA Otomatis)
  let buyerPhone = "0";
  if (buyerContact) {
      buyerPhone = buyerContact; 
  } else if (items && items.length > 0 && items[0].data && items[0].data.length > 0) {
      buyerPhone = items[0].data[0]; 
  }

  // Format list item
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
              // Tombol ACC membawa data OrderID & NoHP
              { text: "✅ ACC PAID & ISI DATA", callback_data: `ACC_${orderId}_${buyerPhone}` }
            ]
          ]
        }
      })
    });

    const result = await response.json();
    
    if (!result.ok) {
        throw new Error(`Telegram API Error: ${result.description}`);
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("TELEGRAM ERROR:", error.message);
    return res.status(500).json({ error: error.message });
  }
}
