// Schwab connection page (/schwab) and the nav status button. Read-only: no orders are placed anywhere.

const ERROR_TEXT = {
  denied: 'Schwab login was cancelled.',
  state: 'That Schwab login link expired or was already used. Click Connect to try again.',
  code: 'Schwab did not send back a login code. Click Connect to try again.',
  exchange: 'Schwab rejected the login. Check SCHWAB_APP_KEY, SCHWAB_APP_SECRET and SCHWAB_CALLBACK_URL in Vercel, then try again.',
  config: 'Schwab is not set up yet: add SCHWAB_APP_KEY, SCHWAB_APP_SECRET and SCHWAB_CALLBACK_URL to the environment variables.',
};

const money = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const qty = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 4 }));

function el(tag, { cls, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

export async function fetchSchwabStatus() {
  try {
    const res = await fetch('/api/schwab/status');
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

function statusLabel(s) {
  if (!s) return { text: 'Schwab', cls: '' };
  if (!s.configured) return { text: 'Schwab: set up', cls: 'warn' };
  if (s.connected) {
    const left = s.daysLeft >= 1 ? `${s.daysLeft}d` : `${s.hoursLeft}h`;
    return { text: `Schwab · ${left}`, cls: s.daysLeft >= 1 ? 'ok' : 'warn' };
  }
  return { text: s.reason === 'expired' ? 'Schwab: reconnect' : 'Schwab: connect', cls: 'warn' };
}

export async function updateSchwabNav(button) {
  if (!button) return;
  const s = await fetchSchwabStatus();
  const { text, cls } = statusLabel(s);
  button.textContent = text;
  button.classList.remove('ok', 'warn');
  if (cls) button.classList.add(cls);
  button.title = s?.connected ? `Connection renews by ${new Date(s.expiresAt).toLocaleString()}` : 'Connect your Schwab account (read-only)';
}

function positionsTable(positions) {
  const table = el('table', { cls: 'val-table schwab-table' });
  const head = el('tr');
  for (const [t, isNum] of [['Symbol'], ['Type'], ['Qty', true], ['Avg cost', true], ['Market value', true], ['Day P/L', true], ['Open P/L', true]]) {
    head.append(el('th', { text: t, cls: isNum ? 'num' : undefined }));
  }
  table.append(el('thead', {}, [head]));
  const body = el('tbody');
  for (const p of positions) {
    const q = p.shortQuantity ? -p.shortQuantity : p.longQuantity;
    const tr = el('tr');
    const sym = el('td', {}, [el('div', { text: p.symbol || '—', cls: 'mono' }), el('div', { text: p.description || '', cls: 'schwab-desc' })]);
    tr.append(
      sym,
      el('td', { text: p.assetType || '—' }),
      el('td', { text: qty(q), cls: 'num' }),
      el('td', { text: money(p.averagePrice), cls: 'num' }),
      el('td', { text: money(p.marketValue), cls: 'num' }),
      el('td', { text: money(p.dayProfitLoss), cls: `num ${p.dayProfitLoss > 0 ? 'up' : p.dayProfitLoss < 0 ? 'down' : ''}` }),
      el('td', { text: money(p.openProfitLoss), cls: `num ${p.openProfitLoss > 0 ? 'up' : p.openProfitLoss < 0 ? 'down' : ''}` }),
    );
    body.append(tr);
  }
  table.append(body);
  return el('div', { cls: 'table-scroll' }, [table]);
}

async function loadAccounts(wrap) {
  wrap.replaceChildren(el('div', { cls: 'empty-state', text: 'Loading accounts from Schwab…' }));
  let data;
  try {
    const res = await fetch('/api/schwab/accounts');
    if (res.status === 409) {
      wrap.replaceChildren(el('div', { cls: 'empty-state', text: 'Schwab is not connected.' }));
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(err);
    wrap.replaceChildren(el('div', { cls: 'empty-state error-state', text: 'Could not load accounts from Schwab. Try again in a moment.' }));
    return;
  }
  if (!data.accounts?.length) {
    wrap.replaceChildren(el('div', { cls: 'empty-state', text: 'No Schwab accounts were returned.' }));
    return;
  }
  const blocks = data.accounts.map((a) => {
    const header = el('div', { cls: 'schwab-acct-head' }, [
      el('div', { cls: 'section-label', text: `${a.type || 'Account'} ····${a.last4 || '????'}` }),
      el('div', { cls: 'schwab-acct-totals' }, [
        el('span', { text: 'Value ' }), el('span', { cls: 'mono', text: money(a.liquidationValue) }),
        el('span', { text: '   Cash ' }), el('span', { cls: 'mono', text: money(a.cash) }),
      ]),
    ]);
    const body = a.positions.length ? positionsTable(a.positions) : el('div', { cls: 'empty-state', text: 'No positions in this account.' });
    return el('div', { cls: 'card schwab-acct' }, [header, body]);
  });
  const stamp = el('div', { cls: 'disclaimer', text: `From Schwab at ${new Date(data.fetchedAt).toLocaleTimeString()}. Read-only.` });
  wrap.replaceChildren(...blocks, stamp);
}

export async function renderSchwab(container, { onStatusChange } = {}) {
  // One-time result from the OAuth callback (?connected=1 / ?error=…), then tidy the URL
  const params = new URLSearchParams(window.location.search);
  const justConnected = params.get('connected') === '1';
  const errorKey = params.get('error');
  if (justConnected || errorKey) window.history.replaceState({}, '', '/schwab');

  const notice = el('div');
  const statusCard = el('div', { cls: 'card' }, [el('div', { cls: 'section-label', text: 'Schwab connection' }), el('div', { cls: 'empty-state', text: 'Checking…' })]);
  const accountsWrap = el('div', { cls: 'schwab-accounts' });
  container.replaceChildren(el('div', { cls: 'schwab-page' }, [notice, statusCard, accountsWrap]));

  if (justConnected) notice.replaceChildren(el('div', { cls: 'schwab-notice ok', text: 'Schwab connected.' }));
  else if (errorKey) notice.replaceChildren(el('div', { cls: 'schwab-notice err', text: ERROR_TEXT[errorKey] || 'Schwab connection failed. Try again.' }));

  const s = await fetchSchwabStatus();
  onStatusChange?.();

  const connectBtn = el('button', { cls: 'btn btn-primary btn-inline', text: s?.connected ? 'Reconnect' : 'Connect Schwab', attrs: { type: 'button' } });
  connectBtn.addEventListener('click', () => { window.location.href = '/api/schwab/connect'; });

  const lines = [];
  if (!s) {
    lines.push(el('p', { cls: 'error-state', text: 'Could not check the Schwab connection.' }));
  } else if (!s.configured) {
    lines.push(el('p', { text: ERROR_TEXT.config }));
  } else if (s.connected) {
    lines.push(el('p', {}, [
      el('span', { cls: 'pill pill-pass', text: 'CONNECTED' }),
      el('span', { text: `  Renew by ${new Date(s.expiresAt).toLocaleString()} (${s.daysLeft >= 1 ? `${s.daysLeft} days` : `${s.hoursLeft} hours`} left). Schwab requires logging in again every 7 days.` }),
    ]));
  } else {
    lines.push(el('p', {}, [
      el('span', { cls: 'pill pill-warn', text: s.reason === 'expired' ? 'EXPIRED' : 'NOT CONNECTED' }),
      el('span', { text: s.reason === 'expired' ? '  The 7-day Schwab login ran out. Reconnect to continue.' : '  Connect to see your Schwab accounts and positions (read-only).' }),
    ]));
  }

  const actions = el('div', { cls: 'schwab-actions' });
  if (s?.configured) actions.append(connectBtn);
  if (s?.connected) {
    const refreshBtn = el('button', { cls: 'btn btn-ghost btn-inline', text: 'Refresh', attrs: { type: 'button' } });
    refreshBtn.addEventListener('click', () => loadAccounts(accountsWrap));
    const discBtn = el('button', { cls: 'btn btn-ghost btn-inline', text: 'Disconnect', attrs: { type: 'button' } });
    discBtn.addEventListener('click', async () => {
      discBtn.disabled = true;
      try { await fetch('/api/schwab/disconnect', { method: 'POST' }); } catch (err) { console.error(err); }
      renderSchwab(container, { onStatusChange });
    });
    actions.append(refreshBtn, discBtn);
  }
  statusCard.replaceChildren(el('div', { cls: 'section-label', text: 'Schwab connection' }), ...lines, actions,
    el('p', { cls: 'schwab-fine', text: 'Read-only. Stockinator never places, changes or cancels orders.' }));

  if (s?.connected) loadAccounts(accountsWrap);
  else accountsWrap.replaceChildren();
}
