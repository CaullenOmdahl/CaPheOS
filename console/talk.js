'use strict';
/* console/talk.js — Settings › How the crew talks to you (docs/TALK.md; the tool is company/tools/talk.js, the reading
 * and the check are company/tools/lib/talk.js). Mounted by console/server.js: require('./talk.js').mount(route, deps).
 *
 *   GET  /api/settings/talk                       talk.js show --console: the owner's choice, the examples, the check counts
 *   POST /api/settings/talk { level?, length?, often? }   talk.js set … --by <owner> (nothing here writes a company file)
 *
 * meetingHooks(co) -> { ownerTalk, ownerTalkLint, ownerShown }: the meeting engine's hooks (console/meeting.js deps).
 * In a meeting the check never re-runs a turn: a reply more technical than the owner's level gets a note on the seat's
 * next turn (the existing lint line) and a check row; a Plain owner sees paths and commands masked (display only, the
 * minutes keep every word).
 */
const path = require('path');
const TALK = () => require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'talk.js'));

function mount(route, d) {
  const { runApi, bad, owner } = d;
  route('GET', /^\/api\/settings\/talk$/, () => runApi('talk.js', ['show', '--console'], { timeout: 15000 }));
  route('POST', /^\/api\/settings\/talk$/, (m, q, b) => {
    const T = TALK(); const args = ['set'];
    for (const [k, list] of [['level', T.LEVELS], ['length', T.LENGTHS], ['often', T.OFTEN]]) {
      if (b == null || b[k] === undefined || b[k] === null || b[k] === '') continue;
      if (!list.includes(String(b[k]))) bad('That choice is not one of the options.');
      args.push('--' + k, String(b[k]));
    }
    if (args.length === 1) bad('Pick how the crew should talk to you first.');
    return runApi('talk.js', args.concat(['--by', owner(), '--json']), { timeout: 30000 });
  });
}

function meetingHooks(co) {
  const root = () => co.ROOT;
  const prefs = () => { try { return TALK().prefs({ root: root() }); } catch (_) { return null; } };
  const ownerName = () => (co.config.owner && co.config.owner.name) || 'The owner';
  return {
    ownerTalk() {
      const tp = prefs(); if (!tp) return '';
      const b = TALK().block(tp, '', { root: root() });
      return b ? '- ' + b + '\n' : '';
    },
    ownerTalkLint(text, seat) {
      const tp = prefs(); if (!tp || tp.check === 'off' || tp.level === 'technical') return null;
      const c = TALK().check(text, tp.level, tp.length, { limits: tp.limits });
      if (c.ok) return null;
      try { TALK().record({ seat: seat || null, where: 'meeting', level: tp.level, check: tp.check, problems: c.problems, action: 'shadow' }, { root: root() }); } catch (_) {}
      if (tp.check !== 'live') return null;
      const words = c.problems.filter(p => p.kind !== 'length').flatMap(p => p.words).slice(0, 5);
      const long = c.problems.find(p => p.kind === 'length');
      const O = ownerName();
      return { kind: 'talk', why: 'it was more technical than ' + O + ' asked for' + (words.length ? ' (' + words.join(', ') + ')' : '') + (long ? (words.length ? ', and ' : ': ') + 'it was long (' + long.words[0] + ')' : ''),
        fix: O + (tp.level === 'some' ? ' chose some detail: explain a technical word in the same sentence, and never give a command or a file path.' : ' chose plain words: say what it means for them, without file names, commands, tool names or model names.'),
        words };
    },
    ownerShown(text) {
      const tp = prefs(); if (!tp || tp.level !== 'plain' || tp.check !== 'live') return null;
      const c = TALK().check(text, 'plain', 'full');
      if (!c.problems.some(p => p.kind === 'command' || p.kind === 'path' || p.kind === 'tool' || p.kind === 'code')) return null;
      const mk = TALK().mask(text);
      return { text: mk.text, technical: mk.technical, talkMasked: true, notice: TALK().MASKED_NOTICE };
    },
  };
}

module.exports = { mount, meetingHooks };
