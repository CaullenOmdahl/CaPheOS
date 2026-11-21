'use strict';
// the free daily cap and the provider-error cooling read real run-log rows (startedAt/endedAt, quota_exhausted, no text)
const test = require('node:test'), assert = require('node:assert');
const FM = require('../lib/free-models.js');
const day = Date.UTC(2030, 0, 10), now = day + 13 * 3600e3;
const row = o => Object.assign({ provider: 'openrouter', model: 'vendor/m:free', reason: 'error', error: '', startedAt: now - 20 * 60e3, endedAt: now - 19 * 60e3 }, o);
test('a quota_exhausted free run with no error text closes free models until the next UTC midnight', () => {
  assert.strictEqual(FM.dailyLimitUntil([row({ failureCode: 'quota_exhausted' })], now), Date.UTC(2030, 0, 11));
});
test('yesterday\'s quota run does not close today', () => {
  assert.strictEqual(FM.dailyLimitUntil([row({ failureCode: 'quota_exhausted', startedAt: day - 3600e3, endedAt: day - 3500e3 })], now), 0);
});
test('a successful free run does not close it', () => {
  assert.strictEqual(FM.dailyLimitUntil([row({ reason: 'done', failureCode: '' })], now), 0);
});
test('cooling reads endedAt when a row has no at', () => {
  assert.ok(FM.coolingRun([row({ failureCode: 'rate_limited' })], 'vendor/m:free', now, 60));
  assert.strictEqual(FM.coolingRun([row({ failureCode: 'rate_limited' })], 'vendor/m:free', now + 2 * 3600e3, 60), null);
});
