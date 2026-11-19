// A reply the console masked for a Plain owner (console/chat.js shownLine, console/talk.js ownerShown; docs/TALK.md):
// the notice under it, and the parts taken out folded under "Technical details (for the crew)".
import { h, Details } from './ui.js';

export const MASKED_NOTICE = 'Some technical details were left out. The crew handles them.';
export const TECH_TITLE = 'Technical details (for the crew)';
export function maskedNote(technical, notice) {
  const parts = Array.isArray(technical) ? technical.filter(Boolean) : [];
  return h('div', { class: 'stack-4 talk-masked', 'data-talk': 'masked' },
    h('p', { class: 'caption muted' }, notice || MASKED_NOTICE),
    parts.length ? Details(TECH_TITLE, h('ul', { class: 'plain stack-2' }, parts.map(p => h('li', { class: 'caption mono-s', style: 'white-space:pre-wrap' }, p)))) : null);
}
