// Screener page (/screener): Buffett-style rules over the whole market (SEC frames data, refreshed on demand and
// stored in Neon). Results update instantly as rules change. All text goes through textContent.

import { RULES, FIELD_INDEX, defaultSettings, screen, latest, evaluate } from './screener-rules.js';
import { addToWatchlist } from './watchlist.js';

const LS_KEY = 'vl.screener.v1';
const PAGE = 200;
let dataset = null; // cached for the session
let cleanup = null;

export function disposeScreener() { if (cleanup) { cleanup(); cleanup = null; } }

function el(tag, { cls, text, attrs, on } = {}, children = []) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (on) for (const [e, fn] of Object.entries(on)) n.addEventListener(e, fn);
  for (const c of children) if (c) n.append(c);
  return n;
}

function loadSettings() {
  const d = defaultSettings();
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!s) return d;
    for (const r of RULES) {
      const v = s.rules?.[r.key];
      if (v && typeof v.on === 'boolean') d.rules[r.key].on = v.on;
      if (v && Number.isFinite(v.value)) d.rules[r.key].value = v.value;
    }
    if (Number.isInteger(s.minPass)) d.minPass = s.minPass;
    if (s.missing === 'skip' || s.missing === 'fail') d.missing = s.missing;
    if (Number.isInteger(s.hold) && s.hold >= 1 && s.hold <= 5) d.hold = s.hold;
  } catch (err) { /* defaults */ }
  return d;
}
const saveSettings = (s) => { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (err) { /* ignore */ } };

const fmtVal = (rule, v) => {
  if (v === null || v === undefined) return 'N/A';
  switch (rule.fmt) {
    case 'pct': return v >= 99 ? 'loss' : `${(v * 100).toFixed(1)}%`;
    case 'x': return v >= 99 ? 'neg. eq.' : v.toFixed(2);
    case 'yrs': return v === 0 ? 'None' : v >= 99 ? 'no profit' : v.toFixed(1);
    case 'eps': return `$${v.toFixed(2)}`;
    case 'up': return v === 1 ? 'up' : 'down';
    default: return String(v);
  }
};
// Threshold shown to the user: percentages as whole numbers ("40"), others as-is
const toInput = (rule, v) => (rule.fmt === 'pct' ? String(Math.round(v * 1000) / 10) : String(v));
const fromInput = (rule, s) => { const n = Number(s); return Number.isFinite(n) ? (rule.fmt === 'pct' ? n / 100 : n) : null; };
const unitOf = (rule) => (rule.fmt === 'pct' ? '%' : rule.fmt === 'yrs' ? 'yrs' : rule.fmt === 'x' ? '×' : '');

export function renderScreener(container, { onOpenFilings }) {
  disposeScreener();
  let destroyed = false;
  let settings = loadSettings();
  let status = null;
  let sortKey = 'passed';
  let sortDir = -1;
  let shown = PAGE;
  let popover = null;

  // ----- skeleton -----
  const statusText = el('span', { cls: 'scr-status', text: 'Loading…' });
  const refreshBtn = el('button', { cls: 'btn btn-ghost btn-inline scr-refresh', text: '↻ Refresh data', attrs: { type: 'button' } });
  const progress = el('div', { cls: 'scr-progress', attrs: { hidden: '' } }, [el('div', { cls: 'scr-bar' }), el('span', { cls: 'scr-progress-text' })]);
  const topCard = el('div', { cls: 'card scr-top' }, [el('span', { cls: 'section-label scr-title', text: 'Screener' }), statusText, el('span', { cls: 'scr-spacer' }), refreshBtn, progress]);
  const rulesCard = el('div', { cls: 'card scr-rules' });
  const resultsHead = el('div', { cls: 'scr-results-head' });
  const tableWrap = el('div', { cls: 'scr-table-wrap' });
  const resultsCard = el('div', { cls: 'card scr-results' }, [resultsHead, tableWrap]);
  container.replaceChildren(el('div', { cls: 'scr-page' }, [topCard, el('div', { cls: 'scr-grid' }, [rulesCard, resultsCard])]));

  // ----- rules panel -----
  const activeRules = () => RULES.filter((r) => settings.rules[r.key].on);
  function changed() {
    const n = activeRules().length;
    if (settings.minPass > n) settings.minPass = n;
    saveSettings(settings);
    shown = PAGE;
    renderResults();
  }
  function ruleRow(rule) {
    const st = settings.rules[rule.key];
    const cb = el('input', { attrs: { type: 'checkbox', 'aria-label': rule.label } });
    cb.checked = st.on;
    cb.addEventListener('change', () => { st.on = cb.checked; renderRules(); changed(); });
    const label = el('span', { cls: 'scr-rule-label', text: `${rule.label}${rule.op === '>=' ? ' ≥' : rule.op === '>' ? ' >' : rule.op === '<=' ? ' ≤' : ''}`, attrs: { title: rule.help } });
    let input = el('span');
    if (rule.def !== null) {
      input = el('span', { cls: 'scr-input-wrap' }, [
        el('input', { cls: 'scr-num mono', attrs: { type: 'number', step: rule.fmt === 'pct' ? '1' : '0.1', value: toInput(rule, st.value), 'aria-label': `${rule.label} threshold` }, on: { input: (e) => { const v = fromInput(rule, e.target.value); if (v !== null) { st.value = v; changed(); } } } }),
        el('span', { cls: 'scr-unit', text: unitOf(rule) }),
      ]);
    }
    return el('div', { cls: `scr-rule${st.on ? '' : ' off'}` }, [cb, label, input]);
  }
  let optOpen = RULES.some((r) => !r.core && settings.rules[r.key].on);
  function renderRules() {
    const n = activeRules().length;
    const optToggle = el('button', { cls: 'scr-opt-toggle', text: `Optional rules ${optOpen ? '▴' : '▾'}`, attrs: { type: 'button' }, on: { click: () => { optOpen = !optOpen; renderRules(); } } });
    const minPass = el('input', { cls: 'scr-num mono', attrs: { type: 'number', min: '1', max: String(Math.max(1, n)), step: '1', value: String(settings.minPass), 'aria-label': 'Minimum rules passed' }, on: { input: (e) => { const v = parseInt(e.target.value, 10); if (v >= 1) { settings.minPass = Math.min(v, n); changed(); } } } });
    const missing = el('select', { cls: 'scr-select', attrs: { 'aria-label': 'Missing data' }, on: { change: (e) => { settings.missing = e.target.value; changed(); } } }, [el('option', { text: "doesn't fail", attrs: { value: 'skip' } }), el('option', { text: 'fails', attrs: { value: 'fail' } })]);
    missing.value = settings.missing;
    const hold = el('input', { cls: 'scr-num mono', attrs: { type: 'number', min: '1', max: '5', step: '1', value: String(settings.hold), 'aria-label': 'Years a rule must hold' }, on: { input: (e) => { const v = parseInt(e.target.value, 10); if (v >= 1 && v <= 5) { settings.hold = v; changed(); } } } });
    const reset = el('button', { cls: 'btn btn-ghost btn-inline', text: 'Reset to defaults', attrs: { type: 'button' }, on: { click: () => { settings = defaultSettings(); renderRules(); changed(); } } });
    rulesCard.replaceChildren(
      el('div', { cls: 'section-label', text: 'Core rules' }),
      ...RULES.filter((r) => r.core).map(ruleRow),
      optToggle,
      ...(optOpen ? RULES.filter((r) => !r.core).map(ruleRow) : []),
      el('div', { cls: 'section-label scr-settings-label', text: 'Settings' }),
      el('div', { cls: 'scr-setting' }, [el('span', { text: 'Pass at least' }), minPass, el('span', { text: `of ${n}` })]),
      el('div', { cls: 'scr-setting' }, [el('span', { text: 'Missing data' }), missing]),
      el('div', { cls: 'scr-setting' }, [el('span', { text: 'Rule must hold' }), hold, el('span', { text: `of ${dataset?.years?.length || 5} yrs` })]),
      reset,
    );
  }

  // ----- results -----
  const sortValue = (item, key) => {
    if (key === 'passed') return item.passed / Math.max(1, item.counted) + item.passed / 100;
    if (key === 'ticker') return item.row[0];
    const v = latest(item.row[FIELD_INDEX[key]]);
    return v === null ? null : v;
  };
  function renderResults() {
    closePopover();
    if (!dataset) return;
    const items = screen(dataset.companies, settings);
    items.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * -sortDir;
      return (va - vb) * sortDir;
    });
    const cols = activeRules();
    resultsHead.replaceChildren(
      el('span', { cls: 'scr-count' }, [el('span', { cls: 'mono', text: items.length.toLocaleString() }), el('span', { text: ` ${items.length === 1 ? 'company passes' : 'companies pass'}` })]),
      el('span', { cls: 'scr-dim', text: 'updates as you change rules · click a value for its history · click a row to open in Filings' }),
    );
    if (!cols.length) { tableWrap.replaceChildren(el('div', { cls: 'empty-state', text: 'Turn on at least one rule.' })); return; }
    if (!items.length) { tableWrap.replaceChildren(el('div', { cls: 'empty-state', text: 'No companies pass these rules. Loosen a threshold or lower "Pass at least".' })); return; }

    const headCell = (text, key, num = true) => {
      const th = el('th', { cls: num ? 'num' : '', text: `${text}${sortKey === key ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}`, attrs: { title: 'Sort' } });
      th.addEventListener('click', () => { if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = key === 'ticker' ? 1 : -1; } renderResults(); });
      return th;
    };
    const short = { gm: 'GM', nm: 'NM', sga: 'SG&A', int: 'Int', de: 'D/E', ltd: 'LTD yrs', eps: 'EPS', roe: 'ROE', cr: 'CR', reUp: 'RE' };
    const table = el('table', { cls: 'val-table scr-table' });
    table.append(el('thead', {}, [el('tr', {}, [headCell('Company', 'ticker', false), headCell('Pass', 'passed'), ...cols.map((r) => headCell(short[r.key], r.key)), el('th', { text: '' })])]));
    const body = el('tbody');
    for (const it of items.slice(0, shown)) {
      const [ticker, name] = it.row;
      const tr = el('tr', { attrs: { title: `Open ${ticker} in Filings` } });
      tr.addEventListener('click', () => onOpenFilings(ticker));
      tr.append(
        el('td', {}, [el('div', { cls: 'mono scr-ticker', text: ticker }), el('div', { cls: 'scr-name', text: name })]),
        el('td', { cls: `num ${it.passed === it.counted ? 'up' : ''}`, text: `${it.passed}/${it.counted}` }),
      );
      for (const rule of cols) {
        const st = it.results[rule.key];
        const series = it.row[FIELD_INDEX[rule.key]];
        const td = el('td', { cls: `num scr-cell ${st === 'pass' ? 'up' : st === 'fail' ? 'down' : 'na'}`, text: rule.op === 'noloss' ? (st === 'pass' ? '✓' : st === 'fail' ? '✗' : 'N/A') : fmtVal(rule, latest(series)) });
        td.addEventListener('click', (e) => { e.stopPropagation(); openPopover(td, ticker, rule, series); });
        tr.append(td);
      }
      const watch = el('button', { cls: 'scr-watch', text: '+', attrs: { type: 'button', title: `Add ${ticker} to watchlist`, 'aria-label': `Add ${ticker} to watchlist` } });
      watch.addEventListener('click', async (e) => {
        e.stopPropagation();
        watch.disabled = true;
        const ok = await addToWatchlist(ticker).catch(() => false);
        watch.textContent = ok ? '✓' : '+';
        watch.title = ok ? 'On watchlist' : 'Could not add';
        if (!ok) watch.disabled = false;
      });
      tr.append(el('td', {}, [watch]));
      body.append(tr);
    }
    table.append(body);
    const nodes = [el('div', { cls: 'table-scroll' }, [table])];
    if (items.length > shown) nodes.push(el('button', { cls: 'btn btn-ghost btn-inline scr-more', text: `Show ${Math.min(PAGE, items.length - shown)} more`, attrs: { type: 'button' }, on: { click: () => { shown += PAGE; renderResults(); } } }));
    tableWrap.replaceChildren(...nodes);
  }

  // ----- history popover -----
  function closePopover() { if (popover) { popover.remove(); popover = null; } }
  function openPopover(cell, ticker, rule, series) {
    closePopover();
    const years = dataset.years;
    const threshold = settings.rules[rule.key].value;
    const rows = years.map((y, i) => {
      const v = series?.[i] ?? null;
      let cls = 'na';
      if (v !== null) {
        const st = rule.op === 'noloss' ? (v > 0 ? 'pass' : 'fail') : evaluate(rule, [v], threshold, 1);
        cls = st === 'pass' ? 'up' : st === 'fail' ? 'down' : 'na';
      }
      return el('div', { cls: 'scr-pop-row' }, [el('span', { cls: 'mono', text: `FY${y}` }), el('span', { cls: `mono ${cls}`, text: fmtVal(rule, v) })]);
    });
    popover = el('div', { cls: 'scr-pop' }, [el('div', { cls: 'scr-pop-title', text: `${ticker} · ${rule.label}` }), ...rows, el('div', { cls: 'scr-pop-note', text: rule.help })]);
    document.body.append(popover);
    const r = cell.getBoundingClientRect();
    popover.style.top = `${window.scrollY + r.bottom + 6}px`;
    popover.style.left = `${Math.max(8, window.scrollX + r.right - 220)}px`;
  }
  const onDocClick = (e) => { if (popover && !popover.contains(e.target)) closePopover(); };
  document.addEventListener('click', onDocClick);

  // ----- data status and refresh -----
  function paintStatus() {
    const ds = status?.dataset;
    if (!ds) { statusText.textContent = 'No data yet. Click Refresh data to pull the whole market from SEC (a few minutes).'; return; }
    const y = ds.years || [];
    statusText.textContent = `Data: ${Number(ds.companies).toLocaleString()} companies · FY${y[0]}–${y[y.length - 1]} · refreshed ${new Date(ds.builtAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  async function loadStatus() {
    try {
      const res = await fetch('/api/screener?action=status');
      if (res.ok) status = await res.json();
    } catch (err) { console.error(err); }
    if (!destroyed) paintStatus();
  }
  async function loadData(force = false) {
    if (dataset && !force) { renderRules(); renderResults(); return; }
    tableWrap.replaceChildren(el('div', { cls: 'empty-state', text: 'Loading screener data…' }));
    try {
      const res = await fetch('/api/screener?action=data');
      if (res.status === 404) { dataset = null; renderRules(); tableWrap.replaceChildren(el('div', { cls: 'empty-state', text: 'No screener data yet. Click "Refresh data" above to pull it from SEC.' })); return; }
      if (!res.ok) throw new Error(`status ${res.status}`);
      dataset = await res.json();
    } catch (err) {
      console.error(err);
      if (!destroyed) tableWrap.replaceChildren(el('div', { cls: 'empty-state error-state', text: 'Could not load the screener data.' }));
      return;
    }
    if (destroyed) return;
    renderRules();
    renderResults();
  }
  let refreshing = false;
  async function refreshAll() {
    if (refreshing) return;
    if (!window.confirm('Pull fresh data for the whole market from SEC? It takes a few minutes; keep this tab open.')) return;
    refreshing = true;
    refreshBtn.disabled = true;
    progress.hidden = false;
    const bar = progress.querySelector('.scr-bar');
    const text = progress.querySelector('.scr-progress-text');
    const metrics = status?.metrics || [];
    const total = metrics.length + 1;
    try {
      for (let i = 0; i < metrics.length; i++) {
        if (destroyed) return;
        text.textContent = `${i + 1}/${total} · ${metrics[i]}`;
        bar.style.width = `${(i / total) * 100}%`;
        const res = await fetch(`/api/screener?action=refresh&metric=${encodeURIComponent(metrics[i])}`, { method: 'POST' });
        if (!res.ok) throw new Error(`${metrics[i]}: ${res.status}`);
      }
      text.textContent = `${total}/${total} · building`;
      bar.style.width = `${((total - 1) / total) * 100}%`;
      const res = await fetch('/api/screener?action=build', { method: 'POST' });
      if (!res.ok) throw new Error(`build: ${res.status}`);
      bar.style.width = '100%';
      text.textContent = 'Done';
      await loadStatus();
      await loadData(true);
    } catch (err) {
      console.error('screener refresh failed:', err);
      text.textContent = `Stopped (${err.message}). Click Refresh data to try again.`;
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      setTimeout(() => { if (!refreshing) progress.hidden = true; }, 4000);
    }
  }
  refreshBtn.addEventListener('click', refreshAll);

  cleanup = () => { destroyed = true; closePopover(); document.removeEventListener('click', onDocClick); };
  renderRules();
  loadStatus();
  loadData();
}
