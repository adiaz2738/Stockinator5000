import { renderCalculator } from './calculator.js';
import { renderValuations } from './valuations.js';
import { renderFilings, FILINGS_PREFILL_KEY } from './filings.js';

const app = document.getElementById('app');
const tabCalc = document.getElementById('tab-calculator');
const tabFilings = document.getElementById('tab-filings');
const tabVal = document.getElementById('tab-valuations');

function setActiveTab(route) {
  tabCalc.classList.toggle('active', route === '/' || route === '/calculator');
  tabFilings.classList.toggle('active', route === '/filings');
  tabVal.classList.toggle('active', route === '/valuations');
}

function normalizeRoute() {
  const path = window.location.pathname;
  if (path === '/valuations') return '/valuations';
  if (path === '/filings') return '/filings';
  return '/calculator';
}

// Values handed over by the Filings tab. Read once, then cleared.
function takeFilingsPrefill() {
  try {
    const raw = sessionStorage.getItem(FILINGS_PREFILL_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(FILINGS_PREFILL_KEY);
    const data = JSON.parse(raw);
    const prefill = {};
    if (typeof data.ticker === 'string') prefill.ticker = data.ticker.slice(0, 20);
    if (typeof data.companyName === 'string') prefill.companyName = data.companyName.slice(0, 200);
    if (Number.isFinite(data.fcfPerShare)) prefill.fcfPerShare = data.fcfPerShare;
    if (Number.isFinite(data.growthRate1_5)) prefill.growthRate1_5 = data.growthRate1_5;
    return Object.keys(prefill).length ? prefill : null;
  } catch (err) {
    return null;
  }
}

function render(prefill) {
  const route = normalizeRoute();
  setActiveTab(route);

  if (route === '/valuations') {
    renderValuations(app, (data) => {
      navigate('/calculator');
      requestAnimationFrame(() => renderCalculator(app, data));
    });
  } else if (route === '/filings') {
    renderFilings(app, { onSendToCalculator: () => navigate('/calculator') });
  } else {
    const fromFilings = prefill ? null : takeFilingsPrefill();
    if (fromFilings) {
      renderCalculator(app, fromFilings, { autoCalculate: false });
    } else {
      renderCalculator(app, prefill);
    }
  }
}

function navigate(path) {
  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path);
  }
  render();
}

tabCalc.addEventListener('click', () => navigate('/calculator'));
tabFilings.addEventListener('click', () => navigate('/filings'));
tabVal.addEventListener('click', () => navigate('/valuations'));

window.addEventListener('popstate', () => render());

render();
