// 네이버 모바일증권 — 투자자별 일별 순매수 (외국인/기관/개인)
// 응답 예시: [{bizdate, foreignerPureBuyQuant, organPureBuyQuant, individualPureBuyQuant, closePrice, ...}, ...]
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { symbol } = req.query;
  if (!symbol || !/^\d{6}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid symbol (6-digit code required)' });
  }

  try {
    const r = await fetch(
      `https://m.stock.naver.com/api/stock/${symbol}/trend`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!r.ok) return res.status(502).json({ error: 'naver unavailable', status: r.status });
    const arr = await r.json();
    if (!Array.isArray(arr)) return res.status(500).json({ error: 'unexpected naver format' });

    const num = (v) => {
      if (v == null) return null;
      const n = Number(String(v).replace(/[+,\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    };

    const data = arr.map(d => {
      const code = d.compareToPreviousPrice?.code;
      const signedChange = (code === '4' || code === '5')
        ? -Math.abs(num(d.compareToPreviousClosePrice) || 0)
        : (num(d.compareToPreviousClosePrice) || 0);
      const bd = d.bizdate || '';
      return {
        date: bd.length === 8 ? `${bd.slice(0,4)}-${bd.slice(4,6)}-${bd.slice(6,8)}` : null,
        close: num(d.closePrice),
        change: signedChange,
        foreign: num(d.foreignerPureBuyQuant),
        foreignHoldRatio: num((d.foreignerHoldRatio || '').replace('%', '')),
        organ: num(d.organPureBuyQuant),
        individual: num(d.individualPureBuyQuant),
        volume: num(d.accumulatedTradingVolume),
      };
    }).filter(d => d.date);

    return res.json({ symbol, data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
