const fmtMoney = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);

function badgeClassFor(verdict) {
  if (verdict === 'UNDERVALUED') return 'badge-undervalued';
  if (verdict === 'OVERVALUED') return 'badge-overvalued';
  return 'badge-fair';
}

function rebuildBreakdown(row) {
  const fcfPerShare = Number(row.fcf_per_share);
  const g1 = Number(row.growth_rate_1_5) / 100;
  const g2 = Number(row.growth_rate_6_10) / 100;
  const r = Number(row.discount_rate) / 100;
  const tg = Number(row.terminal_growth) / 100;

  const rows = [];
  let fcf = fcfPerShare;
  let totalPV = 0;
  for (let year = 1; year <= 10; year++) {
    const growth = year <= 5 ? g1 : g2;
    fcf = fcf * (1 + growth);
    const discountFactor = 1 / Math.pow(1 + r, year);
    const pv = fcf * discountFactor;
    totalPV += pv;
    rows.push({ year, fcf, discountFactor, pv });
  }
  const year10FCF = rows[9].fcf;
  const terminalValue = (year10FCF * (1 + tg)) / (r - tg);
  const discountedTerminalValue = terminalValue / Math.pow(1 + r, 10);

  return { rows, terminalValue, discountedTerminalValue };
}

export async function renderValuations(container, onLoad) {
  container.innerHTML = `
    <div class="summary-row" id="summary-row"></div>
    <div class="card">
      <div class="section-label">Saved Valuations</div>
      <div id="table-wrap"></div>
    </div>
    <div id="detail-wrap"></div>
  `;

  const summaryRow = container.querySelector('#summary-row');
  const tableWrap = container.querySelector('#table-wrap');
  const detailWrap = container.querySelector('#detail-wrap');

  let data = [];
  let undoTimer = null;
  let pendingDelete = null;

  async function load() {
    tableWrap.innerHTML = `<div class="empty-state">Loading...</div>`;
    try {
      const res = await fetch('/api/valuations');
      if (!res.ok) throw new Error('fetch failed');
      data = await res.json();
    } catch (err) {
      console.error(err);
      tableWrap.innerHTML = `<div class="empty-state">Failed to load valuations.</div>`;
      return;
    }
    renderSummary();
    renderTable();
  }

  function renderSummary() {
    const total = data.length;
    const under = data.filter((d) => d.verdict === 'UNDERVALUED').length;
    const over = data.filter((d) => d.verdict === 'OVERVALUED').length;
    summaryRow.innerHTML = `
      <div class="summary-card">
        <div class="label">Total Saved</div>
        <div class="value mono">${total}</div>
      </div>
      <div class="summary-card">
        <div class="label">Undervalued</div>
        <div class="value mono" style="color:var(--green)">${under}</div>
      </div>
      <div class="summary-card">
        <div class="label">Overvalued</div>
        <div class="value mono" style="color:var(--red)">${over}</div>
      </div>
    `;
  }

  function renderTable() {
    if (data.length === 0) {
      tableWrap.innerHTML = `<div class="empty-state">No saved valuations yet. Run a calculation and save it.</div>`;
      return;
    }

    tableWrap.innerHTML = `
      <div class="table-scroll">
        <table class="val-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Company</th>
              <th class="num">Intrinsic Value</th>
              <th class="num">Safety Price</th>
              <th class="num">Market Price</th>
              <th>Verdict</th>
              <th>Date</th>
              <th>Notes</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="val-tbody"></tbody>
        </table>
      </div>
    `;

    const tbody = tableWrap.querySelector('#val-tbody');
    for (const row of data) {
      const tr = document.createElement('tr');
      tr.dataset.id = row.id;

      const tdTicker = document.createElement('td');
      tdTicker.className = 'mono';
      tdTicker.textContent = row.ticker;

      const tdCompany = document.createElement('td');
      tdCompany.textContent = row.company_name || '—';

      const tdIV = document.createElement('td');
      tdIV.className = 'num';
      tdIV.textContent = fmtMoney(row.intrinsic_value);

      const tdSafety = document.createElement('td');
      tdSafety.className = 'num';
      tdSafety.textContent = fmtMoney(row.safety_price);

      const tdMarket = document.createElement('td');
      tdMarket.className = 'num';
      tdMarket.textContent = fmtMoney(row.market_price);

      const tdVerdict = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${badgeClassFor(row.verdict)}`;
      badge.textContent = row.verdict || 'FAIRLY VALUED';
      tdVerdict.appendChild(badge);

      const tdDate = document.createElement('td');
      tdDate.textContent = row.created_at ? new Date(row.created_at).toLocaleDateString() : '—';

      const tdNotes = document.createElement('td');
      const notesText = row.notes || '';
      tdNotes.textContent = notesText.length > 40 ? notesText.slice(0, 40) + '…' : (notesText || '—');

      const tdActions = document.createElement('td');
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'row-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'icon-btn';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onLoad({
          ticker: row.ticker,
          companyName: row.company_name,
          fcfPerShare: row.fcf_per_share,
          growthRate1_5: row.growth_rate_1_5,
          growthRate6_10: row.growth_rate_6_10,
          discountRate: row.discount_rate,
          terminalGrowth: row.terminal_growth,
          marginOfSafety: row.margin_of_safety,
          marketPrice: row.market_price,
        });
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDelete(row.id, tr);
      });

      actionsWrap.appendChild(loadBtn);
      actionsWrap.appendChild(deleteBtn);
      tdActions.appendChild(actionsWrap);

      tr.appendChild(tdTicker);
      tr.appendChild(tdCompany);
      tr.appendChild(tdIV);
      tr.appendChild(tdSafety);
      tr.appendChild(tdMarket);
      tr.appendChild(tdVerdict);
      tr.appendChild(tdDate);
      tr.appendChild(tdNotes);
      tr.appendChild(tdActions);

      tr.addEventListener('click', () => showDetail(row));

      tbody.appendChild(tr);
    }
  }

  function showDetail(row) {
    const { rows, terminalValue, discountedTerminalValue } = rebuildBreakdown(row);
    detailWrap.innerHTML = `
      <div class="card detail-panel">
        <div class="section-label">${row.ticker} — Breakdown</div>
        <div class="table-scroll">
          <table class="breakdown">
            <thead>
              <tr><th>Year</th><th>Projected FCF</th><th>Discount Factor</th><th>Present Value</th></tr>
            </thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td>${r.year}</td>
                  <td>${fmtMoney(r.fcf)}</td>
                  <td>${r.discountFactor.toFixed(4)}</td>
                  <td>${fmtMoney(r.pv)}</td>
                </tr>
              `).join('')}
              <tr class="tv-row">
                <td>Terminal Value</td>
                <td>${fmtMoney(terminalValue)}</td>
                <td>—</td>
                <td>${fmtMoney(discountedTerminalValue)}</td>
              </tr>
              <tr class="total-row">
                <td colspan="3">Intrinsic Value</td>
                <td>${fmtMoney(row.intrinsic_value)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div id="notes-display" style="margin-top:14px; color:var(--text-2); font-size:13px;"></div>
      </div>
    `;
    const notesDisplay = detailWrap.querySelector('#notes-display');
    notesDisplay.textContent = row.notes ? `Notes: ${row.notes}` : '';
  }

  function handleDelete(id, tr) {
    tr.style.opacity = '0.4';
    pendingDelete = { id, row: data.find((d) => d.id === id) };
    data = data.filter((d) => d.id !== id);

    const toast = document.createElement('div');
    toast.className = 'undo-toast';
    toast.innerHTML = `<span>Valuation deleted.</span>`;
    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', () => {
      clearTimeout(undoTimer);
      toast.remove();
      pendingDelete = null;
      renderSummary();
      renderTable();
    });
    toast.appendChild(undoBtn);
    document.body.appendChild(toast);

    undoTimer = setTimeout(async () => {
      toast.remove();
      if (pendingDelete) {
        try {
          const res = await fetch(`/api/valuations?id=${encodeURIComponent(pendingDelete.id)}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('delete failed');
        } catch (err) {
          console.error(err);
        }
        pendingDelete = null;
      }
    }, 5000);

    renderSummary();
    renderTable();
  }

  await load();
}
