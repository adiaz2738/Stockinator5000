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

export async function secFetch(url, accept = 'application/json') {
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

export async function loadTickerMap() {
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
  // Gains (positive) and losses (negative) on selling assets such as vessels or property. Used for the "ex-gains" figures.
  gainOnAssetSales: {
    kind: 'flow',
    'us-gaap': ['GainLossOnSaleOfPropertyPlantEquipment', 'GainLossOnSaleOfPropertyPlantAndEquipment', 'GainLossOnDispositionOfAssets', 'GainLossOnDispositionOfAssets1', 'GainLossOnSaleOfOtherAssets', 'GainLossOnDispositionOfOtherAssets'],
    'ifrs-full': ['GainsLossesOnDisposalsOfPropertyPlantAndEquipment', 'GainsLossesOnDisposalsOfNoncurrentAssets'],
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
    'us-gaap': ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
    'ifrs-full': ['DilutedEarningsLossPerShare', 'BasicAndDilutedEarningsLossPerShare'],
  },
  dilutedShares: {
    kind: 'flow',
    unit: 'shares',
    'us-gaap': ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted', 'WeightedAverageNumberOfSharesOutstandingBasicAndDiluted'],
    'ifrs-full': ['AdjustedWeightedAverageShares'],
  },
  dividendsPerShare: {
    kind: 'flow',
    unit: 'perShare',
    'us-gaap': ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'],
    'ifrs-full': ['DividendsRecognisedAsDistributionsToOwnersPerShare'],
  },
  // Year-end common shares outstanding, for book value per share (weighted diluted shares are used when missing)
  sharesOutstanding: {
    kind: 'instant',
    unit: 'shares',
    'us-gaap': ['CommonStockSharesOutstanding'],
    'ifrs-full': ['NumberOfSharesOutstanding'],
  },
  cash: {
    kind: 'instant',
    'us-gaap': ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    'ifrs-full': ['CashAndCashEquivalents'],
  },
  shortTermInvestments: {
    kind: 'instant',
    'us-gaap': ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'OtherShortTermInvestments'],
    'ifrs-full': ['ShortTermInvestments', 'CurrentInvestments'],
  },
  totalAssets: {
    kind: 'instant',
    'us-gaap': ['Assets'],
    'ifrs-full': ['Assets'],
  },
  // Only used to complete the net cash figure; not shown as its own row
  currentDebt: {
    kind: 'instant',
    'us-gaap': ['LongTermDebtCurrent', 'DebtCurrent'],
    'ifrs-full': ['CurrentPortionOfLongtermBorrowings', 'CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings'],
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
  // Total expenses, used for operating income (revenue - total expenses) only when no operating income tag exists
  totalExpenses: {
    kind: 'flow',
    'us-gaap': ['CostsAndExpenses', 'BenefitsLossesAndExpenses'],
    'ifrs-full': [],
  },
  capex: {
    kind: 'flow',
    // Tags that total a company's capital spending. Software and intangibles are components (below), not totals.
    'us-gaap': ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements', 'PaymentsToAcquireOtherPropertyPlantAndEquipment'],
    'ifrs-full': ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'PurchaseOfPropertyPlantAndEquipment'],
  },
};

// Capital-type investing outflows that are summed when no single capex tag exists for a year.
// Acquisitions, purchases of investments and loans are deliberately absent.
const CAPEX_COMPONENTS = {
  'us-gaap': [
    'PaymentsToAcquireMachineryAndEquipment', 'PaymentsToAcquireBuildings', 'PaymentsToAcquireFurnitureAndFixtures',
    'PaymentsToAcquireOtherProductiveAssets', 'PaymentsToDevelopSoftware', 'PaymentsForSoftware',
    'PaymentsToAcquireIntangibleAssets', 'PaymentsToAcquireOilAndGasPropertyAndEquipment', 'PaymentsToAcquireMiningAssets',
  ],
  'ifrs-full': [
    'PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities', 'PurchaseOfOtherLongtermAssetsClassifiedAsInvestingActivities',
    'PurchaseOfInvestmentPropertyClassifiedAsInvestingActivities',
  ],
};

// If any of these carries a non-zero annual value in the displayed years, the company has debt in XBRL
const DEBT_PRESENCE_TAGS = {
  'us-gaap': ['LongTermDebt', 'LongTermDebtNoncurrent', 'LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings', 'NotesPayable', 'LongTermNotesPayable', 'ConvertibleNotesPayable', 'ConvertibleDebt', 'LineOfCredit', 'LongTermLineOfCredit', 'SecuredDebt', 'UnsecuredDebt', 'DebtInstrumentCarryingAmount', 'DebtAndCapitalLeaseObligations', 'LongTermDebtAndCapitalLeaseObligations', 'NotesPayableRelatedPartiesClassifiedCurrent', 'SeniorNotes'],
  'ifrs-full': ['Borrowings', 'LongtermBorrowings', 'CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings', 'NoncurrentPortionOfNoncurrentLoansReceived', 'NoncurrentPortionOfNoncurrentBondsIssued', 'BondsIssued'],
};

export const METRIC_KEYS = Object.keys(METRICS);

// ---------- Extraction ----------

const DAY = 86400000;

// Fiscal-year label: year of the period end, shifted back 20 days so 52/53-week
// years ending in the first days of January land on the prior year.
export function fiscalYearOf(endDate) {
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
    // A weighted share count of 0 is a filing artifact, never a real count: treat it as not reported
    if (wantedUnit === 'shares' && !(f.val > 0)) continue;
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
          merged.set(fy, { ...v, tag });
          contributed = true;
        }
      }
      if (contributed) tagsUsed.push(tag);
      if (!def.unit && !currency) currency = series.unit;
    }
    out[key] = { values: merged, tags: tagsUsed };
    if (merged.size) found++;
  }

  // Capital-type components per fiscal year, for years where no single capex tag exists
  const capexParts = new Map();
  for (const tag of CAPEX_COMPONENTS[taxonomy] || []) {
    const concept = concepts[tag];
    const series = concept?.units ? annualSeries(concept, 'flow') : null;
    if (!series) continue;
    for (const [fy, v] of series.byYear) {
      if (!capexParts.has(fy)) capexParts.set(fy, []);
      capexParts.get(fy).push({ tag, label: concept.label || tag, value: Math.abs(v.value) });
    }
  }

  // Years (fiscal) in which any debt tag has a non-zero annual value
  const debtYears = new Set();
  for (const tag of DEBT_PRESENCE_TAGS[taxonomy] || []) {
    const concept = concepts[tag];
    if (!concept?.units) continue;
    for (const arr of Object.values(concept.units)) {
      for (const f of arr) {
        if (ANNUAL_FORMS.has(f.form) && typeof f.val === 'number' && f.val !== 0 && f.end) debtYears.add(fiscalYearOf(f.end));
      }
    }
  }
  return { out, found, currency, capexParts, debtYears };
}

const round = (n, d = 4) => (n === null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const div = (a, b) => (a === null || b === null || b === 0 ? null : a / b);

// ---------- Data-quality checks (scale errors) ----------
// Some filers tag a value in millions or thousands but label the unit "shares" or "USD" without applying
// the scale (McDonald's reports diluted shares as 751.8 instead of 751,800,000 from the FY2023 10-K on).

// Bump when extraction logic changes so cached rows in Neon refetch.
export const DATA_VERSION = 9; // 9: dividends per share, shares outstanding, book value per share
export const DATA_VERSION_PREV = 8; // 8: capex 0 when none is ever reported; operating income from revenue - total expenses

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const SCALE_POWERS = [3, 6, -3, -6];
// Tolerance for "reported shares vs net income / diluted EPS": covers EPS rounding, preferred dividends, etc.
const SHARES_OK_MIN = 0.5;
const SHARES_OK_MAX = 2;
// EPS this small is mostly rounding, so net income / EPS says nothing reliable
const MIN_ABS_EPS_FOR_CHECK = 0.05;
// Dollar series that stay clearly away from zero; others (net income, cash flow, equity, retained earnings...)
// legitimately pass near zero, where a 1000x "outlier" is real, so they are never rescaled.
const OUTLIER_CHECK_KEYS = ['revenue', 'costOfRevenue', 'sga', 'rnd', 'depreciation', 'currentAssets', 'currentLiabilities', 'totalLiabilities', 'netReceivables', 'capex', 'dilutedShares', 'totalAssets', 'cash'];

// ratio ~ 10^k for k in {3, 6, -3, -6} (within about a factor of 2.2), else null
function scalePower(ratio) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  const l = Math.log10(ratio);
  return SCALE_POWERS.find((k) => Math.abs(l - k) < 0.35) ?? null;
}

const rescale = (v, k) => Number((v * 10 ** -k).toPrecision(12));
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmtFactor = (k) => `×${(10 ** -k).toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
const fmtYearRanges = (ys) => {
  const s = [...new Set(ys)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}–${s[j]}` : `${s[i]}`);
    i = j;
  }
  return parts.join(', ');
};

// Diluted shares must agree with net income / diluted EPS. ~1,000x or 1,000,000x off -> rescale (and say so);
// any other large disagreement -> N/A. Never guesses.
function checkDilutedShares(raw, years, quality) {
  for (let i = 0; i < years.length; i++) {
    const sh = raw.dilutedShares[i];
    const ni = raw.netIncome[i];
    const eps = raw.epsDiluted[i];
    if (!isNum(sh) || sh <= 0 || !isNum(ni) || !isNum(eps) || Math.abs(eps) < MIN_ABS_EPS_FOR_CHECK) continue;
    const implied = ni / eps;
    if (!(implied > 0)) continue;
    const ratio = sh / implied;
    if (ratio >= SHARES_OK_MIN && ratio <= SHARES_OK_MAX) continue;

    const k = scalePower(ratio);
    if (k !== null) {
      const fixed = Math.round(rescale(sh, k));
      const after = fixed / implied;
      if (after >= SHARES_OK_MIN && after <= SHARES_OK_MAX) {
        raw.dilutedShares[i] = fixed;
        quality.rescaled.push({
          metric: 'dilutedShares', year: years[i], from: sh, to: fixed, factor: 10 ** -k,
          reason: `Reported as ${sh.toLocaleString('en-US')} but net income ÷ diluted EPS implies about ${Math.round(implied).toLocaleString('en-US')}; rescaled ${fmtFactor(k)}`,
        });
        continue;
      }
    }
    raw.dilutedShares[i] = null;
    quality.nulled.push({
      metric: 'dilutedShares', year: years[i],
      reason: `Reported ${sh.toLocaleString('en-US')} disagrees with net income ÷ diluted EPS (about ${Math.round(implied).toLocaleString('en-US')}) by a factor of ${ratio.toPrecision(3)}, so it is not shown`,
    });
  }
}

// A value ~1,000x or 1,000,000x away from every other year's level, while those other years agree with each other.
function checkScaleOutliers(raw, years, quality) {
  for (const key of OUTLIER_CHECK_KEYS) {
    const vals = raw[key];
    const idx = vals.map((v, i) => (isNum(v) && v !== 0 ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 5) continue;
    for (const i of idx) {
      const others = idx.filter((j) => j !== i).map((j) => Math.abs(vals[j]));
      const med = median(others);
      const agreeing = others.filter((o) => o / med < 10 && med / o < 10).length;
      if (agreeing < Math.max(3, Math.ceil(others.length * 0.6))) continue;
      const k = scalePower(Math.abs(vals[i]) / med);
      if (k === null) continue;
      const fixed = rescale(vals[i], k);
      quality.rescaled.push({
        metric: key, year: years[i], from: vals[i], to: fixed, factor: 10 ** -k,
        reason: `Reported ${vals[i].toLocaleString('en-US')} is about ${(10 ** Math.abs(k)).toLocaleString('en-US')}x ${k > 0 ? 'larger' : 'smaller'} than every other year; rescaled ${fmtFactor(k)}`,
      });
      vals[i] = fixed;
    }
  }
}

// Latest fiscal year only: if no diluted share count survived, use the cover-page shares outstanding (dei).
function fillLatestSharesFromCoverPage(facts, res, raw, years, quality) {
  const last = years.length - 1;
  if (last < 0 || isNum(raw.dilutedShares[last])) return;
  const entries = facts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares;
  if (!Array.isArray(entries)) return;

  let fyEnd = null;
  for (const key of METRIC_KEYS) {
    const end = res.out[key].values.get(years[last])?.end;
    if (end && (!fyEnd || end > fyEnd)) fyEnd = end;
  }
  if (!fyEnd) return;
  const cover = entries
    .filter((f) => ANNUAL_FORMS.has(f.form) && isNum(f.val) && f.val > 0 && f.end >= fyEnd
      && (Date.parse(f.filed) - Date.parse(fyEnd)) / DAY < 400)
    .sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : a.end < b.end ? 1 : -1))[0];
  if (!cover) return;

  const ni = raw.netIncome[last];
  const eps = raw.epsDiluted[last];
  if (isNum(ni) && isNum(eps) && Math.abs(eps) >= MIN_ABS_EPS_FOR_CHECK && ni / eps > 0) {
    const ratio = cover.val / (ni / eps);
    if (ratio < SHARES_OK_MIN || ratio > SHARES_OK_MAX) return; // implausible against EPS: don't use
  }
  raw.dilutedShares[last] = cover.val;
  quality.derived.push({
    metric: 'dilutedShares', year: years[last], value: cover.val,
    reason: `Derived from the cover-page shares outstanding (${cover.val.toLocaleString('en-US')} as of ${cover.end}), not the weighted-average diluted count`,
  });
}

// Plain-text lines for the company header's data-quality note.
function buildQualitySummary(quality, years) {
  const out = [];
  const label = { dilutedShares: 'diluted shares' };
  const name = (m) => label[m] || m.replace(/([A-Z])/g, ' $1').toLowerCase();

  const groups = new Map();
  for (const r of quality.rescaled) {
    const key = `${r.metric}|${r.factor}`;
    if (!groups.has(key)) groups.set(key, { metric: r.metric, factor: r.factor, years: [] });
    groups.get(key).years.push(r.year);
  }
  for (const g of groups.values()) {
    out.push(`${name(g.metric)} rescaled ${g.factor >= 1 ? '×' : '÷'}${(g.factor >= 1 ? g.factor : 1 / g.factor).toLocaleString('en-US')} for ${fmtYearRanges(g.years)} (the filing's value was off by that scale)`);
  }
  const nulls = new Map();
  for (const n of quality.nulled) {
    if (!nulls.has(n.metric)) nulls.set(n.metric, []);
    nulls.get(n.metric).push(n.year);
  }
  for (const [m, ys] of nulls) out.push(`${name(m)} N/A for ${fmtYearRanges(ys)} (disagreed with net income ÷ EPS)`);
  for (const d of quality.derived) out.push(`${name(d.metric)} for ${d.year} derived from the cover-page share count`);

  const fcfNa = Object.keys(quality.cellNotes.fcfPerShare || {}).map(Number);
  if (fcfNa.length) out.push(`FCF/share N/A for ${fmtYearRanges(fcfNa)} (hover the cell for why)`);
  return out;
}

// Long-term debt tags that already contain the current portion, so it must not be added again
const LTD_TAGS_INCLUDING_CURRENT = new Set(['LongTermDebt']);
// Extracted only to support another figure, so they don't count toward "metrics found"
const COVERAGE_EXCLUDE = new Set(['currentDebt', 'gainOnAssetSales', 'sharesOutstanding', 'dividendsPerShare']);

// Builds the metrics document stored in Neon and returned to the client.
// `extra` carries figures derived from the as-filed statements (see api/_statements.js):
//   statementCapex: Map(fiscalYear -> { value, lines }), statementWorkingCapital: Map(fiscalYear -> { label, amount })
export function buildMetrics(facts, extra = {}) {
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

  // Scale checks run on the extracted values, before any ratio is computed from them.
  const quality = { rescaled: [], nulled: [], derived: [], cellNotes: {}, summary: [] };
  checkDilutedShares(raw, years, quality);
  checkScaleOutliers(raw, years, quality);
  fillLatestSharesFromCoverPage(facts, res, raw, years, quality);
  const noteCell = (metric, year, text) => {
    quality.cellNotes[metric] = quality.cellNotes[metric] || {};
    if (!quality.cellNotes[metric][year]) quality.cellNotes[metric][year] = text;
  };
  for (const r of quality.rescaled) noteCell(r.metric, r.year, r.reason);
  for (const n of quality.nulled) noteCell(n.metric, n.year, n.reason);
  for (const d of quality.derived) noteCell(d.metric, d.year, d.reason);

  // Capex for years with no single capex tag: the as-filed statement (sees every investing line), else the
  // sum of standard capital-type XBRL tags. Where both exist the statement wins, because custom-tagged lines
  // (leasehold improvements, patents) never appear in companyfacts and would be silently missing from the sum.
  const capexMethod = years.map((_, i) => (raw.capex[i] !== null ? 'tag' : null));
  const money = (n) => Math.round(n).toLocaleString('en-US');
  years.forEach((fy, i) => {
    if (raw.capex[i] !== null) return;
    const st = extra.statementCapex?.get(fy);
    const parts = res.capexParts.get(fy);
    const partsSum = parts?.length ? parts.reduce((s, p) => s + p.value, 0) : null;
    if (st) {
      raw.capex[i] = st.value;
      capexMethod[i] = 'statement';
      let text = `Derived from as-filed statement: ${st.lines.map((l) => `${l.label} ${money(l.amount)}`).join('; ')}. Only capital-type investing lines are included; acquisitions, investment purchases and loans are not.`;
      if (partsSum !== null && Math.round(partsSum) !== Math.round(st.value)) text += ` (Standard XBRL tags alone would give ${money(partsSum)}.)`;
      noteCell('capex', fy, text);
    } else if (partsSum !== null) {
      raw.capex[i] = partsSum;
      capexMethod[i] = 'components';
      noteCell('capex', fy, `Derived from components: ${parts.map((p) => `${p.label} ${money(p.value)}`).join('; ')}. Standard XBRL tags only; custom-tagged lines would not be included.`);
    }
  });
  // No capex anywhere: no capex tag or component in any year, and the latest cash flow statement has an investing
  // section without a single property/equipment line (insurers, asset managers). Capex is then 0, so FCF = operating cash flow.
  const noneEver = extra.statementCapex?.noCapitalLines && raw.capex.every((v) => v === null) && !res.capexParts.size;
  if (noneEver) {
    years.forEach((fy, i) => {
      if (raw.capex[i] !== null || raw.operatingCashFlow[i] === null) return;
      raw.capex[i] = 0;
      capexMethod[i] = 'none';
      noteCell('capex', fy, 'No capex reported: the cash flow statement has no property or equipment purchases (only investment purchases, which are not capex), and no capex tag exists in any year. Treated as 0, so FCF = operating cash flow.');
      noteCell('fcf', fy, 'Equals operating cash flow (no capex reported). For insurers and asset managers, operating cash flow includes client and policyholder money, so it is not owner earnings.');
    });
  }
  const capexDerivedYears = (m) => years.filter((_, i) => capexMethod[i] === m);

  // Cost of revenue, SG&A and one-time gains for years where no tag provides them: read from the as-filed income
  // statement, by fixed label rules (see incomeFromStatement in _statements.js). A value with a real tag is never replaced.
  const incomeMethod = { costOfRevenue: years.map(() => null), sga: years.map(() => null), gainOnAssetSales: years.map(() => null), operatingIncome: years.map(() => null) };
  const lineText = (lines) => lines.map((l) => `${l.label} ${money(l.amount)}`).join('; ');
  years.forEach((fy, i) => {
    const st = extra.statementIncome?.get(fy);
    if (!st) return;
    if (raw.costOfRevenue[i] === null && raw.grossProfit[i] === null && st.cost) {
      raw.costOfRevenue[i] = st.cost.value;
      incomeMethod.costOfRevenue[i] = 'statement';
      noteCell('costOfRevenue', fy, `Derived from as-filed statement: ${lineText(st.cost.lines)}. Direct operating lines only (commissions, voyage, vessel operating and dry-docking expenses); depreciation, management fees, G&A and gains are excluded.${st.cost.skipped.length ? ` Not counted because already deducted in the revenue figure: ${lineText(st.cost.skipped)}.` : ''}`);
      noteCell('grossProfit', fy, 'Revenue minus cost of revenue, where cost of revenue is derived from the as-filed statement (hover the cost of revenue cell for the rows used)');
    }
    if (raw.sga[i] === null && st.sga) {
      raw.sga[i] = st.sga.value;
      incomeMethod.sga[i] = 'statement';
      noteCell('sga', fy, `Derived from as-filed statement: ${lineText(st.sga.lines)}. General and administrative plus management fees, including related-party fees.`);
    }
    if (raw.operatingIncome[i] === null && st.opIncome) {
      raw.operatingIncome[i] = st.opIncome.value;
      incomeMethod.operatingIncome[i] = 'statement';
      noteCell('operatingIncome', fy, `No operating income line is reported. Derived from as-filed statement: ${lineText(st.opIncome.lines)} (revenue minus total expenses).`);
    }
    if (raw.gainOnAssetSales[i] === null && st.gain) {
      raw.gainOnAssetSales[i] = st.gain.value;
      incomeMethod.gainOnAssetSales[i] = 'statement';
      noteCell('gainOnAssetSales', fy, `Derived from as-filed statement: ${lineText(st.gain.lines)}`);
    }
  });

  // Operating income for remaining years with no tag: revenue - total expenses (CostsAndExpenses / BenefitsLossesAndExpenses)
  years.forEach((fy, i) => {
    if (raw.operatingIncome[i] !== null || raw.revenue[i] === null || raw.totalExpenses[i] === null) return;
    raw.operatingIncome[i] = raw.revenue[i] - raw.totalExpenses[i];
    incomeMethod.operatingIncome[i] = 'tags';
    noteCell('operatingIncome', fy, `No operating income line is reported. Revenue ${money(raw.revenue[i])} minus total expenses ${money(raw.totalExpenses[i])} (${res.out.totalExpenses.values.get(fy)?.tag}).`);
  });

  // A tag-based gain/loss is used in ex-gains figures only when an as-filed row confirms it for that fiscal year:
  // an income statement row labeled as a gain/loss on sale, or the matching cash flow reconciliation row (a gain is a
  // negative adjustment there). Amount within 1% (against the sum of the rows or any single row) and same sign.
  // Gains read straight from as-filed rows are confirmed by construction.
  const GAIN_TOLERANCE = 0.01;
  const gainStatus = years.map(() => null); // 'statement' | 'income' | 'cashflow' | 'both' | 'unconfirmed' | null (no gain found)
  const gainConfirmNote = years.map(() => null);
  const matches = (ev, tag) => ev && [ev.value, ...ev.lines.map((l) => l.amount)].some((v) => Math.sign(v) === Math.sign(tag) && Math.abs(v - tag) <= GAIN_TOLERANCE * Math.abs(tag));
  const signText = (v) => (v >= 0 ? 'gain' : 'loss');
  years.forEach((fy, i) => {
    const tag = raw.gainOnAssetSales[i];
    if (tag === null) return;
    if (incomeMethod.gainOnAssetSales[i] === 'statement') { gainStatus[i] = 'statement'; return; }
    const ev = extra.gainEvidence?.get(fy);
    const okIncome = matches(ev?.income, tag);
    const okCash = matches(ev?.cashflow, tag);
    const seen = [];
    if (ev?.income) seen.push(`income statement ${ev.income.lines.map((l) => `${l.label} ${money(l.amount)}`).join('; ')} (reads as a ${signText(ev.income.value)})`);
    if (ev?.cashflow) seen.push(`cash flow ${ev.cashflow.lines.map((l) => `${l.label} ${money(-l.amount)}`).join('; ')} (an adjustment of ${money(-ev.cashflow.value)}, reads as a ${signText(ev.cashflow.value)})`);
    if (okIncome || okCash) {
      gainStatus[i] = okIncome && okCash ? 'both' : okIncome ? 'income' : 'cashflow';
      gainConfirmNote[i] = `Tag value ${money(tag)} (${signText(tag)}) confirmed by the as-filed ${okIncome && okCash ? 'income statement and cash flow statement' : okIncome ? 'income statement' : 'cash flow statement'}: ${seen.join('; ')}.`;
      noteCell('gainOnAssetSales', fy, gainConfirmNote[i]);
    } else {
      gainStatus[i] = 'unconfirmed';
      noteCell('gainOnAssetSales', fy, `Gain/loss tag found but not confirmed by the as-filed statement. Tag value ${money(tag)} (${signText(tag)}); ${seen.length ? `as-filed rows show: ${seen.join('; ')}` : 'no matching gain/loss row in the as-filed statements for this year'}. Not used in ex-gains figures.`);
    }
  });

  // Gross profit: use the reported figure; else revenue - cost of revenue (both reported).
  const grossProfit = years.map((_, i) => {
    if (raw.grossProfit[i] !== null) return raw.grossProfit[i];
    if (raw.revenue[i] !== null && raw.costOfRevenue[i] !== null) return raw.revenue[i] - raw.costOfRevenue[i];
    return null;
  });
  const grossProfitDerived = raw.grossProfit.every((v) => v === null) && grossProfit.some((v) => v !== null);

  const at = (key, i) => (i >= 0 ? raw[key][i] : null);
  const derived = {
    grossMargin: [], netMargin: [], operatingMargin: [], sgaPctGrossProfit: [], interestPctOperatingIncome: [],
    debtToEquity: [], longTermDebtYears: [], currentRatio: [], roe: [],
    fcf: [], fcfPerShare: [], bookValuePerShare: [], epsGrowth: [], netCash: [],
    totalDebt: [], totalDebtYears: [], totalDebtYearsExGains: [],
    operatingIncomeExGains: [], netIncomeExGains: [], netMarginExGains: [], roeExGains: [],
  };
  years.forEach((_, i) => {
    // Net cash (debt) = cash and equivalents - long-term debt - current portion of debt (when reported).
    // Derived; N/A whenever cash or long-term debt is missing, never assumed to be zero.
    const cashV = at('cash', i);
    const ltdV = at('longTermDebt', i);
    const curDebtV = at('currentDebt', i);
    const ltdTag = res.out.longTermDebt.values.get(years[i])?.tag;
    let netCash = null;
    if (cashV === null) {
      noteCell('netCash', years[i], 'Cash and cash equivalents are not reported for this year, so net cash cannot be computed');
    } else if (ltdV === null) {
      noteCell('netCash', years[i], 'Long-term debt is not reported for this year, so net cash cannot be computed');
    } else if (LTD_TAGS_INCLUDING_CURRENT.has(ltdTag)) {
      netCash = cashV - ltdV;
      noteCell('netCash', years[i], `Cash minus debt as tagged (${ltdTag} already includes the current portion)`);
    } else if (curDebtV === null || curDebtV < 0) {
      // A negative debt balance is not meaningful, so it is left out rather than netted against cash
      netCash = cashV - ltdV;
      noteCell('netCash', years[i], curDebtV === null
        ? 'Cash minus long-term debt. The current portion of debt is not reported for this year, so it is not included'
        : 'Cash minus long-term debt. The reported current portion of debt is negative, so it is not included');
    } else {
      netCash = cashV - ltdV - curDebtV;
    }
    derived.netCash.push(netCash);

    // Total debt = long-term debt + current portion. When the current portion is not reported, it is not
    // guessed: total debt then equals long-term debt, and the cell says so.
    let totalDebt = null;
    if (ltdV !== null) {
      if (LTD_TAGS_INCLUDING_CURRENT.has(ltdTag)) {
        totalDebt = ltdV;
        noteCell('totalDebt', years[i], `As tagged (${ltdTag} already includes the current portion)`);
      } else if (curDebtV === null) {
        totalDebt = ltdV;
        noteCell('totalDebt', years[i], 'The current portion of debt is not reported for this year, so total debt is long-term debt only');
      } else if (curDebtV < 0) {
        totalDebt = ltdV;
        noteCell('totalDebt', years[i], 'The reported current portion of debt is negative, so it is not included');
      } else {
        totalDebt = ltdV + curDebtV;
      }
    }
    derived.totalDebt.push(totalDebt);

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
    // Operating margin = operating income / revenue. N/A (with a reason) when either input is missing.
    const revV = at('revenue', i);
    if (opInc === null) {
      noteCell('operatingMargin', years[i], 'Operating income is not reported for this year (some filers, including many IFRS filers, do not report it), so operating margin is N/A');
    } else if (revV === null) {
      noteCell('operatingMargin', years[i], 'Revenue is not reported for this year, so operating margin is N/A');
    }
    derived.operatingMargin.push(opInc !== null && revV !== null ? round(div(opInc, revV)) : null);
    derived.sgaPctGrossProfit.push(gp !== null && gp > 0 ? round(div(at('sga', i), gp)) : null);
    derived.interestPctOperatingIncome.push(opInc !== null && opInc > 0 ? round(div(at('interestExpense', i), opInc)) : null);
    derived.debtToEquity.push(equity !== null && equity > 0 ? round(div(at('totalLiabilities', i), equity)) : null);
    derived.longTermDebtYears.push(ni !== null && ni > 0 ? round(div(at('longTermDebt', i), ni)) : null);
    derived.currentRatio.push(round(div(at('currentAssets', i), at('currentLiabilities', i))));
    derived.roe.push(equity !== null && equity > 0 ? round(div(ni, equity)) : null);
    derived.fcf.push(fcf);

    // One-time gains/losses on asset sales: simple subtraction, no tax adjustment. N/A (not the reported figure)
    // when no gain or loss figure was found for the year, so a company's own numbers are never mixed up with them.
    // A tag-based gain that no as-filed row confirms makes no adjustment at all.
    const gainRaw = at('gainOnAssetSales', i);
    const gainV = i >= 0 && gainStatus[i] !== 'unconfirmed' ? gainRaw : null;
    const gainFound = gainV !== null;
    const exNote = gainFound ? `Reported figure minus the ${gainV >= 0 ? 'gain' : 'loss'} on asset sales (${money(gainV)}). Simple subtraction, no tax adjustment.`
      : gainRaw !== null ? 'Gain/loss tag found but not confirmed by the as-filed statement' : null;
    const opExG = gainFound && opInc !== null ? opInc - gainV : null;
    const niExG = gainFound && ni !== null ? ni - gainV : null;
    derived.operatingIncomeExGains.push(opExG);
    derived.netIncomeExGains.push(niExG);
    derived.netMarginExGains.push(round(div(niExG, revV)));
    derived.roeExGains.push(equity !== null && equity > 0 ? round(div(niExG, equity)) : null);
    // Debt vs earnings on total debt, on reported and on ex-gains earnings
    derived.totalDebtYears.push(totalDebt !== null && ni !== null && ni > 0 ? round(div(totalDebt, ni)) : null);
    derived.totalDebtYearsExGains.push(gainFound && totalDebt !== null && niExG !== null && niExG > 0 ? round(div(totalDebt, niExG)) : null);
    if (exNote) for (const k of ['operatingIncomeExGains', 'netIncomeExGains', 'netMarginExGains', 'roeExGains', 'totalDebtYearsExGains']) noteCell(k, years[i], exNote);
    // Display-only flag: OCF moved by more than 50% and one working-capital line in the as-filed statement
    // is bigger than half of that move. No number is adjusted.
    const prevOcf = i > 0 ? raw.operatingCashFlow[i - 1] : null;
    const wc = extra.statementWorkingCapital?.get(years[i]);
    if (fcf !== null && ocf !== null && prevOcf !== null && prevOcf !== 0 && wc) {
      const change = ocf - prevOcf;
      if (Math.abs(change) / Math.abs(prevOcf) > 0.5 && Math.abs(wc.amount) > Math.abs(change) / 2) {
        noteCell('fcf', years[i], 'Operating cash flow includes a large working-capital swing; FCF may not be representative.');
      }
    }
    // FCF/share is N/A (with a reason) rather than a number that fails a sanity check
    const shares = at('dilutedShares', i);
    let fcfPerShare = null;
    if (fcf !== null) {
      if (!isNum(shares) || shares <= 0) {
        noteCell('fcfPerShare', years[i], quality.cellNotes.dilutedShares?.[years[i]] || 'Diluted share count is not available for this year, so FCF per share cannot be computed');
      } else {
        fcfPerShare = fcf / shares;
        if (isNum(eps) && eps > 0 && fcfPerShare > 10 * eps) {
          noteCell('fcfPerShare', years[i], `FCF per share would be ${fcfPerShare.toFixed(2)}, more than 10x diluted EPS (${eps}), which points to a data scale problem, so it is not shown`);
          fcfPerShare = null;
        }
      }
    }
    derived.fcfPerShare.push(round(fcfPerShare, 4));
    // Book value per share: shareholders' equity ÷ year-end shares outstanding (weighted diluted shares if not reported)
    const eqV = at('equity', i);
    const bvShares = at('sharesOutstanding', i) ?? shares;
    derived.bookValuePerShare.push(eqV !== null && bvShares > 0 ? round(eqV / bvShares, 4) : null);
    // Growth from a zero or negative base is "n/m" (not meaningful), not a missing value
    derived.epsGrowth.push(eps !== null && prevEps !== null
      ? (prevEps > 0 ? round((eps - prevEps) / prevEps) : 'n/m')
      : null);
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

  const coverageKeys = METRIC_KEYS.filter((k) => !COVERAGE_EXCLUDE.has(k));
  const found = coverageKeys.filter((k) => raw[k].some((v) => v !== null));
  const found2 = grossProfitDerived && !found.includes('grossProfit') ? [...found, 'grossProfit'] : found;
  const tags = {};
  for (const key of METRIC_KEYS) tags[key] = res.out[key].tags;

  quality.summary = buildQualitySummary(quality, years);
  const byStatement = capexDerivedYears('statement');
  const byComponents = capexDerivedYears('components');
  for (const [key, label] of [['costOfRevenue', 'cost of revenue'], ['sga', 'SG&A'], ['gainOnAssetSales', 'gains on asset sales']]) {
    const ys = years.filter((_, i) => incomeMethod[key][i] === 'statement');
    if (ys.length) quality.summary.push(`${label} for ${fmtYearRanges(ys)} derived from the as-filed statement (other years N/A: custom-tagged lines are not in the XBRL data)`);
  }
  if (byStatement.length) quality.summary.push(`capex for ${fmtYearRanges(byStatement)} derived from the as-filed statement`);
  if (byComponents.length) quality.summary.push(`capex for ${fmtYearRanges(byComponents)} derived from components`);
  const byNone = capexDerivedYears('none');
  if (byNone.length) quality.summary.push(`no capex reported for ${fmtYearRanges(byNone)} (no property or equipment purchases), so capex is 0 and FCF = operating cash flow`);
  const opDerived = years.filter((_, i) => incomeMethod.operatingIncome[i]);
  if (opDerived.length) quality.summary.push(`operating income for ${fmtYearRanges(opDerived)} is revenue minus total expenses (no operating income line reported)`);

  return {
    dataVersion: DATA_VERSION,
    capexMethod,
    incomeMethod,
    gainStatus,
    // A year with no debt tag of any kind and no interest expense shows "None reported" and passes the
    // debt-vs-earnings rule. A year with either one stays N/A.
    debt: {
      noDebtYears: years.map((fy, i) => raw.longTermDebt[i] === null && raw.currentDebt[i] === null
        && !res.debtYears.has(fy) && raw.interestExpense[i] === null),
    },
    taxonomy,
    currency: res.currency,
    quality,
    years,
    raw: { ...raw, grossProfit },
    grossProfitDerived,
    derived,
    fcfCagr,
    fcfCagrSpan: fcfIdx.length >= 2 ? [years[fcfIdx[0]], years[fcfIdx[fcfIdx.length - 1]]] : null,
    tags,
    coverage: {
      found: found2.length,
      total: coverageKeys.length,
      missing: coverageKeys.filter((k) => !found2.includes(k)),
    },
  };
}

// ---------- Filing text extraction (for the Story tab) ----------

const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

export const SECTION_CAPS = { business: 30000, risk_factors: 30000, mdna: 40000, segments: 12000 };
export const SECTION_KEYS = Object.keys(SECTION_CAPS);

export const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;
export const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Most recent 10-K / 40-F / 20-F for a CIK, or null.
export async function findLatestAnnualFiling(cik) {
  return findLatestFiling(cik, ANNUAL_FORMS);
}

// IPO prospectus forms, newest first in SEC's list: the final prospectus (424B4) or the registration statement
const PROSPECTUS_FORMS = new Set(['424B4', '424B1', 'S-1/A', 'S-1', 'F-1/A', 'F-1']);
export async function findLatestProspectus(cik) {
  return findLatestFiling(cik, PROSPECTUS_FORMS);
}

async function findLatestFiling(cik, forms) {
  if (!CIK_RE.test(cik)) throw new Error('invalid cik');
  const padded = cik.padStart(10, '0');
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`);
  if (!res.ok) throw new Error(`SEC submissions request failed with status ${res.status}`);
  const sub = await res.json();
  const rc = sub?.filings?.recent;
  if (!rc) return null;
  const i = rc.form.findIndex((f) => forms.has(f));
  if (i < 0) return null;
  const accession = rc.accessionNumber[i];
  const primaryDocument = rc.primaryDocument[i];
  // Links are built only from values SEC returned, and only if they have the expected shape
  if (!ACCESSION_RE.test(accession) || !DOC_NAME_RE.test(primaryDocument || '')) return null;
  const base = `${ARCHIVES}/${parseInt(padded, 10)}/${accession.replace(/-/g, '')}`;
  return {
    // IPO prospectuses aren't inline XBRL, so they open as plain documents
    viewerUrl: forms === ANNUAL_FORMS ? `https://www.sec.gov/ix?doc=${new URL(`${base}/${primaryDocument}`).pathname}` : `${base}/${primaryDocument}`,
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
// Tolerates the common layouts: "Item 1. Business", "ITEM 1—BUSINESS", "Item1.", "PART I – ITEM 1. BUSINESS",
// and a heading split over lines ("ITEM" / "1." / "BUSINESS"), which some filings' HTML produces.
const ITEM_HEAD = /^(?:part\s+[ivx]+\s*[,.:\u2013\u2014-]?\s*)?item\s*(1a|1b|1c|1|2|3|4|5|6|7a|7|8|9a|9b|9c|9|10|11|12|13|14|15|16)(?=$|[\s.:\u2013\u2014)\-])/i;

// The line itself, or (for a short fragment like "ITEM" or "ITEM 1.") the line joined with the next one or two
function headingText(lines, idx) {
  const line = lines[idx];
  if (line.length >= 20) return line;
  let joined = line;
  for (let k = 1; k <= 2 && idx + k < lines.length && joined.length < 40; k++) joined += ` ${lines[idx + k]}`;
  return joined;
}

function findItemHeads(lines) {
  const heads = [];
  lines.forEach((line, idx) => {
    if (line.length >= 200) return;
    const m = headingText(lines, idx).match(ITEM_HEAD);
    if (m) heads.push({ idx, id: m[1].toLowerCase(), text: line });
  });
  return heads;
}

function itemExtractor(lines) {
  const heads = findItemHeads(lines);
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
  business: /^(?:item\s*1\.?\s*[\u2013\u2014:-]?\s*business\s*$|(?:item\s+\d+[a-z]?\.?\s*)?(?:\d+\.?\s*)?(?:description\s+of\s+the\s+business|general\s+development\s+of\s+the\s+business|business\s+overview|our\s+business|the\s+business|business\s+of\s+the\s+company)\b[^.]{0,60}$)/i,
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
// diagnose: also return the heading-like lines the 10-K parser saw (for the free /api/sections check)
export async function extractFilingSections(cik, { diagnose = false } = {}) {
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
    // Fallback when no "Item 1" heading is recognized: the best-scoring "Business" heading
    if (sections.business.status !== 'found') {
      const t = extractByKeyword(lines, 'business', SECTION_CAPS.business);
      if (t) set('business', t, 'Business (heading search)');
    }
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
    if (diagnose) {
      const heads = findItemHeads(lines).map((h) => ({ line: h.idx, item: h.id, text: h.text.slice(0, 120) }));
      const unmatched = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.length < 160 && /\bitem\b/i.test(l))
        .filter(({ i }) => !heads.some((h) => h.line === i))
        .slice(0, 40)
        .map(({ l, i }) => ({ line: i, text: l.slice(0, 120) }));
      return { filing, sections, diagnostics: { totalLines: lines.length, recognizedHeadings: heads.slice(0, 80), otherLinesMentioningItem: unmatched } };
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
