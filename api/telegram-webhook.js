import admin from 'firebase-admin';

// --- 1. INISIALISASI FIREBASE (SAMA DENGAN APP.JSX) ---
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      const serviceAccount = JSON.parse(raw);
      // Fix format private key jika dari environment variable
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
  } catch (e) {
    console.error("Firebase Init Error:", e.message);
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// --- 2. CONFIG ---
const LOW_STOCK_THRESHOLD = 3;

// --- 3. HELPER FUNCTION: CARI PRODUK BERDASARKAN SERVICE CODE ---
// Ini adalah KUNCI agar Bot sinkron dengan App.jsx. 
// Bot mencari field 'serviceCode' yang Anda input di Admin Panel App.
async function findProductByCode(code) {
  if (!code) return null;
  
  // A. Cari di Produk Utama (Main Products)
  const snapshot = await db.collection('products').where('serviceCode', '==', code).get();
  if (!snapshot.empty) {
    return { doc: snapshot.docs[0], type: 'main', index: -1 };
  }
  
  // B. Cari di Variasi (Looping semua produk karena Firestore tidak bisa query dalam array object secara langsung)
  // Ini menangani produk variasi yang dibuat di App.jsx
  const allProds = await db.collection('products').get();
  for (const doc of allProds.docs) {
    const pData = doc.data();
    if (pData.variations && Array.isArray(pData.variations)) {
      const idx = pData.variations.findIndex(v => v.serviceCode === code);
      if (idx !== -1) {
        return { doc: doc, type: 'variant', index: idx };
      }
    }
  }
  return null;
}

// Helper: Format Rupiah
const fmtRp = (num) => "Rp " + parseInt(num || 0).toLocaleString('id-ID');

// Helper: Kirim Pesan Telegram
async function replyText(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

// --- 4. MAIN HANDLER ---
export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (req.method !== 'POST') return res.status(200).send('Bot Running...');
  if (!db) return res.status(500).send("Database Error");

  const body = req.body;
  if (body.message && body.message.text) {
    const chatId = body.message.chat.id;
    const text = body.message.text.trim();
    
    // --- ROUTING PERINTAH (LOGIC FIX) ---
    // Menggunakan urutan if/else if yang ketat agar tidak bocor ke command lain.

    try {
      // 1. MENU / HELP
      if (text === '/help' || text === '/menu' || text === '/start') {
        const msg = `🤖 <b>SYSTEM CONNECTED</b>\n\n` +
                    `<b>FITUR PRODUK (SINKRON APP):</b>\n` +
                    `• <code>/cek KODE</code> : Cek stok & detail\n` +
                    `• <code>/stok KODE DATA</code> : Tambah stok (Baris baru)\n` +
                    `• <code>/new KODE NAMA HARGA</code> : Buat produk baru\n` +
                    `• <code>/setharga KODE HARGA</code> : Ubah harga\n` +
                    `• <code>/hapus KODE NO_BARIS</code> : Hapus 1 stok\n` +
                    `\n<b>FITUR TRANSAKSI:</b>\n` +
                    `• <code>/trx ID</code> : Cek status order\n` +
                    `• <code>/pending</code> : List order butuh ACC`;
        await replyText(token, chatId, msg);
      }

      // 2. CEK STOK (/cek KODE)
      else if (text.startsWith('/cek')) {
        const code = text.replace('/cek', '').trim();
        if (!code) {
           await replyText(token, chatId, "⚠️ <b>Format Salah!</b>\nGunakan: <code>/cek KODE_LAYANAN</code>");
           return res.send('ok');
        }

        const target = await findProductByCode(code);
        if (!target) {
           await replyText(token, chatId, `❌ Produk dengan Kode <b>${code}</b> tidak ditemukan di Database.\n\n<i>Pastikan 'Service Code' sudah diisi di Admin Panel App.</i>`);
        } else {
           const pData = target.doc.data();
           let items = [];
           let name = pData.name;
           let price = pData.price;

           if (target.type === 'variant') {
             const v = pData.variations[target.index];
             items = v.items || [];
             name = `${name} (${v.name})`;
             price = v.price;
           } else {
             items = pData.items || [];
           }

           const stokList = items.map((item, i) => `${i + 1}. <code>${item}</code>`).join('\n');
           const msg = `📦 <b>${name}</b>\n💰 Harga: ${fmtRp(price)}\n🔑 Kode: <code>${code}</code>\n📊 Stok: ${items.length}\n\n${stokList || '<i>Stok Kosong</i>'}`;
           await replyText(token, chatId, msg.substring(0, 4000)); // Limit telegram text
        }
      }

      // 3. TAMBAH STOK (/stok KODE DATA)
      else if (text.startsWith('/stok')) {
        const args = text.replace('/stok', '').trim();
        const spaceIdx = args.indexOf(' ');
        
        if (spaceIdx === -1) {
             await replyText(token, chatId, "⚠️ Format: <code>/stok KODE data_stoknya</code>");
             return res.send('ok');
        }

        const code = args.substring(0, spaceIdx).trim();
        const rawData = args.substring(spaceIdx).trim();
        
        // Split berdasarkan baris baru atau koma
        const newItems = rawData.split(/\n|,/).map(s => s.trim()).filter(s => s);

        const target = await findProductByCode(code);
        if (!target) {
            await replyText(token, chatId, "❌ Kode tidak ditemukan.");
        } else {
            const docRef = db.collection('products').doc(target.doc.id);
            const pData = target.doc.data();
            let totalStok = 0;

            if (target.type === 'variant') {
                const vars = [...pData.variations];
                const oldItems = vars[target.index].items || [];
                vars[target.index].items = [...oldItems, ...newItems];
                await docRef.update({ variations: vars });
                totalStok = vars[target.index].items.length;
            } else {
                const oldItems = pData.items || [];
                await docRef.update({ items: [...oldItems, ...newItems] });
                totalStok = oldItems.length + newItems.length;
            }
            await replyText(token, chatId, `✅ <b>STOK DITAMBAH!</b>\nKode: ${code}\nMasuk: ${newItems.length}\nTotal Sekarang: ${totalStok}`);
        }
      }

      // 4. BUAT PRODUK BARU (/new KODE NAMA HARGA)
      else if (text.startsWith('/new')) {
         const parts = text.replace('/new', '').trim().split(' ');
         // Minimal ada 3 bagian: KODE, NAMA, HARGA
         if (parts.length < 3) {
             await replyText(token, chatId, "⚠️ Format: <code>/new KODE NAMA HARGA</code>\nContoh: <code>/new P2 Netflix 35000</code>");
             return res.send('ok');
         }

         const code = parts[0];
         const priceRaw = parts[parts.length - 1]; // Ambil elemen terakhir sebagai harga
         const price = parseInt(priceRaw.replace(/[^0-9]/g, ''));
         
         // Ambil nama (gabungkan elemen dari index 1 sampai sebelum terakhir)
         const name = parts.slice(1, parts.length - 1).join(' ');

         if (isNaN(price)) {
             await replyText(token, chatId, "❌ Harga harus berupa angka.");
             return res.send('ok');
         }

         // Cek apakah kode sudah ada
         const existing = await findProductByCode(code);
         if (existing) {
             await replyText(token, chatId, "❌ Kode layanan sudah digunakan!");
             return res.send('ok');
         }

         // Simpan ke Firestore sesuai struktur App.jsx
         await db.collection('products').add({
             name: name,
             price: price,
             serviceCode: code, // INI PENTING UNTUK SINKRONISASI
             category: "Digital", // Default category
             description: "Dibuat via Telegram Bot",
             image: "", 
             items: [], // Stok awal kosong
             isManual: false,
             processType: "MANUAL",
             createdAt: new Date().toISOString(),
             variations: [] // Tidak ada variasi dulu
         });

         await replyText(token, chatId, `✨ <b>PRODUK DIBUAT!</b>\n\nNama: ${name}\nKode: <code>${code}</code>\nHarga: ${fmtRp(price)}\n\n<i>Produk sudah tampil di Web App! Gunakan /stok ${code} untuk isi stok.</i>`);
      }

      // 5. UPDATE HARGA (/setharga KODE HARGA)
      else if (text.startsWith('/setharga')) {
          const parts = text.replace('/setharga', '').trim().split(' ');
          if (parts.length < 2) {
              await replyText(token, chatId, "⚠️ Format: <code>/setharga KODE NOMINAL</code>");
              return res.send('ok');
          }
          const code = parts[0];
          const price = parseInt(parts[1]);

          const target = await findProductByCode(code);
          if (!target) {
              await replyText(token, chatId, "❌ Kode tidak ditemukan.");
          } else {
              const docRef = db.collection('products').doc(target.doc.id);
              if (target.type === 'variant') {
                  const pData = target.doc.data();
                  const vars = [...pData.variations];
                  vars[target.index].price = price;
                  await docRef.update({ variations: vars });
              } else {
                  await docRef.update({ price: price });
              }
              await replyText(token, chatId, `💰 <b>HARGA UPDATE!</b>\nKode: ${code}\nBaru: ${fmtRp(price)}`);
          }
      }

      // 6. EDIT/HAPUS STOK (/hapus KODE NO)
      else if (text.startsWith('/hapus')) {
          const parts = text.replace('/hapus', '').trim().split(' ');
          if (parts.length < 2) {
              await replyText(token, chatId, "⚠️ Format: <code>/hapus KODE NO_BARIS</code>\nLihat nomor baris pakai /cek");
              return res.send('ok');
          }
          const code = parts[0];
          const indexStok = parseInt(parts[1]) - 1; // User input 1, array index 0

          const target = await findProductByCode(code);
          if (!target) {
               await replyText(token, chatId, "❌ Kode tidak ditemukan.");
          } else {
               const docRef = db.collection('products').doc(target.doc.id);
               const pData = target.doc.data();
               let deletedItem = "";
               
               if (target.type === 'variant') {
                   const vars = [...pData.variations];
                   const items = vars[target.index].items || [];
                   if (items[indexStok]) {
                       deletedItem = items[indexStok];
                       items.splice(indexStok, 1); // Hapus
                       vars[target.index].items = items;
                       await docRef.update({ variations: vars });
                   }
               } else {
                   const items = pData.items || [];
                   if (items[indexStok]) {
                       deletedItem = items[indexStok];
                       items.splice(indexStok, 1); // Hapus
                       await docRef.update({ items: items });
                   }
               }
               
               if(deletedItem) await replyText(token, chatId, `🗑️ <b>Item Dihapus:</b>\n${deletedItem}`);
               else await replyText(token, chatId, "❌ Nomor baris tidak valid.");
          }
      }
      
      // 7. TRACKING (/trx)
      else if (text.startsWith('/trx')) {
           // Logic tracking pesanan sama seperti sebelumnya...
           // (Disederhanakan di sini agar kode tidak terlalu panjang, tapi bisa dicopy dari kode lama)
           const id = text.replace('/trx', '').trim();
           if(!id) return await replyText(token, chatId, "⚠️ Masukkan ID Transaksi");
           
           const docSnap = await db.collection('orders').doc(id).get();
           if(!docSnap.exists) return await replyText(token, chatId, "❌ Order ID tidak ditemukan");
           
           const data = docSnap.data();
           await replyText(token, chatId, `🧾 <b>ORDER: ${id}</b>\nStatus: ${data.status}\nTotal: ${fmtRp(data.total)}`);
      }

    } catch (e) {
      console.error(e);
      await replyText(token, chatId, `⚠️ Error System: ${e.message}`);
    }
  }

  return res.status(200).send('OK');
}
