// Server-side only. SEC EDGAR XBRL access + metric extraction. Never import from frontend JS.

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts/CIK';

const ANNUAL_FORMS = new Set(['10-K', '40-F', '20-F']);
const MIN_INTERVAL_MS = 200; // ~5 req/s, well under SEC's 10 req/s limit
const MAX_YEARS = 10;

export const TICKER_RE = /^[A-Za-z.-]{1,10}$/;
const CIK_RE = /^\d{1,10}$/;

// ---------- Throttled fetch ----------

let nextSlot = 0;

async function secFetch(url, accept = 'application/json') {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) throw new Error('SEC_USER_AGENT is not configured');

  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: accept },
    signal: AbortSignal.timeout(20000),
  });
  return res;
}

// ---------- Input resolution ----------

let tickerMap = null;
let tickerMapAt = 0;

async function loadTickerMap() {
  if (tickerMap && Date.now() - tickerMapAt < 24 * 3600 * 1000) return tickerMap;
  const res = await secFetch(TICKERS_URL);
  if (!res.ok) throw new Error(`SEC tickers request failed with status ${res.status}`);
  const raw = await res.json();
  const byTicker = new Map();
  const byCik = new Map();
  for (const entry of Object.values(raw)) {
    const cik = String(entry.cik_str).padStart(10, '0');
    const ticker = String(entry.ticker).toUpperCase();
    byTicker.set(ticker, { cik, title: entry.title });
    if (!byCik.has(cik)) byCik.set(cik, { ticker, title: entry.title });
  }
  tickerMap = { byTicker, byCik };
  tickerMapAt = Date.now();
  return tickerMap;
}

function cikFromUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return { error: 'invalid' };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' };
  if (host !== 'sec.gov' && !host.endsWith('.sec.gov')) return { error: 'invalid' };

  // ?CIK=0001403161 (or CIK=V, which is a ticker) on browse-edgar style links
  const param = url.searchParams.get('CIK') ?? url.searchParams.get('cik');
  if (param !== null) {
    if (CIK_RE.test(param)) return { cik: param.padStart(10, '0') };
    if (TICKER_RE.test(param)) return { ticker: param.toUpperCase() };
    return { error: 'invalid' };
  }
  // /Archives/edgar/data/1403161/... or /cgi-bin/browse-edgar/.../CIK0001403161.json
  const m = url.pathname.match(/\/data\/(\d{1,10})(?:\/|$)/) || url.pathname.match(/CIK(\d{1,10})/i);
  if (m) return { cik: m[1].padStart(10, '0') };
  return { error: 'invalid' };
}

// Returns { cik, ticker, title } or { error: 'invalid' | 'not_found' }.
export async function resolveInput(rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (!input || input.length > 500) return { error: 'invalid' };

  let ticker = null;
  if (/^https?:\/\//i.test(input) || /sec\.gov/i.test(input)) {
    const parsed = cikFromUrl(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (parsed.error) return parsed;
    if (parsed.cik) {
      const maps = await loadTickerMap();
      const hit = maps.byCik.get(parsed.cik);
      return { cik: parsed.cik, ticker: hit?.ticker ?? null, title: hit?.title ?? null };
    }
    ticker = parsed.ticker;
  } else {
    if (!TICKER_RE.test(input)) return { error: 'invalid' };
    ticker = input.toUpperCase();
  }

  const maps = await loadTickerMap();
  const hit = maps.byTicker.get(ticker) || maps.byTicker.get(ticker.replace('.', '-'));
  if (!hit) return { error: 'not_found' };
  return { cik: hit.cik, ticker, title: hit.title };
}

// ---------- Company facts ----------

// Returns the parsed companyfacts JSON, or null if the company has no XBRL facts (404).
export async function fetchCompanyFacts(cik) {
  if (!CIK_RE.test(cik)) throw new Error('invalid cik');
  const res = await secFetch(`${FACTS_URL}${cik.padStart(10, '0')}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SEC companyfacts request failed with status ${res.status}`);
  return res.json();
}

// ---------- Metric definitions ----------
// Ordered fallback tags per taxonomy. Per fiscal year, the first tag with a value wins,
// so a company that switched tags mid-decade still gets a full series.

const METRICS = {
  revenue: {
    kind: 'flow',
    'us-gaap': ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet', 'SalesRevenueServicesNet', 'RevenuesNetOfInterestExpense'],
    'ifrs-full': ['Revenue', 'RevenueFromContractsWithCustomers'],
  },
  costOfRevenue: {
    kind: 'flow',
    'us-gaap': ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'],
    'ifrs-full': ['CostOfSales'],
  },
  grossProfit: {
    kind: 'flow',
    'us-gaap': ['GrossProfit'],
    'ifrs-full': ['GrossProfit'],
  },
  sga: {
    kind: 'flow',
    'us-gaap': ['SellingGeneralAndAdministrativeExpense'],
    'ifrs-full': ['SellingGeneralAndAdministrativeExpense'],
  },
  rnd: {
    kind: 'flow',
    'us-gaap': ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'],
    'ifrs-full': ['ResearchAndDevelopmentExpense'],
  },
  depreciation: {
    kind: 'flow',
    'us-gaap': ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'Depreciation'],
    'ifrs-full': ['DepreciationAndAmortisationExpense', 'DepreciationExpense'],
  },
  operatingIncome: {
    kind: 'flow',
    'us-gaap': ['OperatingIncomeLoss'],
    'ifrs-full': ['ProfitLossFromOperatingActivities'],
  },
  interestExpense: {
    kind: 'flow',
    'us-gaap': ['InterestExpense', 'InterestExpenseDebt', 'InterestAndDebtExpense', 'InterestExpenseNonoperating'],
    'ifrs-full': ['InterestExpense', 'FinanceCosts'],
  },
  netIncome: {
    kind: 'flow',
    'us-gaap': ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
    'ifrs-full': ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'],
  },
  epsDiluted: {
    kind: 'flow',
    unit: 'perShare',
    'us-gaap': ['EarningsPerShareDiluted'],
    'ifrs-full': ['DilutedEarningsLossPerShare'],
  },
  dilutedShares: {
    kind: 'flow',
    unit: 'shares',
    'us-gaap': ['WeightedAverageNumberOfDilutedSharesOutstanding'],
    'ifrs-full': ['AdjustedWeightedAverageShares'],
  },
  currentAssets: {
    kind: 'instant',
    'us-gaap': ['AssetsCurrent'],
    'ifrs-full': ['CurrentAssets'],
  },
  currentLiabilities: {
    kind: 'instant',
    'us-gaap': ['LiabilitiesCurrent'],
    'ifrs-full': ['CurrentLiabilities'],
  },
  totalLiabilities: {
    kind: 'instant',
    'us-gaap': ['Liabilities'],
    'ifrs-full': ['Liabilities'],
  },
  equity: {
    kind: 'instant',
    'us-gaap': ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    'ifrs-full': ['EquityAttributableToOwnersOfParent', 'Equity'],
  },
  longTermDebt: {
    kind: 'instant',
    'us-gaap': ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations', 'LongTermDebt'],
    'ifrs-full': ['LongtermBorrowings', 'NoncurrentPortionOfNoncurrentBondsIssued', 'NoncurrentPortionOfNoncurrentLoansReceived'],
  },
  retainedEarnings: {
    kind: 'instant',
    'us-gaap': ['RetainedEarningsAccumulatedDeficit'],
    'ifrs-full': ['RetainedEarnings'],
  },
  netReceivables: {
    kind: 'instant',
    'us-gaap': ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent', 'AccountsNotesAndLoansReceivableNetCurrent'],
    'ifrs-full': ['TradeAndOtherCurrentReceivables', 'CurrentTradeReceivables'],
  },
  operatingCashFlow: {
    kind: 'flow',
    'us-gaap': ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    'ifrs-full': ['CashFlowsFromUsedInOperatingActivities'],
  },
  capex: {
    kind: 'flow',
    'us-gaap': ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements'],
    'ifrs-full': ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'PurchaseOfPropertyPlantAndEquipment'],
  },
};

export const METRIC_KEYS = Object.keys(METRICS);

// ---------- Extraction ----------

const DAY = 86400000;

// Fiscal-year label: year of the period end, shifted back 20 days so 52/53-week
// years ending in the first days of January land on the prior year.
function fiscalYearOf(endDate) {
  const t = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t - 20 * DAY).getUTCFullYear();
}

function pickUnit(units, wanted) {
  if (wanted === 'shares') return units.shares ? 'shares' : null;
  if (wanted === 'perShare') {
    return Object.keys(units).find((u) => /\/shares$/i.test(u)) ?? null;
  }
  if (units.USD) return 'USD';
  return Object.keys(units).find((u) => /^[A-Z]{3}$/.test(u)) ?? null;
}

// Annual values for one tag: Map(fiscalYear -> { value, end, filed }) deduped by latest filing.
function annualSeries(concept, kind, wantedUnit) {
  const unit = pickUnit(concept.units || {}, wantedUnit);
  if (!unit) return null;
  const byYear = new Map();
  for (const f of concept.units[unit]) {
    if (!ANNUAL_FORMS.has(f.form) || f.fp !== 'FY') continue;
    if (typeof f.val !== 'number' || !f.end) continue;
    if (kind === 'flow') {
      if (!f.start) continue;
      const days = (Date.parse(f.end) - Date.parse(f.start)) / DAY;
      if (!(days >= 340 && days <= 380)) continue;
    }
    const fy = fiscalYearOf(f.end);
    if (fy === null) continue;
    const prev = byYear.get(fy);
    // latest filing wins; on a tie keep the later period end
    if (!prev || f.filed > prev.filed || (f.filed === prev.filed && f.end > prev.end)) {
      byYear.set(fy, { value: f.val, end: f.end, filed: f.filed });
    }
  }
  return byYear.size ? { byYear, unit } : null;
}

function extractForTaxonomy(facts, taxonomy) {
  const concepts = facts?.facts?.[taxonomy];
  if (!concepts) return null;
  const out = {};
  let found = 0;
  let currency = null;
  for (const key of METRIC_KEYS) {
    const def = METRICS[key];
    const merged = new Map();
    const tagsUsed = [];
    for (const tag of def[taxonomy] || []) {
      const concept = concepts[tag];
      if (!concept?.units) continue;
      const series = annualSeries(concept, def.kind, def.unit);
      if (!series) continue;
      let contributed = false;
      for (const [fy, v] of series.byYear) {
        if (!merged.has(fy)) {
          merged.set(fy, v);
          contributed = true;
        }
      }
      if (contributed) tagsUsed.push(tag);
      if (!def.unit && !currency) currency = series.unit;
    }
    out[key] = { values: merged, tags: tagsUsed };
    if (merged.size) found++;
  }
  return { out, found, currency };
}

const round = (n, d = 4) => (n === null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const div = (a, b) => (a === null || b === null || b === 0 ? null : a / b);

// Builds the metrics document stored in Neon and returned to the client.
export function buildMetrics(facts) {
  const candidates = ['us-gaap', 'ifrs-full']
    .map((tax) => ({ tax, res: extractForTaxonomy(facts, tax) }))
    .filter((c) => c.res);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.res.found - a.res.found);
  const { tax: taxonomy, res } = candidates[0];
  if (res.found === 0) return null;

  // Last 10 fiscal years that have at least one annual value
  const allYears = new Set();
  for (const key of METRIC_KEYS) for (const fy of res.out[key].values.keys()) allYears.add(fy);
  const years = [...allYears].sort((a, b) => a - b).slice(-MAX_YEARS);

  const raw = {};
  for (const key of METRIC_KEYS) {
    raw[key] = years.map((fy) => res.out[key].values.get(fy)?.value ?? null);
  }

  // Gross profit: use the reported figure; else revenue - cost of revenue (both reported).
  const grossProfit = years.map((_, i) => {
    if (raw.grossProfit[i] !== null) return raw.grossProfit[i];
    if (raw.revenue[i] !== null && raw.costOfRevenue[i] !== null) return raw.revenue[i] - raw.costOfRevenue[i];
    return null;
  });
  const grossProfitDerived = raw.grossProfit.every((v) => v === null) && grossProfit.some((v) => v !== null);

  const at = (key, i) => (i >= 0 ? raw[key][i] : null);
  const derived = {
    grossMargin: [], netMargin: [], sgaPctGrossProfit: [], interestPctOperatingIncome: [],
    debtToEquity: [], longTermDebtYears: [], currentRatio: [], roe: [],
    fcf: [], fcfPerShare: [], epsGrowth: [],
  };
  years.forEach((_, i) => {
    const gp = grossProfit[i];
    const ni = at('netIncome', i);
    const opInc = at('operatingIncome', i);
    const equity = at('equity', i);
    const ocf = at('operatingCashFlow', i);
    const capex = at('capex', i);
    const fcf = ocf !== null && capex !== null ? ocf - Math.abs(capex) : null;
    const eps = at('epsDiluted', i);
    const prevEps = i > 0 ? raw.epsDiluted[i - 1] : null;

    derived.grossMargin.push(round(div(gp, at('revenue', i))));
    derived.netMargin.push(round(div(ni, at('revenue', i))));
    derived.sgaPctGrossProfit.push(gp !== null && gp > 0 ? round(div(at('sga', i), gp)) : null);
    derived.interestPctOperatingIncome.push(opInc !== null && opInc > 0 ? round(div(at('interestExpense', i), opInc)) : null);
    derived.debtToEquity.push(equity !== null && equity > 0 ? round(div(at('totalLiabilities', i), equity)) : null);
    derived.longTermDebtYears.push(ni !== null && ni > 0 ? round(div(at('longTermDebt', i), ni)) : null);
    derived.currentRatio.push(round(div(at('currentAssets', i), at('currentLiabilities', i))));
    derived.roe.push(equity !== null && equity > 0 ? round(div(ni, equity)) : null);
    derived.fcf.push(fcf);
    derived.fcfPerShare.push(round(div(fcf, at('dilutedShares', i)), 4));
    derived.epsGrowth.push(eps !== null && prevEps !== null && prevEps > 0 ? round((eps - prevEps) / prevEps) : null);
  });

  // 10-year FCF CAGR between the first and last years that have FCF (both must be positive)
  let fcfCagr = null;
  const fcfIdx = derived.fcf.map((v, i) => (v !== null ? i : -1)).filter((i) => i >= 0);
  if (fcfIdx.length >= 2) {
    const first = fcfIdx[0];
    const last = fcfIdx[fcfIdx.length - 1];
    const span = years[last] - years[first];
    if (span >= 3 && derived.fcf[first] > 0 && derived.fcf[last] > 0) {
      fcfCagr = round(Math.pow(derived.fcf[last] / derived.fcf[first], 1 / span) - 1);
    }
  }

  const found = METRIC_KEYS.filter((k) => raw[k].some((v) => v !== null));
  const found2 = grossProfitDerived && !found.includes('grossProfit') ? [...found, 'grossProfit'] : found;
  const tags = {};
  for (const key of METRIC_KEYS) tags[key] = res.out[key].tags;

  return {
    taxonomy,
    currency: res.currency,
    years,
    raw: { ...raw, grossProfit },
    grossProfitDerived,
    derived,
    fcfCagr,
    fcfCagrSpan: fcfIdx.length >= 2 ? [years[fcfIdx[0]], years[fcfIdx[fcfIdx.length - 1]]] : null,
    tags,
    coverage: {
      found: found2.length,
      total: METRIC_KEYS.length,
      missing: METRIC_KEYS.filter((k) => !found2.includes(k)),
    },
  };
}

// ---------- Filing text extraction (for the Story tab) ----------

const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

export const SECTION_CAPS = { business: 30000, risk_factors: 30000, mdna: 40000, segments: 12000 };
export const SECTION_KEYS = Object.keys(SECTION_CAPS);

// Most recent 10-K / 40-F / 20-F for a CIK, or null.
export async function findLatestAnnualFiling(cik) {
  if (!CIK_RE.test(cik)) throw new Error('invalid cik');
  const padded = cik.padStart(10, '0');
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`);
  if (!res.ok) throw new Error(`SEC submissions request failed with status ${res.status}`);
  const sub = await res.json();
  const rc = sub?.filings?.recent;
  if (!rc) return null;
  const i = rc.form.findIndex((f) => ANNUAL_FORMS.has(f));
  if (i < 0) return null;
  const accession = rc.accessionNumber[i];
  const base = `${ARCHIVES}/${parseInt(padded, 10)}/${accession.replace(/-/g, '')}`;
  return {
    form: rc.form[i],
    filingDate: rc.filingDate[i],
    reportDate: rc.reportDate?.[i] || null,
    accession,
    primaryDocument: rc.primaryDocument[i],
    baseUrl: base,
    primaryUrl: `${base}/${rc.primaryDocument[i]}`,
    indexUrl: `${base}/${accession}-index.htm`,
  };
}

const CURRENT_REPORT_FORMS = new Set(['8-K', '8-K/A', '6-K', '6-K/A']);

// Meaning of the most common 8-K item codes, so downstream text can say what a filing was about.
const ITEM_DESCRIPTIONS = {
  '1.01': 'Entry into a material definitive agreement',
  '1.02': 'Termination of a material definitive agreement',
  '1.03': 'Bankruptcy or receivership',
  '2.01': 'Completion of acquisition or disposition of assets',
  '2.02': 'Results of operations and financial condition',
  '2.03': 'Creation of a direct financial obligation',
  '2.04': 'Triggering events that accelerate a financial obligation',
  '2.05': 'Costs associated with exit or disposal activities',
  '2.06': 'Material impairments',
  '3.01': 'Notice of delisting or failure to satisfy a listing rule',
  '3.02': 'Unregistered sales of equity securities',
  '3.03': 'Material modification to rights of security holders',
  '4.01': 'Change in certifying accountant',
  '4.02': 'Non-reliance on previously issued financial statements',
  '5.01': 'Changes in control of registrant',
  '5.02': 'Departure or appointment of directors or officers',
  '5.03': 'Amendments to articles or bylaws',
  '5.07': 'Submission of matters to a vote of security holders',
  '7.01': 'Regulation FD disclosure',
  '8.01': 'Other events',
  '9.01': 'Financial statements and exhibits',
};

// 8-K (domestic) and 6-K (foreign private issuer) filings from the last `days` days, newest first:
// [{ form, filingDate, accession, items: [{ code, description }], description, url }].
// 6-Ks carry no item codes, so `description` (SEC's own document label) is the only hint there.
export async function listRecentCurrentReports(cik, days = 120) {
  if (!CIK_RE.test(cik)) throw new Error('invalid cik');
  const padded = cik.padStart(10, '0');
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`);
  if (!res.ok) throw new Error(`SEC submissions request failed with status ${res.status}`);
  const rc = (await res.json())?.filings?.recent;
  if (!rc) return [];

  const cutoff = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < rc.form.length; i++) {
    if (rc.filingDate[i] < cutoff) break; // `recent` is newest first
    if (!CURRENT_REPORT_FORMS.has(rc.form[i])) continue;
    const accession = rc.accessionNumber[i];
    out.push({
      form: rc.form[i],
      filingDate: rc.filingDate[i],
      accession,
      items: String(rc.items?.[i] || '').split(',').map((c) => c.trim()).filter(Boolean)
        .map((code) => ({ code, description: ITEM_DESCRIPTIONS[code] || null })),
      description: rc.primaryDocDescription?.[i] || null,
      url: `${ARCHIVES}/${parseInt(padded, 10)}/${accession.replace(/-/g, '')}/${rc.primaryDocument[i]}`,
    });
  }
  return out;
}

const HEADLINE_MAX_BYTES = 120000; // read only the start of an exhibit; the headline is at the top
const HEADLINE_MAX_CHARS = 400;
const HEADLINE_BOILERPLATE = /^(exhibit\b|united states|securities and exchange|washington|form\s+6-k|report of foreign|for the month|commission file|indicate by check|\(|signature|table of contents|news release|press release$|pursuant to rule|cover of form|of the securities exchange act|of registrant as specified|\d{4}$)|registrant as specified|principal executive offices|\(?exact name of/i;

// Reads at most `maxBytes` of a document, then stops the download.
async function readDocumentStart(url, maxBytes) {
  const res = await secFetch(url, 'text/html');
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

// First few real lines of a document, skipping cover-page boilerplate.
function headlineFromHtml(html) {
  const lines = htmlToText(html).split('\n').filter((l) => l.length >= 25 && !HEADLINE_BOILERPLATE.test(l));
  return lines.slice(0, 3).join(' | ').slice(0, HEADLINE_MAX_CHARS) || null;
}

// 6-K filings have no item codes, so read the top of each one's press-release exhibit (EX-99.x) to
// say what it was about. Only the `max` most recent 6-Ks are read; 8-K filings are left untouched.
export async function addCurrentReportHeadlines(reports, max = 6) {
  const out = reports.map((r) => ({ ...r }));
  let read = 0;
  for (const r of out) {
    if (read >= max) break;
    if (!r.form.startsWith('6-K')) continue;
    read++;
    try {
      const base = r.url.slice(0, r.url.lastIndexOf('/'));
      let target = r.url;
      const idx = await secFetch(`${base}/index.json`);
      if (idx.ok) {
        const names = ((await idx.json())?.directory?.item || []).map((it) => it.name).filter((n) => /\.html?$/i.test(n));
        const exhibits = names.filter((n) => /ex[-_]?99/i.test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b));
        const preferred = exhibits.find((n) => /ex[-_]?99[-_.]?0?1(?!\d)/i.test(n)) || exhibits[0];
        if (preferred) target = `${base}/${preferred}`;
      }
      const html = await readDocumentStart(target, HEADLINE_MAX_BYTES);
      r.headline = html ? headlineFromHtml(html) : null;
    } catch (err) {
      console.error('6-K headline lookup failed:', err);
      r.headline = null;
    }
  }
  return out;
}

// Documents in a filing: [{ name, type, size }]. Sizes come from index.json; document types
// (EX-99.1, EX-13...) only appear on the -index.htm page, so both are read.
export async function listFilingDocuments(filing) {
  const jsonRes = await secFetch(`${filing.baseUrl}/index.json`);
  if (!jsonRes.ok) throw new Error(`SEC filing index failed with status ${jsonRes.status}`);
  const items = (await jsonRes.json())?.directory?.item || [];

  const types = new Map();
  const htmRes = await secFetch(filing.indexUrl, 'text/html');
  if (htmRes.ok) {
    const html = await htmRes.text();
    for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map((c) => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      const link = row.match(/href="[^"]*\/([^"/]+)"/i);
      if (cells.length >= 5 && link) types.set(link[1], cells[3].toUpperCase());
    }
  }
  return items.map((it) => ({ name: it.name, size: Number(it.size) || 0, type: types.get(it.name) || null }));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...' };

export function htmlToText(html) {
  return html
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? ' ')
    .replace(/[  ​]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').replace(/^[| ]+|[| ]+$/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

function capSection(text, cap, source) {
  const truncated = text.length > cap;
  const out = truncated ? text.slice(0, cap) : text;
  return { status: 'found', text: out, chars: out.length, truncated, source };
}

const missingSection = () => ({ status: 'missing', text: '', chars: 0, truncated: false, source: null });

// 10-K: locate "Item N" headings; for a wanted item take the heading whose body is longest
// (the table-of-contents entry is short, the real section is long).
const ITEM_HEAD = /^item\s+(1a|1b|1c|1|2|3|4|5|6|7a|7|8|9a|9b|9c|9|10|11|12|13|14|15|16)\b[\s.:-]/i;

function itemExtractor(lines) {
  const heads = [];
  lines.forEach((line, idx) => {
    const m = line.length < 200 && line.match(ITEM_HEAD);
    if (m) heads.push({ idx, id: m[1].toLowerCase() });
  });
  return (id) => {
    let best = '';
    for (let h = 0; h < heads.length; h++) {
      if (heads[h].id !== id) continue;
      let end = h + 1;
      while (end < heads.length && heads[end].id === id) end++;
      const stop = end < heads.length ? heads[end].idx : lines.length;
      const body = lines.slice(heads[h].idx, stop).join('\n');
      if (body.length > best.length) best = body;
    }
    return best;
  };
}

// Prose density: count of sentence-length lines after a heading. Separates real sections
// from table-of-contents entries and one-line mentions.
function proseScore(lines, from, span) {
  let n = 0;
  for (let i = from; i < Math.min(lines.length, from + span); i++) if (lines[i].length > 80) n++;
  return n;
}

const SEGMENT_HEAD = /^(?:note\s+\d+\s*[.:—–-]?\s*)?(?:\d+(?:\.|\s+n)?\s+)?(?:operating\s+segments?|segments?|business\s+segments?|reportable\s+segments?|concentrations?\s+of\s+(?:credit\s+risk|customers?|risk)|major\s+customers?|significant\s+customers?)(?:\s+[a-z&,'’-]+){0,4}$/i;
const NOTE_HEAD = /^(?:note\s+\d+\s*[.:—–-]|\d+\s+n\s+[a-z])/i;

function extractSegments(lines) {
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 120 || !SEGMENT_HEAD.test(lines[i]) || /\btotal\b/i.test(lines[i])) continue;
    // A numbered financial-statement note beats a same-named subsection of the business description
    const score = proseScore(lines, i + 1, 40) + (NOTE_HEAD.test(lines[i]) ? 1000 : 0);
    if (score >= 4 && (!best || score > best.score)) best = { idx: i, score };
  }
  if (!best) return null;
  const isNote = NOTE_HEAD.test(lines[best.idx]);
  let end = Math.min(lines.length, best.idx + 4000);
  if (isNote) {
    for (let j = best.idx + 1; j < end; j++) {
      if (NOTE_HEAD.test(lines[j])) { end = j; break; }
    }
  }
  return lines.slice(best.idx, end).join('\n');
}

// Heading keywords for exhibit-style annual reports (40-F / 20-F, or a 10-K with Exhibit 13).
const KEYWORD_HEADS = {
  business: /^(?:item\s+\d+[a-z]?\.?\s*)?(?:\d+\.?\s*)?(?:description\s+of\s+the\s+business|general\s+development\s+of\s+the\s+business|business\s+overview|our\s+business|the\s+business|business\s+of\s+the\s+company)\b[^.]{0,60}$/i,
  risk_factors: /^(?:item\s+\d+[a-z]?\.?\s*)?(?:\d+\.?\s*)?(?:risk\s+factors|risks\s+and\s+uncertainties|principal\s+risks[a-z\s]*)\s*$/i,
  mdna: /^(?:item\s+\d+[a-z]?\.?\s*)?(?:\d+\.?\s*)?(?:management['’]?s\s+discussion\s+and\s+analysis|operating\s+and\s+financial\s+review[a-z\s]*)\b[^.]{0,80}$/i,
};

// Exhibit sections have no reliable end marker, so the body runs from the best heading to the cap.
function extractByKeyword(lines, key, cap) {
  const re = KEYWORD_HEADS[key];
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 120 || !re.test(lines[i])) continue;
    const score = proseScore(lines, i + 1, 80);
    if (score >= 8 && (!best || score > best.score)) best = { idx: i, score };
  }
  if (!best) return null;
  const out = [];
  let size = 0;
  for (let j = best.idx; j < lines.length && size <= cap + 1; j++) {
    out.push(lines[j]);
    size += lines[j].length + 1;
  }
  return out.join('\n');
}

async function fetchDocText(url) {
  const res = await secFetch(url, 'text/html');
  if (!res.ok) throw new Error(`SEC document request failed with status ${res.status}`);
  return htmlToText(await res.text());
}

// Returns { filing, sections } or null when the company has no annual filing. Each section is
// { status: 'found'|'missing', text, chars, truncated, source }.
export async function extractFilingSections(cik) {
  const filing = await findLatestAnnualFiling(cik);
  if (!filing) return null;
  const docs = await listFilingDocuments(filing);
  const sections = {};
  for (const k of SECTION_KEYS) sections[k] = missingSection();
  const set = (key, text, source) => {
    if (text && text.length > 500) sections[key] = capSection(text, SECTION_CAPS[key], source);
  };
  const isHtml = (d) => /\.html?$/i.test(d.name);

  if (filing.form === '10-K') {
    const lines = (await fetchDocText(filing.primaryUrl)).split('\n');
    const item = itemExtractor(lines);
    set('business', item('1'), 'Item 1');
    set('risk_factors', item('1a'), 'Item 1A');
    set('mdna', item('7'), 'Item 7 (MD&A)');
    set('segments', extractSegments(lines), 'Segment / concentration note');

    // MD&A incorporated by reference from an Exhibit 13 annual report
    if (sections.mdna.chars < 3000) {
      const ex13 = docs.find((d) => d.type?.startsWith('EX-13') && isHtml(d));
      if (ex13) {
        const exLines = (await fetchDocText(`${filing.baseUrl}/${ex13.name}`)).split('\n');
        const t = extractByKeyword(exLines, 'mdna', SECTION_CAPS.mdna);
        if (t) set('mdna', t, 'EX-13 (MD&A)');
      }
    }
    return { filing, sections };
  }

  // 40-F / 20-F: the main document is a wrapper; read the annual report exhibits.
  const exhibits = docs
    .filter((d) => /^EX-(99|13)/.test(d.type || '') && isHtml(d) && d.size > 100000)
    .sort((a, b) => b.size - a.size)
    .slice(0, 4);
  const cands = { business: [], risk_factors: [], mdna: [], segments: [] };
  for (const ex of exhibits) {
    const lines = (await fetchDocText(`${filing.baseUrl}/${ex.name}`)).split('\n');
    const src = `${ex.type} (${ex.name})`;
    for (const key of ['business', 'risk_factors', 'mdna']) {
      const t = extractByKeyword(lines, key, SECTION_CAPS[key]);
      if (t) cands[key].push({ t, src });
    }
    const seg = extractSegments(lines);
    if (seg) cands.segments.push({ t: seg, src });
  }
  for (const key of SECTION_KEYS) {
    const best = cands[key].sort((a, b) => b.t.length - a.t.length)[0];
    if (best) set(key, best.t, best.src);
  }
  return { filing, sections };
}
