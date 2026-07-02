// 10년물 국채 금리 — 미국(Yahoo ^TNX) / 한국(네이버 국고채 10년)
// 응답: { price: 금리(%), prevClose: 전일 금리(%), name }
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const country = String(req.query.country || 'US').toUpperCase();

  const fetchWithTimeout = async (url, ms, headers) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { headers, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    if (country === 'US') {
      // Yahoo ^TNX = 미국 10년물 국채 금리(값 자체가 % 단위)
      const urls = [
        'https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d',
        'https://query2.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d',
      ];
      for (const url of urls) {
        try {
          const r = await fetchWithTimeout(url, 8000, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' });
          const d = await r.json();
          const meta = d?.chart?.result?.[0]?.meta;
          if (meta?.regularMarketPrice) {
            const price = meta.regularMarketPrice;
            const prevClose = meta.chartPreviousClose || meta.previousClose || null;
            console.log(`[bond-yield] US 10Y: ${price}% (prev ${prevClose}%)`);
            return res.json({ price, prevClose, name: 'US 10Y' });
          }
        } catch (e) {}
      }
      return res.status(500).json({ error: 'us bond yield unavailable' });
    }

    if (country === 'KR') {
      // 네이버 채권 API — 국고채 10년(로이터 코드 KR10YT=RR) JSON
      // 구 시장지표 페이지(finance.naver.com)에는 3년물까지만 있어 모바일 API 사용
      const hdrs = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'application/json',
        'Referer': 'https://m.stock.naver.com/marketindex/bond/KR10YT%3DRR',
      };
      const num = v => {
        const n = parseFloat(String(v ?? '').replace(/,/g, ''));
        return Number.isFinite(n) && n > 0 && n < 30 ? n : null;
      };
      const debug = [];

      // 일별 시세 목록 (최신순) — 응답 구조가 바뀔 수 있어 closePrice+날짜를 가진 객체를 깊이 탐색
      const priceUrls = [
        'https://m.stock.naver.com/front-api/marketIndex/prices?category=bond&reutersCode=KR10YT%3DRR&page=1&pageSize=10',
        'https://api.stock.naver.com/marketindex/bond/KR10YT%3DRR/prices?page=1&pageSize=10',
        'https://api.stock.naver.com/marketindex/bond/KR10YT=RR/prices?page=1&pageSize=10',
      ];
      for (const url of priceUrls) {
        try {
          const r = await fetchWithTimeout(url, 6000, hdrs);
          if (!r.ok) { debug.push(`${new URL(url).host}: status ${r.status}`); continue; }
          const d = await r.json();
          const rows = [];
          (function walk(v) {
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (v && typeof v === 'object') {
              if (v.closePrice != null && (v.localTradedAt || v.tradedAt || v.localDate)) rows.push(v);
              else Object.values(v).forEach(walk);
            }
          })(d);
          const yields = rows.map(x => num(x.closePrice)).filter(v => v != null);
          if (yields.length > 0) {
            const price = yields[0];
            const prevClose = yields.length > 1 ? yields[1] : null;
            console.log(`[bond-yield] KR 10Y: ${price}% (prev ${prevClose}%) via ${new URL(url).host}`);
            return res.json({ price, prevClose, name: '국고채 10년' });
          }
          debug.push(`${new URL(url).host}: no rows (keys ${Object.keys(d || {}).slice(0, 5).join(',')})`);
        } catch (e) {
          debug.push(`${new URL(url).host}: ${e.message}`);
        }
      }

      // 최후 폴백: 상세 API — 현재 금리만이라도 표시 (전일비는 생략)
      try {
        const r = await fetchWithTimeout(
          'https://m.stock.naver.com/front-api/marketIndex/productDetails?category=bond&reutersCode=KR10YT%3DRR', 6000, hdrs);
        if (r.ok) {
          const d = await r.json();
          let found = null;
          (function walk(v) {
            if (found || !v || typeof v !== 'object') return;
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (v.closePrice != null && num(v.closePrice) != null) { found = v; return; }
            Object.values(v).forEach(walk);
          })(d);
          if (found) {
            const price = num(found.closePrice);
            // 전일비가 있으면 전일값 복원 (하락이면 delta 부호 처리)
            const delta = parseFloat(String(found.compareToPreviousClosePrice ?? '').replace(/,/g, ''));
            const falling = /FALL|MINUS|하락|RISK/i.test(String(found.fluctuationsType || found.compareToPreviousPrice?.name || ''));
            const prevClose = Number.isFinite(delta) && delta !== 0
              ? price + (falling ? Math.abs(delta) : -Math.abs(delta))
              : null;
            console.log(`[bond-yield] KR 10Y (detail): ${price}%`);
            return res.json({ price, prevClose, name: '국고채 10년' });
          }
          debug.push('productDetails: no closePrice');
        } else {
          debug.push(`productDetails: status ${r.status}`);
        }
      } catch (e) {
        debug.push(`productDetails: ${e.message}`);
      }

      console.log(`[bond-yield] KR 10Y all failed: ${debug.join(' | ')}`);
      return res.status(500).json({ error: 'kr bond yield unavailable', debug });
    }

    return res.status(400).json({ error: 'country must be US or KR' });
  } catch (e) {
    console.log(`[bond-yield] ${country} fail: ${e.message}`);
    return res.status(500).json({ error: 'bond yield unavailable', detail: e.message });
  }
}
