import valuations from './_handlers/valuations.js';
import reverse from './_handlers/reverse.js';
import portfolio from './_handlers/portfolio.js';
import chartstate from './_handlers/chartstate.js';

// Saved work: forward DCF valuations, reverse DCFs, portfolio imports and chart drawings/settings.
// vercel.json rewrites the old URLs (e.g. /api/valuations) to /api/saved?resource=<name>, so the browser code is unchanged.
// Grouping keeps the app well under Vercel Hobby's 12-functions-per-deployment limit (every non-underscore file in api/ is one).
const HANDLERS = { valuations, reverse, portfolio, chartstate };

export default async function handler(req, res) {
  const resource = String(req.query?.resource || '');
  const fn = Object.prototype.hasOwnProperty.call(HANDLERS, resource) ? HANDLERS[resource] : null;
  if (!fn) return res.status(404).json({ error: 'Not found' });
  if (req.query) delete req.query.resource;
  return fn(req, res);
}
