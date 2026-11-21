'use strict';

// Run: node --test alerts/checks.test.js
const test = require('node:test');
const assert = require('node:assert');
const { dexZone, blockChunks, gridBookHealth, pm2Changes, recentFills, createAlerter, fmtAgo, lastReason, recentRestarts } = require('./checks');

test('dexZone: below / near / ok around a $7 floor, 3% near band', () => {
  assert.strictEqual(dexZone(6.99, 7, 3), 'below');
  assert.strictEqual(dexZone(7.00, 7, 3), 'near');
  assert.strictEqual(dexZone(7.20, 7, 3), 'near');
  assert.strictEqual(dexZone(7.21, 7, 3), 'ok');
  assert.strictEqual(dexZone(NaN, 7, 3), 'unknown');
});

test('blockChunks: pieces of at most 10 blocks covering the whole range', () => {
  assert.deepStrictEqual(blockChunks(100, 104, 10), [[100, 104]]);
  assert.deepStrictEqual(blockChunks(100, 124, 10), [[100, 109], [110, 119], [120, 124]]);
  assert.deepStrictEqual(blockChunks(100, 109, 10), [[100, 109]]);
  assert.deepStrictEqual(blockChunks(105, 104, 10), []);
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
  assert.deepStrictEqual(h.topBuys.map((o) => o.price), [6.97, 6.96]);  // highest first, manual order left out
  assert.deepStrictEqual(h.topSells.map((o) => o.price), [7.03, 7.04]); // lowest first
  assert.ok(Math.abs(h.topBuys[0].usd - 300) < 1e-6);
});

test('gridBookHealth: the 3 nearest orders per side', () => {
  const buys = [6.9, 6.95, 6.97, 6.93].map((p) => order('buy', p, 50));
  const sells = [7.1, 7.02, 7.05, 7.3].map((p) => order('sell', p, 50));
  const h = gridBookHealth(buys.concat(sells));
  assert.deepStrictEqual(h.topBuys.map((o) => o.price), [6.97, 6.95, 6.93]);
  assert.deepStrictEqual(h.topSells.map((o) => o.price), [7.02, 7.05, 7.1]);
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

test('fmtAgo: seconds, minutes, hours, days', () => {
  assert.strictEqual(fmtAgo(45), '45s');
  assert.strictEqual(fmtAgo(23 * 60 + 10), '23m');
  assert.strictEqual(fmtAgo(3 * 3600 + 12 * 60), '3h 12m');
  assert.strictEqual(fmtAgo(110 * 86400 + 5 * 3600), '110d 5h');
  assert.strictEqual(fmtAgo(null), 'unknown');
});

test('lastReason: newest matching line wins; info spam is skipped; colours stripped', () => {
  const room = '\x1b[90m[12:19:06]\x1b[0m \x1b[33m⚠️ No trade room. Spread 7.0001-7.0400 outside fence [$6.98-$7.02] or tighter than buffer.\x1b[0m';
  const band = '\x1b[90m[12:19:11]\x1b[0m \x1b[36m📊 BAND center $7.0000 [$6.9755–$7.0245] DEX $7.0734\x1b[0m';
  const r = lastReason(['[12:00:00] ❌ Maker Failed: timeout', room, band, band]);
  assert.strictEqual(r.kind, 'room');
  assert.ok(r.line.startsWith('[12:19:06] ⚠️ No trade room'));
  assert.strictEqual(lastReason(['[23:39:54] [GRID] ❌ Failed to connect: bitmart GET https://api-cloud.bitmart.com fetch failed']).kind, 'api');
  assert.strictEqual(lastReason(['🛑 GATEKEEPER: Best Ask (6.9) < floor ($7.0000). Waiting.']).kind, 'room');
  assert.strictEqual(lastReason(['🛑 ENGINE STOPPED.']).kind, 'stopped');
  assert.strictEqual(lastReason(['epoch 21: parent holds 0.4767 WL1X — Send ~16.75 WL1X to 0x1471']).kind, 'funds');
  assert.strictEqual(lastReason(['backend price unreadable']).kind, 'price');
  assert.strictEqual(lastReason(['📊 BAND center', '']), null);
});

test('recentRestarts: only restarts inside the window', () => {
  const now = 1_000_000;
  assert.deepStrictEqual(recentRestarts([now - 11 * 60000, now - 9 * 60000, now], now, 10 * 60000), [now - 9 * 60000, now]);
});

test('createAlerter: a raise can use its own cooldown', async () => {
  let t = 0; const sent = [];
  const a = createAlerter({ send: async (m) => sent.push(m), cooldownMs: 1000, now: () => t });
  await a.raise('idle', 'x', { cooldownMs: 5000 });
  t = 2000;
  assert.strictEqual(await a.raise('idle', 'x', { cooldownMs: 5000 }), false);
  t = 5000;
  assert.strictEqual(await a.raise('idle', 'x', { cooldownMs: 5000 }), true);
});
