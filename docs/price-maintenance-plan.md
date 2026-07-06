# CEX ↔ DEX Dynamic Price Maintenance — Build Plan

Make the CEX (Bitmart + LBank) L1X price **follow the DEX price** instead of
sitting in a fixed box, so the two venues stay aligned. The DEX is the
price-discovery source; the CEX bots track it gradually; the treasury catches
big fast spikes. Tight safety controls throughout.

---

## 1. Current state (verified from code)

- **Volume / pattern bots** (`bitmart/Bitmart_Pattern_Trading.js`,
  `lbank/Lbank_Pattern_Trading.js`): self-trade to set the price **inside a
  FIXED box** `hardFloorPrice=8.47` … `hardResistancePrice=8.53`. This box never
  moves. **They have zero DEX awareness.** These bots are what actually *move*
  the last-trade price.
- **Grid managers** (`bitmart/grid_manager_bitmart.js`,
  `lbank/LBank_GridManager.js`): place buy/sell orders at **hardcoded ABSOLUTE
  price ranges** (sells ~$8.53–8.585, buys ~$8.41–8.47). Refresh every 10 min
  (`refreshIntervalSeconds: 600`). The logged `Center: $X` is just the current
  market price for reference — it is **NOT** used to move the orders. So the grid
  does **not** move either.
- **Inner spread today:** highest buy **$8.47** / lowest sell **$8.53** =
  **$0.06 (~0.71%)**. The volume bot trades in that empty gap.
- **Treasury** (`arb/treasury_sell.js`, `arb/treasury_monitor.js`): sells L1X on
  the Uniswap DEX when DEX price ≥ CEX by `TREASURY_MIN_PREMIUM_PCT`. Works, live.
- **DEX price source:** `uniswap/lib.js` — `poolL1xUsdPrice(sqrtPriceX96,…)` ×
  `resolveEthUsdPrice()` (reads the L1X/WETH Uniswap pool on Ethereum).

**Why the price is stuck at ~$8.50:** both the volume box and the grid are pinned
to fixed absolute prices. Nothing follows the market.

---

## 2. The design — one shared engine, three consumers

A single **band engine** computes the target center from the DEX price; the
volume bot, the grid, and (indirectly) the treasury all use it, so they never
fight each other.

### Part A — Shared Band Engine (new: `shared/price_band.js`)
1. Fetch the DEX price via `uniswap/lib.js`, **cached**, refreshed every
   `BAND_REFRESH_MS` (default 10 min = the grid cycle).
2. **Smooth** it. Two options, in priority order:
   - **EMA (primary, available now):** `EMA = α·price + (1−α)·EMA_prev`,
     `α = BAND_SMOOTHING_ALPHA` (default 0.3, ≈ last hour weighted to recent).
   - **Uniswap V3 TWAP (future upgrade):** more manipulation-resistant, but the
     L1X/WETH pool currently has `observationCardinality = 1` — **no TWAP window
     available.** Enabling it needs a one-time `increaseObservationCardinalityNext`
     tx **and** time for the (thin) pool to fill the window with swaps. Switch to
     TWAP as primary once cardinality is raised and the window is warm.
3. **Rate-limit** movement: the center moves at most `BAND_MAX_MOVE_PCT` per
   update (default 0.5%). A larger DEX move is caught up over the next few cycles.
4. **Clamp** to absolute safety limits `BAND_ABS_MIN` / `BAND_ABS_MAX`.
5. Return `{ center, floor, resistance, minAsk, highestBuy, lowestSell }`:
   - `highestBuy = center × (1 − halfSpread)`
   - `lowestSell = center × (1 + halfSpread)`
   - `floor`/`resistance` = the volume bot's hard limits (a bit wider than the inner spread)
   - **inner spread = 2 × halfSpread, HARD-CAPPED at `INNER_SPREAD_PCT` ≤ 1%** (default ~0.7%).
6. **Fallback:** if the DEX read fails, return the **last good band** — never
   widen, never crash.

### Part B — Volume/pattern bot follows the band
- Replace `CONFIG.hardFloorPrice` / `hardResistancePrice` / `minBestAskToTrade`
  (bitmart lines 918–947, lbank 695–705) with the engine's `floor` / `resistance`
  / `minAsk`, recomputed each tick from the cached band.
- `updateMicroTrend` and the final clamp use the dynamic floor/resistance.
- Effect: the box slides with the DEX → the bot trades the CEX price to the DEX
  level. **This is what moves the price.**

### Part C — Grid: relative offsets + dynamic center
- Convert grid `priceRanges` from **absolute prices** to **center-relative
  offsets** (% from center): innermost sell = `center +0.35%…+0.6%`, innermost
  buy = `center −0.35%…−0.6%`, defensive layers further out.
- At each 10-min refresh, set `center = band engine center` (DEX-based) instead
  of the current market price.
- Effect: the whole grid slides to the new level; the innermost gap = the inner
  spread (≤1%).

### Part D — Treasury (unchanged, complementary)
- Keeps selling L1X on the DEX when DEX ≥ CEX by `TREASURY_MIN_PREMIUM_PCT`.
- Because the band follows the DEX **slowly** (capped move/step), a big fast DEX
  spike opens a gap the band hasn't closed → the treasury sells to cap it. Slow
  drift → the band tracks it. The two cover each other.

```
External buyers move the DEX price
        │
        ▼
Band engine: EMA + max-move cap + abs clamp  →  center (updated every 10 min)
        ├─ Volume bot  → trades CEX price to center      (moves the price)
        ├─ Grid        → re-centers liquidity on center  (provides depth)
        └─ Treasury    → sells on DEX if DEX ≥ center+5%  (catches fast spikes)
```

---

## 3. Config (env) — all gated behind one switch

| Var | Meaning | Default |
|-----|---------|---------|
| `DYNAMIC_BAND` | master on/off (false = today's fixed box) | `false` |
| `BAND_REFRESH_MS` | how often to refetch DEX + move the band | `600000` (10 min) |
| `BAND_SMOOTHING_ALPHA` | EMA smoothing 0–1 (lower = smoother) | `0.3` |
| `BAND_FOLLOW_MAX_PCT` | stop following if DEX is this far from CEX (freeze) | `5` |
| `BAND_MAX_MOVE_PCT` | max center move per update | `0.5` |
| `INNER_SPREAD_PCT` | grid buy↔sell gap (**hard-capped 1.0**) | `0.7` |
| `BAND_ABS_MIN` / `BAND_ABS_MAX` | absolute safety floor/ceiling | e.g. `5` / `20` |
| `BAND_STALE_MS` | freeze band if DEX price older than this | `300000` |
| treasury vars | unchanged | — |

---

## 4. Safety mechanisms (what makes it robust)

1. **EMA smoothing** — no jitter from pool noise.
2. **Max-move-per-step cap** — the band can't jump on a big DEX move; it eases in.
3. **Absolute min/max clamp** — a bad or manipulated DEX read can NEVER push the
   CEX band outside a safe range.
4. **Inner spread hard-capped ≤ 1%** — the market always looks tight/liquid.
5. **DEX-read fallback** — RPC blip → keep the last good band; bots keep running.
6. **Staleness freeze** — if the DEX price is too old, stop moving the band.
7. **Follow-within-threshold, freeze-beyond (key manipulation guard)** — the band
   only follows the DEX while the DEX is within the treasury trigger (~5%) of the
   current CEX. If the DEX spikes *past* that, the band **freezes** (does NOT
   chase it) — a big spike is either manipulation or a real event the **treasury**
   handles by selling the DEX back. This is what replaces TWAP's protection while
   the pool has no observation history.
8. **Kill switch** — `DYNAMIC_BAND=false` instantly reverts to the fixed box, no
   redeploy.
9. **Single source of truth** — volume bot, grid, and treasury all read the same
   center, so they can't fight.

---

## 5. Failure modes & handling

| Failure | What happens |
|---------|--------------|
| DEX RPC down / slow | last-good band; bots keep trading; no crash |
| DEX pool manipulated/glitched | abs clamp + max-move cap + oracle check contain it |
| Band vs volume-bot out of sync | both read the same engine each cycle |
| Treasury vs band oscillation | smoothing/lag → band follows slowly; treasury handles fast |
| Bad config (spread too wide) | inner spread clamped to 1% |

---

## 6. Implementation steps (file by file)

1. **`shared/price_band.js`** (new) — fetch DEX, EMA, max-move cap, abs clamp,
   staleness, fallback; expose `getBand()` returning the band object.
2. **`bitmart/Bitmart_Pattern_Trading.js`** + **`lbank/Lbank_Pattern_Trading.js`**
   — swap fixed-band reads for `getBand()`; gate behind `DYNAMIC_BAND`.
3. **`bitmart/grid_manager_bitmart.js`** + **`lbank/LBank_GridManager.js`** —
   convert `priceRanges` to relative offsets; set `center = getBand().center` at
   refresh; gate behind `DYNAMIC_BAND`.
4. **`.env.example`** — add the `BAND_*` vars.
5. **Treasury** — no change.

---

## 7. Rollout (safe, staged)

1. **Simulation first** (`BOT_DRY_RUN=true`) — watch the band track a moving DEX
   price in the logs; no real orders.
2. **Shadow mode** — compute + log the dynamic band but keep placing orders on
   the fixed band; compare for a day.
3. **One venue first** — enable on Bitmart, watch, then LBank.
4. **Tight caps initially** — small `BAND_MAX_MOVE_PCT`, tight inner spread; relax later.
5. **Kill switch ready** — flip `DYNAMIC_BAND=false` to revert instantly.

---

## 8. Open decisions (need confirmation before building)

1. **Follow speed:** slow/lagged EMA (recommended — keeps the treasury useful) vs
   exact mirror.
2. **Inner spread:** 0.7% (today), hard-capped 1% — confirm.
3. **Treasury trigger:** 5% or 1.5%?
4. **Absolute safety limits:** what min/max is safe for L1X (e.g. $5–$20)?
5. **DEX source:** the Uniswap L1X/WETH pool (Ethereum) — confirm (not the QDex
   L1X-chain pool).
6. **TWAP:** enable it later? (one-time `increaseObservationCardinalityNext` tx +
   warm-up), or stay on EMA + the freeze-beyond-threshold guard. Checked
   2026-07: pool cardinality = 1, so TWAP is not available today.
