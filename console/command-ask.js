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
 * The detector is the composer's own (inbox.js shellAsk): the whole reply in its evidence mode (a command counts only
 * next to words that hand it over: "in your terminal", "run this", "on your side", a $ prompt or a fenced command
 * line), and each sentence in its strict mode when the sentence tells the reader to run, type or paste it ("run:"
 * followed by a backticked line on the next line counts too). "I ran `git push`" is a report, not an ask.
 *
 *   node console/command-ask.js --selftest
 */
'use strict';
const path = require('path');

let detector = null;
function shellAsk(text, opts) {
  if (!detector) {
    const co = require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'company.js'));
    detector = require(co.p('company', 'tools', 'inbox.js')).shellAsk;
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
  const m = spans.find(x => x.includes(hit)) || spans.find(x => x.length > 12 && hit.includes(x.slice(0, 20)));
  if (m) full = m;
  return { command: full.trim().slice(0, 160), action: actionFor(full) };
}

function selftest() {
  let fails = 0, n = 0;
  const ok = (name, cond, x) => { n++; if (!cond) fails++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || x === undefined ? '' : ' :: ' + JSON.stringify(x).slice(0, 400))); };
  // captured 2026-11-17 from the sandbox Founder's chat replies (console-agent stream)
  const CAPTURED_1 = 'One change from what I said earlier: the stop is yours to run, not mine. The liveness timer is a framework unit that `service.js` deliberately doesn\'t manage (service.js:624), and Ingrid\'s procedure says it\'s stopped by you or the framework, not by a seat. Agents are also refused `systemctl` here. The command is reversible and touches nothing else. No halt, gate or watch changes.\n\nThe steps:\n\n1. Open your check at [healthchecks.io](https://healthchecks.io/) and note its period and grace. Only your account shows them.\n2. In a terminal, run:\n   `systemctl --user stop capheos-sandbox-station-liveness.timer`\n   The last healthy ping went out at 21:20, and the next one was due at 21:25.\n3. Wait for period plus grace. The alert should reach you inside that window.\n4. Then restart it:\n   `systemctl --user start capheos-sandbox-station-liveness.timer`\n   You should get a recovery notice within about 5 minutes.\n\n```actions\n{"id": "hb-test-1", "prompt": "Heartbeat silence test", "items": [{"type": "button", "label": "I stopped the timer", "value": "stopped"}]}\n```';
  const CAPTURED_2 = 'For tonight, the heartbeat test is ready whenever you are:\n\n1. Note the period and grace on your healthchecks.io check.\n2. Stop the timer by running `systemctl --user stop capheos-sandbox-station-liveness.timer`.\n\nThen tap "I stopped the timer" in the block above, and I\'ll take it from there.';
  let r = commandAsk(CAPTURED_1);
  ok('captured reply 1 ("In a terminal, run:" + the systemctl line) is flagged', r && /systemctl --user stop capheos-sandbox-station-liveness\.timer/.test(r.command), r);
  ok('captured reply 1 links the console action for it: Test the outside alarm', r && r.action && r.action.href === '#/settings/system/alarm', r);
  r = commandAsk(CAPTURED_2);
  ok('captured reply 2 ("Stop the timer by running `systemctl …`") is flagged with the same action', r && /liveness\.timer/.test(r.command) && r.action && r.action.href === '#/settings/system/alarm', r);
  for (const [txt, what] of [['Please run `sudo apt install jq` and tell me when it is done.', 'sudo'], ['You can run npm install in the repo and I will pick it up.', 'npm install'],
    ['Type `pip install pyyaml` in your shell.', 'pip install'], ['Could you run `git push origin main` for me?', 'git push'], ['Run this:\n```\nnode company/tools/onboard.js --certify\n```', 'a fenced command after "Run this"'],
    ['To restart it, run `systemctl --user restart capheos-station.service`.', 'systemctl restart']]) ok('flags an instruction: ' + what, !!commandAsk(txt), txt);
  r = commandAsk('Could you run `git push origin main` for me?');
  ok('no console action for git push: the page says to tell the agent to use one', r && r.action === null, r);
  r = commandAsk('To restart it, run `systemctl --user restart capheos-station.service`.');
  ok('a station restart links System health', r && r.action && r.action.href === '#/settings/system/health', r);
  for (const [txt, what] of [['I ran `git push` on the branch and opened a pull request.', 'a report of what the agent ran'], ['Done: I wrote company/CHARTER.md and ran `node company/tools/onboard.js --certify`, which passed.', 'a report with a backticked command'],
    ['The dispatcher checks in every 10 minutes; nothing for you to do.', 'plain prose'], ['The service is stopped. You can start it again from Background services.', 'a pointer to a console place'],
    ['Agents run `systemctl --user status` to read the timer; nothing changed.', 'what agents run']]) ok('does not flag ' + what, commandAsk(txt) === null, { txt, got: commandAsk(txt) });
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}

module.exports = { commandAsk, actionFor };
if (require.main === module) {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  console.error('usage: node console/command-ask.js --selftest'); process.exit(2);
}
