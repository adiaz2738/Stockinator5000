import sql from './_db.js';
import { resolveInput, fetchCompanyFacts, buildMetrics } from './sec.js';

const USER_ID = 'local';
const CACHE_MS = 7 * 24 * 3600 * 1000;
const REFRESH_COOLDOWN_MS = 60 * 1000;

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS company_financials (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      cik TEXT NOT NULL,
      ticker TEXT,
      company_name TEXT,
      taxonomy TEXT,
      metrics JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, cik)
    )
  `;
}

function toResponse(row, cached) {
  return {
    cik: row.cik,
    ticker: row.ticker,
    companyName: row.company_name,
    taxonomy: row.taxonomy,
    fetchedAt: new Date(row.fetched_at).toISOString(),
    cached,
    metrics: row.metrics,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = typeof req.query?.q === 'string' ? req.query.q : '';
  const forceRefresh = req.query?.refresh === '1';

  try {
    const target = await resolveInput(q);
    if (target.error === 'invalid') {
      return res.status(400).json({ error: 'Enter a valid ticker or EDGAR URL' });
    }
    if (target.error === 'not_found') {
      return res.status(404).json({ error: 'Company not found' });
    }

    await ensureTable();

    const existing = await sql`
      SELECT * FROM company_financials
      WHERE user_id = ${USER_ID} AND cik = ${target.cik}
    `;
    const row = existing[0];
    if (row) {
      const age = Date.now() - new Date(row.fetched_at).getTime();
      const fresh = age < CACHE_MS;
      const coolingDown = forceRefresh && age < REFRESH_COOLDOWN_MS;
      if ((fresh && !forceRefresh) || coolingDown) {
        return res.status(200).json(toResponse(row, true));
      }
    }

    const facts = await fetchCompanyFacts(target.cik);
    const metrics = facts ? buildMetrics(facts) : null;
    if (!metrics) {
      return res.status(404).json({ error: 'No XBRL financial data available for this company' });
    }

    const companyName = (typeof facts.entityName === 'string' && facts.entityName) || target.title || null;
    const saved = await sql`
      INSERT INTO company_financials (user_id, cik, ticker, company_name, taxonomy, metrics, fetched_at)
      VALUES (${USER_ID}, ${target.cik}, ${target.ticker}, ${companyName}, ${metrics.taxonomy}, ${JSON.stringify(metrics)}::jsonb, NOW())
      ON CONFLICT (user_id, cik) DO UPDATE SET
        ticker = EXCLUDED.ticker,
        company_name = EXCLUDED.company_name,
        taxonomy = EXCLUDED.taxonomy,
        metrics = EXCLUDED.metrics,
        fetched_at = NOW()
      RETURNING *
    `;
    return res.status(200).json(toResponse(saved[0], false));
  } catch (err) {
    console.error('filings api error:', err);
    return res.status(502).json({ error: 'Could not load filings data' });
  }
}
