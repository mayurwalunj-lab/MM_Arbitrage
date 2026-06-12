'use strict';

// MySQL accounting for the arb module. Uses ARB_DB_* env when set, otherwise
// falls back to the BITMART_DB_* connection (same managed MySQL server the MM
// bots already write to). All tables are arb_-prefixed so they never collide
// with the existing MM tables, and follow the same auto-create pattern.

const mysql = require('mysql2/promise');

function dbConfig() {
  const pick = (key) => process.env[`ARB_DB_${key}`] || process.env[`DB_${key}`] || process.env[`BITMART_DB_${key}`] || '';
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
  const config = dbConfig();
  if (!config) throw new Error('No DB config: set ARB_DB_* or BITMART_DB_* in .env');
  pool = mysql.createPool({ ...config, connectionLimit: 4, waitForConnections: true });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS arb_opportunities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp DATETIME NOT NULL,
      exchange VARCHAR(20) NOT NULL,
      direction VARCHAR(10) NOT NULL DEFAULT 'sell-dex',
      self_trade_filter_ok TINYINT(1) DEFAULT 0,
      eth_usd DECIMAL(20,8),
      dex_spot_usd DECIMAL(20,8),
      boundary_usd DECIMAL(20,8),
      ceiling_l1x DECIMAL(20,8),
      size_l1x DECIMAL(20,8),
      dex_avg_price_usd DECIMAL(20,8),
      dex_post_price_usd DECIMAL(20,8),
      dex_leg_usd DECIMAL(20,8),
      cex_avg_price_usd DECIMAL(20,8),
      cex_worst_price_usd DECIMAL(20,8),
      cex_leg_usd DECIMAL(20,8),
      cex_fee_usd DECIMAL(20,8),
      hedge_fee_usd DECIMAL(20,8),
      gas_usd DECIMAL(20,8),
      net_usd DECIMAL(20,8),
      gross_edge_pct DECIMAL(10,4),
      streak INT,
      wallet_l1x DECIMAL(20,8),
      INDEX idx_arb_opp_ts (timestamp),
      INDEX idx_arb_opp_exchange (exchange)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS arb_trades (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp DATETIME NOT NULL,
      exchange VARCHAR(20) NOT NULL,
      size_l1x DECIMAL(20,8) NOT NULL,
      dex_tx_hash VARCHAR(80),
      dex_weth_out DECIMAL(30,18),
      dex_avg_sell_usd DECIMAL(20,8),
      dex_gas_usd DECIMAL(20,8),
      cex_order_id VARCHAR(100),
      cex_avg_price DECIMAL(20,8),
      cex_fee_usd DECIMAL(20,8),
      hedge_order_id VARCHAR(100),
      hedge_eth_amount DECIMAL(30,18),
      hedge_avg_price DECIMAL(20,8),
      hedge_fee_usd DECIMAL(20,8),
      eth_usd DECIMAL(20,8),
      realized_pnl_usdt DECIMAL(20,8),
      is_dry_run TINYINT(1) DEFAULT 0,
      notes TEXT,
      INDEX idx_arb_trades_ts (timestamp)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dex_trades (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp DATETIME NOT NULL,
      side VARCHAR(4) NOT NULL,
      tx_hash VARCHAR(80),
      block_number INT,
      l1x_amount DECIMAL(30,18),
      weth_amount DECIMAL(30,18),
      avg_price_usd DECIMAL(20,8),
      eth_usd DECIMAL(20,8),
      gas_eth DECIMAL(30,18),
      gas_usd DECIMAL(20,8),
      wallet VARCHAR(64),
      INDEX idx_dex_trades_ts (timestamp)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS arb_inventory_snapshot (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp DATETIME NOT NULL,
      wallet_l1x DECIMAL(30,18),
      wallet_weth DECIMAL(30,18),
      wallet_eth DECIMAL(30,18),
      bitmart_l1x DECIMAL(20,8),
      bitmart_usdt DECIMAL(20,8),
      bitmart_eth DECIMAL(20,8),
      lbank_l1x DECIMAL(20,8),
      lbank_usdt DECIMAL(20,8),
      lbank_eth DECIMAL(20,8),
      eth_usd DECIMAL(20,8),
      l1x_usd DECIMAL(20,8),
      total_value_usd DECIMAL(20,8),
      INDEX idx_arb_inv_ts (timestamp)
    )
  `);

  return pool;
}

function requirePool() {
  if (!pool) throw new Error('arb db not initialized — call init() first');
  return pool;
}

// record: the same object the monitor appends to opportunities.jsonl
async function insertOpportunity(record) {
  await requirePool().query(
    `INSERT INTO arb_opportunities
      (timestamp, exchange, direction, self_trade_filter_ok, eth_usd, dex_spot_usd, boundary_usd, ceiling_l1x,
       size_l1x, dex_avg_price_usd, dex_post_price_usd, dex_leg_usd,
       cex_avg_price_usd, cex_worst_price_usd, cex_leg_usd, cex_fee_usd, hedge_fee_usd,
       gas_usd, net_usd, gross_edge_pct, streak, wallet_l1x)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      new Date(record.ts), record.exchange, record.direction || 'sell-dex', record.selfTradeFilterOk ? 1 : 0,
      record.ethUsd, record.dexSpotUsd, record.boundaryUsd ?? null, record.ceilingL1x ?? null,
      record.sizeL1x, record.dexAvgPriceUsd, record.dexPostPriceUsd, record.dexLegUsd,
      record.cexAvgPriceUsd, record.cexWorstPriceUsd, record.cexLegUsd, record.cexFeeUsd,
      record.hedgeFeeUsd, record.gasUsd, record.netUsd, record.grossEdgePct,
      record.streak, record.walletL1x ?? null
    ]
  );
}

async function insertTrade(trade) {
  const [result] = await requirePool().query(
    `INSERT INTO arb_trades
      (timestamp, exchange, size_l1x, dex_tx_hash, dex_weth_out, dex_avg_sell_usd, dex_gas_usd,
       cex_order_id, cex_avg_price, cex_fee_usd,
       hedge_order_id, hedge_eth_amount, hedge_avg_price, hedge_fee_usd,
       eth_usd, realized_pnl_usdt, is_dry_run, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      trade.timestamp ?? new Date(), trade.exchange, trade.sizeL1x,
      trade.dexTxHash ?? null, trade.dexWethOut ?? null, trade.dexAvgSellUsd ?? null, trade.dexGasUsd ?? null,
      trade.cexOrderId ?? null, trade.cexAvgPrice ?? null, trade.cexFeeUsd ?? null,
      trade.hedgeOrderId ?? null, trade.hedgeEthAmount ?? null, trade.hedgeAvgPrice ?? null, trade.hedgeFeeUsd ?? null,
      trade.ethUsd ?? null, trade.realizedPnlUsdt ?? null, trade.isDryRun ? 1 : 0, trade.notes ?? null
    ]
  );
  return result.insertId;
}

async function insertDexTrade(trade) {
  const [result] = await requirePool().query(
    `INSERT INTO dex_trades
      (timestamp, side, tx_hash, block_number, l1x_amount, weth_amount,
       avg_price_usd, eth_usd, gas_eth, gas_usd, wallet)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      trade.timestamp ?? new Date(), trade.side, trade.txHash ?? null, trade.blockNumber ?? null,
      trade.l1xAmount ?? null, trade.wethAmount ?? null, trade.avgPriceUsd ?? null,
      trade.ethUsd ?? null, trade.gasEth ?? null, trade.gasUsd ?? null, trade.wallet ?? null
    ]
  );
  return result.insertId;
}

async function insertSnapshot(snapshot) {
  await requirePool().query(
    `INSERT INTO arb_inventory_snapshot
      (timestamp, wallet_l1x, wallet_weth, wallet_eth,
       bitmart_l1x, bitmart_usdt, bitmart_eth, lbank_l1x, lbank_usdt, lbank_eth,
       eth_usd, l1x_usd, total_value_usd)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      snapshot.timestamp ?? new Date(),
      snapshot.walletL1x ?? null, snapshot.walletWeth ?? null, snapshot.walletEth ?? null,
      snapshot.bitmartL1x ?? null, snapshot.bitmartUsdt ?? null, snapshot.bitmartEth ?? null,
      snapshot.lbankL1x ?? null, snapshot.lbankUsdt ?? null, snapshot.lbankEth ?? null,
      snapshot.ethUsd ?? null, snapshot.l1xUsd ?? null, snapshot.totalValueUsd ?? null
    ]
  );
}

async function report() {
  const db = requirePool();
  const [[opps]] = await db.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(net_usd),0) AS potential,
            COALESCE(AVG(net_usd),0) AS avg_net, COALESCE(MAX(net_usd),0) AS best
     FROM arb_opportunities`
  );
  const [oppsByDay] = await db.query(
    `SELECT DATE(timestamp) AS day, exchange, COUNT(*) AS n,
            ROUND(AVG(net_usd),2) AS avg_net, ROUND(MAX(net_usd),2) AS best
     FROM arb_opportunities GROUP BY day, exchange ORDER BY day DESC LIMIT 14`
  );
  const [[trades]] = await db.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(realized_pnl_usdt),0) AS pnl
     FROM arb_trades WHERE is_dry_run = 0`
  );
  const [tradesByDay] = await db.query(
    `SELECT DATE(timestamp) AS day, COUNT(*) AS n, ROUND(SUM(realized_pnl_usdt),2) AS pnl
     FROM arb_trades WHERE is_dry_run = 0 GROUP BY day ORDER BY day DESC LIMIT 14`
  );
  const [latestSnapshot] = await db.query(
    `SELECT * FROM arb_inventory_snapshot ORDER BY id DESC LIMIT 1`
  );
  const [[dexTrades]] = await db.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(gas_usd),0) AS gas FROM dex_trades`
  );
  const [recentDexTrades] = await db.query(
    `SELECT timestamp, side, l1x_amount, weth_amount, avg_price_usd, tx_hash
     FROM dex_trades ORDER BY id DESC LIMIT 5`
  );
  return { opps, oppsByDay, trades, tradesByDay, latestSnapshot: latestSnapshot[0] ?? null, dexTrades, recentDexTrades };
}

async function end() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { init, insertOpportunity, insertTrade, insertDexTrade, insertSnapshot, report, end, dbConfig };
