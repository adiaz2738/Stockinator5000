import { calculateDCF } from './dcf.js';

const FIELDS = [
  { key: 'ticker', label: 'Ticker', type: 'text' },
  { key: 'companyName', label: 'Company Name', type: 'text' },
  { key: 'fcfPerShare', label: 'FCF / Share ($)', type: 'number' },
  { key: 'growthRate1_5', label: 'Growth Rate Y1–5 (%)', type: 'number' },
  { key: 'growthRate6_10', label: 'Growth Rate Y6–10 (%)', type: 'number' },
  { key: 'discountRate', label: 'Discount Rate (%)', type: 'number' },
  { key: 'terminalGrowth', label: 'Terminal Growth Rate (%)', type: 'number' },
  { key: 'marginOfSafety', label: 'Margin of Safety (%)', type: 'number' },
  { key: 'marketPrice', label: 'Current Market Price ($, optional)', type: 'number' },
];

const fmtMoney = (n) => `$${n.toFixed(2)}`;
const fmtPct = (n) => `${n.toFixed(1)}%`;

export function renderCalculator(container, prefill) {
  container.innerHTML = `
    <div class="grid-2col">
      <div class="card">
        <div class="section-label">Inputs</div>
        <form id="dcf-form">
          ${FIELDS.map((f) => `
            <div class="field">
              <label for="f-${f.key}">${f.label}</label>
              <input
                id="f-${f.key}"
                name="${f.key}"
                type="${f.type === 'number' ? 'text' : 'text'}"
                inputmode="${f.type === 'number' ? 'decimal' : 'text'}"
                class="${f.type === 'number' ? 'mono-input' : ''}"
                autocomplete="off"
              />
            </div>
          `).join('')}
          <button type="submit" class="btn btn-primary">Calculate Intrinsic Value</button>
          <button type="button" id="save-btn" class="btn btn-ghost" disabled>Save Valuation</button>
        </form>
      </div>
      <div class="card" id="results-card">
        <div class="section-label">Results</div>
        <div id="results-body">
          <div class="results-empty">Enter inputs and calculate to see intrinsic value.</div>
        </div>
      </div>
    </div>
  `;

  const form = container.querySelector('#dcf-form');
  const saveBtn = container.querySelector('#save-btn');
  const resultsBody = container.querySelector('#results-body');

  let lastResult = null;
  let lastInputs = null;

  if (prefill) {
    for (const f of FIELDS) {
      const input = form.querySelector(`#f-${f.key}`);
      if (input && prefill[f.key] !== undefined && prefill[f.key] !== null) {
        input.value = prefill[f.key];
      }
    }
  }

  function readInputs() {
    const ticker = form.querySelector('#f-ticker').value.trim().toUpperCase();
    const companyName = form.querySelector('#f-companyName').value.trim();
    const fcfPerShare = parseFloat(form.querySelector('#f-fcfPerShare').value);
    const growthRate1_5 = parseFloat(form.querySelector('#f-growthRate1_5').value);
    const growthRate6_10 = parseFloat(form.querySelector('#f-growthRate6_10').value);
    const discountRate = parseFloat(form.querySelector('#f-discountRate').value);
    const terminalGrowth = parseFloat(form.querySelector('#f-terminalGrowth').value);
    const marginOfSafety = parseFloat(form.querySelector('#f-marginOfSafety').value);
    const marketPriceRaw = form.querySelector('#f-marketPrice').value.trim();
    const marketPrice = marketPriceRaw === '' ? NaN : parseFloat(marketPriceRaw);

    return {
      ticker, companyName, fcfPerShare, growthRate1_5, growthRate6_10,
      discountRate, terminalGrowth, marginOfSafety, marketPrice,
    };
  }

  function renderResults(inputs, result) {
    const { rows, totalPV, terminalValue, discountedTerminalValue, intrinsicValue, safetyPrice, verdict } = result;
    const marketPrice = inputs.marketPrice;

    const badgeClass = verdict === 'UNDERVALUED' ? 'badge-undervalued'
      : verdict === 'OVERVALUED' ? 'badge-overvalued' : 'badge-fair';

    const safetyColorClass = Number.isFinite(marketPrice)
      ? (marketPrice < safetyPrice ? 'green' : 'red')
      : '';

    resultsBody.innerHTML = `
      <div class="stat-block">
        <div class="stat-label">Intrinsic Value Per Share</div>
        <div class="stat-value mono">${fmtMoney(intrinsicValue)}</div>
      </div>
      <div class="stat-block">
        <div class="stat-label">Margin of Safety Price</div>
        <div class="stat-value secondary mono ${safetyColorClass}">${fmtMoney(safetyPrice)}</div>
      </div>
      ${Number.isFinite(marketPrice) ? `
      <div class="stat-block">
        <div class="stat-label">Current Market Price</div>
        <div class="stat-market mono">${fmtMoney(marketPrice)}</div>
      </div>` : ''}
      <div class="stat-block">
        <span class="badge ${badgeClass}">${verdict}</span>
      </div>
      <hr class="divider" />
      <div class="breakdown-header">
        <div class="section-label" style="margin-bottom:0;">How This Was Calculated</div>
        <button type="button" class="breakdown-toggle" id="toggle-breakdown">Collapse ▾</button>
      </div>
      <div id="breakdown-content">
        <div class="table-scroll">
          <table class="breakdown">
            <thead>
              <tr>
                <th>Year</th>
                <th>Projected FCF</th>
                <th>Discount Factor</th>
                <th>Present Value</th>
              </tr>
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
                <td colspan="3">Intrinsic Value (Total PV + Discounted TV)</td>
                <td>${fmtMoney(intrinsicValue)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const toggleBtn = resultsBody.querySelector('#toggle-breakdown');
    const breakdownContent = resultsBody.querySelector('#breakdown-content');
    toggleBtn.addEventListener('click', () => {
      const isHidden = breakdownContent.style.display === 'none';
      breakdownContent.style.display = isHidden ? '' : 'none';
      toggleBtn.textContent = isHidden ? 'Collapse ▾' : 'Expand ▸';
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const inputs = readInputs();

    if (!inputs.ticker || [inputs.fcfPerShare, inputs.growthRate1_5, inputs.growthRate6_10,
        inputs.discountRate, inputs.terminalGrowth, inputs.marginOfSafety]
        .some((n) => !Number.isFinite(n))) {
      resultsBody.innerHTML = `<div class="results-empty">Please fill in all required fields with valid numbers.</div>`;
      saveBtn.disabled = true;
      lastResult = null;
      return;
    }

    if (inputs.discountRate <= inputs.terminalGrowth) {
      resultsBody.innerHTML = `<div class="results-empty">Discount rate must be greater than terminal growth rate.</div>`;
      saveBtn.disabled = true;
      lastResult = null;
      return;
    }

    const result = calculateDCF(inputs);
    lastResult = result;
    lastInputs = inputs;
    renderResults(inputs, result);
    saveBtn.disabled = false;
  });

  saveBtn.addEventListener('click', async () => {
    if (!lastResult || !lastInputs) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const payload = {
        ticker: lastInputs.ticker,
        companyName: lastInputs.companyName || null,
        fcfPerShare: lastInputs.fcfPerShare,
        growthRate1_5: lastInputs.growthRate1_5,
        growthRate6_10: lastInputs.growthRate6_10,
        discountRate: lastInputs.discountRate,
        terminalGrowth: lastInputs.terminalGrowth,
        marginOfSafety: lastInputs.marginOfSafety,
        intrinsicValue: lastResult.intrinsicValue,
        safetyPrice: lastResult.safetyPrice,
        marketPrice: Number.isFinite(lastInputs.marketPrice) ? lastInputs.marketPrice : null,
        verdict: lastResult.verdict,
      };
      const res = await fetch('/api/valuations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('save failed');
      saveBtn.textContent = 'Saved ✓';
      setTimeout(() => {
        saveBtn.textContent = 'Save Valuation';
        saveBtn.disabled = false;
      }, 1500);
    } catch (err) {
      console.error(err);
      saveBtn.textContent = 'Save failed — retry';
      saveBtn.disabled = false;
    }
  });

  if (prefill) {
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  }
}
