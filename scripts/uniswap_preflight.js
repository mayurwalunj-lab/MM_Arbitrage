#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { ethers } = require('ethers');
const ccxt = require('ccxt');

const args = new Set(process.argv.slice(2));
const withWallet = args.has('--wallet') || args.has('--all');
const withQuote = args.has('--quote') || args.has('--all');
const withEthPrice = args.has('--eth-price') || args.has('--all');
const ethPriceOnly = args.has('--eth-price-only');

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

const V3_POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
];

const checks = [];

function addCheck(name, fn) {
  checks.push({ name, fn });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name) {
  return process.env[name] || '';
}

function requiredAddress(name) {
  const value = requiredEnv(name);
  if (!ethers.isAddress(value)) throw new Error(`${name} is not a valid address`);
  return ethers.getAddress(value);
}

function requiredNumber(name, min, max) {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return Math.trunc(value);
}

function getConfig() {
  return {
    rpcUrl: requiredEnv('ETH_RPC_URL'),
    chainId: requiredNumber('UNISWAP_CHAIN_ID', 1, 999999999),
    l1xToken: requiredAddress('L1X_TOKEN_ADDRESS'),
    poolAddress: requiredAddress('L1X_WETH_POOL_ADDRESS'),
    weth: requiredAddress('WETH_ADDRESS'),
    quoterV2: requiredAddress('UNISWAP_QUOTER_V2_ADDRESS'),
    swapRouter02: requiredAddress('UNISWAP_SWAP_ROUTER_02_ADDRESS'),
    defaultSlippageBps: requiredNumber('UNISWAP_DEFAULT_SLIPPAGE_BPS', 0, 5000),
    deadlineSeconds: requiredNumber('UNISWAP_DEADLINE_SECONDS', 1, 86400),
    ethUsdPrice: optionalEnv('ETH_USD_PRICE'),
    walletAddress: optionalEnv('UNISWAP_WALLET_ADDRESS'),
    privateKey: optionalEnv('UNISWAP_WALLET_PRIVATE_KEY')
  };
}

async function tokenMeta(provider, address) {
  const token = new ethers.Contract(address, ERC20_ABI, provider);
  const [name, symbol, decimals] = await Promise.all([token.name(), token.symbol(), token.decimals()]);
  return { address, name, symbol, decimals: Number(decimals), contract: token };
}

async function poolInfo(provider, config) {
  const pool = new ethers.Contract(config.poolAddress, V3_POOL_ABI, provider);
  const [token0, token1, fee, liquidity, slot0] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.fee(),
    pool.liquidity(),
    pool.slot0()
  ]);
  return {
    token0: ethers.getAddress(token0),
    token1: ethers.getAddress(token1),
    fee: Number(fee),
    liquidity,
    tick: Number(slot0.tick),
    unlocked: slot0.unlocked
  };
}

async function quote(provider, config, pool, tokenIn, tokenOut, amountIn) {
  const quoter = new ethers.Contract(config.quoterV2, QUOTER_V2_ABI, provider);
  return quoter.quoteExactInputSingle.staticCall({
    tokenIn,
    tokenOut,
    amountIn,
    fee: pool.fee,
    sqrtPriceLimitX96: 0
  });
}

function walletFromConfig(config, provider) {
  if (!config.privateKey) throw new Error('UNISWAP_WALLET_PRIVATE_KEY is required for --wallet');
  const wallet = new ethers.Wallet(config.privateKey, provider);
  if (config.walletAddress && ethers.getAddress(config.walletAddress) !== wallet.address) {
    throw new Error(`UNISWAP_WALLET_ADDRESS does not match private key address ${wallet.address}`);
  }
  return wallet;
}

if (!ethPriceOnly) {
  addCheck('env config is valid', async () => {
    const config = getConfig();
    if (config.walletAddress && !ethers.isAddress(config.walletAddress)) {
      throw new Error('UNISWAP_WALLET_ADDRESS is not a valid address');
    }
  });

  addCheck('rpc connects to expected chain', async () => {
    const config = getConfig();
    const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== config.chainId) {
      throw new Error(`RPC chainId ${network.chainId} does not match UNISWAP_CHAIN_ID ${config.chainId}`);
    }
  });

  addCheck('pool is configured L1X/WETH', async () => {
    const config = getConfig();
    const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
    const pool = await poolInfo(provider, config);
    const tokens = [pool.token0.toLowerCase(), pool.token1.toLowerCase()];
    if (!tokens.includes(config.l1xToken.toLowerCase())) throw new Error('Pool does not include L1X token');
    if (!tokens.includes(config.weth.toLowerCase())) throw new Error('Pool does not include WETH token');
    if (pool.liquidity <= 0n) throw new Error('Pool liquidity is zero');
    if (!pool.unlocked) throw new Error('Pool is locked');
    console.log(`     fee=${pool.fee} liquidity=${pool.liquidity.toString()} tick=${pool.tick}`);
  });

  addCheck('token metadata is readable', async () => {
    const config = getConfig();
    const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
    const [l1x, weth] = await Promise.all([
      tokenMeta(provider, config.l1xToken),
      tokenMeta(provider, config.weth)
    ]);
    console.log(`     ${l1x.symbol} decimals=${l1x.decimals}`);
    console.log(`     ${weth.symbol} decimals=${weth.decimals}`);
  });
}

if (withQuote) {
  addCheck('sample buy/sell quotes work', async () => {
    const config = getConfig();
    const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
    const pool = await poolInfo(provider, config);
    const [l1x, weth] = await Promise.all([
      tokenMeta(provider, config.l1xToken),
      tokenMeta(provider, config.weth)
    ]);
    const buyAmountIn = ethers.parseUnits('0.001', weth.decimals);
    const buyQuote = await quote(provider, config, pool, config.weth, config.l1xToken, buyAmountIn);
    const sellAmountIn = ethers.parseUnits('1', l1x.decimals);
    const sellQuote = await quote(provider, config, pool, config.l1xToken, config.weth, sellAmountIn);
    console.log(`     0.001 ${weth.symbol} -> ${ethers.formatUnits(buyQuote.amountOut, l1x.decimals)} ${l1x.symbol}`);
    console.log(`     1 ${l1x.symbol} -> ${ethers.formatUnits(sellQuote.amountOut, weth.decimals)} ${weth.symbol}`);
  });
}

if (withEthPrice) {
  addCheck('live ETH/USDT price sources', async () => {
    async function fetchPrice(exchangeId) {
      const Exchange = ccxt[exchangeId];
      const exchange = new Exchange({ enableRateLimit: true });
      const ticker = await exchange.fetchTicker('ETH/USDT');
      const price = Number(ticker.last || ticker.close || ticker.bid || ticker.ask);
      if (!Number.isFinite(price) || price <= 0) throw new Error(`${exchangeId} returned invalid ETH/USDT price`);
      return price;
    }

    const results = await Promise.allSettled([fetchPrice('bitmart'), fetchPrice('lbank')]);
    const ok = results
      .map((result, index) => ({ result, name: index === 0 ? 'bitmart' : 'lbank' }))
      .filter((item) => item.result.status === 'fulfilled');
    if (!ok.length) {
      throw new Error(results.map((result, index) => `${index === 0 ? 'bitmart' : 'lbank'}: ${result.reason?.message || result.reason}`).join('; '));
    }
    console.log(`     ${ok.map((item) => `${item.name}=${item.result.value}`).join(', ')}`);
  });
}

if (withWallet) {
  addCheck('wallet read-only balances and allowances', async () => {
    const config = getConfig();
    const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
    const wallet = walletFromConfig(config, provider);
    const [ethBalance, l1x, weth] = await Promise.all([
      provider.getBalance(wallet.address),
      tokenMeta(provider, config.l1xToken),
      tokenMeta(provider, config.weth)
    ]);
    const [l1xBalance, wethBalance, l1xAllowance, wethAllowance] = await Promise.all([
      l1x.contract.balanceOf(wallet.address),
      weth.contract.balanceOf(wallet.address),
      l1x.contract.allowance(wallet.address, config.swapRouter02),
      weth.contract.allowance(wallet.address, config.swapRouter02)
    ]);
    console.log(`     wallet=${wallet.address}`);
    console.log(`     ETH=${ethers.formatEther(ethBalance)}`);
    console.log(`     ${l1x.symbol}=${ethers.formatUnits(l1xBalance, l1x.decimals)} allowance=${l1xAllowance.toString()}`);
    console.log(`     ${weth.symbol}=${ethers.formatUnits(wethBalance, weth.decimals)} allowance=${wethAllowance.toString()}`);
  });
}

async function main() {
  const failures = [];
  for (const check of checks) {
    try {
      await check.fn();
      console.log(`PASS ${check.name}`);
    } catch (error) {
      failures.push(check.name);
      console.log(`FAIL ${check.name}`);
      console.log(`     ${error.message}`);
    }
  }

  console.log('');
  if (failures.length) {
    console.log(`Uniswap preflight failed: ${failures.length} issue(s).`);
    process.exitCode = 1;
    return;
  }

  console.log('Uniswap preflight passed.');
  if (!withQuote || !withWallet || !withEthPrice) {
    console.log('For deeper checks run: npm run uniswap:test:all');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
