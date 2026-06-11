#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const args = new Set(process.argv.slice(2));
const shouldRunDb = args.has('--db') || args.has('--all');
const shouldRunPublicExchange = args.has('--public-exchange') || args.has('--all');
const shouldRunPrivateBalances = args.has('--private-balances');

dotenv.config({ path: ENV_PATH, quiet: true });

const activeFiles = [
  'bitmart/Bitmart_Pattern_Trading.js',
  'bitmart/grid_manager_bitmart.js',
  'bitmart/public/index.html',
  'lbank/Lbank_Pattern_Trading.js',
  'lbank/LBank_GridManager.js',
  'lbank/public/index.html',
  'dashboard/Server.js',
  'dashboard/index.html',
  'uniswap/uniswap_l1x_trader.js',
  'package.json',
  'package-lock.json',
  'ecosystem.config.js',
  'run-all.sh',
  '.env',
  '.gitignore'
];

const requiredEnvKeys = [
  'BITMART_BOT_A_API_KEY',
  'BITMART_BOT_A_SECRET',
  'BITMART_BOT_A_UID',
  'BITMART_BOT_B_API_KEY',
  'BITMART_BOT_B_SECRET',
  'BITMART_BOT_B_UID',
  'BITMART_GRID_API_KEY',
  'BITMART_GRID_SECRET',
  'BITMART_GRID_UID',
  'LBANK_BOT_A_API_KEY',
  'LBANK_BOT_A_SECRET',
  'LBANK_BOT_B_API_KEY',
  'LBANK_BOT_B_SECRET',
  'LBANK_GRID_API_KEY',
  'LBANK_GRID_SECRET',
  'BITMART_DB_HOST',
  'BITMART_DB_PORT',
  'BITMART_DB_USER',
  'BITMART_DB_PASSWORD',
  'BITMART_DB_NAME',
  'LBANK_DB_HOST',
  'LBANK_DB_PORT',
  'LBANK_DB_USER',
  'LBANK_DB_PASSWORD',
  'LBANK_DB_NAME',
  'DASHBOARD_PORT',
  'UNISWAP_CHAIN_ID',
  'L1X_TOKEN_ADDRESS',
  'L1X_WETH_POOL_ADDRESS',
  'WETH_ADDRESS',
  'UNISWAP_QUOTER_V2_ADDRESS',
  'UNISWAP_SWAP_ROUTER_02_ADDRESS',
  'UNISWAP_DEFAULT_SLIPPAGE_BPS',
  'UNISWAP_DEADLINE_SECONDS'
];

const optionalEnvKeys = [
  'ETH_RPC_URL',
  'ETH_USD_PRICE',
  'UNISWAP_WALLET_PRIVATE_KEY',
  'UNISWAP_WALLET_ADDRESS',
  'ARB_BITMART_API_KEY',
  'ARB_BITMART_SECRET',
  'ARB_BITMART_UID',
  'ARB_LBANK_API_KEY',
  'ARB_LBANK_SECRET'
];

const requiredPackages = ['ccxt', 'cors', 'dotenv', 'express', 'mysql2', 'socket.io'];

const checks = [];

function addCheck(name, fn) {
  checks.push({ name, fn });
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function file(filePath) {
  return path.join(ROOT, filePath);
}

function read(filePath) {
  return fs.readFileSync(file(filePath), 'utf8');
}

function run(command, options = {}) {
  return childProcess.execSync(command, {
    cwd: ROOT,
    stdio: options.stdio || 'pipe',
    encoding: 'utf8',
    env: process.env
  });
}

function envValue(key) {
  return String(process.env[key] || '').trim();
}

function parseEnvFile() {
  const found = new Map();
  const duplicate = [];
  for (const line of read('.env').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (found.has(match[1])) duplicate.push(match[1]);
    found.set(match[1], match[2]);
  }
  return { found, duplicate };
}

addCheck('required files exist', () => {
  for (const f of activeFiles) {
    assert(fs.existsSync(file(f)), `Missing ${f}`);
  }
});

addCheck('legacy folders are archived', () => {
  const legacyAtRoot = [
    'Market_Making_Bitmart',
    'Market_making_Lbank',
    'Market_making _Dashboard'
  ].filter((dir) => fs.existsSync(file(dir)));
  assert(legacyAtRoot.length === 0, `Legacy folders still at root: ${legacyAtRoot.join(', ')}`);
  assert(fs.existsSync(file('archive/legacy-projects')), 'archive/legacy-projects is missing');
});

addCheck('root node_modules and packages exist', () => {
  assert(fs.existsSync(file('node_modules')), 'node_modules missing. Run npm install.');
  for (const pkg of requiredPackages) {
    assert(fs.existsSync(file(`node_modules/${pkg}`)), `Missing package node_modules/${pkg}`);
  }
});

addCheck('package.json scripts point to clean folders', () => {
  const pkg = JSON.parse(read('package.json'));
  const scripts = Object.values(pkg.scripts || {}).join('\n');
  assert(!scripts.includes('Market_Making_Bitmart'), 'package scripts still reference Market_Making_Bitmart');
  assert(!scripts.includes('Market_making_Lbank'), 'package scripts still reference Market_making_Lbank');
  assert(!scripts.includes('Market_making _Dashboard'), 'package scripts still reference Market_making _Dashboard');
  assert(scripts.includes('bitmart/Bitmart_Pattern_Trading.js'), 'missing bitmart pattern script');
  assert(scripts.includes('lbank/Lbank_Pattern_Trading.js'), 'missing lbank pattern script');
  assert(scripts.includes('dashboard/Server.js'), 'missing dashboard script');
});

addCheck('ecosystem config has expected PM2 apps', () => {
  const ecosystem = require(file('ecosystem.config.js'));
  const apps = ecosystem.apps || [];
  const expected = new Map([
    ['Bitmart_Pattern_Trading', 'bitmart/Bitmart_Pattern_Trading.js'],
    ['grid_manager_bitmart', 'bitmart/grid_manager_bitmart.js'],
    ['Lbank_Pattern_Trading', 'lbank/Lbank_Pattern_Trading.js'],
    ['LBank_GridManager', 'lbank/LBank_GridManager.js'],
    ['Server', 'dashboard/Server.js']
  ]);
  assert(apps.length === expected.size, `Expected ${expected.size} PM2 apps, found ${apps.length}`);
  for (const app of apps) {
    assert(expected.has(app.name), `Unexpected PM2 app ${app.name}`);
    assert(app.script === expected.get(app.name), `Wrong script for ${app.name}: ${app.script}`);
    assert(app.cwd === ROOT, `Wrong cwd for ${app.name}`);
  }
});

addCheck('env keys are complete and non-empty', () => {
  const { found, duplicate } = parseEnvFile();
  assert(duplicate.length === 0, `Duplicate env keys: ${duplicate.join(', ')}`);
  const missing = requiredEnvKeys.filter((key) => !found.has(key));
  const empty = requiredEnvKeys.filter((key) => !envValue(key));
  const optionalMissing = optionalEnvKeys.filter((key) => !found.has(key));
  assert(missing.length === 0, `Missing env keys: ${missing.join(', ')}`);
  assert(empty.length === 0, `Empty env keys: ${empty.join(', ')}`);
  assert(optionalMissing.length === 0, `Missing optional env keys: ${optionalMissing.join(', ')}`);
});

addCheck('active process.env keys match .env', () => {
  const jsFiles = [
    'bitmart/Bitmart_Pattern_Trading.js',
    'bitmart/grid_manager_bitmart.js',
    'lbank/Lbank_Pattern_Trading.js',
    'lbank/LBank_GridManager.js',
    'dashboard/Server.js',
    'uniswap/uniswap_l1x_trader.js'
  ];
  const used = new Set();
  for (const f of jsFiles) {
    const text = read(f);
    for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      used.add(match[1]);
    }
  }
  const { found } = parseEnvFile();
  const missing = [...used].filter((key) => !found.has(key)).sort();
  const allowed = new Set([...requiredEnvKeys, ...optionalEnvKeys]);
  const unused = [...found.keys()].filter((key) => !used.has(key) && !allowed.has(key)).sort();
  assert(missing.length === 0, `Used env keys missing from .env: ${missing.join(', ')}`);
  assert(unused.length === 0, `Unused env keys in .env: ${unused.join(', ')}`);
});

addCheck('no hardcoded credentials in active JS', () => {
  const jsFiles = [
    'bitmart/Bitmart_Pattern_Trading.js',
    'bitmart/grid_manager_bitmart.js',
    'lbank/Lbank_Pattern_Trading.js',
    'lbank/LBank_GridManager.js',
    'dashboard/Server.js'
  ];
  const patterns = [
    /apiKey:\s*'[^']{8,}'/,
    /secret:\s*'[^']{8,}'/,
    /password:\s*'[^']{8,}'/,
    /erJsjak/
  ];
  const hits = [];
  for (const f of jsFiles) {
    const lines = read(f).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (patterns.some((pattern) => pattern.test(line))) hits.push(`${f}:${index + 1}`);
    });
  }
  assert(hits.length === 0, `Possible hardcoded credentials: ${hits.join(', ')}`);
});

addCheck('syntax check active JS', () => {
  run('npm run check');
});

addCheck('root npm audit has no high vulnerabilities', () => {
  try {
    run('npm audit --audit-level=high');
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
    const networkProblem = /socket hang up|audit endpoint returned an error|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(output);
    if (networkProblem) {
      console.log('     warning: npm audit endpoint was unavailable; rerun this check when network is stable');
      return;
    }
    throw error;
  }
});

addCheck('ports are expected', () => {
  assert(read('bitmart/Bitmart_Pattern_Trading.js').includes('server.listen(5010'), 'Bitmart pattern port is not 5010');
  assert(read('lbank/Lbank_Pattern_Trading.js').includes('server.listen(5001'), 'LBank pattern port is not 5001');
  assert(read('dashboard/Server.js').includes('DASHBOARD_PORT'), 'Dashboard does not use DASHBOARD_PORT');
});

addCheck('startup behavior is understood', () => {
  assert(read('bitmart/Bitmart_Pattern_Trading.js').includes('dryRun: true'), 'Bitmart pattern dryRun is not true');
  assert(read('lbank/Lbank_Pattern_Trading.js').includes('dryRun: true'), 'LBank pattern dryRun is not true');
  assert(read('bitmart/grid_manager_bitmart.js').includes('dryRun: false'), 'Bitmart grid dryRun is not false');
  assert(read('lbank/LBank_GridManager.js').includes('dryRun: false'), 'LBank grid dryRun is not false');
  assert(read('bitmart/grid_manager_bitmart.js').includes('startGridManager();'), 'Bitmart grid does not auto-start');
  assert(read('lbank/LBank_GridManager.js').includes('startGridManager();'), 'LBank grid does not auto-start');
});

async function checkDb() {
  const mysql = require('mysql2/promise');
  const configs = [
    {
      name: 'bitmart',
      config: {
        host: envValue('BITMART_DB_HOST'),
        port: Number(envValue('BITMART_DB_PORT')),
        user: envValue('BITMART_DB_USER'),
        password: envValue('BITMART_DB_PASSWORD'),
        database: envValue('BITMART_DB_NAME'),
        connectTimeout: 10000
      }
    },
    {
      name: 'lbank',
      config: {
        host: envValue('LBANK_DB_HOST'),
        port: Number(envValue('LBANK_DB_PORT')),
        user: envValue('LBANK_DB_USER'),
        password: envValue('LBANK_DB_PASSWORD'),
        database: envValue('LBANK_DB_NAME'),
        connectTimeout: 10000
      }
    }
  ];

  for (const item of configs) {
    const connection = await mysql.createConnection(item.config);
    try {
      await connection.ping();
      const [tables] = await connection.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('trade_history','inventory_snapshot','system_logs','grid_log')",
        [item.config.database]
      );
      const names = tables.map((row) => row.TABLE_NAME || row.table_name);
      assert(names.includes('trade_history'), `${item.name} DB missing trade_history`);
      assert(names.includes('inventory_snapshot'), `${item.name} DB missing inventory_snapshot`);
      assert(names.includes('system_logs'), `${item.name} DB missing system_logs`);
    } finally {
      await connection.end();
    }
  }
}

async function checkPublicExchange() {
  const ccxt = require('ccxt');
  const exchanges = [
    { name: 'bitmart', instance: new ccxt.bitmart({ enableRateLimit: true }) },
    { name: 'lbank', instance: new ccxt.lbank({ enableRateLimit: true }) }
  ];
  for (const item of exchanges) {
    await item.instance.loadMarkets();
    assert(item.instance.markets['L1X/USDT'], `${item.name} does not expose L1X/USDT`);
    const ticker = await item.instance.fetchTicker('L1X/USDT');
    assert(Number.isFinite(Number(ticker.last)) || Number.isFinite(Number(ticker.bid)) || Number.isFinite(Number(ticker.ask)), `${item.name} ticker has no usable price`);
  }
}

async function checkPrivateBalances() {
  const ccxt = require('ccxt');
  const exchanges = [
    {
      name: 'bitmart bot A',
      instance: new ccxt.bitmart({
        apiKey: envValue('BITMART_BOT_A_API_KEY'),
        secret: envValue('BITMART_BOT_A_SECRET'),
        uid: envValue('BITMART_BOT_A_UID'),
        enableRateLimit: true
      })
    },
    {
      name: 'bitmart bot B',
      instance: new ccxt.bitmart({
        apiKey: envValue('BITMART_BOT_B_API_KEY'),
        secret: envValue('BITMART_BOT_B_SECRET'),
        uid: envValue('BITMART_BOT_B_UID'),
        enableRateLimit: true
      })
    },
    {
      name: 'bitmart grid',
      instance: new ccxt.bitmart({
        apiKey: envValue('BITMART_GRID_API_KEY'),
        secret: envValue('BITMART_GRID_SECRET'),
        uid: envValue('BITMART_GRID_UID'),
        enableRateLimit: true
      })
    },
    {
      name: 'lbank bot A',
      instance: new ccxt.lbank({
        apiKey: envValue('LBANK_BOT_A_API_KEY'),
        secret: envValue('LBANK_BOT_A_SECRET'),
        enableRateLimit: true
      })
    },
    {
      name: 'lbank bot B',
      instance: new ccxt.lbank({
        apiKey: envValue('LBANK_BOT_B_API_KEY'),
        secret: envValue('LBANK_BOT_B_SECRET'),
        enableRateLimit: true
      })
    },
    {
      name: 'lbank grid',
      instance: new ccxt.lbank({
        apiKey: envValue('LBANK_GRID_API_KEY'),
        secret: envValue('LBANK_GRID_SECRET'),
        enableRateLimit: true
      })
    }
  ];
  for (const item of exchanges) {
    const balance = await item.instance.fetchBalance();
    assert(balance && typeof balance === 'object', `${item.name} returned invalid balance`);
  }
}

async function runChecks() {
  const failures = [];
  for (const check of checks) {
    try {
      await check.fn();
      console.log(`PASS ${check.name}`);
    } catch (error) {
      failures.push({ name: check.name, error });
      console.log(`FAIL ${check.name}`);
      console.log(`     ${error.message}`);
    }
  }

  const optional = [
    ['database connectivity', shouldRunDb, checkDb],
    ['public exchange connectivity', shouldRunPublicExchange, checkPublicExchange],
    ['private read-only balances', shouldRunPrivateBalances, checkPrivateBalances]
  ];

  for (const [name, enabled, fn] of optional) {
    if (!enabled) {
      console.log(`SKIP ${name} (use --${name === 'database connectivity' ? 'db' : name === 'public exchange connectivity' ? 'public-exchange' : 'private-balances'})`);
      continue;
    }
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.log(`FAIL ${name}`);
      console.log(`     ${error.message}`);
    }
  }

  console.log('');
  if (failures.length) {
    console.log(`Preflight failed: ${failures.length} issue(s).`);
    process.exitCode = 1;
    return;
  }

  console.log('Preflight passed.');
  if (!shouldRunDb || !shouldRunPublicExchange || !shouldRunPrivateBalances) {
    console.log('For deeper checks run: npm run test:production');
  }
}

runChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
