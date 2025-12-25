// file: api/notify.js
const { Telegraf } = require('telegraf');

// Pastikan Token & Admin ID ada di .env
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID; 

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // Ambil data yang dikirim dari Frontend saat onSuccess
        const { orderId, total, items, buyerContact, type } = req.body;

        // --- 1. SUSUN PESAN LAPORAN KE ADMIN ---
        let message = `✅ <b>PEMBAYARAN SUKSES (AUTO)</b>\n\n`;
        message += `🆔 Order ID: <code>${orderId}</code>\n`;
        message += `💰 Total: Rp ${parseInt(total).toLocaleString('id-ID')}\n`;
        message += `👤 Kontak: ${buyerContact}\n\n`;
        
        message += `🛒 <b>Item Dibeli:</b>\n`;
        let contentToSend = ""; // Menampung konten (akun/kode) untuk user

        items.forEach((item, index) => {
            // Abaikan Voucher di list tampilan
            if(item.name.startsWith("VOUCHER")) return; 

            message += `${index+1}. ${item.name} x${item.qty}\n`;
            
            // Cek apakah ada data rahasia (akun/kode) di dalam item note/data
            // Di kode frontend Anda: data: c.note ? [c.note] : []
            if (item.data && item.data.length > 0) {
                message += `   <i>Data: ${item.data.join(', ')}</i>\n`;
                contentToSend += `📦 <b>${item.name}</b>:\n<code>${item.data.join('\n')}</code>\n\n`;
            } else {
                // Jika tidak ada data otomatis, beri tanda harus proses manual
                message += `   ℹ️ <i>(Butuh Proses Manual / Stok Fisik)</i>\n`;
            }
        });

        message += `\n<i>Mohon cek Dashboard Midtrans untuk detail mutasi.</i>`;

        // --- 2. KIRIM KE TELEGRAM ADMIN ---
        if (ADMIN_ID) {
            await bot.telegram.sendMessage(ADMIN_ID, message, { parse_mode: 'HTML' });
            
            // --- 3. (OPSIONAL) KIRIM KONTEN KE ADMIN JUGA SUPAYA GAMPANG COPAS ---
            if (contentToSend) {
                 await bot.telegram.sendMessage(ADMIN_ID, "👇 <b>KONTEN PESANAN UNTUK BUYER:</b>\n\n" + contentToSend, { parse_mode: 'HTML' });
            }
        }

        // --- 4. SUKSES ---
        res.status(200).json({ status: 'Notification Sent' });

    } catch (e) {
        console.error("Notify Error:", e);
        res.status(500).json({ error: "Gagal kirim notifikasi" });
    }
};
