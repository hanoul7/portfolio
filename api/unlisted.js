export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    // 1) 비상장 리스트에서 종목 검색
    const listUrl = 'https://www.ustockplus.com/?schedule=toBeIPOList';
    const listRes = await fetch(listUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await listRes.text();

    // Next.js __NEXT_DATA__ JSON 추출
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return res.status(500).json({ error: 'parse failed' });

    const nextData = JSON.parse(match[1]);
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];

    // 모든 쿼리에서 종목 리스트 찾기
    let stocks = [];
    for (const q of queries) {
      const data = q?.state?.data;
      if (Array.isArray(data)) {
        stocks = stocks.concat(data);
      } else if (data?.pages) {
        for (const page of data.pages) {
          if (Array.isArray(page)) stocks = stocks.concat(page);
          else if (page?.content) stocks = stocks.concat(page.content);
        }
      }
    }

    // 종목명으로 검색 (부분 일치)
    const keyword = name.trim().toLowerCase();
    const found = stocks.find(s =>
      s.name && s.name.toLowerCase().includes(keyword)
    );

    if (found && found.currentPrice > 0) {
      return res.json({
        name: found.name,
        code: found.code,
        price: found.currentPrice,
        changeRate: found.currentChangeRate || 0,
        engCode: found.engCode || null
      });
    }

    // 2) 리스트에 없으면 개별 페이지 시도 (engCode 패턴)
    return res.json({ error: 'not found', name });

  } catch (e) {
    console.error('[unlisted]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
