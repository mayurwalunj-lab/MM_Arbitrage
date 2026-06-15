'use strict';

// Shared Uniswap L1X/WETH library. All functions return data and never print;
// callers (CLI, arb monitor/executor) decide how to log. Pass `log` where
// progress output is useful (approvals, swaps).

const { ethers } = require('ethers');
const ccxt = require('ccxt');

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

const WETH_ABI = [
  ...ERC20_ABI,
  'function deposit() payable',
  'function withdraw(uint256 amount)'
];

const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
  'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
];

// SwapRouter02 struct has NO deadline field (unlike the original SwapRouter);
// deadline protection is applied via multicall(deadline, calls).
const SWAP_ROUTER_02_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)'
];

const noop = () => {};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function envAddress(name) {
  const value = requiredEnv(name);
  if (!ethers.isAddress(value)) throw new Error(`${name} is not a valid address: ${value || '<empty>'}`);
  return ethers.getAddress(value);
}

function optionalNumber(name) {
  const value = process.env[name];
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function envNumber(name, min, max) {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return Math.trunc(value);
}

function getConfig() {
  return {
    rpcUrl: requiredEnv('ETH_RPC_URL'),
    walletAddress: process.env.UNISWAP_WALLET_ADDRESS ? ethers.getAddress(process.env.UNISWAP_WALLET_ADDRESS) : null,
    privateKey: process.env.UNISWAP_WALLET_PRIVATE_KEY || '',
    chainId: envNumber('UNISWAP_CHAIN_ID', 1, 999999999),
    l1xToken: envAddress('L1X_TOKEN_ADDRESS'),
    poolAddress: envAddress('L1X_WETH_POOL_ADDRESS'),
    weth: envAddress('WETH_ADDRESS'),
    quoterV2: envAddress('UNISWAP_QUOTER_V2_ADDRESS'),
    swapRouter02: envAddress('UNISWAP_SWAP_ROUTER_02_ADDRESS'),
    defaultSlippageBps: envNumber('UNISWAP_DEFAULT_SLIPPAGE_BPS', 0, 5000),
    deadlineSeconds: envNumber('UNISWAP_DEADLINE_SECONDS', 1, 86400),
    ethUsdPrice: optionalNumber('ETH_USD_PRICE'),
    // USDT conversion (for `convert`: WETH -> USDT on Uniswap). Optional —
    // only the convert path needs these.
    usdtToken: process.env.USDT_ADDRESS ? ethers.getAddress(process.env.USDT_ADDRESS) : null,
    usdtPoolFee: process.env.UNISWAP_USDT_POOL_FEE ? Number(process.env.UNISWAP_USDT_POOL_FEE) : 500
  };
}

function getProvider(config) {
  return new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
}

function getWallet(config, provider, requirePrivateKey = false) {
  if (!config.privateKey) {
    if (requirePrivateKey) throw new Error('UNISWAP_WALLET_PRIVATE_KEY is required for --execute');
    return null;
  }
  const wallet = new ethers.Wallet(config.privateKey, provider);
  if (config.walletAddress && wallet.address.toLowerCase() !== config.walletAddress.toLowerCase()) {
    throw new Error(`UNISWAP_WALLET_ADDRESS (${config.walletAddress}) does not match private key address (${wallet.address})`);
  }
  return wallet;
}

async function getPoolInfo(config, provider) {
  const pool = new ethers.Contract(config.poolAddress, V3_POOL_ABI, provider);
  const [token0, token1, fee, liquidity, slot0] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.liquidity(),
    pool.slot0()
  ]);

  const normalized = {
    token0: ethers.getAddress(token0),
    token1: ethers.getAddress(token1),
    fee: Number(fee),
    liquidity,
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: Number(slot0.tick),
    unlocked: slot0.unlocked
  };

  const hasL1x = [normalized.token0, normalized.token1].some((addr) => addr.toLowerCase() === config.l1xToken.toLowerCase());
  const hasWeth = [normalized.token0, normalized.token1].some((addr) => addr.toLowerCase() === config.weth.toLowerCase());
  if (!hasL1x || !hasWeth) {
    throw new Error(`Pool ${config.poolAddress} is not the configured L1X/WETH pool`);
  }

  return normalized;
}

async function getTokenMeta(address, provider) {
  const token = new ethers.Contract(address, ERC20_ABI, provider);
  const [name, symbol, decimals] = await Promise.all([token.name(), token.symbol(), token.decimals()]);
  return { address, name, symbol, decimals: Number(decimals) };
}

// Pool + both token metas in one call; every consumer needs all three together.
async function loadMarket(config, provider) {
  const [pool, l1x, weth] = await Promise.all([
    getPoolInfo(config, provider),
    getTokenMeta(config.l1xToken, provider),
    getTokenMeta(config.weth, provider)
  ]);
  return { pool, l1x, weth };
}

function bpsFromSlippage(value, defaultSlippageBps) {
  const raw = value == null || value === true ? String(defaultSlippageBps / 100) : String(value);
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
    throw new Error('--slippage must be a percent between 0 and 50');
  }
  return Math.round(percent * 100);
}

function minOut(amountOut, slippageBps) {
  return amountOut * BigInt(10000 - slippageBps) / 10000n;
}

function formatToken(amount, decimals, symbol) {
  return `${ethers.formatUnits(amount, decimals)} ${symbol}`;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function decimalString(value, precision = 8) {
  return Number(value).toFixed(precision).replace(/\.?0+$/, '');
}

async function quoteExactInput({ config, provider, tokenIn, tokenOut, amountIn, fee }) {
  const quoter = new ethers.Contract(config.quoterV2, QUOTER_V2_ABI, provider);
  const params = {
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0
  };
  const result = await quoter.quoteExactInputSingle.staticCall(params);
  return {
    amountOut: result.amountOut,
    sqrtPriceX96After: result.sqrtPriceX96After,
    initializedTicksCrossed: result.initializedTicksCrossed,
    gasEstimate: result.gasEstimate
  };
}

async function quoteExactOutput({ config, provider, tokenIn, tokenOut, amountOut, fee }) {
  const quoter = new ethers.Contract(config.quoterV2, QUOTER_V2_ABI, provider);
  const params = {
    tokenIn,
    tokenOut,
    amount: amountOut,
    fee,
    sqrtPriceLimitX96: 0
  };
  const result = await quoter.quoteExactOutputSingle.staticCall(params);
  return {
    amountIn: result.amountIn,
    sqrtPriceX96After: result.sqrtPriceX96After,
    initializedTicksCrossed: result.initializedTicksCrossed,
    gasEstimate: result.gasEstimate
  };
}

function getTokenDecimals(address, l1x, weth) {
  if (address.toLowerCase() === l1x.address.toLowerCase()) return l1x.decimals;
  if (address.toLowerCase() === weth.address.toLowerCase()) return weth.decimals;
  throw new Error(`Unknown pool token ${address}`);
}

function poolL1xUsdPrice({ sqrtPriceX96, pool, l1x, weth, ethUsdPrice }) {
  const ratio = Number(sqrtPriceX96) / (2 ** 96);
  const token1PerToken0 = ratio * ratio * (10 ** (getTokenDecimals(pool.token0, l1x, weth) - getTokenDecimals(pool.token1, l1x, weth)));
  const l1xIsToken0 = pool.token0.toLowerCase() === l1x.address.toLowerCase();
  const wethPerL1x = l1xIsToken0 ? token1PerToken0 : (1 / token1PerToken0);
  return wethPerL1x * ethUsdPrice;
}

function quoteAverageUsd({ amountInL1x, amountOutWeth, l1x, weth, ethUsdPrice }) {
  const wethOut = Number(ethers.formatUnits(amountOutWeth, weth.decimals));
  const l1xIn = Number(ethers.formatUnits(amountInL1x, l1x.decimals));
  return (wethOut * ethUsdPrice) / l1xIn;
}

async function fetchExchangeEthUsdt(exchangeId) {
  const Exchange = ccxt[exchangeId];
  if (!Exchange) throw new Error(`Unsupported exchange: ${exchangeId}`);
  const exchange = new Exchange({ enableRateLimit: true });
  const ticker = await exchange.fetchTicker('ETH/USDT');
  const candidates = [ticker.last, ticker.close, ticker.bid, ticker.ask]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!candidates.length) throw new Error(`${exchangeId} ETH/USDT returned no usable price`);
  return candidates[0];
}

async function fetchLiveEthUsdPrice() {
  const results = await Promise.allSettled([
    fetchExchangeEthUsdt('bitmart'),
    fetchExchangeEthUsdt('lbank')
  ]);
  const prices = [];
  const errors = [];

  for (let i = 0; i < results.length; i++) {
    const name = i === 0 ? 'bitmart' : 'lbank';
    const result = results[i];
    if (result.status === 'fulfilled') {
      prices.push({ name, price: result.value });
    } else {
      errors.push(`${name}: ${result.reason?.message || result.reason}`);
    }
  }

  if (!prices.length) {
    throw new Error(errors.join('; ') || 'No exchange price sources available');
  }

  if (prices.length === 1) {
    return {
      price: prices[0].price,
      source: prices[0].name,
      details: prices
    };
  }

  return {
    price: prices.reduce((sum, item) => sum + item.price, 0) / prices.length,
    source: prices.map((item) => item.name).join('+'),
    details: prices
  };
}

// Resolution order: live exchanges -> explicit override -> ETH_USD_PRICE env.
async function resolveEthUsdPrice({ override = null, config, log = noop }) {
  try {
    const live = await fetchLiveEthUsdPrice();
    return {
      price: live.price,
      source: `live:${live.source}`,
      details: live.details
    };
  } catch (error) {
    log(`Live ETH/USDT fetch failed: ${error.message}`);
  }

  if (override) {
    return {
      price: parsePositiveNumber(override, '--eth-usd'),
      source: '--eth-usd',
      details: []
    };
  }

  if (config.ethUsdPrice) {
    return {
      price: config.ethUsdPrice,
      source: 'ETH_USD_PRICE',
      details: []
    };
  }

  throw new Error('Could not resolve ETH/USD price from live exchanges, --eth-usd, or ETH_USD_PRICE');
}

// Quote one swap side. side: 'buy' (WETH->L1X) or 'sell' (L1X->WETH).
// amount is a decimal string/number in the input token's units.
async function buildSwapQuote({ config, provider, market, side, amount, slippageBps }) {
  const { pool, l1x, weth } = market;
  const isBuy = side === 'buy';
  const amountIn = ethers.parseUnits(String(amount), isBuy ? weth.decimals : l1x.decimals);
  const tokenIn = isBuy ? config.weth : config.l1xToken;
  const tokenOut = isBuy ? config.l1xToken : config.weth;
  const inMeta = isBuy ? weth : l1x;
  const outMeta = isBuy ? l1x : weth;
  const quote = await quoteExactInput({ config, provider, tokenIn, tokenOut, amountIn, fee: pool.fee });
  const amountOutMin = minOut(quote.amountOut, slippageBps);
  return { side, amountIn, quote, amountOutMin, tokenIn, tokenOut, inMeta, outMeta, slippageBps, pool, l1x, weth };
}

// Quote a sell of sizeL1x and report USD prices for it.
async function evaluateSell({ config, provider, market, sizeL1x, ethUsdPrice }) {
  const { pool, l1x, weth } = market;
  const amountIn = ethers.parseUnits(decimalString(sizeL1x), l1x.decimals);
  const quote = await quoteExactInput({
    config,
    provider,
    tokenIn: config.l1xToken,
    tokenOut: config.weth,
    amountIn,
    fee: pool.fee
  });
  const postPriceUsd = poolL1xUsdPrice({
    sqrtPriceX96: quote.sqrtPriceX96After,
    pool,
    l1x,
    weth,
    ethUsdPrice
  });
  const avgSellPriceUsd = quoteAverageUsd({
    amountInL1x: amountIn,
    amountOutWeth: quote.amountOut,
    l1x,
    weth,
    ethUsdPrice
  });
  const wethOut = Number(ethers.formatUnits(quote.amountOut, weth.decimals));
  return { sizeL1x, amountIn, quote, postPriceUsd, avgSellPriceUsd, wethOut };
}

// Quote buying exactly sizeL1x (WETH -> L1X) and report USD prices for it.
async function evaluateBuy({ config, provider, market, sizeL1x, ethUsdPrice }) {
  const { pool, l1x, weth } = market;
  const amountOut = ethers.parseUnits(decimalString(sizeL1x), l1x.decimals);
  const quote = await quoteExactOutput({
    config,
    provider,
    tokenIn: config.weth,
    tokenOut: config.l1xToken,
    amountOut,
    fee: pool.fee
  });
  const postPriceUsd = poolL1xUsdPrice({
    sqrtPriceX96: quote.sqrtPriceX96After,
    pool,
    l1x,
    weth,
    ethUsdPrice
  });
  const wethIn = Number(ethers.formatUnits(quote.amountIn, weth.decimals));
  const avgBuyPriceUsd = (wethIn * ethUsdPrice) / sizeL1x;
  return { sizeL1x, amountOut, quote, postPriceUsd, avgBuyPriceUsd, wethIn };
}

// Largest buy size whose post-trade pool price stays <= maxPriceUsd
// (buying pushes the pool price UP). Mirror of maxSellSize.
async function maxBuySize({ config, provider, market, maxPriceUsd, maxL1x, stepL1x, ethUsdPrice }) {
  if (stepL1x >= maxL1x) throw new Error('step must be smaller than max size');

  const evaluate = (sizeL1x) => evaluateBuy({ config, provider, market, sizeL1x, ethUsdPrice });

  let low = 0;
  let high = maxL1x;
  let best = null;
  let highResult = null;

  try {
    highResult = await evaluate(high);
    if (highResult.postPriceUsd <= maxPriceUsd) {
      best = highResult;
      low = high;
    }
  } catch (error) {
    highResult = { error: error.message };
  }

  if (!best) {
    for (let i = 0; i < 32 && (high - low) > stepL1x; i++) {
      const mid = (low + high) / 2;
      let result;
      try {
        result = await evaluate(mid);
      } catch (_) {
        high = mid;
        continue;
      }

      if (result.postPriceUsd <= maxPriceUsd) {
        best = result;
        low = mid;
      } else {
        high = mid;
      }
    }
  }

  return { best, highResult };
}

// Largest sell size whose post-trade pool price stays >= minPriceUsd.
// Returns { best, highResult } where best is null if no size qualifies.
async function maxSellSize({ config, provider, market, minPriceUsd, maxL1x, stepL1x, ethUsdPrice }) {
  if (stepL1x >= maxL1x) throw new Error('--step-l1x must be smaller than --max-l1x');

  const evaluate = (sizeL1x) => evaluateSell({ config, provider, market, sizeL1x, ethUsdPrice });

  let low = 0;
  let high = maxL1x;
  let best = null;
  let highResult = null;

  try {
    highResult = await evaluate(high);
    if (highResult.postPriceUsd >= minPriceUsd) {
      best = highResult;
      low = high;
    }
  } catch (error) {
    highResult = { error: error.message };
  }

  if (!best) {
    for (let i = 0; i < 32 && (high - low) > stepL1x; i++) {
      const mid = (low + high) / 2;
      let result;
      try {
        result = await evaluate(mid);
      } catch (_) {
        high = mid;
        continue;
      }

      if (result.postPriceUsd >= minPriceUsd) {
        best = result;
        low = mid;
      } else {
        high = mid;
      }
    }
  }

  return { best, highResult };
}

async function approveIfNeeded({ tokenAddress, owner, spender, amount, wallet, symbol, log = noop }) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) {
    log(`${symbol} allowance OK: ${allowance.toString()}`);
    return;
  }
  log(`${symbol} allowance too low. Approving ${spender}...`);
  const tx = await token.approve(spender, amount);
  log(`approve tx: ${tx.hash}`);
  await tx.wait();
  log('approve confirmed');
}

async function executeSwap({ config, wallet, pool, tokenIn, tokenOut, amountIn, amountOutMin, value, log = noop }) {
  const router = new ethers.Contract(config.swapRouter02, SWAP_ROUTER_02_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const params = {
    tokenIn,
    tokenOut,
    fee: pool.fee,
    recipient: wallet.address,
    amountIn,
    amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0
  };
  const swapData = router.interface.encodeFunctionData('exactInputSingle', [params]);
  const gas = await router.multicall.estimateGas(deadline, [swapData], { value });
  log(`estimated gas: ${gas.toString()}`);
  const tx = await router.multicall(deadline, [swapData], { value });
  log(`swap tx: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`swap confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

// Sell L1X -> WETH with balance check, approval, and slippage protection.
// Used by the CLI sell command and (later) the arb executor.
async function sellL1x({ config, provider, market, sizeL1x, slippageBps, log = noop }) {
  const { pool, l1x } = market;
  const swapQuote = await buildSwapQuote({ config, provider, market, side: 'sell', amount: sizeL1x, slippageBps });
  const wallet = getWallet(config, provider, true);
  const l1xToken = new ethers.Contract(config.l1xToken, ERC20_ABI, wallet);
  const l1xBalance = await l1xToken.balanceOf(wallet.address);
  if (l1xBalance < swapQuote.amountIn) {
    throw new Error(`L1X balance too low: ${formatToken(l1xBalance, l1x.decimals, l1x.symbol)}`);
  }

  await approveIfNeeded({
    tokenAddress: config.l1xToken,
    owner: wallet.address,
    spender: config.swapRouter02,
    amount: swapQuote.amountIn,
    wallet,
    symbol: l1x.symbol,
    log
  });

  const receipt = await executeSwap({
    config,
    wallet,
    pool,
    tokenIn: config.l1xToken,
    tokenOut: config.weth,
    amountIn: swapQuote.amountIn,
    amountOutMin: swapQuote.amountOutMin,
    value: 0n,
    log
  });
  return { receipt, swapQuote };
}

// Buy exactly sizeL1x (WETH -> L1X) via exactOutputSingle, wrapping ETH and
// approving as needed. amountInMaximum caps the WETH spent (slippage guard).
async function buyExactL1x({ config, provider, market, sizeL1x, slippageBps, log = noop }) {
  const { pool, l1x, weth } = market;
  const wallet = getWallet(config, provider, true);
  const amountOut = ethers.parseUnits(decimalString(sizeL1x), l1x.decimals);
  const quote = await quoteExactOutput({
    config,
    provider,
    tokenIn: config.weth,
    tokenOut: config.l1xToken,
    amountOut,
    fee: pool.fee
  });
  const amountInMax = quote.amountIn * BigInt(10000 + slippageBps) / 10000n;

  const wethContract = new ethers.Contract(config.weth, WETH_ABI, wallet);
  const wethBalance = await wethContract.balanceOf(wallet.address);
  if (wethBalance < amountInMax) {
    const toDeposit = amountInMax - wethBalance;
    const ethBalance = await provider.getBalance(wallet.address);
    if (ethBalance < toDeposit) {
      throw new Error(`Not enough ETH+WETH: need ${ethers.formatEther(amountInMax)} WETH max`);
    }
    log(`Depositing ${ethers.formatEther(toDeposit)} ETH to WETH...`);
    const depositTx = await wethContract.deposit({ value: toDeposit });
    log(`deposit tx: ${depositTx.hash}`);
    await depositTx.wait();
    log('deposit confirmed');
  }

  await approveIfNeeded({
    tokenAddress: config.weth,
    owner: wallet.address,
    spender: config.swapRouter02,
    amount: amountInMax,
    wallet,
    symbol: weth.symbol,
    log
  });

  const router = new ethers.Contract(config.swapRouter02, SWAP_ROUTER_02_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const params = {
    tokenIn: config.weth,
    tokenOut: config.l1xToken,
    fee: pool.fee,
    recipient: wallet.address,
    amountOut,
    amountInMaximum: amountInMax,
    sqrtPriceLimitX96: 0
  };
  const swapData = router.interface.encodeFunctionData('exactOutputSingle', [params]);
  const gas = await router.multicall.estimateGas(deadline, [swapData], { value: 0n });
  log(`estimated gas: ${gas.toString()}`);
  const tx = await router.multicall(deadline, [swapData], { value: 0n });
  log(`swap tx: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`swap confirmed in block ${receipt.blockNumber}`);
  return { receipt, amountOut, amountInMax, quote };
}

// Swap WETH -> USDT on Uniswap (the "batch hedge" / convert step). Quotes
// first for slippage protection, approves if needed, swaps via SwapRouter02.
// amountWeth is a decimal string/number in WETH; null = use full balance.
async function swapWethToUsdt({ config, provider, amountWeth = null, slippageBps, log = noop }) {
  if (!config.usdtToken) throw new Error('USDT_ADDRESS not configured');
  const wallet = getWallet(config, provider, true);
  const weth = await getTokenMeta(config.weth, provider);
  const usdt = await getTokenMeta(config.usdtToken, provider);

  const wethContract = new ethers.Contract(config.weth, ERC20_ABI, wallet);
  const balance = await wethContract.balanceOf(wallet.address);
  const amountIn = amountWeth == null ? balance : ethers.parseUnits(String(amountWeth), weth.decimals);
  if (amountIn <= 0n) throw new Error('no WETH to convert');
  if (amountIn > balance) throw new Error(`WETH balance too low: have ${ethers.formatUnits(balance, weth.decimals)}`);

  const quote = await quoteExactInput({
    config,
    provider,
    tokenIn: config.weth,
    tokenOut: config.usdtToken,
    amountIn,
    fee: config.usdtPoolFee
  });
  const amountOutMin = minOut(quote.amountOut, slippageBps);

  await approveIfNeeded({
    tokenAddress: config.weth,
    owner: wallet.address,
    spender: config.swapRouter02,
    amount: amountIn,
    wallet,
    symbol: weth.symbol,
    log
  });

  const receipt = await executeSwap({
    config,
    wallet,
    pool: { fee: config.usdtPoolFee },
    tokenIn: config.weth,
    tokenOut: config.usdtToken,
    amountIn,
    amountOutMin,
    value: 0n,
    log
  });
  return { receipt, amountIn, quote, weth, usdt, amountOutMin };
}

// Swap USDT -> WETH on Uniswap (reverse of swapWethToUsdt — replenish wallet
// WETH for buy-dex trades). amountUsdt is a decimal string/number; null = full
// USDT balance.
async function swapUsdtToWeth({ config, provider, amountUsdt = null, slippageBps, log = noop }) {
  if (!config.usdtToken) throw new Error('USDT_ADDRESS not configured');
  const wallet = getWallet(config, provider, true);
  const weth = await getTokenMeta(config.weth, provider);
  const usdt = await getTokenMeta(config.usdtToken, provider);

  const usdtContract = new ethers.Contract(config.usdtToken, ERC20_ABI, wallet);
  const balance = await usdtContract.balanceOf(wallet.address);
  const amountIn = amountUsdt == null ? balance : ethers.parseUnits(String(amountUsdt), usdt.decimals);
  if (amountIn <= 0n) throw new Error('no USDT to convert');
  if (amountIn > balance) throw new Error(`USDT balance too low: have ${ethers.formatUnits(balance, usdt.decimals)}`);

  const quote = await quoteExactInput({
    config,
    provider,
    tokenIn: config.usdtToken,
    tokenOut: config.weth,
    amountIn,
    fee: config.usdtPoolFee
  });
  const amountOutMin = minOut(quote.amountOut, slippageBps);

  await approveIfNeeded({
    tokenAddress: config.usdtToken,
    owner: wallet.address,
    spender: config.swapRouter02,
    amount: amountIn,
    wallet,
    symbol: usdt.symbol,
    log
  });

  const receipt = await executeSwap({
    config,
    wallet,
    pool: { fee: config.usdtPoolFee },
    tokenIn: config.usdtToken,
    tokenOut: config.weth,
    amountIn,
    amountOutMin,
    value: 0n,
    log
  });
  return { receipt, amountIn, quote, weth, usdt, amountOutMin };
}

module.exports = {
  ERC20_ABI,
  WETH_ABI,
  V3_POOL_ABI,
  QUOTER_V2_ABI,
  SWAP_ROUTER_02_ABI,
  getConfig,
  getProvider,
  getWallet,
  getPoolInfo,
  getTokenMeta,
  loadMarket,
  bpsFromSlippage,
  minOut,
  formatToken,
  parsePositiveNumber,
  decimalString,
  quoteExactInput,
  quoteExactOutput,
  getTokenDecimals,
  poolL1xUsdPrice,
  quoteAverageUsd,
  fetchExchangeEthUsdt,
  fetchLiveEthUsdPrice,
  resolveEthUsdPrice,
  buildSwapQuote,
  evaluateSell,
  evaluateBuy,
  maxSellSize,
  maxBuySize,
  approveIfNeeded,
  executeSwap,
  sellL1x,
  buyExactL1x,
  swapWethToUsdt,
  swapUsdtToWeth
};
