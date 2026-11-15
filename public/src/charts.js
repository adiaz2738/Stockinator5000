import { TOOLS, defaultStyle, registerAll, compareStore } from './chart-overlays.js';

// Charts PROTOTYPE (KLineChart 10.1.0, vendored in /vendor/klinecharts). Static sample data only: /sample/{TICKER}.json,
// daily OHLCV made by scripts/fetch-sample-prices.js. Weekly and monthly candles are aggregated from the daily bars.
// Intraday and live data come later with Schwab.

export const SAMPLE_TICKERS = ['AAPL', 'MSFT', 'V'];
const DAY = 86400000;
const LS_PREFIX = 'vl.charts.v1.';
const LS_LAYOUT = 'vl.charts.layout';
const MAX_COMPARE = 3;

// ---------- DOM helper (all text goes through textContent) ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  if (props.on) for (const [ev, fn] of Object.entries(props.on)) node.addEventListener(ev, fn);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

// ---------- Design tokens (read from CSS so the chart follows the app theme) ----------

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', '#080c12'), surface: v('--surface', '#0d1219'), card: v('--card', '#111720'), border: v('--border', '#1c2535'), borderHi: v('--border-hi', '#253045'),
    blue: v('--blue', '#3b9eff'), green: v('--green', '#00e5a0'), red: v('--red', '#ff4d6a'), yellow: v('--yellow', '#ffc940'),
    text: v('--text', '#e8edf5'), text2: v('--text-2', '#8a96a8'), text3: v('--text-3', '#4a5568'),
    mono: "'JetBrains Mono', monospace", sans: "'Inter', sans-serif",
  };
}

// ---------- Library loading ----------

let libPromise = null;
function loadLibrary() {
  if (window.klinecharts) return Promise.resolve(window.klinecharts);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/klinecharts/klinecharts.min.js';
      s.onload = () => resolve(window.klinecharts);
      s.onerror = () => { libPromise = null; reject(new Error('Chart library failed to load')); };
      document.head.append(s);
    });
  }
  return libPromise;
}

let registered = false;
function ensureRegistered(kc, colors) {
  if (registered) return;
  registerAll(kc, colors);
  registered = true;
}

// ---------- Sample data and aggregation ----------

const dailyCache = new Map();
function loadDaily(ticker) {
  if (!dailyCache.has(ticker)) {
    dailyCache.set(ticker, fetch(`/sample/${encodeURIComponent(ticker)}.json`).then((r) => {
      if (!r.ok) throw new Error(`No sample data for ${ticker}`);
      return r.json();
    }).then((j) => j.bars.map((b) => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))).catch((err) => { dailyCache.delete(ticker); throw err; }));
  }
  return dailyCache.get(ticker);
}

// Weekly (Monday-based) and monthly bars from daily ones. A bar's timestamp is its first trading day.
function aggregate(daily, tf) {
  if (tf === 'D') return daily;
  const keyOf = (t) => {
    const d = new Date(t);
    if (tf === 'W') return t - ((d.getUTCDay() + 6) % 7) * DAY;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  };
  const out = [];
  let curKey = null;
  for (const b of daily) {
    const k = keyOf(b.timestamp);
    if (k !== curKey) { out.push({ ...b }); curKey = k; continue; }
    const last = out[out.length - 1];
    last.high = Math.max(last.high, b.high);
    last.low = Math.min(last.low, b.low);
    last.close = b.close;
    last.volume += b.volume;
  }
  return out;
}

const PERIODS = { D: { type: 'day', span: 1 }, W: { type: 'week', span: 1 }, M: { type: 'month', span: 1 } };

// ---------- Per-ticker settings and drawings (localStorage) ----------
// TODO(neon): persist drawings and chart settings per ticker in a Neon table (user_id + ticker, JSONB), behind an
// authenticated API route, and load them on open. localStorage is only the prototype store.

const IND_DEFAULTS = (c) => ({
  ema50: { on: true, color: c.blue, type: 'ema', period: 50, label: 'EMA 50' },
  ema200: { on: true, color: c.yellow, type: 'ema', period: 200, label: 'EMA 200' },
  sma50: { on: false, color: c.text, type: 'sma', period: 50, label: 'SMA 50' },
  sma200: { on: false, color: c.text2, type: 'sma', period: 200, label: 'SMA 200' },
});
const CMP_COLORS = ['#ff9f43', '#b48cff', '#5ad1e6'];

function defaultSettings(c) {
  return { tf: 'D', ind: IND_DEFAULTS(c), vol: { on: true, mode: 'direction', color: c.blue, opacity: 0.35, height: 90 }, compare: [], drawings: [] };
}

function loadSettings(ticker, c) {
  const d = defaultSettings(c);
  try {
    const raw = localStorage.getItem(LS_PREFIX + ticker);
    if (!raw) return d;
    const s = JSON.parse(raw);
    const out = { ...d };
    if (['D', 'W', 'M'].includes(s.tf)) out.tf = s.tf;
    for (const k of Object.keys(d.ind)) if (s.ind?.[k]) out.ind[k] = { ...d.ind[k], on: !!s.ind[k].on, color: typeof s.ind[k].color === 'string' ? s.ind[k].color : d.ind[k].color };
    if (s.vol) out.vol = { ...d.vol, ...pickVol(s.vol) };
    if (Array.isArray(s.compare)) out.compare = s.compare.filter((t) => SAMPLE_TICKERS.includes(t) && t !== ticker).slice(0, MAX_COMPARE);
    if (Array.isArray(s.drawings)) out.drawings = s.drawings.filter((x) => x && TOOLS.some((t) => t.name === x.name) && Array.isArray(x.points) && x.points.every((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value)));
    return out;
  } catch (err) {
    return d;
  }
}
function pickVol(v) {
  const o = {};
  if (typeof v.on === 'boolean') o.on = v.on;
  if (v.mode === 'single' || v.mode === 'direction') o.mode = v.mode;
  if (typeof v.color === 'string') o.color = v.color;
  if (Number.isFinite(v.opacity)) o.opacity = Math.min(1, Math.max(0.05, v.opacity));
  if (Number.isFinite(v.height)) o.height = Math.min(300, Math.max(40, v.height));
  return o;
}
function saveSettings(ticker, s) {
  try { localStorage.setItem(LS_PREFIX + ticker, JSON.stringify(s)); } catch (err) { /* storage unavailable: the chart still works, nothing persists */ }
}

function loadLayout() {
  try {
    const l = JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null');
    if (l && (l.count === 1 || l.count === 2) && Array.isArray(l.tickers)) return { count: l.count, tickers: l.tickers.map((t, i) => (SAMPLE_TICKERS.includes(t) ? t : SAMPLE_TICKERS[i % 3])) };
  } catch (err) { /* ignore */ }
  return { count: 1, tickers: ['AAPL', 'MSFT'] };
}
function saveLayout(l) {
  try { localStorage.setItem(LS_LAYOUT, JSON.stringify(l)); } catch (err) { /* ignore */ }
}

// ---------- KLineChart styles from the design tokens ----------

function buildStyles(c) {
  const line = (color) => ({ color });
  const axis = { axisLine: { color: c.border }, tickLine: { color: c.border }, tickText: { color: c.text2, family: c.mono, size: 11 } };
  const crossText = { color: c.text, family: c.mono, size: 11, backgroundColor: c.borderHi, borderColor: c.borderHi };
  return {
    grid: { horizontal: line(c.border), vertical: line(c.border) },
    candle: {
      bar: {
        upColor: c.green, downColor: c.red, noChangeColor: c.text2,
        upBorderColor: c.green, downBorderColor: c.red, noChangeBorderColor: c.text2,
        upWickColor: c.green, downWickColor: c.red, noChangeWickColor: c.text2,
      },
      priceMark: {
        high: { color: c.text2, textFamily: c.mono },
        low: { color: c.text2, textFamily: c.mono },
        last: { upColor: c.green, downColor: c.red, noChangeColor: c.text2, text: { family: c.mono, color: '#04101c' } },
      },
      tooltip: { title: { color: c.text2, family: c.mono }, legend: { color: c.text2, family: c.mono, size: 11 } },
    },
    indicator: {
      lastValueMark: { show: false },
      tooltip: { title: { color: c.text2, family: c.mono }, legend: { color: c.text2, family: c.mono, size: 11 } },
    },
    xAxis: axis,
    yAxis: axis,
    separator: { color: c.border },
    crosshair: { horizontal: { line: line(c.text3), text: crossText }, vertical: { line: line(c.text3), text: crossText } },
    overlay: {
      point: { color: c.blue, borderColor: c.card, borderSize: 1, radius: 4, activeColor: c.blue, activeBorderColor: c.text, activeBorderSize: 2, activeRadius: 5 },
    },
  };
}

// Dates are shown as calendar dates (no time of day), in UTC because the sample bars are stamped at UTC midnight
function formatBarDate({ timestamp, template }) {
  const d = new Date(timestamp);
  const p = (n) => String(n).padStart(2, '0');
  const parts = { YYYY: d.getUTCFullYear(), MM: p(d.getUTCMonth() + 1), DD: p(d.getUTCDate()), HH: p(d.getUTCHours()), mm: p(d.getUTCMinutes()) };
  return String(template).replace(/\s*HH:mm(?::ss)?/g, '').replace(/YYYY|MM|DD|HH|mm/g, (t) => parts[t]);
}

// ---------- One chart panel ----------

const panels = new Set();
export function disposeCharts() {
  for (const p of [...panels]) p.destroy();
  panels.clear();
}

function createPanel(kc, c, host, { ticker, onTickerChange, compact }) {
  let tkr = ticker;
  let settings = loadSettings(tkr, c);
  let chart = null;
  let pendingId = null;
  let selectedId = null;
  let destroyed = false;
  let volPaneId = null;
  const cmpIds = new Map();

  const card = el('div', { class: 'card vlc-card' });
  const toolbar1 = el('div', { class: 'chart-toolbar' });
  const toolbar2 = el('div', { class: 'chart-toolbar' });
  const stage = el('div', { class: 'chart-stage' });
  const canvas = el('div', { class: `chart-canvas${compact ? ' compact' : ''}` });
  const status = el('div', { class: 'chart-status', text: '' });
  stage.append(canvas, status);
  card.append(toolbar1, toolbar2, stage);
  host.append(card);

  const persist = () => saveSettings(tkr, settings);

  // ----- drawings -----
  const isDrawing = (o) => TOOLS.some((t) => t.name === o.name);
  const serialise = () => chart.getOverlays().filter((o) => isDrawing(o) && o.currentStep === -1).map((o) => ({
    name: o.name,
    points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
    extendData: o.extendData,
  }));
  const saveDrawings = () => { if (!chart) return; settings.drawings = serialise(); persist(); };

  const stylePanel = el('div', { class: 'line-panel', attrs: { hidden: '' } });
  stage.append(stylePanel);

  function closeStylePanel() { stylePanel.hidden = true; stylePanel.replaceChildren(); selectedId = null; }

  const wire = () => ({
    onDrawEnd: ({ overlay }) => { pendingId = null; setActiveTool(null); saveDrawings(); openStylePanel(overlay.id); return false; },
    onClick: ({ overlay }) => { openStylePanel(overlay.id); return false; },
    onPressedMoveEnd: () => { saveDrawings(); return false; },
    onRemoved: ({ overlay }) => { if (overlay.id === selectedId) closeStylePanel(); setTimeout(saveDrawings, 0); return false; },
  });

  function startTool(name) {
    if (!chart) return;
    cancelPending();
    const ex = defaultStyle(name, c);
    const id = chart.createOverlay({ name, paneId: 'candle_pane', extendData: ex, ...wire() });
    pendingId = Array.isArray(id) ? id[0] : id;
    setActiveTool(name);
  }
  function cancelPending() {
    if (pendingId && chart) chart.removeOverlay({ id: pendingId });
    pendingId = null;
    setActiveTool(null);
  }

  function restoreDrawings() {
    for (const d of settings.drawings) {
      chart.createOverlay({ name: d.name, paneId: 'candle_pane', points: d.points, extendData: d.extendData, needDefaultYAxisFigure: d.extendData?.priceTag !== false, ...wire() });
    }
  }

  function openStylePanel(id) {
    const ov = chart.getOverlays({ id })[0];
    if (!ov) return;
    selectedId = id;
    const isV = ov.name === 'vlVLine';
    const toolLabel = TOOLS.find((t) => t.name === ov.name)?.label || 'Line';
    const read = () => ({ ...defaultStyle(ov.name, c), ...(chart.getOverlays({ id })[0]?.extendData || {}) });
    const apply = (patch) => {
      const cur = read();
      const next = { ...cur, ...patch, show: { ...cur.show, ...(patch.show || {}) } };
      chart.overrideOverlay({ id, extendData: next, needDefaultYAxisFigure: next.priceTag });
      saveDrawings();
    };
    const cur = read();
    stylePanel.replaceChildren();
    stylePanel.hidden = false;

    const seg = (opts, value, onPick) => {
      const wrap = el('div', { class: 'seg' });
      for (const [v, label] of opts) {
        wrap.append(el('button', { class: `seg-btn${v === value ? ' active' : ''}`, text: label, attrs: { type: 'button' }, on: { click: () => { for (const b of wrap.children) b.classList.remove('active'); wrap.children[opts.findIndex((o) => o[0] === v)].classList.add('active'); onPick(v); } } }));
      }
      return wrap;
    };
    const row = (label, ...nodes) => el('div', { class: 'lp-row' }, [el('span', { class: 'lp-label', text: label }), ...nodes]);
    const check = (label, checked, onChange) => {
      const input = el('input', { attrs: { type: 'checkbox' }, on: { change: () => onChange(input.checked) } });
      input.checked = checked;
      return el('label', { class: 'lp-check' }, [input, el('span', { text: label })]);
    };

    const head = el('div', { class: 'lp-head' }, [
      el('span', { class: 'lp-title', text: toolLabel }),
      el('button', { class: 'lp-x', text: '×', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: closeStylePanel } }),
    ]);
    const colorIn = el('input', { class: 'lp-color', attrs: { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur.color) ? cur.color : c.blue }, on: { input: () => apply({ color: colorIn.value }) } });
    const widthSel = el('select', { class: 'lp-select mono', on: { change: () => apply({ width: Number(widthSel.value) }) } });
    for (const w of [1, 1.5, 2, 3, 4]) { const o = el('option', { text: `${w}px`, attrs: { value: String(w) } }); if (w === cur.width) o.selected = true; widthSel.append(o); }
    const labelIn = el('input', { class: 'lp-text', attrs: { type: 'text', maxlength: '60', placeholder: 'Text label' }, on: { input: () => apply({ label: labelIn.value.slice(0, 60) }) } });
    labelIn.value = cur.label || '';
    const del = el('button', { class: 'btn btn-ghost lp-del', text: 'Delete', attrs: { type: 'button' }, on: { click: () => { chart.removeOverlay({ id }); closeStylePanel(); saveDrawings(); } } });

    stylePanel.append(
      head,
      row('Line', seg([['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']], cur.dash, (v) => apply({ dash: v }))),
      row('Color', colorIn, widthSel),
      row(isV ? 'Ends' : 'Ends', check(isV ? 'Extend up' : 'Extend left', cur.extendLeft, (v) => apply({ extendLeft: v })), check(isV ? 'Extend down' : 'Extend right', cur.extendRight, (v) => apply({ extendRight: v }))),
      row('Label', labelIn),
      row('Axis', check('Price label', cur.priceTag, (v) => apply({ priceTag: v }))),
    );
    if (!isV) {
      stylePanel.append(row('Shows', check('Price', cur.show.price, (v) => apply({ show: { price: v } })), check('% change', cur.show.pct, (v) => apply({ show: { pct: v } })), check('Bars', cur.show.bars, (v) => apply({ show: { bars: v } })), check('Days', cur.show.days, (v) => apply({ show: { days: v } }))));
    }
    stylePanel.append(del);
  }

  // ----- toolbar -----
  let toolButtons = new Map();
  function setActiveTool(name) { for (const [n, b] of toolButtons) b.classList.toggle('active', n === name); }

  function buildToolbar() {
    toolbar1.replaceChildren();
    toolbar2.replaceChildren();

    const tickerSel = el('select', { class: 'ch-select mono', attrs: { 'aria-label': 'Ticker' }, on: { change: () => switchTicker(tickerSel.value) } });
    for (const t of SAMPLE_TICKERS) { const o = el('option', { text: t, attrs: { value: t } }); if (t === tkr) o.selected = true; tickerSel.append(o); }

    const tfSeg = el('div', { class: 'seg' });
    for (const tf of ['D', 'W', 'M']) {
      tfSeg.append(el('button', { class: `seg-btn mono${settings.tf === tf ? ' active' : ''}`, text: tf, attrs: { type: 'button', title: { D: 'Daily', W: 'Weekly', M: 'Monthly' }[tf] }, on: { click: () => setTimeframe(tf) } }));
    }

    const cmpWrap = el('div', { class: 'cmp-wrap' });
    const cmpSel = el('select', { class: 'ch-select', attrs: { 'aria-label': 'Compare ticker' }, on: { change: () => { if (cmpSel.value) addCompare(cmpSel.value); } } });
    cmpSel.append(el('option', { text: 'Compare…', attrs: { value: '' } }));
    for (const t of SAMPLE_TICKERS) if (t !== tkr && !settings.compare.includes(t)) cmpSel.append(el('option', { text: t, attrs: { value: t } }));
    cmpSel.disabled = settings.compare.length >= MAX_COMPARE || cmpSel.options.length === 1;
    cmpWrap.append(cmpSel);
    settings.compare.forEach((t, i) => {
      const chip = el('span', { class: 'chip', attrs: { style: `--chip:${CMP_COLORS[i % CMP_COLORS.length]}` } }, [
        el('span', { class: 'chip-dot' }), el('span', { class: 'mono', text: t }),
        el('button', { class: 'chip-x', text: '×', attrs: { type: 'button', 'aria-label': `Remove ${t}` }, on: { click: () => removeCompare(t) } }),
      ]);
      cmpWrap.append(chip);
    });

    const newTab = el('a', { class: 'btn btn-ghost btn-inline ch-btn', text: 'Open in new tab', attrs: { href: `/chart/${encodeURIComponent(tkr)}`, target: '_blank', rel: 'noopener' } });
    const fsBtn = el('button', { class: 'btn btn-ghost btn-inline ch-btn', text: 'Full screen', attrs: { type: 'button' }, on: { click: toggleFullscreen } });
    fsBtn.dataset.role = 'fs';
    toolbar1.append(tickerSel, tfSeg, cmpWrap, el('span', { class: 'ch-spacer' }), newTab, fsBtn);

    // drawing tools
    toolButtons = new Map();
    const tools = el('div', { class: 'tool-group' });
    for (const t of TOOLS) {
      const b = el('button', { class: 'ch-tool', text: t.short, attrs: { type: 'button', title: `${t.label}: click on the price chart to place it (Esc cancels)` }, on: { click: () => (toolButtons.get(t.name).classList.contains('active') ? cancelPending() : startTool(t.name)) } });
      toolButtons.set(t.name, b);
      tools.append(b);
    }
    const clearBtn = el('button', { class: 'ch-tool ghost', text: 'Clear all', attrs: { type: 'button', title: 'Remove every drawing on this ticker' }, on: { click: () => { cancelPending(); closeStylePanel(); for (const o of chart.getOverlays()) if (isDrawing(o)) chart.removeOverlay({ id: o.id }); settings.drawings = []; persist(); } } });
    tools.append(clearBtn);

    // indicators
    const inds = el('div', { class: 'ind-group' });
    for (const [key, ind] of Object.entries(settings.ind)) {
      const colorIn = el('input', { class: 'chip-color', attrs: { type: 'color', value: ind.color, 'aria-label': `${ind.label} color` }, on: { input: () => { ind.color = colorIn.value; persist(); applyIndicator(key); } } });
      const chip = el('button', { class: `ind-chip${ind.on ? ' on' : ''}`, attrs: { type: 'button', style: `--chip:${ind.color}` }, on: { click: () => { ind.on = !ind.on; chip.classList.toggle('on', ind.on); persist(); applyIndicator(key); } } }, [el('span', { class: 'chip-dot' }), el('span', { class: 'mono', text: ind.label })]);
      colorIn.addEventListener('input', () => chip.style.setProperty('--chip', colorIn.value));
      inds.append(el('span', { class: 'ind-item' }, [chip, colorIn]));
    }

    // volume settings
    const volBtn = el('button', { class: 'ch-tool', text: 'Volume ⚙', attrs: { type: 'button' } });
    const volPop = el('div', { class: 'vol-pop', attrs: { hidden: '' } });
    const buildVolPop = () => {
      volPop.replaceChildren();
      const v = settings.vol;
      const on = el('input', { attrs: { type: 'checkbox' }, on: { change: () => { v.on = on.checked; persist(); applyVolume(); } } });
      on.checked = v.on;
      const mode = el('select', { class: 'lp-select', on: { change: () => { v.mode = mode.value; persist(); applyVolume(); } } }, [el('option', { text: 'Green / red by candle', attrs: { value: 'direction' } }), el('option', { text: 'Single color', attrs: { value: 'single' } })]);
      mode.value = v.mode;
      const color = el('input', { class: 'lp-color', attrs: { type: 'color', value: v.color }, on: { input: () => { v.color = color.value; persist(); applyVolume(); } } });
      const opText = el('span', { class: 'mono lp-val', text: `${Math.round(v.opacity * 100)}%` });
      const op = el('input', { attrs: { type: 'range', min: '5', max: '100', step: '5', value: String(Math.round(v.opacity * 100)) }, on: { input: () => { v.opacity = Number(op.value) / 100; opText.textContent = `${op.value}%`; persist(); applyVolume(); } } });
      const hText = el('span', { class: 'mono lp-val', text: `${v.height}px` });
      const h = el('input', { attrs: { type: 'range', min: '40', max: '240', step: '10', value: String(v.height) }, on: { input: () => { v.height = Number(h.value); hText.textContent = `${h.value}px`; persist(); applyVolume(); } } });
      volPop.append(
        el('label', { class: 'lp-check' }, [on, el('span', { text: 'Show volume' })]),
        el('div', { class: 'lp-row' }, [el('span', { class: 'lp-label', text: 'Bars' }), mode]),
        el('div', { class: 'lp-row' }, [el('span', { class: 'lp-label', text: 'Color' }), color]),
        el('div', { class: 'lp-row' }, [el('span', { class: 'lp-label', text: 'Opacity' }), op, opText]),
        el('div', { class: 'lp-row' }, [el('span', { class: 'lp-label', text: 'Height' }), h, hText]),
      );
    };
    buildVolPop();
    volBtn.addEventListener('click', () => { volPop.hidden = !volPop.hidden; });
    const volWrap = el('div', { class: 'vol-wrap' }, [volBtn, volPop]);

    toolbar2.append(tools, el('span', { class: 'ch-spacer' }), inds, volWrap);
  }

  // ----- indicators / volume / compare -----
  const indId = (key) => `vl_${key}`;
  function applyIndicator(key) {
    if (!chart) return;
    const ind = settings.ind[key];
    const exists = chart.getIndicators({ id: indId(key) }).length > 0;
    if (!ind.on) { if (exists) chart.removeIndicator({ id: indId(key) }); return; }
    const extendData = { type: ind.type, color: ind.color, title: ind.type.toUpperCase() };
    if (exists) chart.overrideIndicator({ id: indId(key), name: 'VL_MA', extendData });
    else chart.createIndicator({ id: indId(key), name: 'VL_MA', paneId: 'candle_pane', calcParams: [ind.period], extendData }, true);
  }

  function applyVolume() {
    if (!chart) return;
    const v = settings.vol;
    const existing = chart.getIndicators({ name: 'VL_VOL' })[0];
    if (!v.on) { if (existing) { chart.removeIndicator({ name: 'VL_VOL' }); volPaneId = null; } return; }
    const extendData = { mode: v.mode, color: v.color, opacity: v.opacity };
    if (existing) chart.overrideIndicator({ id: existing.id, name: 'VL_VOL', extendData });
    else {
      volPaneId = 'vl_vol_pane';
      chart.createIndicator({ name: 'VL_VOL', id: 'vl_vol', paneId: volPaneId, extendData }, false);
    }
    chart.setPaneOptions({ id: volPaneId, height: v.height, minHeight: 30 });
  }

  async function refreshCompare() {
    if (!chart) return;
    // drop indicators for removed tickers
    for (const [t, id] of [...cmpIds]) if (!settings.compare.includes(t)) { chart.removeIndicator({ id }); cmpIds.delete(t); }
    for (let i = 0; i < settings.compare.length; i++) {
      const t = settings.compare[i];
      let daily;
      try { daily = await loadDaily(t); } catch (err) { setStatus(`Compare data for ${t} is unavailable`); continue; }
      if (destroyed || !chart) return;
      const key = `${t}|${settings.tf}`;
      compareStore.set(key, new Map(aggregate(daily, settings.tf).map((b) => [b.timestamp, b.close])));
      const extendData = { ticker: t, color: CMP_COLORS[i % CMP_COLORS.length], key, baseIndex: Math.max(0, chart.getVisibleRange().from) };
      if (cmpIds.has(t)) chart.overrideIndicator({ id: cmpIds.get(t), name: 'VL_CMP', extendData });
      else {
        const id = `vl_cmp_${t}`;
        chart.createIndicator({ id, name: 'VL_CMP', paneId: 'candle_pane', extendData }, true);
        cmpIds.set(t, id);
      }
    }
    // The price scale shows % change while compare is on
    chart.overrideYAxis({ name: settings.compare.length ? 'percentage' : 'normal', paneId: 'candle_pane' });
  }

  function addCompare(t) {
    if (settings.compare.includes(t) || settings.compare.length >= MAX_COMPARE || t === tkr) return;
    settings.compare.push(t);
    persist();
    buildToolbar();
    refreshCompare();
  }
  function removeCompare(t) {
    settings.compare = settings.compare.filter((x) => x !== t);
    persist();
    buildToolbar();
    refreshCompare();
  }

  function setStatus(msg) { status.textContent = msg; status.hidden = !msg; }

  // ----- timeframe / ticker -----
  function setTimeframe(tf) {
    if (tf === settings.tf || !chart) return;
    settings.tf = tf;
    persist();
    buildToolbar();
    chart.setPeriod(PERIODS[tf]);
  }

  function switchTicker(next) {
    if (next === tkr) return;
    cancelPending();
    closeStylePanel();
    destroyChart();
    tkr = next;
    settings = loadSettings(tkr, c);
    onTickerChange?.(tkr);
    buildToolbar();
    createChart();
  }

  // ----- chart lifecycle -----
  let ro = null;
  let visHandler = null;
  function createChart() {
    setStatus('Loading…');
    chart = kc.init(canvas, { timezone: 'UTC', locale: 'en-US', styles: buildStyles(c), formatter: { formatDate: formatBarDate } });
    if (!chart) { setStatus('Chart could not start'); return; }
    chart.setDataLoader({
      getBars: async ({ type, symbol, period, callback }) => {
        if (type !== 'init') { callback([], false); return; }
        try {
          const tf = Object.keys(PERIODS).find((k) => PERIODS[k].type === period.type) || 'D';
          const bars = aggregate(await loadDaily(symbol.ticker), tf);
          if (destroyed) return;
          callback(bars, false);
          setStatus('');
          refreshCompare();
        } catch (err) {
          callback([], false);
          setStatus(`No sample data for ${symbol.ticker} yet (prototype supports ${SAMPLE_TICKERS.join(', ')})`);
        }
      },
    });
    chart.setSymbol({ ticker: tkr, pricePrecision: 2, volumePrecision: 0 });
    chart.setPeriod(PERIODS[settings.tf]);
    for (const key of Object.keys(settings.ind)) applyIndicator(key);
    applyVolume();
    restoreDrawings();

    // Keep compare lines rebased to the first visible bar (the % axis does the same for the candles)
    let lastBase = -1;
    visHandler = () => {
      if (!chart || !settings.compare.length) return;
      const base = Math.max(0, chart.getVisibleRange().from);
      if (base === lastBase) return;
      lastBase = base;
      for (const [t, id] of cmpIds) {
        const ind = chart.getIndicators({ id })[0];
        if (ind) chart.overrideIndicator({ id, name: 'VL_CMP', extendData: { ...ind.extendData, baseIndex: base } });
        void t;
      }
    };
    chart.subscribeAction('onVisibleRangeChange', visHandler);
    ro = new ResizeObserver(() => chart && chart.resize());
    ro.observe(canvas);
  }

  function destroyChart() {
    if (ro) { ro.disconnect(); ro = null; }
    if (chart) { try { kc.dispose(canvas); } catch (err) { /* already gone */ } }
    chart = null;
    cmpIds.clear();
    volPaneId = null;
  }

  // ----- full screen -----
  function toggleFullscreen() {
    if (document.fullscreenElement === card) document.exitFullscreen?.();
    else if (card.requestFullscreen) card.requestFullscreen().catch(() => setStatus('Full screen is not available in this browser'));
    else setStatus('Full screen is not available in this browser');
  }
  const onFsChange = () => {
    const on = document.fullscreenElement === card;
    card.classList.toggle('is-fullscreen', on);
    const b = toolbar1.querySelector('[data-role="fs"]');
    if (b) b.textContent = on ? 'Exit full screen' : 'Full screen';
    setTimeout(() => chart && chart.resize(), 50);
  };
  document.addEventListener('fullscreenchange', onFsChange);

  const onKey = (e) => {
    if (e.key === 'Escape') { if (pendingId) cancelPending(); else if (!stylePanel.hidden) closeStylePanel(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) {
      chart.removeOverlay({ id: selectedId });
      closeStylePanel();
      saveDrawings();
    }
  };
  document.addEventListener('keydown', onKey);

  buildToolbar();
  createChart();

  const api = {
    get ticker() { return tkr; },
    destroy() {
      destroyed = true;
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('keydown', onKey);
      destroyChart();
      card.remove();
      panels.delete(api);
    },
    debug: () => ({ chart, settings }),
  };
  panels.add(api);
  return api;
}

// ---------- Page ----------

export async function renderCharts(app, { ticker } = {}) {
  disposeCharts();
  app.replaceChildren();
  const c = tokens();
  const layout = loadLayout();
  const routeTicker = ticker && SAMPLE_TICKERS.includes(ticker.toUpperCase()) ? ticker.toUpperCase() : null;
  if (routeTicker) layout.tickers[0] = routeTicker;
  if (layout.tickers[1] === layout.tickers[0]) layout.tickers[1] = SAMPLE_TICKERS.find((t) => t !== layout.tickers[0]);

  const head = el('div', { class: 'charts-head' });
  const grid = el('div', { class: `vlc-grid cols-${layout.count}` });
  app.append(head, grid);

  if (ticker && !routeTicker) {
    grid.append(el('div', { class: 'card' }, [el('div', { class: 'section-label', text: 'Charts' }), el('p', { class: 'chart-note', text: `No sample data for ${ticker.slice(0, 12)} yet. The prototype supports ${SAMPLE_TICKERS.join(', ')}.` })]));
    return;
  }

  let kc;
  try {
    kc = await loadLibrary();
    ensureRegistered(kc, c);
  } catch (err) {
    grid.append(el('div', { class: 'card' }, [el('p', { class: 'chart-note', text: 'The chart library could not be loaded.' })]));
    return;
  }

  const build = () => {
    disposeCharts();
    grid.replaceChildren();
    grid.className = `vlc-grid cols-${layout.count}`;
    for (let i = 0; i < layout.count; i++) {
      createPanel(kc, c, grid, {
        ticker: layout.tickers[i], compact: layout.count === 2,
        onTickerChange: (t) => {
          layout.tickers[i] = t; saveLayout(layout);
          if (/^\/chart\//.test(window.location.pathname) && i === 0) window.history.replaceState({}, '', `/chart/${encodeURIComponent(t)}`);
        },
      });
    }
    renderHead();
  };

  const renderHead = () => {
    head.replaceChildren();
    const seg = el('div', { class: 'seg' });
    for (const n of [1, 2]) seg.append(el('button', { class: `seg-btn${layout.count === n ? ' active' : ''}`, text: n === 1 ? '1 chart' : '2 charts', attrs: { type: 'button' }, on: { click: () => { if (layout.count !== n) { layout.count = n; saveLayout(layout); build(); } } } }));
    head.append(
      el('div', { class: 'charts-title' }, [el('span', { class: 'section-label', text: 'Charts' }), el('span', { class: 'proto-badge', text: 'Prototype' })]),
      el('span', { class: 'chart-note', text: 'Sample daily data (about 2 years). Weekly and monthly are built from daily. Intraday comes with Schwab.' }),
      el('span', { class: 'ch-spacer' }),
      seg,
    );
  };

  build();
}

// For headless checks
export function __panels() { return [...panels]; }
