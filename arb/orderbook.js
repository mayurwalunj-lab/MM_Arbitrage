'use strict';

// Pure orderbook math. No I/O, no ccxt — everything takes plain arrays so it
// can be unit-tested with fixtures.
//
// Level format: [price, amount] (ccxt orderbook convention, amounts in base
// units i.e. L1X). Own-order format: { price, remaining, side } where side is
// 'buy' or 'sell'.

// Remove our own grid/MM orders from one side of the book so edge math runs
// on external liquidity only. Trading against our own orders is wash trading:
// it pays fees twice and produces no real profit.
function subtractOwnOrders(levels, ownOrders, side) {
  if (!ownOrders || !ownOrders.length) return levels.map(([p, a]) => [p, a]);
  const ownSide = side === 'asks' ? 'sell' : 'buy';
  const own = ownOrders.filter((o) => o.side === ownSide && Number(o.remaining) > 0);
  if (!own.length) return levels.map(([p, a]) => [p, a]);

  const out = [];
  for (const [price, amount] of levels) {
    let remaining = amount;
    for (const order of own) {
      const tolerance = Math.max(Math.abs(price), Math.abs(order.price)) * 1e-9;
      if (Math.abs(order.price - price) <= tolerance) {
        remaining -= Number(order.remaining);
      }
    }
    if (remaining > 1e-12) out.push([price, remaining]);
  }
  return out;
}

// Walk levels (best first) to fill sizeBase. Returns the volume-weighted
// average price actually paid/received, the worst level touched, and whether
// the book had enough depth.
function walkLevels(levels, sizeBase) {
  if (!(sizeBase > 0)) throw new Error('walkLevels: size must be positive');
  let remaining = sizeBase;
  let costQuote = 0;
  let worstPrice = null;
  let levelsUsed = 0;

  for (const [price, amount] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, amount);
    costQuote += take * price;
    worstPrice = price;
    remaining -= take;
    levelsUsed++;
  }

  const filledBase = sizeBase - remaining;
  return {
    filledBase,
    costQuote,
    avgPrice: filledBase > 0 ? costQuote / filledBase : null,
    worstPrice,
    levelsUsed,
    sufficient: remaining <= 1e-12
  };
}

function walkAsks(book, sizeBase, ownOrders) {
  return walkLevels(subtractOwnOrders(book.asks || [], ownOrders, 'asks'), sizeBase);
}

function walkBids(book, sizeBase, ownOrders) {
  return walkLevels(subtractOwnOrders(book.bids || [], ownOrders, 'bids'), sizeBase);
}

// Total external base-units available on one side within priceRangePct of mid.
function depthWithinRange(levels, mid, priceRangePct) {
  let depth = 0;
  for (const [price, amount] of levels) {
    if (Math.abs(price - mid) / mid <= priceRangePct / 100) depth += amount;
  }
  return depth;
}

// Sanity-check an external (own-orders-filtered) book. A grid bot mid-refresh
// leaves the book thin or wildly spread; any failure here means "do not trust
// this tick", which also catches crashed grids that never cleared their flag.
function bookSanity(book, ownOrders, { maxSpreadPct, minDepthBase, depthRangePct }) {
  const asks = subtractOwnOrders(book.asks || [], ownOrders, 'asks');
  const bids = subtractOwnOrders(book.bids || [], ownOrders, 'bids');
  const reasons = [];

  if (!asks.length) reasons.push('no external asks');
  if (!bids.length) reasons.push('no external bids');
  if (reasons.length) return { ok: false, reasons, mid: null, spreadPct: null, askDepth: 0, bidDepth: 0 };

  const bestAsk = asks[0][0];
  const bestBid = bids[0][0];
  const mid = (bestAsk + bestBid) / 2;
  const spreadPct = ((bestAsk - bestBid) / mid) * 100;

  if (bestBid >= bestAsk) reasons.push(`crossed book: bid ${bestBid} >= ask ${bestAsk}`);
  if (spreadPct > maxSpreadPct) reasons.push(`spread ${spreadPct.toFixed(3)}% > max ${maxSpreadPct}%`);

  const askDepth = depthWithinRange(asks, mid, depthRangePct);
  const bidDepth = depthWithinRange(bids, mid, depthRangePct);
  if (askDepth < minDepthBase) reasons.push(`ask depth ${askDepth.toFixed(2)} < min ${minDepthBase}`);
  if (bidDepth < minDepthBase) reasons.push(`bid depth ${bidDepth.toFixed(2)} < min ${minDepthBase}`);

  return { ok: reasons.length === 0, reasons, mid, spreadPct, askDepth, bidDepth, asks, bids };
}

module.exports = {
  subtractOwnOrders,
  walkLevels,
  walkAsks,
  walkBids,
  depthWithinRange,
  bookSanity
};
