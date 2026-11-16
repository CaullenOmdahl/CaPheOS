#!/usr/bin/env node
/* agy-contract.js — run a scoped job through the Antigravity (AGY) CLI and return schema-validated JSON.
 *
 * Why: AGY is a subscription-backed agent CLI (Gemini 4 Argon/Hydrogen, Claude Opus 5.5, GPT-OSS ...).
 * It cannot be a StarNet "brain" (it runs its own tools, which would bypass StarNet's permission gates),
 * but it is an excellent CONTRACTOR: a StarNet agent with a workbench shells this wrapper to get an
 * independent, cross-family judgment back as strict JSON.
 *
 * usage:
 *   node agy-contract.js --prompt "..." --schema schema.json [--model gemini-4-argon-high] [--effort high] [--out x.json]
 *   node agy-contract.js --prompt-file prompt.txt --schema schema.json
 * exit: 0 ok (prints validated JSON), 1 usage/runtime failure (prints JSON {ok:false,error}), 2 invalid JSON
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--prompt') a.prompt = argv[++i];
    else if (k === '--prompt-file') a.promptFile = argv[++i];
    else if (k === '--schema') a.schema = argv[++i];
    else if (k === '--model') a.model = argv[++i];
    else if (k === '--effort') a.effort = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--timeout') a.timeout = Number(argv[++i]) || 0;
    else throw new Error('unknown argument: ' + k);
  }
  return a;
}

function fail(msg, code) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code || 1);
}

const a = (() => { try { return parseArgs(process.argv.slice(2)); } catch (e) { fail(e.message, 1); } })();
if (!a.prompt && !a.promptFile) fail('--prompt or --prompt-file is required');
if (!a.schema) fail('--schema is required');
let schemaText, schema;
try {
  schemaText = fs.readFileSync(path.resolve(a.schema), 'utf8');
  schema = JSON.parse(schemaText);
} catch (e) { fail('unreadable schema: ' + e.message, 1); }
const prompt = a.prompt || fs.readFileSync(path.resolve(a.promptFile), 'utf8');

const args = ['-p', prompt, '--json-schema', fs.readFileSync(path.resolve(a.schema), 'utf8'), '--output-format', 'json'];
if (a.model) args.push('--model', a.model);
if (a.effort) args.push('--effort', a.effort);
if (a.timeout) args.push('--print-timeout', String(a.timeout) + 's');   // agy takes a Go duration

const t0 = Date.now();
const r = spawnSync('agy', args, { encoding: 'utf8', timeout: (a.timeout || 600) * 1000, maxBuffer: 32 * 1024 * 1024 });
const elapsedMs = Date.now() - t0;
if (r.error) fail('agy spawn failed: ' + r.error.message);
if (r.status !== 0) fail('agy exited ' + r.status + ': ' + String(r.stderr || '').slice(0, 400));

let envelope;
try { envelope = JSON.parse(r.stdout); } catch (e) { fail('agy printed non-JSON: ' + String(r.stdout).slice(0, 300), 2); }
if (envelope.status && envelope.status !== 'SUCCESS') fail('agy status ' + envelope.status + ': ' + String(envelope.response || '').slice(0, 300));

let data;
try { data = typeof envelope.response === 'string' ? JSON.parse(envelope.response) : envelope.response; }
catch (e) { fail('model response was not JSON: ' + String(envelope.response).slice(0, 300), 2); }

// shallow schema check: required top-level keys + declared types for primitives
const problems = [];
for (const key of (schema.required || [])) {
  if (!(key in data)) problems.push('missing required key: ' + key);
}
for (const [key, def] of Object.entries(schema.properties || {})) {
  if (!(key in data) || !def || !def.type) continue;
  const v = data[key];
  const ok = def.type === 'array' ? Array.isArray(v)
    : def.type === 'string' ? typeof v === 'string'
    : def.type === 'number' ? typeof v === 'number'
    : def.type === 'integer' ? Number.isInteger(v)
    : def.type === 'boolean' ? typeof v === 'boolean'
    : def.type === 'object' ? (v && typeof v === 'object' && !Array.isArray(v))
    : true;
  if (!ok) problems.push(key + ' should be ' + def.type);
}

const out = {
  ok: problems.length === 0,
  data,
  schemaProblems: problems,
  meta: {
    model: a.model || 'agy-default',
    durationSeconds: typeof envelope.duration_seconds === 'number' ? envelope.duration_seconds : null,
    wallMs: elapsedMs,
    usage: envelope.usage || null,
    conversationId: envelope.conversation_id || null,
  },
};
if (a.out) fs.writeFileSync(path.resolve(a.out), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
process.exit(problems.length === 0 ? 0 : 2);
