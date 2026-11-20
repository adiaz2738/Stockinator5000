import sql from '../_db.js';
import { requireAuth } from '../_auth.js';
import { loadStatements, capexFromStatement, workingCapitalFromStatement, incomeFromStatement, gainEvidenceFromStatements, factsFromStatements, interimFromStatements, expenseLinesFromStatement } from '../_statements.js';
import { resolveInput, fetchCompanyFacts, buildMetrics, findLatestAnnualFiling, findLatestProspectus, DATA_VERSION } from '../_sec.js';

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

const RECENT_YEARS = 3;

// True when any of the latest years has no single-tag capex, no cost of revenue (and no gross profit) or no SG&A tag,
// or operating cash flow moved by more than 50%.
function needsStatement(m) {
  const n = m.years.length;
  for (let i = Math.max(0, n - RECENT_YEARS); i < n; i++) {
    if (m.capexMethod[i] !== 'tag') return true;
    if (m.raw.costOfRevenue[i] === null && m.raw.grossProfit[i] === null) return true;
    if (m.raw.sga[i] === null) return true;
    if (m.raw.operatingIncome[i] === null) return true;
    // A tag-based gain/loss on asset sales must be confirmed against the as-filed statements
    if (m.raw.gainOnAssetSales[i] !== null && m.incomeMethod?.gainOnAssetSales?.[i] !== 'statement') return true;
    const ocf = m.raw.operatingCashFlow[i];
    const prev = i > 0 ? m.raw.operatingCashFlow[i - 1] : null;
    if (ocf !== null && prev !== null && prev !== 0 && Math.abs(ocf - prev) / Math.abs(prev) > 0.5) return true;
  }
  return false;
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
  if (!requireAuth(req, res)) return;
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
      // Rows built by older extraction logic (no or old dataVersion) are refetched whatever their age
      const fresh = age < CACHE_MS && row.metrics?.dataVersion === DATA_VERSION;
      const coolingDown = forceRefresh && age < REFRESH_COOLDOWN_MS;
      if ((fresh && !forceRefresh) || coolingDown) {
        return res.status(200).json(toResponse(row, true));
      }
    }

    let facts = await fetchCompanyFacts(target.cik);
    let metrics = facts ? buildMetrics(facts) : null;
    let prospectus = null;

    // Latest annual filing, for the header links and the as-filed fallbacks. A failure here never blocks the metrics.
    let filing = null;
    try {
      filing = await findLatestAnnualFiling(target.cik);
    } catch (err) {
      console.error('latest filing lookup failed:', err);
    }

    // No annual XBRL data (a new IPO: registration statements carry no XBRL, and no 10-K is filed yet): read the
    // numbers from the IPO prospectus's own statements. A 10-K, once filed, takes over automatically.
    if (!metrics || !filing) {
      try {
        const pf = !metrics ? await findLatestProspectus(target.cik) : null;
        if (pf) {
          const { statements } = await loadStatements(target.cik, pf);
          if (statements.income || statements.balance || statements.cashflow) {
            facts = factsFromStatements(statements, { filed: pf.filingDate, entityName: facts?.entityName || target.title });
            metrics = buildMetrics(facts, {
              statementCapex: statements.cashflow ? capexFromStatement(statements.cashflow) : undefined,
              statementIncome: statements.income ? incomeFromStatement(statements.income) : undefined,
            });
            if (metrics) {
              filing = pf;
              prospectus = { statements, filing: pf };
            }
          }
        }
      } catch (err) {
        console.error('prospectus fallback failed:', err);
      }
    }
    if (!metrics) {
      return res.status(404).json({ error: 'No financial data found for this company: no annual XBRL data and no readable IPO prospectus' });
    }

    if (prospectus) {
      const { statements } = prospectus;
      metrics.source = {
        kind: 'prospectus', form: filing.form, filingDate: filing.filingDate,
        note: `Numbers read from the ${filing.form} filed ${filing.filingDate} (IPO prospectus). There is no 10-K yet, so SEC has no structured data for this company; the first 10-K takes over automatically.`,
      };
      metrics.interim = interimFromStatements(statements);
      metrics.expenseLines = expenseLinesFromStatement(statements.income);
      const q = metrics.quality;
      q.cellNotes = q.cellNotes || {};
      const noteAll = (metric, text) => { q.cellNotes[metric] = q.cellNotes[metric] || {}; for (const y of metrics.years) if (!q.cellNotes[metric][y]) q.cellNotes[metric][y] = text; };
      if (metrics.expenseLines) {
        const t = 'No cost of revenue line: this company reports expenses by type (see Operating expenses as filed), so gross margin and the SG&A rule cannot be computed.';
        for (const k of ['costOfRevenue', 'grossProfit', 'grossMargin', 'sga', 'sgaPctGrossProfit']) noteAll(k, t);
      }
      // Before the IPO, preferred stock and convertible notes sit outside the common share count; they convert at the
      // IPO, so per-share figures from the prospectus overstate what each post-IPO share earns
      if (statements.balance?.rows.some((r) => /redeemable convertible preferred|convertible preferred stock|convertible (?:promissory )?notes? payable/i.test(r.label))) {
        const t = 'Pre-IPO share count: convertible preferred stock and convertible notes turn into common shares at the IPO, so per-share figures after the IPO will be lower than this.';
        for (const k of ['dilutedShares', 'epsDiluted', 'fcfPerShare']) noteAll(k, t);
      }
      if (statements.balance?.rows.some((r) => /convertible (?:promissory )?notes? payable|^convertible debt/i.test(r.label))) {
        noteAll('longTermDebt', 'Convertible notes are not counted as long-term debt: they convert to stock at the IPO. They are included in total liabilities as filed.');
        q.summary = [...(q.summary || []), 'convertible notes are excluded from long-term debt (they convert to stock at the IPO)'];
      }
    }

    // Capex missing or not from a single tag, or a big operating-cash-flow swing: read the as-filed cash flow
    // statement (cached per filing) and rebuild with what it shows.
    if (filing && !prospectus && needsStatement(metrics)) {
      try {
        const { statements } = await loadStatements(target.cik, filing);
        if (statements.cashflow || statements.income) {
          metrics = buildMetrics(facts, {
            statementCapex: statements.cashflow ? capexFromStatement(statements.cashflow) : undefined,
            statementWorkingCapital: statements.cashflow ? workingCapitalFromStatement(statements.cashflow) : undefined,
            statementIncome: statements.income ? incomeFromStatement(statements.income) : undefined,
            gainEvidence: gainEvidenceFromStatements(statements.income, statements.cashflow),
          });
        }
      } catch (err) {
        console.error('as-filed statement fallback failed:', err);
      }
    }
    metrics.latestFiling = filing && {
      form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate, accession: filing.accession,
      primaryDocument: filing.primaryDocument, viewerUrl: filing.viewerUrl, indexUrl: filing.indexUrl,
    };

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
