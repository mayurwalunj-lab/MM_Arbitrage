'use strict';

// Pure decision helpers for the QDex MM — no I/O, so they can be tested directly.

// Is the price fresh enough to act on? `record` is { price, updatedAt } or null
// (lib.getOracleRecord or backend_price.getBackendPrice); `label` names it in
// the reason. maxAgeSec <= 0 disables the check. An unreadable or implausible
// timestamp fails closed: a price we can't date is treated like a stale one.
function checkOracleAge(record, nowSec, maxAgeSec, label = 'oracle') {
  if (!(maxAgeSec > 0)) return { ok: true, ageSec: null, reason: 'age check off' };
  const t = record ? Number(record.updatedAt) : NaN;
  if (!Number.isFinite(t) || t <= 0) return { ok: false, ageSec: null, reason: `${label} update time unreadable` };
  const ageSec = nowSec - t;
  if (ageSec < -600) return { ok: false, ageSec, reason: `${label} update time is in the future` };
  if (ageSec > maxAgeSec) return { ok: false, ageSec, reason: `${label} stale: last update ${formatAge(ageSec)} ago (limit ${formatAge(maxAgeSec)})` };
  return { ok: true, ageSec, reason: 'fresh' };
}

function formatAge(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// Cap a trade to what the wallet can pay. Selling spends base (WL1X); buying
// spends quote (XUSD ≈ sizeBase × price). Keeps a tiny margin so rounding can't
// push amountIn past the balance. When the balance shrinks the trade below
// minTradeBase it is skipped; a small trade the wallet can fully pay still goes.
function capToBalance({ side, sizeBase, price, balanceBase, balanceQuote, minTradeBase = 0 }) {
  const margin = 0.999;
  const affordable = side === 'sell'
    ? Number(balanceBase) * margin
    : (price > 0 ? (Number(balanceQuote) * margin) / price : 0);
  if (!Number.isFinite(affordable) || !(affordable > 0)) return { sizeBase: 0, capped: true, affordable: 0 };
  if (sizeBase <= affordable) return { sizeBase, capped: false, affordable };
  if (affordable < Math.max(minTradeBase, 0)) return { sizeBase: 0, capped: true, affordable };
  return { sizeBase: affordable, capped: true, affordable };
}

// After `after` swap failures in a row, stop sending swaps for `pauseMs`, so a
// swap that can't succeed isn't resubmitted every tick. A success resets it.
function createFailureBackoff({ after = 3, pauseMs = 60 * 60 * 1000 } = {}) {
  let failures = 0;
  let pausedUntil = 0;
  return {
    blocked(nowMs) { return nowMs < pausedUntil; },
    remainingMs(nowMs) { return Math.max(0, pausedUntil - nowMs); },
    failures() { return failures; },
    onSuccess() { failures = 0; pausedUntil = 0; },
    // Returns true when this failure starts a pause.
    onFailure(nowMs) {
      failures++;
      if (after > 0 && failures >= after) { pausedUntil = nowMs + pauseMs; failures = 0; return true; }
      return false;
    }
  };
}

module.exports = { checkOracleAge, capToBalance, createFailureBackoff, formatAge };
