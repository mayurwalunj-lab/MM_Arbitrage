'use strict';

// MySQL accounting for the QDex market maker. Writes to the same mm_production
// DB the other venues use (QDEX_DB_* -> DB_* -> BITMART_DB_* fallback). Records
// EVERY tick (observed / skipped / executed) with an is_dry_run flag, so you get
// a full audit trail of what the peg MM saw and did.

const mysql = require('mysql2/promise');

function dbConfig() {
  const pick = (k) => process.env[`QDEX_DB_${k}`] || process.env[`DB_${k}`] || process.env[`BITMART_DB_${k}`] || '';
  const config = {
    host: pick('HOST'),
    port: Number(pick('PORT') || 3306),
    user: pick('USER'),
    password: pick('PASSWORD'),
    database: pick('NAME')
  };
  if (!config.host || !config.user || !config.database) return null;
  return config;
}

let pool = null;

async function init() {
  if (pool) return;
  const config = dbConfig();
  if (!config) throw new Error('No DB config: set QDEX_DB_* or DB_* in .env');
  pool = mysql.createPool({ ...config, connectionLimit: 3, waitForConnections: true });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qdex_actions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      mode VARCHAR(10) NOT NULL DEFAULT 'peg',        -- peg | fixed
      status VARCHAR(16) NOT NULL,                    -- observed | skipped | executed
      is_dry_run TINYINT(1) NOT NULL DEFAULT 0,
      pair VARCHAR(24),                               -- e.g. WL1X/XUSD
      pool_ratio DECIMAL(40,18),                      -- XUSD per WL1X (pool)
      oracle_wl1x_usd DECIMAL(40,18),                 -- authoritative WL1X USD
      xusd_price DECIMAL(40,18),                      -- derived XUSD in USD
      peg DECIMAL(40,18),                             -- target XUSD peg
      target_ratio DECIMAL(40,18),                    -- target pool ratio
      deviation_pct DECIMAL(20,8),                    -- XUSD % off peg
      side VARCHAR(8),                                -- buy | sell | NULL
      correct_to VARCHAR(8),                          -- center | edge
      size_base DECIMAL(40,18),                       -- WL1X traded
      notional_quote DECIMAL(40,18),                  -- XUSD notional
      min_out DECIMAL(40,18),                         -- slippage floor
      tx_hash VARCHAR(80),
      block_number BIGINT,
      gas_used DECIMAL(40,0),
      gas_usd DECIMAL(20,8),
      note VARCHAR(255),
      INDEX idx_qdex_ts (timestamp),
      INDEX idx_qdex_status (status),
      INDEX idx_qdex_dry (is_dry_run)
    )
  `);
}

async function insertAction(a) {
  if (!pool) await init();
  await pool.query(
    `INSERT INTO qdex_actions
      (timestamp, mode, status, is_dry_run, pair, pool_ratio, oracle_wl1x_usd, xusd_price,
       peg, target_ratio, deviation_pct, side, correct_to, size_base, notional_quote,
       min_out, tx_hash, block_number, gas_used, gas_usd, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      a.timestamp ?? new Date(),
      a.mode ?? 'peg',
      a.status,
      a.isDryRun ? 1 : 0,
      a.pair ?? null,
      a.poolRatio ?? null,
      a.oracleWl1xUsd ?? null,
      a.xusdPrice ?? null,
      a.peg ?? null,
      a.targetRatio ?? null,
      a.deviationPct ?? null,
      a.side ?? null,
      a.correctTo ?? null,
      a.sizeBase ?? null,
      a.notionalQuote ?? null,
      a.minOut ?? null,
      a.txHash ?? null,
      a.blockNumber ?? null,
      a.gasUsed ?? null,
      a.gasUsd ?? null,
      a.note ?? null
    ]
  );
}

async function end() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { dbConfig, init, insertAction, end };
