import { requireAuth } from '../_auth.js';
import { resolveInput, listFilingEvents } from '../_sec.js';

// GET /api/events?ticker=AAPL — earnings releases (8-K Item 2.02), 10-K and 10-Q filing dates with links, for the
// chart's markers. Straight from SEC's submissions API (one request); the browser may reuse the answer for an hour.
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const q = typeof req.query?.ticker === 'string' ? req.query.ticker : '';
  try {
    const r = await resolveInput(q);
    if (!r || r.error || !r.cik) return res.status(404).json({ error: 'Not an SEC filer', events: [] });
    const events = await listFilingEvents(r.cik);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).json({ ticker: r.ticker, events });
  } catch (err) {
    console.error('events failed:', err.message);
    return res.status(502).json({ error: 'Could not read SEC filings', events: [] });
  }
}
