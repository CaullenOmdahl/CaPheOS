#!/usr/bin/env node
/* console-cookie-names.test.js — two companies' consoles on one host keep separate sign-ins: each names its session and
 * CSRF cookies after its company, so signing in to one never replaces the other's cookie (cookies ignore the port).
 *   node --test company/tools/tests/console-cookie-names.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../../console/auth.js');

test('cookie names carry the company slug; no slug keeps the old names; odd characters are dropped', () => {
  const a = A.cookieNames({ config: { slug: 'acme-trading' } }), b = A.cookieNames({ config: { slug: 'beta-labs' } });
  assert.deepEqual(a, { session: 'capheos_session_acme-trading', csrf: 'capheos_csrf_acme-trading' });
  assert.notEqual(a.session, b.session); assert.notEqual(a.csrf, b.csrf);
  assert.deepEqual(A.cookieNames({ config: {} }), { session: 'capheos_session', csrf: 'capheos_csrf' });
  assert.equal(A.cookieSuffix({ config: { slug: 'Odd Co; x=1' } }), '_oddcox1');
});
