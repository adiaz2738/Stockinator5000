// Screener page (/screener): Buffett-style rules over the whole market (SEC frames data, refreshed on demand and
// stored in Neon). Results update instantly as rules change. All text goes through textContent.

import { RULES, FIELD_INDEX, RANGE_KEYS, BIOTECH_SICS, defaultSettings, screen, latest, evaluate, marketFigures, applyFilters, isFinancial, cagrOf } from './screener-rules.js';
import { addToWatchlist } from './watchlist.js';

const LS_KEY = 'vl.screener.v1';
const LS_SCREEN = 'vl.screener.screen';
const PAGE = 200;
const INDUSTRY_BATCH = 40;
const INDUSTRY_AUTO_MAX = 400;   // industries looked up automatically per screen (the rest when the results narrow)
const QUOTE_BATCH = 500;
const QUOTE_TTL = 5 * 60 * 1000; // prices are refetched after 5 minutes
const METRIC_FRESH_MS = 20 * 3600 * 1000; // Refresh data skips metrics pulled in the last 20 hours
let dataset = null; // cached for the session
let cleanup = null;
// Prices and buy-below prices for this session: { prices: {T: n}, buyBelow: {T: n}, tried: Set, at, schwab }
let market = { prices: {}, extra: {}, buyBelow: {}, tried: new Set(), at: 0, schwab: 'ok' };

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

const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// Settings from localStorage or a saved screen, checked field by field (anything unknown falls back to the default)
function normalizeSettings(s) {
  const d = defaultSettings();
  if (!s || typeof s !== 'object') return d;
  try {
    for (const r of RULES) {
      const v = s.rules?.[r.key];
      if (v && typeof v.on === 'boolean') d.rules[r.key].on = v.on;
      if (v && Number.isFinite(v.value)) d.rules[r.key].value = v.value;
    }
    if (Number.isInteger(s.minPass)) d.minPass = s.minPass;
    if (s.missing === 'skip' || s.missing === 'fail') d.missing = s.missing;
    if (Number.isInteger(s.hold) && s.hold >= 1 && s.hold <= 5) d.hold = s.hold;
    const f = s.filters || {};
    d.filters.buyZoneOnly = f.buyZoneOnly === true;
    if (f.ind && Array.isArray(f.ind.sics)) {
      d.filters.ind = { mode: f.ind.mode === 'exclude' ? 'exclude' : 'include', sics: f.ind.sics.filter((x) => Number.isInteger(x)).slice(0, 1000) };
    } else if (f.exBio === true) {
      d.filters.ind = { mode: 'exclude', sics: [...BIOTECH_SICS] }; // settings saved before the industry picker
    }
    for (const k of RANGE_KEYS) {
      const r = f.ranges?.[k];
      if (Array.isArray(r)) d.filters.ranges[k] = [numOrNull(r[0]), numOrNull(r[1])];
    }
    // settings saved before ranges existed
    if (f.mcapMin !== undefined && !f.ranges) d.filters.ranges.mcap[0] = numOrNull(f.mcapMin);
    if (f.peMax !== undefined && !f.ranges) d.filters.ranges.pe[1] = numOrNull(f.peMax);
    if (f.priceMax !== undefined && !f.ranges) d.filters.ranges.price[1] = numOrNull(f.priceMax);
  } catch (err) { return defaultSettings(); }
  return d;
}
function loadSettings() {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(LS_KEY) || 'null')); } catch (err) { return defaultSettings(); }
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
    case 'cagr': return fmtCap(v); // per-year values in the history popover are revenue
    default: return String(v);
  }
};
// Threshold shown to the user: percentages as whole numbers ("40"), others as-is
const isPctRule = (rule) => rule.fmt === 'pct' || rule.fmt === 'cagr';
const toInput = (rule, v) => (isPctRule(rule) ? String(Math.round(v * 1000) / 10) : String(v));
const fromInput = (rule, s) => { const n = Number(s); return Number.isFinite(n) ? (isPctRule(rule) ? n / 100 : n) : null; };
const fmtMoney = (v) => (v === null ? '—' : `$${v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}`);
const fmtCap = (v) => {
  if (v === null) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${Math.round(v / 1e6)}M`;
  return `$${Math.round(v / 1e3)}K`;
};
const unitOf = (rule) => (isPctRule(rule) ? '%' : rule.fmt === 'yrs' ? 'yrs' : rule.fmt === 'x' ? '×' : '');

export function renderScreener(container, { onOpenFilings }) {
  disposeScreener();
  // prices and buy-below prices are reloaded each visit (a valuation saved elsewhere shows up here)
  market = { prices: {}, extra: {}, buyBelow: {}, tried: new Set(), at: 0, schwab: market.schwab };
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
  const screensBox = el('div', { cls: 'scr-screens' });
  const topCard = el('div', { cls: 'card scr-top' }, [el('span', { cls: 'section-label scr-title', text: 'Screener' }), statusText, el('span', { cls: 'scr-spacer' }), screensBox, refreshBtn, progress]);
  const rulesCard = el('div', { cls: 'card scr-rules' });
  const resultsHead = el('div', { cls: 'scr-results-head' });
  const tableWrap = el('div', { cls: 'scr-table-wrap' });
  // Search: ticker or company name. By default within the results; "All companies" ignores the rules and filters
  let query = '';
  let searchAll = false;
  const searchInput = el('input', { cls: 'scr-search-input', attrs: { type: 'search', placeholder: 'Search ticker or company  ( / )', 'aria-label': 'Search ticker or company', autocomplete: 'off', spellcheck: 'false' } });
  const searchAllBox = el('input', { attrs: { type: 'checkbox', 'aria-label': 'Search all companies' } });
  let searchTimer = null;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { query = searchInput.value.trim(); shown = PAGE; renderResults(); }, 150); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchInput.value = ''; query = ''; renderResults(); } });
  searchAllBox.addEventListener('change', () => { searchAll = searchAllBox.checked; shown = PAGE; renderResults(); });
  const searchBar = el('div', { cls: 'scr-search' }, [
    el('span', { cls: 'scr-search-icon', text: '⌕' }), searchInput,
    el('label', { cls: 'scr-search-all', attrs: { title: 'Search every company, ignoring the rules and filters (non-passing companies are marked)' } }, [searchAllBox, el('span', { text: 'All companies' })]),
  ]);
  const onSlash = (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    searchInput.focus();
  };
  document.addEventListener('keydown', onSlash);
  const resultsCard = el('div', { cls: 'card scr-results' }, [searchBar, resultsHead, tableWrap]);
  container.replaceChildren(el('div', { cls: 'scr-page' }, [topCard, el('div', { cls: 'scr-grid' }, [rulesCard, resultsCard])]));

  // ----- rules panel -----
  const activeRules = () => RULES.filter((r) => settings.rules[r.key].on);
  function changed() {
    const n = activeRules().length;
    if (n && settings.minPass > n) settings.minPass = n;
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
        el('input', { cls: 'scr-num mono', attrs: { type: 'number', step: isPctRule(rule) ? '1' : '0.1', value: toInput(rule, st.value), 'aria-label': `${rule.label} threshold` }, on: { input: (e) => { const v = fromInput(rule, e.target.value); if (v !== null) { st.value = v; changed(); } } } }),
        el('span', { cls: 'scr-unit', text: unitOf(rule) }),
      ]);
    }
    return el('div', { cls: `scr-rule${st.on ? '' : ' off'}` }, [cb, label, input]);
  }
  // ----- industry and valuation filters -----
  const fl = () => settings.filters;
  // ----- industry picker: check any number of industries, then show only those or exclude them -----
  let indOpen = false;
  let indSearch = '';
  let indList = null;
  let indBtn = null;
  const indSummary = () => {
    const { mode, sics } = fl().ind;
    if (!sics.length) return 'All industries';
    return `${mode === 'include' ? 'Only' : 'Excluding'} ${sics.length} ${sics.length === 1 ? 'industry' : 'industries'}`;
  };
  // Every industry known so far, with how many companies are in it (unclassified = -1)
  function industryCatalog() {
    const m = new Map();
    for (const [sic, desc] of Object.values(dataset?.industries || {})) {
      const code = sic ?? -1;
      const e = m.get(code) || { sic: code, desc: code === -1 ? 'Unclassified' : (desc || `SIC ${code}`), n: 0 };
      e.n++;
      m.set(code, e);
    }
    for (const code of fl().ind.sics) if (!m.has(code)) m.set(code, { sic: code, desc: code === -1 ? 'Unclassified' : `SIC ${code}`, n: 0 });
    return [...m.values()].sort((a, b) => a.desc.localeCompare(b.desc));
  }
  function setSics(list) {
    fl().ind.sics = [...new Set(list)];
    if (indBtn) indBtn.textContent = `${indSummary()} ▾`;
    paintIndList();
    changed();
  }
  function paintIndList() {
    if (!indList) return;
    const chosen = new Set(fl().ind.sics);
    const q = indSearch.trim().toLowerCase();
    const all = industryCatalog().filter((e) => !q || e.desc.toLowerCase().includes(q) || String(e.sic).includes(q));
    // checked industries first
    all.sort((a, b) => (chosen.has(b.sic) - chosen.has(a.sic)) || a.desc.localeCompare(b.desc));
    indList.replaceChildren(...(all.length ? all.map((e) => {
      const cb = el('input', { attrs: { type: 'checkbox', 'aria-label': e.desc } });
      cb.checked = chosen.has(e.sic);
      cb.addEventListener('change', () => setSics(cb.checked ? [...fl().ind.sics, e.sic] : fl().ind.sics.filter((x) => x !== e.sic)));
      return el('label', { cls: 'scr-ind-row', attrs: { title: e.sic === -1 ? 'No industry code on file' : `SIC ${e.sic}` } }, [cb, el('span', { cls: 'scr-ind-name', text: e.desc }), el('span', { cls: 'scr-ind-n mono', text: String(e.n) })]);
    }) : [el('div', { cls: 'scr-dim', text: dataset?.industries && Object.keys(dataset.industries).length ? 'No industry matches.' : 'Industries appear after Refresh data looks them up.' })]));
  }
  function industryPicker() {
    indBtn = el('button', { cls: 'scr-select scr-ind-btn', text: `${indSummary()} ▾`, attrs: { type: 'button', 'aria-expanded': String(indOpen) } });
    const panel = el('div', { cls: 'scr-ind-panel', attrs: indOpen ? {} : { hidden: '' } });
    indBtn.addEventListener('click', () => { indOpen = !indOpen; panel.hidden = !indOpen; indBtn.setAttribute('aria-expanded', String(indOpen)); if (indOpen) paintIndList(); });
    const mode = el('select', { cls: 'scr-select', attrs: { 'aria-label': 'Industry filter mode' } }, [
      el('option', { text: 'Show only checked', attrs: { value: 'include' } }),
      el('option', { text: 'Exclude checked', attrs: { value: 'exclude' } }),
    ]);
    mode.value = fl().ind.mode;
    mode.addEventListener('change', () => { fl().ind.mode = mode.value; indBtn.textContent = `${indSummary()} ▾`; changed(); });
    const search = el('input', { cls: 'scr-ind-search', attrs: { type: 'search', placeholder: 'Search industries', value: indSearch, 'aria-label': 'Search industries' } });
    search.addEventListener('input', () => { indSearch = search.value; paintIndList(); });
    const preset = (label, title, codes) => el('button', { cls: 'scr-chip', text: label, attrs: { type: 'button', title }, on: { click: () => {
      const list = codes();
      const cur = new Set(fl().ind.sics);
      const allIn = list.length && list.every((c) => cur.has(c));
      setSics(allIn ? fl().ind.sics.filter((c) => !list.includes(c)) : [...fl().ind.sics, ...list]);
    } } });
    indList = el('div', { cls: 'scr-ind-list' });
    panel.append(
      el('div', { cls: 'scr-ind-tools' }, [mode]),
      search,
      el('div', { cls: 'scr-ind-tools' }, [
        preset('Biotech / pharma', 'SIC 2833–2836 and 8731', () => [...BIOTECH_SICS]),
        preset('Banks, insurers, asset mgrs', 'SIC 6000–6499 and 6700–6799, REITs stay in', () => industryCatalog().map((e) => e.sic).filter(isFinancial)),
        el('button', { cls: 'scr-chip', text: 'Check all', attrs: { type: 'button' }, on: { click: () => setSics(industryCatalog().filter((e) => !indSearch || e.desc.toLowerCase().includes(indSearch.toLowerCase())).map((e) => e.sic)) } }),
        el('button', { cls: 'scr-chip', text: 'Clear', attrs: { type: 'button' }, on: { click: () => setSics([]) } }),
      ]),
      indList,
    );
    if (indOpen) paintIndList();
    return el('div', { cls: 'scr-ind' }, [indBtn, panel]);
  }
  function filtersBlock() {
    const check = (key, label, title) => {
      const cb = el('input', { attrs: { type: 'checkbox', 'aria-label': label } });
      cb.checked = fl()[key];
      cb.addEventListener('change', () => { fl()[key] = cb.checked; changed(); });
      return el('label', { cls: 'scr-filter-check', attrs: title ? { title } : {} }, [cb, el('span', { text: label })]);
    };
    // min – max inputs; either side can be left empty
    const rangeInput = (key, label, unit, scale = 1) => {
      const box = (side, ph) => {
        const v = fl().ranges[key][side];
        const input = el('input', { cls: 'scr-num scr-range-num mono', attrs: { type: 'number', min: '0', step: 'any', placeholder: ph, value: v === null ? '' : String(v / scale), 'aria-label': `${label} ${ph}` } });
        input.addEventListener('input', () => { const n = input.value === '' ? null : Number(input.value); if (n === null || Number.isFinite(n)) { fl().ranges[key][side] = n === null ? null : n * scale; changed(); } });
        return input;
      };
      return el('div', { cls: 'scr-setting scr-range' }, [el('span', { cls: 'scr-filter-label', text: label }), box(0, 'min'), el('span', { cls: 'scr-dash', text: '–' }), box(1, 'max'), el('span', { cls: 'scr-unit', text: unit })]);
    };
    return el('div', { cls: 'scr-filters' }, [
      el('div', { cls: 'section-label', text: 'Industry' }),
      industryPicker(),
      el('div', { cls: 'section-label scr-settings-label', text: 'Valuation' }),
      rangeInput('mcap', 'Market cap', '$M', 1e6),
      rangeInput('pe', 'P/E', '×'),
      rangeInput('pb', 'P/B', '×'),
      rangeInput('ps', 'P/S', '×'),
      rangeInput('price', 'Price', '$'),
      check('buyZoneOnly', 'Buy zone only', 'Price at or below the buy-below price of your latest saved valuation'),
    ]);
  }

  let optOpen = RULES.some((r) => !r.core && settings.rules[r.key].on);
  function renderRules() {
    const n = activeRules().length;
    const optToggle = el('button', { cls: 'scr-opt-toggle', text: `Optional rules ${optOpen ? '▴' : '▾'}`, attrs: { type: 'button' }, on: { click: () => { optOpen = !optOpen; renderRules(); } } });
    const minPass = el('input', { cls: 'scr-num mono', attrs: { type: 'number', min: '1', max: String(Math.max(1, n)), step: '1', value: String(n ? settings.minPass : 0), 'aria-label': 'Minimum rules passed', ...(n ? {} : { disabled: '' }) }, on: { input: (e) => { const v = parseInt(e.target.value, 10); if (v >= 1) { settings.minPass = Math.min(v, n); changed(); } } } });
    const missing = el('select', { cls: 'scr-select', attrs: { 'aria-label': 'Missing data' }, on: { change: (e) => { settings.missing = e.target.value; changed(); } } }, [el('option', { text: "doesn't fail", attrs: { value: 'skip' } }), el('option', { text: 'fails', attrs: { value: 'fail' } })]);
    missing.value = settings.missing;
    const hold = el('input', { cls: 'scr-num mono', attrs: { type: 'number', min: '1', max: '5', step: '1', value: String(settings.hold), 'aria-label': 'Years a rule must hold' }, on: { input: (e) => { const v = parseInt(e.target.value, 10); if (v >= 1 && v <= 5) { settings.hold = v; changed(); } } } });
    const reset = el('button', { cls: 'btn btn-ghost btn-inline', text: 'Reset to defaults', attrs: { type: 'button' }, on: { click: () => { settings = defaultSettings(); renderRules(); changed(); } } });
    const setAll = (on) => { for (const r of RULES) if (r.core || !on) settings.rules[r.key].on = on; if (on && settings.minPass < 1) settings.minPass = 1; renderRules(); changed(); };
    rulesCard.replaceChildren(
      el('div', { cls: 'scr-rules-head' }, [
        el('div', { cls: 'section-label', text: 'Core rules' }),
        el('span', { cls: 'scr-rules-links' }, [
          el('button', { cls: 'scr-link', text: 'All core', attrs: { type: 'button', title: 'Turn on every core rule' }, on: { click: () => setAll(true) } }),
          el('button', { cls: 'scr-link', text: 'None', attrs: { type: 'button', title: 'Turn every rule off: a plain screener on the filters below' }, on: { click: () => setAll(false) } }),
        ]),
      ]),
      ...RULES.filter((r) => r.core).map(ruleRow),
      optToggle,
      ...(optOpen ? RULES.filter((r) => !r.core).map(ruleRow) : []),
      filtersBlock(),
      el('div', { cls: 'section-label scr-settings-label', text: 'Settings' }),
      el('div', { cls: 'scr-setting' }, [el('span', { text: 'Pass at least' }), minPass, el('span', { text: `of ${n}` })]),
      el('div', { cls: 'scr-setting' }, [el('span', { text: 'Missing data' }), missing]),
      el('div', { cls: 'scr-setting' }, [el('span', { text: 'Rule must hold' }), hold, el('span', { text: `of ${dataset?.years?.length || 5} yrs` })]),
      reset,
    );
  }

  // ----- results -----
  const industryOf = (row) => dataset?.industries?.[row[2]];
  const figuresOf = (row) => marketFigures(row, market.prices[row[0]], market.buyBelow[row[0]]);
  const infoOf = (row) => { const ind = industryOf(row); return { sic: ind ? ind[0] : undefined, desc: ind ? ind[1] : null, m: figuresOf(row) }; };
  let lastRuleItems = [];

  // Background lookups for the companies that pass the rules: industries (cached in Neon) and prices
  let industryBusy = false;
  let quotesBusy = false;
  let industryPending = 0;
  const industryTried = new Set();
  async function lookupIndustries(items) {
    if (industryBusy || !dataset) return;
    const todo = items.map((it) => it.row[2]).filter((cik) => !dataset.industries?.[cik] && !industryTried.has(cik)).slice(0, INDUSTRY_AUTO_MAX);
    if (!todo.length) return;
    industryBusy = true;
    industryPending = todo.length;
    paintHead();
    try {
      for (let i = 0; i < todo.length && !destroyed; i += INDUSTRY_BATCH) {
        const batch = todo.slice(i, i + INDUSTRY_BATCH);
        batch.forEach((c) => industryTried.add(c));
        const res = await fetch('/api/screener?action=industry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ciks: batch }) });
        if (!res.ok) throw new Error(`industry ${res.status}`);
        const { industries } = await res.json();
        dataset.industries = { ...(dataset.industries || {}), ...industries };
        industryPending = Math.max(0, todo.length - i - batch.length);
        if (!destroyed) { paintIndList(); renderResults(true); }
      }
    } catch (err) {
      console.error('industry lookup failed:', err);
    } finally {
      industryBusy = false;
      industryPending = 0;
      if (!destroyed) renderResults(true);
    }
  }
  async function loadQuotes(items) {
    if (quotesBusy) return;
    if (Date.now() - market.at > QUOTE_TTL && market.at) market = { prices: {}, extra: {}, buyBelow: market.buyBelow, tried: new Set(), at: 0, schwab: market.schwab };
    const todo = items.map((it) => it.row[0]).filter((t) => !market.tried.has(t)).slice(0, QUOTE_BATCH);
    if (!todo.length) return;
    quotesBusy = true;
    todo.forEach((t) => market.tried.add(t));
    try {
      const res = await fetch('/api/screener?action=quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers: todo }) });
      if (!res.ok) throw new Error(`quotes ${res.status}`);
      const q = await res.json();
      Object.assign(market.prices, q.prices || {});
      Object.assign(market.extra, q.extra || {});
      market.buyBelow = q.buyBelow || {};
      market.schwab = q.schwab;
      if (!market.at) market.at = q.at || Date.now();
    } catch (err) {
      console.error('screener quotes failed:', err);
      market.schwab = 'error';
    } finally {
      quotesBusy = false;
      if (!destroyed) renderResults(true);
    }
  }

  let headInfo = { count: 0, noPrice: 0 };
  const selected = new Set();
  let bulkMsg = '';
  async function addSelected() {
    const tickers = [...selected];
    bulkMsg = 'adding…';
    paintHead();
    try {
      const res = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) });
      const body = await res.json().catch(() => ({}));
      bulkMsg = res.ok ? `added ${tickers.length} to the watchlist` : (body.error || 'could not add');
      if (res.ok) selected.clear();
    } catch (err) {
      bulkMsg = 'could not add';
    }
    if (!destroyed) renderResults(true);
    setTimeout(() => { bulkMsg = ''; if (!destroyed) paintHead(); }, 5000);
  }
  function paintHead() {
    const notes = [];
    if (industryPending) notes.push(`looking up industries… ${industryPending} left`);
    if (quotesBusy) notes.push('loading prices…');
    if (market.schwab === 'not_connected') notes.push('connect Schwab to see prices');
    else if (market.schwab === 'error') notes.push('prices unavailable right now');
    if (headInfo.noPrice) notes.push(`${headInfo.noPrice} without a price left out by the valuation filters`);
    const bulk = selected.size ? [el('span', { cls: 'scr-bulk' }, [
      el('span', { text: `${selected.size} selected` }),
      el('button', { cls: 'btn btn-ghost btn-inline scr-screen-btn', text: '+ Add to watchlist', attrs: { type: 'button' }, on: { click: addSelected } }),
      el('button', { cls: 'btn btn-ghost btn-inline scr-screen-btn', text: 'Clear', attrs: { type: 'button' }, on: { click: () => { selected.clear(); renderResults(true); } } }),
      ...(bulkMsg ? [el('span', { cls: 'scr-note', text: bulkMsg })] : []),
    ])] : [];
    resultsHead.replaceChildren(
      ...bulk,
      el('span', { cls: 'scr-count' }, [el('span', { cls: 'mono', text: headInfo.count.toLocaleString() }), el('span', { text: query ? ` ${headInfo.count === 1 ? 'match' : 'matches'} for “${query}”${searchAll ? ' in all companies' : ' in the results'}` : ` ${headInfo.count === 1 ? 'company passes' : 'companies pass'}` })]),
      el('span', { cls: 'scr-dim', text: 'click a value for its history · click a row to open in Filings' }),
      el('button', { cls: 'btn btn-ghost btn-inline scr-screen-btn scr-export', text: 'Export CSV', attrs: { type: 'button', title: 'Download every row in the current list (not just the ones shown)' }, on: { click: exportCsv } }),
      ...(notes.length ? [el('span', { cls: 'scr-note', text: notes.join(' · ') })] : []),
    );
  }

  // How far the price is below its 52-week high (0 = at the high), and where it sits in the year's range
  const offHigh = (t) => { const p = market.prices[t]; const hi = market.extra[t]?.[0]; return Number.isFinite(p) && hi > 0 ? p / hi - 1 : null; };
  const rangePos = (t) => { const p = market.prices[t]; const [hi, lo] = market.extra[t] || []; return Number.isFinite(p) && hi > lo ? (p - lo) / (hi - lo) : null; };
  const sortValue = (item, key) => {
    if (key === 'passed') return item.counted ? item.passed / item.counted + item.passed / 100 : null;
    if (key === 'ticker') return item.row[0];
    if (key === 'industry') return industryOf(item.row)?.[1] || null;
    if (key === 'revGrowth') return cagrOf(item.row[FIELD_INDEX.rev]);
    if (key === 'divy') return market.extra[item.row[0]]?.[2] ?? null;
    if (key === 'off52') return offHigh(item.row[0]);
    if (['price', 'mcap', 'pe', 'pb', 'ps', 'zoneDist'].includes(key)) { const v = figuresOf(item.row)[key]; return v !== null && v < 0 && key !== 'zoneDist' ? null : v; }
    const v = latest(item.row[FIELD_INDEX[key]]);
    return v === null ? null : v;
  };
  // background = a re-render because industries or prices arrived: an open history popover stays open
  function renderResults(background = false) {
    if (!background) closePopover();
    if (!dataset) return;
    const ruleItems = screen(dataset.companies, settings);
    lastRuleItems = ruleItems;
    const f = settings.filters;
    const valuationOn = RANGE_KEYS.some((k) => f.ranges[k][0] !== null || f.ranges[k][1] !== null) || f.buyZoneOnly;
    let items = applyFilters(ruleItems, f, infoOf);
    // Search narrows the list: within the results, or across every company when "All companies" is on
    const q = query.toLowerCase();
    if (q) {
      const pool = searchAll ? screen(dataset.companies, settings, { all: true }) : items;
      const qu = query.toUpperCase();
      items = pool.filter((it) => it.row[0].startsWith(qu) || String(it.row[1]).toLowerCase().includes(q));
      // exact ticker first, then tickers starting with the text, then name matches
      const rank = (it) => (it.row[0] === qu ? 0 : it.row[0].startsWith(qu) ? 1 : 2);
      items.sort((a, b) => rank(a) - rank(b));
    }
    headInfo = { count: items.length, noPrice: valuationOn ? ruleItems.filter((it) => market.tried.has(it.row[0]) && !Number.isFinite(market.prices[it.row[0]])).length : 0 };
    if (!q) items.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * -sortDir;
      return (va - vb) * sortDir;
    });
    // Background lookups: everything when a filter or sort needs it, otherwise just the rows on screen
    const marketSort = ['price', 'mcap', 'pe', 'pb', 'ps', 'zoneDist'].includes(sortKey);
    const indOn = f.ind.sics.length > 0;
    const shownRows = items.slice(0, shown);
    // paused while Refresh data runs, so its requests aren't stuck behind these
    if (!refreshing) {
      lookupIndustries(indOn ? ruleItems : shownRows);
      loadQuotes(valuationOn || marketSort ? applyFilters(ruleItems, { ...f, ranges: {}, buyZoneOnly: false }, infoOf) : shownRows);
    }
    const cols = activeRules();
    lastItems = items;
    paintHead();
    if (!items.length) {
      const waiting = valuationOn && quotesBusy;
      const msg = waiting ? 'Loading prices…' : query ? (searchAll ? `No company matches “${query}”.` : `No company in the results matches “${query}”. Tick “All companies” to search everything.`) : 'No companies pass these rules and filters. Loosen a threshold, lower "Pass at least" or clear a filter.';
      tableWrap.replaceChildren(el('div', { cls: 'empty-state', text: msg }));
      return;
    }

    const headCell = (text, key, num = true) => {
      const th = el('th', { cls: num ? 'num' : '', text: `${text}${sortKey === key ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}`, attrs: { title: `${HEAD_HELP[key] || text}\nClick to sort.` } });
      th.addEventListener('click', () => { if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = key === 'ticker' ? 1 : -1; } renderResults(); });
      return th;
    };
    const HEAD_HELP = {
      ticker: 'Company: ticker and name',
      industry: 'Industry: SEC industry classification (SIC code)',
      passed: 'Pass: core rules passed out of those that could be measured',
      zoneDist: 'Buy zone: current price vs. the buy-below price of your latest saved valuation',
      price: 'Price: latest price from Schwab',
      mcap: 'Market cap: price × latest diluted share count',
      pe: 'Price / earnings: price ÷ latest full-year diluted EPS',
      pb: 'Price / book: market cap ÷ latest shareholders’ equity',
      ps: 'Price / sales: market cap ÷ latest full-year revenue',
      off52: '52-week range: how far the price is below its 52-week high (Schwab); the bar shows where it sits between the low and the high',
      divy: 'Dividend yield: as Schwab reports it (trailing dividends ÷ price)',
      revGrowth: 'Revenue growth: average per year from the first to the latest year with revenue',
      gm: 'Gross margin: gross profit ÷ revenue',
      nm: 'Net margin: net income ÷ revenue',
      sga: 'SG&A: selling, general and administrative expense ÷ gross profit',
      int: 'Interest: interest expense ÷ operating income',
      de: 'Debt / equity: total liabilities ÷ shareholders’ equity',
      ltd: 'Long-term debt in years of earnings: long-term debt ÷ net income',
      eps: 'EPS: diluted earnings per share above zero every year',
      roe: 'Return on equity: net income ÷ shareholders’ equity',
      cr: 'Current ratio: current assets ÷ current liabilities',
      reUp: 'Retained earnings: up year over year',
    };
    const short = { gm: 'GM', nm: 'NM', sga: 'SG&A', int: 'Int', de: 'D/E', ltd: 'LTD yrs', eps: 'EPS', roe: 'ROE', cr: 'CR', reUp: 'RE', revGrowth: 'Rev/yr' };
    const table = el('table', { cls: 'val-table scr-table' });
    const visible = items.slice(0, shown);
    const allBox = el('input', { attrs: { type: 'checkbox', 'aria-label': 'Select all shown', title: 'Select all shown' } });
    allBox.checked = visible.length > 0 && visible.every((it) => selected.has(it.row[0]));
    allBox.addEventListener('click', (e) => e.stopPropagation());
    allBox.addEventListener('change', () => { for (const it of visible) { if (allBox.checked) selected.add(it.row[0]); else selected.delete(it.row[0]); } renderResults(); });
    table.append(el('thead', {}, [el('tr', {}, [
      el('th', { cls: 'scr-sel' }, [allBox]),
      headCell('Company', 'ticker', false), headCell('Industry', 'industry', false), headCell('Pass', 'passed'),
      headCell('Buy zone', 'zoneDist', false), headCell('Price', 'price'), headCell('52-wk', 'off52'), headCell('Mkt cap', 'mcap'), headCell('P/E', 'pe'), headCell('P/B', 'pb'), headCell('P/S', 'ps'), headCell('Div yld', 'divy'),
      ...cols.map((r) => headCell(short[r.key], r.key)), el('th', { text: '' }),
    ])]));
    const body = el('tbody');
    for (const it of visible) {
      const [ticker, name] = it.row;
      const href = `/filings?ticker=${encodeURIComponent(ticker)}`;
      const tr = el('tr', { cls: selected.has(ticker) ? 'scr-selected' : '', attrs: { title: `Open ${ticker} in Filings` } });
      tr.addEventListener('click', () => onOpenFilings(ticker));
      const box = el('input', { attrs: { type: 'checkbox', 'aria-label': `Select ${ticker}` } });
      box.checked = selected.has(ticker);
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => { if (box.checked) selected.add(ticker); else selected.delete(ticker); renderResults(true); });
      // A real link, so right-click "Open in new tab", Ctrl+click and middle-click work. A plain click stays in the app.
      const link = el('a', { cls: 'mono scr-ticker', text: ticker, attrs: { href } });
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); onOpenFilings(ticker); }
      });
      const m = figuresOf(it.row);
      const tried = market.tried.has(ticker);
      const ratio = (v) => (v === null ? (tried ? '—' : '…') : v < 0 ? 'neg.' : v.toFixed(1));
      tr.append(
        el('td', { cls: 'scr-sel' }, [box]),
        el('td', {}, [link, el('div', { cls: 'scr-name', text: name })]),
        industryCell(it.row),
        el('td', { cls: `num ${it.qualifies === false ? 'down' : it.counted && it.passed === it.counted ? 'up' : 'na'}`, text: it.counted ? `${it.passed}/${it.counted}` : '—', attrs: { title: passTip(it) } }),
        zoneCell(m),
        el('td', { cls: `num${m.price === null ? ' na' : ''}`, text: m.price !== null ? fmtMoney(m.price) : tried ? '—' : '…' }),
        rangeCell(ticker, tried),
        el('td', { cls: `num${m.mcap === null ? ' na' : ''}`, text: m.mcap !== null ? fmtCap(m.mcap) : tried ? '—' : '…', attrs: { title: 'Price × latest diluted share count' } }),
        el('td', { cls: `num${m.pe === null || m.pe < 0 ? ' na' : ''}`, text: m.pe !== null && m.pe < 0 ? 'loss' : ratio(m.pe), attrs: { title: 'Price ÷ latest full-year diluted EPS' } }),
        el('td', { cls: `num${m.pb === null || m.pb < 0 ? ' na' : ''}`, text: ratio(m.pb), attrs: { title: 'Market cap ÷ latest shareholders’ equity (neg. = negative equity)' } }),
        el('td', { cls: `num${m.ps === null ? ' na' : ''}`, text: ratio(m.ps), attrs: { title: 'Market cap ÷ latest full-year revenue' } }),
        (() => { const y = market.extra[ticker]?.[2]; return el('td', { cls: `num${Number.isFinite(y) ? '' : ' na'}`, text: Number.isFinite(y) ? `${y.toFixed(2)}%` : tried ? '—' : '…' }); })(),
      );
      for (const rule of cols) {
        const st = it.results[rule.key];
        const series = it.row[FIELD_INDEX[rule.key]];
        const cellText = rule.op === 'noloss' ? (st === 'pass' ? '✓' : st === 'fail' ? '✗' : 'N/A') : rule.op === 'cagr' ? (cagrOf(series) === null ? 'N/A' : `${(cagrOf(series) * 100).toFixed(1)}%`) : fmtVal(rule, latest(series));
        const td = el('td', { cls: `num scr-cell ${st === 'pass' ? 'up' : st === 'fail' ? 'down' : 'na'}`, text: cellText });
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

  // CSV of the current list (all rows, current order). Numbers are raw (percentages as percent), blanks for N/A.
  let lastItems = [];
  function exportCsv() {
    const cols = RULES.filter((r) => settings.rules[r.key].on);
    const q = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const n = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : '');
    const head = ['Ticker', 'Company', 'Industry', 'Rules passed', 'Rules measured', 'Price', '% below 52-wk high', 'Market cap', 'P/E', 'P/B', 'P/S', 'Dividend yield %', 'Buy-below', ...cols.map((r) => (isPctRule(r) ? `${r.label} %` : r.label))];
    const lines = [head.map(q).join(',')];
    for (const it of lastItems) {
      const [ticker, name] = it.row;
      const m = figuresOf(it.row);
      const ruleVals = cols.map((r) => {
        const series = it.row[FIELD_INDEX[r.key]];
        if (r.op === 'noloss') return it.results[r.key] === 'pass' ? 'yes' : it.results[r.key] === 'fail' ? 'no' : '';
        if (r.op === 'cagr') { const g = cagrOf(series); return g === null ? '' : n(g * 100, 2); }
        const v = latest(series);
        return v === null ? '' : isPctRule(r) ? n(v * 100, 2) : n(v, 4);
      });
      const off = offHigh(ticker);
      lines.push([ticker, name, industryOf(it.row)?.[1] || '', it.passed, it.counted, n(m.price, 2), off === null ? '' : n(off * -100, 2), n(m.mcap, 0), m.pe > 0 ? n(m.pe, 2) : '', m.pb > 0 ? n(m.pb, 2) : '', n(m.ps, 2), n(market.extra[ticker]?.[2], 2), n(m.buyBelow, 2), ...ruleVals].map(q).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `screener-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // Pass cell tooltip: which active rules failed or had no data
  function passTip(it) {
    if (!it.counted) return 'No rules are on';
    const names = (st) => RULES.filter((r) => it.results[r.key] === st).map((r) => r.label);
    const failed = names('fail');
    const missing = names('missing');
    const lines = [`Passed ${it.passed} of ${it.counted} measurable rules`];
    if (failed.length) lines.push(`Failed: ${failed.join(', ')}`);
    if (missing.length) lines.push(`No data: ${missing.join(', ')}`);
    if (it.qualifies === false) lines.push("Doesn't pass your current settings (shown because of the search)");
    return lines.join('\n');
  }
  function rangeCell(t, tried) {
    const off = offHigh(t);
    const pos = rangePos(t);
    if (off === null) return el('td', { cls: 'num na', text: tried ? '—' : '…' });
    const [hi, lo] = market.extra[t];
    const bar = el('div', { cls: 'scr-range-bar' }, [el('div', { cls: 'scr-range-dot', attrs: { style: `left:${Math.round(Math.max(0, Math.min(1, pos ?? 0)) * 100)}%` } })]);
    return el('td', { cls: 'num scr-range-cell', attrs: { title: `52-week low ${fmtMoney(lo)} · high ${fmtMoney(hi)}` } }, [el('div', { text: off >= -0.0005 ? 'at high' : `${(off * 100).toFixed(1)}%` }), bar]);
  }
  function industryCell(row) {
    const ind = industryOf(row);
    const text = ind ? (ind[1] || 'Unclassified') : industryTried.has(row[2]) ? '—' : '…';
    return el('td', { cls: `scr-industry-cell${ind ? '' : ' na'}`, text, attrs: { title: ind ? `${ind[1] || 'No description'}${ind[0] ? ` (SIC ${ind[0]})` : ''}` : 'Not looked up yet' } });
  }
  function zoneCell(m) {
    if (m.buyBelow === null) return el('td', { cls: 'na scr-zone', text: 'No valuation', attrs: { title: 'Save a valuation for this ticker to get a buy-below price' } });
    if (m.zone === null) return el('td', { cls: 'scr-zone' }, [el('span', { cls: 'scr-tag', text: `Buy < ${fmtMoney(m.buyBelow)}` })]);
    const below = m.zone === 'below';
    return el('td', { cls: 'scr-zone', attrs: { title: `${(Math.abs(m.zoneDist) * 100).toFixed(1)}% ${below ? 'below' : 'above'} your buy-below price` } }, [
      el('span', { cls: `scr-tag ${below ? 'scr-tag-buy' : 'scr-tag-wait'}`, text: `${below ? 'Below' : 'Above'} ${fmtMoney(m.buyBelow)}` }),
    ]);
  }

  // ----- saved screens -----
  let screens = [];
  let currentScreen = (() => { try { return localStorage.getItem(LS_SCREEN) || ''; } catch (err) { return ''; } })();
  const setCurrent = (name) => { currentScreen = name; try { localStorage.setItem(LS_SCREEN, name); } catch (err) { /* ignore */ } };
  function paintScreens(msg = '') {
    const sel = el('select', { cls: 'scr-select', attrs: { 'aria-label': 'Saved screens' } }, [
      el('option', { text: screens.length ? 'choose…' : 'none saved', attrs: { value: '' } }),
      ...screens.map((sc) => el('option', { text: sc.name, attrs: { value: sc.name } })),
    ]);
    sel.value = screens.some((sc) => sc.name === currentScreen) ? currentScreen : '';
    sel.addEventListener('change', () => {
      const sc = screens.find((x) => x.name === sel.value);
      if (!sc) return;
      setCurrent(sc.name);
      settings = normalizeSettings(sc.settings);
      saveSettings(settings);
      renderRules();
      shown = PAGE;
      renderResults();
      paintScreens();
    });
    const save = el('button', { cls: 'btn btn-ghost btn-inline scr-screen-btn', text: 'Save as…', attrs: { type: 'button' }, on: { click: saveScreen } });
    const del = el('button', { cls: 'btn btn-ghost btn-inline scr-screen-btn', text: 'Delete', attrs: { type: 'button', title: 'Delete the selected saved screen' }, on: { click: deleteScreen } });
    screensBox.replaceChildren(el('span', { cls: 'scr-dim', text: 'Saved screens' }), sel, save, ...(sel.value ? [del] : []), ...(msg ? [el('span', { cls: 'scr-note', text: msg })] : []));
  }
  async function loadScreens() {
    try {
      const res = await fetch('/api/screener?action=screens');
      if (res.ok) screens = (await res.json()).screens || [];
    } catch (err) { console.error(err); }
    if (!destroyed) paintScreens();
  }
  async function saveScreen() {
    const name = (window.prompt('Name this screen', currentScreen) || '').trim();
    if (!name) return;
    if (screens.some((sc) => sc.name === name) && name !== currentScreen && !window.confirm(`Replace the saved screen "${name}"?`)) return;
    try {
      const res = await fetch('/api/screener?action=screens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, settings }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { paintScreens(body.error || 'Could not save'); return; }
      setCurrent(body.name || name);
      await loadScreens();
      paintScreens('Saved');
    } catch (err) { console.error(err); paintScreens('Could not save'); }
  }
  async function deleteScreen() {
    if (!currentScreen || !window.confirm(`Delete the saved screen "${currentScreen}"?`)) return;
    try {
      await fetch(`/api/screener?action=screens&name=${encodeURIComponent(currentScreen)}`, { method: 'DELETE' });
      setCurrent('');
      await loadScreens();
    } catch (err) { console.error(err); }
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
    // Missing metrics, or metrics pulled after the last build, mean the dataset is out of date
    const missing = (status.metrics || []).filter((mk) => !status.refreshed?.[mk]);
    const newer = (status.metrics || []).filter((mk) => status.refreshed?.[mk] && Date.parse(status.refreshed[mk].at) > Date.parse(ds.builtAt));
    if (missing.length || newer.length) {
      statusText.append(el('span', { cls: 'scr-note', text: ` · incomplete (${missing.length ? `not pulled yet: ${missing.join(', ')}` : 'not rebuilt since the last pull'}). Click Refresh data.` }));
    }
  }
  async function loadStatus() {
    try {
      const res = await fetch('/api/screener?action=status');
      if (res.ok) status = await res.json();
    } catch (err) { console.error(err); }
    if (!destroyed) paintStatus();
  }
  // The dataset (a few MB) is kept in the browser's cache and reused until the data or the industries change,
  // so opening the Screener doesn't download it again. Cache problems just fall back to downloading.
  const CACHE_NAME = 'stockinator-screener';
  const cacheKeyOf = (st) => (st?.dataset ? `/screener-cache/${encodeURIComponent(`${st.dataset.builtAt}|${st.industries?.count || 0}|${st.industries?.at || ''}`)}` : null);
  async function fromCache(key) {
    try { const c = await caches.open(CACHE_NAME); const r = await c.match(key); return r ? await r.json() : null; } catch (err) { return null; }
  }
  async function toCache(key, json) {
    try { const c = await caches.open(CACHE_NAME); for (const k of await c.keys()) await c.delete(k); await c.put(key, new Response(JSON.stringify(json))); } catch (err) { /* ignore */ }
  }
  async function loadData(force = false) {
    if (dataset && !force) { renderRules(); renderResults(); return; }
    tableWrap.replaceChildren(el('div', { cls: 'empty-state', text: 'Loading screener data…' }));
    try {
      await statusReady;
      const key = cacheKeyOf(status);
      const cached = key && !force ? await fromCache(key) : null;
      if (cached) {
        dataset = cached;
      } else {
        const res = await fetch('/api/screener?action=data');
        if (res.status === 404) { dataset = null; renderRules(); tableWrap.replaceChildren(el('div', { cls: 'empty-state', text: 'No screener data yet. Click "Refresh data" above to pull it from SEC.' })); return; }
        if (!res.ok) throw new Error(`status ${res.status}`);
        dataset = await res.json();
        if (key) toCache(key, dataset);
      }
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
  const reason = async (res) => { try { const j = await res.json(); return j.error || res.status; } catch (err) { return res.status; } };
  async function refreshAll() {
    if (refreshing) return;
    if (!window.confirm('Pull fresh data for the whole market from SEC? It takes a few minutes (the first industry lookup longer); keep this tab open. If it stops, Refresh data picks up where it left off.')) return;
    refreshing = true;
    refreshBtn.disabled = true;
    progress.hidden = false;
    const bar = progress.querySelector('.scr-bar');
    const text = progress.querySelector('.scr-progress-text');
    // Metrics pulled in the last 20 hours are kept (a new metric, or a retry after a stop, only fetches what's missing)
    const now = Date.now();
    const metrics = (status?.metrics || []).filter((mk) => { const at = status?.refreshed?.[mk]?.at; return !at || now - Date.parse(at) > METRIC_FRESH_MS; });
    const total = metrics.length + 1;
    try {
      for (let i = 0; i < metrics.length; i++) {
        if (destroyed) return;
        text.textContent = `${i + 1}/${total} · ${metrics[i]}`;
        bar.style.width = `${(i / total) * 100}%`;
        const res = await fetch(`/api/screener?action=refresh&metric=${encodeURIComponent(metrics[i])}`, { method: 'POST' });
        if (!res.ok) throw new Error(`${metrics[i]}: ${await reason(res)}`);
      }
      text.textContent = `${total}/${total} · building`;
      bar.style.width = `${((total - 1) / total) * 100}%`;
      const res = await fetch('/api/screener?action=build', { method: 'POST' });
      if (!res.ok) throw new Error(`build: ${await reason(res)}`);
      await loadData(true);
      // Industries for every company, so the industry filter works on the whole market. Only companies without one
      // are looked up (the first run takes a while; later runs only pick up new companies).
      let stalls = 0;
      for (;;) {
        if (destroyed) return;
        const r = await fetch('/api/screener?action=fill-industries', { method: 'POST' });
        if (!r.ok) throw new Error(`industries: ${await reason(r)}`);
        const j = await r.json();
        const doneN = (j.total || 0) - (j.remaining || 0);
        text.textContent = `industries · ${doneN.toLocaleString()} of ${(j.total || 0).toLocaleString()}`;
        bar.style.width = `${j.total ? (doneN / j.total) * 100 : 100}%`;
        if (!j.remaining) break;
        stalls = j.looked ? 0 : stalls + 1;
        if (stalls >= 3) break; // SEC isn't answering for the rest; the next refresh tries them again
      }
      bar.style.width = '100%';
      text.textContent = 'Done';
      await loadStatus();
      market.tried = new Set();
      await loadData(true);
    } catch (err) {
      console.error('screener refresh failed:', err);
      text.textContent = `Stopped at ${err.message}. Click Refresh data to resume.`;
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      if (!destroyed && dataset) renderResults(true); // resume price and industry loading
      // an error stays on screen; a finished run hides the bar after a few seconds
      if (text.textContent === 'Done') setTimeout(() => { if (!refreshing) progress.hidden = true; }, 4000);
    }
  }
  refreshBtn.addEventListener('click', refreshAll);

  cleanup = () => { destroyed = true; closePopover(); document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onSlash); clearTimeout(searchTimer); };
  renderRules();
  paintScreens();
  loadScreens();
  const statusReady = loadStatus();
  loadData();
}
