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
    }
  ]
};
