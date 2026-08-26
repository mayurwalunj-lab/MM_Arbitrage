#!/usr/bin/env node

'use strict';

// QDEX VOLUME TEST HARNESS — generates randomised test trades across a
// configured set of WL1X-paired pools from a rotating roster of sub-wallets.
//
//   node qdex/volume/bot.js              dry-run loop (simulate, no transactions)
//   node qdex/volume/bot.js --once       one iteration
//   node qdex/volume/bot.js --execute    LIVE — also needs QVT_EXECUTE=true and
//                                        the chain + every pool allow-listed
//
// THIS IS TEST ACTIVITY AND IS LABELLED AS SUCH. Every database row carries
// is_test_activity=1, the epoch id and the run id; the wallet roster is recorded
// and documented; the parent wallet never rotates, so all of it traces to one
// address. The randomisation exists to cover a range of sizes, directions and
// pools — not to imitate organic user flow. There is no burst shaping, no
// session modelling and no attempt to make coordinated trades look independent.
//
// Safety posture: dry-run is the default and cannot be overridden by accident.
// Live execution requires ALL of: --execute (or QVT_EXECUTE=true), the live
// chain id in QVT_ALLOWED_CHAIN_IDS, every configured pool in QVT_ALLOWED_POOLS,
// QVT_PARENT_PK set, and QVT_KEY_ENCRYPTION_KEY set. Any missing piece degrades
// to simulation rather than erroring, so the harness stays usable for testing.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const fs = require('fs');
const { ethers } = require('ethers');
const lib = require('../lib');
const cfgMod = require('./config');
const db = require('./db');
const epochMod = require('./epoch');
const walletsMod = require('./wallets');
const poolsMod = require('./pools');
const funding = require('./funding');
const guards = require('./guards');

const argv = process.argv.slice(2);
const wantExecute = argv.includes('--execute');
const once = argv.includes('--once');

const ts = () => new Date().toISOString();
const log = (m) => console.log(`[${ts()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- simulation
// In dry-run nothing on chain changes, so a naive loop would re-read the same
// balances forever and never exercise the inventory bias or the rebalance path.
// This overlay applies simulated deltas on top of the real snapshot so a dry run
// behaves like a real one.
class SimLedger {
  constructor() { this.d = new Map(); }
  _for(addr) {
    const k = addr.toLowerCase();
    if (!this.d.has(k)) this.d.set(k, { wl1x: 0, tokens: {} });
    return this.d.get(k);
  }
  applyTrade(addr, tokenAddr, side, amountInHuman, amountOutHuman) {
    const e = this._for(addr);
    const t = tokenAddr.toLowerCase();
    e.tokens[t] = e.tokens[t] || 0;
    if (side === 'buy') { e.wl1x -= amountInHuman; e.tokens[t] += amountOutHuman; }
    else { e.tokens[t] -= amountInHuman; e.wl1x += amountOutHuman; }
  }
  applyWl1x(addr, delta) { this._for(addr).wl1x += delta; }
  // Dry runs are normally done BEFORE any wallet is funded, so every wallet
  // would otherwise fail the gas and floor checks and the trading path would
  // never be exercised at all. Seed the simulated fleet with what `fund` would
  // give it, so a dry run shows what a funded fleet would actually do.
  seedFunding(signers, config) {
    signers.forEach((s) => { this._for(s.address).wl1x += config.fundWl1xPerWallet; });
  }
  overlay(snapshot) {
    const e = this.d.get(snapshot.address.toLowerCase());
    if (!e) return snapshot;
    const out = { ...snapshot, wl1x: Math.max(0, snapshot.wl1x + e.wl1x), tokens: { ...snapshot.tokens } };
    for (const [t, dv] of Object.entries(e.tokens)) {
      const base = out.tokens[t] || { symbol: '?', decimals: 18, human: 0, raw: 0n };
      out.tokens[t] = { ...base, human: Math.max(0, (base.human || 0) + dv) };
    }
    return out;
  }
}

// --------------------------------------------------------------------- setup
async function poolTvlWl1x({ provider, market, config }) {
  // TVL in WL1X terms from real reserves. Used only to weight pool selection so
  // a $2M pool sees proportionally more traffic than a $26K one.
  const erc = (a) => new ethers.Contract(a, walletsMod.ERC20_ABI, provider);
  const [wRaw, tRaw] = await Promise.all([
    erc(config.wl1x).balanceOf(market.address),
    erc(market.quote.address).balanceOf(market.address)
  ]);
  const w = Number(ethers.formatUnits(wRaw, market.base.decimals));
  const t = Number(ethers.formatUnits(tRaw, market.quote.decimals));
  const px = poolsMod.price(market);
  return w + (px > 0 ? t / px : 0);
}

function banner({ config, chainId, gate, execute, epoch, runId }) {
  const line = '='.repeat(72);
  console.log(line);
  console.log('  QDEX VOLUME TEST HARNESS — generates TEST ACTIVITY, not organic flow');
  console.log(line);
  console.log(`  mode        : ${execute ? '*** LIVE — REAL TRANSACTIONS ***' : 'DRY-RUN (simulate only)'}`);
  console.log(`  run id      : ${runId}`);
  console.log(`  test tag    : ${config.testTag}`);
  console.log(`  chain       : ${chainId}`);
  console.log(`  ${epochMod.summarise(epoch)}`);
  console.log(`  pools       : ${config.pools.length} (${config.pools.map((p) => p.label).join(', ')})`);
  console.log(`  rate limit  : ${config.maxTxPerHour}/hr (hard cap ${cfgMod.HARD_TX_PER_HOUR_CAP})`);
  console.log(`  impact cap  : ${config.maxImpactBps} bps    price band: ±${config.maxDeviationPct}%`);
  console.log(`  stop file   : ${config.stopFile}`);
  if (!execute) {
    console.log('  --- not executing because ---');
    gate.reasons.forEach((r) => console.log(`      · ${r}`));
  }
  console.log(line);
}

// ---------------------------------------------------------------- main cycle
async function run() {
  const config = cfgMod.getConfig();
  try { cfgMod.validateConfig(config); }
  catch (e) { console.error(`CONFIG ERROR: ${e.message}`); process.exit(1); }

  const provider = lib.getProvider({ rpcUrl: config.rpcUrl, chainId: config.chainId });
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);

  const gate = cfgMod.executionGate(config, chainId);
  const execute = wantExecute && gate.ok;
  if (wantExecute && !gate.ok) {
    log('--execute requested but the safety gate is CLOSED — running as a dry-run instead.');
  }

  await db.init();

  const epoch = await epochMod.current();
  if (!epoch) {
    console.error('No active epoch. Create one first:  npm run qdex:vol:epoch:new');
    process.exit(1);
  }

  const runId = `${config.testTag}-e${epoch.id}-${Date.now().toString(36)}`;
  banner({ config, chainId, gate, execute, epoch, runId });

  // Clear a stale stop file so a previous emergency stop does not silently
  // prevent this run from starting — but say so loudly.
  if (fs.existsSync(config.stopFile)) {
    console.error(`\nRefusing to start: stop file exists at ${config.stopFile}\n  Remove it to resume:  rm ${config.stopFile}\n`);
    process.exit(1);
  }

  // Single-instance lock. Two bots on one epoch would draw the same nonce for the
  // same wallet: one transaction replaces the other, or both revert.
  const lock = guards.acquireLock(config.lockFile);
  if (!lock.ok) {
    console.error(`\nRefusing to start: another instance holds the lock — ${lock.reason}`);
    console.error(`  lock file: ${config.lockFile}\n  If you are certain nothing is running, delete it.\n`);
    process.exit(1);
  }
  const cleanup = () => guards.releaseLock(config.lockFile);
  process.on('exit', cleanup);

  const signers = await epochMod.loadSigners({ config, epochId: epoch.id, provider });
  const parent = config.parentPrivateKey ? walletsMod.parentSigner(config, provider) : null;
  const tokenMeta = await walletsMod.loadTokenMeta(provider, config);

  // Load every market once to seed anchors and TVL weights.
  const markets = [];
  for (const p of config.pools) {
    try {
      const m = await poolsMod.loadMarket({ provider, poolCfg: p, config, tokenMeta });
      m.tvlWl1x = await poolTvlWl1x({ provider, market: m, config });
      markets.push(m);
      log(`pool ${p.label.padEnd(8)} px=${poolsMod.price(m).toPrecision(6)} tvl=${m.tvlWl1x.toFixed(2)} WL1X ` +
        `maxBuy=${poolsMod.maxSizeAtImpact(m, config.maxImpactBps, 'buy').toFixed(4)} WL1X`);
    } catch (e) {
      log(`pool ${p.label}: FAILED to load (${String(e.shortMessage || e.message).slice(0, 90)}) — excluded`);
    }
  }
  if (!markets.length) { console.error('No pools could be loaded.'); process.exit(1); }

  const anchors = new guards.AnchorBook(config);
  markets.forEach((m) => anchors.seedIfAbsent(m.address, poolsMod.price(m)));

  const limiter = new guards.RateLimiter(config.maxTxPerHour);
  const stop = new guards.StopController(config, log);
  stop.installSignalHandlers();
  const sim = new SimLedger();
  // Dry-run against an unfunded roster: assume the fleet has been funded so the
  // run demonstrates real behaviour instead of ten identical "out of gas" skips.
  // --no-assume-funded shows the true unfunded state instead.
  const assumeFunded = !execute && !argv.includes('--no-assume-funded');
  if (assumeFunded) {
    sim.seedFunding(signers, config);
    log(`dry-run: assuming each wallet holds ${config.fundWl1xPerWallet} WL1X and ${config.fundGasNative} L1X gas (--no-assume-funded to use real balances)`);
  }
  const lastTraded = new Map();   // wallet address -> ms
  let cursor = 0;                 // round-robin base, jittered per pick

  const recordTrade = async (t) => {
    try { await db.insertTrade({ ...t, epochId: epoch.id, runId, isDryRun: !execute }); }
    catch (e) { log(`WARN trade not recorded: ${String(e.message).slice(0, 100)}`); }
  };
  const recordTransfer = async (x) => {
    try { await db.insertTransfer({ ...x, epochId: epoch.id, runId, isDryRun: !execute }); }
    catch (e) { log(`WARN transfer not recorded: ${String(e.message).slice(0, 100)}`); }
  };

  let iterations = 0;
  while (!stop.shouldStop()) {
    iterations++;

    // ---- epoch expiry: drain rather than trading past the rotation point ----
    const fresh = await epochMod.current();
    if (epochMod.isExpired(fresh)) {
      log(`epoch ${fresh.id} has expired — stopping. Rotate with:  npm run qdex:vol:epoch:rotate`);
      stop.trip('epoch expired');
      break;
    }

    // ---- rate limit ----
    const wait = limiter.waitMs();
    if (wait > 0) {
      log(`rate limit — ${limiter.countLastHour()}/${config.maxTxPerHour} in the last hour, waiting ${Math.ceil(wait / 1000)}s`);
      await sleep(Math.min(wait, 30000));
      continue;
    }

    // ---- pick a wallet first: the side depends on what it is holding ----
    let signer = null;
    for (let k = 0; k < signers.length; k++) {
      const cand = signers[(cursor + k) % signers.length];
      const last = lastTraded.get(cand.address) || 0;
      if (Date.now() - last >= config.walletCooldownMs) { signer = cand; cursor = (cursor + k + 1) % signers.length; break; }
    }
    if (!signer) {
      log(`all ${signers.length} wallets are in cooldown — waiting`);
      await sleep(Math.min(config.walletCooldownMs / 4, 15000));
      continue;
    }

    let base = { walletIdx: signer.idx, walletAddress: signer.address };

    try {
      // ---- balances (+ simulated deltas when dry-running) ----
      const realSnap = await walletsMod.snapshot({ provider, address: signer.address, config, tokenMeta });
      const snap = execute ? realSnap : sim.overlay(realSnap);

      // ---- portfolio-level inventory, valued in WL1X across EVERY pool ----
      // Deciding the side from a single pool's holding is wrong when a wallet
      // spreads its buys over ten pools: no individual holding ever grows large
      // enough to flip the bias, so the wallet buys forever. Value the whole
      // portfolio instead, then pick a pool that can serve the chosen side.
      const holdings = markets.map((mk) => {
        const t = snap.tokens[mk.quote.address.toLowerCase()];
        const p = mk.lastPrice || poolsMod.price(mk);
        return { market: mk, tokenHuman: t ? t.human : 0, valueWl1x: t && p > 0 ? t.human / p : 0 };
      });
      const tokenValueTotal = holdings.reduce((a, h) => a + h.valueWl1x, 0);

      // ---- pick a pool that can actually serve the wallet's needed side ----
      const wantSell = guards.chooseSide({
        wl1xValue: snap.wl1x, tokenValue: tokenValueTotal, deviationPct: 0, config
      }).side === 'sell';
      const sellable = holdings.filter((h) => h.valueWl1x >= config.minTradeWl1x);
      const candidates = wantSell && sellable.length ? sellable.map((h) => h.market) : markets;
      // Weighting choice matters more than it looks: TVL here spans ~40x, so
      // straight TVL weighting starves the small pools of traffic entirely.
      // 'sqrt' keeps the ordering but compresses the ratio; 'uniform' ignores
      // depth altogether (the per-pool impact cap still keeps sizes safe).
      const weightOf = (mk) => {
        if (mk.cfg.weight) return mk.cfg.weight;
        if (config.poolWeighting === 'sqrt') return Math.sqrt(mk.tvlWl1x);
        return mk.tvlWl1x;
      };
      const market = config.poolWeighting === 'uniform'
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : guards.weightedPick(candidates, weightOf);
      base = { ...base, poolAddress: market.address, poolLabel: market.cfg.label };

      // ---- refresh that pool's state (needed for the quote anyway) ----
      const m = await poolsMod.loadMarket({ provider, poolCfg: market.cfg, config, tokenMeta });
      const px = poolsMod.price(m);
      market.lastPrice = px;
      const anchor = anchors.seedIfAbsent(m.address, px);
      const devPct = anchors.deviationPct(m.address, px);

      // ---- gas check (real balances only; simulated fleets are assumed fuelled) ----
      if (!assumeFunded && realSnap.native < config.minGasNative) {
        await recordTrade({ ...base, status: 'skipped', priceBefore: px, anchorPrice: anchor, deviationPct: devPct,
          reason: `native gas ${realSnap.native.toFixed(6)} below QVT_MIN_GAS_NATIVE ${config.minGasNative}` });
        log(`w${pad2(signer.idx)} SKIP  out of gas (${realSnap.native.toFixed(6)} L1X)`);
        await sleep(1000);
        continue;
      }

      // ---- WL1X floor: peer transfer, else parent backstop ----
      if (snap.wl1x < config.walletFloorWl1x) {
        const others = [];
        for (const s of signers) {
          if (s.address === signer.address) continue;
          const rs = await walletsMod.snapshot({ provider, address: s.address, config, tokenMeta });
          others.push(execute ? rs : sim.overlay(rs));
        }
        const moved = parent
          ? await funding.rebalanceWallet({ provider, recipient: snap, snapshots: others, signers, parent, config, execute, record: recordTransfer, log })
          : null;
        if (moved && !execute) {
          sim.applyWl1x(signer.address, moved.amount);
          if (moved.kind === 'peer') {
            const donor = funding.chooseDonor(others, snap.address, config);
            if (donor) sim.applyWl1x(donor.s.address, -moved.amount);
          }
        }
        if (!moved) {
          await recordTrade({ ...base, status: 'skipped', priceBefore: px, anchorPrice: anchor, deviationPct: devPct,
            reason: `WL1X ${snap.wl1x.toFixed(4)} below floor ${config.walletFloorWl1x} and no donor available` });
          log(`w${pad2(signer.idx)} SKIP  below WL1X floor, no donor`);
          await sleep(1000);
          continue;
        }
      }

      // ---- side: this pool's price band first, then portfolio inventory ----
      const tokenBal = snap.tokens[m.quote.address.toLowerCase()];
      const tokenHuman = tokenBal ? tokenBal.human : 0;
      const tokenInWl1x = px > 0 ? tokenHuman / px : 0;
      const { side, reason: sideReason } = guards.chooseSide({
        wl1xValue: snap.wl1x, tokenValue: tokenValueTotal, deviationPct: devPct, config
      });

      // ---- can this wallet actually fund that side? ----
      if (side === 'sell' && tokenInWl1x < config.minTradeWl1x) {
        await recordTrade({ ...base, status: 'skipped', side, priceBefore: px, anchorPrice: anchor, deviationPct: devPct,
          reason: `no ${m.quote.symbol} inventory for SELL (${tokenHuman.toPrecision(4)})` });
        log(`w${pad2(signer.idx)} ${market.cfg.label} SKIP  no ${m.quote.symbol} inventory for SELL`);
        await sleep(500);
        continue;
      }

      // ---- size: impact cap is the real constraint, WL1X bounds are clamps ----
      const capBps = Number.isFinite(m.cfg.maxImpactBps) ? m.cfg.maxImpactBps : config.maxImpactBps;
      const poolMax = poolsMod.maxSizeAtImpact(m, capBps, side);
      const fractionMax = poolsMod.maxSizeAtImpact(m, config.maxPoolFractionBps, side);
      const inventoryMax = side === 'buy' ? snap.wl1x - config.walletFloorWl1x : tokenInWl1x;
      const upper = Math.min(config.maxTradeWl1x, poolMax, fractionMax, inventoryMax);

      if (!(upper >= config.minTradeWl1x)) {
        await recordTrade({ ...base, status: 'skipped', side, priceBefore: px, anchorPrice: anchor, deviationPct: devPct,
          reason: `no size fits: poolMax=${poolMax.toFixed(4)} fracMax=${fractionMax.toFixed(4)} invMax=${inventoryMax.toFixed(4)} min=${config.minTradeWl1x}` });
        log(`w${pad2(signer.idx)} ${market.cfg.label} SKIP  no feasible size (pool caps at ${poolMax.toFixed(4)} WL1X)`);
        await sleep(500);
        continue;
      }

      const wanted = guards.logUniform(config.minTradeWl1x, upper);
      const fit = poolsMod.quoteWithinImpact({
        market: m, side, sizeWl1x: wanted, maxImpactBps: capBps,
        minWl1x: config.minTradeWl1x, slippageBps: config.slippageBps
      });
      if (!fit) {
        await recordTrade({ ...base, status: 'skipped', side, priceBefore: px, anchorPrice: anchor, deviationPct: devPct,
          reason: `even ${config.minTradeWl1x} WL1X exceeds the ${capBps}bps impact cap` });
        log(`w${pad2(signer.idx)} ${market.cfg.label} SKIP  minimum size still over the ${capBps}bps cap`);
        await sleep(500);
        continue;
      }
      if (fit.shrunkFrom) {
        log(`w${pad2(signer.idx)} ${market.cfg.label} shrink ${fit.shrunkFrom.toFixed(4)}->${fit.quote.sizeWl1x.toFixed(4)} (impact cap ${capBps}bps)`);
      }
      const q = fit.quote;

      const row = {
        ...base, side,
        amountIn: q.amountInHuman, amountInSymbol: q.tokenIn.symbol,
        amountOut: q.amountOutHuman, amountOutSymbol: q.tokenOut.symbol,
        notionalWl1x: q.notionalWl1x, execPrice: q.execPrice,
        priceBefore: q.priceBefore, priceAfter: q.priceAfter, impactBps: q.impactBps,
        anchorPrice: anchor, deviationPct: devPct, minOut: q.minOutHuman
      };
      const headline = `w${pad2(signer.idx)} ${market.cfg.label.padEnd(7)} ${side.toUpperCase().padEnd(4)} ` +
        `${q.amountInHuman.toPrecision(6)} ${q.tokenIn.symbol} -> ${q.amountOutHuman.toPrecision(6)} ${q.tokenOut.symbol} ` +
        `| ${q.priceBefore.toPrecision(6)}>${q.priceAfter.toPrecision(6)} ${(side === 'buy' ? '-' : '+')}${q.impactBps.toFixed(1)}bps`;

      if (!execute) {
        sim.applyTrade(signer.address, m.quote.address, side, q.amountInHuman, q.amountOutHuman);
        log(`${headline} [DRY]`);
        await recordTrade({ ...row, status: 'executed', reason: `dry-run; ${sideReason}` });
        stop.recordSuccess(q.notionalWl1x);
      } else {
        try {
          const receipt = await poolsMod.executeSwap({ market: m, signer: signer.wallet, side, quote: q, config, log });
          log(`${headline} | ${receipt?.hash || '(no hash)'}`);
          await recordTrade({ ...row, status: 'executed', txHash: receipt?.hash ?? null,
            blockNumber: receipt?.blockNumber != null ? Number(receipt.blockNumber) : null,
            gasUsed: receipt?.gasUsed != null ? receipt.gasUsed.toString() : null, reason: sideReason });
          stop.recordSuccess(q.notionalWl1x);
        } catch (e) {
          const msg = String(e.shortMessage || e.message).slice(0, 180);
          if (e.unconfirmed && e.broadcastHash) {
            // Broadcast but unconfirmed: the swap may still be mined. Record it
            // as `unconfirmed` WITH the hash so it can be reconciled, and stop —
            // continuing to trade this wallet risks acting on a stale balance.
            log(`w${pad2(signer.idx)} ${market.cfg.label} UNCONFIRMED ${e.broadcastHash} — ${msg}`);
            await recordTrade({ ...row, status: 'unconfirmed', txHash: e.broadcastHash,
              reason: `broadcast but unconfirmed (nonce ${e.broadcastNonce}): ${msg}` });
            stop.trip(`unconfirmed transaction ${e.broadcastHash} — reconcile before resuming (npm run qdex:vol:reconcile)`);
          } else {
            log(`w${pad2(signer.idx)} ${market.cfg.label} FAILED ${msg}`);
            await recordTrade({ ...row, status: 'failed', reason: msg });
            stop.recordFailure();
          }
        }
      }

      limiter.record();
      lastTraded.set(signer.address, Date.now());
      // Keep the weighting current — liquidity moves as LPs add and pull.
      market.tvlWl1x = await poolTvlWl1x({ provider, market: m, config }).catch(() => market.tvlWl1x);
    } catch (e) {
      const msg = String(e.shortMessage || e.message).slice(0, 200);
      log(`iteration error: ${msg}`);
      await recordTrade({ ...base, status: 'failed', reason: msg });
      if (lib.isTransientRpcError(e)) {
        stop.recordRpcError();
        // Back off so a dead endpoint is not hammered while the streak builds.
        await sleep(Math.min(2000 * stop.consecutiveRpcErrors, 30000));
      } else {
        stop.recordFailure();
      }
    }

    if (once) break;
    const delay = Math.round(guards.randBetween(config.minDelayMs, config.maxDelayMs));
    await sleep(delay);
  }

  stop.removeSignalHandlers();
  log(`stopped after ${iterations} iterations — ${stop.txCount} trades, ${stop.notionalWl1x.toFixed(4)} WL1X notional` +
    (stop.reason ? ` | reason: ${stop.reason}` : ''));
  guards.releaseLock(config.lockFile);
  await db.end().catch(() => {});
}

// A transient RPC 502 surfacing as an unhandled rejection would otherwise exit
// the process (Node >= 15). Same guard the peg MM uses.
function installCrashGuards() {
  process.on('unhandledRejection', (e) => {
    if (lib.isTransientRpcError(e)) { log(`ignored transient RPC error: ${String(e && (e.shortMessage || e.message)).slice(0, 100)}`); return; }
    log(`unhandledRejection: ${String(e && (e.stack || e.message || e)).slice(0, 200)}`);
  });
  process.on('uncaughtException', (e) => {
    if (lib.isTransientRpcError(e)) { log(`ignored transient RPC error: ${String(e && (e.shortMessage || e.message)).slice(0, 100)}`); return; }
    log(`uncaughtException: ${String(e && (e.stack || e.message || e)).slice(0, 200)}`);
  });
}

installCrashGuards();
run().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(1); });
