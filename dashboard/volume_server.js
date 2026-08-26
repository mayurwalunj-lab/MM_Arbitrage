'use strict';

// Standalone dashboard for the QDex volume test harness. Serves volume.html and
// nothing else.
//
//   node dashboard/volume_server.js        then open http://localhost:5003
//
// Deliberately separate from dashboard/Server.js. That process serves the
// Bitmart/LBank views and the arb view off different tables entirely, and its
// landing page reads $0 while this harness is trading — which looks like nothing
// is happening. Rather than strip those views out of a shared file (and break
// them for every other branch), this runs the volume page on its own port.
//
// SECURITY: qdex_volume_wallets.privkey_enc and qdex_volume_epochs.mnemonic_enc
// hold wallet keys — in plaintext when QVT_STORE_PLAINTEXT_KEYS is on. Every
// query below names its columns explicitly and excludes those two. Never replace
// one with SELECT *: this process serves over HTTP, and with CORS open by
// default a single careless route publishes spendable keys.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');

const app = express();
app.use(cors());

function dbConfig() {
  const pick = (k) => process.env[`QVT_DB_${k}`] || process.env[`QDEX_DB_${k}`] || process.env[`DB_${k}`] || process.env[`BITMART_DB_${k}`] || '';
  return {
    host: pick('HOST'),
    port: Number(pick('PORT') || 3306),
    user: pick('USER'),
    password: pick('PASSWORD'),
    database: pick('NAME')
  };
}

const pool = mysql.createPool({ ...dbConfig(), waitForConnections: true, connectionLimit: 5, queueLimit: 0 });

// Dry-run rows vastly outnumber live ones — a dry run explores every pool — so
// the two must never be summed. Defaults to live.
function modeFilter(mode) {
  if (mode === 'dry') return 'is_dry_run = 1';
  if (mode === 'all') return '1=1';
  return 'is_dry_run = 0';
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'volume.html')));
app.get('/volume', (req, res) => res.sendFile(path.join(__dirname, 'volume.html')));

app.get('/api/qdex/volume/summary', (req, res) => {
  const hours = Number(req.query.hours) || 24;
  const flt = modeFilter(req.query.mode);
  pool.query(
    `SELECT COUNT(*) attempts,
            SUM(status='executed') executed,
            SUM(status='skipped')  skipped,
            SUM(status='failed')   failed,
            COALESCE(SUM(CASE WHEN status='executed' THEN notional_wl1x END),0) volume_wl1x,
            AVG(CASE WHEN status='executed' THEN notional_wl1x END) avg_size_wl1x,
            AVG(CASE WHEN status='executed' THEN impact_bps END)    avg_impact_bps,
            MAX(CASE WHEN status='executed' THEN impact_bps END)    max_impact_bps,
            AVG(CASE WHEN status='executed' THEN cost_bps END)      avg_cost_bps,
            SUM(CASE WHEN status='executed' AND side='buy'  THEN 1 ELSE 0 END) buys,
            SUM(CASE WHEN status='executed' AND side='sell' THEN 1 ELSE 0 END) sells,
            MIN(timestamp) first_ts, MAX(timestamp) last_ts
     FROM qdex_volume_trades
     WHERE timestamp > NOW() - INTERVAL ? HOUR AND ${flt}`,
    [hours],
    (err, totals) => {
      if (err) return res.status(500).json({ error: err.message });
      pool.query(
        `SELECT pool_label, COUNT(*) attempts, SUM(status='executed') executed,
                COALESCE(SUM(CASE WHEN status='executed' THEN notional_wl1x END),0) volume_wl1x,
                AVG(CASE WHEN status='executed' THEN impact_bps END) avg_impact_bps,
                AVG(CASE WHEN status='executed' THEN cost_bps END)   avg_cost_bps,
                AVG(deviation_pct) avg_deviation_pct
         FROM qdex_volume_trades
         WHERE timestamp > NOW() - INTERVAL ? HOUR AND ${flt}
         GROUP BY pool_label ORDER BY volume_wl1x DESC`,
        [hours],
        (e2, byPool) => {
          if (e2) return res.status(500).json({ error: e2.message });
          pool.query(
            `SELECT reason, COUNT(*) n FROM qdex_volume_trades
             WHERE timestamp > NOW() - INTERVAL ? HOUR AND status='skipped' AND ${flt}
             GROUP BY reason ORDER BY n DESC LIMIT 10`,
            [hours],
            (e3, skips) => {
              if (e3) return res.status(500).json({ error: e3.message });
              res.json({ totals: totals[0] || {}, byPool, skipReasons: skips });
            }
          );
        }
      );
    }
  );
});

app.get('/api/qdex/volume/trades', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const flt = modeFilter(req.query.mode);
  pool.query(
    `SELECT id, timestamp, epoch_id, run_id, status, is_dry_run, is_test_activity,
            wallet_idx, wallet_address, pool_label, side,
            amount_in, amount_in_symbol, amount_out, amount_out_symbol,
            notional_wl1x, exec_price, price_before, price_after, impact_bps, cost_bps,
            deviation_pct, tx_hash, block_number, gas_used, reason
     FROM qdex_volume_trades WHERE ${flt} ORDER BY id DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ trades: rows });
    }
  );
});

app.get('/api/qdex/volume/epochs', (req, res) => {
  // mnemonic_enc deliberately excluded.
  pool.query(
    `SELECT id, status, chain_id, parent_address, wallet_count, derivation_path,
            test_tag, is_test_activity, created_at, expires_at, retired_at, note
     FROM qdex_volume_epochs ORDER BY id DESC LIMIT 20`,
    (err, epochs) => {
      if (err) return res.status(500).json({ error: err.message });
      // privkey_enc deliberately excluded.
      pool.query(
        `SELECT epoch_id, idx, address, funded_at, swept_at
         FROM qdex_volume_wallets ORDER BY epoch_id DESC, idx ASC LIMIT 200`,
        (e2, wallets) => {
          if (e2) return res.status(500).json({ error: e2.message });
          res.json({ epochs, wallets });
        }
      );
    }
  );
});

app.get('/api/qdex/volume/transfers', (req, res) => {
  const hours = Number(req.query.hours) || 168;
  const flt = modeFilter(req.query.mode);
  pool.query(
    `SELECT id, timestamp, epoch_id, kind, from_address, to_address,
            token_symbol, amount, tx_hash, status, is_dry_run, reason
     FROM qdex_volume_transfers
     WHERE timestamp > NOW() - INTERVAL ? HOUR AND ${flt}
     ORDER BY id DESC LIMIT 300`,
    [hours],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ transfers: rows });
    }
  );
});

app.get('/api/qdex/volume/pools', (req, res) => {
  pool.query(
    `SELECT id, label, address, token_address, router_address, fee, enabled, allow_live,
            weight, max_impact_bps, tvl_usd, note, updated_at
     FROM qdex_volume_pools ORDER BY id`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ pools: rows });
    }
  );
});

const PORT = parseInt(process.env.QVT_DASHBOARD_PORT) || 5003;
app.listen(PORT, () => {
  console.log(`QDex volume dashboard: http://localhost:${PORT}`);
});
