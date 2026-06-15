-- Add is_dry_run to every remaining data table so each row declares
-- whether it was produced by a simulated (1) or live (0) system.
-- Existing rows default to 0 (real) — correct for production history.
-- Guarded per table against double-apply.

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dex_trades' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE dex_trades ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'arb_inventory_snapshot' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE arb_inventory_snapshot ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bitmart_inventory_snapshot' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE bitmart_inventory_snapshot ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lbank_inventory_snapshot' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE lbank_inventory_snapshot ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bitmart_system_logs' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE bitmart_system_logs ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lbank_system_logs' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE lbank_system_logs ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bitmart_grid_log' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE bitmart_grid_log ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lbank_grid_log' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE lbank_grid_log ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'bitmart_grid_activity' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE bitmart_grid_activity ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lbank_grid_activity' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE lbank_grid_activity ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lbank_grid_ac_balance' AND column_name = 'is_dry_run');
SET @ddl := IF(@col = 0, 'ALTER TABLE lbank_grid_ac_balance ADD COLUMN is_dry_run TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

