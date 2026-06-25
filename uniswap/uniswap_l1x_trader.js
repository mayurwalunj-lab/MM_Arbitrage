#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { ethers } = require('ethers');
const lib = require('./lib');

function usage() {
  console.log(`
Usage:
  node uniswap/uniswap_l1x_trader.js check
  node uniswap/uniswap_l1x_trader.js pool
  node uniswap/uniswap_l1x_trader.js quote-buy --eth 0.01 [--slippage 1]
  node uniswap/uniswap_l1x_trader.js quote-sell --l1x 100 [--slippage 1]
  node uniswap/uniswap_l1x_trader.js max-sell-size --min-price-usd 8.5 --max-l1x 1000 [--eth-usd 3500] [--step-l1x 0.01]
  node uniswap/uniswap_l1x_trader.js impact --l1x 10 [--eth-usd 3500]        (sell impact)
  node uniswap/uniswap_l1x_trader.js impact --buy --usd 100                  (buy impact for $100)
  node uniswap/uniswap_l1x_trader.js balance [--address 0x...]
  node uniswap/uniswap_l1x_trader.js convert [--weth 0.1] [--slippage 1] [--execute]            (WETH -> USDT)
  node uniswap/uniswap_l1x_trader.js convert --reverse [--usdt 100] [--slippage 1] [--execute]  (USDT -> WETH)
  node uniswap/uniswap_l1x_trader.js buy --eth 0.01 [--slippage 1] [--execute]
  node uniswap/uniswap_l1x_trader.js sell --l1x 100 [--slippage 1] [--execute] [--unwrap]

Notes:
  - buy/sell are dry-run by default. Add --execute to broadcast.
  - buy swaps WETH -> L1X. It deposits ETH to WETH first only with --execute.
  - sell swaps L1X -> WETH. Add --unwrap with --execute to unwrap WETH to ETH after the swap.
  - max-sell-size fetches live ETH/USDT first, then falls back to --eth-usd or ETH_USD_PRICE.
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

async function printContext(config, provider) {
  const [network, wallet] = await Promise.all([
    provider.getNetwork(),
    Promise.resolve(lib.getWallet(config, provider, false))
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
  const config = lib.getConfig();
  const provider = lib.getProvider(config);
  await printContext(config, provider);
  const { pool, l1x, weth } = await lib.loadMarket(config, provider);
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
  const config = lib.getConfig();
  const provider = lib.getProvider(config);
  const market = await lib.loadMarket(config, provider);
  const slippageBps = lib.bpsFromSlippage(args.slippage, config.defaultSlippageBps);

  const isBuy = side === 'buy';
  const rawAmount = isBuy ? args.eth : args.l1x;
  if (!rawAmount) throw new Error(isBuy ? '--eth is required' : '--l1x is required');
  const details = await lib.buildSwapQuote({ config, provider, market, side, amount: rawAmount, slippageBps });
  const { amountIn, quote, amountOutMin, inMeta, outMeta, pool } = details;

  console.log(`${side.toUpperCase()} quote`);
  console.log(`input: ${lib.formatToken(amountIn, inMeta.decimals, inMeta.symbol)}`);
  console.log(`expected output: ${lib.formatToken(quote.amountOut, outMeta.decimals, outMeta.symbol)}`);
  console.log(`minimum output @ ${slippageBps / 100}% slippage: ${lib.formatToken(amountOutMin, outMeta.decimals, outMeta.symbol)}`);
  console.log(`quoted gas estimate: ${quote.gasEstimate.toString()}`);
  console.log(`pool fee: ${pool.fee}`);
  return { config, provider, market, ...details };
}

async function commandMaxSellSize(args) {
  const config = lib.getConfig();
  const provider = lib.getProvider(config);
  const market = await lib.loadMarket(config, provider);
  const { l1x, weth } = market;

  const minPriceUsd = lib.parsePositiveNumber(args['min-price-usd'], '--min-price-usd');
  const maxL1x = lib.parsePositiveNumber(args['max-l1x'], '--max-l1x');
  const stepL1x = args['step-l1x'] ? lib.parsePositiveNumber(args['step-l1x'], '--step-l1x') : 0.01;
  const ethUsd = await lib.resolveEthUsdPrice({ override: args['eth-usd'], config, log: console.log });
  const ethUsdPrice = ethUsd.price;

  const { best, highResult } = await lib.maxSellSize({
    config,
    provider,
    market,
    minPriceUsd,
    maxL1x,
    stepL1x,
    ethUsdPrice
  });

  const currentPriceUsd = lib.poolL1xUsdPrice({
    sqrtPriceX96: market.pool.sqrtPriceX96,
    pool: market.pool,
    l1x,
    weth,
    ethUsdPrice
  });

  console.log('MAX SELL SIZE');
  console.log(`current pool price: $${currentPriceUsd.toFixed(6)}`);
  console.log(`min post-trade price: $${minPriceUsd}`);
  console.log(`ETH/USD: $${ethUsdPrice} (${ethUsd.source})`);
  if (ethUsd.details?.length) {
    console.log(`ETH/USD sources: ${ethUsd.details.map((item) => `${item.name}=${item.price}`).join(', ')}`);
  }

  if (!best) {
    console.log('No safe sell size found above zero for the requested floor.');
    if (highResult?.error) console.log(`max-size quote error: ${highResult.error}`);
    return;
  }

  console.log(`max search size: ${maxL1x} ${l1x.symbol}`);
  console.log(`step: ${stepL1x} ${l1x.symbol}`);
  console.log(`safe size: ${lib.decimalString(best.sizeL1x)} ${l1x.symbol}`);
  console.log(`expected output: ${lib.formatToken(best.quote.amountOut, weth.decimals, weth.symbol)}`);
  console.log(`average sell price: $${best.avgSellPriceUsd.toFixed(6)}`);
  console.log(`post-trade price: $${best.postPriceUsd.toFixed(6)}`);
  console.log(`quoted gas estimate: ${best.quote.gasEstimate.toString()}`);
  console.log('dry-run only. This command never sends a transaction.');
}

// Record a confirmed swap to the dex_trades accounting table. Best-effort:
// a DB failure must never make a successful trade look failed.
async function recordDexTrade({ side, receipt, config, market, walletAddress, amountIn, tokenOut }) {
  const db = require('../arb/db');
  try {
    const transferIface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
    let actualOut = 0n;
    for (const logEntry of receipt.logs) {
      if (logEntry.address.toLowerCase() !== tokenOut.toLowerCase()) continue;
      try {
        const parsed = transferIface.parseLog(logEntry);
        if (parsed?.name === 'Transfer' && parsed.args.to.toLowerCase() === walletAddress.toLowerCase()) {
          actualOut += parsed.args.value;
        }
      } catch (_) { /* not a Transfer log */ }
    }

    const isBuy = side === 'buy';
    const { l1x, weth } = market;
    const l1xAmount = isBuy
      ? Number(ethers.formatUnits(actualOut, l1x.decimals))
      : Number(ethers.formatUnits(amountIn, l1x.decimals));
    const wethAmount = isBuy
      ? Number(ethers.formatUnits(amountIn, weth.decimals))
      : Number(ethers.formatUnits(actualOut, weth.decimals));

    const gasEth = Number(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? 0n)));
    const ethUsd = await lib.resolveEthUsdPrice({ config, log: () => {} }).catch(() => null);

    await db.init();
    const id = await db.insertDexTrade({
      side,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      l1xAmount,
      wethAmount,
      avgPriceUsd: ethUsd && l1xAmount > 0 ? (wethAmount * ethUsd.price) / l1xAmount : null,
      ethUsd: ethUsd?.price ?? null,
      gasEth,
      gasUsd: ethUsd ? gasEth * ethUsd.price : null,
      wallet: walletAddress,
      isDryRun: false
    });
    console.log(`recorded to accounting DB: dex_trades #${id}`);
  } catch (error) {
    console.log(`WARN: trade NOT recorded to DB (${error.message.slice(0, 100)}). Tx hash: ${receipt.hash}`);
  } finally {
    await db.end().catch(() => {});
  }
}

async function commandConvert(args) {
  const config = lib.getConfig();
  if (!config.usdtToken) throw new Error('USDT_ADDRESS not set in .env (needed for convert)');
  const provider = lib.getProvider(config);
  const weth = await lib.getTokenMeta(config.weth, provider);
  const usdt = await lib.getTokenMeta(config.usdtToken, provider);
  const slippageBps = lib.bpsFromSlippage(args.slippage, config.defaultSlippageBps);

  const owner = config.walletAddress || (lib.getWallet(config, provider, false)?.address);
  if (!owner) throw new Error('No wallet configured');
  const reverse = Boolean(args.reverse);   // --reverse = USDT -> WETH

  // Direction-specific token setup
  const inMeta = reverse ? usdt : weth;
  const outMeta = reverse ? weth : usdt;
  const inAddr = reverse ? config.usdtToken : config.weth;
  const outAddr = reverse ? config.weth : config.usdtToken;
  const amtArg = reverse ? args.usdt : args.weth;

  const inContract = new ethers.Contract(inAddr, lib.ERC20_ABI, provider);
  const balance = await inContract.balanceOf(owner);
  const amountIn = amtArg ? ethers.parseUnits(String(amtArg), inMeta.decimals) : balance;

  const quote = await lib.quoteExactInput({
    config, provider, tokenIn: inAddr, tokenOut: outAddr, amountIn, fee: config.usdtPoolFee
  });
  const amountOutMin = lib.minOut(quote.amountOut, slippageBps);

  console.log(`CONVERT ${inMeta.symbol} -> ${outMeta.symbol}`);
  console.log(`wallet ${inMeta.symbol} balance: ${lib.formatToken(balance, inMeta.decimals, inMeta.symbol)}`);
  const amtIn = Number(ethers.formatUnits(amountIn, inMeta.decimals));
  const amtOut = Number(ethers.formatUnits(quote.amountOut, outMeta.decimals));
  const ethUsd = await lib.resolveEthUsdPrice({ config, log: () => {} }).then((r) => r.price).catch(() => null);
  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  const gasEth = Number(ethers.formatUnits(quote.gasEstimate * gasPriceWei, 18));
  const gasUsd = ethUsd ? gasEth * ethUsd : null;
  const poolFeePct = config.usdtPoolFee / 10000;
  // value of the input leg in USD (WETH side uses ETH price; USDT side is ~$1)
  const inValueUsd = reverse ? amtIn : (ethUsd ? amtIn * ethUsd : null);
  const poolFeeUsd = inValueUsd != null ? inValueUsd * (poolFeePct / 100) : null;

  console.log(`converting: ${amtIn} ${inMeta.symbol}${inValueUsd != null ? ` (~$${inValueUsd.toFixed(2)})` : ''}`);
  console.log(`pool fee tier: ${config.usdtPoolFee} (${poolFeePct}%)`);
  console.log(`expected output: ${amtOut.toFixed(6)} ${outMeta.symbol}`);
  console.log(`minimum output @ ${slippageBps / 100}% slippage: ${Number(ethers.formatUnits(amountOutMin, outMeta.decimals)).toFixed(6)} ${outMeta.symbol}`);
  console.log('--- cost breakdown ---');
  console.log(`  pool fee (${poolFeePct}%): ${poolFeeUsd != null ? '~$' + poolFeeUsd.toFixed(4) : 'n/a'} (already in expected output)`);
  console.log(`  gas: ${quote.gasEstimate.toString()} units${gasUsd != null ? ` × $${ethUsd.toFixed(0)}/ETH ≈ $${gasUsd.toFixed(4)}` : ''}`);
  console.log(`  slippage allowance: up to ${slippageBps / 100}%${inValueUsd != null ? ' ($' + (inValueUsd * slippageBps / 10000).toFixed(4) + ')' : ''}`);

  if (!args.execute) {
    console.log(`dry-run only. Add --execute to swap ${inMeta.symbol} to ${outMeta.symbol}.`);
    return;
  }

  const swapFn = reverse ? lib.swapUsdtToWeth : lib.swapWethToUsdt;
  const swapArg = reverse ? { amountUsdt: args.usdt || null } : { amountWeth: args.weth || null };
  const { receipt } = await swapFn({ config, provider, ...swapArg, slippageBps, log: console.log });

  // Record to dex_trades
  const db = require('../arb/db');
  try {
    const outReceived = Number(ethers.formatUnits(
      transferTotalToWalletGeneric(receipt, outAddr, owner), outMeta.decimals));
    const spent = Number(ethers.formatUnits(amountIn, inMeta.decimals));
    const gasEthActual = Number(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? 0n)));
    // dex_trades is WETH-centric: record the WETH leg amount + implied price
    const wethAmt = reverse ? outReceived : spent;
    const usdtAmt = reverse ? spent : outReceived;
    await db.init();
    const id = await db.insertDexTrade({
      side: reverse ? 'convert-back' : 'convert', txHash: receipt.hash, blockNumber: receipt.blockNumber,
      l1xAmount: 0, wethAmount: wethAmt, avgPriceUsd: wethAmt > 0 ? usdtAmt / wethAmt : null,
      ethUsd, gasEth: gasEthActual, gasUsd: ethUsd ? gasEthActual * ethUsd : null, wallet: owner, isDryRun: false
    });
    console.log(`recorded to accounting DB: dex_trades #${id} (${outReceived} ${outMeta.symbol} received)`);
  } catch (error) {
    console.log(`WARN: convert NOT recorded to DB (${error.message.slice(0, 100)}). Tx: ${receipt.hash}`);
  } finally {
    await db.end().catch(() => {});
  }
}

// Sum Transfer(to=wallet) of a token from a receipt (generic helper).
function transferTotalToWalletGeneric(receipt, tokenAddress, walletAddress) {
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

async function commandBalance(args) {
  const config = lib.getConfig();
  const provider = lib.getProvider(config);
  const market = await lib.loadMarket(config, provider);
  const { l1x, weth } = market;

  let address = typeof args.address === 'string' ? args.address : null;
  if (!address) {
    const wallet = lib.getWallet(config, provider, false);
    address = wallet ? wallet.address : config.walletAddress;
  }
  if (!address) throw new Error('No wallet configured. Set UNISWAP_WALLET_ADDRESS/UNISWAP_WALLET_PRIVATE_KEY or pass --address 0x...');
  address = ethers.getAddress(address);

  const l1xContract = new ethers.Contract(config.l1xToken, lib.ERC20_ABI, provider);
  const wethContract = new ethers.Contract(config.weth, lib.ERC20_ABI, provider);
  const [ethBal, wethBal, l1xBal, wethAllowance, l1xAllowance, ethUsd] = await Promise.all([
    provider.getBalance(address),
    wethContract.balanceOf(address),
    l1xContract.balanceOf(address),
    wethContract.allowance(address, config.swapRouter02),
    l1xContract.allowance(address, config.swapRouter02),
    lib.resolveEthUsdPrice({ config, log: console.log }).catch(() => null)
  ]);

  const fmtUsd = (amount, price) => (price ? ` (= $${(Number(ethers.formatEther(amount)) * price).toFixed(2)})` : '');
  const l1xUsd = ethUsd
    ? lib.poolL1xUsdPrice({ sqrtPriceX96: market.pool.sqrtPriceX96, pool: market.pool, l1x, weth, ethUsdPrice: ethUsd.price })
    : null;

  // USDT (if configured)
  let usdtBal = null;
  let usdtMeta = null;
  if (config.usdtToken) {
    try {
      usdtMeta = await lib.getTokenMeta(config.usdtToken, provider);
      usdtBal = await new ethers.Contract(config.usdtToken, lib.ERC20_ABI, provider).balanceOf(address);
    } catch (_) { /* skip if unreadable */ }
  }

  console.log('WALLET BALANCE');
  console.log(`address: ${address}`);
  console.log(`ETH: ${ethers.formatEther(ethBal)}${fmtUsd(ethBal, ethUsd?.price)}`);
  console.log(`${weth.symbol}: ${ethers.formatEther(wethBal)}${fmtUsd(wethBal, ethUsd?.price)}`);
  console.log(`${l1x.symbol}: ${ethers.formatUnits(l1xBal, l1x.decimals)}${l1xUsd ? ` (= $${(Number(ethers.formatUnits(l1xBal, l1x.decimals)) * l1xUsd).toFixed(2)} @ pool price $${l1xUsd.toFixed(4)})` : ''}`);
  if (usdtBal != null) {
    const usdtNum = Number(ethers.formatUnits(usdtBal, usdtMeta.decimals));
    console.log(`${usdtMeta.symbol}: ${usdtNum.toFixed(6)} (= $${usdtNum.toFixed(2)})`);
  }
  console.log(`${weth.symbol} allowance to router: ${ethers.formatEther(wethAllowance)}`);
  console.log(`${l1x.symbol} allowance to router: ${ethers.formatUnits(l1xAllowance, l1x.decimals)}`);
}

async function commandImpact(args) {
  const config = lib.getConfig();
  const provider = lib.getProvider(config);
  const market = await lib.loadMarket(config, provider);
  const { l1x, weth } = market;

  const isBuy = Boolean(args.buy);
  const ethUsd = await lib.resolveEthUsdPrice({ override: args['eth-usd'], config, log: console.log });
  const ethUsdPrice = ethUsd.price;
  const currentPriceUsd = lib.poolL1xUsdPrice({
    sqrtPriceX96: market.pool.sqrtPriceX96, pool: market.pool, l1x, weth, ethUsdPrice
  });

  // size: --l1x N, or --usd N (converted to L1X at the current price)
  let sizeL1x;
  if (args.usd != null) sizeL1x = lib.parsePositiveNumber(args.usd, '--usd') / currentPriceUsd;
  else sizeL1x = lib.parsePositiveNumber(args.l1x, '--l1x');

  if (isBuy) {
    const r = await lib.evaluateBuy({ config, provider, market, sizeL1x, ethUsdPrice });
    const incUsd = r.postPriceUsd - currentPriceUsd;
    console.log('BUY IMPACT');
    console.log(`ETH/USD: $${ethUsdPrice} (${ethUsd.source})`);
    console.log(`buy size: ${lib.decimalString(sizeL1x)} ${l1x.symbol}`);
    console.log(`current pool price: $${currentPriceUsd.toFixed(6)}`);
    console.log(`cost: ${r.wethIn.toFixed(6)} ${weth.symbol} (= $${(r.wethIn * ethUsdPrice).toFixed(2)})`);
    console.log(`average buy price: $${r.avgBuyPriceUsd.toFixed(6)}`);
    console.log(`post-trade price: $${r.postPriceUsd.toFixed(6)}`);
    console.log(`price impact: +$${incUsd.toFixed(6)} (+${((incUsd / currentPriceUsd) * 100).toFixed(4)}%)`);
  } else {
    const result = await lib.evaluateSell({ config, provider, market, sizeL1x, ethUsdPrice });
    const impactUsd = currentPriceUsd - result.postPriceUsd;
    console.log('SELL IMPACT');
    console.log(`ETH/USD: $${ethUsdPrice} (${ethUsd.source})`);
    console.log(`sell size: ${lib.decimalString(sizeL1x)} ${l1x.symbol}`);
    console.log(`current pool price: $${currentPriceUsd.toFixed(6)}`);
    console.log(`expected output: ${lib.formatToken(result.quote.amountOut, weth.decimals, weth.symbol)} (= $${(result.wethOut * ethUsdPrice).toFixed(4)})`);
    console.log(`average sell price: $${result.avgSellPriceUsd.toFixed(6)}`);
    console.log(`post-trade price: $${result.postPriceUsd.toFixed(6)}`);
    console.log(`price impact: -$${impactUsd.toFixed(6)} (-${((impactUsd / currentPriceUsd) * 100).toFixed(4)}%)`);
  }
  console.log('dry-run only. This command never sends a transaction.');
}

async function commandBuy(args) {
  const details = await commandQuote(args, 'buy');
  const { config, provider, weth, amountIn, amountOutMin, pool } = details;
  const execute = Boolean(args.execute);
  if (!execute) {
    console.log('dry-run only. Add --execute to deposit ETH to WETH and send the swap.');
    return;
  }

  const wallet = lib.getWallet(config, provider, true);
  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance < amountIn) throw new Error(`ETH balance too low: ${ethers.formatEther(ethBalance)} ETH`);

  const wethContract = new ethers.Contract(config.weth, lib.WETH_ABI, wallet);
  const wethBalance = await wethContract.balanceOf(wallet.address);
  if (wethBalance < amountIn) {
    const toDeposit = amountIn - wethBalance;
    console.log(`Depositing ${ethers.formatEther(toDeposit)} ETH to WETH...`);
    const depositTx = await wethContract.deposit({ value: toDeposit });
    console.log(`deposit tx: ${depositTx.hash}`);
    await depositTx.wait();
    console.log('deposit confirmed');
  }

  await lib.approveIfNeeded({
    tokenAddress: config.weth,
    owner: wallet.address,
    spender: config.swapRouter02,
    amount: amountIn,
    wallet,
    symbol: weth.symbol,
    log: console.log
  });

  const receipt = await lib.executeSwap({
    config,
    wallet,
    pool,
    tokenIn: config.weth,
    tokenOut: config.l1xToken,
    amountIn,
    amountOutMin,
    value: 0n,
    log: console.log
  });
  await recordDexTrade({
    side: 'buy',
    receipt,
    config,
    market: details.market,
    walletAddress: wallet.address,
    amountIn,
    tokenOut: config.l1xToken
  });
}

async function commandSell(args) {
  const details = await commandQuote(args, 'sell');
  const { config, provider, pool, l1x, amountIn, amountOutMin } = details;
  const execute = Boolean(args.execute);
  if (!execute) {
    console.log('dry-run only. Add --execute to approve L1X and send the swap.');
    return;
  }

  const wallet = lib.getWallet(config, provider, true);
  const l1xToken = new ethers.Contract(config.l1xToken, lib.ERC20_ABI, wallet);
  const l1xBalance = await l1xToken.balanceOf(wallet.address);
  if (l1xBalance < amountIn) throw new Error(`L1X balance too low: ${lib.formatToken(l1xBalance, l1x.decimals, l1x.symbol)}`);

  await lib.approveIfNeeded({
    tokenAddress: config.l1xToken,
    owner: wallet.address,
    spender: config.swapRouter02,
    amount: amountIn,
    wallet,
    symbol: l1x.symbol,
    log: console.log
  });

  const receipt = await lib.executeSwap({
    config,
    wallet,
    pool,
    tokenIn: config.l1xToken,
    tokenOut: config.weth,
    amountIn,
    amountOutMin,
    value: 0n,
    log: console.log
  });
  await recordDexTrade({
    side: 'sell',
    receipt,
    config,
    market: details.market,
    walletAddress: wallet.address,
    amountIn,
    tokenOut: config.weth
  });
  if (args.unwrap) {
    console.log('Swap confirmed. Check WETH received, then unwrap manually if needed.');
    console.log('Automatic unwrap is intentionally not bundled into the same flow to keep execution simple and auditable.');
  }
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
    if (command === 'max-sell-size') {
      await commandMaxSellSize(args);
      return;
    }
    if (command === 'impact') {
      await commandImpact(args);
      return;
    }
    if (command === 'balance') {
      await commandBalance(args);
      return;
    }
    if (command === 'convert') {
      await commandConvert(args);
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
