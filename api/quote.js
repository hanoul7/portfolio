export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol, market } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Yahoo Finance 심볼 변환: KR 000660 → 000660.KS
  const yahooSymbol = market === 'KR' ? symbol + '.KS' : symbol;

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d&includePrePost=true`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d&includePrePost=true`,
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
        // currentTradingPeriod에서 마켓 상태 판별
        const tp = meta.currentTradingPeriod;
        let marketState = 'CLOSED';
        if (tp) {
          const now = Math.floor(Date.now() / 1000);
          if (tp.regular && now >= tp.regular.start && now <= tp.regular.end) marketState = 'REGULAR';
          else if (tp.pre && now >= tp.pre.start && now <= tp.pre.end) marketState = 'PRE';
          else if (tp.post && now >= tp.post.start && now <= tp.post.end) marketState = 'POST';
        }
        // 프리/포스트마켓: 캔들 데이터의 최신 가격 사용
        let price = meta.regularMarketPrice;
        const result = d?.chart?.result?.[0];
        if ((marketState === 'PRE' || marketState === 'POST') && result?.timestamp?.length > 0) {
          const closes = result.indicators?.quote?.[0]?.close;
          if (closes) {
            for (let i = closes.length - 1; i >= 0; i--) {
              if (closes[i] != null && closes[i] > 0) { price = closes[i]; break; }
            }
          }
        }
        console.log(`[quote] ${symbol} (${market}): $${price} (regular: $${meta.regularMarketPrice}) | marketState: ${marketState}`);
        return res.json({
          price,
          prevClose: meta.chartPreviousClose || meta.previousClose,
          name: meta.longName || meta.shortName || null,
          currency: meta.currency,
          marketState
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
