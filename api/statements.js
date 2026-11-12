import { requireAuth } from './_auth.js';
import { findLatestAnnualFiling } from './_sec.js';
import { loadStatements } from './_statements.js';

const CIK_RE = /^\d{1,10}$/;

function filingInfo(f) {
  return {
    form: f.form,
    filingDate: f.filingDate,
    reportDate: f.reportDate,
    accession: f.accession,
    viewerUrl: f.viewerUrl,
    indexUrl: f.indexUrl,
  };
}

// GET /api/statements?cik=0000063908 -> the latest annual filing's balance sheet, income statement and
// cash flow statement as filed (cached in Neon per accession number).
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cikParam = typeof req.query?.cik === 'string' ? req.query.cik.trim() : '';
  if (!CIK_RE.test(cikParam)) return res.status(400).json({ error: 'Invalid company' });
  const cik = cikParam.padStart(10, '0');

  try {
    const filing = await findLatestAnnualFiling(cik);
    if (!filing) return res.status(404).json({ error: 'No annual filing (10-K, 40-F, 20-F) found for this company' });
    const { statements, cached } = await loadStatements(cik, filing);
    return res.status(200).json({ cik, filing: filingInfo(filing), statements, cached });
  } catch (err) {
    console.error('statements api error:', err);
    return res.status(502).json({ error: 'Could not load the as-filed statements' });
  }
}
