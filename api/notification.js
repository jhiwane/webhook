import { db } from '../lib/firebase';
import { HttpsProxyAgent } from 'https-proxy-agent';
const axios = require('axios');
const crypto = require('crypto'); // Pakai native Node.js agar ringan

// --- CONFIG ---
const TIMEOUT_LIMIT = 9000; // 9 Detik (Batas aman Vercel Serverless)

async function sendTelegramAlert(msg) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        // Fire and forget (jangan await kelamaan)
        axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, text: msg, parse_mode: 'HTML'
        }, { timeout: 3000 }).catch(() => {}); 
    } catch (e) {}
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // --- 1. IDEMPOTENCY CHECK (Cegah Double Process) ---
    // Di Vercel, kadang satu request dijalankan 2x jika ada retry.
    // Kita pastikan sukses di akhir flow.

    try {
        const body = req.body;
        
        // A. JALUR MIDTRANS (Notifikasi Pembayaran)
        if (body.transaction_status) {
            const { order_id, status_code, gross_amount, signature_key, transaction_status, custom_field1 } = body;

            // Cek Signature Keamanan
            const serverKey = process.env.MIDTRANS_SERVER_KEY;
            const inputStr = order_id + status_code + gross_amount + serverKey;
            const mySignature = crypto.createHash('sha512').update(inputStr).digest('hex');

            if (signature_key !== mySignature) {
                return res.status(403).json({ message: "Invalid Signature" });
            }

            let newStatus = 'pending';
            if (['capture', 'settlement'].includes(transaction_status)) newStatus = 'processing'; // Jangan langsung 'paid' agar user menunggu proses
            else if (['deny', 'cancel', 'expire'].includes(transaction_status)) newStatus = 'failed';

            if (newStatus === 'processing') {
                // Ambil data order untuk tahu ini Manual atau API
                const orderRef = db.collection('orders').doc(order_id);
                const snap = await orderRef.get();
                let isApi = false;
                let itemName = "Item";

                if (snap.exists) {
                    const d = snap.data();
                    if(d.items && d.items[0]) {
                        itemName = d.items[0].name;
                        if(d.items[0].processType === 'EXTERNAL_API') isApi = true;
                    }
                }

                await orderRef.update({ 
                    status: 'processing', // User melihat "Sedang Diproses"
                    isPaid: true,
                    adminMessage: isApi ? "🤖 Menghubungkan ke Server..." : "📦 Pembayaran Diterima. Menunggu Admin memproses..."
                });

                await sendTelegramAlert(
                    `💰 <b>DANA MASUK!</b>\nID: <code>${order_id}</code>\nItem: ${itemName}\nRp ${gross_amount}\n\n${isApi ? '🤖 <b>AUTO PROCESS STARTED</b>' : '⚡ <b>BUTUH PROSES MANUAL!</b>'}`
                );

                // JIKA API: Trigger logika API disini (Opsional, atau pisah ke file lain biar aman)
                // Untuk keamanan Vercel, return OK dulu baru proses background (tapi Vercel mematikan background process)
                // Jadi kita return OK sekarang. Bot atau script lain yang handle eksekusi API.
            } else {
                await db.collection('orders').doc(order_id).update({ status: newStatus });
            }

            return res.status(200).send('OK');
        }
        
        // B. JALUR MANUAL CONFIRMATION (Dari App.jsx tombol "SAYA SUDAH BAYAR")
        // Request body: { orderId, total, items, buyerContact, type: 'manual' }
        if (body.type === 'manual') {
            await sendTelegramAlert(
                `🔔 <b>KONFIRMASI MANUAL USER</b>\nID: <code>${body.orderId}</code>\nTotal: Rp ${body.total}\n\nUser mengklaim sudah transfer. Cek mutasi!`
            );
            return res.status(200).json({ status: 'ok' });
        }
        
        // C. JALUR KOMPLAIN (Dari App.jsx tombol "LAPORKAN MASALAH")
        if (body.type === 'complaint') {
             await sendTelegramAlert(
                `🛡️ <b>KOMPLAIN MASUK</b>\nID: <code>${body.orderId}</code>\nMsg: ${body.message}\nKontak: ${body.buyerContact}`
            );
            return res.status(200).json({ status: 'ok' });
        }

        return res.status(200).send('OK'); // Default return
    } catch (e) {
        console.error("Notify Error:", e);
        // Tetap return 200 agar Midtrans tidak menembak ulang terus menerus (Looping)
        return res.status(200).send('Error Handled');
    }
}
