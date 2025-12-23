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

// --- CONFIG ---
const LOW_STOCK_THRESHOLD = 3;

// --- HELPER KIRIM PESAN (DENGAN KEYBOARD) ---
async function replyText(token, chatId, text, options = {}) {
    const body = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options 
    };
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

// --- HELPER CARI PRODUK ---
async function findProductByCode(code) {
    let snapshot = await db.collection('products').where('serviceCode', '==', code).get();
    if (!snapshot.empty) return { doc: snapshot.docs[0], type: 'main', index: -1 };
    
    const allProds = await db.collection('products').get();
    for (const doc of allProds.docs) {
        const pData = doc.data();
        if (pData.variations && Array.isArray(pData.variations)) {
            const idx = pData.variations.findIndex(v => v.serviceCode === code);
            if (idx !== -1) return { doc: doc, type: 'variant', index: idx };
        }
    }
    return null; 
}

// --- HELPER FORMAT RUPIAH ---
const fmtRp = (num) => "Rp " + parseInt(num).toLocaleString('id-ID');

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl = "https://" + req.headers.host; 

  if (!db) return res.status(500).send("DB Error");

  // ============================================================
  // 1. HANDLE PERINTAH TEKS
  // ============================================================
  if (req.body.message && req.body.message.text) {
      const msg = req.body.message;
      const text = msg.text.trim();
      const chatId = msg.chat.id;

      // --- A. HELP MENU ---
      if (text === '/help' || text === '/start' || text === '/menu') {
          const helpMsg = `🤖 <b>PANEL KONTROL ADMIN</b>\n\n` +
                          `<b>🔎 Tracking & Filter</b>\n` +
                          `• <code>/trx [ID]</code> : Lacak status pesanan & Kelola\n` +
                          `• <code>/pending</code> : Lihat orderan yg belum di-ACC\n\n` +
                          `<b>📦 Manajemen Stok</b>\n` +
                          `• <code>/list</code> : Daftar Kode & Sisa Stok\n` +
                          `• <code>/cek [KODE]</code> : Lihat isi stok detail\n` +
                          `• <code>/stok [KODE] [DATA]</code> : Isi stok\n` +
                          `• <code>/hapus [KODE] [NO]</code> : Hapus baris stok\n` +
                          `• <code>/edit [KODE] [NO] [DATA]</code> : Edit baris stok`;
          await replyText(token, chatId, helpMsg);
      }

      // --- B. TRACKING ID (/trx ID) ---
      else if (text.startsWith('/trx')) {
          const orderId = text.replace('/trx', '').trim();
          if (!orderId) return await replyText(token, chatId, "⚠️ Masukkan ID.\nContoh: <code>/trx TRX-12345678</code>");

          try {
              const docRef = db.collection('orders').doc(orderId);
              const docSnap = await docRef.get();
              
              if (!docSnap.exists) {
                  return await replyText(token, chatId, `❌ Order ID <b>${orderId}</b> tidak ditemukan.`);
              }

              const o = docSnap.data();
              const itemsList = o.items.map(i => `• ${i.name} x${i.qty}`).join('\n');
              const statusIcon = o.status === 'paid' ? '✅' : (o.status === 'cancelled' ? '❌' : '⏳');
              const contact = o.items[0]?.note || "-";

              const details = `<b>🧾 DETAIL TRANSAKSI</b>\n\n` +
                              `🆔 <b>ID:</b> <code>${docSnap.id}</code>\n` +
                              `📅 <b>Tanggal:</b> ${new Date(o.date).toLocaleString()}\n` +
                              `👤 <b>Kontak:</b> ${contact}\n` +
                              `💰 <b>Total:</b> ${fmtRp(o.total)}\n` +
                              `💳 <b>Metode:</b> ${o.paymentMethod || 'Auto'}\n` +
                              `📊 <b>Status:</b> ${statusIcon} <b>${o.status.toUpperCase()}</b>\n\n` +
                              `🛒 <b>Items:</b>\n${itemsList}`;

              // Logic Tombol Dinamis
              let keyboard = [];
              if (o.status === 'manual_verification' || o.status === 'manual_pending') {
                  keyboard = [
                      [{ text: "✅ ACC SEKARANG", callback_data: `ACC|${docSnap.id}|${contact}` }],
                      [{ text: "❌ TOLAK", callback_data: `REJECT|${docSnap.id}|${contact}` }]
                  ];
              } else if (o.status === 'paid') {
                  keyboard = [
                      [{ text: "📩 KIRIM DATA MANUAL", callback_data: `INPUT|${docSnap.id}|${contact}|0` }],
                      [{ text: "🛡️ BALAS KOMPLAIN", callback_data: `COMPLAIN|${docSnap.id}|${contact}` }]
                  ];
              }

              await replyText(token, chatId, details, {
                  reply_markup: { inline_keyboard: keyboard }
              });

          } catch (e) { await replyText(token, chatId, `Error: ${e.message}`); }
      }

      // --- C. FILTER PENDING (/pending) ---
      else if (text === '/pending') {
          try {
              // Cari status manual_verification (Menunggu Admin)
              const snapshot = await db.collection('orders')
                  .where('status', 'in', ['manual_verification', 'manual_pending'])
                  .orderBy('date', 'desc')
                  .limit(10)
                  .get();

              if (snapshot.empty) {
                  return await replyText(token, chatId, "✅ <b>Aman!</b> Tidak ada pesanan pending.");
              }

              let msg = "⏳ <b>DAFTAR PESANAN PENDING (Perlu Tindakan)</b>\n\n";
              snapshot.forEach(doc => {
                  const o = doc.data();
                  msg += `👉 <code>/trx ${doc.id}</code>\n   ${fmtRp(o.total)} | ${o.items[0].name}\n\n`;
              });
              
              msg += "<i>Klik ID untuk proses ACC/Tolak.</i>";
              await replyText(token, chatId, msg);

          } catch (e) { await replyText(token, chatId, `Error: ${e.message}`); }
      }

      // --- D. FITUR STOK LAINNYA (/list, /stok, /hapus, /edit) ---
      else if (text === '/list') {
          const allProds = await db.collection('products').get();
          let report = "📋 <b>DAFTAR KODE & STOK</b>\n\n";
          let count = 0;
          allProds.docs.forEach(doc => {
              const p = doc.data();
              if (p.serviceCode) {
                  const stock = p.items ? p.items.length : 0;
                  const status = stock === 0 ? "🔴 HABIS" : (stock < LOW_STOCK_THRESHOLD ? "⚠️ DIKIT" : "✅ AMAN");
                  report += `<b>${p.name}</b>\n└ Kode: <code>${p.serviceCode}</code> | Stok: ${stock} ${status}\n\n`;
                  count++;
              }
              if (p.variations) {
                  p.variations.forEach(v => {
                      if (v.serviceCode) {
                          const vStock = v.items ? v.items.length : 0;
                          const vStatus = vStock === 0 ? "🔴 HABIS" : (vStock < LOW_STOCK_THRESHOLD ? "⚠️ DIKIT" : "✅ AMAN");
                          report += `<b>${p.name} - ${v.name}</b>\n└ Kode: <code>${v.serviceCode}</code> | Stok: ${vStock} ${vStatus}\n\n`;
                          count++;
                      }
                  });
              }
          });
          if (count === 0) report += "Belum ada produk dengan Service Code.";
          await replyText(token, chatId, report);
      }

      else if (text.startsWith('/stok')) {
          const content = text.replace('/stok', '').trim();
          const firstSpaceIdx = content.indexOf(' ');
          if (firstSpaceIdx === -1) { await replyText(token, chatId, "⚠️ Format: <code>/stok KODE data1, data2</code>"); return res.send('ok'); }
          const code = content.substring(0, firstSpaceIdx).trim();
          const dataRaw = content.substring(firstSpaceIdx).trim();
          const newItems = dataRaw.split(/\n|,/).map(s => s.trim()).filter(s => s);

          try {
              const target = await findProductByCode(code);
              if (!target) { await replyText(token, chatId, `❌ Kode <b>${code}</b> tidak ditemukan.`); return res.send('ok'); }
              const pData = target.doc.data();
              let currentItems = [];
              let prodName = pData.name;
              if (target.type === 'variant') {
                  const vars = [...pData.variations];
                  currentItems = vars[target.index].items || [];
                  vars[target.index].items = [...currentItems, ...newItems];
                  prodName += ` (${vars[target.index].name})`;
                  await db.collection('products').doc(target.doc.id).update({ variations: vars });
              } else {
                  currentItems = pData.items || [];
                  const updatedItems = [...currentItems, ...newItems];
                  await db.collection('products').doc(target.doc.id).update({ items: updatedItems });
              }
              await replyText(token, chatId, `✅ <b>STOK MASUK!</b>\nProduk: ${prodName}\nMasuk: ${newItems.length}\nTotal: ${(currentItems.length + newItems.length)}`);
          } catch (e) { await replyText(token, chatId, `Error: ${e.message}`); }
      }

      else if (text.startsWith('/cek')) {
          const code = text.replace('/cek', '').trim();
          if (!code) return await replyText(token, chatId, "⚠️ Format: <code>/cek KODE</code>");
          const target = await findProductByCode(code);
          if (!target) return await replyText(token, chatId, "❌ Kode salah.");
          const pData = target.doc.data();
          let items = [];
          let name = pData.name;
          if (target.type === 'variant') { items = pData.variations[target.index].items || []; name += ` - ${pData.variations[target.index].name}`; } 
          else { items = pData.items || []; }
          if (items.length === 0) return await replyText(token, chatId, `📦 <b>${name}</b>\nStok: 0 (KOSONG)`);
          let list = items.map((item, i) => `${i + 1}. <code>${item}</code>`).join('\n');
          if (list.length > 3500) list = list.substring(0, 3500) + "\n... (kepanjangan)";
          await replyText(token, chatId, `📦 <b>STOK: ${name}</b>\nJumlah: ${items.length}\n\n${list}\n\n👉 <i>/hapus ${code} [NO]</i> | <i>/edit ${code} [NO] [DATA]</i>`);
      }

      else if (text.startsWith('/hapus')) {
          const args = text.replace('/hapus', '').trim().split(' ');
          if (args.length < 2) return await replyText(token, chatId, "⚠️ Format: <code>/hapus [KODE] [NO]</code>");
          const code = args[0]; const num = parseInt(args[1]);
          const target = await findProductByCode(code);
          if (!target) return await replyText(token, chatId, "❌ Kode salah.");
          try {
              const docRef = db.collection('products').doc(target.doc.id);
              const pData = target.doc.data();
              let deletedItem = "";
              if (target.type === 'variant') {
                  const vars = [...pData.variations];
                  const items = vars[target.index].items || [];
                  if (num < 1 || num > items.length) return await replyText(token, chatId, "❌ Nomor salah.");
                  deletedItem = items[num - 1]; items.splice(num - 1, 1);
                  vars[target.index].items = items; await docRef.update({ variations: vars });
              } else {
                  const items = pData.items || [];
                  if (num < 1 || num > items.length) return await replyText(token, chatId, "❌ Nomor salah.");
                  deletedItem = items[num - 1]; items.splice(num - 1, 1);
                  await docRef.update({ items: items });
              }
              await replyText(token, chatId, `🗑️ <b>DIHAPUS:</b>\n<code>${deletedItem}</code>`);
          } catch (e) { await replyText(token, chatId, `Error: ${e.message}`); }
      }

      else if (text.startsWith('/edit')) {
          const parts = text.replace('/edit', '').trim().split(' ');
          if (parts.length < 3) return await replyText(token, chatId, "⚠️ Format: <code>/edit [KODE] [NO] [DATA]</code>");
          const code = parts[0]; const num = parseInt(parts[1]); const newData = parts.slice(2).join(' ');
          const target = await findProductByCode(code);
          if (!target) return await replyText(token, chatId, "❌ Kode salah.");
          try {
              const docRef = db.collection('products').doc(target.doc.id);
              const pData = target.doc.data();
              let oldItem = "";
              if (target.type === 'variant') {
                  const vars = [...pData.variations];
                  const items = vars[target.index].items || [];
                  if (num < 1 || num > items.length) return await replyText(token, chatId, "❌ Nomor salah.");
                  oldItem = items[num - 1]; items[num - 1] = newData;
                  vars[target.index].items = items; await docRef.update({ variations: vars });
              } else {
                  const items = pData.items || [];
                  if (num < 1 || num > items.length) return await replyText(token, chatId, "❌ Nomor salah.");
                  oldItem = items[num - 1]; items[num - 1] = newData;
                  await docRef.update({ items: items });
              }
              await replyText(token, chatId, `✏️ <b>DIEDIT:</b>\nLama: <code>${oldItem}</code>\nBaru: <code>${newData}</code>`);
          } catch (e) { await replyText(token, chatId, `Error: ${e.message}`); }
      }
  }

  // ============================================================
  // 2. HANDLE TOMBOL & LOGIC ACC (OTOMATIS STOK)
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

    if (action === 'ACC') {
        const orderRef = db.collection('orders').doc(orderId);
        try {
            await db.runTransaction(async (t) => {
                const orderDoc = await t.get(orderRef);
                if (!orderDoc.exists) throw "Order hilang";
                const orderData = orderDoc.data();
                if (orderData.status === 'paid') throw "Sudah Lunas";

                let items = orderData.items;
                let lowStockAlerts = [];

                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
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

                        // AUTO AMBIL STOK
                        if (stockPool.length >= item.qty) {
                            const taken = stockPool.slice(0, item.qty);
                            const remain = stockPool.slice(item.qty);
                            items[i].data = taken;
                            items[i].isManual = false; 
                            items[i].note = (items[i].note||"") + " [Auto]";

                            if (varIndex !== -1) {
                                const newVars = [...prodData.variations];
                                newVars[varIndex].items = remain;
                                t.update(prodRef, { variations: newVars, realSold: admin.firestore.FieldValue.increment(item.qty) });
                            } else {
                                t.update(prodRef, { items: remain, realSold: admin.firestore.FieldValue.increment(item.qty) });
                            }

                            if (remain.length <= LOW_STOCK_THRESHOLD) {
                                const pName = item.isVariant ? `${prodData.name} (${item.variantName})` : prodData.name;
                                lowStockAlerts.push(`⚠️ <b>STOK KRITIS!</b>\nProduk: ${pName}\nSisa: ${remain.length}`);
                            }
                        }
                    }
                }
                t.update(orderRef, { status: 'paid', items: items });
            });

            // Hapus Pesan & Notif User
            await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            });
            await fetch(`${baseUrl}/api/telegram-notify`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    orderId: orderId, total: 0, items: (await orderRef.get()).data().items,
                    buyerContact: extra, type: 'paid_trigger'
                })
            });

            // Cek Manual untuk Low Stock Alert (Outside Transaction)
            const updatedOrder = (await orderRef.get()).data();
            for(const item of updatedOrder.items) {
                 const prodRef = db.collection('products').doc(item.originalId || item.id);
                 const pSnap = await prodRef.get();
                 if(pSnap.exists) {
                     const pData = pSnap.data();
                     let sisa = 0;
                     let name = pData.name;
                     if(item.isVariant) {
                         const v = pData.variations.find(v=>v.name === item.variantName);
                         if(v) { sisa = v.items?.length || 0; name += ` (${v.name})`; }
                     } else { sisa = pData.items?.length || 0; }
                     
                     if(sisa <= LOW_STOCK_THRESHOLD) {
                         await replyText(token, chatId, `⚠️ <b>PERINGATAN STOK MENIPIS!</b>\n\nProduk: ${name}\nSisa Stok: <b>${sisa}</b>`);
                     }
                 }
            }

        } catch (e) { await replyText(token, chatId, `❌ Gagal ACC: ${e}`); }
    }
    else if (action === 'REJECT') {
        await db.collection('orders').doc(orderId).update({ status: 'cancelled' });
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: `❌ <b>ORDER ${orderId} DITOLAK</b>`, parse_mode: 'HTML' })
        });
    }
    else if (action === 'INPUT') {
        const itemIndex = parseInt(indexParam);
        const docSnap = await db.collection('orders').doc(orderId).get();
        const itemName = docSnap.exists ? docSnap.data().items[itemIndex].name : "Item";
        await replyText(token, chatId, `✍️ <b>INPUT DATA</b>\nProduk: ${itemName}\nOrder: <code>${orderId}</code>\nIndex: ${itemIndex}\n\n<i>Reply data:</i>`, true, `Data...`);
    }
    else if (action === 'COMPLAIN') {
        await replyText(token, chatId, `🛡️ <b>BALAS KOMPLAIN</b>\nOrder: <code>${orderId}</code>\n\n<i>Ketik solusi:</i>`, true, "Solusi...");
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
    const indexMatch = replyOrigin.match(/Index: (\d+)/);
    let itemIndex = indexMatch ? parseInt(indexMatch[1]) : null;

    if (orderId && adminContent) {
        try {
            const orderRef = db.collection('orders').doc(orderId);
            const doc = await orderRef.get();
            if(!doc.exists) throw "Order 404";
            
            let items = doc.data().items;
            let title = "DATA TERSIMPAN";

            if (replyOrigin.includes("BALAS KOMPLAIN")) {
                title = "SOLUSI TERKIRIM";
                await orderRef.update({ complaintReply: adminContent });
            } else {
                if (itemIndex !== null) {
                    items[itemIndex].data = [adminContent];
                    items[itemIndex].isManual = false;
                    items[itemIndex].note = "✅ Sent Manual";
                    await orderRef.update({ items: items, status: 'paid' });
                }
            }

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
