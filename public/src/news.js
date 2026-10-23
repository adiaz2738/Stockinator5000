// News tab: web-search news context. Kept visually and textually separate from filing-derived data.

const COST_NOTE = 'Uses web search. About $0.10 per run. Cached for 12 hours.';
const DISCLAIMER = 'AI-generated from web search. Sources may be wrong or out of date. Verify before acting. Not financial advice.';

const CONFIDENCE_CLASS = { high: 'pill-pass', medium: 'pill-warn', low: 'pill-na' };
const DIRECTION_LABEL = { up: '↑ Up', down: '↓ Down', mixed: '↕ Mixed', neutral: '→ Neutral', unclear: '? Unclear' };

// Survives tab switches; `ui` points at the mounted pane so a running request updates what is on screen.
let store = null; // { cik, data }
let running = false;
let ui = null;
let timer = null;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmtPrice = (v) => (isNum(v) ? `$${v.toFixed(2)}` : 'N/A');
const fmtPct = (v) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : 'N/A');

function fmtDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'N/A' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------- Pills & links ----------

const factPill = () => el('span', { class: 'kind-tag kind-fact', text: 'Fact' });
const interpPill = () => el('span', { class: 'kind-tag kind-interp', text: 'Interpretation' });
const confidencePill = (c) => el('span', { class: `pill ${CONFIDENCE_CLASS[c] || 'pill-na'}`, text: `${String(c || 'low').toUpperCase()} CONFIDENCE` });

// A source becomes a link only if its URL is http(s); the link text is the domain.
function sourceLinks(sources) {
  const wrap = el('div', { class: 'news-sources' });
  for (const s of sources || []) {
    let url;
    try {
      url = new URL(s.url);
    } catch (err) {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const a = el('a', { class: 'news-source-link', text: url.hostname.replace(/^www\./, '') });
    a.setAttribute('href', url.href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    if (typeof s.title === 'string' && s.title) a.setAttribute('title', s.title);
    wrap.append(a);
  }
  return wrap.childNodes.length ? wrap : null;
}

// ---------- Cards ----------

function newsCard(title, children) {
  return el('div', { class: 'card news-card' }, [
    el('div', { class: 'news-card-head' }, [
      el('div', { class: 'section-label', text: title }),
      el('span', { class: 'news-tag', text: 'News context' }),
    ]),
    ...children,
  ]);
}

function itemBlock(label, parts) {
  return el('div', { class: 'story-item' }, [
    label ? el('div', { class: 'story-item-head' }, label) : null,
    ...parts,
  ]);
}

function factLine(text) {
  return el('div', { class: 'news-line' }, [factPill(), el('span', { class: 'story-text', text })]);
}

function interpLine(text, confidence) {
  return el('div', { class: 'news-line' }, [interpPill(), confidencePill(confidence), el('span', { class: 'story-text', text })]);
}

function summaryCard(r) {
  return newsCard('What Has Been Happening', [
    el('div', { class: 'story-text news-summary', text: r.summary }),
    el('div', { class: 'head-note', text: 'The summary mixes reported facts with interpretation. See the sections below for each point, its confidence, and its sources.' }),
  ]);
}

function priceStatCell(label, value) {
  return el('div', { class: 'meta-item' }, [
    el('div', { class: 'meta-label', text: label }),
    el('div', { class: 'meta-value mono', text: value }),
  ]);
}

function priceCard(r) {
  const pc = r.price_context;
  const meta = r.meta || {};
  const children = [];
  if (meta.priceDataProvided && meta.priceSummary) {
    const p = meta.priceSummary;
    children.push(
      el('div', { class: 'meta-row story-meta' }, [
        priceStatCell('Start', `${fmtPrice(p.start.close)} (${p.start.date})`),
        priceStatCell('End', `${fmtPrice(p.end.close)} (${p.end.date})`),
        priceStatCell('12-month change', fmtPct(p.changePct)),
        priceStatCell('High', `${fmtPrice(p.high.close)} (${p.high.date})`),
        priceStatCell('Low', `${fmtPrice(p.low.close)} (${p.low.date})`),
      ]),
      el('div', { class: 'head-note', text: 'Largest daily moves: ' + p.largestDailyMoves.map((m) => `${m.date} ${fmtPct(m.changePct)}`).join(', ') }),
      el('div', { class: 'head-note', text: 'Computed from daily closes (Financial Modeling Prep), not by the AI.' }),
    );
  } else {
    children.push(el('div', { class: 'news-note', text: 'Price data was not available for this ticker, so the price context below comes only from cited sources.' }));
  }
  const basis = { provided_data: 'From the price data above', cited_source: 'From a cited source', not_available: 'No supported price figure' }[pc.basis] || '';
  children.push(itemBlock(null, [
    el('div', { class: 'news-line' }, [factPill(), el('span', { class: 'story-text', text: pc.text })]),
    el('div', { class: 'head-note', text: basis }),
    sourceLinks(pc.sources),
  ]));
  return newsCard('Price Context', children);
}

function driversCard(r) {
  const body = r.drivers.length ? r.drivers.map((d) => itemBlock(
    [el('span', { class: 'story-label', text: d.name }), el('span', { class: 'src-pill', text: DIRECTION_LABEL[d.direction] || DIRECTION_LABEL.unclear })],
    [factLine(d.evidence), d.interpretation ? interpLine(d.interpretation, d.confidence) : null, sourceLinks(d.sources)],
  )) : [el('div', { class: 'head-note', text: 'No supported drivers found in search results.' })];
  return newsCard('External Drivers', body);
}

function eventsCard(r) {
  const body = r.company_events.length ? r.company_events.map((e) => itemBlock(
    [el('span', { class: 'story-label mono', text: e.date || 'Date unknown' })],
    [factLine(e.what_happened), e.interpretation ? interpLine(e.interpretation, e.confidence) : null, sourceLinks(e.sources)],
  )) : [el('div', { class: 'head-note', text: 'No supported company events found.' })];
  return newsCard('Company Events', body);
}

function analystCard(r) {
  const body = r.analyst_actions.length ? r.analyst_actions.map((a) => itemBlock(
    [el('span', { class: 'story-label', text: a.firm }), el('span', { class: 'story-label mono', text: a.date || '' })],
    [factLine(a.action), sourceLinks(a.sources)],
  )) : [el('div', { class: 'head-note', text: 'Not found in search results.' })];
  return newsCard('Analyst Actions', [
    ...body,
    el('div', { class: 'head-note', text: 'Reported by the cited sources. Not recommendations from this app.' }),
  ]);
}

function catalystsCard(r) {
  const body = r.upcoming_catalysts.length ? r.upcoming_catalysts.map((c) => itemBlock(
    [el('span', { class: 'story-label mono', text: c.date || 'Date not found' })],
    [factLine(c.what), sourceLinks(c.sources)],
  )) : [el('div', { class: 'head-note', text: 'Not found in search results.' })];
  return newsCard('Upcoming Catalysts', body);
}

function unknownsCard(r) {
  if (!r.unknowns.length) return null;
  return newsCard('Unknowns', r.unknowns.map((u) => el('div', { class: 'story-item' }, el('div', { class: 'story-text', text: u }))));
}

function footerCard(data) {
  const row = el('div', { class: 'meta-row story-meta' });
  for (const [label, value] of [
    ['Generated', fmtDate(data.generatedAt)], ['Model', data.model || 'N/A'], ['Web searches', String(data.searchesUsed ?? 'N/A')],
    ['Source', data.cached ? 'Cached' : 'Fresh run'],
  ]) {
    row.append(el('div', { class: 'meta-item' }, [
      el('div', { class: 'meta-label', text: label }),
      el('div', { class: 'meta-value mono', text: value }),
    ]));
  }
  return el('div', { class: 'card story-footer' }, row);
}

function renderResult() {
  if (!ui) return;
  ui.sections.replaceChildren();
  const data = store?.data;
  if (!data) return;
  const r = data.result;
  for (const card of [summaryCard(r), priceCard(r), driversCard(r), eventsCard(r), analystCard(r), catalystsCard(r), unknownsCard(r), footerCard(data)]) {
    if (card) ui.sections.append(card);
  }
}

// ---------- Progress & run ----------

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function startProgress() {
  stopTimer();
  const t0 = Date.now();
  const tick = () => {
    if (!ui) return;
    const s = Math.round((Date.now() - t0) / 1000);
    const phase = s < 4 ? 'Gathering recent SEC filings and price data...' : s < 50 ? 'Searching the web for news on the company and its drivers...' : 'Writing the summary...';
    ui.progress.replaceChildren(
      el('div', { class: 'progress-text', text: `${phase} (${s}s)` }),
      el('div', { class: 'progress-bar' }, el('div', { class: 'progress-fill progress-indeterminate' })),
    );
  };
  tick();
  timer = setInterval(tick, 1000);
}

function setError(message) {
  if (!ui) return;
  ui.error.replaceChildren();
  if (message) ui.error.append(el('div', { class: 'story-error', text: message }));
}

function updateButton() {
  if (!ui) return;
  ui.button.disabled = running;
  if (running) ui.button.textContent = 'Working...';
  else ui.button.textContent = store?.data ? 'Refresh News Context' : 'Get News Context';
}

function failMessage(status, data) {
  if (status === 429) return `Daily news limit of ${Number.isInteger(data?.dailyLimit) ? `${data.dailyLimit} ` : ''}runs reached. Try again tomorrow.`;
  if (status === 401) return 'Your session expired. Please sign in again.';
  if (status === 409) return 'Load the company metrics first.';
  return 'Could not get news context. Please try again.';
}

async function run({ ensureData, refresh }) {
  if (running) return;
  running = true;
  setError('');
  updateButton();
  try {
    const company = await ensureData();
    if (!company) {
      setError('Enter a valid ticker or EDGAR URL first.');
      return;
    }
    if (store && store.cik !== company.cik) store = null;
    startProgress();
    const res = await fetch('/api/news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cik: company.cik, refresh: !!refresh }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(failMessage(res.status, data));
      return;
    }
    store = { cik: company.cik, data };
    renderResult();
  } catch (err) {
    console.error(err);
    setError('Could not get news context. Please try again.');
  } finally {
    running = false;
    stopTimer();
    if (ui) ui.progress.replaceChildren();
    updateButton();
  }
}

// Mounts the News pane. ensureData() resolves to the loaded metrics payload (loading it if needed) or null.
export function renderNewsPane(pane, { ensureData, getCurrentCik }) {
  pane.replaceChildren();

  const button = el('button', { class: 'btn btn-primary btn-inline', text: 'Get News Context', attrs: { type: 'button' } });
  const progress = el('div', { class: 'story-progress' });
  const error = el('div', { class: 'story-error-wrap' });
  const sections = el('div', { class: 'story-sections' });

  pane.append(
    el('div', { class: 'card news-card' }, [
      el('div', { class: 'news-banner', text: 'NEWS CONTEXT, NOT FROM FILINGS' }),
      el('div', { class: 'story-intro', text: 'Why this stock may have been moving: recent news on the company and the outside forces that drive it, found by web search. Unlike the Metrics and Story tabs, none of this comes from SEC filings.' }),
      el('div', { class: 'story-actions' }, [button, el('span', { class: 'story-hint', text: COST_NOTE })]),
      progress,
      error,
    ]),
    sections,
    el('div', { class: 'disclaimer', text: DISCLAIMER }),
  );

  ui = { button, progress, error, sections };
  button.addEventListener('click', () => run({ ensureData, refresh: !!store?.data }));

  // Only show a stored result for the company currently loaded
  const current = getCurrentCik();
  if (store && current && store.cik !== current) store = null;
  renderResult();
  updateButton();
  if (running) startProgress();
}
