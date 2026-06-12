'use strict';

// Phase 2 executor: runs one three-leg arbitrage round.
//
//   forward (sell-dex):  leg1 BUY L1X on CEX -> leg2 SELL L1X on Uniswap
//                        -> leg3 SELL the received ETH on CEX
//   reverse (buy-dex):   leg1 SELL L1X on CEX -> leg2 BUY L1X on Uniswap
//                        -> leg3 BUY back the spent ETH on CEX
//
// Master lock: unless ARB_DRY_RUN=false, every order/swap is SIMULATED — the
// full flow runs, logs "[DRY]" lines, and journals with dryRun=true.
//
// Safety rails (all enforced before leg 1):
//   - HALT file stops everything
//   - one round in flight at a time (lock file with stale timeout)
//   - per-trade USD cap, max rounds per hour, daily loss limit
//   - fresh re-detection: the edge must still exist at execution time
//
// Failure handling:
//   - leg1 unfilled within timeout -> cancel, abort (no position, no loss)
//   - leg1 partial fill            -> continue with the filled amount
//   - leg2 fails after leg1 filled -> unwind leg1 on the CEX, ALERT
//   - leg3 fails                   -> retry 3x, then ALERT (bounded ETH
//                                     exposure, recorded as hedge_pending)

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const lib = require('../uniswap/lib');
const cex = require('./cex');
const arbDb = require('./db');
const { bookSanity } = require('./orderbook');
const { findOpportunities } = require('./edge');

const STATE_DIR = path.join(__dirname, 'state');
const HALT_FILE = path.join(STATE_DIR, 'HALT');
const LOCK_FILE = path.join(STATE_DIR, 'EXECUTING');
const JOURNAL_FILE = path.join(STATE_DIR, 'trades.jsonl');
const LOCK_STALE_MS = 3 * 60 * 1000;
const HEDGE_SYMBOL = 'ETH/USDT';

function envNum(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function execConfig() {
  return {
    dryRun: process.env.ARB_DRY_RUN !== 'false',
    maxTradeUsd: envNum('ARB_EXEC_MAX_TRADE_USD', 200),
    maxTradesPerHour: envNum('ARB_EXEC_MAX_TRADES_PER_HOUR', 6),
    dailyLossLimitUsd: envNum('ARB_EXEC_DAILY_LOSS_LIMIT_USD', 20),
    legTimeoutMs: envNum('ARB_EXEC_LEG_TIMEOUT_MS', 10000),
    priceBufferBps: envNum('ARB_EXEC_PRICE_BUFFER_BPS', 10),
    cooldownMs: envNum('ARB_EXEC_COOLDOWN_MS', 60000),
    slippageBps: envNum('ARB_EXEC_SLIPPAGE_BPS', 100),
    cexTakerFeeBps: envNum('ARB_CEX_TAKER_FEE_BPS', 25)
  };
}

function journalAppend(entry) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n');
}

function journalToday() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    return fs.readFileSync(JOURNAL_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter((entry) => entry && !entry.dryRun && entry.ts?.startsWith(today));
  } catch (_) {
    return [];
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    const stat = fs.statSync(LOCK_FILE);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
    // stale lock from a crashed run — take it over
  } catch (_) { /* no lock */ }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* gone */ }
}

// ---------------------------------------------------------------------------
// One-shot detection (used by the CLI and to re-verify before executing).
// Returns { best, exchangeName, ethUsd, gasUsd, dexSpotUsd, context } or null.
// restrictTo: { exchangeName, direction } narrows the scan (re-verification).
async function detectOnce({ config, provider, market, arbClients, ownOrdersByExchange, options, restrictTo = null, log = () => {} }) {
  const tickers = await Promise.allSettled(
    cex.EXCHANGES.map((name) => cex.fetchTickerPrice(arbClients[name], 'ETH/USDT'))
  );
  const prices = tickers.filter((r) => r.status === 'fulfilled').map((r) => r.value.price);
  if (!prices.length) throw new Error('no ETH/USDT price available');
  const ethUsd = prices.reduce((a, b) => a + b, 0) / prices.length;

  const [feeData, poolInfo] = await Promise.all([provider.getFeeData(), lib.getPoolInfo(config, provider)]);
  const dexSpotUsd = lib.poolL1xUsdPrice({
    sqrtPriceX96: poolInfo.sqrtPriceX96,
    pool: poolInfo,
    l1x: market.l1x,
    weth: market.weth,
    ethUsdPrice: ethUsd
  });

  const candidates = [];
  for (const name of cex.EXCHANGES) {
    if (restrictTo && restrictTo.exchangeName !== name) continue;
    try {
      const book = await cex.fetchOrderBook(arbClients[name], options.pair);
      const ownOrders = ownOrdersByExchange?.[name] ?? [];
      const sanity = bookSanity(book, ownOrders, {
        maxSpreadPct: options.maxSpreadPct,
        minDepthBase: options.minDepthL1x,
        depthRangePct: options.depthRangePct
      });
      if (!sanity.ok) {
        log(`${name}: book failed sanity — ${sanity.reasons.join('; ')}`);
        continue;
      }
      candidates.push({ name, book, ownOrders });
    } catch (error) {
      log(`${name}: fetch failed — ${error.message}`);
    }
  }
  if (!candidates.length) return null;

  let walletL1x = null;
  let walletEthTotal = null;
  if (config.walletAddress) {
    try {
      const l1xContract = new ethers.Contract(config.l1xToken, lib.ERC20_ABI, provider);
      const wethContract = new ethers.Contract(config.weth, lib.ERC20_ABI, provider);
      const [l1xBal, wethBal, ethBal] = await Promise.all([
        l1xContract.balanceOf(config.walletAddress),
        wethContract.balanceOf(config.walletAddress),
        provider.getBalance(config.walletAddress)
      ]);
      walletL1x = Number(ethers.formatUnits(l1xBal, market.l1x.decimals));
      walletEthTotal = Number(ethers.formatEther(wethBal)) + Number(ethers.formatEther(ethBal));
    } catch (_) { /* caps just stay off */ }
  }

  const result = await findOpportunities({
    config,
    provider,
    market,
    ethUsdPrice: ethUsd,
    gasPriceWei: feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n,
    dexSpotUsd,
    exchanges: candidates,
    options: {
      maxTradeL1x: options.maxTradeL1x,
      minTradeL1x: options.minTradeL1x,
      cexTakerFeeBps: options.cexTakerFeeBps,
      gasLimitSwap: options.gasLimitSwap,
      walletL1x,
      walletEthTotal
    }
  });

  let best = null;
  let exchangeName = null;
  for (const [name, candidate] of Object.entries(result.perExchange)) {
    if (!candidate) continue;
    if (restrictTo && restrictTo.direction && candidate.direction !== restrictTo.direction) continue;
    if (!best || candidate.netUsd > best.netUsd) {
      best = candidate;
      exchangeName = name;
    }
  }
  if (!best) return null;

  return { best, exchangeName, ethUsd, gasUsd: result.gasUsd, dexSpotUsd, result };
}

// ---------------------------------------------------------------------------

function transferTotalToWallet(receipt, tokenAddress, walletAddress) {
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  let total = 0n;
  for (const logEntry of receipt.logs) {
    if (logEntry.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(logEntry);
      if (parsed?.name === 'Transfer' && parsed.args.to.toLowerCase() === walletAddress.toLowerCase()) {
        total += parsed.args.value;
      }
    } catch (_) { /* not a Transfer */ }
  }
  return total;
}

async function placeAndAwait({ client, exchangeId, symbol, side, amount, price, timeoutMs, dryRun, log }) {
  if (dryRun) {
    log(`[DRY] would place ${exchangeId} ${side.toUpperCase()} ${amount} ${symbol} limit $${price}`);
    return { status: 'filled', filled: Number(amount), average: Number(price), orderId: 'dry-run' };
  }
  const placed = await cex.placeLimitOrder({ client, exchangeId, symbol, side, amount, price });
  log(`${exchangeId} ${side} order placed: ${placed.id}`);
  let polled = await cex.pollOrder({ client, orderId: placed.id, symbol, timeoutMs });
  if (polled.status !== 'filled') {
    await cex.cancelOrder({ client, orderId: placed.id, symbol });
    // one final read: the cancel may have raced a fill
    polled = await cex.pollOrder({ client, orderId: placed.id, symbol, timeoutMs: 2000 });
  }
  return { ...polled, orderId: placed.id };
}

// Execute one round. opportunity: { direction, exchangeName, sizeL1x } from a
// prior detection — it is ALWAYS re-verified fresh before any order.
async function executeOpportunity({ config, provider, market, arbClients, ownOrdersByExchange, options, opportunity, log = console.log }) {
  const EXEC = execConfig();
  const dryRun = EXEC.dryRun;
  const tag = dryRun ? '[DRY] ' : '';

  if (fs.existsSync(HALT_FILE)) throw new Error('HALT file present — execution refused');

  const today = journalToday();
  const lastHour = today.filter((e) => Date.now() - Date.parse(e.ts) < 3600_000);
  if (lastHour.length >= EXEC.maxTradesPerHour) {
    throw new Error(`max trades per hour reached (${EXEC.maxTradesPerHour})`);
  }
  const todayPnl = today.reduce((sum, e) => sum + (e.realizedPnlUsdt ?? 0), 0);
  if (todayPnl <= -EXEC.dailyLossLimitUsd) {
    fs.writeFileSync(HALT_FILE, `daily loss limit hit: ${todayPnl.toFixed(2)} USDT`);
    throw new Error(`daily loss limit hit ($${todayPnl.toFixed(2)}) — HALT file created`);
  }

  if (!acquireLock()) throw new Error('another execution is in flight (arb/state/EXECUTING)');

  const startedAt = new Date().toISOString();
  const journalBase = { ts: startedAt, dryRun };

  try {
    // ---- re-verify the edge fresh -------------------------------------
    const fresh = await detectOnce({
      config, provider, market, arbClients, ownOrdersByExchange, options,
      restrictTo: { exchangeName: opportunity.exchangeName, direction: opportunity.direction },
      log
    });
    if (!fresh) throw new Error('re-verification found no opportunity — book moved, aborting');
    const { best, ethUsd } = fresh;
    if (best.netUsd < options.minEdgeUsd) {
      throw new Error(`re-verified net $${best.netUsd.toFixed(2)} below min edge $${options.minEdgeUsd} — aborting`);
    }
    const sizeL1x = best.sizeL1x;
    const tradeUsd = sizeL1x * best.cexAvgPriceUsd;
    if (tradeUsd > EXEC.maxTradeUsd) {
      throw new Error(`trade $${tradeUsd.toFixed(2)} exceeds ARB_EXEC_MAX_TRADE_USD ${EXEC.maxTradeUsd}`);
    }

    const isForward = best.direction === 'sell-dex';
    const exchangeId = opportunity.exchangeName;
    const client = arbClients[exchangeId];
    const buffer = EXEC.priceBufferBps / 10000;
    log(`${tag}EXECUTING ${best.direction} on ${exchangeId}: ${sizeL1x.toFixed(4)} L1X, expected net $${best.netUsd.toFixed(2)}`);

    // ---- leg 1: CEX L1X order ------------------------------------------
    const leg1Side = isForward ? 'buy' : 'sell';
    const leg1Price = isForward
      ? best.cexWorstPriceUsd * (1 + buffer)
      : best.cexWorstPriceUsd * (1 - buffer);
    const leg1 = await placeAndAwait({
      client, exchangeId, symbol: options.pair, side: leg1Side,
      amount: Number(sizeL1x.toFixed(4)), price: Number(leg1Price.toFixed(6)),
      timeoutMs: EXEC.legTimeoutMs, dryRun, log
    });
    if (!leg1.filled || leg1.filled <= 0) {
      journalAppend({ ...journalBase, status: 'aborted', reason: 'leg1 unfilled', direction: best.direction, exchange: exchangeId, sizeL1x });
      log(`${tag}leg1 unfilled — cancelled, aborted cleanly (no position)`);
      return { status: 'aborted', reason: 'leg1-unfilled' };
    }
    const filledN = Math.min(leg1.filled, sizeL1x);
    if (filledN < sizeL1x * 0.999) log(`${tag}leg1 PARTIAL fill ${filledN}/${sizeL1x} — continuing with ${filledN}`);
    log(`${tag}leg1 done: ${leg1Side} ${filledN} L1X @ ~$${leg1.average ?? leg1Price}`);

    // ---- leg 2: DEX swap ------------------------------------------------
    let dexReceipt = null;
    let actualWeth;
    let gasUsd = best.gasUsd;
    try {
      if (dryRun) {
        actualWeth = (best.dexLegUsd / ethUsd) * (filledN / sizeL1x);
        log(`[DRY] would ${isForward ? 'sell' : 'buy'} ${filledN.toFixed(4)} L1X on Uniswap (~${actualWeth.toFixed(6)} WETH)`);
      } else if (isForward) {
        const { receipt } = await lib.sellL1x({ config, provider, market, sizeL1x: filledN, slippageBps: EXEC.slippageBps, log });
        dexReceipt = receipt;
        actualWeth = Number(ethers.formatEther(transferTotalToWallet(receipt, config.weth, config.walletAddress)));
        gasUsd = Number(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? 0n))) * ethUsd;
      } else {
        const { receipt } = await lib.buyExactL1x({ config, provider, market, sizeL1x: filledN, slippageBps: EXEC.slippageBps, log });
        dexReceipt = receipt;
        // WETH actually spent = max approved minus what came back is unreliable;
        // read the WETH Transfer OUT of the wallet instead.
        const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
        let spent = 0n;
        for (const logEntry of receipt.logs) {
          if (logEntry.address.toLowerCase() !== config.weth.toLowerCase()) continue;
          try {
            const parsed = iface.parseLog(logEntry);
            if (parsed?.name === 'Transfer' && parsed.args.from.toLowerCase() === config.walletAddress.toLowerCase()) {
              spent += parsed.args.value;
            }
          } catch (_) { /* skip */ }
        }
        actualWeth = Number(ethers.formatEther(spent));
        gasUsd = Number(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? 0n))) * ethUsd;
      }
    } catch (error) {
      // leg2 failed after leg1 filled: UNWIND leg1 on the CEX
      log(`ALERT leg2 (DEX) failed: ${error.message}`);
      const unwindSide = isForward ? 'sell' : 'buy';
      const unwindPrice = isForward
        ? (leg1.average ?? leg1Price) * (1 - 2 * buffer)
        : (leg1.average ?? leg1Price) * (1 + 2 * buffer);
      try {
        const unwind = await placeAndAwait({
          client, exchangeId, symbol: options.pair, side: unwindSide,
          amount: Number(filledN.toFixed(4)), price: Number(unwindPrice.toFixed(6)),
          timeoutMs: EXEC.legTimeoutMs * 2, dryRun, log
        });
        log(`${tag}leg1 unwound: ${unwindSide} ${unwind.filled} L1X @ ~$${unwind.average ?? unwindPrice}`);
        journalAppend({ ...journalBase, status: 'unwound', reason: error.message, direction: best.direction, exchange: exchangeId, sizeL1x: filledN });
        return { status: 'unwound', reason: error.message };
      } catch (unwindError) {
        log(`ALERT UNWIND ALSO FAILED — manual action required: ${unwindError.message}`);
        journalAppend({ ...journalBase, status: 'unwind-failed', reason: error.message, direction: best.direction, exchange: exchangeId, sizeL1x: filledN });
        fs.writeFileSync(HALT_FILE, 'unwind failed — manual review required');
        return { status: 'unwind-failed', reason: unwindError.message };
      }
    }
    log(`${tag}leg2 done: ${isForward ? 'sold' : 'bought'} ${filledN.toFixed(4)} L1X <-> ${actualWeth.toFixed(6)} WETH`);

    // ---- leg 3: ETH hedge ----------------------------------------------
    const hedgeSide = isForward ? 'sell' : 'buy';
    let hedge = null;
    let hedgeError = null;
    for (let attempt = 1; attempt <= 3 && !hedge?.filled; attempt++) {
      try {
        const ticker = dryRun ? { bid: ethUsd, ask: ethUsd } : await cex.fetchTickerPrice(client, HEDGE_SYMBOL);
        const hedgePrice = isForward
          ? (ticker.bid ?? ethUsd) * (1 - buffer)
          : (ticker.ask ?? ethUsd) * (1 + buffer);
        hedge = await placeAndAwait({
          client, exchangeId, symbol: HEDGE_SYMBOL, side: hedgeSide,
          amount: Number(actualWeth.toFixed(6)), price: Number(hedgePrice.toFixed(2)),
          timeoutMs: EXEC.legTimeoutMs, dryRun, log
        });
        if (!hedge.filled) hedge = null;
      } catch (error) {
        hedgeError = error.message;
        log(`ALERT leg3 attempt ${attempt} failed: ${error.message}`);
      }
    }

    // ---- account the round ----------------------------------------------
    const feeRate = EXEC.cexTakerFeeBps / 10000;
    const cexAvg = leg1.average ?? leg1Price;
    const hedgeAvg = hedge?.average ?? ethUsd;
    let realizedPnlUsdt;
    if (isForward) {
      realizedPnlUsdt = (actualWeth * hedgeAvg) * (1 - feeRate) - (filledN * cexAvg) * (1 + feeRate) - gasUsd;
    } else {
      realizedPnlUsdt = (filledN * cexAvg) * (1 - feeRate) - (actualWeth * hedgeAvg) * (1 + feeRate) - gasUsd;
    }

    const status = hedge?.filled ? 'completed' : 'hedge_pending';
    if (status === 'hedge_pending') {
      log(`ALERT hedge incomplete (${hedgeError ?? 'unfilled'}) — you are ${isForward ? 'long' : 'short'} ${actualWeth.toFixed(6)} ETH until hedged manually`);
    }

    const entry = {
      ...journalBase,
      status,
      direction: best.direction,
      exchange: exchangeId,
      sizeL1x: filledN,
      cexOrderId: leg1.orderId,
      cexAvgPrice: cexAvg,
      dexTxHash: dexReceipt?.hash ?? null,
      wethAmount: actualWeth,
      hedgeOrderId: hedge?.orderId ?? null,
      hedgeAvgPrice: hedge?.average ?? null,
      gasUsd,
      ethUsd,
      expectedNetUsd: best.netUsd,
      realizedPnlUsdt
    };
    journalAppend(entry);

    try {
      await arbDb.init();
      await arbDb.insertTrade({
        exchange: exchangeId,
        sizeL1x: filledN,
        dexTxHash: entry.dexTxHash,
        dexWethOut: actualWeth,
        dexAvgSellUsd: filledN > 0 ? (actualWeth * ethUsd) / filledN : null,
        dexGasUsd: gasUsd,
        cexOrderId: entry.cexOrderId,
        cexAvgPrice: cexAvg,
        cexFeeUsd: filledN * cexAvg * feeRate,
        hedgeOrderId: entry.hedgeOrderId,
        hedgeEthAmount: actualWeth,
        hedgeAvgPrice: entry.hedgeAvgPrice,
        hedgeFeeUsd: actualWeth * hedgeAvg * feeRate,
        ethUsd,
        realizedPnlUsdt,
        isDryRun: dryRun,
        notes: `${best.direction} | status=${status} | expected $${best.netUsd.toFixed(2)}`
      });
    } catch (error) {
      log(`WARN trade not recorded to DB: ${error.message.slice(0, 100)} (journal has it)`);
    }

    log(`${tag}ROUND ${status.toUpperCase()}: ${best.direction} ${filledN.toFixed(4)} L1X | expected $${best.netUsd.toFixed(2)} | realized $${realizedPnlUsdt.toFixed(2)}`);
    return { status, realizedPnlUsdt, expectedNetUsd: best.netUsd, sizeL1x: filledN, direction: best.direction, exchange: exchangeId };
  } finally {
    releaseLock();
  }
}

module.exports = { detectOnce, executeOpportunity, execConfig, journalToday };
