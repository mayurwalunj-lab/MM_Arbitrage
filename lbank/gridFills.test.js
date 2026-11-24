'use strict';

// Run: node --test lbank/gridFills.test.js
const test = require('node:test');
const assert = require('node:assert');
const { classifyGoneOrder } = require('./gridFills');

test('fully filled order is a FILLED with its traded amount', () => {
    const r = classifyGoneOrder({ status: 'closed', filled: 3.12, price: 6.972, average: 6.972 });
    assert.strictEqual(r.action, 'FILLED');
    assert.strictEqual(r.amount, 3.12);
    assert.ok(Math.abs(r.valueUsdt - 21.75264) < 1e-9);
});

test('a cancel that timed out but went through is CANCELLED, not FILLED', () => {
    assert.strictEqual(classifyGoneOrder({ status: 'canceled', filled: 0, price: 7.0421 }).action, 'CANCELLED');
    assert.strictEqual(classifyGoneOrder({ status: 'closed', filled: 0, price: 7.0421 }).action, 'CANCELLED');
});

test('partly filled then cancelled: FILLED for the part that traded only', () => {
    const r = classifyGoneOrder({ status: 'canceled', filled: 1.5, amount: 10, price: 7.03 });
    assert.strictEqual(r.action, 'FILLED');
    assert.strictEqual(r.amount, 1.5);
    assert.ok(Math.abs(r.valueUsdt - 10.545) < 1e-9);
});

test('still on the book (open-orders list missed it): OPEN, log nothing', () => {
    assert.strictEqual(classifyGoneOrder({ status: 'open', filled: 0.5, price: 7 }).action, 'OPEN');
});

test('unreadable answers are UNKNOWN and checked again later', () => {
    assert.strictEqual(classifyGoneOrder(null).action, 'UNKNOWN');
    assert.strictEqual(classifyGoneOrder({ status: 'closed', price: 7 }).action, 'UNKNOWN');
    assert.strictEqual(classifyGoneOrder({ status: undefined, filled: 0 }).action, 'UNKNOWN');
});

test('price falls back to the logged price when LBank gives none', () => {
    const r = classifyGoneOrder({ status: 'closed', filled: 2 }, 6.95);
    assert.strictEqual(r.price, 6.95);
    assert.strictEqual(r.valueUsdt, 13.9);
});
