import { fmpFetch } from './fmp.js';

const TICKER_RE = /^[A-Za-z.-]{1,10}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const symbol = typeof req.query?.symbol === 'string' ? req.query.symbol.trim().toUpperCase() : '';

  if (!TICKER_RE.test(symbol)) {
    return res.status(400).json({ error: 'Invalid ticker symbol' });
  }

  try {
    const data = await fmpFetch(`/profile?symbol=${encodeURIComponent(symbol)}`);
    const companyName = Array.isArray(data) && data[0]?.companyName ? data[0].companyName : null;
    return res.status(200).json({ ticker: symbol, companyName });
  } catch (err) {
    console.error('ticker api error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
