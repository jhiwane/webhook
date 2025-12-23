export default async function handler(req, res) {
  // --- CORS HEADERS (PENTING AGAR TIDAK BLOCKED OLEH BROWSER) ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_ID;

  if (!token || !chatId) return res.status(500).json({ error: 'Env Var Missing' });

  // --- AMBIL DATA DARI FRONTEND/WEBHOOK ---
  // type: 'manual' (Menunggu ACC), 'auto' (Lunas/Midtrans), 'paid_trigger' (Dari Webhook setelah ACC), 'complaint'
  const { orderId, total, items, buyerContact, type = 'manual', message = '', itemIndex } = req.body;

  // Cari Kontak (Fallback jika buyerContact kosong)
  let contactInfo = buyerContact || "-";
  if (contactInfo === "-" && items?.[0]?.note) contactInfo = items[0].note;

  // --- LOGIKA PESAN & TOMBOL DINAMIS ---
  let text = "";
  let buttons = [];

  // ============================================================
  // SKENARIO 1: ADA KOMPLAIN DARI USER
  // ============================================================
  if (type === 'complaint') {
      text = `⚠️ <b>ADA KOMPLAIN MASUK!</b>\n`;
      text += `🆔 <code>${orderId}</code>\n`;
      text += `👤 ${contactInfo}\n\n`;
      text += `🗣️ <b>Keluhan User:</b>\n"<i>${message}</i>"\n\n`;
      text += `👇 Segera cek dan balas solusi di bawah.`;
      
      // Tombol Balas Komplain
      // Kita tambahkan itemIndex jika ada (untuk komplain spesifik item)
      const indexStr = itemIndex !== undefined ? `|${itemIndex}` : '';
      buttons.push([
          { text: "💬 BALAS KOMPLAIN", callback_data: `COMPLAIN|${orderId}|${contactInfo}${indexStr}` }
      ]);
  } 

  // ============================================================
  // SKENARIO 2: ORDER BARU - MANUAL (BUTUH ACC)
  // ============================================================
  else if (type === 'manual') {
      text = `💸 <b>KONFIRMASI PEMBAYARAN MANUAL</b>\n`;
      text += `🆔 <code>${orderId}</code>\n`;
      text += `💰 <b>Rp ${parseInt(total || 0).toLocaleString()}</b>\n`;
      text += `👤 ${contactInfo}\n\n`;
      text += `📋 <b>List Item:</b>\n`;
      if(items) items.forEach((i, idx) => { text += `${idx+1}. ${i.name} (x${i.qty})\n`; });
      
      text += `\n⚠️ <i>Cek mutasi rekening. Jika dana masuk, klik ACC.</i>`;

      // Tombol ACC (Satu tombol Global)
      buttons.push([
          { text: "✅ TERIMA (ACC) & PROSES", callback_data: `ACC|${orderId}|${contactInfo}` }
      ]);
      buttons.push([
          { text: "❌ TOLAK", callback_data: `REJECT|${orderId}` }
      ]);
  }

  // ============================================================
  // SKENARIO 3: ORDER LUNAS (AUTO / SUDAH DI-ACC) - MINTA DATA
  // ============================================================
  else if (type === 'auto' || type === 'paid_trigger') {
      text = `📦 <b>ORDER LUNAS (SIAP PROSES)</b>\n`;
      text += `🆔 <code>${orderId}</code>\n`;
      text += `💰 Rp ${parseInt(total || 0).toLocaleString()} (Paid)\n`;
      text += `👤 ${contactInfo}\n\n`;
      text += `📋 <b>DAFTAR ITEM:</b>\n`;

      // LOOPING ITEM UNTUK MEMBUAT TOMBOL
      if (items && Array.isArray(items)) {
          items.forEach((item, index) => {
              // Tanda status di teks pesan
              const statusIcon = item.isManual ? "⏳" : "✅";
              text += `${index + 1}. ${item.name} (x${item.qty}) ${statusIcon}\n`;

              // Jika item statusnya MANUAL (Butuh diisi admin), buat tombolnya
              if (item.isManual) {
                  // Potong nama item biar tombol ga kepanjangan
                  const shortName = item.name.length > 20 ? item.name.substring(0, 17) + '...' : item.name;
                  
                  // TOMBOL SINKRONISASI: INPUT|ID|INDEX
                  buttons.push([
                      { text: `📝 Isi Item #${index+1}: ${shortName}`, callback_data: `INPUT|${orderId}|${index}` }
                  ]);
              }
          });
      }

      // Jika semua item otomatis/sudah selesai
      const pendingItems = items ? items.filter(i => i.isManual).length : 0;
      if (pendingItems === 0) {
          text += `\n✅ <i>Semua item otomatis/sudah diproses.</i>`;
      } else {
          text += `\n👇 <i>Klik tombol item yang ingin diisi datanya:</i>`;
      }
  }

  // --- KIRIM KE TELEGRAM ---
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML', // PENTING: Saya ubah ke HTML agar lebih aman untuk format list
        reply_markup: { inline_keyboard: buttons }
      })
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
