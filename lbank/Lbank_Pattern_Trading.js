const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const ccxt = require('ccxt');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// --- SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 1. CONFIGURATION
// ============================================================
let CONFIG = {
    pair: 'L1X/USDT',
    dailyVolumeTarget: 50000, 

    // Time-based volume target
    timeTargetEnabled: true,
    timeTargetVolume: 50000,
    timeTargetHours: 24,
    
    // SAFETY BUFFER (USD)
    safeZoneBuffer: 0.0005, 

    // HARD FLOOR PRICE (USD)
    hardFloorPrice: 8.47,

    // HARD RESISTANCE PRICE (USD)
    hardResistancePrice: 8.53,

    // BEST-ASK SAFETY TRIGGER (USD)
    minBestAskToTrade: 8.48,

    checkPressureEveryMinutes: 5, 

    // Volume Trade Settings
    minTradeSize: 6,       
    maxTradeSize: 11,

    // Trend phase durations (minutes) - dry run simulation only
    trendUpMinMinutes: 15,
    trendUpMaxMinutes: 25,
    trendDownMinMinutes: 15,
    trendDownMaxMinutes: 25,
    volatileHoldMinMinutes: 30,
    volatileHoldMaxMinutes: 50,

    // Trend mode probabilities
    trendUpProbability: 0.20,
    trendDownProbability: 0.20,
    trendVolatileProbability: 0.60,
    trendNearFloorUpProbability: 0.99,
    trendNearResistanceDownProbability: 0.99,
    
    // API KEYS (LBank)
    botA: { 
        apiKey: process.env.LBANK_BOT_A_API_KEY || '',
        secret: process.env.LBANK_BOT_A_SECRET || '',
    },
    botB: { 
        apiKey: process.env.LBANK_BOT_B_API_KEY || '',
        secret: process.env.LBANK_BOT_B_SECRET || '',
    },

    dryRun: process.env.BOT_DRY_RUN !== 'false', // env-driven: dry-run unless BOT_DRY_RUN=false
    
    // MySQL DATABASE
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
// 1.5. API CACHE SYSTEM
// ============================================================
const balanceCache = { botA: { data: null, timestamp: 0 }, botB: { data: null, timestamp: 0 } };
const BALANCE_CACHE_TTL = 3000;
const openOrdersCache = { botA: { data: null, timestamp: 0 }, botB: { data: null, timestamp: 0 } };
const OPEN_ORDERS_CACHE_TTL = 3000;

function invalidateBalanceCache(botName) { if (balanceCache[botName]) balanceCache[botName].timestamp = 0; }
function invalidateOpenOrdersCache(botName) { if (openOrdersCache[botName]) openOrdersCache[botName].timestamp = 0; }

// ============================================================
// 2. DATABASE SETUP
// ============================================================
let dbPool = null;

const pendingDbWrites = {
    tradeHistory: [],
    systemLogs: [],
    inventory: []
};
const MAX_PENDING_DB_WRITES = 2000;

function enqueueDbWrite(queueName, payload) {
    const q = pendingDbWrites[queueName];
    if (!Array.isArray(q)) return;
    if (q.length >= MAX_PENDING_DB_WRITES) q.shift(); 
    q.push(payload);
}

async function flushPendingDbWrites() {
    if (!dbPool) return;

    while (pendingDbWrites.systemLogs.length > 0) {
        const item = pendingDbWrites.systemLogs.shift();
        try {
            await dbPool.execute(
                `INSERT INTO lbank_system_logs (log_level, message, is_dry_run) VALUES (?, ?, ?)`,
                [item.level?.toUpperCase?.() || String(item.level || 'INFO'), String(item.message || ''), CONFIG.dryRun ? 1 : 0]
            );
        } catch (e) {
            console.error('DB Flush Error (lbank_system_logs):', e.message);
            break;
        }
    }

    while (pendingDbWrites.tradeHistory.length > 0) {
        const item = pendingDbWrites.tradeHistory.shift();
        try {
            await logTradeHistory(item.data, item.update);
        } catch (e) {
            console.error('DB Flush Error (lbank_trade_history):', e.message);
            break;
        }
    }

    while (pendingDbWrites.inventory.length > 0) {
        const item = pendingDbWrites.inventory.shift();
        try {
            await logInventorySnapshot(item.botABal, item.botBBal, item.netChange);
        } catch (e) {
            console.error('DB Flush Error (lbank_inventory_snapshot):', e.message);
            break;
        }
    }
}

async function initDatabase() {
    try {
        dbPool = mysql.createPool(CONFIG.database);
        const connection = await dbPool.getConnection();
        await connection.ping();
        connection.release();
        
        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS lbank_trade_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                pair VARCHAR(20) NOT NULL,
                side VARCHAR(10) NOT NULL,
                price DECIMAL(20, 8) NOT NULL,
                amount DECIMAL(20, 8) NOT NULL,
                total_usd DECIMAL(20, 8) NOT NULL,
                trend_progress DECIMAL(5, 2) DEFAULT 0,
                maker_bot VARCHAR(10),
                taker_bot VARCHAR(10),
                maker_order_id VARCHAR(100),
                maker_order_status VARCHAR(20) DEFAULT 'PENDING',
                taker_order_id VARCHAR(100),
                taker_order_status VARCHAR(20) DEFAULT 'PENDING',
                taker_price DECIMAL(20, 8) DEFAULT NULL,
                taker_amount DECIMAL(20, 8) DEFAULT NULL,
                taker_total_usd DECIMAL(20, 8) DEFAULT NULL,
                execution_time_ms INT,
                is_dry_run BOOLEAN DEFAULT FALSE
            )
        `);

        try { await dbPool.execute(`ALTER TABLE lbank_trade_history ADD COLUMN trend_progress DECIMAL(5, 2) DEFAULT 0 AFTER total_usd`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE lbank_trade_history ADD COLUMN taker_price DECIMAL(20, 8) DEFAULT NULL AFTER taker_order_status`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE lbank_trade_history ADD COLUMN taker_amount DECIMAL(20, 8) DEFAULT NULL AFTER taker_price`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE lbank_trade_history ADD COLUMN taker_total_usd DECIMAL(20, 8) DEFAULT NULL AFTER taker_amount`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE lbank_trade_history ADD COLUMN is_dry_run BOOLEAN DEFAULT FALSE`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE lbank_trade_history ADD COLUMN execution_time_ms INT`); } catch (_) {}

        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS lbank_inventory_snapshot (
                id INT AUTO_INCREMENT PRIMARY KEY,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                bot_a_usdt DECIMAL(20, 8) DEFAULT 0,
                bot_a_token DECIMAL(20, 8) DEFAULT 0,
                bot_b_usdt DECIMAL(20, 8) DEFAULT 0,
                bot_b_token DECIMAL(20, 8) DEFAULT 0,
                net_token_change DECIMAL(20, 8) DEFAULT 0,
                is_dry_run TINYINT(1) NOT NULL DEFAULT 0
            )
        `);

        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS lbank_system_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                log_level VARCHAR(20) NOT NULL,
                message TEXT,
                is_dry_run TINYINT(1) NOT NULL DEFAULT 0
            )
        `);

        broadcastLog("📊 Database connected.", 'info');
        await logSystemLog('INFO', 'Database initialized successfully');
        await flushPendingDbWrites();
    } catch (error) {
        dbPool = null;
        broadcastLog(`❌ Database connection failed: ${error.message}`, 'warn');
        try { await logSystemLog('ERROR', `Database connection failed: ${error.message}`); } catch (_) {}
    }
}

// ============================================================
// 3. LOGGING FUNCTIONS
// ============================================================
async function logTradeHistory(tradeData, updateExisting = false) {
    if (!dbPool) {
        enqueueDbWrite('tradeHistory', { data: tradeData, update: updateExisting });
        return;
    }
    try {
        if (updateExisting && tradeData.makerOrderId) {
            await dbPool.execute(`
                UPDATE lbank_trade_history SET
                    taker_order_id = ?,
                    taker_order_status = ?,
                    maker_order_status = ?,
                    taker_price = ?,
                    taker_amount = ?,
                    taker_total_usd = ?,
                    execution_time_ms = ?
                WHERE maker_order_id = ?
                ORDER BY id DESC
                LIMIT 1
            `, [
                tradeData.takerOrderId || null,
                tradeData.takerOrderStatus || 'PENDING',
                tradeData.makerOrderStatus || 'OPEN',
                tradeData.takerPrice || null,
                tradeData.takerAmount || null,
                tradeData.takerTotalUsd || null,
                tradeData.executionTimeMs || null,
                tradeData.makerOrderId
            ]);
        } else {
            await dbPool.execute(`
                INSERT INTO lbank_trade_history (
                    pair, side, price, amount, total_usd, trend_progress,
                    maker_bot, taker_bot, maker_order_id, maker_order_status,
                    taker_order_id, taker_order_status, execution_time_ms, is_dry_run
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                tradeData.pair || CONFIG.pair,
                (tradeData.side && typeof tradeData.side === 'string') ? tradeData.side.toUpperCase() : tradeData.side,
                tradeData.price,
                tradeData.amount,
                tradeData.totalUsd,
                tradeData.trendProgress || 0,
                tradeData.makerBot || null,
                tradeData.takerBot || null,
                tradeData.makerOrderId || null,
                tradeData.makerOrderStatus || 'PENDING',
                tradeData.takerOrderId || null,
                tradeData.takerOrderStatus || 'PENDING',
                tradeData.executionTimeMs || null,
                CONFIG.dryRun ? 1 : 0
            ]);
        }
    } catch (e) {
        console.error('DB Log Error (lbank_trade_history):', e.message);
        broadcastLog(`❌ DB Log Error (lbank_trade_history): ${e.message}`, 'warn');
        if (dbPool) {
             try { await dbPool.execute(`INSERT INTO lbank_system_logs (log_level, message, is_dry_run) VALUES (?, ?, ?)`, ['ERROR', `DB Log Error: ${e.message}`, CONFIG.dryRun ? 1 : 0]); } catch(_) {}
        }
    }
}

async function logSystemLog(level, message) {
    if (!dbPool) {
        enqueueDbWrite('systemLogs', { level, message });
        return;
    }
    try {
        await dbPool.execute(`INSERT INTO lbank_system_logs (log_level, message, is_dry_run) VALUES (?, ?, ?)`, [
            (level && typeof level === 'string') ? level.toUpperCase() : level,
            message,
            CONFIG.dryRun ? 1 : 0
        ]);
    } catch (e) {
        console.error('DB Log Error (lbank_system_logs):', e.message);
    }
}

async function logInventorySnapshot(botABal, botBBal, netChange) {
    if (!dbPool) {
        enqueueDbWrite('inventory', { botABal, botBBal, netChange });
        return;
    }
    try {
        await dbPool.execute(
            `INSERT INTO lbank_inventory_snapshot (bot_a_usdt, bot_a_token, bot_b_usdt, bot_b_token, net_token_change, is_dry_run) VALUES (?,?,?,?,?,?)`,
            [botABal.usdt, botABal.l1x, botBBal.usdt, botBBal.l1x, netChange, CONFIG.dryRun ? 1 : 0]
        );
    } catch (e) {
        console.error('DB Log Error (lbank_inventory_snapshot):', e.message);
    }
}

// ============================================================
// 4. HELPERS
// ============================================================
let isRunning = false;
let stats = { volume: 0, count: 0 };
let balances = { botA: { usdt: 5000, l1x: 500 }, botB: { usdt: 5000, l1x: 500 } };
let initialInventorySnapshot = { botA: { usdt: 0, l1x: 0 }, botB: { usdt: 0, l1x: 0 } };

// Global Simulation Price for Dry Run (Persists across loops)
let simPrice = 0;

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomVal = (min, max) => Math.random() * (max - min) + min;

// --- Gaussian Random (Bell Curve) ---
function gaussianRandom(mean, stdev) {
    const u = 1 - Math.random(); 
    const v = Math.random();
    const z = Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
    return z * stdev + mean;
}

// --- Linear Interpolation ---
function lerp(start, end, t) {
    return start * (1 - t) + end * t;
}

// --- MICRO-TREND MANAGER (Strictly Bounded) ---
let microTrend = {
    startPrice: 0,
    targetPrice: 0,
    startTime: 0,
    endTime: 0,
    mode: 'SIDEWAYS',
    volatility: 0.0005 // Default low volatility
};

function updateMicroTrend(currentPrice, floor, resistance) {
    const now = Date.now();
    
    if (microTrend.startPrice === 0) microTrend.startPrice = currentPrice;

    if (now > microTrend.endTime) {
        // Reset Start Price to where we are now
        microTrend.startPrice = currentPrice;
        
        const rand = Math.random();
        const rangeTotal = resistance - floor;
        const distToFloor = currentPrice - floor;
        const distToResist = resistance - currentPrice;

        let totalProb = (CONFIG.trendUpProbability || 0) + (CONFIG.trendDownProbability || 0) + (CONFIG.trendVolatileProbability || 0);
        if (totalProb <= 0) totalProb = 1;
        let probTrendUp = (CONFIG.trendUpProbability ?? 0.35) / totalProb;
        let probTrendDown = (CONFIG.trendDownProbability ?? 0.35) / totalProb;

        if (distToFloor < (rangeTotal * 0.15)) {
            probTrendUp = CONFIG.trendNearFloorUpProbability ?? 0.8;
            probTrendDown = 0;
        }
        if (distToResist < (rangeTotal * 0.15)) {
            probTrendUp = 0;
            probTrendDown = CONFIG.trendNearResistanceDownProbability ?? 0.8;
        }

        if (rand < probTrendUp) {
            microTrend.mode = 'TREND_UP';
            microTrend.targetPrice = randomVal(currentPrice + (rangeTotal * 0.4), resistance);
            const duration = randomVal(CONFIG.trendUpMinMinutes * 60 * 1000, CONFIG.trendUpMaxMinutes * 60 * 1000);
            microTrend.endTime = now + duration;
            microTrend.volatility = 0.0008; 
            
        } else if (rand < (probTrendUp + probTrendDown)) {
            microTrend.mode = 'TREND_DOWN';
            microTrend.targetPrice = randomVal(floor, currentPrice - (rangeTotal * 0.4));
            const duration = randomVal(CONFIG.trendDownMinMinutes * 60 * 1000, CONFIG.trendDownMaxMinutes * 60 * 1000);
            microTrend.endTime = now + duration;
            microTrend.volatility = 0.0008;

        } else {
            microTrend.mode = 'VOLATILE_HOLD';
            microTrend.targetPrice = currentPrice + randomVal(-0.002, 0.002);
            const duration = randomVal(CONFIG.volatileHoldMinMinutes * 60 * 1000, CONFIG.volatileHoldMaxMinutes * 60 * 1000);
            microTrend.endTime = now + duration;
            microTrend.volatility = 0.0035; 
        }
        
        // Strict Clamp
        microTrend.targetPrice = Math.max(floor, Math.min(resistance, microTrend.targetPrice));
        microTrend.startTime = now;

        broadcastLog(`🌊 PATTERN: ${microTrend.mode} -> ${microTrend.targetPrice.toFixed(4)} (Vol: ${microTrend.volatility})`, 'info');
    }
}

// ------------------------------------------------------------
// BROADCAST LOGGING (Terminal + Frontend)
// ------------------------------------------------------------
const TERM_COLORS = {
    RESET: "\x1b[0m", RED: "\x1b[31m", GREEN: "\x1b[32m", YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m", CYAN: "\x1b[36m", WHITE: "\x1b[37m", GRAY: "\x1b[90m"
};

function broadcastLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US',{hour12:false});
    io.emit('log', { time, msg, type });
    let color = TERM_COLORS.WHITE;
    if (type === 'warn' || type === 'error') color = TERM_COLORS.YELLOW;
    else if (type === 'res' || type === 'success') color = TERM_COLORS.GREEN;
    else if (type === 'req' || type === 'info') color = TERM_COLORS.CYAN;
    console.log(`${TERM_COLORS.GRAY}[${time}]${TERM_COLORS.RESET} ${color}${msg}${TERM_COLORS.RESET}`);
}

function isOrderFilled(order, fallbackAmount = null) {
    if (!order) return false;
    const status = (order.status || order.info?.status || '').toLowerCase();
    if (status === 'closed' || status === 'filled' || status === 'completed') return true;
    const filled = parseFloat(order.filled);
    const amount = parseFloat(order.amount);
    if (!Number.isFinite(filled) || !Number.isFinite(amount)) return false;
    return Math.abs(filled - amount) < 0.0000001 || filled >= amount;
}

async function fetchOrderSafe(bot, orderId, pair) {
    try { return await bot.fetchOrder(orderId, pair); } catch (e) { return null; }
}

async function waitForBothFills({ makerBot, takerBot, makerOrderId, takerOrderId, pair, makerAmount, takerAmount, timeoutMs = 10000 }) {
    const start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
        const makerOrder = await fetchOrderSafe(makerBot, makerOrderId, pair);
        const takerOrder = await fetchOrderSafe(takerBot, takerOrderId, pair);
        if (isOrderFilled(makerOrder, makerAmount) && isOrderFilled(takerOrder, takerAmount)) {
            return { success: true, makerOrder, takerOrder };
        }
        await delay(500);
    }
    return { success: false };
}

function deriveDbOrderStatus(order, fallbackAmount = null) {
    if (!order) return 'PENDING';
    const status = (order.status || order.info?.status || '').toString().toLowerCase();
    if (isOrderFilled(order, fallbackAmount)) return 'FILLED';
    const filled = typeof order.filled === 'number' ? order.filled : Number.parseFloat(order.filled);
    const amount = typeof order.amount === 'number' ? order.amount : Number.parseFloat(order.amount);
    const target = Number.isFinite(amount) ? amount : (Number.isFinite(fallbackAmount) ? fallbackAmount : NaN);
    if (Number.isFinite(filled) && filled > 0 && Number.isFinite(target) && target > 0 && filled < target) return 'PARTIAL_FILLED';
    if (status === 'open' || status === 'pending' || status === 'new') return 'OPEN';
    if (status === 'canceled' || status === 'cancelled' || status === 'cancel') return 'CANCELLED';
    return 'PENDING';
}

async function syncOrderStatuses(botA, botB) {
    if (!dbPool || CONFIG.dryRun) return;
    try {
        const [rows] = await dbPool.execute(`
            SELECT id, maker_bot, taker_bot, maker_order_id, taker_order_id, maker_order_status, taker_order_status, amount
            FROM lbank_trade_history
            WHERE (maker_order_id IS NOT NULL OR taker_order_id IS NOT NULL)
              AND (maker_order_status IN ('OPEN','PENDING','PARTIAL_FILLED') OR taker_order_status IN ('OPEN','PENDING','PARTIAL_FILLED'))
            ORDER BY id DESC LIMIT 100
        `);
        if (!rows || rows.length === 0) return;
        let updated = 0;
        for (const r of rows) {
            try {
                let makerNew = r.maker_order_status, takerNew = r.taker_order_status;
                if (r.maker_order_id && r.maker_bot) {
                    const makerBot = r.maker_bot === 'botA' ? botA : (r.maker_bot === 'botB' ? botB : null);
                    if (makerBot) {
                        const makerOrder = await fetchOrderSafe(makerBot, r.maker_order_id, CONFIG.pair);
                        makerNew = deriveDbOrderStatus(makerOrder, Number(r.amount));
                    }
                }
                if (r.taker_order_id && r.taker_bot) {
                    const takerBot = r.taker_bot === 'botA' ? botA : (r.taker_bot === 'botB' ? botB : null);
                    if (takerBot) {
                        const takerOrder = await fetchOrderSafe(takerBot, r.taker_order_id, CONFIG.pair);
                        takerNew = deriveDbOrderStatus(takerOrder, Number(r.amount));
                    }
                }
                if (makerNew !== r.maker_order_status || takerNew !== r.taker_order_status) {
                    await dbPool.execute(
                        `UPDATE lbank_trade_history SET maker_order_status = ?, taker_order_status = ? WHERE id = ?`,
                        [makerNew, takerNew, r.id]
                    );
                    updated++;
                }
            } catch (_) {}
        }
        if (updated > 0) broadcastLog(`🔄 Synced ${updated} order status(es) from exchange`, 'info');
    } catch (e) { broadcastLog(`⚠️ Order status sync failed: ${e.message}`, 'warn'); }
}

async function cancelPendingOrders(botA, botB) {
    if (CONFIG.dryRun) return;
    try {
        const botAOrders = await botA.fetchOpenOrders(CONFIG.pair);
        const botBOrders = await botB.fetchOpenOrders(CONFIG.pair);
        let count = 0;
        for (const o of botAOrders) { await botA.cancelOrder(o.id, CONFIG.pair).catch(() => {}); count++; }
        for (const o of botBOrders) { await botB.cancelOrder(o.id, CONFIG.pair).catch(() => {}); count++; }
        if (count > 0) broadcastLog(`🧹 Cleaned ${count} stuck orders`, 'info');
        invalidateOpenOrdersCache('botA');
        invalidateOpenOrdersCache('botB');
    } catch (e) {}
}

async function checkBalances(bot, botName) {
    if (CONFIG.dryRun) return balances[botName];
    const now = Date.now();
    if (balanceCache[botName].data && (now - balanceCache[botName].timestamp) < BALANCE_CACHE_TTL) return balanceCache[botName].data;
    try {
        const bal = await bot.fetchBalance();
        const res = { usdt: bal['USDT'] ? bal['USDT'].free : 0, l1x: bal['L1X'] ? bal['L1X'].free : 0 };
        balanceCache[botName] = { data: res, timestamp: now };
        return res;
    } catch (e) { return { usdt: 0, l1x: 0 }; }
}

async function takeAndLogInventorySnapshot(botA, botB, reason = '') {
    try {
        const [botABal, botBBal] = await Promise.all([ checkBalances(botA, 'botA'), checkBalances(botB, 'botB') ]);
        const currentTotal = (botABal.l1x || 0) + (botBBal.l1x || 0);
        const netChange = currentTotal - ((initialInventorySnapshot.botA.l1x || 0) + (initialInventorySnapshot.botB.l1x || 0));
        const label = reason || 'periodic';
        broadcastLog(`🏦 Inventory Snapshot (${label}): botA USDT=${(botABal.usdt || 0).toFixed(2)} L1X=${(botABal.l1x || 0).toFixed(4)} | botB USDT=${(botBBal.usdt || 0).toFixed(2)} L1X=${(botBBal.l1x || 0).toFixed(4)} | Net ΔL1X=${netChange.toFixed(4)}`, 'info');
        await logInventorySnapshot(botABal, botBBal, netChange);
    } catch (e) {}
}

async function fetchTickerCached(bot, pair) { return await bot.fetchTicker(pair); }

function calculateOrganicSleep(startTime, currentVol) {
    const dailyRemainingVol = (CONFIG.dailyVolumeTarget || 0) - currentVol;
    if (!CONFIG.timeTargetEnabled) {
        if (dailyRemainingVol <= 0) return { sleepMs: 60000 };
        return { sleepMs: randomVal(10000, 30000) };
    }
    const targetVol = Number(CONFIG.timeTargetVolume);
    const hours = Number(CONFIG.timeTargetHours);
    const totalMs = hours * 60 * 60 * 1000;
    const elapsedMs = Date.now() - startTime;
    const remainingMs = totalMs - elapsedMs;
    const remainingVol = targetVol - currentVol;

    if (!Number.isFinite(targetVol) || targetVol <= 0 || !Number.isFinite(totalMs) || totalMs <= 0) {
        return { sleepMs: randomVal(10000, 30000) };
    }
    if (remainingVol <= 0) return { sleepMs: 60000 };
    if (remainingMs <= 0) return { sleepMs: 0 };

    const fallbackAvgUsd = (Number(CONFIG.minTradeSize) + Number(CONFIG.maxTradeSize)) / 2;
    const avgUsdPerTrade = (stats.count && stats.count > 0 && Number.isFinite(currentVol))
        ? (currentVol / stats.count)
        : (Number.isFinite(fallbackAvgUsd) && fallbackAvgUsd > 0 ? fallbackAvgUsd : 1);

    const tradesNeeded = Math.max(1, Math.ceil(remainingVol / avgUsdPerTrade));
    const desiredSleepMs = Math.floor(remainingMs / tradesNeeded);
    const sleepMs = Math.max(1000, Math.min(30000, desiredSleepMs));
    return { sleepMs };
}

// ============================================================
// 5. TRADE LOGIC
// ============================================================
function decidePreferredMakerForBuyOnly(balA, balB, price) {
    const minUsdt = 10;
    const aUsdt = Math.max(0, (balA?.usdt || 0) - minUsdt);
    const bUsdt = Math.max(0, (balB?.usdt || 0) - minUsdt);
    if (aUsdt > bUsdt) return { preferredMakerBotName: 'botA', reason: 'botA has more USDT' };
    return { preferredMakerBotName: 'botB', reason: 'botB has more USDT' };
}

async function validateAndPlaceTradeWithFallback(botA, botB, side, usdSize, price, preferredMakerBotName) {
    const [balA, balB] = await Promise.all([checkBalances(botA, 'botA'), checkBalances(botB, 'botB')]);
    const minUsdt = 10;
    
    const tryPair = (makerName) => {
        const makerBal = makerName === 'botA' ? balA : balB;
        const takerBal = makerName === 'botA' ? balB : balA;
        const makerBot = makerName === 'botA' ? botA : botB;
        const takerBot = makerName === 'botA' ? botB : botA;
        
        if (side === 'buy') {
            if ((makerBal.usdt - minUsdt) > usdSize && (takerBal.l1x * price) > usdSize) return { makerBot, takerBot, makerName, takerName: makerName === 'botA' ? 'botB' : 'botA' };
        } else {
            if ((makerBal.l1x * price) > usdSize && (takerBal.usdt - minUsdt) > usdSize) return { makerBot, takerBot, makerName, takerName: makerName === 'botA' ? 'botB' : 'botA' };
        }
        return null;
    };

    let res = tryPair(preferredMakerBotName) || tryPair(preferredMakerBotName === 'botA' ? 'botB' : 'botA');
    if (!res) return { success: false, reason: 'Insufficient Funds' };

    return {
        success: true,
        makerBot: res.makerBot, takerBot: res.takerBot, makerBotName: res.makerName, takerBotName: res.takerName,
        finalUsdSize: usdSize,
        finalAmountStr: (usdSize / price).toFixed(4),
        finalPriceStr: price.toFixed(4),
        side
    };
}

// ============================================================
// 6. MAIN ENGINE (STRICT LBANK VERSION)
// ============================================================
async function runLiveEngine() {
    broadcastLog("🚀 STARTING STRICT PURE VOLUME ENGINE (LBank)...", 'req');
    await initDatabase();
    isRunning = true;
    io.emit('status_update', true);

    const exOpt = { enableRateLimit: true, options: { 'defaultType': 'spot', 'adjustForTimeDifference': true } };
    let botA, botB;
    try {
        botA = new ccxt.lbank({ apiKey: CONFIG.botA.apiKey, secret: CONFIG.botA.secret, ...exOpt });
        botB = new ccxt.lbank({ apiKey: CONFIG.botB.apiKey, secret: CONFIG.botB.secret, ...exOpt });
        if(!CONFIG.dryRun) { await botA.loadMarkets(); await botB.loadMarkets(); }
    } catch(e) { isRunning = false; return broadcastLog("❌ Init Failed: " + e.message, 'warn'); }

    const rawSymbol = CONFIG.pair; // LBank handles L1X/USDT correctly
    let startTime = Date.now();
    const volumeTarget = CONFIG.timeTargetVolume; 
    const timeLimit = startTime + (CONFIG.timeTargetHours * 3600000);

    if (CONFIG.dryRun) {
        simPrice = (CONFIG.hardFloorPrice + CONFIG.hardResistancePrice) / 2;
    }

    initialInventorySnapshot = { botA: await checkBalances(botA,'botA'), botB: await checkBalances(botB,'botB') };
    if (CONFIG.timeTargetEnabled) {
        broadcastLog(`⏱️ Time target enabled: $${Number(volumeTarget).toFixed(2)} in ${CONFIG.timeTargetHours} hour(s)`, 'info');
    }
    await takeAndLogInventorySnapshot(botA, botB, 'initial');

    while (isRunning && stats.volume < volumeTarget && Date.now() < timeLimit) {
        try {
            if(!isRunning) break;

            // 1. GET MARKET DATA
            let bestBid, bestAsk;
            if (CONFIG.dryRun) {
                if (microTrend.targetPrice > 0) {
                    let move = (microTrend.targetPrice - simPrice) * 0.05; 
                    simPrice += move;
                }
                simPrice += randomVal(-0.0005, 0.0005);
                simPrice = Math.max(CONFIG.hardFloorPrice, Math.min(CONFIG.hardResistancePrice, simPrice));
                bestBid = simPrice; 
                bestAsk = simPrice + 0.003; 
            } else {
                const book = await botA.fetchOrderBook(CONFIG.pair);
                bestBid = book.bids[0][0];
                bestAsk = book.asks[0][0];
            }

            // 2. STRICT GATEKEEPER CHECK
            const minAskLimit = Number(CONFIG.minBestAskToTrade);
            if (bestAsk < minAskLimit) {
                broadcastLog(`🛑 GATEKEEPER: Best Ask (${bestAsk.toFixed(4)}) < Min Limit (${minAskLimit}). Waiting.`, 'warn');
                await delay(5000); continue; 
            }

            // 3. DEFINE VALID TRADING BAND
            let lowerBound = Math.max(bestBid + CONFIG.safeZoneBuffer, CONFIG.hardFloorPrice);
            let upperBound = Math.min(bestAsk - CONFIG.safeZoneBuffer, CONFIG.hardResistancePrice);

            if (lowerBound >= upperBound) {
                broadcastLog(`⚠️ No trade room. Spread: ${bestBid.toFixed(4)}-${bestAsk.toFixed(4)} vs Limits: ${CONFIG.hardFloorPrice}-${CONFIG.hardResistancePrice}`, 'warn');
                await delay(5000); continue;
            }

            // 4. NATURAL PRICE CALCULATION
            const currentMid = (bestBid + bestAsk) / 2;
            updateMicroTrend(currentMid, CONFIG.hardFloorPrice, CONFIG.hardResistancePrice);

            const now = Date.now();
            const progress = Math.max(0, Math.min(1, (now - microTrend.startTime) / (microTrend.endTime - microTrend.startTime)));
            let basePrice = lerp(microTrend.startPrice, microTrend.targetPrice, progress);
            let naturalPrice = gaussianRandom(basePrice, microTrend.volatility);

            // 5. FINAL STRICT CLAMP
            let targetPrice = Math.max(lowerBound, Math.min(upperBound, naturalPrice));

            // 6. EXECUTE
            const usdSize = randomVal(CONFIG.minTradeSize, CONFIG.maxTradeSize);
            const side = 'buy';
            const [balA, balB] = await Promise.all([checkBalances(botA, 'botA'), checkBalances(botB, 'botB')]);
            const { preferredMakerBotName, reason: makerReason } = decidePreferredMakerForBuyOnly(balA, balB, targetPrice);
            const tradeInfo = await validateAndPlaceTradeWithFallback(botA, botB, side, usdSize, targetPrice, preferredMakerBotName);

            if (!tradeInfo.success) {
                broadcastLog("⚠️ Funds low.", 'warn');
                await delay(5000); continue;
            }

            const { makerBot, takerBot, makerBotName, takerBotName, finalAmountStr, finalPriceStr, finalUsdSize } = tradeInfo;
            const oppSide = 'sell';

            broadcastLog(`⚡ VOL: ${side.toUpperCase()} ${finalAmountStr} @ ${finalPriceStr} (buy-only: ${makerReason})`, 'info');

            if (CONFIG.dryRun) {
                broadcastLog(`✅ Dry run: trade simulated. Counting volume.`, 'success');
                stats.volume += finalUsdSize;
                stats.count++;
                await logTradeHistory({ pair: CONFIG.pair, side, price: targetPrice, amount: finalAmountStr, totalUsd: finalUsdSize, is_dry_run: true });
                io.emit('stats', { volume: stats.volume, balances });
                const dryPacing = calculateOrganicSleep(startTime, stats.volume);
                await delay(dryPacing.sleepMs);
                continue;
            }

            // REAL EXECUTION (Adapted for LBank)
            let makerOrderId = null;
            const makerStartTime = Date.now();
            try {
                // LBank uses unified createOrder
                const makerOrder = await makerBot.createOrder(CONFIG.pair, 'limit', side, Number(finalAmountStr), Number(finalPriceStr));
                makerOrderId = makerOrder.id;
                invalidateBalanceCache(makerBotName);
                broadcastLog(`✅ ${makerBotName} Maker Order Placed: ${side.toUpperCase()} ${finalAmountStr} @ ${finalPriceStr}`, 'res');
                await logTradeHistory({
                    pair: CONFIG.pair, side, price: targetPrice, amount: finalAmountStr, totalUsd: finalUsdSize,
                    makerBot: makerBotName, takerBot: takerBotName, makerOrderId, makerOrderStatus: 'OPEN',
                    takerOrderId: null, takerOrderStatus: 'PENDING'
                });
            } catch (e) {
                broadcastLog(`❌ Maker Failed: ${e.message}`, 'warn');
                await delay(5000);
                continue;
            }

            await delay(randomVal(500, 2000)); // Organic Linger

            // Anti-sniper
            let isSafeToTrade = true;
            try {
                const ticker = await fetchTickerCached(takerBot, CONFIG.pair);
                const currentBid = ticker.bid;
                const myPriceVal = parseFloat(finalPriceStr);
                if (currentBid > (myPriceVal + 0.0001)) {
                    broadcastLog(`🛑 ABORT: Real bid ${currentBid} would take our fill.`, 'warn');
                    isSafeToTrade = false;
                }
            } catch (e) {
                broadcastLog(`⚠️ Anti-sniper check failed. Aborting.`, 'warn');
                isSafeToTrade = false;
            }

            if (!isSafeToTrade) {
                try {
                    await makerBot.cancelOrder(makerOrderId, CONFIG.pair);
                    broadcastLog(`↩️ ${makerBotName} Maker cancelled.`, 'warn');
                    await logTradeHistory({ makerOrderId, makerOrderStatus: 'CANCELLED', takerOrderStatus: 'NOT_ATTEMPTED', executionTimeMs: Date.now() - makerStartTime }, true);
                } catch (c) { broadcastLog(`⚠️ Cancel failed: ${c.message}`, 'warn'); }
                io.emit('stats', { volume: stats.volume, balances });
                await delay(5000);
                continue;
            }

            broadcastLog(`📋 ${takerBotName} Taker Order Details: ${finalAmountStr} @ $${finalPriceStr} = $${Number(finalUsdSize).toFixed(2)}`, 'info');
            let takerOrderId = null;
            try {
                // LBank uses unified createOrder
                const takerOrder = await takerBot.createOrder(CONFIG.pair, 'limit', oppSide, Number(finalAmountStr), Number(finalPriceStr));
                takerOrderId = takerOrder.id;
                broadcastLog(`✅ ${takerBotName} Taker Order Placed: ${oppSide.toUpperCase()} ${finalAmountStr} @ $${finalPriceStr}`, 'res');
                await logTradeHistory({
                    makerOrderId, makerOrderStatus: 'OPEN', takerOrderId, takerOrderStatus: 'OPEN',
                    takerPrice: parseFloat(finalPriceStr), takerAmount: parseFloat(finalAmountStr),
                    takerTotalUsd: finalUsdSize, executionTimeMs: Date.now() - makerStartTime
                }, true);
            } catch (e) {
                broadcastLog(`❌ Taker Failed: ${e.message}`, 'warn');
                try { await makerBot.cancelOrder(makerOrderId, CONFIG.pair); } catch (_) {}
                await logTradeHistory({ makerOrderId, makerOrderStatus: 'CANCELLED', takerOrderStatus: 'FAILED', executionTimeMs: Date.now() - makerStartTime }, true);
                io.emit('stats', { volume: stats.volume, balances });
                await delay(5000);
                continue;
            }

            // Wait for fills and Handle Failures (Red Logic)
            const filled = await waitForBothFills({ makerBot, takerBot, makerOrderId, takerOrderId, pair: CONFIG.pair, makerAmount: finalAmountStr, takerAmount: finalAmountStr });
            
            if (filled.success) {
                broadcastLog(`✅ Matched trade filled (maker+taker). Counting volume.`, 'success');
                stats.volume += finalUsdSize;
                stats.count++;
                await logTradeHistory({
                    makerOrderId, makerOrderStatus: 'FILLED', takerOrderId, takerOrderStatus: 'FILLED',
                    takerPrice: parseFloat(finalPriceStr), takerAmount: parseFloat(finalAmountStr),
                    takerTotalUsd: finalUsdSize, executionTimeMs: Date.now() - makerStartTime
                }, true);
            } else {
                // FAILURE HANDLING (Red Logic)
                broadcastLog(`⚠️ Fills not confirmed. Cancelling both.`, 'warn');
                try { await makerBot.cancelOrder(makerOrderId, CONFIG.pair); } catch (_) {}
                try { await takerBot.cancelOrder(takerOrderId, CONFIG.pair); } catch (_) {}
                
                const makerAfter = await fetchOrderSafe(makerBot, makerOrderId, CONFIG.pair);
                const takerAfter = await fetchOrderSafe(takerBot, takerOrderId, CONFIG.pair);
                
                await logTradeHistory({
                    makerOrderId, makerOrderStatus: deriveDbOrderStatus(makerAfter, parseFloat(finalAmountStr)),
                    takerOrderId, takerOrderStatus: deriveDbOrderStatus(takerAfter, parseFloat(finalAmountStr)),
                    takerPrice: parseFloat(finalPriceStr), takerAmount: parseFloat(finalAmountStr),
                    takerTotalUsd: finalUsdSize, executionTimeMs: Date.now() - makerStartTime
                }, true);
            }

            // Inventory & Order Sync (Red Logic)
            if (stats.count > 0 && stats.count % 10 === 0) {
                broadcastLog(`🔄 Every 10 trades refresh (trade #${stats.count}): cancel pending, sync orders, inventory snapshot.`, 'info');
                await cancelPendingOrders(botA, botB);
                await syncOrderStatuses(botA, botB);
                await takeAndLogInventorySnapshot(botA, botB, `every 10 trades`);
            }

            io.emit('stats', { volume: stats.volume, balances });
            const pacing = calculateOrganicSleep(startTime, stats.volume);
            await delay(pacing.sleepMs);

        } catch (e) {
            console.error(e);
            await delay(5000);
        }
    }
    broadcastLog("🛑 ENGINE STOPPED.");
    try { await takeAndLogInventorySnapshot(botA, botB, 'final'); } catch (_) {}
    isRunning = false;
    io.emit('status_update', false);
}

// ============================================================
// 7. CLEANUP & SOCKETS
// ============================================================
async function cancelAllOrders() {
    if(CONFIG.dryRun) return;
    try {
        const botA = new ccxt.lbank({ apiKey: CONFIG.botA.apiKey, secret: CONFIG.botA.secret });
        const botB = new ccxt.lbank({ apiKey: CONFIG.botB.apiKey, secret: CONFIG.botB.secret });
        await botA.cancelAllOrders(CONFIG.pair);
        await botB.cancelAllOrders(CONFIG.pair);
        broadcastLog("🚨 EMERGENCY STOP: All Orders Cancelled.", 'warn');
    } catch(e) { console.error(e); }
}

io.on('connection', (socket) => {
    socket.emit('status_update', isRunning);
    socket.emit('stats', { volume: stats.volume, balances });
    socket.on('request_config', () => socket.emit('config_data', CONFIG));
    socket.on('update_config', (newConfig) => {
        if (isRunning) return broadcastLog("⚠️ Stop engine to update config.", 'warn');
        CONFIG = { ...CONFIG, ...newConfig };
        socket.emit('config_data', CONFIG);
        broadcastLog("⚙️ Config Updated.", 'info');
    });
    socket.on('start_engine', () => { if(!isRunning) runLiveEngine(); });
    socket.on('stop_engine', async () => { isRunning = false; await cancelAllOrders(); io.emit('status_update', false); });
});

(async function startServer() {
    await initDatabase();
    server.listen(5001, () => {
        console.log('✅ LBANK PURE VOLUME BOT RUNNING ON PORT 5001');
    });
})();

process.on('SIGINT', async () => {
    console.log("\n🛑 DETECTED SHUTDOWN SIGNAL (Ctrl+C)");
    isRunning = false;
    try { await logSystemLog('INFO', 'System shutdown via SIGINT (Ctrl+C)'); } catch (_) {}
    try { await cancelAllOrders(); } catch (_) {}
    try { if (dbPool) await dbPool.end(); } catch (_) {}
    console.log("👋 System Exit.");
    process.exit();
});
