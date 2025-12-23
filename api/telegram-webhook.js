import admin from 'firebase-admin';

// --- INIT FIREBASE ---
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      const serviceAccount = JSON.parse(raw);
      if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
  } catch (e) { console.error("Firebase Error:", e.message); }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- HELPER: FORMAT RUPIAH ---
const formatRp = (num) => "Rp " + parseInt(num).toLocaleString('id-ID');

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl = "https://" + req.headers.host; 

  if (!db) return res.status(500).send("DB Error");

  // ============================================================
  // 1. HANDLE INPUT STOK DARI ADMIN (FORMAT CHAT)
  // ============================================================
  // Format: /stok KODE_PRODUK data1, data2, data3
  // Contoh: /stok ML5 user1|pass1, user2|pass2
  if (req.body.message && req.body.message.text && req.body.message.text.startsWith('/stok')) {
      const msg = req.body.message;
      const content = msg.text.replace('/stok', '').trim(); // Hapus command
      const [serviceCode, ...dataRaw] = content.split(' '); // Ambil kata pertama sbg kode
      const dataString = dataRaw.join(' '); // Sisa text adalah data
      
      // Pisahkan data berdasarkan baris baru atau koma
      const newItems = dataString.split(/\n|,/).map(s => s.trim()).filter(s => s);

      if (!serviceCode || newItems.length === 0) {
          await replyText(token, msg.chat.id, "⚠️ <b>Format Salah!</b>\n\nContoh:\n<code>/stok KODE data1, data2</code>\n\nPastikan produk punya <b>Service Code</b> di Web.");
          return res.send('ok');
      }

      try {
          // Cari Produk berdasarkan serviceCode
          const snapshot = await db.collection('products').where('serviceCode', '==', serviceCode).get();
          
          if (snapshot.empty) {
              // Coba cari di variasi (agak kompleks, kita cari produk utama dulu)
              await replyText(token, msg.chat.id, `❌ Produk dengan kode <b>${serviceCode}</b> tidak ditemukan.`);
          } else {
              const productDoc = snapshot.docs[0];
              const currentItems = productDoc.data().items || [];
              const updatedItems = [...currentItems, ...newItems];
              
              await db.collection('products').doc(productDoc.id).update({ items: updatedItems });
              await replyText(token, msg.chat.id, `✅ <b>STOK BERHASIL DITAMBAH!</b>\n\nProduk: ${productDoc.data().name}\nKode: ${serviceCode}\nJumlah Masuk: ${newItems.length}\nTotal Stok: ${updatedItems.length}`);
          }
      } catch (e) {
          await replyText(token, msg.chat.id, `❌ Error: ${e.message}`);
      }
      return res.send('ok');
  }

  // ============================================================
  // 2. HANDLE TOMBOL (CALLBACK QUERY)
  // ============================================================
  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const data = callback.data;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;

    const parts = data.split('|');
    const action = parts[0]; // ACC, INPUT, REJECT, COMPLAIN
    const orderId = parts[1];
    const extra = parts[2]; 
    const indexParam = parts[3];

    // --- A. ADMIN KLIK "ACC" (SMART AUTO-STOCK) ---
    if (action === 'ACC') {
        const buyerContact = extra; 
        const orderRef = db.collection('orders').doc(orderId);
        
        try {
            await db.runTransaction(async (t) => {
                const orderDoc = await t.get(orderRef);
                if (!orderDoc.exists) throw "Order hilang";
                
                const orderData = orderDoc.data();
                if (orderData.status === 'paid') throw "Sudah Lunas";

                let items = orderData.items;
                let autoProcessedCount = 0;

                // LOOPING ITEM UNTUK CEK STOK OTOMATIS
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    // Cek apakah item ini butuh stok (bukan manual murni)
                    // Kita cari produk aslinya di DB
                    const prodId = item.originalId || item.id;
                    const prodRef = db.collection('products').doc(prodId);
                    const prodDoc = await t.get(prodRef);

                    if (prodDoc.exists) {
                        const prodData = prodDoc.data();
                        let stockPool = [];
                        let isVariant = item.isVariant;
                        let varIndex = -1;

                        // Ambil kolam stok (Main atau Variasi)
                        if (isVariant && prodData.variations) {
                            varIndex = prodData.variations.findIndex(v => v.name === item.variantName);
                            if (varIndex !== -1) stockPool = prodData.variations[varIndex].items || [];
                        } else {
                            stockPool = prodData.items || [];
                        }

                        // JIKA STOK CUKUP -> AMBIL OTOMATIS
                        if (stockPool.length >= item.qty) {
                            const takenStock = stockPool.slice(0, item.qty);
                            const remainingStock = stockPool.slice(item.qty);

                            // Update data item di Order
                            items[i].data = takenStock;
                            items[i].isManual = false; // Matikan tanda manual
                            items[i].note = (items[i].note || "") + " [Auto-Processed by Bot]";
                            autoProcessedCount++;

                            // Update Stok Produk di DB
                            if (isVariant && varIndex !== -1) {
                                const newVars = [...prodData.variations];
                                newVars[varIndex].items = remainingStock;
                                t.update(prodRef, { variations: newVars, realSold: admin.firestore.FieldValue.increment(item.qty) });
                            } else {
                                t.update(prodRef, { items: remainingStock, realSold: admin.firestore.FieldValue.increment(item.qty) });
                            }
                        }
                        // JIKA STOK KOSONG -> BIARKAN MANUAL (Nanti Admin Input)
                    }
                }

                // Update Order jadi PAID dengan items yang mungkin sudah terisi sebagian
                t.update(orderRef, { status: 'paid', items: items });
            });

            // BERI TAHU ADMIN & TRIGGER INPUT UNTUK SISA ITEM
            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            });

            await fetch(`${baseUrl}/api/telegram-notify`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    orderId: orderId,
                    total: 0, // Dummy
                    items: (await orderRef.get()).data().items, // Ambil items terbaru (yg sudah ada isinya)
                    buyerContact: buyerContact,
                    type: 'paid_trigger' // Panggil tampilan LUNAS
                })
            });

        } catch (e) {
            await replyText(token, chatId, `❌ Gagal ACC: ${e.message || e}`);
        }
    }

    // --- B. ADMIN KLIK "TOLAK" ---
    else if (action === 'REJECT') {
        await db.collection('orders').doc(orderId).update({ status: 'cancelled', adminMessage: 'Pesanan Dibatalkan/Dana tidak masuk.' });
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                chat_id: chatId, message_id: messageId,
                text: `❌ <b>ORDER ${orderId} DITOLAK</b>\nStatus diubah menjadi Cancelled.`,
                parse_mode: 'HTML'
            })
        });
    }

    // --- C. ADMIN KLIK "ISI ITEM" (MANUAL INPUT) ---
    else if (action === 'INPUT') {
        const itemIndex = parseInt(extra);
        const docSnap = await db.collection('orders').doc(orderId).get();
        const itemName = docSnap.exists ? docSnap.data().items[itemIndex].name : "Item";

        await replyText(token, chatId, `✍️ <b>INPUT DATA KONTEN</b>\n\nProduk: <b>${itemName}</b>\nOrder: <code>${orderId}</code>\nIndex: ${itemIndex}\n\n<i>Reply pesan ini dengan data akun/voucher:</i>`, true, `Data untuk ${itemName}...`);
    }

    // --- D. ADMIN KLIK "BALAS KOMPLAIN" ---
    else if (action === 'COMPLAIN') {
        const itemIdx = indexParam ? parseInt(indexParam) : null;
        const label = itemIdx !== null ? `ITEM #${itemIdx+1}` : "UMUM";
        await replyText(token, chatId, `🛡️ <b>BALAS KOMPLAIN (${label})</b>\n\nOrder: <code>${orderId}</code>\nIndex: ${itemIdx !== null ? itemIdx : '-'}\n\n<i>Ketik solusi untuk pembeli:</i>`, true, "Solusi...");
    }

    // Tutup loading
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id })
    });
  }

  // ============================================================
  // 3. HANDLE BALASAN ADMIN (TEXT REPLY)
  // ============================================================
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyOrigin = msg.reply_to_message.text;
    const adminContent = msg.text;
    const chatId = msg.chat.id;

    // Parsing ID dan Index
    const orderIdMatch = replyOrigin.match(/Order: ([^\s\n]+)/);
    const indexMatch = replyOrigin.match(/Index: (\d+|-)/);

    const orderId = orderIdMatch ? orderIdMatch[1] : null;
    let itemIndex = (indexMatch && indexMatch[1] !== '-') ? parseInt(indexMatch[1]) : null;

    if (orderId && adminContent) {
        try {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await orderRef.get();
            if (!doc.exists) throw "Order 404";

            let items = doc.data().items || [];
            let updateData = {};
            let replyTitle = "DATA TERSIMPAN";

            // LOGIKA BALASAN
            if (replyOrigin.includes("BALAS KOMPLAIN")) {
                replyTitle = "SOLUSI TERKIRIM";
                if (itemIndex !== null && items[itemIndex]) {
                    items[itemIndex].note = `[ADMIN]: ${adminContent} | ${items[itemIndex].note || ''}`;
                    updateData = { items };
                } else {
                    updateData = { complaintReply: adminContent };
                }
            } else {
                // INPUT DATA MANUAL
                if (itemIndex !== null && items[itemIndex]) {
                    items[itemIndex].data = [adminContent];
                    items[itemIndex].isManual = false; 
                    items[itemIndex].note = "✅ Data Terkirim Manual";
                    updateData = { items, status: 'paid' };
                }
            }

            await orderRef.update(updateData);
            
            // Generate Link
            const contact = items[0]?.note || "";
            let link = "";
            if(contact.match(/^\d+$/) || contact.startsWith('08') || contact.startsWith('62')) {
                 let p = contact.replace(/^08/, '62').replace(/[^0-9]/g, '');
                 link = `\n<a href="https://wa.me/${p}?text=${encodeURIComponent('Halo, update pesanan: ' + adminContent)}">👉 Kirim WA</a>`;
            }

            await replyText(token, chatId, `✅ <b>${replyTitle}</b>\nOrder: ${orderId}\nIsi: ${adminContent}${link}`);

        } catch (e) {
            await replyText(token, chatId, `❌ Gagal: ${e.message}`);
        }
    }
  }

  return res.status(200).send('OK');
}

// Helper Function Kirim Pesan
async function replyText(token, chatId, text, forceReply = false, placeholder = "") {
    const body = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    };
    if (forceReply) {
        body.reply_markup = { force_reply: true, input_field_placeholder: placeholder };
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}
