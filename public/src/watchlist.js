// Watchlist page (/watchlist): tickers with live Schwab prices next to the intrinsic value and buy-below price from the
// latest saved valuation. Sorted with the closest-to-buy-zone first. Read-only market data.

import { subscribeQuotes, onStreamStatus, streamStatus } from './schwab-stream.js';

const NEAR_PCT = 10; // "near" = within 10% above the buy-below price
let cleanup = null;

export function disposeWatchlist() {
  if (cleanup) { cleanup(); cleanup = null; }
}

function el(tag, { cls, text, attrs, on } = {}, children = []) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (on) for (const [ev, fn] of Object.entries(on)) node.addEventListener(ev, fn);
  for (const c of children) if (c) node.append(c);
  return node;
}

const money = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : '—');
const pct = (n, signed = true) => (Number.isFinite(n) ? `${signed && n > 0 ? '+' : ''}${n.toFixed(2)}%` : '—');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// Distance from the buy-below price: negative = below it (in the buy zone)
function distance(price, buyBelow) {
  if (!Number.isFinite(price) || !Number.isFinite(buyBelow) || buyBelow <= 0) return null;
  return ((price - buyBelow) / buyBelow) * 100;
}
function zone(d) {
  if (d === null) return null;
  if (d <= 0) return 'buy';
  if (d <= NEAR_PCT) return 'near';
  return null;
}

export function renderWatchlist(container, { onOpenFilings, onValue }) {
  disposeWatchlist();
  let items = [];
  let schwabState = 'ok';
  const live = new Map(); // ticker -> { last, prevClose }
  const unsubs = new Map(); // ticker -> off()
  let destroyed = false;

  // ----- add form -----
  const input = el('input', { attrs: { type: 'text', autocomplete: 'off', placeholder: 'AAPL, MCD, V', maxlength: '2000', 'aria-label': 'Tickers to add' } });
  const addBtn = el('button', { cls: 'btn btn-primary btn-inline', text: 'Add', attrs: { type: 'submit' } });
  const formMsg = el('div', { cls: 'wl-form-msg' });
  const form = el('form', { cls: 'search-row' }, [el('div', { cls: 'field' }, [input]), addBtn]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    addBtn.disabled = true;
    formMsg.textContent = '';
    try {
      const res = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers: raw }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { formMsg.textContent = body.error || 'Could not add those tickers.'; return; }
      input.value = '';
      await load();
    } catch (err) {
      console.error(err);
      formMsg.textContent = 'Could not add those tickers.';
    } finally {
      addBtn.disabled = false;
    }
  });
  const addCard = el('div', { cls: 'card' }, [
    el('div', { cls: 'section-label', text: 'Watchlist' }),
    form,
    el('div', { cls: 'search-hint', text: 'Add one ticker or paste several (commas or spaces), e.g. your Schwab watchlist symbols.' }),
    formMsg,
  ]);

  const tableCard = el('div', { cls: 'card' }, [el('div', { cls: 'empty-state', text: 'Loading…' })]);
  const foot = el('div', { cls: 'disclaimer' });
  container.replaceChildren(el('div', { cls: 'wl-page' }, [addCard, tableCard, foot]));

  // ----- data -----
  const priceOf = (it) => live.get(it.ticker)?.last ?? it.quote?.last ?? null;
  const prevCloseOf = (it) => live.get(it.ticker)?.prevClose ?? it.quote?.prevClose ?? null;
  function changePct(it) {
    const p = priceOf(it);
    const pc = prevCloseOf(it);
    if (Number.isFinite(p) && Number.isFinite(pc) && pc > 0) return ((p - pc) / pc) * 100;
    return it.quote?.changePct ?? null;
  }

  async function load() {
    let data;
    try {
      const res = await fetch('/api/watchlist');
      if (!res.ok) throw new Error(`status ${res.status}`);
      data = await res.json();
    } catch (err) {
      console.error(err);
      if (!destroyed) tableCard.replaceChildren(el('div', { cls: 'empty-state error-state', text: 'Could not load the watchlist.' }));
      return;
    }
    if (destroyed) return;
    items = data.items || [];
    schwabState = data.schwab;
    syncSubscriptions();
    render();
  }

  function syncSubscriptions() {
    const want = new Set(schwabState === 'ok' ? items.map((i) => i.ticker) : []);
    for (const [t, off] of unsubs) if (!want.has(t)) { off(); unsubs.delete(t); live.delete(t); }
    for (const t of want) {
      if (unsubs.has(t)) continue;
      unsubs.set(t, subscribeQuotes(t, (q) => {
        live.set(t, { last: q.last, prevClose: q.prevClose });
        scheduleRender();
      }));
    }
  }

  let raf = 0;
  function scheduleRender() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  }

  async function remove(ticker) {
    try {
      await fetch(`/api/watchlist?ticker=${encodeURIComponent(ticker)}`, { method: 'DELETE' });
    } catch (err) { console.error(err); }
    items = items.filter((i) => i.ticker !== ticker);
    syncSubscriptions();
    render();
  }

  function render() {
    if (destroyed) return;
    if (!items.length) {
      tableCard.replaceChildren(el('div', { cls: 'empty-state', text: 'Your watchlist is empty. Add tickers above.' }));
      paintFoot();
      return;
    }
    // Closest to (or deepest into) the buy zone first; tickers without a valuation last
    const rows = items.map((it) => {
      const price = priceOf(it);
      const d = distance(price, it.valuation?.buyBelow);
      return { it, price, d, z: zone(d) };
    }).sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity) || a.it.ticker.localeCompare(b.it.ticker));

    const table = el('table', { cls: 'val-table wl-table' });
    const head = el('tr');
    for (const [t, isNum] of [['Ticker'], ['Price', true], ['Today', true], ['Intrinsic value', true], ['Buy below', true], ['vs. buy below', true], ['Valued'], ['']]) {
      head.append(el('th', { text: t, cls: isNum ? 'num' : undefined }));
    }
    table.append(el('thead', {}, [head]));
    const body = el('tbody');
    for (const { it, price, d, z } of rows) {
      const chg = changePct(it);
      const v = it.valuation;
      const tr = el('tr', { cls: z ? `wl-${z}` : '', attrs: { title: `Open ${it.ticker} in Filings` } });
      tr.addEventListener('click', () => onOpenFilings(it.ticker));

      const tickerCell = el('td', {}, [
        el('div', { cls: 'mono wl-ticker', text: it.ticker }),
        el('div', { cls: 'schwab-desc', text: it.companyName || '' }),
      ]);
      let distCell;
      if (!v) {
        const valueBtn = el('button', { cls: 'btn btn-ghost btn-inline wl-value', text: 'Value it →', attrs: { type: 'button', title: 'Open the calculator for this ticker' } });
        valueBtn.addEventListener('click', (e) => { e.stopPropagation(); onValue(it.ticker, it.companyName); });
        distCell = el('td', { cls: 'num' }, [el('span', { cls: 'wl-none', text: 'No valuation ' }), valueBtn]);
      } else {
        const label = d === null ? '—' : d <= 0 ? `${Math.abs(d).toFixed(1)}% below` : `${d.toFixed(1)}% above`;
        distCell = el('td', { cls: 'num' }, [
          z === 'buy' ? el('span', { cls: 'pill pill-pass', text: 'BUY ZONE' }) : z === 'near' ? el('span', { cls: 'pill pill-warn', text: 'NEAR' }) : null,
          el('span', { cls: 'mono', text: ` ${label}` }),
        ]);
      }
      const removeBtn = el('button', { cls: 'wl-remove', text: '×', attrs: { type: 'button', title: `Remove ${it.ticker}`, 'aria-label': `Remove ${it.ticker}` } });
      removeBtn.addEventListener('click', (e) => { e.stopPropagation(); remove(it.ticker); });

      tr.append(
        tickerCell,
        el('td', { cls: 'num', text: money(price) }),
        el('td', { cls: `num ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}`, text: pct(chg) }),
        el('td', { cls: 'num', text: v ? money(v.intrinsicValue) : '—' }),
        el('td', { cls: 'num', text: v ? money(v.buyBelow) : '—' }),
        distCell,
        el('td', { cls: 'wl-date', text: v ? fmtDate(v.valuedAt) : '' }),
        el('td', {}, [removeBtn]),
      );
      body.append(tr);
    }
    table.append(body);
    tableCard.replaceChildren(el('div', { cls: 'table-scroll' }, [table]));
    paintFoot();
  }

  function paintFoot() {
    if (schwabState === 'not_connected') foot.textContent = 'Prices need Schwab connected (Schwab button in the nav). Intrinsic values come from your latest saved valuation.';
    else if (schwabState === 'error') foot.textContent = 'Schwab prices could not be loaded right now. Intrinsic values come from your latest saved valuation.';
    else foot.textContent = `Prices: Schwab${streamStatus() === 'live' ? ' (live)' : streamStatus() === 'polling' ? ' (refreshed every 5 seconds)' : ''}. Intrinsic value and buy-below come from your latest saved valuation for each ticker. Buy zone = at or under buy-below; near = within ${NEAR_PCT}% above.`;
  }
  const offStatus = onStreamStatus(() => paintFoot());

  cleanup = () => {
    destroyed = true;
    cancelAnimationFrame(raf);
    offStatus();
    for (const off of unsubs.values()) off();
    unsubs.clear();
  };

  load();
}

// Used by the Filings page's "+ Watchlist" button
export async function addToWatchlist(ticker) {
  const res = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers: [ticker] }) });
  return res.ok;
}
