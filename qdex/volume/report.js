#!/usr/bin/env node

'use strict';

// Dashboard for the QDex volume test harness — reads the database and prints
// totals, volume, average trade size, price impact, per-pool and per-wallet
// breakdowns, skip reasons, and the transfer/rotation history.
//
//   node qdex/volume/report.js                 last 24h, active epoch
//   node qdex/volume/report.js --hours 168     last week
//   node qdex/volume/report.js --epoch 3       one specific epoch
//   node qdex/volume/report.js --all           every epoch
//
// Skip reasons are printed deliberately: when tuning limits they are the most
// informative output the harness produces.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const db = require('./db');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

const n = (v, dp = 4) => (v == null ? '-' : Number(v).toFixed(dp));
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);
const bar = (w = 74) => console.log('-'.repeat(w));

(async () => {
  await db.init();

  const hours = Number(arg('--hours', 24));
  const epochArg = arg('--epoch');
  const where = [];
  const params = [];
  if (epochArg) { where.push('epoch_id = ?'); params.push(Number(epochArg)); }
  else if (!has('--all')) { where.push('timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)'); params.push(hours); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const scope = epochArg ? `epoch ${epochArg}` : has('--all') ? 'all time' : `last ${hours}h`;
  console.log(`\n${'='.repeat(74)}`);
  console.log(`  QDEX VOLUME TEST — ${scope}`);
  console.log('='.repeat(74));

  // ---- headline ----
  const [[t]] = await db.query(`
    SELECT COUNT(*) attempts,
           SUM(status='executed') executed,
           SUM(status='skipped')  skipped,
           SUM(status='failed')   failed,
           SUM(is_dry_run=1)      dry,
           SUM(CASE WHEN status='executed' THEN notional_wl1x ELSE 0 END) volume_wl1x,
           AVG(CASE WHEN status='executed' THEN notional_wl1x END)        avg_size,
           AVG(CASE WHEN status='executed' THEN impact_bps END)           avg_impact,
           MAX(CASE WHEN status='executed' THEN impact_bps END)           max_impact,
           SUM(CASE WHEN status='executed' AND side='buy'  THEN 1 ELSE 0 END) buys,
           SUM(CASE WHEN status='executed' AND side='sell' THEN 1 ELSE 0 END) sells,
           MIN(timestamp) first_ts, MAX(timestamp) last_ts
    FROM qdex_volume_trades ${W}`, params);

  if (!t || !t.attempts) { console.log('\n  no activity in scope\n'); await db.end(); return; }

  const spanH = (new Date(t.last_ts) - new Date(t.first_ts)) / 3600000;
  console.log(`  window       ${t.first_ts} -> ${t.last_ts}  (${spanH.toFixed(2)}h)`);
  console.log(`  attempts     ${t.attempts}   executed ${t.executed}, skipped ${t.skipped}, failed ${t.failed}`);
  console.log(`  live/dry     ${t.attempts - t.dry} live / ${t.dry} dry-run`);
  console.log(`  volume       ${n(t.volume_wl1x)} WL1X`);
  console.log(`  avg size     ${n(t.avg_size)} WL1X       buy/sell  ${t.buys} / ${t.sells}`);
  console.log(`  impact       avg ${n(t.avg_impact, 2)} bps   max ${n(t.max_impact, 2)} bps`);
  if (spanH > 0.01) console.log(`  rate         ${(t.executed / spanH).toFixed(1)} executed tx/hr`);

  // ---- per pool ----
  const [pools] = await db.query(`
    SELECT pool_label, COUNT(*) attempts,
           SUM(status='executed') executed,
           SUM(CASE WHEN status='executed' THEN notional_wl1x ELSE 0 END) volume,
           AVG(CASE WHEN status='executed' THEN impact_bps END) avg_impact,
           MIN(CASE WHEN status='executed' THEN price_after END) lo,
           MAX(CASE WHEN status='executed' THEN price_after END) hi,
           AVG(deviation_pct) avg_dev
    FROM qdex_volume_trades ${W} GROUP BY pool_label ORDER BY volume DESC`, params);
  console.log(`\n  ${pad('pool', 10)}${rpad('exec', 6)}${rpad('volume WL1X', 14)}${rpad('avg bps', 9)}${rpad('avg dev%', 10)}   price range`);
  bar();
  pools.forEach((p) => console.log(`  ${pad(p.pool_label || '?', 10)}${rpad(p.executed, 6)}${rpad(n(p.volume), 14)}` +
    `${rpad(n(p.avg_impact, 2), 9)}${rpad(n(p.avg_dev, 3), 10)}   ${p.lo != null ? Number(p.lo).toPrecision(6) + ' – ' + Number(p.hi).toPrecision(6) : '-'}`));

  // ---- per wallet ----
  const [ws] = await db.query(`
    SELECT wallet_idx, wallet_address, COUNT(*) attempts,
           SUM(status='executed') executed,
           SUM(CASE WHEN status='executed' THEN notional_wl1x ELSE 0 END) volume
    FROM qdex_volume_trades ${W} GROUP BY wallet_idx, wallet_address ORDER BY wallet_idx`, params);
  console.log(`\n  ${pad('wallet', 8)}${pad('address', 44)}${rpad('exec', 6)}${rpad('volume WL1X', 14)}`);
  bar();
  ws.forEach((w) => console.log(`  ${pad('w' + String(w.wallet_idx).padStart(2, '0'), 8)}${pad(w.wallet_address || '-', 44)}` +
    `${rpad(w.executed, 6)}${rpad(n(w.volume), 14)}`));

  // ---- why trades were skipped ----
  const [skips] = await db.query(`
    SELECT reason, COUNT(*) c FROM qdex_volume_trades ${W}${W ? ' AND' : 'WHERE'} status='skipped'
    GROUP BY reason ORDER BY c DESC LIMIT 10`, params);
  if (skips.length) {
    console.log('\n  skip reasons');
    bar();
    skips.forEach((s) => console.log(`  ${rpad(s.c, 5)}  ${String(s.reason || '').slice(0, 64)}`));
  }

  // ---- transfers ----
  const [xf] = await db.query(`
    SELECT kind, token_symbol, COUNT(*) c, SUM(amount) total
    FROM qdex_volume_transfers ${W} GROUP BY kind, token_symbol ORDER BY kind, total DESC`, params);
  if (xf.length) {
    console.log('\n  transfers');
    bar();
    xf.forEach((x) => console.log(`  ${pad(x.kind, 10)}${pad(x.token_symbol || '-', 10)}${rpad(x.c, 5)} tx   ${n(x.total)}`));
  }

  // ---- epochs ----
  const [eps] = await db.query(`
    SELECT e.id, e.status, e.wallet_count, e.created_at, e.expires_at, e.retired_at,
           (SELECT COUNT(*) FROM qdex_volume_trades t WHERE t.epoch_id = e.id AND t.status='executed') trades
    FROM qdex_volume_epochs e ORDER BY e.id DESC LIMIT 8`);
  if (eps.length) {
    console.log('\n  epochs');
    bar();
    console.log(`  ${pad('id', 5)}${pad('status', 10)}${rpad('wallets', 8)}${rpad('trades', 8)}   created -> expires`);
    eps.forEach((e) => console.log(`  ${pad(e.id, 5)}${pad(e.status, 10)}${rpad(e.wallet_count, 8)}${rpad(e.trades, 8)}   ` +
      `${e.created_at} -> ${e.expires_at || '-'}${e.retired_at ? '  (retired ' + e.retired_at + ')' : ''}`));
  }

  console.log('');
  await db.end().catch(() => {});
})().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(1); });
