-- dex_trades.side was VARCHAR(4) (sized for buy/sell) but now also stores
-- 'convert' (7) and 'convert-back' (12). Widen to VARCHAR(16).
-- MODIFY is idempotent — re-running just re-sets the same type.
ALTER TABLE dex_trades MODIFY COLUMN side VARCHAR(16) NOT NULL;
