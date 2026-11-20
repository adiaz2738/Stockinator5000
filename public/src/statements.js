// Statements tab: the latest annual filing's balance sheet, income statement and cash flow statement as filed.
// Everything from the API is rendered with textContent; fetched HTML never reaches the page.

const SEC_ORIGIN = 'https://www.sec.gov/';
const ORDER = ['balance', 'income', 'cashflow'];
const METHOD_LABEL = { 'r-pages': 'XBRL R page', document: 'Located in the filing document' };
const TAB_LABEL = { balance: 'Balance Sheet', income: 'Income Statement', cashflow: 'Cash Flow' };
let activeStatement = 'balance'; // remembered across companies and tab switches

// Survives tab switches.
const cache = new Map(); // cik -> { filing, statements }
let mounted = null; // { cik } of what is on screen
const inflight = new Set();

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

// Link to SEC only; anything else is shown as plain text, never as a link.
export function secLink(url, text, className = 'link-btn-inline') {
  if (typeof url !== 'string' || !url.startsWith(SEC_ORIGIN)) return el('span', { text });
  return el('a', {
    class: className,
    text,
    attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' },
  });
}

export function fmtFilingDate(value) {
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(value || '') : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------- Column order and year-over-year change ----------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const SPAN_WORDS = { one: 1, three: 3, six: 6, nine: 9, twelve: 12 };
const LS_YOY = 'vl.statements.yoy';
let showYoy = (() => { try { return localStorage.getItem(LS_YOY) === '1'; } catch (err) { return false; } })();

// { span: months (12 for a year, 0 for a balance-sheet date), t: end date as a sortable number, day: day of year } or null
function periodInfo(p) {
  const text = String(p || '');
  const d = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d\d)/.exec(text);
  const yOnly = /\b((?:19|20)\d\d)\b/.exec(text);
  if (!d && !yOnly) return null;
  const sp = /(\d+|one|three|six|nine|twelve)[- ]months?/i.exec(text);
  let span = sp ? (SPAN_WORDS[sp[1].toLowerCase()] ?? Number(sp[1])) : /years? ended|fiscal year|12 months/i.test(text) ? 12 : /^as of|^at\b|balance/i.test(text) ? 0 : null;
  if (d && MONTHS[d[1].toLowerCase()] !== undefined) {
    const mo = MONTHS[d[1].toLowerCase()];
    const y = Number(d[3]);
    return { span, year: y, day: mo * 30.5 + Number(d[2]), t: y * 400 + mo * 30.5 + Number(d[2]) };
  }
  const y = Number(yOnly[1]);
  return { span: span ?? 12, year: y, day: null, t: y * 400 + 366 };
}

// Period info for every column. SEC's R pages print "12 Months Ended" once over several date columns, so a column
// with no length of its own takes the one to its left.
function infosOf(s, cols) {
  const info = Array.from({ length: cols }, (_, i) => periodInfo(s.periods[i]));
  for (let i = 1; i < cols; i++) if (info[i] && info[i].span === null && info[i - 1]) info[i].span = info[i - 1].span;
  return info;
}

// Display order: newest first. Columns of the same length stay together (Sep 2026, Sep 2025 | FY2025, FY2024, FY2023),
// the group holding the latest period first. Unreadable headers keep the filing's own order.
function columnOrder(s, cols) {
  const info = infosOf(s, cols);
  if (info.some((x) => !x)) return Array.from({ length: cols }, (_, i) => i);
  const groupKey = (x) => String(x.span);
  const latest = {};
  info.forEach((x) => { const k = groupKey(x); latest[k] = Math.max(latest[k] ?? -Infinity, x.t); });
  return info.map((x, i) => i).sort((a, b) => (latest[groupKey(info[b])] - latest[groupKey(info[a])]) || (info[b].t - info[a].t) || (a - b));
}

// The column one year before column i: same length, same date of the year (within 3 weeks), previous year
function priorColumn(s, cols, i) {
  const info = infosOf(s, cols);
  const x = info[i];
  if (!x) return -1;
  for (let j = 0; j < cols; j++) {
    const y = info[j];
    if (!y || j === i || y.year !== x.year - 1 || y.span !== x.span) continue;
    if (x.day !== null && y.day !== null) { const gap = Math.abs(x.day - y.day); if (Math.min(gap, 366 - gap) > 21) continue; }
    return j;
  }
  return -1;
}

function amountOf(text) {
  const t = String(text || '').replace(/[$\s]/g, '');
  if (/^[—–-]$/.test(t)) return 0;
  const m = /^(\()?(-)?([\d,]+(?:\.\d+)?)\)?%?$/.exec(t);
  if (!m) return null;
  const n = parseFloat(m[3].replace(/,/g, ''));
  return m[1] || m[2] ? -n : n;
}

function yoyText(cur, prev) {
  if (cur === null || prev === null) return null;
  if (prev === 0) return cur === 0 ? '0%' : 'n/m';
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const abs = Math.abs(pct);
  return `${pct > 0 ? '▲' : pct < 0 ? '▼' : ''}${abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(1)}%`;
}

function statementCard(s) {
  const head = el('div', { class: 'stmt-head' }, [
    el('div', { class: 'section-label', text: s.name }),
    s.sourceUrl ? secLink(s.sourceUrl, `${s.method === 'r-pages' ? 'XBRL page ' : ''}${s.sourceFile} ↗`) : null,
  ]);

  const unitText = s.units ? `As filed. ${s.title}. Units: ${s.units}` : `As filed. ${s.title}. Units and scale were not stated on the page; check the filing`;
  const layoutNote = s.replacedSegmentView ? ' Taken from the 10-K document so the layout matches the filing (SEC\u2019s XBRL page splits this statement by segment).' : '';
  const note = el('div', { class: 'head-note stmt-note', text: `${unitText}. Source: ${METHOD_LABEL[s.method] || s.method}.${layoutNote}` });

  const cols = Math.max(s.columns || 0, 0);
  const order = columnOrder(s, cols);
  const prior = order.map((i) => priorColumn(s, cols, i));
  const yoyBtn = el('button', { class: `stmt-yoy-btn${showYoy ? ' active' : ''}`, text: showYoy ? 'YoY % on' : 'YoY %', attrs: { type: 'button', title: 'Show the change from the same period a year earlier under each amount', 'aria-pressed': String(showYoy) } });
  head.append(yoyBtn);
  const thead = el('thead', {}, el('tr', {}, [
    el('th', { text: s.title }),
    ...order.map((i) => el('th', { text: s.periods[i] || '' })),
  ]));
  const tbody = el('tbody');
  for (const row of s.rows) {
    const level = Math.max(0, Math.min(Number(row.level) || 0, 4));
    const cls = ['stmt-row', `lvl-${level}`, row.header ? 'stmt-section' : '', row.total ? 'stmt-total' : ''].filter(Boolean).join(' ');
    const cells = [el('td', { text: String(row.label) })];
    order.forEach((i, k) => {
      const v = row.values[i];
      const td = el('td', { text: typeof v === 'string' ? v : '' });
      if (showYoy && prior[k] >= 0 && !row.header) {
        const ch = yoyText(amountOf(v), amountOf(row.values[prior[k]]));
        if (ch) td.append(el('div', { class: `stmt-yoy${ch.startsWith('▲') ? ' up' : ch.startsWith('▼') ? ' down' : ''}`, text: ch, attrs: { title: `vs. ${s.periods[prior[k]]}: ${row.values[prior[k]]}` } }));
      }
      cells.push(td);
    });
    tbody.append(el('tr', { class: cls }, cells));
  }
  const card = el('div', { class: 'card' }, [
    head,
    note,
    el('div', { class: 'table-scroll' }, el('table', { class: 'fin-table stmt-table' }, [thead, tbody])),
  ]);
  yoyBtn.addEventListener('click', () => {
    showYoy = !showYoy;
    try { localStorage.setItem(LS_YOY, showYoy ? '1' : '0'); } catch (err) { /* ignore */ }
    card.replaceWith(statementCard(s));
  });
  return card;
}

function render(pane, { filing, statements }) {
  const found = ORDER.filter((k) => statements[k]);
  const filingLine = el('div', { class: 'card stmt-filing' }, [
    el('div', {}, [
      el('div', { class: 'section-label', text: 'Source filing' }),
      el('div', { class: 'stmt-filing-line' }, [
        el('span', { class: 'mono', text: `${filing.form} filed ${fmtFilingDate(filing.filingDate)}` }),
        secLink(filing.viewerUrl, 'Open filing in SEC viewer ↗'),
        secLink(filing.indexUrl, 'Filing index ↗'),
      ]),
    ]),
  ]);

  if (!found.length) {
    pane.replaceChildren(
      filingLine,
      el('div', { class: 'card empty-state' }, [
        el('div', { text: 'As-filed statements not available for this filing' }),
        el('div', { class: 'stmt-empty-link' }, secLink(filing.viewerUrl, 'View the filing on SEC.gov ↗')),
      ]),
    );
    return;
  }

  // One statement at a time, chosen with tabs (like most finance sites)
  if (!statements[activeStatement]) activeStatement = found[0];
  const holder = el('div');
  const tabs = el('div', { class: 'stmt-tabs', attrs: { role: 'tablist' } });
  const show = (key) => {
    activeStatement = key;
    for (const b of tabs.children) {
      const on = b.dataset.key === key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    holder.replaceChildren(statementCard(statements[key]));
    for (const box of holder.querySelectorAll('.table-scroll')) box.scrollLeft = 0;
  };
  for (const k of ORDER) {
    const b = el('button', { class: 'stmt-tab', text: TAB_LABEL[k], attrs: { type: 'button', role: 'tab', 'data-key': k } });
    if (!statements[k]) {
      b.disabled = true;
      b.title = `${TAB_LABEL[k]} not found in this filing`;
    } else b.addEventListener('click', () => show(k));
    tabs.append(b);
  }
  pane.replaceChildren(filingLine, tabs, holder);
  show(activeStatement);
}

export async function renderStatementsPane(pane, { ensureData, getCurrentCik }) {
  const cik = getCurrentCik();
  if (!cik) {
    mounted = null;
    pane.replaceChildren(el('div', { class: 'card empty-state', text: 'Load a company on the Metrics tab first.' }));
    return;
  }
  if (cache.has(cik)) {
    if (mounted?.cik !== cik) {
      render(pane, cache.get(cik));
      mounted = { cik };
    }
    return;
  }
  mounted = null;
  pane.replaceChildren(el('div', { class: 'card empty-state', text: 'Reading the latest annual filing from SEC EDGAR...' }));
  if (inflight.has(cik)) return; // the running request fills this pane when it finishes
  inflight.add(cik);
  try {
    const res = await fetch(`/api/statements?cik=${encodeURIComponent(cik)}`);
    const body = await res.json().catch(() => ({}));
    // The user may have loaded another company while this was running
    if (getCurrentCik() !== cik) return;
    if (!res.ok) {
      pane.replaceChildren(el('div', { class: 'card empty-state error-state', text: typeof body.error === 'string' ? body.error : 'Could not load the as-filed statements' }));
      return;
    }
    cache.set(cik, { filing: body.filing, statements: body.statements });
    render(pane, cache.get(cik));
    mounted = { cik };
  } catch (err) {
    console.error(err);
    if (getCurrentCik() === cik) pane.replaceChildren(el('div', { class: 'card empty-state error-state', text: 'Could not load the as-filed statements' }));
  } finally {
    inflight.delete(cik);
  }
}
