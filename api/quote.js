// US 전용: 어제 KST 15:30(= 어제 06:30 UTC) 시점 이하 가장 최근 valid close 찾기
// 미장은 KST 15:30 시점에 closed 상태 → 직전 정규/포스트마켓 마지막 체결가가 반환됨
function findKst1530Price(timestamps, closes) {
  if (!timestamps || !closes) return null;
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  kst.setHours(15, 30, 0, 0);
  kst.setDate(kst.getDate() - 1);
  const targetUtc = Math.floor(new Date(kst.toISOString().slice(0, 10) + 'T06:30:00Z').getTime() / 1000);
  let bestTs = -1, bestPrice = null;
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i], c = closes[i];
    if (ts <= targetUtc && c != null && c > 0 && ts > bestTs) {
      bestTs = ts;
      bestPrice = c;
    }
  }
  return bestPrice;
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

  // US 전용: 전일 KST 15:30 기준가용 5m/5d 히스토리 — 메인 호출과 병렬 진행
  const kst1530Promise = market === 'US' ? (async () => {
    const histUrls = [
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=5m&range=5d&includePrePost=true`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=5m&range=5d&includePrePost=true`,
    ];
    for (const url of histUrls) {
      try {
        const r = await fetchWithTimeout(url, 8000);
        const d = await r.json();
        const result = d?.chart?.result?.[0];
        const found = findKst1530Price(result?.timestamp, result?.indicators?.quote?.[0]?.close);
        if (found) return found;
      } catch(e) {}
    }
    return null;
  })() : Promise.resolve(null);

  // KR 전용: 네이버 금융 시간외 가격 보강 — Yahoo는 한국주식 장전/장후 시간외를 미제공
  // 장전 시간외 종가(08:30~08:40), 장후 시간외 종가(15:40~16:00), 시간외 단일가(16:00~18:00)
  const krCode = market === 'KR' ? symbol.replace(/\.(KS|KQ)$/i, '') : null;
  const naverPromise = market === 'KR' && /^\d{6}$/.test(krCode || '') ? (async () => {
    try {
      const r = await fetchWithTimeout(
        `https://polling.finance.naver.com/api/realtime/domestic/stock/${krCode}`,
        3000
      );
      if (!r.ok) return null;
      const d = await r.json();
      const s = d?.datas?.[0];
      // nv: 현재가(시간외 반영), sv: 전일종가, nm: 종목명, ms: 마켓상태
      if (s?.nv && Number(s.nv) > 0) {
        return {
          price: Number(s.nv),
          prevClose: Number(s.sv) || null,
          name: s.nm || null,
          ms: s.ms || null,
        };
      }
    } catch(e) {
      console.log(`[quote] ${symbol} naver fail: ${e.message}`);
    }
    return null;
  })() : Promise.resolve(null);
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

        // US 종목: 전일 KST 15:30 시점 가격 (병렬 히스토리 조회 결과 await)
        const kst1530Price = await kst1530Promise;
        if (market === 'US') console.log(`[quote] ${symbol} kst1530Price: $${kst1530Price} (state: ${marketState})`);

        // KR 종목: 네이버 시간외 가격으로 덮어쓰기 (정규장 외 시간엔 yahoo가 stale)
        let finalPrice = price;
        let finalPrevClose = meta.chartPreviousClose || meta.previousClose;
        let finalName = meta.longName || meta.shortName || null;
        if (market === 'KR') {
          const nv = await naverPromise;
          if (nv) {
            console.log(`[quote] ${symbol} naver override: ${nv.price} (yahoo: ${price}, ms: ${nv.ms})`);
            finalPrice = nv.price;
            if (nv.prevClose) finalPrevClose = nv.prevClose;
            if (nv.name) finalName = nv.name;
          }
        }

        return res.json({
          price: finalPrice,
          prevClose: finalPrevClose,
          name: finalName,
          currency: meta.currency,
          marketState,
          ...(kst1530Price != null && { kst1530Price })
        });
      }
      errors.push(`${url.split('/')[2]}: price missing (status ${r.status})`);
    } catch(e) {
      errors.push(`${url.split('/')[2]}: ${e.message}`);
    }
  }

  // Yahoo 전체 실패 — KR이면 네이버만으로라도 응답
  if (market === 'KR') {
    const nv = await naverPromise;
    if (nv) {
      console.log(`[quote] ${symbol} yahoo failed, naver fallback: ${nv.price}`);
      return res.json({
        price: nv.price,
        prevClose: nv.prevClose,
        name: nv.name,
        currency: 'KRW',
        marketState: 'CLOSED',
      });
    }
  }

  console.log(`[quote] ${symbol} (${market}) all failed:`, errors.join(' | '));
  return res.status(500).json({ error: 'quote unavailable', details: errors });
}
