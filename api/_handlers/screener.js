import sql from '../_db.js';
import { requireAuth } from '../_auth.js';
import { secFetch, loadTickerMap } from '../_sec.js';

// Full-market screener data from SEC's XBRL "frames" API: one request returns one line item for every filer for one
// calendar year (CY2025 = annual facts; CY2025Q4I = balance-sheet values at year end). Refreshing runs one metric per
// call (the page drives it with a progress bar), merging tag fallbacks into a 5-year series per company, stored in Neon.
// "build" then turns the stored series into a compact per-company dataset of ratios that the page screens instantly.
//
//   GET  /api/screener?action=status          last refresh per metric, dataset build time
//   POST /api/screener?action=refresh&metric=revenue
//   POST /api/screener?action=build
//   GET  /api/screener?action=data            the compact dataset
// SEC data is public; it is stored once for the app (not per user). Real reported values only, nothing estimated.

const YEARS_BACK = 5;
const FRAMES = 'https://data.sec.gov/api/xbrl/frames/us-gaap';
// metric -> { kind: 'dur' (annual) | 'inst' (year-end), unit, tags in priority order }
export const METRICS = {
  revenue: { kind: 'dur', unit: 'USD', tags: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'] },
  costOfRevenue: { kind: 'dur', unit: 'USD', tags: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'] },
  grossProfit: { kind: 'dur', unit: 'USD', tags: ['GrossProfit'] },
  sga: { kind: 'dur', unit: 'USD', tags: ['SellingGeneralAndAdministrativeExpense'] },
  operatingIncome: { kind: 'dur', unit: 'USD', tags: ['OperatingIncomeLoss'] },
  interest: { kind: 'dur', unit: 'USD', tags: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt', 'InterestAndDebtExpense'] },
  netIncome: { kind: 'dur', unit: 'USD', tags: ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'] },
  eps: { kind: 'dur', unit: 'USD-per-shares', tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'] },
  liabilities: { kind: 'inst', unit: 'USD', tags: ['Liabilities'] },
  equity: { kind: 'inst', unit: 'USD', tags: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  ltDebt: { kind: 'inst', unit: 'USD', tags: ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations'] },
  currentAssets: { kind: 'inst', unit: 'USD', tags: ['AssetsCurrent'] },
  currentLiabilities: { kind: 'inst', unit: 'USD', tags: ['LiabilitiesCurrent'] },
  retainedEarnings: { kind: 'inst', unit: 'USD', tags: ['RetainedEarningsAccumulatedDeficit'] },
};
export const METRIC_KEYS = Object.keys(METRICS);

// The latest complete calendar year: annual reports for year Y are filed by about March of Y+1
export function screenerYears(now = new Date()) {
  const latest = now.getUTCMonth() >= 4 ? now.getUTCFullYear() - 1 : now.getUTCFullYear() - 2;
  return Array.from({ length: YEARS_BACK }, (_, i) => latest - YEARS_BACK + 1 + i);
}

let tablesReady = null;
// The page asks for status and data at the same time. Two first-ever CREATE TABLE IF NOT EXISTS calls can collide in
// Postgres, so the check runs once per instance and is retried once if the parallel request won the race.
function ensureTables() {
  if (!tablesReady) {
    tablesReady = createTables()
      .catch(() => new Promise((r) => setTimeout(r, 300)).then(createTables))
      .catch((err) => { tablesReady = null; throw err; });
  }
  return tablesReady;
}

async function createTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS screener_metrics (
      metric     TEXT PRIMARY KEY,
      years      JSONB NOT NULL,
      data       JSONB NOT NULL,       -- { cik: [v per year] }
      companies  INTEGER NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS screener_dataset (
      id       INTEGER PRIMARY KEY,
      payload  JSONB NOT NULL,
      built_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function fetchFrame(tag, unit, period) {
  const res = await secFetch(`${FRAMES}/${tag}/${unit}/${period}.json`);
  if (res.status === 404) return null; // nobody reported this tag for this period
  if (!res.ok) throw new Error(`SEC frames ${tag} ${period}: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : null;
}

// One metric: for each year, the first tag (in priority order) a company reported wins
async function refreshMetric(metric) {
  const spec = METRICS[metric];
  const years = screenerYears();
  const series = new Map(); // cik -> array
  for (let yi = 0; yi < years.length; yi++) {
    const period = spec.kind === 'inst' ? `CY${years[yi]}Q4I` : `CY${years[yi]}`;
    for (const tag of spec.tags) {
      const rows = await fetchFrame(tag, spec.unit, period);
      if (!rows) continue;
      for (const r of rows) {
        const val = Number(r.val);
        if (!Number.isFinite(val)) continue;
        const cik = String(r.cik).padStart(10, '0');
        let arr = series.get(cik);
        if (!arr) { arr = Array(years.length).fill(null); series.set(cik, arr); }
        if (arr[yi] === null) arr[yi] = val;
      }
    }
  }
  const data = Object.fromEntries(series);
  await sql`
    INSERT INTO screener_metrics (metric, years, data, companies, fetched_at)
    VALUES (${metric}, ${JSON.stringify(years)}::jsonb, ${JSON.stringify(data)}::jsonb, ${series.size}, NOW())
    ON CONFLICT (metric) DO UPDATE SET years = EXCLUDED.years, data = EXCLUDED.data, companies = EXCLUDED.companies, fetched_at = NOW()
  `;
  return { metric, companies: series.size, years };
}

// ---------- Build: per-company ratios per year ----------

const r4 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const div = (a, b) => (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0 ? null : a / b);

// Ratios per year, matching the Filings scorecard definitions. null = not computable from reported data.
export function companyRatios(m, n) {
  const at = (k, i) => (m[k] ? m[k][i] ?? null : null);
  const out = { gm: [], nm: [], sga: [], int: [], de: [], ltd: [], eps: [], roe: [], cr: [], reUp: [], rev: [] };
  for (let i = 0; i < n; i++) {
    const rev = at('revenue', i);
    const gp = at('grossProfit', i) ?? (rev !== null && at('costOfRevenue', i) !== null ? rev - at('costOfRevenue', i) : null);
    const ni = at('netIncome', i);
    const opInc = at('operatingIncome', i);
    const interest = at('interest', i);
    const equity = at('equity', i);
    const liab = at('liabilities', i);
    // No long-term debt tag while the balance sheet is reported = no long-term debt ("None reported", as in Filings)
    const ltDebt = at('ltDebt', i) ?? (liab !== null ? 0 : null);
    out.rev.push(rev);
    out.gm.push(r4(rev > 0 ? div(gp, rev) : null));
    out.nm.push(r4(rev > 0 ? div(ni, rev) : null));
    out.sga.push(r4(gp > 0 ? div(at('sga', i), gp) : null));
    // Interest vs operating income: an operating loss with interest expense fails the rule (shown as a large ratio)
    out.int.push(r4(interest === null || opInc === null ? null : opInc > 0 ? interest / opInc : interest > 0 ? 99 : 0));
    out.de.push(r4(equity === null || liab === null ? null : equity > 0 ? liab / equity : 99));
    out.ltd.push(r4(ltDebt === null ? null : ltDebt === 0 ? 0 : ni !== null && ni > 0 ? ltDebt / ni : 99));
    out.eps.push(r4(at('eps', i)));
    out.roe.push(r4(equity !== null && equity > 0 ? div(ni, equity) : null));
    out.cr.push(r4(div(at('currentAssets', i), at('currentLiabilities', i))));
    const re = at('retainedEarnings', i);
    const rePrev = i > 0 ? at('retainedEarnings', i - 1) : null;
    out.reUp.push(re === null || rePrev === null ? null : re >= rePrev ? 1 : 0);
  }
  return out;
}

async function build() {
  const rows = [];
  for (const metric of METRIC_KEYS) {
    const r = await sql`SELECT years, data FROM screener_metrics WHERE metric = ${metric}`;
    if (r[0]) rows.push({ metric, years: r[0].years, data: r[0].data });
  }
  if (!rows.some((r) => r.metric === 'revenue')) throw new Error('Refresh the data first');
  const years = rows.find((r) => r.metric === 'revenue').years;
  const n = years.length;
  const { byCik } = await loadTickerMap();
  const fields = ['gm', 'nm', 'sga', 'int', 'de', 'ltd', 'eps', 'roe', 'cr', 'reUp', 'rev'];
  const companies = [];
  for (const [cik, info] of byCik) {
    const m = {};
    for (const r of rows) {
      const arr = r.data[cik];
      // a metric refreshed with a different year window is aligned by year
      if (arr) m[r.metric] = years.map((y) => { const j = r.years.indexOf(y); return j >= 0 ? arr[j] ?? null : null; });
    }
    if (!m.revenue && !m.netIncome) continue; // no income statement data in the frames (funds, shells, IFRS filers)
    const ratios = companyRatios(m, n);
    companies.push([info.ticker, info.title, cik, ...fields.map((f) => ratios[f])]);
  }
  const payload = { years, fields, companies, builtAt: new Date().toISOString() };
  await sql`
    INSERT INTO screener_dataset (id, payload, built_at) VALUES (1, ${JSON.stringify(payload)}::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, built_at = NOW()
  `;
  return { companies: companies.length, years };
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query?.action || '');
  try {
    await ensureTables();
    if (action === 'status' && req.method === 'GET') {
      const rows = await sql`SELECT metric, companies, fetched_at, years FROM screener_metrics`;
      const ds = await sql`SELECT built_at, jsonb_array_length(payload->'companies') AS n, payload->'years' AS years FROM screener_dataset WHERE id = 1`;
      return res.status(200).json({
        metrics: METRIC_KEYS,
        refreshed: Object.fromEntries(rows.map((r) => [r.metric, { companies: r.companies, at: r.fetched_at, years: r.years }])),
        dataset: ds[0] ? { builtAt: ds[0].built_at, companies: ds[0].n, years: ds[0].years } : null,
        years: screenerYears(),
      });
    }
    if (action === 'refresh' && req.method === 'POST') {
      const metric = String(req.query?.metric || '');
      if (!METRICS[metric]) return res.status(400).json({ error: 'Unknown metric' });
      return res.status(200).json(await refreshMetric(metric));
    }
    if (action === 'build' && req.method === 'POST') {
      return res.status(200).json(await build());
    }
    if (action === 'data' && req.method === 'GET') {
      const ds = await sql`SELECT payload FROM screener_dataset WHERE id = 1`;
      if (!ds[0]) return res.status(404).json({ error: 'no_data' });
      return res.status(200).json(ds[0].payload);
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('screener failed:', err);
    return res.status(502).json({ error: err.message === 'Refresh the data first' ? err.message : 'Screener request failed' });
  }
}
