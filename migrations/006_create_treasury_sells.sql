-- Treasury-sell accounting: one row per treasury_sell run (observation, skip,
-- or execution) so the full premium history and realized sells are queryable.
CREATE TABLE IF NOT EXISTS treasury_sells (
  id INT AUTO_INCREMENT PRIMARY KEY,
  timestamp DATETIME NOT NULL,
  status VARCHAR(16) NOT NULL,            -- observed | skipped | executed
  cex_floor_usd DECIMAL(20,8),            -- reference floor (CEX bid)
  cex_source VARCHAR(20),
  dex_spot_usd DECIMAL(20,8),
  premium_pct DECIMAL(10,4),
  ceiling_l1x DECIMAL(30,18),             -- full size to reach the floor (pool capacity)
  wallet_l1x DECIMAL(30,18),
  sold_l1x DECIMAL(30,18),
  avg_sell_usd DECIMAL(20,8),
  weth_received DECIMAL(30,18),
  usdt_received DECIMAL(20,8),
  premium_captured_usd DECIMAL(20,8),
  sell_gas_usd DECIMAL(20,8),
  convert_gas_usd DECIMAL(20,8),
  sell_tx VARCHAR(80),
  convert_tx VARCHAR(80),
  eth_usd DECIMAL(20,8),
  is_dry_run TINYINT(1) NOT NULL DEFAULT 0,
  INDEX idx_treasury_ts (timestamp),
  INDEX idx_treasury_status (status)
);
