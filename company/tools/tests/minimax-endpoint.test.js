#!/usr/bin/env node
/* minimax-endpoint.test.js — offline tests for company/tools/lib/minimax-endpoint.js: the regions, the migration
 * default (nothing stored = Global), custom base URL validation, what is written to company.json, the pacer's usage URL.
 *   node --test company/tools/tests/minimax-endpoint.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.CAPHEOS_MINIMAX_WIRE = 'openai';   // these tests are about the OpenAI wire unless they say otherwise
const M = require('../lib/minimax-endpoint');

test('regions: OpenAI-compatible /v1 bases, key pages per platform, choices in plain words', () => {
  assert.equal(M.resolve({ region: 'global' }).baseUrl, 'https://api.minimax.io/v1');
  assert.equal(M.resolve({ region: 'cn' }).baseUrl, 'https://api.minimaxi.com/v1');
  assert.match(M.resolve({ region: 'global' }).keyUrl, /^https:\/\/platform\.minimax\.io\//);
  assert.match(M.resolve({ region: 'cn' }).keyUrl, /^https:\/\/platform\.minimaxi\.com\//);
  assert.deepEqual(M.choices().map(c => c.label), ['Global', 'Mainland China', 'Custom']);
  assert.ok(M.choices().every(c => c.what && !/https?:\/\//.test(c.what)), 'no raw URL in the option text');
  assert.equal(M.resolve({ region: 'mars' }).ok, false);
});

test('migration: no providers.minimax (or none at all) is Global; a broken entry falls back to Global with a problem', () => {
  for (const cfg of [{}, { providers: {} }, { providers: { minimax: {} } }, null]) {
    const ep = M.fromConfig(cfg); assert.equal(ep.region, 'global'); assert.equal(ep.stored, false); assert.equal(ep.baseUrl, 'https://api.minimax.io/v1');
  }
  const bad = M.fromConfig({ providers: { minimax: { region: 'custom', baseUrl: 'ftp://x.minimax.io' } } });
  assert.equal(bad.region, 'global'); assert.match(bad.problem, /Global is used/);
  const root = require('../lib/temp-life').tmpDir('mme-test-');
  try { assert.equal(M.read(root).region, 'global', 'a missing company.json is Global too'); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('custom base URL: https only, no credentials/query, MiniMax host or an explicit "other" with a warning', () => {
  assert.equal(M.checkCustomUrl('').ok, false);
  assert.equal(M.checkCustomUrl('not a url').ok, false);
  assert.match(M.checkCustomUrl('http://api.minimax.io/v1').error, /https/);
  assert.match(M.checkCustomUrl('https://u:p@api.minimax.io/v1').error, /user name/);
  assert.match(M.checkCustomUrl('https://api.minimax.io/v1?x=1').error, /\?/);
  assert.equal(M.checkCustomUrl('https://evilminimax.io/v1').ok, false, 'a look-alike host is not MiniMax');
  const ok = M.checkCustomUrl('https://api.minimax.io/v1/');
  assert.equal(ok.ok, true); assert.equal(ok.baseUrl, 'https://api.minimax.io/v1'); assert.deepEqual(ok.warnings, []);
  assert.equal(M.checkCustomUrl('https://api.minimax.cn/v1').ok, true);
  assert.match(M.checkCustomUrl('https://api.minimax.cn/v1').warnings.join(' '), /thinking/, 'minimax.cn works but loses the reasoning replay (patch 0007)');
  const other = M.checkCustomUrl('https://llm.example.com/v1');
  assert.equal(other.ok, false); assert.equal(other.code, 'not-minimax');
  const allowed = M.checkCustomUrl('https://llm.example.com/v1', true);
  assert.equal(allowed.ok, true); assert.match(allowed.warnings[0], /not a MiniMax address/);
  assert.match(M.checkCustomUrl('https://api.minimax.io/openai').warnings.join(' '), /\/v1/);
});

test('stored entry: presets store only the region; custom stores its address; usage URL derives unless overridden', () => {
  assert.deepEqual(M.entryOf(M.resolve({ region: 'cn' })), { region: 'cn' });
  const c = M.resolve({ region: 'custom', baseUrl: 'https://llm.example.com/v1', other: true });
  assert.equal(c.usageUrl, 'https://llm.example.com/v1/token_plan/remains');
  assert.deepEqual(M.entryOf(c), { region: 'custom', baseUrl: 'https://llm.example.com/v1', other: true });
  assert.deepEqual(M.fromConfig({ providers: { minimax: M.entryOf(c) } }).baseUrl, c.baseUrl);
  assert.equal(M.usageUrlFor('', M.resolve({ region: 'cn' })).url, M.REGIONS.cn.usageUrl);
  assert.equal(M.usageUrlFor('https://www.minimax.io/v1/token_plan/remains', M.resolve({ region: 'cn' })).url, M.REGIONS.cn.usageUrl, 'the old default is not an override');
  assert.equal(M.usageUrlFor('https://my.example/remains', M.resolve({ region: 'cn' })).url, 'https://my.example/remains');
});

test('wire: with StarNet patch 0015 the presets use MiniMax\'s Anthropic-compatible address; a custom /anthropic address is warned about only without it', () => {
  try {
    process.env.CAPHEOS_MINIMAX_WIRE = 'anthropic';
    assert.equal(M.wire(), 'anthropic');
    assert.equal(M.resolve({ region: 'global' }).baseUrl, 'https://api.minimax.io/anthropic');
    assert.equal(M.resolve({ region: 'cn' }).baseUrl, 'https://api.minimaxi.com/anthropic');
    assert.equal(M.fromConfig({}).baseUrl, 'https://api.minimax.io/anthropic', 'an existing company with nothing stored moves too');
    assert.equal(M.resolve({ region: 'global' }).usageUrl, 'https://www.minimax.io/v1/token_plan/remains', 'the plan usage URL is unchanged');
    const c = M.resolve({ region: 'custom', baseUrl: 'https://api.minimax.io/anthropic' });
    assert.equal(c.ok, true); assert.deepEqual(c.warnings, []); assert.equal(c.usageUrl, 'https://api.minimax.io/v1/token_plan/remains');
    assert.deepEqual(M.entryOf(c), { region: 'custom', baseUrl: 'https://api.minimax.io/anthropic' });
    process.env.CAPHEOS_MINIMAX_WIRE = 'openai';
    assert.match(M.checkCustomUrl('https://api.minimax.io/anthropic').warnings.join(' '), /patch 0015 is not applied/);
    assert.equal(M.resolve({ region: 'global' }).baseUrl, 'https://api.minimax.io/v1');
  } finally { process.env.CAPHEOS_MINIMAX_WIRE = 'openai'; }
});
