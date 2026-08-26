module.exports = {
  apps: [
    {
      name: 'Bitmart_Pattern_Trading',
      script: 'bitmart/Bitmart_Pattern_Trading.js',
      cwd: __dirname
    },
    {
      name: 'grid_manager_bitmart',
      script: 'bitmart/grid_manager_bitmart.js',
      cwd: __dirname
    },
    {
      name: 'Lbank_Pattern_Trading',
      script: 'lbank/Lbank_Pattern_Trading.js',
      cwd: __dirname
    },
    {
      name: 'LBank_GridManager',
      script: 'lbank/LBank_GridManager.js',
      cwd: __dirname
    },
    {
      name: 'Server',
      script: 'dashboard/Server.js',
      cwd: __dirname
    },
    {
      name: 'arb_monitor',
      script: 'arb/monitor.js',
      cwd: __dirname,
      restart_delay: 10000,
      max_restarts: 50
    },
    {
      // Runs one inventory snapshot and exits; PM2 re-runs it on the cron.
      name: 'arb_snapshot',
      script: 'arb/accounting.js',
      args: 'snapshot',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '*/30 * * * *'
    },
    {
      // Treasury sell/buy loop. Live vs dry-run is driven by TREASURY_EXECUTE
      // in .env (true = real trades; anything else = simulate). No --execute
      // arg here so you can toggle it from env without editing this file.
      name: 'treasury_monitor',
      script: 'arb/treasury_monitor.js',
      cwd: __dirname,
      restart_delay: 10000,
      max_restarts: 50
    },
    {
      // QDex market maker — holds the WL1X/XUSD pool to peg XUSD ($1). Live vs
      // dry-run is driven by QDEX_EXECUTE in .env (true = real swaps; else
      // simulate). Loop cadence = QDEX_POLL_MS; size cap = QDEX_MAX_TRADE_BASE.
      // No --execute/--once arg here so it loops and toggles from env.
      name: 'qdex_mm',
      script: 'qdex/qdex_mm.js',
      cwd: __dirname,
      restart_delay: 10000,
      max_restarts: 50
    },
    {
      // QDex VOLUME TEST HARNESS — randomised test trades across the pools
      // enabled in qdex_volume_pools, from the active epoch's wallet roster.
      //
      // Live vs dry-run is driven entirely by .env and the database, not by an
      // argument here: QVT_EXECUTE, QVT_ALLOWED_CHAIN_IDS and each pool's
      // allow_live flag. --execute is passed because without it the process can
      // never trade regardless of configuration; the gate is what actually
      // decides, and it degrades to simulation when shut.
      //
      // Do NOT raise `instances`. The harness takes a PID lock and a second
      // instance would refuse to start — and if it somehow did not, two copies
      // would draw the same nonce for the same wallet.
      name: 'qdex_volume',
      script: 'qdex/volume/bot.js',
      args: '--execute',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      // The bot stops itself on an undetermined transaction outcome or an
      // exhausted budget. Restarting into that state would spin, so back off
      // hard and cap the attempts — a human should look at why it stopped.
      restart_delay: 60000,
      max_restarts: 20,
      min_uptime: 120000,
      // The stop file survives a restart, so `npm run qdex:vol:stop` halts the
      // service properly rather than being undone by pm2.
      autorestart: true
    }
  ]
};
