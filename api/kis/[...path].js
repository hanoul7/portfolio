export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,authorization,appkey,appsecret,tr_id,custtype');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // catch-all: req.query.path = ['uapi','domestic-stock','v1',...]
  const pathSegments = req.query.path || [];
  const queryString = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const target = `https://openapi.koreainvestment.com:9443/${pathSegments.join('/')}${queryString ? '?' + queryString : ''}`;

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
