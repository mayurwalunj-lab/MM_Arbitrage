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

function routerContract(address, signer, variant) {
  return new ethers.Contract(address, variant === 'v02' ? ROUTER_02_ABI : ROUTER_DEADLINE_ABI, signer);
}
function paramsFor(variant, p) {
  const base = { tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, recipient: p.recipient,
    amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, sqrtPriceLimitX96: 0 };
  return variant === 'v02' ? base : { ...base, deadline: p.deadline };
}

async function ensureAllowance({ tokenAddress, signer, spender, amountWei, log = () => {} }) {
  const erc = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const have = await lib.withRetry(() => erc.allowance(signer.address, spender), { attempts: 3, label: 'allowance', log });
  if (have >= amountWei) return null;
  log(`approving ${tokenAddress} to router ${spender}`);
  const tx = await erc.approve(spender, ethers.MaxUint256);
  return lib.withRetry(() => tx.wait(), { attempts: 3, label: 'approve.wait', log });
}

// Execute one swap through THIS pool's router. Mirrors the hardening in
// qdex/lib.js: retry the gas estimate (transient 502s surface as bogus reverts),
// then pin the nonce so a retried broadcast can never become a second swap.
async function executeSwap({ market, signer, side, quote: q, config, log = () => {} }) {
  const routerAddr = market.cfg.router;
  const tokenIn = q.tokenIn, tokenOut = q.tokenOut;
  const amountIn = ethers.parseUnits(q.amountInHuman.toFixed(tokenIn.decimals), tokenIn.decimals);
  const minOut = ethers.parseUnits(Math.max(q.minOutHuman, 0).toFixed(tokenOut.decimals), tokenOut.decimals);

  await ensureAllowance({ tokenAddress: tokenIn.address, signer, spender: routerAddr, amountWei: amountIn, log });

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
  const nonce = await lib.withRetry(() => signer.getNonce('pending'), { attempts: 3, label: 'swap.nonce', log });
  const tx = await lib.withRetry(
    () => c.exactInputSingle(paramsFor(variant, raw), { gasLimit: (gasEst * 12n) / 10n, nonce }),
    { attempts: 2, label: 'swap.send', log });
  try {
    return await lib.withRetry(() => tx.wait(), { attempts: 3, label: 'swap.wait', log });
  } catch (e) {
    // The transaction WAS broadcast — we simply could not confirm it. It may yet
    // be mined. Losing the hash here would leave funds moved with no record, so
    // attach it and let the caller file the row as UNCONFIRMED rather than failed.
    e.broadcastHash = tx.hash;
    e.broadcastNonce = nonce;
    e.unconfirmed = true;
    throw e;
  }
}

module.exports = { Q96, V3_POOL_ABI, loadMarket, price, priceFrom, maxSizeAtImpact, quote, quoteWithinImpact, executeSwap, ensureAllowance };
