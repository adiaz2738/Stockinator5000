import { renderCalculator } from './calculator.js';
import { renderValuations } from './valuations.js';
import { renderReverse } from './reverse.js';
import { renderFilings, FILINGS_PREFILL_KEY } from './filings.js';
import { renderLogin } from './login.js';
import { renderCharts, disposeCharts } from './charts.js';
import { renderSchwab, updateSchwabNav } from './schwab.js';
import { renderWatchlist, disposeWatchlist } from './watchlist.js';

const app = document.getElementById('app');
const loginScreen = document.getElementById('login-screen');
const signOutBtn = document.getElementById('signout');
const tabCalc = document.getElementById('tab-calculator');
const tabReverse = document.getElementById('tab-reverse');
const tabFilings = document.getElementById('tab-filings');
const tabVal = document.getElementById('tab-valuations');
const tabCharts = document.getElementById('tab-charts');
const tabWatch = document.getElementById('tab-watchlist');
const schwabNav = document.getElementById('schwab-status');

function setActiveTab(route) {
  tabCharts.classList.toggle('active', route === '/charts' || route.startsWith('/chart/'));
  tabCalc.classList.toggle('active', route === '/' || route === '/calculator');
  tabReverse.classList.toggle('active', route === '/reverse');
  tabFilings.classList.toggle('active', route === '/filings');
  tabVal.classList.toggle('active', route === '/valuations');
  tabWatch.classList.toggle('active', route === '/watchlist');
  schwabNav.classList.toggle('active', route === '/schwab');
}

function normalizeRoute() {
  const path = window.location.pathname;
  if (path === '/valuations') return '/valuations';
  if (path === '/filings') return '/filings';
  if (path === '/reverse') return '/reverse';
  if (path === '/charts') return '/charts';
  if (path === '/schwab') return '/schwab';
  if (path === '/watchlist') return '/watchlist';
  if (/^\/chart\/[^/]+\/?$/.test(path)) return path.replace(/\/$/, '');
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
  disposeCharts();
  disposeWatchlist();

  if (route === '/charts' || route.startsWith('/chart/')) {
    let ticker;
    if (route.startsWith('/chart/')) {
      try { ticker = decodeURIComponent(route.slice('/chart/'.length)); } catch (err) { ticker = ''; }
    }
    renderCharts(app, { ticker });
  } else if (route === '/watchlist') {
    renderWatchlist(app, {
      onOpenFilings: (t) => navigate(`/filings?ticker=${encodeURIComponent(t)}`),
      onValue: (ticker, companyName) => {
        try { sessionStorage.setItem(FILINGS_PREFILL_KEY, JSON.stringify({ ticker, companyName: companyName || undefined })); } catch (err) { /* ignore */ }
        navigate('/calculator');
      },
    });
  } else if (route === '/schwab') {
    renderSchwab(app, { onStatusChange: () => updateSchwabNav(schwabNav) });
  } else if (route === '/valuations') {
    renderValuations(app, (data) => {
      navigate('/calculator');
      requestAnimationFrame(() => renderCalculator(app, data));
    }, (loaded) => {
      navigate('/reverse');
      requestAnimationFrame(() => renderReverse(app, { loaded }));
    });
  } else if (route === '/reverse') {
    renderReverse(app);
  } else if (route === '/filings') {
    // /filings?ticker=MCD loads that company (from the watchlist, or after a page refresh; Filings keeps the URL current)
    const initialTicker = new URLSearchParams(window.location.search).get('ticker');
    renderFilings(app, { initialTicker, onSendToCalculator: () => navigate('/calculator'), onSendToReverse: () => navigate('/reverse'), onOpenInCharts: (t) => navigate(`/chart/${encodeURIComponent(t)}`), onOpenValuations: () => navigate('/valuations') });
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
  if (window.location.pathname + window.location.search !== path) {
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
  updateSchwabNav(schwabNav);
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
tabReverse.addEventListener('click', () => navigate('/reverse'));
tabFilings.addEventListener('click', () => navigate('/filings'));
tabVal.addEventListener('click', () => navigate('/valuations'));
tabWatch.addEventListener('click', () => navigate('/watchlist'));
tabCharts.addEventListener('click', () => navigate('/charts'));
schwabNav.addEventListener('click', () => navigate('/schwab'));

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
