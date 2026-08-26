'use strict';

// Wallet roster for the QDex volume TEST harness.
//
// The 10 sub-wallets are HD-derived from ONE mnemonic (m/44'/60'/0'/0/i) rather
// than being 10 unrelated random keys: one secret to back up, reproducible on any
// machine, and trivially extended to more wallets. Generation needs no network,
// no gas and no chain interaction — an address is pure math, and the chain only
// learns it exists when it first receives funds.
//
// Keys are persisted twice, deliberately: encrypted in MySQL (recoverable with
// QVT_KEY_ENCRYPTION_KEY) and as a gitignored keyfile holding the mnemonic
// (recoverable if the database is lost). Either one alone restores the roster.
//
// The parent wallet is NOT generated here — it is supplied via QVT_PARENT_PK
// because it is the wallet that actually holds funds across epoch rotations.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const crypto = require('./crypto');

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)'
];

function derive(mnemonic, count, basePath) {
  const out = [];
  for (let i = 0; i < count; i++) {
    // Derive each child straight from the seed at its full path. Note that
    // HDNodeWallet.fromPhrase(mnemonic) alone returns a node ALREADY at the
    // default account path (depth 5) — calling derivePath('m/...') on that
    // throws, so the path has to be passed here instead.
    const w = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `${basePath}/${i}`);
    out.push({ idx: i, address: w.address, privateKey: w.privateKey });
  }
  return out;
}

// Create a brand-new roster. Offline: no provider, no gas, no transaction.
function generate(config) {
  const mnemonic = ethers.Wallet.createRandom().mnemonic.phrase;
  return { mnemonic, wallets: derive(mnemonic, config.walletCount, config.derivationPath) };
}

function readKeyfile(config) {
  if (!fs.existsSync(config.keyfile)) return null;
  return JSON.parse(fs.readFileSync(config.keyfile, 'utf8'));
}

// Refuse to clobber a keyfile that may be guarding funded wallets — an explicit
// --force takes a timestamped backup first.
function writeKeyfile(config, data, { force = false, stamp } = {}) {
  if (fs.existsSync(config.keyfile)) {
    if (!force) {
      throw new Error(`keyfile already exists: ${config.keyfile}\n` +
        '  It may hold funded wallets. Sweep them first, or pass --force (the old file is backed up).');
    }
    const bak = `${config.keyfile}.${stamp || 'backup'}.bak`;
    fs.copyFileSync(config.keyfile, bak);
  }
  fs.mkdirSync(path.dirname(config.keyfile), { recursive: true });
  fs.writeFileSync(config.keyfile, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(config.keyfile, 0o600);
}

// Rebuild signers for an epoch. Prefers the DB (encrypted keys), falls back to
// re-deriving from the keyfile mnemonic if the DB row is unavailable.
function signersFromRows(rows, provider) {
  return rows.map((r) => ({
    idx: r.idx,
    address: r.address,
    wallet: new ethers.Wallet(crypto.decrypt(r.privkey_enc), provider)
  }));
}
function signersFromMnemonic(mnemonic, config, provider) {
  return derive(mnemonic, config.walletCount, config.derivationPath)
    .map((w) => ({ idx: w.idx, address: w.address, wallet: new ethers.Wallet(w.privateKey, provider) }));
}

function parentSigner(config, provider) {
  if (!config.parentPrivateKey) throw new Error('QVT_PARENT_PK not set in .env');
  return new ethers.Wallet(config.parentPrivateKey, provider);
}

// One balance snapshot: native gas, WL1X, and every configured pool token.
// Issued in parallel — with ten pools this is a dozen calls per wallet, and the
// bot takes a snapshot of every wallet whenever one drops below its floor.
// Serialising them made an iteration take tens of seconds on a slow RPC.
async function snapshot({ provider, address, config, tokenMeta }) {
  const wl1x = new ethers.Contract(config.wl1x, ERC20_ABI, provider);
  const poolTokens = config.pools.filter((p) => tokenMeta[p.token.toLowerCase()]);
  const [native, wl1xBal, ...raws] = await Promise.all([
    provider.getBalance(address),
    wl1x.balanceOf(address),
    ...poolTokens.map((p) => new ethers.Contract(p.token, ERC20_ABI, provider).balanceOf(address))
  ]);
  const tokens = {};
  poolTokens.forEach((p, i) => {
    const meta = tokenMeta[p.token.toLowerCase()];
    tokens[p.token.toLowerCase()] = {
      symbol: meta.symbol, decimals: meta.decimals, label: p.label,
      raw: raws[i], human: Number(ethers.formatUnits(raws[i], meta.decimals))
    };
  });
  return {
    address,
    nativeRaw: native,
    native: Number(ethers.formatEther(native)),
    wl1xRaw: wl1xBal,
    wl1x: Number(ethers.formatUnits(wl1xBal, 18)),
    tokens
  };
}

// Cache symbol/decimals once per process — they never change.
async function loadTokenMeta(provider, config) {
  const meta = {};
  const addrs = [config.wl1x, ...config.pools.map((p) => p.token)];
  for (const a of [...new Set(addrs.map((x) => x.toLowerCase()))]) {
    try {
      const c = new ethers.Contract(a, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([c.symbol().catch(() => '?'), c.decimals().catch(() => 18)]);
      meta[a] = { address: ethers.getAddress(a), symbol: String(symbol).trim(), decimals: Number(decimals) };
    } catch {
      meta[a] = { address: ethers.getAddress(a), symbol: '?', decimals: 18 };
    }
  }
  return meta;
}

module.exports = {
  ERC20_ABI, derive, generate, readKeyfile, writeKeyfile,
  signersFromRows, signersFromMnemonic, parentSigner, snapshot, loadTokenMeta
};
