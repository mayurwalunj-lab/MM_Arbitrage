'use strict';

// Net-edge math for the CEX->DEX arbitrage:
//   sell N L1X on Uniswap, buy N L1X back on the CEX, sell the received ETH
//   on the CEX immediately (hedge leg).
//
// netUsd(N) = dexRevenueUsd(N)            // WETH received * ETH/USD
//           - dexRevenueUsd(N) * fee      // hedge leg: selling that ETH on CEX
//           - cexCostUsd(N) * (1 + fee)   // walked ask cost + taker fee
//           - gasUsd                      // fixed per swap, size-independent

const { evaluateSell } = require('../uniswap/lib');
const { walkAsks } = require('./orderbook');

function logSpacedSizes(minSize, maxSize, count) {
  if (maxSize <= minSize) return [maxSize];
  const sizes = [];
  const ratio = Math.pow(maxSize / minSize, 1 / (count - 1));
  for (let i = 0; i < count; i++) {
    sizes.push(minSize * Math.pow(ratio, i));
  }
  sizes[count - 1] = maxSize;
  return sizes;
}

function gasCostUsd({ gasPriceWei, gasLimit, ethUsdPrice }) {
  return (Number(gasPriceWei) * gasLimit / 1e18) * ethUsdPrice;
}

// Combine one DEX sell evaluation with one CEX ask walk into a net edge.
function combineLegs({ dexEval, cexWalk, feeRate, gasUsd }) {
  const dexRevenueUsd = dexEval.avgSellPriceUsd * dexEval.sizeL1x;
  const hedgeFeeUsd = dexRevenueUsd * feeRate;
  const cexCostUsd = cexWalk.costQuote;
  const cexFeeUsd = cexCostUsd * feeRate;
  const netUsd = dexRevenueUsd - hedgeFeeUsd - cexCostUsd - cexFeeUsd - gasUsd;
  return {
    sizeL1x: dexEval.sizeL1x,
    dexAvgSellUsd: dexEval.avgSellPriceUsd,
    dexPostPriceUsd: dexEval.postPriceUsd,
    dexRevenueUsd,
    cexAvgAskUsd: cexWalk.avgPrice,
    cexWorstAskUsd: cexWalk.worstPrice,
    cexCostUsd,
    cexFeeUsd,
    hedgeFeeUsd,
    gasUsd,
    netUsd,
    grossEdgePct: cexWalk.avgPrice > 0 ? ((dexEval.avgSellPriceUsd - cexWalk.avgPrice) / cexWalk.avgPrice) * 100 : null
  };
}

// Evaluate a grid of sizes once on the DEX (one quoter call per size), then
// walk each exchange's external book per size — book walks are free, so the
// expensive DEX quotes are shared across exchanges.
//
// exchanges: [{ name, book, ownOrders }]
// Returns { perExchange: { [name]: bestResult|null }, evaluatedSizes }
async function findOpportunities({
  config,
  provider,
  market,
  ethUsdPrice,
  gasPriceWei,
  exchanges,
  options
}) {
  const {
    maxTradeL1x,
    minTradeL1x,
    cexTakerFeeBps,
    gasLimitSwap,
    sizeGridPoints = 7,
    walletL1x = null
  } = options;

  let maxFeasible = maxTradeL1x;
  if (walletL1x != null) maxFeasible = Math.min(maxFeasible, walletL1x);
  if (maxFeasible < minTradeL1x) {
    return { perExchange: Object.fromEntries(exchanges.map((e) => [e.name, null])), evaluatedSizes: [], capped: 'below-min-trade' };
  }

  const feeRate = cexTakerFeeBps / 10000;
  const gasUsd = gasCostUsd({ gasPriceWei, gasLimit: gasLimitSwap, ethUsdPrice });
  const sizes = logSpacedSizes(minTradeL1x, maxFeasible, sizeGridPoints);

  const dexEvals = await Promise.all(
    sizes.map((sizeL1x) =>
      evaluateSell({ config, provider, market, sizeL1x, ethUsdPrice })
        .catch((error) => ({ sizeL1x, error: error.message }))
    )
  );

  const perExchange = {};
  for (const { name, book, ownOrders } of exchanges) {
    let best = null;
    for (const dexEval of dexEvals) {
      if (dexEval.error) continue;
      const cexWalk = walkAsks(book, dexEval.sizeL1x, ownOrders);
      if (!cexWalk.sufficient) continue;
      const result = combineLegs({ dexEval, cexWalk, feeRate, gasUsd });
      if (!best || result.netUsd > best.netUsd) best = result;
    }
    perExchange[name] = best;
  }

  return { perExchange, evaluatedSizes: sizes, gasUsd };
}

module.exports = {
  logSpacedSizes,
  gasCostUsd,
  combineLegs,
  findOpportunities
};
