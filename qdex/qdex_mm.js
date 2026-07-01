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
  if (!config.targetPrice || config.targetPrice <= 0) {
    log('QDEX_TARGET_PRICE not set (>0) — nothing to hold. Skipping.');
    return;
  }
  const provider = lib.getProvider(config);

  // 1. read pool state once + current price (quote per base)
  const market = await lib.loadPool(config, provider);
  const price = lib.priceFromSqrt(market);

  // 2. compare to target ± band
  const band = config.targetPrice * (config.bandPct / 100);
  const upper = config.targetPrice + band;
  const lower = config.targetPrice - band;
  const driftPct = ((price - config.targetPrice) / config.targetPrice) * 100;
  log(`${market.base.symbol}/${market.quote.symbol} pool=${price.toFixed(6)} target=${config.targetPrice} band=±${config.bandPct}% drift=${driftPct.toFixed(3)}%`);

  let side = null;
  if (price > upper) side = 'sell';       // too high -> sell base to push down
  else if (price < lower) side = 'buy';   // too low  -> buy base to push up
  if (!side) { log('within band — no action.'); return; }

  // 3. size the trade to bring price back to target (capped)
  let sizeBase = await lib.sizeToTarget({ config, provider, side, targetPrice: config.targetPrice, market });
  if (config.maxTradeBase > 0) sizeBase = Math.min(sizeBase, config.maxTradeBase);
  if (!(sizeBase > 0)) { log('no feasible size — skipping.'); return; }

  const notional = side === 'sell' ? sizeBase * price : sizeBase * price;
  log(`${side.toUpperCase()} ${sizeBase.toFixed(4)} ${market.base.symbol} (~${notional.toFixed(2)} ${market.quote.symbol}) to restore target (${execute ? 'LIVE' : 'DRY-RUN'})`);

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
