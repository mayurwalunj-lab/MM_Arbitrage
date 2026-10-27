// ============================================================
// STANDALONE GRID MANAGER - Price Range Grid Order Placement
// Runs independently with its own bot and configuration
// LBank Exchange Version
// ============================================================

const ccxt = require('ccxt');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const priceBand = require('../shared/price_band'); // dynamic DEX-following band (off unless DYNAMIC_BAND=true)

// Signals the arb monitor (arb/monitor.js) that our orders are being
// mass-cancelled, so it must not trust the L1X orderbook during this window.
const GRID_REFRESH_FLAG = path.join(__dirname, '..', 'arb', 'state', 'grid_refreshing_lbank.flag');
function setGridRefreshFlag() {
    try {
        fs.mkdirSync(path.dirname(GRID_REFRESH_FLAG), { recursive: true });
        fs.writeFileSync(GRID_REFRESH_FLAG, String(Date.now()));
    } catch (e) { /* flag I/O must never break trading */ }
}
function clearGridRefreshFlag() {
    try { fs.unlinkSync(GRID_REFRESH_FLAG); } catch (e) { /* already gone */ }
}

// ============================================================
// GRID MANAGER CONFIGURATION
// ============================================================
const GRID_CONFIG = {
    // Bot credentials (can use same or different bot)
    bot: {
        apiKey: process.env.LBANK_GRID_API_KEY || '',
        secret: process.env.LBANK_GRID_SECRET || '',
        // LBank does not use UID
    },
    
    // Trading pair (CCXT format - will be converted internally)
    pair: 'L1X/USDT',
    
    // Dry run mode
    dryRun: process.env.BOT_DRY_RUN !== 'false', // env-driven: dry-run unless BOT_DRY_RUN=false
    
    // Minimum balances required
    minUsdtBalance: 10,
    minL1xBalance: 5,
    
    // Price Range Grid Configuration (BitMart-style)
    // Prices are written for a $8.50 center (baseCenterPrice); with DYNAMIC_BAND
    // on, every range slides with the band center, so the % distances hold.
    //
    // LBank listing rule: best bid <-> best ask spread <= 1%, and $500-$1000 of
    // orders within +/-1% of the price on EACH side, or LBank suspends the pair's
    // API. The sell side keeps $600 within 0.35%-0.95% of the center, $530 of it
    // within 0.65%, so it stays at $500+ inside 1% even when LBank measures from
    // the other edge of our 0.7% spread, and under the $1000 cap when it measures
    // from this edge (the far sells start at +3%, out of reach).
    // Beyond 1% the sells are few, thin and far apart, growing with distance, so
    // buyers can lift the price quickly and the bulk only sells high.
    priceRangeGrids: {
        // SELL SIDE (Asks) - Above current price. $1500 total, 15 orders.
        sell: [
            // within 1%: $600
            { minPrice: 8.5298, maxPrice: 8.5425, totalValue: 300, ordersPerRange: 3, spacing: 'medium' }, // +0.35-0.5%
            { minPrice: 8.5425, maxPrice: 8.5545, totalValue: 230, ordersPerRange: 3, spacing: 'medium' }, // +0.5-0.65%
            { minPrice: 8.5545, maxPrice: 8.5808, totalValue: 70, ordersPerRange: 2, spacing: 'medium' },  // +0.65-0.95%
            // beyond 1%: $900 in five narrow steps with wide gaps between them
            { minPrice: 8.755, maxPrice: 8.7975, totalValue: 50, ordersPerRange: 1, spacing: 'wide' },    // +3-3.5%
            { minPrice: 9.18, maxPrice: 9.265, totalValue: 125, ordersPerRange: 1, spacing: 'wide' },      // +8-9%
            { minPrice: 9.775, maxPrice: 9.9025, totalValue: 200, ordersPerRange: 2, spacing: 'wide' },    // +15-16.5%
            { minPrice: 10.54, maxPrice: 10.71, totalValue: 250, ordersPerRange: 2, spacing: 'wide' },     // +24-26%
            { minPrice: 11.475, maxPrice: 11.73, totalValue: 275, ordersPerRange: 1, spacing: 'wide' },    // +35-38%
        ],

        // BUY SIDE (Bids) - Below current price. $520 total, all within 1%:
        // $500 inside 0.65% (the minimum at either edge of the spread), so any
        // fill can take this side under LBank's $500 until the next refresh.
        buy: [
            { minPrice: 8.4575, maxPrice: 8.4702, totalValue: 270, ordersPerRange: 5, spacing: 'medium' }, // -0.35-0.5%
            { minPrice: 8.4448, maxPrice: 8.4575, totalValue: 230, ordersPerRange: 5, spacing: 'medium' }, // -0.5-0.65%
            { minPrice: 8.4193, maxPrice: 8.4448, totalValue: 20, ordersPerRange: 1, spacing: 'medium' },  // -0.65-0.95%
        ]
    },
    
    baseCenterPrice: 8.50,

    // BUY GUARD (DYNAMIC_BAND only): never bid above the DEX price minus this %,
    // except at the floor: buys always sit in [BAND_ABS_MIN, max(DEX - this %,
    // BAND_ABS_MIN)]. A bid above the DEX lets anyone buy on the DEX and sell to
    // us at a profit, so buys above the cap are moved down to it (old ones are
    // cancelled at once); buys below the floor are moved up to it. If the DEX
    // price is unknown, no buys. GRID_BUY_DEX_MARGIN_PCT < 0 turns the guard off.
    buyDexMarginPct: Number.isFinite(Number(process.env.GRID_BUY_DEX_MARGIN_PCT)) && process.env.GRID_BUY_DEX_MARGIN_PCT !== ''
        ? Number(process.env.GRID_BUY_DEX_MARGIN_PCT) : 0.5,

    // Stop/restart cancels grid orders this many at a time, so they're all gone
    // before pm2 kills the process (the old 5-minute spread left most behind).
    stopCancelBatchSize: 5,
    stopCancelBatchDelayMs: 250,

    // Refresh interval (seconds)
    refreshIntervalSeconds: 600,
    
    // API Rate Limit Protection
    // Time window for placing/cancelling orders (seconds)
    orderOperationTimeWindow: 300, // 5 minutes = 300 seconds
    
    // Database configuration (optional, for logging)
    database: {
        host: process.env.DB_HOST || process.env.LBANK_DB_HOST || '159.195.76.213',
        port: parseInt(process.env.DB_PORT || process.env.LBANK_DB_PORT) || 25060,
        user: process.env.DB_USER || process.env.LBANK_DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.LBANK_DB_PASSWORD || '',
        database: process.env.DB_NAME || process.env.LBANK_DB_NAME || 'marketcap',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    }
};

// ============================================================
// HELPERS
// ============================================================
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomVal = (min, max) => Math.random() * (max - min) + min;

function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[${time}] [GRID] ${message}`);
}

// Effective price ranges for this refresh. With DYNAMIC_BAND on, every range is
// scaled by centerPrice/baseCenterPrice so the whole grid slides to follow the
// DEX-driven center (relative spacing preserved). Off = the fixed absolute ranges.
function effectiveRanges(centerPrice) {
    const src = GRID_CONFIG.priceRangeGrids;
    if (!priceBand.isEnabled() || !src || !(centerPrice > 0)) return src;
    const base = GRID_CONFIG.baseCenterPrice || centerPrice;
    const ratio = centerPrice / base;
    const shift = (arr) => (arr || []).map(r => ({ ...r, minPrice: r.minPrice * ratio, maxPrice: r.maxPrice * ratio }));
    return { buy: shift(src.buy), sell: shift(src.sell) };
}

// The center the grid should build around: the DEX-following band center when
// DYNAMIC_BAND is on, otherwise the current market price (today's behavior).
async function resolveGridCenter(marketPrice) {
    if (!priceBand.isEnabled()) return marketPrice;
    try {
        const band = await priceBand.getBand(marketPrice);
        log(`📊 BAND center $${band.center.toFixed(4)} (DEX $${band.dexPrice ? band.dexPrice.toFixed(4) : 'n/a'}${band.frozen ? ', FROZEN' : ''}) — grid follows`, 'info');
        return band.center;
    } catch (e) {
        log(`⚠️ band unavailable, grid centered on market: ${String(e.message).slice(0, 60)}`, 'warn');
        return marketPrice;
    }
}

// Highest price a grid buy may sit at: the DEX price minus buyDexMarginPct, but
// never under the floor (BAND_ABS_MIN) — the grid always bids at the floor, even
// when the DEX is lower (defending the floor costs that gap to arbitrage).
// Infinity = guard off (band off or negative margin); 0 = DEX unknown, no buys.
function buyPriceCap() {
    if (!priceBand.isEnabled() || GRID_CONFIG.buyDexMarginPct < 0) return Infinity;
    const band = priceBand.getBandSync();
    const dex = band ? Number(band.dexPrice) : NaN;
    if (!(dex > 0)) return 0;
    return Math.max(dex * (1 - GRID_CONFIG.buyDexMarginPct / 100), priceBand.config().absMin);
}

// Lowest price a grid buy may sit at: the floor (band on), else no limit.
function buyPriceFloor() {
    return priceBand.isEnabled() ? priceBand.config().absMin : 0;
}

// Clamp a grid buy price into [floor, cap]. null = no buy (cap unknown/0).
function clampBuyPrice(price, cap) {
    if (!(cap > 0)) return null;
    return Math.min(Math.max(price, buyPriceFloor()), cap);
}

// Prefix for orders placed by the Grid Manager API. Only these are cancelled on refresh/stop.
// Manual frontend orders (no prefix) are never touched.
const GRID_ORDER_PREFIX = 'grid_';

function isGridOrder(order) {
    const cid = order.clientOrderId || order.info?.custom_id;
    return typeof cid === 'string' && cid.startsWith(GRID_ORDER_PREFIX);
}

function generateGridClientOrderId() {
    return GRID_ORDER_PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

// ============================================================
// CACHE SYSTEM
// ============================================================
const balanceCache = { data: null, timestamp: 0 };
const BALANCE_CACHE_TTL = 5000; // 5 seconds

const openOrdersCache = { data: null, timestamp: 0 };
const OPEN_ORDERS_CACHE_TTL = 3000; // 3 seconds

function invalidateBalanceCache() {
    balanceCache.timestamp = 0;
}

function invalidateOpenOrdersCache() {
    openOrdersCache.timestamp = 0;
}

// ============================================================
// DATABASE (Optional)
// ============================================================
let dbPool = null;

async function initDatabase() {
    try {
        dbPool = mysql.createPool(GRID_CONFIG.database);
        const connection = await dbPool.getConnection();
        await connection.ping();
        connection.release();
        const dbName = GRID_CONFIG.database.database;
        log(`📊 Database connected (${dbName}).`, 'info');
        try {
            await dbPool.execute(`
                CREATE TABLE IF NOT EXISTS lbank_grid_log (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    action VARCHAR(20) NOT NULL,
                    order_id VARCHAR(100) DEFAULT NULL,
                    client_order_id VARCHAR(100) DEFAULT NULL,
                    symbol VARCHAR(20) DEFAULT NULL,
                    side VARCHAR(10) DEFAULT NULL,
                    price DECIMAL(20, 8) DEFAULT NULL,
                    amount DECIMAL(20, 8) DEFAULT NULL,
                    value_usdt DECIMAL(20, 8) DEFAULT NULL,
                    price_range VARCHAR(50) DEFAULT NULL,
                    center_price DECIMAL(20, 8) DEFAULT NULL,
                    buy_budget_used DECIMAL(20, 8) DEFAULT NULL,
                    sell_budget_used DECIMAL(20, 8) DEFAULT NULL,
                    active_buy_orders INT DEFAULT NULL,
                    active_sell_orders INT DEFAULT NULL,
                    bot_name VARCHAR(50) DEFAULT 'gridBot',
                    is_dry_run TINYINT(1) NOT NULL DEFAULT 0
                )
            `);
            try {
                await dbPool.execute(`CREATE INDEX idx_grid_log_created_at ON lbank_grid_log(created_at DESC)`);
                await dbPool.execute(`CREATE INDEX idx_grid_log_action ON lbank_grid_log(action)`);
                await dbPool.execute(`CREATE INDEX idx_grid_log_order_id ON lbank_grid_log(order_id)`);
            } catch (e) { /* Indexes may exist */ }
            log("📊 lbank_grid_log table ready.", 'info');
            try {
                await dbPool.execute(`
                    INSERT INTO lbank_grid_log (action, center_price, buy_budget_used, sell_budget_used, active_buy_orders, active_sell_orders, bot_name, is_dry_run)                    VALUES ('START', 0, 0, 0, 0, 0, 'gridBot', ${GRID_CONFIG.dryRun ? 1 : 0})
                `);
                log("📊 DB test write OK — check lbank_grid_log in database.", 'info');
            } catch (testErr) {
                log(`❌ DB test write failed: ${testErr.message}`, 'warn');
            }
        } catch (tableErr) {
            log(`❌ lbank_grid_log table setup failed: ${tableErr.message}`, 'warn');
            dbPool = null;
        }
    } catch (error) {
        log(`❌ Database connection failed: ${error.message}`, 'warn');
        dbPool = null; // Continue without database
    }
}

async function logGridActivity(activityData) {
    if (!dbPool) return;
    try {
        await dbPool.execute(`
            INSERT INTO lbank_grid_log (
                action, center_price, buy_budget_used, sell_budget_used,
                active_buy_orders, active_sell_orders, bot_name, is_dry_run
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            activityData.action || 'REFRESH',
            activityData.centerPrice ?? null,
            activityData.buyBudgetUsed ?? 0,
            activityData.sellBudgetUsed ?? 0,
            activityData.activeBuyOrders ?? 0,
            activityData.activeSellOrders ?? 0,
            'gridBot',
            GRID_CONFIG.dryRun ? 1 : 0
        ]);
    } catch (e) {
        log(`❌ DB logGridActivity failed: ${e.message}`, 'warn');
    }
}

async function logGridOrderEvent(event) {
    if (!dbPool) return;
    if (GRID_CONFIG.dryRun) return;
    try {
        await dbPool.execute(`
            INSERT INTO lbank_grid_log (
                action, order_id, client_order_id, symbol, side, price, amount, value_usdt, price_range, bot_name, is_dry_run
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            event.action,
            event.orderId ?? null,
            event.clientOrderId ?? null,
            event.symbol ?? GRID_CONFIG.pair,
            event.side ?? null,
            event.price ?? null,
            event.amount ?? null,
            event.valueUsdt ?? null,
            event.priceRange ?? null,
            'gridBot',
            GRID_CONFIG.dryRun ? 1 : 0
        ]);
    } catch (e) {
        log(`❌ DB logGridOrderEvent failed (${event?.action} ${event?.orderId}): ${e.message}`, 'warn');
    }
}

/**
 * Find grid orders we PLACED (no CANCELLED/FILLED) that are no longer open → they filled.
 * Log FILLED for each so they're marked in DB.
 */
async function detectAndLogFilledOrders(openGridOrderIds) {
    if (!dbPool || GRID_CONFIG.dryRun) return;
    const openSet = new Set(openGridOrderIds);
    try {
        const [rows] = await dbPool.execute(`
            SELECT order_id, client_order_id, side, price, amount, value_usdt, price_range
            FROM lbank_grid_log e1
            WHERE e1.action = 'PLACED' AND e1.order_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM lbank_grid_log e2
                WHERE e2.order_id = e1.order_id AND e2.action IN ('CANCELLED', 'FILLED')
            )
        `);
        for (const r of rows || []) {
            if (openSet.has(r.order_id)) continue;
            await logGridOrderEvent({
                orderId: r.order_id,
                clientOrderId: r.client_order_id,
                side: r.side,
                price: parseFloat(r.price),
                amount: r.amount != null ? parseFloat(r.amount) : null,
                valueUsdt: r.value_usdt != null ? parseFloat(r.value_usdt) : null,
                action: 'FILLED',
                priceRange: r.price_range
            });
            log(`📗 FILLED (logged): ${r.side} order ${r.order_id} @ $${parseFloat(r.price).toFixed(4)}`, 'info');
        }
    } catch (e) {
        log(`❌ DB detectAndLogFilledOrders failed: ${e.message}`, 'warn');
    }
}

// ============================================================
// API FUNCTIONS
// ============================================================
// ccxt's lbank.fetchBalance() calls /supplement/user_info.do, which returns
// "Internal error" for this account (auth is fine — other signed calls work).
// /supplement/user_info_account.do works and returns clean {asset,free,locked}
// rows, so read balances directly from it.
async function lbankSpotBalance(bot) {
    const r = await bot.spotPrivatePostSupplementUserInfoAccount({});
    const rows = (r && r.data && r.data.balances) || [];
    const out = {};
    for (const row of rows) {
        out[String(row.asset || '').toUpperCase()] = { free: parseFloat(row.free) || 0, used: parseFloat(row.locked) || 0 };
    }
    return out;
}

async function checkBalances(bot) {
    if (GRID_CONFIG.dryRun) {
        return { usdt: 10000, l1x: 1000 }; // Simulated balances
    }
    
    const now = Date.now();
    if (balanceCache.data && (now - balanceCache.timestamp) < BALANCE_CACHE_TTL) {
        return balanceCache.data;
    }
    
    // Retry transient LBank balance errors ("Internal error", 429, timeouts)
    // before giving up — a FAILED fetch is not an EMPTY wallet.
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const bal = await lbankSpotBalance(bot);
            const result = {
                usdt: bal['USDT'] ? bal['USDT'].free : 0,
                l1x: bal['L1X'] ? bal['L1X'].free : 0
            };
            balanceCache.data = result;
            balanceCache.timestamp = now;
            return result;
        } catch (e) {
            lastErr = e;
            if (attempt < 3) await delay(1500 * attempt);
        }
    }
    // All retries failed. Prefer the last-known-good balance over reporting zero
    // (which would wrongly trip "WALLETS EMPTY" and skip the whole grid).
    log(`⚠️ Balance fetch failed after retries: ${lastErr && lastErr.message}`, 'warn');
    if (balanceCache.data) {
        log(`↩️ Using last-known balances (USDT=${balanceCache.data.usdt}, L1X=${balanceCache.data.l1x})`, 'warn');
        return balanceCache.data;
    }
    return null; // unknown (never fetched successfully) — caller must NOT treat as empty
}

async function fetchOpenOrdersCached(bot, pair) {
    const now = Date.now();
    if (openOrdersCache.data && (now - openOrdersCache.timestamp) < OPEN_ORDERS_CACHE_TTL) {
        return openOrdersCache.data;
    }
    
    try {
        const orders = await bot.fetchOpenOrders(pair);
        openOrdersCache.data = orders;
        openOrdersCache.timestamp = now;
        return orders;
    } catch (e) {
        log(`⚠️ Error fetching orders: ${e.message}`, 'warn');
        return [];
    }
}

async function getCurrentPrice(bot, pair) {
    try {
        const ticker = await bot.fetchTicker(pair);
        return ticker.last;
    } catch (e) {
        log(`⚠️ Error fetching price: ${e.message}`, 'warn');
        return null;
    }
}

// ============================================================
// GRID LOGIC
// ============================================================

/**
 * Helper function to randomly distribute total value across orders
 */
function randomizeOrderSizes(totalValue, numOrders) {
    const sizes = [];
    let remaining = totalValue;
    
    for (let i = 0; i < numOrders - 1; i++) {
        const proportion = randomVal(0.1, 0.3);
        const size = remaining * proportion;
        sizes.push(size);
        remaining -= size;
    }
    sizes.push(remaining);
    
    // Shuffle to randomize order
    for (let i = sizes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sizes[i], sizes[j]] = [sizes[j], sizes[i]];
    }
    
    return sizes;
}

/**
 * Helper function to calculate random price positions within range
 */
function calculateRandomPriceDistribution(range) {
    const prices = [];
    const rangeSize = range.maxPrice - range.minPrice;
    
    for (let i = 0; i < range.ordersPerRange; i++) {
        let price;
        let attempts = 0;
        const minGap = rangeSize * 0.005;
        
        do {
            const randomFactor = Math.random();
            const centerWeight = 0.3;
            
            if (randomFactor < centerWeight) {
                const center = (range.minPrice + range.maxPrice) / 2;
                const offset = (Math.random() - 0.5) * (rangeSize * 0.3);
                price = center + offset;
            } else {
                price = range.minPrice + (Math.random() * rangeSize);
            }
            
            price = Math.max(range.minPrice, Math.min(range.maxPrice, price));
            attempts++;
        } while (attempts < 50 && prices.some(p => Math.abs(p - price) < minGap));
        
        prices.push(price);
    }
    
    return prices.sort((a, b) => a - b);
}

/**
 * Main Grid Manager Function - One-by-one replacement spread over 5 minutes
 */
async function maintainGrid(bot, centerPrice, symbol) {
    if (!isRunning) return;
    const ranges = effectiveRanges(centerPrice);
    const startTime = Date.now();
    // Use orderOperationTimeWindow (5 minutes) for operation time limit
    // Add 10 seconds buffer to ensure we finish before next refresh
    const BUFFER_SECONDS = 10;
    const MAX_OPERATION_TIME = (GRID_CONFIG.orderOperationTimeWindow + BUFFER_SECONDS) * 1000;
    
    const botBals = await checkBalances(bot);
    if (!isRunning) return;
    // null = balance API unavailable (not empty). Keep existing orders in place and
    // retry next refresh — do NOT cancel or claim wallets empty on a transient error.
    if (!botBals) {
        log("⚠️ Balances unavailable (API error) — keeping existing orders, retrying next refresh.", 'warn');
        return;
    }
    const canBuy = botBals.usdt > GRID_CONFIG.minUsdtBalance;
    const canSell = botBals.l1x > GRID_CONFIG.minL1xBalance;

    if (!canBuy && !canSell) {
        log("🛑 WALLETS EMPTY. Skipping Grid Update.", 'warn');
        await logGridActivity({
            centerPrice,
            action: 'REFRESH',
            buyBudgetUsed: 0,
            sellBudgetUsed: 0,
            activeBuyOrders: 0,
            activeSellOrders: 0
        });
        return;
    }

    log(`🛡️ GRID REFRESH (Center: $${centerPrice.toFixed(4)}) | Time window: ${GRID_CONFIG.orderOperationTimeWindow}s (5 min)`, 'info');
    
    let buyBudgetUsed = 0;
    let sellBudgetUsed = 0;
    let activeBuyOrders = 0;
    let activeSellOrders = 0;
    
    // Check if we're running out of time
    const checkTime = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_OPERATION_TIME) {
            log(`⏰ Time limit reached (${(elapsed/1000).toFixed(1)}s / ${MAX_OPERATION_TIME/1000}s). Stopping operations.`, 'warn');
            return true;
        }
        return false;
    };
    
    // Visualization for dry run
    if (GRID_CONFIG.dryRun) {
        let visualGrid = { bids: [], asks: [] };
        
        if (GRID_CONFIG.priceRangeGrids && ranges.buy) {
            const maxBuyPrice = buyPriceCap();
            for (const range of ranges.buy) {
                const prices = calculateRandomPriceDistribution(range);
                const orderSizes = randomizeOrderSizes(range.totalValue, range.ordersPerRange);
                
                for (let i = 0; i < prices.length; i++) {
                    const price = clampBuyPrice(prices[i], maxBuyPrice);
                    if (price == null) continue;
                    const orderSize = orderSizes[i];
                    const amount = orderSize / price;
                    visualGrid.bids.push({ 
                        price: price, 
                        amount: amount, 
                        value: orderSize,
                        range: `${range.minPrice}-${range.maxPrice}` 
                    });
                    buyBudgetUsed += orderSize;
                    activeBuyOrders++;
                }
            }
        }
        
        if (GRID_CONFIG.priceRangeGrids && ranges.sell) {
            for (const range of ranges.sell) {
                const prices = calculateRandomPriceDistribution(range);
                const orderSizes = randomizeOrderSizes(range.totalValue, range.ordersPerRange);
                
                for (let i = 0; i < prices.length; i++) {
                    const price = prices[i];
                    const orderSize = orderSizes[i];
                    const amount = orderSize / price;
                    visualGrid.asks.push({ 
                        price: price, 
                        amount: amount, 
                        value: orderSize,
                        range: `${range.minPrice}-${range.maxPrice}` 
                    });
                    sellBudgetUsed += orderSize;
                    activeSellOrders++;
                }
            }
        }
        
        log(`📊 DRY RUN: ${activeBuyOrders} buy orders, ${activeSellOrders} sell orders`, 'info');
        for (const b of visualGrid.bids) {
            log(`   [DRY] BUY  $${b.value.toFixed(2)} @ $${b.price.toFixed(4)} amount=${b.amount.toFixed(4)} [${b.range}]`, 'info');
        }
        for (const a of visualGrid.asks) {
            log(`   [DRY] SELL $${a.value.toFixed(2)} @ $${a.price.toFixed(4)} amount=${a.amount.toFixed(4)} [${a.range}]`, 'info');
        }
        await logGridActivity({
            centerPrice,
            action: 'REFRESH',
            buyBudgetUsed,
            sellBudgetUsed,
            activeBuyOrders,
            activeSellOrders
        });
        return;
    }

    // Real Logic - One-by-one replacement
    try {
        if (!isRunning) return;
        const openOrders = await fetchOpenOrdersCached(bot, GRID_CONFIG.pair);
        if (!isRunning) return;
        
        // Separate orders by side and range (grid orders only; manual frontend orders are never touched)
        const existingBuyOrders = [];
        const existingSellOrders = [];
        const openGridOrderIds = [];
        let manualOrderCount = 0;
        const maxBuyPrice = buyPriceCap();
        if (maxBuyPrice !== Infinity) {
            log(maxBuyPrice > 0
                ? `🛡️ BUY GUARD: no buys above $${maxBuyPrice.toFixed(4)} (DEX - ${GRID_CONFIG.buyDexMarginPct}%, never under the $${buyPriceFloor()} floor)`
                : '🛡️ BUY GUARD: DEX price unknown — placing no buys this refresh', maxBuyPrice > 0 ? 'info' : 'warn');
        }
        
        for (const order of openOrders) {
            if (!isRunning) break;
            if (!isGridOrder(order)) {
                manualOrderCount++;
                continue;
            }
            openGridOrderIds.push(order.id);
            const orderPrice = parseFloat(order.price);
            // Every old order is replaced one by one below (new placed first), even
            // when the center moved and it's outside the new ranges: cancelling
            // those at once emptied the book until the new orders went up. Only a
            // buy above the buy-guard cap goes at once — it's an open arbitrage.
            const unsafeBuy = order.side === 'buy' && orderPrice > maxBuyPrice;

            if (order.side === 'buy' && !unsafeBuy) {
                existingBuyOrders.push(order);
            } else if (order.side === 'sell') {
                existingSellOrders.push(order);
            } else {
                // Buy above the guard cap - cancel immediately
                try {
                    await bot.cancelOrder(order.id, GRID_CONFIG.pair);
                    log(`🗑️ Cancelled grid buy above the guard cap: @ $${order.price.toFixed(4)}`, 'info');
                    await logGridOrderEvent({
                        orderId: order.id,
                        clientOrderId: order.clientOrderId || order.info?.custom_id,
                        side: order.side,
                        price: parseFloat(order.price),
                        amount: order.amount != null ? parseFloat(order.amount) : null,
                        action: 'CANCELLED',
                        priceRange: 'guard'
                    });
                    await delay(100);
                } catch (e) {
                    // Ignore
                }
            }
        }
        
        await detectAndLogFilledOrders(openGridOrderIds);

        // canBuy/canSell look at FREE balance only, which the grid's own open
        // orders lock up: a fully placed side can show under the minimum and
        // would then be cancelled entirely. A side with grid orders on the book
        // is fundable — each old order frees its funds when it's replaced.
        const buySideOn = canBuy || existingBuyOrders.length > 0;
        const sellSideOn = canSell || existingSellOrders.length > 0;
        
        // Generate target orders for each range
        const targetBuyOrders = [];
        const targetSellOrders = [];
        
        // Generate BUY target orders
        let clampedBuys = 0, skippedBuys = 0;
        if (buySideOn && GRID_CONFIG.priceRangeGrids && ranges.buy) {
            for (const range of ranges.buy) {
                const prices = calculateRandomPriceDistribution(range);
                const orderSizes = randomizeOrderSizes(range.totalValue, range.ordersPerRange);
                
                for (let i = 0; i < prices.length; i++) {
                    const price = clampBuyPrice(prices[i], maxBuyPrice);
                    if (price == null) { skippedBuys++; continue; }
                    if (price !== prices[i]) clampedBuys++;
                    const orderSize = orderSizes[i];
                    const amount = orderSize / price;
                    
                    // Apply precision using CCXT
                    const pricePrecision = bot.priceToPrecision(symbol, price);
                    const amountPrecision = bot.amountToPrecision(symbol, amount);
                    
                    targetBuyOrders.push({
                        side: 'buy',
                        price: pricePrecision,
                        amount: amountPrecision,
                        orderSize: orderSize,
                        range: range
                    });
                }
            }
        }
        
        // Generate SELL target orders
        if (sellSideOn && GRID_CONFIG.priceRangeGrids && ranges.sell) {
            for (const range of ranges.sell) {
                const prices = calculateRandomPriceDistribution(range);
                const orderSizes = randomizeOrderSizes(range.totalValue, range.ordersPerRange);
                
                for (let i = 0; i < prices.length; i++) {
                    const price = prices[i];
                    const orderSize = orderSizes[i];
                    const amount = orderSize / price;
                    
                    // Apply precision using CCXT
                    const pricePrecision = bot.priceToPrecision(symbol, price);
                    const amountPrecision = bot.amountToPrecision(symbol, amount);
                    
                    targetSellOrders.push({
                        side: 'sell',
                        price: pricePrecision,
                        amount: amountPrecision,
                        orderSize: orderSize,
                        range: range
                    });
                }
            }
        }
        
        if (clampedBuys > 0) log(`🛡️ BUY GUARD: ${clampedBuys} buy order(s) moved into $${buyPriceFloor().toFixed(4)}-$${maxBuyPrice.toFixed(4)} (floor - DEX cap)`, 'info');
        if (skippedBuys > 0) log(`🛡️ BUY GUARD: skipped ${skippedBuys} buy order(s) — DEX price unknown`, 'warn');
        log(`📊 Target: ${targetBuyOrders.length} buy, ${targetSellOrders.length} sell | Existing grid: ${existingBuyOrders.length} buy, ${existingSellOrders.length} sell` + (manualOrderCount > 0 ? ` | Manual (untouched): ${manualOrderCount}` : ''), 'info');
        
        // Calculate total operations and delay per operation to spread over 5 minutes
        const totalCancellations = existingBuyOrders.length + existingSellOrders.length;
        const totalPlacements = targetBuyOrders.length + targetSellOrders.length;
        const totalOperations = totalCancellations + totalPlacements;
        
        // Calculate delay between operations (spread over 5 minutes)
        // Leave 10 seconds buffer at the end
        const operationTimeWindow = (GRID_CONFIG.orderOperationTimeWindow - 10) * 1000; // Convert to ms
        const delayPerOperation = totalOperations > 0 ? Math.max(1000, operationTimeWindow / totalOperations) : 1000;
        
        log(`⏱️ Spreading ${totalOperations} operations over ${GRID_CONFIG.orderOperationTimeWindow}s (${(delayPerOperation/1000).toFixed(1)}s delay between operations)`, 'info');
        
        // Replace orders one at a time, PLACING the new order before CANCELLING
        // the old one, so a side never goes empty and the depth within 1% holds
        // mid-refresh (LBank's $500 rule). Only if the free balance can't fund
        // the new order while the old one still locks funds is the old one
        // cancelled first. Old orders with no new counterpart are cancelled.
        const cancelOld = async (side, oldOrder) => {
            try {
                await bot.cancelOrder(oldOrder.id, GRID_CONFIG.pair);
                log(`🗑️ Cancelled ${side} order @ $${parseFloat(oldOrder.price).toFixed(4)}`, 'info');
                await logGridOrderEvent({
                    orderId: oldOrder.id,
                    clientOrderId: oldOrder.clientOrderId || oldOrder.info?.custom_id,
                    side,
                    price: parseFloat(oldOrder.price),
                    amount: oldOrder.amount != null ? parseFloat(oldOrder.amount) : null,
                    action: 'CANCELLED',
                    priceRange: null
                });
            } catch (e) {
                log(`⚠️ Failed to cancel ${side} order: ${e.message}`, 'warn');
            }
            await delay(delayPerOperation); // Wait to avoid rate limits
        };
        const canFund = (side, order, bal) => !!bal && (side === 'buy'
            ? bal.usdt >= parseFloat(order.price) * parseFloat(order.amount)
            : bal.l1x >= parseFloat(order.amount));

        // Replace order i of one side: place the new one, then cancel the old one.
        const replaceAt = async (side, existing, targets, i) => {
                const label = side === 'buy' ? 'Buy' : 'Sell';
                const oldOrder = i < existing.length ? existing[i] : null;
                const newOrder = i < targets.length ? targets[i] : null;
                if (!newOrder) { if (oldOrder) await cancelOld(side, oldOrder); return; }

                // Refresh balance before placing
                invalidateBalanceCache();
                let currentBal = await checkBalances(bot);
                let oldDone = false;
                if (!canFund(side, newOrder, currentBal) && oldOrder) {
                    await cancelOld(side, oldOrder); // free its funds, then place
                    oldDone = true;
                    invalidateBalanceCache();
                    currentBal = await checkBalances(bot);
                }
                const orderSizeUsdt = parseFloat(newOrder.price) * parseFloat(newOrder.amount);
                if (!canFund(side, newOrder, currentBal)) {
                    log(side === 'buy'
                        ? `⚠️ Insufficient/unknown USDT for buy order ${i+1}. Need $${orderSizeUsdt.toFixed(2)}, have $${currentBal ? currentBal.usdt.toFixed(2) : 'n/a'}`
                        : `⚠️ Insufficient/unknown L1X for sell order ${i+1}. Need ${newOrder.amount}, have ${currentBal ? currentBal.l1x.toFixed(4) : 'n/a'}`, 'warn');
                    await delay(delayPerOperation); // Still wait to maintain timing
                    return;
                }

                try {
                    const cid = generateGridClientOrderId();
                    const placed = await bot.createOrder(
                        symbol,
                        'limit',
                        side,
                        newOrder.amount,
                        newOrder.price,
                        { clientOrderId: cid }
                    );
                    if (side === 'buy') { buyBudgetUsed += orderSizeUsdt; activeBuyOrders++; }
                    else { sellBudgetUsed += orderSizeUsdt; activeSellOrders++; }
                    log(`✅ ${label} ${i+1}/${targets.length}: $${orderSizeUsdt.toFixed(2)} @ $${newOrder.price} [${newOrder.range.minPrice}-${newOrder.range.maxPrice}]`, 'info');
                    await logGridOrderEvent({
                        orderId: placed.id,
                        clientOrderId: cid,
                        side,
                        price: parseFloat(newOrder.price),
                        amount: parseFloat(newOrder.amount),
                        valueUsdt: orderSizeUsdt,
                        action: 'PLACED',
                        priceRange: `${newOrder.range.minPrice}-${newOrder.range.maxPrice}`
                    });
                    await delay(delayPerOperation); // Wait to avoid rate limits
                } catch (e) {
                    log(`❌ Failed to place ${side} order ${i+1} @ $${newOrder.price}: ${e.message}`, 'warn');
                    await delay(delayPerOperation); // Still wait even on error
                }
                if (oldOrder && !oldDone) await cancelOld(side, oldOrder);
        };

        // Nearest the center first on both sides, and alternate buy/sell, so the
        // two sides move together and the spread stays tight while the center
        // shifts (all buys then all sells left them ~1% apart for minutes).
        existingBuyOrders.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        targetBuyOrders.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        existingSellOrders.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        targetSellOrders.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        const steps = Math.max(existingBuyOrders.length, targetBuyOrders.length, existingSellOrders.length, targetSellOrders.length);
        for (let i = 0; i < steps; i++) {
            if (!isRunning || checkTime()) break;
            await replaceAt('buy', existingBuyOrders, targetBuyOrders, i);
            if (!isRunning || checkTime()) break;
            await replaceAt('sell', existingSellOrders, targetSellOrders, i);
        }
        
        invalidateOpenOrdersCache();
        invalidateBalanceCache();
        
        const totalTime = Date.now() - startTime;
        const timeRemaining = ((MAX_OPERATION_TIME - totalTime) / 1000).toFixed(1);
        log(`✅ Grid refresh complete in ${(totalTime/1000).toFixed(1)}s / ${MAX_OPERATION_TIME/1000}s limit (${timeRemaining}s remaining). Placed: ${activeBuyOrders} buy, ${activeSellOrders} sell`, 'info');
        
    } catch (e) {
        log(`⚠️ Error in grid management: ${e.message}`, 'warn');
    }
   
    // Log grid activity
    await logGridActivity({
        centerPrice: centerPrice,
        action: 'REFRESH',
        buyBudgetUsed: buyBudgetUsed,
        sellBudgetUsed: sellBudgetUsed,
        activeBuyOrders: activeBuyOrders,
        activeSellOrders: activeSellOrders
    });
}

// ============================================================
// MAIN GRID MANAGER LOOP
// ============================================================
let isRunning = false;
let gridLoopInterval = null;
let gridBot = null;
let gridSymbol = null;

async function startGridManager() {
    if (isRunning) {
        log("⚠️ Grid Manager is already running!", 'warn');
        return;
    }
    
    log("🚀 Starting Grid Manager...", 'info');
    isRunning = true;
    
    // Initialize database
    await initDatabase();
    
    // Initialize bot
    const exchangeOptions = {
        enableRateLimit: true,
        options: {
            'defaultType': 'spot',
            'adjustForTimeDifference': true
        }
    };
    
    gridBot = new ccxt.lbank({
        apiKey: GRID_CONFIG.bot.apiKey,
        secret: GRID_CONFIG.bot.secret,
        ...exchangeOptions
    });
    // LBank's fetchCurrencies hits /v2/withdrawConfigs.do (heavily rate-limited,
    // 429) and blocks startup. The grid only trades, so skip currency loading.
    gridBot.has.fetchCurrencies = false;

    try {
        await gridBot.loadMarkets();
        log("✅ Connected to LBank", 'info');
    } catch (e) {
        log(`❌ Failed to connect: ${e.message}`, 'warn');
        isRunning = false;
        gridBot = null;
        return;
    }
    
    // Get the market symbol (CCXT handles conversion)
    const market = gridBot.market(GRID_CONFIG.pair);
    gridSymbol = market.id || GRID_CONFIG.pair;
    
    // Initial grid setup
    let currentPrice = await getCurrentPrice(gridBot, GRID_CONFIG.pair);
    if (!currentPrice) {
        log("❌ Could not fetch current price", 'warn');
        isRunning = false;
        gridBot = null;
        gridSymbol = null;
        return;
    }
    
    await maintainGrid(gridBot, await resolveGridCenter(currentPrice), gridSymbol);
    
    // Set up periodic refresh
    gridLoopInterval = setInterval(async () => {
        if (!isRunning) return;
        
        try {
            const price = await getCurrentPrice(gridBot, GRID_CONFIG.pair);
            if (price) {
                await maintainGrid(gridBot, await resolveGridCenter(price), gridSymbol);
            }
        } catch (e) {
            log(`⚠️ Error in grid loop: ${e.message}`, 'warn');
        }
    }, GRID_CONFIG.refreshIntervalSeconds * 1000);
    
    log(`✅ Grid Manager running. Refreshing every ${GRID_CONFIG.refreshIntervalSeconds} seconds.`, 'info');
}

/**
 * Cancel all grid orders quickly (batches of stopCancelBatchSize), then re-check
 * and retry once. Used on stop/restart, where pm2 kills the process soon after
 * the signal: spreading cancels over 5 minutes left most orders on the book.
 */
async function cancelAllOrders(bot, symbol) {
    if (GRID_CONFIG.dryRun) {
        log("🛑 [DRY RUN] Would cancel all orders", 'info');
        return;
    }
    
    setGridRefreshFlag();
    try {
        let cancelledCount = 0;
        let failedCount = 0;
        for (let pass = 1; pass <= 2; pass++) {
            invalidateOpenOrdersCache();
            const openOrders = await fetchOpenOrdersCached(bot, GRID_CONFIG.pair);
            const gridOrders = openOrders.filter(o => isGridOrder(o));
            const manual = openOrders.length - gridOrders.length;

            if (gridOrders.length === 0) {
                if (pass === 1) log("ℹ️ No grid orders to cancel" + (manual > 0 ? ` (${manual} manual order(s) left untouched)` : ''), 'info');
                break;
            }
            log(`🛑 ${pass === 1 ? 'Cancelling' : 'Retrying'} ${gridOrders.length} grid order(s)` + (manual > 0 ? ` (${manual} manual order(s) left untouched)` : '') + '...', 'warn');
            failedCount = 0;

            const size = GRID_CONFIG.stopCancelBatchSize;
            for (let i = 0; i < gridOrders.length; i += size) {
                const batch = gridOrders.slice(i, i + size);
                const results = await Promise.allSettled(batch.map(o => bot.cancelOrder(o.id, GRID_CONFIG.pair)));
                for (let j = 0; j < batch.length; j++) {
                    const order = batch[j];
                    if (results[j].status === 'fulfilled') {
                        cancelledCount++;
                        log(`🗑️ Cancelled grid order: ${order.side} @ $${parseFloat(order.price).toFixed(4)}`, 'info');
                        await logGridOrderEvent({
                            orderId: order.id,
                            clientOrderId: order.clientOrderId || order.info?.custom_id,
                            side: order.side,
                            price: parseFloat(order.price),
                            amount: order.amount != null ? parseFloat(order.amount) : null,
                            action: 'CANCELLED',
                            priceRange: 'stop'
                        });
                    } else {
                        failedCount++;
                        log(`⚠️ Failed to cancel grid order ${order.id}: ${results[j].reason?.message || results[j].reason}`, 'warn');
                    }
                }
                if (i + size < gridOrders.length) await delay(GRID_CONFIG.stopCancelBatchDelayMs);
            }
            // Re-check once even on success: an order placed by a refresh that was
            // mid-flight when the stop came in can appear after the first fetch.
            await delay(1000);
        }
        
        invalidateOpenOrdersCache();
        invalidateBalanceCache();
        
        log(`✅ Grid cancellation complete: ${cancelledCount} cancelled, ${failedCount} failed` + (failedCount > 0 ? ' — CHECK OPEN ORDERS ON LBANK' : ''), failedCount > 0 ? 'warn' : 'info');
    } catch (e) {
        log(`❌ Error cancelling orders: ${e.message} — CHECK OPEN ORDERS ON LBANK`, 'warn');
    } finally {
        clearGridRefreshFlag();
    }
}

async function stopGridManager() {
    if (!isRunning) {
        log("⚠️ Grid Manager is not running!", 'warn');
        return;
    }
    
    log("🛑 Stopping Grid Manager...", 'warn');
    isRunning = false;
    
    if (gridLoopInterval) {
        clearInterval(gridLoopInterval);
        gridLoopInterval = null;
    }
    
    // Cancel all grid orders before stopping
    if (gridBot && gridSymbol) {
        await cancelAllOrders(gridBot, gridSymbol);
    }
    
    if (dbPool) {
        dbPool.end();
        dbPool = null;
    }
    
    gridBot = null;
    gridSymbol = null;
    
    log("✅ Grid Manager stopped.", 'info');
}

// ============================================================
// STARTUP
// ============================================================
if (require.main === module) {
    // Run if executed directly
    startGridManager();
    
    // Handle shutdown: pm2 stop/restart sends SIGINT, a plain kill sends SIGTERM.
    // pm2 waits kill_timeout (ecosystem.config.js) before force-killing.
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n🛑 DETECTED SHUTDOWN SIGNAL (${signal})`);
        await stopGridManager();
        process.exit();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Export for use in other files
module.exports = {
    startGridManager,
    stopGridManager,
    maintainGrid,
    cancelAllOrders,
    GRID_CONFIG
};
