#!/usr/bin/env node

'use strict';

// Offline self-test for the QDex volume harness. Exercises the crypto round
// trip, the rate limiter, the stop controller, side selection and the V3 sizing
// / quoting math against a synthetic pool. Touches no network and no database.
//
//   node qdex/volume/selftest.js

const assert = require('assert');
const path = require('path');
const { ethers } = require('ethers');

const crypto = require('./crypto');
const guards = require('./guards');
const pools = require('./pools');

let passed = 0;
const pending = [];
const test = (name, fn) => {
  try {
    const r = fn();
    // Async tests return a promise; collect them so the summary waits.
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { console.log(`  ok    ${name}`); passed++; })
        .catch((e) => { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }));
      return;
    }
    console.log(`  ok    ${name}`); passed++;
  } catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

console.log('\nQDex volume harness — offline self-test\n');

// ---------------------------------------------------------------- crypto
const SECRET = crypto.newSecret();

test('encrypt/decrypt round-trips a private key', () => {
  const pk = ethers.Wallet.createRandom().privateKey;
  assert.strictEqual(crypto.decrypt(crypto.encrypt(pk, SECRET), SECRET), pk);
});

test('ciphertext differs every time (random IV)', () => {
  const pk = ethers.Wallet.createRandom().privateKey;
  assert.notStrictEqual(crypto.encrypt(pk, SECRET), crypto.encrypt(pk, SECRET));
});

test('wrong secret fails loudly instead of returning garbage', () => {
  const blob = crypto.encrypt('hello', SECRET);
  assert.throws(() => crypto.decrypt(blob, crypto.newSecret()), /decrypt failed/);
});

test('tampered ciphertext is rejected by the GCM auth tag', () => {
  const parts = crypto.encrypt('hello', SECRET).split(':');
  const buf = Buffer.from(parts[3], 'base64');
  buf[0] ^= 0xff;
  parts[3] = buf.toString('base64');
  assert.throws(() => crypto.decrypt(parts.join(':'), SECRET), /decrypt failed/);
});

test('a passphrase secret is stretched, a short one refused', () => {
  assert.strictEqual(crypto.decrypt(crypto.encrypt('x', 'a-long-enough-passphrase'), 'a-long-enough-passphrase'), 'x');
  assert.throws(() => crypto.encrypt('x', 'short'), /too short/);
});

// ---------------------------------------------------------- storage format
test('wrap/unwrap round-trips in encrypted mode', () => {
  const pk = ethers.Wallet.createRandom().privateKey;
  const blob = crypto.wrap(pk, { plaintext: false, secret: SECRET });
  assert.ok(blob.startsWith('v1:'), 'encrypted blobs carry the version prefix');
  assert.strictEqual(crypto.unwrap(blob, SECRET), pk);
});

test('wrap/unwrap round-trips in plaintext mode', () => {
  const pk = ethers.Wallet.createRandom().privateKey;
  const blob = crypto.wrap(pk, { plaintext: true });
  assert.strictEqual(blob, 'plain:' + pk);
  assert.strictEqual(crypto.unwrap(blob), pk);
});

test('unwrap reads plaintext rows without needing a secret at all', () => {
  const pk = ethers.Wallet.createRandom().privateKey;
  assert.strictEqual(crypto.unwrap(crypto.wrap(pk, { plaintext: true }), undefined), pk);
});

test('encrypted and plaintext rosters can coexist', () => {
  // Switching QVT_STORE_PLAINTEXT_KEYS must never orphan wallets written under
  // the other mode — the prefix is what makes each row self-describing.
  const a = ethers.Wallet.createRandom().privateKey;
  const b = ethers.Wallet.createRandom().privateKey;
  const rows = [crypto.wrap(a, { plaintext: false, secret: SECRET }), crypto.wrap(b, { plaintext: true })];
  assert.deepStrictEqual(rows.map((r) => crypto.unwrap(r, SECRET)), [a, b]);
  assert.strictEqual(crypto.isPlaintext(rows[0]), false);
  assert.strictEqual(crypto.isPlaintext(rows[1]), true);
});

// ---------------------------------------------------------------- HD wallets
test('the same mnemonic always derives the same 10 addresses', () => {
  const m = ethers.Wallet.createRandom().mnemonic.phrase;
  const { derive } = require('./wallets');
  const a = derive(m, 10, "m/44'/60'/0'/0").map((w) => w.address);
  const b = derive(m, 10, "m/44'/60'/0'/0").map((w) => w.address);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(new Set(a).size, 10, 'addresses must be distinct');
});

// ---------------------------------------------------------------- rate limiter
test('rate limiter allows exactly max per rolling hour', () => {
  const rl = new guards.RateLimiter(5);
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) { assert.strictEqual(rl.waitMs(t0 + i), 0); rl.record(t0 + i); }
  assert.ok(rl.waitMs(t0 + 5) > 0, 'sixth call in the hour must wait');
  assert.strictEqual(rl.waitMs(t0 + 3600001), 0, 'window must roll forward');
});

test('rate limiter reports the trailing-hour count', () => {
  const rl = new guards.RateLimiter(100);
  const t0 = 5_000_000;
  for (let i = 0; i < 10; i++) rl.record(t0 + i * 1000);
  assert.strictEqual(rl.countLastHour(t0 + 20000), 10);
  assert.strictEqual(rl.countLastHour(t0 + 3600000 + 20000), 0);
});

// ---------------------------------------------------------------- stop controller
test('stop trips after N consecutive failures', () => {
  const s = new guards.StopController({ maxConsecutiveFailures: 3, stopFile: null, maxSessionTx: 0, maxSessionNotionalWl1x: 0, maxRuntimeMin: 0 });
  s.recordFailure(); s.recordFailure();
  assert.strictEqual(s.stopped, false);
  s.recordFailure();
  assert.strictEqual(s.stopped, true);
  assert.match(s.reason, /consecutive/);
});

test('a success resets the failure streak', () => {
  const s = new guards.StopController({ maxConsecutiveFailures: 3, stopFile: null, maxSessionTx: 0, maxSessionNotionalWl1x: 0, maxRuntimeMin: 0 });
  s.recordFailure(); s.recordFailure(); s.recordSuccess(1);
  s.recordFailure(); s.recordFailure();
  assert.strictEqual(s.stopped, false);
});

test('session transaction budget trips the stop', () => {
  const s = new guards.StopController({ maxConsecutiveFailures: 99, stopFile: null, maxSessionTx: 2, maxSessionNotionalWl1x: 0, maxRuntimeMin: 0 });
  s.recordSuccess(1); s.recordSuccess(1);
  assert.strictEqual(s.shouldStop(), true);
  assert.match(s.reason, /transaction budget/);
});

test('session notional budget trips the stop', () => {
  const s = new guards.StopController({ maxConsecutiveFailures: 99, stopFile: null, maxSessionTx: 0, maxSessionNotionalWl1x: 5, maxRuntimeMin: 0 });
  s.recordSuccess(3); s.recordSuccess(3);
  assert.strictEqual(s.shouldStop(), true);
  assert.match(s.reason, /notional budget/);
});

test('a persistent RPC outage eventually trips the stop', () => {
  const s = new guards.StopController({ maxConsecutiveFailures: 99, maxConsecutiveRpcErrors: 4, stopFile: null, maxSessionTx: 0, maxSessionNotionalWl1x: 0, maxRuntimeMin: 0 });
  for (let i = 0; i < 3; i++) s.recordRpcError();
  assert.strictEqual(s.stopped, false, 'must tolerate a short outage');
  s.recordRpcError();
  assert.strictEqual(s.stopped, true);
  assert.match(s.reason, /RPC failures/);
});

test('RPC errors do not count as transaction failures', () => {
  const s = new guards.StopController({ maxConsecutiveFailures: 2, maxConsecutiveRpcErrors: 0, stopFile: null, maxSessionTx: 0, maxSessionNotionalWl1x: 0, maxRuntimeMin: 0 });
  for (let i = 0; i < 50; i++) s.recordRpcError();
  assert.strictEqual(s.stopped, false, 'a swap that never ran is not a swap that failed');
});

// ---------------------------------------------------------------- instance lock
const os = require('os');
const fsx = require('fs');
const lockPath = path.join(os.tmpdir(), `qvt-selftest-${process.pid}.LOCK`);

test('the lock is taken when free and refused while held', () => {
  fsx.rmSync(lockPath, { force: true });
  assert.strictEqual(guards.acquireLock(lockPath).ok, true);
  const second = guards.acquireLock(lockPath);
  assert.strictEqual(second.ok, false, 'a live holder must block a second instance');
  assert.match(second.reason, /still running/);
  guards.releaseLock(lockPath);
  assert.strictEqual(fsx.existsSync(lockPath), false, 'release must remove the file');
});

test('a lock left by a dead process is taken over, not honoured forever', () => {
  // PID 2^22 - 1 is above every platform's pid_max, so it cannot be alive.
  fsx.writeFileSync(lockPath, JSON.stringify({ pid: 4194303, startedAt: '2020-01-01T00:00:00Z' }));
  const r = guards.acquireLock(lockPath);
  assert.strictEqual(r.ok, true, 'a crashed run must not need manual cleanup');
  guards.releaseLock(lockPath);
});

test('a corrupt lock file does not wedge the bot', () => {
  fsx.writeFileSync(lockPath, 'not json at all');
  assert.strictEqual(guards.acquireLock(lockPath).ok, true);
  guards.releaseLock(lockPath);
  fsx.rmSync(lockPath, { force: true });
});

// ---------------------------------------------------------------- focus
const mk = (label, address) => ({ cfg: { label }, address });
const MKTS = [mk('L1USD', '0xAAA1'), mk('M1X', '0xBBB2'), mk('DRAU', '0xCCC3')];

test('focus by label narrows to just that pool', () => {
  const r = guards.applyPoolFocus(MKTS, ['l1usd']);
  assert.strictEqual(r.markets.length, 1);
  assert.strictEqual(r.markets[0].cfg.label, 'L1USD');
  assert.strictEqual(r.focused, true);
  assert.strictEqual(r.fellBack, false);
});

test('focus by address works and is case-insensitive', () => {
  const r = guards.applyPoolFocus(MKTS, ['0xbbb2']);
  assert.strictEqual(r.markets.length, 1);
  assert.strictEqual(r.markets[0].cfg.label, 'M1X');
});

test('focus can name several pools', () => {
  const r = guards.applyPoolFocus(MKTS, ['L1USD', '0xCCC3']);
  assert.deepStrictEqual(r.markets.map((m) => m.cfg.label), ['L1USD', 'DRAU']);
});

test('a focus matching nothing falls back to ALL pools, not none', () => {
  const r = guards.applyPoolFocus(MKTS, ['TYPO', '0xdeadbeef']);
  assert.strictEqual(r.markets.length, 3, 'a typo must not leave the bot unable to trade');
  assert.strictEqual(r.focused, false);
  assert.strictEqual(r.fellBack, true);
});

test('a partially-matching focus keeps only what matched', () => {
  const r = guards.applyPoolFocus(MKTS, ['L1USD', 'NOPE']);
  assert.deepStrictEqual(r.markets.map((m) => m.cfg.label), ['L1USD']);
  assert.strictEqual(r.fellBack, false);
});

test('no focus set leaves the list untouched', () => {
  for (const f of [[], null, undefined]) {
    const r = guards.applyPoolFocus(MKTS, f);
    assert.strictEqual(r.markets.length, 3);
    assert.strictEqual(r.focused, false);
  }
});

// ---------------------------------------------------------------- wallet limit
const ROSTER = [0, 1, 2, 3, 4].map((i) => ({ idx: i, address: '0x' + i }));

test('wallet limit takes the first N', () => {
  const r = guards.applyWalletLimit(ROSTER, 2);
  assert.deepStrictEqual(r.signers.map((s) => s.idx), [0, 1]);
  assert.strictEqual(r.limited, true);
});

test('a limit at or above the roster size uses everyone', () => {
  for (const n of [5, 9]) {
    const r = guards.applyWalletLimit(ROSTER, n);
    assert.strictEqual(r.signers.length, 5);
    assert.strictEqual(r.limited, false);
  }
});

test('zero or nonsense limits never empty the roster', () => {
  for (const n of [0, -3, NaN, null, undefined]) {
    const r = guards.applyWalletLimit(ROSTER, n);
    assert.strictEqual(r.signers.length, 5, `limit ${n} must not disable trading`);
  }
});

// ---------------------------------------------------------------- side choice
const sideCfg = { maxDeviationPct: 0.75, inventoryTargetPct: 50, biasStrength: 0.7 };

test('price below the band forces SELL, above forces BUY', () => {
  assert.strictEqual(guards.chooseSide({ wl1xValue: 1, tokenValue: 1, deviationPct: -2, config: sideCfg }).side, 'sell');
  assert.strictEqual(guards.chooseSide({ wl1xValue: 1, tokenValue: 1, deviationPct: 2, config: sideCfg }).side, 'buy');
});

test('a wallet holding only WL1X leans BUY — this is what opens epoch 1', () => {
  let buys = 0;
  for (let i = 0; i < 2000; i++) {
    if (guards.chooseSide({ wl1xValue: 3, tokenValue: 0, deviationPct: 0, config: sideCfg }).side === 'buy') buys++;
  }
  assert.ok(buys / 2000 > 0.7, `expected a strong buy lean, got ${(buys / 2000 * 100).toFixed(0)}%`);
});

test('a balanced wallet is near a coin flip', () => {
  let buys = 0;
  for (let i = 0; i < 4000; i++) {
    if (guards.chooseSide({ wl1xValue: 1, tokenValue: 1, deviationPct: 0, config: sideCfg }).side === 'buy') buys++;
  }
  const r = buys / 4000;
  assert.ok(r > 0.44 && r < 0.56, `expected ~50/50, got ${(r * 100).toFixed(0)}%`);
});

// ---------------------------------------------------------------- sizing
test('logUniform stays in range and favours smaller sizes', () => {
  let sum = 0;
  for (let i = 0; i < 5000; i++) {
    const v = guards.logUniform(0.05, 1.0);
    assert.ok(v >= 0.05 && v <= 1.0, `out of range: ${v}`);
    sum += v;
  }
  const mean = sum / 5000;
  assert.ok(mean < 0.5, `log-uniform mean should sit below the midpoint, got ${mean.toFixed(3)}`);
});

test('weightedPick follows the weights', () => {
  const items = [{ id: 'big', w: 90 }, { id: 'small', w: 10 }];
  let big = 0;
  for (let i = 0; i < 5000; i++) if (guards.weightedPick(items, (x) => x.w).id === 'big') big++;
  const r = big / 5000;
  assert.ok(r > 0.85 && r < 0.95, `expected ~90% big, got ${(r * 100).toFixed(0)}%`);
});

// ---------------------------------------------------------------- V3 pool math
// Synthetic 18/18-decimal pool with WL1X as token0 at a price of 100 token/WL1X.
function synth({ price = 100, L = 1e24, wl1xIsToken0 = true } = {}) {
  const t1PerT0 = wl1xIsToken0 ? price : 1 / price;
  const sqrtX96 = Math.sqrt(t1PerT0) * pools.Q96;
  const wl1x = { address: '0x' + '11'.repeat(20), symbol: 'WL1X', decimals: 18 };
  const tok = { address: '0x' + '22'.repeat(20), symbol: 'TOK', decimals: 18 };
  return {
    cfg: { label: 'synth', router: '0x' + '33'.repeat(20) },
    address: '0x' + '44'.repeat(20),
    fee: 3000, liquidity: BigInt(Math.floor(L)), sqrtPriceX96: BigInt(Math.floor(sqrtX96)),
    token0: wl1xIsToken0 ? wl1x : tok, token1: wl1xIsToken0 ? tok : wl1x,
    baseIsToken0: wl1xIsToken0, base: wl1x, quote: tok
  };
}

test('price() recovers the price the pool was built at (WL1X = token0)', () => {
  assert.ok(Math.abs(pools.price(synth({ price: 100 })) - 100) / 100 < 1e-6);
});

test('price() recovers it with WL1X as token1 too', () => {
  assert.ok(Math.abs(pools.price(synth({ price: 100, wl1xIsToken0: false })) - 100) / 100 < 1e-6);
});

test('BUY pushes token-per-WL1X DOWN, SELL pushes it UP', () => {
  const m = synth();
  const b = pools.quote({ market: m, side: 'buy', sizeWl1x: 1, slippageBps: 100 });
  const s = pools.quote({ market: m, side: 'sell', sizeWl1x: 1, slippageBps: 100 });
  assert.ok(b.priceAfter < b.priceBefore, 'buy must lower the price');
  assert.ok(s.priceAfter > s.priceBefore, 'sell must raise it');
});

test('maxSizeAtImpact actually lands on the cap', () => {
  for (const wl1xIsToken0 of [true, false]) {
    for (const side of ['buy', 'sell']) {
      const m = synth({ wl1xIsToken0 });
      const cap = 25;
      const size = pools.maxSizeAtImpact(m, cap, side);
      assert.ok(size > 0, `${side}/${wl1xIsToken0}: size must be positive`);
      const q = pools.quote({ market: m, side, sizeWl1x: size, slippageBps: 100 });
      // The fee is taken off the input, so realised impact lands slightly under
      // the cap — it must never land over it.
      assert.ok(q.impactBps <= cap * 1.02,
        `${side}/token0=${wl1xIsToken0}: impact ${q.impactBps.toFixed(2)} exceeded cap ${cap}`);
      assert.ok(q.impactBps > cap * 0.85,
        `${side}/token0=${wl1xIsToken0}: impact ${q.impactBps.toFixed(2)} far below cap — sizing is too timid`);
    }
  }
});

test('impact grows with size', () => {
  const m = synth();
  const a = pools.quote({ market: m, side: 'buy', sizeWl1x: 1, slippageBps: 100 });
  const b = pools.quote({ market: m, side: 'buy', sizeWl1x: 10, slippageBps: 100 });
  assert.ok(b.impactBps > a.impactBps);
});

test('quoteWithinImpact shrinks an oversized trade under the cap', () => {
  const m = synth();
  const huge = pools.maxSizeAtImpact(m, 25, 'buy') * 8;
  const fit = pools.quoteWithinImpact({ market: m, side: 'buy', sizeWl1x: huge, maxImpactBps: 25, minWl1x: 0.001, slippageBps: 100 });
  assert.ok(fit, 'should find a fitting size');
  assert.strictEqual(fit.shrunkFrom, huge);
  assert.ok(fit.quote.sizeWl1x < huge);
  assert.ok(fit.quote.impactBps <= 25, `shrunk impact ${fit.quote.impactBps} still over cap`);
});

test('quoteWithinImpact gives up when even the minimum is too big', () => {
  const thin = synth({ L: 1e18 });
  const fit = pools.quoteWithinImpact({ market: thin, side: 'buy', sizeWl1x: 100, maxImpactBps: 1, minWl1x: 50, slippageBps: 100 });
  assert.strictEqual(fit, null);
});

test('the pool fee is charged on the input', () => {
  const m = synth();
  const q = pools.quote({ market: m, side: 'buy', sizeWl1x: 0.001, slippageBps: 0 });
  // Tiny trade => negligible slippage, so output/input should be price minus fee.
  const effective = q.amountOutHuman / q.amountInHuman;
  const expected = 100 * (1 - 3000 / 1e6);
  assert.ok(Math.abs(effective - expected) / expected < 0.001,
    `effective ${effective.toFixed(4)} vs expected ${expected.toFixed(4)}`);
});

test('minOut respects the slippage setting', () => {
  const m = synth();
  const q = pools.quote({ market: m, side: 'buy', sizeWl1x: 1, slippageBps: 100 });
  assert.ok(Math.abs(q.minOutHuman - q.amountOutHuman * 0.99) < 1e-9);
});

test('a zero-liquidity pool quotes nothing rather than dividing by zero', () => {
  const dead = synth({ L: 0 });
  assert.strictEqual(pools.quote({ market: dead, side: 'buy', sizeWl1x: 1, slippageBps: 100 }), null);
  assert.strictEqual(pools.maxSizeAtImpact(dead, 25, 'buy'), 0);
});

// ---------------------------------------------------------------- nonce manager
test('nonce manager hands out a strictly increasing sequence', async () => {
  const { NonceManager } = require('./funding');
  const nm = new NonceManager();
  // A node whose pending count LAGS: it keeps answering 5 no matter how many
  // transactions have been broadcast. This is what caused TRANSACTION_REPLACED.
  const signer = { address: '0xAbC', getNonce: async () => 5 };
  const got = [];
  for (let i = 0; i < 4; i++) got.push(nm.take(signer));
  return Promise.all(got).then((ns) => {
    assert.deepStrictEqual(ns, [5, 6, 7, 8], 'each send must get its own nonce');
  });
});

test('nonce manager keeps separate sequences per wallet', async () => {
  const { NonceManager } = require('./funding');
  const nm = new NonceManager();
  const a = { address: '0xAAA', getNonce: async () => 10 };
  const b = { address: '0xBBB', getNonce: async () => 99 };
  assert.strictEqual(await nm.take(a), 10);
  assert.strictEqual(await nm.take(b), 99);
  assert.strictEqual(await nm.take(a), 11);
  assert.strictEqual(await nm.take(b), 100);
});

test('reset re-reads the chain — a failed send invalidates the local count', async () => {
  const { NonceManager } = require('./funding');
  const nm = new NonceManager();
  let chain = 3;
  const signer = { address: '0xAbC', getNonce: async () => chain };
  assert.strictEqual(await nm.take(signer), 3);
  assert.strictEqual(await nm.take(signer), 4);
  chain = 4;                 // only one of the two actually landed
  nm.reset(signer);
  assert.strictEqual(await nm.take(signer), 4, 'must resync rather than keep counting');
});

test('approve and swap from one wallet never share a nonce', async () => {
  const { NonceManager } = require('./nonces');
  const nm = new NonceManager();
  // A wallet's FIRST trade is approve() then exactInputSingle() back to back.
  // This node reports 12 forever, as a lagging RPC does.
  const w = { address: '0xTrader', getNonce: async () => 12 };
  const approveNonce = await NonceManager.nonceFor(nm, w, 'approve');
  const swapNonce = await NonceManager.nonceFor(nm, w, 'swap');
  assert.notStrictEqual(approveNonce, swapNonce,
    'the swap must not replace the approve — it would then revert for no allowance');
  assert.deepStrictEqual([approveNonce, swapNonce], [12, 13]);
});

test('nonceFor without a tracker falls back to querying the node', async () => {
  const { NonceManager } = require('./nonces');
  const w = { address: '0xTrader', getNonce: async (tag) => (tag === 'pending' ? 7 : 0) };
  assert.strictEqual(await NonceManager.nonceFor(null, w, 'x'), 7);
});

test('one tracker keeps ten trading wallets independent', async () => {
  const { NonceManager } = require('./nonces');
  const nm = new NonceManager();
  const fleet = Array.from({ length: 10 }, (_, i) => ({ address: '0xW' + i, getNonce: async () => i * 100 }));
  // Two rounds of trades across the fleet, as the bot's round-robin would do.
  for (const w of fleet) assert.strictEqual(await nm.take(w), fleet.indexOf(w) * 100);
  for (const w of fleet) assert.strictEqual(await nm.take(w), fleet.indexOf(w) * 100 + 1);
});

// ------------------------------------------------- swap step ordering
test('executeSwap approves BEFORE it simulates', () => {
  // eth_call runs the real transferFrom, so simulating an unapproved wallet
  // always reverts. With the order inverted, every wallet is permanently unable
  // to make its first trade on a pool — and any wallet that already has an
  // allowance still works, which disguises it as an intermittent fault.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'pools.js'), 'utf8');
  const body = src.slice(src.indexOf('async function executeSwap('));
  const approveAt = body.indexOf('await ensureAllowance(');
  const simAt = body.indexOf('await quoteOnChain(');
  const sendAt = body.indexOf('c.exactInputSingle(paramsFor(');
  assert.ok(approveAt > 0 && simAt > 0 && sendAt > 0, 'all three steps must be present');
  assert.ok(approveAt < simAt, 'ensureAllowance must run before quoteOnChain');
  assert.ok(simAt < sendAt, 'the simulation must run before the broadcast');
});

// ---------------------------------------------------------------- donor choice
test('donor selection never drops a donor below its own floor', () => {
  const { chooseDonor } = require('./funding');
  const cfg = { walletFloorWl1x: 0.3, minTransferWl1x: 0.25 };
  const snaps = [
    { address: '0xa', wl1x: 0.35 },  // surplus 0.05 — too small
    { address: '0xb', wl1x: 2.0 },   // surplus 1.7  — the winner
    { address: '0xc', wl1x: 0.9 }
  ];
  const d = chooseDonor(snaps, '0xz', cfg);
  assert.strictEqual(d.s.address, '0xb');
  assert.ok(d.surplus <= 2.0 - cfg.walletFloorWl1x + 1e-9);
});

test('no donor is returned when everyone is at the floor', () => {
  const { chooseDonor } = require('./funding');
  const cfg = { walletFloorWl1x: 0.3, minTransferWl1x: 0.25 };
  const snaps = [{ address: '0xa', wl1x: 0.31 }, { address: '0xb', wl1x: 0.30 }];
  assert.strictEqual(chooseDonor(snaps, '0xz', cfg), null);
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', all green'}\n`);
});
