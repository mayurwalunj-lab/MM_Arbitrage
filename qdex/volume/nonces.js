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

module.exports = { NonceManager };
