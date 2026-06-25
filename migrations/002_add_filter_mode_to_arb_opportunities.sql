-- Add the 3-state data-quality marker to recorded opportunities:
--   on       = self-trade filter active and healthy (decision-grade data)
--   degraded = filter wanted but own-orders fetch failed (IP-blocked etc.)
--   off      = filter disabled by config (raw book, may include own orders)
-- Guarded against double-apply (column may already exist on databases that
-- were auto-created by arb/db.js after this change shipped).

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'arb_opportunities'
               AND column_name = 'filter_mode');
SET @ddl := IF(@col = 0,
  'ALTER TABLE arb_opportunities ADD COLUMN filter_mode VARCHAR(10) DEFAULT NULL AFTER self_trade_filter_ok',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
