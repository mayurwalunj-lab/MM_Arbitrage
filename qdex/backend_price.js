'use strict';

// WL1X USD price from the L1X app backend database (read-only), used instead of
// the on-chain oracle when QDEX_PRICE_SOURCE=backend_db.
//
// The backend's update:l1x_rate job writes CoinMarketCap's L1X/USD price into
// Config (ConfigKey QDEX_BACKEND_PRICE_KEY, default MEXC_L1X_RATE) and logs each
// fetch in L1XCoinMarketPrice (about hourly). Config.UpdatedAt only moves when
// the value changes, so the price counts as updated at the later of that and
// the newest L1XCoinMarketPrice row. WL1X is wrapped L1X: same price.
//
// Connection: MARIADB_HOST / MARIADB_PORT / MARIADB_USERNAME / MARIADB_PASSWORD /
// MARIADB_DC (database). A read-only user is enough.

const mysql = require('mysql2/promise');

let pool = null;

function dbConfig() {
  const c = {
    host: process.env.MARIADB_HOST || '',
    port: Number(process.env.MARIADB_PORT || 3306),
    user: process.env.MARIADB_USERNAME || '',
    password: process.env.MARIADB_PASSWORD || '',
    database: process.env.MARIADB_DC || ''
  };
  if (!c.host || !c.user || !c.database) return null;
  return c;
}

function getPool() {
  if (pool) return pool;
  const c = dbConfig();
  if (!c) throw new Error('backend DB not configured: set MARIADB_HOST, MARIADB_USERNAME, MARIADB_PASSWORD, MARIADB_DC');
  pool = mysql.createPool({ ...c, connectionLimit: 2, connectTimeout: 10000, waitForConnections: true });
  return pool;
}

// { price, updatedAt (unix seconds), source } in the same shape as the oracle
// record, or null when the key is missing / not a positive number. DB errors
// (unreachable, auth) are thrown so the caller can tell them apart.
// UNIX_TIMESTAMP() is computed by the DB, so the driver's timezone can't skew it.
async function getBackendPrice(key) {
  const p = getPool();
  const [rows] = await p.query(
    'SELECT ConfigValue AS value, UNIX_TIMESTAMP(UpdatedAt) AS cfgTs FROM Config WHERE ConfigKey = ? LIMIT 1',
    [key]
  );
  if (!rows.length) return null;
  const price = Number(rows[0].value);
  if (!(price > 0)) return null;
  let updatedAt = Number(rows[0].cfgTs) || 0;
  try {
    const [hist] = await p.query('SELECT UNIX_TIMESTAMP(CreatedAt) AS ts FROM L1XCoinMarketPrice ORDER BY Id DESC LIMIT 1');
    if (hist.length) updatedAt = Math.max(updatedAt, Number(hist[0].ts) || 0);
  } catch (_) { /* history table optional: fall back to Config.UpdatedAt */ }
  return { price, updatedAt, source: `backend ${key}` };
}

async function close() {
  if (pool) { await pool.end().catch(() => {}); pool = null; }
}

module.exports = { dbConfig, getBackendPrice, close };
