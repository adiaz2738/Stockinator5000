const SECTION_TITLES = {
  business_summary: 'Business Summary',
  revenue_sources: 'Revenue Sources',
  where_money_goes: 'Where the Money Goes',
  capital_management: 'Capital Management',
  moat_assessment: 'Moat Assessment',
  screener_context: 'Screener Context',
  top_risks: 'Top Risks',
  red_flags: 'Red Flags',
  questions_to_research: 'Questions to Research',
};

// verdict -> pill class
const VERDICT_CLASS = {
  strong: 'pill-pass', moderate: 'pill-warn', weak: 'pill-fail', not_disclosed: 'pill-na',
  yes: 'pill-warn', no: 'pill-pass', unclear: 'pill-na',
  flagged: 'pill-fail', not_flagged: 'pill-pass', FAIL: 'pill-fail', 'N/A': 'pill-na',
};

// Survives tab switches. `ui` points at the currently mounted pane so a running
// generation keeps updating whatever is on screen.
let store = null; // { cik, state }
let running = false;
let ui = null;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, v);
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

// ---------- API ----------

// The session cookie authenticates the request; a 401 is handled globally by returning to the login screen.
async function post(body) {
  const res = await fetch('/api/narrative', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---------- Rendering ----------

function fmtDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'N/A' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function itemNode(sectionKey, item, index) {
  const head = el('div', { class: 'story-item-head' });
  if (sectionKey === 'top_risks') head.append(el('span', { class: 'story-rank mono', text: String(index + 1) }));
  head.append(el('span', { class: 'story-label', text: item.label || 'Note' }));
  if (item.verdict) {
    head.append(el('span', { class: `pill ${VERDICT_CLASS[item.verdict] || 'pill-na'}`, text: item.verdict.replace(/_/g, ' ').toUpperCase() }));
  }
  const tags = el('div', { class: 'story-tags' }, [
    el('span', { class: `kind-tag ${item.kind === 'fact' ? 'kind-fact' : 'kind-interp'}`, text: item.kind === 'fact' ? 'Fact' : 'Interpretation' }),
    ...String(item.source || 'Not disclosed').split(' + ').map((s) => el('span', { class: 'src-pill', text: s.trim() })),
  ]);
  return el('div', { class: 'story-item' }, [head, el('div', { class: 'story-text', text: item.text }), tags]);
}

function sectionCard(key, data, isMissingSource) {
  const card = el('div', { class: 'card story-card' }, el('div', { class: 'section-label', text: SECTION_TITLES[key] }));
  data.items.forEach((item, i) => card.append(itemNode(key, item, i)));
  if (isMissingSource) {
    card.append(el('div', { class: 'head-note', text: 'Part of the source filing text could not be located, so some points may read "Not disclosed".' }));
  }
  return card;
}

function footerCard(state) {
  const m = state.meta;
  const footer = el('div', { class: 'card story-footer' });
  const facts = [
    ['Form', m.form], ['Filed', fmtDate(m.filingDate)], ['Model', m.model], ['Generated', fmtDate(m.generatedAt)],
  ];
  const row = el('div', { class: 'meta-row story-meta' });
  for (const [label, value] of facts) {
    row.append(el('div', { class: 'meta-item' }, [
      el('div', { class: 'meta-label', text: label }),
      el('div', { class: 'meta-value mono', text: String(value ?? 'N/A') }),
    ]));
  }
  footer.append(row);
  if (typeof m.filingUrl === 'string' && m.filingUrl.startsWith('https://www.sec.gov/')) {
    footer.append(el('a', {
      class: 'btn btn-ghost btn-inline link-btn story-source-link',
      text: 'View source filing on EDGAR ↗',
      attrs: { href: m.filingUrl, target: '_blank', rel: 'noopener noreferrer' },
    }));
  }
  return footer;
}

function setProgress(text, done, total) {
  if (!ui) return;
  ui.progress.replaceChildren();
  if (text === null) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = el('div', { class: 'progress-bar' }, el('div', { class: 'progress-fill', attrs: { style: `width:${pct}%` } }));
  ui.progress.append(el('div', { class: 'progress-text', text }), bar);
}

function setError(message) {
  if (!ui) return;
  ui.error.replaceChildren();
  if (!message) return;
  ui.error.append(el('div', { class: 'story-error', text: message }));
}

function renderSections() {
  if (!ui) return;
  ui.sections.replaceChildren();
  const state = store?.state;
  if (!state) return;
  const anyMissing = Object.values(state.missing || {}).some(Boolean);
  for (const key of state.order) {
    if (state.sections[key]) ui.sections.append(sectionCard(key, state.sections[key], anyMissing));
  }
  if (state.status === 'complete') {
    ui.sections.append(footerCard(state));
  }
  updateButton();
}

function updateButton() {
  if (!ui) return;
  const state = store?.state;
  const done = state ? Object.keys(state.sections).length : 0;
  const total = state ? state.order.length : 0;
  ui.button.disabled = running;
  if (running) ui.button.textContent = 'Generating...';
  else if (state && state.status === 'complete') ui.button.textContent = 'Regenerate Story';
  else if (state && done > 0) ui.button.textContent = `Resume (${done}/${total} done)`;
  else ui.button.textContent = 'Generate Story';
}

function failMessage(r) {
  if (r.status === 401) return 'Your session expired. Please sign in again.';
  if (r.status === 429) {
    const limit = Number.isInteger(r.data?.dailyLimit) ? `${r.data.dailyLimit} ` : '';
    return `Daily limit of ${limit}story generations reached. Try again tomorrow.`;
  }
  if (r.status === 404 || r.status === 409 || r.status === 422) return typeof r.data?.error === 'string' ? r.data.error : 'Could not generate a story for this company.';
  return 'Could not generate the story. Please try again.';
}

async function generate({ ensureData, regenerate }) {
  if (running) return;
  running = true;
  setError('');
  updateButton();
  try {
    setProgress('Loading company metrics...', 0, 1);
    const data = await ensureData();
    if (!data) {
      setProgress(null);
      setError('Enter a valid ticker or EDGAR URL first.');
      return;
    }
    const cik = data.cik;
    if (store && store.cik !== cik) store = null;

    setProgress('Reading the latest annual filing...', 0, 1);
    const started = await post({ cik, action: 'start', regenerate: !!regenerate });
    if (!started.ok) {
      setProgress(null);
      setError(failMessage(started));
      return;
    }
    store = { cik, state: started.data };
    renderSections();

    const { order } = store.state;
    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      if (store.state.sections[key]) continue;
      setProgress(`Writing section ${i + 1} of ${order.length}: ${SECTION_TITLES[key]}...`, i, order.length);
      const r = await post({ cik, action: 'section', section: key, accession: store.state.accession });
      if (!r.ok) {
        setProgress(null);
        setError(`${failMessage(r)} Progress is saved; use Resume to continue from "${SECTION_TITLES[key]}".`);
        return;
      }
      store.state.sections[key] = r.data.data;
      store.state.status = r.data.status;
      renderSections();
    }
    store.state.status = 'complete';
    setProgress(null);
    renderSections();
  } catch (err) {
    console.error(err);
    setProgress(null);
    setError('Could not generate the story. Please try again.');
  } finally {
    running = false;
    updateButton();
  }
}

// Mounts the Story pane. ensureData() resolves to the loaded metrics payload (loading it if needed) or null.
export function renderStoryPane(pane, { ensureData, getCurrentCik }) {
  pane.replaceChildren();

  const button = el('button', { class: 'btn btn-primary btn-inline', text: 'Generate Story', attrs: { type: 'button' } });
  const progress = el('div', { class: 'story-progress' });
  const error = el('div', { class: 'story-error-wrap' });
  const sections = el('div', { class: 'story-sections' });

  pane.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'section-label', text: 'Company Story' }),
      el('div', { class: 'story-intro', text: 'An AI-written narrative of the business, built from the latest annual SEC filing and the stored 10-year metrics. Each point is tagged with where it came from and whether it is fact or interpretation.' }),
      el('div', { class: 'story-actions' }, [
        button,
        el('span', { class: 'story-hint', text: 'Each new story uses one of your limited daily generations. Existing stories reload free.' }),
      ]),
      progress,
      error,
    ]),
    sections,
    el('div', { class: 'disclaimer', text: 'AI-generated from SEC filings. Verify against the filing. Not financial advice.' }),
  );

  ui = { button, progress, error, sections };
  button.addEventListener('click', () => {
    const state = store?.state;
    const regenerate = !!state && state.status === 'complete';
    generate({ ensureData, regenerate });
  });

  // Only show a stored story for the company currently loaded
  const current = getCurrentCik();
  if (store && current && store.cik !== current) store = null;
  renderSections();
  updateButton();
}
