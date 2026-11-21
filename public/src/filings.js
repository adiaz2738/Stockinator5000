import { renderStoryPane } from './story.js';
import { renderNewsPane } from './news.js';
import { renderStatementsPane, secLink, fmtFilingDate } from './statements.js';
import { mountChartView } from './chart-view.js';
import { NO_DATA_MESSAGE } from './chart-data.js';
import { addToWatchlist } from './watchlist.js';
import { latestValuation } from './latest-valuation.js';

export const FILINGS_PREFILL_KEY = 'filingsPrefill';
const REVERSE_PREFILL_KEY = 'reversePrefill';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NA = 'N/A';
const NONE_REPORTED = 'None reported';

// Last loaded company, so switching tabs doesn't throw the page away.
let lastLoaded = null;
let activeSubTab = 'metrics';

// ---------- DOM helpers (user/API text always goes through textContent) ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- Formatting ----------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function fmtCompact(n, currency) {
  if (!isNum(n)) return NA;
  const abs = Math.abs(n);
  const prefix = !currency || currency === 'USD' ? '$' : `${currency} `;
  let s;
  if (abs >= 1e12) s = `${(abs / 1e12).toFixed(2)}T`;
  else if (abs >= 1e9) s = `${(abs / 1e9).toFixed(2)}B`;
  else if (abs >= 1e6) s = `${(abs / 1e6).toFixed(1)}M`;
  else if (abs >= 1e3) s = `${(abs / 1e3).toFixed(1)}K`;
  else s = abs.toFixed(2);
  return `${n < 0 ? '-' : ''}${prefix}${s}`;
}

function fmtShares(n) {
  if (!isNum(n)) return NA;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n.toFixed(0);
}

const fmtPct = (v) => (isNum(v) ? `${(v * 100).toFixed(1)}%` : NA);
const fmtRatio = (v) => (isNum(v) ? v.toFixed(2) : NA);
const fmtYears = (v) => (isNum(v) ? `${v.toFixed(1)} yrs` : NA);
const fmtPerShare = (currency) => (v) => {
  if (!isNum(v)) return NA;
  const prefix = !currency || currency === 'USD' ? '$' : `${currency} `;
  return `${v < 0 ? '-' : ''}${prefix}${Math.abs(v).toFixed(2)}`;
};

// ---------- Scorecard ----------

const MIN_CONSISTENCY_POINTS = 5;
const CONSISTENCY_PASS_RATE = 0.75;

function yearly(values, test) {
  return values.map((value) => (isNum(value) ? { value, pass: test(value) } : { value: null, pass: null }));
}

const EX_GAINS_TIP = 'Pass/fail uses the ex-gains value (reported figure minus gains or losses on asset sales, no tax adjustment) in any year where such a gain or loss was found. The as-reported value is shown underneath.';

// Like yearly(), but the figure that is judged is the ex-gains one whenever it exists for the year.
// The as-reported figure rides along for display.
function yearlyEx(reported, exGains, test, gainStatus) {
  return reported.map((rep, i) => {
    const ex = exGains?.[i];
    const useEx = isNum(ex);
    const value = useEx ? ex : rep;
    if (!isNum(value)) return { value: null, pass: null };
    return { value, pass: test(value), adj: useEx, unconfirmed: gainStatus?.[i] === 'unconfirmed', reported: isNum(rep) ? rep : null };
  });
}
const UNCONFIRMED_NOTE = 'gain tag not confirmed; reported value used';

function buildRules(m) {
  const r = m.raw;
  const d = m.derived;

  // Total debt (long-term + current portion) against earnings; earnings are ex-gains whenever a gain or loss was found
  const ltDebtYears = d.totalDebt.map((debt, i) => {
    const exEarnings = d.netIncomeExGains?.[i];
    const adj = isNum(exEarnings);
    const earnings = adj ? exEarnings : r.netIncome[i];
    const reported = d.totalDebtYears[i];
    // No debt tag anywhere and no interest expense that year: shown as "None reported" and passes
    if (m.debt?.noDebtYears?.[i]) return { value: null, pass: true, note: NONE_REPORTED };
    if (!isNum(debt) || !isNum(earnings)) return { value: null, pass: null };
    const unconfirmed = m.gainStatus?.[i] === 'unconfirmed';
    if (debt <= 0) return { value: 0, pass: true };
    if (earnings <= 0) return { value: null, pass: false, note: 'Loss', adj, unconfirmed, reported: isNum(reported) ? reported : null };
    const years = debt / earnings;
    return { value: years, pass: years <= 4, adj, unconfirmed, reported: isNum(reported) ? reported : null };
  });

  const epsGrowth = yearly(d.epsGrowth, (g) => g > 0);
  // Any loss year (EPS of zero or less) in the window fails the consistency rule outright
  const lossYears = m.years.filter((_, i) => isNum(r.epsDiluted[i]) && r.epsDiluted[i] <= 0);
  const epsOverride = lossYears.length
    ? { pass: false, note: `loss year in window: ${lossYears[lossYears.length - 1]}`, tip: `Years with EPS of zero or less: ${lossYears.join(', ')}. One loss year in the window fails this rule; growth from a zero or negative base shows as n/m.` }
    : null;
  const reRising = r.retainedEarnings.map((re, i) => {
    const prev = i > 0 ? r.retainedEarnings[i - 1] : null;
    if (!isNum(re) || !isNum(prev)) return { value: null, pass: null };
    return { value: re, pass: re > prev };
  });

  const core = [
    { label: 'Gross margin ≥ 40%', fmt: fmtPct, series: yearly(d.grossMargin, (v) => v >= 0.4) },
    { label: 'Net margin ≥ 20%', fmt: fmtPct, tip: EX_GAINS_TIP, series: yearlyEx(d.netMargin, d.netMarginExGains, (v) => v >= 0.2, m.gainStatus) },
    { label: 'SG&A ≤ 30% of gross profit', fmt: fmtPct, series: yearly(d.sgaPctGrossProfit, (v) => v <= 0.3) },
    { label: 'Interest ≤ 15% of operating income', fmt: fmtPct, series: yearly(d.interestPctOperatingIncome, (v) => v <= 0.15) },
    { label: 'Debt-to-equity ≤ 0.80', fmt: fmtRatio, series: yearly(d.debtToEquity, (v) => v <= 0.8) },
    { label: 'Long-term debt ≤ 4 years of earnings', fmt: fmtYears, tip: `Uses total debt (long-term debt plus the current portion, when reported) divided by earnings. ${EX_GAINS_TIP}`, series: ltDebtYears },
    { label: 'Consistent EPS growth', fmt: fmtPct, series: epsGrowth, consistency: true, override: epsOverride, tip: epsOverride?.tip },
  ];
  const optional = [
    { label: 'Operating margin (informational)', fmt: fmtPct, info: true, series: d.operatingMargin.map((value) => ({ value: isNum(value) ? value : null, pass: null })) },
    { label: 'ROE ≥ 25%', fmt: fmtPct, tip: EX_GAINS_TIP, series: yearlyEx(d.roe, d.roeExGains, (v) => v >= 0.25, m.gainStatus) },
    { label: 'Current ratio > 1', fmt: fmtRatio, series: yearly(d.currentRatio, (v) => v > 1) },
    { label: 'Retained earnings rising', fmt: (v) => fmtCompact(v, m.currency), series: reRising, consistency: true },
  ];
  return { core, optional };
}

// Latest-year verdict (or consistency verdict) plus the count of passing years.
function evaluate(rule) {
  const withData = rule.series.filter((s) => s.pass !== null);
  const passed = withData.filter((s) => s.pass).length;
  const latest = rule.series[rule.series.length - 1];
  if (rule.override) return { pass: rule.override.pass, passed, total: withData.length, latest: { value: null, pass: rule.override.pass, note: rule.override.note } };
  let pass = null;
  if (rule.consistency) {
    if (withData.length >= MIN_CONSISTENCY_POINTS) pass = passed / withData.length >= CONSISTENCY_PASS_RATE;
  } else if (latest) {
    pass = latest.pass;
  }
  return { pass, passed, total: withData.length, latest };
}

function pill(pass) {
  if (pass === null) return el('span', { class: 'pill pill-na', text: NA });
  return el('span', { class: `pill ${pass ? 'pill-pass' : 'pill-fail'}`, text: pass ? 'PASS' : 'FAIL' });
}

// Informational rule: no threshold, so no pass/fail. Shows the latest value and the first-to-latest trend.
function infoRow(rule) {
  const pts = rule.series.map((s, i) => ({ v: s.value, i })).filter((p) => isNum(p.v));
  const latest = rule.series[rule.series.length - 1];
  const latestText = latest && isNum(latest.value) ? rule.fmt(latest.value) : NA;
  let trend = NA;
  if (pts.length >= 2) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dir = last.v > first.v ? '↑' : last.v < first.v ? '↓' : '→';
    trend = `${rule.fmt(first.v)} ${dir} ${rule.fmt(last.v)} (${pts.length} yrs)`;
  } else if (pts.length === 1) {
    trend = '1 yr of data';
  }
  return el('div', { class: 'rule-row' }, [
    el('div', { class: 'rule-label', text: rule.label, attrs: { title: 'No pass/fail threshold: shown for context only' } }),
    el('div', { class: `rule-value mono${latestText === NA ? ' na' : ''}`, text: latestText }),
    el('span', { class: 'pill pill-na', text: 'INFO' }),
    el('div', { class: 'rule-years mono', text: trend }),
  ]);
}

function ruleRow(rule) {
  if (rule.info) return infoRow(rule);
  const ev = evaluate(rule);
  const latestText = ev.latest?.note ?? (ev.latest && isNum(ev.latest.value) ? rule.fmt(ev.latest.value) : NA);
  // When the judged figure is the ex-gains one, say so and show the as-reported figure underneath
  const adj = ev.latest?.adj === true && !ev.latest.note;
  const valueCell = el('div', { class: `rule-value mono${latestText === NA ? ' na' : ''}` }, [
    adj ? `${latestText} ex-gains` : latestText,
    adj ? el('div', { class: 'rule-sub', text: `${isNum(ev.latest.reported) ? rule.fmt(ev.latest.reported) : NA} as reported` }) : null,
    ev.latest?.unconfirmed && !adj ? el('div', { class: 'rule-sub', text: UNCONFIRMED_NOTE, attrs: { title: 'Gain/loss tag found but not confirmed by the as-filed statement' } }) : null,
  ]);
  return el('div', { class: 'rule-row' }, [
    el('div', { class: 'rule-label', text: rule.label, attrs: rule.tip ? { title: rule.tip } : {} }),
    valueCell,
    pill(ev.pass),
    el('div', { class: 'rule-years mono', text: ev.total ? `${ev.passed}/${ev.total} yrs` : NA }),
  ]);
}

function scorecardCard(m) {
  const { core, optional } = buildRules(m);
  const passCount = core.filter((r) => evaluate(r).pass === true).length;
  const scoredCount = core.filter((r) => evaluate(r).pass !== null).length;

  const head = el('div', { class: 'rule-head' }, [
    el('span', { text: 'Rule' }), el('span', { text: 'Latest' }), el('span', { text: 'Result' }), el('span', { text: 'Last 10 yrs' }),
  ]);
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: 'Screener Scorecard' }),
    el('div', { class: 'score-summary mono', text: `${passCount} of ${core.length} core rules passed${scoredCount < core.length ? ` (${core.length - scoredCount} not scored: N/A)` : ''}` }),
    head,
    ...core.map(ruleRow),
    el('div', { class: 'section-label sub', text: 'Optional Rules' }),
    ...optional.map(ruleRow),
  ]);
}

// ---------- 10-year table ----------

function tableCard(m) {
  const c = m.currency;
  const r = m.raw;
  const d = m.derived;
  const money = (v) => fmtCompact(v, c);
  const groups = [
    ['Income Statement', [
      ['Revenue', r.revenue, money], ['Cost of revenue', r.costOfRevenue, money],
      [m.grossProfitDerived ? 'Gross profit (revenue − cost)' : 'Gross profit', r.grossProfit, money],
      ['SG&A', r.sga, money], ['R&D', r.rnd, money], ['Depreciation', r.depreciation, money],
      ['Operating income', r.operatingIncome, money],
      ['Non-recurring gains/(losses) on asset sales', r.gainOnAssetSales, money, 'Gain (positive) or loss (negative) on selling assets such as vessels or property, from the XBRL tag or, if there is none, from an as-filed statement row labeled gain/loss on sale. Hover a cell for its source.'],
      ['Operating income ex-gains', d.operatingIncomeExGains, money, 'Operating income minus the gain on asset sales. Simple subtraction, no tax adjustment. N/A when no gain or loss figure was found for the year.'],
      ['Interest expense', r.interestExpense, money],
      ['Net income', r.netIncome, money],
      ['Net income ex-gains', d.netIncomeExGains, money, 'Net income minus the gain on asset sales. Simple subtraction, no tax adjustment. N/A when no gain or loss figure was found for the year.'],
      ['EPS (diluted)', r.epsDiluted, fmtPerShare(c)],
      ['Dividends / share', r.dividendsPerShare || [], fmtPerShare(c), 'Common dividends declared (or paid) per share, as tagged by the company'],
      ['Diluted shares', r.dilutedShares, fmtShares],
    ]],
    ['Balance Sheet', [
      ['Cash and cash equivalents', r.cash, money],
      ['Short-term investments', r.shortTermInvestments, money, 'Short-term investments / marketable securities, as tagged by the company'],
      ['Net cash (debt), derived', d.netCash, money, 'Derived: cash and cash equivalents minus long-term debt, minus the current portion of debt where the company reports it (cells say when it is missing). Short-term investments are not counted. N/A when cash or long-term debt is not reported.'],
      ['Total assets', r.totalAssets, money],
      ['Total current assets', r.currentAssets, money], ['Total current liabilities', r.currentLiabilities, money],
      ['Total liabilities', r.totalLiabilities, money], ["Shareholders' equity", r.equity, money],
      ['Long-term debt', r.longTermDebt, money],
      ['Current portion of long-term debt', r.currentDebt, money, 'Debt due within a year, as tagged by the company'],
      ['Total debt', d.totalDebt, money, 'Long-term debt plus the current portion. If the current portion is not reported for a year, total debt equals long-term debt only (the cell says so).'],
      ['Retained earnings', r.retainedEarnings, money],
      ['Book value / share', d.bookValuePerShare || [], fmtPerShare(c), "Shareholders' equity ÷ year-end shares outstanding (weighted diluted shares when the year-end count isn't reported)"],
      ['Net receivables', r.netReceivables, money],
    ]],
    ['Cash Flow', [
      ['Operating cash flow', r.operatingCashFlow, money], ['Capex', r.capex, money],
      ['Free cash flow', d.fcf, money], ['FCF / share', d.fcfPerShare, fmtPerShare(c)],
    ]],
    ['Ratios', [
      ['Gross margin', d.grossMargin, fmtPct], ['Net margin', d.netMargin, fmtPct],
      ['Net margin ex-gains', d.netMarginExGains, fmtPct, 'Net income ex-gains divided by revenue. N/A when no gain or loss figure was found for the year.'],
      ['Operating margin', d.operatingMargin, fmtPct, 'Operating income ÷ revenue. N/A when either is not reported; filers that report no operating income (e.g. many IFRS filers such as Barrick) stay N/A.'],
      ['SG&A % of gross profit', d.sgaPctGrossProfit, fmtPct], ['Interest % of operating income', d.interestPctOperatingIncome, fmtPct],
      ['Debt-to-equity', d.debtToEquity, fmtRatio], ['Long-term debt / earnings', d.longTermDebtYears, fmtYears, 'Long-term debt only (no current portion) divided by reported net income'],
      ['Total debt / earnings', d.totalDebtYears, fmtYears, 'Total debt divided by reported net income'],
      ['Total debt / earnings ex-gains', d.totalDebtYearsExGains, fmtYears, 'Total debt divided by net income ex-gains. The scorecard rule uses this figure whenever it exists.'],
      ['Current ratio', d.currentRatio, fmtRatio], ['ROE', d.roe, fmtPct], ['ROE ex-gains', d.roeExGains, fmtPct, 'Net income ex-gains divided by shareholders equity'], ['EPS growth', d.epsGrowth, fmtPct, 'n/m means growth from a zero or negative EPS, which is not meaningful'],
    ]],
  ];

  // Which metric a row shows, found by the series it was built from (used to look up data-quality notes)
  const keyOfSeries = new Map();
  for (const [k, series] of Object.entries(r)) keyOfSeries.set(series, k);
  for (const [k, series] of Object.entries(d)) keyOfSeries.set(series, k);

  // Display order only: newest fiscal year first. The stored series stay oldest to newest.
  const newestFirst = m.years.map((_, i) => i).reverse();

  const thead = el('thead', {}, el('tr', {}, [
    el('th', { text: 'Fiscal year' }),
    ...newestFirst.map((i) => el('th', { text: String(m.years[i]) })),
  ]));
  const tbody = el('tbody');
  for (const [title, rows] of groups) {
    // A single colspan cell is as wide as the whole row, so it can't stay pinned while scrolling.
    // Split it: a sticky label cell (the same first-column cell as the metric names) plus a filler.
    tbody.append(el('tr', { class: 'group-row' }, [
      el('td', { text: title }),
      el('td', { class: 'group-fill', attrs: { colspan: String(m.years.length) } }),
    ]));
    for (const [label, values, fmt, tip] of rows) {
      const metricKey = keyOfSeries.get(values);
      tbody.append(el('tr', {}, [
        el('td', { text: label, attrs: tip ? { title: tip } : {} }),
        ...newestFirst.map((i) => {
          const v = values[i];
          // Rescaled or derived values and N/A-with-a-reason cells explain themselves on hover
          const note = metricKey ? m.quality?.cellNotes?.[metricKey]?.[m.years[i]] : null;
          const cls = [isNum(v) ? '' : 'na', note ? (isNum(v) ? 'cell-adjusted' : 'cell-note') : ''].filter(Boolean).join(' ');
          // A year with no debt tag of any kind and no interest expense shows "None reported" rather than N/A
          const nm = v === 'n/m';
          const none = !isNum(v) && (metricKey === 'longTermDebt' || metricKey === 'longTermDebtYears') && m.debt?.noDebtYears?.[i];
          return el('td', { class: cls, text: isNum(v) ? fmt(v) : nm ? 'n/m' : none ? NONE_REPORTED : NA, attrs: note ? { title: note } : nm ? { title: 'Growth from a zero or negative EPS is not meaningful' } : none ? { title: 'No debt is reported in the filings for this year, and there is no interest expense' } : {} });
        }),
      ]));
    }
  }
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: `10-Year Financials (${c || 'USD'})` }),
    el('div', { class: 'table-scroll' }, el('table', { class: 'fin-table' }, [thead, tbody])),
  ]);
}

// ---------- Valuation today and growth summary ----------

// Latest value of a series and its fiscal year
function lastOf(m, series) {
  for (let i = m.years.length - 1; i >= 0; i--) if (isNum(series?.[i])) return { v: series[i], year: m.years[i], i };
  return null;
}

let treasuryPromise = null;
function treasuryRate() {
  if (!treasuryPromise) treasuryPromise = fetch('/api/treasury').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return treasuryPromise;
}

// Today's price (Schwab) against the latest fiscal year's figures. Same definitions as the Screener.
function valuationCard(data) {
  const m = data.metrics;
  const ticker = String(data.ticker || '').toUpperCase();
  const c = m.currency;
  const card = el('div', { class: 'card val-today' });
  const head = el('div', { class: 'val-today-head' }, [el('div', { class: 'section-label', text: 'Valuation today' }), el('span', { class: 'val-today-src', text: ticker ? 'Loading price…' : 'No ticker' })]);
  const grid = el('div', { class: 'val-tiles' });
  card.append(head, grid);
  if (!ticker) return card;
  const preIpo = m.source?.kind === 'prospectus';
  const tile = (label, value, tip, { warn = false, sub = null, bad = false } = {}) => el('div', { class: `val-tile${warn ? ' warn' : ''}`, attrs: { title: tip } }, [
    el('div', { class: 'val-tile-label', text: label }),
    el('div', { class: `val-tile-value mono${value === NA ? ' na' : ''}`, text: value }),
    ...(sub ? [el('div', { class: `val-tile-sub${bad ? ' bad' : ''}`, text: sub })] : []),
  ]);
  const ratio = (v) => (isNum(v) ? v.toFixed(1) : NA);
  const pct = (v) => (isNum(v) ? `${(v * 100).toFixed(1)}%` : NA);
  Promise.all([
    fetch(`/api/schwab/quotes?symbols=${encodeURIComponent(ticker)}`).then(async (r) => (r.ok ? r.json() : { status: r.status })).catch(() => null),
    treasuryRate(),
  ]).then(([q, tsy]) => {
    const price = q?.quotes?.[ticker]?.last ?? q?.quotes?.[ticker]?.prevClose ?? null;
    if (!isNum(price)) {
      head.lastChild.textContent = q?.status === 409 ? 'Connect Schwab to see valuation ratios' : 'Price unavailable right now';
      return;
    }
    const sharesOut = lastOf(m, m.raw.sharesOutstanding) || lastOf(m, m.raw.dilutedShares);
    const eps = lastOf(m, m.raw.epsDiluted);
    const rev = lastOf(m, m.raw.revenue);
    const eq = lastOf(m, m.raw.equity);
    const fcf = lastOf(m, m.derived.fcf);
    const ebit = lastOf(m, m.raw.operatingIncome);
    const cash = lastOf(m, m.raw.cash);
    const dps = lastOf(m, m.raw.dividendsPerShare);
    const n = m.years.length - 1;
    const debtV = isNum(m.derived.totalDebt?.[n]) ? m.derived.totalDebt[n] : m.debt?.noDebtYears?.[n] ? 0 : null;
    const mcap = sharesOut && sharesOut.v > 0 ? price * sharesOut.v : null;
    const ev = isNum(mcap) && debtV !== null && cash ? mcap + debtV - cash.v : null;
    const fy = eps?.year || rev?.year || m.years[n];
    head.lastChild.textContent = `Price ${fmtPerShare(c)(price)} · Schwab · FY${fy} figures`;
    const ipoTip = preIpo ? ' Pre-IPO share count: preferred stock and convertible notes convert at the IPO, so this is not reliable until the first 10-Q.' : '';
    const ey = eps && eps.v > 0 ? eps.v / price : null;
    const tsyRate = isNum(tsy?.rate) ? tsy.rate / 100 : null;
    grid.replaceChildren(
      tile('Market cap', isNum(mcap) ? fmtCompact(mcap, c) : NA, `Price × ${m.raw.sharesOutstanding && lastOf(m, m.raw.sharesOutstanding) ? 'year-end shares outstanding' : 'weighted diluted shares'} (FY${sharesOut?.year ?? '?'}).${ipoTip}`, { warn: preIpo }),
      tile('Enterprise value', isNum(ev) ? fmtCompact(ev, c) : NA, `Market cap + total debt − cash and cash equivalents (FY${fy}). N/A when debt or cash isn't reported.${ipoTip}`, { warn: preIpo }),
      tile('P/E', eps ? (eps.v > 0 ? ratio(price / eps.v) : 'loss') : NA, `Price ÷ diluted EPS (FY${eps?.year ?? '?'}).${ipoTip}`, { warn: preIpo }),
      tile('P/B', eq && isNum(mcap) ? (eq.v > 0 ? ratio(mcap / eq.v) : 'neg. equity') : NA, `Market cap ÷ shareholders' equity (FY${eq?.year ?? '?'}).${ipoTip}`, { warn: preIpo }),
      tile('P/S', rev && isNum(mcap) && rev.v > 0 ? ratio(mcap / rev.v) : NA, `Market cap ÷ revenue (FY${rev?.year ?? '?'}).${ipoTip}`, { warn: preIpo }),
      tile('Price / FCF', fcf && isNum(mcap) ? (fcf.v > 0 ? ratio(mcap / fcf.v) : 'neg. FCF') : NA, `Market cap ÷ free cash flow (FY${fcf?.year ?? '?'}).${ipoTip}`, { warn: preIpo }),
      tile('EV / EBIT', ebit && isNum(ev) ? (ebit.v > 0 ? ratio(ev / ebit.v) : 'neg. EBIT') : NA, `Enterprise value ÷ operating income (FY${ebit?.year ?? '?'}).${ipoTip}`, { warn: preIpo }),
      tile('FCF yield', fcf && isNum(mcap) && mcap > 0 ? pct(fcf.v / mcap) : NA, `Free cash flow ÷ market cap (FY${fcf?.year ?? '?'}). Compare with a bond yield.${ipoTip}`, { warn: preIpo }),
      tile('Dividend yield', dps ? pct(dps.v / price) : NA, dps ? `Dividends per share (FY${dps.year}) ÷ price` : 'No dividends per share reported in the filings (the company may pay none)', {}),
      tile('Earnings yield', isNum(ey) ? pct(ey) : eps ? 'loss' : NA, `Diluted EPS ÷ price: what the business earns per dollar of price. Buffett compares it with the 10-year Treasury.${ipoTip}`, {
        warn: preIpo,
        sub: tsyRate !== null ? `10-yr Treasury ${(tsyRate * 100).toFixed(2)}%` : '10-yr Treasury unavailable',
        bad: isNum(ey) && tsyRate !== null && ey < tsyRate,
      }),
    );
  });
  return card;
}

// Average yearly growth (CAGR) over 3, 5 and 10 years, ending at the latest year with a value
function growthCard(m) {
  const c = m.currency;
  const series = [
    ['Revenue', m.raw.revenue, (v) => fmtCompact(v, c)],
    ['EPS (diluted)', m.raw.epsDiluted, fmtPerShare(c)],
    ['Book value / share', m.derived.bookValuePerShare, fmtPerShare(c)],
    ['Free cash flow', m.derived.fcf, (v) => fmtCompact(v, c)],
    ['Dividends / share', m.raw.dividendsPerShare, fmtPerShare(c)],
  ].filter(([, s]) => Array.isArray(s) && s.some(isNum));
  if (!series.length) return null;
  const spans = [3, 5, 10];
  const cell = (s, fmt, span) => {
    const end = lastOf(m, s);
    if (!end) return el('td', { class: 'na', text: NA });
    const si = m.years.indexOf(end.year - span);
    const start = si >= 0 && isNum(s[si]) ? s[si] : null;
    if (start === null) return el('td', { class: 'na', text: NA, attrs: { title: `No FY${end.year - span} value` } });
    const tip = `FY${end.year - span} ${fmt(start)} → FY${end.year} ${fmt(end.v)}`;
    if (!(start > 0) || !(end.v > 0)) return el('td', { class: 'na', text: 'n/m', attrs: { title: `${tip}. Not meaningful with a zero or negative start or end.` } });
    const g = Math.pow(end.v / start, 1 / span) - 1;
    return el('td', { class: g >= 0 ? 'up' : 'down', text: `${(g * 100).toFixed(1)}%`, attrs: { title: tip } });
  };
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: 'Growth summary (average per year)' }),
    el('div', { class: 'table-scroll' }, el('table', { class: 'fin-table growth-table' }, [
      el('thead', {}, el('tr', {}, [el('th', { text: '' }), ...spans.map((n) => el('th', { text: `${n} yr` }))])),
      el('tbody', {}, series.map(([label, s, fmt]) => el('tr', {}, [el('td', { text: label }), ...spans.map((n) => cell(s, fmt, n))]))),
    ])),
    el('div', { class: 'head-note', text: 'Compound growth from the start year to the latest year. n/m when either end is zero or negative. Hover a cell for the values used.' }),
  ]);
}

// ---------- IPO prospectus extras ----------

const shortPeriod = (p) => String(p || '').replace(/^(\w+) months? ended (\w+) \d+,? ((?:19|20)\d\d)$/i, (_, n, mon, y) => `${n[0].toUpperCase()}${n.slice(1).toLowerCase()} mo. to ${mon.slice(0, 3)} ${y}`);

// Six-month (or other interim) columns, which the fiscal-year table leaves out
function interimCard(m) {
  const it = m.interim;
  if (!it || (!it.columns?.length && !it.balance)) return null;
  const c = m.currency;
  const money = (v) => (isNum(v) ? fmtCompact(v, c) : NA);
  const nodes = [el('div', { class: 'section-label', text: 'Latest interim results (not in the yearly table)' })];
  if (it.columns?.length) {
    const rows = [
      ['Revenue', 'Revenues', money], ['Total operating expenses', 'CostsAndExpenses', money], ['Operating income', 'OperatingIncomeLoss', money],
      ['Net income', 'NetIncomeLoss', money], ['EPS (diluted)', 'EarningsPerShareDiluted', fmtPerShare(c)],
      ['Operating cash flow', 'NetCashProvidedByUsedInOperatingActivities', money], ['Capex', 'PaymentsToAcquirePropertyPlantAndEquipment', money], ['Free cash flow', 'fcf', money],
    ].filter(([, k]) => it.columns.some((col) => isNum(col[k])));
    const cols = [...it.columns].reverse(); // newest first, like the yearly table
    nodes.push(el('div', { class: 'table-scroll' }, el('table', { class: 'fin-table' }, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Period' }), ...cols.map((col) => el('th', { text: shortPeriod(col.label) }))])),
      el('tbody', {}, rows.map(([label, k, fmt]) => el('tr', {}, [el('td', { text: label }), ...cols.map((col) => el('td', { class: isNum(col[k]) ? '' : 'na', text: isNum(col[k]) ? fmt(col[k]) : NA }))]))),
    ])));
    nodes.push(el('div', { class: 'head-note', text: 'Partial-year figures as filed, not annualized.' }));
  }
  const b = it.balance;
  if (b) {
    const items = [['Cash and cash equivalents', 'CashAndCashEquivalentsAtCarryingValue'], ['Short-term investments', 'ShortTermInvestments'], ['Total assets', 'Assets'], ['Total liabilities', 'Liabilities'], ['Convertible notes', 'ConvertibleNotesPayable'], ['Stockholders’ equity (deficit)', 'StockholdersEquity']].filter(([, k]) => isNum(b[k]));
    nodes.push(el('div', { class: 'section-label interim-sub', text: `Balance sheet, ${String(b.label).replace(/^as of /i, '')}` }));
    nodes.push(el('div', { class: 'meta-row' }, items.map(([label, k]) => el('div', { class: 'meta-item' }, [el('div', { class: 'meta-label', text: label }), el('div', { class: 'meta-value mono', text: money(b[k]) })]))));
  }
  return el('div', { class: 'card' }, nodes);
}

// Expenses grouped by type (no cost of revenue line): each line as filed, with its share of revenue
function expenseCard(m) {
  const ex = m.expenseLines;
  if (!ex) return null;
  const c = m.currency;
  // newest first: interim columns (null year) are the latest; then fiscal years newest to oldest
  const order = ex.periods.map((p, i) => i).sort((a, b) => {
    const ya = ex.years[a] ?? 9999; const yb = ex.years[b] ?? 9999;
    return yb - ya || b - a;
  });
  const cell = (v, i) => {
    const rev = ex.revenue[i];
    const pct = isNum(v) && isNum(rev) && rev > 0 ? ` (${Math.round((v / rev) * 100)}%)` : '';
    return el('td', { class: isNum(v) ? '' : 'na', text: isNum(v) ? `${fmtCompact(v, c)}${pct}` : NA });
  };
  const label = (i) => (ex.years[i] !== null && ex.years[i] !== undefined ? `FY${ex.years[i]}` : shortPeriod(ex.periods[i]));
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: 'Operating expenses as filed (share of revenue)' }),
    el('div', { class: 'head-note', text: 'This company groups expenses by type instead of reporting cost of revenue, so there is no gross margin. The largest direct cost line is the closest substitute.' }),
    el('div', { class: 'table-scroll' }, el('table', { class: 'fin-table' }, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Line' }), ...order.map((i) => el('th', { text: label(i) }))])),
      el('tbody', {}, [
        el('tr', {}, [el('td', { text: 'Revenue' }), ...order.map((i) => el('td', { text: fmtCompact(ex.revenue[i], c) }))]),
        ...ex.lines.map((ln) => el('tr', {}, [el('td', { text: ln.label }), ...order.map((i) => cell(ln.values[i], i))])),
        el('tr', { class: 'total-row' }, [el('td', { text: ex.totalLabel }), ...order.map((i) => cell(ex.total[i], i))]),
      ]),
    ])),
  ]);
}

// Scroll the 10-year table back to its start, where the latest fiscal year now sits.
function resetTableScroll(root) {
  for (const box of root.querySelectorAll('.table-scroll')) box.scrollLeft = 0;
}

// ---------- Charts ----------

let chartSeq = 0;

function areaChart({ title, years, values, fmt, color }) {
  const W = 400;
  const H = 170;
  const pad = { l: 46, r: 12, t: 12, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const card = el('div', { class: 'card chart-card' }, el('div', { class: 'section-label', text: title }));

  const points = values.map((v, i) => (isNum(v) ? { i, v } : null)).filter(Boolean);
  if (points.length < 2) {
    card.append(el('div', { class: 'results-empty', text: 'Not enough data (N/A)' }));
    return card;
  }

  let min = Math.min(...points.map((p) => p.v));
  let max = Math.max(...points.map((p) => p.v));
  if (max === min) { max += 1; min -= 1; }
  const span = max - min;
  min -= span * 0.05;
  max += span * 0.05;

  const n = values.length;
  const x = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;
  const gradId = `grad-${++chartSeq}`;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': title });
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.35' }));
  grad.append(svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }));
  defs.append(grad);
  svg.append(defs);

  for (let g = 0; g <= 3; g++) {
    const val = min + ((max - min) * g) / 3;
    const gy = y(val);
    svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: gy, y2: gy, class: 'chart-grid' }));
    svg.append(svgEl('text', { x: pad.l - 6, y: gy + 3, class: 'chart-label', 'text-anchor': 'end' }, fmt(val)));
  }
  if (min < 0 && max > 0) {
    svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: 'chart-zero' }));
  }

  // Break the line wherever a year is missing so gaps are never interpolated.
  const baseY = y(Math.max(min, Math.min(0, max)));
  const segments = [];
  let current = [];
  values.forEach((v, i) => {
    if (isNum(v)) current.push({ i, v });
    else if (current.length) { segments.push(current); current = []; }
  });
  if (current.length) segments.push(current);
  for (const seg of segments) {
    if (seg.length < 2) continue;
    const line = seg.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    svg.append(svgEl('path', {
      d: `${line} L${x(seg[seg.length - 1].i).toFixed(1)},${baseY.toFixed(1)} L${x(seg[0].i).toFixed(1)},${baseY.toFixed(1)} Z`,
      fill: `url(#${gradId})`,
    }));
    svg.append(svgEl('path', { d: line, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  for (const p of points) {
    const dot = svgEl('circle', { cx: x(p.i), cy: y(p.v), r: '3.5', fill: color, stroke: 'var(--card)', 'stroke-width': '1.5' });
    dot.append(svgEl('title', {}, `${years[p.i]}: ${fmt(p.v)}`));
    svg.append(dot);
  }
  const labelEvery = n > 6 ? 2 : 1;
  years.forEach((yr, i) => {
    if ((n - 1 - i) % labelEvery !== 0) return;
    svg.append(svgEl('text', { x: x(i), y: H - 6, class: 'chart-label', 'text-anchor': 'middle' }, String(yr)));
  });

  card.append(svg);
  return card;
}

function chartsGrid(m) {
  const d = m.derived;
  const c = m.currency;
  const defs = [
    { title: 'Gross Margin', values: d.grossMargin, fmt: fmtPct, color: '#3b9eff' },
    { title: 'Net Margin', values: d.netMargin, fmt: fmtPct, color: '#00e5a0' },
    { title: 'Operating Margin', values: d.operatingMargin, fmt: fmtPct, color: '#ffc940' },
    { title: 'EPS (Diluted)', values: m.raw.epsDiluted, fmt: fmtPerShare(c), color: '#3b9eff' },
    { title: 'FCF / Share', values: d.fcfPerShare, fmt: fmtPerShare(c), color: '#00e5a0' },
    { title: 'Debt-to-Equity', values: d.debtToEquity, fmt: fmtRatio, color: '#ffc940' },
  ];
  return el('div', { class: 'charts-grid' }, defs.map((def) => areaChart({ ...def, years: m.years })));
}

// ---------- Header card ----------

// Latest saved valuation, shown in the header card so it's visible without scrolling
function valuationStrip(ticker, { onOpenValuations }) {
  const strip = el('div', { class: 'val-strip' }, [el('span', { class: 'val-strip-label', text: 'Latest valuation' }), el('span', { class: 'val-strip-dim', text: 'Loading…' })]);
  if (!ticker) { strip.hidden = true; return strip; }
  const money = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : NA);
  latestValuation(ticker).then((v) => {
    if (!v) {
      strip.replaceChildren(
        el('span', { class: 'val-strip-label', text: 'Latest valuation' }),
        el('span', { class: 'val-strip-dim', text: 'None saved yet. Use Send to Calculator, then Save Valuation.' }),
      );
      return;
    }
    const verdictCls = v.verdict === 'UNDERVALUED' ? 'pill-pass' : v.verdict === 'OVERVALUED' ? 'pill-fail' : 'pill-warn';
    const item = (label, value, cls = '') => el('span', { class: 'val-strip-item' }, [el('span', { class: 'val-strip-dim', text: label }), el('span', { class: `mono ${cls}`.trim(), text: value })]);
    const openBtn = el('button', { class: 'val-strip-link', text: 'All saved valuations →', attrs: { type: 'button' } });
    openBtn.addEventListener('click', () => onOpenValuations?.());
    strip.replaceChildren(
      el('span', { class: 'val-strip-label', text: 'Latest valuation' }),
      el('span', { class: 'val-strip-dim', text: new Date(v.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }),
      item('Intrinsic value', money(v.intrinsicValue), 'val-iv'),
      item(`Buy below${Number.isFinite(v.marginOfSafety) ? ` (${v.marginOfSafety}% MoS)` : ''}`, money(v.buyBelow), 'val-bb'),
      v.marketPrice !== null ? item('Price then', money(v.marketPrice)) : null,
      v.verdict ? el('span', { class: `pill ${verdictCls}`, text: v.verdict }) : null,
      openBtn,
    );
  });
  return strip;
}

function headerCard(data, { onRefresh, onSend, onSendReverse, onWatch, onOpenValuations, busy }) {
  const m = data.metrics;
  const updated = new Date(data.fetchedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const meta = (label, value) => el('div', { class: 'meta-item' }, [
    el('div', { class: 'meta-label', text: label }),
    el('div', { class: 'meta-value mono', text: value }),
  ]);

  // Built from values SEC returned (CIK, accession, document name), validated on the server
  const lf = m.latestFiling;
  const fromProspectus = m.source?.kind === 'prospectus';
  const annualLink = lf?.viewerUrl?.startsWith('https://www.sec.gov/') ? secLink(lf.viewerUrl, `${fromProspectus ? 'IPO prospectus' : 'Latest annual report'} ↗ (${lf.form}, ${fmtFilingDate(lf.filingDate)})`, 'btn btn-ghost btn-inline link-btn') : null;
  const allFilingsLink = lf && /^[0-9A-Za-z-]{1,10}$/.test(lf.form)
    ? secLink(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(data.cik)}&type=${encodeURIComponent(lf.form)}&dateb=&owner=include&count=40`, 'All filings ↗', 'btn btn-ghost btn-inline link-btn')
    : null;
  const refreshBtn = el('button', { class: 'btn btn-ghost btn-inline', text: busy ? 'Refreshing...' : 'Refresh', attrs: { type: 'button' } });
  refreshBtn.disabled = busy;
  refreshBtn.addEventListener('click', onRefresh);
  // The calculator is never sent a FCF/share that the data-quality checks marked N/A
  const lastYear = m.years[m.years.length - 1];
  const fcfPsNote = m.quality?.cellNotes?.fcfPerShare?.[lastYear] || null;
  const fcfPsOk = isNum(m.derived.fcfPerShare[m.derived.fcfPerShare.length - 1]) && !fcfPsNote;
  const sendBtn = el('button', {
    class: 'btn btn-primary btn-inline',
    text: fcfPsOk ? 'Send to Calculator →' : 'Send to Calculator (no FCF/share) →',
    attrs: fcfPsOk ? { type: 'button' } : { type: 'button', title: `FCF/share will not be sent: ${fcfPsNote || 'it is not available for the latest year'}` },
  });
  sendBtn.addEventListener('click', onSend);
  const reverseBtn = el('button', { class: 'btn btn-ghost btn-inline', text: 'Send to Reverse DCF →', attrs: { type: 'button' } });
  reverseBtn.addEventListener('click', onSendReverse);
  const watchBtn = el('button', { class: 'btn btn-ghost btn-inline', text: '+ Watchlist', attrs: { type: 'button', title: 'Add this ticker to your watchlist' } });
  watchBtn.addEventListener('click', async () => {
    watchBtn.disabled = true;
    const ok = await onWatch?.().catch(() => false);
    watchBtn.textContent = ok ? '✓ On watchlist' : 'Could not add';
    if (!ok) watchBtn.disabled = false;
  });
  if (!data.ticker) watchBtn.hidden = true;

  const notes = [];
  if (fromProspectus) notes.push(`${m.coverage.found}/${m.coverage.total} metrics found in the prospectus statements.`);
  else if (m.coverage.missing.length) notes.push(`${m.coverage.found}/${m.coverage.total} metrics found. Not reported in XBRL: ${m.coverage.missing.join(', ')}.`);
  if (m.grossProfitDerived) notes.push('Gross profit computed as revenue minus cost of revenue (not separately reported).');
  if (m.quality?.summary?.length) notes.push(`Data quality: ${m.quality.summary.join('; ')}.`);

  return el('div', { class: 'card' }, [
    el('div', { class: 'company-head' }, [
      el('div', {}, [
        el('h1', { class: 'company-name', text: data.companyName || 'Unknown company' }),
        el('div', { class: 'company-sub' }, [
          el('span', { class: 'mono ticker-chip', text: data.ticker || NA }),
        ]),
      ]),
      el('div', { class: 'head-actions' }, [annualLink, allFilingsLink, refreshBtn, sendBtn, reverseBtn, watchBtn]),
    ]),
    ...(fromProspectus ? [el('div', { class: 'source-banner', text: m.source.note })] : []),
    valuationStrip(String(data.ticker || '').toUpperCase(), { onOpenValuations }),
    el('div', { class: 'meta-row' }, [
      meta('CIK', data.cik), meta('Taxonomy', data.taxonomy || NA),
      meta('Currency', m.currency || NA), meta('Last updated', updated),
    ]),
    ...notes.map((t) => el('div', { class: 'head-note', text: t })),
  ]);
}

// ---------- Page ----------

export function renderFilings(container, { onSendToCalculator, onSendToReverse, onOpenInCharts, onOpenValuations, initialTicker }) {
  // Keep the loaded ticker in the address (/filings?ticker=ACFN) so a page refresh reopens it
  const rememberTicker = (t) => {
    const tick = String(t || '').toUpperCase();
    if (!tick || window.location.pathname !== '/filings') return;
    const want = `/filings?ticker=${encodeURIComponent(tick)}`;
    if (window.location.pathname + window.location.search !== want) window.history.replaceState({}, '', want);
  };
  container.replaceChildren();

  const input = el('input', { attrs: { id: 'filings-q', type: 'text', autocomplete: 'off', placeholder: 'Ticker (e.g. V) or EDGAR URL', maxlength: '500', 'aria-label': 'Ticker or EDGAR URL' } });
  const loadBtn = el('button', { class: 'btn btn-primary btn-inline', text: 'Load Filings', attrs: { type: 'submit' } });
  const form = el('form', { class: 'search-row' }, [el('div', { class: 'field' }, input), loadBtn]);
  const searchCard = el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: 'Company' }),
    form,
    el('div', { class: 'search-hint', text: 'Free data from SEC EDGAR (XBRL). Annual filings only: 10-K, 40-F, 20-F.' }),
  ]);
  const results = el('div', { class: 'filings-results' });
  const storyPane = el('div', { class: 'filings-results' });
  const newsPane = el('div', { class: 'filings-results' });
  const subMetrics = el('button', { class: 'sub-tab', text: 'Metrics', attrs: { type: 'button' } });
  const statementsPane = el('div', { class: 'filings-results' });
  const subStatements = el('button', { class: 'sub-tab', text: 'Statements', attrs: { type: 'button' } });
  const subStory = el('button', { class: 'sub-tab', text: 'Story', attrs: { type: 'button' } });
  const subNews = el('button', { class: 'sub-tab sub-tab-news', text: 'News', attrs: { type: 'button' } });
  const subTabs = el('div', { class: 'sub-tabs' }, [subMetrics, subStatements, subStory, subNews]);
  container.append(searchCard, subTabs, results, statementsPane, storyPane, newsPane);

  // The Price card at the top of the company view is the full chart component (chart-view.js, mode 'card'):
  // every chart feature, icon-only toolbars, and Expand maximizes it in place without leaving this page.
  let priceChart = null;
  const disposePrice = () => { priceChart?.destroy?.(); priceChart = null; };

  function priceCard(data) {
    disposePrice();
    const ticker = String(data.ticker || '').toUpperCase();
    const host = el('div', { class: 'vlc-card-host' });
    const card = el('div', { class: 'card' }, [el('div', { class: 'section-label', text: 'Price' }), host]);
    if (!ticker) {
      host.replaceChildren(el('div', { class: 'chart-empty-note', text: NO_DATA_MESSAGE }));
      return card;
    }
    mountChartView(host, { ticker, mode: 'card', location: 'card', onOpenInCharts }).then((view) => {
      if (!card.isConnected) { view.destroy?.(); return; }
      disposePrice();
      priceChart = view;
    });
    return card;
  }

  function showSubTab(name) {
    activeSubTab = name;
    subMetrics.classList.toggle('active', name === 'metrics');
    subStatements.classList.toggle('active', name === 'statements');
    subStory.classList.toggle('active', name === 'story');
    subNews.classList.toggle('active', name === 'news');
    results.hidden = name !== 'metrics';
    statementsPane.hidden = name !== 'statements';
    storyPane.hidden = name !== 'story';
    newsPane.hidden = name !== 'news';
    // A hidden pane can't hold a scroll position, so make sure the latest year is in view when it reappears
    if (name === 'metrics') resetTableScroll(results);
    const paneArgs = { ensureData, getCurrentCik: () => lastLoaded?.data.cik ?? null };
    if (name === 'statements') renderStatementsPane(statementsPane, paneArgs);
    if (name === 'story') renderStoryPane(storyPane, paneArgs);
    if (name === 'news') renderNewsPane(newsPane, paneArgs);
  }
  subMetrics.addEventListener('click', () => showSubTab('metrics'));
  subStatements.addEventListener('click', () => showSubTab('statements'));
  subStory.addEventListener('click', () => showSubTab('story'));
  subNews.addEventListener('click', () => showSubTab('news'));

  // Metrics for whatever is in the search box, loading them first when they aren't loaded yet
  async function ensureData() {
    const q = input.value.trim();
    if (!q) return lastLoaded?.data ?? null;
    if (lastLoaded && lastLoaded.q === q) return lastLoaded.data;
    return load(q);
  }

  let requestSeq = 0;

  function showMessage(text, isError) {
    disposePrice();
    results.replaceChildren(el('div', { class: `card empty-state${isError ? ' error-state' : ''}`, text }));
  }

  function showData(data, busy = false) {
    results.replaceChildren(
      headerCard(data, {
        busy,
        onRefresh: () => load(
          data.ticker || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${data.cik}`,
          { refresh: true, keep: data },
        ),
        onSendReverse: () => {
          const m = data.metrics;
          const n = m.years.length - 1;
          const last = (series) => (isNum(series?.[n]) ? series[n] : null);
          const lastFcfPs = last(m.derived.fcfPerShare);
          const fcfNote = m.quality?.cellNotes?.fcfPerShare?.[m.years[n]];
          // Margins for the last 5 fiscal years, oldest first. A year with no margin stays N/A (null)
          const marginHistory = m.years.map((year, i) => ({ year, margin: isNum(m.derived.operatingMargin?.[i]) ? m.derived.operatingMargin[i] : null })).slice(-5);
          const form = m.latestFiling?.form;
          const payload = {
            ticker: data.ticker,
            companyName: data.companyName,
            revenue: last(m.raw.revenue),
            operatingIncome: last(m.raw.operatingIncome),
            depreciation: last(m.raw.depreciation),
            capex: last(m.raw.capex),
            fcfPerShare: lastFcfPs !== null && !fcfNote ? lastFcfPs : null,
            dilutedShares: last(m.raw.dilutedShares),
            cash: last(m.raw.cash),
            longTermDebt: last(m.raw.longTermDebt),
            marginHistory,
            fcfCagr: isNum(m.fcfCagr) ? m.fcfCagr : null,
            source: `FY${m.years[n]} ${form && /^[0-9A-Za-z-]{1,10}$/.test(form) ? form : 'annual filing'}`,
          };
          try {
            sessionStorage.setItem(REVERSE_PREFILL_KEY, JSON.stringify(payload));
          } catch (err) {
            console.error(err);
          }
          onSendToReverse();
        },
        onWatch: () => addToWatchlist(String(data.ticker || '').toUpperCase()),
        onOpenValuations,
        onSend: () => {
          const m = data.metrics;
          const lastFcfPs = m.derived.fcfPerShare[m.derived.fcfPerShare.length - 1];
          const lastNote = m.quality?.cellNotes?.fcfPerShare?.[m.years[m.years.length - 1]];
          const payload = {
            ticker: data.ticker,
            companyName: data.companyName,
            fcfPerShare: isNum(lastFcfPs) && !lastNote ? Number(lastFcfPs.toFixed(2)) : null,
            growthRate1_5: isNum(m.fcfCagr) ? Number((m.fcfCagr * 100).toFixed(1)) : null,
          };
          try {
            sessionStorage.setItem(FILINGS_PREFILL_KEY, JSON.stringify(payload));
          } catch (err) {
            console.error(err);
          }
          onSendToCalculator();
        },
      }),
      valuationCard(data),
      ...[growthCard(data.metrics)].filter(Boolean),
      priceCard(data),
      ...[interimCard(data.metrics)].filter(Boolean),
      scorecardCard(data.metrics),
      tableCard(data.metrics),
      ...[expenseCard(data.metrics)].filter(Boolean),
      chartsGrid(data.metrics),
    );
    resetTableScroll(results);
  }

  async function load(q, { refresh = false, keep = null } = {}) {
    const seq = ++requestSeq;
    loadBtn.disabled = true;
    if (keep) showData(keep, true);
    else showMessage('Loading filings from SEC EDGAR...', false);
    try {
      const url = `/api/filings?q=${encodeURIComponent(q)}${refresh ? '&refresh=1' : ''}`;
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (seq !== requestSeq) return null;
      if (!res.ok) {
        if (keep) showData(keep, false);
        else showMessage(typeof body.error === 'string' ? body.error : 'Could not load filings data', true);
        return null;
      }
      lastLoaded = { q, data: body };
      rememberTicker(body.ticker);
      showData(body);
      if (activeSubTab === 'statements') renderStatementsPane(statementsPane, { ensureData, getCurrentCik: () => lastLoaded?.data.cik ?? null });
      return body;
    } catch (err) {
      console.error(err);
      if (seq !== requestSeq) return null;
      if (keep) showData(keep, false);
      else showMessage('Could not load filings data', true);
      return null;
    } finally {
      if (seq === requestSeq) loadBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    load(q);
  });

  const wanted = typeof initialTicker === 'string' ? initialTicker.trim().toUpperCase().slice(0, 20) : '';
  if (wanted && String(lastLoaded?.data?.ticker || '').toUpperCase() !== wanted) {
    input.value = wanted;
    load(wanted);
  } else if (lastLoaded) {
    input.value = lastLoaded.q;
    rememberTicker(lastLoaded.data.ticker);
    showData(lastLoaded.data);
  } else {
    showMessage('Enter a ticker or paste an EDGAR URL to see 10 years of Buffett-style metrics.', false);
  }
  showSubTab(activeSubTab);
}
