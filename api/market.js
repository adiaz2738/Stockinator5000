import prices from './_handlers/prices.js';
import ticker from './_handlers/ticker.js';
import watchlist from './_handlers/watchlist.js';

// Market data: daily/intraday prices, ticker name lookup, watchlist.
// vercel.json rewrites the old URLs (e.g. /api/prices) to /api/market?resource=<name>, so the browser code is unchanged.
// Grouping keeps the app well under Vercel Hobby's 12-functions-per-deployment limit (every non-underscore file in api/ is one).
const HANDLERS = { prices, ticker, watchlist };

export default async function handler(req, res) {
  const resource = String(req.query?.resource || '');
  const fn = Object.prototype.hasOwnProperty.call(HANDLERS, resource) ? HANDLERS[resource] : null;
  if (!fn) return res.status(404).json({ error: 'Not found' });
  if (req.query) delete req.query.resource;
  return fn(req, res);
}
