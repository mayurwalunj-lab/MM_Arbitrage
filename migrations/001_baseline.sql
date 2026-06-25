-- Baseline: full schema as of 2026-06-12 (mm_production).
-- Idempotent: IF NOT EXISTS everywhere, safe on existing databases.

CREATE TABLE IF NOT EXISTS `arb_inventory_snapshot` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime NOT NULL,
  `wallet_l1x` decimal(30,18) DEFAULT NULL,
  `wallet_weth` decimal(30,18) DEFAULT NULL,
  `wallet_eth` decimal(30,18) DEFAULT NULL,
  `bitmart_l1x` decimal(20,8) DEFAULT NULL,
  `bitmart_usdt` decimal(20,8) DEFAULT NULL,
  `bitmart_eth` decimal(20,8) DEFAULT NULL,
  `lbank_l1x` decimal(20,8) DEFAULT NULL,
  `lbank_usdt` decimal(20,8) DEFAULT NULL,
  `lbank_eth` decimal(20,8) DEFAULT NULL,
  `eth_usd` decimal(20,8) DEFAULT NULL,
  `l1x_usd` decimal(20,8) DEFAULT NULL,
  `total_value_usd` decimal(20,8) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_arb_inv_ts` (`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `arb_opportunities` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime NOT NULL,
  `exchange` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `direction` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'sell-dex',
  `self_trade_filter_ok` tinyint(1) DEFAULT '0',
  `eth_usd` decimal(20,8) DEFAULT NULL,
  `dex_spot_usd` decimal(20,8) DEFAULT NULL,
  `boundary_usd` decimal(20,8) DEFAULT NULL,
  `ceiling_l1x` decimal(20,8) DEFAULT NULL,
  `size_l1x` decimal(20,8) DEFAULT NULL,
  `dex_avg_price_usd` decimal(20,8) DEFAULT NULL,
  `dex_post_price_usd` decimal(20,8) DEFAULT NULL,
  `dex_leg_usd` decimal(20,8) DEFAULT NULL,
  `cex_avg_price_usd` decimal(20,8) DEFAULT NULL,
  `cex_worst_price_usd` decimal(20,8) DEFAULT NULL,
  `cex_leg_usd` decimal(20,8) DEFAULT NULL,
  `cex_fee_usd` decimal(20,8) DEFAULT NULL,
  `hedge_fee_usd` decimal(20,8) DEFAULT NULL,
  `gas_usd` decimal(20,8) DEFAULT NULL,
  `net_usd` decimal(20,8) DEFAULT NULL,
  `gross_edge_pct` decimal(10,4) DEFAULT NULL,
  `streak` int DEFAULT NULL,
  `wallet_l1x` decimal(20,8) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_arb_opp_ts` (`timestamp`),
  KEY `idx_arb_opp_exchange` (`exchange`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `arb_trades` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime NOT NULL,
  `exchange` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `size_l1x` decimal(20,8) NOT NULL,
  `dex_tx_hash` varchar(80) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `dex_weth_out` decimal(30,18) DEFAULT NULL,
  `dex_avg_sell_usd` decimal(20,8) DEFAULT NULL,
  `dex_gas_usd` decimal(20,8) DEFAULT NULL,
  `cex_order_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cex_avg_price` decimal(20,8) DEFAULT NULL,
  `cex_fee_usd` decimal(20,8) DEFAULT NULL,
  `hedge_order_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `hedge_eth_amount` decimal(30,18) DEFAULT NULL,
  `hedge_avg_price` decimal(20,8) DEFAULT NULL,
  `hedge_fee_usd` decimal(20,8) DEFAULT NULL,
  `eth_usd` decimal(20,8) DEFAULT NULL,
  `realized_pnl_usdt` decimal(20,8) DEFAULT NULL,
  `is_dry_run` tinyint(1) DEFAULT '0',
  `notes` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `idx_arb_trades_ts` (`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bitmart_grid_activity` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `center_price` decimal(20,8) NOT NULL,
  `action` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `buy_budget_used` decimal(20,8) DEFAULT '0.00000000',
  `sell_budget_used` decimal(20,8) DEFAULT '0.00000000',
  `active_buy_orders` int DEFAULT '0',
  `active_sell_orders` int DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_grid_activity_timestamp` (`timestamp`),
  KEY `idx_grid_activity_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bitmart_grid_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `action` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `order_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `client_order_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `symbol` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `side` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price` decimal(20,8) DEFAULT NULL,
  `amount` decimal(20,8) DEFAULT NULL,
  `value_usdt` decimal(20,8) DEFAULT NULL,
  `price_range` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `center_price` decimal(20,8) DEFAULT NULL,
  `buy_budget_used` decimal(20,8) DEFAULT NULL,
  `sell_budget_used` decimal(20,8) DEFAULT NULL,
  `active_buy_orders` int DEFAULT NULL,
  `active_sell_orders` int DEFAULT NULL,
  `bot_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'gridBot',
  PRIMARY KEY (`id`),
  KEY `idx_grid_log_action` (`action`) USING BTREE,
  KEY `idx_grid_log_created_at` (`created_at` DESC) USING BTREE,
  KEY `idx_grid_log_order_id` (`order_id`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bitmart_inventory_snapshot` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `bot_a_usdt` decimal(20,8) DEFAULT '0.00000000',
  `bot_a_token` decimal(20,8) DEFAULT '0.00000000',
  `bot_b_usdt` decimal(20,8) DEFAULT '0.00000000',
  `bot_b_token` decimal(20,8) DEFAULT '0.00000000',
  `net_token_change` decimal(20,8) DEFAULT '0.00000000',
  PRIMARY KEY (`id`),
  KEY `idx_inventory_snapshot_timestamp` (`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bitmart_system_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `log_level` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `idx_system_logs_timestamp` (`timestamp`),
  KEY `idx_system_logs_level` (`log_level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bitmart_trade_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `pair` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `side` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `price` decimal(20,8) NOT NULL,
  `amount` decimal(20,8) NOT NULL,
  `total_usd` decimal(20,8) NOT NULL,
  `trend_progress` decimal(5,2) DEFAULT '0.00',
  `maker_order_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `taker_order_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `execution_time_ms` int DEFAULT NULL,
  `is_dry_run` tinyint(1) DEFAULT '0',
  `maker_bot` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `taker_bot` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `maker_order_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'PENDING',
  `taker_order_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'PENDING',
  `taker_price` decimal(20,8) DEFAULT NULL,
  `taker_amount` decimal(20,8) DEFAULT NULL,
  `taker_total_usd` decimal(20,8) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_trade_history_timestamp` (`timestamp`),
  KEY `idx_trade_history_pair_timestamp` (`pair`,`timestamp`),
  KEY `idx_trade_history_side_timestamp` (`side`,`timestamp`),
  KEY `idx_trade_history_maker_bot` (`maker_bot`),
  KEY `idx_trade_history_taker_bot` (`taker_bot`),
  KEY `idx_trade_history_maker_status` (`maker_order_status`),
  KEY `idx_trade_history_taker_status` (`taker_order_status`),
  KEY `idx_trade_history_pair` (`pair`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `dex_trades` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime NOT NULL,
  `side` varchar(4) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tx_hash` varchar(80) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `block_number` int DEFAULT NULL,
  `l1x_amount` decimal(30,18) DEFAULT NULL,
  `weth_amount` decimal(30,18) DEFAULT NULL,
  `avg_price_usd` decimal(20,8) DEFAULT NULL,
  `eth_usd` decimal(20,8) DEFAULT NULL,
  `gas_eth` decimal(30,18) DEFAULT NULL,
  `gas_usd` decimal(20,8) DEFAULT NULL,
  `wallet` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_dex_trades_ts` (`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lbank_grid_ac_balance` (
  `id` int NOT NULL AUTO_INCREMENT,
  `account_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `window_start` datetime DEFAULT NULL,
  `window_end` datetime DEFAULT NULL,
  `l1x_balance_start` decimal(20,8) DEFAULT '0.00000000',
  `l1x_balance_end` decimal(20,8) DEFAULT '0.00000000',
  `usdt_balance_start` decimal(20,8) DEFAULT '0.00000000',
  `usdt_balance_end` decimal(20,8) DEFAULT '0.00000000',
  `l1x_deposit` decimal(20,8) DEFAULT '0.00000000',
  `l1x_withdrawal` decimal(20,8) DEFAULT '0.00000000',
  `usdt_deposit` decimal(20,8) DEFAULT '0.00000000',
  `usdt_withdrawal` decimal(20,8) DEFAULT '0.00000000',
  `l1x_bought` decimal(20,8) DEFAULT '0.00000000',
  `l1x_sold` decimal(20,8) DEFAULT '0.00000000',
  `usdt_spent` decimal(20,8) DEFAULT '0.00000000',
  `usdt_received` decimal(20,8) DEFAULT '0.00000000',
  `fees_paid_l1x` decimal(20,8) DEFAULT '0.00000000',
  `fees_paid_usdt` decimal(20,8) DEFAULT '0.00000000',
  `reconciliation_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'PENDING',
  `mismatch_details` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_account_time` (`account_name`,`window_end`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lbank_grid_activity` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `center_price` decimal(20,8) NOT NULL,
  `action` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `buy_budget_used` decimal(20,8) DEFAULT '0.00000000',
  `sell_budget_used` decimal(20,8) DEFAULT '0.00000000',
  `active_buy_orders` int DEFAULT '0',
  `active_sell_orders` int DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_grid_activity_action` (`action`) USING BTREE,
  KEY `idx_grid_activity_timestamp` (`timestamp`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lbank_grid_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `action` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `order_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `client_order_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `symbol` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `side` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `price` decimal(20,8) DEFAULT NULL,
  `amount` decimal(20,8) DEFAULT NULL,
  `value_usdt` decimal(20,8) DEFAULT NULL,
  `price_range` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `center_price` decimal(20,8) DEFAULT NULL,
  `buy_budget_used` decimal(20,8) DEFAULT NULL,
  `sell_budget_used` decimal(20,8) DEFAULT NULL,
  `active_buy_orders` int DEFAULT NULL,
  `active_sell_orders` int DEFAULT NULL,
  `bot_name` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'gridBot',
  PRIMARY KEY (`id`),
  KEY `idx_grid_log_created_at` (`created_at` DESC),
  KEY `idx_grid_log_action` (`action`),
  KEY `idx_grid_log_order_id` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lbank_inventory_snapshot` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `bot_a_usdt` decimal(20,8) DEFAULT '0.00000000',
  `bot_a_token` decimal(20,8) DEFAULT '0.00000000',
  `bot_b_usdt` decimal(20,8) DEFAULT '0.00000000',
  `bot_b_token` decimal(20,8) DEFAULT '0.00000000',
  `net_token_change` decimal(20,8) DEFAULT '0.00000000',
  PRIMARY KEY (`id`),
  KEY `idx_inventory_snapshot_timestamp` (`timestamp`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lbank_system_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `log_level` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  KEY `idx_system_logs_level` (`log_level`) USING BTREE,
  KEY `idx_system_logs_timestamp` (`timestamp`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lbank_trade_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  `pair` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `side` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `price` decimal(20,8) NOT NULL,
  `amount` decimal(20,8) NOT NULL,
  `total_usd` decimal(20,8) NOT NULL,
  `trend_progress` decimal(5,2) DEFAULT '0.00',
  `maker_bot` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `taker_bot` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `maker_order_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `maker_order_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'PENDING',
  `taker_order_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `taker_order_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'PENDING',
  `taker_price` decimal(20,8) DEFAULT NULL,
  `taker_amount` decimal(20,8) DEFAULT NULL,
  `taker_total_usd` decimal(20,8) DEFAULT NULL,
  `execution_time_ms` int DEFAULT NULL,
  `is_dry_run` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_trade_history_timestamp` (`timestamp` DESC),
  KEY `idx_trade_history_pair` (`pair`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

