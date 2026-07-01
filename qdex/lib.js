'use strict';

// QuantumDex (QDex) on-chain client + pool helpers. QDex is a Uniswap-V3-style
// AMM on the L1X chain (chainId 1066). The pool is WL1X/XUSD (both 18 decimals),
// so price = XUSD per WL1X read from slot0.sqrtPriceX96 like uniswap/lib.js.
//
// Defaults below are the real mainnet addresses; override any via QDEX_* env.

const { ethers } = require('ethers');

const Q96 = 2 ** 96;

const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)'
];
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
];
// Uniswap-V3 SwapRouter (exactInputSingle). QDex router variant is unverified —
// if it's SwapRouter02 (no deadline field) this struct needs adjusting.
const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'
];
// L1X price oracle — getLatestPrice(token) returns USD price with `decimals()` dp.
const ORACLE_ABI = [
  'function getLatestPrice(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
];
// Uniswap-V3 QuoterV2 (canonical off-chain quote — revert-based, needs no funds).
// Only used if QDEX_QUOTER_ADDRESS is set; otherwise we quote from pool math.
const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
];

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function getConfig() {
  return {
    rpcUrl: process.env.QDEX_RPC_URL || 'https://v2-mainnet-rpc.l1x.foundation',
    chainId: envNum('QDEX_CHAIN_ID', 1066),
    walletAddress: process.env.QDEX_WALLET_ADDRESS ? ethers.getAddress(process.env.QDEX_WALLET_ADDRESS) : null,
    privateKey: process.env.QDEX_WALLET_PRIVATE_KEY || '',
    poolAddress: ethers.getAddress(process.env.QDEX_POOL_ADDRESS || '0x35a4Ef191750f6f70a29e58AcC2886de33a16DbD'),
    routerAddress: ethers.getAddress(process.env.QDEX_ROUTER_ADDRESS || '0xA3A2dfF9f43Edc2825AC4C2Ff1A2945e103a37eB'),
    // base = the token whose price we hold (WL1X); quote = XUSD. Defaults resolved
    // from the pool if not set, but pinned here for clarity.
    baseToken: process.env.QDEX_BASE_TOKEN ? ethers.getAddress(process.env.QDEX_BASE_TOKEN) : ethers.getAddress('0x743B3A9094B2226AEfd5EbEE22071FCDb64c707f'),
    quoteToken: process.env.QDEX_QUOTE_TOKEN ? ethers.getAddress(process.env.QDEX_QUOTE_TOKEN) : ethers.getAddress('0xcCD313e2c962BCea8501A6691598EF9A98975ba7'),
    // oracle (authoritative WL1X USD price on L1X)
    oracleAddress: ethers.getAddress(process.env.QDEX_ORACLE_ADDRESS || '0xbF730f5a23a63653457829ee88d3Aaf54453a809'),
    // optional QuoterV2 — if set, quotes use it (canonical); else pool-math quote
    quoterAddress: process.env.QDEX_QUOTER_ADDRESS ? ethers.getAddress(process.env.QDEX_QUOTER_ADDRESS) : '',
    // strategy
    //   peg mode: QDEX_XUSD_PEG > 0 -> hold XUSD at that USD value (target pool
    //     ratio = oracleWL1X / peg). Overrides QDEX_TARGET_PRICE.
    //   fixed mode: QDEX_TARGET_PRICE = XUSD per WL1X to hold directly.
    xusdPeg: envNum('QDEX_XUSD_PEG', 0),
    targetPrice: envNum('QDEX_TARGET_PRICE', 0),   // XUSD per WL1X to hold (0 = unset)
    bandPct: envNum('QDEX_BAND_PCT', 0.5),
    // 'center' = correct all the way back to the peg/target (fewer, bigger trades
    // that fully re-center). 'edge' = correct only to the near band edge (smaller,
    // more frequent trades, lets it hug the band — lower churn per trade).
    correctTo: (process.env.QDEX_CORRECT_TO || 'center').toLowerCase(),
    maxDeviationPct: envNum('QDEX_MAX_DEVIATION_PCT', 5), // circuit breaker
    maxTradeBase: envNum('QDEX_MAX_TRADE_BASE', 0),
    slippageBps: envNum('QDEX_SLIPPAGE_BPS', 100),
    deadlineSeconds: envNum('QDEX_DEADLINE_SECONDS', 600)
  };
}

function getProvider(config) {
  if (!config.rpcUrl) throw new Error('QDEX_RPC_URL not set');
  return new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
}

function getWallet(config, provider, requireKey = false) {
  if (!config.privateKey) {
    if (requireKey) throw new Error('QDEX_WALLET_PRIVATE_KEY required to execute');
    return null;
  }
  return new ethers.Wallet(config.privateKey, provider);
}

// Load pool tokens/decimals/fee + current slot0 & liquidity, and mark which side
// is the base token.
async function loadPool(config, provider) {
  const pool = new ethers.Contract(config.poolAddress, V3_POOL_ABI, provider);
  const [token0, token1, fee, liquidity, slot0] = await Promise.all([
    pool.token0(), pool.token1(), pool.fee(), pool.liquidity(), pool.slot0()
  ]);
  const meta = async (addr) => {
    const c = new ethers.Contract(addr, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
    return { address: ethers.getAddress(addr), symbol, decimals: Number(decimals) };
  };
  const [t0, t1] = await Promise.all([meta(token0), meta(token1)]);
  const baseIsToken0 = config.baseToken.toLowerCase() === t0.address.toLowerCase();
  return {
    pool, fee: Number(fee), liquidity, sqrtPriceX96: slot0.sqrtPriceX96, tick: Number(slot0.tick),
    token0: t0, token1: t1, baseIsToken0,
    base: baseIsToken0 ? t0 : t1, quote: baseIsToken0 ? t1 : t0
  };
}

// Current pool price = quote per base (XUSD per WL1X).
function priceFromSqrt(market) {
  const sqrt = Number(market.sqrtPriceX96) / Q96;
  const priceT1PerT0 = sqrt * sqrt * Math.pow(10, market.token0.decimals - market.token1.decimals);
  return market.baseIsToken0 ? priceT1PerT0 : 1 / priceT1PerT0;
}

async function getPoolPrice(config, provider) {
  const market = await loadPool(config, provider);
  return priceFromSqrt(market);
}

// Authoritative USD price for a token from the L1X oracle (WL1X is registered;
// XUSD is not — derive XUSD = oracleWL1X / poolRatio instead).
let _oracleDecimals = null;
async function getOraclePrice(config, provider, tokenAddress) {
  const oracle = new ethers.Contract(config.oracleAddress, ORACLE_ABI, provider);
  if (_oracleDecimals == null) _oracleDecimals = Number(await oracle.decimals());
  const raw = await oracle.getLatestPrice(tokenAddress);
  return Number(raw) / Math.pow(10, _oracleDecimals);
}

// Amount of BASE to trade to move the pool price to `targetPrice`, using the
// current active liquidity (single-range V3 math — accurate for tight bands; a
// large move that crosses ticks would be approximate). Returns base-token units.
async function sizeToTarget({ config, provider, side, targetPrice, market }) {
  const m = market || await loadPool(config, provider);
  const L = Number(m.liquidity);
  if (!(L > 0)) return 0;
  const decDiff = Math.pow(10, m.token0.decimals - m.token1.decimals); // t1/t0 raw factor
  // target price in raw token1/token0 terms
  const targetT1PerT0 = m.baseIsToken0 ? (targetPrice / decDiff) : (1 / (targetPrice * decDiff));
  const sqrtCur = Number(m.sqrtPriceX96);
  const sqrtTgt = Math.sqrt(targetT1PerT0) * Q96;
  if (!(sqrtTgt > 0)) return 0;

  // amount deltas in wei for moving sqrt between current and target
  const amount0 = (sqrtA, sqrtB) => L * Q96 * (sqrtB - sqrtA) / (sqrtA * sqrtB); // token0 wei
  const amount1 = (sqrtA, sqrtB) => L * (sqrtB - sqrtA) / Q96;                   // token1 wei

  const base = m.base, dec0 = m.token0.decimals, dec1 = m.token1.decimals;
  let baseUnits = 0;
  if (side === 'sell') {
    // sell base pushes price down (sqrt toward target < current)
    if (m.baseIsToken0) baseUnits = Math.abs(amount0(sqrtTgt, sqrtCur)) / Math.pow(10, dec0);
    else baseUnits = Math.abs(amount1(sqrtTgt, sqrtCur)) / Math.pow(10, dec1);
  } else { // buy base pushes price up (sqrt toward target > current)
    if (m.baseIsToken0) baseUnits = Math.abs(amount0(sqrtCur, sqrtTgt)) / Math.pow(10, dec0);
    else baseUnits = Math.abs(amount1(sqrtCur, sqrtTgt)) / Math.pow(10, dec1);
  }
  void base;
  return baseUnits;
}

// Impact-aware expected output from the pool's own state (single active range):
// given amountIn wei of the input token, walk the V3 curve to the post-trade
// sqrt price and return the output wei. Same float approach as sizeToTarget.
function estimateAmountOutWei(market, tokenInIsToken0, amountInWei) {
  const L = Number(market.liquidity);
  const sqrtCur = Number(market.sqrtPriceX96);
  const amtIn = Number(amountInWei);
  if (!(L > 0) || !(amtIn > 0) || !(sqrtCur > 0)) return 0;
  if (tokenInIsToken0) {
    // selling token0 -> sqrt moves down -> token1 out
    const sqrtNew = 1 / (1 / sqrtCur + amtIn / (L * Q96));
    return L * (sqrtCur - sqrtNew) / Q96;
  }
  // selling token1 -> sqrt moves up -> token0 out
  const sqrtNew = sqrtCur + amtIn * Q96 / L;
  return L * Q96 * (sqrtNew - sqrtCur) / (sqrtCur * sqrtNew);
}

// Quote a swap BEFORE executing: exact expected output + slippage floor. Uses
// QuoterV2 if config.quoterAddress is set (canonical), otherwise the pool-math
// estimate above. side 'sell' = base->quote; 'buy' = quote->base.
async function quoteAmountOut({ config, provider, market, side, sizeBase, slippageBps }) {
  const m = market;
  const tokenIn = side === 'sell' ? m.base : m.quote;
  const tokenOut = side === 'sell' ? m.quote : m.base;
  const px = priceFromSqrt(m);
  const amountInHuman = side === 'sell' ? sizeBase : sizeBase * px;
  const amountIn = ethers.parseUnits(amountInHuman.toFixed(tokenIn.decimals), tokenIn.decimals);

  let amountOutWei, method;
  if (config.quoterAddress) {
    const quoter = new ethers.Contract(config.quoterAddress, QUOTER_V2_ABI, provider);
    const res = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, fee: m.fee, sqrtPriceLimitX96: 0
    });
    amountOutWei = Number(res.amountOut ?? res[0]);
    method = 'quoterV2';
  } else {
    const tokenInIsToken0 = tokenIn.address.toLowerCase() === m.token0.address.toLowerCase();
    amountOutWei = estimateAmountOutWei(m, tokenInIsToken0, Number(amountIn));
    method = 'pool-math';
  }
  const amountOutHuman = amountOutWei / Math.pow(10, tokenOut.decimals);
  const bps = Number.isFinite(slippageBps) ? slippageBps : config.slippageBps;
  const minOutHuman = amountOutHuman * (1 - bps / 10000);
  return { amountInHuman, amountOutHuman, minOutHuman, tokenIn, tokenOut, method };
}

// Execute a swap on the QDex router. side 'sell' = base->quote (amountIn in base);
// 'buy' = quote->base (amountIn in quote ≈ amountBase * price). exactInputSingle.
// NOTE: unverified against QDex's router in production — confirm the router
// variant (deadline vs no-deadline) and approvals on a tiny live test first.
async function executeSwap({ config, provider, side, amountBase, price, slippageBps, minOutHuman, log = () => {} }) {
  const wallet = getWallet(config, provider, true);
  const m = await loadPool(config, provider);
  const tokenIn = side === 'sell' ? m.base : m.quote;
  const tokenOut = side === 'sell' ? m.quote : m.base;
  const px = price || priceFromSqrt(m);
  // amountIn: sell -> base units; buy -> quote units (base*price)
  const amountInHuman = side === 'sell' ? amountBase : amountBase * px;
  const amountIn = ethers.parseUnits(amountInHuman.toFixed(tokenIn.decimals), tokenIn.decimals);

  // approve router if needed
  const erc = new ethers.Contract(tokenIn.address, ERC20_ABI, wallet);
  const allowance = await erc.allowance(wallet.address, config.routerAddress);
  if (allowance < amountIn) {
    log(`approving ${tokenIn.symbol} to router...`);
    const atx = await erc.approve(config.routerAddress, ethers.MaxUint256);
    await atx.wait();
  }

  // slippage floor from a QUOTE (impact-aware). Use the caller's precomputed
  // minOutHuman if given; otherwise quote here.
  const bps = Number.isFinite(slippageBps) ? slippageBps : config.slippageBps;
  let floorHuman = minOutHuman;
  if (floorHuman == null) {
    const q = await quoteAmountOut({ config, provider, market: m, side, sizeBase: amountBase, slippageBps: bps });
    floorHuman = q.minOutHuman;
    log(`quote(${q.method}): expect ${q.amountOutHuman.toFixed(6)} ${tokenOut.symbol}`);
  }
  const minOut = ethers.parseUnits(floorHuman.toFixed(tokenOut.decimals), tokenOut.decimals);
  log(`amountIn=${amountInHuman} ${tokenIn.symbol} minOut=${floorHuman.toFixed(6)} ${tokenOut.symbol} (slippage ${bps}bps)`);
  const router = new ethers.Contract(config.routerAddress, SWAP_ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const params = {
    tokenIn: tokenIn.address, tokenOut: tokenOut.address, fee: m.fee,
    recipient: wallet.address, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
  };
  const tx = await router.exactInputSingle(params);
  return tx.wait();
}

module.exports = {
  Q96, V3_POOL_ABI, ERC20_ABI,
  getConfig, getProvider, getWallet, loadPool, priceFromSqrt,
  getPoolPrice, getOraclePrice, sizeToTarget, quoteAmountOut, estimateAmountOutWei, executeSwap
};
