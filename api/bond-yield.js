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
      // 네이버 금융 국고채(10년) 일별 시세 — HTML 테이블 파싱
      // 엔드포인트/코드가 바뀔 수 있어 여러 후보를 순서대로 시도
      const candidates = [
        'https://finance.naver.com/marketindex/interestDailyQuote.naver?marketindexCd=IRR_GOVT10Y&page=1',
        'https://finance.naver.com/marketindex/interestDailyQuote.nhn?marketindexCd=IRR_GOVT10Y&page=1',
        'https://finance.naver.com/marketindex/interestDailyQuote.naver?marketindexCd=IRR_GOVT10&page=1',
        'https://finance.naver.com/marketindex/bondDailyQuote.naver?marketindexCd=IRR_GOVT10Y&page=1',
      ];
      // 날짜(예 2026.06.05) 다음에 오는 첫 숫자(=종가/금리)를 행마다 추출
      const re = /class="date"[^>]*>\s*([\d.]{6,10})\s*<\/td>[\s\S]*?class="num"[^>]*>\s*([\d.]+)/g;
      const debug = [];
      for (const url of candidates) {
        try {
          const r = await fetchWithTimeout(url, 6000, {
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://finance.naver.com/marketindex/',
          });
          if (!r.ok) { debug.push(`${url.split('?')[0].split('/').pop()}: status ${r.status}`); continue; }
          const html = await r.text();
          const yields = [];
          let m;
          re.lastIndex = 0;
          while ((m = re.exec(html)) !== null) {
            const v = parseFloat(m[2]);
            if (Number.isFinite(v) && v > 0 && v < 30) yields.push(v);
          }
          if (yields.length > 0) {
            const price = yields[0];
            const prevClose = yields.length > 1 ? yields[1] : null;
            console.log(`[bond-yield] KR 10Y: ${price}% (prev ${prevClose}%) via ${url}`);
            return res.json({ price, prevClose, name: '국고채 10년' });
          }
          debug.push(`${url.split('?')[0].split('/').pop()}: no rows (len ${html.length})`);
        } catch (e) {
          debug.push(`${url.split('?')[0].split('/').pop()}: ${e.message}`);
        }
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
