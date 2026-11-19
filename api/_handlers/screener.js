import sql from '../_db.js';
import { requireAuth } from '../_auth.js';
import { secFetch, loadTickerMap } from '../_sec.js';
import { fetchQuotes } from './watchlist.js';

const USER_ID = 'local';
const SUBMISSIONS = 'https://data.sec.gov/submissions/CIK';
const INDUSTRY_BATCH = 40;   // companies looked up per call (SEC allows about 5 requests a second)
const QUOTE_BATCH = 500;
const MAX_SCREENS = 50;
const TICKER_RE = /^[A-Z][A-Z0-9.\-\/]{0,9}$/;

// Full-market screener data from SEC's XBRL "frames" API: one request returns one line item for every filer for one
// calendar year (CY2025 = annual facts; CY2025Q4I = balance-sheet values at year end). Refreshing runs one metric per
// call (the page drives it with a progress bar), merging tag fallbacks into a 5-year series per company, stored in Neon.
// "build" then turns the stored series into a compact per-company dataset of ratios that the page screens instantly.
//
//   GET  /api/screener?action=status          last refresh per metric, dataset build time
//   POST /api/screener?action=refresh&metric=revenue
//   POST /api/screener?action=build
//   GET  /api/screener?action=data            the compact dataset, plus the industries looked up so far
//   POST /api/screener?action=industry        { ciks: [...] } -> SIC industry per company (SEC submissions, cached)
//   POST /api/screener?action=quotes          { tickers: [...] } -> Schwab prices + latest saved buy-below price
//   GET  /api/screener?action=screens         saved screens; POST { name, settings } saves; DELETE ?name= removes
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
  shares: { kind: 'dur', unit: 'shares', tags: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'] },
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
  await sql`
    CREATE TABLE IF NOT EXISTS screener_industry (
      cik        TEXT PRIMARY KEY,
      sic        INTEGER,
      sic_desc   TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS screener_screens (
      user_id    TEXT NOT NULL DEFAULT 'local',
      name       TEXT NOT NULL,
      settings   JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, name)
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

// Runs fn over items with at most `limit` in flight. secFetch still spaces request starts to SEC's rate limit;
// this lets the downloads overlap instead of waiting for each file to finish before starting the next.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// One metric: for each year, the first tag (in priority order) a company reported wins
async function refreshMetric(metric) {
  const spec = METRICS[metric];
  const years = screenerYears();
  const series = new Map(); // cik -> array
  const jobs = [];
  for (let yi = 0; yi < years.length; yi++) {
    const period = spec.kind === 'inst' ? `CY${years[yi]}Q4I` : `CY${years[yi]}`;
    for (const tag of spec.tags) jobs.push({ yi, tag, period });
  }
  const frames = await pool(jobs, 4, (j) => fetchFrame(j.tag, spec.unit, j.period));
  // merged in the original order (year, then tag priority), so the first tag reported still wins
  for (let ji = 0; ji < jobs.length; ji++) {
    const { yi } = jobs[ji];
    {
      const rows = frames[ji];
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
  const out = { gm: [], nm: [], sga: [], int: [], de: [], ltd: [], eps: [], roe: [], cr: [], reUp: [], rev: [], sh: [], eq: [] };
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
    out.sh.push(at('shares', i));
    out.eq.push(equity);
  }
  return out;
}

// Each build step is timed and logged to the vercel dev terminal, so a slow or stuck step can be found
async function build() {
  const t0 = Date.now();
  const step = (name) => console.log(`screener build: ${name} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  step('start');
  const rows = [];
  for (const metric of METRIC_KEYS) {
    const r = await sql`SELECT years, data FROM screener_metrics WHERE metric = ${metric}`;
    if (r[0]) rows.push({ metric, years: r[0].years, data: r[0].data });
  }
  step(`read ${rows.length} metrics`);
  if (!rows.some((r) => r.metric === 'revenue')) throw new Error('Refresh the data first');
  const years = rows.find((r) => r.metric === 'revenue').years;
  const n = years.length;
  const { byCik } = await loadTickerMap();
  step('ticker list loaded');
  const fields = ['gm', 'nm', 'sga', 'int', 'de', 'ltd', 'eps', 'roe', 'cr', 'reUp', 'rev', 'sh', 'eq'];
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
    // share count and equity are only used as their latest value (market cap, P/B), so one number each
    const lastOf = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i]; return null; };
    ratios.sh = lastOf(ratios.sh);
    ratios.eq = lastOf(ratios.eq);
    // Share-count check: net income ÷ EPS must roughly equal the share count. Some filers tag shares in thousands
    // (or report EPS per ADS), which made market cap 1000× too small; then the implied count is used instead.
    for (let i = n - 1; i >= 0; i--) {
      const ni = m.netIncome?.[i];
      const eps = m.eps?.[i];
      if (!Number.isFinite(ni) || !Number.isFinite(eps) || eps === 0 || ni === 0 || Math.sign(ni) !== Math.sign(eps)) continue;
      const implied = ni / eps;
      if (!(ratios.sh > 0) || ratios.sh / implied > 5 || ratios.sh / implied < 0.2) ratios.sh = Math.round(implied);
      break;
    }
    // A gross margin above 100% is impossible: a currency or tag mismatch, so it's left out rather than shown
    ratios.gm = ratios.gm.map((v) => (v !== null && v > 1 ? null : v));
    companies.push([info.ticker, info.title, cik, ...fields.map((f) => ratios[f])]);
  }
  const payload = { years, fields, companies, builtAt: new Date().toISOString() };
  const body = JSON.stringify(payload);
  step(`${companies.length} companies computed, ${(body.length / 1e6).toFixed(1)} MB`);
  await sql`
    INSERT INTO screener_dataset (id, payload, built_at) VALUES (1, ${body}::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, built_at = NOW()
  `;
  step('saved');
  return { companies: companies.length, years };
}

// ---------- Industry (SIC code from SEC's company record), looked up on demand and kept ----------

async function lookupIndustries(ciks, max = INDUSTRY_BATCH) {
  const want = [...new Set(ciks.map((c) => String(c).replace(/\D/g, '').padStart(10, '0')).filter((c) => c.length === 10))].slice(0, max);
  if (!want.length) return {};
  const have = await sql`SELECT cik, sic, sic_desc FROM screener_industry WHERE cik = ANY(${want})`;
  const out = Object.fromEntries(have.map((r) => [r.cik, [r.sic, r.sic_desc]]));
  await pool(want.filter((cik) => !out[cik]), 4, async (cik) => {
    let sic = null;
    let desc = null;
    try {
      const res = await secFetch(`${SUBMISSIONS}${cik}.json`);
      if (res.ok) {
        const j = await res.json();
        sic = Number.parseInt(j?.sic, 10);
        if (!Number.isFinite(sic)) sic = null;
        desc = typeof j?.sicDescription === 'string' && j.sicDescription ? j.sicDescription.slice(0, 120) : null;
      } else if (res.status !== 404) {
        return; // try again next time
      }
    } catch (err) {
      console.error('industry lookup failed:', cik, err.message);
      return;
    }
    await sql`
      INSERT INTO screener_industry (cik, sic, sic_desc, fetched_at) VALUES (${cik}, ${sic}, ${desc}, NOW())
      ON CONFLICT (cik) DO UPDATE SET sic = EXCLUDED.sic, sic_desc = EXCLUDED.sic_desc, fetched_at = NOW()
    `;
    out[cik] = [sic, desc];
  });
  return out;
}

// Looks up industries for dataset companies that don't have one yet (part of Refresh data; resumable).
// SEC allows about 5 requests a second, so each call handles a batch and reports what's left.
const FILL_BATCH = 50;
async function fillIndustries() {
  const ds = await sql`SELECT payload FROM screener_dataset WHERE id = 1`;
  if (!ds[0]) return { looked: 0, remaining: 0 };
  const have = new Set((await sql`SELECT cik FROM screener_industry`).map((r) => r.cik));
  const missing = ds[0].payload.companies.map((c) => c[2]).filter((cik) => !have.has(cik));
  const batch = missing.slice(0, FILL_BATCH);
  const found = await lookupIndustries(batch, FILL_BATCH);
  const looked = Object.keys(found).length;
  return { looked, remaining: missing.length - looked, total: ds[0].payload.companies.length };
}

// ---------- Prices and buy-below (latest saved valuation per ticker, the same number the watchlist uses) ----------

async function quotesAndBuyBelow(tickers) {
  const list = [...new Set(tickers.map((t) => String(t).trim().toUpperCase()).filter((t) => TICKER_RE.test(t)))].slice(0, QUOTE_BATCH);
  const { quotes, schwab } = await fetchQuotes(list);
  const prices = {};
  for (const t of list) if (Number.isFinite(quotes[t]?.last)) prices[t] = quotes[t].last;
  let buyBelow = {};
  try {
    const rows = await sql`
      SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) AS ticker, safety_price
      FROM valuations WHERE user_id = ${USER_ID}
      ORDER BY UPPER(ticker), created_at DESC
    `;
    buyBelow = Object.fromEntries(rows.filter((r) => Number.isFinite(Number(r.safety_price))).map((r) => [r.ticker, Number(r.safety_price)]));
  } catch (err) {
    if (!/does not exist/.test(err.message)) throw err; // no valuations saved yet
  }
  return { prices, buyBelow, schwab, at: Date.now() };
}

// ---------- Saved screens ----------

function cleanScreenName(v) {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
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
      const ind = await sql`SELECT COUNT(*)::int AS n, MAX(fetched_at) AS at FROM screener_industry`;
      return res.status(200).json({
        metrics: METRIC_KEYS,
        refreshed: Object.fromEntries(rows.map((r) => [r.metric, { companies: r.companies, at: r.fetched_at, years: r.years }])),
        dataset: ds[0] ? { builtAt: ds[0].built_at, companies: ds[0].n, years: ds[0].years } : null,
        industries: { count: ind[0]?.n || 0, at: ind[0]?.at || null }, // the page's cache key
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
      const ind = await sql`SELECT cik, sic, sic_desc FROM screener_industry`;
      return res.status(200).json({ ...ds[0].payload, industries: Object.fromEntries(ind.map((r) => [r.cik, [r.sic, r.sic_desc]])) });
    }
    if (action === 'fill-industries' && req.method === 'POST') {
      return res.status(200).json(await fillIndustries());
    }
    if (action === 'industry' && req.method === 'POST') {
      const ciks = Array.isArray(req.body?.ciks) ? req.body.ciks : [];
      return res.status(200).json({ industries: await lookupIndustries(ciks) });
    }
    if (action === 'quotes' && req.method === 'POST') {
      const tickers = Array.isArray(req.body?.tickers) ? req.body.tickers : [];
      return res.status(200).json(await quotesAndBuyBelow(tickers));
    }
    if (action === 'screens') {
      if (req.method === 'GET') {
        const rows = await sql`SELECT name, settings, updated_at FROM screener_screens WHERE user_id = ${USER_ID} ORDER BY name`;
        return res.status(200).json({ screens: rows.map((r) => ({ name: r.name, settings: r.settings, updatedAt: r.updated_at })) });
      }
      if (req.method === 'POST') {
        const name = cleanScreenName(req.body?.name);
        const settings = req.body?.settings;
        if (!name) return res.status(400).json({ error: 'Name required' });
        if (!settings || typeof settings !== 'object' || JSON.stringify(settings).length > 20000) return res.status(400).json({ error: 'Invalid settings' });
        const count = await sql`SELECT COUNT(*)::int AS n FROM screener_screens WHERE user_id = ${USER_ID} AND name <> ${name}`;
        if (count[0].n >= MAX_SCREENS) return res.status(400).json({ error: `Up to ${MAX_SCREENS} saved screens` });
        await sql`
          INSERT INTO screener_screens (user_id, name, settings, updated_at) VALUES (${USER_ID}, ${name}, ${JSON.stringify(settings)}::jsonb, NOW())
          ON CONFLICT (user_id, name) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
        `;
        return res.status(200).json({ ok: true, name });
      }
      if (req.method === 'DELETE') {
        const name = cleanScreenName(req.query?.name);
        await sql`DELETE FROM screener_screens WHERE user_id = ${USER_ID} AND name = ${name}`;
        return res.status(200).json({ ok: true });
      }
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('screener failed:', action, err);
    // the reason is shown on the page (this app's own data steps; no secrets in these messages)
    return res.status(502).json({ error: String(err?.message || 'Screener request failed').slice(0, 300) });
  }
}
