// Screener rules engine (no DOM, so it can be tested on its own). Rows come from /api/screener?action=data:
// [ticker, name, cik, gm[], nm[], sga[], int[], de[], ltd[], eps[], roe[], cr[], reUp[], rev[], sh, eq] with one value per year (sh and eq: latest diluted shares and equity only).

export const RULES = [
  { key: 'gm', label: 'Gross margin', op: '>=', def: 0.40, fmt: 'pct', core: true, help: 'Gross profit ÷ revenue' },
  { key: 'nm', label: 'Net margin', op: '>=', def: 0.20, fmt: 'pct', core: true, help: 'Net income ÷ revenue' },
  { key: 'sga', label: 'SG&A of gross profit', op: '<=', def: 0.30, fmt: 'pct', core: true, help: 'SG&A ÷ gross profit' },
  { key: 'int', label: 'Interest of op. income', op: '<=', def: 0.15, fmt: 'pct', core: true, help: 'Interest expense ÷ operating income' },
  { key: 'de', label: 'Debt / equity', op: '<=', def: 0.80, fmt: 'x', core: true, help: 'Total liabilities ÷ shareholders’ equity' },
  { key: 'ltd', label: 'LT debt in yrs of earnings', op: '<=', def: 4, fmt: 'yrs', core: true, help: 'Long-term debt ÷ net income' },
  { key: 'eps', label: 'EPS: no loss years', op: 'noloss', def: null, fmt: 'eps', core: true, help: 'Diluted EPS above zero in every year with data (needs 3+ years)' },
  { key: 'roe', label: 'ROE', op: '>=', def: 0.25, fmt: 'pct', core: false, help: 'Net income ÷ shareholders’ equity' },
  { key: 'cr', label: 'Current ratio', op: '>', def: 1.0, fmt: 'x', core: false, help: 'Current assets ÷ current liabilities' },
  { key: 'reUp', label: 'Retained earnings rising', op: 'up', def: null, fmt: 'up', core: false, help: 'Retained earnings up year over year' },
  { key: 'revGrowth', label: 'Revenue growth / yr', op: 'cagr', def: 0.05, fmt: 'cagr', core: false, help: 'Average yearly revenue growth from the first to the latest year with revenue (needs 3+ years apart)' },
];
export const FIELD_INDEX = { gm: 3, nm: 4, sga: 5, int: 6, de: 7, ltd: 8, eps: 9, roe: 10, cr: 11, reUp: 12, rev: 13, sh: 14, eq: 15, revGrowth: 13 };

export function defaultSettings() {
  const rules = {};
  for (const r of RULES) rules[r.key] = { on: r.core, value: r.def };
  return { rules, minPass: 6, missing: 'skip', hold: 4, filters: defaultFilters() };
}

// Industry and valuation filters. Nothing is excluded by default.
// ranges: [min, max] per market figure, null = no limit on that side. Market cap is in dollars.
export const RANGE_KEYS = ['mcap', 'pe', 'pb', 'ps', 'price'];
// Industry filter: SIC codes, either "only these" (include) or "all but these" (exclude). Empty = every industry.
export function defaultFilters() {
  const ranges = {};
  for (const k of RANGE_KEYS) ranges[k] = [null, null];
  return { ind: { mode: 'include', sics: [] }, ranges, buyZoneOnly: false };
}
export const BIOTECH_SICS = [2833, 2834, 2835, 2836, 8731];

// SIC codes. Biotech / pharma: medicinal chemicals, pharmaceutical preparations, diagnostics, biological products,
// and commercial biological research. Financials: banks, credit, brokers, insurance and investment firms (6000-6499,
// 6700-6799), except REITs (6798), which are real estate.
export const isBiotech = (sic) => [2833, 2834, 2835, 2836, 8731].includes(sic);
export const isFinancial = (sic) => Number.isInteger(sic) && ((sic >= 6000 && sic <= 6499) || (sic >= 6700 && sic <= 6799 && sic !== 6798));

// Market data per company row: price, market cap (price x latest diluted shares), P/E (price / latest diluted EPS),
// P/B (market cap / latest equity), P/S (market cap / latest revenue), buy zone against the latest saved buy-below
// price. null where it can't be computed; -1 = negative earnings or equity (never passes a range).
export function marketFigures(row, price, buyBelow) {
  const p = Number.isFinite(price) ? price : null;
  const one = (v) => (Array.isArray(v) ? latest(v) : Number.isFinite(v) ? v : null);
  const shares = one(row[FIELD_INDEX.sh]);
  const eps = latest(row[FIELD_INDEX.eps]);
  const bb = Number.isFinite(buyBelow) && buyBelow > 0 ? buyBelow : null;
  const mcap = p !== null && shares > 0 ? p * shares : null;
  const equity = one(row[FIELD_INDEX.eq]);
  const rev = latest(row[FIELD_INDEX.rev]);
  return {
    price: p,
    mcap,
    pe: p !== null && eps !== null ? (eps > 0 ? p / eps : -1) : null,
    pb: mcap !== null && equity !== null ? (equity > 0 ? mcap / equity : -1) : null,
    ps: mcap !== null && rev !== null && rev > 0 ? mcap / rev : null,
    buyBelow: bb,
    zone: p !== null && bb !== null ? (p <= bb ? 'below' : 'above') : null,
    zoneDist: p !== null && bb !== null ? (p - bb) / bb : null,
  };
}

// Applies the industry and valuation filters. info(row) -> { sic, desc, m: marketFigures } (sic undefined = not looked
// up yet: kept until known). A valuation filter drops companies without a price.
export function applyFilters(items, f, info) {
  return items.filter((it) => {
    const { sic, m } = info(it.row);
    const sics = f.ind?.sics || [];
    if (sics.length) {
      // not looked up yet: hidden by "only these", kept by "all but these"
      const code = sic === undefined ? undefined : sic ?? -1;
      if (f.ind.mode === 'include' && (code === undefined || !sics.includes(code))) return false;
      if (f.ind.mode === 'exclude' && code !== undefined && sics.includes(code)) return false;
    }
    for (const k of RANGE_KEYS) {
      const [lo, hi] = f.ranges?.[k] || [null, null];
      if (lo === null && hi === null) continue;
      const v = m[k];
      if (v === null || v < 0) return false;
      if (lo !== null && v < lo) return false;
      if (hi !== null && v > hi) return false;
    }
    if (f.buyZoneOnly && m.zone !== 'below') return false;
    return true;
  });
}

const meets = (rule, v, threshold) => {
  if (v === null || v === undefined) return null;
  switch (rule.op) {
    case '>=': return v >= threshold;
    case '>': return v > threshold;
    case '<=': return v <= threshold;
    case 'up': return v === 1;
    default: return null;
  }
};

// Compound yearly growth from the first to the last value in a yearly series; null with fewer than 3 years between
// them or a zero/negative start or end
export function cagrOf(series) {
  if (!Array.isArray(series)) return null;
  let a = -1;
  let b = -1;
  for (let i = 0; i < series.length; i++) if (series[i] !== null && series[i] !== undefined) { if (a < 0) a = i; b = i; }
  if (a < 0 || b - a < 3 || !(series[a] > 0) || !(series[b] > 0)) return null;
  return Math.pow(series[b] / series[a], 1 / (b - a)) - 1;
}

// 'pass' | 'fail' | 'missing' for one rule on one company row
export function evaluate(rule, series, threshold, hold) {
  if (rule.op === 'cagr') {
    const g = cagrOf(series);
    return g === null ? 'missing' : g >= threshold ? 'pass' : 'fail';
  }
  const vals = Array.isArray(series) ? series : [];
  const have = vals.filter((v) => v !== null && v !== undefined);
  if (rule.op === 'noloss') {
    if (have.length < 3) return 'missing';
    return have.every((v) => v > 0) ? 'pass' : 'fail';
  }
  if (!have.length) return 'missing';
  const passes = vals.filter((v) => meets(rule, v, threshold) === true).length;
  const required = Math.min(hold, have.length);
  return passes >= required ? 'pass' : 'fail';
}

export const latest = (series) => {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i--) if (series[i] !== null && series[i] !== undefined) return series[i];
  return null;
};

// Screens every company; returns [{ row, results: {key: status}, passed, counted, qualifies }] for those that qualify.
// With { all: true } every company is returned, scored, with qualifies false for those that don't pass (search).
export function screen(rows, settings, { all = false } = {}) {
  const active = RULES.filter((r) => settings.rules[r.key]?.on);
  const out = [];
  // No rules on: every company (a plain screener on the industry and valuation filters)
  if (!active.length) return rows.map((row) => ({ row, results: {}, passed: 0, counted: 0, qualifies: true }));
  for (const row of rows) {
    const results = {};
    let passed = 0;
    let missing = 0;
    for (const rule of active) {
      const st = evaluate(rule, row[FIELD_INDEX[rule.key]], settings.rules[rule.key].value, settings.hold);
      results[rule.key] = st;
      if (st === 'pass') passed++;
      else if (st === 'missing') missing++;
    }
    const counted = settings.missing === 'skip' ? active.length - missing : active.length;
    // Too little reported data to judge: it must be measurable on at least 60% of the active rules (5 of 7)
    const qualifies = counted >= Math.max(1, Math.ceil(active.length * 0.6)) && passed >= Math.min(settings.minPass, counted);
    if (qualifies || all) out.push({ row, results, passed, counted, qualifies });
  }
  return out;
}
