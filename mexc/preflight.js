#!/usr/bin/env node
'use strict';

// MEXC readiness preflight — run this ON THE SERVER (where the IP-bound keys live)
// before enabling the MEXC bots. Read-only by default: checks whether L1X/USDT is
// listed + API-tradable, and whether each key set (botA/botB/grid) authenticates
// and has balances. Never prints secrets.
//
//   node mexc/preflight.js            # public + auth + balances (safe)
//   node mexc/preflight.js --test-order   # also place+cancel one tiny order (LIVE)
//
// The --test-order flag is the only definitive proof that MEXC's API TRADING is
// enabled for L1X/USDT — it places a far-from-market limit order and cancels it.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const ccxt = require('ccxt');

const PAIR = process.env.MEXC_PAIR || 'L1X/USDT';
const testOrder = process.argv.includes('--test-order');

const keySets = [
  { name: 'botA', apiKey: process.env.MEXC_BOT_A_API_KEY, secret: process.env.MEXC_BOT_A_SECRET },
  { name: 'botB', apiKey: process.env.MEXC_BOT_B_API_KEY, secret: process.env.MEXC_BOT_B_SECRET },
  { name: 'grid', apiKey: process.env.MEXC_GRID_API_KEY, secret: process.env.MEXC_GRID_SECRET }
];

const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => console.log('  ❌ ' + m);
const warn = (m) => console.log('  ⚠️  ' + m);

(async () => {
  console.log(`\nMEXC preflight — pair ${PAIR}\n`);

  // 1) PUBLIC: is the pair listed + API-tradable?
  console.log('[1] Public market check (no keys):');
  const pub = new ccxt.mexc({ enableRateLimit: true });
  let market = null;
  try {
    await pub.loadMarkets();
    const l1x = Object.keys(pub.markets).filter((s) => /L1X/i.test(s));
    if (!l1x.length) { bad(`no L1X markets on MEXC yet — nothing to trade until it lists`); }
    else ok(`L1X markets: ${l1x.join(', ')}`);
    market = pub.markets[PAIR] || null;
    if (market) {
      ok(`${PAIR}: active=${market.active} spot=${market.spot}`);
      console.log(`     price precision=${JSON.stringify(market.precision.price)} | amount precision=${JSON.stringify(market.precision.amount)}`);
      console.log(`     min cost=${market.limits.cost && market.limits.cost.min} | min amount=${market.limits.amount && market.limits.amount.min} | taker=${market.taker}`);
      if (market.active === false) warn('market is not active — trading disabled');
    } else {
      warn(`${PAIR} not found — listing pending (bots will error on orders until it lists)`);
    }
  } catch (e) { bad(`public loadMarkets failed: ${e.message}`); }

  // 2) PRIVATE: does each key set authenticate + have balances?
  for (const ks of keySets) {
    console.log(`\n[2] ${ks.name} key check:`);
    if (!ks.apiKey || !ks.secret) { warn(`MEXC_${ks.name.toUpperCase()}_* not set — skipping`); continue; }
    const ex = new ccxt.mexc({ apiKey: ks.apiKey, secret: ks.secret, enableRateLimit: true });
    try {
      const bal = await ex.fetchBalance();
      const usdt = (bal.total && bal.total.USDT) || 0;
      const l1x = (bal.total && bal.total.L1X) || 0;
      ok(`authenticated — USDT=${usdt} L1X=${l1x}`);
    } catch (e) {
      bad(`auth/balance failed: ${e.message.slice(0, 100)}`);
      continue;
    }
    // 3) optional: prove API trading works with a tiny place+cancel
    if (testOrder && market && market.active) {
      try {
        const book = await ex.fetchOrderBook(PAIR);
        const bid = book.bids[0] && book.bids[0][0];
        if (!bid) { warn('no bids — skipping test order'); continue; }
        const px = ex.priceToPrecision(PAIR, bid * 0.5); // far below market, won't fill
        const minCost = (market.limits.cost && market.limits.cost.min) || 5;
        const amt = ex.amountToPrecision(PAIR, (minCost * 1.1) / Number(px));
        const o = await ex.createOrder(PAIR, 'limit', 'buy', amt, px);
        ok(`test order placed (${o.id}) — API TRADING IS ENABLED`);
        await ex.cancelOrder(o.id, PAIR);
        ok('test order cancelled');
      } catch (e) {
        bad(`test order failed — API trading may be disabled: ${e.message.slice(0, 120)}`);
      }
    } else if (testOrder) {
      warn('skipped test order (market not listed/active yet)');
    }
  }

  console.log('\nDone. Green across the board (with --test-order) = MEXC is ready to enable.\n');
})();
