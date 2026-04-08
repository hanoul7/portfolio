export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol, market } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Yahoo Finance 심볼 변환: KR 000660 → 000660.KS
  const yahooSymbol = market === 'KR' ? symbol + '.KS' : symbol;

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`,
  ];

  const errors = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        console.log(`[quote] ${symbol} (${market}): $${meta.regularMarketPrice} via ${url.includes('query2') ? 'query2' : 'query1'}`);
        return res.json({
          price: meta.regularMarketPrice,
          prevClose: meta.chartPreviousClose || meta.previousClose,
          name: meta.longName || meta.shortName || null,
          currency: meta.currency,
          marketState: meta.marketState
        });
      }
      errors.push(`${url.split('/')[2]}: price missing (status ${r.status})`);
    } catch(e) {
      errors.push(`${url.split('/')[2]}: ${e.message}`);
    }
  }

  console.log(`[quote] ${symbol} (${market}) all failed:`, errors.join(' | '));
  return res.status(500).json({ error: 'quote unavailable', details: errors });
}
