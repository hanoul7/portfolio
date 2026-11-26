// snapshots.js — 일일 스냅샷·백필·연간 수익률(Modified Dietz)
// 날짜 경계: KST 아침 7시. 날짜 D의 값 = D까지의 보유(원장) × 각 시장 D일 종가
// (국장 = KST D일 종가, 미장 = 현지 D일 종가 × 당일 환율) + 추적 현금.
// 연말(12/31) 스냅샷이 곧 그해 정산값이자 다음 해의 기준값이 된다.
(function (global) {
  'use strict';

  const LS_KEY = 'v2_snapshots';
  let store = null;   // { "YYYY-MM-DD": { total, stocks, cash } }

  function load() {
    if (!store) store = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return store;
  }
  function persist() { localStorage.setItem(LS_KEY, JSON.stringify(store)); }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // 완결된 마지막 날짜: KST 현재 − 7시간의 날짜 − 1일
  // (그 날의 국장 종가와 미장 현지 종가가 모두 확정된 시점이 KST 다음날 07:00)
  function completedDay() {
    const kst = new Date(Date.now() + 9 * 3600 * 1000 - 7 * 3600 * 1000);
    return addDays(kst.toISOString().slice(0, 10), -1);
  }

  // 종가 조회 (휴장일은 직전 거래일 종가로 이월, 최대 14일 소급)
  function pickClose(hist, date) {
    if (!hist || !hist.closes) return null;
    if (hist.closes[date] != null) return hist.closes[date];
    if (!hist._dates) hist._dates = Object.keys(hist.closes).sort();
    let d = date;
    for (let i = 0; i < 14; i++) {
      d = addDays(d, -1);
      if (hist.closes[d] != null) return hist.closes[d];
    }
    return null;
  }

  // 날짜 D의 총자산 계산 (positions/byAcct = Ledger.replay(events, D) 결과)
  function computeTotal(st, histories, date) {
    let stocks = 0;
    const fx = pickClose(histories['USDKRW:FX'], date) || 0;
    for (const p of st.positions) {
      const hist = histories[`${p.ticker}:${p.market}`];
      const close = pickClose(hist, date);
      if (p.market === 'US') {
        stocks += (close != null ? close : p.avg) * p.qty * (fx || p.avgFx || 0);
      } else if (p.market === 'KR') {
        stocks += (close != null ? close : p.avg) * p.qty;
      } else {
        stocks += p.avg * p.qty;   // 시세 미지원(수기) — 원가로 평가
      }
    }
    let cash = 0;
    for (const a of Object.values(st.byAcct)) if (a.cashTracked) cash += a.cash;
    return { total: stocks + cash, stocks, cash };
  }

  // 빠진 날짜를 종가 이력으로 소급 계산. 변경 여부 반환.
  async function ensure() {
    const events = Ledger.load();
    if (events.length === 0) return false;
    const snaps = load();
    const first = events.map(e => (e.ts || '').slice(0, 10)).sort()[0];
    const target = completedDay();
    if (!first || first > target) return false;

    const from = addDays(target, -370) > first ? addDays(target, -370) : first;
    const missing = [];
    for (let d = from; d <= target; d = addDays(d, 1)) if (!snaps[d]) missing.push(d);
    if (missing.length === 0) return false;

    // 필요한 심볼 수집 → 이력 한 번에 조회
    const keys = new Set(['USDKRW:FX']);
    for (const e of events) {
      if (['OPEN', 'BUY', 'SELL'].includes(e.type) && (e.market === 'KR' || e.market === 'US')) {
        keys.add(`${e.ticker}:${e.market}`);
      }
    }
    const daysNeeded = Math.min(Math.ceil((Date.parse(target) - Date.parse(from)) / 86400000) + 30, 730);
    let histories = {};
    try {
      const r = await fetch(`/api/history2?symbols=${encodeURIComponent([...keys].join(','))}&days=${daysNeeded}`);
      const d = await r.json();
      histories = d.histories || {};
    } catch (e) { return false; }

    for (const d of missing) {
      const st = Ledger.replay(events, d);
      if (st.positions.length === 0 && Object.values(st.byAcct).every(a => !a.cashTracked)) continue;
      snaps[d] = computeTotal(st, histories, d);
    }
    persist();
    return true;
  }

  // 그해의 날짜순 시리즈 [{date, total}]
  function series(year) {
    const snaps = load();
    return Object.keys(snaps)
      .filter(d => d.startsWith(String(year)))
      .sort()
      .map(d => ({ date: d, total: snaps[d].total }));
  }

  // 연간 정산: 기준값 = 전년 12/31(없으면 그해 첫 스냅샷), 끝값 = 실시간 총자산(인자)
  function yearStats(year, liveTotal) {
    const snaps = load();
    const prevEnd = `${year - 1}-12-31`;
    let startDate = null;
    // 전년 말 이하의 가장 최근 스냅샷
    const all = Object.keys(snaps).sort();
    for (const d of all) if (d <= prevEnd) startDate = d;
    let startValue;
    if (startDate) startValue = snaps[startDate].total;
    else {
      const firstInYear = all.find(d => d.startsWith(String(year)));
      if (!firstInYear) return null;
      startDate = firstInYear;
      startValue = snaps[firstInYear].total;
    }
    const endDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    // 플로우: 입출금 추적 계좌는 입출금, 미추적 계좌는 매수(+)/매도(−) 근사
    const st = Ledger.state();
    const flows = [];
    for (const a of Object.values(st.byAcct)) {
      const src = a.cashTracked ? a.flowsExternal : a.flowsTrade;
      for (const f of src) {
        const d = (f.ts || '').slice(0, 10);
        if (d > startDate && d <= endDate) flows.push({ ts: d, amount: f.amount });
      }
    }
    const dz = Ledger.dietz(startValue, liveTotal, flows, startDate, endDate);
    return { year, startDate, startValue, endValue: liveTotal, gain: dz.gain, rate: dz.rate, denom: dz.denom };
  }

  global.Snapshots = { ensure, series, yearStats, completedDay, computeTotal, pickClose, _load: load };
})(typeof window !== 'undefined' ? window : globalThis);
