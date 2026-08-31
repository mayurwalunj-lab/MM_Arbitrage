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
const { NonceManager, resolveAfterTimeout } = require('./nonces');

const argv = process.argv.slice(2);
const wantExecute = argv.includes('--execute');
const once = argv.includes('--once');
// One-off narrowing without editing .env:
//   --pool L1USD          only that pool (label or address, comma-separated)
//   --wallets 2           only the first 2 wallets of the roster
const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const cliPools = (flagVal('--pool') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const cliWallets = Number(flagVal('--wallets'));

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
  console.log(`  pools       : ${config.pools.length} from ${config.poolSource || 'env'} (${config.pools.map((p) => p.label).join(', ')})`);
  console.log(`  rate limit  : ${config.maxTxPerHour}/hr (hard cap ${cfgMod.HARD_TX_PER_HOUR_CAP})`);
  console.log(`  impact cap  : ${config.maxImpactBps} bps    price band: ±${config.maxDeviationPct}%`);
  console.log(`  stop file   : ${config.stopFile}`);
  if (config.storePlaintextKeys) console.log('  key storage : PLAINTEXT in MySQL (QVT_STORE_PLAINTEXT_KEYS=true)');
  if (!execute) {
    console.log('  --- not executing because ---');
    gate.reasons.forEach((r) => console.log(`      · ${r}`));
  }
  console.log(line);
}

// ---------------------------------------------------------------- main cycle
async function run() {
  const config = cfgMod.getConfig();

  // Connect and load pools from the database BEFORE validating. Pool definitions
  // live in qdex_volume_pools, so .env legitimately has none — validating first
  // would reject a perfectly good config for having "no pools".
  await db.init();
  const poolSrc = await cfgMod.hydratePools(config, db);

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

  if (poolSrc.error) log(`WARNING: could not read pools from the database (${poolSrc.error}) — using .env`);

  const epoch = await epochMod.current();
  if (!epoch) {
    console.error('No active epoch. Create one first:  npm run qdex:vol:epoch:new');
    process.exit(1);
  }

  config.poolSource = poolSrc.source;
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

  const fullRoster = await epochMod.loadSigners({ config, epochId: epoch.id, provider });
  const walletLimit = Number.isFinite(cliWallets) && cliWallets > 0 ? cliWallets : config.activeWallets;
  const wsel = guards.applyWalletLimit(fullRoster, walletLimit);
  const signers = wsel.signers;
  if (wsel.limited) log(`using ${signers.length} of ${fullRoster.length} wallets: ${signers.map((s) => 'w' + pad2(s.idx)).join(', ')}`);
  else if (walletLimit > 0 && walletLimit >= fullRoster.length) log(`QVT_ACTIVE_WALLETS=${walletLimit} >= roster size ${fullRoster.length} — using all of them`);
  const parent = config.parentPrivateKey ? walletsMod.parentSigner(config, provider) : null;
  const tokenMeta = await walletsMod.loadTokenMeta(provider, config);

  // Load every market once to seed anchors and TVL weights.
  const allMarkets = [];
  for (const p of config.pools) {
    try {
      const m = await poolsMod.loadMarket({ provider, poolCfg: p, config, tokenMeta });
      m.tvlWl1x = await poolTvlWl1x({ provider, market: m, config });
      allMarkets.push(m);
      log(`pool ${p.label.padEnd(8)} px=${poolsMod.price(m).toPrecision(6)} tvl=${m.tvlWl1x.toFixed(2)} WL1X ` +
        `maxBuy=${poolsMod.maxSizeAtImpact(m, config.maxImpactBps, 'buy').toFixed(4)} WL1X`);
    } catch (e) {
      log(`pool ${p.label}: FAILED to load (${String(e.shortMessage || e.message).slice(0, 90)}) — excluded`);
    }
  }
  if (!allMarkets.length) { console.error('No pools could be loaded.'); process.exit(1); }

  // ---- narrow to the focused pools, falling back loudly if nothing matches ----
  const focus = cliPools.length ? cliPools : config.focusPools;
  const sel = guards.applyPoolFocus(allMarkets, focus);
  const markets = sel.markets;
  if (sel.fellBack) {
    log(`WARNING: focus [${focus.join(', ')}] matched none of the loaded pools ` +
        `(${allMarkets.map((m) => m.cfg.label).join(', ')}) — falling back to ALL ${markets.length} pools.`);
  } else if (sel.focused) {
    log(`focused on ${markets.length} pool(s): ${markets.map((m) => m.cfg.label).join(', ')}`);
  }

  const anchors = new guards.AnchorBook(config);
  markets.forEach((m) => anchors.seedIfAbsent(m.address, poolsMod.price(m)));

  const limiter = new guards.RateLimiter(config.maxTxPerHour);
  const stop = new guards.StopController(config, log);
  stop.installSignalHandlers();
  // ONE nonce tracker for the whole run. The bot is single-threaded, so a
  // single instance safely covers every send from every wallet: approvals,
  // swaps, peer transfers and backstops alike.
  const nonces = new NonceManager();
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
  // A skip costs no rate budget and only a short sleep, so a fleet that cannot
  // trade at all spins as fast as the RPC allows. Observed in production: a
  // fragmentation deadlock produced 5.2 skips/second and ~260,000 rows before
  // anyone noticed. Count consecutive skips, back off, and eventually stop —
  // a bot that cannot trade should say so, not hammer the database.
  let consecutiveSkips = 0;
  // Back off geometrically while nothing can trade, and give up rather than
  // spin forever. Returns true when the caller should break out of the loop.
  const onSkip = async () => {
    consecutiveSkips++;
    if (config.maxConsecutiveSkips > 0 && consecutiveSkips >= config.maxConsecutiveSkips) {
      stop.trip(`${consecutiveSkips} consecutive skips — no wallet can trade. ` +
        'Likely inventory fragmentation: check `npm run qdex:vol:preflight` and consider ' +
        'lowering QVT_MIN_TRADE_WL1X, raising QVT_FUND_WL1X, or enabling fewer pools.');
      return true;
    }
    // 0.5s, 1s, 2s, 4s ... capped. A healthy run never reaches the longer waits.
    const backoff = Math.min(500 * Math.pow(2, Math.floor(consecutiveSkips / 5)), 30000);
    if (consecutiveSkips % 25 === 0) {
      log(`${consecutiveSkips} consecutive skips — backing off ${(backoff / 1000).toFixed(1)}s ` +
        `(stops at ${config.maxConsecutiveSkips || 'never'})`);
    }
    await sleep(backoff);
    return false;
  };

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
        if (await onSkip()) break;
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
          ? await funding.rebalanceWallet({ provider, recipient: snap, snapshots: others, signers, parent, config, execute, record: recordTransfer, log, nonces })
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
            reason: `cannot trade: WL1X surplus ${buyableSurplus.toFixed(4)} < minTrade ${config.minTradeWl1x}, no sellable bag, no donor` });
          log(`w${pad2(signer.idx)} SKIP  cannot trade either way and no donor available`);
          if (await onSkip()) break;
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
        if (await onSkip()) break;
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
        if (await onSkip()) break;
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
        if (await onSkip()) break;
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
      // Built lazily: executeSwap replaces q's analytic figures with the
      // simulated ones, so a string frozen beforehand reports the curve's
      // prediction rather than what the pool paid.
      const headline = () => `w${pad2(signer.idx)} ${market.cfg.label.padEnd(7)} ${side.toUpperCase().padEnd(4)} ` +
        `${q.amountInHuman.toPrecision(6)} ${q.tokenIn.symbol} -> ${q.amountOutHuman.toPrecision(6)} ${q.tokenOut.symbol} ` +
        `| ${q.priceBefore.toPrecision(6)}>${q.priceAfter.toPrecision(6)} ${(side === 'buy' ? '-' : '+')}${q.impactBps.toFixed(1)}bps` +
        `${q.effectiveCostBps != null ? ` cost ${q.effectiveCostBps.toFixed(0)}bps` : ''}`;

      if (!execute) {
        sim.applyTrade(signer.address, m.quote.address, side, q.amountInHuman, q.amountOutHuman);
        log(`${headline()} [DRY]`);
        await recordTrade({ ...row, status: 'executed', reason: `dry-run; ${sideReason}` });
        stop.recordSuccess(q.notionalWl1x);
      } else {
        // Write-ahead: the row exists BEFORE anything is broadcast, so a process
        // killed mid-flight still leaves a trace that reconcile can settle.
        // Without it, a kill -9 between broadcast and insert loses the trade
        // entirely — funds moved, nothing recorded, nothing to reconcile against.
        let walId = null;
        try {
          const receipt = await poolsMod.executeSwap({
            market: m, signer: signer.wallet, side, quote: q, config, log, nonces,
            onNonce: async ({ nonce }) => {
              walId = await db.insertTrade({ ...row, epochId: epoch.id, runId, isDryRun: false,
                status: 'broadcasting', nonce: Number(nonce), reason: sideReason });
            },
            onSent: async ({ hash }) => { if (walId) await db.updateTrade(walId, { txHash: hash }); }
          });
          log(`${headline()} | ${receipt?.hash || '(no hash)'}`);
          // executeSwap replaces q's analytic figures with what the simulation
          // actually returned. `row` was built before that, so the corrected
          // numbers have to be written back or the log records the curve's
          // prediction — inflating reported volume and mis-stating exec price.
          const done = { status: 'executed', txHash: receipt?.hash ?? null,
            blockNumber: receipt?.blockNumber != null ? Number(receipt.blockNumber) : null,
            gasUsed: receipt?.gasUsed != null ? receipt.gasUsed.toString() : null,
            amountOut: q.amountOutHuman, execPrice: q.execPrice,
            costBps: q.effectiveCostBps ?? null,
            notionalWl1x: q.notionalWl1x };
          if (walId) await db.updateTrade(walId, done);
          else await recordTrade({ ...row, ...done, reason: sideReason });
          stop.recordSuccess(q.notionalWl1x);
        } catch (e) {
          const msg = String(e.shortMessage || e.message).slice(0, 180);
          if (e.timedOut) {
            // The node never answered. Retrying blind could double-spend if the
            // transaction is merely slow, so resolve it from the nonce first and
            // only stop when the outcome is genuinely undecidable.
            log(`w${pad2(signer.idx)} ${market.cfg.label} TIMEOUT — ${msg}`);
            const res = config.timeoutRecovery && e.broadcastNonce != null
              ? await resolveAfterTimeout({ provider, address: signer.address, nonce: e.broadcastNonce,
                  hash: e.broadcastHash, attempts: config.timeoutRecheckAttempts,
                  delayMs: config.timeoutRecheckMs, log })
              : { outcome: 'unknown' };

            if (res.outcome === 'not-sent') {
              // Nothing was accepted: no nonce consumed, no funds moved. Record
              // it and carry on — one lost iteration, not a lost session.
              log(`w${pad2(signer.idx)} resolved: nonce ${e.broadcastNonce} never used, nothing sent — continuing`);
              const f = { status: 'failed', reason: `timed out, confirmed not sent: ${msg}`.slice(0, 250) };
              if (walId) await db.updateTrade(walId, f); else await recordTrade({ ...row, ...f });
              stop.recordFailure();
            } else if (res.outcome === 'landed') {
              const okOnChain = !res.receipt || Number(res.receipt.status) === 1;
              log(`w${pad2(signer.idx)} resolved: transaction DID land${res.receipt ? ` in block ${res.receipt.blockNumber}` : ' (hash unknown)'} — continuing`);
              const f = { status: okOnChain ? 'executed' : 'failed',
                txHash: e.broadcastHash ?? null,
                blockNumber: res.receipt?.blockNumber != null ? Number(res.receipt.blockNumber) : null,
                gasUsed: res.receipt?.gasUsed != null ? res.receipt.gasUsed.toString() : null,
                reason: `timed out but landed: ${msg}`.slice(0, 250) };
              if (walId) await db.updateTrade(walId, f); else await recordTrade({ ...row, ...f });
              if (okOnChain) stop.recordSuccess(q.notionalWl1x); else stop.recordFailure();
            } else {
              // Still undecidable after rechecking. This is the only case that
              // halts: continuing risks acting on a balance about to change.
              const f = { status: 'unconfirmed', txHash: e.broadcastHash ?? null, nonce: e.broadcastNonce ?? null,
                reason: `timed out, outcome undetermined: ${msg}`.slice(0, 250) };
              if (walId) await db.updateTrade(walId, f); else await recordTrade({ ...row, ...f });
              stop.trip('transaction outcome undetermined after timeout — run npm run qdex:vol:reconcile');
            }
          } else if (e.preflightRejected) {
            // Rejected by the simulation BEFORE anything was broadcast: nothing
            // was sent, no nonce consumed, no gas spent. A skip, not a failure.
            log(`w${pad2(signer.idx)} ${market.cfg.label} SKIP  ${msg}`);
            const f = { status: 'skipped', reason: msg };
            if (walId) await db.updateTrade(walId, f); else await recordTrade({ ...row, ...f });
          } else if (e.revertedOnChain) {
            // Mined and reverted: definite, nothing in flight, no reconcile
            // needed. Counts as a normal failure so the breaker can act on a
            // run of them, rather than halting the bot on the first one.
            log(`w${pad2(signer.idx)} ${market.cfg.label} REVERTED ${e.broadcastHash} — ${msg}`);
            const f = { status: 'failed', txHash: e.broadcastHash, blockNumber: e.blockNumber,
              gasUsed: e.gasUsed, reason: `reverted on chain: ${msg}`.slice(0, 250) };
            if (walId) await db.updateTrade(walId, f); else await recordTrade({ ...row, ...f });
            stop.recordFailure();
          } else if (e.unconfirmed && e.broadcastHash) {
            // Broadcast but unconfirmed: the swap may still be mined. Keep it as
            // `unconfirmed` WITH the hash so it can be reconciled, and stop —
            // continuing to trade this wallet risks acting on a stale balance.
            log(`w${pad2(signer.idx)} ${market.cfg.label} UNCONFIRMED ${e.broadcastHash} — ${msg}`);
            const f = { status: 'unconfirmed', txHash: e.broadcastHash,
              reason: `broadcast but unconfirmed (nonce ${e.broadcastNonce}): ${msg}`.slice(0, 250) };
            if (walId) await db.updateTrade(walId, f); else await recordTrade({ ...row, ...f });
            stop.trip(`unconfirmed transaction ${e.broadcastHash} — reconcile before resuming (npm run qdex:vol:reconcile)`);
          } else if (walId) {
            // The write-ahead row exists, so the nonce may already be consumed.
            // Never assume nothing happened — leave it for reconcile to settle.
            log(`w${pad2(signer.idx)} ${market.cfg.label} FAILED after write-ahead — ${msg}`);
            await db.updateTrade(walId, { status: 'unconfirmed', reason: `failed after broadcast point: ${msg}`.slice(0, 250) });
            stop.trip(`transaction outcome unknown (nonce recorded) — run npm run qdex:vol:reconcile`);
          } else {
            log(`w${pad2(signer.idx)} ${market.cfg.label} FAILED ${msg}`);
            await recordTrade({ ...row, status: 'failed', reason: msg });
            stop.recordFailure();
          }
        }
      }

      consecutiveSkips = 0;
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
