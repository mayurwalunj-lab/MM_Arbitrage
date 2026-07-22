#!/usr/bin/env node
'use strict';

// Diagnose QDex swap reverts: prints the wallet's WL1X + XUSD balances, the
// router allowance, native gas balance, and whether the wallet can actually fund
// the correction the MM wants to make. Read-only — sends no transaction.
//
//   node qdex/check_wallet.js
//
// A BUY (push XUSD down toward peg) spends XUSD to get WL1X → needs XUSD balance.
// A SELL (push XUSD up)              spends WL1X to get XUSD → needs WL1X balance.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const lib = require('./lib');

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

(async () => {
  try {
    const config = lib.getConfig();
    const provider = lib.getProvider(config);
    const wallet = lib.getWallet(config, provider, false);
    const m = await lib.loadPool(config, provider);
    const price = lib.priceFromSqrt(m); // base (WL1X) in quote (XUSD)

    const base = new ethers.Contract(m.base.address, ERC20, provider);
    const quote = new ethers.Contract(m.quote.address, ERC20, provider);

    const [bBase, bQuote, allowQuote, allowBase, gas] = await Promise.all([
      base.balanceOf(wallet.address),
      quote.balanceOf(wallet.address),
      quote.allowance(wallet.address, config.routerAddress),
      base.allowance(wallet.address, config.routerAddress),
      provider.getBalance(wallet.address)
    ]);

    const fB = (v, d) => Number(ethers.formatUnits(v, d));
    const baseBal = fB(bBase, m.base.decimals);
    const quoteBal = fB(bQuote, m.quote.decimals);

    console.log('QDex wallet:', wallet.address);
    console.log('pool price :', price.toFixed(6), `${m.quote.symbol} per ${m.base.symbol}`);
    console.log('');
    console.log(`${m.base.symbol}  balance:`, baseBal.toFixed(6), '| router allowance:', fB(allowBase, m.base.decimals).toFixed(2));
    console.log(`${m.quote.symbol}  balance:`, quoteBal.toFixed(6), '| router allowance:', fB(allowQuote, m.quote.decimals).toFixed(2));
    console.log('native gas :', ethers.formatEther(gas), '(chain', config.chainId + ')');
    console.log('');

    const cap = config.maxTradeBase > 0 ? config.maxTradeBase : null;
    const buyNeedQuote = (cap || 30) * price;   // XUSD needed to buy `cap` WL1X
    console.log('--- can the wallet fund a correction? ---');
    console.log(`BUY  ${cap || '?'} ${m.base.symbol} needs ~${buyNeedQuote.toFixed(2)} ${m.quote.symbol} →`,
      quoteBal >= buyNeedQuote ? '✅ enough XUSD' : `❌ SHORT (have ${quoteBal.toFixed(2)} ${m.quote.symbol})`);
    console.log(`SELL ${cap || '?'} ${m.base.symbol} needs ${cap || '?'} ${m.base.symbol} →`,
      baseBal >= (cap || 0) ? '✅ enough WL1X' : `❌ SHORT (have ${baseBal.toFixed(2)} ${m.base.symbol})`);
    if (fB(allowQuote, m.quote.decimals) < buyNeedQuote) console.log('⚠️ XUSD router allowance is low — approval may be needed for a BUY.');
    if (gas === 0n) console.log('⚠️ native gas balance is ZERO — every transaction will fail to send.');
  } catch (e) {
    console.error('check failed:', e.message);
    process.exit(1);
  }
})();
