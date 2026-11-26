// /api/history2 — 일별 종가 이력 (스냅샷 백필·연간 곡선용)
// GET /api/history2?symbols=005930:KR,AAPL:US,USDKRW:FX&days=400
// 응답: { histories: { key: { closes: {"YYYY-MM-DD": close} } | {error} } }
// KR = 네이버 fchart(수년간 안정), US/FX = 야후 일봉. 캐시 10분.

const cache = new Map();
const TTL = 10 * 60 * 1000;

function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctl.signal })
    .finally(() => clearTimeout(t));
}

async function krHistory(code, days) {
  const r = await fetchWithTimeout(
    `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=${days}&requestType=0`, 6000);
  if (!r.ok) throw new Error('naver ' + r.status);
  const text = await r.text();
  const closes = {};
  const re = /data="(\d{8})\|[\d.]*\|[\d.]*\|[\d.]*\|([\d.]+)\|/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const d = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
    closes[d] = parseFloat(m[2]);
  }
  if (Object.keys(closes).length === 0) throw new Error('naver empty');
  return { closes };
}

async function yahooHistory(symbol, days) {
  const range = days > 365 ? '2y' : '1y';
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetchWithTimeout(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`, 6000);
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      const ts = res?.timestamp, cl = res?.indicators?.quote?.[0]?.close;
      if (!ts || !cl) throw new Error('no data');
      const tz = res.meta?.exchangeTimezoneName || 'America/New_York';
      const closes = {};
      for (let i = 0; i < ts.length; i++) {
        if (cl[i] == null || !(cl[i] > 0)) continue;
        const date = new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: tz });
        closes[date] = cl[i];   // 같은 날 중복 시 마지막 값
      }
      if (Object.keys(closes).length === 0) throw new Error('empty');
      return { closes };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('yahoo failed');
}

async function getHistory(key, days) {
  const ck = key + '|' + days;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.t < TTL) return hit.data;
  const [sym, market] = key.split(':');
  let data;
  try {
    if (market === 'KR') data = await krHistory(sym, days);
    else if (market === 'FX') data = await yahooHistory('KRW=X', days);
    else data = await yahooHistory(sym, days);
  } catch (e) {
    return { error: e.message || 'failed' };
  }
  cache.set(ck, { t: Date.now(), data });
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const raw = String(req.query.symbols || '').trim();
  if (!raw) return res.status(400).json({ error: 'symbols required' });
  const days = Math.min(parseInt(req.query.days, 10) || 400, 730);
  const keys = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 60);
  const results = await Promise.all(keys.map(k => getHistory(k, days).then(d => [k, d])));
  res.setHeader('Cache-Control', 's-maxage=300');
  return res.json({ histories: Object.fromEntries(results) });
}
