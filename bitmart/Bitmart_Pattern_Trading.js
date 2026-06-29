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
// 1. CONFIGURATION (CLEANED - NO GRID)
// ============================================================
let CONFIG = {
    pair: 'L1X/USDT',
    dailyVolumeTarget: 60000, 

    // Time-based volume target
    timeTargetEnabled: true,
    timeTargetVolume: 60000,
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
    maxTradeSize: 15,

    // Natural volume distribution settings
    volumeBurstMinTrades: 3,               // min trades in a burst cluster
    volumeBurstMaxTrades: 8,               // max trades in a burst cluster
    volumeQuietMinMs: 10000,               // min quiet period after burst (ms)
    volumeQuietMaxMs: 40000,               // max quiet period after burst (ms)
    volumeWhaleSpikeProbability: 0.03,     // chance of a random large trade per tick
    volumeTransitionSpikeMultiplier: 1.8,  // volume boost during phase transitions

    // Trend phase durations (minutes) - dry run simulation only
    trendUpMinMinutes: 15,
    trendUpMaxMinutes: 25,
    trendDownMinMinutes: 15,
    trendDownMaxMinutes: 25,
    volatileHoldMinMinutes: 30,
    volatileHoldMaxMinutes: 50,

    // Trend mode probabilities (0–1). Up + Down + Volatile should sum to 1; they are normalized if not.
    trendUpProbability: 0.20,
    trendDownProbability: 0.20,
    trendVolatileProbability: 0.60,
    // When price is near floor/resistance, override to bounce (0–1)
    trendNearFloorUpProbability: 0.99,
    trendNearResistanceDownProbability: 0.99,
    
    // API KEYS
     // API KEYS
     botA: { 
        apiKey: process.env.BITMART_BOT_A_API_KEY || '',
        secret: process.env.BITMART_BOT_A_SECRET || '',
        uid: process.env.BITMART_BOT_A_UID || ''
    },
    botB: { 
        apiKey: process.env.BITMART_BOT_B_API_KEY || '',
        secret: process.env.BITMART_BOT_B_SECRET || '',
        uid: process.env.BITMART_BOT_B_UID || ''
    },

    dryRun: process.env.BOT_DRY_RUN !== 'false', // env-driven: dry-run unless BOT_DRY_RUN=false
    
    // MySQL DATABASE
    database: {
        host: process.env.DB_HOST || process.env.BITMART_DB_HOST || '157.173.109.193',
        port: parseInt(process.env.DB_PORT || process.env.BITMART_DB_PORT) || 25060,
        user: process.env.DB_USER || process.env.BITMART_DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.BITMART_DB_PASSWORD || '',
        database: process.env.DB_NAME || process.env.BITMART_DB_NAME || 'market-cap_production',
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
                `INSERT INTO bitmart_system_logs (log_level, message, is_dry_run) VALUES (?, ?, ?)`,
                [item.level?.toUpperCase?.() || String(item.level || 'INFO'), String(item.message || ''), CONFIG.dryRun ? 1 : 0]
            );
        } catch (e) {
            console.error('DB Flush Error (bitmart_system_logs):', e.message);
            break;
        }
    }

    while (pendingDbWrites.tradeHistory.length > 0) {
        const item = pendingDbWrites.tradeHistory.shift();
        try {
            await logTradeHistory(item.data, item.update);
        } catch (e) {
            console.error('DB Flush Error (bitmart_trade_history):', e.message);
            break;
        }
    }

    while (pendingDbWrites.inventory.length > 0) {
        const item = pendingDbWrites.inventory.shift();
        try {
            await logInventorySnapshot(item.botABal, item.botBBal, item.netChange);
        } catch (e) {
            console.error('DB Flush Error (bitmart_inventory_snapshot):', e.message);
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
            CREATE TABLE IF NOT EXISTS bitmart_trade_history (
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

        try { await dbPool.execute(`ALTER TABLE bitmart_trade_history ADD COLUMN trend_progress DECIMAL(5, 2) DEFAULT 0 AFTER total_usd`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE bitmart_trade_history ADD COLUMN taker_price DECIMAL(20, 8) DEFAULT NULL AFTER taker_order_status`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE bitmart_trade_history ADD COLUMN taker_amount DECIMAL(20, 8) DEFAULT NULL AFTER taker_price`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE bitmart_trade_history ADD COLUMN taker_total_usd DECIMAL(20, 8) DEFAULT NULL AFTER taker_amount`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE bitmart_trade_history ADD COLUMN is_dry_run BOOLEAN DEFAULT FALSE`); } catch (_) {}
        try { await dbPool.execute(`ALTER TABLE bitmart_trade_history ADD COLUMN execution_time_ms INT`); } catch (_) {}

        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS bitmart_inventory_snapshot (
                id INT AUTO_INCREMENT PRIMARY KEY,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                bot_a_usdt DECIMAL(20, 8) DEFAULT 0,
                bot_a_token DECIMAL(20, 8) DEFAULT 0,
                bot_b_usdt DECIMAL(20, 8) DEFAULT 0,
                bot_b_token DECIMAL(20, 8) DEFAULT 0,
                net_token_change DECIMAL(20, 8) DEFAULT 0
            )
        `);

        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS bitmart_system_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                log_level VARCHAR(20) NOT NULL,
                message TEXT
            )
        `);

        try { await dbPool.execute(`CREATE INDEX idx_trade_history_timestamp ON bitmart_trade_history(timestamp DESC)`); } catch (_) {}
        try { await dbPool.execute(`CREATE INDEX idx_trade_history_pair ON bitmart_trade_history(pair)`); } catch (_) {}
        try { await dbPool.execute(`CREATE INDEX idx_inventory_snapshot_timestamp ON bitmart_inventory_snapshot(timestamp DESC)`); } catch (_) {}
        try { await dbPool.execute(`CREATE INDEX idx_system_logs_timestamp ON bitmart_system_logs(timestamp DESC)`); } catch (_) {}
        try { await dbPool.execute(`CREATE INDEX idx_system_logs_level ON bitmart_system_logs(log_level)`); } catch (_) {}

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
                UPDATE bitmart_trade_history SET
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
                INSERT INTO bitmart_trade_history (
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
        console.error('DB Log Error (bitmart_trade_history):', e.message);
        broadcastLog(`❌ DB Log Error (bitmart_trade_history): ${e.message}`, 'warn');
        if (dbPool) {
             try { await dbPool.execute(`INSERT INTO bitmart_system_logs (log_level, message, is_dry_run) VALUES (?, ?, ?)`, ['ERROR', `DB Log Error: ${e.message}`, CONFIG.dryRun ? 1 : 0]); } catch(_) {}
        }
    }
}

async function logSystemLog(level, message) {
    if (!dbPool) {
        enqueueDbWrite('systemLogs', { level, message });
        return;
    }
    try {
        await dbPool.execute(`INSERT INTO bitmart_system_logs (log_level, message, is_dry_run) VALUES (?, ?, ?)`, [
            (level && typeof level === 'string') ? level.toUpperCase() : level,
            message,
            CONFIG.dryRun ? 1 : 0
        ]);
    } catch (e) {
        console.error('DB Log Error (bitmart_system_logs):', e.message);
    }
}

async function logInventorySnapshot(botABal, botBBal, netChange) {
    if (!dbPool) {
        enqueueDbWrite('inventory', { botABal, botBBal, netChange });
        return;
    }
    try {
        await dbPool.execute(
            `INSERT INTO bitmart_inventory_snapshot (bot_a_usdt, bot_a_token, bot_b_usdt, bot_b_token, net_token_change, is_dry_run) VALUES (?,?,?,?,?,?)`,
            [botABal.usdt, botABal.l1x, botBBal.usdt, botBBal.l1x, netChange, CONFIG.dryRun ? 1 : 0]
        );
    } catch (e) {
        console.error('DB Log Error (bitmart_inventory_snapshot):', e.message);
    }
}

// ============================================================
// 4. HELPERS & TREND LOGIC
// ============================================================
let isRunning = false;
let stats = { volume: 0, count: 0 };
let balances = { botA: { usdt: 5000, l1x: 500 }, botB: { usdt: 5000, l1x: 500 } };
let initialInventorySnapshot = { botA: { usdt: 0, l1x: 0 }, botB: { usdt: 0, l1x: 0 } };

// Global Simulation Price for Dry Run (Persists across loops)
let simPrice = 0;

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomVal = (min, max) => Math.random() * (max - min) + min;

// --- HELPER: Gaussian Random (Bell Curve) ---
function gaussianRandom(mean, stdev) {
    const u = 1 - Math.random(); 
    const v = Math.random();
    const z = Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
    return z * stdev + mean;
}

// --- HELPER: Linear Interpolation ---
function lerp(start, end, t) {
    return start * (1 - t) + end * t;
}

// --- HYBRID TREND MANAGER (Candle Bodies + Wicks) ---
let microTrend = {
    startPrice: 0,
    targetPrice: 0,
    startTime: 0,
    endTime: 0,
    mode: 'SIDEWAYS',
    volatility: 0.0005 // Default low volatility
};

// --- NATURAL VOLUME PROFILE STATE ---
let volumeProfile = {
    // Burst/quiet cycle state
    burstMode: false,                 // true = currently in a burst of rapid trades
    burstTradesRemaining: 0,          // how many trades left in current burst
    quietUntil: 0,                    // timestamp: extended sleep until this time

    // Phase transition spike detection
    lastTrendMode: 'SIDEWAYS',        // track mode changes for transition spikes
    transitionSpikeActive: false,
    transitionSpikeTradesRemaining: 0,

    // EMA-smoothed intensity (prevents jarring jumps between ticks)
    currentIntensity: 1.0,
    smoothingAlpha: 0.15,             // lower = smoother transitions
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

        // Base probabilities from config (normalized so they sum to 1)
        let totalProb = (CONFIG.trendUpProbability || 0) + (CONFIG.trendDownProbability || 0) + (CONFIG.trendVolatileProbability || 0);
        if (totalProb <= 0) totalProb = 1;
        let probTrendUp = (CONFIG.trendUpProbability ?? 0.35) / totalProb;
        let probTrendDown = (CONFIG.trendDownProbability ?? 0.35) / totalProb;

        // Near floor/resistance overrides from config
        if (distToFloor < (rangeTotal * 0.15)) {
            probTrendUp = CONFIG.trendNearFloorUpProbability ?? 0.8;
            probTrendDown = 0;
        }
        if (distToResist < (rangeTotal * 0.15)) {
            probTrendUp = 0;
            probTrendDown = CONFIG.trendNearResistanceDownProbability ?? 0.8;
        }

        if (rand < probTrendUp) {
            // MODE 1: BIG BODY UPTREND
            microTrend.mode = 'TREND_UP';
            // Aim for 70-100% of the way to resistance
            microTrend.targetPrice = randomVal(currentPrice + (rangeTotal * 0.4), resistance);
            const duration = randomVal(CONFIG.trendUpMinMinutes * 60 * 1000, CONFIG.trendUpMaxMinutes * 60 * 1000);
            microTrend.endTime = now + duration;
            // LOW NOISE: Makes the line straight (Solid Body)
            microTrend.volatility = 0.0008; 
            
        } else if (rand < (probTrendUp + probTrendDown)) {
            // MODE 2: BIG BODY DOWNTREND
            microTrend.mode = 'TREND_DOWN';
            // Aim for 70-100% of the way to floor
            microTrend.targetPrice = randomVal(floor, currentPrice - (rangeTotal * 0.4));
            const duration = randomVal(CONFIG.trendDownMinMinutes * 60 * 1000, CONFIG.trendDownMaxMinutes * 60 * 1000);
            microTrend.endTime = now + duration;
            // LOW NOISE
            microTrend.volatility = 0.0008;

        } else {
            // MODE 3: THE FIGHT (WICKS)
            // Stays roughly where it is but spikes hard up and down.
            microTrend.mode = 'VOLATILE_HOLD';
            microTrend.targetPrice = currentPrice + randomVal(-0.002, 0.002);
            const duration = randomVal(CONFIG.volatileHoldMinMinutes * 60 * 1000, CONFIG.volatileHoldMaxMinutes * 60 * 1000);
            microTrend.endTime = now + duration;
            // HIGH NOISE: Creates the long wicks
            microTrend.volatility = 0.0035; 
        }
        
        // Strict Clamp
        microTrend.targetPrice = Math.max(floor, Math.min(resistance, microTrend.targetPrice));
        microTrend.startTime = now;

        broadcastLog(`🌊 PATTERN: ${microTrend.mode} -> ${microTrend.targetPrice.toFixed(4)} (Vol: ${microTrend.volatility})`, 'info');
    }
}

// --- VOLUME INTENSITY ENGINE ---
// Returns a multiplier (0.3 - 2.5) based on trend state, phase transitions, and random whale spikes.
function getVolumeIntensity() {
    const now = Date.now();
    const progress = (microTrend.endTime > microTrend.startTime)
        ? Math.max(0, Math.min(1, (now - microTrend.startTime) / (microTrend.endTime - microTrend.startTime)))
        : 0.5;

    let rawIntensity = 1.0;

    // --- BASE INTENSITY FROM TREND MODE ---
    switch (microTrend.mode) {
        case 'TREND_UP':
        case 'TREND_DOWN':
            // Trending phases have higher volume.
            // Peaks early in the trend (breakout) and tapers toward end (exhaustion).
            // Shape: inverted parabola peaking at progress ~0.2
            rawIntensity = 1.0 + 0.8 * Math.max(0, 1.0 - Math.pow((progress - 0.2) / 0.8, 2));
            break;

        case 'VOLATILE_HOLD':
            // Consolidation: low base with oscillation (representing failed breakout attempts)
            rawIntensity = 0.5 + 0.3 * Math.sin(progress * Math.PI * 4);
            break;

        default: // 'SIDEWAYS' (initial state)
            rawIntensity = 0.7;
    }

    // --- PHASE TRANSITION SPIKE ---
    if (microTrend.mode !== volumeProfile.lastTrendMode) {
        volumeProfile.lastTrendMode = microTrend.mode;
        volumeProfile.transitionSpikeActive = true;
        const spikeCount = Math.floor(randomVal(
            CONFIG.volumeBurstMinTrades || 3,
            (CONFIG.volumeBurstMaxTrades || 8) + 1
        ));
        volumeProfile.transitionSpikeTradesRemaining = spikeCount;
        broadcastLog(`📈 VOL-PROFILE: Phase transition spike (${spikeCount} trades at ${(CONFIG.volumeTransitionSpikeMultiplier || 1.8).toFixed(1)}x)`, 'info');
    }

    if (volumeProfile.transitionSpikeActive && volumeProfile.transitionSpikeTradesRemaining > 0) {
        rawIntensity *= (CONFIG.volumeTransitionSpikeMultiplier || 1.8);
        volumeProfile.transitionSpikeTradesRemaining--;
        if (volumeProfile.transitionSpikeTradesRemaining <= 0) {
            volumeProfile.transitionSpikeActive = false;
        }
    }

    // --- RANDOM WHALE SPIKES ---
    if (Math.random() < (CONFIG.volumeWhaleSpikeProbability || 0.03)) {
        rawIntensity *= randomVal(1.5, 2.5);
    }

    // --- EMA SMOOTHING ---
    const alpha = volumeProfile.smoothingAlpha;
    volumeProfile.currentIntensity = alpha * rawIntensity + (1 - alpha) * volumeProfile.currentIntensity;

    return Math.max(0.3, Math.min(2.5, volumeProfile.currentIntensity));
}

// ------------------------------------------------------------
// BROADCAST LOGGING (Terminal + Frontend)
// ------------------------------------------------------------
const TERM_COLORS = {
    RESET: "\x1b[0m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    BLUE: "\x1b[34m",
    CYAN: "\x1b[36m",
    WHITE: "\x1b[37m",
    GRAY: "\x1b[90m"
};

function broadcastLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US',{hour12:false});
    
    // 1. Emit to Frontend (Socket)
    io.emit('log', { time, msg, type });

    // 2. Log to Terminal with Colors
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
    const filled = typeof order.filled === 'number' ? order.filled : parseFloat(order.filled);
    const amount = typeof order.amount === 'number' ? order.amount : parseFloat(order.amount);
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
            FROM bitmart_trade_history
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
                        `UPDATE bitmart_trade_history SET maker_order_status = ?, taker_order_status = ? WHERE id = ?`,
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
        await logInventorySnapshot(botABal, botBBal, netChange);
        const label = reason ? ` (${reason})` : '';
        broadcastLog(
            `🏦 Inventory Snapshot${label}: botA USDT=${Number(botABal.usdt || 0).toFixed(2)} L1X=${Number(botABal.l1x || 0).toFixed(4)} | botB USDT=${Number(botBBal.usdt || 0).toFixed(2)} L1X=${Number(botBBal.l1x || 0).toFixed(4)} | Net ΔL1X=${Number(netChange).toFixed(4)}`,
            'info'
        );
    } catch (e) {}
}

async function fetchTickerCached(bot, pair) { return await bot.fetchTicker(pair); }

// --- NATURAL TRADE SIZE (Gaussian, intensity-driven) ---
// Replaces the flat randomVal(min, max). Gaussian bell curve centered
// on an intensity-shifted mean so trend phases produce larger trades
// and consolidation produces smaller ones.
function calculateNaturalTradeSize(intensity) {
    const min = CONFIG.minTradeSize;
    const max = CONFIG.maxTradeSize;
    const range = max - min;
    const midpoint = min + range * 0.5;

    // Intensity shifts the mean within the range
    // intensity=0.3 -> mean near min + 20% of range
    // intensity=1.0 -> mean at midpoint
    // intensity=2.5 -> mean near max (clamped after)
    const mean = midpoint + (intensity - 1.0) * range * 0.4;

    // Stdev scales with intensity: high intensity = wider spread, low = tighter clustering
    const stdev = range * 0.15 * Math.max(0.5, intensity);

    let size = gaussianRandom(mean, stdev);

    // Hard clamp to CONFIG bounds
    return Math.max(min, Math.min(max, size));
}

// --- VOLUME BUDGET CORRECTION ---
// Compares actual cumulative volume to expected (linear trajectory).
// Returns 0.6 - 1.4 to gently steer trade sizes back on track.
function getVolumeBudgetCorrection(startTime, currentVol) {
    const targetVol = Number(CONFIG.timeTargetVolume);
    const hours = Number(CONFIG.timeTargetHours);
    const totalMs = hours * 60 * 60 * 1000;
    const elapsedMs = Date.now() - startTime;

    if (totalMs <= 0 || elapsedMs <= 0 || !Number.isFinite(targetVol) || targetVol <= 0) return 1.0;

    // Where SHOULD we be right now?
    const expectedVol = targetVol * (elapsedMs / totalMs);

    // Positive deviation = ahead of schedule
    const deviation = currentVol - expectedVol;
    const deviationPct = deviation / Math.max(1, expectedVol);

    // If 20% ahead: correction ~0.8 (shrink sizes, slow down)
    // If 20% behind: correction ~1.2 (grow sizes, speed up)
    let correction = 1.0 - (deviationPct * 1.0);
    return Math.max(0.6, Math.min(1.4, correction));
}

// --- NATURAL SLEEP (burst/quiet cycles, intensity-scaled, jittered) ---
// Replaces the old flat calculateOrganicSleep. Same baseline pacing formula
// but layered with intensity scaling, burst/quiet cycles, and Gaussian jitter.
function calculateNaturalSleep(startTime, currentVol, intensity) {
    // STEP 1: Baseline sleep (same core formula as before)
    const targetVol = Number(CONFIG.timeTargetVolume);
    const hours = Number(CONFIG.timeTargetHours);
    const totalMs = hours * 60 * 60 * 1000;
    const elapsedMs = Date.now() - startTime;
    const remainingMs = totalMs - elapsedMs;
    const remainingVol = targetVol - currentVol;

    if (!CONFIG.timeTargetEnabled || !Number.isFinite(targetVol) || targetVol <= 0) {
        return { sleepMs: randomVal(8000, 25000) };
    }
    if (remainingVol <= 0) return { sleepMs: 60000 };
    if (remainingMs <= 0) return { sleepMs: 0 };

    const fallbackAvgUsd = (Number(CONFIG.minTradeSize) + Number(CONFIG.maxTradeSize)) / 2;
    const avgUsdPerTrade = (stats.count > 0 && Number.isFinite(currentVol))
        ? (currentVol / stats.count)
        : (Number.isFinite(fallbackAvgUsd) && fallbackAvgUsd > 0 ? fallbackAvgUsd : 1);

    const tradesNeeded = Math.max(1, Math.ceil(remainingVol / avgUsdPerTrade));
    const baselineSleepMs = Math.floor(remainingMs / tradesNeeded);

    // STEP 2: Scale by intensity (high intensity = faster trades)
    let adjustedSleep = baselineSleepMs / Math.max(0.3, intensity);

    // STEP 3: Burst/quiet cycle overlay
    const now = Date.now();

    // Quiet period: sleep is 2-4x baseline
    if (volumeProfile.quietUntil > now) {
        adjustedSleep = baselineSleepMs * randomVal(2.0, 4.0);
    }
    // Maybe START a burst (probability scales with intensity)
    else if (!volumeProfile.burstMode && volumeProfile.burstTradesRemaining <= 0) {
        const burstProb = 0.05 + (intensity - 0.5) * 0.05;
        if (Math.random() < burstProb) {
            volumeProfile.burstMode = true;
            volumeProfile.burstTradesRemaining = Math.floor(randomVal(
                CONFIG.volumeBurstMinTrades || 3,
                (CONFIG.volumeBurstMaxTrades || 8) + 1
            ));
        }
    }

    // In burst mode: compress sleep to 20-50% of normal
    if (volumeProfile.burstMode && volumeProfile.burstTradesRemaining > 0) {
        adjustedSleep *= randomVal(0.2, 0.5);
        volumeProfile.burstTradesRemaining--;

        if (volumeProfile.burstTradesRemaining <= 0) {
            volumeProfile.burstMode = false;
            // After burst, enter quiet period
            volumeProfile.quietUntil = now + randomVal(
                CONFIG.volumeQuietMinMs || 10000,
                CONFIG.volumeQuietMaxMs || 40000
            );
        }
    }

    // STEP 4: Gaussian jitter (+/- 30%) to prevent metronomic feel
    const jitter = gaussianRandom(1.0, 0.15);
    adjustedSleep *= Math.max(0.5, Math.min(1.5, jitter));

    // STEP 5: Hard bounds (never faster than 1s, never slower than 45s)
    const sleepMs = Math.max(1000, Math.min(45000, Math.round(adjustedSleep)));
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
    
    // Simple logic: Can we trade?
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

    const makerReason = res.makerName === 'botA' ? 'botA has more USDT' : 'botB has more USDT';
    return {
        success: true,
        makerBot: res.makerBot, takerBot: res.takerBot, makerBotName: res.makerName, takerBotName: res.takerName,
        finalUsdSize: usdSize,
        finalAmountStr: (usdSize / price).toFixed(4),
        finalPriceStr: price.toFixed(4),
        side,
        reason: `buy-only: ${makerReason}`
    };
}

// ============================================================
// 6. MAIN ENGINE (STRICT)
// ============================================================
// --- PERSISTENT DAILY VOLUME (restart-proof) ---------------------------------
// "Today's volume" is the sum of trades already recorded in bitmart_trade_history
// for the current calendar day. Loading it on startup means a restart RESUMES the
// day's budget instead of granting a fresh 60k. The filter mirrors exactly what
// increments stats.volume: live counts only fully-matched (maker+taker FILLED)
// trades; dry-run counts its simulated rows. NOTE: "today" uses the DB's CURDATE()
// and the process's local clock — assumes the bot and MySQL share a timezone.
function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfDayMs() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
async function loadTodayVolume() {
    if (!dbPool) return { volume: 0, count: 0 };
    const filledFilter = CONFIG.dryRun
        ? `is_dry_run = 1`
        : `is_dry_run = 0 AND maker_order_status = 'FILLED' AND taker_order_status = 'FILLED'`;
    try {
        const [rows] = await dbPool.query(
            `SELECT COALESCE(SUM(total_usd), 0) AS vol, COUNT(*) AS cnt
             FROM bitmart_trade_history
             WHERE DATE(timestamp) = CURDATE() AND (${filledFilter})`
        );
        const r = rows[0] || {};
        return { volume: Number(r.vol) || 0, count: Number(r.cnt) || 0 };
    } catch (e) {
        broadcastLog(`⚠️ loadTodayVolume failed (${e.message}) — starting day at 0`, 'warn');
        return { volume: 0, count: 0 };
    }
}

async function runLiveEngine() {
    broadcastLog("🚀 STARTING STRICT PURE VOLUME ENGINE...", 'req');
    await initDatabase();
    isRunning = true;
    io.emit('status_update', true);

    const exOpt = { enableRateLimit: true, options: { 'defaultType': 'spot', 'adjustForTimeDifference': true } };
    let botA, botB;
    try {
        botA = new ccxt.bitmart({ apiKey: CONFIG.botA.apiKey, secret: CONFIG.botA.secret, uid: CONFIG.botA.uid, ...exOpt });
        botB = new ccxt.bitmart({ apiKey: CONFIG.botB.apiKey, secret: CONFIG.botB.secret, uid: CONFIG.botB.uid, ...exOpt });
        if(!CONFIG.dryRun) { await botA.loadMarkets(); await botB.loadMarkets(); }
    } catch(e) { isRunning = false; return broadcastLog("❌ Init Failed: " + e.message, 'warn'); }

    const rawSymbol = CONFIG.pair.replace('/', '_');
    // Restart-proof daily volume: resume today's total from the DB so any number
    // of restarts within a calendar day shares ONE 60k budget (not 60k each).
    let currentDayKey = dayKey();
    const resumed = await loadTodayVolume();
    stats.volume = resumed.volume;
    stats.count = resumed.count;
    let startTime = startOfDayMs();            // pace across the calendar day, not from process start
    const volumeTarget = CONFIG.timeTargetVolume;
    broadcastLog(`📊 Day ${currentDayKey}: resuming at $${stats.volume.toFixed(2)} / $${Number(volumeTarget).toLocaleString()} already done today (${stats.count} trades)`, 'info');

    if (CONFIG.timeTargetEnabled) {
        broadcastLog(`⏱️ Time target enabled: $${Number(volumeTarget).toLocaleString()} in ${CONFIG.timeTargetHours} hour(s)`, 'info');
    }

    // Initialize Sim Price for Dry Run
    if (CONFIG.dryRun) {
        simPrice = (CONFIG.hardFloorPrice + CONFIG.hardResistancePrice) / 2;
    }

    initialInventorySnapshot = { botA: await checkBalances(botA,'botA'), botB: await checkBalances(botB,'botB') };
    await takeAndLogInventorySnapshot(botA, botB, 'initial');

    while (isRunning) {
        try {
            if(!isRunning) break;

            // --- CALENDAR-DAY VOLUME CAP (restart-proof) ---
            // New day -> reload (≈0) and reset the pacing anchor to midnight.
            if (dayKey() !== currentDayKey) {
                currentDayKey = dayKey();
                const fresh = await loadTodayVolume();
                stats.volume = fresh.volume;
                stats.count = fresh.count;
                startTime = startOfDayMs();
                broadcastLog(`🔄 New day ${currentDayKey} — volume budget reset (resuming at $${stats.volume.toFixed(2)}).`, 'info');
            }
            // Today's budget spent -> idle until the date rolls over (do NOT exit;
            // exiting + restart used to grant a fresh budget — that's the bug).
            if (stats.volume >= volumeTarget) {
                broadcastLog(`✅ Daily target $${Number(volumeTarget).toLocaleString()} reached ($${stats.volume.toFixed(0)}). Idling until next day.`, 'info');
                await delay(60000);
                continue;
            }

            // 1. GET MARKET DATA
            let bestBid, bestAsk;
            if (CONFIG.dryRun) {
                // --- DYNAMIC SIMULATION LOGIC ---
                // Move sim price towards trend target
                if (microTrend.targetPrice > 0) {
                    let move = (microTrend.targetPrice - simPrice) * 0.05; // 5% approach per tick
                    simPrice += move;
                }
                
                // Add tiny noise to keep bid/ask fluttering
                simPrice += randomVal(-0.0005, 0.0005);

                // Strictly Clamp Sim Price so we don't break our own boundaries
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
            // We can only trade in the overlap of (SafeSpread) AND (HardLimits)
            let lowerBound = Math.max(bestBid + CONFIG.safeZoneBuffer, CONFIG.hardFloorPrice);
            let upperBound = Math.min(bestAsk - CONFIG.safeZoneBuffer, CONFIG.hardResistancePrice);

            // If Spread is tighter than safety buffer OR outside hard limits
            if (lowerBound >= upperBound) {
                broadcastLog(`⚠️ No trade room. Spread: ${bestBid.toFixed(4)}-${bestAsk.toFixed(4)} vs Limits: ${CONFIG.hardFloorPrice}-${CONFIG.hardResistancePrice}`, 'warn');
                await delay(5000); continue;
            }

            // 4. NATURAL PRICE CALCULATION (Hybrid: Trend + Wicks)
            const currentMid = (bestBid + bestAsk) / 2;
            
            updateMicroTrend(currentMid, CONFIG.hardFloorPrice, CONFIG.hardResistancePrice);

            // A. Calculate Trend Path (The Candle Body)
            const now = Date.now();
            const timeElapsed = now - microTrend.startTime;
            const totalDuration = microTrend.endTime - microTrend.startTime;
            const progress = Math.max(0, Math.min(1, timeElapsed / totalDuration));
            
            // "Base" price moves smoothly via Linear Interpolation (Trend)
            let basePrice = lerp(microTrend.startPrice, microTrend.targetPrice, progress);
            
            // B. Apply Volatility (The Wicks)
            // Gaussian noise adds the wicks. It's high in VOLATILE_HOLD mode, low in TREND mode.
            let naturalPrice = gaussianRandom(basePrice, microTrend.volatility);

            // 5. FINAL STRICT CLAMP
            // Force the natural price to stay inside the valid band calculated in Step 3
            let targetPrice = Math.max(lowerBound, Math.min(upperBound, naturalPrice));

            // 6. EXECUTE (Natural volume distribution)
            const intensity = getVolumeIntensity();
            const budgetCorrection = getVolumeBudgetCorrection(startTime, stats.volume);
            const usdSize = calculateNaturalTradeSize(intensity * budgetCorrection);
            broadcastLog(`📊 VOL-PROFILE: intensity=${intensity.toFixed(2)} correction=${budgetCorrection.toFixed(2)} size=$${usdSize.toFixed(2)} mode=${microTrend.mode} burst=${volumeProfile.burstMode}`, 'info');
            const side = 'buy';
            const tradeInfo = await validateAndPlaceTradeWithFallback(botA, botB, side, usdSize, targetPrice, 'botA');

            if (!tradeInfo.success) {
                broadcastLog("⚠️ Funds low.", 'warn');
                await delay(5000); continue;
            }

            // ... (Standard Execution Logic) ...
            const { makerBot, takerBot, makerBotName, takerBotName, finalAmountStr, finalPriceStr, finalUsdSize, reason: makerReason } = tradeInfo;
            const oppSide = 'sell';
            const reasonText = (makerReason && typeof makerReason === 'string') ? ` (${makerReason})` : '';

            broadcastLog(`⚡ VOL: ${side.toUpperCase()} ${finalAmountStr} @ ${finalPriceStr}${reasonText}`, 'info');

            if (CONFIG.dryRun) {
                stats.volume += finalUsdSize;
                stats.count++;
                broadcastLog(`✅ Dry run: trade simulated. Counting volume.`, 'res');
                await logTradeHistory({ pair: CONFIG.pair, side, price: targetPrice, amount: finalAmountStr, totalUsd: finalUsdSize, is_dry_run: true });
                io.emit('stats', { volume: stats.volume, balances });
                // Natural pacing: intensity-scaled with burst/quiet cycles
                const dryPacing = calculateNaturalSleep(startTime, stats.volume, intensity);
                await delay(dryPacing.sleepMs);
                continue;
            }

            // ---------- REAL EXECUTION (with anti-sniper and cancel logic) ----------
            let makerOrderId = null;
            const makerStartTime = Date.now();
            try {
                const makerOrder = await makerBot.privatePostSpotV2SubmitOrder({ 'symbol': rawSymbol, 'side': side, 'type': 'limit', 'size': finalAmountStr, 'price': finalPriceStr });
                makerOrderId = makerOrder.data?.order_id || makerOrder.id;
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

            // Anti-sniper: before taker, check if someone else would take our fill
            await delay(randomVal(300, 700));
            let isSafeToTrade = true;
            try {
                const ticker = await fetchTickerCached(takerBot, CONFIG.pair);
                const currentBid = ticker.bid;
                const myPriceVal = parseFloat(finalPriceStr);
                // Maker buy, taker sell: if real bid > our buy, taker would sell to real user
                if (currentBid > (myPriceVal + 0.0001)) {
                    broadcastLog(`🛑 ABORT: Real bid ${currentBid} would take our fill (${myPriceVal}). Cancelling maker.`, 'warn');
                    isSafeToTrade = false;
                }
            } catch (e) {
                broadcastLog(`⚠️ Anti-sniper check failed: ${e.message}. Aborting.`, 'warn');
                isSafeToTrade = false;
            }

            if (!isSafeToTrade) {
                try {
                    await makerBot.cancelOrder(makerOrderId, CONFIG.pair);
                    broadcastLog(`↩️ ${makerBotName} Maker cancelled.`, 'warn');
                    await logTradeHistory({
                        makerOrderId, makerOrderStatus: 'CANCELLED', takerOrderStatus: 'NOT_ATTEMPTED',
                        executionTimeMs: Date.now() - makerStartTime
                    }, true);
                } catch (c) { broadcastLog(`⚠️ Cancel failed: ${c.message}`, 'warn'); }
                io.emit('stats', { volume: stats.volume, balances });
                await delay(5000);
                continue;
            }

            // Place taker
            const takerAmountNum = parseFloat(finalAmountStr);
            const takerPriceNum = parseFloat(finalPriceStr);
            const takerTotalUsd = (Number.isFinite(takerAmountNum) && Number.isFinite(takerPriceNum)) ? (takerAmountNum * takerPriceNum) : finalUsdSize;
            broadcastLog(`📋 ${takerBotName} Taker Order Details: ${Number.isFinite(takerAmountNum) ? takerAmountNum.toFixed(4) : finalAmountStr} @ $${finalPriceStr} = $${Number(takerTotalUsd).toFixed(2)}`, 'info');

            let takerOrderId = null;
            try {
                const takerOrder = await takerBot.privatePostSpotV2SubmitOrder({ 'symbol': rawSymbol, 'side': oppSide, 'type': 'limit', 'size': finalAmountStr, 'price': finalPriceStr });
                takerOrderId = takerOrder.data?.order_id || takerOrder.id;
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

            const filled = await waitForBothFills({ makerBot, takerBot, makerOrderId, takerOrderId, pair: CONFIG.pair, makerAmount: finalAmountStr, takerAmount: finalAmountStr });

            if (!filled.success) {
                broadcastLog(`⚠️ Fills not confirmed. Cancelling both; volume not counted.`, 'warn');
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
            } else {
                stats.volume += finalUsdSize;
                stats.count++;
                broadcastLog(`✅ Matched trade filled (maker+taker). Counting volume.`, 'res');
                await logTradeHistory({
                    makerOrderId, makerOrderStatus: 'FILLED', takerOrderId, takerOrderStatus: 'FILLED',
                    takerPrice: parseFloat(finalPriceStr), takerAmount: parseFloat(finalAmountStr),
                    takerTotalUsd: finalUsdSize, executionTimeMs: Date.now() - makerStartTime
                }, true);
            }

            if (stats.count > 0 && stats.count % 10 === 0) {
                broadcastLog(`🔄 Every 10 trades refresh (trade #${stats.count}): cancel pending, sync orders, inventory snapshot.`, 'info');
                await cancelPendingOrders(botA, botB);
                await syncOrderStatuses(botA, botB);
                await takeAndLogInventorySnapshot(botA, botB, `every 10 trades (count=${stats.count})`);
            }

            io.emit('stats', { volume: stats.volume, balances });
            const pacing = calculateNaturalSleep(startTime, stats.volume, intensity);
            await delay(pacing.sleepMs);

        } catch (e) {
            console.error(e);
            await delay(5000);
        }
    }
    try { await takeAndLogInventorySnapshot(botA, botB, 'final'); } catch (_) {}
    broadcastLog("🛑 ENGINE STOPPED.");
    isRunning = false;
    io.emit('status_update', false);
}

// ============================================================
// 7. CLEANUP & SOCKETS
// ============================================================
async function cancelAllOrders() {
    if(CONFIG.dryRun) return;
    try {
        const botA = new ccxt.bitmart({ apiKey: CONFIG.botA.apiKey, secret: CONFIG.botA.secret, uid: CONFIG.botA.uid });
        const botB = new ccxt.bitmart({ apiKey: CONFIG.botB.apiKey, secret: CONFIG.botB.secret, uid: CONFIG.botB.uid });
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
    server.listen(5010, () => {
        console.log('✅ BITMART PATTERN BOT RUNNING ON PORT 5010');
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
