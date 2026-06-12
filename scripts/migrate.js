#!/usr/bin/env node

'use strict';

// Versioned schema migrations for mm_production.
//
//   node scripts/migrate.js status    list applied and pending migrations
//   node scripts/migrate.js up        apply all pending migrations in order
//
// Migrations live in migrations/NNN_name.sql, applied in filename order and
// recorded in the schema_migrations table. A migration runs once, ever.
//
// Rules for writing migrations:
//   - never edit an applied migration; add a new numbered file instead
//   - make statements idempotent where cheap (IF NOT EXISTS), but the runner
//     guarantees once-only application either way
//   - one concern per file; the filename should say what it does
//
// Target database: ARB_DB_* when set, else BITMART_DB_* (same resolution as
// arb/db.js — both point at the consolidated mm_production).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function dbConfig() {
  const pick = (key) => process.env[`ARB_DB_${key}`] || process.env[`BITMART_DB_${key}`] || '';
  return {
    host: pick('HOST'),
    port: Number(pick('PORT') || 3306),
    user: pick('USER'),
    password: pick('PASSWORD'),
    database: pick('NAME'),
    multipleStatements: true,
    connectTimeout: 15000
  };
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

async function ensureTrackingTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function appliedVersions(conn) {
  const [rows] = await conn.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(rows.map((r) => r.version));
}

async function main() {
  const command = process.argv[2];
  if (!['status', 'up'].includes(command)) {
    console.log('Usage: node scripts/migrate.js <status|up>');
    process.exitCode = command ? 1 : 0;
    return;
  }

  const config = dbConfig();
  if (!config.host || !config.database) {
    throw new Error('No DB config (set BITMART_DB_* or ARB_DB_* in .env)');
  }
  console.log(`database: ${config.database} @ ${config.host}`);

  const conn = await mysql.createConnection(config);
  try {
    await ensureTrackingTable(conn);
    const applied = await appliedVersions(conn);
    const files = listMigrationFiles();

    if (command === 'status') {
      if (!files.length) { console.log('no migration files in migrations/'); return; }
      for (const file of files) {
        console.log(`${applied.has(file) ? 'APPLIED' : 'PENDING'}  ${file}`);
      }
      const pending = files.filter((f) => !applied.has(f)).length;
      console.log(`\n${applied.size} applied, ${pending} pending`);
      return;
    }

    const pending = files.filter((f) => !applied.has(f));
    if (!pending.length) { console.log('nothing to do — all migrations applied.'); return; }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const started = Date.now();
      console.log(`applying ${file}...`);
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      console.log(`  done (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
    console.log(`\n${pending.length} migration(s) applied.`);
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
