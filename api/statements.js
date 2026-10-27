import sql from './_db.js';
import { requireAuth } from './_auth.js';
import { findLatestAnnualFiling } from './_sec.js';
import { fetchAsFiledStatements, PARSER_VERSION } from './_statements.js';

const USER_ID = 'local';
const CIK_RE = /^\d{1,10}$/;

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS company_statements (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      cik TEXT NOT NULL,
      accession TEXT NOT NULL,
      statements JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, cik, accession)
    )
  `;
}

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
// cash flow statement as filed. A filing never changes once accepted, so a cached row is reused as long as
// the parser version matches.
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

    await ensureTable();
    const existing = await sql`
      SELECT statements FROM company_statements
      WHERE user_id = ${USER_ID} AND cik = ${cik} AND accession = ${filing.accession}
    `;
    if (existing[0]?.statements?.parserVersion === PARSER_VERSION) {
      return res.status(200).json({ cik, filing: filingInfo(filing), statements: existing[0].statements.statements, cached: true });
    }

    const result = await fetchAsFiledStatements(filing);
    // Nothing found is not cached, so a later parser fix or a transient SEC error isn't remembered
    if (Object.values(result.statements).some(Boolean)) {
      await sql`
        INSERT INTO company_statements (user_id, cik, accession, statements, fetched_at)
        VALUES (${USER_ID}, ${cik}, ${filing.accession}, ${JSON.stringify(result)}::jsonb, NOW())
        ON CONFLICT (user_id, cik, accession) DO UPDATE SET
          statements = EXCLUDED.statements,
          fetched_at = NOW()
      `;
    }
    return res.status(200).json({ cik, filing: filingInfo(filing), statements: result.statements, cached: false });
  } catch (err) {
    console.error('statements api error:', err);
    return res.status(502).json({ error: 'Could not load the as-filed statements' });
  }
}
