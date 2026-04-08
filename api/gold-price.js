export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sources = [
    { url: 'https://query2.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d', label: 'query2/GC=F' },
    { url: 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d', label: 'query1/GC=F' },
    { url: 'https://query2.finance.yahoo.com/v8/finance/chart/XAU=X?interval=1m&range=1d', label: 'query2/XAU=X' },
  ];

  const errors = [];

  for (const { url, label } of sources) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prevClose = meta?.chartPreviousClose || meta?.previousClose;
      if (price > 0) {
        console.log(`[gold-price] OK from ${label}: $${price}`);
        return res.json({ price, prevClose, source: label });
      }
      errors.push(`${label}: price=${price} (status ${r.status})`);
    } catch(e) {
      errors.push(`${label}: ${e.message}`);
    }
  }

  console.log('[gold-price] all sources failed:', errors.join(' | '));
  return res.status(500).json({ error: 'gold price unavailable', details: errors });
}
