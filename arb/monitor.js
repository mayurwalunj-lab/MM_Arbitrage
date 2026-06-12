#!/usr/bin/env node

'use strict';

// CEX->DEX arbitrage detection monitor. DRY-RUN ONLY: this process never
// places orders or sends transactions. It watches Bitmart/LBank L1X books
// and the Uniswap pool, computes the net edge for the optimal size, and logs
// opportunities to arb/state/opportunities.jsonl for offline analysis.
//
// Protections (all must pass before an opportunity is recorded):
//   - HALT file              arb/state/HALT pauses all evaluation
//   - grid refresh flag      arb/state/grid_refreshing_<exchange>.flag set by
//                            the grid bots around cancel-all/re-place windows
//   - self-trade filter      own MM/grid orders are subtracted from the book
//   - book sanity            spread/depth checks catch thin or broken books
//   - staleness              slow ticks are discarded, never evaluated
//   - persistence            edge must survive ARB_PERSIST_TICKS consecutive
//                            ticks before it counts as real

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const lib = require('../uniswap/lib');
const cex = require('./cex');
const arbDb = require('./db');
const executor = require('./executor');
const { bookSanity } = require('./orderbook');
const { findOpportunities } = require('./edge');

let dbReady = false;

const STATE_DIR = path.join(__dirname, 'state');
const HALT_FILE = path.join(STATE_DIR, 'HALT');
const OPPORTUNITIES_FILE = path.join(STATE_DIR, 'opportunities.jsonl');

function envNum(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const CONFIG = {
  pair: process.env.ARB_PAIR || 'L1X/USDT',
  pollMs: envNum('ARB_POLL_MS', 5000),
  minEdgeUsd: envNum('ARB_MIN_EDGE_USD', 20),
  minTradeL1x: envNum('ARB_MIN_TRADE_L1X', 10),
  maxTradeL1x: envNum('ARB_MAX_TRADE_L1X', 1000),
  cexTakerFeeBps: envNum('ARB_CEX_TAKER_FEE_BPS', 25),
  gasLimitSwap: envNum('ARB_GAS_LIMIT_SWAP', 200000),
  maxSpreadPct: envNum('ARB_MAX_SPREAD_PCT', 2),
  minDepthL1x: envNum('ARB_MIN_DEPTH_L1X', 50),
  depthRangePct: envNum('ARB_DEPTH_RANGE_PCT', 2),
  persistTicks: envNum('ARB_PERSIST_TICKS', 3),
  staleMs: envNum('ARB_STALE_MS', 3000),
  ownOrdersTtlMs: envNum('ARB_OWN_ORDERS_TTL_MS', 10000),
  // Set ARB_SELF_TRADE_FILTER=false to evaluate the raw book WITH our own
  // orders included. Detection-only use (e.g. off-server testing, measuring
  // how much of the book is ours) — edges found this way may be wash trades.
  selfTradeFilter: process.env.ARB_SELF_TRADE_FILTER !== 'false',
  // Stage B/C: ARB_AUTO_EXECUTE=true lets the monitor fire the executor on
  // confirmed opportunities. Orders stay simulated unless ARB_DRY_RUN=false
  // too — both switches must be flipped for live auto-trading.
  autoExecute: process.env.ARB_AUTO_EXECUTE === 'true',
  autoMinEdgeUsd: envNum('ARB_AUTO_MIN_EDGE_USD', envNum('ARB_MIN_EDGE_USD', 20) * 2)
};

const autoState = { cooldownUntil: 0 };

function ts() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${ts()}] ${message}`);
}

function gridRefreshFlag(exchangeId) {
  return path.join(STATE_DIR, `grid_refreshing_${exchangeId}.flag`);
}

function appendOpportunity(record) {
  // JSONL always (survives DB outages); DB best-effort for querying/reports.
  fs.appendFileSync(OPPORTUNITIES_FILE, JSON.stringify(record) + '\n');
  if (dbReady) {
    arbDb.insertOpportunity(record).catch((error) => log(`WARN db insert failed: ${error.message}`));
  }
}

// --- per-exchange runtime state ----------------------------------------

function buildExchangeState(exchangeId) {
  const ownClients = cex.createOwnAccountClients(exchangeId);
  return {
    name: exchangeId,
    client: cex.createArbClient(exchangeId),
    ownClients,
    ownOrdersCache: { orders: [], fetchedAt: 0 },
    streak: 0
  };
}

async function getOwnOrders(ex) {
  if (!CONFIG.selfTradeFilter) return { orders: [], filterOk: false, filterMode: 'off' };
  if (!ex.ownClients.length) return { orders: [], filterOk: false };
  const age = Date.now() - ex.ownOrdersCache.fetchedAt;
  if (age < CONFIG.ownOrdersTtlMs) return ex.ownOrdersCache;
  const { orders, errors } = await cex.fetchOwnOpenOrders(ex.ownClients, CONFIG.pair);
  for (const error of errors) log(`WARN ${ex.name} own-orders fetch: ${String(error).slice(0, 140)}`);
  // On partial failure keep going with what we got; sanity checks backstop us,
  // and filterOk=false marks recorded opportunities as possibly self-trades.
  ex.ownOrdersCache = { orders, fetchedAt: Date.now(), filterOk: errors.length === 0 };
  return ex.ownOrdersCache;
}

async function resolveEthUsd(exchangeStates, uniConfig) {
  const results = await Promise.allSettled(
    exchangeStates.map((ex) => cex.fetchTickerPrice(ex.client, 'ETH/USDT'))
  );
  const prices = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      prices.push({ name: exchangeStates[i].name, price: results[i].value.price });
    }
  }
  if (prices.length) {
    return {
      price: prices.reduce((sum, p) => sum + p.price, 0) / prices.length,
      source: prices.map((p) => p.name).join('+')
    };
  }
  if (uniConfig.ethUsdPrice) return { price: uniConfig.ethUsdPrice, source: 'ETH_USD_PRICE' };
  return null;
}

// --- auto-execution (Stage B/C) -------------------------------------------

async function maybeAutoExecute({ uniConfig, provider, market, exchangeStates, candidates, best, exchangeName }) {
  if (!CONFIG.autoExecute) return;
  if (best.netUsd < CONFIG.autoMinEdgeUsd) {
    log(`auto-exec skip: net $${best.netUsd.toFixed(2)} < auto threshold $${CONFIG.autoMinEdgeUsd}`);
    return;
  }
  if (Date.now() < autoState.cooldownUntil) {
    log('auto-exec skip: cooldown active');
    return;
  }
  autoState.cooldownUntil = Date.now() + executor.execConfig().cooldownMs;

  const arbClients = Object.fromEntries(exchangeStates.map((ex) => [ex.name, ex.client]));
  const ownOrdersByExchange = Object.fromEntries(candidates.map((c) => [c.name, c.ownOrders]));
  try {
    const result = await executor.executeOpportunity({
      config: uniConfig,
      provider,
      market,
      arbClients,
      ownOrdersByExchange,
      options: {
        pair: CONFIG.pair,
        minEdgeUsd: CONFIG.autoMinEdgeUsd,
        minTradeL1x: CONFIG.minTradeL1x,
        maxTradeL1x: CONFIG.maxTradeL1x,
        cexTakerFeeBps: CONFIG.cexTakerFeeBps,
        gasLimitSwap: CONFIG.gasLimitSwap,
        maxSpreadPct: CONFIG.maxSpreadPct,
        minDepthL1x: CONFIG.minDepthL1x,
        depthRangePct: CONFIG.depthRangePct
      },
      opportunity: { direction: best.direction, exchangeName, sizeL1x: best.sizeL1x },
      log
    });
    log(`auto-exec result: ${result.status}${result.realizedPnlUsdt != null ? ` pnl $${result.realizedPnlUsdt.toFixed(2)}` : ''}`);
  } catch (error) {
    log(`auto-exec refused/failed: ${error.message}`);
  }
  for (const ex of exchangeStates) ex.streak = 0;
}

// --- main loop -----------------------------------------------------------

async function tick({ uniConfig, provider, market, exchangeStates }) {
  if (fs.existsSync(HALT_FILE)) {
    log('HALT file present — skipping tick (remove arb/state/HALT to resume)');
    for (const ex of exchangeStates) ex.streak = 0;
    return;
  }

  const tickStart = Date.now();

  const [ethUsd, feeData, poolInfo, walletBal, ...bookResults] = await Promise.all([
    resolveEthUsd(exchangeStates, uniConfig),
    provider.getFeeData(),
    lib.getPoolInfo(uniConfig, provider),
    uniConfig.walletAddress
      ? (async () => {
          try {
            const l1xContract = new ethers.Contract(uniConfig.l1xToken, lib.ERC20_ABI, provider);
            const wethContract = new ethers.Contract(uniConfig.weth, lib.ERC20_ABI, provider);
            const [l1xBal, wethBal, ethBal] = await Promise.all([
              l1xContract.balanceOf(uniConfig.walletAddress),
              wethContract.balanceOf(uniConfig.walletAddress),
              provider.getBalance(uniConfig.walletAddress)
            ]);
            return {
              l1x: Number(ethers.formatUnits(l1xBal, market.l1x.decimals)),
              ethTotal: Number(ethers.formatEther(wethBal)) + Number(ethers.formatEther(ethBal))
            };
          } catch (_) {
            return null;
          }
        })()
      : Promise.resolve(null),
    ...exchangeStates.map(async (ex) => {
      try {
        const [book, own] = await Promise.all([
          cex.fetchOrderBook(ex.client, CONFIG.pair),
          getOwnOrders(ex)
        ]);
        return { ex, book, ownOrders: own.orders, filterOk: own.filterOk };
      } catch (error) {
        return { ex, error: error.message };
      }
    })
  ]);

  const fetchMs = Date.now() - tickStart;
  if (fetchMs > CONFIG.staleMs) {
    log(`STALE tick discarded: fetches took ${fetchMs}ms > ${CONFIG.staleMs}ms`);
    for (const ex of exchangeStates) ex.streak = 0;
    return;
  }

  if (!ethUsd) {
    log('SKIP tick: no ETH/USD price available');
    return;
  }

  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  const dexSpotUsd = lib.poolL1xUsdPrice({
    sqrtPriceX96: poolInfo.sqrtPriceX96,
    pool: poolInfo,
    l1x: market.l1x,
    weth: market.weth,
    ethUsdPrice: ethUsd.price
  });

  // Per-exchange gating: refresh flag, fetch errors, book sanity.
  const candidates = [];
  const summaries = [];
  for (const result of bookResults) {
    const { ex } = result;
    if (fs.existsSync(gridRefreshFlag(ex.name))) {
      log(`${ex.name}: grid refresh in progress — skipping`);
      ex.streak = 0;
      continue;
    }
    if (result.error) {
      log(`${ex.name}: fetch failed — ${String(result.error).slice(0, 140)}`);
      ex.streak = 0;
      continue;
    }
    const sanity = bookSanity(result.book, result.ownOrders, {
      maxSpreadPct: CONFIG.maxSpreadPct,
      minDepthBase: CONFIG.minDepthL1x,
      depthRangePct: CONFIG.depthRangePct
    });
    if (!sanity.ok) {
      log(`${ex.name}: book failed sanity — ${sanity.reasons.join('; ')}`);
      ex.streak = 0;
      continue;
    }
    candidates.push({ name: ex.name, book: result.book, ownOrders: result.ownOrders, filterOk: result.filterOk, ex, sanity });
  }

  if (!candidates.length) return;

  const walletL1x = walletBal?.l1x ?? null;
  const walletEthTotal = walletBal?.ethTotal ?? null;

  const result = await findOpportunities({
    config: uniConfig,
    provider,
    market,
    ethUsdPrice: ethUsd.price,
    gasPriceWei,
    dexSpotUsd,
    exchanges: candidates,
    options: {
      maxTradeL1x: CONFIG.maxTradeL1x,
      minTradeL1x: CONFIG.minTradeL1x,
      cexTakerFeeBps: CONFIG.cexTakerFeeBps,
      gasLimitSwap: CONFIG.gasLimitSwap,
      walletL1x,
      walletEthTotal
    }
  });
  const { perExchange, gasUsd, skipped, minAsk, maxBid, forward, reverse } = result;

  if (skipped === 'no-spread') {
    for (const ex of exchangeStates) ex.streak = 0;
    log(`tick dexSpot=$${dexSpotUsd.toFixed(4)} eth=$${ethUsd.price.toFixed(0)} | no spread: dex inside bid $${maxBid?.toFixed(4)} .. ask $${minAsk?.toFixed(4)}`);
    return;
  }

  const statusNotes = [];
  for (const [label, dir] of [['sell-dex', forward], ['buy-dex', reverse]]) {
    if (!dir) continue;
    if (dir.inventoryBlocked) {
      statusNotes.push(`${label} blocked: inventory ${dir.maxFeasible?.toFixed(4)} L1X-eq < min trade ${CONFIG.minTradeL1x}`);
    } else if (dir.tooSmall) {
      statusNotes.push(`${label} blocked: ceiling ${dir.ceilingL1x?.toFixed(2)} L1X < min trade ${CONFIG.minTradeL1x}`);
    }
  }

  for (const candidate of candidates) {
    const { ex } = candidate;
    const best = perExchange[candidate.name];
    if (!best) {
      ex.streak = 0;
      summaries.push(`${ex.name}: no feasible size`);
      continue;
    }

    const summary = `${ex.name}[${best.direction}] size=${best.sizeL1x.toFixed(2)} dex=$${best.dexAvgPriceUsd.toFixed(4)} cex=$${best.cexAvgPriceUsd.toFixed(4)} net=$${best.netUsd.toFixed(2)}`;
    if (best.netUsd >= CONFIG.minEdgeUsd) {
      ex.streak++;
      if (ex.streak >= CONFIG.persistTicks) {
        log(`OPPORTUNITY ${summary} (streak ${ex.streak})`);
        appendOpportunity({
          ts: ts(),
          exchange: ex.name,
          selfTradeFilterOk: candidate.filterOk,
          filterMode: !CONFIG.selfTradeFilter ? 'off' : (candidate.filterOk ? 'on' : 'degraded'),
          ethUsd: ethUsd.price,
          ethUsdSource: ethUsd.source,
          dexSpotUsd,
          boundaryUsd: best.direction === 'sell-dex' ? forward?.floorUsd : reverse?.capUsd,
          ceilingL1x: best.direction === 'sell-dex' ? forward?.ceilingL1x : reverse?.ceilingL1x,
          cexMid: candidate.sanity.mid,
          cexSpreadPct: candidate.sanity.spreadPct,
          externalAskDepth: candidate.sanity.askDepth,
          walletL1x,
          streak: ex.streak,
          ...best
        });
        await maybeAutoExecute({ uniConfig, provider, market, exchangeStates, candidates, best, exchangeName: ex.name });
      } else {
        log(`candidate ${summary} (streak ${ex.streak}/${CONFIG.persistTicks})`);
      }
    } else {
      ex.streak = 0;
      summaries.push(summary);
    }
  }

  const parts = [...statusNotes, ...summaries];
  if (parts.length) {
    const ceilings = [
      forward?.ceilingL1x != null ? `fwdCeil=${forward.ceilingL1x.toFixed(1)}` : null,
      reverse?.ceilingL1x != null ? `revCeil=${reverse.ceilingL1x.toFixed(1)}` : null
    ].filter(Boolean).join(' ');
    log(`tick dexSpot=$${dexSpotUsd.toFixed(4)} eth=$${ethUsd.price.toFixed(0)} gas=$${gasUsd?.toFixed(2) ?? '?'}${ceilings ? ' ' + ceilings : ''} | ${parts.join(' | ')}`);
  }
}

async function main() {
  const once = process.argv.includes('--once');
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const uniConfig = lib.getConfig();
  const provider = lib.getProvider(uniConfig);
  const market = await lib.loadMarket(uniConfig, provider);
  const exchangeStates = cex.EXCHANGES.map(buildExchangeState);

  // ccxt clients need markets loaded before private endpoints map symbols
  // correctly; load once per exchange and share with the own-account clients.
  for (const ex of exchangeStates) {
    try {
      const markets = await ex.client.loadMarkets();
      for (const { client } of ex.ownClients) client.setMarkets(markets, ex.client.currencies);
    } catch (error) {
      log(`WARN ${ex.name} loadMarkets failed: ${error.message}`);
    }
  }

  try {
    await arbDb.init();
    dbReady = true;
    log('accounting DB connected (arb_* tables)');
  } catch (error) {
    log(`WARN accounting DB unavailable, JSONL only: ${error.message.slice(0, 100)}`);
  }

  const liveOrders = process.env.ARB_DRY_RUN === 'false';
  if (CONFIG.autoExecute) {
    log(`AUTO-EXECUTE ARMED (threshold $${CONFIG.autoMinEdgeUsd}/trade) — orders are ${liveOrders ? 'LIVE' : 'SIMULATED (ARB_DRY_RUN not false)'}`);
  } else {
    log('arb monitor starting (detection only — ARB_AUTO_EXECUTE not set)');
  }
  log(`pair=${CONFIG.pair} poll=${CONFIG.pollMs}ms minEdge=$${CONFIG.minEdgeUsd} size=${CONFIG.minTradeL1x}-${CONFIG.maxTradeL1x} L1X persist=${CONFIG.persistTicks} ticks`);
  if (!CONFIG.selfTradeFilter) {
    log('WARN self-trade filter DISABLED by config (ARB_SELF_TRADE_FILTER=false) — edges may include your own orders');
  } else {
    for (const ex of exchangeStates) {
      if (ex.ownClients.length) {
        log(`${ex.name}: self-trade filter active (${ex.ownClients.map((c) => c.label).join(', ')})`);
      } else {
        log(`WARN ${ex.name}: no MM/grid API keys found — self-trade filter DISABLED; edges may include your own orders`);
      }
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick({ uniConfig, provider, market, exchangeStates });
    } catch (error) {
      log(`tick error: ${error.message}`);
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, CONFIG.pollMs));
  }

  // The MySQL pool keeps the event loop alive; release it so --once exits.
  if (dbReady) await arbDb.end().catch(() => {});
}

main().catch((error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
