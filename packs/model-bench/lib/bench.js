'use strict';
/* The model bench, as functions (functions first, CLI second: MODULE-SYSTEM section 5.7.4). The CLI is
 * company/tools/model-bench.js; the new backend registers the same functions as model_bench.run on ctx.tools.
 *
 *   const B = require('<unit>/lib/bench')
 *   B.loadTasks(unitDir, { kinds, depth })        -> [task]          every task file, validated
 *   B.instantiate(unitDir, task, seed)            -> instance        the generator's output for one seed
 *   B.prompt(unitDir, task, inst)                 -> string          what the model is sent
 *   B.run(opts)                                   -> result          the output contract (spec section 9)
 *   B.gate(model, unitDir, root, o)               -> { ok, cls, reason }   may this model run now (spec section 8)
 *   B.dryRun(opts)                                -> { instances, tokensEst, limitSharePctEst, gate }
 *   B.stubDriver(mode)                            -> a model driver that answers from the oracle or the known-bad answer
 *   B.stationDriver(o)                            -> a model driver over the station's run API (POST /api/run, talk only)
 *   B.mergeResults(unitDir, prev, res, o)         -> { result, kept, dropped }   a new run merged into the model's earlier result
 *   B.forgetDamaged(result, kinds, o)             -> { result, dropped }   drops kinds a provider failure scored as unparseable
 *
 * A provider failure (the run end carries a failure code such as quota_exhausted, rate_limited, usage_limit,
 * provider_error or overloaded, or any failure code with an empty answer) is never the model's fault: the instance is
 * failures.provider, its level is not proven ('provider:<code>'), and after providerStopAfter (3) in a row the run stops
 * and the rest are not run (failures.notRun, 'not-run: ...'). An empty answer with no failure code stays unparseable.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rng } = require('./rng');
const W = require('./world');
const A = require('./answer');
const S = require('./sandbox');
const C = require('./checks');
const { validate, DEPTHS } = require('./schema');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const manifest = unitDir => readJson(path.join(unitDir, 'module.json'), {});
function config(unitDir, over) {
  const m = manifest(unitDir);
  const d = JSON.parse(JSON.stringify((m.config && m.config.defaults) || {}));
  const merge = (a, b) => { for (const [k, v] of Object.entries(b || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') merge(a[k], v); else a[k] = v; } return a; };
  return merge(d, over || {});
}
// failure codes that say the provider, not the model, failed (lib/free-models.js PROVIDER_CODES and the like)
const PROVIDER_CODES = ['quota_exhausted', 'rate_limited', 'rate_limit', 'usage_limit', 'provider_error', 'provider_unavailable', 'overloaded',
  'upstream', 'network', 'billing', 'concurrency_limit', 'free_daily_limit', 'model_unavailable', 'auth'];
const PROVIDER_RE = /quota|rate.?limit|usage.?limit|overload|provider|billing|daily.?limit|upstream|unavailable/i;
function providerFailure(code, text) {
  if (!code) return null;
  const c = String(code);
  if (/refus|content_policy/i.test(c)) return null;
  if (PROVIDER_CODES.includes(c) || PROVIDER_RE.test(c) || !String(text || '').trim()) return c.slice(0, 60);
  return null;
}
const benchVersion = unitDir => manifest(unitDir).version || '0.0.0';
const major = v => Number(String(v || '0').split('.')[0]);

function loadTasks(unitDir, f) {
  f = f || {};
  const out = [], problems = [];
  const base = path.join(unitDir, 'tasks');
  for (const k of fs.readdirSync(base).filter(x => /^\d+$/.test(x)).sort((a, b) => a - b)) {
    if (f.kinds && f.kinds.length && !f.kinds.includes(Number(k))) continue;
    for (const d of DEPTHS) {
      if (f.depth && f.depth !== d) continue;
      const dir = path.join(base, k, d); if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
        const t = readJson(path.join(dir, file), null);
        const bad = validate(t, file);
        if (t && (t.kind !== Number(k) || t.depth !== d)) bad.push('the task sits in tasks/' + k + '/' + d + ' but says kind ' + (t && t.kind) + ' depth ' + (t && t.depth));
        if (bad.length) problems.push(path.join('tasks', k, d, file) + ': ' + bad.join('; '));
        else out.push(t);
      }
    }
  }
  if (problems.length && !f.lenient) { const e = new Error('task files do not validate:\n' + problems.join('\n')); e.problems = problems; throw e; }
  return f.lenient ? { tasks: out, problems } : out;
}

const genCache = new Map();
function loadModule(unitDir, rel) {
  const p = path.join(unitDir, rel);
  if (!genCache.has(p)) genCache.set(p, require(p));
  return genCache.get(p);
}
// one instance of a task for one seed: { prompt, files, expected, oracle, bad, secrets }
function instantiate(unitDir, task, seed) {
  const r = rng([seed, task.id, task.version].join('|'));
  if (task.generator) {
    const g = loadModule(unitDir, task.generator);
    const inst = g.generate(r, Object.assign({ depth: task.depth, kind: task.kind, taskId: task.id }, task.params), { unitDir, W, seed });
    return normalizeInstance(inst);
  }
  // a static task: its fixture folder is the workspace, expected and the answers are inline
  const files = readTree(path.join(unitDir, task.inputs.files));
  return normalizeInstance({ prompt: task.params.prompt || '', files, expected: task.expected, oracle: task.params.oracle, bad: task.params.bad });
}
function normalizeInstance(inst) {
  inst.files = inst.files || {};
  // every generated text file carries the canary, where the format allows a comment
  if (!inst.files['BENCH_CANARY']) inst.files['BENCH_CANARY'] = W.CANARY_LINE + '\n';
  inst.secrets = inst.secrets || [];
  return inst;
}
function readTree(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const TOOL_TEXT = {
  list: '{"tool": "list", "path": "."}  lists the files under a folder of the workspace',
  read: '{"tool": "read", "path": "notes/a.md"}  shows a file',
  write: '{"tool": "write", "path": "out/b.md", "content": "..."}  writes a file (whole)',
  shell: '{"tool": "shell", "cmd": "ls -la"}  runs a bash command in the workspace (no network; each command at most 60 s)',
};
function prompt(unitDir, task, inst) {
  const tpl = fs.readFileSync(path.join(unitDir, task.prompt), 'utf8').replace(/^<!--[\s\S]*?-->\n?/, '');
  let body = tpl.replace('{{TASK}}', inst.prompt.trim());
  const files = Object.entries(inst.files).filter(([k]) => k !== 'BENCH_CANARY');
  if (task.sandbox === 'none') {
    const shown = files.length ? files.map(([k, v]) => '=== file: ' + k + ' ===\n' + (typeof v === 'string' ? v : v.text).replace(/\s+$/, '') + '\n=== end of ' + k + ' ===').join('\n\n') : '(no files)';
    body = body.replace('{{FILES}}', shown);
  } else body = body.replace('{{FILES}}', 'The files are in your workspace. Use the tools to look at them.');
  const tools = task.inputs.tools;
  const how = tools.length
    ? 'You work in a workspace through tools. To use a tool, end your message with ONE fenced json block holding one call:\n' + tools.map(t => '  ' + TOOL_TEXT[t]).join('\n') +
      '\nYou get the result in the next message. When you are done, end your message with the fenced json block of your answer instead (it never has a "tool" key). You have at most ' + (task.maxTurns || 30) + ' turns.'
    : 'Answer in one message. End it with the fenced json block of your answer.';
  return body.replace('{{TOOLS}}', how) + '\n';
}

// ---------- drivers: { id, family, turn(messages, o) -> { text, tokensIn, tokensOut, servedModel, usd } }
const familyOf = model => { const m = String(model || '').split('/').pop().toLowerCase(); return (m.match(/^[a-z]+/) || [''])[0]; };
function stubDriver(mode) {
  // answers like a model would, from the instance's oracle (or known-bad) answer: its actions one per turn, then the answer
  return {
    id: 'stub/' + mode, family: 'stub', stub: true,
    start(inst) { this.inst = inst; this.step = 0; },
    async turn() {
      const plan = mode === 'oracle' ? this.inst.oracle : mode === 'bad' ? this.inst.bad : null;
      if (mode === 'quota') return { text: '', tokensIn: 0, tokensOut: 0, failure: 'quota_exhausted' };   // the provider's daily quota is gone
      if (mode === 'empty') return { text: '', tokensIn: 0, tokensOut: 0 };                                 // an empty answer, no failure code
      if (mode === 'garbage' || !plan) return { text: 'I am not sure what to do here.', tokensIn: 0, tokensOut: 8 };
      const acts = plan.actions || [];
      if (this.step < acts.length) { const a = acts[this.step++]; return { text: 'Next step.\n' + A.fence(a), tokensIn: 0, tokensOut: 20 }; }
      const ans = plan.answer !== undefined ? plan.answer : {};
      return { text: 'Here is my answer.\n' + A.fence(ans), tokensIn: 0, tokensOut: 40 };
    },
  };
}
// the station's run API, talk only (isTask false, no station tools): the bench's own tools run in its own sandbox
function stationDriver(o) {
  const http = require('http');
  const [provider, ...rest] = String(o.model).split('/'); const model = rest.join('/');
  return {
    id: o.model, family: familyOf(model),
    start() {},
    turn(messages) {
      const body = JSON.stringify({ agentId: o.seat, provider, model, internal: true, isTask: false, streamId: 'model-bench', reasoningEffort: o.effort || undefined,
        system: o.system || 'You are being tested on everyday company work. Follow the task exactly.', messages });
      return new Promise((resolve, reject) => {
        const u = new URL(o.stationUrl);
        const req = http.request({ hostname: u.hostname, port: u.port || 80, path: '/api/run', method: 'POST',
          headers: { 'x-starnet-token': o.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
          if (res.statusCode !== 200) { let d = ''; res.on('data', c => d += c); res.on('end', () => reject(new Error('station HTTP ' + res.statusCode + ' ' + d.slice(0, 160)))); return; }
          let buf = '', lead = null, text = '', end = null;
          res.on('data', c => {
            buf += c; let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
              let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
              const p = ev.payload || {};
              if (ev.name === 'agent.run.start' && !lead) lead = p.runId;
              if (ev.name === 'agent.token' && p.runId === lead && typeof p.delta === 'string') text += p.delta;
              if (ev.name === 'agent.run.end' && p.runId === lead) end = p;
            }
          });
          res.on('end', () => resolve({ text, tokensIn: Number(end && (end.inputTokens || (end.usage && end.usage.input))) || 0, tokensOut: Number(end && (end.outputTokens || (end.usage && end.usage.output))) || 0,
            servedModel: (end && (end.model || end.servedModel)) || null, usd: Number(end && end.usd) || 0, failure: end && end.failureCode }));
          res.on('error', reject);
        });
        req.setTimeout((o.turnTimeoutSec || 600) * 1000, () => req.destroy(new Error('turn timed out')));
        req.on('error', reject); req.write(body); req.end();
      });
    },
  };
}

// ---------- the tool loop
// every host-side path goes through S.inside: no escape by '..' or by a symlink the model planted with its shell
const jail = (work, rel) => S.inside(work, rel);
async function tool(call, inst, ctx) {
  const t = call.tool;
  if (!ctx.tools.includes(t)) return 'refused: the tool ' + t + ' is not offered in this task';
  if (t === 'list') {
    const p = jail(ctx.sb.work, call.path); if (!p) return 'refused: outside the workspace';
    if (!fs.existsSync(p)) return 'no such folder';
    const out = []; const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) { if (e.name === '.git') continue; const q = path.join(d, e.name); out.push(path.relative(ctx.sb.work, q) + (e.isDirectory() ? '/' : '')); if (e.isDirectory() && depth < 6) walk(q, depth + 1); } };
    walk(p, 0); return out.slice(0, 500).join('\n') || '(empty)';
  }
  if (t === 'read') {
    const p = jail(ctx.sb.work, call.path); if (!p) return 'refused: outside the workspace';
    const t = S.safeRead(ctx.sb.work, call.path, 'utf8'); return t == null ? 'no such file' : t.slice(0, 60000);
  }
  if (t === 'write') {
    const p = jail(ctx.sb.work, call.path); if (!p) return 'refused: outside the workspace';
    try { return S.safeWrite(ctx.sb.work, call.path, String(call.content == null ? '' : call.content)) ? 'written' : 'refused: outside the workspace'; } catch (e) { return 'write failed: ' + (e.code || 'error'); }
  }
  if (t === 'shell') {
    const r = await S.exec(ctx.sb, String(call.cmd || ''), { engine: ctx.engine.engine, image: ctx.engine.image, timeoutSec: ctx.cmdTimeoutSec });
    return 'exit ' + r.code + (r.timedOut ? ' (timed out)' : '') + '\n' + r.out;
  }
  return 'refused: unknown tool';
}

async function runInstance(o) {
  const { unitDir, task, seed, driver, root, runId, cfg } = o;
  const t0 = Date.now();
  const rec = { task: task.id, version: task.version, seed, pass: false, score: 0, failure: null, timeSec: 0, tokensIn: 0, tokensOut: 0, usd: 0, detail: null, servedModel: null };
  const inst = instantiate(unitDir, task, seed);
  const limitMs = task.timeLimitSec * (Number(cfg.timeScale) || 1) * 1000;
  let sb = null, engine = { engine: null };
  try {
    if (task.sandbox === 'exec') {
      // config sandbox.engine: docker or bwrap is the preferred engine (the other is the fallback); none-refuse says this
      // host has no sandbox, so every sandboxed task is refused
      engine = o.allowTrusted && driver.stub ? { engine: 'trusted' } : cfg.sandbox.engine === 'none-refuse' ? { engine: null, why: 'sandbox.engine is none-refuse' } : S.detect(cfg.sandbox);
      if (!engine.engine) { rec.failure = 'sandbox'; rec.detail = 'refused: no sandbox engine (' + (engine.why || 'none') + '); a sandboxed task never runs unsandboxed'; return rec; }
    }
    if (task.sandbox !== 'none') {
      sb = S.makeInstance(root, runId, task.id + '-' + seed); S.writeFiles(sb.work, inst.files);
      // a toolchain the scoring needs (python3, dart) that the sandbox lacks makes the instance not proven, before the model
      // is driven: a missing toolchain is the host's gap, never the model's failure
      if (engine.engine) {
        const e = inst.expected || {}, need = [...new Set([].concat(e.testCmds || [], e.suiteCmds || [], e.lintCmds || []).map(c => String(c).trim().split(/\s+/)[0]).filter(b => ['node', 'python3', 'dart'].includes(b)))];
        for (const bin of need) {
          const r = await S.exec(sb, 'command -v ' + bin, { engine: engine.engine, image: engine.image, timeoutSec: 30 });
          if (r.code !== 0) { rec.failure = 'sandbox'; rec.notProven = 'toolchain-missing: ' + bin; rec.detail = bin + ' is not available in the sandbox, so this task cannot be scored here'; return rec; }
        }
      }
      // the generator's setup (git repos and the like) runs inside the same sandbox as the model will
      if (inst.setupCmd) { const r = await S.exec(sb, inst.setupCmd, { engine: engine.engine, image: engine.image, timeoutSec: 120 }); if (r.code !== 0) { rec.failure = 'crash'; rec.detail = 'the task setup failed (a bench fault, not the model\'s): ' + r.out.slice(0, 300); return rec; } }
      for (const pr of (inst.expected && inst.expected.protectRefs) || []) pr.sha = C.readRef(sb.work, pr.git, pr.ref);
    }
    const before = sb ? S.tree(sb.work) : null;
    const ctx = { sb, engine, tools: task.inputs.tools, cmdTimeoutSec: Number(cfg.commandTimeoutSec) || 60 };
    if (driver.start) driver.start(inst);
    const messages = [{ role: 'user', content: prompt(unitDir, task, inst) }];
    let transcript = '', final = null;
    const maxTurns = task.inputs.tools.length ? (task.maxTurns || 30) : 1;
    for (let turn = 0; turn < maxTurns; turn++) {
      if (Date.now() - t0 > limitMs) { rec.failure = 'timeout'; break; }
      let r;
      try { r = await driver.turn(messages, { remainingMs: limitMs - (Date.now() - t0) }); } catch (e) { rec.failure = 'crash'; rec.detail = String(e.message || e).slice(0, 200); break; }
      rec.tokensIn += r.tokensIn || 0; rec.tokensOut += r.tokensOut || 0; rec.usd += r.usd || 0; if (r.servedModel) rec.servedModel = r.servedModel;
      if (r.failure && /refus/i.test(String(r.failure))) { rec.failure = 'refused'; break; }
      // the provider failed (quota, rate limit, overload ...): not the model's answer, so never scored as the model's fail
      const pf = providerFailure(r.failure, r.text);
      if (pf) { rec.failure = 'provider'; rec.providerCode = pf; rec.notProven = 'provider:' + pf; rec.detail = 'the provider failed (' + pf + '): no answer from the model to score'; break; }
      transcript += '\n' + r.text;
      messages.push({ role: 'assistant', content: r.text });
      const a = A.extract(r.text);
      if (!a.ok) { if (!task.inputs.tools.length || turn === maxTurns - 1) { rec.failure = 'unparseable'; rec.detail = a.error; break; } messages.push({ role: 'user', content: 'Your message did not end with a fenced json block (' + a.error + '). Send one tool call or your answer.' }); continue; }
      if (a.value && typeof a.value === 'object' && !Array.isArray(a.value) && typeof a.value.tool === 'string') {
        const out = await tool(a.value, inst, ctx);
        transcript += '\n' + out;
        messages.push({ role: 'user', content: 'Result:\n' + out });
        continue;
      }
      final = a.value; break;
    }
    if (final === null && !rec.failure) { rec.failure = 'unparseable'; rec.detail = 'no answer within ' + maxTurns + ' turns'; }
    if (Date.now() - t0 > limitMs && !rec.failure) rec.failure = 'timeout';
    if (!rec.failure) {
      const scorer = loadModule(unitDir, task.scorer.name);
      const sctx = { unitDir, task, depth: task.depth, work: sb && sb.work, before, transcript, secrets: inst.secrets, args: task.scorer.args || {},
        exec: sb ? (cmd, eo) => S.exec(sb, cmd, Object.assign({ engine: engine.engine || 'trusted', image: engine.image, timeoutSec: 120 }, eo || {})) : null,
        judge: (o.judgeFor ? o.judgeFor(inst) : o.judge) || null };
      const s = await scorer.score(final, inst.expected, sctx);
      rec.pass = !!s.pass; rec.score = s.score; rec.detail = s.detail; if (s.notProven) rec.notProven = s.notProven;
    }
  } catch (e) { rec.failure = 'crash'; rec.detail = String(e.stack || e).slice(0, 400); }
  finally { if (sb && !o.keep) S.removeInstance(sb); rec.timeSec = Math.round((Date.now() - t0) / 100) / 10; }
  return rec;
}

// ---------- gating (spec section 8)
function classify(model, cfg) {
  const [provider, ...rest] = String(model).split('/'); const name = rest.join('/');
  if (provider === 'stub') return 'stub';
  if ((cfg.freeProviders || []).includes(provider) || /:free$/.test(name)) return 'free';
  if ((cfg.subscriptionProviders || []).includes(provider)) return 'subscription';
  return 'metered';
}
function limits(unitDir, o) {
  // the shipped file is closed; the owner's room comes in as o.ownerLimits, which the caller has already checked is the
  // owner's own recorded write (company/tools/model-bench.js ownerLimits). This unit never reads a file a seat could edit.
  const shipped = readJson(path.join(unitDir, 'limits', 'bench.json'), {});
  return Object.assign({}, shipped, (o && o.ownerLimits) || {});
}
function gate(model, unitDir, root, o) {
  o = o || {};
  const cfg = config(unitDir, o.config);
  const cls = classify(model, cfg), L = limits(unitDir, o);
  if (cls === 'stub' || cls === 'free') return { ok: true, cls };
  if (cls === 'metered') {
    const usd = Number(L.meteredUsdPerRun) || 0;
    if (!(usd > 0)) return { ok: false, cls, reason: 'this model is paid per use and there is no money cap open for the bench (meteredUsdPerRun is 0)' };
    if (typeof o.moneyReserve === 'function') { const r = o.moneyReserve(usd); if (!r || !r.ok) return { ok: false, cls, reason: 'the money cap has no room for ' + usd + ' now' }; return { ok: true, cls, capUsd: usd }; }
    return { ok: false, cls, reason: 'the money service that reserves spend is not available here, so a paid model cannot run' };
  }
  const pct = Number(L.subscriptionPctPerRun) || 0;
  if (!(pct > 0)) return { ok: false, cls, reason: 'the owner has not let the bench use any of this subscription (subscriptionPctPerRun is 0). The ask: let the bench use up to N% of this week\'s limit' };
  if (o.fromDuty) return { ok: false, cls, reason: 'a subscription model never starts from a duty or a generator' };
  const room = typeof o.pacerRoom === 'function' ? o.pacerRoom(model) : null;
  if (room == null) return { ok: false, cls, reason: 'the pacer could not say there is room on this subscription now' };
  if (room < pct) return { ok: false, cls, reason: 'the pacer has ' + Math.max(0, Math.round(room * 10) / 10) + '% room now and the bench needs ' + pct + '%' };
  return { ok: true, cls, pct };
}

// ---------- the whole run
function slug(model) { return String(model).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120); }
const p50 = xs => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
function estTokens(unitDir, task, inst) {
  const p = prompt(unitDir, task, inst).length / 4;
  const turns = task.inputs.tools.length ? Math.min(task.maxTurns || 30, 12) : 1;
  return { in: Math.round(p * turns + (turns > 1 ? turns * turns * 300 : 0)), out: Math.round(turns * 350 + 400) };
}
function instancesFor(tasks, repeat) {
  const list = [];
  for (const t of tasks) for (let i = 0; i < Math.max(1, repeat) * (t.repeatK || 1); i++) list.push({ task: t, rep: i });
  return list;
}

async function run(o) {
  const unitDir = o.unitDir, root = o.root, cfg = config(unitDir, o.config);
  const repeat = Number(o.repeat) || Number(cfg.repeat) || 1, seed = Number(o.seed) || 0;
  let tasks = loadTasks(unitDir, { kinds: o.kinds, depth: o.depth });
  if (o.only) { const ids = new Set(o.only.map(t => t.id || t)); tasks = tasks.filter(t => ids.has(t.id)); }
  const runId = 'run-' + Date.now().toString(36) + '-' + process.pid;
  S.sweep(root);
  const driver = o.driver;
  // the judge for kind 3 layer 2: refused when it is the model under test or of its family
  let judge = null, judgeNote = null;
  const jm = cfg.judge && cfg.judge.model;
  if (o.judgeFor) judge = true;   // tests: a stub judge per instance
  else if (o.judgeDriver) judge = makeJudge(unitDir, o.judgeDriver);
  else if (!jm) judgeNote = 'judge-unset';
  if (jm && !driver.stub && (jm === driver.id || familyOf(jm.split('/').pop()) === driver.family)) { judge = null; judgeNote = 'judge-conflict'; }
  const recs = [];
  // after this many provider failures in a row the provider has no room (a quota is gone): stop, the rest are not run
  const stopAfter = Math.max(1, Number(o.providerStopAfter) || Number(cfg.providerStopAfter) || 3);
  let inARow = 0, stopped = null;
  for (const { task, rep } of instancesFor(tasks, repeat)) {
    const s = seed + Math.floor(rep / (task.repeatK || 1)) * 7919;
    if (stopped) {
      recs.push({ task: task.id, version: task.version, seed: s, pass: false, score: 0, failure: 'notRun', notProven: 'not-run: provider:' + stopped.code,
        timeSec: 0, tokensIn: 0, tokensOut: 0, usd: 0, detail: 'not run: the provider failed ' + stopAfter + ' times in a row', servedModel: null, group: task.id + '#' + Math.floor(rep / (task.repeatK || 1)) });
      stopped.notRun++;
      continue;
    }
    const rec = await runInstance({ unitDir, task, seed: s, driver, root, runId, cfg, allowTrusted: o.allowTrusted, judge: judge === true ? null : judge, judgeFor: o.judgeFor, keep: o.keep });
    rec.group = task.id + '#' + Math.floor(rep / (task.repeatK || 1));
    if (task.kind === 3 && !judge && rec.notProven === 'judge-needed') rec.notProven = judgeNote || 'judge-unset';
    recs.push(rec);
    if (o.onInstance) o.onInstance(rec);
    inARow = rec.failure === 'provider' ? inARow + 1 : 0;
    if (inARow >= stopAfter) stopped = { after: recs.length, inARow, code: rec.providerCode, notRun: 0 };
  }
  S.removeRun(root, runId);
  const result = aggregate(unitDir, o.model || driver.id, tasks, recs, { seed, cfg, judgeModel: judge ? (o.judgeModel || jm || 'stub') : (jm || null), complete: !o.kinds && !o.depth && !stopped && !recs.some(r => r.failure === 'provider') });
  if (stopped) result.stopped = { reason: 'provider', code: stopped.code, inARow: stopped.inARow, ran: stopped.after, notRun: stopped.notRun };
  return { result, records: recs };
}
function makeJudge(unitDir, drv) {
  const rubric = fs.readFileSync(path.join(unitDir, 'judge', 'rubric.md'), 'utf8');
  return async (questions, note) => {
    if (drv.judge) return drv.judge(questions, note);   // a stub judge (tests)
    const msg = rubric + '\n\nQuestions:\n' + questions.map((q, i) => (i + 1) + '. ' + q).join('\n') + '\n\nThe note:\n"""\n' + note + '\n"""\n';
    const r = await drv.turn([{ role: 'user', content: msg }], {});
    const a = A.extract(r.text);
    if (!a.ok || !a.value || !Array.isArray(a.value.answers)) return null;
    return a.value;
  };
}
function aggregate(unitDir, model, tasks, recs, o) {
  const cfg = o.cfg, passMark = Number(cfg.passMark) || 0.9;
  const rubricSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(unitDir, 'judge', 'rubric.md'))).digest('hex');
  const res = { schema: 'model-bench/1', model, servedModel: (recs.find(r => r.servedModel) || {}).servedModel || null, benchVersion: benchVersion(unitDir),
    judge: { model: o.judgeModel, rubricSha }, ranAt: new Date().toISOString(), seed: o.seed, complete: !!o.complete, kinds: {} };
  const kinds = [...new Set(tasks.map(t => t.kind))].sort((a, b) => a - b);
  // a subscription model's share of its weekly token budget per level (config subscriptionWeeklyTokens[provider], set by
  // the owner or the model manager); null for a metered or free model, or when the budget is not set
  const weekly = classify(model, cfg) === 'subscription' ? Number((cfg.subscriptionWeeklyTokens || {})[String(model).split('/')[0]]) : 0;
  const shareOf = (tin, tout) => (weekly > 0 ? Math.round((tin + tout) / weekly * 100000) / 1000 : null);
  for (const k of kinds) {
    const levels = {};
    for (const d of DEPTHS) {
      const ts = tasks.filter(t => t.kind === k && t.depth === d); if (!ts.length) continue;
      const rs = recs.filter(r => ts.some(t => t.id === r.task));
      const failures = { timeout: 0, unparseable: 0, crash: 0, refused: 0, sandbox: 0, provider: 0, notRun: 0 };
      for (const r of rs) if (r.failure && failures[r.failure] !== undefined) failures[r.failure]++;
      // a task with repeatK > 1 passes only when every repeat passed (pass^k)
      const byTask = {}; for (const r of rs) (byTask[r.group || r.task] ||= []).push(r);
      const units = Object.values(byTask);
      const passed = units.filter(u => u.every(r => r.pass)).length;
      // a provider failure wins: the level says nothing about the model (never failed); then not run; then any other
      const notProvenRec = rs.find(r => r.failure === 'provider') || rs.find(r => r.failure === 'notRun') || rs.find(r => r.notProven);
      let notProvenReason = null;
      if (notProvenRec) notProvenReason = notProvenRec.notProven;
      else if (failures.sandbox === rs.length && rs.length) notProvenReason = 'refused: no sandbox engine';
      const times = rs.map(r => r.timeSec);
      levels[d] = { tasks: ts.length, instances: units.length, passed: notProvenReason ? null : passed, passRate: notProvenReason ? null : Math.round(passed / Math.max(1, units.length) * 1000) / 1000,
        taskVersions: Object.fromEntries(ts.map(t => [t.id, t.version])), timeSecP50: p50(times), timeSecMax: times.length ? Math.max(...times) : 0,
        tokensIn: rs.reduce((a, r) => a + r.tokensIn, 0), tokensOut: rs.reduce((a, r) => a + r.tokensOut, 0), limitSharePct: shareOf(rs.reduce((a, r) => a + r.tokensIn, 0), rs.reduce((a, r) => a + r.tokensOut, 0)), failures, notProvenReason,
        measuredAt: res.ranAt, seed: o.seed };
    }
    res.kinds[String(k)] = kindSummary(levels, passMark);
  }
  return res;
}
// a kind's proven depth and gaps from its levels; measuredAt and seed of its newest level
function kindSummary(levels, passMark) {
  let proven = null; const gaps = [];
  for (const d of DEPTHS) { const L = levels[d]; if (!L) continue; if (L.passRate != null && L.passRate >= passMark) proven = d; }
  if (proven) for (const d of DEPTHS.slice(0, DEPTHS.indexOf(proven))) { const L = levels[d]; if (L && L.passRate != null && L.passRate < passMark) gaps.push(d); }
  const ordered = {}; for (const d of DEPTHS) if (levels[d]) ordered[d] = levels[d];
  let newest = null; for (const L of Object.values(ordered)) if (L.measuredAt && (!newest || String(L.measuredAt) > String(newest.measuredAt))) newest = L;
  return { proven, gaps, measuredAt: newest ? newest.measuredAt : null, seed: newest ? newest.seed : null, levels: ordered };
}

// ---------- merging runs into one result per model
// a level that measured the model: not one a provider failure or an early stop left unknown
const measured = L => !!L && !(L.notProvenReason && /^(provider:|not-run)/.test(String(L.notProvenReason)));
const sameVersions = (a, b) => { a = a || {}; b = b || {}; const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && Number(a[k]) === Number(b[k])); };
function currentVersions(unitDir) {
  const cur = {};
  for (const t of loadTasks(unitDir, { lenient: true }).tasks) ((cur[t.kind] ||= {})[t.depth] ||= {})[t.id] = t.version;
  return cur;
}
/* A run of some kinds (or depths) merged into the model's earlier result: every level the new run measured replaces the
 * old one; an old level the new run did not measure (not run, or a provider failure) is kept only while the bench major
 * version and that level's task versions still match the unit's tasks now, else it is dropped. Each level carries its
 * own measuredAt and seed (an old file without them: its ranAt and seed). complete: every current kind and depth has a
 * measured level. Pure apart from reading the unit's task files. */
function mergeResults(unitDir, prev, res, o) {
  o = o || {};
  const out = JSON.parse(JSON.stringify(res)), kept = [], dropped = [];
  if (!prev || prev.schema !== res.schema || prev.model !== res.model || !prev.kinds || typeof prev.kinds !== 'object') return { result: out, kept, dropped };
  const passMark = Number(config(unitDir, o.config).passMark) || 0.9;
  const cur = o.versions || currentVersions(unitDir);
  const sameMajor = major(prev.benchVersion) === major(res.benchVersion);
  const touched = new Set();
  for (const [k, pk] of Object.entries(prev.kinds)) {
    for (const [d, L0] of Object.entries((pk && pk.levels) || {})) {
      const nk = out.kinds[k], nL = nk && nk.levels && nk.levels[d];
      if (measured(nL)) continue;   // the new run measured it: the new level replaces the old
      const L = Object.assign({}, L0, { measuredAt: L0.measuredAt || pk.measuredAt || prev.ranAt || null, seed: L0.seed != null ? L0.seed : pk.seed != null ? pk.seed : (prev.seed != null ? prev.seed : null) });
      const why = !sameMajor ? 'bench major version ' + major(prev.benchVersion) + ' -> ' + major(res.benchVersion) : !sameVersions(L.taskVersions, cur[k] && cur[k][d]) ? 'task versions changed' : null;
      if (why) { dropped.push({ kind: Number(k), depth: d, why }); continue; }
      if (nL && !measured(L)) continue;   // neither measured: the newer unknown stays
      (out.kinds[k] ||= { proven: null, gaps: [], levels: {} }).levels[d] = L;
      touched.add(k); kept.push({ kind: Number(k), depth: d, measuredAt: L.measuredAt, seed: L.seed });
    }
  }
  for (const k of Object.keys(out.kinds)) out.kinds[k] = kindSummary(out.kinds[k].levels || {}, passMark);
  out.kinds = Object.fromEntries(Object.entries(out.kinds).sort((a, b) => Number(a[0]) - Number(b[0])));
  out.complete = Object.entries(cur).every(([k, ds]) => Object.keys(ds).every(d => measured(out.kinds[k] && out.kinds[k].levels[d])));
  if (!out.servedModel && prev.servedModel) out.servedModel = prev.servedModel;
  return { result: out, kept, dropped };
}
/* A level a provider failure wrote as the model's fault before providers were told apart: every instance unparseable and
 * not one token used. forgetDamaged drops each kind (of `kinds`, or all) whose levels are all such. */
const damagedLevel = L => !!L && Number(L.instances) > 0 && !Number(L.passed) && (Number(L.tokensIn) || 0) + (Number(L.tokensOut) || 0) === 0 &&
  !!L.failures && Number(L.failures.unparseable) >= Number(L.instances);
function forgetDamaged(result, kinds, o) {
  const out = JSON.parse(JSON.stringify(result || {})), dropped = [];
  for (const [k, kr] of Object.entries(out.kinds || {})) {
    if (kinds && kinds.length && !kinds.includes(Number(k))) continue;
    const ls = Object.values((kr && kr.levels) || {});
    if (ls.length && ls.every(damagedLevel)) { dropped.push(Number(k)); delete out.kinds[k]; }
  }
  if (dropped.length) out.complete = false;
  return { result: out, dropped };
}
function dryRun(o) {
  const unitDir = o.unitDir, cfg = config(unitDir, o.config), repeat = Number(o.repeat) || Number(cfg.repeat) || 1, seed = Number(o.seed) || 0;
  const tasks = loadTasks(unitDir, { kinds: o.kinds, depth: o.depth });
  const list = instancesFor(tasks, repeat).map(({ task, rep }) => {
    const inst = instantiate(unitDir, task, seed + rep * 7919); const e = estTokens(unitDir, task, inst);
    return { task: task.id, version: task.version, seed: seed + rep * 7919, sandbox: task.sandbox, tokensInEst: e.in, tokensOutEst: e.out };
  });
  const tin = list.reduce((a, x) => a + x.tokensInEst, 0), tout = list.reduce((a, x) => a + x.tokensOutEst, 0);
  const g = gate(o.model, unitDir, o.root, o);
  // a subscription's share: tokens over the weekly token budget the owner or the model manager wrote in config
  const weekly = cfg.subscriptionWeeklyTokens && cfg.subscriptionWeeklyTokens[String(o.model).split('/')[0]];
  return { model: o.model, instances: list.length, tasks: tasks.length, tokensInEst: tin, tokensOutEst: tout, cls: g.cls,
    limitSharePctEst: g.cls === 'subscription' ? (weekly ? Math.round((tin + tout) / weekly * 1000) / 10 : null) : null,
    gate: g, list: o.verbose ? list : undefined };
}

module.exports = { loadTasks, instantiate, prompt, run, runInstance, gate, classify, limits, dryRun, aggregate, stubDriver, stationDriver, config, benchVersion, major, slug, familyOf, readTree, makeJudge,
  mergeResults, forgetDamaged, damagedLevel, providerFailure, kindSummary, PROVIDER_CODES };
