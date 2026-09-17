'use strict';

// Epoch lifecycle, end to end, with nothing left behind.
//
//   expired / draining epoch  ->  sweep every wallet  ->  VERIFY it is empty
//                             ->  retire  ->  create a fresh roster
//                             ->  seed it from the parent (top-up, idempotent)
//
// Two properties matter more than anything else here:
//
//   1. An epoch is only retired once its wallets are VERIFIED empty. Retiring on
//      the strength of "the sweep didn't throw" is how epoch 13 ended up retired
//      while still holding 106 token bags. A retired roster is never looked at
//      again, so anything left in it is lost in practice.
//
//   2. Every step is safe to repeat. The process can die at any point — RPC
//      outage, pm2 restart, a node dropping transactions — and the next run picks
//      up exactly where it stopped: a 'draining' epoch is re-swept, a roster with
//      unmarked wallets is topped up to its target rather than paid twice.

const { ethers } = require('ethers');
const db = require('./db');
const epochMod = require('./epoch');
const walletsMod = require('./wallets');
const poolsMod = require('./pools');
const funding = require('./funding');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

// Price every pool token in WL1X once. A pool whose price will not load yields
// Infinity for its token — "worth moving, cannot tell how much" — so an
// unpriced balance is always swept and always counted as left over. Abandoning
// is irreversible; a wasted transfer is not.
async function bagValuer({ provider, config, tokenMeta, log = () => {} }) {
  const px = new Map();
  for (const pc of config.pools) {
    try {
      const m = await poolsMod.loadMarket({ provider, poolCfg: pc, config, tokenMeta });
      px.set(pc.token.toLowerCase(), poolsMod.price(m));
    } catch (e) {
      log(`WARN ${pc.label} price unavailable — its balances will be swept and counted, never abandoned`);
    }
  }
  return (addr, human) => {
    const p = px.get(String(addr).toLowerCase());
    return p > 0 ? human / p : Infinity;
  };
}

// What a wallet still holds that a sweep should have removed. Native gas is
// reported but never counted: the drain must leave enough to pay for itself.
function leftovers(snapshot, valueBag, allowWl1x) {
  const left = [];
  if (snapshot.wl1xRaw > 0n && snapshot.wl1x >= allowWl1x) {
    left.push({ symbol: 'WL1X', amount: snapshot.wl1x, worth: snapshot.wl1x });
  }
  for (const [addr, t] of Object.entries(snapshot.tokens)) {
    if (!(t.raw > 0n)) continue;
    const worth = valueBag(addr, t.human);
    if (worth >= allowWl1x) left.push({ symbol: t.symbol, amount: t.human, worth });
  }
  return left;
}

// Sweep one roster to the parent and prove it worked. Repeatable: it reads
// balances fresh every time, so a second pass only moves what the first missed.
async function sweepAndVerify({ config, provider, epoch, parent, tokenMeta, execute, log, nonces, record }) {
  const signers = await epochMod.loadSigners({ config, epochId: epoch.id, provider });
  const valueBag = await bagValuer({ provider, config, tokenMeta, log });
  // Anything worth less than this may stay. Defaults to effectively nothing; an
  // operator who deliberately set QVT_SWEEP_MIN_WL1X gets that honoured too.
  const allow = Math.max(config.rotateMaxLeftWl1x || 0, config.sweepMinWl1x || 0);

  // Only a LIVE roster moves to 'draining'. A retired one being swept again for
  // its leftovers must stay retired — marking it draining would make it an open
  // epoch again, and two open epochs stop the harness cold.
  if (execute && epoch.status === 'active') await db.setEpochStatus(epoch.id, 'draining', 'rotation: sweeping');
  log(`epoch ${epoch.id}: sweeping ${signers.length} wallets to ${parent.address} in kind — ${execute ? 'LIVE' : 'DRY-RUN'}`);

  for (const s of signers) {
    try {
      const snap = await walletsMod.snapshot({ provider, address: s.address, config, tokenMeta });
      const moved = await funding.sweepWallet({ provider, signer: s, parent, snapshot: snap, config, execute, record, log, nonces, valueBag });
      if (execute && moved.length) await db.markWallet(epoch.id, s.idx, 'swept', moved);
    } catch (e) {
      // One wallet must not stop the other nine. Verification below reports it,
      // and the caller sweeps again.
      if (nonces) nonces.reset(s.wallet || s);
      log(`w${pad2(s.idx)} sweep incomplete: ${String(e.shortMessage || e.message).slice(0, 100)}`);
    }
  }

  if (!execute) {
    log(`epoch ${epoch.id}: [DRY] would now verify every wallet is empty` +
      (epoch.status === 'retired' ? '' : ' before retiring it'));
    return { ok: false, dryRun: true, left: [] };
  }

  const left = [];
  let gasLeft = 0;
  for (const s of signers) {
    const snap = await walletsMod.snapshot({ provider, address: s.address, config, tokenMeta });
    gasLeft += snap.native;
    const l = leftovers(snap, valueBag, allow);
    if (l.length) left.push({ idx: s.idx, address: s.address, items: l });
  }
  if (left.length) {
    for (const w of left) {
      log(`  w${pad2(w.idx)} still holds: ${w.items.map((i) => `${i.symbol} ${i.worth === Infinity ? '(unpriced)' : i.worth.toFixed(5) + ' WL1X'}`).join(', ')}`);
    }
    log(`epoch ${epoch.id}: NOT empty — ${left.length} wallet(s) still hold funds; it stays 'draining' and will be swept again`);
    return { ok: false, left, gasLeft };
  }
  log(`epoch ${epoch.id}: verified empty (gas left for the drains themselves: ${gasLeft.toFixed(4)} L1X)`);
  return { ok: true, left: [], gasLeft };
}

// The per-wallet float a roster needs to trade smoothly: enough that a position
// in one of its pools can reach minTrade and still be sold. Below this the fleet
// seizes up within hours, which is worse than not starting — so seeding waits.
function seedTarget(config) {
  if (Number.isFinite(config.seedMinWl1x) && config.seedMinWl1x > 0) return config.seedMinWl1x;
  const k = config.poolsPerWallet > 0 ? config.poolsPerWallet : 1;
  const inv = (config.inventoryTargetPct || 50) / 100;
  return config.walletFloorWl1x + (k * config.minTradeWl1x) / inv;
}

// Share the parent's WL1X across the wallets that are not yet funded, as a
// TOP-UP to a fixed per-wallet level. Re-running sends only the shortfall, so a
// crash half way through never pays anyone twice.
function planSeed({ parentWl1x, unfundedBalances, reservePct }) {
  const keep = 1 - (reservePct || 0) / 100;
  const n = unfundedBalances.length;
  if (!n) return { perWallet: 0, needFromParent: 0 };
  const alreadyThere = unfundedBalances.reduce((a, b) => a + b, 0);
  const perWallet = (parentWl1x * keep + alreadyThere) / n;
  const needFromParent = unfundedBalances.reduce((a, b) => a + Math.max(0, perWallet - b), 0);
  return { perWallet, needFromParent };
}

async function seedRoster({ config, provider, epoch, parent, tokenMeta, execute, log, nonces, record, passes = 4,
                            balanceOf = null, retryDelayMs = 15000 }) {
  const rows = await db.getWallets(epoch.id);
  const unfunded = rows.filter((r) => !r.funded_at);
  if (!unfunded.length) return { ok: true, seeded: 0 };

  const signersAll = await epochMod.loadSigners({ config, epochId: epoch.id, provider });
  const signers = signersAll.filter((s) => unfunded.some((r) => r.idx === s.idx));
  const balOf = balanceOf || (async (a) => {
    const c = new ethers.Contract(config.wl1x, walletsMod.ERC20_ABI, provider);
    return Number(ethers.formatUnits(await c.balanceOf(a), 18));
  });

  const parentWl1x = await balOf(parent.address);
  const balances = [];
  for (const s of signers) balances.push(await balOf(s.address));
  const plan = planSeed({ parentWl1x, unfundedBalances: balances, reservePct: config.parentReservePct });
  const target = seedTarget(config);

  if (plan.perWallet < target) {
    // perWallet = (parent*keep + alreadyThere) / n  >=  target
    //   =>  parent >= (target*n - alreadyThere) / keep
    const keep = 1 - (config.parentReservePct || 0) / 100;
    const alreadyThere = balances.reduce((a, b) => a + b, 0);
    const shortfall = (target * signers.length - alreadyThere) / keep - parentWl1x;
    return {
      ok: false, waitingForFunds: true, perWallet: plan.perWallet, target,
      parentWl1x, shortfall: Math.max(0, shortfall), wallets: signers.length
    };
  }

  log(`epoch ${epoch.id}: seeding ${signers.length} wallet(s) to ${plan.perWallet.toFixed(4)} WL1X + ${config.fundGasNative} L1X each — ${execute ? 'LIVE' : 'DRY-RUN'}`);
  if (!execute) return { ok: false, dryRun: true, perWallet: plan.perWallet };

  // fundWallets tops up to config.fundWl1xPerWallet — point it at this roster's
  // share for the duration, without touching the caller's config.
  const cfg = { ...config, fundWl1xPerWallet: plan.perWallet };
  let pending = signers;
  for (let pass = 1; pass <= passes && pending.length; pass++) {
    await funding.fundWallets({ provider, parent, signers: pending, config: cfg, execute, record, log, nonces });
    const still = [];
    for (const s of pending) {
      const [w, g] = await Promise.all([balOf(s.address), provider.getBalance(s.address)]);
      const gas = Number(ethers.formatEther(g));
      // 0.1% slack: the share is a float and the top-up rounds.
      if (w >= plan.perWallet * 0.999 && gas >= config.fundGasNative * 0.99) {
        await db.markWallet(epoch.id, s.idx, 'funded');
      } else {
        still.push(s);
      }
    }
    pending = still;
    if (pending.length && pass < passes) {
      log(`epoch ${epoch.id}: ${pending.length} wallet(s) not yet funded (${pending.map((s) => 'w' + pad2(s.idx)).join(' ')}) — retrying`);
      if (nonces) nonces.reset(parent);
      await sleep(retryDelayMs);
    }
  }
  if (pending.length) {
    log(`epoch ${epoch.id}: ${pending.length} wallet(s) still short after ${passes} passes — they will be retried on the next start`);
    return { ok: false, seeded: signers.length - pending.length, pending: pending.map((s) => s.idx) };
  }
  log(`epoch ${epoch.id}: all ${signers.length} wallet(s) seeded`);
  return { ok: true, seeded: signers.length };
}

// Drive the lifecycle until there is a live, funded epoch — or until told to
// stop. Used by the bot at start-up, so a restart after expiry rotates by itself
// and a freshly funded parent is noticed without anyone touching the server.
//
//   shouldStop()  checked between every wait, so the stop file and SIGTERM work
//                 while it is sweeping or waiting for funds.
async function ensureLiveEpoch({ config, provider, chainId, parent, tokenMeta, execute, log, nonces, recordFor,
                                 shouldStop = () => false, seedOpts = {}, backoffMs = 60000 }) {
  let backoff = backoffMs;
  const waitFor = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (shouldStop()) return false; await sleep(Math.min(5000, until - Date.now())); }
    return !shouldStop();
  };

  for (;;) {
    if (shouldStop()) return null;
    let epoch = await epochMod.current();

    // 1. nothing active: open a fresh roster (all previous ones are verified empty)
    if (!epoch) {
      if (!execute) { log('[DRY] no active epoch — would create one'); return null; }
      const res = await epochMod.createEpoch({ config, chainId, parentAddress: parent.address, log });
      log(`epoch ${res.epochId} created — ${config.walletCount} fresh wallets, expires in ${config.epochDays} day(s)`);
      continue;
    }

    // 2. expired or half-drained: empty it, prove it, retire it
    if (epoch.status === 'draining' || epochMod.isExpired(epoch)) {
      log(`epoch ${epoch.id} is ${epoch.status === 'draining' ? 'mid-sweep' : 'expired'} — rotating`);
      const r = await sweepAndVerify({ config, provider, epoch, parent, tokenMeta, execute, log, nonces, record: recordFor(epoch.id) });
      if (r.dryRun) return null;
      if (!r.ok) {
        log(`sweep of epoch ${epoch.id} incomplete — trying again in ${Math.round(backoff / 1000)}s`);
        if (!(await waitFor(backoff))) return null;
        backoff = Math.min(backoff * 2, 600000);
        continue;
      }
      await db.setEpochStatus(epoch.id, 'retired', 'rotated: verified empty');
      log(`epoch ${epoch.id} retired`);
      backoff = backoffMs;
      continue;
    }

    // 3. live epoch with unfunded wallets: seed it, or wait for the parent
    const s = await seedRoster({ config, provider, epoch, parent, tokenMeta, execute, log, nonces, record: recordFor(epoch.id), ...seedOpts });
    if (s.waitingForFunds) {
      log(`epoch ${epoch.id}: parent holds ${s.parentWl1x.toFixed(4)} WL1X — enough for ${s.perWallet.toFixed(4)}/wallet, ` +
        `but a tradeable roster needs ${s.target.toFixed(4)}. Send ~${s.shortfall.toFixed(2)} WL1X to ${parent.address}; ` +
        `re-checking every ${Math.round(config.fundPollMs / 60000)} min`);
      if (!(await waitFor(config.fundPollMs))) return null;
      continue;
    }
    if (s.dryRun) return epoch;
    if (!s.ok) {
      if (!(await waitFor(backoff))) return null;
      backoff = Math.min(backoff * 2, 600000);
      continue;
    }
    return epoch;
  }
}

module.exports = { bagValuer, leftovers, sweepAndVerify, seedTarget, planSeed, seedRoster, ensureLiveEpoch };
