import { panelA, panelB } from './reverse-math.js';

// Values handed over by the Filings tab ("Send to Reverse DCF"). Read once, then cleared.
export const REVERSE_PREFILL_KEY = 'reversePrefill';

const NA = 'N/A';
const UNITS = {
  dollars: { mult: 1, suffix: '', label: 'dollars' },
  thousands: { mult: 1e3, suffix: 'K', label: 'thousands' },
  millions: { mult: 1e6, suffix: 'M', label: 'millions' },
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- DOM helpers (all text goes through textContent) ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function parseNum(str) {
  const s = String(str ?? '').replace(/,/g, '').trim();
  if (s === '') return NaN;
  return Number(s);
}

const fmtPct = (v, d = 1) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : NA);
const fmtPrice = (v) => (isNum(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}` : NA);

// ---------- Field definitions ----------

// pct: typed as a percent, used as a decimal. unit: label gets the units suffix.
const SHARED = [
  { key: 'ticker', label: 'Ticker', text: true },
  { key: 'companyName', label: 'Company name', text: true },
  { key: 'price', label: 'Current price ($)' },
  { key: 'priceDate', label: 'Price date', date: true, required: true },
  { key: 'units', label: 'Units', select: true },
  { key: 'shares', label: 'Diluted shares', unit: true },
  { key: 'cash', label: 'Cash and equivalents', unit: true },
  { key: 'debt', label: 'Total debt', unit: true },
  { key: 'other', label: 'Other debt-like obligations', unit: true, tip: 'For example deferred purchase consideration. Leave blank if none.' },
  { key: 'discountRate', label: 'Discount rate (%)', def: '10', pct: true },
  { key: 'terminalGrowth', label: 'Terminal growth (%)', def: '3', pct: true },
  { key: 'marginOfSafety', label: 'Margin of safety (%)', def: '20', pct: true },
  { key: 'taxRate', label: 'Tax rate (%)', def: '21', pct: true },
];

// ---------- Page ----------

export function renderReverse(container, options = {}) {
  container.replaceChildren();

  const fields = {};   // key -> { input, label, def }
  const sources = {};  // key -> source text shown under a prefilled field
  const srcNodes = {};
  const ctx = { marginHistory: [], fcfCagr: null, gTouched: false };

  function addField(def, extra = {}) {
    const id = `rv-${def.key}`;
    const label = el('label', { attrs: { for: id }, text: def.label });
    let input;
    if (def.select) {
      input = el('select', { attrs: { id } }, Object.entries(UNITS).map(([k, u]) => el('option', { text: u.label, attrs: { value: k } })));
      input.value = 'dollars';
    } else {
      input = el('input', {
        class: def.text ? '' : 'mono-input',
        attrs: {
          id,
          type: def.date ? 'date' : 'text',
          autocomplete: 'off',
          ...(def.text || def.date ? {} : { inputmode: 'decimal' }),
          ...(def.tip ? { title: def.tip } : {}),
        },
      });
      if (def.def !== undefined) input.value = def.def;
    }
    if (def.tip) label.setAttribute('title', def.tip);
    if (def.required) label.append(' ', el('span', { class: 'req', text: '(required)' }));
    const src = el('span', { class: 'src' });
    src.hidden = true;
    srcNodes[def.key] = src;
    fields[def.key] = { input, label, def };
    // Typing over a prefilled value removes its "from the filing" label: it no longer is
    input.addEventListener('input', () => { if (sources[def.key]) { delete sources[def.key]; src.hidden = true; } });
    return el('div', { class: `field${extra.wide ? ' wide' : ''}` }, [label, input, src]);
  }

  // ---- Shared inputs card ----
  const sharedGrid = el('div', { class: 'rev-grid' }, SHARED.map((d) => addField(d)));
  const derivedBox = el('div', { class: 'rev-derived' });
  const prefillNote = el('div', { class: 'rev-note warn' });
  prefillNote.hidden = true;
  const unitsNote = el('div', { class: 'rev-note', text: 'Units label how you typed the dollar amounts and share counts; changing the selector does not rescale what is in the boxes. Per-share values are always in dollars.' });
  const sharedCard = el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: 'Shared Inputs' }),
    prefillNote, sharedGrid, unitsNote, derivedBox,
  ]);

  // ---- Panel A ----
  const aInputs = el('div', { class: 'rev-grid' }, [
    addField({ key: 'fcf', label: 'Starting FCF / share ($)' }),
    addField({ key: 'fcfNorm', label: 'Normalized FCF / share ($, optional)', tip: 'An optional second starting point, for example FCF with one-time working-capital swings removed.' }),
  ]);
  const aResults = el('div');
  const panelACard = el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: 'A. What growth is the price implying?' }),
    aInputs, aResults,
  ]);

  // ---- Panel B ----
  const bInputs = el('div', { class: 'rev-grid' }, [
    addField({ key: 'growthB', label: 'Growth for this method (%)', def: '3', pct: true }),
    addField({ key: 'revenue', label: 'Revenue', unit: true }),
    addField({ key: 'operatingIncome', label: 'Operating income', unit: true }),
    addField({ key: 'depreciation', label: 'Depreciation', unit: true }),
    addField({ key: 'capex', label: 'Capex', unit: true }),
  ]);
  const bResults = el('div');
  const panelBCard = el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: 'B. What operating margin does the price require?' }),
    bInputs, bResults,
  ]);

  // ---- Save card ----
  const notesInput = el('input', { attrs: { id: 'rv-notes', type: 'text', maxlength: '2000', autocomplete: 'off', placeholder: 'Optional' } });
  const saveBtn = el('button', { class: 'btn btn-primary btn-inline', text: 'Save Reverse DCF', attrs: { type: 'button' } });
  const saveStatus = el('div', { class: 'rev-note' });
  const saveCard = el('div', { class: 'card' }, [
    el('div', { class: 'section-label', text: 'Save' }),
    el('div', { class: 'rev-save' }, [
      el('div', { class: 'field' }, [el('label', { attrs: { for: 'rv-notes' }, text: 'Notes' }), notesInput]),
      saveBtn,
    ]),
    saveStatus,
  ]);

  container.append(sharedCard, el('div', { class: 'rev-panels' }, [panelACard, panelBCard, saveCard]));

  // ---------- Reading inputs ----------

  const unitKey = () => fields.units.input.value;
  const unit = () => UNITS[unitKey()] || UNITS.dollars;
  const raw = (key) => fields[key].input.value;
  const num = (key) => parseNum(raw(key));
  const pct = (key) => { const v = num(key); return Number.isFinite(v) ? v / 100 : NaN; };

  function refreshUnitLabels() {
    const u = unit();
    for (const { label, def } of Object.values(fields)) {
      if (!def.unit) continue;
      const base = def.label;
      label.firstChild.textContent = `${base} (${u.label})`;
    }
  }

  function setPrefillNote(show) {
    prefillNote.hidden = !show;
    if (show) prefillNote.textContent = 'Annual figures can be out of date. Overwrite cash, debt, shares, and any trailing figures from the latest 10-Q.';
  }

  // ---------- Formatting amounts in the chosen units ----------

  function amt(v) {
    if (!isNum(v)) return NA;
    const s = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
    return `${v < 0 ? '-' : ''}$${s}${unit().suffix}`;
  }
  const shr = (v) => (isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : NA);

  // ---------- Compute + render ----------

  let last = null; // what Save stores

  function computeNetCash() {
    const shares = num('shares');
    const cash = num('cash');
    const debt = num('debt');
    const otherRaw = num('other');
    const other = Number.isNaN(otherRaw) && raw('other').trim() === '' ? 0 : otherRaw;
    if (![shares, cash, debt, other].every(Number.isFinite) || shares <= 0) return null;
    return { value: (cash - debt - other) / shares, shares, cash, debt, other };
  }

  function recalc() {
    refreshUnitLabels();
    const price = num('price');
    const r = pct('discountRate');
    const tg = pct('terminalGrowth');
    const mos = pct('marginOfSafety');
    const tax = pct('taxRate');
    const nc = computeNetCash();

    // Derived read-out
    derivedBox.replaceChildren();
    const d = (label, value, cls) => derivedBox.append(el('div', {}, [el('div', { class: 'stat-label', text: label }), el('div', { class: `mono ${cls || ''}`, text: value })]));
    d('Net cash / share', nc ? fmtPrice(nc.value) : NA);
    const otherV = Number.isNaN(num('other')) && raw('other').trim() === '' ? 0 : num('other');
    const haveEvInputs = [price, num('shares'), num('debt'), otherV, num('cash')].every(Number.isFinite);
    d('Market cap', haveEvInputs ? amt(price * num('shares')) : NA);
    d('Enterprise value', haveEvInputs ? amt(price * num('shares') + num('debt') + otherV - num('cash')) : NA);

    const results = { };
    renderPanelA({ price, r, tg, mos, nc, results });
    renderPanelB({ price, r, tg, mos, tax, results });
    last = { price, results };
  }

  function note(text, cls = '') { return el('div', { class: `rev-note ${cls}`.trim(), text }); }

  function renderPanelA({ price, r, tg, mos, nc, results }) {
    aResults.replaceChildren();
    if (!isNum(price) || price <= 0) { aResults.append(note('Enter the current price to see what growth it implies.')); return; }
    if (!isNum(r) || !isNum(tg) || !isNum(mos)) { aResults.append(note('Fill in discount rate, terminal growth and margin of safety.')); return; }
    if (r <= tg) { aResults.append(note('Discount rate must be greater than terminal growth.', 'warn')); return; }
    const netCash = nc ? nc.value : 0;
    results.netCashPerShare = nc ? nc.value : null;
    if (!nc) aResults.append(note('Net cash is not included yet: fill in shares, cash and debt (other obligations may stay blank).', 'warn'));

    const cols = [
      { key: 'fcf', title: 'Starting FCF / share', rkey: 'impliedGrowth', mkey: 'impliedGrowthMos' },
      { key: 'fcfNorm', title: 'Normalized FCF / share', rkey: 'impliedGrowthNormalized', mkey: 'impliedGrowthMosNormalized', optional: true },
    ];
    const colNodes = cols.map((c) => {
      const f = num(c.key);
      if (!Number.isFinite(f)) {
        return el('div', {}, [
          el('div', { class: 'rev-sub', text: c.title }),
          note(c.optional ? 'Optional. Enter a normalized FCF / share to compare.' : 'Enter the starting FCF / share.'),
        ]);
      }
      const a = panelA({ fcf: f, price, netCash, r, tg, mos });
      if (a.atPrice.ok) results[c.rkey] = a.atPrice.g;
      if (a.forMos.ok) results[c.mkey] = a.forMos.g;
      const body = [el('div', { class: 'rev-sub', text: `${c.title}: ${fmtPrice(f)}` })];

      if (a.atPrice.ok) {
        body.push(el('p', { class: 'rev-line' }, [
          `At ${fmtPrice(price)}, the price assumes about `,
          el('span', { class: 'mono', text: fmtPct(a.atPrice.g) }),
          ' a year for 10 years.',
        ]));
      } else {
        body.push(el('p', { class: 'rev-line rev-bad', text: a.atPrice.reason }));
      }

      const stat = (label, value, sub) => el('div', { class: 'stat-block' }, [
        el('div', { class: 'stat-label', text: label }),
        el('div', { class: 'stat-value secondary mono', text: value }),
        sub ? el('div', { class: 'rev-note', text: sub }) : null,
      ]);
      body.push(stat('Implied growth at the current price', a.atPrice.ok ? fmtPct(a.atPrice.g) : NA));
      body.push(stat(
        `Implied growth for a ${(mos * 100).toFixed(0)}% margin of safety`,
        a.forMos.ok ? fmtPct(a.forMos.g) : NA,
        isNum(a.mosTarget) ? `Intrinsic value = price ÷ (1 − ${(mos * 100).toFixed(0)}%) = ${fmtPrice(a.mosTarget)}${a.forMos.ok ? '' : `. ${a.forMos.reason}`}` : null,
      ));
      if (isNum(ctx.fcfCagr)) {
        body.push(stat('Company 10-year FCF CAGR (Filings)', fmtPct(ctx.fcfCagr), 'Historical growth, shown only for comparison with the implied figure.'));
      }

      const t1 = el('table', { class: 'breakdown' }, [
        el('thead', {}, el('tr', {}, [el('th', { text: 'Growth' }), el('th', { text: 'Value / share' })])),
        el('tbody', {}, a.values.map((v) => el('tr', {}, [el('td', { text: fmtPct(v.g, 0) }), el('td', { text: fmtPrice(v.value) })]))),
      ]);
      body.push(el('div', { class: 'rev-sub', text: 'Intrinsic value at a given growth (includes net cash)' }), el('div', { class: 'table-scroll' }, t1));
      const t2 = el('table', { class: 'breakdown' }, [
        el('thead', {}, el('tr', {}, [el('th', { text: 'Discount rate' }), el('th', { text: 'Implied growth' })])),
        el('tbody', {}, a.byDiscount.map((v) => el('tr', {}, [
          el('td', { text: fmtPct(v.r, 0) }),
          el('td', { text: v.solved.ok ? fmtPct(v.solved.g) : NA, attrs: v.solved.ok ? {} : { title: v.solved.reason } }),
        ]))),
      ]);
      body.push(el('div', { class: 'rev-sub', text: 'Implied growth at other discount rates' }), el('div', { class: 'table-scroll' }, t2));
      return el('div', {}, body);
    });
    aResults.append(el('div', { class: 'rev-cols' }, colNodes));
  }

  function renderPanelB({ price, r, tg, mos, tax, results }) {
    bResults.replaceChildren();
    const g = pct('growthB');
    const otherRaw = num('other');
    const other = Number.isNaN(otherRaw) && raw('other').trim() === '' ? 0 : otherRaw;
    const shares = num('shares');
    const debt = num('debt');
    const cash = num('cash');
    const revenue = num('revenue');
    const opInc = num('operatingIncome');
    const b = panelB({
      price, shares, debt, other, cash, g, r, tax, mos,
      revenue: Number.isFinite(revenue) ? revenue : null,
      operatingIncome: Number.isFinite(opInc) ? opInc : null,
      capex: Number.isFinite(num('capex')) ? num('capex') : null,
      depreciation: Number.isFinite(num('depreciation')) ? num('depreciation') : null,
    });
    if (!b.ok) { bResults.append(note(b.message, b.reason === 'missing' ? '' : 'warn')); return; }

    results.marketCap = b.marketCap;
    results.ev = b.ev;

    const step = (title, formula, math) => el('li', {}, [
      el('strong', { text: `${title}: ` }),
      formula,
      ' = ',
      el('span', { class: 'mono', text: math }),
    ]);
    const steps = [];
    steps.push(step('Market cap', 'price × shares', `${fmtPrice(price)} × ${shr(shares)} = ${amt(b.marketCap)}`));
    steps.push(step('Enterprise value', 'market cap + debt + other − cash', `${amt(b.marketCap)} + ${amt(debt)} + ${amt(other)} − ${amt(cash)} = ${amt(b.ev)}`));
    if (!b.evPositive) {
      bResults.append(el('ol', { class: 'rev-steps' }, steps));
      bResults.append(el('p', { class: 'rev-line rev-bad', text: 'Enterprise value is not positive; this method isn’t meaningful here.' }));
      return;
    }
    steps.push(step('Multiple', '(1 + g) ÷ (r − g)', `(1 + ${fmtPct(g)}) ÷ (${fmtPct(r)} − ${fmtPct(g)}) = ${b.multiple.toFixed(2)}×`));
    steps.push(step('Required FCF', 'EV ÷ multiple', `${amt(b.ev)} ÷ ${b.multiple.toFixed(2)} = ${amt(b.requiredFcf)}`));
    steps.push(step('Required operating income', 'required FCF ÷ (1 − tax rate)', `${amt(b.requiredFcf)} ÷ (1 − ${fmtPct(tax)}) = ${amt(b.requiredOperatingIncome)}`));

    const haveRev = b.requiredMargin !== null;
    if (haveRev) {
      results.requiredMargin = b.requiredMargin;
      steps.push(step('Required operating margin', 'required operating income ÷ revenue', `${amt(b.requiredOperatingIncome)} ÷ ${amt(revenue)} = ${fmtPct(b.requiredMargin)}`));
      if (b.requiredMarginMos !== null) {
        results.requiredMarginMos = b.requiredMarginMos;
        steps.push(step('With margin of safety', 'required margin ÷ (1 − margin of safety)', `${fmtPct(b.requiredMargin)} ÷ (1 − ${fmtPct(mos)}) = ${fmtPct(b.requiredMarginMos)}`));
      }
    } else {
      steps.push(el('li', {}, [el('strong', { text: 'Required operating margin: ' }), 'required operating income ÷ revenue = ', el('span', { class: 'mono', text: `${NA} (revenue is missing or not positive)` })]));
    }
    if (b.actualMargin !== null) {
      results.actualMargin = b.actualMargin;
      steps.push(step('Actual operating margin', 'operating income ÷ revenue', `${amt(opInc)} ÷ ${amt(revenue)} = ${fmtPct(b.actualMargin)}`));
    } else {
      steps.push(el('li', {}, [el('strong', { text: 'Actual operating margin: ' }), 'operating income ÷ revenue = ', el('span', { class: 'mono', text: `${NA} (operating income or revenue is missing)` })]));
    }
    if (ctx.marginHistory.length) {
      const hist = ctx.marginHistory.map((h) => `FY${h.year} ${isNum(h.margin) ? fmtPct(h.margin) : NA}`).join('  ·  ');
      steps.push(el('li', {}, [el('strong', { text: 'Last 5 fiscal years (Filings): ' }), el('span', { class: 'mono', text: hist })]));
    }
    bResults.append(el('ol', { class: 'rev-steps' }, steps));

    // Comparison, in words, no recommendation
    let cmp = null;
    if (b.comparison === 'cushion') cmp = ['rev-ok', `Actual margin ${fmtPct(b.actualMargin)} is above the required ${fmtPct(b.requiredMargin)} with a cushion (above ${fmtPct(b.requiredMarginMos)}, the required margin with margin of safety).`];
    else if (b.comparison === 'between') cmp = ['rev-mid', `Actual margin ${fmtPct(b.actualMargin)} is between the required ${fmtPct(b.requiredMargin)} and the required-with-margin-of-safety ${b.requiredMarginMos !== null ? fmtPct(b.requiredMarginMos) : NA}.`];
    else if (b.comparison === 'below') cmp = ['rev-bad', `Actual margin ${fmtPct(b.actualMargin)} is below the required ${fmtPct(b.requiredMargin)}.`];
    bResults.append(cmp ? el('p', { class: `rev-line ${cmp[0]}`, text: cmp[1] }) : el('p', { class: 'rev-line', text: `Comparison: ${NA}. Operating income or revenue is missing.` }));

    if (b.capexWarning) {
      bResults.append(note(`Caveat: capex ÷ depreciation is ${b.capexRatio.toFixed(2)}, outside 0.5 to 2.0. This method assumes capex is roughly equal to depreciation, so treat the result with caution.`, 'warn'));
    } else if (b.capexRatio === null) {
      bResults.append(note('Capex ÷ depreciation is not available, so the capex ≈ depreciation assumption was not checked.'));
    }
    bResults.append(note('The 3% default growth is conservative for fast growers; raise it to see how much the answer moves.'));
  }

  // ---------- Events ----------

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(recalc, 150); };

  for (const [key, f] of Object.entries(fields)) {
    f.input.addEventListener('input', () => {
      if (key === 'growthB') ctx.gTouched = true;
      if (key === 'terminalGrowth' && !ctx.gTouched) fields.growthB.input.value = raw('terminalGrowth');
      schedule();
    });
  }
  fields.units.input.addEventListener('change', recalc);

  fields.ticker.input.addEventListener('blur', async () => {
    const t = raw('ticker').trim().toUpperCase();
    if (!t || fields.companyName.input.value.trim() !== '') return;
    try {
      const res = await fetch(`/api/ticker?symbol=${encodeURIComponent(t)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.companyName && fields.companyName.input.value.trim() === '') fields.companyName.input.value = data.companyName;
    } catch (err) {
      console.error(err);
    }
  });

  saveBtn.addEventListener('click', async () => {
    saveStatus.className = 'rev-note';
    const ticker = raw('ticker').trim().toUpperCase();
    const price = num('price');
    const priceDate = raw('priceDate');
    if (!ticker || !isNum(price) || price <= 0 || !priceDate) {
      saveStatus.className = 'rev-note warn';
      saveStatus.textContent = 'Ticker, current price and price date are required to save.';
      return;
    }
    recalc();
    const inputs = {
      units: unitKey(),
      fields: Object.fromEntries(Object.keys(fields).filter((k) => !['ticker', 'companyName', 'price', 'priceDate'].includes(k)).map((k) => [k, raw(k)])),
      sources: { ...sources },
      marginHistory: ctx.marginHistory,
      fcfCagr: ctx.fcfCagr,
      gTouched: ctx.gTouched,
    };
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const res = await fetch('/api/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker, companyName: raw('companyName').trim() || null, price, priceDate,
          inputs, results: last.results, notes: notesInput.value.trim() || null,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      saveBtn.textContent = 'Saved ✓';
      saveStatus.textContent = 'Saved. Find it under Saved Valuations › Reverse.';
      setTimeout(() => { saveBtn.textContent = 'Save Reverse DCF'; saveBtn.disabled = false; }, 1500);
    } catch (err) {
      console.error(err);
      saveBtn.textContent = 'Save Reverse DCF';
      saveBtn.disabled = false;
      saveStatus.className = 'rev-note warn';
      saveStatus.textContent = 'Could not save. Try again.';
    }
  });

  // ---------- Prefill: from a saved row, or from the Filings tab ----------

  function setField(key, value) {
    if (value === undefined || value === null) return;
    fields[key].input.value = String(value);
  }
  function showSource(key, text) {
    if (!text || !srcNodes[key]) return;
    sources[key] = text;
    srcNodes[key].textContent = text;
    srcNodes[key].hidden = false;
  }

  function applyLoaded(l) {
    const inp = l.inputs || {};
    if (typeof l.ticker === 'string') setField('ticker', l.ticker);
    if (typeof l.companyName === 'string') setField('companyName', l.companyName);
    if (l.price !== null && l.price !== undefined) setField('price', Number(l.price));
    if (typeof l.priceDate === 'string') setField('priceDate', l.priceDate.slice(0, 10));
    if (typeof l.notes === 'string') notesInput.value = l.notes;
    if (UNITS[inp.units]) fields.units.input.value = inp.units;
    for (const [k, v] of Object.entries(inp.fields || {})) if (fields[k] && typeof v === 'string') fields[k].input.value = v;
    for (const [k, v] of Object.entries(inp.sources || {})) if (fields[k] && typeof v === 'string') showSource(k, v);
    if (Array.isArray(inp.marginHistory)) ctx.marginHistory = inp.marginHistory.filter((h) => h && Number.isFinite(h.year)).slice(-5);
    if (isNum(inp.fcfCagr)) ctx.fcfCagr = inp.fcfCagr;
    ctx.gTouched = inp.gTouched === true;
    if (Object.keys(sources).length) setPrefillNote(true);
  }

  function applyFilings(p) {
    // Pick units from the size of the figures so the boxes hold readable numbers
    const biggest = Math.max(0, ...['revenue', 'operatingIncome', 'cash', 'longTermDebt'].map((k) => (isNum(p[k]) ? Math.abs(p[k]) : 0)));
    const key = biggest >= 1e9 ? 'millions' : biggest >= 1e6 ? 'thousands' : 'dollars';
    fields.units.input.value = key;
    const mult = UNITS[key].mult;
    const scaled = (v) => (isNum(v) ? Number((v / mult).toFixed(2)) : null);
    const src = p.source;
    const put = (field, value, source) => { if (value !== null && value !== undefined) { setField(field, value); showSource(field, source); } };
    if (typeof p.ticker === 'string') setField('ticker', p.ticker);
    if (typeof p.companyName === 'string') setField('companyName', p.companyName);
    put('revenue', scaled(p.revenue), src);
    put('operatingIncome', scaled(p.operatingIncome), src);
    put('depreciation', scaled(p.depreciation), src);
    put('capex', scaled(p.capex !== null && isNum(p.capex) ? Math.abs(p.capex) : null), src);
    put('fcf', isNum(p.fcfPerShare) ? Number(p.fcfPerShare.toFixed(2)) : null, src);
    put('shares', scaled(p.dilutedShares), src);
    put('cash', scaled(p.cash), src);
    put('debt', scaled(p.longTermDebt), src ? `${src} (long-term debt only)` : null);
    if (Array.isArray(p.marginHistory)) ctx.marginHistory = p.marginHistory.filter((h) => h && Number.isFinite(h.year)).slice(-5);
    if (isNum(p.fcfCagr)) ctx.fcfCagr = p.fcfCagr;
    setPrefillNote(true);
  }

  if (options.loaded) {
    applyLoaded(options.loaded);
  } else {
    try {
      const rawPrefill = sessionStorage.getItem(REVERSE_PREFILL_KEY);
      if (rawPrefill !== null) {
        sessionStorage.removeItem(REVERSE_PREFILL_KEY);
        const p = JSON.parse(rawPrefill);
        if (p && typeof p === 'object') applyFilings(p);
      }
    } catch (err) {
      console.error(err);
    }
  }
  if (!ctx.gTouched && !options.loaded) fields.growthB.input.value = raw('terminalGrowth');
  recalc();
}
