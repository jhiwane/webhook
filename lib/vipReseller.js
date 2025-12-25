const axios = require('axios');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Helper: Pilih Proxy Acak
const getProxyAgent = () => {
    const rawProxy = process.env.PROXY_URL; 
    if (!rawProxy) return null;

    // Support banyak proxy dipisah koma
    const proxyList = rawProxy.split(',').map(s => s.trim());
    const selectedProxy = proxyList[Math.floor(Math.random() * proxyList.length)];
    
    // Validasi format proxy
    if(selectedProxy.length < 5) return null;

    console.log(`🔒 Via Proxy: ${selectedProxy.substring(0, 15)}...`);
    return new HttpsProxyAgent(selectedProxy);
};

const processVipTransaction = async (trxId, serviceCode, target) => {
    const apiId = process.env.VIP_API_ID;
    const apiKey = process.env.VIP_API_KEY;

    if (!apiId || !apiKey) throw new Error("API VIP belum disetting!");

    // Signature MD5
    const sign = crypto.createHash('md5').update(apiId + apiKey).digest('hex');

    // Data Payload
    const payload = new URLSearchParams();
    payload.append('key', apiKey);
    payload.append('sign', sign);
    payload.append('type', 'order');
    payload.append('service', serviceCode);
    payload.append('data_no', target);
    payload.append('trx_id', trxId);

    // Config Request
    const config = {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    };

    const agent = getProxyAgent();
    if (agent) {
        config.httpsAgent = agent;
        config.proxy = false; 
    }

    try {
        const response = await axios.post('https://vip-reseller.co.id/api/game-feature', payload, config);
        const result = response.data;

        if (result.result === false) {
            throw new Error(result.message); // Lempar error jika VIP menolak
        }

        return {
            status: 'success',
            sn: result.data.sn || "Transaksi Sukses (Auto)",
            raw: result
        };

    } catch (error) {
        const msg = error.response?.data?.message || error.message;
        throw new Error(msg);
    }
};

module.exports = { processVipTransaction };
