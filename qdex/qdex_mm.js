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
    const oracleWL1X = await lib.getOraclePrice(config, provider, market.base.address);
    if (!(oracleWL1X > 0)) { log('oracle returned no WL1X price — skipping.'); await record('skipped', 'oracle no price'); return; }
    rec.oracleWl1xUsd = oracleWL1X;
    const xusdPrice = oracleWL1X / price;                 // current XUSD in USD
    rec.xusdPrice = xusdPrice;
    const devPct = ((xusdPrice - config.xusdPeg) / config.xusdPeg) * 100;
    rec.deviationPct = devPct;
    pegInfo = `XUSD=$${xusdPrice.toFixed(5)} (peg $${config.xusdPeg}, dev ${devPct.toFixed(3)}%) | WL1X oracle=$${oracleWL1X.toFixed(4)}`;
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

  // 4. size the trade (center = to target, edge = to near band edge), capped
  const correctionTarget = config.correctTo === 'edge' ? (side === 'sell' ? upper : lower) : target;
  let sizeBase = await lib.sizeToTarget({ config, provider, side, targetPrice: correctionTarget, market });
  if (config.maxTradeBase > 0) sizeBase = Math.min(sizeBase, config.maxTradeBase);
  if (!(sizeBase > 0)) { log('no feasible size — skipping.'); await record('skipped', 'no feasible size'); return; }

  const notional = sizeBase * price;
  rec.sizeBase = sizeBase;
  rec.notionalQuote = notional;

  // 5. QUOTE before swapping (impact-aware) -> slippage floor
  const q = await lib.quoteAmountOut({ config, provider, market, side, sizeBase, slippageBps: config.slippageBps });
  rec.minOut = q.minOutHuman;
  const pegGoal = pegMode ? ` toward XUSD $${config.xusdPeg}` : ' toward target';
  log(`${side.toUpperCase()} ${sizeBase.toFixed(4)} ${market.base.symbol} (~${notional.toFixed(2)} ${market.quote.symbol})${pegGoal} [correct-to-${config.correctTo}] | quote(${q.method}): expect ${q.amountOutHuman.toFixed(4)} ${q.tokenOut.symbol}, minOut ${q.minOutHuman.toFixed(4)} (${execute ? 'LIVE' : 'DRY-RUN'})`);

  // 6. execute (or simulate) — dry-run records as executed + is_dry_run=1
  if (!execute) {
    log('[DRY] would swap — set --execute or QDEX_EXECUTE=true to go live.');
    await record('executed', 'dry-run simulated');
    return;
  }
  try {
    const receipt = await lib.executeSwap({ config, provider, side, amountBase: sizeBase, price, slippageBps: config.slippageBps, minOutHuman: q.minOutHuman, log });
    rec.txHash = receipt && receipt.hash;
    rec.blockNumber = receipt && receipt.blockNumber != null ? Number(receipt.blockNumber) : null;
    if (receipt && receipt.gasUsed != null) rec.gasUsed = receipt.gasUsed.toString();
    log(`swap sent: ${rec.txHash || '(no hash)'}`);
    await record('executed', 'live swap');
  } catch (e) {
    log(`swap FAILED: ${String(e.message).slice(0, 160)}`);
    await record('skipped', 'swap failed: ' + String(e.message).slice(0, 100));
  }
}

async function main() {
  log(`QDex MM starting — ${execute ? 'LIVE (real swaps)' : 'DRY-RUN (simulate)'} poll=${pollMs}ms once=${once}`);
  try { lib.validateConfig(lib.getConfig()); }
  catch (e) { console.error(`CONFIG ERROR: ${e.message}`); process.exit(1); }
  try { await db.init(); log('accounting DB connected (qdex_actions)'); }
  catch (e) { log(`WARN accounting DB not connected (${String(e.message).slice(0, 80)}) — running without recording`); }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await tick(); } catch (e) { log(`tick error: ${String(e.message).slice(0, 200)}`); }
    if (once) break;
    await sleep(pollMs);
  }
  await db.end().catch(() => {});
}

main().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
