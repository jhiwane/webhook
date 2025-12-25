// api/midtrans-webhook.js
const { db, admin } = require('./firebaseConfig');
const { sendMessage } = require('./botConfig');
const crypto = require('crypto');

const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_ID;

// Fungsi Inti: Proses Stok & Order
async function processOrderInventory(orderId) {
    const orderRef = db.collection('orders').doc(orderId);
    
    await db.runTransaction(async (t) => {
        const doc = await t.get(orderRef);
        if (!doc.exists) throw "Order not found";
        const order = doc.data();
        if (order.status === 'paid' && order.fulfillmentDone) return; // Sudah diproses

        let updatedItems = [...order.items];
        let needsManualProcessing = false;
        let processedLog = [];

        // Loop setiap item di keranjang
        for (let i = 0; i < updatedItems.length; i++) {
            let item = updatedItems[i];
            const pRef = db.collection('products').doc(item.isVariant ? item.originalId : item.id);
            const pDoc = await t.get(pRef);
            
            if (!pDoc.exists) {
                needsManualProcessing = true;
                continue; // Skip jika produk dihapus
            }
            
            const pData = pDoc.data();
            
            // Cek apakah item ini Manual / API / Otomatis Stok
            // Kita asumsikan API dihandle di sini (tapi disederhanakan ke Manual jika API gagal/tidak diimplement)
            
            if (pData.isManual || pData.processType === 'MANUAL') {
                needsManualProcessing = true;
                item.isManual = true; // Flag untuk UI
            } else {
                // LOGIC POTONG STOK OTOMATIS
                // Cari array stok yang benar (Varian atau Utama)
                let availableStock = [];
                let isVariantObj = null;
                let varIndex = -1;

                if (item.isVariant) {
                    varIndex = pData.variations.findIndex(v => v.name === item.variantName);
                    if (varIndex > -1) availableStock = pData.variations[varIndex].items || [];
                } else {
                    availableStock = pData.items || [];
                }

                if (availableStock.length >= item.qty) {
                    // AMBIL STOK (SLICE)
                    const codesToSend = availableStock.slice(0, item.qty);
                    const remainingStock = availableStock.slice(item.qty);

                    // Update Item di Order dengan Data Akun/Kode
                    updatedItems[i].data = codesToSend;
                    updatedItems[i].isManual = false;
                    processedLog.push(`${item.name}: ✅ Terkirim Otomatis`);

                    // Update Database Produk (Kurangi Stok)
                    if (item.isVariant) {
                        const newVars = [...pData.variations];
                        newVars[varIndex].items = remainingStock;
                        t.update(pRef, { variations: newVars, realSold: admin.firestore.FieldValue.increment(item.qty) });
                    } else {
                        t.update(pRef, { items: remainingStock, realSold: admin.firestore.FieldValue.increment(item.qty) });
                    }
                } else {
                    // STOK HABIS -> LARI KE MANUAL
                    needsManualProcessing = true;
                    item.isManual = true; 
                    processedLog.push(`${item.name}: ⚠️ Stok Kurang (Switch ke Manual)`);
                }
            }
        }

        // Update Order
        t.update(orderRef, { 
            status: 'paid', 
            items: updatedItems,
            fulfillmentDone: !needsManualProcessing 
        });

        // NOTIFIKASI HASIL KE ADMIN
        if (needsManualProcessing) {
             // Kirim pesan manual input ke Telegram
             // Kita lakukan di luar transaction (after commit) biar aman, tapi di sini simple logic
             // Kita return status manual
             return { status: 'manual_needed', items: updatedItems };
        }
        return { status: 'complete' };
    }).then(async (result) => {
        if (result && result.status === 'manual_needed') {
            // KIRIM REQUEST PENGISIAN DATA KE TELEGRAM
            let msg = `🔔 <b>ORDER PAID (BUTUH PROSES)</b>\nID: <code>${orderId}</code>\n\nBeberapa item butuh diproses manual (Stok habis/Produk Joki):\n`;
            
            result.items.forEach((item, index) => {
                if (item.isManual || !item.data || item.data.length === 0) {
                     msg += `\n📦 <b>${item.name}</b> (x${item.qty})\nCatatan User: <code>${item.note || '-'}</code>\n👉 <i>Reply pesan ini dengan data/kode (Pisahkan enter jika banyak). Format:</i> <code>/fill ${orderId} ${index} [data]</code>\n`;
                     // Tips: Agar admin mudah, nanti di webhook telegram kita buat sistem reply pintar
                }
            });
            await sendMessage(ADMIN_CHAT_ID, msg);
        } else {
            await sendMessage(ADMIN_CHAT_ID, `✅ <b>ORDER SELESAI (OTOMATIS)</b>\nID: ${orderId}\nSemua stok telah dikirim.`);
        }
    }).catch(e => console.error("Transaction Error", e));
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    
    const { order_id, transaction_status, status_code } = req.body;
    
    // Verifikasi Signature Midtrans (Disarankan)
    // const signatureKey = crypto.createHash('sha512').update(order_id + status_code + gross_amount + SERVER_KEY).digest('hex');
    // if (signatureKey !== req.body.signature_key) return res.status(403).send('Invalid Signature');

    if (transaction_status === 'capture' || transaction_status === 'settlement') {
        await processOrderInventory(order_id);
    } else if (transaction_status === 'expire' || transaction_status === 'cancel') {
        await db.collection('orders').doc(order_id).update({ status: 'expired' });
    }

    res.status(200).json({ status: 'ok' });
}
