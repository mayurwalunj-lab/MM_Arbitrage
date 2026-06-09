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
    }
  ]
};
