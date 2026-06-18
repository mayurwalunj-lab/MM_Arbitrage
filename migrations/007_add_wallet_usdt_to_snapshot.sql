-- Track the treasury wallet's USDT balance in inventory snapshots, so the
-- dashboard can show "USDT in treasury". Guarded against double-apply.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'arb_inventory_snapshot'
             AND column_name = 'wallet_usdt');
SET @s := IF(@c = 0,
  'ALTER TABLE arb_inventory_snapshot ADD COLUMN wallet_usdt DECIMAL(20,8) DEFAULT NULL AFTER wallet_eth',
  'SELECT 1');
PREPARE p FROM @s; EXECUTE p; DEALLOCATE PREPARE p;
