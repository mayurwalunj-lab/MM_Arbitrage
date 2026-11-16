'use strict';

// TELEGRAM SENDER — posts plain-text messages to one chat via the Bot API, and
// reads commands sent to the bot (getUpdates). TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID come from .env; with either missing, messages are only
// logged (so the monitor still runs, e.g. locally).

const https = require('https');

function config() {
  return {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: (process.env.TELEGRAM_CHAT_ID || '').trim()
  };
}

function isEnabled() {
  const c = config();
  return !!(c.token && c.chatId);
}

function post(token, body, method = 'sendMessage', timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('telegram request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

// Send one message. Never throws: a failed alert must not stop the monitor.
// Retries once after Telegram's retry_after on a 429.
async function send(text) {
  const c = config();
  const msg = String(text).slice(0, 4000); // Telegram limit is 4096 chars
  if (!c.token || !c.chatId) {
    console.log(`[telegram disabled] ${msg.replace(/\n/g, ' | ')}`);
    return false;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await post(c.token, { chat_id: c.chatId, text: msg, disable_web_page_preview: true });
      if (r.json && r.json.ok) return true;
      const wait = r.json && r.json.parameters && r.json.parameters.retry_after;
      if (r.status === 429 && wait && attempt === 1) {
        await new Promise((res) => setTimeout(res, Math.min(wait, 60) * 1000));
        continue;
      }
      console.log(`[telegram] send failed (${r.status}): ${r.json && r.json.description}`);
      return false;
    } catch (e) {
      console.log(`[telegram] send error: ${e.message}`);
      return false;
    }
  }
  return false;
}

// Messages sent to the bot from the configured chat only, after `offset`.
// Long-polls up to waitSec. Returns { ok, messages: [{ id, text, date }], offset }.
// Never throws; on any error ok is false, with no messages and the same offset.
async function getCommands(offset, waitSec = 0) {
  const c = config();
  if (!c.token || !c.chatId) return { ok: false, messages: [], offset };
  try {
    const r = await post(c.token, { offset, timeout: waitSec, allowed_updates: ['message'] }, 'getUpdates', (waitSec + 15) * 1000);
    if (!r.json || !r.json.ok) return { ok: false, messages: [], offset };
    let next = offset;
    const messages = [];
    for (const u of r.json.result) {
      next = Math.max(next || 0, u.update_id + 1);
      const m = u.message;
      if (m && m.text && String(m.chat && m.chat.id) === c.chatId) messages.push({ id: m.message_id, text: m.text.trim(), date: m.date });
    }
    return { ok: true, messages, offset: next };
  } catch (_) {
    return { ok: false, messages: [], offset };
  }
}

module.exports = { config, isEnabled, send, getCommands };
