export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol, range } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const r = range || 'ytd';
  const urls = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${r}`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${r}`,
  ];

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await resp.json();
      const result = d?.chart?.result?.[0];
      if (result && result.timestamp) {
        const ts = result.timestamp;
        const closes = result.indicators?.quote?.[0]?.close || [];
        // 날짜 + 종가만 반환 (경량화)
        const data = ts.map((t, i) => ({
          date: new Date(t * 1000).toISOString().slice(0, 10),
          close: closes[i]
        })).filter(d => d.close != null);
        return res.json({ symbol, data });
      }
    } catch(e) {}
  }

  return res.status(500).json({ error: 'chart data unavailable', symbol });
}
