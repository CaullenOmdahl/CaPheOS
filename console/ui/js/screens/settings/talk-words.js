// The owner's words for Settings › How the crew talks to you (docs/TALK.md). Pure: no DOM, so
// company/tools/tests/talk-console.test.js checks every line here with lib/owner-scope.js wordsProblems.
export const SECTION = 'How the crew talks to you';
export const LEDE = 'How much detail you get, how long the messages are, and how often you hear from the crew.';
// [id, name, tag, what it means]
export const LEVELS = [
  ['plain', 'Plain', 'recommended', 'Everyday words. They tell you what it means for you, not how it works.'],
  ['some', 'Some detail', '', 'Mostly plain, with the odd technical word explained.'],
  ['technical', 'Technical', '', 'The crew talks the way they talk to each other.'],
];
export const LEVEL_TITLE = 'How much detail';
export const LENGTH_TITLE = 'How long';
export const LENGTHS = [['short', 'Short'], ['medium', 'Medium'], ['full', 'Full']];
export const OFTEN_TITLE = 'How often you hear from them';
export const OFTEN = [['needed', 'Only when they need you (and a weekly summary)'], ['daily', 'A daily summary'], ['asItHappens', 'As things happen']];
export const EXAMPLE_TITLE = 'Example';
export const EXAMPLE_PICK = 'Show the example as';
export const SAVE = 'Save';
export const SAVED = 'Saved. The crew will talk to you this way from their next message.';
export const NOT_SAVED = 'Not saved';
export const NOT_PICKED = 'You have not picked yet, so the crew still talks the way it always has. Pick one and save.';
export const CHECK_LIVE = 'Before a reply reaches you, it is checked. One that is too technical goes back once to be written again.';
export const CHECK_SHADOW = 'For now replies are only checked and noted, nothing is sent back.';
export const checksLine = c => 'In the last 30 days: ' + (Number(c && c['sent-back']) || 0) + ' replies went back to be written again, and ' + (Number(c && c.masked) || 0) + ' had technical details left out for you.';
export const shadowLine = c => 'In the last 30 days, ' + (Number(c && c.wouldSendBack) || 0) + ' replies would have gone back to be written more plainly.';
export const TECH_PREVIEW = 'Example, as the crew writes to each other:';
