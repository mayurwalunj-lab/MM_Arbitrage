#!/usr/bin/env node

'use strict';

// Prune the skip rows from qdex_volume_trades.
//
//   node scripts/qdex_volume_prune_skips.js              dry run — counts only
//   node scripts/qdex_volume_prune_skips.js --execute    archive, then delete
//   node scripts/qdex_volume_prune_skips.js --keep-hours 24 --execute
//
// Why this exists: the bot writes one row per trade ATTEMPT, skips included.
// A fragmented fleet skips in a tight loop — 260,137 rows in four days, 106 MB
// of a 107 MB table — which buries the 4,656 real trades and slows every
// dashboard query that scans the table.
//
// Nothing is deleted before it is archived. Two artefacts are written first:
//   <out>/skips-<stamp>.summary.json   aggregate counts by day/wallet/pool/reason
//   <out>/skips-<stamp>.raw.csv.gz     every row being deleted, in full
// The summary is the part worth keeping — it answers the same questions
// report.js answers from the raw rows, in a few KB instead of 106 MB.
//
// Only status='skipped' is ever touched. executed / failed / unconfirmed rows
// are the audit trail of real money and are never in scope, at any flag.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mysql = require('mysql2/promise');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const execute = has('--execute');
const keepHours = Number(arg('--keep-hours', 0));
const chunk = Number(arg('--chunk', 5000));
const outDir = arg('--out', path.join(__dirname, '..', 'qdex', 'volume', 'archive'));

function dbConfig() {
  const pick = (k) => process.env[`QVT_DB_${k}`] || process.env[`QDEX_DB_${k}`] || process.env[`DB_${k}`] || process.env[`BITMART_DB_${k}`] || '';
  const c = { host: pick('HOST'), port: Number(pick('PORT') || 3306), user: pick('USER'), password: pick('PASSWORD'), database: pick('NAME') };
  if (!c.host || !c.user || !c.database) throw new Error('database is not configured (QVT_DB_* / DB_*)');
  return c;
}

// Recent skips are worth keeping: they are how you diagnose a fleet that is
// stuck RIGHT NOW. --keep-hours draws that line.
const WHERE = keepHours > 0
  ? { sql: `status = 'skipped' AND timestamp < NOW() - INTERVAL ? HOUR`, args: [keepHours] }
  : { sql: `status = 'skipped'`, args: [] };

const csvCell = (v) => {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

(async () => {
  const pool = mysql.createPool({ ...dbConfig(), waitForConnections: true, connectionLimit: 2 });
  const q = (sql, a = []) => pool.query(sql, a);

  const [[tot]] = await q(`SELECT COUNT(*) n, MIN(timestamp) a, MAX(timestamp) b FROM qdex_volume_trades WHERE ${WHERE.sql}`, WHERE.args);
  const [[keep]] = await q(`SELECT COUNT(*) n FROM qdex_volume_trades WHERE status <> 'skipped'`);

  log(`skip rows in scope : ${tot.n}` + (keepHours > 0 ? `  (older than ${keepHours}h)` : '  (all)'));
  log(`  range            : ${tot.a ? new Date(tot.a).toISOString() : '-'} .. ${tot.b ? new Date(tot.b).toISOString() : '-'}`);
  log(`rows NOT in scope  : ${keep.n}  (executed / failed / unconfirmed — never deleted)`);

  if (!tot.n) { log('nothing to prune'); await pool.end(); return; }
  if (!execute) {
    log('');
    log('DRY RUN — nothing archived, nothing deleted. Re-run with --execute.');
    await pool.end();
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sumPath = path.join(outDir, `skips-${stamp}.summary.json`);
  const rawPath = path.join(outDir, `skips-${stamp}.raw.csv.gz`);

  // ---- 1. summary (the part anyone will actually read again) ----
  const grab = async (sql) => { const [r] = await q(`${sql}`, WHERE.args); return r; };
  const summary = {
    generatedAt: new Date().toISOString(),
    scope: keepHours > 0 ? `status='skipped' older than ${keepHours}h` : `status='skipped' (all)`,
    total: tot.n,
    firstAt: tot.a, lastAt: tot.b,
    byDay: await grab(`SELECT DATE(timestamp) day, COUNT(*) n FROM qdex_volume_trades WHERE ${WHERE.sql} GROUP BY day ORDER BY day`),
    byEpoch: await grab(`SELECT epoch_id, COUNT(*) n FROM qdex_volume_trades WHERE ${WHERE.sql} GROUP BY epoch_id ORDER BY epoch_id`),
    byWallet: await grab(`SELECT wallet_idx, COUNT(*) n FROM qdex_volume_trades WHERE ${WHERE.sql} GROUP BY wallet_idx ORDER BY wallet_idx`),
    byPool: await grab(`SELECT pool_label, COUNT(*) n FROM qdex_volume_trades WHERE ${WHERE.sql} GROUP BY pool_label ORDER BY n DESC`),
    // Reasons carry a live number in the text ("invMax=0.247"), so the raw
    // strings shatter into thousands of near-identical groups. Cut at the '='
    // to recover the actual categories.
    byReasonClass: await grab(`SELECT SUBSTRING_INDEX(LEFT(reason,60),'=',1) class, COUNT(*) n
                               FROM qdex_volume_trades WHERE ${WHERE.sql} GROUP BY class ORDER BY n DESC`),
    topReasons: await grab(`SELECT LEFT(reason,120) reason, COUNT(*) n FROM qdex_volume_trades
                            WHERE ${WHERE.sql} GROUP BY LEFT(reason,120) ORDER BY n DESC LIMIT 50`)
  };
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  log(`summary written    : ${sumPath}`);

  // ---- 2. raw archive, streamed and gzipped so 260k rows never sit in memory ----
  const gz = zlib.createGzip();
  const sink = fs.createWriteStream(rawPath);
  gz.pipe(sink);
  const conn = await mysql.createConnection({ ...dbConfig() });
  let cols = null, written = 0;
  await new Promise((resolve, reject) => {
    const stream = conn.connection.query(`SELECT * FROM qdex_volume_trades WHERE ${WHERE.sql} ORDER BY id`, WHERE.args).stream();
    stream.on('error', reject);
    stream.on('data', (row) => {
      if (!cols) { cols = Object.keys(row); gz.write(cols.join(',') + '\n'); }
      gz.write(cols.map((c) => csvCell(row[c])).join(',') + '\n');
      if (++written % 50000 === 0) log(`  archived ${written}/${tot.n}`);
    });
    stream.on('end', resolve);
  });
  await conn.end();
  await new Promise((res, rej) => { gz.end(); sink.on('finish', res); sink.on('error', rej); });
  const mb = (fs.statSync(rawPath).size / 1048576).toFixed(1);
  log(`raw archive written: ${rawPath}  (${written} rows, ${mb} MB gz)`);

  if (written !== tot.n) {
    // Refuse to delete what was not archived. Better to leave the rows than to
    // lose them because the archive came up short.
    throw new Error(`archived ${written} rows but ${tot.n} are in scope — NOT deleting`);
  }

  // ---- 3. delete in chunks ----
  // One 260k-row DELETE builds a huge undo log and holds locks for the whole
  // run; the bot writing concurrently would block on it. Chunks keep each
  // transaction small and let other writers interleave.
  let deleted = 0;
  for (;;) {
    const [r] = await q(`DELETE FROM qdex_volume_trades WHERE ${WHERE.sql} LIMIT ${chunk}`, WHERE.args);
    if (!r.affectedRows) break;
    deleted += r.affectedRows;
    if (deleted % (chunk * 10) === 0 || r.affectedRows < chunk) log(`  deleted ${deleted}/${tot.n}`);
  }
  log(`deleted            : ${deleted} rows`);

  // ---- 4. reclaim the space ----
  // InnoDB frees the pages to the tablespace but does not return them to the
  // filesystem; without this the table still reports ~107 MB on disk.
  log('rebuilding the table to reclaim disk (this locks it briefly)...');
  await q(`OPTIMIZE TABLE qdex_volume_trades`);

  // MySQL 8 caches information_schema table stats for 24h, so without this the
  // size read back is the PRE-prune figure and the run appears to have freed
  // nothing. Count the rows directly for the same reason.
  await q(`SET SESSION information_schema_stats_expiry = 0`);
  const [[left]] = await q(`SELECT COUNT(*) n FROM qdex_volume_trades`);
  const [[after]] = await q(
    `SELECT ROUND(data_length/1048576,1) data_mb, ROUND(index_length/1048576,1) idx_mb
     FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'qdex_volume_trades'`);
  log(`table now          : ${left.n} rows, ${after.data_mb} MB data + ${after.idx_mb} MB index`);
  await pool.end();
})().catch((e) => { console.error(`\nERROR: ${e.message}\n`); process.exit(1); });
