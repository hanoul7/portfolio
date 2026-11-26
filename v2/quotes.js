// quotes.js — v2 클라이언트 시세 모듈
// /api/quote2 배치 호출, 30초 자동 갱신, 실패 시 '지연' 상태 유지 (무한 로딩 없음)
(function (global) {
  'use strict';

  const data = {};        // "TICKER:MARKET" → quote
  let fxKrw = 0;          // USD/KRW
  let lastAt = null;      // 마지막 성공 시각
  let timer = null;

  function keyOf(pos) { return `${pos.ticker}:${pos.market}`; }

  async function fetchFor(positions) {
    const keys = new Set(positions.filter(p => p.market === 'KR' || p.market === 'US').map(keyOf));
    if (positions.some(p => p.market === 'US') || keys.size === 0) keys.add('USDKRW:FX');
    if (keys.size === 0) return data;
    try {
      const r = await fetch('/api/quote2?symbols=' + encodeURIComponent([...keys].join(',')));
      const d = await r.json();
      if (d && d.quotes) {
        Object.assign(data, d.quotes);
        const fx = d.quotes['USDKRW:FX'];
        if (fx && fx.price > 0) fxKrw = fx.price;
        lastAt = new Date();
      }
    } catch (e) { /* 기존 값 유지 — 상태줄에 지연 표시 */ }
    return data;
  }

  function get(pos) { return data[keyOf(pos)] || null; }

  // 현재가 원화 (시세 없으면 평단 기준 원가로 대체)
  function priceKrw(pos) {
    const q = get(pos);
    if (q && q.price > 0) return pos.market === 'US' ? q.price * (fxKrw || pos.avgFx || 0) : q.price;
    return pos.market === 'US' ? pos.avg * (pos.avgFx || fxKrw || 0) : pos.avg;
  }
  function costKrw(pos) {
    return pos.market === 'US' ? pos.avg * (pos.avgFx || fxKrw || 0) * pos.qty : pos.avg * pos.qty;
  }
  function evalKrw(pos) { return priceKrw(pos) * pos.qty; }

  function startAuto(cb, ms) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') cb();
    }, ms || 30000);
  }

  global.Quotes = {
    fetchFor, get, priceKrw, costKrw, evalKrw, startAuto,
    get fxKrw() { return fxKrw; },
    get lastAt() { return lastAt; },
  };
})(window);
