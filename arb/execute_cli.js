#!/usr/bin/env node

'use strict';

// Stage A: command-triggered execution. Detects the current best opportunity
// and runs ONE three-leg round through arb/executor.js.
//
//   npm run arb:execute                          # best opportunity, any venue
//   npm run arb:execute -- --exchange lbank      # restrict venue
//   npm run arb:execute -- --min-edge 2          # require $2 net minimum
//   npm run arb:execute -- --force               # DRY-RUN ONLY: ignore the
//                                                  edge check to test the flow
//
// SIMULATED unless ARB_DRY_RUN=false is set in .env (the master lock).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const lib = require('../uniswap/lib');
const cex = require('./cex');
const arbDb = require('./db');
const executor = require('./executor');

function envNum(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) { out[key] = true; } else { out[key] = next; i++; }
  }
  return out;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = process.env.ARB_DRY_RUN !== 'false';

  const options = {
    pair: process.env.ARB_PAIR || 'L1X/USDT',
    minEdgeUsd: args['min-edge'] != null ? Number(args['min-edge']) : envNum('ARB_MIN_EDGE_USD', 20),
    minTradeL1x: envNum('ARB_MIN_TRADE_L1X', 10),
    maxTradeL1x: envNum('ARB_MAX_TRADE_L1X', 1000),
    cexTakerFeeBps: envNum('ARB_CEX_TAKER_FEE_BPS', 25),
    gasLimitSwap: envNum('ARB_GAS_LIMIT_SWAP', 200000),
    maxSpreadPct: envNum('ARB_MAX_SPREAD_PCT', 2),
    minDepthL1x: envNum('ARB_MIN_DEPTH_L1X', 50),
    depthRangePct: envNum('ARB_DEPTH_RANGE_PCT', 2)
  };

  if (args.force && !dryRun) {
    throw new Error('--force is only allowed in dry-run mode (ARB_DRY_RUN not false)');
  }

  log(dryRun
    ? 'DRY RUN — full flow, simulated orders only (set ARB_DRY_RUN=false for live)'
    : 'LIVE MODE — real orders will be placed');

  const config = lib.getConfig();
  const provider = lib.getProvider(config);
  const market = await lib.loadMarket(config, provider);

  const arbClients = {};
  for (const name of cex.EXCHANGES) {
    arbClients[name] = cex.createArbClient(name);
    try { await arbClients[name].loadMarkets(); } catch (_) { /* tolerated */ }
  }

  // Self-trade filter for execution: fetch own orders where keys allow.
  const ownOrdersByExchange = {};
  if (process.env.ARB_SELF_TRADE_FILTER !== 'false') {
    for (const name of cex.EXCHANGES) {
      const ownClients = cex.createOwnAccountClients(name);
      if (!ownClients.length) continue;
      const { orders, errors } = await cex.fetchOwnOpenOrders(ownClients, options.pair);
      for (const error of errors) log(`WARN ${name} own-orders: ${error.slice(0, 80)}`);
      ownOrdersByExchange[name] = orders;
    }
  }

  log('detecting current best opportunity...');
  const detected = await executor.detectOnce({
    config,
    provider,
    market,
    arbClients,
    ownOrdersByExchange,
    options,
    restrictTo: typeof args.exchange === 'string' ? { exchangeName: args.exchange } : null,
    log
  });

  if (!detected) {
    log('no opportunity found (no spread, or books unhealthy). Nothing to execute.');
    return;
  }

  const { best, exchangeName } = detected;
  log(`best: ${exchangeName} ${best.direction} size=${best.sizeL1x.toFixed(4)} L1X | dex $${best.dexAvgPriceUsd.toFixed(4)} | cex $${best.cexAvgPriceUsd.toFixed(4)} | net $${best.netUsd.toFixed(2)}`);

  if (best.netUsd < options.minEdgeUsd && !args.force) {
    log(`net $${best.netUsd.toFixed(2)} is below min edge $${options.minEdgeUsd} — not executing. (--force to test the flow in dry-run)`);
    return;
  }
  if (args.force) {
    options.minEdgeUsd = -Infinity;
    log('--force: edge check bypassed (dry-run flow test)');
  }

  const result = await executor.executeOpportunity({
    config,
    provider,
    market,
    arbClients,
    ownOrdersByExchange,
    options,
    opportunity: { direction: best.direction, exchangeName, sizeL1x: best.sizeL1x },
    log
  });

  log(`result: ${JSON.stringify(result)}`);
}

main()
  .catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => arbDb.end().catch(() => {}));
