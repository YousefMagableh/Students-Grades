'use strict';
/* Static checks of the files themselves (no browser): the hard constraints R1 (static, offline, no build
 * step), R2 (no network at runtime), R8 (real exports and backups are never committed) and the version
 * shown in Help / About. The browser smoke test (tests/e2e/smoke.mjs) checks the same at runtime. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Every file under dir (relative to ROOT) whose name ends with ext. */
function filesUnder(dir, ext) {
  const out = [];
  (function walk(d) {
    fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach((e) => {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(ext)) out.push(rel);
    });
  })(dir);
  return out.sort();
}

const html = read('index.html');
const appFiles = filesUnder('js', '.js').concat(filesUnder('css', '.css'));

test('R1: index.html loads only local classic scripts and stylesheets, and every one of them exists', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 20, 'scripts: ' + scripts.length);
  scripts.forEach((attrs) => {
    assert.doesNotMatch(attrs, /type\s*=\s*["']module["']/, 'no ES modules (Chrome blocks them on file://)');
    const src = /src\s*=\s*"([^"]+)"/.exec(attrs);
    assert.ok(src, 'every script has a src');
    assert.match(src[1], /^js\/[\w./-]+\.js$/, 'local script: ' + src[1]);
    assert.ok(fs.existsSync(path.join(ROOT, src[1])), src[1] + ' exists');
  });
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sheets.length >= 9);
  sheets.forEach((href) => {
    assert.match(href, /^css\/[\w.-]+\.css$/, 'local stylesheet: ' + href);
    assert.ok(fs.existsSync(path.join(ROOT, href)), href + ' exists');
  });
  // Each script and stylesheet of js/ and css/ is loaded exactly once.
  const loaded = scripts.map((a) => /src\s*=\s*"([^"]+)"/.exec(a)[1]).concat(sheets);
  assert.equal(new Set(loaded).size, loaded.length, 'no duplicate tags');
  appFiles.forEach((f) => assert.ok(loaded.includes(f.split(path.sep).join('/')), f + ' is loaded by index.html'));
});

test('R2: a Content-Security-Policy blocks connections, fonts, frames and workers; no remote URL anywhere', () => {
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(csp, 'CSP meta tag');
  for (const d of ["connect-src 'none'", "font-src 'none'", 'img-src data: blob:', "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(d), 'CSP has ' + d);
  }
  const files = ['index.html'].concat(appFiles);
  files.forEach((f) => {
    const text = read(f);
    // The SVG namespace inside inline icons is an identifier, not a request.
    const urls = (text.match(/\bhttps?:\/\/[^\s"')]+/gi) || []).filter((u) => !/^http:\/\/www\.w3\.org\/2000\/svg$/.test(u));
    assert.deepEqual(urls, [], f + ' has remote URLs');
    // Protocol-relative links ("//cdn…") in an attribute or a CSS url().
    assert.doesNotMatch(text, /(?:\b(?:src|href)\s*=\s*["']|url\(\s*["']?)\/\//i, f + ' has a protocol-relative URL');
  });
  filesUnder('js', '.js').forEach((f) => {
    const code = read(f);
    for (const api of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\b/, /@import\b/]) {
      assert.doesNotMatch(code, api, f + ' uses ' + api);
    }
  });
  filesUnder('css', '.css').forEach((f) => {
    assert.doesNotMatch(read(f), /@import|@font-face/, f + ' loads nothing (system fonts only)');
  });
  // ExcelJS is vendored and loaded on demand from vendor/, never from a CDN.
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'exceljs.min.js')), 'vendor/exceljs.min.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'exceljs.LICENSE.txt')), 'its license');
  assert.match(read('js/ui/widgets.js'), /vendor\/exceljs\.min\.js/);
});

test('R8: .gitignore keeps spreadsheets, CSV files and backups out of the repository', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  for (const p of ['*.xlsx', '*.xls', '*.csv', '*backup*.json', 'grade-tracker-*.json']) assert.ok(lines.includes(p), '.gitignore has ' + p);
  // The app's own download names are covered: grades exports and backups.
  const covers = (name) => lines.some((p) => p && !p.startsWith('#') && new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name));
  for (const name of ['SE4351-grades-2026-12-15_1030.xlsx', 'SE4351-grades-2026-12-15_1030.csv', 'grade-tracker-backup-2026-12-15_1030.json',
    'grade-tracker-unreadable-backup-2026-12-15_1030.json']) assert.ok(covers(name), name + ' is ignored');
});

test('version 1.0.0: package.json and Help / About agree', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '1.0.0');
  const m = /var VERSION = '([^']+)'/.exec(read('js/app.js'));
  assert.ok(m, 'GT.app.VERSION in js/app.js');
  assert.equal(m[1], pkg.version);
});
