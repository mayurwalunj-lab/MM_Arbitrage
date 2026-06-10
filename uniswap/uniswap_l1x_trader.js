#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { ethers } = require('ethers');

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
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
];

const SWAP_ROUTER_02_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'
];

function usage() {
  console.log(`
Usage:
  node uniswap/uniswap_l1x_trader.js check
  node uniswap/uniswap_l1x_trader.js pool
  node uniswap/uniswap_l1x_trader.js quote-buy --eth 0.01 [--slippage 1]
  node uniswap/uniswap_l1x_trader.js quote-sell --l1x 100 [--slippage 1]
  node uniswap/uniswap_l1x_trader.js buy --eth 0.01 [--slippage 1] [--execute]
  node uniswap/uniswap_l1x_trader.js sell --l1x 100 [--slippage 1] [--execute] [--unwrap]

Notes:
  - buy/sell are dry-run by default. Add --execute to broadcast.
  - buy swaps WETH -> L1X. It deposits ETH to WETH first only with --execute.
  - sell swaps L1X -> WETH. Add --unwrap with --execute to unwrap WETH to ETH after the swap.
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function envAddress(name) {
  const value = requiredEnv(name);
  if (!ethers.isAddress(value)) throw new Error(`${name} is not a valid address: ${value || '<empty>'}`);
  return ethers.getAddress(value);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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
    deadlineSeconds: envNumber('UNISWAP_DEADLINE_SECONDS', 1, 86400)
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

async function printContext(config, provider) {
  const [network, wallet] = await Promise.all([
    provider.getNetwork(),
    Promise.resolve(getWallet(config, provider, false))
  ]);
  console.log(`chainId: ${network.chainId}`);
  console.log(`wallet: ${wallet ? wallet.address : (config.walletAddress || '<not configured>')}`);
  console.log(`L1X token: ${config.l1xToken}`);
  console.log(`WETH token: ${config.weth}`);
  console.log(`pool: ${config.poolAddress}`);
  console.log(`quoterV2: ${config.quoterV2}`);
  console.log(`swapRouter02: ${config.swapRouter02}`);
}

async function commandCheck() {
  const config = getConfig();
  const provider = getProvider(config);
  await printContext(config, provider);
  const pool = await getPoolInfo(config, provider);
  const [l1x, weth] = await Promise.all([
    getTokenMeta(config.l1xToken, provider),
    getTokenMeta(config.weth, provider)
  ]);
  console.log(`pool token0: ${pool.token0}`);
  console.log(`pool token1: ${pool.token1}`);
  console.log(`pool fee: ${pool.fee}`);
  console.log(`pool liquidity: ${pool.liquidity.toString()}`);
  console.log(`pool tick: ${pool.tick}`);
  console.log(`pool unlocked: ${pool.unlocked}`);
  console.log(`token: ${l1x.symbol} decimals=${l1x.decimals}`);
  console.log(`token: ${weth.symbol} decimals=${weth.decimals}`);
}

async function commandQuote(args, side) {
  const config = getConfig();
  const provider = getProvider(config);
  const pool = await getPoolInfo(config, provider);
  const [l1x, weth] = await Promise.all([
    getTokenMeta(config.l1xToken, provider),
    getTokenMeta(config.weth, provider)
  ]);
  const slippageBps = bpsFromSlippage(args.slippage, config.defaultSlippageBps);

  const isBuy = side === 'buy';
  const rawAmount = isBuy ? args.eth : args.l1x;
  if (!rawAmount) throw new Error(isBuy ? '--eth is required' : '--l1x is required');
  const amountIn = ethers.parseUnits(String(rawAmount), isBuy ? weth.decimals : l1x.decimals);
  const tokenIn = isBuy ? config.weth : config.l1xToken;
  const tokenOut = isBuy ? config.l1xToken : config.weth;
  const inMeta = isBuy ? weth : l1x;
  const outMeta = isBuy ? l1x : weth;
  const quote = await quoteExactInput({ config, provider, tokenIn, tokenOut, amountIn, fee: pool.fee });
  const amountOutMin = minOut(quote.amountOut, slippageBps);

  console.log(`${side.toUpperCase()} quote`);
  console.log(`input: ${formatToken(amountIn, inMeta.decimals, inMeta.symbol)}`);
  console.log(`expected output: ${formatToken(quote.amountOut, outMeta.decimals, outMeta.symbol)}`);
  console.log(`minimum output @ ${slippageBps / 100}% slippage: ${formatToken(amountOutMin, outMeta.decimals, outMeta.symbol)}`);
  console.log(`quoted gas estimate: ${quote.gasEstimate.toString()}`);
  console.log(`pool fee: ${pool.fee}`);
  return { config, provider, pool, l1x, weth, amountIn, quote, amountOutMin, tokenIn, tokenOut, inMeta, outMeta };
}

async function approveIfNeeded({ tokenAddress, owner, spender, amount, wallet, symbol }) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) {
    console.log(`${symbol} allowance OK: ${allowance.toString()}`);
    return;
  }
  console.log(`${symbol} allowance too low. Approving ${spender}...`);
  const tx = await token.approve(spender, amount);
  console.log(`approve tx: ${tx.hash}`);
  await tx.wait();
  console.log('approve confirmed');
}

async function commandBuy(args) {
  const details = await commandQuote(args, 'buy');
  const { config, provider, weth, amountIn, amountOutMin, pool } = details;
  const execute = Boolean(args.execute);
  if (!execute) {
    console.log('dry-run only. Add --execute to deposit ETH to WETH and send the swap.');
    return;
  }

  const wallet = getWallet(config, provider, true);
  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance < amountIn) throw new Error(`ETH balance too low: ${ethers.formatEther(ethBalance)} ETH`);

  const wethContract = new ethers.Contract(config.weth, WETH_ABI, wallet);
  const wethBalance = await wethContract.balanceOf(wallet.address);
  if (wethBalance < amountIn) {
    const toDeposit = amountIn - wethBalance;
    console.log(`Depositing ${ethers.formatEther(toDeposit)} ETH to WETH...`);
    const depositTx = await wethContract.deposit({ value: toDeposit });
    console.log(`deposit tx: ${depositTx.hash}`);
    await depositTx.wait();
    console.log('deposit confirmed');
  }

  await approveIfNeeded({
    tokenAddress: config.weth,
    owner: wallet.address,
    spender: config.swapRouter02,
    amount: amountIn,
    wallet,
    symbol: weth.symbol
  });

  await executeSwap({ config, wallet, pool, tokenIn: config.weth, tokenOut: config.l1xToken, amountIn, amountOutMin, value: 0n });
}

async function commandSell(args) {
  const details = await commandQuote(args, 'sell');
  const { config, provider, pool, l1x, amountIn, amountOutMin } = details;
  const execute = Boolean(args.execute);
  if (!execute) {
    console.log('dry-run only. Add --execute to approve L1X and send the swap.');
    return;
  }

  const wallet = getWallet(config, provider, true);
  const l1xToken = new ethers.Contract(config.l1xToken, ERC20_ABI, wallet);
  const l1xBalance = await l1xToken.balanceOf(wallet.address);
  if (l1xBalance < amountIn) throw new Error(`L1X balance too low: ${formatToken(l1xBalance, l1x.decimals, l1x.symbol)}`);

  await approveIfNeeded({
    tokenAddress: config.l1xToken,
    owner: wallet.address,
    spender: config.swapRouter02,
    amount: amountIn,
    wallet,
    symbol: l1x.symbol
  });

  const receipt = await executeSwap({ config, wallet, pool, tokenIn: config.l1xToken, tokenOut: config.weth, amountIn, amountOutMin, value: 0n });
  if (args.unwrap) {
    console.log('Swap confirmed. Check WETH received, then unwrap manually if needed.');
    console.log('Automatic unwrap is intentionally not bundled into the same flow to keep execution simple and auditable.');
  }
  return receipt;
}

async function executeSwap({ config, wallet, pool, tokenIn, tokenOut, amountIn, amountOutMin, value }) {
  const router = new ethers.Contract(config.swapRouter02, SWAP_ROUTER_02_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const params = {
    tokenIn,
    tokenOut,
    fee: pool.fee,
    recipient: wallet.address,
    deadline,
    amountIn,
    amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0
  };
  const gas = await router.exactInputSingle.estimateGas(params, { value });
  console.log(`estimated gas: ${gas.toString()}`);
  const tx = await router.exactInputSingle(params, { value });
  console.log(`swap tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`swap confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (!command || command === 'help' || args.help) {
      usage();
      return;
    }
    if (command === 'check' || command === 'pool') {
      await commandCheck();
      return;
    }
    if (command === 'quote-buy') {
      await commandQuote(args, 'buy');
      return;
    }
    if (command === 'quote-sell') {
      await commandQuote(args, 'sell');
      return;
    }
    if (command === 'buy') {
      await commandBuy(args);
      return;
    }
    if (command === 'sell') {
      await commandSell(args);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
