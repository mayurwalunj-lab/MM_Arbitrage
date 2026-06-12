#!/usr/bin/env node

'use strict';

// Option A database consolidation: copy both production databases into one
// database with prefixed table names. Sources are NEVER modified.
//
//   node scripts/db_consolidate.js copy      create mm_production + full copy
//   node scripts/db_consolidate.js verify    compare row counts source vs target
//   node scripts/db_consolidate.js topup     copy rows added since the last
//                                            copy (by id) — run at cutover
//
// Mapping:
//   market-cap_production.X  -> mm_production.bitmart_X
//   marketcap.X              -> mm_production.lbank_X
//   arb_* / dex_* tables     -> copied with their original names (already
//                               namespaced; the arb module keeps working)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const mysql = require('mysql2/promise');

const TARGET_DB = process.env.CONSOLIDATED_DB_NAME || 'mm_production';

const SOURCES = [
  { db: process.env.BITMART_DB_NAME || 'market-cap_production', prefix: 'bitmart_' },
  { db: process.env.LBANK_DB_NAME || 'marketcap', prefix: 'lbank_' }
];

function targetName(sourceTable, prefix) {
  if (sourceTable.startsWith('arb_') || sourceTable.startsWith('dex_')) return sourceTable;
  const lower = sourceTable.toLowerCase();
  if (lower.startsWith(prefix)) return lower;
  return prefix + lower;
}

async function connect() {
  return mysql.createConnection({
    host: process.env.BITMART_DB_HOST,
    port: Number(process.env.BITMART_DB_PORT || 3306),
    user: process.env.BITMART_DB_USER,
    password: process.env.BITMART_DB_PASSWORD,
    multipleStatements: false,
    connectTimeout: 15000
  });
}

async function listTables(conn, db) {
  const [rows] = await conn.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
    [db]
  );
  return rows.map((r) => r.t);
}

async function rowCount(conn, db, table) {
  const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${db}\`.\`${table}\``);
  return r.n;
}

async function commandCopy() {
  const conn = await connect();
  console.log(`creating database \`${TARGET_DB}\` (if missing)...`);
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${TARGET_DB}\``);

  for (const source of SOURCES) {
    const tables = await listTables(conn, source.db);
    console.log(`\n${source.db}: ${tables.length} tables`);
    for (const table of tables) {
      const target = targetName(table, source.prefix);
      const [existing] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [TARGET_DB, target]
      );
      if (existing[0].n > 0) {
        console.log(`  SKIP ${target} (already exists — use topup for increments)`);
        continue;
      }
      const started = Date.now();
      await conn.query(`CREATE TABLE \`${TARGET_DB}\`.\`${target}\` LIKE \`${source.db}\`.\`${table}\``);
      await conn.query(`INSERT INTO \`${TARGET_DB}\`.\`${target}\` SELECT * FROM \`${source.db}\`.\`${table}\``);
      const n = await rowCount(conn, TARGET_DB, target);
      console.log(`  OK ${source.db}.${table} -> ${target} (${n} rows, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
  }
  await conn.end();
  console.log('\ncopy complete. Sources untouched. Next: node scripts/db_consolidate.js verify');
}

async function commandVerify() {
  const conn = await connect();
  let mismatches = 0;
  for (const source of SOURCES) {
    const tables = await listTables(conn, source.db);
    for (const table of tables) {
      const target = targetName(table, source.prefix);
      const [src, tgt] = await Promise.all([
        rowCount(conn, source.db, table),
        rowCount(conn, TARGET_DB, target).catch(() => null)
      ]);
      const ok = tgt !== null && tgt >= src ? 'OK ' : 'MISMATCH';
      if (ok !== 'OK ') mismatches++;
      console.log(`${ok} ${source.db}.${table} (${src}) -> ${TARGET_DB}.${target} (${tgt ?? 'MISSING'})`);
    }
  }
  await conn.end();
  console.log(mismatches === 0 ? '\nall tables verified.' : `\n${mismatches} mismatch(es) — investigate before cutover.`);
  if (mismatches > 0) process.exitCode = 1;
}

async function commandTopup() {
  const conn = await connect();
  for (const source of SOURCES) {
    const tables = await listTables(conn, source.db);
    for (const table of tables) {
      const target = targetName(table, source.prefix);
      const [pk] = await conn.query(
        `SELECT column_name AS c FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ? AND column_key = 'PRI' AND extra LIKE '%auto_increment%'`,
        [source.db, table]
      );
      if (!pk.length) {
        console.log(`  SKIP ${table} (no auto-increment pk — full recopy needed if it changed)`);
        continue;
      }
      const col = pk[0].c;
      const [[m]] = await conn.query(`SELECT COALESCE(MAX(\`${col}\`),0) AS m FROM \`${TARGET_DB}\`.\`${target}\``);
      const [result] = await conn.query(
        `INSERT INTO \`${TARGET_DB}\`.\`${target}\` SELECT * FROM \`${source.db}\`.\`${table}\` WHERE \`${col}\` > ?`,
        [m.m]
      );
      if (result.affectedRows > 0) console.log(`  TOPUP ${target}: +${result.affectedRows} rows (after ${col}=${m.m})`);
    }
  }
  await conn.end();
  console.log('topup complete.');
}

async function main() {
  const command = process.argv[2];
  try {
    if (command === 'copy') await commandCopy();
    else if (command === 'verify') await commandVerify();
    else if (command === 'topup') await commandTopup();
    else {
      console.log('Usage: node scripts/db_consolidate.js <copy|verify|topup>');
      process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
