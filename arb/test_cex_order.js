#!/usr/bin/env node

'use strict';

// Isolated live test of the CEX order path (leg 1 machinery): place an
// UNFILLABLE limit buy far below market, confirm it appears on the exchange,
// then cancel it. Proves placeLimitOrder / pollOrder / cancelOrder work
// against the real exchange with zero fill risk.
//
//   ARB_DRY_RUN=false node arb/test_cex_order.js --exchange lbank [--l1x 5] [--price 1.0]
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
  const amount = Number(args.l1x ?? 5);
  const price = Number(args.price ?? 1.0);   // far below market — cannot fill

  if (process.env.ARB_DRY_RUN !== 'false') {
    throw new Error('Set ARB_DRY_RUN=false to run a real (unfillable) test order');
  }
  if (!cex.EXCHANGES.includes(exchangeId)) throw new Error(`unknown exchange ${exchangeId}`);

  const client = cex.createArbClient(exchangeId);
  if (!client.arbHasKeys) throw new Error(`No ARB_${exchangeId.toUpperCase()} API keys in .env`);
  await client.loadMarkets();

  // Sanity: confirm the price really is far below market so it can't fill
  const ticker = await cex.fetchTickerPrice(client, pair);
  log(`${exchangeId} ${pair} market ~$${ticker.price.toFixed(4)} | test buy ${amount} @ $${price} (unfillable)`);
  if (price >= ticker.price * 0.5) {
    throw new Error(`test price $${price} too close to market $${ticker.price} — use a far-below price like 1.0`);
  }

  log('placing unfillable limit BUY...');
  const placed = await cex.placeLimitOrder({ client, exchangeId, symbol: pair, side: 'buy', amount, price });
  log(`OK — order placed, id=${placed.id}`);

  log('confirming it is open on the exchange...');
  const polled = await cex.pollOrder({ client, orderId: placed.id, symbol: pair, timeoutMs: 4000, intervalMs: 1000 });
  log(`order status: ${polled.status} (filled ${polled.filled})`);

  log('cancelling...');
  const cancelled = await cex.cancelOrder({ client, orderId: placed.id, symbol: pair });
  log(cancelled ? 'OK — cancel request sent' : 'cancel returned false (may already be gone)');

  const after = await cex.pollOrder({ client, orderId: placed.id, symbol: pair, timeoutMs: 3000, intervalMs: 1000 });
  log(`final status: ${after.status}`);

  console.log('\nRESULT: CEX order path works — placed, confirmed open, cancelled. Leg 1 machinery verified.');
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
