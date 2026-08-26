'use strict';

// Epoch lifecycle: the 10 sub-wallets live for QVT_EPOCH_DAYS, then everything
// they hold goes back to the parent in kind and a fresh 10 are generated.
//
//   active -> draining -> retired,  then a new epoch opens
//
// The parent wallet is constant across every epoch. That is deliberate and it is
// what keeps this auditable: rotating sub-wallets would otherwise make the
// activity hard to attribute, but every epoch's funding traces to the same
// parent address and the roster of every past epoch stays in the database.

const { ethers } = require('ethers');
const db = require('./db');
const crypto = require('./crypto');
const wallets = require('./wallets');

// Generate a roster, persist it (encrypted in MySQL + mnemonic in the keyfile)
// and open the epoch. No chain interaction at all — an address is pure math.
async function createEpoch({ config, chainId, parentAddress, force = false, log = () => {} }) {
  if (!config.encryptionKey) {
    throw new Error('QVT_KEY_ENCRYPTION_KEY not set — refusing to generate wallets whose keys cannot be encrypted.\n' +
      `  Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  }
  const open = await db.getActiveEpoch();
  if (open.length && !force) {
    throw new Error(`epoch ${open[0].id} is still ${open[0].status} — rotate or retire it first (or pass --force)`);
  }

  const { mnemonic, wallets: derived } = wallets.generate(config);
  const expiresAt = new Date(Date.now() + config.epochDays * 86400000);

  const epochId = await db.createEpoch({
    chainId, parentAddress,
    walletCount: config.walletCount,
    derivationPath: config.derivationPath,
    mnemonicEnc: crypto.encrypt(mnemonic),
    testTag: config.testTag,
    expiresAt,
    note: 'generated offline'
  });

  for (const w of derived) {
    await db.insertWallet({ epochId, idx: w.idx, address: w.address, privkeyEnc: crypto.encrypt(w.privateKey) });
  }

  wallets.writeKeyfile(config, {
    epochId, mnemonic,
    derivationPath: config.derivationPath,
    walletCount: config.walletCount,
    chainId, parentAddress,
    testTag: config.testTag,
    addresses: derived.map((w) => ({ idx: w.idx, address: w.address })),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    WARNING: 'Test wallets for the QDex volume harness. Back up QVT_KEY_ENCRYPTION_KEY too — either this mnemonic or that secret can recover the keys.'
  }, { force, stamp: String(Date.now()) });

  log(`epoch ${epochId} created — ${derived.length} wallets, expires ${expiresAt.toISOString()}`);
  return { epochId, expiresAt, wallets: derived };
}

// Load an epoch's signers. DB first (encrypted keys); if a row is missing or the
// encryption secret is wrong, fall back to re-deriving from the keyfile mnemonic.
async function loadSigners({ config, epochId, provider }) {
  const rows = await db.getWallets(epochId);
  if (rows.length && rows.every((r) => r.privkey_enc)) {
    try { return wallets.signersFromRows(rows, provider); } catch { /* fall through */ }
  }
  const kf = wallets.readKeyfile(config);
  if (!kf || !kf.mnemonic) throw new Error(`cannot load epoch ${epochId} signers: no usable DB keys and no keyfile at ${config.keyfile}`);
  return wallets.signersFromMnemonic(kf.mnemonic, config, provider);
}

async function current() {
  const open = await db.getActiveEpoch();
  if (!open.length) return null;
  if (open.length > 1) {
    throw new Error(`${open.length} epochs are open (${open.map((e) => e.id).join(', ')}) — exactly one must be active. Retire the stale ones.`);
  }
  return open[0];
}

const isExpired = (epoch) => !!(epoch && epoch.expires_at && new Date(epoch.expires_at).getTime() <= Date.now());

function summarise(epoch) {
  if (!epoch) return 'no active epoch';
  const ageH = (Date.now() - new Date(epoch.created_at).getTime()) / 3600000;
  const leftH = epoch.expires_at ? (new Date(epoch.expires_at).getTime() - Date.now()) / 3600000 : null;
  return `epoch ${epoch.id} [${epoch.status}] age ${ageH.toFixed(1)}h` +
    (leftH != null ? `, ${leftH > 0 ? leftH.toFixed(1) + 'h left' : 'EXPIRED'}` : '') +
    `, ${epoch.wallet_count} wallets`;
}

// Recover the private key for one wallet — the operator-facing escape hatch.
async function exportKey({ epochId, idx }) {
  const rows = await db.getWallets(epochId);
  const row = rows.find((r) => Number(r.idx) === Number(idx));
  if (!row) throw new Error(`no wallet idx ${idx} in epoch ${epochId}`);
  if (!row.privkey_enc) throw new Error('no encrypted key stored for that wallet');
  const pk = crypto.decrypt(row.privkey_enc);
  if (new ethers.Wallet(pk).address.toLowerCase() !== row.address.toLowerCase()) {
    throw new Error('decrypted key does not match the stored address — data corruption');
  }
  return { address: row.address, privateKey: pk };
}

module.exports = { createEpoch, loadSigners, current, isExpired, summarise, exportKey };
