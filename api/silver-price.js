// 전일 KST 15:30(UTC 06:30) 종가 캔들 찾기 — 항상 직전 영업일 15:30 기준
function findKstClose(timestamps, closes) {
  if (!timestamps || !closes) return null;
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  kst.setHours(15, 30, 0, 0);
  kst.setDate(kst.getDate() - 1);
  while (kst.getDay() === 0 || kst.getDay() === 6) kst.setDate(kst.getDate() - 1);
  const targetUtc = Math.floor(new Date(kst.toISOString().slice(0, 10) + 'T06:30:00Z').getTime() / 1000);

  let bestIdx = -1, bestDiff = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const diff = Math.abs(timestamps[i] - targetUtc);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  if (bestIdx >= 0 && bestDiff <= 1800 && closes[bestIdx] > 0) return closes[bestIdx];
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 1) 현재가 조회
  const priceSources = [
    { url: 'https://query2.finance.yahoo.com/v8/finance/chart/SI=F?interval=1m&range=1d', label: 'query2/SI=F' },
    { url: 'https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=1m&range=1d', label: 'query1/SI=F' },
    { url: 'https://query2.finance.yahoo.com/v8/finance/chart/XAG=X?interval=1m&range=1d', label: 'query2/XAG=X' },
    { url: 'https://query1.finance.yahoo.com/v8/finance/chart/XAG=X?interval=1m&range=1d', label: 'query1/XAG=X' },
  ];

  let price = 0, prevClose = 0, source = '';
  const errors = [];

  for (const { url, label } of priceSources) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const p = meta?.regularMarketPrice;
      const pc = meta?.chartPreviousClose || meta?.previousClose;
      if (p > 0) {
        price = p;
        prevClose = pc;
        source = label;
        console.log(`[silver-price] OK from ${label}: $${price}`);
        break;
      }
      errors.push(`${label}: price=${p} (status ${r.status})`);
    } catch(e) {
      errors.push(`${label}: ${e.message}`);
    }
  }

  if (!price) {
    console.log('[silver-price] all sources failed:', errors.join(' | '));
    return res.status(500).json({ error: 'silver price unavailable', details: errors });
  }

  // 2) KST 15:30 기준 전일종가 조회 (5분봉 2일치)
  let kstPrevClose = null;
  const histSources = [
    'https://query2.finance.yahoo.com/v8/finance/chart/SI=F?interval=5m&range=5d',
    'https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=5m&range=5d',
    'https://query2.finance.yahoo.com/v8/finance/chart/XAG=X?interval=5m&range=5d',
  ];
  for (const url of histSources) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      const timestamps = result?.timestamp;
      const closes = result?.indicators?.quote?.[0]?.close;
      const found = findKstClose(timestamps, closes);
      if (found) { kstPrevClose = found; break; }
    } catch(e) {}
  }
  console.log(`[silver-price] kstPrevClose: $${kstPrevClose}`);

  return res.json({ price, prevClose, kstPrevClose, source });
}
