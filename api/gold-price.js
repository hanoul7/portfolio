export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 1차: Yahoo Finance XAU=X
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/XAU=X?interval=1m&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await r.json();
    const meta = d?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const prevClose = meta?.chartPreviousClose || meta?.previousClose;
    if (price) return res.json({ price, prevClose, source: 'yahoo' });
  } catch(e) {}

  // 2차: metals.live
  try {
    const r = await fetch('https://api.metals.live/v1/spot/gold');
    const d = await r.json();
    if (d?.[0]?.gold) return res.json({ price: d[0].gold, prevClose: null, source: 'metals' });
  } catch(e) {}

  return res.status(500).json({ error: 'gold price unavailable' });
}
