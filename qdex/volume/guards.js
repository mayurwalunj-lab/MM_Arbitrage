'use strict';

// Rate limiting, emergency stop and the pre-trade safety checks.
//
// The emergency stop has four independent paths, deliberately — any one of them
// halts the harness before the next trade is opened:
//   1. SIGINT / SIGTERM     graceful drain
//   2. a stop FILE          `touch $QVT_STOP_FILE` from any other shell or cron
//   3. auto-breakers        consecutive tx failures, RPC failure streak
//   4. session budgets      max transactions, max notional, max runtime

const fs = require('fs');

// Single-instance lock. Two bots sharing one epoch would draw the same nonce for
// the same wallet at the same time: one transaction replaces the other, or both
// fail. Nothing else in the design prevents that, so it is prevented here.
// A lock whose PID is no longer alive is treated as stale and taken over — a
// crashed process must not require manual cleanup before the bot can restart.
function acquireLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const prev = JSON.parse(raw);
    let alive = false;
    try { process.kill(prev.pid, 0); alive = true; } catch { alive = false; }
    if (alive) {
      return { ok: false, holder: prev, reason: `pid ${prev.pid} is still running (started ${prev.startedAt})` };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Unreadable or corrupt lock: safest to overwrite it, but say so.
      if (e instanceof SyntaxError) { /* fall through and take the lock */ }
      else return { ok: false, holder: null, reason: `cannot read lock file: ${e.message}` };
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  return { ok: true };
}

function releaseLock(lockPath) {
  try {
    const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (prev.pid === process.pid) fs.unlinkSync(lockPath);
  } catch { /* nothing to release */ }
}

// Sliding-window limiter. A fixed bucket would allow 2x the cap across a window
// boundary; this counts the trailing hour exactly.
class RateLimiter {
  constructor(maxPerHour) {
    this.max = Math.max(1, maxPerHour);
    this.hits = [];
  }
  _prune(now) {
    const cutoff = now - 3600000;
    while (this.hits.length && this.hits[0] < cutoff) this.hits.shift();
  }
  // ms to wait before another action is allowed (0 = go now)
  waitMs(now = Date.now()) {
    this._prune(now);
    if (this.hits.length < this.max) return 0;
    return Math.max(0, this.hits[0] + 3600000 - now);
  }
  record(now = Date.now()) { this.hits.push(now); }
  countLastHour(now = Date.now()) { this._prune(now); return this.hits.length; }
}

class StopController {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.stopped = false;
    this.reason = null;
    this.consecutiveFailures = 0;
    this.consecutiveRpcErrors = 0;
    this.startedAt = Date.now();
    this.txCount = 0;
    this.notionalWl1x = 0;
    this._handlers = [];
  }
  installSignalHandlers() {
    const onSig = (sig) => () => this.trip(`signal ${sig}`);
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const h = onSig(sig);
      process.on(sig, h);
      this._handlers.push([sig, h]);
    }
  }
  removeSignalHandlers() { this._handlers.forEach(([s, h]) => process.off(s, h)); this._handlers = []; }

  trip(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.reason = reason;
    this.log(`EMERGENCY STOP — ${reason}`);
  }
  recordSuccess(notionalWl1x = 0) {
    this.consecutiveFailures = 0;
    this.consecutiveRpcErrors = 0;
    this.txCount++;
    this.notionalWl1x += notionalWl1x;
  }
  recordFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.trip(`${this.consecutiveFailures} consecutive transaction failures`);
    }
  }
  // Transient RPC errors are deliberately NOT counted as transaction failures —
  // the swap was never the problem and retrying is correct. But an RPC that is
  // simply down would otherwise spin forever without anyone being told, so a long
  // unbroken streak trips the stop on its own.
  recordRpcError() {
    this.consecutiveRpcErrors++;
    const limit = this.config.maxConsecutiveRpcErrors || 0;
    if (limit > 0 && this.consecutiveRpcErrors >= limit) {
      this.trip(`${this.consecutiveRpcErrors} consecutive RPC failures — the endpoint looks down`);
    }
  }
  // Checked before every trade. Returns true when the loop must exit.
  shouldStop() {
    if (this.stopped) return true;
    const c = this.config;
    if (c.stopFile && fs.existsSync(c.stopFile)) { this.trip(`stop file present: ${c.stopFile}`); return true; }
    if (c.maxSessionTx > 0 && this.txCount >= c.maxSessionTx) { this.trip(`session transaction budget reached (${c.maxSessionTx})`); return true; }
    if (c.maxSessionNotionalWl1x > 0 && this.notionalWl1x >= c.maxSessionNotionalWl1x) { this.trip(`session notional budget reached (${c.maxSessionNotionalWl1x} WL1X)`); return true; }
    if (c.maxRuntimeMin > 0 && Date.now() - this.startedAt >= c.maxRuntimeMin * 60000) { this.trip(`max runtime reached (${c.maxRuntimeMin} min)`); return true; }
    return false;
  }
}

// Per-pool anchor price. The anchor is what "unmanipulated" means for this
// session: trades are allowed to wander around it inside the band, and the side
// bias pulls back toward it when they don't.
class AnchorBook {
  constructor(config) { this.config = config; this.anchors = new Map(); }
  set(poolAddress, px) { this.anchors.set(poolAddress.toLowerCase(), px); }
  get(poolAddress) { return this.anchors.get(poolAddress.toLowerCase()) ?? null; }
  seedIfAbsent(poolAddress, px) {
    if (this.get(poolAddress) == null && px > 0) this.set(poolAddress, px);
    return this.get(poolAddress);
  }
  deviationPct(poolAddress, px) {
    const a = this.get(poolAddress);
    if (!a || !(px > 0)) return 0;
    return ((px - a) / a) * 100;
  }
}

// Choose a side. Two pulls, both toward stability:
//   - inventory: a wallet holding only WL1X can only buy; one holding mostly
//     token should sell. This is what makes epoch 1 open sanely without any
//     special-case seeding code.
//   - price: if the pool has drifted outside the band, force the corrective side.
// `biasStrength` (0..1) sets how strongly inventory tilts an otherwise coin-flip.
function chooseSide({ wl1xValue, tokenValue, deviationPct, config, rng = Math.random }) {
  const band = config.maxDeviationPct;
  if (deviationPct < -band) return { side: 'sell', reason: `pool ${deviationPct.toFixed(2)}% below anchor — forced SELL` };
  if (deviationPct > band) return { side: 'buy', reason: `pool ${deviationPct.toFixed(2)}% above anchor — forced BUY` };

  const total = wl1xValue + tokenValue;
  if (!(total > 0)) return { side: 'buy', reason: 'no inventory' };
  const wl1xShare = wl1xValue / total;
  const target = config.inventoryTargetPct / 100;
  // Over-weight WL1X -> lean buy. p is the probability of picking BUY.
  const tilt = (wl1xShare - target) * config.biasStrength;
  const p = Math.min(0.98, Math.max(0.02, 0.5 + tilt));
  const side = rng() < p ? 'buy' : 'sell';
  return { side, reason: `inventory ${(wl1xShare * 100).toFixed(0)}% WL1X (target ${config.inventoryTargetPct}%), p(buy)=${p.toFixed(2)}` };
}

// Narrow a loaded market list to the focused pools. A focus can name either the
// pool label (L1USD) or its address, case-insensitively. Returning the FULL list
// when nothing matches is deliberate: a typo in QVT_FOCUS_POOLS should not leave
// the bot silently unable to trade anything. The caller warns on fallback.
function applyPoolFocus(markets, focus) {
  if (!focus || !focus.length) return { markets, focused: false, fellBack: false };
  const want = new Set(focus.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const hit = markets.filter((m) =>
    want.has(String(m.cfg.label).toLowerCase()) || want.has(String(m.address).toLowerCase()));
  if (!hit.length) return { markets, focused: false, fellBack: true };
  return { markets: hit, focused: true, fellBack: false };
}

// Same idea for wallets: take the first N of the roster, and fall back to the
// whole roster rather than an empty set if N is nonsense.
function applyWalletLimit(signers, n) {
  if (!n || n <= 0 || n >= signers.length) return { signers, limited: false };
  return { signers: signers.slice(0, n), limited: true };
}

// Weighted pick without replacement bias — used for pool selection so a $2M pool
// gets proportionally more traffic than a $26K one.
function weightedPick(items, weightOf, rng = Math.random) {
  const ws = items.map((x) => Math.max(0, weightOf(x) || 0));
  const total = ws.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return items[Math.floor(rng() * items.length)];
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

const randBetween = (lo, hi, rng = Math.random) => lo + rng() * (hi - lo);
// Log-uniform: without this, "random between 0.05 and 1.0" is 0.5 on average and
// almost never small. Log-uniform spreads sizes evenly across the magnitudes.
function logUniform(lo, hi, rng = Math.random) {
  if (!(lo > 0) || !(hi > lo)) return lo;
  return Math.exp(randBetween(Math.log(lo), Math.log(hi), rng));
}

module.exports = { RateLimiter, StopController, AnchorBook, chooseSide, weightedPick, randBetween, logUniform, acquireLock, releaseLock, applyPoolFocus, applyWalletLimit };
