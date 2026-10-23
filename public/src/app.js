import { renderCalculator } from './calculator.js';
import { renderValuations } from './valuations.js';
import { renderFilings, FILINGS_PREFILL_KEY } from './filings.js';
import { renderLogin } from './login.js';

const app = document.getElementById('app');
const loginScreen = document.getElementById('login-screen');
const signOutBtn = document.getElementById('signout');
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

// ---------- Auth gate ----------

function showLogin() {
  document.body.classList.add('locked');
  app.replaceChildren();
  loginScreen.hidden = false;
  renderLogin(loginScreen, showApp);
}

function showApp() {
  loginScreen.hidden = true;
  loginScreen.replaceChildren();
  document.body.classList.remove('locked');
  render();
}

// Any 401 from an API route sends the user back to the login screen (the login call itself is exempt).
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === 'string' ? input : input?.url || '';
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth') && !document.body.classList.contains('locked')) {
    showLogin();
  }
  return res;
};

signOutBtn.addEventListener('click', async () => {
  try {
    await nativeFetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' }),
    });
  } catch (err) {
    console.error(err);
  }
  // Reload so no company data from the old session stays in memory
  window.location.reload();
});

tabCalc.addEventListener('click', () => navigate('/calculator'));
tabFilings.addEventListener('click', () => navigate('/filings'));
tabVal.addEventListener('click', () => navigate('/valuations'));

window.addEventListener('popstate', () => {
  if (!document.body.classList.contains('locked')) render();
});

async function init() {
  try {
    const res = await nativeFetch('/api/auth?action=me');
    const data = await res.json();
    if (data.authenticated === true) {
      showApp();
      return;
    }
  } catch (err) {
    console.error(err);
  }
  showLogin();
}

init();
