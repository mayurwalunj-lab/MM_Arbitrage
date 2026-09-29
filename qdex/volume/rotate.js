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

// Sell a wallet's token bags back to WL1X. Used for a fragmented roster and for
// the PARENT, which accumulates tokens every rotation: the sweep is in kind, so
// a retired roster's positions arrive as tokens, and a WL1X-only distribution
// cannot hand them back out. Left alone they are dead weight — that is how
// epoch 16 ended up unseeded with 7.58 WL1X of the fleet's own value parked at
// the parent.
//
// Bags below minBagWl1x are left: under some size the fees exceed the bag.
async function consolidateWallet({ provider, signer, walletIdx, config, tokenMeta, execute, log, nonces,
                                  recordTrade = async () => {}, minBagWl1x, maxCostBps, delayMs = 1500,
                                  reason = 'consolidation: token bag back to WL1X' }) {
  const label = walletIdx === null || walletIdx === undefined ? 'parent' : 'w' + pad2(walletIdx);
  const out = { sold: 0, skipped: 0, failed: 0, recovered: 0, dustLeft: 0 };
  const snap = await walletsMod.snapshot({ provider, address: signer.address, config, tokenMeta });

  const bags = [];
  for (const pc of config.pools) {
    const t = snap.tokens[pc.token.toLowerCase()];
    if (!t || !(t.raw > 0n)) continue;
    let mk;
    try { mk = await poolsMod.loadMarket({ provider, poolCfg: pc, config, tokenMeta }); }
    catch { log(`WARN ${pc.label} unreadable — its bag is left in place`); out.skipped++; continue; }
    const px = poolsMod.price(mk);
    bags.push({ cfg: pc, tokenHuman: t.human, valueWl1x: px > 0 ? t.human / px : 0 });
  }
  bags.sort((a, b) => b.valueWl1x - a.valueWl1x);
  const target = bags.filter((b) => b.valueWl1x >= minBagWl1x);
  out.dustLeft = bags.filter((b) => b.valueWl1x < minBagWl1x).reduce((a, b) => a + b.valueWl1x, 0);
  if (!target.length) return out;

  log(`${label}: ${snap.wl1x.toFixed(4)} WL1X, ${bags.length} bags — selling ${target.length}, leaving ${bags.length - target.length} as dust`);
  // Freeing stranded value is worth paying more for than an ordinary trade, so
  // the consolidation ceiling replaces the normal cost cap for this run only.
  const cfg = { ...config, maxCostBps: maxCostBps };

  for (const b of target) {
    // Re-read: earlier sells in this same run have moved the price.
    let mk;
    try { mk = await poolsMod.loadMarket({ provider, poolCfg: b.cfg, config, tokenMeta }); }
    catch { out.skipped++; continue; }
    const px = poolsMod.price(mk);
    if (!(px > 0)) { out.skipped++; continue; }
    // 0.999: tokenHuman/px multiplied back by px lands ABOVE the real balance for
    // about half of all bags, and transferFrom then reverts. Leave headroom.
    const sizeWl1x = (b.tokenHuman * 0.999) / px;
    const q = poolsMod.quote({ market: mk, side: 'sell', sizeWl1x, slippageBps: config.slippageBps });
    if (!q) { log(`     ${b.cfg.label} unquotable, left in place`); out.skipped++; continue; }

    const row = { walletIdx: walletIdx ?? null, walletAddress: signer.address,
      poolAddress: mk.address, poolLabel: mk.cfg.label, side: 'sell', priceBefore: px, reason };
    if (!execute) {
      log(`     [DRY] ${b.cfg.label} sell ${b.valueWl1x.toFixed(4)} WL1X-worth`);
      out.sold++; out.recovered += b.valueWl1x;
      continue;
    }
    try {
      const rc = await poolsMod.executeSwap({ market: mk, signer, side: 'sell', quote: q, config: cfg, log, nonces });
      await recordTrade({ ...row, status: 'executed', amountIn: q.amountInHuman, amountInSymbol: q.tokenIn.symbol,
        amountOut: q.amountOutHuman, amountOutSymbol: q.tokenOut.symbol, notionalWl1x: q.notionalWl1x,
        execPrice: q.execPrice, costBps: q.effectiveCostBps ?? null, txHash: rc?.hash ?? null,
        blockNumber: rc?.blockNumber != null ? Number(rc.blockNumber) : null });
      log(`     ${b.cfg.label} sold ${b.valueWl1x.toFixed(4)} WL1X-worth  ${rc?.hash ?? ''}`);
      out.sold++; out.recovered += q.notionalWl1x || b.valueWl1x;
    } catch (err) {
      const why = String(err.shortMessage || err.message).slice(0, 120);
      await recordTrade({ ...row, status: err.preflightRejected ? 'skipped' : 'failed', reason: `${reason}: ${why}` }).catch(() => {});
      log(`     ${b.cfg.label} NOT sold: ${why}`);
      if (err.preflightRejected) out.skipped++; else out.failed++;
      if (nonces) nonces.reset(signer);
    }
    if (delayMs) await sleep(delayMs);
  }
  return out;
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
function planSeed({ parentWl1x, unfundedBalances, reservePct, target = 0 }) {
  const keep = 1 - (reservePct || 0) / 100;
  const n = unfundedBalances.length;
  if (!n) return { perWallet: 0, count: 0, needFromParent: 0 };
  const alreadyThere = unfundedBalances.reduce((a, b) => a + b, 0);
  const avail = parentWl1x * keep + alreadyThere;
  // Fund FEWER wallets properly rather than every wallet too thinly. Eight
  // wallets that can trade beat ten that cannot — and beat waiting, which is
  // what left epoch 16 idle for five days. Whatever is available is split across
  // the wallets that can be funded, so nothing sits back at the parent.
  let count = n;
  if (target > 0 && avail / n < target) count = Math.floor(avail / target);
  if (count < 1) return { perWallet: avail / n, count: 0, needFromParent: 0, avail };
  const perWallet = avail / count;
  const needFromParent = unfundedBalances.slice(0, count).reduce((a, b) => a + Math.max(0, perWallet - b), 0);
  return { perWallet, count, needFromParent, avail };
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
  const target = seedTarget(config);
  const plan = planSeed({ parentWl1x, unfundedBalances: balances, reservePct: config.parentReservePct, target });

  if (!plan.count) {
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

  const chosen = signers.slice(0, plan.count);
  log(`epoch ${epoch.id}: seeding ${chosen.length} of ${signers.length} unfunded wallet(s) to ` +
    `${plan.perWallet.toFixed(4)} WL1X + ${config.fundGasNative} L1X each — ${execute ? 'LIVE' : 'DRY-RUN'}`);
  if (chosen.length < signers.length) {
    log(`  the parent cannot give all ${signers.length} the ${target.toFixed(4)} a tradeable wallet needs, ` +
      `so ${signers.length - chosen.length} stay unfunded and will be seeded when there is more`);
  }
  if (!execute) return { ok: false, dryRun: true, perWallet: plan.perWallet, count: plan.count };

  // fundWallets tops up to config.fundWl1xPerWallet — point it at this roster's
  // share for the duration, without touching the caller's config.
  const cfg = { ...config, fundWl1xPerWallet: plan.perWallet };
  let pending = chosen;
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
    return { ok: false, seeded: chosen.length - pending.length, pending: pending.map((s) => s.idx) };
  }
  log(`epoch ${epoch.id}: all ${chosen.length} wallet(s) seeded`);
  return { ok: true, seeded: chosen.length, partial: signers.length - chosen.length };
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

  let parentRecycled = false;
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

    // 3. recycle the parent's token pile into WL1X before judging whether it can
    //    seed. These are the previous roster's positions, swept in kind; as
    //    tokens they cannot be distributed and are simply dead capital.
    if (execute && config.rotateConsolidateParent && !parentRecycled) {
      parentRecycled = true;
      const valueBag = await bagValuer({ provider, config, tokenMeta, log });
      const psnap = await walletsMod.snapshot({ provider, address: parent.address, config, tokenMeta });
      const tokenValue = Object.entries(psnap.tokens)
        .filter(([, t]) => t.raw > 0n)
        .reduce((a, [addr, t]) => { const v = valueBag(addr, t.human); return a + (Number.isFinite(v) ? v : 0); }, 0);
      if (tokenValue >= config.consolidateMinWl1x) {
        log(`parent holds ${tokenValue.toFixed(4)} WL1X of tokens from the last sweep — selling them back to WL1X`);
        const r = await consolidateWallet({
          provider, signer: parent, walletIdx: null, config, tokenMeta, execute, log, nonces,
          recordTrade: recordFor(epoch.id), minBagWl1x: config.consolidateMinWl1x,
          maxCostBps: config.consolidateMaxCostBps, reason: 'rotation: recycling parent tokens to WL1X'
        });
        log(`parent recycled: ${r.sold} sold, ${r.recovered.toFixed(4)} WL1X recovered, ${r.dustLeft.toFixed(4)} left as dust`);
        continue;   // re-evaluate seeding with the WL1X now available
      }
    }

    // 4. live epoch with unfunded wallets: seed it, or wait for the parent
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

module.exports = { bagValuer, leftovers, consolidateWallet, sweepAndVerify, seedTarget, planSeed, seedRoster, ensureLiveEpoch };
