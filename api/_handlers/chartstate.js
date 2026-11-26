import sql from '../_db.js';
import { requireAuth } from '../_auth.js';

// Chart drawings and settings, synced between devices (see public/src/chart-sync.js).
//   GET  /api/chartstate                      every saved key: { items: { [key]: { data, t } } }
//   POST /api/chartstate  { items: [{ key, data, t }] }   save up to 50 keys; an older change never overwrites a newer one
// Keys are the browser's localStorage keys ("vl.charts.…"); t is the time of the change in ms (the device's clock).
// A save only replaces a strictly older one, so a device's first upload (t = 1) never overwrites another device's copy.

const USER_ID = 'local';
const KEY_RE = /^vl\.charts\.[A-Za-z0-9._\-/]{1,110}$/;
const MAX_ITEM_BYTES = 200000;

let tablesReady = null;
function ensureTable() {
  if (!tablesReady) {
    tablesReady = sql`
      CREATE TABLE IF NOT EXISTS chart_state (
        user_id    TEXT NOT NULL DEFAULT 'local',
        key        TEXT NOT NULL,
        data       JSONB,
        t          BIGINT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, key)
      )
    `.catch((err) => { tablesReady = null; throw err; });
  }
  return tablesReady;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureTable();

    if (req.method === 'GET') {
      const rows = await sql`SELECT key, data, t FROM chart_state WHERE user_id = ${USER_ID}`;
      const items = {};
      for (const r of rows) items[r.key] = { data: r.data, t: Number(r.t) };
      return res.status(200).json({ items });
    }

    if (req.method === 'POST') {
      const list = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
      let saved = 0;
      for (const it of list) {
        const key = String(it?.key || '');
        const t = Number(it?.t);
        if (!KEY_RE.test(key) || !Number.isFinite(t)) continue;
        const json = JSON.stringify(it.data ?? null);
        if (json.length > MAX_ITEM_BYTES) continue;
        await sql`
          INSERT INTO chart_state (user_id, key, data, t, updated_at)
          VALUES (${USER_ID}, ${key}, ${json}::jsonb, ${Math.round(t)}, NOW())
          ON CONFLICT (user_id, key) DO UPDATE SET data = EXCLUDED.data, t = EXCLUDED.t, updated_at = NOW()
          WHERE chart_state.t < EXCLUDED.t
        `;
        saved++;
      }
      return res.status(200).json({ ok: true, saved });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('chartstate failed:', err.message);
    return res.status(500).json({ error: 'Could not save chart data' });
  }
}
