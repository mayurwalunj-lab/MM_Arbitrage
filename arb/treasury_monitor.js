#!/usr/bin/env node

'use strict';

// TREASURY MONITOR — runs the treasury sell/buy logic on a loop. It does NOT
// touch the CEX arbitrage; the CEX is only a price reference. Each tick runs
// arb/treasury_sell.js (sell and/or buy per TREASURY_MODE), which self-skips
// when there's no opportunity and records every run.
//
//   node arb/treasury_monitor.js              dry-run loop (simulate + record)
//   node arb/treasury_monitor.js --execute    LIVE loop (real sells/buys)
//
// Safety: HALT file pauses it; TREASURY_MAX_TRADES_PER_DAY caps live trades/day;
// TREASURY_COOLDOWN_MS waits after any action; dry-run is the default.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const db = require('./db');

const STATE_DIR = path.join(__dirname, 'state');
const HALT_FILE = path.join(STATE_DIR, 'HALT');
const SELL_SCRIPT = path.join(__dirname, 'treasury_sell.js');

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = {
  pollMs: envNum('TREASURY_POLL_MS', 30000),
  cooldownMs: envNum('TREASURY_COOLDOWN_MS', 60000),
  maxTradesPerDay: envNum('TREASURY_MAX_TRADES_PER_DAY', 20),
  mode: (process.env.TREASURY_MODE || 'both').toLowerCase()
};
// Live trading is enabled by the --execute flag OR TREASURY_EXECUTE=true in the
// env (so PM2 can toggle live/dry from .env without editing args). Dry-run is
// the default/fail-safe — anything other than 'true' simulates only.
const execute = process.argv.includes('--execute') ||
  (process.env.TREASURY_EXECUTE || '').toLowerCase() === 'true';

// Count today's real (non-dry) executed treasury trades, for the daily cap.
async function executedToday() {
  try {
    const cfg = db.dbConfig();
    if (!cfg) return 0;
    const conn = await mysql.createConnection({ ...cfg, connectTimeout: 8000 });
    const [[r]] = await conn.query(
      "SELECT COUNT(*) n FROM treasury_sells WHERE status='executed' AND is_dry_run=0 AND DATE(timestamp)=CURDATE()"
    );
    await conn.end();
    return r.n;
  } catch (_) { return 0; }
}

// Run the treasury script once for a direction; resolve true if it acted (sold/bought).
function runOnce(direction, live) {
  return new Promise((resolve) => {
    const args = [SELL_SCRIPT];
    if (direction === 'buy') args.push('--buy');
    if (live) args.push('--execute');
    let acted = false;
    const child = spawn('node', args, { env: process.env });
    child.stdout.on('data', (d) => {
      const s = d.toString();
      process.stdout.write(s);
      if (/DONE: (sold|bought)/.test(s) && !/\[DRY\]/.test(s)) acted = true;
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', () => resolve(acted));
  });
}

async function tick() {
  if (fs.existsSync(HALT_FILE)) { log('HALT present — skipping tick'); return false; }

  let live = execute;
  if (live) {
    const done = await executedToday();
    if (done >= CONFIG.maxTradesPerDay) {
      log(`daily cap reached (${done}/${CONFIG.maxTradesPerDay}) — observing only (dry) for the rest of today`);
      live = false;
    }
  }

  let acted = false;
  if (CONFIG.mode === 'sell' || CONFIG.mode === 'both') acted = (await runOnce('sell', live)) || acted;
  if (CONFIG.mode === 'buy' || CONFIG.mode === 'both') acted = (await runOnce('buy', live)) || acted;
  return acted;
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const liveSrc = process.argv.includes('--execute') ? '--execute flag' : ((process.env.TREASURY_EXECUTE || '').toLowerCase() === 'true' ? 'TREASURY_EXECUTE=true' : 'TREASURY_EXECUTE not set');
  log(`treasury monitor starting — mode=${CONFIG.mode} poll=${CONFIG.pollMs}ms ${execute ? `LIVE (real trades) [${liveSrc}]` : `DRY-RUN (simulate only) [${liveSrc}]`}`);
  log(`safety: HALT file pauses; max ${CONFIG.maxTradesPerDay} live trades/day; ${CONFIG.cooldownMs}ms cooldown after action`);
  const once = process.argv.includes('--once');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let acted = false;
    try { acted = await tick(); } catch (e) { log(`tick error: ${e.message}`); }
    if (once) break;
    await sleep(acted ? CONFIG.cooldownMs : CONFIG.pollMs);
  }
}

main().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
