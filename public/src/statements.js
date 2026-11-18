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

function statementCard(s) {
  const head = el('div', { class: 'stmt-head' }, [
    el('div', { class: 'section-label', text: s.name }),
    s.sourceUrl ? secLink(s.sourceUrl, `${s.method === 'r-pages' ? 'XBRL page ' : ''}${s.sourceFile} ↗`) : null,
  ]);

  const unitText = s.units ? `As filed. ${s.title}. Units: ${s.units}` : `As filed. ${s.title}. Units and scale were not stated on the page; check the filing`;
  const layoutNote = s.replacedSegmentView ? ' Taken from the 10-K document so the layout matches the filing (SEC\u2019s XBRL page splits this statement by segment).' : '';
  const note = el('div', { class: 'head-note stmt-note', text: `${unitText}. Source: ${METHOD_LABEL[s.method] || s.method}.${layoutNote}` });

  const cols = Math.max(s.columns || 0, 0);
  const thead = el('thead', {}, el('tr', {}, [
    el('th', { text: s.title }),
    ...Array.from({ length: cols }, (_, i) => el('th', { text: s.periods[i] || '' })),
  ]));
  const tbody = el('tbody');
  for (const row of s.rows) {
    const level = Math.max(0, Math.min(Number(row.level) || 0, 4));
    const cls = ['stmt-row', `lvl-${level}`, row.header ? 'stmt-section' : '', row.total ? 'stmt-total' : ''].filter(Boolean).join(' ');
    const cells = [el('td', { text: String(row.label) })];
    for (let i = 0; i < cols; i++) {
      const v = row.values[i];
      cells.push(el('td', { text: typeof v === 'string' ? v : '' }));
    }
    tbody.append(el('tr', { class: cls }, cells));
  }
  return el('div', { class: 'card' }, [
    head,
    note,
    el('div', { class: 'table-scroll' }, el('table', { class: 'fin-table stmt-table' }, [thead, tbody])),
  ]);
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
