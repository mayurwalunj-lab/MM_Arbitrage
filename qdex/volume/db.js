'use strict';

// MySQL persistence for the QDex volume TEST harness. Reuses the same
// mm_production database as the other venues (QVT_DB_* -> QDEX_DB_* -> DB_*).
//
// Four tables:
//   qdex_volume_epochs     one row per 10-wallet generation (rotates weekly)
//   qdex_volume_wallets    the 10 wallets of an epoch, private key encrypted
//   qdex_volume_trades     every trade ATTEMPT, executed or skipped, with reason
//   qdex_volume_transfers  fund / peer / backstop / sweep movements
//
// Every row carries is_test_activity=1 and the epoch id. Skipped attempts are
// recorded too — the skip reasons are the most useful signal when tuning limits.
//
// SECURITY: privkey_enc / mnemonic_enc are AES-256-GCM blobs (see crypto.js).
// Never expose those two columns through dashboard/Server.js — that process
// serves this database over HTTP with open CORS.

const mysql = require('mysql2/promise');

function dbConfig() {
  const pick = (k) => process.env[`QVT_DB_${k}`] || process.env[`QDEX_DB_${k}`] || process.env[`DB_${k}`] || process.env[`BITMART_DB_${k}`] || '';
  const c = { host: pick('HOST'), port: Number(pick('PORT') || 3306), user: pick('USER'), password: pick('PASSWORD'), database: pick('NAME') };
  if (!c.host || !c.user || !c.database) return null;
  return c;
}

let pool = null;

async function init() {
  if (pool) return;
  const c = dbConfig();
  if (!c) throw new Error('No DB config: set QVT_DB_* or QDEX_DB_* or DB_* in .env');
  pool = mysql.createPool({ ...c, connectionLimit: 4, waitForConnections: true });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qdex_volume_epochs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      status VARCHAR(12) NOT NULL DEFAULT 'active',   -- active | draining | retired
      chain_id BIGINT,
      parent_address VARCHAR(64),
      wallet_count INT NOT NULL DEFAULT 10,
      derivation_path VARCHAR(64),
      mnemonic_enc TEXT,                              -- AES-256-GCM
      test_tag VARCHAR(64),
      is_test_activity TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      retired_at DATETIME,
      note VARCHAR(255),
      INDEX idx_qvt_epoch_status (status)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qdex_volume_wallets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      epoch_id INT NOT NULL,
      idx INT NOT NULL,
      address VARCHAR(64) NOT NULL,
      privkey_enc TEXT,                               -- AES-256-GCM, never served over HTTP
      funded_at DATETIME,
      swept_at DATETIME,
      final_balances_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_qvt_wallet (epoch_id, idx),
      INDEX idx_qvt_wallet_addr (address)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qdex_volume_trades (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      epoch_id INT,
      run_id VARCHAR(48),
      is_test_activity TINYINT(1) NOT NULL DEFAULT 1,
      is_dry_run TINYINT(1) NOT NULL DEFAULT 1,
      status VARCHAR(12) NOT NULL,                    -- executed | skipped | failed
      wallet_idx INT,
      wallet_address VARCHAR(64),
      pool_address VARCHAR(64),
      pool_label VARCHAR(32),
      side VARCHAR(8),                                -- buy = WL1X->token, sell = token->WL1X
      amount_in DECIMAL(40,18),
      amount_in_symbol VARCHAR(24),
      amount_out DECIMAL(40,18),
      amount_out_symbol VARCHAR(24),
      notional_wl1x DECIMAL(40,18),
      exec_price DECIMAL(40,18),                      -- token per WL1X, realised
      price_before DECIMAL(40,18),
      price_after DECIMAL(40,18),
      impact_bps DECIMAL(20,8),
      anchor_price DECIMAL(40,18),
      deviation_pct DECIMAL(20,8),
      min_out DECIMAL(40,18),
      tx_hash VARCHAR(80),
      nonce BIGINT,                                   -- write-ahead: set BEFORE broadcast
      block_number BIGINT,
      gas_used DECIMAL(40,0),
      reason VARCHAR(255),
      INDEX idx_qvt_tr_ts (timestamp),
      INDEX idx_qvt_tr_epoch (epoch_id),
      INDEX idx_qvt_tr_status (status),
      INDEX idx_qvt_tr_pool (pool_address)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qdex_volume_transfers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      epoch_id INT,
      run_id VARCHAR(48),
      is_test_activity TINYINT(1) NOT NULL DEFAULT 1,
      is_dry_run TINYINT(1) NOT NULL DEFAULT 1,
      kind VARCHAR(12) NOT NULL,                      -- fund | peer | backstop | sweep
      from_address VARCHAR(64),
      to_address VARCHAR(64),
      token_address VARCHAR(64),                      -- NULL = native gas
      token_symbol VARCHAR(24),
      amount DECIMAL(40,18),
      tx_hash VARCHAR(80),
      status VARCHAR(12),
      reason VARCHAR(255),
      INDEX idx_qvt_xf_ts (timestamp),
      INDEX idx_qvt_xf_epoch (epoch_id),
      INDEX idx_qvt_xf_kind (kind)
    )`);

  // Additive migration for databases created before the write-ahead column.
  // MySQL has no ADD COLUMN IF NOT EXISTS, so a duplicate is simply ignored.
  try { await pool.query('ALTER TABLE qdex_volume_trades ADD COLUMN nonce BIGINT AFTER tx_hash'); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }

  // Enforce "exactly one active epoch" IN THE DATABASE rather than only in
  // application code. `active_lock` is 1 for an active epoch and NULL otherwise,
  // and a UNIQUE index ignores NULLs — so any second active row is rejected by
  // MySQL itself. Previously two concurrent `epoch:new --force` calls could leave
  // the harness wedged with two open epochs.
  try {
    await pool.query(
      `ALTER TABLE qdex_volume_epochs
         ADD COLUMN active_lock TINYINT
         GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN 1 ELSE NULL END) STORED`);
  } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  try {
    await pool.query('ALTER TABLE qdex_volume_epochs ADD UNIQUE KEY uniq_qvt_one_active (active_lock)');
  } catch (e) {
    // ER_DUP_KEYNAME = already applied. ER_DUP_ENTRY = existing data already has
    // two active epochs; surface that rather than failing silently.
    if (e.code === 'ER_DUP_ENTRY') {
      console.error('WARNING: more than one epoch is already marked active — retire the stale ones, ' +
        'then restart so the single-active constraint can be applied.');
    } else if (e.code !== 'ER_DUP_KEYNAME') throw e;
  }

  // Wallet-level view of what is live. The wallets table has no status of its
  // own, so without this you must remember to join to qdex_volume_epochs; it is
  // easy to read a retired roster by mistake. A view cannot drift out of sync
  // the way a duplicated status column would.
  await pool.query(`
    CREATE OR REPLACE VIEW qdex_volume_wallet_status AS
      SELECT w.epoch_id, w.idx, w.address, e.status AS epoch_status,
             (e.status = 'active') AS is_active,
             e.expires_at, w.funded_at, w.swept_at, w.created_at
      FROM qdex_volume_wallets w
      JOIN qdex_volume_epochs e ON e.id = w.epoch_id`);
}

const q = async (sql, args) => { if (!pool) await init(); return pool.query(sql, args); };

// ---- epochs ----
async function createEpoch(e) {
  const [r] = await q(
    `INSERT INTO qdex_volume_epochs
       (status, chain_id, parent_address, wallet_count, derivation_path, mnemonic_enc, test_tag, expires_at, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['active', e.chainId ?? null, e.parentAddress ?? null, e.walletCount ?? 10, e.derivationPath ?? null,
     e.mnemonicEnc ?? null, e.testTag ?? null, e.expiresAt ?? null, e.note ?? null]
  );
  return r.insertId;
}
async function getActiveEpoch() {
  const [rows] = await q(`SELECT * FROM qdex_volume_epochs WHERE status IN ('active','draining') ORDER BY id DESC`);
  return rows;
}
async function getEpoch(id) {
  const [rows] = await q(`SELECT * FROM qdex_volume_epochs WHERE id = ?`, [id]);
  return rows[0] || null;
}
async function setEpochStatus(id, status, note) {
  const retired = status === 'retired' ? new Date() : null;
  await q(`UPDATE qdex_volume_epochs SET status = ?, retired_at = COALESCE(?, retired_at), note = COALESCE(?, note) WHERE id = ?`,
    [status, retired, note ?? null, id]);
}

// ---- wallets ----
async function insertWallet(w) {
  await q(`INSERT INTO qdex_volume_wallets (epoch_id, idx, address, privkey_enc) VALUES (?,?,?,?)`,
    [w.epochId, w.idx, w.address, w.privkeyEnc ?? null]);
}
async function getWallets(epochId) {
  const [rows] = await q(`SELECT * FROM qdex_volume_wallets WHERE epoch_id = ? ORDER BY idx`, [epochId]);
  return rows;
}
async function markWallet(epochId, idx, field, balances) {
  const col = field === 'funded' ? 'funded_at' : 'swept_at';
  await q(`UPDATE qdex_volume_wallets SET ${col} = ?, final_balances_json = COALESCE(?, final_balances_json) WHERE epoch_id = ? AND idx = ?`,
    [new Date(), balances ? JSON.stringify(balances) : null, epochId, idx]);
}

// ---- activity ----
async function insertTrade(t) {
  const [r] = await q(
    `INSERT INTO qdex_volume_trades
      (timestamp, epoch_id, run_id, is_dry_run, status, wallet_idx, wallet_address, pool_address, pool_label,
       side, amount_in, amount_in_symbol, amount_out, amount_out_symbol, notional_wl1x, exec_price,
       price_before, price_after, impact_bps, anchor_price, deviation_pct, min_out, tx_hash, nonce, block_number, gas_used, reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [t.timestamp ?? new Date(), t.epochId ?? null, t.runId ?? null, t.isDryRun ? 1 : 0, t.status,
     t.walletIdx ?? null, t.walletAddress ?? null, t.poolAddress ?? null, t.poolLabel ?? null,
     t.side ?? null, t.amountIn ?? null, t.amountInSymbol ?? null, t.amountOut ?? null, t.amountOutSymbol ?? null,
     t.notionalWl1x ?? null, t.execPrice ?? null, t.priceBefore ?? null, t.priceAfter ?? null,
     t.impactBps ?? null, t.anchorPrice ?? null, t.deviationPct ?? null, t.minOut ?? null,
     t.txHash ?? null, t.nonce ?? null, t.blockNumber ?? null, t.gasUsed ?? null, t.reason ? String(t.reason).slice(0, 250) : null]
  );
  return r.insertId;
}

// Update a row in place. Used by the write-ahead path: a row is written BEFORE
// the transaction is broadcast, then amended once the outcome is known.
async function updateTrade(id, f) {
  const sets = [], args = [];
  const map = { status: 'status', txHash: 'tx_hash', blockNumber: 'block_number', gasUsed: 'gas_used',
    reason: 'reason', nonce: 'nonce', amountOut: 'amount_out', priceAfter: 'price_after' };
  for (const [k, col] of Object.entries(map)) {
    if (f[k] !== undefined) { sets.push(`${col} = ?`); args.push(f[k]); }
  }
  if (!sets.length) return;
  args.push(id);
  await q(`UPDATE qdex_volume_trades SET ${sets.join(', ')} WHERE id = ?`, args);
}
async function insertTransfer(x) {
  await q(
    `INSERT INTO qdex_volume_transfers
      (timestamp, epoch_id, run_id, is_dry_run, kind, from_address, to_address, token_address, token_symbol, amount, tx_hash, status, reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [x.timestamp ?? new Date(), x.epochId ?? null, x.runId ?? null, x.isDryRun ? 1 : 0, x.kind,
     x.from ?? null, x.to ?? null, x.token ?? null, x.tokenSymbol ?? null, x.amount ?? null,
     x.txHash ?? null, x.status ?? 'executed', x.reason ? String(x.reason).slice(0, 250) : null]
  );
}

async function end() { if (pool) await pool.end(); pool = null; }

module.exports = {
  dbConfig, init, end, query: q, updateTrade,
  createEpoch, getActiveEpoch, getEpoch, setEpochStatus,
  insertWallet, getWallets, markWallet,
  insertTrade, insertTransfer
};
