// ============================================================
// STANDALONE GRID MANAGER - Price Range Grid Order Placement
// Runs independently with its own bot and configuration
// BitMart Exchange Version
// ============================================================

const ccxt = require('ccxt');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Signals the arb monitor (arb/monitor.js) that our orders are being
// mass-cancelled, so it must not trust the L1X orderbook during this window.
const GRID_REFRESH_FLAG = path.join(__dirname, '..', 'arb', 'state', 'grid_refreshing_bitmart.flag');
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
        apiKey: process.env.BITMART_GRID_API_KEY || '',
        secret: process.env.BITMART_GRID_SECRET || '',
        uid: process.env.BITMART_GRID_UID || '', // BitMart requires UID
    },
    
    // Trading pair (CCXT format - will be converted internally)
    pair: 'L1X/USDT',
    
    // Dry run mode
    dryRun: false,
    
    // Minimum balances required
    minUsdtBalance: 10,
    minL1xBalance: 5,
    
    // Price Range Grid Configuration (BitMart-style)
    priceRangeGrids: {
        // SELL SIDE (Asks) - Above current price
        sell: [
            // $9.35 - $10: ~$650 total, evenly spread (tight clustering near price)
            { minPrice: 10.0, maxPrice: 11.0, totalValue: 25, ordersPerRange:2, spacing: 'medium' },
            { minPrice: 8.9, maxPrice: 10.0, totalValue: 25, ordersPerRange:2, spacing: 'medium' },
            { minPrice: 8.57, maxPrice: 8.585, totalValue: 45, ordersPerRange: 4, spacing: 'wide' }, 
            { minPrice: 8.55, maxPrice: 8.57, totalValue: 150, ordersPerRange: 8, spacing: 'tight' },  
            { minPrice: 8.53, maxPrice: 8.55, totalValue: 150, ordersPerRange: 8, spacing: 'medium' },           
            // Above $20: ~$20 (defensive, very wide)
            // { minPrice: 20.0, maxPrice: 25.0, totalValue: 20, ordersPerRange: 1, spacing: 'very_wide' }
        ],
        
        // BUY SIDE (Bids) - Below current price
        buy: [
            // $9 - $9.3: ~$660 cumulative (tight clustering near price)
            // { minPrice: 9.0, maxPrice: 9.3, totalValue: 660, ordersPerRange: 6, spacing: 'tight' },          
            // $8 - $9: ~$200+ (main support band)
            { minPrice: 8.44, maxPrice: 8.47, totalValue: 50, ordersPerRange: 3, spacing: 'medium' },  
            { minPrice: 8.415, maxPrice: 8.44, totalValue: 50, ordersPerRange: 6, spacing: 'medium' },  
            { minPrice: 8.41, maxPrice: 8.415, totalValue: 10, ordersPerRange: 1, spacing: 'medium' },                 // Below $8: Smaller defensive liquidity (wider spacing)
            { minPrice: 7.5, maxPrice: 8.4, totalValue: 10, ordersPerRange: 1, spacing: 'wide' },
            { minPrice: 7.0, maxPrice: 7.5, totalValue: 10, ordersPerRange: 1, spacing: 'wide' },
        ]
    },
    
    // Refresh interval (seconds)
    refreshIntervalSeconds: 600,
    
    // API Rate Limit Protection
    // Time window for placing/cancelling orders (seconds)
    orderOperationTimeWindow: 120, // 5 minutes = 300 seconds
    
    // Database configuration (optional, for logging)
    database: {
        host: process.env.BITMART_DB_HOST || '157.173.109.193',
        port: parseInt(process.env.BITMART_DB_PORT) || 25060,
        user: process.env.BITMART_DB_USER || 'root',
        password: process.env.BITMART_DB_PASSWORD || '',
        database: process.env.BITMART_DB_NAME || 'market-cap_production',
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

// Prefix for orders placed by the Grid Manager API. Only these are cancelled on refresh/stop.
// Manual frontend orders (no prefix) are never touched.
//
// BitMart clientOrderId constraints: alphanumeric only (letters + numbers).
// So we generate new IDs using an alphanumeric prefix with no "_" separators.
const GRID_ORDER_PREFIX = 'grid';
// Legacy prefix used by older versions of this script (kept for safe cleanup of existing orders).
const LEGACY_GRID_ORDER_PREFIX = 'grid_';

function isGridOrder(order) {
    const cid = order.clientOrderId || order.info?.custom_id;
    return (
        typeof cid === 'string' &&
        (cid.startsWith(GRID_ORDER_PREFIX) || cid.startsWith(LEGACY_GRID_ORDER_PREFIX))
    );
}

function generateGridClientOrderId() {
    // Alphanumeric only for BitMart (no underscores/dashes).
    // Example: "gridl9m8x1q8k3j9x2ab"
    return (
        GRID_ORDER_PREFIX +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 10)
    );
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
                CREATE TABLE IF NOT EXISTS grid_log (
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
                    bot_name VARCHAR(50) DEFAULT 'gridBot'
                )
            `);
            try {
                await dbPool.execute(`CREATE INDEX idx_grid_log_created_at ON grid_log(created_at DESC)`);
                await dbPool.execute(`CREATE INDEX idx_grid_log_action ON grid_log(action)`);
                await dbPool.execute(`CREATE INDEX idx_grid_log_order_id ON grid_log(order_id)`);
            } catch (e) { /* Indexes may exist */ }
            log("📊 grid_log table ready.", 'info');
            try {
                await dbPool.execute(`
                    INSERT INTO grid_log (action, center_price, buy_budget_used, sell_budget_used, active_buy_orders, active_sell_orders, bot_name)
                    VALUES ('START', 0, 0, 0, 0, 0, 'gridBot')
                `);
                log("📊 DB test write OK — check grid_log in database.", 'info');
            } catch (testErr) {
                log(`❌ DB test write failed: ${testErr.message}`, 'warn');
            }
        } catch (tableErr) {
            log(`❌ grid_log table setup failed: ${tableErr.message}`, 'warn');
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
            INSERT INTO grid_log (
                action, center_price, buy_budget_used, sell_budget_used,
                active_buy_orders, active_sell_orders, bot_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            activityData.action || 'REFRESH',
            activityData.centerPrice ?? null,
            activityData.buyBudgetUsed ?? 0,
            activityData.sellBudgetUsed ?? 0,
            activityData.activeBuyOrders ?? 0,
            activityData.activeSellOrders ?? 0,
            'gridBot'
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
            INSERT INTO grid_log (
                action, order_id, client_order_id, symbol, side, price, amount, value_usdt, price_range, bot_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            'gridBot'
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
            FROM grid_log e1
            WHERE e1.action = 'PLACED' AND e1.order_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM grid_log e2
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
async function checkBalances(bot) {
    if (GRID_CONFIG.dryRun) {
        return { usdt: 10000, l1x: 1000 }; // Simulated balances
    }
    
    const now = Date.now();
    if (balanceCache.data && (now - balanceCache.timestamp) < BALANCE_CACHE_TTL) {
        return balanceCache.data;
    }
    
    try {
        const bal = await bot.fetchBalance();
        const result = {
            usdt: bal['USDT'] ? bal['USDT'].free : 0,
            l1x: bal['L1X'] ? bal['L1X'].free : 0
        };
        balanceCache.data = result;
        balanceCache.timestamp = now;
        return result;
    } catch (e) {
        log(`⚠️ Balance fetch error: ${e.message}`, 'warn');
        return { usdt: 0, l1x: 0 };
    }
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

// BitMart minimum notional constraint (observed via error: "size * price >=5")
const MIN_ORDER_NOTIONAL_USDT = 5;

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
 * If (price * amount) is below BitMart min notional, try to adjust price UP within range
 * to meet the constraint. If not possible, return null to indicate skip.
 */
function adjustPriceToMeetMinNotional({ bot, symbol, price, amount, range }) {
    const priceNum = parseFloat(price);
    const amountNum = parseFloat(amount);
    if (!Number.isFinite(priceNum) || !Number.isFinite(amountNum) || amountNum <= 0) return null;

    if ((priceNum * amountNum) >= MIN_ORDER_NOTIONAL_USDT) {
        return { price, adjusted: false };
    }

    // Needed price to satisfy min notional with this fixed amount.
    const neededPrice = MIN_ORDER_NOTIONAL_USDT / amountNum;
    if (!Number.isFinite(neededPrice)) return null;

    // Must stay within configured range.
    if (neededPrice < range.minPrice || neededPrice > range.maxPrice) return null;

    // Apply exchange precision (may truncate), then verify again.
    let candidate = neededPrice;
    let candidateStr = bot.priceToPrecision(symbol, candidate);
    let candidateNum = parseFloat(candidateStr);

    // If truncation still fails min notional, try nudging up by 1 tick (if we can infer it).
    if ((candidateNum * amountNum) < MIN_ORDER_NOTIONAL_USDT) {
        const market = bot.market(GRID_CONFIG.pair);
        const pPrec = market?.precision?.price;
        if (typeof pPrec === 'number' && pPrec >= 0 && pPrec <= 18) {
            const tick = Math.pow(10, -pPrec);
            // Try a few small nudges to get over the threshold after rounding.
            for (let i = 0; i < 5; i++) {
                candidate = Math.min(range.maxPrice, candidate + tick);
                candidateStr = bot.priceToPrecision(symbol, candidate);
                candidateNum = parseFloat(candidateStr);
                if ((candidateNum * amountNum) >= MIN_ORDER_NOTIONAL_USDT) break;
            }
        }
    }

    if ((candidateNum * amountNum) < MIN_ORDER_NOTIONAL_USDT) return null;
    if (candidateNum < range.minPrice || candidateNum > range.maxPrice) return null;

    return { price: candidateStr, adjusted: true };
}

/**
 * Main Grid Manager Function - One-by-one replacement spread over 5 minutes
 */
async function maintainGrid(bot, centerPrice, symbol) {
    if (!isRunning) return;
    const startTime = Date.now();
    // Use orderOperationTimeWindow (5 minutes) for operation time limit
    // Add 10 seconds buffer to ensure we finish before next refresh
    const BUFFER_SECONDS = 10;
    const MAX_OPERATION_TIME = (GRID_CONFIG.orderOperationTimeWindow + BUFFER_SECONDS) * 1000;
    
    const botBals = await checkBalances(bot);
    if (!isRunning) return;
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
        
        if (GRID_CONFIG.priceRangeGrids && GRID_CONFIG.priceRangeGrids.buy) {
            for (const range of GRID_CONFIG.priceRangeGrids.buy) {
                const prices = calculateRandomPriceDistribution(range);
                const orderSizes = randomizeOrderSizes(range.totalValue, range.ordersPerRange);
                
                for (let i = 0; i < prices.length; i++) {
                    const price = prices[i];
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
        
        if (GRID_CONFIG.priceRangeGrids && GRID_CONFIG.priceRangeGrids.sell) {
            for (const range of GRID_CONFIG.priceRangeGrids.sell) {
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
        
        // Collect valid price ranges
        const validRanges = {
            buy: GRID_CONFIG.priceRangeGrids?.buy?.map(r => ({ min: r.minPrice, max: r.maxPrice })) || [],
            sell: GRID_CONFIG.priceRangeGrids?.sell?.map(r => ({ min: r.minPrice, max: r.maxPrice })) || []
        };
        
        // Separate orders by side and range (grid orders only; manual frontend orders are never touched)
        const existingBuyOrders = [];
        const existingSellOrders = [];
        const openGridOrderIds = [];
        let manualOrderCount = 0;
        
        for (const order of openOrders) {
            if (!isRunning) break;
            if (!isGridOrder(order)) {
                manualOrderCount++;
                continue;
            }
            openGridOrderIds.push(order.id);
            const orderPrice = parseFloat(order.price);
            const isBuyInRange = order.side === 'buy' && validRanges.buy.some(r => orderPrice >= r.min && orderPrice <= r.max);
            const isSellInRange = order.side === 'sell' && validRanges.sell.some(r => orderPrice >= r.min && orderPrice <= r.max);
            
            if (isBuyInRange) {
                existingBuyOrders.push(order);
            } else if (isSellInRange) {
                existingSellOrders.push(order);
            } else {
                // Grid order outside range - cancel immediately
                try {
                    await bot.cancelOrder(order.id, GRID_CONFIG.pair);
                    log(`🗑️ Cancelled grid order outside range: ${order.side} @ $${order.price.toFixed(4)}`, 'info');
                    await logGridOrderEvent({
                        orderId: order.id,
                        clientOrderId: order.clientOrderId || order.info?.custom_id,
                        side: order.side,
                        price: parseFloat(order.price),
                        amount: order.amount != null ? parseFloat(order.amount) : null,
                        action: 'CANCELLED',
                        priceRange: 'outside'
                    });
                    await delay(100);
                } catch (e) {
                    // Ignore
                }
            }
        }
        
        await detectAndLogFilledOrders(openGridOrderIds);
        
        // Generate target orders for each range
        const targetBuyOrders = [];
        const targetSellOrders = [];
        
        // Generate BUY target orders
        if (canBuy && GRID_CONFIG.priceRangeGrids && GRID_CONFIG.priceRangeGrids.buy) {
            for (const range of GRID_CONFIG.priceRangeGrids.buy) {
                const prices = calculateRandomPriceDistribution(range);
                const orderSizes = randomizeOrderSizes(range.totalValue, range.ordersPerRange);
                
                for (let i = 0; i < prices.length; i++) {
                    const price = prices[i];
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
        if (canSell && GRID_CONFIG.priceRangeGrids && GRID_CONFIG.priceRangeGrids.sell) {
            for (const range of GRID_CONFIG.priceRangeGrids.sell) {
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
        
        // STEP 1: Replace BUY orders one-by-one
        const maxReplacements = Math.max(existingBuyOrders.length, targetBuyOrders.length);
        
        for (let i = 0; i < maxReplacements; i++) {
            if (!isRunning) break;
            if (checkTime()) break;
            
            // Cancel old order if exists
            if (i < existingBuyOrders.length) {
                try {
                    const oldOrder = existingBuyOrders[i];
                    await bot.cancelOrder(oldOrder.id, GRID_CONFIG.pair);
                    log(`🗑️ Cancelled buy order @ $${oldOrder.price.toFixed(4)}`, 'info');
                    await logGridOrderEvent({
                        orderId: oldOrder.id,
                        clientOrderId: oldOrder.clientOrderId || oldOrder.info?.custom_id,
                        side: 'buy',
                        price: parseFloat(oldOrder.price),
                        amount: oldOrder.amount != null ? parseFloat(oldOrder.amount) : null,
                        action: 'CANCELLED',
                        priceRange: null
                    });
                    await delay(delayPerOperation); // Wait to avoid rate limits
                } catch (e) {
                    log(`⚠️ Failed to cancel buy order: ${e.message}`, 'warn');
                    await delay(delayPerOperation); // Still wait even on error
                }
            }
            
            // Place new order if exists
            if (i < targetBuyOrders.length) {
                if (!isRunning) break;
                if (checkTime()) break;
                
                const newOrder = targetBuyOrders[i];
                const adjustedBuy = adjustPriceToMeetMinNotional({
                    bot,
                    symbol,
                    price: newOrder.price,
                    amount: newOrder.amount,
                    range: newOrder.range
                });
                if (!adjustedBuy) {
                    const attemptedNotional = parseFloat(newOrder.price) * parseFloat(newOrder.amount);
                    log(`⚠️ Skipping buy order ${i+1}: notional $${Number.isFinite(attemptedNotional) ? attemptedNotional.toFixed(4) : 'NaN'} < $${MIN_ORDER_NOTIONAL_USDT} and cannot adjust within range [${newOrder.range.minPrice}-${newOrder.range.maxPrice}]`, 'warn');
                    await delay(delayPerOperation);
                    continue;
                }
                const priceToUse = adjustedBuy.price;
                
                // Refresh balance before placing
                invalidateBalanceCache();
                const currentBal = await checkBalances(bot);
                
                const orderSizeUsdt = parseFloat(priceToUse) * parseFloat(newOrder.amount);
                if (currentBal.usdt < orderSizeUsdt) {
                    log(`⚠️ Insufficient USDT for buy order ${i+1}. Need $${orderSizeUsdt.toFixed(2)}, have $${currentBal.usdt.toFixed(2)}`, 'warn');
                    await delay(delayPerOperation); // Still wait to maintain timing
                    continue;
                }
                
                try {
                    const cid = generateGridClientOrderId();
                    const placed = await bot.createOrder(
                        symbol,
                        'limit',
                        'buy',
                        newOrder.amount,
                        priceToUse,
                        { clientOrderId: cid }
                    );
                    
                    buyBudgetUsed += orderSizeUsdt;
                    activeBuyOrders++;
                    log(`✅ Buy ${i+1}/${targetBuyOrders.length}: $${orderSizeUsdt.toFixed(2)} @ $${priceToUse}${adjustedBuy.adjusted ? ' (adjusted)' : ''} [${newOrder.range.minPrice}-${newOrder.range.maxPrice}]`, 'info');
                    await logGridOrderEvent({
                        orderId: placed.id,
                        clientOrderId: cid,
                        side: 'buy',
                        price: parseFloat(priceToUse),
                        amount: parseFloat(newOrder.amount),
                        valueUsdt: orderSizeUsdt,
                        action: 'PLACED',
                        priceRange: `${newOrder.range.minPrice}-${newOrder.range.maxPrice}`
                    });
                    await delay(delayPerOperation); // Wait to avoid rate limits
                } catch (e) {
                    log(`❌ Failed to place buy order ${i+1} @ $${priceToUse}: ${e.message}`, 'warn');
                    await delay(delayPerOperation); // Still wait even on error
                }
            }
        }
        
        // STEP 2: Replace SELL orders one-by-one
        const maxSellReplacements = Math.max(existingSellOrders.length, targetSellOrders.length);
        
        for (let i = 0; i < maxSellReplacements; i++) {
            if (!isRunning) break;
            if (checkTime()) break;
            
            // Cancel old order if exists
            if (i < existingSellOrders.length) {
                try {
                    const oldOrder = existingSellOrders[i];
                    await bot.cancelOrder(oldOrder.id, GRID_CONFIG.pair);
                    log(`🗑️ Cancelled sell order @ $${oldOrder.price.toFixed(4)}`, 'info');
                    await logGridOrderEvent({
                        orderId: oldOrder.id,
                        clientOrderId: oldOrder.clientOrderId || oldOrder.info?.custom_id,
                        side: 'sell',
                        price: parseFloat(oldOrder.price),
                        amount: oldOrder.amount != null ? parseFloat(oldOrder.amount) : null,
                        action: 'CANCELLED',
                        priceRange: null
                    });
                    await delay(delayPerOperation); // Wait to avoid rate limits
                } catch (e) {
                    log(`⚠️ Failed to cancel sell order: ${e.message}`, 'warn');
                    await delay(delayPerOperation); // Still wait even on error
                }
            }
            
            // Place new order if exists
            if (i < targetSellOrders.length) {
                if (!isRunning) break;
                if (checkTime()) break;
                
                const newOrder = targetSellOrders[i];
                const adjustedSell = adjustPriceToMeetMinNotional({
                    bot,
                    symbol,
                    price: newOrder.price,
                    amount: newOrder.amount,
                    range: newOrder.range
                });
                if (!adjustedSell) {
                    const attemptedNotional = parseFloat(newOrder.price) * parseFloat(newOrder.amount);
                    log(`⚠️ Skipping sell order ${i+1}: notional $${Number.isFinite(attemptedNotional) ? attemptedNotional.toFixed(4) : 'NaN'} < $${MIN_ORDER_NOTIONAL_USDT} and cannot adjust within range [${newOrder.range.minPrice}-${newOrder.range.maxPrice}]`, 'warn');
                    await delay(delayPerOperation);
                    continue;
                }
                const priceToUse = adjustedSell.price;
                
                // Refresh balance before placing
                invalidateBalanceCache();
                const currentBal = await checkBalances(bot);
                
                if (currentBal.l1x < parseFloat(newOrder.amount)) {
                    log(`⚠️ Insufficient L1X for sell order ${i+1}. Need ${newOrder.amount}, have ${currentBal.l1x.toFixed(4)}`, 'warn');
                    await delay(delayPerOperation); // Still wait to maintain timing
                    continue;
                }
                
                try {
                    const cid = generateGridClientOrderId();
                    const placed = await bot.createOrder(
                        symbol,
                        'limit',
                        'sell',
                        newOrder.amount,
                        priceToUse,
                        { clientOrderId: cid }
                    );
                    
                    const orderSizeUsdt = parseFloat(priceToUse) * parseFloat(newOrder.amount);
                    sellBudgetUsed += orderSizeUsdt;
                    activeSellOrders++;
                    log(`✅ Sell ${i+1}/${targetSellOrders.length}: $${orderSizeUsdt.toFixed(2)} @ $${priceToUse}${adjustedSell.adjusted ? ' (adjusted)' : ''} [${newOrder.range.minPrice}-${newOrder.range.maxPrice}]`, 'info');
                    await logGridOrderEvent({
                        orderId: placed.id,
                        clientOrderId: cid,
                        side: 'sell',
                        price: parseFloat(priceToUse),
                        amount: parseFloat(newOrder.amount),
                        valueUsdt: orderSizeUsdt,
                        action: 'PLACED',
                        priceRange: `${newOrder.range.minPrice}-${newOrder.range.maxPrice}`
                    });
                    await delay(delayPerOperation); // Wait to avoid rate limits
                } catch (e) {
                    log(`❌ Failed to place sell order ${i+1} @ $${priceToUse}: ${e.message}`, 'warn');
                    await delay(delayPerOperation); // Still wait even on error
                }
            }
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
    
    gridBot = new ccxt.bitmart({
        apiKey: GRID_CONFIG.bot.apiKey,
        secret: GRID_CONFIG.bot.secret,
        uid: GRID_CONFIG.bot.uid, // BitMart requires UID
        ...exchangeOptions
    });
    
    try {
        await gridBot.loadMarkets();
        log("✅ Connected to BitMart", 'info');
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
    
    await maintainGrid(gridBot, currentPrice, gridSymbol);
    
    // Set up periodic refresh
    gridLoopInterval = setInterval(async () => {
        if (!isRunning) return;
        
        try {
            const price = await getCurrentPrice(gridBot, GRID_CONFIG.pair);
            if (price) {
                await maintainGrid(gridBot, price, gridSymbol);
            }
        } catch (e) {
            log(`⚠️ Error in grid loop: ${e.message}`, 'warn');
        }
    }, GRID_CONFIG.refreshIntervalSeconds * 1000);
    
    log(`✅ Grid Manager running. Refreshing every ${GRID_CONFIG.refreshIntervalSeconds} seconds.`, 'info');
}

/**
 * Cancel all open orders with rate limit protection (spread over 5 minutes)
 */
async function cancelAllOrders(bot, symbol) {
    if (GRID_CONFIG.dryRun) {
        log("🛑 [DRY RUN] Would cancel all orders", 'info');
        return;
    }
    
    setGridRefreshFlag();
    try {
        const openOrders = await fetchOpenOrdersCached(bot, GRID_CONFIG.pair);
        const gridOrders = openOrders.filter(o => isGridOrder(o));

        if (gridOrders.length === 0) {
            log("ℹ️ No grid orders to cancel" + (openOrders.length > 0 ? ` (${openOrders.length} manual order(s) left untouched)` : ''), 'info');
            return;
        }
        
        log(`🛑 Cancelling ${gridOrders.length} grid order(s) over ${GRID_CONFIG.orderOperationTimeWindow}s` + (openOrders.length > gridOrders.length ? ` (${openOrders.length - gridOrders.length} manual order(s) left untouched)` : '') + '...', 'warn');
        
        // Calculate delay per operation (spread over 5 minutes with 10s buffer)
        const operationTimeWindow = (GRID_CONFIG.orderOperationTimeWindow - 10) * 1000; // Convert to ms
        const delayPerOperation = Math.max(1000, operationTimeWindow / gridOrders.length);
        
        log(`⏱️ Delay between cancellations: ${(delayPerOperation/1000).toFixed(1)}s`, 'info');
        
        let cancelledCount = 0;
        let failedCount = 0;
        
        for (let i = 0; i < gridOrders.length; i++) {
            const order = gridOrders[i];
            try {
                await bot.cancelOrder(order.id, GRID_CONFIG.pair);
                cancelledCount++;
                log(`🗑️ Cancelled grid order ${i+1}/${gridOrders.length}: ${order.side} @ $${order.price.toFixed(4)}`, 'info');
                await logGridOrderEvent({
                    orderId: order.id,
                    clientOrderId: order.clientOrderId || order.info?.custom_id,
                    side: order.side,
                    price: parseFloat(order.price),
                    amount: order.amount != null ? parseFloat(order.amount) : null,
                    action: 'CANCELLED',
                    priceRange: 'stop'
                });
                if (i < gridOrders.length - 1) {
                    await delay(delayPerOperation);
                }
            } catch (e) {
                failedCount++;
                log(`⚠️ Failed to cancel grid order ${i+1}/${gridOrders.length} (${order.id}): ${e.message}`, 'warn');
                if (i < gridOrders.length - 1) {
                    await delay(delayPerOperation);
                }
            }
        }
        
        invalidateOpenOrdersCache();
        invalidateBalanceCache();
        
        log(`✅ Grid cancellation complete: ${cancelledCount} cancelled, ${failedCount} failed`, 'info');
    } catch (e) {
        log(`❌ Error cancelling orders: ${e.message}`, 'warn');
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
    
    // Cancel all orders before stopping (with rate limit protection)
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
    
    // Handle shutdown
    process.on('SIGINT', async () => {
        console.log("\n🛑 DETECTED SHUTDOWN SIGNAL (Ctrl+C)");
        await stopGridManager();
        process.exit();
    });
}

// Export for use in other files
module.exports = {
    startGridManager,
    stopGridManager,
    maintainGrid,
    cancelAllOrders,
    GRID_CONFIG
};
