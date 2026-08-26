# QDex volume test harness

Generates randomised **test** trades across WL1X-paired QDex pools from a
rotating roster of sub-wallets, with hard limits on size, price impact, rate and
total exposure.

## What this is, and what it is not

This is a load/behaviour test harness. It is **labelled as test activity
throughout** and makes no attempt to disguise coordinated trading as organic
user flow:

- every `qdex_volume_*` row carries `is_test_activity = 1`, the epoch id and the run id
- every log line carries the run id and `QVT_TEST_TAG`
- **the parent wallet never rotates** — every epoch's funding traces back to one
  constant address, so the full history is reconstructible on chain
- the roster of every past epoch stays in the database
- randomisation covers a range of sizes, directions and pools. There is no burst
  shaping, no session-length modelling, and nothing that makes coordinated trades
  look independent

If you need any of those properties for a legitimate reason, that is a different
tool and it is not this one.

## Safety posture

Dry-run is the default and cannot be turned off by accident. **Every one of these
must be true before a single transaction can be sent:**

| Requirement | Why |
|---|---|
| `--execute` flag or `QVT_EXECUTE=true` | explicit intent |
| live chain id ∈ `QVT_ALLOWED_CHAIN_IDS` | network allow-list; empty = nothing executes |
| every pool ∈ `QVT_ALLOWED_POOLS` | pool allow-list; empty = nothing executes |
| `QVT_PARENT_PK` set | funding source |
| `QVT_KEY_ENCRYPTION_KEY` set | keys must be encryptable |

Both allow-lists ship **empty**. Until you deliberately fill them in, the harness
is a simulator. If `--execute` is passed while the gate is closed, it says so and
degrades to a dry run rather than failing.

## Quick start

```bash
npm run qdex:vol:secret          # generate QVT_KEY_ENCRYPTION_KEY, paste into .env
npm run qdex:vol:epoch:new       # generate 10 wallets — offline, zero gas
npm run qdex:vol:preflight       # read-only: roster, balances, pools, verdict
npm run qdex:vol                 # dry-run loop
npm run qdex:vol:report          # dashboard
```

To go live, fill in the allow-lists and `QVT_PARENT_PK`, then:

```bash
npm run qdex:vol:fund -- --execute
npm run qdex:vol:live
```

## Emergency stop

Four independent paths, any one halts before the next trade:

```bash
npm run qdex:vol:stop            # writes the stop file — works from any shell or cron
```

1. `SIGINT` / `SIGTERM` — graceful drain
2. the stop file (`QVT_STOP_FILE`, default `qdex/volume/.STOP`)
3. auto-breakers — `QVT_MAX_CONSECUTIVE_FAILURES` transaction failures in a row
4. session budgets — `QVT_MAX_SESSION_TX`, `QVT_MAX_SESSION_NOTIONAL_WL1X`, `QVT_MAX_RUNTIME_MIN`

The bot refuses to start while the stop file exists. Clear it with
`npm run qdex:vol:resume`.

## How a trade is decided

```
pick pool (TVL-weighted)  ->  pick wallet (round-robin + cooldown)
  -> rate limit + emergency stop
  -> gas check, WL1X floor check (peer transfer, else parent backstop)
  -> side: price band first, then inventory target
  -> size: min(impact cap, pool-fraction cap, inventory, QVT_MAX_TRADE_WL1X)
  -> quote, shrink if over the impact cap, skip if even the minimum is too big
  -> execute or simulate  ->  record  ->  random delay
```

Every attempt is recorded, including skips, **with the reason**. When tuning
limits, the skip reasons in `npm run qdex:vol:report` are the most useful output
the harness produces.

### Sizing is per-pool, not a constant

QDex pool depth spans many orders of magnitude, and `liquidity()` does **not**
predict tradeable size — one pool reporting 28,000× more liquidity than another
absorbs 40,000× *less*. So `QVT_MAX_IMPACT_BPS` is the real control and the size
is derived from each pool's own state at quote time. `QVT_MIN_TRADE_WL1X` and
`QVT_MAX_TRADE_WL1X` are only outer clamps.

### Pool weighting

`QVT_POOL_WEIGHTING` controls how traffic is spread:

| Value | Weight | Effect |
|---|---|---|
| `sqrt` (default) | √TVL | depth-aware, but every pool still gets traffic |
| `tvl` | TVL | strictly proportional — the small pools get almost nothing |
| `uniform` | equal | ignores depth; the per-pool impact cap still keeps sizes safe |

TVL across the shipped 10 spans about 40×, so straight `tvl` weighting starves
the bottom half: in a measured 84-trade dry run it sent 51 trades to L1USD and
**zero** to five of the ten pools. `sqrt` compresses that ratio to about 6×.
Per-pool overrides are available as `QVT_POOL_n_WEIGHT`.

### Side selection

Two pulls, both toward stability:

- **price** — outside `±QVT_MAX_DEVIATION_PCT` of the session anchor, the
  corrective side is forced
- **inventory** — a wallet is steered toward `QVT_INVENTORY_TARGET_PCT` WL1X by
  value, measured across its **whole portfolio**, not the chosen pool alone

That distinction matters. Valuing only the selected pool's holding means a wallet
spreading buys over ten pools never accumulates enough in any single one to flip
the bias — it buys forever. The portfolio view fixes that: the side is decided
first, then a pool that can actually serve it is chosen (for a SELL, one where the
wallet holds enough of that token).

The inventory pull is also why epoch 1 opens with no special-case code: wallets
start holding only WL1X, so they are maximally off target and the bias picks BUY.
Expect a one-directional opening of roughly `walletCount × fundWl1x / 2` WL1X of
net buying — about 15 WL1X across ten pools with the defaults, which is under
0.05% of even the smallest shipped pool's depth.

## Wallets

Ten sub-wallets are HD-derived from one mnemonic at `m/44'/60'/0'/0/i` — one
secret to back up, reproducible anywhere, portable to any standard wallet.
Generation needs **no network, no gas and no chain interaction**: an address is
pure math, and the chain only learns it exists when it first receives funds.

Keys are persisted twice on purpose:

- **encrypted in MySQL** (`qdex_volume_wallets.privkey_enc`, AES-256-GCM) —
  recoverable with `QVT_KEY_ENCRYPTION_KEY`
- **as a gitignored keyfile** holding the mnemonic — recoverable if the database
  is lost

Either one alone restores the roster. Recover a single key with:

```bash
npm run qdex:vol:export -- --epoch 3 --idx 7
```

> **Back up `QVT_KEY_ENCRYPTION_KEY`.** The database alone is useless without it —
> which is the point, since `dashboard/Server.js` serves the same database over
> HTTP with open CORS. `privkey_enc` and `mnemonic_enc` must never be exposed
> through any dashboard route.

The parent wallet is **not** generated — supply it via `QVT_PARENT_PK`.

## Epoch rotation

```
epoch N trading (QVT_EPOCH_DAYS)
  -> sweep to parent IN KIND (every token as-is, no swaps)
  -> retire epoch N
  -> generate 10 fresh wallets (offline)
  -> parent distributes every asset pro rata
  -> epoch N+1 trading
```

```bash
npm run qdex:vol:epoch           # status, age, time left, roster
npm run qdex:vol:epoch:rotate    # the whole cycle (dry-run without --execute)
npm run qdex:vol:sweep           # sweep only
```

**The sweep is in kind.** Token bags are transferred as they are, never sold back
to WL1X first — liquidating them would pay the pool fee twice over and move every
price at once. A side effect is that epoch 2 onward starts *pre-balanced*: new
wallets inherit the previous epoch's tokens and can trade either direction
immediately.

Native gas is swept last, minus the cost of that very transaction, so retired
wallets do not accumulate stranded dust across epochs.

A rotation is roughly `wallets × (pools + 2)` transfers out and the same back —
with 10 wallets and 10 pools that is ~120 each way. Budget parent gas for it.

## Two factories, two routers

QDex runs **two** factory deployments. A Uniswap-V3 `SwapRouter` derives pool
addresses via CREATE2 from its own immutable factory, so a router **cannot** swap
on the other factory's pools. The router is therefore configured **per pool**:

| | Factory | Router |
|---|---|---|
| F1 | `0xE22074DE1060298e3B45D46313ca32bC3fE2B86A` | `0xA3A2dfF9f43Edc2825AC4C2Ff1A2945e103a37eB` |
| F2 | `0xD565a80EAf4CCCf520F523052e30c0d9a12ccea4` | `0xfd6fce2C473CDa77D794a2B03A72c8F30F47F60d` |

`QDEX_ROUTER_ADDRESS` in `.env` is F1's. The QDex UI aggregates both, which is
why a factory-1-only pool scan misses funded pools such as M1X, GDAO and `$STAR`.

The harness probes each router once for which `exactInputSingle` shape it speaks
(with `deadline`, or SwapRouter02 without) and caches the answer.

## Pool selection notes

- **The XUSD/WL1X pool is deliberately excluded.** `qdex/qdex_mm.js` holds it at
  a peg; a volume bot there would fight it, cost real money on both sides, and
  pollute the peg accounting in `qdex_actions`.
- **STACK is excluded** — $2.2M reported TVL but the QDex UI does not list it, and
  its sibling pool shows $733K TVL backed by $1,621 of WL1X (the rest is STACK
  valued at STACK's own pool price).
- **Zero-active-liquidity pools are excluded.** `liquidity() == 0` does not mean
  empty — it means price sits outside every LP range. Such a pool can hold real
  reserves while being untradeable at the current price.

## Fee burn

A buy-then-sell round trip pays the pool fee twice. At 100 tx/hr, 0.3 WL1X
average, 0.3% tier:

```
100 × 0.3 × 0.003 ≈ 0.09 WL1X/hr
```

Against a 30 WL1X fleet float that is ~0.3%/hr, ~7%/day, plus gas. The parent
needs a WL1X reserve for backstop top-ups on any long run.

## Tables

| Table | Contents |
|---|---|
| `qdex_volume_epochs` | one row per roster generation; encrypted mnemonic |
| `qdex_volume_wallets` | the 10 wallets of an epoch; encrypted private key |
| `qdex_volume_trades` | every attempt — executed, skipped or failed, with reason |
| `qdex_volume_transfers` | fund / peer / backstop / sweep movements |

## Tests

```bash
node qdex/volume/selftest.js     # offline: crypto, limiter, breakers, V3 math
npm run check                    # syntax across the repo
```

The self-test uses a synthetic pool and touches no network or database. It
asserts, among other things, that `maxSizeAtImpact` actually lands on the cap for
both sides and for either token ordering — that is the function everything else
trusts to keep trades small.
