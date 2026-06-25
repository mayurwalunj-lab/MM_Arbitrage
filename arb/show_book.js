#!/usr/bin/env node

'use strict';

// Read-only orderbook viewer for testing. Shows top asks/bids and the
// volume-weighted average price to buy/sell a given size (walking the book).
//
//   node arb/show_book.js --exchange lbank [--pair L1X/USDT] [--size 5] [--depth 8]
//
// Public data — no API keys needed.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const cex = require('./cex');
const { walkAsks, walkBids } = require('./orderbook');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const n = argv[i + 1];
    if (n == null || n.startsWith('--')) out[k] = true; else { out[k] = n; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exchangeId = typeof args.exchange === 'string' ? args.exchange : 'lbank';
  const pair = typeof args.pair === 'string' ? args.pair : (process.env.ARB_PAIR || 'L1X/USDT');
  const size = Number(args.size ?? 5);
  const depth = Number(args.depth ?? 8);

  const client = cex.createArbClient(exchangeId);
  const book = await cex.fetchOrderBook(client, pair, 50);
  const bestAsk = book.asks[0]?.[0];
  const bestBid = book.bids[0]?.[0];
  const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : null;

  console.log(`${exchangeId.toUpperCase()} ${pair} orderbook` + (mid ? `  mid ~$${mid.toFixed(4)}  spread ${(((bestAsk - bestBid) / mid) * 100).toFixed(3)}%` : ''));
  console.log('');
  console.log('  ASKS (sellers — you BUY here):');
  for (const [p, a] of book.asks.slice(0, depth).reverse()) console.log(`    $${p.toFixed(4)}  ×  ${a.toFixed(2)} L1X`);
  console.log('  ' + '-'.repeat(28));
  console.log('  BIDS (buyers — you SELL here):');
  for (const [p, a] of book.bids.slice(0, depth)) console.log(`    $${p.toFixed(4)}  ×  ${a.toFixed(2)} L1X`);
  console.log('');

  const buy = walkAsks(book, size);
  const sell = walkBids(book, size);
  console.log(`walk ${size} L1X:`);
  console.log(`  BUY  avg $${buy.avgPrice ? buy.avgPrice.toFixed(4) : 'n/a'}  worst $${buy.worstPrice ?? 'n/a'}  (${buy.sufficient ? 'enough depth' : 'NOT enough — only ' + buy.filledBase.toFixed(2) + ' available'})`);
  console.log(`  SELL avg $${sell.avgPrice ? sell.avgPrice.toFixed(4) : 'n/a'}  worst $${sell.worstPrice ?? 'n/a'}  (${sell.sufficient ? 'enough depth' : 'NOT enough — only ' + sell.filledBase.toFixed(2) + ' available'})`);
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
