import { mountChartView, disposeCharts, __views } from './chart-view.js';
import { loadLayout, saveLayout, SAMPLE_TICKERS } from './chart-data.js';
import { chartSyncReady } from './chart-sync.js';

// The Charts page (/charts and /chart/TICKER): fills the viewport below the nav and holds one or two chart views.
// All chart behavior lives in chart-view.js (shared with the Filings tab).

export { disposeCharts };

export async function renderCharts(app, { ticker } = {}) {
  disposeCharts();
  app.replaceChildren();
  app.classList.add('vlc-fill');

  await chartSyncReady(); // the saved layout may come from another device
  const layout = loadLayout();
  // Phones show one chart (the two-chart toggle is hidden there); the saved desktop layout is left as it is
  if (window.matchMedia('(max-width: 600px)').matches) layout.count = 1;
  const routeTicker = ticker && /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(ticker) ? ticker.toUpperCase() : null;
  if (routeTicker) layout.tickers[0] = routeTicker;
  if (layout.tickers[1] === layout.tickers[0]) layout.tickers[1] = SAMPLE_TICKERS.find((t) => t !== layout.tickers[0]) || SAMPLE_TICKERS[0];

  const grid = document.createElement('div');
  app.append(grid);
  let seq = 0;

  const build = async () => {
    const mine = ++seq;
    disposeCharts();
    app.classList.add('vlc-fill');
    grid.className = `vlc-grid cols-${layout.count}`;
    grid.replaceChildren();
    const hosts = [];
    for (let i = 0; i < layout.count; i++) {
      const h = document.createElement('div');
      h.className = 'vlc-slot';
      grid.append(h);
      hosts.push(h);
    }
    for (let i = 0; i < layout.count; i++) {
      const view = await mountChartView(hosts[i], {
        ticker: layout.tickers[i],
        mode: 'full',
        location: `page-${i}`, // timeframe, volume and compare are saved per pane; drawings and indicators are shared per ticker
        // The layout toggle lives in the first chart's toolbar
        layout: i === 0 ? { count: layout.count, onChange: (n) => { if (n !== layout.count) { layout.count = n; saveLayout(layout); build(); } } } : null,
        onTickerChange: (t) => {
          layout.tickers[i] = t;
          saveLayout(layout);
          if (i === 0 && /^\/chart\//.test(window.location.pathname)) window.history.replaceState({}, '', `/chart/${encodeURIComponent(t)}`);
        },
      });
      if (mine !== seq) { view.destroy?.(); return; }
    }
  };

  await build();
}

// For headless checks
export function __panels() { return __views(); }
