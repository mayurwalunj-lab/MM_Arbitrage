# Production Deployment Checklist

Step-by-step for moving the consolidated DB + arb system to the production
server. Work top to bottom. Each phase is safe to stop after.

---

## ⚠️ The .env differences that matter most

The same code runs on both machines; behavior comes from `.env`. These keys
MUST differ — getting them wrong silently breaks trading or pollutes data.

| Key | Your Mac (local/testing) | Production server |
|-----|--------------------------|-------------------|
| `BOT_DRY_RUN` | `true` (simulate) | **`false`** (live trading) |
| `ARB_DRY_RUN` | unset / `true` (simulate) | `true` until go-live, then `false` |
| `ARB_SELF_TRADE_FILTER` | `false` (can't fetch own orders here) | **unset or `true`** (filter ON, real data) |
| `DB_*` | local Docker (`127.0.0.1:3307`) | remote `mm_production` (`159.195.76.213:25060`) |
| `ARB_DB_*` | local Docker | unset (falls back to `DB_*`) |

**Never copy the Mac's `.env` to the server verbatim.** Maintain them separately.

---

## Phase 1 — Pre-flight (before touching the server)

- [ ] All work committed and pushed to `feat/uniswap_pool`
- [ ] `npm run check` passes locally
- [ ] Branch merged to `main` (or deploy directly from the feature branch — decide)

## Phase 2 — Server cutover (≈5 min downtime, pick a quiet hour)

- [ ] SSH to the production server
- [ ] `git status` FIRST — note any uncommitted local edits (old dryRun flips etc.)
- [ ] `git pull` the branch with the prefixed-table + env-driven code
- [ ] `pm2 stop all` (bots stop writing to the old databases)
- [ ] `node scripts/db_consolidate.js topup` (copy rows written since last sync)
- [ ] `node scripts/db_consolidate.js verify` — **row counts must match exactly**
- [ ] Edit server `.env`:
  - [ ] `DB_HOST=159.195.76.213` `DB_PORT=25060` `DB_USER=root` `DB_PASSWORD=…` `DB_NAME=mm_production`
  - [ ] `BOT_DRY_RUN=false`  ← REQUIRED or all bots run dry and trading stops
  - [ ] `ARB_DRY_RUN=true`   ← keep arb in detection-only for now
  - [ ] `ARB_SELF_TRADE_FILTER` unset (filter ON for real opportunity data)
  - [ ] no `ARB_DB_*` block (let it fall back to `DB_*`)
- [ ] `npm run db:migrate` — apply pending schema migrations
- [ ] `npm run test:preflight --db` — should pass
- [ ] `pm2 start ecosystem.config.js`
- [ ] `pm2 logs` for ~10 min: bots log REAL trades (not `[DRY]`), no SQL errors
- [ ] Dashboard shows full history for both exchanges

### Rollback (if anything looks wrong)
- [ ] Revert `.env` DB name back to old DBs (`market-cap_production` / `marketcap`)
- [ ] `pm2 restart all` — back on old databases in <1 min, no data lost
- [ ] (`BOT_DRY_RUN=false` stays; old DBs were untouched)

## Phase 3 — Confirm arb monitor health (same session)

- [ ] `pm2 logs arb_monitor` shows `self-trade filter active` with NO "IP forbidden"
- [ ] Ticks show real DEX/CEX prices and direction tags
- [ ] After 30 min: `npm run arb:report` shows snapshots accumulating
- [ ] Recorded opportunities (if any) carry `filter_mode = 'on'`

## Phase 4 — Trading prerequisites (parallel, no rush)

- [ ] CEX order test (leg 1): `npm run arb:test-cex-order -- --exchange lbank`
      (unfillable, zero risk) then `--fill --l1x 1` (real ~$8 buy).
      OK to run against the grid account for the test (the grid bot won't
      cancel non-grid orders), but use a DEDICATED account for production:
- [ ] **Create a dedicated ARB account/sub-account** (NOT a shared MM bot key)
      — its own balance, own API key, trading permission, server IP whitelisted
- [ ] Set `ARB_LBANK_API_KEY` / `ARB_LBANK_SECRET` to the dedicated account
      (currently they alias LBANK_BOT_A — must change before go-live, or arb
      and the pattern bot fight over the same balance/orders)
- [ ] Position inventory: L1X + ETH in the wallet, L1X + ETH + USDT on the exchange

## Phase 5 — Collect data (days — the decision gate)

- [ ] Let `arb_monitor` run; review `arb_opportunities WHERE filter_mode='on'`
- [ ] Decide: are real edges frequent/large enough to beat fees + gas?
- [ ] If NO → stop here; you have monitoring infra and lost nothing
- [ ] If YES → proceed to Phase 6

## Phase 6 — Staged go-live (only if Phase 5 justifies it)

- [ ] Set `ARB_DRY_RUN=false` and `ARB_EXEC_MAX_TRADE_USD=50` (tiny cap)
- [ ] Run ONE `npm run arb:execute` when monitor shows a real edge
- [ ] Compare journal `realizedPnlUsdt` vs `expectedNetUsd` — should be close
- [ ] A few more command-triggered rounds; raise caps only if fills match
- [ ] Only then consider `ARB_AUTO_EXECUTE=true`
- [ ] Safety nets active throughout: daily loss limit, trades/hour cap,
      `touch arb/state/HALT` kill switch

---

## Quick reference — emergency stops

| Situation | Action |
|-----------|--------|
| Stop arb trading instantly | `touch arb/state/HALT` |
| Resume | `rm arb/state/HALT` |
| Stop one bot | `pm2 stop <name>` |
| Stop everything | `pm2 stop all` |
| Back to old databases | revert `DB_NAME` in `.env`, `pm2 restart all` |

## Post-cutover cleanup (after N stable days)

- [ ] Drop legacy `BITMART_DB_*` / `LBANK_DB_*` keys from server `.env` (DB_* only)
- [ ] Archive a final dump of old `market-cap_production` / `marketcap`, then drop them
- [ ] Backfill the 2 historical Uniswap swaps into `dex_trades` (optional)
