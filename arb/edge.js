'use strict';

// Net-edge math for both arbitrage directions on L1X:
//
// sell-dex (DEX price ABOVE the CEX ask):
//   sell N L1X on Uniswap, buy N back on the CEX, sell the received ETH on
//   the CEX (hedge). net = dexRevenue - dexRevenue*fee - cexCost*(1+fee) - gas
//
// buy-dex (DEX price BELOW the CEX bid):
//   buy N L1X on Uniswap, sell N on the CEX, buy back the spent ETH on the
//   CEX (hedge). net = cexProceeds*(1-fee) - dexCost*(1+fee) - gas
//
// Per venue the direction is chosen by where the DEX spot sits relative to
// that venue's external best ask/bid. The expensive DEX quotes are shared
// across venues within a direction; book walks are free.

const { evaluateSell, evaluateBuy, maxSellSize, maxBuySize } = require('../uniswap/lib');
const { walkAsks, walkBids, subtractOwnOrders } = require('./orderbook');

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

// sell-dex: dexEval from evaluateSell, cexWalk from walkAsks (we BUY there)
function combineSellLegs({ dexEval, cexWalk, feeRate, gasUsd }) {
  const dexLegUsd = dexEval.avgSellPriceUsd * dexEval.sizeL1x;
  const hedgeFeeUsd = dexLegUsd * feeRate;
  const cexLegUsd = cexWalk.costQuote;
  const cexFeeUsd = cexLegUsd * feeRate;
  const netUsd = dexLegUsd - hedgeFeeUsd - cexLegUsd - cexFeeUsd - gasUsd;
  return {
    direction: 'sell-dex',
    sizeL1x: dexEval.sizeL1x,
    dexAvgPriceUsd: dexEval.avgSellPriceUsd,
    dexPostPriceUsd: dexEval.postPriceUsd,
    dexLegUsd,
    cexAvgPriceUsd: cexWalk.avgPrice,
    cexWorstPriceUsd: cexWalk.worstPrice,
    cexLegUsd,
    cexFeeUsd,
    hedgeFeeUsd,
    gasUsd,
    netUsd,
    grossEdgePct: cexWalk.avgPrice > 0 ? ((dexEval.avgSellPriceUsd - cexWalk.avgPrice) / cexWalk.avgPrice) * 100 : null
  };
}

// buy-dex: dexEval from evaluateBuy, cexWalk from walkBids (we SELL there)
function combineBuyLegs({ dexEval, cexWalk, feeRate, gasUsd }) {
  const dexLegUsd = dexEval.avgBuyPriceUsd * dexEval.sizeL1x;
  const hedgeFeeUsd = dexLegUsd * feeRate;
  const cexLegUsd = cexWalk.costQuote;
  const cexFeeUsd = cexLegUsd * feeRate;
  const netUsd = cexLegUsd - cexFeeUsd - dexLegUsd - hedgeFeeUsd - gasUsd;
  return {
    direction: 'buy-dex',
    sizeL1x: dexEval.sizeL1x,
    dexAvgPriceUsd: dexEval.avgBuyPriceUsd,
    dexPostPriceUsd: dexEval.postPriceUsd,
    dexLegUsd,
    cexAvgPriceUsd: cexWalk.avgPrice,
    cexWorstPriceUsd: cexWalk.worstPrice,
    cexLegUsd,
    cexFeeUsd,
    hedgeFeeUsd,
    gasUsd,
    netUsd,
    grossEdgePct: dexEval.avgBuyPriceUsd > 0 ? ((cexWalk.avgPrice - dexEval.avgBuyPriceUsd) / dexEval.avgBuyPriceUsd) * 100 : null
  };
}

// exchanges: [{ name, book, ownOrders }]
// Returns { perExchange, gasUsd, forward, reverse, skipped?, capped? } where
// forward/reverse describe each direction's boundary and ceiling when active.
async function findOpportunities({
  config,
  provider,
  market,
  ethUsdPrice,
  gasPriceWei,
  dexSpotUsd = null,
  exchanges,
  options
}) {
  const {
    maxTradeL1x,
    minTradeL1x,
    cexTakerFeeBps,
    gasLimitSwap,
    sizeGridPoints = 7,
    walletL1x = null,
    walletEthTotal = null
  } = options;

  const nullPerExchange = () => Object.fromEntries(exchanges.map((e) => [e.name, null]));

  // External top-of-book per venue decides that venue's direction.
  const venues = [];
  let minAsk = null;
  let maxBid = null;
  for (const venue of exchanges) {
    const asks = subtractOwnOrders(venue.book.asks || [], venue.ownOrders, 'asks');
    const bids = subtractOwnOrders(venue.book.bids || [], venue.ownOrders, 'bids');
    const bestAsk = asks.length ? asks[0][0] : null;
    const bestBid = bids.length ? bids[0][0] : null;
    if (bestAsk != null && (minAsk === null || bestAsk < minAsk)) minAsk = bestAsk;
    if (bestBid != null && (maxBid === null || bestBid > maxBid)) maxBid = bestBid;
    let direction = null;
    if (dexSpotUsd != null && bestAsk != null && dexSpotUsd > bestAsk) direction = 'sell-dex';
    else if (dexSpotUsd != null && bestBid != null && dexSpotUsd < bestBid) direction = 'buy-dex';
    venues.push({ ...venue, bestAsk, bestBid, direction });
  }

  const forwardVenues = venues.filter((v) => v.direction === 'sell-dex');
  const reverseVenues = venues.filter((v) => v.direction === 'buy-dex');

  if (!forwardVenues.length && !reverseVenues.length) {
    return { perExchange: nullPerExchange(), gasUsd: null, skipped: 'no-spread', minAsk, maxBid, dexSpotUsd };
  }

  const feeRate = cexTakerFeeBps / 10000;
  const gasUsd = gasCostUsd({ gasPriceWei, gasLimit: gasLimitSwap, ethUsdPrice });
  const perExchange = nullPerExchange();
  const out = { perExchange, gasUsd, minAsk, maxBid, dexSpotUsd };

  // ---- forward: sell on DEX, buy on CEX ---------------------------------
  if (forwardVenues.length) {
    const floorUsd = Math.min(...forwardVenues.map((v) => v.bestAsk));
    let maxFeasible = maxTradeL1x;
    if (walletL1x != null) maxFeasible = Math.min(maxFeasible, walletL1x);

    if (maxFeasible >= minTradeL1x) {
      const { best: ceiling } = await maxSellSize({
        config,
        provider,
        market,
        minPriceUsd: floorUsd,
        maxL1x: maxFeasible,
        stepL1x: Math.max(0.01, maxFeasible / 128),
        ethUsdPrice
      });
      if (ceiling) {
        const searchMax = Math.min(maxFeasible, ceiling.sizeL1x);
        if (searchMax >= minTradeL1x) {
          out.forward = { floorUsd, ceilingL1x: ceiling.sizeL1x };
          const sizes = logSpacedSizes(minTradeL1x, searchMax, sizeGridPoints);
          const dexEvals = await Promise.all(
            sizes.map((sizeL1x) =>
              evaluateSell({ config, provider, market, sizeL1x, ethUsdPrice })
                .catch((error) => ({ sizeL1x, error: error.message }))
            )
          );
          for (const venue of forwardVenues) {
            let best = null;
            for (const dexEval of dexEvals) {
              if (dexEval.error) continue;
              const cexWalk = walkAsks(venue.book, dexEval.sizeL1x, venue.ownOrders);
              if (!cexWalk.sufficient) continue;
              const result = combineSellLegs({ dexEval, cexWalk, feeRate, gasUsd });
              if (!best || result.netUsd > best.netUsd) best = result;
            }
            perExchange[venue.name] = best;
          }
        } else {
          out.forward = { floorUsd, ceilingL1x: ceiling.sizeL1x, tooSmall: true };
        }
      } else {
        out.forward = { floorUsd, ceilingL1x: 0, tooSmall: true };
      }
    } else {
      out.forward = { floorUsd, inventoryBlocked: true, maxFeasible };
    }
  }

  // ---- reverse: buy on DEX, sell on CEX ---------------------------------
  if (reverseVenues.length) {
    const capUsd = Math.max(...reverseVenues.map((v) => v.bestBid));
    let maxFeasible = maxTradeL1x;
    // Buying on the DEX spends ETH/WETH from the wallet; convert that budget
    // into an L1X-equivalent cap at the current spot.
    if (walletEthTotal != null && dexSpotUsd) {
      maxFeasible = Math.min(maxFeasible, (walletEthTotal * ethUsdPrice) / dexSpotUsd);
    }

    if (maxFeasible >= minTradeL1x) {
      const { best: ceiling } = await maxBuySize({
        config,
        provider,
        market,
        maxPriceUsd: capUsd,
        maxL1x: maxFeasible,
        stepL1x: Math.max(0.01, maxFeasible / 128),
        ethUsdPrice
      });
      if (ceiling) {
        const searchMax = Math.min(maxFeasible, ceiling.sizeL1x);
        if (searchMax >= minTradeL1x) {
          out.reverse = { capUsd, ceilingL1x: ceiling.sizeL1x };
          const sizes = logSpacedSizes(minTradeL1x, searchMax, sizeGridPoints);
          const dexEvals = await Promise.all(
            sizes.map((sizeL1x) =>
              evaluateBuy({ config, provider, market, sizeL1x, ethUsdPrice })
                .catch((error) => ({ sizeL1x, error: error.message }))
            )
          );
          for (const venue of reverseVenues) {
            let best = null;
            for (const dexEval of dexEvals) {
              if (dexEval.error) continue;
              const cexWalk = walkBids(venue.book, dexEval.sizeL1x, venue.ownOrders);
              if (!cexWalk.sufficient) continue;
              const result = combineBuyLegs({ dexEval, cexWalk, feeRate, gasUsd });
              if (!best || result.netUsd > best.netUsd) best = result;
            }
            perExchange[venue.name] = best;
          }
        } else {
          out.reverse = { capUsd, ceilingL1x: ceiling.sizeL1x, tooSmall: true };
        }
      } else {
        out.reverse = { capUsd, ceilingL1x: 0, tooSmall: true };
      }
    } else {
      out.reverse = { capUsd, inventoryBlocked: true, maxFeasible };
    }
  }

  return out;
}

module.exports = {
  logSpacedSizes,
  gasCostUsd,
  combineSellLegs,
  combineBuyLegs,
  findOpportunities
};
