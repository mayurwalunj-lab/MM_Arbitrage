'use strict';

// AES-256-GCM at-rest encryption for wallet private keys and epoch mnemonics.
//
// Keys are stored in MySQL (qdex_volume_wallets.privkey_enc) but the encryption
// secret lives only in .env (QVT_KEY_ENCRYPTION_KEY). A database dump on its own
// is therefore useless — you need both halves. This matters here specifically
// because dashboard/Server.js serves the same database over HTTP with open CORS.
//
// Format: "v1:<iv-b64>:<tag-b64>:<ciphertext-b64>". GCM gives us an auth tag, so
// a tampered row fails loudly on decrypt instead of returning garbage.

const crypto = require('crypto');

const VERSION = 'v1';
const IV_BYTES = 12;   // 96-bit nonce — the GCM standard
const KEY_BYTES = 32;  // AES-256

// Derive a 32-byte key from whatever the operator put in .env. A 64-char hex
// string is used directly; anything else is stretched with scrypt so a
// human-typed passphrase still yields a valid key.
function deriveKey(secret) {
  if (!secret) {
    throw new Error('QVT_KEY_ENCRYPTION_KEY not set in .env — refusing to store wallet keys unencrypted');
  }
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  if (secret.length < 16) {
    throw new Error('QVT_KEY_ENCRYPTION_KEY too short — use at least 16 chars, or 64 hex chars');
  }
  // Fixed salt: the secret is already high-entropy-ish and we need the same key
  // every run. Rotating the salt would orphan every previously stored key.
  return crypto.scryptSync(secret, 'qdex-volume-test-v1', KEY_BYTES);
}

function encrypt(plaintext, secret = process.env.QVT_KEY_ENCRYPTION_KEY) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(blob, secret = process.env.QVT_KEY_ENCRYPTION_KEY) {
  const key = deriveKey(secret);
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`unrecognised ciphertext format (expected ${VERSION}:iv:tag:ct)`);
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  try {
    return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
  } catch {
    // GCM tag mismatch: either the wrong QVT_KEY_ENCRYPTION_KEY or a modified row.
    throw new Error('decrypt failed — wrong QVT_KEY_ENCRYPTION_KEY, or the stored value was altered');
  }
}

// Generate a fresh secret for a first-time operator to paste into .env.
const newSecret = () => crypto.randomBytes(KEY_BYTES).toString('hex');

// ---------------------------------------------------------------------------
// Storage format dispatch.
//
// QVT_STORE_PLAINTEXT_KEYS=true stores keys unencrypted, prefixed "plain:" so a
// row is self-describing about how it was written. That prefix is what lets an
// encrypted roster and a plaintext one coexist — unwrap() reads either, so
// switching the setting never orphans wallets created under the old mode.
//
// Plaintext means anyone with database access holds spendable keys, and this
// database is shared and is served over HTTP by dashboard/Server.js. Never add a
// route that selects privkey_enc or mnemonic_enc.
const PLAIN_PREFIX = 'plain:';

function wrap(value, { plaintext = false, secret } = {}) {
  if (plaintext) return PLAIN_PREFIX + String(value);
  return encrypt(value, secret);
}

function unwrap(blob, secret) {
  const s = String(blob);
  if (s.startsWith(PLAIN_PREFIX)) return s.slice(PLAIN_PREFIX.length);
  return decrypt(s, secret);
}

const isPlaintext = (blob) => String(blob).startsWith(PLAIN_PREFIX);

module.exports = { encrypt, decrypt, deriveKey, newSecret, wrap, unwrap, isPlaintext, VERSION, PLAIN_PREFIX };
