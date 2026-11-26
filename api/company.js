import filings from './_handlers/filings.js';
import statements from './_handlers/statements.js';
import narrative from './_handlers/narrative.js';
import news from './_handlers/news.js';
import sections from './_handlers/sections.js';
import screener from './_handlers/screener.js';
import events from './_handlers/events.js';

// Company research: SEC filings metrics, as-filed statements, AI story and news context.
// vercel.json rewrites the old URLs (e.g. /api/filings) to /api/company?resource=<name>, so the browser code is unchanged.
// Grouping keeps the app well under Vercel Hobby's 12-functions-per-deployment limit (every non-underscore file in api/ is one).
const HANDLERS = { filings, statements, narrative, news, sections, screener, events };

export default async function handler(req, res) {
  const resource = String(req.query?.resource || '');
  const fn = Object.prototype.hasOwnProperty.call(HANDLERS, resource) ? HANDLERS[resource] : null;
  if (!fn) return res.status(404).json({ error: 'Not found' });
  if (req.query) delete req.query.resource;
  return fn(req, res);
}
