// KST 9:00(UTC 00:00)에 가장 가까운 캔들 가격 찾기
function findKst9amClose(timestamps, closes) {
  if (!timestamps || !closes) return null;
  const now = new Date();
  // 오늘 KST 9시 = UTC 00:00
  const todayUtc = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const kstH = todayUtc.getHours();
  // KST 9시 이전이면 전일 기준
  if (kstH < 9) todayUtc.setDate(todayUtc.getDate() - 1);
  // 주말이면 금요일로
  while (todayUtc.getDay() === 0 || todayUtc.getDay() === 6) todayUtc.setDate(todayUtc.getDate() - 1);
  const dateStr = todayUtc.getFullYear() + '-' +
    String(todayUtc.getMonth() + 1).padStart(2, '0') + '-' +
    String(todayUtc.getDate()).padStart(2, '0');
  // KST 9:00 = UTC 00:00 of the same date
  const targetUtc = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);

  let bestIdx = -1, bestDiff = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const diff = Math.abs(timestamps[i] - targetUtc);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  // 30분(1800초) 이내 캔들만 유효
  if (bestIdx >= 0 && bestDiff <= 1800 && closes[bestIdx] != null && closes[bestIdx] > 0) return closes[bestIdx];
  return null;
}

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

        // US 종목: KST 9시 기준가 조회 (5분봉 2일치)
        let kst9amPrice = null;
        if (market === 'US') {
          const histUrls = [
            `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=5m&range=2d&includePrePost=true`,
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=5m&range=2d&includePrePost=true`,
          ];
          for (const hUrl of histUrls) {
            try {
              const hr = await fetch(hUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
              });
              const hd = await hr.json();
              const hResult = hd?.chart?.result?.[0];
              const found = findKst9amClose(hResult?.timestamp, hResult?.indicators?.quote?.[0]?.close);
              if (found) { kst9amPrice = found; break; }
            } catch(e) {}
          }
          console.log(`[quote] ${symbol} kst9amPrice: $${kst9amPrice}`);
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
