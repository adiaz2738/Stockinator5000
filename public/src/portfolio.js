// Portfolio page (/portfolio): live Schwab accounts plus accounts imported from a Fidelity positions CSV (which also
// carries accounts linked into Fidelity, such as a Vanguard Roth IRA). Same ticker across accounts = one row; each row
// is compared with the latest saved valuation. Read-only. All text goes through textContent.

let cleanup = null;
export function disposePortfolio() { if (cleanup) { cleanup(); cleanup = null; } }

function el(tag, { cls, text, attrs, on } = {}, children = []) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (on) for (const [e, fn] of Object.entries(on)) n.addEventListener(e, fn);
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const NA = '—';
const usd = (v, d = 2) => (isNum(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : NA);
const usd0 = (v) => usd(v, 0);
const signedUsd = (v) => (isNum(v) ? `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : NA);
const pct = (v, d = 1) => (isNum(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : NA);
const qtyFmt = (v) => (isNum(v) ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 4 })) : NA);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const descKey = (d) => String(d || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
const ACCOUNT_COLORS = ['#3b9eff', '#00e5a0', '#ffc940', '#b48cff', '#ff9f43', '#5ad1e6'];
const FUND_TYPES = new Set(['MUTUAL_FUND', 'ETF', 'COLLECTIVE_INVESTMENT', 'INDEX']);

// Every position as a lot { accountKey, symbol, description, quantity, price, value, cost, dayChange, kind }, plus
// accounts { key, label, cash, source }
function buildModel(data) {
  const accounts = [];
  const lots = [];
  const q = data.quotes || {};
  for (const a of data.schwab?.accounts || []) {
    const key = `schwab:${a.last4 || accounts.length}`;
    const typeLabel = a.type === 'IRA' || a.type === 'ROTH_IRA' ? 'IRA' : a.type ? a.type.charAt(0) + a.type.slice(1).toLowerCase() : 'Account';
    let cash = isNum(a.cash) ? a.cash : 0;
    for (const p of a.positions || []) {
      const qty = (p.longQuantity || 0) - (p.shortQuantity || 0);
      if (p.assetType === 'CASH_EQUIVALENT') { cash += isNum(p.marketValue) ? p.marketValue : 0; continue; }
      if (!qty) continue;
      const price = q[p.symbol]?.last ?? (isNum(p.marketValue) && qty ? p.marketValue / qty : null);
      lots.push({
        accountKey: key, symbol: p.symbol || null, description: p.description || p.symbol || '', quantity: qty, price,
        value: isNum(price) ? price * qty : p.marketValue, cost: isNum(p.averagePrice) && p.averagePrice > 0 ? p.averagePrice * qty : null, // Schwab sends 0 when it has no cost basis
        dayChange: isNum(p.dayProfitLoss) ? p.dayProfitLoss : null, kind: FUND_TYPES.has(p.assetType) ? 'fund' : 'stock',
      });
    }
    const defaultLabel = `Schwab ${typeLabel} ···${a.last4 || '?'}`;
    const custom = data.labelMap?.[key];
    accounts.push({ key, label: custom ? `${custom} ···${a.last4 || '?'}` : defaultLabel, customLabel: custom || '', defaultLabel, cash, source: 'schwab', count: (a.positions || []).filter((p) => p.assetType !== 'CASH_EQUIVALENT').length });
  }
  for (const a of data.imported || []) {
    const key = a.key;
    for (const h of a.holdings || []) {
      const symbol = h.symbol || data.tickerMap?.[descKey(h.description)] || null;
      const quote = symbol ? q[symbol] : null;
      const price = quote?.last ?? h.lastPrice ?? null;
      const value = isNum(price) ? price * h.quantity : h.value;
      const dayChange = isNum(quote?.last) && isNum(quote?.prevClose) ? (quote.last - quote.prevClose) * h.quantity : null;
      lots.push({ accountKey: key, symbol, description: h.description, quantity: h.quantity, price, value, cost: isNum(h.costBasis) ? h.costBasis : null, dayChange, kind: h.kind || 'stock', unmapped: !symbol, stalePrice: !isNum(quote?.last) });
    }
    accounts.push({ key, label: a.label, cash: a.cash || 0, source: a.source, importedAt: a.importedAt, imported: true, count: (a.holdings || []).length, defaultLabel: a.defaultLabel, last4: a.last4 });
  }
  // Hand-entered costs ("Set cost") win while the share count still matches the count they were entered for
  for (const l of lots) {
    l.costKey = `${l.accountKey}|${l.symbol || `d:${descKey(l.description)}`}`;
    const o = data.costMap?.[l.costKey];
    if (o && isNum(o.total) && Math.abs(o.quantity - l.quantity) < 0.001) { l.cost = o.total; l.costManual = true; }
  }
  return { accounts, lots };
}

// Same symbol (or, with no symbol, same description) = one holding
function mergeHoldings(lots) {
  const map = new Map();
  for (const l of lots) {
    const k = l.symbol ? `s:${l.symbol}` : `d:${descKey(l.description)}`;
    let h = map.get(k);
    if (!h) { h = { key: k, symbol: l.symbol, description: l.description, kind: l.kind, lots: [], quantity: 0, value: 0, cost: 0, costKnown: true, dayChange: 0, dayKnown: false, unmapped: l.unmapped }; map.set(k, h); }
    h.lots.push(l);
    if ((!h.description || h.description === h.symbol) && l.description && l.description !== l.symbol) h.description = l.description;
    h.quantity += l.quantity;
    h.value += isNum(l.value) ? l.value : 0;
    if (isNum(l.cost)) h.cost += l.cost; else h.costKnown = false;
    if (isNum(l.dayChange)) { h.dayChange += l.dayChange; h.dayKnown = true; }
    if (l.price !== null && l.price !== undefined) h.price = l.price;
  }
  return [...map.values()];
}

export function renderPortfolio(container, { onOpenFilings }) {
  disposePortfolio();
  let destroyed = false;
  let data = null;
  let filter = 'all';
  let sortKey = 'value';
  let sortDir = -1;
  const open = new Set();
  let schwabStatus = null;

  const summary = el('div', { cls: 'card pf-summary' });
  const holdingsCard = el('div', { cls: 'card' });
  const allocCard = el('div', { cls: 'card' });
  const importsCard = el('div', { cls: 'card' });
  container.replaceChildren(el('div', { cls: 'pf-page' }, [summary, holdingsCard, el('div', { cls: 'pf-grid' }, [allocCard, importsCard])]));
  summary.append(el('div', { cls: 'empty-state', text: 'Loading portfolio…' }));

  async function load() {
    try {
      const [res, st] = await Promise.all([fetch('/api/portfolio'), fetch('/api/schwab/status').then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
      if (!res.ok) throw new Error(`status ${res.status}`);
      data = await res.json();
      schwabStatus = st;
    } catch (err) {
      console.error(err);
      if (!destroyed) summary.replaceChildren(el('div', { cls: 'empty-state error-state', text: 'Could not load the portfolio.' }));
      return;
    }
    if (!destroyed) render();
  }

  function render() {
    const { accounts, lots } = buildModel(data);
    const inView = (key) => filter === 'all' || filter === key;
    const viewLots = lots.filter((l) => inView(l.accountKey));
    const viewAccounts = accounts.filter((a) => inView(a.key));
    const holdings = mergeHoldings(viewLots);
    const cash = viewAccounts.reduce((s, a) => s + (a.cash || 0), 0);
    const invested = holdings.reduce((s, h) => s + h.value, 0);
    const total = invested + cash;
    const day = holdings.reduce((s, h) => s + (h.dayKnown ? h.dayChange : 0), 0);
    const withCost = holdings.filter((h) => h.costKnown && h.cost > 0);
    const gain = withCost.reduce((s, h) => s + (h.value - h.cost), 0);
    const gainBase = withCost.reduce((s, h) => s + h.cost, 0);
    const noCost = holdings.length - withCost.length;

    // ----- summary -----
    const metric = (label, value, cls = '', tip = '') => el('div', { cls: 'pf-metric', attrs: tip ? { title: tip } : {} }, [el('div', { cls: 'pf-metric-label', text: label }), el('div', { cls: `pf-metric-value mono ${cls}`, text: value })]);
    const sources = [];
    if (data.schwab?.status === 'ok') sources.push('Schwab live');
    else sources.push(data.schwab?.status === 'not_connected' ? 'Schwab not connected' : 'Schwab unavailable');
    for (const a of accounts.filter((x) => x.imported)) sources.push(`${a.label} CSV ${fmtDate(a.importedAt)}`);
    const chips = el('div', { cls: 'pf-chips' }, [
      el('button', { cls: `pf-chip${filter === 'all' ? ' on' : ''}`, text: 'All accounts', attrs: { type: 'button' }, on: { click: () => { filter = 'all'; render(); } } }),
      ...accounts.map((a) => el('button', { cls: `pf-chip${filter === a.key ? ' on' : ''}`, text: a.label, attrs: { type: 'button' }, on: { click: () => { filter = a.key; render(); } } })),
    ]);
    summary.replaceChildren(
      el('div', { cls: 'pf-head' }, [el('span', { cls: 'section-label', text: 'Portfolio' }), el('span', { cls: 'pf-dim', text: sources.join(' · ') })]),
      el('div', { cls: 'pf-metrics' }, [
        metric('Total value', usd0(total)),
        metric('Today', isNum(day) && holdings.some((h) => h.dayKnown) ? `${signedUsd(day)} (${pct(total - day > 0 ? day / (total - day) : null)})` : NA, day >= 0 ? 'up' : 'down', 'Change since yesterday’s close, for holdings with a live price'),
        metric('Total gain', withCost.length ? `${signedUsd(gain)} (${pct(gainBase > 0 ? gain / gainBase : null)})` : NA, gain >= 0 ? 'up' : 'down', noCost ? `Value minus cost basis. ${noCost} holding${noCost === 1 ? '' : 's'} without a cost basis ${noCost === 1 ? 'is' : 'are'} left out.` : 'Value minus cost basis'),
        metric('Cash', usd0(cash), '', 'Cash and money market funds'),
      ]),
      chips,
    );

    // ----- holdings -----
    const buyBelow = data.buyBelow || {};
    const intrinsic = data.intrinsic || {};
    const vsOf = (h) => (h.kind === 'fund' || !h.symbol || !isNum(buyBelow[h.symbol]) || !isNum(h.price) ? null : h.price / buyBelow[h.symbol] - 1);
    const sorters = {
      symbol: (h) => h.symbol || h.description, value: (h) => h.value, weight: (h) => h.value, shares: (h) => h.quantity, price: (h) => h.price ?? null,
      gain: (h) => (h.costKnown && h.cost > 0 ? (h.value - h.cost) / h.cost : null), bb: (h) => (h.symbol ? buyBelow[h.symbol] ?? null : null), vs: vsOf,
    };
    holdings.sort((a, b) => {
      const va = sorters[sortKey](a); const vb = sorters[sortKey](b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return typeof va === 'string' ? va.localeCompare(vb) * -sortDir : (va - vb) * sortDir;
    });
    const th = (text, key, num = true, tip = '') => {
      const c = el('th', { cls: num ? 'num' : '', text: `${text}${sortKey === key ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}`, attrs: { title: `${tip ? `${tip}\n` : ''}Click to sort` } });
      c.addEventListener('click', () => { if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = key === 'symbol' ? 1 : -1; } render(); });
      return c;
    };
    const accountBadge = (key) => { const a = accounts.find((x) => x.key === key); return el('span', { cls: 'pf-badge', text: a ? a.label : key }); };
    const vsCell = (h) => {
      if (h.kind === 'fund') return el('td', { cls: 'na', text: 'Fund', attrs: { title: 'Funds have no DCF valuation' } });
      if (!h.symbol) return el('td', { cls: 'na', text: NA });
      if (!isNum(buyBelow[h.symbol])) return el('td', { cls: 'na', text: 'No valuation', attrs: { title: 'Save a valuation for this ticker to compare' } });
      const v = vsOf(h);
      if (v === null) return el('td', { cls: 'na', text: NA });
      return el('td', {}, [el('span', { cls: `pf-tag ${v <= 0 ? 'buy' : 'wait'}`, text: v <= 0 ? 'Buy zone' : `${(v * 100).toFixed(1)}% above`, attrs: { title: `Price ${usd(h.price)} vs buy-below ${usd(buyBelow[h.symbol])}${isNum(intrinsic[h.symbol]) ? ` · intrinsic value ${usd(intrinsic[h.symbol])}` : ''}` } })]);
    };
    const tbody = el('tbody');
    for (const h of holdings) {
      const g = h.costKnown && h.cost > 0 ? (h.value - h.cost) / h.cost : null;
      const nameCell = el('td', {}, [
        h.symbol
          ? el('a', { cls: 'mono pf-ticker', text: h.symbol, attrs: { href: `/filings?ticker=${encodeURIComponent(h.symbol)}` }, on: { click: (e) => { e.stopPropagation(); if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); onOpenFilings(h.symbol); } } } })
          : el('button', { cls: 'pf-set-ticker', text: 'Set ticker', attrs: { type: 'button', title: 'The file has no ticker for this holding. Set it once to get live prices and valuations.' }, on: { click: (e) => { e.stopPropagation(); setTicker(h.description); } } }),
        el('div', { cls: 'pf-name', text: h.description }),
      ]);
      const tr = el('tr', { cls: `pf-row${open.has(h.key) ? ' open' : ''}`, attrs: { title: h.lots.length > 1 ? 'Click to see each account' : '' } }, [
        nameCell,
        el('td', {}, [...new Set(h.lots.map((l) => l.accountKey))].map(accountBadge)),
        el('td', { cls: 'num', text: qtyFmt(h.quantity) }),
        el('td', { cls: `num${h.lots.every((l) => l.stalePrice === true) ? ' stale' : ''}`, text: usd(h.price), attrs: h.lots.every((l) => l.stalePrice === true) ? { title: 'Price from the CSV file (no live quote)' } : {} }),
        el('td', { cls: 'num', text: usd0(h.value) }),
        el('td', { cls: 'num', text: total > 0 ? `${((h.value / total) * 100).toFixed(1)}%` : NA }),
        el('td', { cls: `num ${g === null ? 'na' : g >= 0 ? 'up' : 'down'}`, attrs: { title: h.costKnown ? `${signedUsd(h.value - h.cost)} on a cost of ${usd(h.cost)}${h.lots.some((l) => l.costManual) ? ' (cost entered by hand)' : ''}` : 'Cost basis not available for every lot' } }, [
          el('span', { text: g === null ? NA : pct(g) }),
          h.lots.length === 1 && (!isNum(h.lots[0].cost) || h.lots[0].costManual) ? costBtn(h.lots[0]) : null,
        ]),
        el('td', { cls: `num${h.symbol && isNum(buyBelow[h.symbol]) ? '' : ' na'}`, text: h.kind === 'fund' ? 'Fund' : h.symbol && isNum(buyBelow[h.symbol]) ? usd(buyBelow[h.symbol]) : NA }),
        vsCell(h),
      ]);
      tr.addEventListener('click', () => { if (open.has(h.key)) open.delete(h.key); else open.add(h.key); render(); });
      tbody.append(tr);
      if (open.has(h.key)) {
        for (const l of h.lots) {
          const lg = isNum(l.cost) && l.cost > 0 ? (l.value - l.cost) / l.cost : null;
          tbody.append(el('tr', { cls: 'pf-lot' }, [
            el('td', { cls: 'pf-lot-label', text: '↳' }),
            el('td', {}, [accountBadge(l.accountKey)]),
            el('td', { cls: 'num', text: qtyFmt(l.quantity) }),
            el('td', { cls: 'num', text: usd(l.price) }),
            el('td', { cls: 'num', text: usd0(l.value) }),
            el('td', { cls: 'num', text: '' }),
            el('td', { cls: `num ${lg === null ? 'na' : lg >= 0 ? 'up' : 'down'}`, attrs: { title: isNum(l.cost) ? `Cost ${usd(l.cost)}${l.costManual ? ' (entered by hand)' : ''}` : 'No cost basis' } }, [
              el('span', { text: lg === null ? NA : pct(lg) }),
              costBtn(l),
            ]),
            el('td', {}), el('td', {}),
          ]));
        }
      }
    }
    holdingsCard.replaceChildren(
      el('div', { cls: 'section-label', text: 'Holdings (same ticker merged across accounts)' }),
      holdings.length
        ? el('div', { cls: 'table-scroll' }, el('table', { cls: 'val-table pf-table' }, [
          el('thead', {}, el('tr', {}, [th('Holding', 'symbol', false), el('th', { text: 'Accounts' }), th('Shares', 'shares'), th('Price', 'price'), th('Value', 'value'), th('% port.', 'weight', true, 'Share of the total, cash included'), th('Gain', 'gain', true, 'Value vs cost basis'), th('Buy-below', 'bb', true, 'From your latest saved valuation'), th('Vs buy-below', 'vs', false)])),
          tbody,
        ]))
        : el('div', { cls: 'empty-state', text: accounts.length ? 'No positions in these accounts, only cash.' : 'Nothing here yet. Upload a Fidelity positions CSV below, or connect Schwab.' }),
      el('div', { cls: 'pf-dim pf-foot', text: 'Click a row for each account’s shares and cost · click a ticker to open Filings · prices are live from Schwab when available' }),
    );

    // ----- allocation -----
    const seg = (parts) => {
      const sum = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
      return el('div', { cls: 'pf-bar' }, parts.filter((p) => p.value > 0 && sum > 0).map((p) => el('div', { cls: 'pf-seg', attrs: { style: `width:${(p.value / sum) * 100}%;background:${p.color}`, title: `${p.label}: ${usd0(p.value)} (${((p.value / sum) * 100).toFixed(1)}%)` } })));
    };
    const legend = (parts) => el('div', { cls: 'pf-legend' }, parts.filter((p) => p.value > 0).map((p) => el('span', {}, [el('i', { attrs: { style: `background:${p.color}` } }), el('span', { text: `${p.label} ${total > 0 ? `${((p.value / total) * 100).toFixed(0)}%` : ''}` })])));
    const byAccount = viewAccounts.map((a, i) => ({ label: a.label, color: ACCOUNT_COLORS[accounts.indexOf(a) % ACCOUNT_COLORS.length], value: a.cash + viewLots.filter((l) => l.accountKey === a.key).reduce((s, l) => s + (isNum(l.value) ? l.value : 0), 0) }));
    const byKind = [
      { label: 'Funds', color: '#b48cff', value: holdings.filter((h) => h.kind === 'fund').reduce((s, h) => s + h.value, 0) },
      { label: 'Stocks', color: '#00e5a0', value: holdings.filter((h) => h.kind !== 'fund').reduce((s, h) => s + h.value, 0) },
      { label: 'Cash', color: '#8a96a8', value: cash },
    ];
    allocCard.replaceChildren(
      el('div', { cls: 'section-label', text: 'Allocation' }),
      el('div', { cls: 'pf-alloc-label', text: 'By account' }), seg(byAccount), legend(byAccount),
      el('div', { cls: 'pf-alloc-label', text: 'Funds vs stocks vs cash' }), seg(byKind), legend(byKind),
    );

    // ----- imports -----
    const fileInput = el('input', { attrs: { type: 'file', accept: '.csv,text/csv', hidden: '' } });
    const msg = el('div', { cls: 'pf-msg' });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      if (f.size > 500000) { msg.textContent = 'That file is too large for a positions export.'; return; }
      msg.textContent = 'Importing…';
      try {
        const csv = await f.text();
        const res = await fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { msg.textContent = body.error || 'Could not import that file.'; return; }
        msg.textContent = `Imported ${body.accounts.map((a) => `${a.label} (${a.holdings})`).join(', ')}.`;
        await load();
      } catch (err) {
        console.error(err);
        msg.textContent = 'Could not import that file.';
      } finally {
        fileInput.value = '';
      }
    });
    const rows = accounts.filter((a) => a.imported).map((a) => el('div', { cls: 'pf-import-row' }, [
      el('span', { text: `${a.label}${a.last4 ? ` ···${a.last4}` : ''} · ${a.count} holding${a.count === 1 ? '' : 's'} · cash ${usd(a.cash)} · ${fmtDate(a.importedAt)}` }),
      el('span', { cls: 'pf-import-actions' }, [
        el('button', { cls: 'pf-link', text: 'Edit cash', attrs: { type: 'button', title: 'Correct this account’s cash until the next upload (e.g. cash that already moved to another broker)' }, on: { click: () => editCash(a) } }),
        el('button', { cls: 'pf-link', text: 'Rename', attrs: { type: 'button' }, on: { click: () => rename(a) } }),
        el('button', { cls: 'pf-link', text: 'Remove', attrs: { type: 'button' }, on: { click: () => remove(a) } }),
      ]),
    ]));
    const schwabLine = el('div', { cls: 'pf-import-row' }, [
      el('span', { text: data.schwab?.status === 'ok' ? `Schwab · live${schwabStatus?.connected ? ` · reconnect in ${schwabStatus.daysLeft} day${schwabStatus.daysLeft === 1 ? '' : 's'}` : ''}` : 'Schwab · not connected' }),
      el('a', { cls: 'pf-link', text: data.schwab?.status === 'ok' ? 'Manage' : 'Connect', attrs: { href: '/schwab' } }),
    ]);
    // Schwab accounts: live, nothing to upload; Rename because Schwab only reports "Cash" or "Margin", not "Roth IRA"
    const schwabRows = accounts.filter((a) => a.source === 'schwab').map((a) => el('div', { cls: 'pf-import-row' }, [
      el('span', { text: `${a.label} · ${a.count} holding${a.count === 1 ? '' : 's'} · cash ${usd(a.cash)} · live` }),
      el('span', { cls: 'pf-import-actions' }, [
        el('button', { cls: 'pf-link', text: 'Rename', attrs: { type: 'button' }, on: { click: () => renameSchwab(a) } }),
      ]),
    ]));
    importsCard.replaceChildren(
      el('div', { cls: 'section-label', text: 'Accounts' }),
      ...rows,
      ...schwabRows,
      schwabLine,
      el('div', { cls: 'pf-upload' }, [
        el('button', { cls: 'btn btn-ghost btn-inline', text: 'Upload CSV (Fidelity or Vanguard)', attrs: { type: 'button' }, on: { click: () => fileInput.click() } }),
        fileInput,
      ]),
      msg,
      el('div', { cls: 'pf-dim pf-howto', text: 'Fidelity: open Positions (All accounts) and use the download icon above the table; linked accounts come in the same file, but their numbers can be months old. Vanguard: download your holdings as a CSV (the OfxDownload file); it replaces the same account’s snapshot and has current share counts. Vanguard leaves out cost basis, so gain shows N/A unless the shares match the last snapshot or every buy is in the file. Only the last 4 digits of account numbers are kept.' }),
    );
  }

  // "Set cost" (no cost on file) or "Edit cost" (any cost): total dollars paid for this account's shares of the holding
  function costBtn(l) {
    return el('button', {
      cls: `pf-cost-btn${l.costManual ? ' manual' : ''}`,
      text: !isNum(l.cost) ? 'Set cost' : l.costManual ? 'Edited' : 'Edit',
      attrs: { type: 'button', title: l.costManual ? 'Cost entered by hand. Click to change or clear it.' : 'Enter the total cost of these shares by hand' },
      on: { click: (e) => { e.stopPropagation(); setCost(l); } },
    });
  }

  async function setCost(l) {
    const acct = buildModel(data).accounts.find((a) => a.key === l.accountKey)?.label || 'this account';
    const raw = window.prompt(`Total cost for ${qtyFmt(l.quantity)} shares of ${l.symbol || l.description} in ${acct}, in dollars (for example 7546.28).\nLeave blank to clear a cost you entered.`, l.costManual ? String(l.cost) : '');
    if (raw === null) return;
    const t = raw.replace(/[$,\s]/g, '');
    if (t && !(Number(t) >= 0)) { window.alert('Enter a dollar amount, like 7546.28'); return; }
    const res = await fetch('/api/portfolio?action=cost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: l.costKey, total: t ? Number(t) : null, quantity: l.quantity }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); window.alert(b.error || 'Could not save the cost'); return; }
    await load();
  }

  async function setTicker(description) {
    const symbol = (window.prompt(`Ticker for “${description}” (for example BRK.B):`, '') || '').trim().toUpperCase();
    if (!symbol) return;
    const res = await fetch('/api/portfolio?action=ticker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description, symbol }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); window.alert(b.error || 'Could not save the ticker'); return; }
    await load();
  }
  async function renameSchwab(a) {
    const label = window.prompt(`Name for ${a.defaultLabel} (for example "Schwab Roth IRA"). The last 4 digits stay. Leave blank to go back to Schwab's name.`, a.customLabel);
    if (label === null) return;
    await fetch('/api/portfolio?action=label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: a.key, label }) });
    await load();
  }

  async function editCash(a) {
    const raw = window.prompt(`Cash in ${a.label}, in dollars. Your next upload of this account replaces it.`, String(a.cash ?? 0));
    if (raw === null) return;
    const t = raw.replace(/[$,\s]/g, '');
    if (!t || !(Number(t) >= 0)) { window.alert('Enter a dollar amount, like 0 or 647.40'); return; }
    const res = await fetch('/api/portfolio?action=cash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: a.key, cash: Number(t) }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); window.alert(b.error || 'Could not save the cash'); return; }
    await load();
  }

  async function rename(a) {
    const label = window.prompt('Account name', a.label);
    if (label === null) return;
    await fetch('/api/portfolio?action=label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: a.key, label }) });
    await load();
  }
  async function remove(a) {
    if (!window.confirm(`Remove ${a.label} from the portfolio? You can import it again any time.`)) return;
    await fetch(`/api/portfolio?key=${encodeURIComponent(a.key)}`, { method: 'DELETE' });
    if (filter === a.key) filter = 'all';
    await load();
  }

  cleanup = () => { destroyed = true; };
  load();
}
