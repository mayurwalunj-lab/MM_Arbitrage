'use strict';

// Exchange access for the arb module. Uses its own API keys (ARB_*) so it
// never shares rate limits or order ownership with the MM/grid bots. The MM
// bots' keys are used read-only, solely to identify our own open orders for
// the self-trade filter.

const ccxt = require('ccxt');

const EXCHANGES = ['bitmart', 'lbank'];

function credsFromEnv(prefix, withUid = false) {
  const apiKey = process.env[`${prefix}_API_KEY`] || '';
  const secret = process.env[`${prefix}_SECRET`] || '';
  if (!apiKey || !secret) return null;
  const creds = { apiKey, secret };
  if (withUid) creds.uid = process.env[`${prefix}_UID`] || '';
  return creds;
}

function newClient(exchangeId, creds) {
  const Exchange = ccxt[exchangeId];
  if (!Exchange) throw new Error(`Unsupported exchange: ${exchangeId}`);
  return new Exchange({ ...(creds || {}), enableRateLimit: true });
}

// Arb trading client. Public-only (orderbooks, tickers) when ARB_* keys are
// not configured; balances and orders then unavailable.
function createArbClient(exchangeId) {
  const prefix = `ARB_${exchangeId.toUpperCase()}`;
  const creds = credsFromEnv(prefix, exchangeId === 'bitmart');
  const client = newClient(exchangeId, creds);
  client.arbHasKeys = Boolean(creds);
  return client;
}

// Read-only clients for every MM/grid account we run on this exchange,
// using the same env keys the bots themselves use.
function createOwnAccountClients(exchangeId) {
  const upper = exchangeId.toUpperCase();
  const withUid = exchangeId === 'bitmart';
  const accounts = [
    { label: 'botA', prefix: `${upper}_BOT_A` },
    { label: 'botB', prefix: `${upper}_BOT_B` },
    { label: 'grid', prefix: `${upper}_GRID` }
  ];
  const clients = [];
  for (const account of accounts) {
    const creds = credsFromEnv(account.prefix, withUid);
    if (creds) clients.push({ label: account.label, client: newClient(exchangeId, creds) });
  }
  return clients;
}

async function fetchOrderBook(client, symbol, limit = 50) {
  const book = await client.fetchOrderBook(symbol, limit);
  return {
    bids: (book.bids || []).map(([p, a]) => [Number(p), Number(a)]),
    asks: (book.asks || []).map(([p, a]) => [Number(p), Number(a)]),
    timestamp: book.timestamp || Date.now()
  };
}

async function fetchTickerPrice(client, symbol) {
  const ticker = await client.fetchTicker(symbol);
  const candidates = [ticker.last, ticker.close, ticker.bid, ticker.ask]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!candidates.length) throw new Error(`${client.id} ${symbol} returned no usable price`);
  return { price: candidates[0], bid: Number(ticker.bid) || null, ask: Number(ticker.ask) || null };
}

async function fetchBalances(client, currencies) {
  const balance = await client.fetchBalance();
  const out = {};
  for (const currency of currencies) {
    out[currency] = Number(balance[currency]?.free ?? 0);
  }
  return out;
}

// All of our own open orders on a symbol across every MM/grid account.
// Failures on individual accounts are reported, not swallowed — a missing
// account would silently disable the self-trade filter for its orders.
async function fetchOwnOpenOrders(ownClients, symbol) {
  const results = await Promise.allSettled(
    ownClients.map(({ client }) => client.fetchOpenOrders(symbol))
  );
  const orders = [];
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const { label } = ownClients[i];
    const result = results[i];
    if (result.status === 'fulfilled') {
      for (const order of result.value) {
        orders.push({
          account: label,
          id: order.id,
          side: order.side,
          price: Number(order.price),
          remaining: Number(order.remaining ?? order.amount)
        });
      }
    } else {
      errors.push(`${label}: ${result.reason?.message || result.reason}`);
    }
  }
  return { orders, errors };
}

// Hard-guarded order placement. Refuses to send anything unless
// ARB_DRY_RUN=false is set explicitly — detection-phase code paths can never
// place an order by accident.
async function placeLimitOrder({ client, exchangeId, symbol, side, amount, price }) {
  if (process.env.ARB_DRY_RUN !== 'false') {
    throw new Error('placeLimitOrder blocked: set ARB_DRY_RUN=false to enable live orders');
  }
  if (!client.arbHasKeys) {
    throw new Error(`No ARB_${exchangeId.toUpperCase()} API keys configured`);
  }
  if (exchangeId === 'bitmart') {
    // Same raw endpoint the pattern bots use; unified createOrder has been
    // unreliable for BitMart spot.
    const rawSymbol = symbol.replace('/', '_');
    const result = await client.privatePostSpotV2SubmitOrder({
      symbol: rawSymbol,
      side,
      type: 'limit',
      size: String(amount),
      price: String(price)
    });
    const id = result?.data?.order_id ?? result?.order_id ?? null;
    if (!id) throw new Error(`bitmart order id missing in response: ${JSON.stringify(result).slice(0, 200)}`);
    return { id: String(id), raw: result };
  }
  const order = await client.createOrder(symbol, 'limit', side, Number(amount), Number(price));
  return { id: order.id, raw: order };
}

// Poll an order until it is fully filled, cancelled, or the timeout passes.
// Returns { status: 'filled'|'partial'|'open'|'canceled', filled, average }.
async function pollOrder({ client, orderId, symbol, timeoutMs = 10000, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 'open', filled: 0, average: null };
  while (Date.now() < deadline) {
    try {
      const order = await client.fetchOrder(orderId, symbol);
      const filled = Number(order.filled ?? 0);
      const average = Number(order.average ?? order.price) || null;
      if (order.status === 'closed') return { status: 'filled', filled, average };
      if (order.status === 'canceled' || order.status === 'cancelled') {
        return { status: 'canceled', filled, average };
      }
      last = { status: filled > 0 ? 'partial' : 'open', filled, average };
    } catch (_) { /* transient fetch error: keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

async function cancelOrder({ client, orderId, symbol }) {
  try {
    await client.cancelOrder(orderId, symbol);
    return true;
  } catch (error) {
    // Already filled or already gone is fine; the poll afterwards decides.
    return false;
  }
}

module.exports = {
  EXCHANGES,
  createArbClient,
  createOwnAccountClients,
  fetchOrderBook,
  fetchTickerPrice,
  fetchBalances,
  fetchOwnOpenOrders,
  placeLimitOrder,
  pollOrder,
  cancelOrder
};
