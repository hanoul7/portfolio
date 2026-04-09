export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,authorization,appkey,appsecret,tr_id,custtype');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // rewrite: /api/kis/uapi/...?foo=bar → /api/kis-proxy?kisPath=uapi/...&foo=bar
  const kisPath = req.query.kisPath || '';
  const extra = Object.entries(req.query)
    .filter(([k]) => k !== 'kisPath')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const target = `https://openapi.koreainvestment.com:9443/${kisPath}${extra ? '?' + extra : ''}`;
  console.log('[kis proxy] method:', req.method, '| target:', target);

  const fwdHeaders = {};
  const passKeys = ['content-type', 'authorization', 'appkey', 'appsecret', 'tr_id', 'custtype'];
  for (const k of passKeys) {
    if (req.headers[k]) fwdHeaders[k] = req.headers[k];
  }

  try {
    const opts = { method: req.method, headers: fwdHeaders };
    if (req.method === 'POST' && req.body) {
      opts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const r = await fetch(target, opts);
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.log('[kis proxy] error:', e.message, '| target:', target);
    return res.status(500).json({ error: 'KIS proxy failed', message: e.message });
  }
}
