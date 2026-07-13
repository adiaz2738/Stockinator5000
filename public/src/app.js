import { renderCalculator } from './calculator.js';
import { renderValuations } from './valuations.js';

const app = document.getElementById('app');
const tabCalc = document.getElementById('tab-calculator');
const tabVal = document.getElementById('tab-valuations');

function setActiveTab(route) {
  tabCalc.classList.toggle('active', route === '/' || route === '/calculator');
  tabVal.classList.toggle('active', route === '/valuations');
}

function normalizeRoute() {
  const path = window.location.pathname;
  if (path === '/valuations') return '/valuations';
  return '/calculator';
}

function render(prefill) {
  const route = normalizeRoute();
  setActiveTab(route);

  if (route === '/valuations') {
    renderValuations(app, (data) => {
      navigate('/calculator');
      requestAnimationFrame(() => renderCalculator(app, data));
    });
  } else {
    renderCalculator(app, prefill);
  }
}

function navigate(path) {
  if (window.location.pathname !== path) {
    window.history.pushState({}, '', path);
  }
  render();
}

tabCalc.addEventListener('click', () => navigate('/calculator'));
tabVal.addEventListener('click', () => navigate('/valuations'));

window.addEventListener('popstate', () => render());

render();
