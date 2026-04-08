export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.json({ name: null });

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&lang=en-US&region=US&quotesCount=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const d = await r.json();
    const q = d?.quotes?.[0];
    const name = q?.longname || q?.shortname || null;
    console.log(`[stock-name] ${symbol}: ${name || 'not found'}`);
    return res.json({ name });
  } catch(e) {
    console.log(`[stock-name] ${symbol} error: ${e.message}`);
    return res.json({ name: null });
  }
}
