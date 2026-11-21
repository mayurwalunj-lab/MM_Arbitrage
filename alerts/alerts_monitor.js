#!/usr/bin/env node

'use strict';

// ALERTS MONITOR — read-only watcher that sends Telegram alerts. It never
// places, cancels or moves anything. Every ALERT_POLL_MS it checks:
//   1. DEX: Uniswap L1X price vs the floor (below / near / back to ok), and
//      every Uniswap swap of at least ALERT_DEX_SWAP_MIN_USD.
//   2. Grid book: the LBank grid's own open orders — an empty side, depth within
//      1% under ALERT_GRID_MIN_DEPTH_USD, or spread over 1% (after it lasts
//      ALERT_GRID_BAD_POLLS checks in a row, so a refresh doesn't trigger it).
//   3. Bots: a pm2 app leaving 'online', coming back, or restarting.
//   4. Fills: grid fills (lbank_grid_log FILLED) adding up to ALERT_FILL_USD on
//      one side within ALERT_FILL_WINDOW_MIN. The grid logs fills at its refresh,
//      so these arrive up to ~10 minutes late.
//   5. Not trading: a bot in pm2 whose last trade / activity is older than its
//      ALERT_IDLE_*_MIN (or that pm2 shows stopped), with how long and why, read
//      from its log (or the QDex peg bot's skip note). "No trade room" gets its
//      own alert. A message when it trades again. Crash-loops (many restarts).
//   6. Balances: LBank bot A, bot B and grid USDT / L1X, alert when low.
//   7. Status report every ALERT_STATUS_EVERY_MIN and on /status sent to the bot:
//      bots, grid depth within 1% and spread vs 1%, grid fills, balances.
//   Each grid fill (buy / sell) is also sent as it is logged (ALERT_FILL_EACH).
//
//   node alerts/alerts_monitor.js          loop
//   node alerts/alerts_monitor.js --once   two rounds, print the result, exit
//   node alerts/alerts_monitor.js --status two rounds, print the status report, exit
//   node alerts/alerts_monitor.js --test   send a test message and exit
//
// Without TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, alerts are only logged.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const { execFile } = require('child_process');
const ccxt = require('ccxt');
const mysql = require('mysql2/promise');
const { ethers } = require('ethers');
const telegram = require('../shared/telegram');
const uni = require('../uniswap/lib');
const fs = require('fs');
const dotenv = require('dotenv');
const { dexZone, blockChunks, gridBookHealth, pm2Changes, recentFills, createAlerter, fmtAgo, lastReason, recentRestarts } = require('./checks');

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}
function envOn(name) { return (process.env[name] || 'true').toLowerCase() !== 'false'; }
function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utc = () => new Date().toISOString().slice(11, 16) + ' UTC';

const SELF = 'alerts_monitor';
const CONFIG = {
  pollMs: envNum('ALERT_POLL_MS', 60000),
  cooldownMs: envNum('ALERT_COOLDOWN_MIN', 30) * 60000,
  failAfter: envNum('ALERT_FAIL_AFTER', 5), // read failures in a row before alerting
  dex: {
    on: envOn('ALERT_DEX'),
    floor: envNum('ALERT_DEX_FLOOR', envNum('BAND_ABS_MIN', 7)),
    nearPct: envNum('ALERT_DEX_NEAR_PCT', 3),
    swapMinUsd: envNum('ALERT_DEX_SWAP_MIN_USD', 50),
    logChunkBlocks: Math.max(1, envNum('ALERT_DEX_LOG_CHUNK_BLOCKS', 10)),
    logMaxBlocks: Math.max(1, envNum('ALERT_DEX_LOG_MAX_BLOCKS', 50))
  },
  grid: {
    on: envOn('ALERT_GRID'),
    pair: 'L1X/USDT',
    minDepthUsd: envNum('ALERT_GRID_MIN_DEPTH_USD', 500),
    badPolls: envNum('ALERT_GRID_BAD_POLLS', 3)
  },
  pm2: {
    on: envOn('ALERT_PM2'),
    exclude: new Set([SELF, ...(process.env.ALERT_PM2_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean)]),
    crashRestarts: envNum('ALERT_CRASH_RESTARTS', 3),
    crashWindowMs: envNum('ALERT_CRASH_WINDOW_MIN', 10) * 60000
  },
  fills: {
    on: envOn('ALERT_FILLS'),
    usd: envNum('ALERT_FILL_USD', 100),
    windowMs: envNum('ALERT_FILL_WINDOW_MIN', 10) * 60000,
    each: envOn('ALERT_FILL_EACH'),             // a message for every grid fill (buy / sell)
    eachMinUsd: envNum('ALERT_FILL_EACH_MIN_USD', 0)
  },
  trading: {
    on: envOn('ALERT_TRADING'),
    repeatMs: envNum('ALERT_IDLE_REPEAT_MIN', 60) * 60000, // reminder while a bot stays idle
    logSilentMin: envNum('ALERT_LOG_SILENT_MIN', 10),
    qvtEnvFile: process.env.ALERT_QVT_ENV_FILE || '/opt/Qdex_volume_trading/qdex_vol_trading/.env'
  },
  balances: {
    on: envOn('ALERT_BALANCES'),
    everyMs: envNum('ALERT_BAL_EVERY_MIN', 10) * 60000,
    volMinUsdt: envNum('ALERT_BAL_VOL_MIN_USDT', 20),
    volMinL1xUsd: envNum('ALERT_BAL_VOL_MIN_L1X_USD', 20),
    gridMinUsdt: envNum('ALERT_BAL_GRID_MIN_USDT', 100),
    gridMinL1xUsd: envNum('ALERT_BAL_GRID_MIN_L1X_USD', 300)
  },
  status: {
    everyMs: envNum('ALERT_STATUS_EVERY_MIN', 60) * 60000 // 0 = only on /status
  }
};

// Bots checked for "online but not trading". `sql` returns the time of the last
// real trade/activity (t) and the DB clock (dbnow). clock 'db': the table is
// stamped by the DB's NOW(); 'local': stamped by the bot's own (server) clock.
// Bots that aren't in pm2 are skipped.
const BOTS = [
  { name: 'LBank volume', pm2: 'Lbank_Pattern_Trading', db: 'mm', clock: 'db', what: 'trade', idleMin: envNum('ALERT_IDLE_VOLUME_MIN', 15),
    sql: 'SELECT MAX(`timestamp`) AS t, NOW() AS dbnow FROM lbank_trade_history WHERE is_dry_run = 0' },
  { name: 'BitMart volume', pm2: 'Bitmart_Pattern_Trading', db: 'mm', clock: 'db', what: 'trade', idleMin: envNum('ALERT_IDLE_VOLUME_MIN', 15),
    sql: 'SELECT MAX(`timestamp`) AS t, NOW() AS dbnow FROM bitmart_trade_history WHERE is_dry_run = 0' },
  { name: 'LBank grid', pm2: 'LBank_GridManager', db: 'mm', clock: 'db', what: 'order placed', idleMin: envNum('ALERT_IDLE_GRID_MIN', 25),
    sql: "SELECT MAX(created_at) AS t, NOW() AS dbnow FROM lbank_grid_log WHERE action = 'PLACED' AND is_dry_run = 0" },
  { name: 'BitMart grid', pm2: 'grid_manager_bitmart', db: 'mm', clock: 'db', what: 'order placed', idleMin: envNum('ALERT_IDLE_GRID_MIN', 25),
    sql: "SELECT MAX(created_at) AS t, NOW() AS dbnow FROM bitmart_grid_log WHERE action = 'PLACED' AND is_dry_run = 0" },
  { name: 'QDex peg', pm2: 'qdex_mm', db: 'mm', clock: 'local', what: 'check', idleMin: envNum('ALERT_IDLE_QDEX_MM_MIN', 30),
    sql: "SELECT MAX(`timestamp`) AS t, NOW() AS dbnow FROM qdex_actions WHERE status IN ('observed', 'executed') AND is_dry_run = 0",
    reasonSql: "SELECT note FROM qdex_actions WHERE status = 'skipped' ORDER BY id DESC LIMIT 1" },
  { name: 'QDex volume', pm2: 'qdex_volume', db: 'qvt', clock: 'local', what: 'swap', idleMin: envNum('ALERT_IDLE_QDEX_VOL_MIN', 30),
    sql: "SELECT MAX(`timestamp`) AS t, NOW() AS dbnow FROM qdex_volume_trades WHERE status = 'executed' AND is_dry_run = 0" }
];

const alerter = createAlerter({ send: telegram.send, cooldownMs: CONFIG.cooldownMs });
const fails = {};
async function readFailed(key, what, err) {
  fails[key] = (fails[key] || 0) + 1;
  log(`${what} failed (${fails[key]}x): ${String(err && err.message || err).slice(0, 160)}`);
  if (fails[key] === CONFIG.failAfter) {
    await alerter.raise(`fail:${key}`, `⚠️ L1X alerts: can't read ${what} (${fails[key]} tries in a row). Last error: ${String(err && err.message || err).slice(0, 200)}`);
  }
}
async function readOk(key, what) {
  fails[key] = 0;
  await alerter.clear(`fail:${key}`, `✅ L1X alerts: reading ${what} works again.`);
}

// ── 1. DEX price + swaps ────────────────────────────────────────────────────
const SWAP = new ethers.Interface(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)']);
const dexState = { cfg: null, provider: null, lastBlock: null, zone: null };

async function reportSwaps(m, eth, usdAt, from, to) {
  const { cfg, provider } = dexState;
  const l1xIs0 = m.pool.token0.toLowerCase() === m.l1x.address.toLowerCase();
  for (const [a, b] of blockChunks(from, to, CONFIG.dex.logChunkBlocks)) {
    const logs = await provider.getLogs({ address: cfg.poolAddress, topics: [SWAP.getEvent('Swap').topicHash], fromBlock: a, toBlock: b });
    for (const l of logs) {
      const e = SWAP.parseLog(l);
      const l1xRaw = l1xIs0 ? e.args.amount0 : e.args.amount1;
      const wethRaw = l1xIs0 ? e.args.amount1 : e.args.amount0;
      const l1x = -Number(ethers.formatUnits(l1xRaw, m.l1x.decimals)); // + = bought from the pool
      const usd = Math.abs(Number(ethers.formatUnits(wethRaw, m.weth.decimals))) * eth.price;
      if (usd < CONFIG.dex.swapMinUsd) continue;
      await telegram.send(`${l1x > 0 ? '🟢 DEX BUY' : '🔴 DEX SELL'} ${Math.abs(l1x).toFixed(2)} L1X (~$${usd.toFixed(0)}) on Uniswap\nprice after: $${usdAt(e.args.sqrtPriceX96).toFixed(4)}\nwallet: ${e.args.recipient}\ntx: https://etherscan.io/tx/${l.transactionHash}`);
    }
  }
}

async function checkDex() {
  if (!dexState.cfg) {
    dexState.cfg = uni.getConfig();
    dexState.provider = uni.getProvider(dexState.cfg);
  }
  const { cfg, provider } = dexState;
  const m = await uni.loadMarket(cfg, provider);
  const eth = await uni.resolveEthUsdPrice({ config: cfg, log: () => {} });
  const usdAt = (sqrtPriceX96) => uni.poolL1xUsdPrice({ sqrtPriceX96, pool: m.pool, l1x: m.l1x, weth: m.weth, ethUsdPrice: eth.price });
  const price = usdAt(m.pool.sqrtPriceX96);
  const latest = await provider.getBlockNumber();

  // swaps since the last check. Read in chunks of ALERT_DEX_LOG_CHUNK_BLOCKS
  // (free RPC plans allow only ~10 blocks per eth_getLogs) and look back at
  // most ALERT_DEX_LOG_MAX_BLOCKS. A failed read skips those blocks and moves
  // on, so the range can't keep growing, and never blocks the price check.
  if (dexState.lastBlock != null && latest > dexState.lastBlock) {
    const from = Math.max(dexState.lastBlock + 1, latest - CONFIG.dex.logMaxBlocks + 1);
    try {
      await reportSwaps(m, eth, usdAt, from, latest);
      await readOk('dexswaps', 'Uniswap swaps');
    } catch (e) {
      await readFailed('dexswaps', `Uniswap swaps (blocks ${from}-${latest}, skipped)`, e);
    }
  }
  dexState.lastBlock = latest;

  const zone = dexZone(price, CONFIG.dex.floor, CONFIG.dex.nearPct);
  if (zone !== dexState.zone) {
    const was = dexState.zone;
    dexState.zone = zone;
    const p = `$${price.toFixed(4)} (ETH $${Number(eth.price).toFixed(0)})`;
    if (zone === 'below') await alerter.raise('dex:below', `🚨 DEX L1X ${p} is BELOW the $${CONFIG.dex.floor} floor — ${utc()}`);
    else await alerter.clear('dex:below', was === 'below' ? `✅ DEX L1X back above the $${CONFIG.dex.floor} floor: ${p}` : null);
    if (zone === 'near') await alerter.raise('dex:near', `⚠️ DEX L1X ${p} is within ${CONFIG.dex.nearPct}% of the $${CONFIG.dex.floor} floor — ${utc()}`);
    else if (zone === 'ok') await alerter.clear('dex:near', was ? `✅ DEX L1X ${p}, more than ${CONFIG.dex.nearPct}% above the floor` : null);
  }
  return { price, zone };
}

// ── 2. Grid book ────────────────────────────────────────────────────────────
const gridState = { ex: null, bad: 0 };

async function checkGrid() {
  if (!gridState.ex) {
    if (!process.env.LBANK_GRID_API_KEY || !process.env.LBANK_GRID_SECRET) throw new Error('LBANK_GRID_API_KEY / LBANK_GRID_SECRET not set');
    const ex = new ccxt.lbank({ apiKey: process.env.LBANK_GRID_API_KEY, secret: process.env.LBANK_GRID_SECRET, enableRateLimit: true, timeout: 20000, options: { defaultType: 'spot', adjustForTimeDifference: true } });
    ex.has.fetchCurrencies = false; // see LBank_GridManager: that endpoint is rate-limited and blocks startup
    await ex.loadMarkets();
    gridState.ex = ex;
  }
  const orders = await gridState.ex.fetchOpenOrders(CONFIG.grid.pair);
  const h = gridBookHealth(orders, { minDepthUsd: CONFIG.grid.minDepthUsd });
  if (h.problems.length) {
    gridState.bad++;
    if (gridState.bad >= CONFIG.grid.badPolls) {
      await alerter.raise('grid', `🚨 LBank grid book: ${h.problems.join('; ')}\nbuys ${h.buys} / sells ${h.sells}` +
        (h.bestBid ? ` | best bid $${h.bestBid.toFixed(4)}` : '') + (h.bestAsk ? ` | best ask $${h.bestAsk.toFixed(4)}` : '') +
        ` — for ${gridState.bad} checks (${utc()})`);
    }
  } else {
    gridState.bad = 0;
    await alerter.clear('grid', `✅ LBank grid book OK: buys ${h.buys} / sells ${h.sells}, within 1% $${h.buyDepth.toFixed(0)} / $${h.sellDepth.toFixed(0)}, spread ${h.spreadPct.toFixed(2)}%`);
  }
  return h;
}

// ── 3. pm2 bots ─────────────────────────────────────────────────────────────
const pm2State = { prev: null, apps: {}, restartTimes: {} };

function pm2List() {
  return new Promise((resolve, reject) => {
    execFile('pm2', ['jlist'], { timeout: 20000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout.slice(stdout.indexOf('[')))); } catch (e) { reject(e); }
    });
  });
}

// Every pm2 app: status, restarts, log files (also used by the trading check).
async function readPm2Apps() {
  const apps = {};
  for (const p of await pm2List()) {
    const env = p.pm2_env || {};
    apps[p.name] = {
      status: env.status, restarts: Number(env.restart_time) || 0, oneShot: env.autorestart === false,
      outLog: env.pm_out_log_path, errLog: env.pm_err_log_path
    };
  }
  pm2State.apps = apps;
  return apps;
}

async function checkPm2() {
  const curr = {};
  for (const [name, a] of Object.entries(await readPm2Apps())) {
    if (CONFIG.pm2.exclude.has(name) || a.oneShot) continue; // cron one-shots stop by design
    curr[name] = { status: a.status, restarts: a.restarts };
  }
  const now = Date.now();
  if (pm2State.prev) {
    for (const ev of pm2Changes(pm2State.prev, curr)) {
      if (ev.kind === 'down' || ev.kind === 'gone') await alerter.raise(`pm2:${ev.name}`, `🛑 BOT ${ev.text} — ${utc()}`);
      else if (ev.kind === 'up') await alerter.clear(`pm2:${ev.name}`, `✅ BOT ${ev.text}`);
      else await alerter.raise(`pm2r:${ev.name}`, `🔁 BOT ${ev.text} — ${utc()}`);
      if (ev.kind === 'restart') {
        const n = curr[ev.name].restarts - pm2State.prev[ev.name].restarts;
        const times = pm2State.restartTimes[ev.name] || [];
        for (let i = 0; i < n; i++) times.push(now);
        pm2State.restartTimes[ev.name] = times;
      }
    }
  }
  // crash loop: many restarts in a short window
  for (const [name, times] of Object.entries(pm2State.restartTimes)) {
    const recent = recentRestarts(times, now, CONFIG.pm2.crashWindowMs);
    pm2State.restartTimes[name] = recent;
    const mins = CONFIG.pm2.crashWindowMs / 60000;
    if (recent.length >= CONFIG.pm2.crashRestarts) {
      await alerter.raise(`crash:${name}`, `🔁 ${name} is CRASH-LOOPING: ${recent.length} restarts in the last ${mins} min — ${utc()}`);
    } else {
      await alerter.clear(`crash:${name}`, null);
    }
  }
  pm2State.prev = curr;
  return curr;
}

// ── 4. Grid fills ───────────────────────────────────────────────────────────
const fillState = { pool: null, lastId: null, fills: [], hist: [] };
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

// One message per check listing every new grid fill, buys and sells apart.
async function reportEachFill(fills) {
  if (!fills.length) return;
  const part = (side, icon) => {
    const fs_ = fills.filter((f) => f.side === side);
    if (!fs_.length) return null;
    const usd = fs_.reduce((t, f) => t + f.usd, 0);
    const amt = fs_.reduce((t, f) => t + f.amount, 0);
    return `${icon} GRID ${side.toUpperCase()} filled: ${fs_.length} order(s), ${amt.toFixed(2)} L1X, $${usd.toFixed(2)}\n` +
      fs_.map((f) => `   ${f.amount.toFixed(2)} L1X @ $${f.price.toFixed(4)} = $${f.usd.toFixed(2)} (${hhmm(f.filledAt)} UTC)`).join('\n');
  };
  const msg = [part('buy', '🟢'), part('sell', '🔴')].filter(Boolean).join('\n');
  await telegram.send(`${msg}\n(LBank grid logs fills at its refresh, so up to ~10 min late)`);
}

function mmPool() {
  if (!fillState.pool) fillState.pool = mysql.createPool({ ...gridDbConfig(), connectionLimit: 2, connectTimeout: 10000 });
  return fillState.pool;
}

function gridDbConfig() {
  const pick = (k) => process.env[`DB_${k}`] || process.env[`LBANK_DB_${k}`] || '';
  const c = { host: pick('HOST'), port: Number(pick('PORT') || 3306), user: pick('USER'), password: pick('PASSWORD'), database: pick('NAME') };
  if (!c.host || !c.user || !c.database) throw new Error('DB_HOST / DB_USER / DB_NAME not set');
  return c;
}

async function checkFills() {
  mmPool();
  if (fillState.lastId == null) { // start from now: don't alert on history, but keep 24h for the status report
    const [[r]] = await fillState.pool.query("SELECT COALESCE(MAX(id), 0) AS id FROM lbank_grid_log");
    fillState.lastId = Number(r.id);
    const [old] = await fillState.pool.query(
      "SELECT side, price, amount, value_usdt, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS ago FROM lbank_grid_log " +
      "WHERE action = 'FILLED' AND is_dry_run = 0 AND created_at > NOW() - INTERVAL 1 DAY"
    );
    const now = Date.now();
    fillState.hist = old.map((r) => ({
      filledAt: now - (Number(r.ago) || 0) * 1000, side: r.side, price: Number(r.price), amount: Number(r.amount),
      usd: r.value_usdt != null ? Number(r.value_usdt) : Number(r.price) * Number(r.amount)
    }));
    return null;
  }
  const [rows] = await fillState.pool.query(
    "SELECT id, side, price, amount, value_usdt, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS ago FROM lbank_grid_log " +
    "WHERE action = 'FILLED' AND is_dry_run = 0 AND id > ? ORDER BY id LIMIT 500",
    [fillState.lastId]
  );
  const now = Date.now();
  const fresh = [];
  for (const r of rows) {
    fillState.lastId = Math.max(fillState.lastId, Number(r.id));
    const usd = r.value_usdt != null ? Number(r.value_usdt) : Number(r.price) * Number(r.amount);
    if (!Number.isFinite(usd)) continue;
    const f = { at: now, filledAt: now - (Number(r.ago) || 0) * 1000, side: r.side, usd, price: Number(r.price), amount: Number(r.amount) };
    fillState.fills.push(f);
    fillState.hist.push(f);
    fresh.push(f);
  }
  fillState.hist = fillState.hist.filter((f) => now - f.filledAt <= 24 * 3600000);
  if (CONFIG.fills.each) await reportEachFill(fresh.filter((f) => f.usd >= CONFIG.fills.eachMinUsd));
  const w = recentFills(fillState.fills, now, CONFIG.fills.windowMs);
  fillState.fills = w.kept;
  const mins = CONFIG.fills.windowMs / 60000;
  if (w.buyUsd >= CONFIG.fills.usd || w.sellUsd >= CONFIG.fills.usd) {
    const prices = w.kept.map((f) => f.price);
    await alerter.raise('fills', `💰 BIG GRID FILLS (last ${mins} min): bought $${w.buyUsd.toFixed(0)}, sold $${w.sellUsd.toFixed(0)} in ${w.count} order(s), $${Math.min(...prices).toFixed(4)}-$${Math.max(...prices).toFixed(4)} — ${utc()}`);
  } else {
    await alerter.clear('fills', null);
  }
  return w;
}

// ── 5. Bots online but not trading ──────────────────────────────────────────
// For each bot in pm2: time since its last trade / activity (from its DB table),
// and why it stopped (its newest log line matching a known reason, or for the
// QDex peg bot its own skip note). Alerts after the bot's idle limit; a "no
// trade room" reason gets its own alert; a recovery message when it trades.
const tradeState = { qvtPool: null, bots: {} };

function qvtPool() {
  if (tradeState.qvtPool) return tradeState.qvtPool;
  if (!fs.existsSync(CONFIG.trading.qvtEnvFile)) throw new Error(`QDex volume .env not found: ${CONFIG.trading.qvtEnvFile}`);
  const e = dotenv.parse(fs.readFileSync(CONFIG.trading.qvtEnvFile));
  if (!e.DB_HOST || !e.DB_USER || !e.DB_NAME) throw new Error(`DB_HOST / DB_USER / DB_NAME missing in ${CONFIG.trading.qvtEnvFile}`);
  tradeState.qvtPool = mysql.createPool({ host: e.DB_HOST, port: Number(e.DB_PORT || 3306), user: e.DB_USER, password: e.DB_PASSWORD || '', database: e.DB_NAME, connectionLimit: 1, connectTimeout: 10000 });
  return tradeState.qvtPool;
}

// Last ~48 KB of a log file as lines, plus its last-modified time.
function readTail(file, bytes = 48 * 1024) {
  if (!file || !fs.existsSync(file)) return { lines: [], mtime: 0 };
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return { lines: buf.toString('utf8').split('\n').slice(1), mtime: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

async function botReason(bot, app) {
  if (bot.reasonSql) {
    const [rows] = await (bot.db === 'qvt' ? qvtPool() : mmPool()).query(bot.reasonSql);
    if (rows.length && rows[0].note) {
      const r = lastReason([rows[0].note]);
      return { kind: r ? r.kind : 'skipped', label: r ? r.label : 'skipping', line: String(rows[0].note).slice(0, 220), silentMin: null };
    }
  }
  // newest log first (stdout vs stderr)
  const logs = [readTail(app.outLog), readTail(app.errLog)].sort((a, b) => b.mtime - a.mtime);
  let reason = null;
  for (const l of logs) { reason = lastReason(l.lines); if (reason) break; }
  const newest = logs[0].mtime;
  const silentMin = newest ? (Date.now() - newest) / 60000 : null;
  return { ...(reason || { kind: 'unknown', label: 'no reason in the log', line: '' }), silentMin };
}

async function checkTrading() {
  const apps = Object.keys(pm2State.apps).length ? pm2State.apps : await readPm2Apps();
  const out = [];
  for (const bot of BOTS) {
    const app = apps[bot.pm2];
    if (!app) continue; // not deployed
    const [[row]] = await (bot.db === 'qvt' ? qvtPool() : mmPool()).query(bot.sql);
    const t = row && row.t ? new Date(row.t).getTime() : null;
    const ref = bot.clock === 'db' ? new Date(row.dbnow).getTime() : Date.now();
    const agoSec = t != null ? Math.max(0, (ref - t) / 1000) : null;
    const lastAt = agoSec != null ? Date.now() - agoSec * 1000 : null;
    const online = app.status === 'online';
    const idle = !online || agoSec == null || agoSec > bot.idleMin * 60;
    const st = tradeState.bots[bot.name] || {};
    const lastTxt = lastAt ? `last ${bot.what}: ${hhmm(lastAt)} UTC (${fmtAgo(agoSec)} ago)` : `no ${bot.what} recorded yet`;
    const rep = { cooldownMs: CONFIG.trading.repeatMs };
    const idleKey = `idle:${bot.name}`, roomKey = `room:${bot.name}`;
    let reason = null;

    if (!online) {
      await alerter.clear(roomKey, null);
      await alerter.raise(idleKey, `🛑 ${bot.name} STOPPED (pm2: ${app.status}) — not trading for ${fmtAgo(agoSec)}\n${lastTxt}`, rep);
    } else if (idle) {
      reason = await botReason(bot, app);
      const silent = reason.silentMin != null && reason.silentMin >= CONFIG.trading.logSilentMin ? `\n⚠️ log silent for ${fmtAgo(reason.silentMin * 60)} (hung?)` : '';
      if (reason.kind === 'room') {
        await alerter.clear(idleKey, null);
        await alerter.raise(roomKey, `⚠️ ${bot.name}: NO TRADE ROOM — no ${bot.what} for ${fmtAgo(agoSec)}\nreason: ${reason.label}\n› ${reason.line}\n${lastTxt}${silent}`, rep);
      } else {
        await alerter.clear(roomKey, null);
        await alerter.raise(idleKey, `🟠 ${bot.name} NOT TRADING for ${fmtAgo(agoSec)}\nreason: ${reason.label}${reason.line ? `\n› ${reason.line}` : ''}\n` +
          `pm2: online, ${app.restarts} restarts\n${lastTxt}${silent}`, rep);
      }
    } else {
      const wasIdle = alerter.isActive(idleKey) || alerter.isActive(roomKey);
      const gap = st.lastAt && lastAt ? fmtAgo((lastAt - st.lastAt) / 1000) : 'a while';
      await alerter.clear(roomKey, null);
      await alerter.clear(idleKey, null);
      if (wasIdle) await telegram.send(`✅ ${bot.name} trading again — was idle ${gap}. ${lastTxt}`);
    }
    tradeState.bots[bot.name] = { lastAt, agoSec, online, idle, status: app.status, restarts: app.restarts, reason, what: bot.what, idleMin: bot.idleMin };
    out.push({ name: bot.name, online, idle, ago: agoSec != null ? Math.round(agoSec) : null, reason: reason && reason.kind });
  }
  return out;
}

// ── 6. Balances: LBank bot A, bot B, grid ───────────────────────────────────
const balState = { ex: {}, at: 0, rows: null, price: null };
const BAL_ACCOUNTS = [
  { name: 'botA', role: 'vol', key: 'LBANK_BOT_A_API_KEY', secret: 'LBANK_BOT_A_SECRET' },
  { name: 'botB', role: 'vol', key: 'LBANK_BOT_B_API_KEY', secret: 'LBANK_BOT_B_SECRET' },
  { name: 'grid', role: 'grid', key: 'LBANK_GRID_API_KEY', secret: 'LBANK_GRID_SECRET' }
];

function lbankClient(acc) {
  if (balState.ex[acc.name]) return balState.ex[acc.name];
  if (!process.env[acc.key] || !process.env[acc.secret]) throw new Error(`${acc.key} / ${acc.secret} not set`);
  const ex = new ccxt.lbank({ apiKey: process.env[acc.key], secret: process.env[acc.secret], enableRateLimit: true, timeout: 20000, options: { defaultType: 'spot', adjustForTimeDifference: true } });
  ex.has.fetchCurrencies = false;
  balState.ex[acc.name] = ex;
  return ex;
}

async function readBalances() {
  const [[p]] = await mmPool().query('SELECT price FROM lbank_trade_history WHERE is_dry_run = 0 ORDER BY id DESC LIMIT 1');
  const price = p ? Number(p.price) : null;
  const rows = [];
  for (const acc of BAL_ACCOUNTS) {
    try {
      const b = await lbankClient(acc).fetchBalance();
      const g = (c, k) => Number((b[c] || {})[k]) || 0;
      rows.push({
        ...acc, usdt: g('USDT', 'total'), usdtUsed: g('USDT', 'used'), l1x: g('L1X', 'total'), l1xUsed: g('L1X', 'used'),
        l1xUsd: price ? g('L1X', 'total') * price : null
      });
    } catch (e) {
      rows.push({ ...acc, error: String(e.message).slice(0, 120) });
    }
  }
  balState.at = Date.now();
  balState.rows = rows;
  balState.price = price;
  return rows;
}

async function checkBalances() {
  if (balState.rows && Date.now() - balState.at < CONFIG.balances.everyMs) return null;
  const rows = await readBalances();
  if (rows.every((r) => r.error)) throw new Error(rows[0].error);
  const c = CONFIG.balances;
  for (const r of rows) {
    if (r.error) continue;
    const minUsdt = r.role === 'grid' ? c.gridMinUsdt : c.volMinUsdt;
    const minL1x = r.role === 'grid' ? c.gridMinL1xUsd : c.volMinL1xUsd;
    const low = [];
    if (r.usdt < minUsdt) low.push(`USDT ${r.usdt.toFixed(2)} < $${minUsdt}`);
    if (r.l1xUsd != null && r.l1xUsd < minL1x) low.push(`L1X ${r.l1x.toFixed(2)} (~$${r.l1xUsd.toFixed(0)}) < $${minL1x}`);
    if (low.length) await alerter.raise(`bal:${r.name}`, `💸 LBank ${r.name} balance LOW: ${low.join(', ')} — ${utc()}`, { cooldownMs: CONFIG.trading.repeatMs });
    else await alerter.clear(`bal:${r.name}`, `✅ LBank ${r.name} balance OK: USDT ${r.usdt.toFixed(2)}, L1X ${r.l1x.toFixed(2)}`);
  }
  return rows.map((r) => ({ name: r.name, usdt: r.usdt, l1x: r.l1x, error: r.error }));
}

// ── 7. Status report (every ALERT_STATUS_EVERY_MIN, and on /status) ──────────
const lastTick = {};

async function statusReport() {
  const L = [`📊 L1X status — ${utc()}`];

  L.push('\nBOTS');
  for (const bot of BOTS) {
    const s = tradeState.bots[bot.name];
    if (!s) continue;
    const ago = s.agoSec != null ? `${fmtAgo(s.agoSec)} ago` : 'never';
    if (!s.online) L.push(`🛑 ${bot.name}: STOPPED (pm2 ${s.status}) — last ${s.what} ${ago}`);
    else if (s.idle) L.push(`${s.reason && s.reason.kind === 'room' ? '⚠️' : '🟠'} ${bot.name}: NOT trading — last ${s.what} ${ago}${s.reason ? ` (${s.reason.label})` : ''}`);
    else L.push(`✅ ${bot.name}: trading — last ${s.what} ${ago}`);
  }
  const others = Object.entries(pm2State.apps).filter(([n]) => !BOTS.some((b) => b.pm2 === n));
  if (others.length) L.push(`other apps: ${others.map(([n, a]) => `${n} ${a.status === 'online' ? '✅' : `🛑 ${a.status}`}`).join(', ')}`);

  const h = lastTick.grid;
  if (h) {
    const mark = (v, ok) => `${v} ${ok ? '✅' : '❌'}`;
    L.push('\nLBANK GRID BOOK (within ±1% of mid)');
    L.push(`orders: ${h.buys} buy / ${h.sells} sell${h.mid ? ` | mid $${h.mid.toFixed(4)}` : ''}`);
    L.push(`buy depth: ${mark(`$${h.buyDepth.toFixed(0)}`, h.buyDepth >= CONFIG.grid.minDepthUsd)} (need ≥ $${CONFIG.grid.minDepthUsd})`);
    L.push(`sell depth: ${mark(`$${h.sellDepth.toFixed(0)}`, h.sellDepth >= CONFIG.grid.minDepthUsd)} (need ≥ $${CONFIG.grid.minDepthUsd})`);
    if (h.spreadPct != null) L.push(`spread: ${mark(`${h.spreadPct.toFixed(2)}%`, h.spreadPct <= 1)} (${h.spreadPct <= 1 ? 'less' : 'MORE'} than 1%)`);
    // nearest orders laid out like a book: sells (highest first), mid, buys
    const ord = (o) => `$${o.price.toFixed(4)}  ${o.amount.toFixed(2)} L1X  $${o.usd.toFixed(2)}`;
    L.push(`\nNEAREST ${h.topSells.length} SELL (grid)`);
    if (h.topSells.length) h.topSells.slice().reverse().forEach((o) => L.push(`🔴 ${ord(o)}`));
    else L.push('🔴 none');
    L.push(`— mid ${h.mid ? `$${h.mid.toFixed(4)}` : 'n/a'} —`);
    if (h.topBuys.length) h.topBuys.forEach((o) => L.push(`🟢 ${ord(o)}`));
    else L.push('🟢 none');
    L.push(`NEAREST ${h.topBuys.length} BUY (grid)`);
  }

  const now = Date.now();
  const sumFills = (ms) => {
    const f = fillState.hist.filter((x) => now - x.filledAt <= ms);
    const s = (side) => { const a = f.filter((x) => x.side === side); return `${a.length} ($${a.reduce((t, x) => t + x.usd, 0).toFixed(0)})`; };
    return `buy ${s('buy')} / sell ${s('sell')}`;
  };
  L.push('\nGRID FILLS');
  L.push(`last 1h: ${sumFills(3600000)}`);
  L.push(`last 24h: ${sumFills(24 * 3600000)}`);

  try { await readBalances(); } catch (e) { L.push(`\nBALANCES: can't read (${String(e.message).slice(0, 80)})`); }
  if (balState.rows) {
    L.push(`\nBALANCES (LBank${balState.price ? `, L1X @ $${balState.price.toFixed(4)}` : ''})`);
    for (const r of balState.rows) {
      if (r.error) { L.push(`${r.name}: can't read (${r.error.slice(0, 60)})`); continue; }
      const inOrd = (v) => (v > 0 ? ` (in orders ${v.toFixed(2)})` : '');
      L.push(`${r.name}: USDT ${r.usdt.toFixed(2)}${inOrd(r.usdtUsed)} | L1X ${r.l1x.toFixed(2)}${inOrd(r.l1xUsed)}${r.l1xUsd != null ? ` ~$${r.l1xUsd.toFixed(0)}` : ''}`);
    }
  }

  if (lastTick.dex && lastTick.dex.price) L.push(`\nDEX L1X $${lastTick.dex.price.toFixed(4)} (floor $${CONFIG.dex.floor})`);
  return L.join('\n');
}

// Wait until the next check, answering /status (and /help) sent to the bot.
const cmdState = { offset: undefined, startedSec: Math.floor(Date.now() / 1000) };
async function waitWithCommands(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const left = Math.floor((end - Date.now()) / 1000);
    if (!telegram.isEnabled() || left < 1) { await sleep(Math.max(0, end - Date.now())); return; }
    const r = await telegram.getCommands(cmdState.offset, Math.min(50, left));
    cmdState.offset = r.offset;
    if (!r.ok) { await sleep(Math.min(5000, Math.max(0, end - Date.now()))); continue; }
    for (const m of r.messages) {
      if (m.date < cmdState.startedSec) continue; // sent before this start
      if (/^\/status/i.test(m.text)) await telegram.send(await statusReport());
      else if (/^\/(help|start)/i.test(m.text)) await telegram.send('Commands:\n/status — bots trading or not, LBank grid depth and spread, grid fills, botA / botB / grid balances');
    }
  }
}

// ── loop ────────────────────────────────────────────────────────────────────
const CHECKS = [
  ['dex', 'the Uniswap price', CONFIG.dex.on, checkDex],
  ['grid', 'the LBank grid orders', CONFIG.grid.on, checkGrid],
  ['pm2', 'the pm2 process list', CONFIG.pm2.on, checkPm2],
  ['fills', 'the grid fills table', CONFIG.fills.on, checkFills],
  ['trading', 'the bots\' last trades', CONFIG.trading.on, checkTrading],
  ['balances', 'the LBank balances', CONFIG.balances.on, checkBalances]
];

async function tick() {
  const out = {};
  for (const [key, what, on, fn] of CHECKS) {
    if (!on) continue;
    try {
      out[key] = await fn();
      if (out[key] != null) lastTick[key] = out[key];
      await readOk(key, what);
    } catch (e) {
      await readFailed(key, what, e);
    }
  }
  return out;
}

function summary() {
  const on = CHECKS.filter((c) => c[2]).map((c) => c[0]).join(', ');
  const idle = BOTS.filter((b) => pm2State.apps[b.pm2]).map((b) => `${b.name} ${b.idleMin}m`).join(', ');
  return `✅ L1X alerts monitor started (${on}). DEX floor $${CONFIG.dex.floor}, near ${CONFIG.dex.nearPct}%, swaps >= $${CONFIG.dex.swapMinUsd}; ` +
    `grid depth >= $${CONFIG.grid.minDepthUsd} after ${CONFIG.grid.badPolls} checks; fills >= $${CONFIG.fills.usd}/${CONFIG.fills.windowMs / 60000} min` +
    `${CONFIG.fills.each ? ' + every fill' : ''}; not-trading after: ${idle || 'n/a'}; ` +
    `check every ${Math.round(CONFIG.pollMs / 1000)}s, repeat alerts every ${CONFIG.cooldownMs / 60000} min (idle: ${CONFIG.trading.repeatMs / 60000} min). ` +
    `Status report ${CONFIG.status.everyMs ? `every ${CONFIG.status.everyMs / 60000} min` : 'off'}; send /status any time.`;
}

async function main() {
  if (process.argv.includes('--test')) {
    const ok = await telegram.send(`🧪 L1X alerts test message — ${new Date().toISOString()}`);
    log(ok ? 'test message sent' : 'test message NOT sent (see above)');
    process.exit(ok ? 0 : 1);
  }
  if (!telegram.isEnabled()) log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alerts will only be logged.');
  if (process.argv.includes('--once') || process.argv.includes('--status')) {
    await tick();
    const r = await tick(); // second round: baselines are set, changes and swaps can show
    log(JSON.stringify({
      dex: r.dex, pm2: r.pm2 && Object.keys(r.pm2).length,
      grid: r.grid && { buys: r.grid.buys, sells: r.grid.sells, buyDepth: Math.round(r.grid.buyDepth), sellDepth: Math.round(r.grid.sellDepth), spreadPct: r.grid.spreadPct, problems: r.grid.problems },
      fills: r.fills && { buyUsd: r.fills.buyUsd, sellUsd: r.fills.sellUsd },
      trading: r.trading
    }));
    if (process.argv.includes('--status')) {
      const text = await statusReport();
      console.log(text);
      if (telegram.isEnabled()) await telegram.send(text);
    }
    process.exit(0);
  }
  await tick(); // first round: baselines (pm2 apps, fills, last trades)
  log(summary());
  await telegram.send(summary());
  let lastStatus = Date.now();
  for (;;) {
    await waitWithCommands(CONFIG.pollMs);
    await tick();
    if (CONFIG.status.everyMs && Date.now() - lastStatus >= CONFIG.status.everyMs) {
      lastStatus = Date.now();
      await telegram.send(await statusReport());
    }
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
