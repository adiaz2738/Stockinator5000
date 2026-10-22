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

async function secFetch(url) {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) throw new Error('SEC_USER_AGENT is not configured');

  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
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
