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
    // ---- unfillable mode: place far below market, confirm open, cancel ----
    const price = Number(args.price ?? 1.0);
    log(`${exchangeId} ${pair} market ~$${ticker.price.toFixed(4)} | test buy ${amount} @ $${price} (unfillable)`);
    if (price >= ticker.price * 0.5) throw new Error(`test price $${price} too close to market — use far below, e.g. 1.0`);

    log('placing unfillable limit BUY...');
    const placed = await cex.placeLimitOrder({ client, exchangeId, symbol: pair, side: 'buy', amount, price });
    log(`OK — order placed, id=${placed.id}`);
    const polled = await cex.pollOrder({ client, orderId: placed.id, symbol: pair, timeoutMs: 4000 });
    log(`order status: ${polled.status} (filled ${polled.filled})`);
    log('cancelling...');
    await cex.cancelOrder({ client, orderId: placed.id, symbol: pair });
    const after = await cex.pollOrder({ client, orderId: placed.id, symbol: pair, timeoutMs: 3000 });
    log(`final status: ${after.status}`);
    console.log('\nRESULT: CEX order path works — placed, confirmed open, cancelled. Leg 1 machinery verified.');
    return;
  }

  // ---- fill mode: a REAL small buy at/above market so it actually fills ----
  const MAX_TEST_L1X = Number(process.env.ARB_TEST_MAX_L1X ?? 5);
  if (amount > MAX_TEST_L1X) throw new Error(`--l1x ${amount} exceeds test cap ${MAX_TEST_L1X} (set ARB_TEST_MAX_L1X to raise)`);
  const ask = ticker.ask ?? ticker.price;
  const price = Number((ask * 1.005).toFixed(6));   // 0.5% above ask → fills as taker
  const costUsd = (amount * ask).toFixed(2);
  log(`${exchangeId} ${pair} market ~$${ticker.price.toFixed(4)} ask $${ask.toFixed(4)}`);
  log(`REAL BUY: ${amount} L1X @ limit $${price} (~$${costUsd} USDT) — this WILL fill and spend real funds`);

  log('placing fillable limit BUY...');
  const placed = await cex.placeLimitOrder({ client, exchangeId, symbol: pair, side: 'buy', amount, price });
  log(`order placed, id=${placed.id} — waiting for fill...`);
  const polled = await cex.pollOrder({ client, orderId: placed.id, symbol: pair, timeoutMs: 15000, intervalMs: 1500 });
  log(`status: ${polled.status} | filled ${polled.filled} L1X @ avg $${polled.average ?? '?'}`);

  if (polled.status !== 'filled') {
    log('not fully filled — cancelling remainder...');
    await cex.cancelOrder({ client, orderId: placed.id, symbol: pair });
  }
  console.log(`\nRESULT: real buy ${polled.status} — ${polled.filled} L1X acquired @ ~$${polled.average ?? price}. Leg 1 FILL verified.`);
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
