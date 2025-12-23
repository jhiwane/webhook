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

// --- HELPER KIRIM PESAN ---
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

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl = "https://" + req.headers.host; 

  if (!db) return res.status(500).send("DB Error");

  // ============================================================
  // 1. HANDLE INPUT STOK DARI ADMIN (FORMAT CHAT)
  // ============================================================
  // Format: /stok KODE data1, data2
  if (req.body.message && req.body.message.text && req.body.message.text.startsWith('/stok')) {
      const msg = req.body.message;
      const content = msg.text.replace('/stok', '').trim();
      // Pisahkan kode (kata pertama) dan data (sisanya)
      const firstSpaceIdx = content.indexOf(' ');
      if (firstSpaceIdx === -1) {
          await replyText(token, msg.chat.id, "⚠️ <b>Format Salah!</b>\nContoh: <code>/stok ML5 data1, data2</code>");
          return res.send('ok');
      }

      const serviceCode = content.substring(0, firstSpaceIdx).trim();
      const dataString = content.substring(firstSpaceIdx).trim();
      
      const newItems = dataString.split(/\n|,/).map(s => s.trim()).filter(s => s);

      if (!serviceCode || newItems.length === 0) {
          await replyText(token, msg.chat.id, "⚠️ Data kosong. Masukkan data setelah kode.");
          return res.send('ok');
      }

      try {
          // --- LOGIKA PENCARIAN (DEEP SEARCH) ---
          
          // A. Cek di Produk Utama Dulu
          let snapshot = await db.collection('products').where('serviceCode', '==', serviceCode).get();
          let targetDoc = null;
          let isVariation = false;
          let varIndex = -1;

          if (!snapshot.empty) {
              targetDoc = snapshot.docs[0];
          } else {
              // B. Jika tidak ketemu, Scan ke dalam VARIASI
              // Kita ambil semua produk (aman untuk toko < 1000 produk)
              const allProds = await db.collection('products').get();
              
              for (const doc of allProds.docs) {
                  const pData = doc.data();
                  if (pData.variations && Array.isArray(pData.variations)) {
                      // Cari apakah ada variasi yang kodenya cocok
                      const idx = pData.variations.findIndex(v => v.serviceCode === serviceCode);
                      if (idx !== -1) {
                          targetDoc = doc;
                          isVariation = true;
                          varIndex = idx;
                          break; // Ketemu! Berhenti looping
                      }
                  }
              }
          }

          if (!targetDoc) {
              await replyText(token, msg.chat.id, `❌ Produk/Variasi dengan kode <b>${serviceCode}</b> tidak ditemukan.`);
              return res.send('ok');
          }

          // --- PROSES UPDATE DATABASE ---
          const productData = targetDoc.data();
          let productName = productData.name;
          let currentStockCount = 0;

          if (isVariation) {
              // Update Stok Variasi
              const updatedVars = [...productData.variations];
              const currentVarItems = updatedVars[varIndex].items || [];
              updatedVars[varIndex].items = [...currentVarItems, ...newItems];
              
              productName += ` (${updatedVars[varIndex].name})`; // Tambah nama variasi
              currentStockCount = updatedVars[varIndex].items.length;

              await db.collection('products').doc(targetDoc.id).update({ variations: updatedVars });
          } else {
              // Update Stok Utama
              const currentItems = productData.items || [];
              const updatedItems = [...currentItems, ...newItems];
              currentStockCount = updatedItems.length;

              await db.collection('products').doc(targetDoc.id).update({ items: updatedItems });
          }

          await replyText(token, msg.chat.id, `✅ <b>STOK MASUK!</b>\n\nProduk: ${productName}\nKode: <code>${serviceCode}</code>\nMasuk: ${newItems.length} item\nTotal Stok: ${currentStockCount}`);

      } catch (e) {
          await replyText(token, msg.chat.id, `❌ Error System: ${e.message}`);
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
    const action = parts[0]; 
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
                let processedCount = 0;

                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    // Logic Cek Stok (Support Variasi)
                    const prodId = item.originalId || item.id;
                    const prodRef = db.collection('products').doc(prodId);
                    const prodDoc = await t.get(prodRef);

                    if (prodDoc.exists) {
                        const prodData = prodDoc.data();
                        let stockPool = [];
                        let varIndex = -1;

                        if (item.isVariant && prodData.variations) {
                            varIndex = prodData.variations.findIndex(v => v.name === item.variantName);
                            if (varIndex !== -1) stockPool = prodData.variations[varIndex].items || [];
                        } else {
                            stockPool = prodData.items || [];
                        }

                        // Jika Stok Cukup -> Ambil
                        if (stockPool.length >= item.qty) {
                            const taken = stockPool.slice(0, item.qty);
                            const remain = stockPool.slice(item.qty);

                            items[i].data = taken;
                            items[i].isManual = false; 
                            items[i].note = (items[i].note||"") + " [Auto]";
                            processedCount++;

                            if (varIndex !== -1) {
                                const newVars = [...prodData.variations];
                                newVars[varIndex].items = remain;
                                t.update(prodRef, { variations: newVars, realSold: admin.firestore.FieldValue.increment(item.qty) });
                            } else {
                                t.update(prodRef, { items: remain, realSold: admin.firestore.FieldValue.increment(item.qty) });
                            }
                        }
                    }
                }
                t.update(orderRef, { status: 'paid', items: items });
            });

            // Hapus Pesan ACC
            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            });

            // Trigger Tampilan Lunas (Tombol Input hanya muncul jika stok habis/manual)
            await fetch(`${baseUrl}/api/telegram-notify`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    orderId: orderId, total: 0, 
                    items: (await orderRef.get()).data().items,
                    buyerContact: buyerContact, type: 'paid_trigger'
                })
            });

        } catch (e) { await replyText(token, chatId, `❌ Gagal ACC: ${e}`); }
    }

    // --- B. ADMIN KLIK "TOLAK" ---
    else if (action === 'REJECT') {
        await db.collection('orders').doc(orderId).update({ status: 'cancelled' });
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: `❌ <b>ORDER ${orderId} DITOLAK</b>`, parse_mode: 'HTML' })
        });
    }

    // --- C. KLIK "ISI ITEM" ---
    else if (action === 'INPUT') {
        const itemIndex = parseInt(extra);
        const docSnap = await db.collection('orders').doc(orderId).get();
        const itemName = docSnap.exists ? docSnap.data().items[itemIndex].name : "Item";
        await replyText(token, chatId, `✍️ <b>INPUT DATA</b>\nProduk: ${itemName}\nOrder: ${orderId}\nIndex: ${itemIndex}\n\n<i>Reply data:</i>`, true, `Data...`);
    }

    // --- D. KLIK "KOMPLAIN" ---
    else if (action === 'COMPLAIN') {
        const idx = indexParam ? parseInt(indexParam) : null;
        await replyText(token, chatId, `🛡️ <b>BALAS KOMPLAIN</b>\nOrder: ${orderId}\nIndex: ${idx!==null?idx:'-'}\n\n<i>Ketik solusi:</i>`, true, "Solusi...");
    }

    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ callback_query_id: callback.id })
    });
  }

  // ============================================================
  // 3. HANDLE REPLY TEXT (INPUT DATA / KOMPLAIN)
  // ============================================================
  else if (req.body.message && req.body.message.reply_to_message) {
    const msg = req.body.message;
    const replyOrigin = msg.reply_to_message.text;
    const adminContent = msg.text;
    const chatId = msg.chat.id;

    const orderId = (replyOrigin.match(/Order: ([^\s\n]+)/) || [])[1];
    const indexMatch = replyOrigin.match(/Index: (\d+|-)/);
    let itemIndex = (indexMatch && indexMatch[1] !== '-') ? parseInt(indexMatch[1]) : null;

    if (orderId && adminContent) {
        try {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await orderRef.get();
            if(!doc.exists) throw "Order 404";
            
            let items = doc.data().items;
            let title = "DATA TERSIMPAN";

            if (replyOrigin.includes("BALAS KOMPLAIN")) {
                title = "SOLUSI TERKIRIM";
                if (itemIndex !== null) items[itemIndex].note = `[ADMIN]: ${adminContent} | ${items[itemIndex].note||''}`;
                else await orderRef.update({ complaintReply: adminContent });
            } else {
                if (itemIndex !== null) {
                    items[itemIndex].data = [adminContent];
                    items[itemIndex].isManual = false;
                    items[itemIndex].note = "✅ Sent Manual";
                }
            }
            // Update items jika ada perubahan di array items
            if (itemIndex !== null) await orderRef.update({ items: items, status: 'paid' });

            // Kirim link WA ke Admin
            const contact = items[0]?.note || "";
            let link = "";
            if(contact.startsWith('08') || contact.startsWith('62')) {
                let p = contact.replace(/^08/, '62').replace(/[^0-9]/g, '');
                link = `\n<a href="https://wa.me/${p}?text=${encodeURIComponent('Update pesanan: ' + adminContent)}">👉 Kirim WA</a>`;
            }
            await replyText(token, chatId, `✅ <b>${title}</b>\nOrder: ${orderId}\nIsi: ${adminContent}${link}`);

        } catch (e) { await replyText(token, chatId, `❌ Gagal: ${e.message}`); }
    }
  }

  return res.status(200).send('OK');
}
