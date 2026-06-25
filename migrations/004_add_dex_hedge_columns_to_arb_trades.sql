-- Make dex-hedge-mode accounting first-class on arb_trades:
--   hedge_mode    cex | dex | skip — which leg-3 path ran
--   dex_hedge_tx  tx hash of the inline WETH->USDT convert (dex mode)
--   dex_usdt_out  USDT received from that convert
-- Each column guarded against double-apply.

SET @c1 := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'arb_trades' AND column_name = 'hedge_mode');
SET @s1 := IF(@c1 = 0, 'ALTER TABLE arb_trades ADD COLUMN hedge_mode VARCHAR(10) DEFAULT NULL AFTER exchange', 'SELECT 1');
PREPARE p1 FROM @s1; EXECUTE p1; DEALLOCATE PREPARE p1;

SET @c2 := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'arb_trades' AND column_name = 'dex_hedge_tx');
SET @s2 := IF(@c2 = 0, 'ALTER TABLE arb_trades ADD COLUMN dex_hedge_tx VARCHAR(80) DEFAULT NULL AFTER hedge_fee_usd', 'SELECT 1');
PREPARE p2 FROM @s2; EXECUTE p2; DEALLOCATE PREPARE p2;

SET @c3 := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'arb_trades' AND column_name = 'dex_usdt_out');
SET @s3 := IF(@c3 = 0, 'ALTER TABLE arb_trades ADD COLUMN dex_usdt_out DECIMAL(20,8) DEFAULT NULL AFTER dex_hedge_tx', 'SELECT 1');
PREPARE p3 FROM @s3; EXECUTE p3; DEALLOCATE PREPARE p3;
