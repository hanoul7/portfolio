// 종목별 투자자 매매동향
// 1) 네이버 모바일증권 /trend — 일별 시계열 (장 마감 후 집계, latest = 직전 거래일)
// 2) (옵션) KIS API 실시간 TR — 클라이언트가 token/appkey/appsecret을 헤더로 넘겨주면 시도
//    TR id를 query 파라미터로 받아 유연하게 시도. 실패시 네이버 데이터만 반환.
//
// 응답 예시: { symbol, data: [{date, close, change, foreign, organ, individual, ...}, ...],
//             realtime?: {date, foreign, organ, individual, source: 'kis'} }
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,authorization,appkey,appsecret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol || !/^\d{6}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid symbol (6-digit code required)' });
  }

  const num = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[+,\s%]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  // 1) 네이버 일별 시계열 (항상 시도)
  let data = [];
  try {
    const r = await fetch(
      `https://m.stock.naver.com/api/stock/${symbol}/trend`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr)) {
        data = arr.map(d => {
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
      }
    }
  } catch (e) { /* fall through */ }

  // 2) KIS 실시간 시도 — 클라이언트가 토큰/키를 헤더로 넘긴 경우만
  // TR FHKST01010900 (외국인기관 추정주문수량) — 종목별 실시간 외국인/기관 추정 매매수량
  let realtime = null;
  const auth = req.headers.authorization;
  const appkey = req.headers.appkey;
  const appsecret = req.headers.appsecret;
  if (auth && appkey && appsecret) {
    try {
      const url = `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/investor-trend-estimate?MKSC_SHRN_ISCD=${symbol}`;
      const kr = await fetch(url, {
        method: 'GET',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'authorization': auth,
          'appkey': appkey,
          'appsecret': appsecret,
          'tr_id': 'HHPTJ04160200',
          'custtype': 'P'
        }
      });
      const kj = await kr.json();
      // 응답 구조 다양 — output1 또는 output2 array
      const rows = Array.isArray(kj?.output2) ? kj.output2 : (Array.isArray(kj?.output) ? kj.output : null);
      const r0 = rows ? rows[0] : null;
      if (r0) {
        // 실시간 추정 합계 — 시간대별이 아니라 누적이라면 직접 사용
        // 필드 후보들: frgn_ntby_qty, orgn_ntby_qty, prsn_ntby_qty, sum_*
        realtime = {
          date: r0.bsop_hour || r0.stck_bsop_date || null,
          foreign: num(r0.frgn_ntby_qty || r0.frgn_seln_vol || r0.frgn_qty),
          organ: num(r0.orgn_ntby_qty || r0.orgn_qty),
          individual: num(r0.prsn_ntby_qty || r0.prsn_qty),
          source: 'kis',
          rawSample: rows.slice(0, 2)  // 디버그용
        };
      } else if (kj) {
        // 응답은 있는데 형식이 예상과 다를 경우 디버그 페이로드 전달
        realtime = { source: 'kis', error: kj?.msg1 || 'unexpected format', raw: kj };
      }
    } catch (e) {
      realtime = { source: 'kis', error: e.message };
    }
  }

  return res.json({ symbol, data, ...(realtime ? { realtime } : {}) });
}
