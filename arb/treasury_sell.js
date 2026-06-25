#!/usr/bin/env node

'use strict';

// TREASURY SELL — sell treasury L1X into the DEX whenever the DEX price is
// trading above the CEX price, down to the CEX price, then convert proceeds
// to USDT. This is NOT arbitrage: it is directional (treasury L1X decreases,
// USDT increases). The CEX price is only a reference FLOOR — nothing is
// bought or traded on the CEX.
//
//   node arb/treasury_sell.js                 dry-run: show premium, size, USDT
//   node arb/treasury_sell.js --execute       real: sell on DEX + convert to USDT
//
// Guardrails:
//   - floor = live CEX price (never sell below market value)
//   - TREASURY_MIN_PREMIUM_PCT: only sell if DEX is this % above CEX
//   - TREASURY_MAX_SELL_L1X / TREASURY_MAX_BUY_L1X: cap L1X per sell / buy run
//   - TREASURY_MAX_L1X_PER_DAY: cap total LIVE L1X sold/bought per day (per dir)
//   - slippage protection on the swap (TREASURY_SLIPPAGE_BPS)
//   - dry-run unless --execute

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { ethers } = require('ethers');
const lib = require('../uniswap/lib');
const cex = require('./cex');
const db = require('./db');

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const n = argv[i + 1];
    if (n == null || n.startsWith('--')) out[k] = true; else { out[k] = n; i++; }
  }
  return out;
}

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }

function dummyTx(tag) { return '0xDRY' + tag + Date.now().toString(16) + Math.random().toString(16).slice(2, 12); }

async function fetchCexPrice(side = 'bid') {
  // side='bid': highest bid = sell floor (what you'd get selling on CEX).
  // side='ask': lowest ask  = buy cap   (what you'd pay buying on CEX).
  const results = await Promise.allSettled(
    cex.EXCHANGES.map((name) => cex.fetchTickerPrice(cex.createArbClient(name), process.env.ARB_PAIR || 'L1X/USDT'))
  );
  const prices = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      const t = results[i].value;
      prices.push({ name: cex.EXCHANGES[i], price: (side === 'ask' ? (t.ask ?? t.price) : (t.bid ?? t.price)) });
    }
  }
  if (!prices.length) throw new Error('no CEX price available');
  prices.sort((a, b) => side === 'ask' ? a.price - b.price : b.price - a.price); // ask: lowest; bid: highest
  return prices[0];
}

// Treasury BUY (buyback): when DEX price is BELOW the CEX ask, buy L1X cheap
// on the DEX (spend USDT -> WETH -> L1X), up to the CEX ask price.
async function runBuy(args, config, provider, market, execute) {
  const CONFIG = {
    minDiscountPct: args['min-premium'] != null ? Number(args['min-premium']) : envNum('TREASURY_MIN_PREMIUM_PCT', 0.5),
    maxBuyL1x: args['max-l1x'] != null ? Number(args['max-l1x']) : envNum('TREASURY_MAX_BUY_L1X', 50),
    slippageBps: envNum('TREASURY_SLIPPAGE_BPS', 100)
  };
  const cexRef = await fetchCexPrice('ask');
  const ethUsd = await lib.resolveEthUsdPrice({ config, log: () => {} }).then((r) => r.price);
  const dexSpot = lib.poolL1xUsdPrice({ sqrtPriceX96: market.pool.sqrtPriceX96, pool: market.pool, l1x: market.l1x, weth: market.weth, ethUsdPrice: ethUsd });
  const discountPct = ((cexRef.price - dexSpot) / cexRef.price) * 100;
  log(`CEX cap (${cexRef.name} ask): $${cexRef.price.toFixed(4)} | DEX spot: $${dexSpot.toFixed(4)} | discount: ${discountPct.toFixed(3)}%`);

  const rec = { status: 'observed', direction: 'buy', cexFloorUsd: cexRef.price, cexSource: cexRef.name, dexSpotUsd: dexSpot, premiumPct: discountPct, ethUsd, isDryRun: !execute };
  async function record() {
    try { await db.init(); await db.insertTreasurySell(rec); log(`recorded to treasury_sells (buy, status=${rec.status})`); }
    catch (e) { log(`WARN not recorded: ${e.message.slice(0, 80)}`); } finally { await db.end().catch(() => {}); }
  }

  if (discountPct < CONFIG.minDiscountPct) {
    log(`discount ${discountPct.toFixed(3)}% below minimum ${CONFIG.minDiscountPct}% — not buying.`);
    rec.status = 'skipped'; await record(); return;
  }

  // ceiling: how much L1X to buy before DEX rises to the CEX ask
  const scanMax = envNum('TREASURY_CEILING_SCAN_MAX', 5000);
  const ceiling = await lib.maxBuySize({ config, provider, market, maxPriceUsd: cexRef.price, maxL1x: scanMax, stepL1x: 0.1, ethUsdPrice: ethUsd });
  if (ceiling.best) { rec.ceilingL1x = ceiling.best.sizeL1x; log(`TO REACH CAP $${cexRef.price.toFixed(4)}: buy ~${ceiling.best.sizeL1x.toFixed(2)} L1X (pool capacity), post-price $${ceiling.best.postPriceUsd.toFixed(4)}`); }

  // budget: treasury USDT
  let walletUsdt = null;
  if (config.walletAddress && config.usdtToken) {
    const usdtMeta = await lib.getTokenMeta(config.usdtToken, provider);
    const bal = await new ethers.Contract(config.usdtToken, lib.ERC20_ABI, provider).balanceOf(config.walletAddress);
    walletUsdt = Number(ethers.formatUnits(bal, usdtMeta.decimals));
  }
  const affordableL1x = (walletUsdt != null && dexSpot > 0) ? walletUsdt / dexSpot : CONFIG.maxBuyL1x;
  let buyEval;
  if (execute) {
    // Daily L1X volume cap (live only): never buy more than TREASURY_MAX_L1X_PER_DAY across all buys today.
    const dailyCap = envNum('TREASURY_MAX_L1X_PER_DAY', 50);
    const doneToday = await db.treasuryL1xToday('buy');
    const remainingDaily = dailyCap - doneToday;
    if (remainingDaily <= 0) {
      log(`daily L1X cap reached (${doneToday.toFixed(2)}/${dailyCap} bought today) — not buying.`);
      rec.status = 'skipped'; await record(); return;
    }
    const maxL1x = Math.min(CONFIG.maxBuyL1x, affordableL1x, remainingDaily);
    log(`treasury USDT: ${walletUsdt != null ? '$' + walletUsdt.toFixed(2) : 'n/a'} | cap: ${CONFIG.maxBuyL1x} | daily left: ${remainingDaily.toFixed(2)}/${dailyCap} | will buy up to: ${maxL1x.toFixed(4)} L1X`);
    if (maxL1x <= 0) { log('no USDT to buy with.'); rec.status = 'skipped'; await record(); return; }
    buyEval = (await lib.maxBuySize({ config, provider, market, maxPriceUsd: cexRef.price, maxL1x, stepL1x: Math.max(0.01, maxL1x / 128), ethUsdPrice: ethUsd })).best;
  } else if (ceiling.best && ceiling.best.sizeL1x <= CONFIG.maxBuyL1x) {
    buyEval = ceiling.best;
  } else {
    buyEval = (await lib.maxBuySize({ config, provider, market, maxPriceUsd: cexRef.price, maxL1x: CONFIG.maxBuyL1x, stepL1x: Math.max(0.01, CONFIG.maxBuyL1x / 128), ethUsdPrice: ethUsd })).best;
  }
  if (!buyEval) { log('no buy size keeps price below the CEX cap — not buying.'); rec.status = 'skipped'; await record(); return; }

  const sizeL1x = buyEval.sizeL1x;
  const wethIn = buyEval.wethIn;
  const usdtCost = buyEval.avgBuyPriceUsd * sizeL1x;
  rec.soldL1x = sizeL1x;                 // L1X amount (bought)
  rec.avgSellUsd = buyEval.avgBuyPriceUsd;
  rec.wethReceived = wethIn;             // WETH amount (spent)
  rec.usdtReceived = usdtCost;           // USDT amount (spent)
  rec.premiumCapturedUsd = (cexRef.price - buyEval.avgBuyPriceUsd) * sizeL1x; // discount captured
  log(`BUY ${sizeL1x.toFixed(4)} L1X @ avg $${buyEval.avgBuyPriceUsd.toFixed(4)} (cost ~${wethIn.toFixed(6)} WETH / ~$${usdtCost.toFixed(2)} USDT), post-price $${buyEval.postPriceUsd.toFixed(4)}`);
  log(`  discount captured vs CEX: ~$${rec.premiumCapturedUsd.toFixed(2)}`);

  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;

  if (!execute) {
    rec.sellGasUsd = Number(ethers.formatUnits(buyEval.quote.gasEstimate * gasPriceWei, 18)) * ethUsd;
    rec.convertGasUsd = rec.sellGasUsd;   // USDT->WETH leg estimate
    rec.sellTx = dummyTx('buy');
    rec.convertTx = dummyTx('conv');
    rec.status = 'executed';
    log(`[DRY] simulated buy: spend ~${wethIn.toFixed(6)} WETH for ${sizeL1x.toFixed(4)} L1X (gas ~$${rec.sellGasUsd.toFixed(4)}, tx ${rec.sellTx})`);
    try {
      await db.init();
      await db.insertTreasurySell(rec);
      await db.insertDexTrade({ side: 'treasury-buy', txHash: rec.sellTx, l1xAmount: sizeL1x, wethAmount: wethIn, avgPriceUsd: buyEval.avgBuyPriceUsd, ethUsd, gasUsd: rec.sellGasUsd, wallet: config.walletAddress, isDryRun: true });
      log('recorded (DRY): treasury_sells (buy) + dex_trades');
    } catch (e) { log(`WARN not recorded: ${e.message.slice(0, 80)}`); } finally { await db.end().catch(() => {}); }
    log(`[DRY] DONE: would buy ${sizeL1x.toFixed(4)} L1X for ~$${usdtCost.toFixed(2)}`);
    return;
  }

  // LIVE: ensure WETH (convert USDT->WETH for the needed amount + buffer), then buy
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const wethC = new ethers.Contract(config.weth, lib.ERC20_ABI, provider);
  const haveWeth = Number(ethers.formatEther(await wethC.balanceOf(config.walletAddress)));
  let convertGasUsd = null, convTx = null;
  if (haveWeth < wethIn) {
    const needUsdt = (wethIn - haveWeth) * ethUsd * 1.01; // +1% buffer
    const conv = await lib.swapUsdtToWeth({ config, provider, amountUsdt: needUsdt, slippageBps: CONFIG.slippageBps, log });
    convertGasUsd = Number(ethers.formatEther(conv.receipt.gasUsed * (conv.receipt.gasPrice ?? 0n))) * ethUsd;
    convTx = conv.receipt.hash;
    log(`converted ~$${needUsdt.toFixed(2)} USDT -> WETH for the buy (gas ~$${convertGasUsd.toFixed(4)})`);
  }
  const { receipt } = await lib.buyExactL1x({ config, provider, market, sizeL1x, slippageBps: CONFIG.slippageBps, log });
  const buyGasUsd = Number(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? 0n))) * ethUsd;
  rec.status = 'executed';
  rec.sellGasUsd = buyGasUsd;
  rec.convertGasUsd = convertGasUsd;
  rec.sellTx = receipt.hash;
  rec.convertTx = convTx;
  log(`bought ${sizeL1x.toFixed(4)} L1X (gas ~$${buyGasUsd.toFixed(4)})`);
  try {
    await db.init();
    await db.insertTreasurySell(rec);
    await db.insertDexTrade({ side: 'treasury-buy', txHash: receipt.hash, blockNumber: receipt.blockNumber, l1xAmount: sizeL1x, wethAmount: wethIn, avgPriceUsd: buyEval.avgBuyPriceUsd, ethUsd, gasUsd: buyGasUsd, wallet: config.walletAddress, isDryRun: false });
    if (convTx) await db.insertDexTrade({ side: 'convert-back', txHash: convTx, l1xAmount: 0, wethAmount: wethIn, avgPriceUsd: null, ethUsd, gasUsd: convertGasUsd, wallet: config.walletAddress, isDryRun: false });
    log('recorded: treasury_sells (buy) + dex_trades');
  } catch (e) { log(`WARN not recorded: ${e.message.slice(0, 80)}`); } finally { await db.end().catch(() => {}); }
  log(`DONE: bought ${sizeL1x.toFixed(4)} L1X for ~$${usdtCost.toFixed(2)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const execute = Boolean(args.execute);
  const CONFIG = {
    minPremiumPct: args['min-premium'] != null ? Number(args['min-premium']) : envNum('TREASURY_MIN_PREMIUM_PCT', 0.5),
    maxSellL1x: args['max-l1x'] != null ? Number(args['max-l1x']) : envNum('TREASURY_MAX_SELL_L1X', 50),
    slippageBps: envNum('TREASURY_SLIPPAGE_BPS', 100),
    convert: process.env.TREASURY_CONVERT_USDT !== 'false'   // convert WETH->USDT after selling
  };

  const dir = args.buy ? 'BUY' : 'SELL';

  // TREASURY_MODE gate: sell | buy | both — blocks disallowed directions.
  const mode = (process.env.TREASURY_MODE || 'both').toLowerCase();
  const wantBuy = Boolean(args.buy);
  if ((mode === 'sell' && wantBuy) || (mode === 'buy' && !wantBuy)) {
    log(`BLOCKED: TREASURY_MODE=${mode} does not allow a ${dir} — nothing done.`);
    return;
  }

  log(`TREASURY ${dir} — ${execute ? 'LIVE' : 'dry-run (add --execute to ' + dir.toLowerCase() + ')'} | TREASURY_MODE=${mode}`);

  const config = lib.getConfig();
  const provider = lib.getProvider(config);
  const market = await lib.loadMarket(config, provider);

  // --buy = treasury buyback (DEX below CEX). Default is sell (DEX above CEX).
  if (args.buy) { await runBuy(args, config, provider, market, execute); return; }

  // 1. reference floor = CEX price; 2. current DEX price
  const cexRef = await fetchCexPrice('bid');
  const ethUsd = await lib.resolveEthUsdPrice({ config, log: () => {} }).then((r) => r.price);
  const dexSpot = lib.poolL1xUsdPrice({
    sqrtPriceX96: market.pool.sqrtPriceX96, pool: market.pool, l1x: market.l1x, weth: market.weth, ethUsdPrice: ethUsd
  });
  const premiumPct = ((dexSpot - cexRef.price) / cexRef.price) * 100;

  log(`CEX floor (${cexRef.name} bid): $${cexRef.price.toFixed(4)} | DEX spot: $${dexSpot.toFixed(4)} | premium: ${premiumPct.toFixed(3)}%`);

  // Accounting record — written for EVERY run (observed / skipped / executed).
  const rec = {
    status: 'observed', cexFloorUsd: cexRef.price, cexSource: cexRef.name,
    dexSpotUsd: dexSpot, premiumPct, ethUsd, isDryRun: !execute
  };
  async function record() {
    try { await db.init(); await db.insertTreasurySell(rec); log(`recorded to treasury_sells (status=${rec.status})`); }
    catch (e) { log(`WARN treasury_sells not recorded: ${e.message.slice(0, 80)}`); }
    finally { await db.end().catch(() => {}); }
  }

  // 3. premium must clear the minimum
  if (premiumPct < CONFIG.minPremiumPct) {
    log(`premium ${premiumPct.toFixed(3)}% below minimum ${CONFIG.minPremiumPct}% — not selling.`);
    rec.status = 'skipped';
    await record();
    return;
  }

  // 4a. FULL capacity: how much L1X to sell to bring DEX down to the CEX floor
  //     (pool property — ignores wallet, capped by a generous scan bound)
  const scanMax = envNum('TREASURY_CEILING_SCAN_MAX', 5000);
  // Fine step (not scanMax-proportional) so the binary search resolves small
  // ceilings on a thin pool instead of exiting coarse and missing them.
  const ceiling = await lib.maxSellSize({
    config, provider, market, minPriceUsd: cexRef.price, maxL1x: scanMax,
    stepL1x: 0.1, ethUsdPrice: ethUsd
  });
  if (ceiling.best) {
    const c = ceiling.best;
    rec.ceilingL1x = c.sizeL1x;
    log(`TO REACH FLOOR $${cexRef.price.toFixed(4)}: sell ~${c.sizeL1x.toFixed(2)} L1X (pool capacity) -> ~${c.wethOut.toFixed(4)} WETH (~$${(c.avgSellPriceUsd * c.sizeL1x).toFixed(2)}), post-price $${c.postPriceUsd.toFixed(4)}`);
  } else {
    log(`TO REACH FLOOR $${cexRef.price.toFixed(4)}: even ${scanMax} L1X would not push the pool that low`);
  }

  // 4b. Pick the sell size.
  //   dry-run: simulate the IDEAL trade = full size down to the floor (the
  //            ceiling), capped by the per-run max — ignores the live wallet
  //            so you see the complete intended flow recorded.
  //   live:    constrained by the actual wallet balance + per-run max.
  let walletL1x = null;
  if (config.walletAddress) {
    const bal = await new ethers.Contract(config.l1xToken, lib.ERC20_ABI, provider).balanceOf(config.walletAddress);
    walletL1x = Number(ethers.formatUnits(bal, market.l1x.decimals));
  }
  rec.walletL1x = walletL1x;

  let sellEval;
  if (execute) {
    // Daily L1X volume cap (live only): never sell more than TREASURY_MAX_L1X_PER_DAY across all sells today.
    const dailyCap = envNum('TREASURY_MAX_L1X_PER_DAY', 50);
    const doneToday = await db.treasuryL1xToday('sell');
    const remainingDaily = dailyCap - doneToday;
    if (remainingDaily <= 0) {
      log(`daily L1X cap reached (${doneToday.toFixed(2)}/${dailyCap} sold today) — not selling.`);
      rec.status = 'skipped'; await record(); return;
    }
    const maxL1x = Math.min(CONFIG.maxSellL1x, walletL1x ?? CONFIG.maxSellL1x, remainingDaily);
    log(`treasury wallet L1X: ${walletL1x != null ? walletL1x.toFixed(4) : 'n/a'} | cap: ${CONFIG.maxSellL1x} | daily left: ${remainingDaily.toFixed(2)}/${dailyCap} | will sell up to: ${maxL1x.toFixed(4)}`);
    if (maxL1x <= 0) { log('no L1X in treasury wallet to sell.'); rec.status = 'skipped'; await record(); return; }
    sellEval = (await lib.maxSellSize({ config, provider, market, minPriceUsd: cexRef.price, maxL1x, stepL1x: Math.max(0.01, maxL1x / 128), ethUsdPrice: ethUsd })).best;
  } else if (ceiling.best && ceiling.best.sizeL1x <= CONFIG.maxSellL1x) {
    sellEval = ceiling.best;   // dry-run: simulate the full distance to the floor
  } else {
    sellEval = (await lib.maxSellSize({ config, provider, market, minPriceUsd: cexRef.price, maxL1x: CONFIG.maxSellL1x, stepL1x: Math.max(0.01, CONFIG.maxSellL1x / 128), ethUsdPrice: ethUsd })).best;
  }
  if (!sellEval) { log('no sell size keeps price above the CEX floor — not selling.'); rec.status = 'skipped'; await record(); return; }

  const sizeL1x = sellEval.sizeL1x;
  rec.soldL1x = sizeL1x;
  rec.avgSellUsd = sellEval.avgSellPriceUsd;
  rec.premiumCapturedUsd = (sellEval.avgSellPriceUsd - cexRef.price) * sizeL1x;
  log(`SELL ${sizeL1x.toFixed(4)} L1X @ avg $${sellEval.avgSellPriceUsd.toFixed(4)} -> ~${sellEval.wethOut.toFixed(6)} WETH (~$${(sellEval.avgSellPriceUsd * sizeL1x).toFixed(2)}), post-price $${sellEval.postPriceUsd.toFixed(4)}`);
  log(`  premium captured vs CEX: ~$${rec.premiumCapturedUsd.toFixed(2)}`);

  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;

  let wethReceived, sellGasUsd, sellTx, sellBlock = null;
  let usdtOut = null, convertGasUsd = null, convTx = null, convBlock = null;

  if (!execute) {
    // ---- DRY RUN: simulate the full flow with estimated values + dummy txs ----
    wethReceived = sellEval.wethOut;
    sellGasUsd = Number(ethers.formatUnits(sellEval.quote.gasEstimate * gasPriceWei, 18)) * ethUsd;
    sellTx = dummyTx('sell');
    log(`[DRY] simulated sell: ${wethReceived.toFixed(6)} WETH (gas ~$${sellGasUsd.toFixed(4)}, tx ${sellTx})`);
    if (CONFIG.convert && config.usdtToken) {
      const poolFee = config.usdtPoolFee / 1e6;            // 500 -> 0.0005
      usdtOut = wethReceived * ethUsd * (1 - poolFee);     // estimate
      convertGasUsd = sellGasUsd;
      convTx = dummyTx('conv');
      log(`[DRY] simulated convert: -> ${usdtOut.toFixed(2)} USDT (gas ~$${convertGasUsd.toFixed(4)}, tx ${convTx})`);
    }
  } else {
    // ---- LIVE: real sell + convert ----
    const { receipt } = await lib.sellL1x({ config, provider, market, sizeL1x, slippageBps: CONFIG.slippageBps, log });
    let gotWeth = 0n;
    for (const l of receipt.logs) { if (l.address.toLowerCase() !== config.weth.toLowerCase()) continue; try { const p = iface.parseLog(l); if (p?.name === 'Transfer' && p.args.to.toLowerCase() === config.walletAddress.toLowerCase()) gotWeth += p.args.value; } catch (_) {} }
    wethReceived = Number(ethers.formatEther(gotWeth));
    sellGasUsd = Number(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? 0n))) * ethUsd;
    sellTx = receipt.hash; sellBlock = receipt.blockNumber;
    log(`sold: received ${wethReceived.toFixed(6)} WETH (gas ~$${sellGasUsd.toFixed(4)})`);
    if (CONFIG.convert && config.usdtToken) {
      const conv = await lib.swapWethToUsdt({ config, provider, amountWeth: wethReceived, slippageBps: CONFIG.slippageBps, log });
      let got = 0n;
      for (const l of conv.receipt.logs) { if (l.address.toLowerCase() !== config.usdtToken.toLowerCase()) continue; try { const p = iface.parseLog(l); if (p?.name === 'Transfer' && p.args.to.toLowerCase() === config.walletAddress.toLowerCase()) got += p.args.value; } catch (_) {} }
      usdtOut = Number(ethers.formatUnits(got, conv.usdt.decimals));
      convertGasUsd = Number(ethers.formatEther(conv.receipt.gasUsed * (conv.receipt.gasPrice ?? 0n))) * ethUsd;
      convTx = conv.receipt.hash; convBlock = conv.receipt.blockNumber;
      log(`converted: ${wethReceived.toFixed(6)} WETH -> ${usdtOut.toFixed(2)} USDT (gas ~$${convertGasUsd.toFixed(4)})`);
    }
  }

  rec.status = 'executed';
  rec.wethReceived = wethReceived;
  rec.sellGasUsd = sellGasUsd;
  rec.convertGasUsd = convertGasUsd;
  rec.usdtReceived = usdtOut;
  rec.sellTx = sellTx;
  rec.convertTx = convTx;

  // record: treasury_sells (full context) + dex_trades (sell + convert)
  try {
    await db.init();
    await db.insertTreasurySell(rec);
    await db.insertDexTrade({ side: 'treasury-sell', txHash: sellTx, blockNumber: sellBlock, l1xAmount: sizeL1x, wethAmount: wethReceived, avgPriceUsd: sellEval.avgSellPriceUsd, ethUsd, gasUsd: sellGasUsd, wallet: config.walletAddress, isDryRun: !execute });
    if (convTx) await db.insertDexTrade({ side: 'convert', txHash: convTx, blockNumber: convBlock, l1xAmount: 0, wethAmount: wethReceived, avgPriceUsd: wethReceived > 0 ? usdtOut / wethReceived : null, ethUsd, gasUsd: convertGasUsd, wallet: config.walletAddress, isDryRun: !execute });
    log(`recorded${execute ? '' : ' (DRY)'}: treasury_sells + dex_trades (sell + convert)`);
  } catch (e) {
    log(`WARN not recorded to DB: ${e.message.slice(0, 80)}`);
  } finally {
    await db.end().catch(() => {});
  }

  log(`${execute ? 'DONE' : '[DRY] DONE'}: sold ${sizeL1x.toFixed(4)} L1X${usdtOut != null ? ` -> ${usdtOut.toFixed(2)} USDT` : ` -> ${wethReceived.toFixed(6)} WETH`}`);
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
