/* page-preview.js — draw a console page or panel offline, the way the owner will see it, and screenshot it.
 *
 * Used by `console-panel.js render --page <id|dir> --png <out.png> [--theme dark] [--width 390] [--height 1800]`
 * and `--serve` (print a local URL and keep serving until Ctrl-C). It starts a private HTTP server on 127.0.0.1
 * (a free port, never 8800) that serves the console's own UI files (console/ui) plus two answers: /api/company
 * (name, timezone, currency) and /api/preview/<id> (the render() answer for the folder). The page is drawn by the
 * console's own code (console/ui/js/preview.js), so what an agent checks is what the owner gets. Nothing is written
 * except the PNG; actions in a preview are shown but never sent.
 *
 * Module: { serve(renderAnswer, opts) -> Promise<{ url, close }>, screenshot(url, out, opts) -> Promise<{ ok, file, error }>,
 *   chromeBin() }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png' };

function uiDir(root) {
  for (const d of [root && path.join(root, 'console', 'ui'), path.join(__dirname, '..', '..', '..', 'console', 'ui')]) if (d && fs.existsSync(path.join(d, 'preview.html'))) return d;
  throw new Error('console/ui/preview.html not found');
}
function serve(answer, opts) {
  opts = opts || {};
  const ui = uiDir(opts.root);
  const company = Object.assign({ name: 'Preview', timezone: 'UTC', currency: 'USD' }, opts.company || {});
  const srv = http.createServer((req, res) => {
    let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { res.writeHead(400); return res.end(); }
    const json = o => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (p === '/api/company') return json(Object.assign({ ok: true }, company));
    if (p.startsWith('/api/preview/')) return json(Object.assign({}, answer, { ok: true }));
    if (p.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"not in a preview"}'); }
    if (p.startsWith('/preview/')) p = '/preview.html';
    if (p.includes('\0') || p.split('/').includes('..')) { res.writeHead(403); return res.end(); }
    const f = path.resolve(ui, '.' + p);
    if (!f.startsWith(ui + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    const tryListen = n => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        if (port === 8800 && n < 3) { srv.close(() => tryListen(n + 1)); return; }
        const qs = new URLSearchParams(); if (opts.theme) qs.set('theme', opts.theme);
        resolve({ url: 'http://127.0.0.1:' + port + '/preview/' + encodeURIComponent(answer.id || 'page') + (qs.toString() ? '?' + qs : ''), close: () => new Promise(r => srv.close(() => r())) });
      });
    };
    tryListen(0);
  });
}
function chromeBin() { return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0) || null; }
function screenshot(url, out, opts) {
  opts = opts || {};
  const bin = chromeBin(); if (!bin) return Promise.resolve({ ok: false, error: 'no Chrome/Chromium installed: use --serve and open the URL instead' });
  const udd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'page-preview-'));
  const w = Math.max(320, Math.min(2560, Number(opts.width) || 1280)), hgt = Math.max(400, Math.min(8000, Number(opts.height) || 1800));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--user-data-dir=' + udd,
    '--window-size=' + w + ',' + hgt, '--virtual-time-budget=6000', '--screenshot=' + path.resolve(out)];
  if (opts.theme === 'dark') args.push('--force-dark-mode');
  args.push(url);
  return new Promise(resolve => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let err = '';
    c.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 45000);
    c.on('exit', code => { clearTimeout(t); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {}
      const ok = fs.existsSync(out) && fs.statSync(out).size > 0;
      resolve(ok ? { ok: true, file: path.resolve(out), width: w, height: hgt } : { ok: false, error: 'Chrome exited ' + code + ': ' + err.trim().split('\n').slice(-2).join(' ') }); });
  });
}

module.exports = { serve, screenshot, chromeBin };
