export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=1d&range=1d',
    'https://query2.finance.yahoo.com/v8/finance/chart/SI=F?interval=1d&range=1d',
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        return res.json({
          price: meta.regularMarketPrice,
          prevClose: meta.chartPreviousClose || meta.previousClose,
          currency: 'USD',
          unit: 'troy oz'
        });
      }
    } catch(e) {}
  }

  return res.status(500).json({ error: 'silver price unavailable' });
}
