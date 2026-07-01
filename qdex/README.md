# QDex Market Making

Hold the **QDex (QuantumDex) WL1X/XUSD** pool price at a fixed target, on the
**L1X chain** (chainId 1066). QDex is a Uniswap-V3-style AMM.

## Two modes
- **Peg mode (`QDEX_XUSD_PEG`)** — hold **XUSD at a $ value** (e.g. $1). Since
  `XUSD = oracleWL1X / poolRatio`, XUSD = peg ⟺ `poolRatio = oracleWL1X / peg`.
  So the target pool ratio tracks the **live oracle** each tick.
- **Fixed mode (`QDEX_TARGET_PRICE`)** — hold **WL1X at a fixed XUSD price**.

## How it works
Each tick (`qdex/qdex_mm.js`):
1. Read the pool ratio on-chain (`slot0.sqrtPriceX96` = XUSD per WL1X).
2. Determine the target ratio: peg mode → `oracleWL1X / peg`; fixed mode → `QDEX_TARGET_PRICE`.
3. Circuit breaker (peg mode): if XUSD is > `QDEX_MAX_DEVIATION_PCT` off peg (or the
   oracle returns nothing), **skip** — don't burn inventory on a possible real
   de-peg / stale oracle.
4. Compare ratio to target ± `QDEX_BAND_PCT`. Above band → **sell WL1X** (ratio down /
   XUSD up); below → **buy WL1X** (ratio up / XUSD down); inside → nothing.
5. Size the swap (V3 single-range math) to restore the target, capped by `QDEX_MAX_TRADE_BASE`.
6. Live swaps use an oracle/pool-derived `amountOutMinimum` (slippage floor).
7. Dry-run by default; live only with `--execute` or `QDEX_EXECUTE=true`.

## Run
```bash
# PEG XUSD to $1 (dynamic oracle target):
QDEX_XUSD_PEG=1.0 npm run qdex:mm:once          # dry-run, one tick
QDEX_XUSD_PEG=1.0 npm run qdex:mm               # dry-run loop
# fixed WL1X target instead:
QDEX_TARGET_PRICE=8.70 npm run qdex:mm:once
# live (after the router caveat below):
QDEX_XUSD_PEG=1.0 QDEX_EXECUTE=true QDEX_MAX_TRADE_BASE=5 npm run qdex:mm
```

Verified (dry-run, live pool): `XUSD=$1.02719 → BUY 39.28 WL1X to bring XUSD → $1`;
oracle WL1X = $8.7139; circuit breaker halts when deviation exceeds the limit.

## On-chain details (verified live)
- Pool `0x35a4Ef191750f6f70a29e58AcC2886de33a16DbD` — **WL1X (token0) / XUSD (token1)**, both 18 dec, fee 0.3%
- Router `0xA3A2dfF9f43Edc2825AC4C2Ff1A2945e103a37eB`
- RPC `https://v2-mainnet-rpc.l1x.foundation`, explorer https://explorer.l1xapp.com

## Status
- ✅ Price read + peg/fixed target + band decision + V3 sizing — working, tested live (dry-run).
- ✅ Oracle integration (`getLatestPrice`, 8 dec) — WL1X = $8.7139; XUSD derived = $1.027.
- ✅ Circuit breaker (`QDEX_MAX_DEVIATION_PCT`) — halts on large deviation / missing oracle.
- ✅ Slippage floor — `executeSwap` sets `amountOutMinimum` from the pool price × (1 − slippage).
- ⚠️ `executeSwap` (live) is a standard V3 `exactInputSingle` but **NOT yet verified against
  QDex's router**. Before going live: confirm the router variant (deadline vs no-deadline
  struct — QDex router is v2) and test with a tiny `QDEX_MAX_TRADE_BASE`.
- TODO: record swaps to a DB table (e.g. `qdex_trades`) like the other venues.
