# MM Arbitrage — Command Reference & Checklists

Quick reference for every command in this repo: what it does, when to use it,
and whether it can spend money.

**Legend:**
- 🟢 **READ-ONLY** — never trades, never sends a transaction, safe to run anytime
- 🟡 **DRY-RUN default** — simulates only; needs an explicit flag to do anything real
- 🔴 **LIVE** — places real orders / sends real transactions

---

## 1. Uniswap (DEX) commands

### 🟢 Check pool & connection
```bash
npm run uniswap:check
```
Shows chain ID, configured wallet, token addresses, pool fee tier, liquidity,
tick, and whether the pool is unlocked. Run this first if anything seems wrong.

### 🟢 Wallet balance
```bash
npm run uniswap:balance                      # wallet from .env
npm run uniswap:balance -- --address 0x...   # any other address
```
Shows ETH / WETH / L1X balances with live USD values, plus router allowances.
If an allowance is 0, the next trade will include an extra approve transaction.

### 🟢 Quote a buy or sell (no trade)
```bash
npm run uniswap:quote-buy -- --eth 0.01          # what does 0.01 ETH buy?
npm run uniswap:quote-sell -- --l1x 100          # what do 100 L1X sell for?
npm run uniswap:quote-sell -- --l1x 100 --slippage 0.5
```
Shows expected output, minimum output after slippage, and gas estimate.

### 🟢 Price impact of a sell
```bash
npm run uniswap:impact -- --l1x 10
```
Shows current pool price, average sell price for that size, post-trade price,
and the impact in $ and %. Use before any sell to see how much you move the pool.

### 🟢 Max sell size for a price floor
```bash
npm run uniswap:max-sell-size -- --min-price-usd 8.00 --max-l1x 1000
```
Answers: "how much L1X can I sell in one swap without pushing the pool price
below $8.00?" Shows current pool price, the safe size, your average sell
price, and where the pool lands. Uses live ETH/USDT from Bitmart+LBank.

### 🟡→🔴 Buy L1X (WETH → L1X)
```bash
npm run uniswap:buy -- --eth 0.003               # DRY RUN: quote only
npm run uniswap:buy -- --eth 0.003 --execute     # LIVE: real swap
```
With `--execute`: wraps ETH to WETH if needed → approves router if needed →
swaps. You only need plain ETH in the wallet. Amount is the ETH you spend.

### 🟡→🔴 Sell L1X (L1X → WETH)
```bash
npm run uniswap:sell -- --l1x 0.5                # DRY RUN: quote only
npm run uniswap:sell -- --l1x 0.5 --execute      # LIVE: real swap
```
With `--execute`: checks L1X balance → approves router if needed → swaps.
You receive WETH (stays wrapped). Amount is the L1X you sell.
Both buy and sell protect you with a minimum-output (default 1% slippage,
override with `--slippage 0.5`). If the pool moves too much, the swap
reverts safely instead of filling at a bad price.

### 🟢 Uniswap preflight tests
```bash
npm run uniswap:test             # env + RPC + pool + token checks
npm run uniswap:test:quote       # + sample quotes
npm run uniswap:test:wallet      # + wallet balances and allowances
npm run uniswap:test:eth-price   # live ETH/USDT from Bitmart + LBank only
npm run uniswap:test:all         # everything
```

---

## 2. Arbitrage monitor (detection only)

### 🟢 Run the monitor
```bash
npm run arb:monitor          # continuous loop (every ARB_POLL_MS, default 5s)
npm run arb:monitor:once     # single tick, for testing
```
Watches Bitmart + LBank L1X/USDT books and the Uniswap pool. Computes net
arbitrage edge (after both taker fees, the ETH hedge fee, and gas) at the
optimal trade size. **Never trades.** Confirmed opportunities are appended to
`arb/state/opportunities.jsonl`.

Built-in protections (an opportunity must pass ALL of these):
- own grid/MM orders subtracted from the book (self-trade filter)
- book sanity: spread and depth near mid must be healthy
- grid-refresh flag: ignores the book while a grid bot mass-cancels
- staleness: slow ticks are discarded
- persistence: edge must survive `ARB_PERSIST_TICKS` consecutive ticks

### Controls
```bash
touch arb/state/HALT         # pause the monitor AND block all execution
rm arb/state/HALT            # resume
cat arb/state/opportunities.jsonl | tail -5    # latest recorded opportunities
cat arb/state/trades.jsonl | tail -5           # execution journal
```

### 🟡→🔴 Execute one arbitrage round (Stage A — command-triggered)
```bash
npm run arb:execute                       # detect best, run the 3 legs
npm run arb:execute -- --exchange lbank   # restrict to one venue
npm run arb:execute -- --min-edge 2       # custom edge requirement
npm run arb:execute -- --force            # dry-run flow test, ignores edge
```
SIMULATED unless `ARB_DRY_RUN=false` in `.env` (the master lock). Re-verifies
the edge fresh, then: CEX limit order → Uniswap swap → ETH hedge, with
cancel/unwind on failure. Respects per-trade cap, trades-per-hour cap, and
the daily loss limit (which auto-creates HALT when hit).

### 🔴 Auto-execution (Stage B/C — monitor fires rounds itself)
Requires BOTH switches in `.env`: `ARB_AUTO_EXECUTE=true` AND `ARB_DRY_RUN=false`.
Only fires above `ARB_AUTO_MIN_EDGE_USD`, one round at a time, with
`ARB_EXEC_COOLDOWN_MS` between rounds and every Stage A cap enforced.

### Tuning (in `.env`)
| Key | Default | Meaning |
|---|---|---|
| `ARB_MIN_EDGE_USD` | 20 | minimum net profit to record an opportunity |
| `ARB_MIN_TRADE_L1X` / `ARB_MAX_TRADE_L1X` | 10 / 1000 | size search range |
| `ARB_CEX_TAKER_FEE_BPS` | 25 | exchange taker fee assumption (0.25%) |
| `ARB_MIN_DEPTH_L1X` | 50 | min external book depth near mid |
| `ARB_DEPTH_RANGE_PCT` | 2 | "near mid" = within ±this % |
| `ARB_MAX_SPREAD_PCT` | 2 | reject book if spread wider than this |
| `ARB_PERSIST_TICKS` | 3 | ticks an edge must survive |
| `ARB_POLL_MS` | 5000 | tick interval |
| `ARB_DRY_RUN` | true | **must stay true** — order placement is blocked unless set to `false` |

---

## 3. Market-making bots (unchanged behavior)

```bash
npm run bitmart:pattern      # Bitmart pattern trading bot
npm run bitmart:grid         # Bitmart grid manager
npm run lbank:pattern        # LBank pattern trading bot
npm run lbank:grid           # LBank grid manager
npm run dashboard            # dashboard server
npm run start                # ./run-all.sh all
npm run pm2:start            # via PM2
```
Note: the grid managers now write `arb/state/grid_refreshing_<exchange>.flag`
while mass-cancelling orders, so the arb monitor ignores those windows.

---

## 3b. Database consolidation (Option A)

All tables live in ONE database `mm_production` with prefixes:
`bitmart_*`, `lbank_*` (MM tables) + `arb_*`, `dex_*` (arb tables).
Old databases `market-cap_production` / `marketcap` are kept untouched as
rollback. `scripts/db_consolidate.js`:

```bash
node scripts/db_consolidate.js copy      # full copy (skips existing tables)
node scripts/db_consolidate.js verify    # row counts source vs target
node scripts/db_consolidate.js topup     # incremental copy by id (cutover)
```

### ✅ Server cutover checklist
- [ ] `git pull` the branch with prefixed-table code
- [ ] `pm2 stop all` (bots stop writing)
- [ ] `node scripts/db_consolidate.js topup` then `verify` — counts must match exactly
- [ ] server `.env`: `BITMART_DB_NAME=mm_production` and `LBANK_DB_NAME=mm_production`
- [ ] `pm2 start ecosystem.config.js` and watch logs for SQL errors
- [ ] dashboard pages show history for both exchanges
- [ ] rollback if needed: revert the two .env values, `pm2 restart all`

## 4. Health checks

```bash
npm run check                # syntax-check every JS file (incl. arb/ + lib)
npm run test:preflight       # env keys, deps, ports, no hardcoded secrets
npm run test:exchange        # + public exchange connectivity
npm run test:balances        # + private balance reads
npm run test:production      # everything
```

---

## 5. Checklists

### ✅ First-time setup on a machine
- [ ] `npm install`
- [ ] copy `.env.example` → `.env`, fill all keys
- [ ] `ETH_RPC_URL` set (e.g. your node provider or a public RPC)
- [ ] `npm run check` passes
- [ ] `npm run test:preflight` passes
- [ ] `npm run uniswap:check` shows the right pool (fee 100, L1X/WETH)
- [ ] `npm run arb:monitor:once` completes a tick

### ✅ Before any LIVE Uniswap trade
- [ ] `UNISWAP_WALLET_PRIVATE_KEY` and `UNISWAP_WALLET_ADDRESS` set in `.env`
- [ ] `npm run uniswap:balance` — enough token to sell/spend + ETH for gas
- [ ] dry-run the exact command first (without `--execute`)
- [ ] `npm run uniswap:impact -- --l1x <size>` — happy with the price impact?
- [ ] then add `--execute`

### ✅ Arb monitor deployment (production server)
- [ ] running from the server whose IP is whitelisted on Bitmart/LBank
      (otherwise own-orders fetch fails and `selfTradeFilterOk` is false)
- [ ] `.env` complete on the server
- [ ] start under PM2 so it survives restarts
- [ ] after a day: check `arb/state/opportunities.jsonl` — any entries?
- [ ] review with: how many opportunities, what sizes, what net edge?

### ✅ Manual arbitrage execution (until Phase 2 is built)
- [ ] monitor logs `OPPORTUNITY` with exchange, size, net edge
- [ ] verify DEX side: `npm run uniswap:impact -- --l1x <size>`
- [ ] leg 1 — buy L1X on the CEX (limit at the walked ask price)
- [ ] leg 2 — `npm run uniswap:sell -- --l1x <size> --execute`
- [ ] leg 3 — sell the received ETH amount on the CEX (locks profit in USDT)
- [ ] record what happened vs. what the monitor predicted

---

## 6. Known facts about this market (measured live, June 2026)

- The L1X/WETH pool is **Uniswap V3**, fee tier **0.01%** (fee=100)
- The pool is **thin**: ~$0.012 price impact per 1 L1X sold (at ~$8.3 price);
  ~21 L1X of selling moves the price down ~3%
- CEX books are also thin near the mid (tens of L1X within ±2%)
- Gas is currently cheap (~$0.05 per swap) — not the binding cost
- Conclusion: opportunities will be small-size; size optimization matters
  more than speed
