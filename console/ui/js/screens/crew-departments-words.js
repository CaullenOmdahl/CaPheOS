// The owner's words for a department lead who gives advice (Crew › People › Departments; docs/DEPARTMENTS.md §5). Pure:
// no DOM, so company/tools/tests/consult-console.test.js checks every line here with lib/owner-scope.js wordsProblems.
// The modes of departments.js advisor (off | shadow | live), said plainly.
export const ADVICE_SAY = {
  off: ['Off', 'neutral', 'Nobody is asked for advice.'],
  shadow: ['Recording only', 'warning'],
  live: ['On', 'online'],
};
export const SWITCH_LABEL = 'Lead gives advice';
export const BRIEF_TITLE = 'What the team is working on';
export const TECH = 'Technical details (for the crew)';
export const leadLine = lead => 'Lead: ' + lead + '. When someone on the team is stuck or about to finish something big, they ask ' + lead + ' first.';
export const recordingLine = lead => 'Recording only: the crew notes when it would ask ' + lead + ' for advice, and asks nobody yet.';
export const onConfirm = lead => lead + ' will be asked for advice a few times a day. It uses a stronger, more expensive setup, and the crew will check after two weeks whether it pays off.';
export const onTitle = lead => 'Let ' + lead + ' give advice?';
export const pauseTitle = lead => 'Pause ' + lead + '\'s advice?';
export const pauseConfirm = () => 'Nobody is asked for advice until you turn it back on. The crew keeps noting when it would have asked.';
export const resumeTitle = () => 'Turn the lead\'s advice back on?';
export const resumeConfirm = () => 'Turn the lead\'s advice back on? The crew will measure it again from today.';
export const askedLine = (n, max) => 'Asked the lead today: ' + (Number(n) || 0) + ' of ' + (Number(max) || 0) + ' allowed.';
export const lastAdviceLine = when => 'Last advice: ' + (when || 'none yet') + '.';
/* a paused department, in plain words: who paused it and what to do; the crew's own reason stays under Technical details */
export function pausedLine(paused, lead, dept) {
  if (!paused) return '';
  if (paused.by === 'auto') return 'The crew paused ' + lead + '\'s advice for ' + dept + ': over the last two weeks it cost more than it saved. You can turn it back on here.';
  return 'You paused ' + lead + '\'s advice for ' + dept + '. You can turn it back on here.';
}
export const noBriefLine = () => 'The lead has not written what the team is working on yet.';
// splitting big jobs (departments.js delegation, docs/DEPARTMENTS.md §6): off | shadow | live, said plainly
export const SPLIT_LABEL = 'Splitting big jobs';
export const SPLIT_SAY = { off: ['Off', 'neutral'], shadow: ['Recording only', 'warning'], live: ['On', 'online'] };
export const splitLine = (lead, n) => lead + ' can hand parts of a big job to up to ' + (Number(n) || 0) + (Number(n) === 1 ? ' person' : ' people') + ' on their team.';
export const splitNobodyLine = lead => 'Nobody on ' + lead + '\'s team is picked to take parts of a big job yet; the CEO picks them.';
export const splitRecordingLine = lead => 'Recording only: the crew notes when ' + lead + ' would split a big job, and everyone keeps their own work.';
export const splitOnTitle = lead => 'Let ' + lead + ' split big jobs?';
export const splitOnConfirm = lead => lead + ' can hand separate parts of one big job to people on the team, each with its own time limit. The crew checks whether it costs less than doing the job in one go, and stops it if not.';
export function splitWithdrawnLine(w, dept) {
  if (!w) return '';
  const d = String(dept || 'this team').replace(/\s+department$/i, '');
  if (w.by === 'auto') return 'The crew stopped splitting ' + d + '\'s bigger jobs between several people: doing them in one go was cheaper. You can turn it back on here.';
  return 'You stopped splitting ' + d + '\'s bigger jobs. You can turn it back on here.';
}
export const splitResumeTitle = () => 'Start splitting big jobs again?';
export const splitResumeConfirm = () => 'The crew will measure it again from today.';
export const savedLine = what => what + '.';
// the lead checks every finished job (departments.js accountable, docs/DEPARTMENTS.md §8): off | shadow | live, said plainly
export const CHECK_LABEL = 'Lead checks every finished job';
export const CHECK_SAY = { off: ['Off', 'neutral'], shadow: ['Recording only', 'warning'], live: ['On', 'online'] };
export const checkLine = lead => lead + ' is responsible for the team\'s work: each person checks their own work first, then ' + lead + ' checks it before it counts as done or goes anywhere else.';
export const checkRecordingLine = lead => 'Recording only: the crew notes what ' + lead + ' would check and hold, and everyone works as before.';
export const checkOnTitle = lead => 'Let ' + lead + ' check every finished job?';
export const checkOnConfirm = lead => 'Finished work waits for ' + lead + '\'s yes before it counts or goes to anyone outside the team. The team does the work on cheaper setups and ' + lead + ' mainly reads, so it should cost less; the crew measures that and stops it if it does not.';
export const SCORE_TITLE = 'How the team is doing';
export function checkStoppedLine(w, lead, dept) {
  if (!w) return '';
  const d = String(dept || 'this team').replace(/\s+department$/i, '');
  if (w.by === 'auto') return 'The crew stopped having ' + lead + ' check every finished job in ' + d + ': it did not cost less than ' + lead + ' doing the work alone. You can turn it back on here.';
  return 'You stopped ' + lead + '\'s checks for ' + d + '. You can turn it back on here.';
}
export const checkResumeTitle = () => 'Turn the lead\'s checks back on?';
export const checkResumeConfirm = () => 'The crew will measure it again from today.';
// every fixed line the screen can show, with sample names, for the plain-words test
export function samples() {
  const L = 'Kwame', D = 'Engineering';
  return [SWITCH_LABEL, BRIEF_TITLE, ADVICE_SAY.off[2], leadLine(L), recordingLine(L), onConfirm(L), onTitle(L), pauseTitle(L), pauseConfirm(), resumeTitle(), resumeConfirm(),
    askedLine(4, 12), lastAdviceLine('yesterday'), lastAdviceLine(null), pausedLine({ by: 'auto' }, L, D), pausedLine({ by: 'owner' }, L, D), noBriefLine(),
    ...Object.values(ADVICE_SAY).map(x => x[0]),
    SPLIT_LABEL, splitLine(L, 3), splitLine(L, 1), splitNobodyLine(L), splitRecordingLine(L), splitOnTitle(L), splitOnConfirm(L), splitWithdrawnLine({ by: 'auto' }, D), splitWithdrawnLine({ by: 'owner' }, D),
    splitResumeTitle(), splitResumeConfirm(), ...Object.values(SPLIT_SAY).map(x => x[0]),
    CHECK_LABEL, checkLine(L), checkRecordingLine(L), checkOnTitle(L), checkOnConfirm(L), SCORE_TITLE, checkStoppedLine({ by: 'auto' }, L, D), checkStoppedLine({ by: 'owner' }, L, D),
    checkResumeTitle(), checkResumeConfirm(), ...Object.values(CHECK_SAY).map(x => x[0])];
}
