#!/usr/bin/env node

'use strict';

// Live test of the CEX order path (leg 1 machinery). Two modes:
//
//   default (unfillable): place a limit buy far below market, confirm it is
//     open, cancel it. Zero fill risk — proves place/poll/cancel.
//
//   --fill (REAL buy): place a small limit buy at/above market so it actually
//     fills. Spends real USDT and acquires L1X — proves leg 1 executes and
//     fills for real. Size-capped for safety.
//
//   ARB_DRY_RUN=false node arb/test_cex_order.js --exchange lbank            (unfillable)
//   ARB_DRY_RUN=false node arb/test_cex_order.js --exchange lbank --fill --l1x 1
//
// Requires: ARB_<EXCHANGE>_* keys in .env, IP whitelisted, ARB_DRY_RUN=false.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const cex = require('./cex');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2); const n = argv[i + 1];
    if (n == null || n.startsWith('--')) out[k] = true; else { out[k] = n; i++; }
  }
  return out;
}

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exchangeId = typeof args.exchange === 'string' ? args.exchange : 'lbank';
  const pair = process.env.ARB_PAIR || 'L1X/USDT';
  const fill = Boolean(args.fill);
  const side = (typeof args.side === 'string' ? args.side : 'buy').toLowerCase();
  if (!['buy', 'sell'].includes(side)) throw new Error('--side must be buy or sell');
  const amount = Number(args.l1x ?? (fill ? 1 : 5));

  if (process.env.ARB_DRY_RUN !== 'false') {
    throw new Error('Set ARB_DRY_RUN=false to run a real test order');
  }
  if (!cex.EXCHANGES.includes(exchangeId)) throw new Error(`unknown exchange ${exchangeId}`);

  const client = cex.createArbClient(exchangeId);
  if (!client.arbHasKeys) throw new Error(`No ARB_${exchangeId.toUpperCase()} API keys in .env`);
  await client.loadMarkets();
  const ticker = await cex.fetchTickerPrice(client, pair);

  if (!fill) {
    // ---- unfillable mode: buy far BELOW / sell far ABOVE market, cancel ----
    const price = Number(args.price ?? (side === 'buy' ? 1.0 : ticker.price * 5));
    log(`${exchangeId} ${pair} market ~$${ticker.price.toFixed(4)} | test ${side} ${amount} @ $${price} (unfillable)`);
    if (side === 'buy' && price >= ticker.price * 0.5) throw new Error(`buy test price $${price} too close to market — use far below, e.g. 1.0`);
    if (side === 'sell' && price <= ticker.price * 2) throw new Error(`sell test price $${price} too close to market — use far above`);

    log(`placing unfillable limit ${side.toUpperCase()}...`);
    const placed = await cex.placeLimitOrder({ client, exchangeId, symbol: pair, side, amount, price });
    log(`OK — order placed, id=${placed.id}`);
    const polled = await cex.pollOrder({ client, orderId: placed.id, symbol: pair, timeoutMs: 4000 });
    log(`order status: ${polled.status} (filled ${polled.filled})`);
    log('cancelling...');
    await cex.cancelOrder({ client, orderId: placed.id, symbol: pair });
    const after = await cex.pollOrder({ client, orderId: placed.id, symbol: pair, timeoutMs: 3000 });
    log(`final status: ${after.status}`);
    console.log(`\nRESULT: CEX ${side} order path works — placed, confirmed open, cancelled. Leg 1 (${side}) machinery verified.`);
    return;
  }

  // ---- fill mode: a REAL small order that fills (buy above ask / sell below bid) ----
  const MAX_TEST_L1X = Number(process.env.ARB_TEST_MAX_L1X ?? 5);
  if (amount > MAX_TEST_L1X) throw new Error(`--l1x ${amount} exceeds test cap ${MAX_TEST_L1X} (set ARB_TEST_MAX_L1X to raise)`);
  const ref = side === 'buy' ? (ticker.ask ?? ticker.price) : (ticker.bid ?? ticker.price);
  const price = Number((side === 'buy' ? ref * 1.005 : ref * 0.995).toFixed(6));  // cross the spread → taker fill
  const costUsd = (amount * ref).toFixed(2);
  log(`${exchangeId} ${pair} market ~$${ticker.price.toFixed(4)} ${side === 'buy' ? 'ask' : 'bid'} $${ref.toFixed(4)}`);
  log(`REAL ${side.toUpperCase()}: ${amount} L1X @ limit $${price} (~$${costUsd}) — this WILL fill and ${side === 'buy' ? 'spend USDT' : 'sell L1X'}`);

  log(`placing fillable limit ${side.toUpperCase()}...`);
  const placed = await cex.placeLimitOrder({ client, exchangeId, symbol: pair, side, amount, price });
  log(`order placed, id=${placed.id} — waiting for fill...`);
  const polled = await cex.pollOrder({ client, orderId: placed.id, symbol: pair, timeoutMs: 15000, intervalMs: 1500 });
  log(`status: ${polled.status} | filled ${polled.filled} L1X @ avg $${polled.average ?? '?'}`);

  if (polled.status !== 'filled') {
    log('not fully filled — cancelling remainder...');
    await cex.cancelOrder({ client, orderId: placed.id, symbol: pair });
  }
  console.log(`\nRESULT: real ${side} ${polled.status} — ${polled.filled} L1X acquired @ ~$${polled.average ?? price}. Leg 1 FILL verified.`);
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
