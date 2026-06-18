#!/usr/bin/env node

'use strict';

// Arb accounting CLI backed by MySQL (arb_* tables).
//
//   node arb/accounting.js report
//   node arb/accounting.js snapshot
//   node arb/accounting.js record-trade --exchange lbank --size 21 \
//     --dex-tx 0x... --weth-out 0.110 --cex-price 8.55 --hedge-price 1655 \
//     [--gas-usd 0.05] [--fee-bps 25] [--cex-order-id X] [--hedge-order-id Y] [--notes "..."]
//
// record-trade computes realized PnL in USDT:
//   pnl = hedge proceeds (weth_out * hedge_price, minus taker fee)
//       - CEX buy cost  (size * cex_price, plus taker fee)
//       - gas

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { ethers } = require('ethers');
const db = require('./db');
const lib = require('../uniswap/lib');
const cex = require('./cex');

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

function num(args, name, required = true) {
  const value = args[name];
  if (value == null || value === true) {
    if (required) throw new Error(`--${name} is required`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

async function commandReport() {
  const { opps, oppsByDay, trades, tradesByDay, latestSnapshot, dexTrades, recentDexTrades } = await db.report();

  console.log('=== ARB ACCOUNTING REPORT ===');
  console.log('');
  console.log(`Opportunities recorded: ${opps.total} | total potential: $${Number(opps.potential).toFixed(2)} | avg: $${Number(opps.avg_net).toFixed(2)} | best: $${Number(opps.best).toFixed(2)}`);
  if (oppsByDay.length) {
    console.log('  by day:');
    for (const row of oppsByDay) {
      console.log(`    ${row.day instanceof Date ? row.day.toISOString().slice(0, 10) : row.day} ${row.exchange}: ${row.n} opps, avg $${row.avg_net}, best $${row.best}`);
    }
  }
  console.log('');
  console.log(`Trades executed: ${trades.total} | REALIZED PNL: $${Number(trades.pnl).toFixed(2)} USDT`);
  if (tradesByDay.length) {
    console.log('  by day:');
    for (const row of tradesByDay) {
      console.log(`    ${row.day instanceof Date ? row.day.toISOString().slice(0, 10) : row.day}: ${row.n} trades, pnl $${row.pnl}`);
    }
  }
  console.log('');
  console.log(`DEX swaps recorded: ${dexTrades.total} | total gas spent: $${Number(dexTrades.gas).toFixed(2)}`);
  for (const row of recentDexTrades) {
    const ts = row.timestamp instanceof Date ? row.timestamp.toISOString().slice(0, 16) : row.timestamp;
    console.log(`    ${ts} ${row.side.toUpperCase().padEnd(4)} ${Number(row.l1x_amount).toFixed(4)} L1X <-> ${Number(row.weth_amount).toFixed(6)} WETH @ $${Number(row.avg_price_usd ?? 0).toFixed(4)} (${(row.tx_hash || '').slice(0, 14)}...)`);
  }
  console.log('');
  if (latestSnapshot) {
    const s = latestSnapshot;
    console.log(`Latest inventory snapshot (${s.timestamp instanceof Date ? s.timestamp.toISOString() : s.timestamp}):`);
    console.log(`  wallet: ${s.wallet_l1x} L1X | ${s.wallet_weth} WETH | ${s.wallet_eth} ETH`);
    console.log(`  bitmart: ${s.bitmart_l1x ?? '?'} L1X | ${s.bitmart_usdt ?? '?'} USDT | lbank: ${s.lbank_l1x ?? '?'} L1X | ${s.lbank_usdt ?? '?'} USDT`);
    console.log(`  total value: $${s.total_value_usd ?? '?'} (ETH $${s.eth_usd}, L1X $${s.l1x_usd})`);
  } else {
    console.log('No inventory snapshots yet. Run: npm run arb:snapshot');
  }
}

async function commandRecordTrade(args) {
  const exchange = args.exchange;
  if (!exchange || exchange === true) throw new Error('--exchange is required (bitmart|lbank)');
  const sizeL1x = num(args, 'size');
  const wethOut = num(args, 'weth-out');
  const cexPrice = num(args, 'cex-price');
  const hedgePrice = num(args, 'hedge-price');
  const gasUsd = num(args, 'gas-usd', false) ?? 0;
  const feeBps = num(args, 'fee-bps', false) ?? 25;
  const feeRate = feeBps / 10000;

  const hedgeProceeds = wethOut * hedgePrice;
  const hedgeFeeUsd = hedgeProceeds * feeRate;
  const cexCost = sizeL1x * cexPrice;
  const cexFeeUsd = cexCost * feeRate;
  const realizedPnlUsdt = hedgeProceeds - hedgeFeeUsd - cexCost - cexFeeUsd - gasUsd;

  await db.init();
  const id = await db.insertTrade({
    exchange,
    sizeL1x,
    dexTxHash: typeof args['dex-tx'] === 'string' ? args['dex-tx'] : null,
    dexWethOut: wethOut,
    dexAvgSellUsd: hedgeProceeds / sizeL1x,
    dexGasUsd: gasUsd,
    cexOrderId: typeof args['cex-order-id'] === 'string' ? args['cex-order-id'] : null,
    cexAvgPrice: cexPrice,
    cexFeeUsd,
    hedgeOrderId: typeof args['hedge-order-id'] === 'string' ? args['hedge-order-id'] : null,
    hedgeEthAmount: wethOut,
    hedgeAvgPrice: hedgePrice,
    hedgeFeeUsd,
    ethUsd: hedgePrice,
    realizedPnlUsdt,
    notes: typeof args.notes === 'string' ? args.notes : null
  });

  console.log(`Trade #${id} recorded.`);
  console.log(`  sell ${sizeL1x} L1X on DEX -> ${wethOut} WETH`);
  console.log(`  hedge: ${wethOut} ETH @ $${hedgePrice} = $${hedgeProceeds.toFixed(2)} (fee $${hedgeFeeUsd.toFixed(2)})`);
  console.log(`  CEX buy: ${sizeL1x} L1X @ $${cexPrice} = $${cexCost.toFixed(2)} (fee $${cexFeeUsd.toFixed(2)})`);
  console.log(`  gas: $${gasUsd.toFixed(2)}`);
  console.log(`  REALIZED PNL: $${realizedPnlUsdt.toFixed(2)} USDT`);
}

async function commandSnapshot() {
  const config = lib.getConfig();
  const provider = lib.getProvider(config);
  const market = await lib.loadMarket(config, provider);

  // Snapshots record real balances; the flag marks whether the machine that
  // took them runs in dry-run mode (true everywhere except live production).
  const snapshot = { timestamp: new Date(), isDryRun: process.env.ARB_DRY_RUN !== 'false' };

  if (config.walletAddress) {
    const l1xContract = new ethers.Contract(config.l1xToken, lib.ERC20_ABI, provider);
    const wethContract = new ethers.Contract(config.weth, lib.ERC20_ABI, provider);
    const [l1xBal, wethBal, ethBal] = await Promise.all([
      l1xContract.balanceOf(config.walletAddress),
      wethContract.balanceOf(config.walletAddress),
      provider.getBalance(config.walletAddress)
    ]);
    snapshot.walletL1x = Number(ethers.formatUnits(l1xBal, market.l1x.decimals));
    snapshot.walletWeth = Number(ethers.formatEther(wethBal));
    snapshot.walletEth = Number(ethers.formatEther(ethBal));
    if (config.usdtToken) {
      try {
        const usdtC = new ethers.Contract(config.usdtToken, lib.ERC20_ABI, provider);
        const usdtMeta = await lib.getTokenMeta(config.usdtToken, provider);
        const usdtBal = await usdtC.balanceOf(config.walletAddress);
        snapshot.walletUsdt = Number(ethers.formatUnits(usdtBal, usdtMeta.decimals));
      } catch (_) { /* skip */ }
    }
  }

  for (const name of cex.EXCHANGES) {
    const client = cex.createArbClient(name);
    if (!client.arbHasKeys) continue;
    try {
      const balances = await cex.fetchBalances(client, ['L1X', 'USDT', 'ETH']);
      snapshot[`${name}L1x`] = balances.L1X;
      snapshot[`${name}Usdt`] = balances.USDT;
      snapshot[`${name}Eth`] = balances.ETH;
    } catch (error) {
      console.log(`WARN ${name} balances unavailable: ${error.message.slice(0, 80)}`);
    }
  }

  try {
    const ethUsd = await lib.resolveEthUsdPrice({ config, log: () => {} });
    snapshot.ethUsd = ethUsd.price;
    snapshot.l1xUsd = lib.poolL1xUsdPrice({
      sqrtPriceX96: market.pool.sqrtPriceX96,
      pool: market.pool,
      l1x: market.l1x,
      weth: market.weth,
      ethUsdPrice: ethUsd.price
    });
    const l1xTotal = (snapshot.walletL1x ?? 0) + (snapshot.bitmartL1x ?? 0) + (snapshot.lbankL1x ?? 0);
    const ethTotal = (snapshot.walletEth ?? 0) + (snapshot.walletWeth ?? 0) + (snapshot.bitmartEth ?? 0) + (snapshot.lbankEth ?? 0);
    const usdtTotal = (snapshot.walletUsdt ?? 0) + (snapshot.bitmartUsdt ?? 0) + (snapshot.lbankUsdt ?? 0);
    snapshot.totalValueUsd = l1xTotal * snapshot.l1xUsd + ethTotal * snapshot.ethUsd + usdtTotal;
  } catch (error) {
    console.log(`WARN pricing unavailable: ${error.message.slice(0, 80)}`);
  }

  await db.init();
  await db.insertSnapshot(snapshot);
  console.log('Snapshot recorded:');
  console.log(`  wallet: ${snapshot.walletL1x ?? '?'} L1X | ${snapshot.walletWeth ?? '?'} WETH | ${snapshot.walletEth ?? '?'} ETH`);
  console.log(`  bitmart: ${snapshot.bitmartL1x ?? 'no keys'} | lbank: ${snapshot.lbankL1x ?? 'no keys'}`);
  console.log(`  total value: $${snapshot.totalValueUsd?.toFixed(2) ?? '?'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === 'report') {
      await db.init();
      await commandReport();
    } else if (command === 'record-trade') {
      await commandRecordTrade(args);
    } else if (command === 'snapshot') {
      await commandSnapshot();
    } else {
      console.log('Usage: node arb/accounting.js <report|record-trade|snapshot> [options]');
      process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
}

main();
