#!/usr/bin/env node
/* reach.js — read-only public internet reader inspired by Agent Reach (MIT).
 *
 * Channels (read-only, zero API keys, zero login, zero anti-bot bypass):
 *   reddit   search <query> [--subreddit <name>] [--limit N] [--tsv] [--json]
 *            subreddit <name> [--query <filter>] [--limit N] [--tsv] [--json]
 *            read <url-or-post-id> [--json]
 *   web      search <query> [--limit N] [--tsv] [--json]
 *            read <url> [--json]
 *   github   search <query> [--limit N] [--tsv] [--json]
 *            read <owner/repo|url> [--json]
 *   youtube  search <query> [--limit N] [--tsv] [--json]
 *            read <url> [--json]
 *   read     <url> [--json]    (auto-routes by URL host)
 *   channels [--json]          (channels, actions, limits, remaining daily budget)
 *   --selftest                 (offline loopback suite)
 *
 * Governance:
 *   - Limits shipped CLOSED (0) in modules/reach/limits/limits.json; opened in company/state/modules/reach/limits/.
 *   - Every outbound HTTP call passes external-gate.js (category: "network") and an SSRF check (public http/https only).
 *   - Challenge / CAPTCHA / login walls return structured error code CHALLENGE_OR_LOGIN_REQUIRED (never bypassed).
 *   - Metered to company/state/reach-log.jsonl via provenance.js; all items carry untrusted: true.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const LIB = [path.join(__dirname, 'lib'), path.join(__dirname, '..', '..', '..', 'company', 'tools', 'lib')].find(d => fs.existsSync(path.join(d, 'modkit.js')));
const co = require(path.join(LIB, 'company'));
const kit = require(path.join(LIB, 'modkit'));

const UA = 'CaPheOS-Reach/0.1 (read-only)';
const EXA_URL = () => process.env.REACH_EXA_URL || 'https://mcp.exa.ai/mcp';
const JINA_BASE = () => (process.env.REACH_JINA_BASE || 'https://r.jina.ai').replace(/\/+$/, '');
const GH_API = () => (process.env.REACH_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const YT_OEMBED = () => process.env.REACH_YT_OEMBED || 'https://www.youtube.com/oembed';
const ROOT_OF = opts => path.resolve((opts && opts.root) || process.env.CAPHEOS_ROOT || co.ROOT);
const METER = opts => path.join(ROOT_OF(opts), 'company', 'state', 'reach-log.jsonl');

const CHANNELS = {
  reddit: { actions: ['search', 'subreddit', 'read'], description: 'Search public Reddit posts, list subreddit posts, and read post text/top comments (no login or API key)' },
  web: { actions: ['search', 'read'], description: 'Semantic public web search (Exa) and clean Markdown page reading (Jina Reader with Exa fallback)' },
  github: { actions: ['search', 'read'], description: 'Search public GitHub repositories and read repo metadata, README or issues/PRs' },
  youtube: { actions: ['search', 'read'], description: 'Search public YouTube videos and read oEmbed metadata' },
};

/* ---------------- URL & SSRF validation ---------------- */
function isPrivateIp(host) {
  const ip = String(host || '').replace(/^\[|\]$/g, '');
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80:') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
  }
  return false;
}
function normalizePublicUrl(raw, opts) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { throw reachErr('BAD_INPUT', 'target must be a valid http(s) URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw reachErr('BAD_INPUT', 'only http and https URLs are allowed');
  if (u.username || u.password) throw reachErr('BAD_INPUT', 'credentials in URL are not allowed');
  const h = u.hostname.toLowerCase();
  if (!(opts && opts.allowLoopback)) {
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || isPrivateIp(h)) {
      throw reachErr('SSRF_BLOCKED', 'private or loopback host refused: ' + h);
    }
  }
  return u.toString();
}
function hostMatches(rawUrl, ...domains) {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return domains.some(d => h === d || h.endsWith('.' + d));
  } catch (_) { return false; }
}
function reachErr(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/* ---------------- Challenge / login wall detection (honest refusal, never bypass) ---------------- */
const WALL_TITLE_RE = /^(?:log\s*in|sign\s*in|join\s+(?:now|linkedin)|just a moment(?:\.\.\.)?|attention required!?\s*\|\s*cloudflare|prove your humanity|access denied|security verification)(?:\s*[-|·:].*)?$/i;
function isChallengeOrLogin(text, title) {
  const sample = String(text || '').slice(0, 4096).toLowerCase();
  const t = String(title || '').trim();
  if (t && WALL_TITLE_RE.test(t)) return true;
  if (sample.includes('warning:') && sample.includes('requiring captcha')) return true;
  if (sample.includes('title: attention required! | cloudflare') && (sample.includes('ray id') || sample.includes('/cdn-cgi/challenge-platform/'))) return true;
  if (sample.includes('## performing security verification') || sample.includes('please verify you are a human')) return true;
  if (sample.includes('title: just a moment...')) return true;
  return false;
}

/* ---------------- Limits, metering, and external gate ---------------- */
function readCaps(opts) {
  const root = ROOT_OF(opts);
  let lim = null;
  for (const f of [path.join(root, 'company', 'state', 'modules', 'reach', 'limits', 'limits.json'), path.join(root, 'modules', 'reach', 'limits', 'limits.json')]) {
    try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); if (v && typeof v === 'object') { lim = v; break; } } catch (_) {}
  }
  const pos = (k, d) => { const v = lim && Number(lim[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    maxRequestsPerDay: pos('maxRequestsPerDay', 0),
    maxResultsPerQuery: pos('maxResultsPerQuery', 10),
    maxResponseChars: pos('maxResponseChars', 20000),
    timeoutMs: pos('timeoutMs', 20000),
  };
}
function usedToday(opts) {
  const today = co.localParts().date;
  let n = 0;
  for (const r of kit.readJsonl(METER(opts))) {
    if (r && typeof r.at === 'string' && co.localParts(new Date(r.at)).date === today) n++;
  }
  return n;
}
function recordMeter(row, opts) {
  const f = METER(opts);
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString(), seat: process.env.STARNET_AGENT_ID || 'unknown' }, row)) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, line);
  try {
    const prov = require(path.join(LIB, '..', 'provenance.js'));
    prov.appended(f, line, 'reach.js', { root: ROOT_OF(opts) });
  } catch (_) {}
}
function assertBudget(caps, opts) {
  if (!(caps.maxRequestsPerDay > 0)) {
    throw reachErr('LIMIT_CLOSED', 'reach limits are closed (maxRequestsPerDay=0); ask the owner to open limits via module.js limits reach set limits.json maxRequestsPerDay <N> --by owner');
  }
  const used = usedToday(opts);
  if (used >= caps.maxRequestsPerDay) {
    throw reachErr('DAILY_CAP_REACHED', 'reach daily request cap reached (' + used + '/' + caps.maxRequestsPerDay + ')');
  }
}
function checkGate(url, opts) {
  if (opts && opts.gate) {
    const ok = opts.gate(url);
    if (!ok) throw reachErr('GATE_REFUSED', 'external gate refused ' + url);
    return;
  }
  const gate = kit.tool('external-gate') || (() => { try { return require(path.join(LIB, '..', 'external-gate.js')); } catch (_) { return null; } })();
  if (!gate) throw reachErr('GATE_MISSING', 'external-gate.js missing: outbound network refused (fail closed)');
  const d = gate.check({ category: 'network', target: url, agent: process.env.STARNET_AGENT_ID || 'reach', note: 'reach read-only fetch' });
  if (!d || !d.allow) throw reachErr('GATE_REFUSED', 'external gate refused ' + url + ': ' + ((d && d.reason) || 'not allowlisted'));
}

async function httpFetch(url, init, opts) {
  checkGate(url, opts);
  const timeoutMs = (opts && opts.timeoutMs) || 20000;
  const maxBytes = (opts && opts.maxBytes) || 2 * 1024 * 1024;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, Object.assign({ redirect: 'manual', signal: ctl.signal }, init || {}));
    if (res.status === 429) throw reachErr('RATE_LIMITED', 'upstream rate limited (HTTP 429) on ' + new URL(url).hostname);
    if (res.status === 401 || res.status === 403) throw reachErr('CHALLENGE_OR_LOGIN_REQUIRED', 'upstream refused anonymous read (HTTP ' + res.status + ') on ' + new URL(url).hostname);
    if (res.status >= 300 && res.status < 400) throw reachErr('UPSTREAM_REDIRECT', 'unexpected redirect (HTTP ' + res.status + ') on ' + new URL(url).hostname);
    if (res.status < 200 || res.status >= 300) throw reachErr('UPSTREAM_ERROR', 'upstream HTTP ' + res.status + ' on ' + new URL(url).hostname);
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return text.slice(0, maxBytes);
    return text;
  } catch (e) {
    if (e && e.code) throw e;
    if (e && e.name === 'AbortError') throw reachErr('TIMEOUT', 'request timed out after ' + timeoutMs + 'ms');
    throw reachErr('NETWORK_ERROR', String(e && e.message || e));
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- Backends: Exa MCP, Jina Reader, GitHub API, YouTube oEmbed ---------------- */
function parseExaBlocks(text, maxChars) {
  const items = [];
  const raw = '\n' + String(text || '').trim();
  const blocks = raw.split(/\n(?=Title: )/).filter(b => b.trim().startsWith('Title:'));
  for (const blk of blocks) {
    const lines = blk.trim().split('\n');
    const f = {};
    let i = 0;
    for (; i < lines.length; i++) {
      const m = /^(Title|URL|Published|Author):\s*(.*)$/.exec(lines[i]);
      if (!m) break;
      f[m[1].toLowerCase()] = m[2].trim();
    }
    const body = lines.slice(i).filter(l => l.trim() !== 'Highlights:' && l.trim() !== 'Text:').join('\n').trim();
    const na = v => (!v || v === 'N/A') ? null : v;
    items.push({
      title: na(f.title),
      url: na(f.url),
      author: na(f.author),
      publishedAt: na(f.published),
      text: maxChars ? body.slice(0, maxChars) : body,
      untrusted: true,
    });
  }
  if (!items.length && String(text || '').trim()) {
    // web_fetch_exa sometimes opens with `# Title\nURL: ...\nPublished: ...\nAuthor: ...`
    const lines = String(text).trim().split('\n');
    const titleM = /^#\s+(.+)$/.exec(lines[0] || '');
    const urlM = /^URL:\s*(.+)$/m.exec(text);
    const pubM = /^Published:\s*(.+)$/m.exec(text);
    const authM = /^Author:\s*(.+)$/m.exec(text);
    if (titleM || urlM) {
      items.push({
        title: titleM ? titleM[1].trim() : null,
        url: urlM ? urlM[1].trim() : null,
        author: authM ? authM[1].trim() : null,
        publishedAt: pubM ? pubM[1].trim() : null,
        text: maxChars ? String(text).trim().slice(0, maxChars) : String(text).trim(),
        untrusted: true,
      });
    }
  }
  return items;
}

async function exaCall(toolName, args, opts) {
  const endpoint = EXA_URL();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } });
  const raw = await httpFetch(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body,
  }, opts);
  const dataLines = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
  let msg;
  try { msg = JSON.parse(dataLines.length ? dataLines[dataLines.length - 1] : raw); }
  catch (_) { throw reachErr('UPSTREAM_ERROR', 'Exa returned non-JSON payload'); }
  if (msg.error) {
    const m = String(msg.error.message || msg.error).slice(0, 240);
    if (/429|rate.?limit|quota|credit/i.test(m)) throw reachErr('RATE_LIMITED', 'Exa: ' + m);
    throw reachErr('UPSTREAM_ERROR', 'Exa: ' + m);
  }
  const res = msg.result || {};
  const txt = (Array.isArray(res.content) ? res.content : []).filter(c => c && c.type === 'text').map(c => c.text || '').join('\n');
  if (res.isError) {
    if (/429|rate.?limit|quota|credit/i.test(txt)) throw reachErr('RATE_LIMITED', 'Exa: ' + txt.slice(0, 240));
    throw reachErr('UPSTREAM_ERROR', 'Exa: ' + txt.slice(0, 240));
  }
  return txt;
}

async function jinaRead(targetUrl, opts) {
  const url = normalizePublicUrl(targetUrl, opts);
  const jinaUrl = JINA_BASE() + '/' + url;
  const body = await httpFetch(jinaUrl, { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'text/plain' } }, opts);
  const titleM = /^Title:\s*(.*)$/m.exec(body);
  const pubM = /^Published Time:\s*(.*)$/m.exec(body);
  const title = titleM ? titleM[1].trim() : null;
  if (isChallengeOrLogin(body, title)) {
    throw reachErr('CHALLENGE_OR_LOGIN_REQUIRED', 'page returned a CAPTCHA, anti-bot challenge or login wall; not bypassed');
  }
  const idx = body.indexOf('Markdown Content:');
  const content = (idx >= 0 ? body.slice(idx + 'Markdown Content:'.length) : body).trim();
  const maxChars = (opts && opts.maxResponseChars) || 20000;
  return [{ title, url, author: null, publishedAt: pubM ? pubM[1].trim() : null, text: content.slice(0, maxChars), untrusted: true }];
}

/* ---------------- Channel implementations ---------------- */
async function redditSearch(params, opts) {
  const q = String(params.query || '').trim();
  if (!q) throw reachErr('BAD_INPUT', 'query is required');
  const sub = params.subreddit ? String(params.subreddit).trim().replace(/^\/?r\//i, '').replace(/[^A-Za-z0-9_]/g, '') : '';
  const scope = sub ? 'site:reddit.com/r/' + sub : 'site:reddit.com/r/';
  const limit = Math.max(1, Math.min(Number(params.limit) || 5, opts.maxResultsPerQuery));
  const txt = await exaCall('web_search_exa', { query: '(' + q + ') (' + scope + ')', objective: q, numResults: limit }, opts);
  const items = parseExaBlocks(txt, opts.maxResponseChars)
    .filter(it => it.url && hostMatches(it.url, 'reddit.com', 'redd.it') && (!sub || it.url.toLowerCase().includes('/r/' + sub.toLowerCase() + '/')))
    .slice(0, limit);
  return { backend: 'public-web/exa', items };
}

async function redditSubreddit(params, opts) {
  const sub = String(params.name || '').trim().replace(/^\/?r\//i, '').replace(/[^A-Za-z0-9_]/g, '');
  if (!sub) throw reachErr('BAD_INPUT', 'subreddit name is required (e.g. python)');
  const filter = String(params.query || '').trim();
  const limit = Math.max(1, Math.min(Number(params.limit) || 5, opts.maxResultsPerQuery));
  const q = filter ? '(' + filter + ') (site:reddit.com/r/' + sub + '/comments)' : 'site:reddit.com/r/' + sub + '/comments';
  const txt = await exaCall('web_search_exa', { query: q, objective: filter || ('recent discussions in r/' + sub), numResults: limit }, opts);
  const items = parseExaBlocks(txt, opts.maxResponseChars)
    .filter(it => it.url && hostMatches(it.url, 'reddit.com', 'redd.it') && it.url.toLowerCase().includes('/r/' + sub.toLowerCase() + '/'))
    .slice(0, limit);
  return { backend: 'public-web/exa', items };
}

async function redditRead(params, opts) {
  let target = String(params.target || '').trim();
  if (!target) throw reachErr('BAD_INPUT', 'target post URL or post id is required');
  if (/^[a-z0-9]{5,12}$/i.test(target)) target = 'https://www.reddit.com/comments/' + target + '/';
  const url = normalizePublicUrl(target, opts);
  if (!hostMatches(url, 'reddit.com', 'redd.it')) throw reachErr('BAD_INPUT', 'target must be a reddit.com or redd.it URL or post id');
  try {
    const txt = await exaCall('web_fetch_exa', { urls: [url], maxCharacters: opts.maxResponseChars }, opts);
    const items = parseExaBlocks(txt, opts.maxResponseChars);
    if (items.length && !isChallengeOrLogin(items[0].text, items[0].title)) {
      if (!items[0].url) items[0].url = url;
      return { backend: 'public-web/exa', items: items.slice(0, 1) };
    }
  } catch (e) {
    if (e && e.code === 'GATE_REFUSED') throw e;
  }
  const items = await jinaRead(url, opts);
  return { backend: 'public-web/jina', items };
}

async function webSearch(params, opts) {
  const q = String(params.query || '').trim();
  if (!q) throw reachErr('BAD_INPUT', 'query is required');
  const limit = Math.max(1, Math.min(Number(params.limit) || 5, opts.maxResultsPerQuery));
  const txt = await exaCall('web_search_exa', { query: q, objective: q, numResults: limit }, opts);
  const items = parseExaBlocks(txt, opts.maxResponseChars).slice(0, limit);
  return { backend: 'exa', items };
}

async function webRead(params, opts) {
  const url = normalizePublicUrl(params.target, opts);
  try {
    const items = await jinaRead(url, opts);
    if (items.length && items[0].text) return { backend: 'jina', items };
  } catch (e) {
    if (e && (e.code === 'GATE_REFUSED' || e.code === 'CHALLENGE_OR_LOGIN_REQUIRED')) throw e;
  }
  const txt = await exaCall('web_fetch_exa', { urls: [url], maxCharacters: opts.maxResponseChars }, opts);
  const items = parseExaBlocks(txt, opts.maxResponseChars);
  if (items.length && isChallengeOrLogin(items[0].text, items[0].title)) {
    throw reachErr('CHALLENGE_OR_LOGIN_REQUIRED', 'page returned a challenge or login wall; not bypassed');
  }
  return { backend: 'exa', items: items.length ? items.slice(0, 1) : [{ title: null, url, author: null, publishedAt: null, text: String(txt || '').slice(0, opts.maxResponseChars), untrusted: true }] };
}

async function githubSearch(params, opts) {
  const q = String(params.query || '').trim();
  if (!q) throw reachErr('BAD_INPUT', 'query is required');
  const limit = Math.max(1, Math.min(Number(params.limit) || 5, opts.maxResultsPerQuery));
  const url = GH_API() + '/search/repositories?q=' + encodeURIComponent(q) + '&per_page=' + limit;
  const raw = await httpFetch(url, { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' } }, opts);
  const d = JSON.parse(raw);
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, limit).map(r => ({
    title: r.full_name,
    url: r.html_url,
    author: r.owner && r.owner.login || null,
    publishedAt: r.updated_at || r.created_at || null,
    text: String((r.description || '') + ' (stars: ' + (r.stargazers_count || 0) + ', lang: ' + (r.language || 'n/a') + ')').slice(0, opts.maxResponseChars),
    untrusted: true,
  }));
  return { backend: 'github-api', items };
}

async function githubRead(params, opts) {
  const raw = String(params.target || '').trim();
  if (!raw) throw reachErr('BAD_INPUT', 'owner/repo or github.com URL is required');
  let m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  let issueNum = null;
  if (!m) {
    const u = new URL(normalizePublicUrl(raw, opts));
    if (!hostMatches(u.toString(), 'github.com')) throw reachErr('BAD_INPUT', 'target must be owner/repo or a github.com URL');
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) throw reachErr('BAD_INPUT', 'github URL must include owner/repo');
    m = [raw, segs[0], segs[1].replace(/\.git$/, '')];
    if ((segs[2] === 'issues' || segs[2] === 'pull') && /^\d+$/.test(segs[3] || '')) issueNum = segs[3];
  }
  const owner = m[1], repo = m[2];
  if (issueNum) {
    const url = GH_API() + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/issues/' + issueNum;
    const d = JSON.parse(await httpFetch(url, { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' } }, opts));
    return { backend: 'github-api', items: [{ title: '#' + d.number + ' ' + (d.title || ''), url: d.html_url, author: d.user && d.user.login || null, publishedAt: d.created_at || null, text: String(d.body || '').slice(0, opts.maxResponseChars), untrusted: true }] };
  }
  const url = GH_API() + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
  const d = JSON.parse(await httpFetch(url, { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' } }, opts));
  let readme = '';
  try {
    const rm = JSON.parse(await httpFetch(url + '/readme', { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' } }, opts));
    if (rm && rm.content) readme = Buffer.from(rm.content, 'base64').toString('utf8');
  } catch (_) {}
  const body = [(d.description || ''), 'stars: ' + (d.stargazers_count || 0) + ' · language: ' + (d.language || 'n/a'), readme ? '\n' + readme : ''].filter(Boolean).join('\n');
  return { backend: 'github-api', items: [{ title: d.full_name, url: d.html_url, author: d.owner && d.owner.login || null, publishedAt: d.updated_at || null, text: body.slice(0, opts.maxResponseChars), untrusted: true }] };
}

async function youtubeSearch(params, opts) {
  const q = String(params.query || '').trim();
  if (!q) throw reachErr('BAD_INPUT', 'query is required');
  const limit = Math.max(1, Math.min(Number(params.limit) || 5, opts.maxResultsPerQuery));
  const txt = await exaCall('web_search_exa', { query: '(' + q + ') (site:youtube.com/watch)', objective: q, numResults: limit }, opts);
  const items = parseExaBlocks(txt, opts.maxResponseChars).filter(it => it.url && hostMatches(it.url, 'youtube.com', 'youtu.be')).slice(0, limit);
  return { backend: 'public-web/exa', items };
}

async function youtubeRead(params, opts) {
  const url = normalizePublicUrl(params.target, opts);
  if (!hostMatches(url, 'youtube.com', 'youtu.be')) throw reachErr('BAD_INPUT', 'target must be a youtube.com or youtu.be URL');
  const oe = YT_OEMBED() + '?url=' + encodeURIComponent(url) + '&format=json';
  const d = JSON.parse(await httpFetch(oe, { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, opts));
  return { backend: 'youtube-oembed', items: [{ title: d.title || null, url, author: d.author_name || null, publishedAt: null, text: ('Video: ' + (d.title || '') + ' by ' + (d.author_name || 'unknown') + (d.author_url ? ' (' + d.author_url + ')' : '')).slice(0, opts.maxResponseChars), untrusted: true }] };
}

/* ---------------- Dispatcher ---------------- */
async function execute(channel, action, params, opts) {
  const caps = Object.assign(readCaps(opts), opts && opts.caps || {});
  assertBudget(caps, opts);
  const runOpts = Object.assign({ maxResultsPerQuery: caps.maxResultsPerQuery, maxResponseChars: caps.maxResponseChars, timeoutMs: caps.timeoutMs }, opts || {});
  let ch = channel, act = action;
  if (ch === 'read') {
    const target = String(params.target || '').trim();
    if (hostMatches(target, 'reddit.com', 'redd.it')) { ch = 'reddit'; act = 'read'; }
    else if (hostMatches(target, 'github.com')) { ch = 'github'; act = 'read'; }
    else if (hostMatches(target, 'youtube.com', 'youtu.be')) { ch = 'youtube'; act = 'read'; }
    else { ch = 'web'; act = 'read'; }
  }
  const map = {
    'reddit:search': redditSearch,
    'reddit:subreddit': redditSubreddit,
    'reddit:read': redditRead,
    'web:search': webSearch,
    'web:read': webRead,
    'github:search': githubSearch,
    'github:read': githubRead,
    'youtube:search': youtubeSearch,
    'youtube:read': youtubeRead,
  };
  const fn = map[ch + ':' + act];
  if (!fn) throw reachErr('BAD_INPUT', 'unknown channel/action: ' + ch + ' ' + act);
  const t0 = Date.now();
  try {
    const res = await fn(params, runOpts);
    const chars = (res.items || []).reduce((n, x) => n + String((x && x.text) || '').length, 0);
    recordMeter({ channel: ch, action: act, backend: res.backend, ok: true, items: (res.items || []).length, chars, ms: Date.now() - t0 }, opts);
    return { ok: true, channel: ch, action: act, backend: res.backend, untrusted: true, count: (res.items || []).length, items: res.items || [] };
  } catch (e) {
    recordMeter({ channel: ch, action: act, ok: false, code: e.code || 'ERROR', error: String(e.message || e).slice(0, 160), ms: Date.now() - t0 }, opts);
    throw e;
  }
}

function formatTsv(res) {
  const clean = s => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
  const lines = ['published\tauthor\ttitle\turl\tsnippet'];
  for (const it of res.items || []) {
    lines.push([clean(it.publishedAt || '-'), clean(it.author || '-'), clean((it.title || '').slice(0, 120)), clean(it.url || ''), clean((it.text || '').slice(0, 220))].join('\t'));
  }
  return lines.join('\n');
}

function formatPlain(res) {
  if (!(res.items || []).length) return '(no results)';
  return res.items.map((it, i) => [
    '[' + (i + 1) + '] ' + (it.title || '(untitled)'),
    it.url ? '    URL: ' + it.url : null,
    (it.author || it.publishedAt) ? '    By: ' + (it.author || '?') + (it.publishedAt ? ' · ' + it.publishedAt : '') : null,
    it.text ? '    ' + String(it.text).replace(/\n/g, '\n    ').slice(0, 800) : null,
  ].filter(Boolean).join('\n')).join('\n\n');
}

/* ---------------- Offline --selftest ---------------- */
async function selftest() {
  const assert = require('assert');
  const life = require(path.join(LIB, 'temp-life'));
  const T = life.tmpDir('reach-selftest-');
  const prevEnv = Object.assign({}, process.env);
  let srv = null;
  let passed = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('ok   ' + msg); };
  try {
    fs.mkdirSync(path.join(T, 'company', 'state', 'modules', 'reach', 'limits'), { recursive: true });
    fs.writeFileSync(path.join(T, 'company', 'company.json'), JSON.stringify({ name: 'Reach Test', timezone: 'UTC' }));
    fs.writeFileSync(path.join(T, 'company', 'state', 'external-allowlist.txt'), '127.0.0.1\n');
    process.env.CAPHEOS_ROOT = T;

    // 1. Closed limits refuse
    let closedErr = null;
    try { await execute('reddit', 'subreddit', { name: 'python' }, { gate: () => true }); } catch (e) { closedErr = e; }
    ok(closedErr && closedErr.code === 'LIMIT_CLOSED', 'closed limits (0) refuse outbound requests');

    // Open limits for test
    const limFile = path.join(T, 'company', 'state', 'modules', 'reach', 'limits', 'limits.json');
    const setLim = o => fs.writeFileSync(limFile, JSON.stringify(o, null, 2));
    setLim({ maxRequestsPerDay: 20, maxResultsPerQuery: 5, maxResponseChars: 4000, timeoutMs: 5000 });

    // 2. SSRF & gate refusal checks
    let ssrfErr = null;
    try { normalizePublicUrl('http://169.254.169.254/latest/meta-data/'); } catch (e) { ssrfErr = e; }
    ok(ssrfErr && ssrfErr.code === 'SSRF_BLOCKED', 'SSRF guard blocks link-local metadata IP');
    let ssrfLocal = null;
    try { normalizePublicUrl('http://127.0.0.1:8800/api/health'); } catch (e) { ssrfLocal = e; }
    ok(ssrfLocal && ssrfLocal.code === 'SSRF_BLOCKED', 'SSRF guard blocks loopback IP');
    let gateErr = null;
    try { checkGate('https://example.com', { gate: () => false }); } catch (e) { gateErr = e; }
    ok(gateErr && gateErr.code === 'GATE_REFUSED', 'external-gate refusal fails closed');

    // 3. Challenge / login wall detection
    ok(isChallengeOrLogin('Warning: Target URL returned error 403 requiring CAPTCHA\nTitle: Just a moment...', 'Just a moment...') === true, 'detects Cloudflare/CAPTCHA challenge wall');
    ok(isChallengeOrLogin('Normal discussion thread about markets and risk.', 'How do contracts work? : r/markets') === false, 'does not false-positive on normal content');

    // 4. Local loopback stub server covering Exa, Jina, GitHub, YouTube
    srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.url === '/mcp') {
          const j = JSON.parse(body || '{}');
          const tool = j.params && j.params.name;
          if (tool === 'web_search_exa') {
            const q = String((j.params.arguments && j.params.arguments.query) || '');
            const text = q.includes('r/python')
              ? 'Title: Fast async patterns : r/python\nURL: https://www.reddit.com/r/python/comments/abc123/fast_async/\nPublished: 2026-11-20T12:00:00Z\nAuthor: u/alex\nHighlights:\nUse TaskGroup for structured concurrency.\n'
              : 'Title: Example Docs\nURL: https://example.com/docs\nPublished: 2026-11-20\nAuthor: Sam\nText:\nClean public documentation.\n';
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            return res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }) + '\n\n');
          }
          if (tool === 'web_fetch_exa') {
            const text = '# Fast async patterns : r/python\nURL: https://www.reddit.com/r/python/comments/abc123/fast_async/\nPublished: 2026-11-20\nAuthor: u/alex\n\nPost body plus top comments.';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }));
          }
        }
        if (req.url.startsWith('/jina/')) {
          if (req.url.includes('captcha.example')) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('Title: Just a moment...\nWarning: Target URL returned error 403 requiring CAPTCHA\n## Performing security verification\n');
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end('Title: Clean Article\nPublished Time: 2026-11-21\nMarkdown Content:\nHello from Jina Reader.');
        }
        if (req.url.startsWith('/gh/search/repositories')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ items: [{ full_name: 'demo/tool', html_url: 'https://github.com/demo/tool', owner: { login: 'demo' }, updated_at: '2026-11-20T00:00:00Z', description: 'Demo repo', stargazers_count: 42, language: 'JavaScript' }] }));
        }
        if (req.url === '/gh/repos/demo/tool') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ full_name: 'demo/tool', html_url: 'https://github.com/demo/tool', owner: { login: 'demo' }, updated_at: '2026-11-20T00:00:00Z', description: 'Demo repo', stargazers_count: 42, language: 'JavaScript' }));
        }
        if (req.url === '/gh/repos/demo/tool/readme') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ content: Buffer.from('# Demo Tool\nWorks cleanly.').toString('base64') }));
        }
        if (req.url.startsWith('/yt')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ title: 'Async Talk', author_name: 'Kim', author_url: 'https://www.youtube.com/@kim' }));
        }
        res.writeHead(404); res.end('not found');
      });
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    process.env.REACH_EXA_URL = 'http://127.0.0.1:' + port + '/mcp';
    process.env.REACH_JINA_BASE = 'http://127.0.0.1:' + port + '/jina';
    process.env.REACH_GITHUB_API = 'http://127.0.0.1:' + port + '/gh';
    process.env.REACH_YT_OEMBED = 'http://127.0.0.1:' + port + '/yt';

    const rSub = await execute('reddit', 'subreddit', { name: 'r/python', limit: 3 }, { gate: () => true });
    ok(rSub.ok && rSub.count === 1 && rSub.untrusted === true && rSub.items[0].author === 'u/alex', 'reddit subreddit parses Exa SSE and tags untrusted');
    const tsv = formatTsv(rSub);
    ok(tsv.includes('published\tauthor\ttitle\turl\tsnippet') && tsv.includes('Fast async patterns'), 'TSV digest formatting works');

    const rRead = await execute('read', '', { target: 'https://www.reddit.com/r/python/comments/abc123/fast_async/' }, { gate: () => true });
    ok(rRead.ok && rRead.channel === 'reddit' && rRead.items[0].text.includes('top comments'), 'auto-dispatch read routes reddit URLs cleanly');

    const rWeb = await execute('web', 'read', { target: 'https://example.com/article' }, { gate: () => true });
    ok(rWeb.ok && rWeb.backend === 'jina' && rWeb.items[0].text.includes('Hello from Jina Reader'), 'web read uses Jina Reader');

    let wallErr = null;
    try { await execute('web', 'read', { target: 'https://captcha.example/secret' }, { gate: () => true }); } catch (e) { wallErr = e; }
    ok(wallErr && wallErr.code === 'CHALLENGE_OR_LOGIN_REQUIRED', 'web read refuses CAPTCHA/challenge walls honestly');

    const rGh = await execute('github', 'read', { target: 'demo/tool' }, { gate: () => true });
    ok(rGh.ok && rGh.items[0].text.includes('# Demo Tool'), 'github read returns repo + decoded README');

    const rYt = await execute('youtube', 'read', { target: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { gate: () => true });
    ok(rYt.ok && rYt.items[0].title === 'Async Talk', 'youtube read parses oEmbed metadata');

    // 5. Daily cap enforcement
    const curUsed = usedToday();
    setLim({ maxRequestsPerDay: curUsed, maxResultsPerQuery: 5, maxResponseChars: 4000, timeoutMs: 5000 });
    let capErr = null;
    try { await execute('web', 'search', { query: 'test' }, { gate: () => true }); } catch (e) { capErr = e; }
    ok(capErr && capErr.code === 'DAILY_CAP_REACHED', 'enforces maxRequestsPerDay cap from meter log');

    console.log('REACH SELFTEST PASSED: ' + passed + ' cases');
    return 0;
  } finally {
    if (srv) try { srv.close(); } catch (_) {}
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
    Object.assign(process.env, prevEnv);
    fs.rmSync(T, { recursive: true, force: true });
  }
}

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['json', 'tsv', 'selftest', 'help'].includes(k)) { flags[k] = true; continue; }
      const nx = argv[i + 1];
      if (nx !== undefined && !nx.startsWith('--')) { flags[k] = nx; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.selftest || pos[0] === 'selftest') process.exit(await selftest());
  if (flags.help || !pos.length) {
    console.log('usage: reach.js channels | read <url> | reddit (search|subreddit|read) <arg> | web (search|read) <arg> | github (search|read) <arg> | youtube (search|read) <arg>   [--subreddit S] [--query Q] [--limit N] [--tsv] [--json]');
    process.exit(0);
  }
  if (pos[0] === 'channels') {
    const caps = readCaps(), used = usedToday();
    const out = { ok: true, channels: CHANNELS, limits: caps, usedToday: used, remainingToday: Math.max(0, caps.maxRequestsPerDay - used) };
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log('Reach channels (used today: ' + used + '/' + caps.maxRequestsPerDay + '):');
      for (const [k, v] of Object.entries(CHANNELS)) console.log('  ' + k.padEnd(10) + v.actions.join(', ').padEnd(24) + v.description);
    }
    process.exit(0);
  }
  try {
    let channel = pos[0], action = pos[1], arg = pos.slice(2).join(' ');
    let params = {};
    if (channel === 'read') { action = 'read'; params = { target: pos.slice(1).join(' ') }; }
    else if (action === 'search') params = { query: arg, subreddit: flags.subreddit, limit: flags.limit };
    else if (action === 'subreddit') params = { name: pos[2] || '', query: flags.query || pos.slice(3).join(' '), limit: flags.limit };
    else if (action === 'read') params = { target: arg };
    else throw reachErr('BAD_INPUT', 'unknown command: ' + pos.join(' '));
    const res = await execute(channel, action, params);
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else if (flags.tsv) console.log(formatTsv(res));
    else console.log(formatPlain(res));
    process.exit(0);
  } catch (e) {
    const out = { ok: false, code: e.code || 'ERROR', error: String(e.message || e) };
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else console.error('reach error [' + out.code + ']: ' + out.error);
    process.exit(1);
  }
}

module.exports = { execute, formatTsv, normalizePublicUrl, isChallengeOrLogin, parseExaBlocks, readCaps, usedToday, CHANNELS };
if (require.main === module) main();
