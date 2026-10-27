import { renderStoryPane } from './story.js';
import { renderNewsPane } from './news.js';

export const FILINGS_PREFILL_KEY = 'filingsPrefill';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NA = 'N/A';

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

function buildRules(m) {
  const r = m.raw;
  const d = m.derived;

  const ltDebtYears = r.longTermDebt.map((debt, i) => {
    const earnings = r.netIncome[i];
    if (!isNum(debt) || !isNum(earnings)) return { value: null, pass: null };
    if (debt <= 0) return { value: 0, pass: true };
    if (earnings <= 0) return { value: null, pass: false, note: 'Loss' };
    const years = debt / earnings;
    return { value: years, pass: years <= 4 };
  });

  const epsGrowth = yearly(d.epsGrowth, (g) => g > 0);
  const reRising = r.retainedEarnings.map((re, i) => {
    const prev = i > 0 ? r.retainedEarnings[i - 1] : null;
    if (!isNum(re) || !isNum(prev)) return { value: null, pass: null };
    return { value: re, pass: re > prev };
  });

  const core = [
    { label: 'Gross margin ≥ 40%', fmt: fmtPct, series: yearly(d.grossMargin, (v) => v >= 0.4) },
    { label: 'Net margin ≥ 20%', fmt: fmtPct, series: yearly(d.netMargin, (v) => v >= 0.2) },
    { label: 'SG&A ≤ 30% of gross profit', fmt: fmtPct, series: yearly(d.sgaPctGrossProfit, (v) => v <= 0.3) },
    { label: 'Interest ≤ 15% of operating income', fmt: fmtPct, series: yearly(d.interestPctOperatingIncome, (v) => v <= 0.15) },
    { label: 'Debt-to-equity ≤ 0.80', fmt: fmtRatio, series: yearly(d.debtToEquity, (v) => v <= 0.8) },
    { label: 'Long-term debt ≤ 4 years of earnings', fmt: fmtYears, series: ltDebtYears },
    { label: 'Consistent EPS growth', fmt: fmtPct, series: epsGrowth, consistency: true },
  ];
  const optional = [
    { label: 'ROE ≥ 25%', fmt: fmtPct, series: yearly(d.roe, (v) => v >= 0.25) },
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

function ruleRow(rule) {
  const ev = evaluate(rule);
  const latestText = ev.latest?.note ?? (ev.latest && isNum(ev.latest.value) ? rule.fmt(ev.latest.value) : NA);
  return el('div', { class: 'rule-row' }, [
    el('div', { class: 'rule-label', text: rule.label }),
    el('div', { class: `rule-value mono${latestText === NA ? ' na' : ''}`, text: latestText }),
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
    el('div', { class: 'score-summary mono', text: `${passCount} of ${scoredCount} scored core rules passed` }),
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
      ['Operating income', r.operatingIncome, money], ['Interest expense', r.interestExpense, money],
      ['Net income', r.netIncome, money], ['EPS (diluted)', r.epsDiluted, fmtPerShare(c)],
      ['Diluted shares', r.dilutedShares, fmtShares],
    ]],
    ['Balance Sheet', [
      ['Total current assets', r.currentAssets, money], ['Total current liabilities', r.currentLiabilities, money],
      ['Total liabilities', r.totalLiabilities, money], ["Shareholders' equity", r.equity, money],
      ['Long-term debt', r.longTermDebt, money], ['Retained earnings', r.retainedEarnings, money],
      ['Net receivables', r.netReceivables, money],
    ]],
    ['Cash Flow', [
      ['Operating cash flow', r.operatingCashFlow, money], ['Capex', r.capex, money],
      ['Free cash flow', d.fcf, money], ['FCF / share', d.fcfPerShare, fmtPerShare(c)],
    ]],
    ['Ratios', [
      ['Gross margin', d.grossMargin, fmtPct], ['Net margin', d.netMargin, fmtPct],
      ['SG&A % of gross profit', d.sgaPctGrossProfit, fmtPct], ['Interest % of operating income', d.interestPctOperatingIncome, fmtPct],
      ['Debt-to-equity', d.debtToEquity, fmtRatio], ['Long-term debt / earnings', d.longTermDebtYears, fmtYears],
      ['Current ratio', d.currentRatio, fmtRatio], ['ROE', d.roe, fmtPct], ['EPS growth', d.epsGrowth, fmtPct],
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
    for (const [label, values, fmt] of rows) {
      const metricKey = keyOfSeries.get(values);
      tbody.append(el('tr', {}, [
        el('td', { text: label }),
        ...newestFirst.map((i) => {
          const v = values[i];
          // Rescaled or derived values and N/A-with-a-reason cells explain themselves on hover
          const note = metricKey ? m.quality?.cellNotes?.[metricKey]?.[m.years[i]] : null;
          const cls = [isNum(v) ? '' : 'na', note ? (isNum(v) ? 'cell-adjusted' : 'cell-note') : ''].filter(Boolean).join(' ');
          return el('td', { class: cls, text: isNum(v) ? fmt(v) : NA, attrs: note ? { title: note } : {} });
        }),
      ]));
    }
  }
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: `10-Year Financials (${c || 'USD'})` }),
    el('div', { class: 'table-scroll' }, el('table', { class: 'fin-table' }, [thead, tbody])),
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
    { title: 'EPS (Diluted)', values: m.raw.epsDiluted, fmt: fmtPerShare(c), color: '#3b9eff' },
    { title: 'FCF / Share', values: d.fcfPerShare, fmt: fmtPerShare(c), color: '#00e5a0' },
    { title: 'Debt-to-Equity', values: d.debtToEquity, fmt: fmtRatio, color: '#ffc940' },
  ];
  return el('div', { class: 'charts-grid' }, defs.map((def) => areaChart({ ...def, years: m.years })));
}

// ---------- Header card ----------

function headerCard(data, { onRefresh, onSend, busy }) {
  const m = data.metrics;
  const updated = new Date(data.fetchedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const meta = (label, value) => el('div', { class: 'meta-item' }, [
    el('div', { class: 'meta-label', text: label }),
    el('div', { class: 'meta-value mono', text: value }),
  ]);

  const filingLink = el('a', {
    class: 'btn btn-ghost btn-inline link-btn',
    text: 'EDGAR filings ↗',
    attrs: {
      href: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(data.cik)}&type=10-K&dateb=&owner=include&count=40`,
      target: '_blank',
      rel: 'noopener noreferrer',
    },
  });
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

  const notes = [];
  if (m.coverage.missing.length) notes.push(`${m.coverage.found}/${m.coverage.total} metrics found. Not reported in XBRL: ${m.coverage.missing.join(', ')}.`);
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
      el('div', { class: 'head-actions' }, [filingLink, refreshBtn, sendBtn]),
    ]),
    el('div', { class: 'meta-row' }, [
      meta('CIK', data.cik), meta('Taxonomy', data.taxonomy || NA),
      meta('Currency', m.currency || NA), meta('Last updated', updated),
    ]),
    ...notes.map((t) => el('div', { class: 'head-note', text: t })),
  ]);
}

// ---------- Page ----------

export function renderFilings(container, { onSendToCalculator }) {
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
  const subStory = el('button', { class: 'sub-tab', text: 'Story', attrs: { type: 'button' } });
  const subNews = el('button', { class: 'sub-tab sub-tab-news', text: 'News', attrs: { type: 'button' } });
  const subTabs = el('div', { class: 'sub-tabs' }, [subMetrics, subStory, subNews]);
  container.append(searchCard, subTabs, results, storyPane, newsPane);

  function showSubTab(name) {
    activeSubTab = name;
    subMetrics.classList.toggle('active', name === 'metrics');
    subStory.classList.toggle('active', name === 'story');
    subNews.classList.toggle('active', name === 'news');
    results.hidden = name !== 'metrics';
    storyPane.hidden = name !== 'story';
    newsPane.hidden = name !== 'news';
    // A hidden pane can't hold a scroll position, so make sure the latest year is in view when it reappears
    if (name === 'metrics') resetTableScroll(results);
    const paneArgs = { ensureData, getCurrentCik: () => lastLoaded?.data.cik ?? null };
    if (name === 'story') renderStoryPane(storyPane, paneArgs);
    if (name === 'news') renderNewsPane(newsPane, paneArgs);
  }
  subMetrics.addEventListener('click', () => showSubTab('metrics'));
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
      scorecardCard(data.metrics),
      tableCard(data.metrics),
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
      showData(body);
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

  if (lastLoaded) {
    input.value = lastLoaded.q;
    showData(lastLoaded.data);
  } else {
    showMessage('Enter a ticker or paste an EDGAR URL to see 10 years of Buffett-style metrics.', false);
  }
  showSubTab(activeSubTab);
}
