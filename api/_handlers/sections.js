import { requireAuth } from '../_auth.js';
import { resolveInput, extractFilingSections } from '../_sec.js';

// GET /api/sections?ticker=ACFN  — free check (no AI): which filing sections the Story would get from the latest
// annual report, how long each is, and the "Item" headings the parser recognized. Used to debug "Not disclosed" stories.
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const q = typeof req.query?.ticker === 'string' ? req.query.ticker : '';
  try {
    const r = await resolveInput(q);
    if (!r || r.error || !r.cik) return res.status(400).json({ error: 'Unknown ticker' });
    const out = await extractFilingSections(r.cik, { diagnose: true });
    if (!out) return res.status(404).json({ error: 'No annual filing found' });
    const sections = Object.fromEntries(Object.entries(out.sections).map(([k, s]) => [k, { status: s.status, chars: s.chars, source: s.source, startsWith: s.text.slice(0, 160) }]));
    return res.status(200).json({ ticker: r.ticker, cik: r.cik, form: out.filing.form, filed: out.filing.filingDate, url: out.filing.primaryUrl, sections, diagnostics: out.diagnostics || null });
  } catch (err) {
    console.error('sections check failed:', err);
    return res.status(502).json({ error: 'Could not read the filing' });
  }
}
