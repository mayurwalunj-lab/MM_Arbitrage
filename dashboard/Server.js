const express = require('express');
const mysql = require('mysql2'); // We use mysql2 for better async support
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(cors());
app.use(express.static(__dirname)); // Serves index.html

// --- 1. MYSQL CONNECTION CONFIGURATION ---
// Database configurations
const dbConfigs = {
    bitmart: {
        host: process.env.BITMART_DB_HOST || '159.195.76.213',
        user: process.env.BITMART_DB_USER || 'root',
        password: process.env.BITMART_DB_PASSWORD || '',
        database: process.env.BITMART_DB_NAME || 'market-cap_production',
        port: parseInt(process.env.BITMART_DB_PORT) || 25060
    },
    lbank: {
        host: process.env.LBANK_DB_HOST || '159.195.76.213',
        user: process.env.LBANK_DB_USER || 'root',
        password: process.env.LBANK_DB_PASSWORD || '',
        database: process.env.LBANK_DB_NAME || 'marketcap',
        port: parseInt(process.env.LBANK_DB_PORT) || 25060
    }
};

// Create connection pools for both databases
const pools = {
    bitmart: mysql.createPool({
        ...dbConfigs.bitmart,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    }),
    lbank: mysql.createPool({
        ...dbConfigs.lbank,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    })
};

// Helper function to get the correct pool
function getPool(dbName) {
    const normalizedName = dbName?.toLowerCase();
    if (normalizedName === 'lbank' || normalizedName === 'marketcap') {
        return pools.lbank;
    }
    // Default to bitmart
    return pools.bitmart;
}

// Test connections on startup
Object.keys(pools).forEach(dbName => {
    pools[dbName].getConnection((err, connection) => {
        if (err) {
            console.error(`❌ ${dbName.toUpperCase()} Database Connection Failed:`, err.code, err.message);
        } else {
            console.log(`✅ Connected to ${dbName.toUpperCase()} Database successfully!`);
            connection.release();
        }
    });
});

// --- 2. API ENDPOINT ---
app.get('/api/volume', (req, res) => {
    const hours = req.query.hours;
    const database = req.query.database || 'bitmart'; // Default to bitmart

    if (!hours) {
        return res.status(400).json({ error: "Please provide 'hours' parameter" });
    }

    const pool = getPool(database);
    
    // Handle "today" - filter by current date
    if (hours === 'today') {
        console.log(`[${database.toUpperCase()}] Checking volume for today...`);
        
        const sql = `
            SELECT 
                SUM(total_usd) AS total_volume,
                MIN(timestamp) AS start_time,
                MAX(timestamp) AS end_time,
                HOUR(NOW()) AS current_hour,
                MINUTE(NOW()) AS current_minute
            FROM trade_history 
            WHERE DATE(timestamp) = CURDATE()
        `;

        pool.query(sql, (err, results) => {
            if (err) {
                console.error("Query Error:", err);
                return res.status(500).json({ error: "Database error" });
            }

            const volume = results[0].total_volume || 0;
            const startTime = results[0].start_time;
            const endTime = results[0].end_time;
            const currentHour = results[0]?.current_hour || 0;
            
            // Calculate hours elapsed today
            // HOUR(NOW()) returns 0-23, representing the current hour of the day
            // This directly represents hours elapsed since midnight:
            // - At 1:00 AM, HOUR=1 → 1 hour has elapsed → show "1 hr"
            // - At 7:00 AM, HOUR=7 → 7 hours have elapsed → show "7 hr"
            // - At 12:00 PM, HOUR=12 → 12 hours have elapsed → show "12 hr"
            const hoursElapsed = currentHour;

            console.log(`Timeframe: ${startTime} to ${endTime} (Today - ${hoursElapsed} hours elapsed)`);

            res.json({ 
                timeframe_hours: 'today',
                volume: volume,
                start_time: startTime,
                end_time: endTime,
                hours_elapsed: hoursElapsed
            });
        });
        return;
    }

    console.log(`[${database.toUpperCase()}] Checking volume for last ${hours} hours from database's last entry...`);

    // First, get the last entry timestamp to calculate the timeframe
    const getLastTimestamp = `
        SELECT MAX(timestamp) AS last_timestamp 
        FROM trade_history
    `;

    pool.query(getLastTimestamp, (err, timestampResults) => {
        if (err) {
            console.error("Error getting last timestamp:", err);
            return res.status(500).json({ error: "Database error" });
        }

        const lastTimestamp = timestampResults[0]?.last_timestamp;
        if (!lastTimestamp) {
            return res.status(404).json({ error: "No data found in database" });
        }

        // Calculate start time: last entry - X hours
        const sql = `
            SELECT 
                SUM(total_usd) AS total_volume,
                MIN(timestamp) AS start_time,
                MAX(timestamp) AS end_time
            FROM trade_history 
            WHERE timestamp >= ? - INTERVAL ? HOUR
        `;

        pool.query(sql, [lastTimestamp, hours], (err, results) => {
            if (err) {
                console.error("Query Error:", err);
                return res.status(500).json({ error: "Database error" });
            }

            // Handle case where result is null (no trades found)
            const volume = results[0].total_volume || 0;
            const startTime = results[0].start_time;
            const endTime = results[0].end_time;

            console.log(`Last entry: ${lastTimestamp}`);
            console.log(`Timeframe: ${startTime} to ${endTime} (${hours} hours)`);

            res.json({ 
                timeframe_hours: hours,
                volume: volume,
                last_entry: lastTimestamp,
                start_time: startTime,
                end_time: endTime
            });
        });
    });
});

// --- 3. API ENDPOINT FOR PRICE CHART ---
app.get('/api/price-chart', (req, res) => {
    const hours = req.query.hours;
    const database = req.query.database || 'bitmart'; // Default to bitmart

    if (!hours) {
        return res.status(400).json({ error: "Please provide 'hours' parameter" });
    }

    const pool = getPool(database);
    
    // Handle "today" - filter by current date
    if (hours === 'today') {
        console.log(`[${database.toUpperCase()}] Fetching price chart data for today...`);
        
        const sql = `
            SELECT 
                timestamp,
                price,
                amount,
                total_usd
            FROM trade_history 
            WHERE DATE(timestamp) = CURDATE()
            ORDER BY timestamp ASC
        `;

        pool.query(sql, (err, results) => {
            if (err) {
                console.error("Query Error:", err);
                return res.status(500).json({ error: "Database error" });
            }

            const chartData = {
                timeframe_hours: 'today',
                data: results.map(row => ({
                    timestamp: row.timestamp,
                    price: parseFloat(row.price || 0),
                    volume: parseFloat(row.total_usd || row.amount || 0)
                }))
            };

            console.log(`Retrieved ${chartData.data.length} price and volume points for today`);

            res.json(chartData);
        });
        return;
    }

    console.log(`[${database.toUpperCase()}] Fetching price chart data for last ${hours} hours from database's last entry...`);

    // First, get the last entry timestamp to calculate the timeframe
    const getLastTimestamp = `
        SELECT MAX(timestamp) AS last_timestamp 
        FROM trade_history
    `;

    pool.query(getLastTimestamp, (err, timestampResults) => {
        if (err) {
            console.error("Error getting last timestamp:", err);
            return res.status(500).json({ error: "Database error" });
        }

        const lastTimestamp = timestampResults[0]?.last_timestamp;
        if (!lastTimestamp) {
            return res.status(404).json({ error: "No data found in database" });
        }

        // Get price and volume data with timestamps, ordered by timestamp
        const sql = `
            SELECT 
                timestamp,
                price,
                amount,
                total_usd
            FROM trade_history 
            WHERE timestamp >= ? - INTERVAL ? HOUR
            ORDER BY timestamp ASC
        `;

        pool.query(sql, [lastTimestamp, hours], (err, results) => {
            if (err) {
                console.error("Query Error:", err);
                return res.status(500).json({ error: "Database error" });
            }

            // Format data for chart: { labels: [timestamps], prices: [prices], volumes: [volumes] }
            const chartData = {
                timeframe_hours: hours,
                last_entry: lastTimestamp,
                data: results.map(row => ({
                    timestamp: row.timestamp,
                    price: parseFloat(row.price || 0),
                    volume: parseFloat(row.total_usd || row.amount || 0)
                }))
            };

            console.log(`Retrieved ${chartData.data.length} price and volume points`);

            res.json(chartData);
        });
    });
});

// --- 4. API ENDPOINT FOR INVENTORY SNAPSHOT ---
app.get('/api/inventory', (req, res) => {
    const database = req.query.database || 'bitmart'; // Default to bitmart
    const pool = getPool(database);
    
    console.log(`[${database.toUpperCase()}] Fetching inventory snapshot...`);

    // Query using exact table and column names - always get latest snapshot
    const sql = `
        SELECT 
            bot_a_token,
            bot_b_token,
            net_token_change,
            bot_a_usdt,
            bot_b_usdt,
            timestamp
        FROM inventory_snapshot
        ORDER BY timestamp DESC
        LIMIT 1
    `;

    pool.query(sql, (err, results) => {
        if (err) {
            console.error("Inventory Query Error:", err);
            return res.status(500).json({ 
                error: "Database error",
                message: err.message
            });
        }

        if (results.length === 0) {
            return res.status(404).json({ 
                error: "No inventory data found",
                message: "No records found in inventory_snapshot table"
            });
        }

        const row = results[0];
        const botA = parseFloat(row.bot_a_token || 0);
        const botB = parseFloat(row.bot_b_token || 0);
        const netL1X = parseFloat(row.net_token_change || 0);
        const botAUsdt = parseFloat(row.bot_a_usdt || 0);
        const botBUsdt = parseFloat(row.bot_b_usdt || 0);

        console.log(`Inventory snapshot retrieved: Bot A=${botA}, Bot B=${botB}, Net L1X=${netL1X}`);

        res.json({
            bot_a: botA,
            bot_b: botB,
            net_l1x: netL1X,
            bot_a_usdt: botAUsdt,
            bot_b_usdt: botBUsdt,
            timestamp: row.timestamp,
            // Status indicators
            bot_a_status: botA >= 0 ? 'bought' : 'sold',
            bot_b_status: botB >= 0 ? 'bought' : 'sold',
            net_l1x_status: netL1X >= 0 ? 'bought' : 'sold'
        });
    });
});

// --- 5. API ENDPOINT FOR INVENTORY ANALYSIS (OPENING/CLOSING) ---
app.get('/api/inventory-analysis', (req, res) => {
    const hours = req.query.hours;
    const database = req.query.database || 'bitmart';

    if (!hours) {
        return res.status(400).json({ error: "Please provide 'hours' parameter" });
    }

    const pool = getPool(database);
    
    // Handle "today" - filter by current date
    if (hours === 'today') {
        console.log(`[${database.toUpperCase()}] Fetching inventory analysis for today...`);
        
        const sql = `
            SELECT 
                bot_a_token,
                bot_b_token,
                bot_a_usdt,
                bot_b_usdt,
                net_token_change,
                timestamp
            FROM inventory_snapshot
            WHERE DATE(timestamp) = CURDATE()
            ORDER BY timestamp ASC
        `;

        pool.query(sql, (err, results) => {
            if (err) {
                console.error("Query Error:", err);
                return res.status(500).json({ error: "Database error" });
            }

            if (results.length === 0) {
                return res.status(404).json({ 
                    error: "No inventory data found in timeframe",
                    message: "No records found for today"
                });
            }

            // Opening balance (first record)
            const opening = results[0];
            const openingBotAL1X = parseFloat(opening.bot_a_token || 0);
            const openingBotBL1X = parseFloat(opening.bot_b_token || 0);
            const openingBotAUsdt = parseFloat(opening.bot_a_usdt || 0);
            const openingBotBUsdt = parseFloat(opening.bot_b_usdt || 0);

            // Closing balance (last record)
            const closing = results[results.length - 1];
            const closingBotAL1X = parseFloat(closing.bot_a_token || 0);
            const closingBotBL1X = parseFloat(closing.bot_b_token || 0);
            const closingBotAUsdt = parseFloat(closing.bot_a_usdt || 0);
            const closingBotBUsdt = parseFloat(closing.bot_b_usdt || 0);

            // Calculate combined totals
            const openingL1X = openingBotAL1X + openingBotBL1X;
            const openingUsdt = openingBotAUsdt + openingBotBUsdt;
            const closingL1X = closingBotAL1X + closingBotBL1X;
            const closingUsdt = closingBotAUsdt + closingBotBUsdt;

            // Calculate net differences
            const netL1X = closingL1X - openingL1X;
            const netUsdt = closingUsdt - openingUsdt;

            console.log(`Opening: L1X=${openingL1X}, USDT=${openingUsdt}`);
            console.log(`Closing: L1X=${closingL1X}, USDT=${closingUsdt}`);
            console.log(`Net: L1X=${netL1X}, USDT=${netUsdt}`);

            res.json({
                timeframe_hours: 'today',
                opening: {
                    bot_a_l1x: openingBotAL1X,
                    bot_b_l1x: openingBotBL1X,
                    bot_a_usdt: openingBotAUsdt,
                    bot_b_usdt: openingBotBUsdt,
                    combined_l1x: openingL1X,
                    combined_usdt: openingUsdt,
                    timestamp: opening.timestamp
                },
                closing: {
                    bot_a_l1x: closingBotAL1X,
                    bot_b_l1x: closingBotBL1X,
                    bot_a_usdt: closingBotAUsdt,
                    bot_b_usdt: closingBotBUsdt,
                    combined_l1x: closingL1X,
                    combined_usdt: closingUsdt,
                    timestamp: closing.timestamp
                },
                net_difference: {
                    l1x: netL1X,
                    usdt: netUsdt
                }
            });
        });
        return;
    }

    console.log(`[${database.toUpperCase()}] Fetching inventory analysis for last ${hours} hours...`);

    // First, get the last entry timestamp from inventory_snapshot
    const getLastTimestamp = `
        SELECT MAX(timestamp) AS last_timestamp 
        FROM inventory_snapshot
    `;

    pool.query(getLastTimestamp, (err, timestampResults) => {
        if (err) {
            console.error("Error getting last timestamp:", err);
            return res.status(500).json({ error: "Database error" });
        }

        const lastTimestamp = timestampResults[0]?.last_timestamp;
        if (!lastTimestamp) {
            return res.status(404).json({ error: "No inventory data found in database" });
        }

        // Get opening (first) and closing (last) records within timeframe
        const sql = `
            SELECT 
                bot_a_token,
                bot_b_token,
                bot_a_usdt,
                bot_b_usdt,
                net_token_change,
                timestamp
            FROM inventory_snapshot
            WHERE timestamp >= ? - INTERVAL ? HOUR
            ORDER BY timestamp ASC
        `;

        pool.query(sql, [lastTimestamp, hours], (err, results) => {
            if (err) {
                console.error("Query Error:", err);
                return res.status(500).json({ error: "Database error" });
            }

            if (results.length === 0) {
                return res.status(404).json({ 
                    error: "No inventory data found in timeframe",
                    message: `No records found in the last ${hours} hours`
                });
            }

            // Opening balance (first record)
            const opening = results[0];
            const openingBotAL1X = parseFloat(opening.bot_a_token || 0);
            const openingBotBL1X = parseFloat(opening.bot_b_token || 0);
            const openingBotAUsdt = parseFloat(opening.bot_a_usdt || 0);
            const openingBotBUsdt = parseFloat(opening.bot_b_usdt || 0);

            // Closing balance (last record)
            const closing = results[results.length - 1];
            const closingBotAL1X = parseFloat(closing.bot_a_token || 0);
            const closingBotBL1X = parseFloat(closing.bot_b_token || 0);
            const closingBotAUsdt = parseFloat(closing.bot_a_usdt || 0);
            const closingBotBUsdt = parseFloat(closing.bot_b_usdt || 0);

            // Calculate combined totals
            const openingL1X = openingBotAL1X + openingBotBL1X;
            const openingUsdt = openingBotAUsdt + openingBotBUsdt;
            const closingL1X = closingBotAL1X + closingBotBL1X;
            const closingUsdt = closingBotAUsdt + closingBotBUsdt;

            // Calculate net differences
            const netL1X = closingL1X - openingL1X;
            const netUsdt = closingUsdt - openingUsdt;

            console.log(`Opening: L1X=${openingL1X}, USDT=${openingUsdt}`);
            console.log(`Closing: L1X=${closingL1X}, USDT=${closingUsdt}`);
            console.log(`Net: L1X=${netL1X}, USDT=${netUsdt}`);

            res.json({
                timeframe_hours: hours,
                opening: {
                    bot_a_l1x: openingBotAL1X,
                    bot_b_l1x: openingBotBL1X,
                    bot_a_usdt: openingBotAUsdt,
                    bot_b_usdt: openingBotBUsdt,
                    combined_l1x: openingL1X,
                    combined_usdt: openingUsdt,
                    timestamp: opening.timestamp
                },
                closing: {
                    bot_a_l1x: closingBotAL1X,
                    bot_b_l1x: closingBotBL1X,
                    bot_a_usdt: closingBotAUsdt,
                    bot_b_usdt: closingBotBUsdt,
                    combined_l1x: closingL1X,
                    combined_usdt: closingUsdt,
                    timestamp: closing.timestamp
                },
                net_difference: {
                    l1x: netL1X,
                    usdt: netUsdt
                }
            });
        });
    });
});

// --- 6. START SERVER ---
const PORT = parseInt(process.env.DASHBOARD_PORT) || 5002;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
