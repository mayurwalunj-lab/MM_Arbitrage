'use strict';

// Fund / rebalance / backstop / sweep — all value movement between the parent
// wallet and the epoch's sub-wallets.
//
// Rebalancing is three layers, cheapest first:
//   1. side bias        (guards.chooseSide — costs zero transactions)
//   2. peer transfer    surplus sub-wallet -> starved sub-wallet
//   3. parent backstop  when the whole fleet is short, or gas is low
//
// SWEEP IS IN KIND. At epoch rotation every non-zero token balance is
// transferred to the parent as-is, never sold back to WL1X first. Liquidating
// ~100 token bags would burn the pool fee twice over and move ten prices at once;
// transferring costs one ERC-20 transfer each and moves nothing.

const { ethers } = require('ethers');
const lib = require('../lib');
const { ERC20_ABI } = require('./wallets');
const { NonceManager, withTimeout, waitFor } = require('./nonces');

const wei = (human, decimals) => ethers.parseUnits(Number(human).toFixed(decimals), decimals);

async function transferToken({ signer, token, to, amountWei, log = () => {}, nonces, timeoutMs = 120000 }) {
  const c = new ethers.Contract(token, ERC20_ABI, signer);
  const gas = await lib.withRetry(() => c.transfer.estimateGas(to, amountWei), { attempts: 3, label: 'transfer.estimateGas', log });
  const nonce = await NonceManager.nonceFor(nonces, signer, 'transfer.nonce');
  try {
    const tx = await withTimeout(c.transfer(to, amountWei, { gasLimit: (gas * 12n) / 10n, nonce }), timeoutMs, 'transfer.send');
    return await waitFor(tx, timeoutMs, 'transfer.wait');
  } catch (e) {
    if (nonces) nonces.reset(signer);
    throw e;
  }
}

async function transferNative({ signer, to, amountWei, log = () => {}, nonces, timeoutMs = 120000 }) {
  const nonce = await NonceManager.nonceFor(nonces, signer, 'native.nonce');
  try {
    const tx = await withTimeout(signer.sendTransaction({ to, value: amountWei, nonce }), timeoutMs, 'native.send');
    return await waitFor(tx, timeoutMs, 'native.wait');
  } catch (e) {
    if (nonces) nonces.reset(signer);
    throw e;
  }
}

// Cost of one plain native transfer, used to leave exactly enough behind when
// draining a wallet's gas so the drain transaction itself can still be paid for.
async function nativeSweepReserve(provider) {
  const fee = await provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('1', 'gwei');
  return price * 21000n * 3n; // 3x headroom — better to strand dust than to brick the sweep
}

// ---- fund: parent -> each sub-wallet, WL1X + native gas ----
async function fundWallets({ provider, parent, signers, config, execute, record, log, nonces = new NonceManager() }) {
  const results = [];
  for (const s of signers) {
    const bal = await provider.getBalance(s.address);
    const wl1x = new ethers.Contract(config.wl1x, ERC20_ABI, provider);
    const haveWl1x = await wl1x.balanceOf(s.address);

    const needNative = wei(config.fundGasNative, 18) - bal;
    const needWl1x = wei(config.fundWl1xPerWallet, 18) - haveWl1x;

    if (needNative > 0n) {
      log(`fund w${String(s.idx).padStart(2, '0')} native ${ethers.formatEther(needNative)}`);
      let hash = null;
      if (execute) hash = (await transferNative({ signer: parent, to: s.address, amountWei: needNative, log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
      await record({ kind: 'fund', from: parent.address, to: s.address, token: null, tokenSymbol: 'L1X',
        amount: Number(ethers.formatEther(needNative)), txHash: hash });
    }
    if (needWl1x > 0n) {
      log(`fund w${String(s.idx).padStart(2, '0')} WL1X ${ethers.formatUnits(needWl1x, 18)}`);
      let hash = null;
      if (execute) hash = (await transferToken({ signer: parent, token: config.wl1x, to: s.address, amountWei: needWl1x, log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
      await record({ kind: 'fund', from: parent.address, to: s.address, token: config.wl1x, tokenSymbol: 'WL1X',
        amount: Number(ethers.formatUnits(needWl1x, 18)), txHash: hash });
    }
    results.push({ idx: s.idx, address: s.address });
  }
  return results;
}

// ---- peer rebalance: only WL1X moves between sub-wallets ----
// A donor may never fall below its own floor; that is what stops a rebalance
// from simply relocating the starvation.
function chooseDonor(snapshots, recipientAddress, config) {
  const floor = config.walletFloorWl1x;
  const candidates = snapshots
    .filter((s) => s.address !== recipientAddress)
    .map((s) => ({ s, surplus: s.wl1x - floor }))
    .filter((x) => x.surplus >= config.minTransferWl1x)
    .sort((a, b) => b.surplus - a.surplus);
  return candidates[0] || null;
}

async function rebalanceWallet({ provider, recipient, snapshots, signers, parent, config, execute, record, log, nonces }) {
  const need = Math.max(config.walletFloorWl1x * 2 - recipient.wl1x, config.minTransferWl1x);
  const donor = chooseDonor(snapshots, recipient.address, config);

  if (donor) {
    const amount = Math.min(donor.surplus, need);
    if (amount < config.minTransferWl1x) return null;
    const from = signers.find((x) => x.address === donor.s.address);
    log(`XFER w${from.idx} -> ${recipient.address.slice(0, 10)}… ${amount.toFixed(4)} WL1X (below floor ${config.walletFloorWl1x})`);
    let hash = null;
    if (execute) hash = (await transferToken({ signer: from.wallet, token: config.wl1x, to: recipient.address, amountWei: wei(amount, 18), log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
    await record({ kind: 'peer', from: donor.s.address, to: recipient.address, token: config.wl1x,
      tokenSymbol: 'WL1X', amount, txHash: hash, reason: 'below floor' });
    return { kind: 'peer', amount };
  }

  // Layer 3: nobody has spare WL1X — the whole fleet is short. Parent tops up.
  const wl1x = new ethers.Contract(config.wl1x, ERC20_ABI, provider);
  const parentBal = Number(ethers.formatUnits(await wl1x.balanceOf(parent.address), 18));
  const reserve = parentBal * (config.parentReservePct / 100);
  const available = parentBal - reserve;
  if (available < config.minTransferWl1x) {
    log(`BACKSTOP unavailable — parent holds ${parentBal.toFixed(4)} WL1X (reserve ${reserve.toFixed(4)})`);
    return null;
  }
  const amount = Math.min(available, need);
  log(`BACKSTOP parent -> ${recipient.address.slice(0, 10)}… ${amount.toFixed(4)} WL1X (fleet-wide shortage)`);
  let hash = null;
  if (execute) hash = (await transferToken({ signer: parent, token: config.wl1x, to: recipient.address, amountWei: wei(amount, 18), log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
  await record({ kind: 'backstop', from: parent.address, to: recipient.address, token: config.wl1x,
    tokenSymbol: 'WL1X', amount, txHash: hash, reason: 'fleet-wide shortage' });
  return { kind: 'backstop', amount };
}

// A wallet that spent all its native gas on trading cannot pay for its own
// sweep — its token bags would be stranded with no way to move them. So before
// sweeping, work out what the sweep will cost and have the parent top it up.
// Without this, "money stuck" is a real outcome rather than a theoretical one.
async function ensureSweepGas({ provider, signer, parent, snapshot, config, execute, record, log, nonces }) {
  const legs = Object.values(snapshot.tokens).filter((t) => t.raw > 0n).length
    + (snapshot.wl1xRaw > 0n ? 1 : 0)
    + 1; // the native drain itself
  const fee = await provider.getFeeData();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('1', 'gwei');
  // ERC-20 transfers are ~65k gas; 2x headroom, plus the 21k native leg.
  const needed = gasPrice * (BigInt(legs) * 130000n + 21000n);
  if (snapshot.nativeRaw >= needed) return 0n;

  const top = needed - snapshot.nativeRaw;
  log(`w${signer.idx} needs ${ethers.formatEther(top)} more L1X to afford its own sweep (${legs} legs) — topping up from parent`);
  let hash = null;
  if (execute) hash = (await transferNative({ signer: parent, to: signer.address, amountWei: top, log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
  await record({ kind: 'backstop', from: parent.address, to: signer.address, token: null, tokenSymbol: 'L1X',
    amount: Number(ethers.formatEther(top)), txHash: hash, reason: 'gas for sweep' });
  return top;
}

// ---- sweep: sub-wallet -> parent, IN KIND (no swaps) ----
async function sweepWallet({ provider, signer, parent, snapshot, config, execute, record, log, nonces }) {
  const moved = [];
  const toppedUp = await ensureSweepGas({ provider, signer, parent, snapshot, config, execute, record, log, nonces });
  if (toppedUp > 0n) snapshot = { ...snapshot, nativeRaw: snapshot.nativeRaw + toppedUp };

  // 1. every non-zero pool token, as-is
  for (const [addr, t] of Object.entries(snapshot.tokens)) {
    if (!(t.raw > 0n)) continue;
    log(`sweep w${signer.idx} ${t.human} ${t.symbol}`);
    let hash = null;
    if (execute) hash = (await transferToken({ signer: signer.wallet, token: addr, to: parent.address, amountWei: t.raw, log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
    await record({ kind: 'sweep', from: signer.address, to: parent.address, token: addr, tokenSymbol: t.symbol, amount: t.human, txHash: hash });
    moved.push({ symbol: t.symbol, amount: t.human });
  }

  // 2. WL1X
  if (snapshot.wl1xRaw > 0n) {
    log(`sweep w${signer.idx} ${snapshot.wl1x} WL1X`);
    let hash = null;
    if (execute) hash = (await transferToken({ signer: signer.wallet, token: config.wl1x, to: parent.address, amountWei: snapshot.wl1xRaw, log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
    await record({ kind: 'sweep', from: signer.address, to: parent.address, token: config.wl1x, tokenSymbol: 'WL1X', amount: snapshot.wl1x, txHash: hash });
    moved.push({ symbol: 'WL1X', amount: snapshot.wl1x });
  }

  // 3. native gas LAST, minus the cost of this very transaction
  const reserve = await nativeSweepReserve(provider);
  const send = snapshot.nativeRaw - reserve;
  if (send > 0n) {
    const human = Number(ethers.formatEther(send));
    log(`sweep w${signer.idx} ${human.toFixed(6)} L1X (gas dust left behind: ${ethers.formatEther(reserve)})`);
    let hash = null;
    if (execute) hash = (await transferNative({ signer: signer.wallet, to: parent.address, amountWei: send, log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
    await record({ kind: 'sweep', from: signer.address, to: parent.address, token: null, tokenSymbol: 'L1X', amount: human, txHash: hash });
    moved.push({ symbol: 'L1X', amount: human });
  }
  return moved;
}

// ---- distribute in kind: parent splits everything it holds across the new
// roster. This is why epoch 2+ starts pre-balanced — the new wallets inherit
// the previous epoch's token bags and can trade either direction immediately. ----
async function distributeInKind({ provider, parent, signers, config, tokenMeta, execute, record, log, nonces = new NonceManager() }) {
  const n = signers.length;
  const keep = 1 - config.parentReservePct / 100;

  const assets = [{ address: config.wl1x, symbol: 'WL1X', decimals: 18 },
    ...config.pools.map((p) => {
      const m = tokenMeta[p.token.toLowerCase()] || { symbol: p.label, decimals: 18 };
      return { address: p.token, symbol: m.symbol, decimals: m.decimals };
    })];

  for (const a of assets) {
    const c = new ethers.Contract(a.address, ERC20_ABI, provider);
    const bal = await c.balanceOf(parent.address);
    if (!(bal > 0n)) continue;
    const share = (bal * BigInt(Math.floor(keep * 1000))) / 1000n / BigInt(n);
    if (!(share > 0n)) continue;
    const human = Number(ethers.formatUnits(share, a.decimals));
    log(`distribute ${human} ${a.symbol} to each of ${n} wallets`);
    for (const s of signers) {
      let hash = null;
      if (execute) hash = (await transferToken({ signer: parent, token: a.address, to: s.address, amountWei: share, log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
      await record({ kind: 'fund', from: parent.address, to: s.address, token: a.address, tokenSymbol: a.symbol, amount: human, txHash: hash, reason: 'in-kind distribution' });
    }
  }

  // native gas for the new roster
  for (const s of signers) {
    const have = await provider.getBalance(s.address);
    const need = wei(config.fundGasNative, 18) - have;
    if (need <= 0n) continue;
    let hash = null;
    if (execute) hash = (await transferNative({ signer: parent, to: s.address, amountWei: need, log, nonces, timeoutMs: config.txTimeoutMs }))?.hash;
    await record({ kind: 'fund', from: parent.address, to: s.address, token: null, tokenSymbol: 'L1X',
      amount: Number(ethers.formatEther(need)), txHash: hash, reason: 'gas' });
  }
}

module.exports = { NonceManager, transferToken, transferNative, nativeSweepReserve, ensureSweepGas, fundWallets, rebalanceWallet, chooseDonor, sweepWallet, distributeInKind };
