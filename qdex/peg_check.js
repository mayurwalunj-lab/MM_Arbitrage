#!/usr/bin/env node
'use strict';

// Read-only: how far XUSD is off its $1 peg, and exactly how much to trade to
// restore it — direction, XUSD amount, WL1X amount — plus what the wallet holds.
// Sends nothing.  Run:  node qdex/peg_check.js   (or  npm run qdex:peg )

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');
const lib = require('./lib');

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)'
];
const ORACLE_ABI = ['function getLatestPrice(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
const ERC20 = ['function balanceOf(address) view returns (uint256)'];

(async () => {
  const c = lib.getConfig();
  const p = lib.getProvider(c);
  const pool = new ethers.Contract(c.poolAddress, POOL_ABI, p);
  const oracle = new ethers.Contract(c.oracleAddress, ORACLE_ABI, p);

  const [s, L, t0, oraDec] = await Promise.all([pool.slot0(), pool.liquidity(), pool.token0(), oracle.decimals()]);
  const raw = await oracle.getLatestPrice(c.baseToken);
  const oracleWL1X = Number(raw) / Math.pow(10, Number(oraDec));   // WL1X USD price
  const baseIsT0 = t0.toLowerCase() === c.baseToken.toLowerCase();
  const priceNow = (Number(s.sqrtPriceX96) / 2 ** 96) ** 2;         // token1/token0
  const poolPrice = baseIsT0 ? priceNow : 1 / priceNow;            // XUSD per WL1X
  const xusd = oracleWL1X / poolPrice;                             // XUSD USD value
  const dev = (xusd - 1) * 100;

  console.log(`\nXUSD price : $${xusd.toFixed(4)}   (${dev >= 0 ? '+' : ''}${dev.toFixed(2)}% off $1 peg)`);
  console.log(`pool       : ${poolPrice.toFixed(4)} XUSD/WL1X   oracle WL1X: $${oracleWL1X.toFixed(4)}`);

  // target: pool price must equal the oracle so 1 XUSD = $1
  const Q96 = 2n ** 96n;
  const sqrtNow = s.sqrtPriceX96;
  // careful: sqrt price is of token1/token0; if base is token1 we invert the target
  const targetT1overT0 = baseIsT0 ? oracleWL1X : 1 / oracleWL1X;
  const sqrtTgt = BigInt(Math.floor(Math.sqrt(targetT1overT0) * 2 ** 96));

  const wl = new ethers.Contract(c.baseToken, ERC20, p);
  const xu = new ethers.Contract(c.quoteToken, ERC20, p);
  const w = c.walletAddress;
  const [bwl, bxu] = w ? await Promise.all([wl.balanceOf(w), xu.balanceOf(w)]) : [0n, 0n];
  const haveWL1X = Number(ethers.formatUnits(bwl, 18));
  const haveXUSD = Number(ethers.formatUnits(bxu, 18));

  console.log(`\nTo restore the $1 peg:`);
  if (Math.abs(dev) < (c.bandPct || 0.5)) {
    console.log(`  ✅ within the ${c.bandPct}% band — no action needed.`);
  } else if (dev > 0) {
    // XUSD over peg -> pool price must RISE -> BUY WL1X with XUSD (token1 in if base=t0)
    const dyWei = baseIsT0 ? (L * (sqrtTgt - sqrtNow)) / Q96 : 0n;
    const xusdIn = Number(ethers.formatUnits(dyWei > 0n ? dyWei : 0n, 18));
    const wl1xOut = Math.abs(haveXUSD >= 0 ? (L === 0n ? 0 : xusdIn / ((poolPrice + oracleWL1X) / 2)) : 0);
    console.log(`  ACTION : BUY WL1X  (spend / SELL XUSD)`);
    console.log(`  SELL   : ~${xusdIn.toLocaleString(undefined, { maximumFractionDigits: 0 })} XUSD`);
    console.log(`  BUY    : ~${wl1xOut.toLocaleString(undefined, { maximumFractionDigits: 0 })} WL1X`);
    console.log(`  wallet : ${haveXUSD.toFixed(2)} XUSD  ->  ${haveXUSD >= xusdIn ? '✅ enough' : `❌ SHORT by ${(xusdIn - haveXUSD).toLocaleString(undefined,{maximumFractionDigits:0})} XUSD`}`);
  } else {
    // XUSD under peg -> pool price must FALL -> SELL WL1X for XUSD
    const invNow = (Q96 * Q96) / sqrtNow;
    const invTgt = (Q96 * Q96) / sqrtTgt;
    const dxWei = baseIsT0 ? (L * (invTgt - invNow)) / Q96 : 0n;
    const wl1xIn = Number(ethers.formatUnits(dxWei > 0n ? dxWei : 0n, 18));
    const xusdOut = wl1xIn * ((poolPrice + oracleWL1X) / 2);
    console.log(`  ACTION : SELL WL1X  (receive / BUY XUSD)`);
    console.log(`  SELL   : ~${wl1xIn.toLocaleString(undefined, { maximumFractionDigits: 0 })} WL1X`);
    console.log(`  GET    : ~${xusdOut.toLocaleString(undefined, { maximumFractionDigits: 0 })} XUSD`);
    console.log(`  wallet : ${haveWL1X.toFixed(2)} WL1X  ->  ${haveWL1X >= wl1xIn ? '✅ enough' : `❌ SHORT by ${(wl1xIn - haveWL1X).toLocaleString(undefined,{maximumFractionDigits:0})} WL1X`}`);
  }
  console.log('');
})().catch((e) => { console.error('peg check failed:', e.message); process.exit(1); });
