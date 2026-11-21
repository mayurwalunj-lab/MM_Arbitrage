'use strict';

// Pure alert rules for the alerts monitor — no I/O, so they can be tested directly.

// Where the DEX price sits relative to the floor.
//   below: under the floor; near: within nearPct above it; ok: above that.
function dexZone(price, floor, nearPct) {
  if (!(price > 0) || !(floor > 0)) return 'unknown';
  if (price < floor) return 'below';
  if (price < floor * (1 + nearPct / 100)) return 'near';
  return 'ok';
}

// Split the inclusive block range [from, to] into [a, b] pieces of at most
// `size` blocks each, for RPCs that cap the eth_getLogs range.
function blockChunks(from, to, size) {
  const out = [];
  for (let a = from; a <= to; a += size) out.push([a, Math.min(a + size - 1, to)]);
  return out;
}

// Health of the grid's own book from its open orders. Only orders whose client
// id starts with `prefix` are counted (manual orders are ignored). Depth is the
// USDT value of grid orders within 1% of the mid between the best grid bid/ask.
// topBuys / topSells: the `top` grid orders nearest the mid on each side.
function gridBookHealth(orders, { prefix = 'grid_', minDepthUsd = 500, maxSpreadPct = 1, top = 3 } = {}) {
  const grid = (orders || []).filter((o) => {
    const cid = o.clientOrderId || (o.info && o.info.custom_id);
    return typeof cid === 'string' && cid.startsWith(prefix);
  });
  const px = (o) => Number(o.price);
  const left = (o) => Number(o.remaining != null ? o.remaining : o.amount) || 0;
  const buys = grid.filter((o) => o.side === 'buy');
  const sells = grid.filter((o) => o.side === 'sell');
  const bestBid = buys.length ? Math.max(...buys.map(px)) : null;
  const bestAsk = sells.length ? Math.min(...sells.map(px)) : null;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
  const depth = (arr, inside) => arr.filter((o) => inside(px(o))).reduce((t, o) => t + px(o) * left(o), 0);
  const buyDepth = mid ? depth(buys, (p) => p >= mid * 0.99) : 0;
  const sellDepth = mid ? depth(sells, (p) => p <= mid * 1.01) : 0;
  const spreadPct = bestBid && bestAsk ? (bestAsk / bestBid - 1) * 100 : null;

  const problems = [];
  if (!buys.length) problems.push('no grid BUY orders');
  if (!sells.length) problems.push('no grid SELL orders');
  if (mid && buyDepth < minDepthUsd) problems.push(`buy depth within 1% $${buyDepth.toFixed(0)} < $${minDepthUsd}`);
  if (mid && sellDepth < minDepthUsd) problems.push(`sell depth within 1% $${sellDepth.toFixed(0)} < $${minDepthUsd}`);
  if (spreadPct != null && spreadPct > maxSpreadPct) problems.push(`spread ${spreadPct.toFixed(2)}% > ${maxSpreadPct}%`);

  // nearest grid orders to the mid: highest buys, lowest sells
  const row = (o) => ({ price: px(o), amount: left(o), usd: px(o) * left(o) });
  const topBuys = buys.map(row).sort((a, b) => b.price - a.price).slice(0, top);
  const topSells = sells.map(row).sort((a, b) => a.price - b.price).slice(0, top);

  return { buys: buys.length, sells: sells.length, bestBid, bestAsk, mid, buyDepth, sellDepth, spreadPct, problems, topBuys, topSells };
}

// pm2 changes between two snapshots ({ name: { status, restarts } }).
// Reports an app that left 'online', came back, restarted, or disappeared.
function pm2Changes(prev, curr) {
  const events = [];
  for (const [name, c] of Object.entries(curr)) {
    const p = prev[name];
    if (!p) continue; // new app: no baseline yet
    if (p.status === 'online' && c.status !== 'online') events.push({ name, kind: 'down', text: `${name} is ${c.status.toUpperCase()}` });
    else if (p.status !== 'online' && c.status === 'online') events.push({ name, kind: 'up', text: `${name} is back ONLINE` });
    else if (c.restarts > p.restarts) events.push({ name, kind: 'restart', text: `${name} restarted (${c.restarts - p.restarts}x, total ${c.restarts})` });
  }
  for (const name of Object.keys(prev)) {
    if (!curr[name]) events.push({ name, kind: 'gone', text: `${name} was removed from pm2` });
  }
  return events;
}

// Sum of fills in the last windowMs. fills: [{ at (ms), side, usd }].
function recentFills(fills, nowMs, windowMs) {
  const inWindow = fills.filter((f) => nowMs - f.at <= windowMs);
  const sum = (side) => inWindow.filter((f) => f.side === side).reduce((t, f) => t + f.usd, 0);
  return { kept: inWindow, buyUsd: sum('buy'), sellUsd: sum('sell'), count: inWindow.length };
}

// "3h 12m", "23m", "45s", "4d 2h" for a number of seconds.
function fmtAgo(sec) {
  if (sec == null || !Number.isFinite(sec)) return 'unknown';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

// Why a bot isn't trading, from its own log lines. Checked newest line first;
// the first line matching any rule wins. kind 'room' = no price room to trade.
const REASON_RULES = [
  ['room', 'no trade room', /No trade room/i],
  ['room', 'best ask below the floor (gatekeeper)', /GATEKEEPER/],
  ['frozen', 'price band frozen', /Band frozen/i],
  ['funds', 'not enough balance', /Funds low|insufficient|not enough|Send ~[\d.]+ WL1X/i],
  ['stopped', 'engine stopped', /ENGINE STOPPED|STOP file|HALT/],
  ['api', 'exchange / RPC unreachable', /Failed to connect|fetch failed|ENOTFOUND|EAI_AGAIN|Could not resolve|ECONNRESET|ETIMEDOUT|Gateway Time-out|nonsupport|Too Many Requests|\b429\b/i],
  ['price', 'price source stale / unreadable', /stale|unreadable|no price|gap to Uniswap/i],
  ['paused', 'swaps paused after failures', /swaps paused/i],
  ['failed', 'orders failing', /ABORT|Aborting|Fills not confirmed|Maker Failed|Taker Failed|swap failed|FAILED/],
  ['error', 'error', /FATAL|❌|\bError\b/]
];

function lastReason(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripAnsi(lines[i]).trim();
    if (!line) continue;
    for (const [kind, label, re] of REASON_RULES) {
      if (re.test(line)) return { kind, label, line: line.slice(0, 220) };
    }
  }
  return null;
}

// Restarts at or after (nowMs - windowMs), from a list of restart times (ms).
function recentRestarts(times, nowMs, windowMs) {
  return times.filter((t) => nowMs - t <= windowMs);
}

// Alert de-duplication: the same key fires at most once per cooldown while the
// problem lasts, and a recovery message is sent once when it clears. A raise can
// pass its own { cooldownMs } (e.g. hourly reminders for long outages).
function createAlerter({ send, cooldownMs = 30 * 60 * 1000, now = () => Date.now() }) {
  const active = new Map(); // key -> last sent ms
  return {
    async raise(key, text, opts = {}) {
      const last = active.get(key);
      const wait = opts.cooldownMs != null ? opts.cooldownMs : cooldownMs;
      if (last != null && now() - last < wait) return false;
      active.set(key, now());
      await send(text);
      return true;
    },
    async clear(key, text) {
      if (!active.has(key)) return false;
      active.delete(key);
      if (text) await send(text);
      return true;
    },
    isActive(key) { return active.has(key); }
  };
}

module.exports = {
  dexZone, blockChunks, gridBookHealth, pm2Changes, recentFills, createAlerter,
  fmtAgo, stripAnsi, lastReason, recentRestarts
};
