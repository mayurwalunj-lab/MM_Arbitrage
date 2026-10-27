'use strict';

// SHARED DYNAMIC PRICE BAND ENGINE
// Computes a CEX price band that follows the DEX (Uniswap L1X/WETH) price, so the
// CEX volume bots and grids can track the DEX instead of a fixed box. One shared
// source of truth → the pattern bots, the grids, and (indirectly) the treasury
// all read the same center and never fight.
//
// Safety layers (see docs/price-maintenance-plan.md):
//   - EMA smoothing (9 EMA, alpha 0.2) on the DEX price
//   - max-move-per-update cap (1%/refresh) — the center eases, never jumps
//   - freeze-beyond-threshold — stop following if DEX is > FOLLOW_MAX_PCT from CEX
//   - absolute min/max clamp — the center can never leave a sane fence
//   - staleness freeze + last-good-band fallback on DEX read failure
//   - master switch DYNAMIC_BAND (off = callers keep their fixed band)
//
// The engine keeps in-memory state and only hits the DEX every BAND_REFRESH_MS;
// getBand() returns the cached band on every tick in between.

const uni = require('../uniswap/lib');

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function config() {
  const innerSpreadPct = Math.min(num('BAND_INNER_SPREAD_PCT', 0.7), 1.0); // HARD cap 1%
  return {
    enabled: (process.env.DYNAMIC_BAND || '').toLowerCase() === 'true',
    refreshMs: num('BAND_REFRESH_MS', 600000),      // 10 min
    alpha: num('BAND_SMOOTHING_ALPHA', 0.2),        // 9 EMA
    maxMovePct: num('BAND_MAX_MOVE_PCT', 1.0),      // per refresh
    followMaxPct: num('BAND_FOLLOW_MAX_PCT', 5),    // freeze beyond this DEX↔CEX gap
    // Center the band this % BELOW the DEX (0 = on the DEX). With it set, an
    // arbitrageur's profitable direction is buy on the CEX, sell on the DEX, so
    // our CEX buys are never sold into from the DEX. Clamped to 0-20.
    dexOffsetPct: clamp(num('BAND_DEX_OFFSET_PCT', 0), 0, 20),
    // Where the center starts after a (re)start:
    //   cex (default) — the CEX price, then ease toward the target ≤ maxMovePct per
    //                   refresh. A restart never jumps the book.
    //   target        — straight at the target (DEX EMA minus dexOffsetPct), for
    //                   when the price is being moved on purpose. Falls back to cex
    //                   when the target is a gap the band would freeze on.
    seed: (process.env.BAND_SEED || '').toLowerCase() === 'target' ? 'target' : 'cex',
    // Treasury only SELLS (lifts the DEX when it runs high), so it covers the
    // UPSIDE gap. On the downside nobody buys, so freezing there would leave the
    // CEX stranded above the market. With this true, we only freeze on the upside
    // and let the band ease DOWN to BAND_ABS_MIN and hold there instead.
    freezeUpsideOnly: (process.env.BAND_FREEZE_UPSIDE_ONLY || '').toLowerCase() === 'true',
    innerSpreadPct,                                 // grid buy↔sell gap (≤1%)
    absMin: num('BAND_ABS_MIN', 5),
    absMax: num('BAND_ABS_MAX', 20),
    staleMs: num('BAND_STALE_MS', 300000),
    fallbackCenter: num('BAND_FALLBACK_CENTER', 8.5)
  };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// in-memory state (per process)
const state = { ema: null, center: null, lastReadMs: 0, lastGoodDex: null, lastBand: null };
let refreshing = null;

function isEnabled() { return config().enabled; }

// Build the band object from a center + config. halfSpread each side, capped so
// the buy↔sell inner spread never exceeds 1%.
function buildBand(center, c) {
  const half = (Math.min(c.innerSpreadPct, 1.0) / 2) / 100; // 0.7% -> 0.0035
  const highestBuy = center * (1 - half);
  const lowestSell = center * (1 + half);
  return {
    center,
    highestBuy,
    lowestSell,
    floor: highestBuy,        // volume/pattern bot box lower bound
    resistance: lowestSell,   // volume/pattern bot box upper bound
    minAsk: highestBuy,       // gatekeeper (min best-ask to trade)
    innerSpreadPct: c.innerSpreadPct
  };
}

// Read the live DEX L1X price (USD) from the Uniswap pool.
let _mockDex = null; // test seam only
async function readDexPrice() {
  if (_mockDex != null) return _mockDex;
  const cfg = uni.getConfig();
  const provider = uni.getProvider(cfg);
  const market = await uni.loadMarket(cfg, provider);
  const eth = await uni.resolveEthUsdPrice({ config: cfg, log: () => {} });
  const price = uni.poolL1xUsdPrice({
    sqrtPriceX96: market.pool.sqrtPriceX96, pool: market.pool,
    l1x: market.l1x, weth: market.weth, ethUsdPrice: eth.price
  });
  if (!(price > 0)) throw new Error('DEX price not positive');
  return price;
}

// Do one refresh: read DEX, update EMA, move the center (capped/clamped/frozen).
// cexRef = the caller's current CEX mid price (seeds the center on first run so a
// restart doesn't jump, and is the reference for the freeze-beyond check).
async function refresh(cexRef, c) {
  let dex;
  try {
    dex = await readDexPrice();
  } catch (e) {
    // DEX read failed → keep the last good band (frozen); seed a safe one if none.
    if (!state.lastBand) {
      const seed = clamp(cexRef || c.fallbackCenter, c.absMin, c.absMax);
      state.center = seed;
      state.lastBand = { ...buildBand(seed, c), dexPrice: null, dexEma: null, cexRef: cexRef || null };
    }
    state.lastBand = { ...state.lastBand, frozen: true, reason: 'dex-read-failed: ' + String(e.message).slice(0, 50), moved: false };
    return state.lastBand;
  }

  const now = Date.now();
  state.lastGoodDex = dex;
  state.lastReadMs = now;

  // EMA of the DEX price; the band aims dexOffsetPct below it
  state.ema = (state.ema == null) ? dex : (c.alpha * dex + (1 - c.alpha) * state.ema);
  const target = state.ema * (1 - c.dexOffsetPct / 100);

  // freeze-beyond: if the DEX (EMA) runs too far from the CEX, don't chase it.
  // signedPct > 0 means DEX is ABOVE the CEX (upside), < 0 means BELOW (downside).
  const ref = (cexRef && cexRef > 0) ? cexRef : (state.center != null ? state.center : dex);
  const signedPct = (target - ref) / ref * 100;
  const divPct = Math.abs(signedPct);
  let frozen = false, moved = false, reason = 'ok';

  // Upside break is always the treasury's job (it SELLS to pull the DEX down) → freeze.
  // Downside break: freeze only if freezeUpsideOnly is off. With it ON, we DON'T freeze
  // on the downside — the band eases down and holds at BAND_ABS_MIN, because the
  // treasury does not buy the dip and a frozen CEX would just sit above the market.
  const upsideBreak = signedPct > c.followMaxPct;
  const downsideBreak = signedPct < -c.followMaxPct;
  const wouldFreeze = upsideBreak || (downsideBreak && !c.freezeUpsideOnly);

  // seed the center on first run: from the CEX (no jump on restart), or straight
  // at the target with BAND_SEED=target unless that is a gap we would freeze on.
  let seeded = null;
  if (state.center == null) {
    seeded = (c.seed === 'target' && !wouldFreeze) ? 'target' : 'cex';
    state.center = clamp(seeded === 'target' ? target : (cexRef || dex), c.absMin, c.absMax);
  }
  let center = state.center;
  if (wouldFreeze) {
    frozen = true;
    reason = `frozen: DEX ${divPct.toFixed(2)}% ${signedPct > 0 ? 'above' : 'below'} CEX > ${c.followMaxPct}% (treasury handles it)`;
  } else {
    // move the center toward the target, capped by maxMovePct of the center
    const maxStep = center * (c.maxMovePct / 100);
    const delta = target - center;
    const step = clamp(delta, -maxStep, maxStep);
    if (step !== 0) moved = true;
    center = clamp(center + step, c.absMin, c.absMax);
    state.center = center;
    if (seeded === 'target') { moved = true; reason = 'started at target (BAND_SEED=target)'; }
    if (center === c.absMin) reason = 'holding at absolute floor (BAND_ABS_MIN)';
    else if (center === c.absMax) reason = 'holding at absolute ceiling (BAND_ABS_MAX)';
  }

  state.lastBand = { ...buildBand(center, c), dexPrice: dex, dexEma: state.ema, target, cexRef: ref, frozen, moved, reason };
  return state.lastBand;
}

// Public: return the current band. Refreshes from the DEX at most every
// refreshMs; returns the cached band in between. cexRef = caller's current CEX
// mid price (optional but recommended — seeds + freeze reference).
async function getBand(cexRef) {
  const c = config();
  const now = Date.now();
  if (state.lastBand && (now - state.lastReadMs) < c.refreshMs) return state.lastBand;
  if (refreshing) return refreshing;
  refreshing = refresh(cexRef, c).finally(() => { refreshing = null; });
  return refreshing;
}

// Last computed band without triggering a refresh (for logging).
function getBandSync() { return state.lastBand; }

// For tests: reset in-memory state.
function _reset() { state.ema = null; state.center = null; state.lastReadMs = 0; state.lastGoodDex = null; state.lastBand = null; refreshing = null; }

function _setMockDex(v) { _mockDex = v; }

module.exports = { config, isEnabled, getBand, getBandSync, buildBand, readDexPrice, _reset, _setMockDex };
