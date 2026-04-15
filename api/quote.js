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
  // 8초 타임아웃으로 yahoo finance 호출 — 한쪽 서버가 느릴 때 다른 쪽으로 빠르게 폴백
  const fetchWithTimeout = async (url, ms) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: ctl.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, 8000);
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
        // 정규장 외: 캔들 데이터의 최신 가격 사용 (포스트마켓/프리마켓/장마감)
        let price = meta.regularMarketPrice;
        const result = d?.chart?.result?.[0];
        if (marketState !== 'REGULAR' && result?.timestamp?.length > 0) {
          const closes = result.indicators?.quote?.[0]?.close;
          if (closes) {
            for (let i = closes.length - 1; i >= 0; i--) {
              if (closes[i] != null && closes[i] > 0) { price = closes[i]; break; }
            }
          }
        }
        console.log(`[quote] ${symbol} (${market}): $${price} (regular: $${meta.regularMarketPrice}) | marketState: ${marketState}`);

        // US 종목: "가장 최근 완료된 정규장 종가" (KST 9시 baseline 용)
        // - REGULAR 중: 어제 종가 (chartPreviousClose)
        // - PRE/POST/CLOSED: regularMarketPrice (= 해당 시점의 최근 정규장 종가)
        let kst9amPrice = null;
        if (market === 'US') {
          if (marketState === 'REGULAR') {
            kst9amPrice = meta.chartPreviousClose || meta.previousClose || null;
          } else {
            kst9amPrice = meta.regularMarketPrice || null;
          }
          console.log(`[quote] ${symbol} kst9amPrice: $${kst9amPrice} (state: ${marketState})`);
        }

        return res.json({
          price,
          prevClose: meta.chartPreviousClose || meta.previousClose,
          name: meta.longName || meta.shortName || null,
          currency: meta.currency,
          marketState,
          ...(kst9amPrice != null && { kst9amPrice })
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
