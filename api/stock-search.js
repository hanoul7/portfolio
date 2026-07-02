// 한글 종목명 → 국내 종목코드 검색 (네이버 자동완성)
// 요청: /api/stock-search?q=해성디에스
// 응답: { code: "195870", name: "해성디에스", exact: true, matches: [...] }
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });

  const fetchWithTimeout = async (url, ms) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://m.stock.naver.com/' },
        signal: ctl.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const results = [];
  const errors = [];

  // 1) 모바일 front-api 자동완성
  try {
    const r = await fetchWithTimeout(
      `https://m.stock.naver.com/front-api/search/autoComplete?query=${encodeURIComponent(q)}&target=stock`, 5000);
    const d = await r.json();
    const items = d?.result?.items || d?.items || [];
    for (const it of items) {
      const code = String(it.code || it.itemCode || '').trim();
      const name = String(it.name || it.stockName || '').trim();
      if (/^\d{6}$/.test(code) && name) results.push({ code, name });
    }
  } catch (e) { errors.push('front-api: ' + e.message); }

  // 2) 구 자동완성 엔드포인트 폴백 — 중첩 배열 구조라 깊이 우선으로 코드/이름 추출
  if (results.length === 0) {
    try {
      const r = await fetchWithTimeout(
        `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`, 5000);
      const d = await r.json();
      const groups = Array.isArray(d?.items) ? d.items : [];
      for (const group of groups) {
        if (!Array.isArray(group)) continue;
        for (const entry of group) {
          const flat = [];
          (function walk(v) {
            if (Array.isArray(v)) v.forEach(walk);
            else if (typeof v === 'string') flat.push(v);
          })(entry);
          const code = flat.find(s => /^\d{6}$/.test(s));
          const name = flat.find(s => /[가-힣A-Za-z]/.test(s) && !/^\d+$/.test(s));
          if (code && name) results.push({ code, name: name.trim() });
        }
      }
    } catch (e) { errors.push('ac: ' + e.message); }
  }

  if (results.length === 0) {
    return res.status(404).json({ error: 'not found', debug: errors });
  }

  // 최적 매치: 정규화 완전일치 > 시작일치 > 첫 결과
  const nq = norm(q);
  const best =
    results.find(x => norm(x.name) === nq) ||
    results.find(x => norm(x.name).startsWith(nq)) ||
    results[0];

  return res.json({
    code: best.code,
    name: best.name,
    exact: norm(best.name) === nq,
    matches: results.slice(0, 5)
  });
}
