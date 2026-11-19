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
export const savedLine = what => what + '.';
// every fixed line the screen can show, with sample names, for the plain-words test
export function samples() {
  const L = 'Kwame', D = 'Engineering';
  return [SWITCH_LABEL, BRIEF_TITLE, ADVICE_SAY.off[2], leadLine(L), recordingLine(L), onConfirm(L), onTitle(L), pauseTitle(L), pauseConfirm(), resumeTitle(), resumeConfirm(),
    askedLine(4, 12), lastAdviceLine('yesterday'), lastAdviceLine(null), pausedLine({ by: 'auto' }, L, D), pausedLine({ by: 'owner' }, L, D), noBriefLine(),
    ...Object.values(ADVICE_SAY).map(x => x[0])];
}
