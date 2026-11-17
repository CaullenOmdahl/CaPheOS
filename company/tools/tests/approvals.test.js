#!/usr/bin/env node
/* approvals.test.js — company/tools/approvals.js against scratch company roots (CAPHEOS_ROOT in a child process, so
 * nothing touches the checkout): the owner's traps for approvals in chat (docs/CHAT-ACTIONS.md "Approvals in chat")
 * and the round-3 integration checks. The chat UI half (badge, rendering, clicks) is tests/chat-actions-walk.js.
 *
 *   node --test company/tools/tests/approvals.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const AP = path.join(REPO, 'company', 'tools', 'approvals.js');
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return ''; } };
const jsonl = (root, rel) => read(root, rel).split('\n').filter(Boolean).map(l => JSON.parse(l));

// a scratch company: the Founder (CEO) and Sam (a specialist), the framework's governance and decision models
function company(o) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-selftest-')); roots.push(T);
  w(T, 'company/company.json', { name: 'Example', owner: { name: 'Olive Owner', title: 'Owner' }, timezone: 'UTC' });
  w(T, 'company/tools/loops.json', { agents: { agent: { name: 'Founder', manager: null, functions: ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'] }, sam: { name: 'Sam', manager: 'agent', functions: [] } } });
  for (const f of ['company/defaults/state/governance.json', 'company/defaults/state/guardrails.json', 'company/defaults/state/approvals-policy.json', 'company/competence-policy.json'])
    fs.mkdirSync(path.dirname(path.join(T, f)), { recursive: true }), fs.copyFileSync(path.join(REPO, f), path.join(T, f));
  fs.cpSync(path.join(REPO, 'company', 'decision-models'), path.join(T, 'company', 'decision-models'), { recursive: true });
  w(T, 'company/work/decisions.md', '# Decisions\n\nNewest first. Who decided, what, why.\n\n- 2026-11-01 09:00 Founder [d-aaaaaa] An earlier decision that must stay exactly as written.\n');
  if (o && o.governance) w(T, 'company/state/governance.json', Object.assign(JSON.parse(read(T, 'company/defaults/state/governance.json')), o.governance));
  if (o && o.policy) w(T, 'company/state/approvals-policy.json', o.policy);
  return T;
}
// run a snippet in the scratch root; `A` is approvals.js, `I` inbox.js; the snippet's value is printed as JSON
function run(T, code, env) {
  const src = 'const A = require(' + JSON.stringify(AP) + '); const I = require(' + JSON.stringify(path.join(REPO, 'company', 'tools', 'inbox.js')) + ');\n' +
    'Promise.resolve((() => {' + code + '})()).then(v => console.log(JSON.stringify(v === undefined ? null : v)), e => { console.log(JSON.stringify({ threw: e.message })); });';
  const r = spawnSync(process.execPath, ['-e', src], { cwd: T, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', PROVENANCE_ROOT: T, STARNET_URL: 'http://127.0.0.1:1' }, env || {}) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  const v = JSON.parse(r.stdout.trim().split('\n').pop()); if (v && v.threw) throw new Error(v.threw); return v;
}
const askSpend = (extra) => 'return A.ask(Object.assign({ from: "Sam", category: "spend", message: "May we buy one month of the example data plan for $20? It unblocks the price study.", params: { amountUsd: 20, vendor: "data.example.com" } }, ' + JSON.stringify(extra || {}) + '));';
const decisionsHas = (T, re) => read(T, 'company/work/decisions.md').split('\n').filter(l => re.test(l));

/* ---------- trap 1: one Needs-you queue ---------- */
test('trap 1: an approval is one open question on Needs you (the console badge counts it once); notify/auto add nothing', () => {
  const T = company({ governance: { categories: Object.assign({}, JSON.parse(read(path.join(REPO), 'company/defaults/state/governance.json')).categories, { models: 'notify', tools: 'auto' }) } });
  const r = run(T, askSpend() + '');
  run(T, 'A.ask({ from: "Sam", category: "models", message: "Switch the research seat to the smaller model.", params: { seat: "sam" } }); A.ask({ from: "Sam", category: "tools", message: "Rename a helper.", params: { f: "x" } });');
  const q = run(T, 'return { open: I.openQuestions().map(q => q.id), approvals: A.list().map(r => r.id) };');
  assert.deepEqual(q.open, [r.id], 'the badge source (/api/questions = inbox.openQuestions) lists the approval exactly once');
  assert.deepEqual(q.approvals, [r.id], 'the approval API reads the same record (no second queue)');
  assert.ok(!fs.existsSync(path.join(T, 'company', 'state', 'approvals.json')) && !fs.readdirSync(path.join(T, 'company')).some(f => /approval/.test(f) && f !== 'pm-inbox.jsonl'), 'no third store');
});

/* ---------- trap 2: a hand-crafted block is inert; old records only on Needs you ---------- */
test('trap 2: an id with no record cannot be answered; an old record with no actionDigest answers only from Needs you', () => {
  const T = company();
  const miss = run(T, 'return A.answer("q-999999", { verdict: "yes", surface: "chat", by: "owner", shownDigest: "sha256:00" });');
  assert.equal(miss.ok, false); assert.equal(miss.code, 'missing');
  assert.equal(jsonl(T, 'company/pm-inbox.jsonl').length, 0, 'nothing was minted by trying');
  // an older governance question (lib/governance fileQuestion): no actionDigest
  const legacy = run(T, 'const g = require(' + JSON.stringify(path.join(REPO, 'company/tools/lib/governance.js')) + '); return g.decide("hiring", { by: "Founder", summary: "open a Sales Lead round", ref: "hiring:x" });');
  const rec = run(T, 'return A.get(' + JSON.stringify(legacy.questionId) + ');');
  assert.equal(rec.legacy, true); assert.equal(rec.chatAnswerable, false);
  const chat = run(T, 'return A.answer(' + JSON.stringify(legacy.questionId) + ', { verdict: "yes", surface: "chat", by: "owner" });');
  assert.equal(chat.code, 'route', JSON.stringify(chat));
  const ny = run(T, 'return A.answer(' + JSON.stringify(legacy.questionId) + ', { verdict: "yes", surface: "needs-you", by: "owner" });');
  assert.equal(ny.ok, true, JSON.stringify(ny));
  assert.equal(run(T, 'const g = require(' + JSON.stringify(path.join(REPO, 'company/tools/lib/governance.js')) + '); return g.approved("hiring:x");'), true, 'governance reads the answer');
});

/* ---------- trap 3: canonical digest, stale refused, dedupe and caps ---------- */
test('trap 3: two key orders give one digest; a changed amount is refused as stale; identical asks dedupe; caps hold', () => {
  const T = company({ policy: { maxPendingPerSeat: 2, maxPerWindowPerSeat: 3, windowMin: 60 } });
  const d = run(T, 'return [A.digestOf({ b: 2, a: { y: "x  y", x: 5.0 } }), A.digestOf({ a: { x: 5, y: " x y " }, b: 2 }), A.digestOf({ a: { x: 6, y: "x y" }, b: 2 })];');
  assert.equal(d[0], d[1], 'stable key order, normalised numbers and strings'); assert.notEqual(d[0], d[2]);
  const a = run(T, askSpend());
  const again = run(T, 'return A.ask({ from: "Sam", category: "spend", message: "Same thing, asked again in other words.", params: { vendor: "data.example.com", amountUsd: 20.0 } });');
  assert.equal(again.deduped, true); assert.equal(again.id, a.id);
  const am = run(T, 'return A.amend(' + JSON.stringify(a.id) + ', { by: "Sam", params: { amountUsd: 200, vendor: "data.example.com" } });');
  assert.notEqual(am.actionDigest, a.actionDigest);
  const stale = run(T, 'return A.answer(' + JSON.stringify(a.id) + ', { verdict: "yes", surface: "chat", by: "owner", shownDigest: ' + JSON.stringify(a.actionDigest) + ' });');
  assert.equal(stale.code, 'stale', JSON.stringify(stale));
  assert.equal(run(T, 'return A.get(' + JSON.stringify(a.id) + ').status;'), 'pending', 'nothing was approved');
  run(T, 'return A.ask({ from: "Sam", category: "spend", message: "A second purchase, a different one.", params: { amountUsd: 5 } });');
  const cap = run(T, 'return A.ask({ from: "Sam", category: "spend", message: "A third purchase.", params: { amountUsd: 6 } });');
  assert.equal(cap.code, 'cap', 'maxPendingPerSeat from the policy file');
});

/* ---------- trap 4: fixed gates from governance.js, equal to gate-triage ---------- */
test('trap 4: the fixed-gate set is governance.json fixed (one source), equals every gate-triage fixed-gate rule, and routes chat to Needs you', () => {
  const T = company();
  const fixed = run(T, 'return A.fixedSet();');
  assert.deepEqual(fixed, Object.keys(JSON.parse(read(REPO, 'company/defaults/state/governance.json')).fixed));
  const dir = path.join(REPO, 'company', 'decision-models', 'gate-triage');
  for (const f of fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f))) {
    const rule = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rules || []).find(r => r.id === 'fixed-gate');
    assert.ok(rule, 'gate-triage ' + f + ' has a fixed-gate rule'); assert.deepEqual([...rule.when.value].sort(), [...fixed].sort(), 'drift: gate-triage ' + f + ' vs governance.json fixed');
  }
  const r = run(T, 'return A.ask({ from: "Sam", category: "access", message: "Could we get read access to the example bank account?", params: { account: "example" } });');
  const chat = run(T, 'return A.answer(' + JSON.stringify(r.id) + ', { verdict: "yes", surface: "chat", by: "owner", shownDigest: ' + JSON.stringify(r.actionDigest) + ' });');
  assert.equal(chat.code, 'route'); assert.match(chat.error, /fixed owner gate/);
  // not a hand-typed list: a category the owner adds to governance.json `fixed` routes the same way
  const T2 = company({ governance: { fixed: Object.assign({ hiring: 'approve' }, JSON.parse(read(REPO, 'company/defaults/state/governance.json')).fixed) } });
  const h = run(T2, 'return A.ask({ from: "Sam", category: "hiring", message: "Open a round for a designer.", params: { role: "designer" } });');
  assert.equal(run(T2, 'return A.get(' + JSON.stringify(h.id) + ').fixed;'), true);
});

/* ---------- trap 5: surface on the record and in the decisions.md line, written by company/tools/decision.js ---------- */
test('trap 5: surface is on the answer record and in the decisions.md line, written by company/tools/decision.js add', () => {
  const T = company();
  const a = run(T, askSpend());
  const r = run(T, 'return A.answer(' + JSON.stringify(a.id) + ', { verdict: "yes", surface: "chat", by: "owner", shownDigest: ' + JSON.stringify(a.actionDigest) + ' });');
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = jsonl(T, 'company/pm-inbox.jsonl').find(x => x.type === 'answer' && x.id === a.id);
  assert.equal(row.surface, 'chat'); assert.equal(row.shownDigest, a.actionDigest);
  assert.equal(run(T, 'return A.get(' + JSON.stringify(a.id) + ').answer.surface;'), 'chat');
  const lines = decisionsHas(T, new RegExp('Approval ' + a.id + ' \\(spend\\) approved'));
  assert.equal(lines.length, 1); assert.match(lines[0], /surface: chat/); assert.match(lines[0], /\(company\/tools\/decision\.js\)$/);
  const src = fs.readFileSync(AP, 'utf8');
  assert.ok(/require\('\.\/decision\.js'\)/.test(src) && !/require\('\.\/lib\/decision/.test(src), 'the writer is company/tools/decision.js, not the decision-model evaluator lib/decision.js');
});

/* ---------- trap 6: CAS and authority ---------- */
test('trap 6: two concurrent answers: one CAS winner, one explained refusal, exactly one answer row and one audit row', async () => {
  const T = company();
  const a = run(T, askSpend());
  const at = Date.now() + 1500;
  const one = verdict => new Promise(res => {
    const src = 'const A = require(' + JSON.stringify(AP) + '); while (Date.now() < ' + at + ') {} console.log(JSON.stringify(A.answer(' + JSON.stringify(a.id) + ', { verdict: "' + verdict + '", surface: "' + (verdict === 'yes' ? 'chat' : 'needs-you') + '", by: "owner", shownDigest: ' + JSON.stringify(a.actionDigest) + ' })));';
    const c = spawn(process.execPath, ['-e', src], { cwd: T, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', PROVENANCE_ROOT: T }) });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.on('close', () => res(JSON.parse(out.trim().split('\n').pop())));
  });
  const [x, y] = await Promise.all([one('yes'), one('no')]);
  const wins = [x, y].filter(r => r.ok), lost = [x, y].filter(r => !r.ok);
  assert.equal(wins.length, 1, JSON.stringify([x, y])); assert.equal(lost.length, 1);
  assert.equal(lost[0].code, 'closed'); assert.match(lost[0].error, /already (approved|denied) \(by .* via (chat|needs-you)/);
  assert.equal(jsonl(T, 'company/pm-inbox.jsonl').filter(r => r.type === 'answer' && r.id === a.id).length, 1);
  assert.equal(decisionsHas(T, new RegExp('Approval ' + a.id + ' \\(spend\\) (approved|denied)')).length, 1);
});
test('trap 6: authority: never the asker; a fixed gate the owner only; any other category the owner or the CEO', () => {
  const T = company();
  const s = run(T, askSpend());
  const ans = (id, by, d, surface) => run(T, 'return A.answer(' + JSON.stringify(id) + ', { verdict: "yes", surface: "' + (surface || 'needs-you') + '", by: ' + JSON.stringify(by) + ', shownDigest: ' + JSON.stringify(d) + ' });');
  assert.equal(ans(s.id, 'Sam', s.actionDigest).code, 'authority', 'the asker');
  assert.equal(ans(s.id, 'Mallory', s.actionDigest).code, 'authority', 'not the owner, not the CEO');
  assert.equal(ans(s.id, 'Founder', s.actionDigest).ok, true, 'the CEO on a non-fixed category');
  const f = run(T, 'return A.ask({ from: "Sam", category: "commitment", message: "May we sign the example pilot agreement?", params: { party: "example" } });');
  assert.equal(ans(f.id, 'Founder', f.actionDigest).code, 'authority', 'the CEO on a fixed gate');
  const own = run(T, 'return A.ask({ from: "Founder", category: "spend", message: "May I buy the example tool for $9?", params: { amountUsd: 9 } });');
  assert.equal(ans(own.id, 'Founder', own.actionDigest).code, 'authority', 'the CEO is never the answerer of its own ask');
  assert.equal(ans(f.id, 'Olive Owner', f.actionDigest).ok, true, 'the owner on a fixed gate, from Needs you');
});

/* ---------- trap 7: archive and withdrawal ---------- */
test('trap 7: the record does not live in the chat: archiving the chat message leaves it pending; withdrawal clears it everywhere', () => {
  const T = company();
  const a = run(T, askSpend());
  // a chat transcript that carried the block, then archived (removed)
  const chat = w(T, '.starnet-data/workspaces/transcripts/console-agent.jsonl', JSON.stringify({ role: 'assistant', content: '```actions\n{"id":"buy","items":[{"type":"approval","ref":"' + a.id + '"}]}\n```' }) + '\n');
  fs.rmSync(chat);
  assert.equal(run(T, 'return A.get(' + JSON.stringify(a.id) + ').status;'), 'pending');
  assert.ok(run(T, 'return I.openQuestions().map(q => q.id);').includes(a.id), 'still on Needs you');
  // withdrawal (inbox.js withdraw): gone from Needs you, the block reads "withdrawn"
  const wd = run(T, 'return A.withdraw(' + JSON.stringify(a.id) + ', { by: "Sam", why: "the vendor gave us a free trial" });');
  assert.equal(wd.ok, true, JSON.stringify(wd));
  assert.ok(!run(T, 'return I.openQuestions().map(q => q.id);').includes(a.id));
  const g = run(T, 'return A.get(' + JSON.stringify(a.id) + ');');
  assert.equal(g.status, 'withdrawn'); assert.equal(g.answer.by, 'Sam');
  assert.equal(run(T, 'return A.answer(' + JSON.stringify(a.id) + ', { verdict: "yes", surface: "chat", by: "owner", shownDigest: ' + JSON.stringify(a.actionDigest) + ' }).code;'), 'closed');
});

/* ---------- trap 8: blocking, dependents, reminders, waking the asker ---------- */
test('trap 8: a blocking approval suppresses dependents, gets ONE reminder over many ticks; an answer wakes the asker and releases', () => {
  const T = company();
  const A1 = run(T, askSpend({ blocking: true }));
  const B1 = run(T, 'return A.ask({ from: "Sam", category: "spend", message: "Then the second month as well, $20.", params: { amountUsd: 20, month: 2 }, dependsOn: ' + JSON.stringify(A1.id) + ' });');
  const b = run(T, 'return A.get(' + JSON.stringify(B1.id) + ');');
  assert.deepEqual(b.suppressed, { by: A1.id }); assert.equal(b.chatAnswerable, false);
  assert.deepEqual(run(T, 'return A.blockingSeats();'), { sam: [{ id: A1.id, category: 'spend', askedAt: run(T, 'return A.get(' + JSON.stringify(A1.id) + ').askedAt;'), dependents: [B1.id] }] });
  // ticks across 16-60 min after creation: one reminder, naming the blocking record only
  const t0 = Date.parse(run(T, 'return A.get(' + JSON.stringify(A1.id) + ').askedAt;'));
  for (const m of [16, 17, 20, 31, 46, 60]) run(T, 'A._S.now = () => ' + (t0 + m * 60e3) + '; return A.tick();');
  const rem = jsonl(T, 'company/pm-inbox.jsonl').filter(r => r.type === 'approval-reminder');
  assert.equal(rem.length, 1, JSON.stringify(rem)); assert.deepEqual(rem[0].ids, [A1.id]);
  const out = jsonl(T, 'company/owner/outbound.jsonl').filter(r => /waiting for you on Today › Needs you/.test(r.text));
  assert.equal(out.length, 1, 'one owner-channel line'); assert.match(out[0].text, /One approval is waiting/);
  // the answer: the asker is woken (an owner message re the id, opening with its name), the dependent is released
  const r = run(T, 'return A.answer(' + JSON.stringify(A1.id) + ', { verdict: "yes", surface: "chat", by: "owner", shownDigest: ' + JSON.stringify(A1.actionDigest) + ' });');
  assert.equal(r.ok, true);
  const woke = jsonl(T, 'company/owner/inbound.jsonl').filter(m => m.re === A1.id);
  assert.equal(woke.length, 1); assert.match(woke[0].text, /^Sam, my answer to your question/);
  assert.equal(run(T, 'return A.get(' + JSON.stringify(B1.id) + ').suppressed;'), null);
  assert.deepEqual(run(T, 'return A.blockingSeats();'), {});
});
test('trap 8: expiry tells the asker and releases the dependents (a hold is never permanent and silent)', () => {
  const T = company();
  const A1 = run(T, askSpend({ blocking: true, expiresMin: 30 }));
  const B1 = run(T, 'return A.ask({ from: "Sam", category: "spend", message: "And the add-on, $4.", params: { amountUsd: 4 }, dependsOn: ' + JSON.stringify(A1.id) + ' });');
  run(T, 'A._S.now = () => Date.now() + 31 * 60e3; return A.tick();');
  assert.equal(run(T, 'return A.get(' + JSON.stringify(A1.id) + ').status;'), 'expired');
  const told = jsonl(T, 'company/owner/inbound.jsonl').filter(m => m.re === A1.id);
  assert.equal(told.length, 1); assert.match(told[0].text, /expired .* default applies \(deny\)/);
  assert.equal(run(T, 'return A.get(' + JSON.stringify(B1.id) + ').suppressed;'), null);
});
test('trap 8 (batching): a same-tick burst is one reminder; one batch per 15-minute window; the clock starts at creation', () => {
  const T = company();
  const ids = run(T, 'return [1, 2, 3].map(n => A.ask({ from: "Sam", category: "spend", message: "Purchase number " + n + " for the study.", params: { amountUsd: n } }).id);');
  // nobody ever rendered these; exactly 15 min after the FIRST was created, the later two are milliseconds younger
  const t0 = Date.parse(run(T, 'return A.get(' + JSON.stringify(ids[0]) + ').askedAt;'));
  const first = run(T, 'A._S.now = () => ' + (t0 + 15 * 60e3) + '; return A.remind();');
  assert.deepEqual(first && first.ids, ids, JSON.stringify(first)); assert.equal(first.pending, 3);
  assert.equal(run(T, 'A._S.now = () => ' + (t0 + 16 * 60e3) + '; return A.remind();'), null, 'reminded once each');
  assert.equal(jsonl(T, 'company/owner/outbound.jsonl').filter(r => /Needs you/.test(r.text)).length, 1);
  assert.match(jsonl(T, 'company/owner/outbound.jsonl').find(r => /Needs you/.test(r.text)).text, /^3 approvals are waiting/);
});

/* ---------- trap 9: the hook is a read; the approval API runs no tool ---------- */
test('trap 9: blockingSeats() is a read (no file changes) and approvals.js never spawns or writes dispatcher state', () => {
  const T = company();
  run(T, askSpend({ blocking: true }));
  const hash = () => { const out = {}; const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, rel + e.name + '/'); else out[rel + e.name] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + fs.statSync(f).mtimeMs; } }; walk(T, ''); return out; };
  const before = hash(); run(T, 'return A.blockingSeats();'); assert.deepEqual(hash(), before);
  const src = fs.readFileSync(AP, 'utf8');
  assert.ok(!/child_process|execSync|spawn\(|\.exec\(/.test(src), 'no command runner in approvals.js');
  assert.ok(!/dispatch-state|owner-outbox|dispatch\.js/.test(src.replace(/^\s*\*.*$/gm, '')), 'no dispatcher state written or required');
  // and an answer still works with every command runner made to throw
  const a = run(T, askSpend({ x: 1 }).replace('amountUsd: 20', 'amountUsd: 21'));
  const r = run(T, 'const cp = require("child_process"); for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[k] = () => { throw new Error("a tool ran: " + k); }; return A.answer(' + JSON.stringify(a.id) + ', { verdict: "no", surface: "chat", by: "owner", shownDigest: ' + JSON.stringify(a.actionDigest) + ' });');
  assert.equal(r.ok, true, JSON.stringify(r));
});

/* ---------- trap 10: expiry is applied server-side ---------- */
test('trap 10: expiry deny is applied by the server (tick / the answer path), not by a renderer; no expiresAt means no expiry', () => {
  const T = company();
  const a = run(T, askSpend({ expiresMin: 1 }));
  const n = run(T, 'return A.ask({ from: "Sam", category: "spend", message: "A purchase that never expires.", params: { amountUsd: 3 } });');
  assert.ok(run(T, 'return A.get(' + JSON.stringify(a.id) + ').expiresAt;'));
  // two minutes later an answer arrives: the answer path applies the expiry first and refuses
  const late = run(T, 'A._S.now = () => Date.now() + 2 * 60e3; return A.answer(' + JSON.stringify(a.id) + ', { verdict: "yes", surface: "chat", by: "owner", shownDigest: ' + JSON.stringify(a.actionDigest) + ' });');
  assert.equal(late.code, 'closed'); assert.match(late.error, /already expired/);
  const row = jsonl(T, 'company/pm-inbox.jsonl').find(r => r.type === 'answer' && r.id === a.id);
  assert.equal(row.surface, 'expiry'); assert.equal(row.answer.verdict, 'no');
  assert.equal(run(T, 'const g = require(' + JSON.stringify(path.join(REPO, 'company/tools/lib/governance.js')) + '); return g.answerOf(' + JSON.stringify(a.id) + ').verdict;'), 'no');
  run(T, 'A._S.now = () => Date.now() + 1000 * 86400e3; return A.tick();');
  assert.equal(run(T, 'return A.get(' + JSON.stringify(n.id) + ').status;'), 'pending', 'no expiresAt: never expires');
  assert.equal(decisionsHas(T, /expired with no answer: default deny applied by the console \(surface: expiry\)/).length, 1);
});

/* ---------- round 3 ---------- */
test('R-B: governance first: auto acts and logs, notify acts, logs and tells (no record, no badge, no reminder), approve mints', () => {
  const cats = JSON.parse(read(REPO, 'company/defaults/state/governance.json')).categories;
  const T = company({ governance: { categories: Object.assign({}, cats, { tools: 'auto', models: 'notify', spend: 'approve' }) } });
  const auto = run(T, 'return A.ask({ from: "Sam", category: "tools", message: "Rename the helper script.", params: { f: "helper" } });');
  const note = run(T, 'return A.ask({ from: "Sam", category: "models", message: "Move the research seat to the smaller model.", params: { seat: "sam" } });');
  const appr = run(T, askSpend());
  assert.deepEqual([auto.minted, auto.level, note.minted, note.level, appr.minted, appr.level], [false, 'auto', false, 'notify', true, 'approve']);
  assert.equal(jsonl(T, 'company/pm-inbox.jsonl').filter(r => r.type === 'ask').length, 1, 'one record: the approve one');
  assert.equal(decisionsHas(T, /Sam goes ahead: Rename the helper/).length, 1, 'auto logs');
  assert.equal(decisionsHas(T, /Sam goes ahead: Move the research seat/).length, 1, 'notify logs');
  assert.equal(jsonl(T, 'company/owner/outbound.jsonl').filter(r => /Sam decided to Move the research seat/.test(r.text)).length, 1, 'notify tells');
  assert.ok(!jsonl(T, 'company/owner/outbound.jsonl').some(r => /Rename the helper/.test(r.text)), 'auto does not tell');
  assert.deepEqual(run(T, 'return I.openQuestions().map(q => q.id);'), [appr.id], 'the badge counts only the approve record');
  const t0 = Date.parse(run(T, 'return A.get(' + JSON.stringify(appr.id) + ').askedAt;'));
  assert.deepEqual(run(T, 'A._S.now = () => ' + (t0 + 16 * 60e3) + '; return A.remind().ids;'), [appr.id], 'reminders cover only the record');
});
test('I-a / I-b (integration): approval events through company/tools/decision.js keep competence.js verify green; a withdrawal shows both events', () => {
  const T = company();
  // a competence ledger with an anchor row in decisions.md, as competence.js daily writes it
  run(T, 'const C = require(' + JSON.stringify(path.join(REPO, 'company/tools/competence.js')) + '); C.appendRows([1, 2, 3].map(n => ({ schema: 1, id: "ev_test" + n, kind: "event", signal: "test", agent: "sam", bucket: "b", at: new Date().toISOString() }))); const v = C.verifyLedger(C.readLedger(), C.anchorText(C.FILES.decisions), {}); return C.anchor(v, {});', { COMPETENCE_ROOT: T });
  const before = read(T, 'company/work/decisions.md').split('\n').filter(Boolean);
  assert.ok(before.some(l => /Competence ledger anchor: 3 events/.test(l)));
  const a = run(T, askSpend());
  run(T, 'return A.answer(' + JSON.stringify(a.id) + ', { verdict: "yes", surface: "needs-you", by: "owner", shownDigest: ' + JSON.stringify(a.actionDigest) + ' });');
  const b = run(T, 'return A.ask({ from: "Sam", category: "spend", message: "A purchase we will not need.", params: { amountUsd: 7 } });');
  const wd = run(T, 'return A.withdraw(' + JSON.stringify(b.id) + ', { by: "Sam", why: "not needed after all" });');
  assert.equal(wd.ok, true, JSON.stringify(wd)); assert.ok(wd.audit, 'the withdrawal is an audit event');
  const after = read(T, 'company/work/decisions.md').split('\n').filter(Boolean);
  // nothing earlier rewritten: every earlier line is still there, in the same order
  let k = 0; for (const l of after) if (l === before[k]) k++;
  assert.equal(k, before.length, 'every earlier line kept, in order');
  // newest first: the approval lines sit above the earlier entry
  const idx = re => after.findIndex(l => re.test(l));
  assert.ok(idx(/Withdraws/) < idx(new RegExp('Approval ' + a.id + ' \\(spend\\) approved')) && idx(new RegExp('Approval ' + a.id + ' \\(spend\\) approved')) < idx(/\[d-aaaaaa\]/));
  // I-b: both events for the withdrawn approval
  const req = after.find(l => l.includes('Approval requested by Sam') && l.includes('A purchase we will not need'));
  const id = /\[(d-[0-9a-f]{6})\]/.exec(req)[1];
  assert.ok(after.some(l => /\*\*Withdraws /.test(l) && l.includes('[' + id + ']') && l.includes(b.id)), 'the withdraw line names the request line');
  const v = spawnSync(process.execPath, [path.join(REPO, 'company/tools/competence.js'), 'verify'], { cwd: T, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, COMPETENCE_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:1' }) });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(JSON.parse(v.stdout).anchors, 1);
});

// Expiry (default deny) and reminders must not depend on the console being open: the dispatcher's tick runs them too.
test('the dispatcher tick runs approvals.tick (expiry and reminders without the console)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'dispatch.js'), 'utf8');
  assert.ok(/require\('\.\/approvals\.js'\)\.tick\(\)/.test(src), 'dispatch.js must call approvals.tick() every tick');
});
