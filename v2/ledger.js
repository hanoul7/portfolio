// ─────────────────────────────────────────────────────────────
// ledger.js — v2 원장(이벤트) 저장·검증·리플레이 엔진
//
// 설계 원칙: 저장하는 것은 거래 사건(이벤트)뿐.
// 보유·평단·실현손익·현금·수익률은 전부 replay()로 파생 계산한다.
// 화면(app.js)과 완전히 분리되어 있고, node에서도 테스트 가능.
//
// 이벤트 스키마 (공통: id, type, ts, acct, memo?, src?)
//   OPEN     { market, ticker, name, qty, price(=평단), fx? }  기초잔고
//   BUY      { market, ticker, name, qty, price, fx? }         매수
//   SELL     { market, ticker, name, qty, price, fx? }         매도
//   DEPOSIT  { amount }                                        입금(원)
//   WITHDRAW { amount }                                        출금(원)
//   DIVIDEND { ticker?, amount }                               배당·이자(원)
//   ADJUST   { amount }                                        실현손익 보정(v1 이월 등)
// ts: 'YYYY-MM-DD' 또는 'YYYY-MM-DDTHH:mm' (KST)
// fx: 미국주식 거래일 환율(원/$). KR은 생략.
// ─────────────────────────────────────────────────────────────
(function (global) {
  'use strict';

  const LS_KEY = 'v2_ledger';
  const LS_PREV = 'v2_ledger_prev';

  const TYPES = ['OPEN', 'BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'DIVIDEND', 'ADJUST'];
  const TRADE_TYPES = ['OPEN', 'BUY', 'SELL'];

  // ── 유틸 ──
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function sortKey(e) {
    // 날짜만 있는 이벤트는 그날 00:00 취급. 같은 시각이면 입력 순서(id 삽입순 보존 위해 seq 사용)
    const ts = (e.ts || '').length === 10 ? e.ts + 'T00:00' : (e.ts || '');
    return ts + '|' + String(e.seq ?? 0).padStart(10, '0');
  }
  function yearOf(e) { return parseInt((e.ts || '').slice(0, 4), 10); }
  function posKey(e) { return `${e.acct || ''}|${e.market}|${e.ticker}`; }
  function isUS(e) { return e.market === 'US'; }

  // 이벤트의 원화 거래대금 (BUY/SELL/OPEN)
  function krwAmount(e, fallbackFx) {
    const fx = isUS(e) ? (e.fx > 0 ? e.fx : fallbackFx || 0) : 1;
    return (e.price || 0) * (e.qty || 0) * fx;
  }

  // ── 리플레이: 원장 → 상태 ──
  // untilTs 포함 이하의 이벤트만 적용. 반환값은 매번 새로 계산된 파생 상태.
  function replay(events, untilTs) {
    const cut = untilTs ? ((untilTs.length === 10 ? untilTs + 'T23:59' : untilTs) + '|9999999999') : null;
    const sorted = events
      .map((e, i) => ({ ...e, seq: e.seq ?? i }))
      .sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1)
      .filter(e => !cut || sortKey(e) <= cut);

    const positions = new Map();   // posKey → {acct, market, ticker, name, qty, avg, avgFx}
    const byAcct = new Map();      // acct → 계좌 상태
    const warnings = [];

    function acctState(name) {
      const key = name || '';
      if (!byAcct.has(key)) {
        byAcct.set(key, {
          acct: key,
          cash: 0,
          cashTracked: false,          // 입출금 기록이 하나라도 있으면 true
          realizedByYear: {},          // 연도 → 매도 실현손익 + ADJUST (원)
          dividendsByYear: {},         // 연도 → 배당 (원)
          flowsExternal: [],           // [{ts, amount}] 입금+, 출금− (Dietz용)
          flowsTrade: [],              // [{ts, amount}] 매수+, 매도− (입출금 미기록 계좌의 근사 분모용)
        });
      }
      return byAcct.get(key);
    }
    function addYear(map, y, v) { map[y] = (map[y] || 0) + v; }

    for (const e of sorted) {
      const a = acctState(e.acct);
      const y = yearOf(e);
      switch (e.type) {
        case 'OPEN': {
          const k = posKey(e);
          if (positions.has(k)) warnings.push({ id: e.id, msg: `OPEN 중복: ${e.ticker} — 기존 포지션을 덮어씀` });
          positions.set(k, {
            acct: e.acct || '', market: e.market, ticker: e.ticker, name: e.name || e.ticker,
            qty: e.qty, avg: e.price, avgFx: isUS(e) ? (e.fx || 0) : 0,
          });
          break;
        }
        case 'BUY': {
          const k = posKey(e);
          const cost = krwAmount(e);
          const p = positions.get(k);
          if (p) {
            const totalQty = p.qty + e.qty;
            if (isUS(e)) {
              const oldUsd = p.avg * p.qty, newUsd = e.price * e.qty;
              const oldFx = p.avgFx > 0 ? p.avgFx : (e.fx || 0);
              if (oldUsd + newUsd > 0) p.avgFx = (oldUsd * oldFx + newUsd * (e.fx || 0)) / (oldUsd + newUsd);
            }
            p.avg = totalQty > 0 ? (p.avg * p.qty + e.price * e.qty) / totalQty : e.price;
            p.qty = totalQty;
            if (e.name) p.name = e.name;
          } else {
            positions.set(k, {
              acct: e.acct || '', market: e.market, ticker: e.ticker, name: e.name || e.ticker,
              qty: e.qty, avg: e.price, avgFx: isUS(e) ? (e.fx || 0) : 0,
            });
          }
          a.cash -= cost;
          a.flowsTrade.push({ ts: e.ts, amount: cost });
          break;
        }
        case 'SELL': {
          const k = posKey(e);
          const p = positions.get(k);
          let applyQty = e.qty;
          if (!p || p.qty <= 0) {
            warnings.push({ id: e.id, msg: `보유 없는 매도: ${e.ticker} ${e.qty}` });
            applyQty = 0;
          } else if (e.qty > p.qty + 1e-9) {
            warnings.push({ id: e.id, msg: `매도 수량 초과: ${e.ticker} 매도 ${e.qty} > 보유 ${p.qty}` });
            applyQty = p.qty;
          }
          if (applyQty > 0 && p) {
            let realized;
            if (isUS(e)) {
              const sellFx = e.fx > 0 ? e.fx : (p.avgFx || 0);
              const buyFx = p.avgFx > 0 ? p.avgFx : sellFx;
              realized = e.price * applyQty * sellFx - p.avg * applyQty * buyFx;
            } else {
              realized = (e.price - p.avg) * applyQty;
            }
            addYear(a.realizedByYear, y, realized);
            const proceeds = krwAmount({ ...e, qty: applyQty }, p.avgFx);
            a.cash += proceeds;
            a.flowsTrade.push({ ts: e.ts, amount: -proceeds });
            p.qty -= applyQty;
            if (p.qty <= 1e-9) positions.delete(k);
          }
          break;
        }
        case 'DEPOSIT':
          a.cash += e.amount; a.cashTracked = true;
          a.flowsExternal.push({ ts: e.ts, amount: e.amount });
          break;
        case 'WITHDRAW':
          a.cash -= e.amount; a.cashTracked = true;
          a.flowsExternal.push({ ts: e.ts, amount: -e.amount });
          break;
        case 'DIVIDEND':
          a.cash += e.amount;
          addYear(a.dividendsByYear, y, e.amount);
          break;
        case 'ADJUST':
          a.cash += e.amount;
          addYear(a.realizedByYear, y, e.amount);
          break;
        default:
          warnings.push({ id: e.id, msg: `알 수 없는 이벤트 유형: ${e.type}` });
      }
    }

    return {
      positions: [...positions.values()],
      byAcct: Object.fromEntries(byAcct),
      warnings,
    };
  }

  // ── 검증 ──
  // 새 이벤트(들)를 더한 전체 원장을 리플레이해, "새 이벤트가 만든" 오류만 골라낸다.
  function validate(existing, incoming) {
    const errors = [];
    for (const e of incoming) {
      if (!TYPES.includes(e.type)) errors.push({ id: e.id, msg: `유형 오류: ${e.type}` });
      if (!e.ts || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(e.ts)) errors.push({ id: e.id, msg: '날짜 형식 오류 (YYYY-MM-DD)' });
      if (TRADE_TYPES.includes(e.type)) {
        if (!e.ticker) errors.push({ id: e.id, msg: '종목 코드 누락' });
        if (!(e.qty > 0)) errors.push({ id: e.id, msg: '수량은 0보다 커야 함' });
        if (!(e.price > 0)) errors.push({ id: e.id, msg: '단가는 0보다 커야 함' });
        if (e.market === 'US' && !(e.fx > 0)) errors.push({ id: e.id, msg: '미국주식 환율 누락' });
      }
      if (['DEPOSIT', 'WITHDRAW', 'DIVIDEND'].includes(e.type) && !(e.amount > 0)) {
        errors.push({ id: e.id, msg: '금액은 0보다 커야 함' });
      }
      if (e.type === 'ADJUST' && typeof e.amount !== 'number') {
        errors.push({ id: e.id, msg: '보정 금액 누락' });
      }
    }
    if (errors.length) return { ok: false, errors, warnings: [] };

    const incomingIds = new Set(incoming.map(e => e.id));
    const prevWarnIds = new Set(replay(existing).warnings.map(w => w.id));
    const after = replay([...existing, ...incoming]);
    // 새 이벤트가 직접 일으킨 경고(매도 초과 등)는 오류로 승격
    for (const w of after.warnings) {
      if (incomingIds.has(w.id)) errors.push(w);
      else if (!prevWarnIds.has(w.id)) errors.push({ ...w, msg: w.msg + ' (새 이벤트로 인해 기존 기록이 모순됨)' });
    }
    return { ok: errors.length === 0, errors, warnings: after.warnings };
  }

  // ── Modified Dietz 수익률 ──
  // startValue: 기초 자산, endValue: 기말 자산, flows: [{ts, amount}] (+유입/−유출)
  // 기간: startTs ~ endTs (YYYY-MM-DD)
  function dietz(startValue, endValue, flows, startTs, endTs) {
    const t0 = Date.parse(startTs), t1 = Date.parse(endTs);
    const span = Math.max(t1 - t0, 1);
    let netFlow = 0, weighted = 0;
    for (const f of flows) {
      const tf = Date.parse((f.ts || '').slice(0, 10));
      if (isNaN(tf) || tf < t0 || tf > t1) continue;
      netFlow += f.amount;
      weighted += f.amount * ((t1 - tf) / span);
    }
    const gain = endValue - startValue - netFlow;
    const denom = startValue + weighted;
    return { gain, denom, rate: denom > 0 ? gain / denom : 0 };
  }

  // ── 저장소 ──
  const hasLS = typeof localStorage !== 'undefined';
  let _events = null;

  function load() {
    if (_events) return _events;
    _events = hasLS ? JSON.parse(localStorage.getItem(LS_KEY) || '[]') : [];
    return _events;
  }
  function persist() {
    if (!hasLS) return;
    const cur = localStorage.getItem(LS_KEY);
    if (cur != null) localStorage.setItem(LS_PREV, cur);  // 직전본 1벌 보관
    localStorage.setItem(LS_KEY, JSON.stringify(_events));
  }
  function undoLastSave() {
    if (!hasLS) return false;
    const prev = localStorage.getItem(LS_PREV);
    if (prev == null) return false;
    localStorage.setItem(LS_KEY, prev);
    _events = JSON.parse(prev);
    return true;
  }

  function addEvents(incoming) {
    const events = load();
    const stamped = incoming.map(e => ({ ...e, id: e.id || newId() }));
    const v = validate(events, stamped);
    if (!v.ok) return v;
    const maxSeq = events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    stamped.forEach((e, i) => { e.seq = maxSeq + 1 + i; });
    _events = [...events, ...stamped];
    persist();
    return { ok: true, errors: [], warnings: v.warnings, added: stamped };
  }

  function updateEvent(id, patch) {
    const events = load();
    const idx = events.findIndex(e => e.id === id);
    if (idx < 0) return { ok: false, errors: [{ id, msg: '이벤트를 찾을 수 없음' }] };
    const updated = { ...events[idx], ...patch, id, seq: events[idx].seq };
    const rest = events.filter(e => e.id !== id);
    const v = validate(rest, [updated]);
    if (!v.ok) return v;
    _events = events.map(e => (e.id === id ? updated : e));
    persist();
    return { ok: true, errors: [], warnings: v.warnings };
  }

  function removeEvent(id) {
    const events = load();
    _events = events.filter(e => e.id !== id);
    persist();
    // 삭제로 생긴 모순(이 매수에 기댄 매도 등)은 경고로 노출
    return { ok: true, warnings: replay(_events).warnings };
  }

  function state(untilTs) { return replay(load(), untilTs); }

  // ── v1 데이터 가져오기 ──
  // 입력: v1 내보내기 JSON({portfolio, yearAccounts, ...}) 또는 localStorage에서 직접.
  // 전략: "지금"을 기초잔고(OPEN)로 확정 + 금년 실현손익은 ADJUST로 이월.
  // 과거 거래 내역은 변환하지 않는다(보유에 이미 반영됨; 이력은 v1에 보존).
  function importV1(data, opts) {
    const today = (opts && opts.date) || new Date().toISOString().slice(0, 10);
    const evts = [];
    const pf = Array.isArray(data.portfolio) ? data.portfolio : [];
    for (const s of pf) {
      if (!(s.qty > 0) || !(s.avg > 0)) continue;
      evts.push({
        id: newId(), type: 'OPEN', ts: today,
        acct: s.acct || '', market: s.market || 'KR', ticker: s.ticker,
        name: s.name || s.ticker, qty: s.qty, price: s.avg,
        fx: s.market === 'US' ? (s.avgFx || 0) : undefined,
        src: 'v1', memo: 'v1 보유 이월',
      });
    }
    const yas = Array.isArray(data.yearAccounts) ? data.yearAccounts : [];
    for (const ya of yas) {
      if (ya.realized) {
        evts.push({
          id: newId(), type: 'ADJUST', ts: today, acct: ya.name || '',
          amount: Math.round(ya.realized), src: 'v1', memo: 'v1 금년 실현손익 이월',
        });
      }
    }
    return evts;   // 호출측이 미리보기 후 addEvents로 확정
  }

  function exportAll() {
    return { version: 2, exportedAt: new Date().toISOString(), ledger: load() };
  }
  function importAll(data) {
    if (!data || !Array.isArray(data.ledger)) return { ok: false, errors: [{ msg: '형식 오류' }] };
    _events = data.ledger;
    persist();
    return { ok: true, warnings: replay(_events).warnings };
  }

  global.Ledger = {
    TYPES, newId, replay, validate, dietz,
    load, addEvents, updateEvent, removeEvent, state,
    importV1, exportAll, importAll, undoLastSave,
    _reset: () => { _events = null; },   // 테스트용
  };
})(typeof window !== 'undefined' ? window : globalThis);
