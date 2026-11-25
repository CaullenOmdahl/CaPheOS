#!/usr/bin/env node
// conformance for the project-takeover unit: the manifest and files check out, and the plugin registers exactly the skill the
// manifest declares, with its text. Exit 0 conformant, 1 not, 2 the test itself could not run.
'use strict';
const path = require('path');
const dir = path.join(__dirname, '..');
(async () => {
  let U; try { U = require(path.join(dir, '..', '..', 'company', 'tools', 'lib', 'units.js')); } catch (_) { U = null; }
  const problems = [];
  if (U) { const c = U.check(dir); problems.push(...c.findings); }
  const mod = await import(require('url').pathToFileURL(path.join(dir, 'host', 'index.js')).href);
  const got = [];
  mod.apply({ skills: { registerProvider: make => got.push(make()) } });
  if (got.length !== 1) problems.push('the plugin must register one provider (got ' + got.length + ')');
  else {
    const list = await got[0].list();
    if (list.length !== 1 || list[0].name !== 'project-takeover') problems.push('the provider must list exactly project-takeover');
    const s = await got[0].get(list[0]);
    if (!/^---\nname: project-takeover\n/.test(s.content) || !/Repository access lets you \*\*understand and work with\*\* a product\. It does \*\*not\*\* make the product/.test(s.content)) problems.push('the skill text is not the shipped SKILL.md');
  }
  if (problems.length) { console.log('NOT CONFORMANT\n- ' + problems.join('\n- ')); process.exit(1); }
  console.log('project-takeover: conformant'); process.exit(0);
})().catch(e => { console.log('conformance test broken: ' + e.message); process.exit(2); });
