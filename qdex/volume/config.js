'use strict';

// Configuration for the QDex volume TEST harness. Everything is env-driven
// (QVT_* in .env) so the whole thing can be pointed at a staging/testnet
// deployment without touching code.
//
// Two deliberate design points:
//
//  1. ROUTER IS PER-POOL. QDex runs two factory deployments (0xE220..2B86A and
//     0xD565..ccea4) with a router each. A Uniswap-V3 SwapRouter derives pool
//     addresses via CREATE2 from its own immutable factory, so the router that
//     serves one factory's pools CANNOT swap on the other's. Each pool therefore
//     carries its own router address.
//
//  2. TRADE SIZE IS NOT A CONSTANT. Pool depth on QDex spans many orders of
//     magnitude, and the reported liquidity() does not predict tradeable size
//     (one pool reporting 28,000x more liquidity absorbs 40,000x less). So
//     QVT_MAX_IMPACT_BPS is the primary control and size is derived per pool at
//     quote time; the min/max WL1X settings are only outer clamps.

const { ethers } = require('ethers');

const HARD_TX_PER_HOUR_CAP = 100; // enforced in code, not just config

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envBool(name, fallback = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}
function envAddr(name) {
  const v = process.env[name];
  if (!v) return '';
  try { return ethers.getAddress(v.trim()); } catch { throw new Error(`${name} is not a valid address: ${v}`); }
}
function envList(name) {
  return String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Pools come from QVT_POOL_1_* .. QVT_POOL_N_*. Each needs an address, the
// non-WL1X token, and the router belonging to that pool's factory.
function loadPools() {
  const count = envNum('QVT_POOL_COUNT', 0);
  const pools = [];
  for (let i = 1; i <= count; i++) {
    const address = envAddr(`QVT_POOL_${i}_ADDRESS`);
    if (!address) continue;
    pools.push({
      index: i,
      address,
      token: envAddr(`QVT_POOL_${i}_TOKEN`),
      router: envAddr(`QVT_POOL_${i}_ROUTER`),
      label: process.env[`QVT_POOL_${i}_LABEL`] || `pool${i}`,
      // Optional per-pool overrides; fall back to the global values.
      maxImpactBps: envNum(`QVT_POOL_${i}_MAX_IMPACT_BPS`, NaN),
      weight: envNum(`QVT_POOL_${i}_WEIGHT`, NaN)
    });
  }
  return pools;
}

function getConfig() {
  return {
    // ---- network (shared with the peg MM so one RPC config serves both) ----
    rpcUrl: process.env.QVT_RPC_URL || process.env.QDEX_RPC_URL || '',
    chainId: envNum('QVT_CHAIN_ID', envNum('QDEX_CHAIN_ID', 0)),
    wl1x: envAddr('QVT_WL1X') || envAddr('QDEX_BASE_TOKEN'),
    oracleAddress: envAddr('QVT_ORACLE_ADDRESS') || envAddr('QDEX_ORACLE_ADDRESS'),

    // ---- safety gate: nothing executes unless the chain AND every pool are
    // explicitly allow-listed. Both blank => dry-run only, by construction. ----
    allowedChainIds: envList('QVT_ALLOWED_CHAIN_IDS').map(Number).filter(Number.isFinite),
    allowedPools: envList('QVT_ALLOWED_POOLS').map((a) => a.toLowerCase()),
    execute: envBool('QVT_EXECUTE', false),

    // ---- wallets ----
    parentPrivateKey: process.env.QVT_PARENT_PK || '',
    walletCount: Math.max(1, envNum('QVT_WALLET_COUNT', 10)),
    derivationPath: process.env.QVT_DERIVATION_PATH || "m/44'/60'/0'/0",
    keyfile: process.env.QVT_KEYFILE || require('path').join(__dirname, '.wallets.json'),
    encryptionKey: process.env.QVT_KEY_ENCRYPTION_KEY || '',

    // ---- epoch rotation ----
    epochDays: envNum('QVT_EPOCH_DAYS', 7),

    // ---- funding (WL1X is the cash leg; every pool is WL1X-paired) ----
    fundWl1xPerWallet: envNum('QVT_FUND_WL1X', 3),
    fundGasNative: envNum('QVT_FUND_GAS_NATIVE', 0.5),
    minGasNative: envNum('QVT_MIN_GAS_NATIVE', 0.05),
    walletFloorWl1x: envNum('QVT_WALLET_FLOOR_WL1X', 0.3),
    minTransferWl1x: envNum('QVT_MIN_TRANSFER_WL1X', 0.25),
    maxTransfersPerHour: envNum('QVT_MAX_TRANSFERS_PER_HOUR', 20),
    parentReservePct: envNum('QVT_PARENT_RESERVE_PCT', 10),

    // ---- sizing: impact cap is primary, WL1X bounds are outer clamps ----
    maxImpactBps: envNum('QVT_MAX_IMPACT_BPS', 25),
    minTradeWl1x: envNum('QVT_MIN_TRADE_WL1X', 0.05),
    maxTradeWl1x: envNum('QVT_MAX_TRADE_WL1X', 1.0),
    maxPoolFractionBps: envNum('QVT_MAX_POOL_FRACTION_BPS', 50),
    slippageBps: envNum('QVT_SLIPPAGE_BPS', 100),
    deadlineSeconds: envNum('QVT_DEADLINE_SECONDS', 600),

    // ---- price guard: keep each pool near where the session found it ----
    maxDeviationPct: envNum('QVT_MAX_DEVIATION_PCT', 0.75),
    anchorMode: (process.env.QVT_ANCHOR_MODE || 'session-start').toLowerCase(),
    inventoryTargetPct: envNum('QVT_INVENTORY_TARGET_PCT', 50),
    biasStrength: envNum('QVT_BIAS_STRENGTH', 0.7),

    // ---- rate limiting + pacing ----
    maxTxPerHour: Math.min(envNum('QVT_MAX_TX_PER_HOUR', 100), HARD_TX_PER_HOUR_CAP),
    minDelayMs: envNum('QVT_MIN_DELAY_MS', 20000),
    maxDelayMs: envNum('QVT_MAX_DELAY_MS', 60000),
    walletCooldownMs: envNum('QVT_WALLET_COOLDOWN_MS', 120000),
    poolWeighting: (process.env.QVT_POOL_WEIGHTING || 'sqrt').toLowerCase(),
    // Narrow the run to specific pools (labels or addresses) and/or the first N
    // wallets of the roster. If a focus is set but nothing matches — a typo, or a
    // pool that failed to load — the bot falls back to the full set rather than
    // silently doing nothing, and says so loudly.
    focusPools: envList('QVT_FOCUS_POOLS').map((s) => s.toLowerCase()),
    activeWallets: envNum('QVT_ACTIVE_WALLETS', 0),   // 0 = use the whole roster

    // ---- session budget + emergency stop ----
    maxSessionTx: envNum('QVT_MAX_SESSION_TX', 0),           // 0 = unlimited
    maxSessionNotionalWl1x: envNum('QVT_MAX_SESSION_NOTIONAL_WL1X', 0),
    maxRuntimeMin: envNum('QVT_MAX_RUNTIME_MIN', 0),
    maxConsecutiveFailures: envNum('QVT_MAX_CONSECUTIVE_FAILURES', 5),
    maxConsecutiveRpcErrors: envNum('QVT_MAX_CONSECUTIVE_RPC_ERRORS', 25),
    lockFile: process.env.QVT_LOCK_FILE || require('path').join(__dirname, '.LOCK'),
    stopFile: process.env.QVT_STOP_FILE || require('path').join(__dirname, '.STOP'),

    // ---- identification: this is test activity and is labelled as such ----
    testTag: process.env.QVT_TEST_TAG || 'QDEX-VOLUME-TEST',

    pools: loadPools()
  };
}

// Config errors that make the harness unrunnable at all (even dry-run).
function validateConfig(c) {
  const missing = [];
  if (!c.rpcUrl) missing.push('QVT_RPC_URL (or QDEX_RPC_URL)');
  if (!c.wl1x) missing.push('QVT_WL1X (or QDEX_BASE_TOKEN)');
  if (!c.pools.length) missing.push('QVT_POOL_COUNT + QVT_POOL_1_* (no pools configured)');
  c.pools.forEach((p) => {
    if (!p.token) missing.push(`QVT_POOL_${p.index}_TOKEN`);
    if (!p.router) missing.push(`QVT_POOL_${p.index}_ROUTER`);
  });
  if (c.minTradeWl1x > c.maxTradeWl1x) missing.push('QVT_MIN_TRADE_WL1X > QVT_MAX_TRADE_WL1X');
  if (c.minDelayMs > c.maxDelayMs) missing.push('QVT_MIN_DELAY_MS > QVT_MAX_DELAY_MS');
  if (missing.length) throw new Error('QVT config problem: ' + missing.join(', '));
}

// Can this config send real transactions? Returns { ok, reasons[] }. Callers
// must treat ok=false as "dry-run only" rather than erroring, so the harness
// stays fully usable for simulation on an un-allow-listed network.
function executionGate(c, liveChainId) {
  const reasons = [];
  if (!c.execute) reasons.push('QVT_EXECUTE is not true');
  if (!c.allowedChainIds.length) reasons.push('QVT_ALLOWED_CHAIN_IDS is empty — no network is approved for execution');
  else if (liveChainId != null && !c.allowedChainIds.includes(Number(liveChainId))) {
    reasons.push(`chain ${liveChainId} is not in QVT_ALLOWED_CHAIN_IDS (${c.allowedChainIds.join(',')})`);
  }
  if (!c.allowedPools.length) reasons.push('QVT_ALLOWED_POOLS is empty — no pool is approved for execution');
  else {
    const bad = c.pools.filter((p) => !c.allowedPools.includes(p.address.toLowerCase()));
    if (bad.length) reasons.push(`pools not allow-listed: ${bad.map((p) => p.label).join(', ')}`);
  }
  if (!c.encryptionKey) reasons.push('QVT_KEY_ENCRYPTION_KEY is not set');
  if (!c.parentPrivateKey) reasons.push('QVT_PARENT_PK is not set');
  return { ok: reasons.length === 0, reasons };
}

module.exports = { getConfig, validateConfig, executionGate, envNum, envBool, envAddr, envList, HARD_TX_PER_HOUR_CAP };
