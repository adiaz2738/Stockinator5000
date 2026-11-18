// Screener rules engine (no DOM, so it can be tested on its own). Rows come from /api/screener?action=data:
// [ticker, name, cik, gm[], nm[], sga[], int[], de[], ltd[], eps[], roe[], cr[], reUp[], rev[]] with one value per year.

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
];
export const FIELD_INDEX = { gm: 3, nm: 4, sga: 5, int: 6, de: 7, ltd: 8, eps: 9, roe: 10, cr: 11, reUp: 12, rev: 13 };

export function defaultSettings() {
  const rules = {};
  for (const r of RULES) rules[r.key] = { on: r.core, value: r.def };
  return { rules, minPass: 6, missing: 'skip', hold: 4 };
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

// 'pass' | 'fail' | 'missing' for one rule on one company row
export function evaluate(rule, series, threshold, hold) {
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

// Screens every company; returns [{ row, results: {key: status}, passed, counted }] for those that qualify
export function screen(rows, settings) {
  const active = RULES.filter((r) => settings.rules[r.key]?.on);
  const out = [];
  if (!active.length) return out;
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
    if (counted < Math.max(1, Math.ceil(active.length * 0.6))) continue;
    if (passed < Math.min(settings.minPass, counted)) continue;
    out.push({ row, results, passed, counted });
  }
  return out;
}
