// api/telegram-webhook.js
const { db, admin } = require('./firebaseConfig');
const { sendMessage, BOT_TOKEN } = require('./botConfig');

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const update = req.body;

    try {
        // 1. HANDLE TOMBOL (CALLBACK QUERY)
        if (update.callback_query) {
            const data = update.callback_query.data;
            const chatId = update.callback_query.message.chat.id;
            const msgId = update.callback_query.message.message_id;

            if (data.startsWith('ACC_')) {
                const orderId = data.split('_')[1];
                
                // Trigger logic proses stok (sama seperti midtrans webhook)
                // Kita "hack" sedikit dengan memanggil fungsi proses inventory
                // Dalam production, sebaiknya funsgi logic stok dipisah ke file 'utils.js' lalu diimport
                // Disini kita update status dulu
                await db.collection('orders').doc(orderId).update({ status: 'paid' });
                await sendMessage(chatId, `✅ Order ${orderId} di-ACC. Mengecek stok...`);

                // Panggil endpoint midtrans-webhook secara internal atau copy logicnya (disini simulasi logic)
                // Agar simple, kita suruh admin cek manual itemsnya lewat pesan baru
                const orderSnap = await db.collection('orders').doc(orderId).get();
                const order = orderSnap.data();
                
                let manualItemsMsg = `📝 <b>PENGISIAN DATA ORDER ${orderId}</b>\n\n`;
                let count = 0;
                order.items.forEach((item, idx) => {
                    // Cek jika item belum punya data (butuh manual)
                    if (!item.data || item.data.length === 0) {
                        manualItemsMsg += `🔹 <b>Item #${idx + 1}:</b> ${item.name} (Qty: ${item.qty})\n`;
                        manualItemsMsg += `   <i>Note: ${item.note || '-'}</i>\n`;
                        manualItemsMsg += `👉 <b>REPLY</b> pesan ini dengan format:\n<code>#${idx} data1</code> (jika 1 baris)\nAtau enter untuk banyak baris.\n\n`;
                        count++;
                    }
                });

                if (count > 0) {
                    await sendMessage(chatId, manualItemsMsg + "Admin, silakan balas pesan ini sesuai instruksi.");
                } else {
                    await sendMessage(chatId, "✅ Semua item sudah otomatis/terisi. Tidak ada tindakan diperlukan.");
                }

            } else if (data.startsWith('REJECT_')) {
                const orderId = data.split('_')[1];
                await db.collection('orders').doc(orderId).update({ status: 'cancelled' });
                await sendMessage(chatId, `❌ Order ${orderId} Dibatalkan.`);
            }
            
            return res.status(200).json({ status: 'ok' });
        }

        // 2. HANDLE BALASAN PESAN (TEXT)
        if (update.message && update.message.text && update.message.reply_to_message) {
            const replyText = update.message.text; // Teks yang diketik admin
            const originalText = update.message.reply_to_message.text; // Pesan bot yang direply

            // A. UPDATE ITEM/DATA (Format: #index data)
            // Bot mendeteksi order ID dari pesan asli
            const orderIdMatch = originalText.match(/ORDER (?:PAID|ID|MANUAL).+?(\w{5,})/i) || originalText.match(/ID: (\S+)/);
            
            if (orderIdMatch) {
                const orderId = orderIdMatch[1];
                
                // Parsing Input Admin
                // Admin bisa ngetik: "#0 kode123" atau hanya "kode123" (jika single item)
                // Sesuai permintaan: "Admin cukup tulis 5 paragraf"
                
                // Kita butuh tau admin mau ngisi item index ke berapa. 
                // Cara pintar: Cek hashtag #0, #1 di awal pesan.
                // Jika tidak ada hashtag, asumsi item pertama yang kosong? Agak riskan.
                // Mari kita paksa admin pakai format simpel: "#0 [enter] data"
                
                // TAPI, user minta "Langsung tulis". 
                // Oke, mari kita buat parser pintar.
                
                // Cek apakah ada format "#Angka"
                let targetIndex = 0;
                let dataToFill = [];
                
                if (replyText.startsWith('#')) {
                    const splitSpace = replyText.indexOf(' ');
                    const splitEnter = replyText.indexOf('\n');
                    let splitIdx = (splitSpace !== -1 && splitSpace < splitEnter) ? splitSpace : splitEnter;
                    if(splitIdx === -1) splitIdx = replyText.length;
                    
                    const indexStr = replyText.substring(1, splitIdx);
                    targetIndex = parseInt(indexStr); // Ambil index (misal 0 utk item pertama)
                    
                    const rawData = replyText.substring(splitIdx).trim();
                    dataToFill = rawData.split('\n').filter(s => s.trim() !== '');
                } else {
                    // Jika admin lupa kasih index, kita cari item pertama yang masih kosong datanya
                   const oSnap = await db.collection('orders').doc(orderId).get();
                   const oData = oSnap.data();
                   targetIndex = oData.items.findIndex(i => !i.data || i.data.length === 0);
                   
                   if (targetIndex === -1) {
                       await sendMessage(update.message.chat.id, "⚠️ Semua item sepertinya sudah terisi. Gunakan #index untuk menimpa.");
                       return res.status(200).send('ok');
                   }
                   
                   dataToFill = replyText.split('\n').filter(s => s.trim() !== '');
                }

                if (isNaN(targetIndex)) return res.status(200).send('ok');

                // UPDATE FIRESTORE
                const orderRef = db.collection('orders').doc(orderId);
                const currentDoc = await orderRef.get();
                const currentItems = currentDoc.data().items;

                // Pastikan items valid
                if (!currentItems[targetIndex]) {
                    await sendMessage(update.message.chat.id, "❌ Index item salah.");
                    return res.status(200).send('ok');
                }

                // Masukkan data (bisa replace atau append, disini kita replace biar fix)
                currentItems[targetIndex].data = dataToFill;
                
                // Update Firestore
                await orderRef.update({ items: currentItems });

                await sendMessage(update.message.chat.id, `✅ <b>Data Tersimpan ke Web!</b>\nItem #${targetIndex + 1}: Terisi ${dataToFill.length} data.`);
            }

            // B. BALAS KOMPLAIN (Reply text biasa ke pesan komplain)
            const complaintMatch = originalText.match(/KOMPLAIN BARU/);
            if (complaintMatch) {
                const orderId = originalText.match(/Order ID: (.+)/)[1];
                await db.collection('orders').doc(orderId.trim()).update({
                    complaintReply: replyText
                });
                await sendMessage(update.message.chat.id, "✅ Balasan dikirim ke pembeli (Web).");
            }
        }

    } catch (e) {
        console.error("Webhook Error:", e);
    }

    return res.status(200).send('OK');
}
