# QDex Market Making

Hold the **QDex (QuantumDex) WL1X/XUSD** pool price at a fixed target, on the
**L1X chain** (chainId 1066). QDex is a Uniswap-V3-style AMM.

## How it works
Each tick (`qdex/qdex_mm.js`):
1. Read the pool price on-chain (`slot0.sqrtPriceX96`) = XUSD per WL1X.
2. Compare to `QDEX_TARGET_PRICE` ± `QDEX_BAND_PCT`.
3. If price is **above** the band → **sell WL1X** into the pool (pushes price down).
   If **below** → **buy WL1X** (pushes price up). Inside the band → do nothing.
4. Size the swap (V3 single-range math) to bring price back to target, capped by
   `QDEX_MAX_TRADE_BASE`.
5. Dry-run by default; live swap only with `--execute` or `QDEX_EXECUTE=true`.

## Run
```bash
QDEX_TARGET_PRICE=8.50 npm run qdex:mm:once     # dry-run, one tick
QDEX_TARGET_PRICE=8.50 npm run qdex:mm          # dry-run loop
# live (after the caveats below are resolved):
QDEX_TARGET_PRICE=8.50 QDEX_EXECUTE=true npm run qdex:mm
```

## On-chain details (verified live)
- Pool `0x35a4Ef191750f6f70a29e58AcC2886de33a16DbD` — **WL1X (token0) / XUSD (token1)**, both 18 dec, fee 0.3%
- Router `0xA3A2dfF9f43Edc2825AC4C2Ff1A2945e103a37eB`
- RPC `https://v2-mainnet-rpc.l1x.foundation`, explorer https://explorer.l1xapp.com

## Status
- ✅ Price read + target/band decision + V3 sizing — working, tested against the live pool (dry-run).
- ⚠️ `executeSwap` (live) is implemented as a standard V3 `exactInputSingle` but is
  **NOT yet verified against QDex's router**. Before going live:
  1. Confirm the router variant (deadline vs no-deadline struct — QDex router is v2).
  2. Set a real `amountOutMinimum` from a quote (currently `0` = no slippage guard) —
     wire QDex's Quoter/oracle (`L1XOracleAddress 0xbF730f…a809`).
  3. Test with a tiny `QDEX_MAX_TRADE_BASE` first.
- TODO: record swaps to a DB table (e.g. `qdex_trades`) like the other venues.
