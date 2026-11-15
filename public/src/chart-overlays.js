// KLineChart registrations for the Charts prototype: our own indicators (EMA/SMA, volume, compare) and drawing tools.
// KLineChart's built-in line tools cannot extend each end independently, show a text label or choose what a line
// shows, so the five tools are registered here as custom overlays whose look is driven by overlay.extendData.

// Overlay types (what is stored with a saved drawing). steps = clicks + 1.
export const TOOLS = [
  { name: 'vlText', label: 'Text', short: 'Text', steps: 2 },
  { name: 'vlTrend', label: 'Trend line', short: 'Trend', steps: 3 },
  { name: 'vlHLine', label: 'Horizontal line', short: 'H-line', steps: 3 },
  { name: 'vlVLine', label: 'Vertical line', short: 'V-line', steps: 3 },
  { name: 'vlChannel', label: 'Parallel channel', short: 'Channel', steps: 4 },
  { name: 'vlFib', label: 'Fib retracement', short: 'Fib', steps: 3 },
];

// Toolbar tools. Several tools are presets of one overlay type (a ray is a trend line extended to the right, and so on),
// so every drawing stays editable. preset overrides the overlay's defaults; extendLeft/extendRight are screen sides.
export const TOOL_GROUPS = [
  { id: 'lines', label: 'Lines', tools: [
    { id: 'trend', overlay: 'vlTrend', label: 'Trend line', preset: {} },
    { id: 'ray', overlay: 'vlTrend', label: 'Ray', preset: { extendRight: true } },
    { id: 'extended', overlay: 'vlTrend', label: 'Extended line', preset: { extendLeft: true, extendRight: true } },
    { id: 'hline', overlay: 'vlHLine', label: 'Horizontal line', preset: {} },
    { id: 'hray', overlay: 'vlHLine', label: 'Horizontal ray', preset: { extendLeft: false, extendRight: true } },
    { id: 'vline', overlay: 'vlVLine', label: 'Vertical line', preset: {} },
  ] },
  { id: 'channels', label: 'Channels', tools: [{ id: 'channel', overlay: 'vlChannel', label: 'Parallel channel', preset: {} }] },
  { id: 'fib', label: 'Fib', tools: [{ id: 'fib', overlay: 'vlFib', label: 'Fib retracement', preset: {} }] },
  { id: 'text', label: 'Text', tools: [{ id: 'text', overlay: 'vlText', label: 'Text label', preset: {} }] },
];

// Default look/behavior per tool. extendLeft/extendRight: for the vertical line they mean the top/bottom end.
export function defaultStyle(name, colors) {
  const base = { dash: 'solid', color: colors.blue, width: 1.5, extendLeft: false, extendRight: false, label: '', priceTag: true, show: { price: false, pct: false, bars: false, days: false } };
  if (name === 'vlText') return { ...base, color: colors.text, width: 1.5, label: 'Text', priceTag: false };
  if (name === 'vlHLine') return { ...base, color: colors.yellow, extendLeft: true, extendRight: true, show: { ...base.show, price: true } };
  if (name === 'vlVLine') return { ...base, color: colors.text2, dash: 'dashed', extendLeft: true, extendRight: true, priceTag: false };
  if (name === 'vlFib') return { ...base, color: colors.yellow, width: 1, extendRight: true };
  if (name === 'vlChannel') return { ...base, show: { ...base.show, pct: true } };
  return { ...base, show: { ...base.show, pct: true, bars: true } };
}

const DAY = 86400000;

// Compare price maps live here, not in indicator.extendData: KLineChart deep-copies extendData, which turns a Map into a plain object.
export const compareStore = new Map();
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---- Indicators -------------------------------------------------------------------------------------------------

function emaCalc(dataList, period) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  let sum = 0;
  dataList.forEach((d, i) => {
    if (i < period - 1) { sum += d.close; out.push({}); return; }
    if (i === period - 1) { sum += d.close; prev = sum / period; } else prev = d.close * k + prev * (1 - k);
    out.push({ v: prev });
  });
  return out;
}

function smaCalc(dataList, period) {
  const out = [];
  let sum = 0;
  dataList.forEach((d, i) => {
    sum += d.close;
    if (i >= period) sum -= dataList[i - period].close;
    out.push(i >= period - 1 ? { v: sum / period } : {});
  });
  return out;
}

const hexToRgba = (hex, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function registerAll(kc, colors) {
  // Moving average line. extendData = { type: 'ema' | 'sma', color, title }
  kc.registerIndicator({
    name: 'VL_MA',
    shortName: 'MA',
    series: 'price',
    precision: 2,
    calcParams: [50],
    extendData: { type: 'ema', color: colors.blue, title: 'EMA' },
    shouldUpdate: (prev, cur) => prev.calcParams[0] !== cur.calcParams[0] || prev.extendData?.type !== cur.extendData?.type || { calc: false, draw: true },
    figures: [{
      key: 'v',
      title: '',
      type: 'line',
      styles: ({ indicator }) => ({ color: indicator.extendData?.color || colors.blue, size: 1.4 }),
    }],
    regenerateFigures: () => [{ key: 'v', title: '', type: 'line', styles: ({ indicator }) => ({ color: indicator.extendData?.color || colors.blue, size: 1.4 }) }],
    calc: (dataList, indicator) => (indicator.extendData?.type === 'sma' ? smaCalc(dataList, indicator.calcParams[0]) : emaCalc(dataList, indicator.calcParams[0])),
    createTooltipDataSource: ({ indicator, crosshair }) => {
      const i = crosshair.dataIndex;
      const v = indicator.result?.[i]?.v;
      const ex = indicator.extendData || {};
      return { name: '', calcParamsText: '', features: [], legends: [{ title: { text: `${ex.title || 'MA'} ${indicator.calcParams[0]}: `, color: ex.color }, value: { text: isNum(v) ? v.toFixed(2) : '--', color: ex.color } }] };
    },
  });

  // Volume bars. extendData = { color, opacity }. The bar color follows the candle direction unless a single color is chosen.
  kc.registerIndicator({
    name: 'VL_VOL',
    shortName: 'VOL',
    series: 'volume',
    precision: 0,
    minValue: 0,
    shouldFormatBigNumber: true,
    extendData: { mode: 'direction', color: colors.blue, opacity: 0.35 },
    figures: [{
      key: 'volume',
      title: 'Volume: ',
      type: 'bar',
      baseValue: 0,
      styles: ({ data, indicator }) => {
        const ex = indicator.extendData || {};
        const cur = data.current;
        let c = ex.color;
        if (ex.mode !== 'single') c = cur && cur.close >= cur.open ? (ex.up || colors.green) : (ex.down || colors.red);
        return { color: hexToRgba(c, ex.opacity ?? 0.35) };
      },
    }],
    shouldUpdate: () => ({ calc: false, draw: true }),
    calc: (dataList) => dataList.map((d) => ({ volume: d.volume ?? 0, open: d.open, close: d.close })),
  });

  // Compare line: another ticker rebased to the main chart's first visible close, so on the % axis both start at 0%.
  // extendData = { ticker, color, key (into compareStore: Map(timestamp -> close)), baseIndex }
  kc.registerIndicator({
    name: 'VL_CMP',
    shortName: 'CMP',
    series: 'price',
    precision: 2,
    extendData: { ticker: '', color: colors.text2, key: '', baseIndex: 0 },
    figures: [{ key: 'v', title: '', type: 'line', styles: ({ indicator }) => ({ color: indicator.extendData?.color || colors.text2, size: 1.4 }) }],
    regenerateFigures: () => [{ key: 'v', title: '', type: 'line', styles: ({ indicator }) => ({ color: indicator.extendData?.color || colors.text2, size: 1.4 }) }],
    shouldUpdate: () => ({ calc: true, draw: true }),
    calc: (dataList, indicator) => {
      const ex = indicator.extendData || {};
      const closes = compareStore.get(ex.key);
      if (!(closes instanceof Map) || !dataList.length) return dataList.map(() => ({}));
      const bi = Math.min(Math.max(ex.baseIndex || 0, 0), dataList.length - 1);
      // first bar at or after the base index that the compare ticker also has
      let baseCmp = null, baseMain = null;
      for (let i = bi; i < dataList.length; i++) {
        const c = closes.get(dataList[i].timestamp);
        if (isNum(c)) { baseCmp = c; baseMain = dataList[i].close; break; }
      }
      return dataList.map((d) => {
        const c = closes.get(d.timestamp);
        return isNum(c) && baseCmp ? { v: (c / baseCmp) * baseMain, pct: (c / baseCmp - 1) * 100 } : {};
      });
    },
    createTooltipDataSource: ({ indicator, crosshair }) => {
      const ex = indicator.extendData || {};
      const pct = indicator.result?.[crosshair.dataIndex]?.pct;
      const text = isNum(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '--';
      return { name: '', calcParamsText: '', features: [], legends: [{ title: { text: `${ex.ticker}: `, color: ex.color }, value: { text, color: ex.color } }] };
    },
  });

  // ---- Drawing tools ----
  const lineStyles = (s) => ({ style: s.dash === 'solid' ? 'solid' : 'dashed', dashedValue: s.dash === 'dotted' ? [1.5, 4] : [8, 6], color: s.color, size: s.width });
  const textStyles = (s, extra = {}) => ({ color: s.color, size: 11, family: "'JetBrains Mono', monospace", weight: 500, backgroundColor: 'rgba(8,12,18,0.78)', paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 3, ...extra });

  // Index of the bar nearest to a timestamp
  const nearestIndex = (chart, ts) => {
    const list = chart.getDataList();
    if (!list.length) return null;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].timestamp < ts) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(list[lo - 1].timestamp - ts) <= Math.abs(list[lo].timestamp - ts)) lo -= 1;
    return lo;
  };

  const money = (v) => `$${v.toFixed(2)}`;
  // Text for "what the line shows", between two data points
  const infoText = (chart, s, p0, p1) => {
    const parts = [];
    if (s.show.price && isNum(p0.value) && isNum(p1.value)) parts.push(`${money(p0.value)} → ${money(p1.value)}`);
    if (s.show.pct && isNum(p0.value) && isNum(p1.value) && p0.value !== 0) {
      const pct = ((p1.value - p0.value) / Math.abs(p0.value)) * 100;
      parts.push(`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`);
    }
    if (s.show.bars && isNum(p0.timestamp) && isNum(p1.timestamp)) {
      const a = nearestIndex(chart, p0.timestamp), b = nearestIndex(chart, p1.timestamp);
      if (a !== null && b !== null) parts.push(`${Math.abs(b - a)} bars`);
    }
    if (s.show.days && isNum(p0.timestamp) && isNum(p1.timestamp)) parts.push(`${Math.round(Math.abs(p1.timestamp - p0.timestamp) / DAY)} days`);
    return parts.join('  ·  ');
  };

  // Extend the segment a-b past either end to the pane edges
  const extend = (a, b, width, extendLeft, extendRight) => {
    const L = a.x <= b.x ? a : b;
    const R = a.x <= b.x ? b : a;
    if (Math.abs(R.x - L.x) < 0.5) return [L, R];
    const slope = (R.y - L.y) / (R.x - L.x);
    return [
      extendLeft ? { x: 0, y: L.y - slope * L.x } : L,
      extendRight ? { x: width, y: R.y + slope * (width - R.x) } : R,
    ];
  };
  const style = (overlay) => ({ ...defaultStyle(overlay.name, colors), ...(overlay.extendData || {}), show: { ...defaultStyle(overlay.name, colors).show, ...(overlay.extendData?.show || {}) } });

  const common = (name, totalStep, createPointFigures, extra = {}) => ({
    name, totalStep, needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true, createPointFigures, ...extra,
  });

  // Label drawn above the middle of a line, then the info text at its right end
  const labelFigures = (chart, s, a, b, p0, p1) => {
    const figs = [];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (s.label) figs.push({ key: 'label', type: 'text', ignoreEvent: true, attrs: { x: mid.x, y: mid.y - 6, text: s.label, align: 'center', baseline: 'bottom' }, styles: textStyles(s, { family: "'Inter', sans-serif", size: 12 }) });
    const info = infoText(chart, s, p0, p1);
    if (info) {
      figs.push({ key: 'info', type: 'text', ignoreEvent: true, attrs: { x: mid.x, y: mid.y + 8, text: info, align: 'center', baseline: 'top' }, styles: textStyles(s) });
    }
    return figs;
  };

  // Single-click text label. The text is extendData.label; the line width setting doubles as the font size step.
  kc.registerOverlay(common('vlText', 2, ({ overlay, coordinates }) => {
    if (!coordinates.length) return [];
    const s = style(overlay);
    return [{ key: 'text', type: 'text', attrs: { x: coordinates[0].x, y: coordinates[0].y, text: s.label || 'Text', align: 'left', baseline: 'middle' }, styles: textStyles(s, { family: "'Inter', sans-serif", size: Math.round(10 + s.width * 2), weight: 600, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3 }) }];
  }));

  kc.registerOverlay(common('vlTrend', 3, ({ chart, overlay, coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const s = style(overlay);
    const [a, b] = extend(coordinates[0], coordinates[1], bounding.width, s.extendLeft, s.extendRight);
    return [{ key: 'line', type: 'line', attrs: { coordinates: [a, b] }, styles: lineStyles(s) }, ...labelFigures(chart, s, coordinates[0], coordinates[1], overlay.points[0], overlay.points[1])];
  }));

  kc.registerOverlay(common('vlHLine', 3, ({ chart, overlay, coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const s = style(overlay);
    const y = coordinates[0].y;
    const [a, b] = extend({ x: coordinates[0].x, y }, { x: coordinates[1].x, y }, bounding.width, s.extendLeft, s.extendRight);
    const figs = [{ key: 'line', type: 'line', attrs: { coordinates: [a, b] }, styles: lineStyles(s) }];
    if (s.label) figs.push({ key: 'label', type: 'text', ignoreEvent: true, attrs: { x: Math.max(a.x, 0) + 6, y: y - 4, text: s.label, align: 'left', baseline: 'bottom' }, styles: textStyles(s, { family: "'Inter', sans-serif", size: 12 }) });
    const info = infoText(chart, { ...s, show: { ...s.show, pct: false, bars: false, days: false } }, overlay.points[0], overlay.points[0]);
    if (info) figs.push({ key: 'info', type: 'text', ignoreEvent: true, attrs: { x: Math.min(b.x, bounding.width) - 6, y: y + 5, text: money(overlay.points[0].value), align: 'right', baseline: 'top' }, styles: textStyles(s) });
    return figs;
  }, {
    performEventPressedMove: ({ points, performPoint }) => { points[0].value = performPoint.value; points[1].value = performPoint.value; },
    performEventMoveForDrawing: ({ currentStep, points, performPoint }) => { if (currentStep === 2) points[0].value = performPoint.value; },
  }));

  kc.registerOverlay(common('vlVLine', 3, ({ overlay, coordinates, bounding, chart }) => {
    if (coordinates.length < 2) return [];
    const s = style(overlay);
    const x = coordinates[0].x;
    const ys = [coordinates[0].y, coordinates[1].y];
    const top = Math.min(...ys), bottom = Math.max(...ys);
    const a = { x, y: s.extendLeft ? 0 : top };
    const b = { x, y: s.extendRight ? bounding.height : bottom };
    const figs = [{ key: 'line', type: 'line', attrs: { coordinates: [a, b] }, styles: lineStyles(s) }];
    if (s.label) figs.push({ key: 'label', type: 'text', ignoreEvent: true, attrs: { x: x + 6, y: 8, text: s.label, align: 'left', baseline: 'top' }, styles: textStyles(s, { family: "'Inter', sans-serif", size: 12 }) });
    const d = overlay.points[0]?.timestamp;
    if (s.show.price || s.show.days || s.show.pct || s.show.bars) {
      const t = isNum(d) ? new Date(d).toISOString().slice(0, 10) : '';
      figs.push({ key: 'info', type: 'text', ignoreEvent: true, attrs: { x: x + 6, y: s.label ? 28 : 8, text: t, align: 'left', baseline: 'top' }, styles: textStyles(s) });
    }
    void chart;
    return figs;
  }, {
    performEventPressedMove: ({ points, performPoint }) => { points[0].timestamp = performPoint.timestamp; points[0].dataIndex = performPoint.dataIndex; points[1].timestamp = performPoint.timestamp; points[1].dataIndex = performPoint.dataIndex; },
    performEventMoveForDrawing: ({ currentStep, points, performPoint }) => { if (currentStep === 2) { points[0].timestamp = performPoint.timestamp; points[0].dataIndex = performPoint.dataIndex; } },
  }));

  kc.registerOverlay(common('vlChannel', 4, ({ chart, overlay, coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const s = style(overlay);
    const [a, b] = extend(coordinates[0], coordinates[1], bounding.width, s.extendLeft, s.extendRight);
    const figs = [{ key: 'line', type: 'line', attrs: { coordinates: [a, b] }, styles: lineStyles(s) }];
    if (coordinates.length > 2) {
      // The third point sets the parallel line: same slope, passing through that point
      const dx = coordinates[1].x - coordinates[0].x;
      const dy = coordinates[1].y - coordinates[0].y;
      const off = { x: coordinates[2].x, y: coordinates[2].y };
      const off2 = { x: coordinates[2].x + dx, y: coordinates[2].y + dy };
      const [c, d] = extend(off, off2, bounding.width, s.extendLeft, s.extendRight);
      figs.push({ key: 'line2', type: 'line', attrs: { coordinates: [c, d] }, styles: lineStyles(s) });
      if (!s.extendLeft && !s.extendRight) {
        figs.push({ key: 'fill', type: 'polygon', ignoreEvent: true, attrs: { coordinates: [a, b, d, c] }, styles: { style: 'fill', color: hexToRgba(s.color, 0.08) } });
      }
    }
    return [...figs, ...labelFigures(chart, s, coordinates[0], coordinates[1], overlay.points[0], overlay.points[1])];
  }));

  const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  kc.registerOverlay(common('vlFib', 3, ({ chart, overlay, coordinates, bounding }) => {
    if (coordinates.length < 2) return [];
    const s = style(overlay);
    const [p0, p1] = overlay.points;
    const x0 = Math.min(coordinates[0].x, coordinates[1].x), x1 = Math.max(coordinates[0].x, coordinates[1].x);
    const left = s.extendLeft ? 0 : x0, right = s.extendRight ? bounding.width : x1;
    const lines = [], texts = [];
    const dy = coordinates[1].y - coordinates[0].y;
    FIB.forEach((lvl) => {
      const y = coordinates[0].y + dy * lvl;
      lines.push({ coordinates: [{ x: left, y }, { x: right, y }] });
      const price = isNum(p0.value) && isNum(p1.value) ? p0.value + (p1.value - p0.value) * lvl : null;
      texts.push({ x: left + 4, y: y - 3, text: `${(lvl * 100).toFixed(1)}%${price !== null ? `  ${money(price)}` : ''}`, align: 'left', baseline: 'bottom' });
    });
    const figs = [
      { key: 'trend', type: 'line', ignoreEvent: true, attrs: { coordinates: [coordinates[0], coordinates[1]] }, styles: { ...lineStyles(s), style: 'dashed', dashedValue: [4, 4], size: 1 } },
      { key: 'levels', type: 'line', attrs: lines, styles: lineStyles(s) },
      { key: 'texts', type: 'text', ignoreEvent: true, attrs: texts, styles: textStyles(s, { backgroundColor: 'rgba(0,0,0,0)', size: 10 }) },
    ];
    if (s.label) figs.push({ key: 'label', type: 'text', ignoreEvent: true, attrs: { x: (left + right) / 2, y: Math.min(coordinates[0].y, coordinates[1].y) - 8, text: s.label, align: 'center', baseline: 'bottom' }, styles: textStyles(s, { family: "'Inter', sans-serif", size: 12 }) });
    const info = infoText(chart, s, p0, p1);
    if (info) figs.push({ key: 'info', type: 'text', ignoreEvent: true, attrs: { x: right - 4, y: Math.max(coordinates[0].y, coordinates[1].y) + 8, text: info, align: 'right', baseline: 'top' }, styles: textStyles(s) });
    return figs;
  }));
}
