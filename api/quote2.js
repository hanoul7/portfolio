// /api/quote2 — v2 배치 시세 어댑터
// GET /api/quote2?symbols=005930:KR,AAPL:US,USDKRW:FX
// 응답: { quotes: { "005930:KR": {price, prevClose, name, state, currency} | {error} } }
//
// 기준(HTS 동일): prevClose = 해당 시장의 직전 정규장 종가, 현지 통화.
// KR = 네이버 폴링 우선(장전/장후 시간외 반영) → 야후 폴백. US/FX = 야후.
// 서버 캐시 30초. 심볼별 독립 — 하나가 실패해도 나머지는 정상 응답.

const cache = new Map();   // key → {t, data}
const TTL = 30 * 1000;

function fetchWithTimeout(url, ms, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...headers },
    signal: ctl.signal,
  }).finally(() => clearTimeout(timer));
}

const num = v => {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ── KST 기준 국장 세션 (v1 검증 로직) ──
function krSession() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = kst.getDay();
  if (day === 0 || day === 6) return 'CLOSED';
  const m = kst.getHours() * 60 + kst.getMinutes();
  if (m >= 510 && m < 540) return 'PRE';       // 08:30-09:00 장전
  if (m >= 540 && m < 930) return 'REGULAR';   // 09:00-15:30
  if (m >= 940 && m < 1080) return 'POST';     // 15:40-18:00 장후/단일가
  return 'CLOSED';
}

// ── KR: 네이버 폴링 ──
async function krNaver(code) {
  const r = await fetchWithTimeout(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, 4000);
  if (!r.ok) throw new Error('naver ' + r.status);
  const d = await r.json();
  const s = d?.datas?.[0];
  if (!s) throw new Error('naver empty');
  const regular = num(s.closePriceRaw) ?? num(s.closePrice);
  const over = num(s.overMarketPriceInfo?.overPrice);
  const session = krSession();
  const price = (session === 'PRE' || session === 'POST') ? (over || regular) : (regular || over);
  if (!(price > 0)) throw new Error('naver no price');
  // 전일 정규장 종가 = 오늘 정규가 − 부호 반영 등락폭
  const deltaRaw = num(s.compareToPreviousClosePriceRaw);
  const deltaPretty = num(s.compareToPreviousClosePrice);
  const code4 = s.compareToPreviousPrice?.code;
  let delta = 0;
  if (deltaRaw != null) delta = deltaRaw;
  else if (deltaPretty != null) delta = deltaPretty < 0 ? deltaPretty : ((code4 === '4' || code4 === '5') ? -deltaPretty : deltaPretty);
  const prevClose = regular ? regular - delta : null;
  return { price, prevClose, regularClose: regular, name: s.stockName || null, state: session, currency: 'KRW', src: 'naver' };
}

// ── 야후 공통 (US 주식 / KR 폴백 / FX) ──
async function yahoo(symbol, stateWanted) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetchWithTimeout(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`, 4000);
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      const meta = res?.meta;
      if (!meta?.regularMarketPrice) throw new Error('no price');
      const tp = meta.currentTradingPeriod;
      let state = 'CLOSED';
      if (tp) {
        const now = Math.floor(Date.now() / 1000);
        if (tp.regular && now >= tp.regular.start && now <= tp.regular.end) state = 'REGULAR';
        else if (tp.pre && now >= tp.pre.start && now <= tp.pre.end) state = 'PRE';
        else if (tp.post && now >= tp.post.start && now <= tp.post.end) state = 'POST';
      }
      let price = meta.regularMarketPrice;
      if (state !== 'REGULAR' && res?.timestamp?.length > 0) {
        const closes = res.indicators?.quote?.[0]?.close;
        if (closes) for (let i = closes.length - 1; i >= 0; i--) {
          if (closes[i] != null && closes[i] > 0) { price = closes[i]; break; }
        }
      }
      // HTS 기준: 직전 정규장 종가. 정규장 중·장외 모두 chartPreviousClose가 그 값.
      const prevClose = meta.chartPreviousClose || meta.previousClose || null;
      return {
        price, prevClose, regularClose: meta.regularMarketPrice,
        name: meta.longName || meta.shortName || null,
        state: stateWanted === 'FX' ? 'FX' : state,
        currency: meta.currency || null, src: 'yahoo',
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('yahoo failed');
}

async function getQuote(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.data;

  const [sym, market] = key.split(':');
  let data;
  try {
    if (market === 'KR') {
      try {
        data = await krNaver(sym);
      } catch (e) {
        for (const suffix of ['.KS', '.KQ']) {
          try { data = await yahoo(sym + suffix); break; } catch (e2) {}
        }
        if (!data) throw e;
      }
    } else if (market === 'FX') {
      data = await yahoo('KRW=X', 'FX');
    } else {  // US
      data = await yahoo(sym);
    }
  } catch (e) {
    // 실패 시: 캐시에 과거 성공값이 있으면 stale로 반환
    if (hit) return { ...hit.data, stale: true };
    return { error: e.message || 'failed' };
  }
  cache.set(key, { t: Date.now(), data });
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const raw = String(req.query.symbols || '').trim();
  if (!raw) return res.status(400).json({ error: 'symbols required (e.g. 005930:KR,AAPL:US,USDKRW:FX)' });
  const keys = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 60);
  const results = await Promise.all(keys.map(k => getQuote(k).then(d => [k, d])));
  res.setHeader('Cache-Control', 's-maxage=15');
  return res.json({ quotes: Object.fromEntries(results), at: new Date().toISOString() });
}
