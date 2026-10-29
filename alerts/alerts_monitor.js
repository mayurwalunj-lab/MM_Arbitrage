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
//
//   node alerts/alerts_monitor.js          loop
//   node alerts/alerts_monitor.js --once   one round, then exit
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
const { dexZone, gridBookHealth, pm2Changes, recentFills, createAlerter } = require('./checks');

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
    swapMinUsd: envNum('ALERT_DEX_SWAP_MIN_USD', 50)
  },
  grid: {
    on: envOn('ALERT_GRID'),
    pair: 'L1X/USDT',
    minDepthUsd: envNum('ALERT_GRID_MIN_DEPTH_USD', 500),
    badPolls: envNum('ALERT_GRID_BAD_POLLS', 3)
  },
  pm2: {
    on: envOn('ALERT_PM2'),
    exclude: new Set([SELF, ...(process.env.ALERT_PM2_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean)])
  },
  fills: {
    on: envOn('ALERT_FILLS'),
    usd: envNum('ALERT_FILL_USD', 100),
    windowMs: envNum('ALERT_FILL_WINDOW_MIN', 10) * 60000
  }
};

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

  // swaps since the last check (capped so a long outage doesn't ask for too much)
  if (dexState.lastBlock != null && latest > dexState.lastBlock) {
    const from = Math.max(dexState.lastBlock + 1, latest - 2000);
    const logs = await provider.getLogs({ address: cfg.poolAddress, topics: [SWAP.getEvent('Swap').topicHash], fromBlock: from, toBlock: latest });
    const l1xIs0 = m.pool.token0.toLowerCase() === m.l1x.address.toLowerCase();
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
const pm2State = { prev: null };

function pm2List() {
  return new Promise((resolve, reject) => {
    execFile('pm2', ['jlist'], { timeout: 20000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout.slice(stdout.indexOf('[')))); } catch (e) { reject(e); }
    });
  });
}

async function checkPm2() {
  const curr = {};
  for (const p of await pm2List()) {
    const env = p.pm2_env || {};
    if (CONFIG.pm2.exclude.has(p.name) || env.autorestart === false) continue; // cron one-shots stop by design
    curr[p.name] = { status: env.status, restarts: Number(env.restart_time) || 0 };
  }
  if (pm2State.prev) {
    for (const ev of pm2Changes(pm2State.prev, curr)) {
      if (ev.kind === 'down' || ev.kind === 'gone') await alerter.raise(`pm2:${ev.name}`, `🛑 BOT ${ev.text} — ${utc()}`);
      else if (ev.kind === 'up') await alerter.clear(`pm2:${ev.name}`, `✅ BOT ${ev.text}`);
      else await alerter.raise(`pm2r:${ev.name}`, `🔁 BOT ${ev.text} — ${utc()}`);
    }
  }
  pm2State.prev = curr;
  return curr;
}

// ── 4. Grid fills ───────────────────────────────────────────────────────────
const fillState = { pool: null, lastId: null, fills: [] };

function gridDbConfig() {
  const pick = (k) => process.env[`DB_${k}`] || process.env[`LBANK_DB_${k}`] || '';
  const c = { host: pick('HOST'), port: Number(pick('PORT') || 3306), user: pick('USER'), password: pick('PASSWORD'), database: pick('NAME') };
  if (!c.host || !c.user || !c.database) throw new Error('DB_HOST / DB_USER / DB_NAME not set');
  return c;
}

async function checkFills() {
  if (!fillState.pool) fillState.pool = mysql.createPool({ ...gridDbConfig(), connectionLimit: 2, connectTimeout: 10000 });
  if (fillState.lastId == null) { // start from now: don't alert on history
    const [[r]] = await fillState.pool.query("SELECT COALESCE(MAX(id), 0) AS id FROM lbank_grid_log");
    fillState.lastId = Number(r.id);
    return null;
  }
  const [rows] = await fillState.pool.query(
    "SELECT id, side, price, amount, value_usdt FROM lbank_grid_log WHERE action = 'FILLED' AND is_dry_run = 0 AND id > ? ORDER BY id LIMIT 500",
    [fillState.lastId]
  );
  const now = Date.now();
  for (const r of rows) {
    fillState.lastId = Math.max(fillState.lastId, Number(r.id));
    const usd = r.value_usdt != null ? Number(r.value_usdt) : Number(r.price) * Number(r.amount);
    if (Number.isFinite(usd)) fillState.fills.push({ at: now, side: r.side, usd, price: Number(r.price) });
  }
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

// ── loop ────────────────────────────────────────────────────────────────────
const CHECKS = [
  ['dex', 'the Uniswap price', CONFIG.dex.on, checkDex],
  ['grid', 'the LBank grid orders', CONFIG.grid.on, checkGrid],
  ['pm2', 'the pm2 process list', CONFIG.pm2.on, checkPm2],
  ['fills', 'the grid fills table', CONFIG.fills.on, checkFills]
];

async function tick() {
  const out = {};
  for (const [key, what, on, fn] of CHECKS) {
    if (!on) continue;
    try {
      out[key] = await fn();
      await readOk(key, what);
    } catch (e) {
      await readFailed(key, what, e);
    }
  }
  return out;
}

function summary() {
  const on = CHECKS.filter((c) => c[2]).map((c) => c[0]).join(', ');
  return `✅ L1X alerts monitor started (${on}). DEX floor $${CONFIG.dex.floor}, near ${CONFIG.dex.nearPct}%, swaps >= $${CONFIG.dex.swapMinUsd}; ` +
    `grid depth >= $${CONFIG.grid.minDepthUsd} after ${CONFIG.grid.badPolls} checks; fills >= $${CONFIG.fills.usd}/${CONFIG.fills.windowMs / 60000} min; ` +
    `check every ${Math.round(CONFIG.pollMs / 1000)}s, repeat alerts every ${CONFIG.cooldownMs / 60000} min.`;
}

async function main() {
  if (process.argv.includes('--test')) {
    const ok = await telegram.send(`🧪 L1X alerts test message — ${new Date().toISOString()}`);
    log(ok ? 'test message sent' : 'test message NOT sent (see above)');
    process.exit(ok ? 0 : 1);
  }
  if (!telegram.isEnabled()) log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alerts will only be logged.');
  if (process.argv.includes('--once')) {
    await tick();
    const r = await tick(); // second round: baselines are set, changes and swaps can show
    log(JSON.stringify({
      dex: r.dex, pm2: r.pm2 && Object.keys(r.pm2).length,
      grid: r.grid && { buys: r.grid.buys, sells: r.grid.sells, buyDepth: Math.round(r.grid.buyDepth), sellDepth: Math.round(r.grid.sellDepth), spreadPct: r.grid.spreadPct, problems: r.grid.problems },
      fills: r.fills && { buyUsd: r.fills.buyUsd, sellUsd: r.fills.sellUsd }
    }));
    process.exit(0);
  }
  log(summary());
  await telegram.send(summary());
  for (;;) {
    await tick();
    await sleep(CONFIG.pollMs);
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
