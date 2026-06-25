-- treasury_sells now records buys too (buyback when DEX is below CEX).
-- direction: 'sell' (DEX above CEX) | 'buy' (DEX below CEX). Default 'sell'.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'treasury_sells'
             AND column_name = 'direction');
SET @s := IF(@c = 0,
  "ALTER TABLE treasury_sells ADD COLUMN direction VARCHAR(8) NOT NULL DEFAULT 'sell' AFTER status",
  'SELECT 1');
PREPARE p FROM @s; EXECUTE p; DEALLOCATE PREPARE p;
