module.exports = {
  apps: [
    {
      // Web dashboard. Serves three separate views off different tables:
      //   /         bitmart_* / lbank_*   the CEX bots
      //   /arb      dex_trades, treasury_sells
      //   /volume   qdex_volume_*         the volume test harness
      // The landing page knows nothing about QDex, so it reads $0 while the
      // harness is trading — /volume is the one to watch for this service.
      name: 'Server',
      script: 'dashboard/Server.js',
      cwd: __dirname,
      restart_delay: 5000,
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
