// app.js — v2 화면: 요약·카드·거래입력·원장·v1 가져오기
(function (global) {
  'use strict';
  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString('ko-KR');
  const fmtSign = n => (n >= 0 ? '+' : '−') + fmt(Math.abs(n));
  const pct = (n, d) => (d > 0 ? (n / d) * 100 : 0);
  const fmtPct = p => (p >= 0 ? '+' : '−') + Math.abs(p).toFixed(2) + '%';
  const cls = n => (n >= 0 ? 'up' : 'down');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const YEAR = new Date().getFullYear();

  const SETTINGS_KEY = 'v2_settings';
  const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  // ── 파생 계산 ──
  function enrich() {
    const st = Ledger.state();
    const events = Ledger.load();
    const tday = today();
    // 오늘 매수 수량·금액 (금일손익의 기준가 보정: HTS 방식)
    const todayBuys = {};
    for (const e of events) {
      if (e.type === 'BUY' && (e.ts || '').slice(0, 10) === tday) {
        const k = `${e.acct || ''}|${e.market}|${e.ticker}`;
        const t = todayBuys[k] || (todayBuys[k] = { qty: 0, cost: 0 });
        t.qty += e.qty; t.cost += e.qty * e.price;   // 현지 통화
      }
    }
    let totEval = 0, totCost = 0, totDay = 0, totCash = 0;
    const fx = Quotes.fxKrw;
    for (const p of st.positions) {
      p.q = Quotes.get(p);
      p.evalKrw = Quotes.evalKrw(p);
      p.costKrw = Quotes.costKrw(p);
      p.gain = p.evalKrw - p.costKrw;
      const toKrw = p.market === 'US' ? (fx || p.avgFx || 0) : 1;
      // 금일손익: 어제부터 보유분 = (현재가−전일종가), 오늘 매수분 = (현재가−매수가)
      p.day = 0; p.chgPct = null;
      if (p.q && p.q.price > 0 && p.q.prevClose > 0) {
        const tb = todayBuys[`${p.acct}|${p.market}|${p.ticker}`] || { qty: 0, cost: 0 };
        const heldQty = Math.max(p.qty - tb.qty, 0);
        p.day = ((p.q.price - p.q.prevClose) * heldQty + (p.q.price * tb.qty - tb.cost)) * toKrw;
        p.chgPct = pct(p.q.price - p.q.prevClose, p.q.prevClose);
      }
      totEval += p.evalKrw; totCost += p.costKrw; totDay += p.day;
    }
    // 올해 실현+배당, 추적 현금
    let realizedY = 0, divY = 0;
    for (const a of Object.values(st.byAcct)) {
      realizedY += a.realizedByYear[YEAR] || 0;
      divY += a.dividendsByYear[YEAR] || 0;
      if (a.cashTracked) totCash += a.cash;
    }
    return { st, totEval, totCost, totDay, totCash, realizedY, divY };
  }

  // ── 렌더: 요약 + 계좌 카드 ──
  function render() {
    const d = enrich();
    const gain = d.totEval - d.totCost;
    const hasQ = d.st.positions.some(p => p.q && p.q.price > 0);
    $('summary').innerHTML = `
      <div class="sum-grid">
        <div class="card wide">
          <div><div class="c-label">총자산${d.totCash ? ' (주식+현금)' : ''}</div>
          <div class="c-val">${hasQ ? fmt(d.totEval + d.totCash) + '원' : '—'}</div></div>
          <div style="text-align:right"><div class="c-label">올해 실현+배당</div>
          <div class="c-val" style="font-size:15px" ><span class="${cls(d.realizedY + d.divY)}">${fmtSign(d.realizedY + d.divY)}원</span></div></div>
        </div>
        <div class="card"><div class="c-label">금일손익</div>
          <div class="c-val ${cls(d.totDay)}">${hasQ ? fmtSign(d.totDay) + '원' : '—'}</div>
          <div class="c-sub">각 시장 전일종가 대비</div></div>
        <div class="card"><div class="c-label">평가손익 (평단 대비)</div>
          <div class="c-val ${cls(gain)}">${hasQ ? fmtSign(gain) + '원' : '—'}</div>
          <div class="c-sub ${cls(gain)}">${hasQ ? fmtPct(pct(gain, d.totCost)) : ''}</div></div>
      </div>`;
    $('st-fx').textContent = Quotes.fxKrw ? `USD/KRW ${Quotes.fxKrw.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}` : '';
    $('st-time').textContent = Quotes.lastAt ? '갱신 ' + Quotes.lastAt.toTimeString().slice(0, 5) : '시세 조회 전';

    // 계좌 그룹
    const groups = {};
    for (const p of d.st.positions) (groups[p.acct || ''] = groups[p.acct || ''] || []).push(p);
    const names = Object.keys(groups).sort((a, b) =>
      groups[b].reduce((s, p) => s + p.evalKrw, 0) - groups[a].reduce((s, p) => s + p.evalKrw, 0));
    if (names.length === 0) {
      $('accounts').innerHTML = `<div class="empty">아직 데이터가 없습니다.<br>
        <button class="btn btn-primary" style="margin-top:10px" onclick="App.openImport()">v1 데이터 가져오기</button>
        <div style="margin-top:8px;font-size:11px">또는 + 버튼으로 거래를 직접 입력하세요</div></div>`;
      return;
    }
    $('accounts').innerHTML = names.map(name => {
      const ps = groups[name].sort((a, b) => b.evalKrw - a.evalKrw);
      const ev = ps.reduce((s, p) => s + p.evalKrw, 0);
      const day = ps.reduce((s, p) => s + p.day, 0);
      const acctInfo = d.st.byAcct[name];
      const cash = acctInfo && acctInfo.cashTracked ? acctInfo.cash : null;
      return `<div class="acct-group">
        <div class="acct-head">
          <span class="acct-name">${esc(name) || '미지정'}</span>
          <span class="acct-stats">평가 ${fmt(ev)}${cash != null ? ' · 현금 ' + fmt(cash) : ''} · <span class="${cls(day)}">${fmtSign(day)}</span></span>
        </div>
        ${ps.map(stockCard).join('')}
      </div>`;
    }).join('');
  }

  function stockCard(p) {
    const q = p.q;
    const isUS = p.market === 'US';
    const badge = isUS ? '<span class="badge us">US</span>' : (p.market === 'KR' ? '<span class="badge kr">KR</span>' : `<span class="badge etc">${esc(p.market)}</span>`);
    const curLocal = q && q.price > 0 ? q.price : null;
    const fmtLocal = v => isUS ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fmt(v);
    const stateTxt = q ? ({ PRE: '장전', POST: '장후', REGULAR: '', CLOSED: '' }[q.state] || '') : '';
    const stale = q && q.stale ? '지연' : (!q ? '시세없음' : '');
    const chg = p.chgPct != null
      ? `<span class="s-chg ${cls(p.chgPct)}">${fmtPct(p.chgPct)}</span>`
      : `<span class="s-chg" style="color:var(--text3)">—</span>`;
    return `<div class="stock">
      <div class="s-row1">
        <span><span class="s-name">${esc(p.name)}</span><span class="s-tick">${esc(p.ticker)}</span>${badge}
          ${stateTxt ? `<span class="mstate" style="color:#e67e22">${stateTxt}</span>` : ''}
          ${stale ? `<span class="mstate" style="color:var(--text3)">${stale}</span>` : ''}</span>
        ${chg}
      </div>
      <div class="s-row2">
        <span>${p.qty.toLocaleString()}주 · 평단 ${fmtLocal(p.avg)}${isUS && p.avgFx ? ` · 환율 ${p.avgFx.toFixed(0)}` : ''}</span>
        <span>현재 ${curLocal != null ? fmtLocal(curLocal) : '—'}</span>
      </div>
      <div class="s-row3">
        <span style="color:var(--text3)">평가 ${fmt(p.evalKrw)}원</span>
        <span class="${cls(p.gain)}">${fmtSign(p.gain)}원 (${fmtPct(pct(p.gain, p.costKrw))})</span>
      </div>
    </div>`;
  }

  // ── 원장 뷰 ──
  function renderLedger() {
    const events = [...Ledger.load()].sort((a, b) =>
      a.ts === b.ts ? (b.seq ?? 0) - (a.seq ?? 0) : (a.ts < b.ts ? 1 : -1));
    const warnings = new Map(Ledger.state().warnings.map(w => [w.id, w.msg]));
    if (events.length === 0) { $('view-ledger').innerHTML = '<div class="empty">원장이 비어 있습니다</div>'; return; }
    let html = '', lastDay = '';
    for (const e of events) {
      const day = (e.ts || '').slice(0, 10);
      if (day !== lastDay) { html += `<div class="lg-day">${day}</div>`; lastDay = day; }
      const label = { OPEN: '기초', BUY: '매수', SELL: '매도', DEPOSIT: '입금', WITHDRAW: '출금', DIVIDEND: '배당', ADJUST: '보정' }[e.type] || e.type;
      let main, sub;
      if (['OPEN', 'BUY', 'SELL'].includes(e.type)) {
        main = `${esc(e.name || e.ticker)} ${e.qty.toLocaleString()}주`;
        sub = `@${e.price.toLocaleString()}${e.market === 'US' ? ` · 환율 ${e.fx || '—'}` : ''} · ${esc(e.acct) || '미지정'}`;
      } else {
        main = `${fmt(e.amount)}원`;
        sub = `${esc(e.acct) || '미지정'}${e.memo ? ' · ' + esc(e.memo) : ''}`;
      }
      const warn = warnings.get(e.id);
      html += `<div class="lg-item">
        <span class="lg-type t-${e.type}">${label}</span>
        <div class="lg-main"><div class="lg-title">${main}</div><div class="lg-sub">${sub}</div>
          ${warn ? `<div class="warn">⚠️ ${esc(warn)}</div>` : ''}</div>
        <div class="lg-btns">
          <button class="btn btn-ghost btn-sm" onclick="App.editEvent('${e.id}')">✏️</button>
          <button class="btn btn-ghost btn-sm" onclick="App.deleteEvent('${e.id}')">✕</button>
        </div>
      </div>`;
    }
    $('view-ledger').innerHTML = html;
  }

  // ── 뷰 전환 ──
  function showView(v) {
    $('view-home').style.display = v === 'home' ? '' : 'none';
    $('view-ledger').style.display = v === 'ledger' ? '' : 'none';
    $('tab-home').classList.toggle('active', v === 'home');
    $('tab-ledger').classList.toggle('active', v === 'ledger');
    if (v === 'ledger') renderLedger();
  }

  // ── 거래 입력 ──
  let rows = [];          // 입력 중 행
  let editingId = null;   // 단일 수정 모드

  function acctNames() {
    return [...new Set(Ledger.load().map(e => e.acct).filter(Boolean))];
  }
  function blankRow(kind) {
    const accts = acctNames();
    return { kind: kind || 'BUY', acct: accts.length === 1 ? accts[0] : (accts[0] || ''), ticker: '', name: '', qty: '', price: '', fx: '', amount: '' };
  }

  function openTrade(prefill) {
    editingId = prefill && prefill.id ? prefill.id : null;
    rows = [prefill ? { ...prefill, kind: prefill.type } : blankRow()];
    $('trade-overlay').classList.add('open');
    renderTrade(prefill ? (prefill.ts || '').slice(0, 10) : today());
  }
  function closeTrade() { $('trade-overlay').classList.remove('open'); }

  function renderTrade(dateVal) {
    const date = dateVal || ($('t-date') ? $('t-date').value : today());
    const accts = acctNames();
    $('trade-modal').innerHTML = `
      <div class="m-title"><span>${editingId ? '기록 수정' : '거래 입력'}</span>
        <button class="btn btn-ghost btn-sm" onclick="App.closeTrade()">닫기</button></div>
      <div class="field"><div class="f-label">거래 날짜 (모든 행 공통)</div>
        <input type="date" id="t-date" value="${date}" /></div>
      <div id="t-rows">${rows.map((r, i) => tradeRowHtml(r, i, accts)).join('')}</div>
      ${editingId ? '' : `<div class="row2" style="margin-bottom:10px">
        <button class="btn btn-ghost" onclick="App.addRow('BUY')">+ 매수/매도</button>
        <button class="btn btn-ghost" onclick="App.addRow('DEPOSIT')">+ 입출금/배당</button>
      </div>`}
      <div id="t-err" class="err"></div>
      <button class="btn btn-primary" style="width:100%;margin-top:6px" onclick="App.saveTrade()">${editingId ? '수정 저장' : '저장'}</button>`;
  }

  function tradeRowHtml(r, i, accts) {
    const isTrade = ['OPEN', 'BUY', 'SELL'].includes(r.kind);
    const isUS = r.market === 'US';
    const acctOpts = [...new Set([r.acct, ...accts])].filter(x => x != null)
      .map(a => `<option value="${esc(a)}" ${a === r.acct ? 'selected' : ''}>${esc(a) || '미지정'}</option>`).join('')
      + '<option value="__NEW__">+ 새 계좌</option>';
    return `<div class="trade-row">
      ${rows.length > 1 ? `<button class="trade-x" onclick="App.delRow(${i})">✕</button>` : ''}
      <div class="row2" style="margin-bottom:8px">
        <div><div class="f-label">구분</div>
          <select onchange="App.setRow(${i},'kind',this.value)">
            ${['BUY|매수', 'SELL|매도', 'OPEN|기초잔고', 'DEPOSIT|입금', 'WITHDRAW|출금', 'DIVIDEND|배당', 'ADJUST|실현손익 보정']
              .map(o => { const [v, l] = o.split('|'); return `<option value="${v}" ${r.kind === v ? 'selected' : ''}>${l}</option>`; }).join('')}
          </select></div>
        <div><div class="f-label">계좌</div>
          <select onchange="App.setAcct(${i},this.value)">${acctOpts}</select></div>
      </div>
      ${isTrade ? `
      <div class="field"><div class="f-label">종목 (코드·티커 또는 한글명)</div>
        <input value="${esc(r.ticker || r.inputName || '')}" placeholder="005930 / AAPL / 해성디에스"
          onchange="App.resolveTicker(${i},this.value)" />
        ${r.name ? `<div class="hint" style="color:var(--up)">✓ ${esc(r.name)} <span style="color:var(--text3)">${esc(r.ticker)} · ${r.market}</span></div>` : ''}
        ${r.resolveErr ? `<div class="warn">${esc(r.resolveErr)}</div>` : ''}</div>
      <div class="${isUS ? 'row3' : 'row2'}">
        <div><div class="f-label">수량</div><input inputmode="decimal" value="${r.qty}" onchange="App.setRow(${i},'qty',this.value)" /></div>
        <div><div class="f-label">단가 ${isUS ? '($)' : '(원)'}</div><input inputmode="decimal" value="${r.price}" onchange="App.setRow(${i},'price',this.value)" /></div>
        ${isUS ? `<div><div class="f-label">환율</div><input inputmode="decimal" value="${r.fx || (Quotes.fxKrw ? Quotes.fxKrw.toFixed(1) : '')}" onchange="App.setRow(${i},'fx',this.value)" /></div>` : ''}
      </div>` : `
      <div class="field"><div class="f-label">금액 (원)${r.kind === 'ADJUST' ? ' — 음수 가능' : ''}</div>
        <input inputmode="numeric" value="${r.amount}" onchange="App.setRow(${i},'amount',this.value)" /></div>`}
    </div>`;
  }

  function addRow(kind) { rows.push(blankRow(kind)); renderTrade(); }
  function delRow(i) { rows.splice(i, 1); renderTrade(); }
  function setRow(i, k, v) {
    rows[i][k] = v;
    if (k === 'kind') renderTrade();
  }
  function setAcct(i, v) {
    if (v === '__NEW__') {
      const name = prompt('새 계좌 이름');
      rows[i].acct = (name || '').trim();
    } else rows[i].acct = v;
    renderTrade();
  }

  async function resolveTicker(i, raw) {
    const r = rows[i];
    const v = (raw || '').trim();
    r.resolveErr = ''; r.name = '';
    if (!v) return;
    if (/^\d{1,6}$/.test(v)) {
      r.ticker = v.padStart(6, '0'); r.market = 'KR';
      try {
        const q = await fetch('/api/quote2?symbols=' + r.ticker + ':KR').then(x => x.json());
        const d = q.quotes[r.ticker + ':KR'];
        if (d && d.name) r.name = d.name;
        if (d && d.price > 0) r.curPrice = d.price;
      } catch (e) {}
    } else if (/[가-힣]/.test(v)) {
      r.inputName = v;
      try {
        const d = await fetch('/api/stock-search?q=' + encodeURIComponent(v)).then(x => x.json());
        if (d && /^\d{6}$/.test(d.code || '')) { r.ticker = d.code; r.market = 'KR'; r.name = d.name || v; }
        else r.resolveErr = '종목을 찾지 못했습니다 — 코드로 입력해 주세요';
      } catch (e) { r.resolveErr = '종목 검색 실패 — 코드로 입력해 주세요'; }
    } else {
      r.ticker = v.toUpperCase(); r.market = 'US';
      try {
        const q = await fetch('/api/quote2?symbols=' + r.ticker + ':US').then(x => x.json());
        const d = q.quotes[r.ticker + ':US'];
        if (d && d.name) r.name = d.name;
      } catch (e) {}
    }
    renderTrade();
  }

  function saveTrade() {
    const date = $('t-date').value || today();
    const evts = [];
    for (const r of rows) {
      const base = { type: r.kind, ts: date, acct: r.acct || '', memo: r.memo, src: 'manual' };
      if (['OPEN', 'BUY', 'SELL'].includes(r.kind)) {
        evts.push({ ...base, market: r.market, ticker: r.ticker, name: r.name || r.inputName || r.ticker,
          qty: parseFloat(String(r.qty).replace(/,/g, '')) || 0,
          price: parseFloat(String(r.price).replace(/,/g, '')) || 0,
          fx: r.market === 'US' ? (parseFloat(String(r.fx).replace(/,/g, '')) || Quotes.fxKrw || 0) : undefined });
      } else {
        evts.push({ ...base, amount: parseFloat(String(r.amount).replace(/,/g, '')) || 0 });
      }
    }
    let result;
    if (editingId) result = Ledger.updateEvent(editingId, evts[0]);
    else result = Ledger.addEvents(evts);
    if (!result.ok) {
      $('t-err').textContent = result.errors.map(e => e.msg).join(' / ');
      return;
    }
    closeTrade();
    render(); renderLedger();
    refresh();   // 새 종목 시세 반영
  }

  function editEvent(id) {
    const e = Ledger.load().find(x => x.id === id);
    if (e) openTrade(e);
  }
  function deleteEvent(id) {
    if (!confirm('이 기록을 삭제할까요? (모든 수치는 자동 재계산됩니다)')) return;
    const r = Ledger.removeEvent(id);
    if (r.warnings.length) alert('⚠️ 삭제로 어긋난 기록이 있습니다:\n' + r.warnings.map(w => w.msg).join('\n'));
    render(); renderLedger();
  }

  // ── v1 가져오기 ──
  function openImport() {
    $('import-overlay').classList.add('open');
    const hasV1 = !!localStorage.getItem('pf_kis');
    $('import-modal').innerHTML = `
      <div class="m-title"><span>v1 데이터 가져오기</span>
        <button class="btn btn-ghost btn-sm" onclick="App.closeImport()">닫기</button></div>
      <div style="font-size:12px;color:var(--text2);line-height:1.6;margin-bottom:12px">
        현재 보유(평단·수량)를 <b>기초잔고(OPEN)</b>로, 올해 실현 수익금을 <b>보정(ADJUST)</b>으로 가져옵니다.
        과거 거래 이력은 v1에 그대로 보존됩니다.</div>
      ${hasV1 ? `<button class="btn btn-primary" style="width:100%;margin-bottom:8px" onclick="App.importFromLocal()">이 브라우저의 v1 데이터 불러오기</button>` : '<div class="hint" style="margin-bottom:8px">이 브라우저에 v1 데이터가 없습니다 — 백업 파일을 선택하세요</div>'}
      <input type="file" id="imp-file" accept=".json" style="display:none" onchange="App.importFromFile(this)" />
      <button class="btn btn-ghost" style="width:100%" onclick="document.getElementById('imp-file').click()">v1 백업 파일(.json) 선택</button>
      <div id="imp-preview"></div>`;
  }
  function closeImport() { $('import-overlay').classList.remove('open'); }

  function importFromLocal() {
    const data = {
      portfolio: JSON.parse(localStorage.getItem('pf_kis') || '[]'),
      yearAccounts: JSON.parse(localStorage.getItem('year_accounts') || '[]'),
      appKey: localStorage.getItem('kis_key') || '', appSecret: localStorage.getItem('kis_secret') || '',
    };
    previewImport(data);
  }
  function importFromFile(input) {
    const f = input.files && input.files[0]; input.value = '';
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { try { previewImport(JSON.parse(fr.result)); } catch (e) { alert('파일 형식 오류'); } };
    fr.readAsText(f);
  }

  let pendingImport = null;
  function previewImport(data) {
    const evts = Ledger.importV1(data);
    if (evts.length === 0) { $('imp-preview').innerHTML = '<div class="err">가져올 데이터가 없습니다</div>'; return; }
    pendingImport = { evts, data };
    const opens = evts.filter(e => e.type === 'OPEN');
    const adjs = evts.filter(e => e.type === 'ADJUST');
    $('imp-preview').innerHTML = `
      <div style="margin-top:14px;font-size:12px;color:var(--text3)">미리보기 — 확인 후 확정하세요</div>
      <table class="prev"><tr><th>종목</th><th>계좌</th><th>수량</th><th>평단</th></tr>
        ${opens.map(e => `<tr><td>${esc(e.name)}</td><td>${esc(e.acct) || '—'}</td><td>${e.qty.toLocaleString()}</td><td>${e.price.toLocaleString()}${e.market === 'US' ? ' $' : ''}</td></tr>`).join('')}
        ${adjs.map(e => `<tr><td>올해 실현손익 이월</td><td>${esc(e.acct)}</td><td colspan="2">${fmtSign(e.amount)}원</td></tr>`).join('')}
      </table>
      <button class="btn btn-primary" style="width:100%;margin-top:12px" onclick="App.confirmImport()">이대로 확정 (${opens.length}종목)</button>`;
  }
  function confirmImport() {
    if (!pendingImport) return;
    const r = Ledger.addEvents(pendingImport.evts);
    if (!r.ok) { alert('가져오기 실패:\n' + r.errors.map(e => e.msg).join('\n')); return; }
    if (pendingImport.data.appKey) { settings.kisKey = pendingImport.data.appKey; settings.kisSecret = pendingImport.data.appSecret; saveSettings(); }
    pendingImport = null;
    closeImport();
    refresh();
  }

  // ── 설정 ──
  function openSettings() {
    $('settings-overlay').classList.add('open');
    $('settings-modal').innerHTML = `
      <div class="m-title"><span>설정·데이터</span>
        <button class="btn btn-ghost btn-sm" onclick="App.closeSettings()">닫기</button></div>
      <button class="btn btn-ghost" style="width:100%;margin-bottom:8px" onclick="App.openImport();App.closeSettings()">⬆ v1 데이터 가져오기</button>
      <button class="btn btn-ghost" style="width:100%;margin-bottom:8px" onclick="App.exportV2()">💾 내보내기 (백업 JSON)</button>
      <input type="file" id="v2-file" accept=".json" style="display:none" onchange="App.importV2File(this)" />
      <button class="btn btn-ghost" style="width:100%;margin-bottom:8px" onclick="document.getElementById('v2-file').click()">📂 가져오기 (v2 백업)</button>
      <button class="btn btn-ghost" style="width:100%;margin-bottom:14px" onclick="App.undoSave()">↩ 직전 저장 되돌리기</button>
      <div class="field"><div class="f-label">KIS 앱키 (선택 — 향후 시세·연동용)</div>
        <input id="set-key" value="${esc(settings.kisKey || '')}" /></div>
      <div class="field"><div class="f-label">KIS 시크릿</div>
        <input id="set-secret" type="password" value="${esc(settings.kisSecret || '')}" /></div>
      <button class="btn btn-primary" style="width:100%" onclick="App.saveSettingsForm()">저장</button>`;
  }
  function closeSettings() { $('settings-overlay').classList.remove('open'); }
  function saveSettingsForm() {
    settings.kisKey = $('set-key').value.trim();
    settings.kisSecret = $('set-secret').value.trim();
    saveSettings(); closeSettings();
  }
  function exportV2() {
    const blob = new Blob([JSON.stringify(Ledger.exportAll(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `portfolio_v2_${today().replace(/-/g, '')}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  }
  function importV2File(input) {
    const f = input.files && input.files[0]; input.value = '';
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        if (!confirm('현재 원장을 이 백업으로 교체할까요?')) return;
        const r = Ledger.importAll(JSON.parse(fr.result));
        if (!r.ok) { alert('형식 오류'); return; }
        closeSettings(); refresh();
      } catch (e) { alert('파일 형식 오류'); }
    };
    fr.readAsText(f);
  }
  function undoSave() {
    if (!confirm('직전 저장 상태로 되돌릴까요?')) return;
    if (Ledger.undoLastSave()) { render(); renderLedger(); } else alert('되돌릴 백업이 없습니다');
  }

  // ── 새로고침 루프 ──
  async function refresh() {
    await Quotes.fetchFor(Ledger.state().positions);
    render();
  }

  // 모달 바깥 클릭 → 닫기 (입력 중 데이터는 rows에 보존되므로 안전)
  for (const [ov, close] of [['trade-overlay', closeTrade], ['import-overlay', closeImport], ['settings-overlay', closeSettings]]) {
    $(ov).addEventListener('click', e => { if (e.target === $(ov)) close(); });
  }

  global.App = {
    refresh, showView, openTrade, closeTrade, addRow, delRow, setRow, setAcct, resolveTicker, saveTrade,
    editEvent, deleteEvent, openImport, closeImport, importFromLocal, importFromFile, confirmImport,
    openSettings, closeSettings, saveSettingsForm, exportV2, importV2File, undoSave,
  };

  render();
  refresh();
  Quotes.startAuto(refresh, 30000);
})(window);
