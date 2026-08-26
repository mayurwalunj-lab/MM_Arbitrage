'use strict';

// Sequential nonce allocation, shared by every path that sends a transaction.
//
// Asking the node for getNonce('pending') before each send looks correct but is
// not: on an RPC whose pending count lags the transactions already broadcast,
// two sends draw the SAME nonce and the second replaces the first. It surfaces
// as TRANSACTION_REPLACED with part of the work silently missing.
//
// This bites wherever transactions are issued back to back:
//   funding      20 sequential sends from the parent
//   sweeping     one per token per wallet, plus WL1X and native
//   THE SWAP     a wallet's first trade is approve() immediately followed by
//                exactInputSingle() — and if the swap steals the approve's
//                nonce, the approve never lands and the swap reverts for
//                having no allowance
//
// So the nonce is read once per wallet and incremented locally. One tracker
// should be shared for a whole run: the bot is single-threaded, so a single
// instance covers swaps, approvals, peer transfers and backstops together.

const lib = require('../lib');

class NonceManager {
  constructor() {
    this.next = new Map();
    this.syncing = new Map();
  }

  async take(signer) {
    const k = signer.address.toLowerCase();
    if (!this.next.has(k)) {
      // Share ONE in-flight sync per wallet. Without this, callers that arrive
      // together all see an empty cache, all fetch, and all receive the same
      // starting nonce — reintroducing the very collision this class prevents.
      if (!this.syncing.has(k)) {
        this.syncing.set(k, lib.withRetry(() => signer.getNonce('latest'), { attempts: 3, label: 'nonce.sync' })
          .then((n) => { if (!this.next.has(k)) this.next.set(k, n); this.syncing.delete(k); },
            (e) => { this.syncing.delete(k); throw e; }));
      }
      await this.syncing.get(k);
    }
    // Read-then-increment is atomic here: no await between the two lines, and
    // JS runs this turn to completion before any other caller resumes.
    const n = this.next.get(k);
    this.next.set(k, n + 1);
    return n;
  }

  // Drop the cached value so the next take() re-reads the chain. Call this after
  // ANY failed send — once a transaction has errored, the local count no longer
  // reflects what the chain accepted.
  reset(signer) {
    this.next.delete(signer.address.toLowerCase());
  }

  // Convenience for callers that may or may not have been given a tracker.
  static async nonceFor(nonces, signer, label = 'nonce') {
    if (nonces) return nonces.take(signer);
    return lib.withRetry(() => signer.getNonce('pending'), { attempts: 3, label });
  }
}

// Every send path must be bounded. ethers' tx.wait() polls indefinitely by
// default, so a transaction the node never accepted — observed here: an approve
// whose pending nonce stayed at 0 while the chain kept producing blocks — hangs
// the bot forever with nothing in flight to recover. Twenty minutes of silence
// with no error is worse than a failure, because nothing trips and no operator
// is told.
//
// Two bounds are needed, not one: the BROADCAST itself can hang before a hash
// exists, and the WAIT can hang after it.
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      e.timedOut = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// tx.wait(confirmations, timeoutMs) is bounded by ethers itself, but it throws a
// generic error; wrap it so the caller can tell a timeout from a revert.
async function waitFor(tx, ms, label = 'tx.wait') {
  try {
    return await tx.wait(1, ms);
  } catch (e) {
    if (/timeout|timed out/i.test(String(e.message))) e.timedOut = true;
    throw e;
  }
}

// After a timeout the outcome is genuinely unknown: the transaction may have
// been dropped, or it may be sitting in a mempool about to land. Retrying blind
// would double-spend in the second case, so establish which happened first.
//
// The nonce decides it. A nonce is consumed exactly once, so:
//   pending count still at or below it  -> nothing was accepted, safe to retry
//   count has passed it                 -> something WAS mined at that nonce
//
// Checking `latest` alone is not enough — a transaction can be accepted into the
// mempool (raising `pending`) without being mined yet. Both must be clear before
// declaring nothing was sent.
async function resolveAfterTimeout({ provider, address, nonce, hash, attempts = 5, delayMs = 6000, log = () => {} }) {
  for (let i = 1; i <= attempts; i++) {
    if (hash) {
      const rc = await provider.getTransactionReceipt(hash).catch(() => null);
      if (rc) return { outcome: 'landed', receipt: rc };
    }
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(address, 'latest').catch(() => null),
      provider.getTransactionCount(address, 'pending').catch(() => null)
    ]);
    if (latest != null && pending != null) {
      if (latest > nonce) return { outcome: 'landed', receipt: null };   // mined, hash unknown
      if (pending <= nonce) return { outcome: 'not-sent', latest, pending };
    }
    log(`resolving timeout: nonce ${nonce} still unresolved (latest ${latest}, pending ${pending}) — recheck ${i}/${attempts}`);
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { outcome: 'unknown' };
}

module.exports = { NonceManager, withTimeout, waitFor, resolveAfterTimeout };
