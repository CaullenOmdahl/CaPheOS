#!/usr/bin/env node
/* console/command-ask.js — does a crew member's chat reply tell the owner to run a command?
 *
 * The owner works only in the console. The ask composer (company/tools/inbox.js composerCheck) already refuses a Today
 * request that hands the owner a command; a live chat reply has no composer, so the console flags it instead: the chat
 * page shows "This asks you to run a command. You don't need a terminal for this: …" under the reply, with the console
 * action that does the same thing when there is one (console/ui/js/chat.js).
 *
 *   commandAsk(text) -> null | { command, action: { label, href } | null }
 *
 * It is a PRE-DELIVERY check (console/chat.js send): a finished reply that hands the owner a command is not delivered;
 * it goes back to the agent once with recheckNote(hit) — the owner uses the console only, so offer a button or do it
 * yourself — and the owner sees the second reply. Only a second reply that still hands over a command is delivered, with
 * the notice. recheckNote's text starts with CHECK_PREFIX, so the chat history never shows it as the owner's words.
 *
 *   recheckNote(hit) -> the message the agent gets       CHECK_PREFIX = '[Console check, not from the owner:'
 *
 * The detector is the composer's own (inbox.js shellAsk): the whole reply in its evidence mode (a command counts only
 * next to words that hand it over: "in your terminal", "run this", "on your side", a $ prompt or a fenced command
 * line), and each sentence in its strict mode when the sentence tells the reader to run, type or paste it ("run:"
 * followed by a backticked line on the next line counts too). "I ran `git push`" is a report, not an ask.
 *
 * ownerAsk(text) is the same lint for the OWNER SCOPE (company/tools/lib/owner-scope.js, the ask composer's rule): a
 * question the reply puts to the owner ("could you …?", "shall I …?", "please …") about infrastructure, monitoring,
 * health checks, timers, tools or framework bugs is the crew's job, and an owner question full of technical words is
 * not one the owner can answer. The chat page shows a notice under it with where it goes.
 *
 *   ownerAsk(text) -> null | { kind: 'crew-scope' | 'jargon', question, why, route: 'risk'|'tools'|'floor'|'framework'|null, words }
 *
 *   node console/command-ask.js --selftest
 */
'use strict';
const path = require('path');

let detector = null;
function shellAsk(text, opts) {
  if (!detector) {
    detector = require(path.join(__dirname, '..', 'company', 'tools', 'inbox.js')).shellAsk;   // this checkout's own (the console runs from the company root)
  }
  return detector(text, opts);
}

// an instruction to the reader: run/type/paste/execute/enter, not as the writer's own report ("I ran", "we'll run")
const TELLS = /(?:^|[^\w'])(?<!\b(?:I|we|I'll|we'll|I've|we've|I'd|I'm|we're|I will|we will|I can|I have|I had|I was|it|it's|that|which|they|she|he|is|are|was|were|agents?)\s)(?:run(?:ning)?|typ(?:e|ing)|past(?:e|ing)|execut(?:e|ing)|enter(?:ing)?)\b(?!\s+(?:out|into|over)\b)/i;

/* the console action for a command, when one exists */
function actionFor(cmd) {
  const c = String(cmd || '');
  if (/liveness/i.test(c) && /\b(?:stop|disable|kill|mask)\b/i.test(c)) return { label: 'Test the outside alarm (Settings › System)', href: '#/settings/system/alarm' };
  if (/\bsystemctl\b/i.test(c) && /\b(?:station|dispatch)\b/i.test(c) && /\b(?:start|restart)\b/i.test(c)) return { label: 'System health (Settings › System)', href: '#/settings/system/health' };
  if (/\bsystemctl\b/i.test(c) && /\b(?:start|stop|restart|enable|disable)\b/i.test(c)) return { label: 'Background services (Settings › System)', href: '#/settings/system/services' };
  if (/\bhalt\.js\b|\bhalt\b/i.test(c)) return { label: 'Halt', href: '#/halt' };
  if (/\bguardrails?\.js\b/i.test(c)) return { label: 'Guardrails (Settings › Autonomy)', href: '#/settings/autonomy/guardrails' };
  if (/\bsecrets\/|\bservice-keys?\b/i.test(c)) return { label: 'Service keys (Settings › Connections and keys)', href: '#/settings/connections/keys' };
  return null;
}

let scopeLib = null;
function scope() {
  if (!scopeLib) scopeLib = require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'owner-scope.js'));
  return scopeLib;
}
// a sentence that puts a question or a request to the owner
const TO_OWNER = /\?\s*$|^(?:please|could you|can you|would you|will you|may (?:i|we)|shall (?:i|we)|should (?:i|we)|do you want|are you ok)\b|\b(?:please|could you|can you|would you)\b/i;
function ownerAsk(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, '\n');
  if (prose.length < 12) return null;
  const S = scope();
  for (const raw of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const sn = raw.replace(/^[\s>*\-\d.)]+/, '').trim();
    if (sn.length < 8 || !TO_OWNER.test(sn) || !/\b(?:you|your|i|we)\b/i.test(sn)) continue;
    const cls = S.classify({ message: sn });
    if (cls.scope === 'crew') return { kind: 'crew-scope', question: sn.slice(0, 200), why: cls.why, route: S.routeFor(cls).to, words: [...new Set(cls.crew.map(c => c.hit))].slice(0, 6) };
    const jar = S.plainScore(sn).jargon;
    if (cls.owner.length && jar.length >= 2) return { kind: 'jargon', question: sn.slice(0, 200), why: 'it asks you in technical words', route: null, words: [...new Set(jar)].slice(0, 6) };
  }
  return null;
}

/* observeAsk(text, ownerName) — the meeting's observe-mode lint: while the owner observes (console/meeting.js), a reply
 * may not put a question to them at all. A question or request that names the owner ("Avery, could you …?", "the
 * owner should decide …?", "@owner") is flagged; a question to a seated colleague ("Dana, can you …?") is not.
 *   observeAsk(text, ownerName) -> null | { kind: 'observe-question', question } */
function observeAsk(text, ownerName) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, '\n');
  if (prose.length < 6) return null;
  const on = String(ownerName || '').trim(); const first = on.split(/\s+/)[0];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = ['the owner', '@owner', 'owner'].concat(on ? [esc(on)] : [], first && first !== on ? [esc(first)] : []);
  const NAMED = new RegExp('(?:^|[^\\w@])(?:' + names.join('|') + ')\\b', 'i');
  for (const raw of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const sn = raw.replace(/^[\s>*\-\d.)]+/, '').trim();
    if (sn.length < 6 || !TO_OWNER.test(sn)) continue;
    if (/^ASK\s*:/i.test(sn)) { const who = sn.replace(/^ASK\s*:\s*/i, '').split(/\s/)[0].replace(/^@|[,:;.]+$/g, ''); if (NAMED.test(' ' + who) || /^(owner|you)$/i.test(who)) return { kind: 'observe-question', question: sn.slice(0, 200) }; continue; }
    if (NAMED.test(sn)) return { kind: 'observe-question', question: sn.slice(0, 200) };
  }
  return null;
}

function commandAsk(text) {
  const t = String(text || '');
  if (t.length < 6) return null;
  // the prose only: an ```actions block is the console's own controls, never a command
  const prose = t.replace(/```actions[\s\S]*?```/g, '\n');
  let hit = null;
  // "run:" / "In a terminal, run:" followed by the command on the next line reads as one sentence
  const joined = prose.replace(/:[ \t]*\n[ \t]*(?=`|\$\s|sudo\b|systemctl\b|npm\b|pip3?\b|git\b|node\b)/g, ': ');
  for (const sn of joined.split(/(?<=[.!?])\s+|\n+/)) {
    if (!TELLS.test(sn)) continue;
    const h = shellAsk(sn); if (h) { hit = h; break; }
  }
  if (!hit) hit = shellAsk(prose, { evidence: true });
  if (!hit) return null;
  // the full command for the action match: the backticked span or the line that holds the hit
  let full = hit;
  const tick = prose.match(/`([^`\n]+)`/g) || [];
  const spans = tick.map(x => x.slice(1, -1));
  // the hit is the words that hand it over ("in your terminal"): the command is the backticked span in that sentence
  const sent = joined.split(/(?<=[.!?])\s+|\n+/).find(x => x.includes(hit)) || '';
  const inSent = (sent.match(/`([^`\n]+)`/g) || []).map(x => x.slice(1, -1));
  const m = spans.find(x => x.includes(hit)) || spans.find(x => x.length > 12 && hit.includes(x.slice(0, 20))) || inSent[0];
  if (m) full = m;
  return { command: full.trim().slice(0, 160), action: actionFor(full) };
}

const CHECK_PREFIX = '[Console check, not from the owner:';
// a push to a default branch is refused for everyone (the one standing rule on agents' git access): the note never tells
// the agent to run it itself
const DEFAULT_PUSH = /\bgit\s+push\b(?:[^`\n]*\s)?(?:\S+:)?(?:refs\/heads\/)?(main|master|trunk)(?=$|[\s`"';])/i;
function recheckNote(hit) {
  const a = hit && hit.action;
  if (hit && hit.command && DEFAULT_PUSH.test(String(hit.command))) {
    return CHECK_PREFIX + ' your reply was NOT shown to the owner, because it asked them to run a command (' + String(hit.command).slice(0, 160) + '). The owner uses the console only and never opens a terminal. ' +
      'Do not run that command yourself either: nobody pushes to a default branch. Push a branch and open a pull request for review, or hand it to the tools seat in a handoff. Write your reply to the owner again, in plain words, without the command.]';
  }
  return CHECK_PREFIX + ' your reply was NOT shown to the owner, because it asked them to run a command' + (hit && hit.command ? ' (' + String(hit.command).slice(0, 160) + ')' : '') +
    '. The owner uses the console only and never opens a terminal. Do it yourself with your tools, or offer the console control that does it' +
    (a ? ' ([' + a.label + '](console:' + a.href + '))' : ' (a [label](console:#/route) link, or an ```actions block)') +
    ', or hand it to the tools seat in a handoff; if agents are refused the command, say so and route it. Write your reply to the owner again, in plain words, without the command.]';
}

function selftest() {
  let fails = 0, n = 0;
  const ok = (name, cond, x) => { n++; if (!cond) fails++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || x === undefined ? '' : ' :: ' + JSON.stringify(x).slice(0, 400))); };
  // captured 2026-11-17 from the sandbox Founder's chat replies (console-agent stream)
  const CAPTURED_1 = 'One change from what I said earlier: the stop is yours to run, not mine. The liveness timer is a framework unit that `service.js` deliberately doesn\'t manage (service.js:624), and Iris\'s procedure says it\'s stopped by you or the framework, not by a seat. Agents are also refused `systemctl` here. The command is reversible and touches nothing else. No halt, gate or watch changes.\n\nThe steps:\n\n1. Open your check at [healthchecks.io](https://healthchecks.io/) and note its period and grace. Only your account shows them.\n2. In a terminal, run:\n   `systemctl --user stop trial-co-station-liveness.timer`\n   The last healthy ping went out at 21:20, and the next one was due at 21:25.\n3. Wait for period plus grace. The alert should reach you inside that window.\n4. Then restart it:\n   `systemctl --user start trial-co-station-liveness.timer`\n   You should get a recovery notice within about 5 minutes.\n\n```actions\n{"id": "hb-test-1", "prompt": "Heartbeat silence test", "items": [{"type": "button", "label": "I stopped the timer", "value": "stopped"}]}\n```';
  const CAPTURED_2 = 'For tonight, the heartbeat test is ready whenever you are:\n\n1. Note the period and grace on your healthchecks.io check.\n2. Stop the timer by running `systemctl --user stop trial-co-station-liveness.timer`.\n\nThen tap "I stopped the timer" in the block above, and I\'ll take it from there.';
  let r = commandAsk(CAPTURED_1);
  ok('captured reply 1 ("In a terminal, run:" + the systemctl line) is flagged', r && /systemctl --user stop trial-co-station-liveness\.timer/.test(r.command), r);
  ok('captured reply 1 links the console action for it: Test the outside alarm', r && r.action && r.action.href === '#/settings/system/alarm', r);
  r = commandAsk(CAPTURED_2);
  ok('captured reply 2 ("Stop the timer by running `systemctl …`") is flagged with the same action', r && /liveness\.timer/.test(r.command) && r.action && r.action.href === '#/settings/system/alarm', r);
  for (const [txt, what] of [['Please run `sudo apt install jq` and tell me when it is done.', 'sudo'], ['You can run npm install in the repo and I will pick it up.', 'npm install'],
    ['Type `pip install pyyaml` in your shell.', 'pip install'], ['Could you run `git push origin main` for me?', 'git push'], ['Run this:\n```\nnode company/tools/onboard.js --certify\n```', 'a fenced command after "Run this"'],
    ['To restart it, run `systemctl --user restart capheos-station.service`.', 'systemctl restart']]) ok('flags an instruction: ' + what, !!commandAsk(txt), txt);
  r = commandAsk('Please run `sudo apt install jq` in your terminal and tell me when it is done.');
  ok('the command is the backticked span next to "in your terminal", not the hand-over words', r && r.command === 'sudo apt install jq', r);
  r = commandAsk('Could you run `git push origin main` for me?');
  ok('no console action for git push: the page says to tell the agent to use one', r && r.action === null, r);
  r = commandAsk('To restart it, run `systemctl --user restart capheos-station.service`.');
  ok('a station restart links System health', r && r.action && r.action.href === '#/settings/system/health', r);
  for (const [txt, what] of [['I ran `git push` on the branch and opened a pull request.', 'a report of what the agent ran'], ['Done: I wrote company/CHARTER.md and ran `node company/tools/onboard.js --certify`, which passed.', 'a report with a backticked command'],
    ['The dispatcher checks in every 10 minutes; nothing for you to do.', 'plain prose'], ['The service is stopped. You can start it again from Background services.', 'a pointer to a console place'],
    ['Agents run `systemctl --user status` to read the timer; nothing changed.', 'what agents run']]) ok('does not flag ' + what, commandAsk(txt) === null, { txt, got: commandAsk(txt) });
  // the pre-delivery check's note to the agent: the reason, the console action when there is one, and the prefix the chat hides
  let rn = recheckNote(commandAsk(CAPTURED_1));
  ok('recheck note: starts with the check prefix, says the owner uses the console only, offers the console action', rn.startsWith(CHECK_PREFIX) && /console only/.test(rn) && /#\/settings\/system\/alarm/.test(rn) && /do it yourself/i.test(rn), rn);
  rn = recheckNote(commandAsk('Could you run `git push origin main` for me?'));
  ok('recheck note for a push to a default branch: says not to run it, points at a pull request', /Do not run that command yourself/.test(rn) && /pull request/.test(rn) && !/Do it yourself/.test(rn) && /git push origin main/.test(rn), rn);
  rn = recheckNote(commandAsk('Could you run `git push origin feature-x` for me?'));
  ok('recheck note without a console action: asks for a button or doing it', /actions block/.test(rn) && /git push origin feature-x/.test(rn) && /Do it yourself/.test(rn), rn);
  for (const c of ['git push origin HEAD:main', 'git push -f origin master', 'git push origin refs/heads/main']) ok('a default-branch push is recognised: ' + c, DEFAULT_PUSH.test(c));
  for (const c of ['git push origin main-fix', 'git push origin feature/maintenance']) ok('not a default-branch push: ' + c, !DEFAULT_PUSH.test(c));
  // the owner-scope lint: crew work put to the owner in chat
  let oa = ownerAsk('The recorder now has its own watchdog. Could you add a healthchecks check named recorder, period 5, grace 15, and paste its ping URL?');
  ok('owner scope: a health-check request in chat is flagged as the crew\'s, routed to the risk seat', oa && oa.kind === 'crew-scope' && oa.route === 'risk' && /healthchecks/.test(oa.words.join()), oa);
  oa = ownerAsk('Shall I adopt the heartbeat timer onto the service register? Nothing new runs.');
  ok('owner scope: "shall I adopt the timer" is flagged: handle it yourself', oa && oa.kind === 'crew-scope', oa);
  oa = ownerAsk('Could you sign up for a free Acme account and paste the API token and the webhook endpoint here?');
  ok('owner scope: an account ask in technical words is flagged as jargon', oa && oa.kind === 'jargon', oa);
  for (const [txt, what] of [['May I spend $40 on a month of market data? It lets us test the price idea; if you skip it, we keep the free feed.', 'a plain money question'],
    ['I fixed the timer and the heartbeat is green again. Nothing for you to do.', 'a report about infrastructure with no question'],
    ['Which market should we focus on first, sports or weather?', 'a direction question']]) ok('owner scope: does not flag ' + what, ownerAsk(txt) === null, { txt, got: ownerAsk(txt) });
  // the meeting's observe-mode lint: no question to the owner at all while they observe
  for (const [txt, what] of [['Avery, could you confirm the budget before we go on?', 'a question that names the owner'], ['I think the owner should decide this. Do you agree, Avery?', 'a question to the owner by name at the end'],
    ['Should we ask the owner about the price?', 'a question about asking the owner'], ['ASK: Avery — which market first?', 'an ASK line to the owner']]) ok('observe: flags ' + what, !!observeAsk(txt, 'Avery Nguyen'), { txt, got: observeAsk(txt, 'Avery Nguyen') });
  for (const [txt, what] of [['Dana, can you take the ranked list?', 'a question to a colleague'], ['Avery asked for this plan, so here it is.', 'a mention of the owner with no question'],
    ['ASK: Nora — which items are push items?', 'an ASK line to a colleague']]) ok('observe: does not flag ' + what, observeAsk(txt, 'Avery Nguyen') === null, { txt, got: observeAsk(txt, 'Avery Nguyen') });
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}

module.exports = { commandAsk, ownerAsk, observeAsk, actionFor, recheckNote, CHECK_PREFIX };
if (require.main === module) {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  console.error('usage: node console/command-ask.js --selftest'); process.exit(2);
}
