#!/usr/bin/env node

'use strict';

// Operator commands for the QDex volume test harness.
//
//   node qdex/volume/cli.js epoch                 show the active epoch + roster
//   node qdex/volume/cli.js epoch:new [--force]   generate 10 fresh wallets (offline)
//   node qdex/volume/cli.js fund      [--execute] parent -> sub-wallets (WL1X + gas)
//   node qdex/volume/cli.js sweep     [--execute] sub-wallets -> parent, IN KIND
//   node qdex/volume/cli.js rotate    [--execute] sweep -> retire -> new epoch -> distribute
//   node qdex/volume/cli.js consolidate [--execute] sell every token bag back to WL1X
//   node qdex/volume/cli.js export --epoch N --idx I    decrypt one private key
//   node qdex/volume/cli.js keygen-secret          print a fresh QVT_KEY_ENCRYPTION_KEY
//
// Everything that touches the chain is DRY-RUN unless --execute is passed AND
// the safety gate is open (chain + pools allow-listed, QVT_EXECUTE=true).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const lib = require('../lib');
const cfgMod = require('./config');
const db = require('./db');
const epochMod = require('./epoch');
const walletsMod = require('./wallets');
const funding = require('./funding');
const poolsMod = require('./pools');
const cryptoMod = require('./crypto');
const { NonceManager } = require('./nonces');

// ONE tracker per CLI invocation. fund, sweep and rotate all issue long runs of
// transactions from the parent; a tracker per wallet or per call would let the
// parent's nonces collide across them.
const nonces = new NonceManager();

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (f) => argv.includes(f);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function withChain(config) {
  const provider = lib.getProvider({ rpcUrl: config.rpcUrl, chainId: config.chainId });
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  const gate = cfgMod.executionGate(config, chainId);
  const execute = has('--execute') && gate.ok;
  if (has('--execute') && !gate.ok) {
    log('--execute requested but the safety gate is CLOSED — simulating instead:');
    gate.reasons.forEach((r) => console.log(`    · ${r}`));
  }
  return { provider, chainId, gate, execute };
}

const runId = `cli-${Date.now().toString(36)}`;
const mkRecord = (epochId, execute) => async (x) => {
  try { await db.insertTransfer({ ...x, epochId, runId, isDryRun: !execute }); }
  catch (e) { log(`WARN transfer not recorded: ${String(e.message).slice(0, 100)}`); }
};

async function cmdEpoch(config) {
  await db.init();
  const e = await epochMod.current();
  console.log('\n' + epochMod.summarise(e));
  if (!e) { console.log('  create one with:  npm run qdex:vol:epoch:new\n'); return; }
  console.log(`  parent   : ${e.parent_address || '(not recorded)'}`);
  console.log(`  chain    : ${e.chain_id}`);
  console.log(`  test tag : ${e.test_tag}`);
  console.log(`  created  : ${e.created_at}`);
  console.log(`  expires  : ${e.expires_at}${epochMod.isExpired(e) ? '   <-- EXPIRED, rotate now' : ''}`);
  const rows = await db.getWallets(e.id);
  console.log(`\n  roster (${rows.length}):`);
  rows.forEach((r) => console.log(`    w${String(r.idx).padStart(2, '0')}  ${r.address}` +
    `${r.funded_at ? '  funded' : ''}${r.swept_at ? '  swept' : ''}`));
  console.log('');
}

async function cmdEpochNew(config) {
  await db.init();
  const { provider, chainId } = await withChain(config);
  const parentAddress = config.parentPrivateKey ? walletsMod.parentSigner(config, provider).address : null;
  const res = await epochMod.createEpoch({ config, chainId, parentAddress, force: has('--force'), log });
  console.log('\n  NEW WALLET ROSTER — generated offline, zero gas, not yet known to the chain:\n');
  res.wallets.forEach((w) => console.log(`    w${String(w.idx).padStart(2, '0')}  ${w.address}`));
  console.log(`\n  keyfile : ${config.keyfile}  (mode 0600, gitignored)`);
  console.log(`  parent  : ${parentAddress || '(QVT_PARENT_PK not set)'}`);
  console.log('\n  BACK UP QVT_KEY_ENCRYPTION_KEY. Either that secret or the keyfile mnemonic');
  console.log('  can recover these keys; losing both loses any funds these wallets hold.\n');
  console.log('  Next:  npm run qdex:vol:preflight     then     npm run qdex:vol:fund\n');
}

async function cmdFund(config) {
  await db.init();
  const { provider, execute } = await withChain(config);
  const e = await epochMod.current();
  if (!e) throw new Error('no active epoch — run epoch:new first');
  const signers = await epochMod.loadSigners({ config, epochId: e.id, provider });
  const parent = walletsMod.parentSigner(config, provider);
  log(`funding ${signers.length} wallets from ${parent.address} — ${execute ? 'LIVE' : 'DRY-RUN'}`);
  await funding.fundWallets({ provider, parent, signers, config, execute, record: mkRecord(e.id, execute), log, nonces });
  if (execute) for (const s of signers) await db.markWallet(e.id, s.idx, 'funded');
  log('fund complete');
}

async function cmdSweep(config) {
  await db.init();
  const { provider, execute } = await withChain(config);
  const e = await epochMod.current();
  if (!e) throw new Error('no active epoch');
  const signers = await epochMod.loadSigners({ config, epochId: e.id, provider });
  const parent = walletsMod.parentSigner(config, provider);
  const tokenMeta = await walletsMod.loadTokenMeta(provider, config);
  const record = mkRecord(e.id, execute);

  // Only mutate state when actually sweeping. A dry run that marks the epoch
  // 'draining' leaves the bot refusing to trade until someone notices and
  // reverses it by hand — simulation must never change what is stored.
  if (execute) await db.setEpochStatus(e.id, 'draining', 'sweep started');
  log(`sweeping ${signers.length} wallets to ${parent.address} IN KIND (no swaps) — ${execute ? 'LIVE' : 'DRY-RUN'}`);
  for (const s of signers) {
    const snap = await walletsMod.snapshot({ provider, address: s.address, config, tokenMeta });
    const moved = await funding.sweepWallet({ provider, signer: s, parent, snapshot: snap, config, execute, record, log, nonces });
    if (execute) await db.markWallet(e.id, s.idx, 'swept', moved);
  }
  log('sweep complete');
  return e;
}

// Drain every wallet's token bags back to WL1X in one pass.
//
// This is the repair for fragmentation. When each wallet spreads buys over every
// pool, no single holding ever reaches minTrade, so nothing is sellable, the
// wallet can only buy, and once its WL1X surplus is gone it skips forever. The
// bot's in-loop consolidation only nibbles at this: it fires ONLY when a wallet
// is already stuck and sells ONLY the largest bag, after which the wallet is
// unstuck, resumes buying, and re-fragments. It never converges. This empties
// every bag at once so the fleet restarts from clean WL1X.
//
// It sells largest-first so an interrupted run still recovers most of the value,
// and it does NOT touch the epoch status — unlike `sweep`, nothing is being
// retired here; the wallets keep trading afterwards.
async function cmdConsolidate(config) {
  await db.init();
  const { provider, execute } = await withChain(config);
  const e = await epochMod.current();
  if (!e) throw new Error('no active epoch');
  const signers = await epochMod.loadSigners({ config, epochId: e.id, provider });
  const tokenMeta = await walletsMod.loadTokenMeta(provider, config);

  // Bags below --min are left alone: below some size the gas and fees cost more
  // than the bag is worth, and selling it destroys value rather than recovering
  // it. The cost ceiling is raised well above the normal trading cap for the
  // same reason the bot raises it — freeing stranded value is worth paying for.
  const minBag = Number(arg('--min', config.consolidateMinWl1x));
  const maxCost = Number(arg('--max-cost-bps', config.consolidateMaxCostBps));
  const delayMs = Number(arg('--delay-ms', 1500));
  config.maxCostBps = maxCost;

  const markets = [];
  for (const pc of config.pools) {
    try { markets.push(await poolsMod.loadMarket({ provider, poolCfg: pc, config, tokenMeta })); }
    catch (err) { log(`WARN pool ${pc.label} unreadable, skipped: ${String(err.message).slice(0, 70)}`); }
  }

  log(`consolidating ${signers.length} wallets across ${markets.length} pools — ${execute ? 'LIVE' : 'DRY-RUN'}`);
  log(`  selling every bag worth >= ${minBag} WL1X, cost ceiling ${maxCost}bps`);

  let sold = 0, skipped = 0, failed = 0, recovered = 0, dustLeft = 0;
  for (const s of signers) {
    const snap = await walletsMod.snapshot({ provider, address: s.address, config, tokenMeta });
    const bags = markets.map((mk) => {
      const t = snap.tokens[mk.cfg.token.toLowerCase()];
      const px = poolsMod.price(mk);
      return { mk, px, tokenHuman: t ? t.human : 0, valueWl1x: t && px > 0 ? t.human / px : 0 };
    }).filter((b) => b.valueWl1x > 0).sort((a, b) => b.valueWl1x - a.valueWl1x);

    const target = bags.filter((b) => b.valueWl1x >= minBag);
    const dust = bags.filter((b) => b.valueWl1x < minBag);
    dustLeft += dust.reduce((a, b) => a + b.valueWl1x, 0);
    log(`w${String(s.idx).padStart(2, '0')} ${snap.wl1x.toFixed(4)} WL1X, ${bags.length} bags — selling ${target.length}, leaving ${dust.length} as dust`);

    for (const b of target) {
      // Re-read the pool: earlier sells in this same run have moved its price.
      const mk = await poolsMod.loadMarket({ provider, poolCfg: b.mk.cfg, config, tokenMeta });
      const px = poolsMod.price(mk);
      if (!(px > 0)) { skipped++; continue; }
      // Shave a hair off so float rounding can never ask for more than the
      // wallet holds — that reverts, and the bag stays stranded.
      const sizeWl1x = (b.tokenHuman * 0.999) / px;
      const q = poolsMod.quote({ market: mk, side: 'sell', sizeWl1x, slippageBps: config.slippageBps });
      if (!q) { log(`     ${mk.cfg.label} unquotable, left in place`); skipped++; continue; }

      const row = { epochId: e.id, runId, isDryRun: !execute, walletIdx: s.idx, walletAddress: s.address,
        poolAddress: mk.address, poolLabel: mk.cfg.label, side: 'sell', priceBefore: px,
        reason: 'consolidation sweep: draining a fragmented holding' };
      if (!execute) {
        log(`     [DRY] ${mk.cfg.label} sell ${b.valueWl1x.toFixed(4)} WL1X-worth`);
        sold++; recovered += b.valueWl1x;
        continue;
      }
      try {
        const rc = await poolsMod.executeSwap({ market: mk, signer: s.wallet, side: 'sell', quote: q, config, log, nonces });
        await db.insertTrade({ ...row, status: 'executed', amountIn: q.amountInHuman, amountInSymbol: q.tokenIn.symbol,
          amountOut: q.amountOutHuman, amountOutSymbol: q.tokenOut.symbol, notionalWl1x: q.notionalWl1x,
          execPrice: q.execPrice, costBps: q.effectiveCostBps ?? null, txHash: rc?.hash ?? null,
          blockNumber: rc?.blockNumber != null ? Number(rc.blockNumber) : null });
        log(`     ${mk.cfg.label} sold ${b.valueWl1x.toFixed(4)} WL1X-worth  ${rc?.hash ?? ''}`);
        sold++; recovered += q.notionalWl1x || b.valueWl1x;
      } catch (err) {
        // A bag that cannot be sold is not fatal — the rest of the fleet still
        // needs draining, so record it and carry on.
        const why = String(err.shortMessage || err.message).slice(0, 120);
        await db.insertTrade({ ...row, status: err.preflightRejected ? 'skipped' : 'failed', reason: `consolidation sweep: ${why}` })
          .catch(() => {});
        log(`     ${mk.cfg.label} NOT sold: ${why}`);
        err.preflightRejected ? skipped++ : failed++;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  log('');
  log(`consolidation ${execute ? 'complete' : 'DRY-RUN complete — nothing was sent'}`);
  log(`  bags sold ${sold}   skipped ${skipped}   failed ${failed}`);
  log(`  WL1X recovered ~${recovered.toFixed(4)}   left as dust below ${minBag}: ~${dustLeft.toFixed(4)}`);
  if (!execute) log('  re-run with --execute to actually sell.');
}

async function cmdRotate(config) {
  const e = await cmdSweep(config);
  const { provider, chainId, execute } = await withChain(config);
  if (execute) {
    await db.setEpochStatus(e.id, 'retired', 'rotated');
    log(`epoch ${e.id} retired`);
  } else {
    log(`[DRY] would retire epoch ${e.id} — epoch status left untouched`);
  }

  const parent = walletsMod.parentSigner(config, provider);
  const res = await epochMod.createEpoch({ config, chainId, parentAddress: parent.address, force: true, log });
  const signers = await epochMod.loadSigners({ config, epochId: res.epochId, provider });
  const tokenMeta = await walletsMod.loadTokenMeta(provider, config);

  log(`distributing parent holdings across the new roster IN KIND — ${execute ? 'LIVE' : 'DRY-RUN'}`);
  await funding.distributeInKind({ provider, parent, signers, config, tokenMeta, execute, record: mkRecord(res.epochId, execute), log, nonces });
  if (execute) for (const s of signers) await db.markWallet(res.epochId, s.idx, 'funded');
  log(`rotation complete — epoch ${res.epochId} is now active`);
}

async function cmdExport() {
  await db.init();
  const epochId = Number(arg('--epoch'));
  const idx = Number(arg('--idx'));
  if (!Number.isFinite(epochId) || !Number.isFinite(idx)) throw new Error('usage: export --epoch N --idx I');
  const { address, privateKey } = await epochMod.exportKey({ epochId, idx });
  console.log(`\n  epoch ${epochId} wallet ${idx}`);
  console.log(`  address     : ${address}`);
  console.log(`  private key : ${privateKey}\n`);
}

// Resolve rows the bot broadcast but could not confirm. Each one is a
// transaction that may or may not have moved funds; leaving them unresolved
// means the trade log does not match the chain.
async function cmdReconcile(config) {
  await db.init();
  const { provider } = await withChain(config);
  const [rows] = await db.query(
    `SELECT id, tx_hash, nonce, wallet_address, pool_label, side, amount_in, amount_in_symbol
     FROM qdex_volume_trades WHERE status IN ('unconfirmed','broadcasting') ORDER BY id`);
  if (!rows.length) { console.log('\n  nothing to reconcile — no unresolved transactions\n'); return; }

  console.log(`\n  ${rows.length} unresolved transaction(s):\n`);
  let resolved = 0, stillPending = 0, needsReview = 0;
  for (const r of rows) {
    // No hash: the process died between recording intent and getting one back.
    // The nonce still settles it — if the wallet's transaction count has not
    // passed that nonce, the transaction was never mined and no funds moved.
    if (!r.tx_hash) {
      if (r.nonce == null || !r.wallet_address) {
        console.log(`  row ${r.id}  no hash and no nonce — cannot resolve automatically`);
        needsReview++; continue;
      }
      // This RPC errors (rather than returning 0) for an address it holds no
      // state for — which is exactly a wallet whose very first transaction
      // failed. Retry, then flag rather than guessing: reporting a wrong
      // "no funds moved" would be worse than asking for a look.
      let count = null;
      try {
        count = await lib.withRetry(() => provider.getTransactionCount(r.wallet_address, 'latest'),
          { attempts: 3, label: 'reconcile.nonce' });
      } catch (e) {
        console.log(`  row ${r.id}  CANNOT READ NONCE for ${r.wallet_address} — ${String(e.shortMessage || e.message).slice(0, 70)}`);
        console.log(`           if that address has no history at all, nothing was sent; verify on the explorer.`);
        needsReview++; continue;
      }
      if (count <= Number(r.nonce)) {
        await db.query(`UPDATE qdex_volume_trades SET status='failed', reason=CONCAT(COALESCE(reason,''),' | reconciled: nonce ',?,' never used, no funds moved') WHERE id=?`, [r.nonce, r.id]);
        console.log(`  row ${r.id}  NEVER SENT — wallet nonce is ${count}, this needed ${r.nonce}. No funds moved.`);
        resolved++;
      } else {
        console.log(`  row ${r.id}  NEEDS REVIEW — nonce ${r.nonce} was consumed by ${r.wallet_address}`);
        console.log(`           a transaction from that wallet at that nonce was mined, but no hash was recorded.`);
        console.log(`           check the wallet's history on the explorer, then set the row manually.`);
        needsReview++;
      }
      continue;
    }
    let rc = null;
    try { rc = await provider.getTransactionReceipt(r.tx_hash); }
    catch (e) { console.log(`  ${r.tx_hash}  RPC error: ${String(e.shortMessage || e.message).slice(0, 60)}`); continue; }

    if (!rc) {
      const tx = await provider.getTransaction(r.tx_hash).catch(() => null);
      if (tx) { console.log(`  ${r.tx_hash}  STILL PENDING in the mempool — re-run later`); stillPending++; }
      else {
        // Never mined and no longer known to the node: it was dropped, so no
        // funds moved. Safe to file as failed.
        await db.query(`UPDATE qdex_volume_trades SET status='failed', reason=CONCAT(COALESCE(reason,''),' | reconciled: dropped, never mined') WHERE id=?`, [r.id]);
        console.log(`  ${r.tx_hash}  DROPPED — never mined, recorded as failed`);
        resolved++;
      }
      continue;
    }
    const ok = rc.status === 1;
    await db.query(
      `UPDATE qdex_volume_trades SET status=?, block_number=?, gas_used=?, reason=CONCAT(COALESCE(reason,''),' | reconciled') WHERE id=?`,
      [ok ? 'executed' : 'failed', Number(rc.blockNumber), rc.gasUsed != null ? rc.gasUsed.toString() : null, r.id]);
    console.log(`  ${r.tx_hash}  ${ok ? 'CONFIRMED' : 'REVERTED'} in block ${rc.blockNumber}  (${r.pool_label} ${r.side} ${r.amount_in} ${r.amount_in_symbol})`);
    resolved++;
  }
  console.log(`\n  resolved ${resolved}, still pending ${stillPending}, needs manual review ${needsReview}`);
  if (!stillPending && !needsReview) console.log('  safe to resume:  npm run qdex:vol:resume\n');
  else if (stillPending) console.log('  re-run reconcile once the pending ones settle before resuming\n');
  else console.log('  resolve the flagged rows by hand before resuming\n');
}

// ---- pools: definitions live in the database, the allow-list stays in .env ----
async function cmdPools(config) {
  await db.init();
  const rows = await db.getPools({ includeDisabled: true });
  if (!rows.length) {
    console.log('\n  no pools in the database yet — import the .env definitions:');
    console.log('    npm run qdex:vol:pools:import\n');
    return;
  }
  const envFilter = new Set(config.allowedPools);
  console.log(`\n  ${rows.length} pool(s) in qdex_volume_pools\n`);
  console.log('  id  label      enabled  live     address                                      router');
  rows.forEach((r) => {
    console.log('  ' + String(r.id).padEnd(4) + String(r.label).padEnd(11) +
      (r.enabled ? 'yes' : 'NO ').padEnd(9) +
      (r.allow_live ? 'YES' : 'no ').padEnd(9) +
      r.address + '  ' + String(r.router_address).slice(0, 12) + '…');
  });
  console.log('\n  enabled  the bot may pick this pool');
  console.log('  live     real transactions are permitted on it  (pools:allow / pools:deny)');
  console.log('  Both must be true to trade it live. New pools are never live by default.');
  if (envFilter.size) {
    console.log(`\n  QVT_ALLOWED_POOLS is also set (${envFilter.size} address(es)) and applies as an`);
    console.log('  ADDITIONAL restriction on top of the database flag.');
  }
  console.log('');
}

// Copy the QVT_POOL_n_* definitions from .env into the table. Idempotent, so it
// can be re-run after editing .env without creating duplicates.
async function cmdPoolsImport(config) {
  await db.init();
  const fromEnv = config.pools;
  if (!fromEnv.length) throw new Error('no QVT_POOL_n_* entries in .env to import');
  for (const p of fromEnv) {
    await db.upsertPool({ label: p.label, address: p.address, token: p.token, router: p.router,
      weight: Number.isFinite(p.weight) ? p.weight : null,
      maxImpactBps: Number.isFinite(p.maxImpactBps) ? p.maxImpactBps : null,
      note: 'imported from .env' });
    log(`imported ${p.label}  ${p.address}`);
  }
  const rows = await db.getPools({ includeDisabled: true });
  console.log(`\n  ${rows.length} pool(s) now in the database.`);
  console.log('  The QVT_POOL_* block in .env is now redundant and can be deleted —');
  console.log('  it is only used as a fallback when the table is empty.\n');
}

async function cmdPoolAllow(config, allow) {
  await db.init();
  const target = argv[1];
  if (!target || target.startsWith('--')) throw new Error(`usage: pools:${allow ? 'allow' : 'deny'} <label|address>`);
  const n = await db.setPoolAllowLive(target, allow);
  if (!n) throw new Error(`no pool matching "${target}"`);
  log(`${target} ${allow ? 'AUTHORISED for live trading' : 'de-authorised — dry-run only'}`);
  if (allow) log('this permits real transactions on that pool; the bot must also have it enabled');
}

async function cmdPoolToggle(config, enabled) {
  await db.init();
  const target = argv[1];
  if (!target || target.startsWith('--')) throw new Error(`usage: pools:${enabled ? 'enable' : 'disable'} <label|address>`);
  const n = await db.setPoolEnabled(target, enabled);
  if (!n) throw new Error(`no pool matching "${target}"`);
  log(`${target} ${enabled ? 'enabled' : 'disabled'}`);
}

const COMMANDS = {
  epoch: cmdEpoch,
  reconcile: cmdReconcile,
  pools: cmdPools,
  'pools:import': cmdPoolsImport,
  'pools:enable': (c) => cmdPoolToggle(c, true),
  'pools:disable': (c) => cmdPoolToggle(c, false),
  'pools:allow': (c) => cmdPoolAllow(c, true),
  'pools:deny': (c) => cmdPoolAllow(c, false),
  'epoch:new': cmdEpochNew,
  fund: cmdFund,
  sweep: cmdSweep,
  rotate: cmdRotate,
  consolidate: cmdConsolidate,
  export: cmdExport,
  'keygen-secret': async () => {
    console.log('\n  Add this to .env as QVT_KEY_ENCRYPTION_KEY and back it up:\n');
    console.log('  QVT_KEY_ENCRYPTION_KEY=' + cryptoMod.newSecret() + '\n');
  }
};

(async () => {
  if (!cmd || !COMMANDS[cmd]) {
    console.log('\nusage: node qdex/volume/cli.js <command> [--execute] [--force]\n');
    Object.keys(COMMANDS).forEach((k) => console.log('  ' + k));
    console.log('  export --epoch N --idx I\n');
    process.exit(cmd ? 1 : 0);
  }
  const config = cfgMod.getConfig();
  if (cmd !== 'keygen-secret') {
    // pools:import must read the .env definitions, so it is the one command that
    // deliberately does NOT hydrate from the database first.
    if (cmd !== 'pools:import') {
      try { await db.init(); await cfgMod.hydratePools(config, db); } catch { /* .env fallback */ }
    }
    cfgMod.validateConfig(config);
  }
  await COMMANDS[cmd](config);
  await db.end().catch(() => {});
})().catch((e) => { console.error(`\nERROR: ${e.message}\n`); process.exit(1); });
