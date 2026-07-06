#!/usr/bin/env node
'use strict';

// DRY-RUN harness for the dynamic price band. Drives the REAL band engine
// (shared/price_band.js) through a simulated DEX price sequence and prints, per
// step: the band center, the pattern-bot box, the inner spread, the shifted grid
// innermost orders, and the follow/cap/freeze status. No server, no orders.
//
//   node scripts/band_dryrun.js

process.env.DYNAMIC_BAND = 'true';
process.env.BAND_REFRESH_MS = '0';           // force a refresh every step
process.env.BAND_SMOOTHING_ALPHA = process.env.BAND_SMOOTHING_ALPHA || '0.2';   // 9 EMA
process.env.BAND_MAX_MOVE_PCT = process.env.BAND_MAX_MOVE_PCT || '1';
process.env.BAND_FOLLOW_MAX_PCT = process.env.BAND_FOLLOW_MAX_PCT || '5';
process.env.BAND_INNER_SPREAD_PCT = process.env.BAND_INNER_SPREAD_PCT || '0.7';
process.env.BAND_ABS_MIN = process.env.BAND_ABS_MIN || '5';
process.env.BAND_ABS_MAX = process.env.BAND_ABS_MAX || '20';

const pb = require('../shared/price_band');

const BASE = 8.50;                 // grid baseCenterPrice
const GRID_BUY = 8.47, GRID_SELL = 8.53;  // innermost grid orders at base
// Simulated DEX price path: aligned → gradual rise → a SHARP spike (freeze) →
// EMA recovers → resumes following.
const dexSeq = [8.50, 8.55, 8.62, 8.70, 12.00, 8.72, 8.70, 8.70, 8.70, 8.70];

(async () => {
  pb._reset();
  let cex = 8.50; // CEX price; the pattern bot walks it to the band center each step
  console.log('Config: 9 EMA (α0.2) · max-move 1%/step · freeze >5% · inner spread 0.7% (cap 1%) · fence $5–$20\n');
  console.log('step |   DEX   | band ctr | pattern box (bot trades here) | inner | grid buy/sell (shifted) | status');
  console.log('-----|---------|----------|-------------------------------|-------|-------------------------|--------');
  for (let i = 0; i < dexSeq.length; i++) {
    pb._setMockDex(dexSeq[i]);
    const b = await pb.getBand(cex);
    const spreadPct = (b.lowestSell - b.highestBuy) / b.center * 100;
    const ratio = b.center / BASE;
    const gBuy = GRID_BUY * ratio, gSell = GRID_SELL * ratio;
    const status = b.frozen ? 'FROZEN' : (b.moved ? 'following' : 'steady');
    const extra = (b.reason && b.reason !== 'ok') ? '  ' + b.reason : '';
    console.log(
      `${String(i + 1).padStart(4)} | $${dexSeq[i].toFixed(3)} | $${b.center.toFixed(4)} | [$${b.floor.toFixed(4)} – $${b.resistance.toFixed(4)}]        | ${spreadPct.toFixed(2)}% | $${gBuy.toFixed(4)} / $${gSell.toFixed(4)}     | ${status}${extra}`
    );
    cex = b.center; // the CEX (via pattern bot) catches up to the band center
  }
  console.log('\nRead: as the DEX rises, the band center eases up ≤1%/step and the pattern box + grid');
  console.log('slide with it. When the DEX spikes >5% above the CEX (step 7-8) the band FREEZES —');
  console.log('the treasury handles that, not the CEX. Then it resumes following.');
})();
