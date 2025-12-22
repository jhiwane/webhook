export default async function handler(req, res) {
    // 1. Cek Environment Variables (Hanya log 'Ada' atau 'Tidak', jangan log Token aslinya demi keamanan)
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_ID;

    console.log("--- DEBUG START ---");
    console.log("Request Method:", req.method);
    console.log("Bot Token Status:", token ? "ADA" : "TIDAK ADA");
    console.log("Chat ID Status:", chatId ? "ADA" : "TIDAK ADA");

    if (!token || !chatId) {
        console.error("ERROR: Env Vars Missing");
        return res.status(500).json({ error: 'Token/ChatID belum disetting di Vercel' });
    }

    // 2. Ambil data (Handle GET untuk tes browser & POST untuk aplikasi)
    let message = "Tes Koneksi Bot Berhasil!";
    
    if (req.method === 'POST') {
        const { orderId, total } = req.body;
        if (orderId) {
            message = `🔔 *PESANAN BARU (MANUAL)*\nID: ${orderId}\nTotal: Rp ${total}\n\nMohon Cek Mutasi!`;
        }
    }

    try {
        // 3. Kirim ke Telegram
        const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`;
        console.log("Sending to:", telegramUrl);

        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            })
        });

        const data = await response.json();
        console.log("Telegram Response:", data);

        if (!data.ok) {
            throw new Error(data.description);
        }

        return res.status(200).json({ success: true, telegram_response: data });

    } catch (error) {
        console.error("FETCH ERROR:", error.message);
        return res.status(500).json({ error: error.message });
    }
}
