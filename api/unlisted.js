export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const listUrl = 'https://www.ustockplus.com/?schedule=toBeIPOList';
    const listRes = await fetch(listUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await listRes.text();

    // Next.js __NEXT_DATA__ JSON 추출
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return res.status(500).json({ error: 'parse failed' });

    const nextData = JSON.parse(match[1]);
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];

    // 모든 경로에서 종목 수집
    let stocks = [];
    for (const q of queries) {
      const data = q?.state?.data;
      if (!data) continue;

      // 직접 배열
      if (Array.isArray(data)) {
        stocks = stocks.concat(data);
      }

      // pages 구조 (무한스크롤)
      if (data?.pages) {
        for (const page of data.pages) {
          if (Array.isArray(page)) stocks = stocks.concat(page);
          else if (page?.content) stocks = stocks.concat(page.content);
        }
      }

      // featuredStockKeywords[].includedStocks[]
      if (Array.isArray(data.featuredStockKeywords)) {
        for (const kw of data.featuredStockKeywords) {
          if (Array.isArray(kw.includedStocks)) {
            stocks = stocks.concat(kw.includedStocks);
          }
        }
      }

      // featuredDiscussStocks
      if (Array.isArray(data.featuredDiscussStocks)) {
        stocks = stocks.concat(data.featuredDiscussStocks);
      }

      // metric (상단 순위)
      if (data.metric && typeof data.metric === 'object') {
        // metric 안의 배열들
        for (const key of Object.keys(data.metric)) {
          if (Array.isArray(data.metric[key])) {
            stocks = stocks.concat(data.metric[key]);
          }
        }
      }
    }

    // 종목명으로 검색 (부분 일치)
    const keyword = name.trim().toLowerCase();
    const found = stocks.find(s =>
      s.name && s.currentPrice > 0 && s.name.toLowerCase().includes(keyword)
    );

    if (found) {
      console.log('[unlisted] found:', found.name, found.currentPrice);
      return res.json({
        name: found.name,
        code: found.code,
        price: found.currentPrice,
        changeRate: found.currentChangeRate || 0,
        engCode: found.engCode || null
      });
    }

    console.log('[unlisted] not found:', name, '| total stocks scanned:', stocks.length);
    return res.json({ error: 'not found', name });

  } catch (e) {
    console.error('[unlisted]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
