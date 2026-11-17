import { TOOLS, TOOL_GROUPS, defaultStyle, registerAll, compareStore } from './chart-overlays.js';
import {
  SAMPLE_TICKERS, NO_DATA_MESSAGE, MAX_COMPARE, PERIODS, TF_GROUPS, TF_ENABLED, IND_KEYS,
  tokens, loadBars, loadSettings, saveSettings, settingsKey, loadGlobal, saveGlobal, failureMessage,
  isIntraday, INTRADAY, tfOfPeriod, bucketStart, inRegularSession, tradingDayKey, periodKey,
} from './chart-data.js';
import { subscribeQuotes, onStreamStatus, streamStatus } from './schwab-stream.js';

// The reusable chart component. Used by the Charts page (mode 'full') and the Price card on the Filings company view
// (mode 'card': same features, icon-only toolbars, can expand in place). Library: KLineChart 10.1.0 (vendored, /vendor/klinecharts).
//
//   const view = await mountChartView(hostElement, { ticker, mode, location, onTickerChange, layout, onOpenInCharts })
//   view.destroy()
//
// Drawings and indicator settings are shared per ticker: every chart showing a ticker reads and writes the same saved
// data, and charts open at the same time (or in other tabs) pick up each other's changes. Zoom, timeframe, volume options
// and compare tickers are independent per location (opts.location: 'page-0', 'page-1', 'card').

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const VALID_TOOLS = TOOLS.map((t) => t.name);
const views = new Set();

export function disposeCharts() {
  for (const v of [...views]) v.destroy();
  views.clear();
  document.getElementById('app')?.classList.remove('vlc-fill');
}

// ---------- DOM helpers (all text goes through textContent) ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  if (props.on) for (const [ev, fn] of Object.entries(props.on)) node.addEventListener(ev, fn);
  for (const ch of [].concat(children)) if (ch) node.append(ch);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// Icons are built with createElementNS (never innerHTML). Each entry: [tag, attributes] drawn on a 24x24 grid.
const ICONS = {
  trend: [['line', { x1: 5, y1: 19, x2: 19, y2: 5 }], ['circle', { cx: 5, cy: 19, r: 2, fill: 'currentColor' }], ['circle', { cx: 19, cy: 5, r: 2, fill: 'currentColor' }]],
  ray: [['line', { x1: 5, y1: 19, x2: 20, y2: 4 }], ['circle', { cx: 5, cy: 19, r: 2, fill: 'currentColor' }], ['path', { d: 'M14 4h6v6' }]],
  extended: [['line', { x1: 3, y1: 21, x2: 21, y2: 3 }], ['circle', { cx: 9, cy: 15, r: 2, fill: 'currentColor' }], ['circle', { cx: 15, cy: 9, r: 2, fill: 'currentColor' }]],
  hline: [['line', { x1: 3, y1: 12, x2: 21, y2: 12 }], ['circle', { cx: 12, cy: 12, r: 2, fill: 'currentColor' }]],
  hray: [['line', { x1: 5, y1: 12, x2: 21, y2: 12 }], ['circle', { cx: 5, cy: 12, r: 2, fill: 'currentColor' }], ['path', { d: 'M17 8l4 4-4 4' }]],
  vline: [['line', { x1: 12, y1: 3, x2: 12, y2: 21 }], ['circle', { cx: 12, cy: 12, r: 2, fill: 'currentColor' }]],
  channel: [['line', { x1: 4, y1: 15, x2: 18, y2: 5 }], ['line', { x1: 6, y1: 21, x2: 20, y2: 11 }], ['path', { d: 'M4 15l2 6M18 5l2 6', 'stroke-dasharray': '1.5 2.5' }]],
  fib: [['line', { x1: 4, y1: 5, x2: 20, y2: 5 }], ['line', { x1: 4, y1: 10, x2: 20, y2: 10, opacity: 0.6 }], ['line', { x1: 4, y1: 15, x2: 20, y2: 15, opacity: 0.6 }], ['line', { x1: 4, y1: 20, x2: 20, y2: 20 }]],
  text: [['path', { d: 'M6 6h12M12 6v13M9 19h6' }]],
  trash: [['path', { d: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5' }]],
  lock: [['rect', { x: 6, y: 11, width: 12, height: 9, rx: 2 }], ['path', { d: 'M9 11V8a3 3 0 0 1 6 0v3' }]],
  unlock: [['rect', { x: 6, y: 11, width: 12, height: 9, rx: 2 }], ['path', { d: 'M9 11V8a3 3 0 0 1 5.6-1.5' }]],
  external: [['path', { d: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5' }]],
  fullscreen: [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
  gear: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1' }]],
  star: [['path', { d: 'M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7z' }]],
  indicators: [['path', { d: 'M3 17l5-6 4 3 6-8 3 4' }]],
  compare: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', { d: 'M12 8v8M8 12h8' }]],
  fit: [['path', { d: 'M3 12h18M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3' }]],
  expand: [['path', { d: 'M9 4H4v5M15 20h5v-5M4 4l6 6M20 20l-6-6' }]],
  minimize: [['path', { d: 'M10 4v6H4M14 20v-6h6M10 10L4 4M14 14l6 6' }]],
  charts: [['path', { d: 'M4 19V5M4 19h16M8 15l3-4 3 2 5-6' }]],
  one: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }]],
  two: [['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ['line', { x1: 12, y1: 5, x2: 12, y2: 19 }]],
  chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
  caret: [['path', { d: 'M7 10l5 5 5-5' }]],
  solid: [['line', { x1: 3, y1: 12, x2: 21, y2: 12 }]],
  dashed: [['line', { x1: 3, y1: 12, x2: 21, y2: 12, 'stroke-dasharray': '5 3' }]],
  dotted: [['line', { x1: 3, y1: 12, x2: 21, y2: 12, 'stroke-dasharray': '1.5 3.5' }]],
  left: [['path', { d: 'M20 12H5M10 7l-5 5 5 5' }]],
  right: [['path', { d: 'M4 12h15M14 7l5 5-5 5' }]],
  up: [['path', { d: 'M12 20V5M7 10l5-5 5 5' }]],
  down: [['path', { d: 'M12 4v15M7 14l5 5 5-5' }]],
  more: [['circle', { cx: 6, cy: 12, r: 1.5, fill: 'currentColor' }], ['circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor' }], ['circle', { cx: 18, cy: 12, r: 1.5, fill: 'currentColor' }]],
};
function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[name] || []) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.append(n);
  }
  return svg;
}
const iconBtn = (name, title, onClick, cls = '') => el('button', { class: `vlc-ibtn ${cls}`.trim(), attrs: { type: 'button', title, 'aria-label': title }, on: { click: onClick } }, icon(name, 18));

// ---------- Library ----------

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

// Dates as calendar dates (no time of day), in UTC because the bars are stamped at UTC midnight
function formatBarDate({ timestamp, template }) {
  const d = new Date(timestamp);
  const p = (n) => String(n).padStart(2, '0');
  const parts = { YYYY: d.getUTCFullYear(), MM: p(d.getUTCMonth() + 1), DD: p(d.getUTCDate()), HH: p(d.getUTCHours()), mm: p(d.getUTCMinutes()) };
  return String(template).replace(/\s*HH:mm(?::ss)?/g, '').replace(/YYYY|MM|DD|HH|mm/g, (t) => parts[t]);
}

// Intraday bars are shown in Pacific time (the market opens at 06:30)
export const CHART_TZ = 'America/Los_Angeles';
const laParts = new Intl.DateTimeFormat('en-US', { timeZone: CHART_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function formatIntradayDate({ timestamp, template }) {
  const p = Object.fromEntries(laParts.formatToParts(new Date(timestamp)).map((x) => [x.type, x.value]));
  const parts = { YYYY: p.year, MM: p.month, DD: p.day, HH: p.hour, mm: p.minute, ss: p.second };
  return String(template).replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => parts[t]);
}

function buildStyles(c, G) {
  const line = (color) => ({ color });
  const axis = { axisLine: { color: c.border }, tickLine: { color: c.border }, tickText: { color: c.text2, family: c.mono, size: 11 } };
  const crossText = { color: c.text, family: c.mono, size: 11, backgroundColor: c.borderHi, borderColor: c.borderHi };
  return {
    grid: { horizontal: line(c.border), vertical: line(c.border) },
    candle: {
      bar: {
        upColor: G.candle.up, downColor: G.candle.down, noChangeColor: c.text2,
        upBorderColor: G.candle.up, downBorderColor: G.candle.down, noChangeBorderColor: c.text2,
        upWickColor: G.candle.up, downWickColor: G.candle.down, noChangeWickColor: c.text2,
      },
      priceMark: {
        high: { color: c.text2, textFamily: c.mono },
        low: { color: c.text2, textFamily: c.mono },
        last: { upColor: G.candle.up, downColor: G.candle.down, noChangeColor: c.text2, text: { family: c.mono, color: '#04101c' } },
      },
      tooltip: { showRule: 'none' }, // the HTML legend replaces the built-in OHLC tooltip
    },
    indicator: { lastValueMark: { show: false }, tooltip: { showRule: 'none' } },
    xAxis: axis,
    yAxis: axis,
    separator: { color: c.border },
    crosshair: { horizontal: { line: line(c.text3), text: crossText }, vertical: { line: line(c.text3), text: crossText } },
    overlay: { point: { color: c.blue, borderColor: c.card, borderSize: 1, radius: 4, activeColor: c.blue, activeBorderColor: c.text, activeBorderSize: 2, activeRadius: 5 } },
  };
}

const fmtPrice = (v) => (Number.isFinite(v) ? v.toFixed(2) : '--');
const fmtVol = (v) => (!Number.isFinite(v) ? '--' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)));
const TF_LABEL = { '1m': '1 min', '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '4h': '4 hour', D: 'Daily', W: 'Weekly', M: 'Monthly' };
const SOURCE_LABEL = { schwab: 'Data: Schwab', fmp: 'Data: FMP (free, delayed)', sample: 'Data: sample file' };

// ---------- Mount ----------

export async function mountChartView(host, opts = {}) {
  const c = tokens();
  const status = el('div', { class: 'vlc-loading', text: 'Loading chart…' });
  host.append(status);
  let kc;
  try {
    kc = await loadLibrary();
    if (!registered) { registerAll(kc, c); registered = true; }
  } catch (err) {
    status.textContent = 'The chart library could not be loaded.';
    return { destroy() { status.remove(); }, ticker: opts.ticker };
  }
  status.remove();
  if (!host.isConnected) return { destroy() {}, ticker: opts.ticker };
  return createView(kc, c, host, opts);
}

function createView(kc, c, host, opts) {
  const card = opts.mode === 'card';
  const loc = opts.location || (card ? 'card' : 'page-0');
  let expanded = false;
  let tkr = String(opts.ticker || '').toUpperCase();
  let settings = loadSettings(tkr, c, VALID_TOOLS, loc);
  const G = loadGlobal(c);
  let chart = null;
  let destroyed = false;
  let pendingId = null;
  let pendingTool = null;
  let selectedId = null;
  let crossIdx = null;
  let fitPending = false;
  const cmpIds = new Map();
  let dataSource = null; // 'schwab' | 'fmp' | 'sample' for the loaded bars
  let liveOff = null; // unsubscribe from the Schwab live stream
  const lg = {};
  function paintLive() {
    if (!lg.live) return;
    const on = !!liveOff && streamStatus() === 'live';
    lg.live.hidden = !liveOff;
    lg.live.classList.toggle('on', on);
    lg.live.textContent = on ? '● LIVE' : '● connecting';
    lg.live.title = on ? 'Live prices from Schwab' : 'Connecting to Schwab live prices…';
  }

  // ----- DOM skeleton -----
  const root = el('div', { class: `vlc-view${card ? ' cardmode' : ''}` });
  const top = el('div', { class: 'vlc-top' });
  const body = el('div', { class: 'vlc-body' });
  const left = el('div', { class: 'vlc-left' });
  const stage = el('div', { class: 'vlc-stage' });
  const canvas = el('div', { class: 'vlc-canvas' });
  const legend = el('div', { class: 'vlc-legend' });
  const floatBar = el('div', { class: 'vlc-float', attrs: { hidden: '' } });
  const msg = el('div', { class: 'vlc-msg', attrs: { hidden: '' } });
  stage.append(canvas, legend, floatBar, msg);
  body.append(left, stage);
  root.append(top, body);
  host.append(root);

  const persist = () => saveSettings(tkr, settings, loc);
  const persistGlobal = () => saveGlobal(G);

  function setMsg(text) { msg.textContent = text || ''; msg.hidden = !text; }

  // ----- menus (dropdowns, flyouts, popovers) -----
  const menus = [];
  function makeMenu(trigger, { onOpen, side = 'below', cls = '' } = {}) {
    const menu = el('div', { class: `vlc-menu ${side === 'right' ? 'side-right' : ''} ${cls}`.trim(), attrs: { hidden: '' } });
    const rec = { menu, trigger };
    menus.push(rec);
    const toggle = () => {
      const willOpen = menu.hidden;
      closeMenus();
      if (willOpen) { onOpen?.(menu); menu.hidden = false; }
    };
    return { menu, toggle, rec };
  }
  function closeMenus(except) { for (const m of menus) if (m !== except) m.menu.hidden = true; }
  const onDocDown = (e) => {
    for (const m of menus) {
      if (m.menu.hidden) continue;
      if (m.menu.contains(e.target) || m.trigger.contains(e.target)) continue;
      m.menu.hidden = true;
    }
  };
  document.addEventListener('pointerdown', onDocDown);

  // Tiny labeled-row builders used by the menus and the floating toolbar
  const check = (label, checked, onChange) => {
    const input = el('input', { attrs: { type: 'checkbox' }, on: { change: () => onChange(input.checked) } });
    input.checked = checked;
    return el('label', { class: 'vlc-check' }, [input, el('span', { text: label })]);
  };
  const colorInput = (value, onInput, label) => el('input', { class: 'vlc-color', attrs: { type: 'color', value, 'aria-label': label }, on: { input: (e) => onInput(e.target.value) } });

  // ----- legend (symbol, OHLC, indicator and compare chips) -----
  const lgLine = el('div', { class: 'vlc-lg-line' });
  const lgChips = el('div', { class: 'vlc-lg-chips' });
  legend.append(lgLine, lgChips);
  function buildLegendLine() {
    lgLine.replaceChildren();
    lg.sym = el('span', { class: 'vlc-lg-sym mono', text: tkr });
    lg.tf = el('span', { class: 'vlc-lg-tf', text: TF_LABEL[settings.tf] || settings.tf });
    lg.o = el('span', { class: 'mono' }); lg.h = el('span', { class: 'mono' }); lg.l = el('span', { class: 'mono' }); lg.cl = el('span', { class: 'mono' }); lg.chg = el('span', { class: 'mono' }); lg.v = el('span', { class: 'mono vlc-dim' });
    const pair = (k, node) => el('span', { class: 'vlc-lg-pair' }, [el('span', { class: 'vlc-dim', text: k }), node]);
    lg.live = el('span', { class: 'vlc-live', text: '● LIVE', attrs: { hidden: '', title: 'Live prices from Schwab' } });
    lg.src = el('span', { class: 'vlc-src', text: SOURCE_LABEL[dataSource] || '' });
    lgLine.append(lg.sym, lg.tf, pair('O', lg.o), pair('H', lg.h), pair('L', lg.l), pair('C', lg.cl), lg.chg, pair('Vol', lg.v), lg.live, lg.src);
    paintLive();
  }
  let chipRefs = [];
  let relegendTimer = 0;
  function renderChips() {
    lgChips.replaceChildren();
    chipRefs = [];
    for (const key of IND_KEYS) {
      const ind = settings.ind[key];
      if (!ind.on) continue;
      const val = el('span', { class: 'mono vlc-chip-val' });
      lgChips.append(el('span', { class: 'vlc-chip', attrs: { style: `--chip:${ind.color}` } }, [
        el('span', { class: 'vlc-chip-dot' }), el('span', { class: 'mono', text: ind.label }), val,
        el('button', { class: 'vlc-chip-x', text: '×', attrs: { type: 'button', 'aria-label': `Remove ${ind.label}`, title: `Remove ${ind.label}` }, on: { click: () => { ind.on = false; saveInd(); applyIndicator(key); renderChips(); updateLegend(); } } }),
      ]));
      chipRefs.push({ type: 'ind', key, val });
    }
    settings.compare.forEach((t, i) => {
      const val = el('span', { class: 'mono vlc-chip-val' });
      lgChips.append(el('span', { class: 'vlc-chip', attrs: { style: `--chip:${c.compare[i % c.compare.length]}` } }, [
        el('span', { class: 'vlc-chip-dot' }), el('span', { class: 'mono', text: t }), val,
        el('button', { class: 'vlc-chip-x', text: '×', attrs: { type: 'button', 'aria-label': `Remove ${t}`, title: `Remove ${t}` }, on: { click: () => removeCompare(t) } }),
      ]));
      chipRefs.push({ type: 'cmp', ticker: t, val });
    });
  }
  function updateLegend() {
    if (!chart) return;
    const list = chart.getDataList();
    if (!list.length) { for (const k of ['o', 'h', 'l', 'cl', 'chg', 'v']) lg[k].textContent = ''; for (const r of chipRefs) r.val.textContent = ''; return; }
    const idx = crossIdx !== null && crossIdx >= 0 && crossIdx < list.length ? crossIdx : list.length - 1;
    const b = list[idx];
    const prev = idx > 0 ? list[idx - 1] : null;
    const up = b.close >= b.open;
    lg.o.textContent = fmtPrice(b.open); lg.h.textContent = fmtPrice(b.high); lg.l.textContent = fmtPrice(b.low); lg.cl.textContent = fmtPrice(b.close);
    lg.v.textContent = fmtVol(b.volume);
    const chg = prev ? ((b.close - prev.close) / prev.close) * 100 : null;
    lg.chg.textContent = chg === null ? '' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    const col = up ? G.candle.up : G.candle.down;
    lg.o.style.color = lg.h.style.color = lg.l.style.color = lg.cl.style.color = col;
    lg.chg.style.color = chg === null ? '' : chg >= 0 ? G.candle.up : G.candle.down;
    for (const r of chipRefs) {
      if (r.type === 'ind') {
        const ind = settings.ind[r.key];
        if (list.length < ind.period) { r.val.textContent = `needs ${ind.period} bars`; r.val.title = `Only ${list.length} bars at this timeframe`; r.val.classList.add('vlc-need'); continue; }
        r.val.classList.remove('vlc-need'); r.val.removeAttribute('title');
        const v = chart.getIndicators({ id: indId(r.key) })[0]?.result?.[idx]?.v;
        // Early bars have no value yet (not enough history). A missing value on a late bar means the calculation hasn't landed yet.
        const early = idx < ind.period - 1;
        r.val.textContent = Number.isFinite(v) ? fmtPrice(v) : early ? `needs ${ind.period} bars` : '';
        r.val.classList.toggle('vlc-need', !Number.isFinite(v) && early);
        if (!Number.isFinite(v) && !early && !relegendTimer) relegendTimer = setTimeout(() => { relegendTimer = 0; updateLegend(); }, 120);
      } else {
        const pct = chart.getIndicators({ id: `vl_cmp_${r.ticker}` })[0]?.result?.[idx]?.pct;
        r.val.textContent = Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
      }
    }
  }

  // ----- indicators, volume, compare -----
  const indId = (key) => `vl_${key}`;
  // Indicator settings are shared per ticker: save, then let other charts on this ticker pick them up
  function saveInd() { persist(); for (const v of views) if (v !== api && v.ticker === tkr) v.reloadShared(); }
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
    if (!v.on) { if (existing) chart.removeIndicator({ name: 'VL_VOL' }); return; }
    const extendData = { mode: v.mode, color: v.color, opacity: v.opacity, up: G.candle.up, down: G.candle.down };
    if (existing) chart.overrideIndicator({ id: existing.id, name: 'VL_VOL', extendData });
    else chart.createIndicator({ name: 'VL_VOL', id: 'vl_vol', paneId: 'vl_vol_pane', extendData }, false);
    chart.setPaneOptions({ id: 'vl_vol_pane', height: v.height, minHeight: 30 });
  }
  async function refreshCompare() {
    if (!chart) return;
    for (const [t, id] of [...cmpIds]) if (!settings.compare.includes(t)) { chart.removeIndicator({ id }); cmpIds.delete(t); }
    for (let i = 0; i < settings.compare.length; i++) {
      const t = settings.compare[i];
      let cbars;
      try { cbars = await loadBars(t, settings.tf, { ext: G.ext }); } catch (err) { continue; }
      if (destroyed || !chart) return;
      const key = `${t}|${settings.tf}|${G.ext ? 1 : 0}`;
      compareStore.set(key, new Map(cbars.map((b) => [b.timestamp, b.close])));
      const extendData = { ticker: t, color: c.compare[i % c.compare.length], key, baseIndex: Math.max(0, chart.getVisibleRange().from) };
      if (cmpIds.has(t)) chart.overrideIndicator({ id: cmpIds.get(t), name: 'VL_CMP', extendData });
      else {
        const id = `vl_cmp_${t}`;
        chart.createIndicator({ id, name: 'VL_CMP', paneId: 'candle_pane', extendData }, true);
        cmpIds.set(t, id);
      }
    }
    // The price scale shows % change while compare is on
    chart.overrideYAxis({ name: settings.compare.length ? 'percentage' : 'normal', paneId: 'candle_pane' });
    updateLegend();
  }
  async function addCompare(raw) {
    const t = String(raw || '').trim().toUpperCase();
    if (!TICKER_RE.test(t) || t === tkr || settings.compare.includes(t) || settings.compare.length >= MAX_COMPARE) return 'Enter a different ticker.';
    try { await loadBars(t, settings.tf, { ext: G.ext }); } catch (err) { return failureMessage(err); }
    settings.compare.push(t);
    persist();
    renderChips();
    await refreshCompare();
    return '';
  }
  function removeCompare(t) {
    settings.compare = settings.compare.filter((x) => x !== t);
    persist();
    renderChips();
    refreshCompare();
  }

  // ----- visible range: daily opens on the last ~2 years, weekly and monthly on everything; "Fit all" shows all bars -----
  const RIGHT_PAD_BARS = 4;
  const DEFAULT_DAILY_BARS = 504;
  // Intraday opens on roughly: 1m one session, 5m three, 15m five, 30m ten, 1h ~20, 4h ~60 sessions
  const DEFAULT_BARS = { '1m': 390, '5m': 234, '15m': 130, '30m': 130, '1h': 140, '4h': 120, D: DEFAULT_DAILY_BARS };
  function fitAll(all = false) {
    if (!chart) return;
    const list = chart.getDataList();
    const size = chart.getSize('candle_pane', 'main');
    if (!list.length) return;
    if (!size || size.width < 60) { fitPending = true; return; }
    fitPending = false;
    const n = !all && DEFAULT_BARS[settings.tf] ? Math.min(list.length, DEFAULT_BARS[settings.tf]) : list.length;
    const space = size.width / (n + RIGHT_PAD_BARS);
    chart.setOffsetRightDistance(space * RIGHT_PAD_BARS);
    chart.setBarSpace(space);
    chart.scrollToRealTime();
    positionFloat();
  }

  // ----- timeframe / ticker -----
  function setTimeframe(tf) {
    if (!TF_ENABLED.has(tf) || tf === settings.tf || !chart) return;
    settings.tf = tf;
    persist();
    lg.tf.textContent = TF_LABEL[tf] || tf;
    renderTfBar?.();
    chart.setTimezone(isIntraday(tf) ? CHART_TZ : 'UTC');
    chart.setPeriod(PERIODS[tf]);
  }
  function switchTicker(raw) {
    const next = String(raw || '').trim().toUpperCase();
    if (!TICKER_RE.test(next) || next === tkr) { if (tickerInput) tickerInput.value = tkr; return; }
    cancelPending();
    closeFloat();
    destroyChart();
    tkr = next;
    settings = loadSettings(tkr, c, VALID_TOOLS, loc);
    opts.onTickerChange?.(tkr);
    if (tickerInput) tickerInput.value = tkr;
    if (newTabLink) newTabLink.setAttribute('href', `/chart/${encodeURIComponent(tkr)}`);
    renderTfBar?.();
    buildLegendLine();
    renderChips();
    createChart();
  }

  // ----- drawings (shared per ticker) -----
  const isDrawing = (o) => VALID_TOOLS.includes(o.name);
  const serialise = () => chart.getOverlays().filter((o) => isDrawing(o) && o.currentStep === -1).map((o) => ({
    name: o.name,
    points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
    extendData: o.extendData,
  }));
  function saveDrawings() {
    if (!chart) return;
    settings.drawings = serialise();
    persist();
    for (const v of views) if (v !== api && v.ticker === tkr) v.reloadShared();
  }
  // Removals the view makes itself (reloading shared drawings, clearing, cancelling) must not trigger a save, or two views
  // showing the same ticker would keep reloading each other
  let internalRemove = 0;
  const silently = (fn) => { internalRemove++; try { fn(); } finally { internalRemove--; } };
  const wire = () => ({
    onDrawEnd: ({ overlay }) => {
      pendingId = null;
      const again = G.keepDrawing && pendingTool;
      saveDrawings();
      if (again) { const t = pendingTool; setTimeout(() => startTool(t), 0); } else { setActiveTool(null); pendingTool = null; openFloat(overlay.id, true); }
      return false;
    },
    onClick: ({ overlay }) => { openFloat(overlay.id); return false; },
    onSelected: ({ overlay }) => { openFloat(overlay.id); return false; },
    onDeselected: ({ overlay }) => { if (overlay.id === selectedId) closeFloat(); return false; },
    onPressedMoving: () => { positionFloat(); return false; },
    onPressedMoveEnd: () => { saveDrawings(); positionFloat(); return false; },
    onRemoved: ({ overlay }) => { if (overlay.id === selectedId) closeFloat(); if (!internalRemove) setTimeout(saveDrawings, 0); return false; },
  });
  function startTool(tool) {
    if (!chart) return;
    cancelPending(true);
    closeFloat();
    const ex = { ...defaultStyle(tool.overlay, c), ...tool.preset };
    const id = chart.createOverlay({ name: tool.overlay, paneId: 'candle_pane', extendData: ex, needDefaultYAxisFigure: ex.priceTag !== false, ...wire() });
    pendingId = Array.isArray(id) ? id[0] : id;
    pendingTool = tool;
    setActiveTool(tool.id);
  }
  function cancelPending(keepTool) {
    if (pendingId && chart) silently(() => chart.removeOverlay({ id: pendingId }));
    pendingId = null;
    if (!keepTool) { pendingTool = null; setActiveTool(null); }
  }
  function restoreDrawings() {
    for (const d of settings.drawings) {
      chart.createOverlay({ name: d.name, paneId: 'candle_pane', points: d.points, extendData: d.extendData, needDefaultYAxisFigure: d.extendData?.priceTag !== false, ...wire() });
    }
  }
  // Another chart (or browser tab) changed this ticker's shared drawings or indicators
  function reloadShared() {
    if (!chart) return;
    let fresh;
    try { fresh = loadSettings(tkr, c, VALID_TOOLS, loc); } catch (err) { return; }
    let indChanged = false;
    for (const k of IND_KEYS) {
      const a = settings.ind[k], b = fresh.ind[k];
      if (a.on !== b.on || a.color !== b.color) { settings.ind[k] = { ...a, on: b.on, color: b.color }; applyIndicator(k); indChanged = true; }
    }
    if (indChanged) { renderChips(); updateLegend(); }
    if (JSON.stringify(settings.drawings) === JSON.stringify(fresh.drawings)) return;
    settings.drawings = fresh.drawings;
    silently(() => { for (const o of chart.getOverlays()) if (isDrawing(o) && o.currentStep === -1) chart.removeOverlay({ id: o.id }); });
    restoreDrawings();
    if (selectedId && !chart.getOverlays({ id: selectedId }).length) closeFloat();
  }
  function deleteAllDrawings() {
    if (!chart) return;
    cancelPending();
    closeFloat();
    silently(() => { for (const o of chart.getOverlays()) if (isDrawing(o)) chart.removeOverlay({ id: o.id }); });
    settings.drawings = [];
    persist();
    for (const v of views) if (v !== api && v.ticker === tkr) v.reloadShared();
  }

  // ----- floating toolbar above the selected drawing -----
  let moreOpen = false;
  function closeFloat() { floatBar.hidden = true; floatBar.replaceChildren(); selectedId = null; moreOpen = false; }

  function openFloat(id, focusLabel = false) {
    if (!chart) return;
    const ov = chart.getOverlays({ id })[0];
    if (!ov || ov.currentStep !== -1) return;
    // The click that finishes a drawing also reports a selection: don't rebuild (and drop focus from) an open toolbar
    if (selectedId === id && !floatBar.hidden) { positionFloat(); return; }
    selectedId = id;
    moreOpen = false;
    buildFloat(focusLabel);
    positionFloat();
  }

  function buildFloat(focusLabel = false) {
    const ov = chart.getOverlays({ id: selectedId })[0];
    if (!ov) { closeFloat(); return; }
    const isV = ov.name === 'vlVLine';
    const isText = ov.name === 'vlText';
    const read = () => ({ ...defaultStyle(ov.name, c), ...(chart.getOverlays({ id: selectedId })[0]?.extendData || {}) });
    const apply = (patch) => {
      const cur = read();
      const next = { ...cur, ...patch, show: { ...cur.show, ...(patch.show || {}) } };
      chart.overrideOverlay({ id: selectedId, extendData: next, needDefaultYAxisFigure: next.priceTag !== false });
      saveDrawings();
      positionFloat();
    };
    const cur = read();
    floatBar.replaceChildren();
    floatBar.hidden = false;

    const group = (...nodes) => el('div', { class: 'vlc-fgroup' }, nodes);
    const toggleBtn = (ic, title, on, onClick) => {
      const b = el('button', { class: `vlc-ibtn${on ? ' active' : ''}`, attrs: { type: 'button', title, 'aria-label': title }, on: { click: () => { const next = !b.classList.contains('active'); b.classList.toggle('active', next); onClick(next); } } }, icon(ic, 16));
      return b;
    };
    const color = colorInput(/^#[0-9a-f]{6}$/i.test(cur.color) ? cur.color : c.blue, (v) => apply({ color: v }), 'Color');
    const widthSel = el('select', { class: 'vlc-select mono', attrs: { 'aria-label': isText ? 'Size' : 'Width', title: isText ? 'Size' : 'Width' }, on: { change: () => apply({ width: Number(widthSel.value) }) } });
    for (const w of [1, 1.5, 2, 3, 4]) { const o = el('option', { text: isText ? `${Math.round(10 + w * 2)}pt` : `${w}px`, attrs: { value: String(w) } }); if (w === cur.width) o.selected = true; widthSel.append(o); }
    const dashSeg = el('div', { class: 'vlc-seg' });
    for (const d of ['solid', 'dashed', 'dotted']) {
      dashSeg.append(el('button', { class: `vlc-seg-btn${cur.dash === d ? ' active' : ''}`, attrs: { type: 'button', title: d[0].toUpperCase() + d.slice(1), 'aria-label': d }, on: { click: () => { for (const b of dashSeg.children) b.classList.remove('active'); dashSeg.querySelector(`[aria-label="${d}"]`).classList.add('active'); apply({ dash: d }); } } }, icon(d, 18)));
    }
    const labelIn = el('input', { class: 'vlc-text', attrs: { type: 'text', maxlength: '60', placeholder: isText ? 'Text' : 'Label', 'aria-label': 'Text label' }, on: { input: () => apply({ label: labelIn.value.slice(0, 60) }) } });
    labelIn.value = cur.label || '';
    const moreBtn = el('button', { class: `vlc-ibtn${moreOpen ? ' active' : ''}`, attrs: { type: 'button', title: 'More options', 'aria-label': 'More options' }, on: { click: () => { moreOpen = !moreOpen; moreBtn.classList.toggle('active', moreOpen); more.hidden = !moreOpen; positionFloat(); } } }, icon('more', 18));
    const delBtn = iconBtn('trash', 'Delete drawing', () => { chart.removeOverlay({ id: selectedId }); closeFloat(); saveDrawings(); }, 'danger');

    const more = el('div', { class: 'vlc-fmore', attrs: moreOpen ? {} : { hidden: '' } });
    if (!isV && !isText) {
      more.append(
        check('Price label on axis', cur.priceTag !== false, (v) => apply({ priceTag: v })),
        el('div', { class: 'vlc-fmore-title', text: 'Line shows' }),
        el('div', { class: 'vlc-fmore-row' }, [
          check('Price', cur.show.price, (v) => apply({ show: { price: v } })), check('% change', cur.show.pct, (v) => apply({ show: { pct: v } })),
          check('Bars', cur.show.bars, (v) => apply({ show: { bars: v } })), check('Days', cur.show.days, (v) => apply({ show: { days: v } })),
        ]),
      );
    } else if (isV) {
      more.append(check('Show date', cur.show.price || cur.show.days || cur.show.pct || cur.show.bars, (v) => apply({ show: { price: v, days: false, pct: false, bars: false } })));
    } else {
      more.append(el('div', { class: 'vlc-fmore-title', text: 'Text label' }), el('div', { class: 'vlc-dim', text: 'Edit the text above; the size menu changes the font size.' }));
    }

    const bar = el('div', { class: 'vlc-fbar' }, [
      group(color, widthSel),
      isText ? null : group(dashSeg),
      isText ? null : group(
        toggleBtn(isV ? 'up' : 'left', isV ? 'Extend up' : 'Extend left', cur.extendLeft, (v) => apply({ extendLeft: v })),
        toggleBtn(isV ? 'down' : 'right', isV ? 'Extend down' : 'Extend right', cur.extendRight, (v) => apply({ extendRight: v })),
      ),
      group(labelIn),
      group(moreBtn, delBtn),
    ]);
    floatBar.append(bar, more);
    // A freshly placed text label goes straight into editing
    if (isText && focusLabel) setTimeout(() => { labelIn.focus(); labelIn.select(); }, 0);
  }

  let posRaf = 0;
  function positionFloat() {
    if (floatBar.hidden || !selectedId) return;
    cancelAnimationFrame(posRaf);
    posRaf = requestAnimationFrame(() => {
      if (!chart || floatBar.hidden) return;
      const ov = chart.getOverlays({ id: selectedId })[0];
      if (!ov) return;
      const pts = ov.points.filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value)).map((p) => ({ timestamp: p.timestamp, value: p.value }));
      if (!pts.length) return;
      let coords = chart.convertToPixel(pts, { paneId: 'candle_pane' });
      coords = [].concat(coords).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!coords.length) return;
      const xs = coords.map((p) => p.x), ys = coords.map((p) => p.y);
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const fw = floatBar.offsetWidth, fh = floatBar.offsetHeight;
      let x = (Math.min(...xs) + Math.max(...xs)) / 2 - fw / 2;
      let y = Math.min(...ys) - fh - 14;
      if (y < 64) y = Math.max(...ys) + 16; // below the legend: drop under the drawing instead
      x = Math.max(6, Math.min(x, sw - fw - 6));
      y = Math.max(6, Math.min(y, sh - fh - 6));
      floatBar.style.left = `${Math.round(x)}px`;
      floatBar.style.top = `${Math.round(y)}px`;
    });
  }

  // ----- top toolbar -----
  let tickerInput = null;
  let newTabLink = null;
  let renderTfBar = null;
  let setActiveTool = () => {};
  const hostEls = {};

  function buildTop() {
    top.replaceChildren();
    // Ticker search / select (any ticker may be typed; only sample tickers have data until Schwab is connected)
    const listId = `vlc-tickers-${Math.random().toString(36).slice(2, 7)}`;
    tickerInput = el('input', { class: 'vlc-ticker mono', attrs: { type: 'text', list: listId, value: tkr, maxlength: '8', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Ticker', title: 'Type a ticker and press Enter' } });
    tickerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { switchTicker(tickerInput.value); tickerInput.blur(); } });
    tickerInput.addEventListener('change', () => switchTicker(tickerInput.value));
    tickerInput.addEventListener('focus', () => tickerInput.select());
    const dl = el('datalist', { attrs: { id: listId } }, SAMPLE_TICKERS.map((t) => el('option', { attrs: { value: t } })));

    // Timeframe dropdown, grouped like TradingView, with favorites as quick buttons
    const tfTrigger = el('button', { class: 'vlc-btn mono', attrs: { type: 'button', title: 'Timeframe' } });
    const tfMenu = makeMenu(tfTrigger, {
      cls: 'tf-menu',
      onOpen: (menu) => {
        menu.replaceChildren();
        for (const grp of TF_GROUPS) {
          menu.append(el('div', { class: 'vlc-menu-head', text: grp.label }));
          for (const it of grp.items) {
            const enabled = TF_ENABLED.has(it.id);
            const fav = G.favTfs.includes(it.id);
            const pick = el('button', { class: `vlc-tf-item${settings.tf === it.id ? ' active' : ''}`, attrs: { type: 'button', title: enabled ? (it.title || it.label) : 'Needs Schwab', ...(enabled ? {} : { disabled: '' }) }, on: { click: () => { setTimeframe(it.id); menu.hidden = true; } } }, [
              el('span', { class: 'mono', text: it.label }), enabled ? (it.title ? el('span', { class: 'vlc-dim', text: it.title }) : null) : el('span', { class: 'vlc-hint', text: 'Needs Schwab' }),
            ]);
            const star = el('button', { class: `vlc-star${fav ? ' on' : ''}`, attrs: { type: 'button', title: fav ? 'Remove from quick buttons' : 'Add to quick buttons', 'aria-label': `Favorite ${it.label}`, 'aria-pressed': String(fav) }, on: { click: () => {
              G.favTfs = G.favTfs.includes(it.id) ? G.favTfs.filter((x) => x !== it.id) : [...G.favTfs, it.id];
              persistGlobal(); renderTfBar(); tfMenu.rec.menu.hidden = true; tfMenu.toggle();
            } } }, icon('star', 15));
            menu.append(el('div', { class: 'vlc-tf-row' }, [pick, star]));
          }
        }
      },
    });
    tfTrigger.addEventListener('click', tfMenu.toggle);
    const tfWrap = el('div', { class: 'vlc-dd' }, [tfTrigger, tfMenu.menu]);
    const favWrap = el('div', { class: 'vlc-favs' });
    renderTfBar = () => {
      tfTrigger.replaceChildren(el('span', { text: settings.tf }), icon('caret', 14));
      favWrap.replaceChildren();
      const order = TF_GROUPS.flatMap((g) => g.items.map((i) => i.id));
      for (const id of order.filter((x) => G.favTfs.includes(x))) {
        const enabled = TF_ENABLED.has(id);
        favWrap.append(el('button', { class: `vlc-btn mono vlc-quick${settings.tf === id ? ' active' : ''}`, text: id, attrs: { type: 'button', title: enabled ? (TF_LABEL[id] || id) : 'Needs Schwab', ...(enabled ? {} : { disabled: '' }) }, on: { click: () => setTimeframe(id) } }));
      }
    };
    renderTfBar();

    // Indicators dropdown
    const indTrigger = el('button', { class: 'vlc-btn', attrs: { type: 'button', title: 'Indicators' } }, [icon('indicators', 16), el('span', { class: 'vlc-lbl', text: 'Indicators' }), icon('caret', 14)]);
    const indMenu = makeMenu(indTrigger, {
      onOpen: (menu) => {
        menu.replaceChildren(el('div', { class: 'vlc-menu-head', text: 'Moving averages' }));
        for (const key of IND_KEYS) {
          const ind = settings.ind[key];
          const cb = el('input', { attrs: { type: 'checkbox' }, on: { change: () => { ind.on = cb.checked; saveInd(); applyIndicator(key); renderChips(); updateLegend(); } } });
          cb.checked = ind.on;
          const sw = colorInput(ind.color, (v) => { ind.color = v; saveInd(); applyIndicator(key); renderChips(); updateLegend(); }, `${ind.label} color`);
          menu.append(el('label', { class: 'vlc-ind-row' }, [cb, el('span', { class: 'mono vlc-ind-name', text: ind.label }), sw]));
        }
      },
    });
    indTrigger.addEventListener('click', indMenu.toggle);
    const indWrap = el('div', { class: 'vlc-dd' }, [indTrigger, indMenu.menu]);

    // Compare
    const cmpTrigger = el('button', { class: 'vlc-btn', attrs: { type: 'button', title: 'Compare with another ticker (shows % change)' } }, [icon('compare', 16), el('span', { class: 'vlc-lbl', text: 'Compare' })]);
    const cmpMenu = makeMenu(cmpTrigger, {
      onOpen: (menu) => {
        menu.replaceChildren();
        const input = el('input', { class: 'vlc-text mono', attrs: { type: 'text', list: listId, maxlength: '8', placeholder: 'Ticker', autocomplete: 'off', 'aria-label': 'Compare ticker' } });
        const note = el('div', { class: 'vlc-hint-line' });
        const add = async () => {
          if (!input.value.trim()) return;
          note.textContent = 'Adding…';
          const err = await addCompare(input.value);
          note.textContent = err || '';
          if (!err) { input.value = ''; menu.hidden = true; }
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
        menu.append(
          el('div', { class: 'vlc-menu-head', text: `Compare (up to ${MAX_COMPARE}, shown as % change)` }),
          el('div', { class: 'vlc-row' }, [input, el('button', { class: 'vlc-btn', text: 'Add', attrs: { type: 'button' }, on: { click: add } })]),
          note,
          settings.compare.length ? el('div', { class: 'vlc-dim', text: `On chart: ${settings.compare.join(', ')} (remove from the legend chips)` }) : null,
        );
        setTimeout(() => input.focus(), 0);
      },
    });
    cmpTrigger.addEventListener('click', cmpMenu.toggle);
    const cmpWrap = el('div', { class: 'vlc-dd' }, [cmpTrigger, cmpMenu.menu]);

    // Chart settings (gear): volume options and candle colors
    const gearTrigger = iconBtn('gear', 'Chart settings', () => {}, 'vlc-gear');
    const gearMenu = makeMenu(gearTrigger, {
      cls: 'gear-menu',
      onOpen: (menu) => {
        menu.replaceChildren();
        const v = settings.vol;
        const mode = el('select', { class: 'vlc-select', on: { change: () => { v.mode = mode.value; persist(); applyVolume(); } } }, [el('option', { text: 'Green / red by candle', attrs: { value: 'direction' } }), el('option', { text: 'Single color', attrs: { value: 'single' } })]);
        mode.value = v.mode;
        const opText = el('span', { class: 'mono vlc-val', text: `${Math.round(v.opacity * 100)}%` });
        const op = el('input', { attrs: { type: 'range', min: '5', max: '100', step: '5', value: String(Math.round(v.opacity * 100)), 'aria-label': 'Volume opacity' }, on: { input: () => { v.opacity = Number(op.value) / 100; opText.textContent = `${op.value}%`; persist(); applyVolume(); } } });
        const hText = el('span', { class: 'mono vlc-val', text: `${v.height}px` });
        const h = el('input', { attrs: { type: 'range', min: '40', max: '240', step: '10', value: String(v.height), 'aria-label': 'Volume pane height' }, on: { input: () => { v.height = Number(h.value); hText.textContent = `${h.value}px`; persist(); applyVolume(); } } });
        const row = (label, ...nodes) => el('div', { class: 'vlc-row' }, [el('span', { class: 'vlc-row-label', text: label }), ...nodes]);
        menu.append(
          el('div', { class: 'vlc-menu-head', text: 'Volume' }),
          check('Show volume', v.on, (on) => { v.on = on; persist(); applyVolume(); }),
          row('Bars', mode),
          row('Color', colorInput(v.color, (val) => { v.color = val; persist(); applyVolume(); }, 'Volume color')),
          row('Opacity', op, opText),
          row('Height', h, hText),
          el('div', { class: 'vlc-menu-head', text: 'Candle colors' }),
          row('Up', colorInput(G.candle.up, (val) => { G.candle.up = val; setCandleColors(); }, 'Up candle color')),
          row('Down', colorInput(G.candle.down, (val) => { G.candle.down = val; setCandleColors(); }, 'Down candle color')),
          el('button', { class: 'vlc-btn', text: 'Reset candle colors', attrs: { type: 'button' }, on: { click: () => { G.candle = { up: c.green, down: c.red }; setCandleColors(); gearMenu.rec.menu.hidden = true; } } }),
          el('div', { class: 'vlc-menu-head', text: 'Session' }),
          check('Extended hours (pre/after-market, intraday)', G.ext, (on) => { G.ext = on; persistGlobal(); if (isIntraday(settings.tf)) reloadData(); else refreshCompare(); }),
        );
      },
    });
    gearTrigger.addEventListener('click', gearMenu.toggle);
    const gearWrap = el('div', { class: 'vlc-dd' }, [gearTrigger, gearMenu.menu]);

    // Fit all bars
    const fitBtn = iconBtn('fit', 'Fit all: show every bar', () => fitAll(true));

    // Right side. Page: layout, open in new tab, full screen. Card: open in Charts, expand / minimize in place.
    const right = el('div', { class: 'vlc-top-right' });
    if (card) {
      const toCharts = el('a', { class: 'vlc-ibtn', attrs: { href: `/chart/${encodeURIComponent(tkr)}`, title: 'Open in Charts', 'aria-label': 'Open in Charts' } }, icon('charts', 18));
      toCharts.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return; e.preventDefault(); opts.onOpenInCharts?.(tkr); });
      newTabLink = toCharts;
      const expandBtn = el('button', { class: 'vlc-btn vlc-expand-btn', attrs: { type: 'button' }, on: { click: () => setExpanded(!expanded) } });
      paintExpandBtn = () => {
        expandBtn.replaceChildren(icon(expanded ? 'minimize' : 'expand', 16), el('span', { text: expanded ? 'Minimize' : 'Expand' }));
        expandBtn.title = expanded ? 'Minimize (Esc)' : 'Expand this chart over the page';
      };
      paintExpandBtn();
      right.append(toCharts, expandBtn);
    } else {
      if (opts.layout) {
        const seg = el('div', { class: 'vlc-seg' });
        for (const n of [1, 2]) seg.append(el('button', { class: `vlc-seg-btn${opts.layout.count === n ? ' active' : ''}`, attrs: { type: 'button', title: n === 1 ? 'One chart' : 'Two charts side by side', 'aria-label': n === 1 ? 'One chart' : 'Two charts' }, on: { click: () => opts.layout.onChange(n) } }, icon(n === 1 ? 'one' : 'two', 18)));
        right.append(seg);
      }
      newTabLink = el('a', { class: 'vlc-ibtn', attrs: { href: `/chart/${encodeURIComponent(tkr)}`, target: '_blank', rel: 'noopener', title: 'Open in new tab', 'aria-label': 'Open in new tab' } }, icon('external', 18));
      const fsBtn = iconBtn('fullscreen', 'Full screen', toggleFullscreen);
      right.append(newTabLink, fsBtn);
      hostEls.fsBtn = fsBtn;
    }

    // In the card the ticker is the company being viewed, so there is no ticker box
    top.append(...(card ? [] : [tickerInput, dl]), tfWrap, favWrap, el('span', { class: 'vlc-sep' }), indWrap, cmpWrap, gearWrap, fitBtn, el('span', { class: 'vlc-spacer' }), right);
  }

  function setCandleColors() {
    persistGlobal();
    if (!chart) return;
    chart.setStyles({ candle: { bar: {
      upColor: G.candle.up, downColor: G.candle.down, upBorderColor: G.candle.up, downBorderColor: G.candle.down, upWickColor: G.candle.up, downWickColor: G.candle.down,
    }, priceMark: { last: { upColor: G.candle.up, downColor: G.candle.down } } } });
    applyVolume();
    updateLegend();
  }

  // ----- left drawing toolbar -----
  function buildLeft() {
    left.replaceChildren();
    const buttons = new Map();
    setActiveTool = (toolId) => { for (const [id, b] of buttons) b.classList.toggle('active', id === toolId); };
    for (const grp of TOOL_GROUPS) {
      const lastId = G.lastTool[grp.id];
      let current = grp.tools.find((t) => t.id === lastId) || grp.tools[0];
      const main = el('button', { class: 'vlc-tool', attrs: { type: 'button' } });
      const paintMain = () => {
        main.replaceChildren(icon(current.id, 22));
        main.setAttribute('title', `${current.label} (click the chart to place; Esc cancels)`);
        main.setAttribute('aria-label', current.label);
      };
      paintMain();
      buttons.set(current.id, main);
      const group = el('div', { class: 'vlc-tool-group' });
      const run = () => { if (pendingTool && pendingTool.id === current.id) cancelPending(); else startTool(current); };
      main.addEventListener('click', run);
      group.append(main);
      if (grp.tools.length > 1) {
        const chev = el('button', { class: 'vlc-flyout-btn', attrs: { type: 'button', title: `${grp.label}: more tools`, 'aria-label': `${grp.label}: more tools` } }, icon('chevron', 10));
        const fly = makeMenu(chev, {
          side: 'right',
          onOpen: (menu) => {
            menu.replaceChildren(el('div', { class: 'vlc-menu-head', text: grp.label }));
            for (const t of grp.tools) {
              menu.append(el('button', { class: `vlc-fly-item${t.id === current.id ? ' active' : ''}`, attrs: { type: 'button' }, on: { click: () => {
                buttons.delete(current.id);
                current = t;
                G.lastTool[grp.id] = t.id;
                persistGlobal();
                buttons.set(t.id, main);
                paintMain();
                menu.hidden = true;
                startTool(t);
              } } }, [icon(t.id, 18), el('span', { text: t.label })]));
            }
          },
        });
        chev.addEventListener('click', fly.toggle);
        group.append(chev, fly.menu);
      }
      left.append(group);
    }
    left.append(el('span', { class: 'vlc-vspacer' }));
    const lockBtn = el('button', { class: `vlc-tool${G.keepDrawing ? ' active' : ''}`, attrs: { type: 'button', title: 'Keep drawing mode: stay on the tool after each drawing', 'aria-label': 'Keep drawing mode', 'aria-pressed': String(G.keepDrawing) } }, icon(G.keepDrawing ? 'lock' : 'unlock', 22));
    lockBtn.addEventListener('click', () => {
      G.keepDrawing = !G.keepDrawing;
      persistGlobal();
      lockBtn.classList.toggle('active', G.keepDrawing);
      lockBtn.setAttribute('aria-pressed', String(G.keepDrawing));
      lockBtn.replaceChildren(icon(G.keepDrawing ? 'lock' : 'unlock', 22));
    });
    left.append(lockBtn, el('button', { class: 'vlc-tool danger', attrs: { type: 'button', title: 'Delete all drawings on this ticker', 'aria-label': 'Delete all drawings' }, on: { click: deleteAllDrawings } }, icon('trash', 22)));
  }

  // ----- live data (Schwab stream) -----
  function stopLive() {
    if (liveOff) { liveOff(); liveOff = null; }
    paintLive();
  }
  const offStatus = onStreamStatus(() => paintLive());
  let legendRaf = 0;
  function scheduleLegend() {
    cancelAnimationFrame(legendRaf);
    legendRaf = requestAnimationFrame(updateLegend);
  }
  function reloadData() {
    // Re-create the chart so new data (e.g. extended hours on/off) loads; drawings and settings are kept
    cancelPending();
    closeFloat();
    destroyChart();
    createChart();
  }

  // ----- chart lifecycle -----
  let ro = null;
  function createChart() {
    setMsg('');
    chart = kc.init(canvas, {
      timezone: isIntraday(settings.tf) ? CHART_TZ : 'UTC', locale: 'en-US', styles: buildStyles(c, G),
      formatter: { formatDate: (a) => (isIntraday(settings.tf) ? formatIntradayDate(a) : formatBarDate(a)) },
      layout: { barSpaceLimit: { min: 0.05, max: 60 } },
    });
    if (!chart) { setMsg('Chart could not start.'); return; }
    chart.setDataLoader({
      getBars: async ({ type, symbol, period, callback }) => {
        if (type !== 'init') { callback([], false); return; }
        try {
          const tf = tfOfPeriod(period);
          const bars = await loadBars(symbol.ticker, tf, { ext: G.ext });
          if (destroyed) return;
          dataSource = bars.source || null;
          lg.src.textContent = SOURCE_LABEL[dataSource] || '';
          callback(bars.map((b) => ({ ...b })), false);
          setMsg('');
          requestAnimationFrame(() => { fitAll(); updateLegend(); });
          refreshCompare();
        } catch (err) {
          dataSource = null;
          lg.src.textContent = '';
          callback([], false);
          setMsg(failureMessage(err));
        }
      },
      // Live: Schwab streaming quotes move the newest bar (or open a new one) as trades happen
      subscribeBar: ({ symbol, period, callback }) => {
        stopLive();
        if (dataSource !== 'schwab') return; // FMP/sample data is end-of-day; live prices only on Schwab data
        const tf = tfOfPeriod(period);
        let prevTotal = null;
        liveOff = subscribeQuotes(symbol.ticker, (q) => {
          if (!chart || destroyed || !Number.isFinite(q.last)) return;
          const now = Number.isFinite(q.tradeTime) ? q.tradeTime : Date.now();
          const delta = Number.isFinite(q.totalVolume) && prevTotal !== null ? Math.max(0, q.totalVolume - prevTotal) : 0;
          if (Number.isFinite(q.totalVolume)) prevTotal = q.totalVolume;
          const regular = inRegularSession(now);
          const list = chart.getDataList();
          const last = list[list.length - 1];
          if (!last) return;
          let key;
          if (isIntraday(tf)) {
            if (!regular && !G.ext) return;
            key = bucketStart(now, INTRADAY[tf].size);
          } else {
            if (!regular) return; // daily-type candles use regular-session prices, like thinkorswim/TradingView
            key = periodKey(tradingDayKey(now), tf);
          }
          if (key < last.timestamp) return;
          const p = q.last;
          let bar;
          if (key === last.timestamp) {
            bar = { ...last, close: p, high: Math.max(last.high, p), low: Math.min(last.low, p), volume: last.volume + delta };
          } else {
            bar = { timestamp: key, open: p, high: p, low: p, close: p, volume: delta };
          }
          if (tf === 'D') {
            // Schwab's day totals are exact for the daily candle
            if (Number.isFinite(q.dayHigh) && q.dayHigh > 0) bar.high = Math.max(bar.high, q.dayHigh);
            if (Number.isFinite(q.dayLow) && q.dayLow > 0) bar.low = Math.min(bar.low, q.dayLow);
            if (Number.isFinite(q.totalVolume)) bar.volume = q.totalVolume;
          }
          callback(bar);
          scheduleLegend();
        });
        paintLive();
      },
      unsubscribeBar: () => stopLive(),
    });
    chart.setSymbol({ ticker: tkr, pricePrecision: 2, volumePrecision: 0 });
    chart.setPeriod(PERIODS[settings.tf]);
    for (const key of IND_KEYS) applyIndicator(key);
    applyVolume();
    restoreDrawings();

    let lastBase = -1;
    chart.subscribeAction('onVisibleRangeChange', () => {
      positionFloat();
      if (!chart || !settings.compare.length) return;
      // keep compare lines rebased to the first visible bar (the % axis does the same for the candles)
      const base = Math.max(0, chart.getVisibleRange().from);
      if (base === lastBase) return;
      lastBase = base;
      for (const id of cmpIds.values()) {
        const ind = chart.getIndicators({ id })[0];
        if (ind) chart.overrideIndicator({ id, name: 'VL_CMP', extendData: { ...ind.extendData, baseIndex: base } });
      }
    });
    let crossRaf = 0;
    chart.subscribeAction('onCrosshairChange', (d) => {
      crossIdx = d && d.kLineData && Number.isFinite(d.dataIndex) ? d.dataIndex : null;
      cancelAnimationFrame(crossRaf);
      crossRaf = requestAnimationFrame(updateLegend);
    });
    ro = new ResizeObserver(() => {
      if (!chart) return;
      chart.resize();
      if (fitPending) fitAll();
      positionFloat();
    });
    ro.observe(canvas);
  }
  function destroyChart() {
    stopLive();
    if (ro) { ro.disconnect(); ro = null; }
    if (chart) { try { kc.dispose(canvas); } catch (err) { /* already gone */ } }
    chart = null;
    cmpIds.clear();
    crossIdx = null;
  }

  // ----- full screen -----
  function toggleFullscreen() {
    if (document.fullscreenElement === root) document.exitFullscreen?.();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => setMsg('Full screen is not available in this browser.'));
    else setMsg('Full screen is not available in this browser.');
  }
  const onFsChange = () => {
    const on = document.fullscreenElement === root;
    root.classList.toggle('is-fullscreen', on);
    if (hostEls.fsBtn) hostEls.fsBtn.title = on ? 'Exit full screen' : 'Full screen';
    setTimeout(() => chart && chart.resize(), 60);
  };
  document.addEventListener('fullscreenchange', onFsChange);

  const onKey = (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      if (pendingId) cancelPending();
      else if (menus.some((m) => !m.menu.hidden)) closeMenus();
      else if (!floatBar.hidden) closeFloat();
      else if (expanded) setExpanded(false);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !typing && chart) {
      chart.removeOverlay({ id: selectedId });
      closeFloat();
      saveDrawings();
    }
  };
  document.addEventListener('keydown', onKey);
  // Another browser tab changed this ticker's drawings
  const onStorage = (e) => { if (e.key === settingsKey(tkr)) reloadShared(); };
  window.addEventListener('storage', onStorage);

  // ----- expand in place (card mode): a full-viewport overlay over the current page, no navigation -----
  function setExpanded(on) {
    if (!card || on === expanded) return;
    expanded = on;
    root.classList.toggle('expanded', on);
    document.body.classList.toggle('vlc-noscroll', on);
    closeMenus();
    paintExpandBtn?.();
    setTimeout(() => { if (chart) chart.resize(); positionFloat(); }, 30);
  }
  let paintExpandBtn = null;

  buildLegendLine();
  renderChips();
  buildTop();
  buildLeft();
  createChart();

  const api = {
    get ticker() { return tkr; },
    reloadShared,
    setExpanded,
    get expanded() { return expanded; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (expanded) document.body.classList.remove('vlc-noscroll');
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocDown);
      window.removeEventListener('storage', onStorage);
      cancelAnimationFrame(posRaf);
      cancelAnimationFrame(legendRaf);
      offStatus();
      destroyChart();
      root.remove();
      views.delete(api);
    },
    debug: () => ({ chart, settings, G }),
  };
  views.add(api);
  return api;
}

export function __views() { return [...views]; }
