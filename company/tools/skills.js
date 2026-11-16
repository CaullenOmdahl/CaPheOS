#!/usr/bin/env node
/* skills.js — the skill propagation tool (owned by the tools function holder).
 *
 * The operator should not hand-install skills agent by agent. This is the repeatable, audited way:
 * read the skill package from company/skills/<name>/SKILL.md, push it to every agent (create or edit),
 * verify presence, and keep an install log. The SAME tool is what pushes a skill after an update.
 *
 *   node company/tools/skills.js status                 # matrix: agent -> skills
 *   node company/tools/skills.js verify                 # expected (company/skills/*) present on all agents
 *   node company/tools/skills.js install <name> --agents all|agent,treasurer,... [--dry-run]
 *   node company/tools/skills.js install-all [--dry-run]
 *
 * Requires the station token (secrets/station-token) and a running station. Uses the station's own skill store
 * (/api/agent-skills/manage) — the same path the UI uses; no file surgery, no server restart.
 * Install log: company/skill-installs.jsonl
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const ROOT = co.ROOT;
const SKILLS_DIR = co.p('company', 'skills');
const LOG = co.p('company', 'skill-installs.jsonl');
const BASE = co.STATION_URL.replace(/\/$/, '');

function args() {
  const a = process.argv.slice(2); const o = { cmd: a[0] || 'status' };
  for (let i = 1; i < a.length; i++) {
    if (!a[i].startsWith('--')) { o._ = o._ || []; o._.push(a[i]); continue; }
    const k = a[i].slice(2);
    o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
  }
  return o;
}
function token() { return co.secret('station-token') || ''; }
function out(code, obj) { console.log(JSON.stringify(obj, null, 1)); process.exit(code); }
async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'x-starnet-token': token() }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (_) { j = { raw: t.slice(0, 300) }; }
  if (!r.ok) throw new Error(p + ' HTTP ' + r.status + ': ' + JSON.stringify(j).slice(0, 200));
  return j;
}
function knownSkills() {
  try { return fs.readdirSync(SKILLS_DIR).filter(n => fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md'))).sort(); } catch (_) { return []; }
}
/** The station's per-skill `description` field takes 280 characters.
 *
 * A plain `slice(0, 280)` cuts mid-word, and a description that ends "…by a sa" reads like a typo
 * rather than a length limit, so nobody notices. Cut on a word boundary and mark the cut with an
 * ellipsis, so a truncated description is obviously truncated rather than subtly wrong. */
const DESCRIPTION_LIMIT = 280;
function truncateDescription(desc) {
  const s = String(desc || '').trim();
  if (s.length <= DESCRIPTION_LIMIT) return s;
  const room = s.slice(0, DESCRIPTION_LIMIT - 1);
  const boundary = room.lastIndexOf(' ');
  const cut = boundary > 0 ? room.slice(0, boundary) : room;
  return cut.replace(/[,;:.\s]+$/, '') + '…';
}

function readSkill(name) {
  const f = path.join(SKILLS_DIR, name, 'SKILL.md');
  const raw = fs.readFileSync(f, 'utf8');
  const desc = ((raw.match(/^description:\s*(.+)$/m) || [])[1] || '').replace(/^["']|["']$/g, '').trim();
  const description = truncateDescription(desc);
  return { name, body: raw.replace(/^---[\s\S]*?---\s*/, '').trim(), summary: description || ('Company skill: ' + name), description };
}
async function agents() {
  const r = await api('GET', '/api/runtime/agent');
  return (r.agents || []).map(a => a.name);
}
function audit(entry) {
  try { fs.appendFileSync(LOG, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n'); } catch (_) {}
}

const a = args();
const agentsArg = String(a.agents || 'all');

(async () => {
  try {
    if (a.cmd === 'selftest') {
      // Proves the one thing this tool rewrites on the way out: the description. A tool that quietly
      // mangles metadata is worse than one that fails, because nobody looks at what it wrote.
      const cases = [
        ['a short description is untouched', 'Classify a refusal, log it, hand it off.', (d) => d === 'Classify a refusal, log it, hand it off.'],
        ['a description at the limit is untouched', 'x'.repeat(280), (d) => d.length === 280 && !d.endsWith('…')],
        // A word-boundary cut means the piece kept is a prefix of the input that the input itself ends with a space.
        ['an over-long description is cut on a word boundary', 'word '.repeat(100).trim(), (d, i) => d.endsWith('…') && i.indexOf(d.slice(0, -1) + ' ') === 0],
        ['a cut never exceeds the limit', 'word '.repeat(100).trim(), (d) => d.length <= 280],
        ['no trailing punctuation before the ellipsis', 'word,'.repeat(100), (d) => /…$/.test(d) && !/[,;:.\s]…$/.test(d)],
        ['one unbroken long token still returns something within the limit', 'y'.repeat(500), (d) => d.length <= 280 && d.endsWith('…')],
        ['the package refusal-escalation reads back as a non-empty description', null, null],
      ];
      let bad = 0;
      for (const [label, input, pred] of cases) {
        if (input === null) {
          const sk = readSkill('refusal-escalation');
          const ok = typeof sk.description === 'string' && sk.description.length > 20 && sk.description.length <= 280;
          if (!ok) bad++;
          console.log((ok ? 'ok    ' : 'FAIL  ') + label + ' → ' + JSON.stringify(String(sk.description).slice(-40)));
          continue;
        }
        const got = truncateDescription(input);
        const ok = pred(got, input);
        if (!ok) bad++;
        console.log((ok ? 'ok    ' : 'FAIL  ') + label + ' → ' + JSON.stringify(got.slice(-42)));
      }
      out(bad ? 1 : 0, { ok: bad === 0, selftest: bad ? 'FAILED: ' + bad + ' case(s) wrong' : 'PASSED (7 cases)' });
    }
    if (a.cmd === 'status') {
      const rows = (() => { try { return fs.readFileSync(path.join(ROOT, '.starnet-data', 'workspaces', 'skills.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } })();
      const by = {};
      for (const r of rows) { if (r.state !== 'active') continue; (by[r.agentId] = by[r.agentId] || []); if (!by[r.agentId].includes(r.name)) by[r.agentId].push(r.name); }
      out(0, { ok: true, expected: knownSkills(), agents: await agents(), installed: by });
    }
    if (a.cmd === 'verify') {
      const rows = (() => { try { return fs.readFileSync(path.join(ROOT, '.starnet-data', 'workspaces', 'skills.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } })();
      /* LAST WRITE WINS, per (agent, skill). The journal is append-only, so an archived skill still has its earlier
         `active` row in the file. Filtering with `state === 'active'` therefore reported a skill archived through
         /api/agent-skills/manage as still installed. A check that cannot see a removal is not a check. */
      const state = new Map();
      /* Only rows that CARRY a state are state transitions. The journal also holds observation rows (an `audit()`
         entry from this tool, a listing) with no `state` at all; letting those win reported correctly installed
         skills as missing. */
      for (const r of rows) if (r && r.agentId && r.name && r.state) state.set(r.agentId + '\u0000' + r.name, String(r.state));
      const have = new Set([...state].filter(([, s]) => s === 'active').map(([k]) => k));
      const list = await agents();
      const nameToId = {}; const rt = await api('GET', '/api/runtime/agent');
      // runtime gives names; map to roster ids for the skill store keys
      const roster = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.starnet-data', 'workspaces', 'agent.roster.json'), 'utf8')).agents; } catch (_) { return []; } })();
      for (const r of roster) nameToId[(r.name || '').toLowerCase()] = r.agentId;
      const missing = [];
      for (const n of list) { const id = nameToId[String(n).toLowerCase()] || String(n).toLowerCase(); for (const s of knownSkills()) if (!have.has(id + '\u0000' + s)) missing.push({ agent: n, id, skill: s }); }
      out(missing.length ? 1 : 0, { ok: missing.length === 0, agents: list, expected: knownSkills(), missing });
    }
    if (a.cmd === 'install' || a.cmd === 'install-all') {
      const which = a.cmd === 'install-all' ? knownSkills() : [String((a._ || [])[0] || '')];
      if (!which[0]) out(2, { ok: false, error: 'usage: install <skill-name> --agents all|list' });
      for (const n of which) if (!fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md'))) out(2, { ok: false, error: 'no skill package at company/skills/' + n + '/SKILL.md' });
      const all = await agents();
      const ids = agentsArg === 'all' ? all.map(x => String(x).toLowerCase()) : agentsArg.split(',').map(s => s.trim()).filter(Boolean);
      // map display names -> roster ids
      const roster = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.starnet-data', 'workspaces', 'agent.roster.json'), 'utf8')).agents; } catch (_) { return []; } })();
      const nameToId = {}; for (const r of roster) nameToId[(r.name || '').toLowerCase()] = r.agentId;
      const results = [];
      for (const n of which) {
        const sk = readSkill(n);
        for (const target of ids) {
          const id = nameToId[String(target).toLowerCase()] || String(target);
          if (a['dry-run']) { results.push({ skill: n, agent: String(target), dryRun: true }); continue; }
          let action = 'create';
          try { await api('POST', '/api/agent-skills/manage', { action: 'create', agentId: id, name: n, body: sk.body, summary: sk.summary, description: sk.description }); }
          catch (e) { if (/already exists/i.test(e.message)) { await api('POST', '/api/agent-skills/manage', { action: 'edit', agentId: id, name: n, body: sk.body, summary: sk.summary, description: sk.description }); action = 'edit'; } else throw e; }
          results.push({ skill: n, agent: String(target), id, action });
          audit({ skill: n, agent: String(target), id, action, by: String(a.by || co.nameOf(co.seatFor('tools'))) });
        }
      }
      out(0, { ok: true, dryRun: !!a['dry-run'], count: results.length, results });
    }
    out(2, { ok: false, error: 'unknown command', commands: ['status', 'verify', 'install', 'install-all'] });
  } catch (e) { out(1, { ok: false, error: e.message }); }
})();
