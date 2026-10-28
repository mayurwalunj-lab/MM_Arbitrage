'use strict';

// Run: node --test alerts/checks.test.js
const test = require('node:test');
const assert = require('node:assert');
const { dexZone, gridBookHealth, pm2Changes, recentFills, createAlerter } = require('./checks');

test('dexZone: below / near / ok around a $7 floor, 3% near band', () => {
  assert.strictEqual(dexZone(6.99, 7, 3), 'below');
  assert.strictEqual(dexZone(7.00, 7, 3), 'near');
  assert.strictEqual(dexZone(7.20, 7, 3), 'near');
  assert.strictEqual(dexZone(7.21, 7, 3), 'ok');
  assert.strictEqual(dexZone(NaN, 7, 3), 'unknown');
});

const order = (side, price, usd, cid = 'grid_1') => ({ side, price, amount: usd / price, clientOrderId: cid });

test('gridBookHealth: a healthy grid has no problems', () => {
  const orders = [
    order('buy', 6.97, 300), order('buy', 6.96, 220),
    order('sell', 7.03, 300), order('sell', 7.04, 300),
    order('buy', 6.50, 1000, 'web_manual') // manual order: ignored
  ];
  const h = gridBookHealth(orders, { minDepthUsd: 500 });
  assert.deepStrictEqual(h.problems, []);
  assert.strictEqual(h.buys, 2);
  assert.strictEqual(h.sells, 2);
  assert.ok(Math.abs(h.buyDepth - 520) < 1e-6);
  assert.ok(h.spreadPct < 1);
});

test('gridBookHealth: empty sell side (27 Oct screenshot)', () => {
  const h = gridBookHealth([order('buy', 7.1365, 20), order('buy', 7.1361, 45)], { minDepthUsd: 500 });
  assert.ok(h.problems.includes('no grid SELL orders'));
  assert.strictEqual(h.mid, null);
});

test('gridBookHealth: thin depth and wide spread', () => {
  const h = gridBookHealth([order('buy', 7.0, 100), order('sell', 7.2, 600)], { minDepthUsd: 500, maxSpreadPct: 1 });
  assert.ok(h.problems.some((p) => p.startsWith('buy depth within 1% $0 ')));
  assert.ok(h.problems.some((p) => p.startsWith('spread 2.86%')));
});

test('gridBookHealth: counts only the unfilled remainder', () => {
  const o = { ...order('sell', 7.03, 700), remaining: 100 / 7.03 };
  const h = gridBookHealth([order('buy', 7.0, 600), o], { minDepthUsd: 500 });
  assert.ok(Math.abs(h.sellDepth - 100) < 1e-6);
  assert.ok(h.problems.some((p) => p.startsWith('sell depth')));
});

test('pm2Changes: down, back up, restart, removed; new apps need a baseline', () => {
  const prev = { grid: { status: 'online', restarts: 17 }, pattern: { status: 'stopped', restarts: 5 }, qdex: { status: 'online', restarts: 1 }, old: { status: 'online', restarts: 0 } };
  const curr = { grid: { status: 'stopped', restarts: 17 }, pattern: { status: 'online', restarts: 6 }, qdex: { status: 'online', restarts: 3 }, fresh: { status: 'online', restarts: 0 } };
  const kinds = Object.fromEntries(pm2Changes(prev, curr).map((e) => [e.name, e.kind]));
  assert.deepStrictEqual(kinds, { grid: 'down', pattern: 'up', qdex: 'restart', old: 'gone' });
  assert.deepStrictEqual(pm2Changes(curr, curr), []);
});

test('recentFills: sums per side inside the window only', () => {
  const now = 1_000_000;
  const w = recentFills([
    { at: now - 11 * 60000, side: 'sell', usd: 500 }, // outside 10 min
    { at: now - 5 * 60000, side: 'sell', usd: 80 },
    { at: now - 1 * 60000, side: 'sell', usd: 40 },
    { at: now, side: 'buy', usd: 20 }
  ], now, 10 * 60000);
  assert.strictEqual(w.sellUsd, 120);
  assert.strictEqual(w.buyUsd, 20);
  assert.strictEqual(w.kept.length, 3);
});

test('createAlerter: once per cooldown, recovery sent once', async () => {
  let t = 0; const sent = [];
  const a = createAlerter({ send: async (m) => sent.push(m), cooldownMs: 1000, now: () => t });
  assert.strictEqual(await a.raise('k', 'down'), true);
  assert.strictEqual(await a.raise('k', 'down'), false);   // within cooldown
  t = 1000;
  assert.strictEqual(await a.raise('k', 'down'), true);    // cooldown passed: reminder
  assert.strictEqual(await a.clear('k', 'up'), true);
  assert.strictEqual(await a.clear('k', 'up'), false);     // not active any more
  assert.strictEqual(await a.clear('never', 'x'), false);
  assert.deepStrictEqual(sent, ['down', 'down', 'up']);
});
