#!/usr/bin/env node

'use strict';

// QDEX MARKET MAKER — hold the QDex pool price at a fixed target.
//
// Every tick: read the pool price, compare to QDEX_TARGET_PRICE. If it drifted
// above target+band -> SELL base into the pool (push price down). If below
// target-band -> BUY base (push price up). Within the band -> do nothing.
//
//   node qdex/qdex_mm.js            dry-run loop (simulate, no swaps)
//   node qdex/qdex_mm.js --once     single tick
//   node qdex/qdex_mm.js --execute  LIVE (real swaps) — or QDEX_EXECUTE=true
//
// Safety: dry-run is the default. Live requires --execute OR QDEX_EXECUTE=true.
// Per-run size is capped by QDEX_MAX_TRADE_BASE.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const lib = require('./lib');
const db = require('./db');
const guards = require('./guards');
const backendPrice = require('./backend_price');
const priceBand = require('../shared/price_band');

const execute = process.argv.includes('--execute') ||
  (process.env.QDEX_EXECUTE || '').toLowerCase() === 'true';
const once = process.argv.includes('--once');
const pollMs = Number(process.env.QDEX_POLL_MS) || 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// Breaker confirmation: a >maxDeviation reading must persist this many
// consecutive ticks before we act on it — filters out a transient oracle glitch
// / momentary spike. If it stays off that long, it's real -> correct it.
const breakerConfirmTicks = Number(process.env.QDEX_BREAKER_CONFIRM_TICKS) || 3;
let breachCount = 0;

// Set up in main() from config: pauses swaps after repeated failures.
let backoff = null;

// WL1X USD price from the configured source, plus the record used for the
// freshness check. backend_db errors (DB unreachable) come back as `error`.
async function readWl1xPrice(config, provider, market) {
  if (config.priceSource === 'backend_db') {
    try {
      const r = await backendPrice.getBackendPrice(config.backendPriceKey);
      return { label: 'backend price', maxAgeSec: config.backendMaxAgeSec, price: r ? r.price : null, record: r, checkDexGap: true };
    } catch (e) {
      return { label: 'backend price', error: String(e.message).slice(0, 120) };
    }
  }
  // The oracle keeps returning its last price if its feeder stops, so its
  // update time is read too (latestPriceData) and checked before trusting it.
  const price = await lib.getOraclePrice(config, provider, market.base.address);
  return { label: 'oracle', maxAgeSec: config.oracleMaxAgeSec, price, record: await lib.getOracleRecord(config, provider, market.base.address), checkDexGap: false };
}

async function tick() {
  const config = lib.getConfig();
  const pegMode = config.xusdPeg > 0;
  // accounting record — filled progressively, written on every tick (non-fatal)
  const rec = { mode: pegMode ? 'peg' : 'fixed', isDryRun: !execute, correctTo: config.correctTo, peg: pegMode ? config.xusdPeg : null };
  const record = async (status, note) => {
    rec.status = status; if (note) rec.note = note;
    try { await db.insertAction(rec); } catch (e) { log(`WARN not recorded: ${String(e.message).slice(0, 120)}`); }
  };

  if (!pegMode && (!config.targetPrice || config.targetPrice <= 0)) {
    log('Neither QDEX_XUSD_PEG nor QDEX_TARGET_PRICE set — nothing to hold. Skipping.');
    await record('skipped', 'no peg/target set');
    return;
  }
  const provider = lib.getProvider(config);

  // 1. read pool state once + current price (quote per base = XUSD per WL1X)
  const market = await lib.loadPool(config, provider);
  const price = lib.priceFromSqrt(market);
  rec.pair = `${market.base.symbol}/${market.quote.symbol}`;
  rec.poolRatio = price;

  // 2. figure out the TARGET pool ratio + circuit breaker.
  let target, pegInfo = '';
  if (pegMode) {
    const src = await readWl1xPrice(config, provider, market);
    if (src.error) { log(`ALERT: ${src.label} unreadable (${src.error}) — skipping.`); breachCount = 0; await record('skipped', `${src.label} unreadable`); return; }
    const oracleWL1X = src.price;
    if (!(oracleWL1X > 0)) { log(`${src.label} returned no WL1X price — skipping.`); await record('skipped', `${src.label} no price`); return; }
    rec.oracleWl1xUsd = oracleWL1X;
    const xusdPrice = oracleWL1X / price;                 // current XUSD in USD
    rec.xusdPrice = xusdPrice;
    const devPct = ((xusdPrice - config.xusdPeg) / config.xusdPeg) * 100;
    rec.deviationPct = devPct;
    pegInfo = `XUSD=$${xusdPrice.toFixed(5)} (peg $${config.xusdPeg}, dev ${devPct.toFixed(3)}%) | WL1X ${src.label}=$${oracleWL1X.toFixed(4)}`;
    // Check how old the price is before trusting it (and before the breaker counts it).
    const age = guards.checkOracleAge(src.record, Math.floor(Date.now() / 1000), src.maxAgeSec, src.label);
    if (!age.ok) {
      log(`ALERT: ${age.reason} — not trading on it. ${pegInfo}`);
      breachCount = 0;
      await record('skipped', age.reason);
      return;
    }
    // backend_db: an off-chain price far from Uniswap is more likely wrong than
    // a real move, so skip it. If Uniswap can't be read, trade on the age check alone.
    if (src.checkDexGap && config.priceMaxDexGapPct > 0) {
      let dex = null;
      try { dex = await priceBand.readDexPrice(); }
      catch (e) { log(`WARN Uniswap price unreadable, gap check skipped: ${String(e.message).slice(0, 80)}`); }
      if (dex > 0) {
        const gapPct = ((oracleWL1X - dex) / dex) * 100;
        pegInfo += ` | Uniswap=$${dex.toFixed(4)} (${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}%)`;
        if (Math.abs(gapPct) > config.priceMaxDexGapPct) {
          const reason = `${src.label} $${oracleWL1X.toFixed(4)} is ${gapPct.toFixed(2)}% from Uniswap $${dex.toFixed(4)} (limit ${config.priceMaxDexGapPct}%)`;
          log(`ALERT: ${reason} — not trading on it. ${pegInfo}`);
          breachCount = 0;
          await record('skipped', reason);
          return;
        }
      }
    }
    if (Math.abs(devPct) > config.maxDeviationPct) {
      breachCount++;
      if (breachCount < breakerConfirmTicks) {
        log(`BREAKER: XUSD ${devPct.toFixed(2)}% off peg > ${config.maxDeviationPct}% — re-checking (${breachCount}/${breakerConfirmTicks}) before acting. ${pegInfo}`);
        await record('skipped', `breaker re-check ${breachCount}/${breakerConfirmTicks}`);
        return;
      }
      log(`BREAKER: large deviation CONFIRMED (${breachCount}/${breakerConfirmTicks} checks, ${devPct.toFixed(2)}% off) — correcting back to the band. ${pegInfo}`);
    } else {
      breachCount = 0;
    }
    target = oracleWL1X / config.xusdPeg;
  } else {
    target = config.targetPrice;
  }
  rec.targetRatio = target;

  // 3. compare pool ratio to target ± band
  const band = target * (config.bandPct / 100);
  const upper = target + band, lower = target - band;
  const driftPct = ((price - target) / target) * 100;
  log(`${market.base.symbol}/${market.quote.symbol} pool=${price.toFixed(6)} target=${target.toFixed(6)} band=±${config.bandPct}% drift=${driftPct.toFixed(3)}%${pegInfo ? ' | ' + pegInfo : ''}`);

  let side = null;
  if (price > upper) side = 'sell';       // ratio too high -> sell WL1X (ratio down / XUSD up)
  else if (price < lower) side = 'buy';   // ratio too low  -> buy WL1X (ratio up / XUSD down)
  if (!side) { log('within band — no action.'); await record('observed', 'within band'); return; }
  rec.side = side;

  // 4. size the trade. correctTo: center = to target, edge = to near band edge,
  //    random = pick one per tick (less mechanical / harder to read).
  const effectiveCorrectTo = config.correctTo === 'random'
    ? (Math.random() < 0.5 ? 'center' : 'edge')
    : config.correctTo;
  rec.correctTo = effectiveCorrectTo;
  const correctionTarget = effectiveCorrectTo === 'edge' ? (side === 'sell' ? upper : lower) : target;
  let sizeBase = await lib.sizeToTarget({ config, provider, side, targetPrice: correctionTarget, market });
  if (config.maxTradeBase > 0) sizeBase = Math.min(sizeBase, config.maxTradeBase);
  if (!(sizeBase > 0)) { log('no feasible size — skipping.'); await record('skipped', 'no feasible size'); return; }

  // Never try to spend more than the wallet holds — that swap can only revert.
  const wallet = lib.getWallet(config, provider);
  const walletAddress = (wallet && wallet.address) || config.walletAddress;
  if (walletAddress) {
    const [balanceBase, balanceQuote] = await Promise.all([
      lib.getTokenBalance(provider, market.base, walletAddress),
      lib.getTokenBalance(provider, market.quote, walletAddress)
    ]);
    const cap = guards.capToBalance({ side, sizeBase, price, balanceBase, balanceQuote, minTradeBase: config.minTradeBase });
    if (!(cap.sizeBase > 0)) {
      const msg = side === 'sell'
        ? `not enough ${market.base.symbol}: have ${balanceBase.toFixed(4)}, want to sell ${sizeBase.toFixed(4)}`
        : `not enough ${market.quote.symbol}: have ${balanceQuote.toFixed(2)}, need ~${(sizeBase * price).toFixed(2)}`;
      log(`ALERT: ${msg} — skipping.`);
      await record('skipped', msg);
      return;
    }
    if (cap.capped) log(`size capped to wallet balance: ${sizeBase.toFixed(4)} -> ${cap.sizeBase.toFixed(4)} ${market.base.symbol}`);
    sizeBase = cap.sizeBase;
  }

  const notional = sizeBase * price;
  rec.sizeBase = sizeBase;
  rec.notionalQuote = notional;

  // 5. QUOTE before swapping (impact-aware) -> slippage floor
  const q = await lib.quoteAmountOut({ config, provider, market, side, sizeBase, slippageBps: config.slippageBps });
  rec.minOut = q.minOutHuman;
  const pegGoal = pegMode ? ` toward XUSD $${config.xusdPeg}` : ' toward target';
  log(`${side.toUpperCase()} ${sizeBase.toFixed(4)} ${market.base.symbol} (~${notional.toFixed(2)} ${market.quote.symbol})${pegGoal} [correct-to-${effectiveCorrectTo}${config.correctTo === 'random' ? ' (random)' : ''}] | quote(${q.method}): expect ${q.amountOutHuman.toFixed(4)} ${q.tokenOut.symbol}, minOut ${q.minOutHuman.toFixed(4)} (${execute ? 'LIVE' : 'DRY-RUN'})`);

  // 6. execute (or simulate) — dry-run records as executed + is_dry_run=1
  if (!execute) {
    log('[DRY] would swap — set --execute or QDEX_EXECUTE=true to go live.');
    await record('executed', 'dry-run simulated');
    return;
  }
  if (backoff && backoff.blocked(Date.now())) {
    const mins = Math.ceil(backoff.remainingMs(Date.now()) / 60000);
    log(`swaps paused after repeated failures — resuming in ${mins}m.`);
    await record('skipped', `swaps paused after repeated failures (${mins}m left)`);
    return;
  }
  try {
    const receipt = await lib.executeSwap({ config, provider, side, amountBase: sizeBase, price, slippageBps: config.slippageBps, minOutHuman: q.minOutHuman, log });
    rec.txHash = receipt && receipt.hash;
    rec.blockNumber = receipt && receipt.blockNumber != null ? Number(receipt.blockNumber) : null;
    if (receipt && receipt.gasUsed != null) rec.gasUsed = receipt.gasUsed.toString();
    log(`swap sent: ${rec.txHash || '(no hash)'}`);
    if (backoff) backoff.onSuccess();
    await record('executed', 'live swap');
  } catch (e) {
    log(`swap FAILED: ${String(e.message).slice(0, 160)}`);
    if (backoff && backoff.onFailure(Date.now())) {
      log(`ALERT: ${config.failBackoffAfter} swap failures in a row — pausing swaps for ${config.failBackoffMin}m.`);
    }
    await record('skipped', 'swap failed: ' + String(e.message).slice(0, 100));
  }
}

// Never let a transient RPC hiccup kill the process. A 502 from ethers' background
// polling surfaces as an unhandled rejection, which (Node ≥15) exits by default —
// that's why the MM "stopped running". Log transient ones and keep polling; only a
// genuinely unexpected non-RPC error is treated as fatal.
function installCrashGuards() {
  process.on('unhandledRejection', (e) => {
    if (lib.isTransientRpcError(e)) { log(`ignored transient RPC error (unhandledRejection): ${String(e && (e.shortMessage || e.message)).slice(0, 100)}`); return; }
    log(`unhandledRejection: ${String(e && (e.stack || e.message || e)).slice(0, 200)}`);
  });
  process.on('uncaughtException', (e) => {
    if (lib.isTransientRpcError(e)) { log(`ignored transient RPC error (uncaughtException): ${String(e && (e.shortMessage || e.message)).slice(0, 100)}`); return; }
    log(`uncaughtException: ${String(e && (e.stack || e.message || e)).slice(0, 200)}`);
  });
}

async function main() {
  installCrashGuards();
  log(`QDex MM starting — ${execute ? 'LIVE (real swaps)' : 'DRY-RUN (simulate)'} poll=${pollMs}ms once=${once}`);
  try { lib.validateConfig(lib.getConfig()); }
  catch (e) { console.error(`CONFIG ERROR: ${e.message}`); process.exit(1); }
  const cfg = lib.getConfig();
  backoff = guards.createFailureBackoff({ after: cfg.failBackoffAfter, pauseMs: cfg.failBackoffMin * 60 * 1000 });
  log(cfg.priceSource === 'backend_db'
    ? `WL1X price: backend DB Config.${cfg.backendPriceKey} (max age ${cfg.backendMaxAgeSec > 0 ? guards.formatAge(cfg.backendMaxAgeSec) : 'off'}, max gap to Uniswap ${cfg.priceMaxDexGapPct > 0 ? cfg.priceMaxDexGapPct + '%' : 'off'})`
    : `WL1X price: on-chain oracle (max age ${cfg.oracleMaxAgeSec > 0 ? guards.formatAge(cfg.oracleMaxAgeSec) : 'off'})`);
  log(`safety: min trade ${cfg.minTradeBase} | pause swaps ${cfg.failBackoffMin}m after ${cfg.failBackoffAfter} failures`);
  try { await db.init(); log('accounting DB connected (qdex_actions)'); }
  catch (e) { log(`WARN accounting DB not connected (${String(e.message).slice(0, 80)}) — running without recording`); }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await tick(); } catch (e) { log(`tick error: ${String(e.message).slice(0, 200)}`); }
    if (once) break;
    await sleep(pollMs);
  }
  await db.end().catch(() => {});
  await backendPrice.close();
  process.exit(0); // --once: the Uniswap provider (gap check) would keep the process alive
}

main().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
