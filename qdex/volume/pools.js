'use strict';

// Per-pool market state, impact-aware sizing, quoting and swap execution.
//
// Kept separate from qdex/lib.js because that module reads ONE pool and ONE
// router out of a global config — it serves the peg MM and must not be disturbed.
// Here every pool carries its own router (QDex runs two factory deployments and
// a SwapRouter can only reach its own factory's pools).
//
// Side convention throughout this harness follows the WL1X-as-cash model:
//   BUY  = WL1X  -> token   (pushes token-per-WL1X price DOWN)
//   SELL = token -> WL1X    (pushes it UP)

const { ethers } = require('ethers');
const lib = require('../lib');
const { ERC20_ABI } = require('./wallets');
const { NonceManager } = require('./nonces');

const Q96 = 2 ** 96;

const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)'
];
// Two SwapRouter shapes exist in the wild: the original (with `deadline`) and
// SwapRouter02 (without). We probe once per router and cache which one works.
const ROUTER_DEADLINE_ABI = ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'];
const ROUTER_02_ABI = ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'];

async function loadMarket({ provider, poolCfg, config, tokenMeta }) {
  const pool = new ethers.Contract(poolCfg.address, V3_POOL_ABI, provider);
  const [token0, token1, fee, liquidity, slot0] = await Promise.all([
    pool.token0(), pool.token1(), pool.fee(), pool.liquidity(), pool.slot0()
  ]);
  const wl1x = config.wl1x.toLowerCase();
  const baseIsToken0 = token0.toLowerCase() === wl1x;
  const m0 = tokenMeta[token0.toLowerCase()] || { symbol: '?', decimals: 18 };
  const m1 = tokenMeta[token1.toLowerCase()] || { symbol: '?', decimals: 18 };
  return {
    cfg: poolCfg,
    address: poolCfg.address,
    fee: Number(fee),
    liquidity,                                   // BigInt — lib math casts to Number
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: Number(slot0.tick),
    token0: { address: ethers.getAddress(token0), ...m0 },
    token1: { address: ethers.getAddress(token1), ...m1 },
    baseIsToken0,
    base: baseIsToken0 ? { address: ethers.getAddress(token0), ...m0 } : { address: ethers.getAddress(token1), ...m1 },
    quote: baseIsToken0 ? { address: ethers.getAddress(token1), ...m1 } : { address: ethers.getAddress(token0), ...m0 }
  };
}

// token per WL1X, from a raw sqrtPriceX96
function priceFrom(market, sqrtRaw) {
  const s = Number(sqrtRaw) / Q96;
  const t1PerT0 = s * s * Math.pow(10, market.token0.decimals - market.token1.decimals);
  return market.baseIsToken0 ? t1PerT0 : 1 / t1PerT0;
}
const price = (market) => priceFrom(market, market.sqrtPriceX96);

// Largest WL1X-denominated trade whose price impact stays within `bps`.
// Derived from the pool's own state, because reported liquidity() does NOT
// predict tradeable size — on QDex a pool reporting 28,000x more liquidity can
// absorb 40,000x less. `side` matters: the curve is not symmetric.
function maxSizeAtImpact(market, bps, side) {
  const L = Number(market.liquidity);
  const sq = Number(market.sqrtPriceX96);
  if (!(L > 0) || !(sq > 0)) return 0;
  const f = bps / 10000;
  // g = ratio the sqrt price moves by for a `f` move in token-per-WL1X price
  const g = Math.sqrt(1 - f);
  const wl1xIsToken0 = market.baseIsToken0;
  let weiIn;
  if (side === 'buy') {
    // WL1X in. token0-side: sqrt falls to sq*g. token1-side: sqrt rises to sq/g.
    weiIn = wl1xIsToken0 ? (L * Q96 * (1 - g)) / (g * sq) : (L * sq * (1 / g - 1)) / Q96;
    return weiIn / Math.pow(10, market.base.decimals);
  }
  // SELL: token in, WL1X out. Size the token leg then convert to WL1X terms so
  // the caller can reason in one unit throughout.
  const gi = Math.sqrt(1 + f);
  const tokenIsToken0 = !wl1xIsToken0;
  weiIn = tokenIsToken0 ? (L * Q96 * (1 - 1 / gi)) / ((1 / gi) * sq) : (L * sq * (gi - 1)) / Q96;
  const tokenHuman = weiIn / Math.pow(10, market.quote.decimals);
  const px = price(market);
  return px > 0 ? tokenHuman / px : 0;
}

// Walk the V3 curve for one exact-input swap. Returns the output, the resulting
// sqrt price and the realised impact, all from pool state — no extra RPC call.
// Applies the pool fee to the input, which lib.estimateAmountOutWei does not.
function quote({ market, side, sizeWl1x, slippageBps }) {
  const L = Number(market.liquidity);
  const sqrtCur = Number(market.sqrtPriceX96);
  const px = price(market);
  if (!(L > 0) || !(sqrtCur > 0) || !(sizeWl1x > 0) || !(px > 0)) return null;

  const tokenIn = side === 'buy' ? market.base : market.quote;
  const tokenOut = side === 'buy' ? market.quote : market.base;
  const amountInHuman = side === 'buy' ? sizeWl1x : sizeWl1x * px;
  const amountInWei = amountInHuman * Math.pow(10, tokenIn.decimals);
  const afterFee = amountInWei * (1 - market.fee / 1e6);

  const inIsToken0 = tokenIn.address.toLowerCase() === market.token0.address.toLowerCase();
  let sqrtNew, outWei;
  if (inIsToken0) {
    sqrtNew = 1 / (1 / sqrtCur + afterFee / (L * Q96));
    outWei = L * (sqrtCur - sqrtNew) / Q96;
  } else {
    sqrtNew = sqrtCur + afterFee * Q96 / L;
    outWei = L * Q96 * (sqrtNew - sqrtCur) / (sqrtCur * sqrtNew);
  }
  if (!(outWei > 0)) return null;

  const amountOutHuman = outWei / Math.pow(10, tokenOut.decimals);
  const priceAfter = priceFrom(market, sqrtNew);
  const impactBps = Math.abs((priceAfter - px) / px) * 10000;
  // Realised price of this trade, always expressed as token per WL1X.
  const execPrice = side === 'buy' ? amountOutHuman / sizeWl1x : amountInHuman / amountOutHuman;
  const minOutHuman = amountOutHuman * (1 - (slippageBps ?? 100) / 10000);

  return {
    side, sizeWl1x, tokenIn, tokenOut,
    amountInHuman, amountOutHuman, minOutHuman,
    priceBefore: px, priceAfter, impactBps, execPrice,
    notionalWl1x: side === 'buy' ? sizeWl1x : amountOutHuman
  };
}

// Shrink until the quote fits the impact cap. Returns { quote, shrunkFrom } or
// null when even the minimum size is too large for this pool right now.
function quoteWithinImpact({ market, side, sizeWl1x, maxImpactBps, minWl1x, slippageBps, attempts = 4 }) {
  let size = sizeWl1x;
  let shrunkFrom = null;
  for (let i = 0; i < attempts; i++) {
    const q = quote({ market, side, sizeWl1x: size, slippageBps });
    if (!q) return null;
    if (q.impactBps <= maxImpactBps) return { quote: q, shrunkFrom };
    if (shrunkFrom == null) shrunkFrom = size;
    // Impact is close to linear in size for small moves — scale down with margin.
    const scaled = size * (maxImpactBps / q.impactBps) * 0.9;
    size = Math.max(minWl1x, Math.min(scaled, size * 0.75));
    if (size <= minWl1x) {
      const last = quote({ market, side, sizeWl1x: minWl1x, slippageBps });
      if (last && last.impactBps <= maxImpactBps) return { quote: last, shrunkFrom };
      return null;
    }
  }
  return null;
}

// Probe cache: which exactInputSingle shape does each router speak?
const routerVariant = new Map();

// Ask the ROUTER what a swap actually returns, by simulating it with eth_call.
//
// The analytic quote() above is single-range V3 math and does not match what
// QDex actually pays. Measured on the WL1X/L1USD pool, every swap loses a fixed
// ~0.037 of the output token on top of the curve — invisible at 2 WL1X, but 19%
// of a 0.01 WL1X trade. Setting amountOutMinimum from the analytic number puts
// the floor ABOVE what the pool will ever pay, and the swap reverts on slippage.
// That is exactly how the first live swap failed.
//
// estimateGas cannot substitute for this: on this RPC it does not simulate at
// all — it returns a canned value even for impossible parameters — so it catches
// nothing. eth_call does simulate correctly, including the caller's balance.
//
// Returns null when the swap would revert outright (insufficient balance, no
// liquidity, expired), which is itself the answer: do not send it.
async function quoteOnChain({ market, signer, side, sizeWl1x, config, log = () => {} }) {
  const px = price(market);
  if (!(px > 0) || !(sizeWl1x > 0)) return null;
  const tokenIn = side === 'buy' ? market.base : market.quote;
  const tokenOut = side === 'buy' ? market.quote : market.base;
  const amountInHuman = side === 'buy' ? sizeWl1x : sizeWl1x * px;
  const amountIn = ethers.parseUnits(amountInHuman.toFixed(tokenIn.decimals), tokenIn.decimals);

  const routerAddr = market.cfg.router;
  const known = routerVariant.get(routerAddr.toLowerCase());
  const order = known ? [known] : ['deadline', 'v02'];
  const raw = { tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee: market.fee,
    recipient: signer.address, deadline: Math.floor(Date.now() / 1000) + config.deadlineSeconds,
    amountIn, amountOutMinimum: 0n };

  for (const v of order) {
    try {
      const c = routerContract(routerAddr, signer, v);
      // amountOutMinimum 0 so the simulation reports the true output rather than
      // reverting against a floor we are trying to compute.
      const outWei = await c.exactInputSingle.staticCall(paramsFor(v, raw), { from: signer.address });
      routerVariant.set(routerAddr.toLowerCase(), v);
      const amountOutHuman = Number(ethers.formatUnits(outWei, tokenOut.decimals));
      if (!(amountOutHuman > 0)) return null;
      const execPrice = side === 'buy' ? amountOutHuman / sizeWl1x : amountInHuman / amountOutHuman;
      return {
        side, sizeWl1x, tokenIn, tokenOut, variant: v,
        amountInHuman, amountOutHuman,
        minOutHuman: amountOutHuman * (1 - config.slippageBps / 10000),
        priceBefore: px, execPrice,
        // Realised cost against the pool's marginal price, fee and everything
        // else the router does included. This is the honest impact number.
        effectiveCostBps: Math.abs((execPrice - px) / px) * 10000,
        notionalWl1x: side === 'buy' ? sizeWl1x : amountOutHuman
      };
    } catch (e) {
      if (lib.isTransientRpcError(e)) throw e;
      if (v === order[order.length - 1]) {
        log(`quoteOnChain: ${market.cfg.label} ${side} ${sizeWl1x} would revert (${String(e.shortMessage || e.message).slice(0, 60)})`);
        return null;
      }
    }
  }
  return null;
}

function routerContract(address, signer, variant) {
  return new ethers.Contract(address, variant === 'v02' ? ROUTER_02_ABI : ROUTER_DEADLINE_ABI, signer);
}
function paramsFor(variant, p) {
  const base = { tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, recipient: p.recipient,
    amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, sqrtPriceLimitX96: 0 };
  return variant === 'v02' ? base : { ...base, deadline: p.deadline };
}

async function ensureAllowance({ tokenAddress, signer, spender, amountWei, log = () => {}, nonces }) {
  const erc = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const have = await lib.withRetry(() => erc.allowance(signer.address, spender), { attempts: 3, label: 'allowance', log });
  if (have >= amountWei) return null;
  log(`approving ${tokenAddress} to router ${spender}`);
  // The approve is immediately followed by the swap from the same wallet. Left
  // to itself ethers reads the node's pending count, which lags — so the swap
  // would draw this same nonce, replace the approve, and then revert for having
  // no allowance. Every wallet's FIRST trade goes through here.
  const nonce = await NonceManager.nonceFor(nonces, signer, 'approve.nonce');
  try {
    const tx = await erc.approve(spender, ethers.MaxUint256, { nonce });
    return await lib.withRetry(() => tx.wait(), { attempts: 3, label: 'approve.wait', log });
  } catch (e) {
    if (nonces) nonces.reset(signer);
    throw e;
  }
}

// Execute one swap through THIS pool's router. Mirrors the hardening in
// qdex/lib.js: retry the gas estimate (transient 502s surface as bogus reverts),
// then pin the nonce so a retried broadcast can never become a second swap.
// `onNonce` fires once the nonce is known and BEFORE anything is broadcast;
// `onSent` fires the moment a hash exists, before the receipt. Together they let
// the caller keep a write-ahead record, so a process killed mid-broadcast still
// leaves a row that reconciliation can find.
async function executeSwap({ market, signer, side, quote: q, config, log = () => {}, onNonce, onSent, nonces }) {
  const routerAddr = market.cfg.router;
  const tokenIn = q.tokenIn, tokenOut = q.tokenOut;
  const amountIn = ethers.parseUnits(q.amountInHuman.toFixed(tokenIn.decimals), tokenIn.decimals);

  // APPROVE FIRST. eth_call below executes the real transferFrom, so a wallet
  // that has not yet approved the router cannot be simulated at all — its
  // simulation reverts and the trade is skipped. Getting this order wrong means
  // every wallet is permanently unable to make its FIRST trade on a pool, while
  // any wallet that happens to already have an allowance works fine, which makes
  // it look like an intermittent fault rather than a hard ordering bug.
  await ensureAllowance({ tokenAddress: tokenIn.address, signer, spender: routerAddr, amountWei: amountIn, log, nonces });

  // minOut MUST come from a simulation of the real router, never from the
  // analytic curve. QDex's router skims a protocol fee (measured ~47bps, paid to
  // a collector address) on top of the 0.3% pool fee, and neither appears in the
  // V3 curve — so an analytic floor sits above what the pool will ever pay and
  // the swap reverts on slippage. That is how the first live swap failed.
  const sim = await quoteOnChain({ market, signer, side, sizeWl1x: q.sizeWl1x, config, log });
  if (!sim) {
    const err = new Error('simulation says this swap would revert — not broadcasting');
    err.preflightRejected = true;
    throw err;
  }
  if (config.maxCostBps > 0 && sim.effectiveCostBps > config.maxCostBps) {
    const err = new Error(`execution cost ${sim.effectiveCostBps.toFixed(0)}bps exceeds QVT_MAX_COST_BPS ${config.maxCostBps}`);
    err.preflightRejected = true;
    throw err;
  }
  log(`simulated: ${sim.amountOutHuman.toPrecision(6)} ${tokenOut.symbol}, cost ${sim.effectiveCostBps.toFixed(0)}bps`);
  // Hand the real numbers back so the caller records what actually happened
  // rather than what the curve predicted.
  q.amountOutHuman = sim.amountOutHuman;
  q.execPrice = sim.execPrice;
  q.effectiveCostBps = sim.effectiveCostBps;
  const minOut = ethers.parseUnits(Math.max(sim.minOutHuman, 0).toFixed(tokenOut.decimals), tokenOut.decimals);

  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const raw = { tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee: market.fee,
    recipient: signer.address, deadline, amountIn, amountOutMinimum: minOut };

  const known = routerVariant.get(routerAddr.toLowerCase());
  const order = known ? [known] : ['deadline', 'v02'];
  let gasEst = null, variant = null, lastErr = null;
  for (const v of order) {
    try {
      const c = routerContract(routerAddr, signer, v);
      gasEst = await lib.withRetry(() => c.exactInputSingle.estimateGas(paramsFor(v, raw)),
        { attempts: 3, label: `swap.estimateGas(${v})`, log });
      variant = v; break;
    } catch (e) {
      lastErr = e;
      // A real revert on BOTH shapes is a genuine failure; a decode/shape
      // mismatch just means we should try the other ABI.
      if (lib.isTransientRpcError(e)) throw e;
    }
  }
  if (!variant) throw lastErr || new Error('router rejected both exactInputSingle shapes');
  routerVariant.set(routerAddr.toLowerCase(), variant);

  const c = routerContract(routerAddr, signer, variant);
  const nonce = await NonceManager.nonceFor(nonces, signer, 'swap.nonce');
  // Write-ahead point: the caller records its intent here. Everything after this
  // line can move funds, so from now on a crash must still leave a trace.
  if (onNonce) await onNonce({ nonce, variant });
  const tx = await lib.withRetry(
    () => c.exactInputSingle(paramsFor(variant, raw), { gasLimit: (gasEst * 12n) / 10n, nonce }),
    { attempts: 2, label: 'swap.send', log });
  if (onSent) await onSent({ hash: tx.hash, nonce });
  try {
    return await lib.withRetry(() => tx.wait(), { attempts: 3, label: 'swap.wait', log });
  } catch (e) {
    if (nonces) nonces.reset(signer);
    // Distinguish two very different outcomes that both throw from wait():
    //   MINED AND REVERTED — a definite failure. The nonce was consumed and gas
    //     was spent, but no funds moved. Nothing to reconcile.
    //   NOT CONFIRMED      — it may still be mined later, so it must be recorded
    //     with its hash and reconciled before trading resumes.
    // Treating a plain revert as "unconfirmed" halts the bot for no reason.
    const rc = e.receipt || (e.error && e.error.receipt);
    if (rc && Number(rc.status) === 0) {
      e.revertedOnChain = true;
      e.broadcastHash = tx.hash;
      e.blockNumber = rc.blockNumber != null ? Number(rc.blockNumber) : null;
      e.gasUsed = rc.gasUsed != null ? rc.gasUsed.toString() : null;
      throw e;
    }
    e.broadcastHash = tx.hash;
    e.broadcastNonce = nonce;
    e.unconfirmed = true;
    throw e;
  }
}

module.exports = { Q96, V3_POOL_ABI, loadMarket, price, priceFrom, maxSizeAtImpact, quote, quoteWithinImpact, quoteOnChain, executeSwap, ensureAllowance };
