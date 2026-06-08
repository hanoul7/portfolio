// 키움/증권사 체결 알림 스크린샷 → 거래 내역 자동 추출 (Claude 비전 + tool use)
// 요청(POST): { image: "<base64>", mediaType: "image/png" }
// 응답: { broker, account_type: "KR"|"US"|"UNKNOWN", date: "YYYY-MM-DD", trades: [{name, ticker?, action, qty, price}] }
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 미설정' });

  // body 파싱 (문자열로 올 수도 있음)
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  let data = (body && body.image) || '';
  const mediaType = (body && body.mediaType) || 'image/png';
  if (!data) return res.status(400).json({ error: 'image required' });
  // data URL 접두사 제거
  data = String(data).replace(/^data:[^;]+;base64,/, '');

  const tool = {
    name: 'record_trades',
    description: '증권사 체결 알림 스크린샷에서 읽어낸 거래 내역을 기록한다.',
    input_schema: {
      type: 'object',
      properties: {
        broker: { type: 'string', description: '증권사 이름 (예: 키움증권). 모르면 빈 문자열.' },
        account_type: {
          type: 'string',
          enum: ['KR', 'US', 'UNKNOWN'],
          description: '국내주식 계좌면 KR, 미국주식 계좌면 US. 한글 종목명·원 단위면 KR.'
        },
        date: { type: 'string', description: '거래 날짜 YYYY-MM-DD. 카톡 상단 날짜 구분선(예: "2026년 6월 8일")을 기준으로 한다.' },
        trades: {
          type: 'array',
          description: '체결 통보 1건당 거래 1개.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '종목명 (예: 삼성전자, KODEX 200, 쓰리빌리언)' },
              ticker: { type: 'string', description: '아는 경우에만: 국내는 6자리 종목코드(예: 005930), 미국은 티커(예: AAPL). 모르면 생략.' },
              action: { type: 'string', enum: ['buy', 'sell'], description: '매수=buy, 매도=sell' },
              qty: { type: 'number', description: '체결 수량 (주)' },
              price: { type: 'number', description: '평균단가, 숫자만 (콤마·원 제거)' }
            },
            required: ['name', 'action', 'qty', 'price']
          }
        }
      },
      required: ['account_type', 'date', 'trades']
    }
  };

  const payload = {
    model: 'claude-opus-4-8',
    max_tokens: 2000,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'record_trades' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: '이 스크린샷은 증권사 체결 알림(카카오 알림톡 등)입니다. 증권사, 국내/해외 계좌 구분, 거래 날짜를 파악하고 각 체결 통보의 종목명·매수매도·수량·평균단가를 record_trades 도구로 기록하세요. 한글 종목명과 원 단위 단가면 국내(KR) 계좌입니다.' }
      ]
    }]
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (!r.ok) {
      console.log('[parse-trades] anthropic error', r.status, JSON.stringify(d).slice(0, 300));
      return res.status(502).json({ error: 'anthropic api error', detail: d?.error?.message || r.status });
    }
    const block = Array.isArray(d.content) ? d.content.find(b => b.type === 'tool_use') : null;
    if (!block) return res.status(502).json({ error: '추출 실패 (tool_use 없음)' });
    return res.json(block.input);
  } catch (e) {
    console.log('[parse-trades] fail', e.message);
    return res.status(500).json({ error: 'parse failed', detail: e.message });
  }
}
