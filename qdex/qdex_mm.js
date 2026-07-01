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

const execute = process.argv.includes('--execute') ||
  (process.env.QDEX_EXECUTE || '').toLowerCase() === 'true';
const once = process.argv.includes('--once');
const pollMs = Number(process.env.QDEX_POLL_MS) || 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function tick() {
  const config = lib.getConfig();
  const pegMode = config.xusdPeg > 0;
  if (!pegMode && (!config.targetPrice || config.targetPrice <= 0)) {
    log('Neither QDEX_XUSD_PEG nor QDEX_TARGET_PRICE set — nothing to hold. Skipping.');
    return;
  }
  const provider = lib.getProvider(config);

  // 1. read pool state once + current price (quote per base = XUSD per WL1X)
  const market = await lib.loadPool(config, provider);
  const price = lib.priceFromSqrt(market);

  // 2. figure out the TARGET pool ratio.
  //   peg mode: hold XUSD at QDEX_XUSD_PEG. XUSD = oracleWL1X / poolRatio, so
  //     target poolRatio = oracleWL1X / peg. Circuit-break on a huge deviation.
  //   fixed mode: target = QDEX_TARGET_PRICE directly.
  let target, pegInfo = '';
  if (pegMode) {
    const oracleWL1X = await lib.getOraclePrice(config, provider, market.base.address);
    if (!(oracleWL1X > 0)) { log('oracle returned no WL1X price — skipping (circuit breaker).'); return; }
    const xusdPrice = oracleWL1X / price;                 // current XUSD in USD
    const devPct = ((xusdPrice - config.xusdPeg) / config.xusdPeg) * 100;
    pegInfo = `XUSD=$${xusdPrice.toFixed(5)} (peg $${config.xusdPeg}, dev ${devPct.toFixed(3)}%) | WL1X oracle=$${oracleWL1X.toFixed(4)}`;
    if (Math.abs(devPct) > config.maxDeviationPct) {
      log(`CIRCUIT BREAKER: XUSD ${devPct.toFixed(2)}% off peg > ${config.maxDeviationPct}% — not trading. ${pegInfo}`);
      return;
    }
    target = oracleWL1X / config.xusdPeg;                 // target pool ratio for XUSD=peg
  } else {
    target = config.targetPrice;
  }

  // 3. compare pool ratio to target ± band
  const band = target * (config.bandPct / 100);
  const upper = target + band, lower = target - band;
  const driftPct = ((price - target) / target) * 100;
  log(`${market.base.symbol}/${market.quote.symbol} pool=${price.toFixed(6)} target=${target.toFixed(6)} band=±${config.bandPct}% drift=${driftPct.toFixed(3)}%${pegInfo ? ' | ' + pegInfo : ''}`);

  let side = null;
  if (price > upper) side = 'sell';       // ratio too high -> sell WL1X (ratio down / XUSD up)
  else if (price < lower) side = 'buy';   // ratio too low  -> buy WL1X (ratio up / XUSD down)
  if (!side) { log('within band — no action.'); return; }

  // 4. size the trade to bring the ratio back to target (capped)
  let sizeBase = await lib.sizeToTarget({ config, provider, side, targetPrice: target, market });
  if (config.maxTradeBase > 0) sizeBase = Math.min(sizeBase, config.maxTradeBase);
  if (!(sizeBase > 0)) { log('no feasible size — skipping.'); return; }

  const notional = sizeBase * price;
  const pegGoal = pegMode ? ` to bring XUSD → $${config.xusdPeg}` : ' to restore target';
  log(`${side.toUpperCase()} ${sizeBase.toFixed(4)} ${market.base.symbol} (~${notional.toFixed(2)} ${market.quote.symbol})${pegGoal} (${execute ? 'LIVE' : 'DRY-RUN'})`);

  // 4. execute (or simulate)
  if (!execute) {
    log('[DRY] would swap — set --execute or QDEX_EXECUTE=true to go live.');
    return;
  }
  const receipt = await lib.executeSwap({ config, provider, side, amountBase: sizeBase, price, slippageBps: config.slippageBps, log });
  log(`swap sent: ${receipt && receipt.hash ? receipt.hash : '(no hash)'}`);
  // TODO(qdex): record to DB (qdex_trades) once the DB shape is decided.
}

async function main() {
  log(`QDex MM starting — ${execute ? 'LIVE (real swaps)' : 'DRY-RUN (simulate)'} poll=${pollMs}ms once=${once}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await tick(); } catch (e) { log(`tick error: ${String(e.message).slice(0, 200)}`); }
    if (once) break;
    await sleep(pollMs);
  }
}

main().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
