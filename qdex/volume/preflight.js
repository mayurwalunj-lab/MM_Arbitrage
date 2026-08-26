#!/usr/bin/env node

'use strict';

// Read-only preflight for the QDex volume test harness. Sends no transactions.
//
//   node qdex/volume/preflight.js
//
// Checks, in order: config sanity, chain, the execution safety gate, the active
// epoch and its roster, parent funding, every sub-wallet's WL1X and gas, and
// each configured pool's price, TVL and actual tradeable size. Ends with a
// verdict on whether the harness could run live right now.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { ethers } = require('ethers');
const lib = require('../lib');
const cfgMod = require('./config');
const db = require('./db');
const epochMod = require('./epoch');
const walletsMod = require('./wallets');
const poolsMod = require('./pools');

const ok = (s) => `  [ok]   ${s}`;
const warn = (s) => `  [warn] ${s}`;
const bad = (s) => `  [FAIL] ${s}`;

(async () => {
  const problems = [];
  const config = cfgMod.getConfig();

  console.log('\n=== 1. configuration ===');
  try { cfgMod.validateConfig(config); console.log(ok(`${config.pools.length} pools, ${config.walletCount} wallets configured`)); }
  catch (e) { console.log(bad(e.message)); problems.push('config'); process.exitCode = 1; }

  console.log(ok(`sizing: impact cap ${config.maxImpactBps}bps, WL1X clamps ${config.minTradeWl1x}–${config.maxTradeWl1x}`));
  console.log(ok(`rate: ${config.maxTxPerHour}/hr, delay ${config.minDelayMs}–${config.maxDelayMs}ms, cooldown ${config.walletCooldownMs}ms`));
  if (config.storePlaintextKeys) {
    console.log(warn('QVT_STORE_PLAINTEXT_KEYS=true — private keys are stored UNENCRYPTED in MySQL'));
    console.log('         anyone with database access holds spendable keys for these wallets');
  } else {
    console.log(config.encryptionKey ? ok('QVT_KEY_ENCRYPTION_KEY is set (keys encrypted at rest)') : bad('QVT_KEY_ENCRYPTION_KEY is NOT set — wallet keys cannot be stored'));
  }

  console.log('\n=== 2. network ===');
  const provider = lib.getProvider({ rpcUrl: config.rpcUrl, chainId: config.chainId });
  let chainId = null;
  try {
    const net = await provider.getNetwork();
    chainId = Number(net.chainId);
    const head = await provider.getBlockNumber();
    console.log(ok(`chain ${chainId}, head block ${head}`));
  } catch (e) { console.log(bad(`RPC unreachable: ${String(e.shortMessage || e.message).slice(0, 90)}`)); problems.push('rpc'); }

  console.log('\n=== 3. execution safety gate ===');
  const gate = cfgMod.executionGate(config, chainId);
  if (gate.ok) console.log(warn('gate is OPEN — this configuration CAN send real transactions'));
  else { console.log(ok('gate is CLOSED — dry-run only')); gate.reasons.forEach((r) => console.log(`         · ${r}`)); }

  console.log('\n=== 4. epoch + roster ===');
  let epoch = null, signers = [];
  try {
    await db.init();
    epoch = await epochMod.current();
    if (!epoch) console.log(warn('no active epoch — create one:  npm run qdex:vol:epoch:new'));
    else {
      console.log(ok(epochMod.summarise(epoch)));
      if (epochMod.isExpired(epoch)) console.log(warn('epoch has EXPIRED — rotate before trading'));
      signers = await epochMod.loadSigners({ config, epochId: epoch.id, provider });
      console.log(ok(`${signers.length} signers loaded`));
    }
  } catch (e) { console.log(bad(`database/epoch: ${String(e.message).slice(0, 120)}`)); problems.push('db'); }

  const tokenMeta = await walletsMod.loadTokenMeta(provider, config).catch(() => ({}));

  console.log('\n=== 5. parent wallet ===');
  if (!config.parentPrivateKey) console.log(warn('QVT_PARENT_PK not set — funding and sweeping are unavailable'));
  else {
    try {
      const parent = walletsMod.parentSigner(config, provider);
      const snap = await walletsMod.snapshot({ provider, address: parent.address, config, tokenMeta });
      const needWl1x = config.fundWl1xPerWallet * config.walletCount;
      const needGas = config.fundGasNative * config.walletCount;
      console.log(ok(`${parent.address}`));
      console.log(`         WL1X ${snap.wl1x.toFixed(4)} (need ${needWl1x} to fund ${config.walletCount})   ` +
        `gas ${snap.native.toFixed(4)} L1X (need ${needGas})`);
      if (snap.wl1x < needWl1x) console.log(warn(`parent is short ${(needWl1x - snap.wl1x).toFixed(4)} WL1X for a full fund`));
      if (snap.native < needGas) console.log(warn(`parent is short ${(needGas - snap.native).toFixed(4)} L1X for gas`));
    } catch (e) { console.log(bad(`parent: ${String(e.message).slice(0, 100)}`)); }
  }

  console.log('\n=== 6. sub-wallets ===');
  if (!signers.length) console.log(warn('no roster to check'));
  for (const s of signers) {
    try {
      const snap = await walletsMod.snapshot({ provider, address: s.address, config, tokenMeta });
      const bags = Object.values(snap.tokens).filter((t) => t.human > 0).map((t) => `${t.human.toPrecision(4)} ${t.symbol}`);
      const flags = [];
      if (snap.wl1x < config.walletFloorWl1x) flags.push('BELOW WL1X FLOOR');
      if (snap.native < config.minGasNative) flags.push('LOW GAS');
      console.log(`  w${String(s.idx).padStart(2, '0')}  ${s.address}  ${snap.wl1x.toFixed(4)} WL1X  ` +
        `${snap.native.toFixed(4)} L1X${bags.length ? '  [' + bags.join(', ') + ']' : ''}${flags.length ? '  <-- ' + flags.join(', ') : ''}`);
    } catch (e) { console.log(bad(`w${s.idx}: ${String(e.message).slice(0, 80)}`)); }
  }

  console.log('\n=== 7. pools ===');
  console.log('  label      price          TVL (WL1X)   maxBuy    maxSell   router');
  let loaded = 0;
  for (const p of config.pools) {
    try {
      const m = await poolsMod.loadMarket({ provider, poolCfg: p, config, tokenMeta });
      const px = poolsMod.price(m);
      const erc = (a) => new ethers.Contract(a, walletsMod.ERC20_ABI, provider);
      const [wRaw, tRaw] = await Promise.all([erc(config.wl1x).balanceOf(m.address), erc(m.quote.address).balanceOf(m.address)]);
      const w = Number(ethers.formatUnits(wRaw, m.base.decimals));
      const t = Number(ethers.formatUnits(tRaw, m.quote.decimals));
      const tvl = w + (px > 0 ? t / px : 0);
      const mb = poolsMod.maxSizeAtImpact(m, config.maxImpactBps, 'buy');
      const ms = poolsMod.maxSizeAtImpact(m, config.maxImpactBps, 'sell');
      console.log(`  ${p.label.padEnd(9)} ${px.toPrecision(8).padStart(13)} ${tvl.toFixed(2).padStart(12)} ` +
        `${mb.toFixed(4).padStart(9)} ${ms.toFixed(4).padStart(9)}   ${p.router.slice(0, 10)}…`);
      if (mb < config.minTradeWl1x) console.log(warn(`  ${p.label}: cannot fit even the minimum ${config.minTradeWl1x} WL1X under the impact cap`));
      if (Number(m.liquidity) === 0) console.log(warn(`  ${p.label}: active liquidity is ZERO — price sits outside every LP range`));
      loaded++;
    } catch (e) { console.log(bad(`  ${p.label}: ${String(e.shortMessage || e.message).slice(0, 80)}`)); }
  }

  console.log('\n=== 8. sizing sanity ===');
  // The wallet float should comfortably outlast the inventory random walk, or
  // the fleet spends its time transferring instead of trading.
  const perHourPerWallet = config.maxTxPerHour / Math.max(1, config.walletCount);
  const avgSize = Math.sqrt(config.minTradeWl1x * config.maxTradeWl1x);
  const driftPerHour = Math.sqrt(perHourPerWallet) * avgSize;
  console.log(`  each wallet trades ~${perHourPerWallet.toFixed(1)}/hr, avg size ~${avgSize.toFixed(3)} WL1X`);
  console.log(`  expected inventory drift ~${driftPerHour.toFixed(3)} WL1X/hr against a ${config.fundWl1xPerWallet} WL1X float`);
  if (driftPerHour > config.fundWl1xPerWallet / 2) {
    console.log(warn('drift is large relative to the float — wallets will starve often; lower QVT_MAX_TRADE_WL1X or raise QVT_FUND_WL1X'));
  } else console.log(ok('float is comfortable for this trade size'));

  console.log('\n=== verdict ===');
  if (problems.length) console.log(`  NOT READY — unresolved: ${problems.join(', ')}`);
  else if (!loaded) console.log('  NOT READY — no pools could be loaded');
  else if (gate.ok) console.log('  READY — and the safety gate is OPEN. Live trades WILL be sent if you pass --execute.');
  else console.log('  READY for DRY-RUN. The safety gate is closed, so no transaction can be sent.');
  console.log('');

  await db.end().catch(() => {});
})().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(1); });
