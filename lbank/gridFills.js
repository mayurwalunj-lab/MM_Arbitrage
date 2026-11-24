'use strict';

// What happened to a grid order that is no longer in the open-orders list,
// from LBank's own record of it (a ccxt order from fetchOrder). No I/O, so it
// can be tested directly.
//
//   OPEN      still on the book (the open-orders list just missed it): log nothing
//   FILLED    some or all of it traded: log FILLED with the amount that traded
//   CANCELLED nothing traded (cancelled, e.g. a cancel that timed out but went
//             through): log CANCELLED, so it is never reported as a fill
//   UNKNOWN   LBank's answer can't be read: log nothing, check again next round
function classifyGoneOrder(order, fallbackPrice) {
    if (!order || typeof order !== 'object') return { action: 'UNKNOWN' };
    const status = order.status;
    const filled = Number(order.filled);
    const price = Number(order.average) > 0 ? Number(order.average)
        : Number(order.price) > 0 ? Number(order.price) : Number(fallbackPrice) || 0;

    if (status === 'open') return { action: 'OPEN' };
    if (!Number.isFinite(filled)) return { action: 'UNKNOWN' };
    if (filled > 0) return { action: 'FILLED', amount: filled, price, valueUsdt: filled * price };
    if (status === 'canceled' || status === 'closed' || status === 'expired' || status === 'rejected') {
        return { action: 'CANCELLED' };
    }
    return { action: 'UNKNOWN' };
}

module.exports = { classifyGoneOrder };
