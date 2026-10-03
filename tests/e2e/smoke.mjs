#!/usr/bin/env node
/* Grade Tracker - end-to-end smoke test in headless Chromium, straight from file:// (no server).
 *
 *   node tests/e2e/smoke.mjs        (or: npm run test:e2e)
 *
 * Uses Playwright from the local node_modules or, failing that, the globally installed one
 * (npm root -g). Fake sample data only. Each check starts from a known state (see resetSample),
 * so one failure does not cascade into the others. Prints a PASS/FAIL list and exits non-zero on
 * any failure. The whole run must make zero non-file network requests and raise no page errors. */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through to the global install */ }
  const globalRoot = execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-smoke-'));
const SAMPLE_STUDENTS = 59;

// ------------------------------------------------------------------ runner

const results = [];
const network = [];
const pageErrors = [];
const consoleErrors = [];

async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log('PASS  ' + name);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, err });
    console.log('FAIL  ' + name + '\n      ' + String(err && err.message ? err.message : err).split('\n').join('\n      '));
    if (page) {
      const shot = path.join(TMP, 'fail-' + results.length + '.png');
      try { await page.screenshot({ path: shot }); console.log('      screenshot: ' + shot); } catch (e) { /* page gone */ }
    }
  }
}

// ------------------------------------------------------------------ page helpers

let browser, context, page;

function watch(p) {
  p.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) network.push(u);
  });
  p.on('pageerror', (e) => pageErrors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
}

async function ready() {
  await page.waitForFunction(() => window.GT && GT.store && GT.store.state && document.querySelector('#tabs .tab'));
}

/** Closes stray dialogs and menus, then replaces all data with the SE 4351 sample course on the
 * Grades tab (light theme, privacy off). Every check that needs data starts here.
 * opts.lateWork: also load the two sample late-work cases (as the course menu's "Load sample data" does). */
async function resetSample(opts = {}) {
  await page.evaluate((o) => {
    document.querySelectorAll('dialog').forEach((d) => { try { d.close(); } catch (e) { /* closed */ } d.remove(); });
    if (GT.ui.closeMenu) GT.ui.closeMenu();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const st = GT.model.createDefaultState();
    st.ui.theme = 'light';
    st.meta.lastBackupAt = new Date().toISOString(); // keep the backup reminder banner out of the way
    GT.store.replaceState(st, 'test');
    GT.store.transact('Load sample data', (c) => GT.sample.loadInto(c, { lateWork: !!o.lateWork }), { source: 'sample', historyMode: 'bulk' });
    GT.app.navigate('grades');
  }, opts);
  // The rows must be the new students (sample ids are new on every load), not the previous table.
  await page.waitForFunction((n) => {
    const rows = [...document.querySelectorAll('.gt-grid tbody tr.gr')];
    const ids = new Set(GT.store.course().students.map((s) => s.id));
    return rows.length === n && rows.every((tr) => ids.has(tr.getAttribute('data-sid')));
  }, SAMPLE_STUDENTS);
}

async function gotoView(id) {
  await page.click('#tab-' + id);
  await page.waitForFunction((v) => {
    const root = document.querySelector('#view .view-root');
    return root && root.getAttribute('data-view') === v && root.children.length > 0;
  }, id);
}

/** data-c index of a grid column header ("raw", "total", "rank", …), matched by its name for raw columns. */
async function gridCol(kind, name) {
  const c = await page.evaluate(([k, n]) => {
    const th = [...document.querySelectorAll('.gt-grid thead th.h-' + k)]
      .find((h) => !n || (h.querySelector('.h-name') && h.querySelector('.h-name').textContent.trim() === n));
    return th ? th.getAttribute('data-c') : null;
  }, [kind, name || null]);
  assert.ok(c !== null, 'grid column not found: ' + kind + ' ' + (name || ''));
  return c;
}

function gridCell(sid, c) {
  return page.locator(`.gt-grid tbody tr[data-sid="${sid}"] td[data-c="${c}"]`);
}

/** Active students in name order (id, raw Test 1, total). */
async function studentsByName() {
  return page.evaluate(() => {
    const c = GT.store.course(), r = GT.store.results();
    return GT.calc.sortStudents(c, r, 'name', 'asc').map((s) => ({
      id: s.id, no: s.no, status: s.status, teamId: s.teamId, total: r.byId[s.id].total,
      t1: r.byId[s.id].items.a_t1.raw, t2: r.byId[s.id].items.a_t2.raw
    }));
  });
}

function historyCount() { return page.evaluate(() => GT.store.course().history.length); }
function historySince(n) { return page.evaluate((k) => GT.store.course().history.slice(k), n); }

async function openMenuItem(buttonSel, label) {
  await page.click(buttonSel);
  await page.locator('.menu [role="menuitem"]', { hasText: label }).first().click();
}

// Stage 2b helpers: drop-down cells, final letters, finalize.

/** Student ids of the grid rows, top to bottom. */
function rowIds() {
  return page.evaluate(() => [...document.querySelectorAll('.gt-grid tbody tr.gr')].map((tr) => tr.getAttribute('data-sid')));
}

/** Student ids in a fresh sort of the current data ('name' | 'total', 'asc' | 'desc'). */
function freshOrder(key, dir) {
  return page.evaluate(([k, d]) => GT.calc.sortStudents(GT.store.course(), GT.store.results(), k, d).map((s) => s.id), [key, dir]);
}

/** Waits until the grid rows are in a fresh sort order. */
async function waitRowsSorted(key, dir) {
  await page.waitForFunction(([k, d]) => {
    const want = GT.calc.sortStudents(GT.store.course(), GT.store.results(), k, d).map((s) => s.id).join();
    return [...document.querySelectorAll('.gt-grid tbody tr.gr')].map((tr) => tr.getAttribute('data-sid')).join() === want;
  }, [key, dir]);
}

/** Picks "Total high–low" in the grid's Sort select and waits for the new row order. */
async function sortTotalDesc() {
  await page.selectOption('.grid-toolbar .grid-sort-select', 'total:desc');
  await waitRowsSorted('total', 'desc');
}

/** The first n consecutive grid rows (from row index `from`) that are all active students. */
async function activeRun(n, from = 0) {
  const ids = await rowIds();
  const st = await page.evaluate((a) => a.map((id) => GT.model.findStudent(GT.store.course(), id).status), ids);
  for (let i = from; i + n <= ids.length; i++) {
    if (st.slice(i, i + n).every((x) => x === 'active')) return ids.slice(i, i + n);
  }
  throw new Error('no run of ' + n + ' active rows');
}

/** Selects a block of rows in grid column c: click the first row, Shift+click the last. */
async function selectRows(ids, c) {
  await gridCell(ids[0], c).click();
  await gridCell(ids[ids.length - 1], c).click({ modifiers: ['Shift'] });
}

function finalLetters(ids) {
  return page.evaluate((a) => a.map((id) => GT.model.findStudent(GT.store.course(), id).finalLetter), ids);
}

function clearToasts() {
  return page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
}

/** Waits for a toast whose text matches re. */
function waitToast(re) {
  return page.waitForFunction(([src, flags]) => [...document.querySelectorAll('#toasts .toast')].some((t) => new RegExp(src, flags).test(t.textContent)),
    [re.source, re.flags]);
}

/** Visible text of a grid cell without its screen-reader-only parts. */
function cellText(sid, c) {
  return gridCell(sid, c).evaluate((td) => {
    const x = td.cloneNode(true);
    x.querySelectorAll('.sr-only').forEach((e) => e.remove());
    return x.textContent.trim();
  });
}

/** Dispatches a paste of plain text on the focused grid cell (as Ctrl+V with Excel data would). */
function pasteText(text) {
  return page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

// Stage 3 helpers: the Attendance tab.

/** Opens the Attendance tab (per-session mode) and waits for the marking grid with every student row. */
async function gotoAttendanceGrid() {
  await gotoView('attendance');
  await page.waitForFunction((n) => document.querySelectorAll('.att-grid tbody tr[data-sid]').length === n, SAMPLE_STUDENTS);
}

/** Attendance grid cell of a student for the session at index j of course.attendance.sessions. */
function attCell(sid, j) {
  return page.locator(`.att-grid tbody tr[data-sid="${sid}"] > td:nth-child(${4 + j})`);
}

/** The stored mark ('P' | 'A' | 'E' | '') of a student for the session at index j. */
function markOf(sid, j) {
  return page.evaluate(([s, k]) => {
    const c = GT.store.course(), ses = c.attendance.sessions[k];
    const row = c.attendance.records[s] || {};
    return row[ses.id] || '';
  }, [sid, j]);
}

/** Selects sessions j0..j1 of one student in the attendance grid (click, then Shift+click). */
async function selectAttRange(sid, j0, j1) {
  await attCell(sid, j0).click();
  if (j1 !== j0) await attCell(sid, j1).click({ modifiers: ['Shift'] });
}

/** An active student with no attendance warning and no threshold highlight (the first in name order). */
function quietStudent(skip = []) {
  return page.evaluate((sk) => {
    const c = GT.store.course();
    const s = GT.calc.sortStudents(c, GT.store.results(), 'name', 'asc').find((x) => {
      const sm = GT.attendance.summary(c, x.id);
      return x.status === 'active' && !sk.includes(x.id) && !sm.warning && !sm.overThreshold && sm.longestStreak < 2;
    });
    return s.id;
  }, skip);
}

/** Totals, letters and ranks of every student: attendance must never change them (T5, T6). */
function gradeSnapshot() {
  return page.evaluate(() => {
    const r = GT.store.results();
    return JSON.stringify(Object.keys(r.byId).sort().map((id) => [id, r.byId[id].total, r.byId[id].letter, r.byId[id].rank, r.byId[id].percentile]));
  });
}

/** Summary cells of the attendance grid that differ from GT.attendance.summary (empty when all match). */
function attSummaryMismatches() {
  return page.evaluate(() => {
    const c = GT.store.course(), bad = [];
    const pct = (x) => (typeof x === 'number' ? GT.util.formatPercent(x, 1) : '—');
    document.querySelectorAll('.att-grid tbody tr[data-sid]').forEach((tr) => {
      const sid = tr.getAttribute('data-sid');
      const sm = GT.attendance.summary(c, sid);
      const txt = (cls) => tr.querySelector('.' + cls).textContent.trim();
      const want = { 'sr-exc': String(sm.excused), 'sr-unx': String(sm.unexcused), 'sr-tot': String(sm.totalAbsences),
        'sr-arate': pct(sm.absenceRate), 'sr-urate': pct(sm.unexcusedRate), 'sr-streak': String(sm.longestStreak) };
      Object.keys(want).forEach((k) => { if (txt(k) !== want[k]) bad.push(sid + ' ' + k + ': ' + txt(k) + ' != ' + want[k]); });
      if (tr.querySelector('.sr-unx').classList.contains('over') !== sm.overThreshold) bad.push(sid + ' threshold highlight');
      if (tr.querySelector('.sr-tot').classList.contains('over') !== sm.overTotalThreshold) bad.push(sid + ' total highlight');
    });
    return bad;
  });
}

/** Absence cells of the Grades grid that differ from GT.attendance.summary; also returns the row count.
 * A withdrawn student shows the numbers but never a warning icon (warnings cover active students only). */
function gridAbsenceMismatches() {
  return page.evaluate(() => {
    const c = GT.store.course(), bad = [];
    const col = (k) => { const th = document.querySelector('.gt-grid thead th.h-' + k); return th ? th.getAttribute('data-c') : null; };
    const cs = { attExc: col('attExc'), attUnx: col('attUnx'), attTot: col('attTot') };
    if (!cs.attExc || !cs.attUnx || !cs.attTot) return { rows: 0, bad: ['absence columns missing'] };
    const rows = [...document.querySelectorAll('.gt-grid tbody tr.gr')];
    rows.forEach((tr) => {
      const sid = tr.getAttribute('data-sid');
      const sm = GT.attendance.summary(c, sid);
      const text = (k) => {
        const td = tr.querySelector('td[data-c="' + cs[k] + '"]').cloneNode(true);
        td.querySelectorAll('.sr-only').forEach((x) => x.remove());
        return td.textContent.trim();
      };
      const got = [text('attExc'), text('attUnx'), text('attTot')].join(' ');
      const want = [sm.excused, sm.unexcused, sm.totalAbsences].join(' ');
      if (got !== want) bad.push(sid + ': ' + got + ' != ' + want);
      const unx = tr.querySelector('td[data-c="' + cs.attUnx + '"]');
      const wd = GT.model.findStudent(c, sid).status === 'withdrawn';
      const flagged = !wd && !!(sm.warning || sm.overThreshold);
      if (!!unx.querySelector('.mk-att') !== flagged) bad.push(sid + ': warning icon ' + !flagged);
    });
    return { rows: rows.length, bad };
  });
}

// Stage 4 helpers: the Import / Export tab. Downloads and test files go to TMP (outside the repository).

const ExcelJS = require(path.join(ROOT, 'vendor', 'exceljs.min.js'));
const miniExcel = require(path.join(ROOT, 'tests', 'helpers', 'mini-excel.js'));
const csvCore = require(path.join(ROOT, 'js', 'core', 'csv.js'));

/** Headers of the default export preset for SE 4351: the previous TA's sheet, then the absences and Status. */
const PREVIOUS_LAYOUT = ['No', 'Last Name', 'First Name', 'Project I', 'Project II', 'Test 1', 'Test 2', 'Class/Project Participation',
  'Project I 10%', 'Project II 20%', 'Test 1 25%', 'Test 2 40%', 'Class/Project Participation 5%', 'Total', 'Letter Grade',
  'Excused (allowed)', 'Unexcused (not allowed)', 'Total absences', 'Status'];

/** The previous TA's sheet, column by column (the 15th header is blank). */
const OLD_SHEET_HEADERS = ['No', 'Last Name', 'First Name', 'Final Project I', 'Final Project II', 'Test 1', 'Test 2',
  'Project I 10%', 'Project II 20%', 'Test 1 25%', 'Test 2 40%', 'Class Participation 5%', 'Total', 'Letter Grade', '', 'No of Absence'];

/** Clicks a download button of the Export card and saves the file in TMP as "<tag>-<suggested name>". */
async function downloadFrom(sel, tag) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click(sel)]);
  const name = dl.suggestedFilename();
  const file = path.join(TMP, tag + '-' + name);
  await dl.saveAs(file);
  return { file, name };
}

/** One entry of a .zip file (an .xlsx is a zip) as text. */
function readZipEntry(buf, name) {
  const b = Buffer.from(buf);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'not a zip file');
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0, n = b.readUInt16LE(eocd + 10); i < n; i++) {
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    if (b.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('No ' + name + ' in the zip');
}

/** The downloaded .xlsx read back with the vendored ExcelJS: { wb, ws (sheet "Grades"), header }. */
async function readXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(file));
  const ws = wb.getWorksheet('Grades');
  assert.ok(ws, 'no "Grades" sheet');
  return { wb, ws, header: ws.getRow(1).values.slice(1) };
}

/** Every cell of an ExcelJS worksheet as a mini-excel sheet (formulas stay formulas), to recalculate it. */
function miniSheet(ws) {
  const cells = {};
  ws.eachRow((row) => row.eachCell((cell) => {
    const v = cell.value;
    cells[cell.address] = v && typeof v === 'object' && typeof v.formula === 'string' ? { formula: v.formula } : v;
  }));
  return miniExcel.createSheet(cells);
}

function noteText(n) {
  if (typeof n === 'string') return n;
  return n && Array.isArray(n.texts) ? n.texts.map((t) => t.text).join('') : '';
}

/** What the app shows for every student of the active course, in name order (the export's row order). */
function appRows() {
  return page.evaluate(() => {
    const c = GT.store.course(), r = GT.store.results();
    return GT.calc.sortStudents(c, r, 'name', 'asc').map((s) => {
      const x = r.byId[s.id], sm = GT.attendance.summary(c, s.id);
      return {
        id: s.id, no: s.no, last: s.lastName, first: s.firstName, status: s.status, total: x.total, letter: x.letter,
        effective: x.effectiveLetter, source: x.letterSource,
        weighted: c.assessments.map((a) => x.items[a.id].weightedUnrounded),
        att: [sm.excused, sm.unexcused, sm.totalAbsences]
      };
    });
  });
}

/** Imports a file through the Import card (steps 1-4 with the guessed mapping, then Import).
 * atMapping(state) runs on step 3 and atPreview(state) on step 4 (state = GT.views.exchange.importState()). */
async function importThroughCard(file, { atMapping, atPreview } = {}) {
  await gotoView('exchange');
  await page.setInputFiles('#xc-file', file);
  await page.locator('#xc-next-2, .xc-imp-error').first().waitFor();
  const err = page.locator('.xc-imp-error');
  if (await err.count()) throw new Error('import refused the file: ' + (await err.innerText()));
  await page.click('#xc-next-2');
  await page.locator('#xc-next-3').waitFor();
  const mapped = await page.evaluate(() => GT.views.exchange.importState());
  if (atMapping) await atMapping(mapped);
  await page.click('#xc-next-3');
  await page.locator('#xc-import-btn').waitFor();
  const preview = await page.evaluate(() => GT.views.exchange.importState());
  if (atPreview) await atPreview(preview);
  await page.click('#xc-import-btn');
  await page.locator('.xc-done').waitFor();
  return { mapping: mapped.mapping, options: mapped.options, counts: preview.counts };
}

/** The raw value stored under a key of the app's IndexedDB object store (undefined if none). */
function idbStored(key) {
  return page.evaluate((k) => new Promise((resolve, reject) => {
    const r = indexedDB.open('grade-tracker', 1);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const g = r.result.transaction('kv', 'readonly').objectStore('kv').get(k);
      g.onsuccess = () => { r.result.close(); resolve(g.result); };
      g.onerror = () => reject(g.error);
    };
  }), key);
}

/** Runs fn(page) in a separate browser context whose IndexedDB is disabled (localStorage backend).
 * init(arg) runs before the app on every load of that page. */
async function withLocalStoragePage(init, arg, fn) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  try {
    const p = await ctx.newPage();
    p.setDefaultTimeout(10000);
    watch(p);
    await p.addInitScript(([initSrc, a]) => {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
      if (initSrc) (0, eval)('(' + initSrc + ')')(a);
    }, [init ? init.toString() : '', arg === undefined ? null : arg]);
    await p.goto(APP_URL);
    await p.waitForFunction(() => window.GT && GT.store && GT.store.state && document.querySelector('#tabs .tab'));
    await fn(p);
  } finally {
    await ctx.close();
  }
}

// Stage 5 helpers: the Statistics tab.

/** Resolves once the app has drawn the current data: a store change re-renders on the next animation
 * frame (app.js requestRender), so two frames later every view shows it. For checks that expect the
 * screen NOT to change (a withdrawn student's edit), where there is nothing new to wait for. */
function rendered() {
  return page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
}

/** Opens the Statistics tab and waits until its panel counts the active students of the current data. */
async function gotoStats() {
  await gotoView('stats');
  await page.waitForFunction(() => {
    const el = document.querySelector('#st-overview [data-stat="count"]');
    return el && Number(el.getAttribute('data-v')) === GT.stats.activeTotals(GT.store.course(), GT.store.results()).length;
  });
}

/** The eLearning-style panel as shown: { <stat>: { v (data-v), text } }, bins (the 12 counts, panel
 * order) and status ({ <key>: count } of STATUS DISTRIBUTION). */
function statsPanel() {
  return page.evaluate(() => {
    const out = { bins: [], status: {} };
    document.querySelectorAll('#st-overview [data-stat]').forEach((td) => {
      out[td.getAttribute('data-stat')] = { v: td.getAttribute('data-v'), text: td.textContent.trim() };
    });
    out.bins = [...document.querySelectorAll('#st-overview [data-bin]')].map((td) => Number(td.textContent.trim()));
    document.querySelectorAll('#st-overview [data-status]').forEach((td) => { out.status[td.getAttribute('data-status')] = Number(td.textContent.trim()); });
    return out;
  });
}

// Stage 6 helpers: late work and the Summary tab.

/** Selects a grid cell and opens "Late work…" with Ctrl+L; returns the dialog. */
async function openLateWork(sid, c) {
  await gridCell(sid, c).click();
  await page.keyboard.press('Control+l');
  const dlg = page.locator('dialog[open].late-dialog');
  await dlg.waitFor();
  return dlg;
}

/** Opens the Summary tab and waits until its grade table shows the current students. */
async function gotoSummary() {
  await gotoView('summary');
  await page.waitForFunction(() => {
    const t = document.querySelector('.view-summary .sum-grades');
    const ids = new Set(GT.store.course().students.map((s) => s.id));
    const rows = t ? [...t.querySelectorAll('tbody tr[data-sid]')] : [];
    return rows.length > 0 && rows.every((tr) => ids.has(tr.getAttribute('data-sid')));
  });
}

/** The Summary grade table as shown: rows top to bottom { sid, wd, no, total, letter, rank } and the
 * letter column's header. Footnote markers (<sup>) are left out of the cell text. */
function summaryTable() {
  return page.evaluate(() => {
    const t = document.querySelector('.view-summary .sum-grades');
    const txt = (el) => (el ? [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.tagName === 'SUP')).map((n) => n.textContent).join('').trim() : null);
    const rows = [...t.querySelectorAll('tbody tr[data-sid]')].map((tr) => ({
      sid: tr.getAttribute('data-sid'), wd: tr.classList.contains('sum-wd'), no: txt(tr.querySelector('.sum-c-no')),
      total: txt(tr.querySelector('.sum-c-total')), letter: txt(tr.querySelector('.sum-c-letter')), rank: txt(tr.querySelector('.sum-c-rank'))
    }));
    return { rows, letterHead: t.querySelector('thead th.sum-c-letter').textContent.replace(/\s+/g, ' ').trim() };
  });
}

/** What the Summary should show for every student: active students by name, then the withdrawn ones
 * (letter "W", no rank); the letter is the effective one, "—" for a student without a final letter
 * once some final letters exist. */
function summaryExpected() {
  return page.evaluate(() => {
    const c = GT.store.course(), r = GT.store.results(), d = c.settings.decimals;
    const sorted = GT.calc.sortStudents(c, r, 'name', 'asc');
    const anyFinal = r.letterSummary.assigned > 0;
    return sorted.filter((s) => r.byId[s.id].active).concat(sorted.filter((s) => !r.byId[s.id].active)).map((s) => {
      const x = r.byId[s.id];
      return {
        sid: s.id, wd: !x.active, no: String(s.no), total: GT.util.formatNumber(x.total, d, { fixed: true }),
        letter: !x.active ? 'W' : anyFinal ? (s.finalLetter || '—') : x.effectiveLetter,
        rank: x.rank === null ? '—' : String(x.rank)
      };
    });
  });
}

/** Writes a letter over cells of the "Letter Grade" column of an exported .xlsx, as a spreadsheet user
 * would: edits(ws, col, rowOf) changes the sheet, then the copy is saved as dst. */
async function editExport(src, dst, edits) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(src));
  const ws = wb.getWorksheet('Grades');
  const header = ws.getRow(1).values.slice(1);
  const col = (name) => header.indexOf(name) + 1;
  const rowOf = (last, first) => {
    for (let r = 2; r <= ws.rowCount; r++) {
      if (ws.getCell(r, col('Last Name')).value === last && ws.getCell(r, col('First Name')).value === first) return r;
    }
    throw new Error('no row for ' + last + ', ' + first);
  };
  await edits(ws, col, rowOf);
  fs.writeFileSync(dst, Buffer.from(await wb.xlsx.writeBuffer()));
}

/** The cached text of a cell (a formula's result, or its value). */
function cellValue(cell) {
  const v = cell.value;
  return v && typeof v === 'object' && 'result' in v ? v.result : v;
}

// ------------------------------------------------------------------ checks

async function run() {
  const pw = loadPlaywright();
  browser = await pw.chromium.launch();
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  watch(page);

  await check('boot with empty storage: two empty courses, IndexedDB, empty state', async () => {
    await page.goto(APP_URL);
    await ready();
    const info = await page.evaluate(() => ({
      courses: GT.store.state.courses.map((c) => c.code + ':' + c.students.length),
      backend: GT.storage.backend(),
      view: GT.store.state.ui.activeView
    }));
    assert.deepEqual(info.courses, ['SE 4351:0', 'SE 6362:0']);
    assert.equal(info.backend, 'indexeddb');
    assert.equal(info.view, 'grades');
    await page.locator('#view .empty-state').waitFor();
  });

  await check('a fresh profile is saved at boot, before any edit', async () => {
    let stored;
    for (let i = 0; i < 20 && !stored; i++) {
      stored = await idbStored('state');
      if (!stored) await page.waitForTimeout(100);
    }
    assert.ok(stored, 'IndexedDB has no "state" after boot');
    const courses = JSON.parse(stored).courses.map((c) => c.id);
    assert.deepEqual(courses, await page.evaluate(() => GT.store.state.courses.map((c) => c.id)));
  });

  await check('load sample data from the course menu: 59 students in SE 4351', async () => {
    await openMenuItem('#btn-course-menu', 'Load sample data');
    await page.locator('dialog[open] .btn-primary').click();
    await page.waitForFunction(() => GT.store.course().students.length > 0);
    const c = await page.evaluate(() => {
      const co = GT.store.course();
      const last = co.history[co.history.length - 1];
      return { code: co.code, n: co.students.length, teams: co.teams.length, kind: last.kind, source: last.source };
    });
    assert.equal(c.code, 'SE 4351');
    assert.equal(c.n, SAMPLE_STUDENTS);
    assert.equal(c.teams, 8);
    assert.equal(c.kind, 'bulk');
    assert.equal(c.source, 'sample');
  });

  await check('every tab renders without an error', async () => {
    await resetSample();
    const tabs = await page.$$eval('#tabs .tab', (els) => els.map((e) => e.getAttribute('data-view')));
    assert.ok(tabs.length >= 4, 'expected at least 4 tabs, got ' + tabs.join(','));
    for (const id of tabs) {
      await gotoView(id);
      const failed = await page.locator('#view .callout-danger', { hasText: 'failed to render' }).count();
      assert.equal(failed, 0, 'view ' + id + ' failed to render');
    }
    // The other course (no students) shows the empty state in the grid.
    await gotoView('grades');
    const other = await page.evaluate(() => GT.store.state.courses[1].id);
    await page.selectOption('#course-select', other);
    await page.locator('#view .empty-state').waitFor();
    await page.selectOption('#course-select', await page.evaluate(() => GT.store.state.courses[0].id));
    await page.waitForFunction((n) => document.querySelectorAll('.gt-grid tbody tr.gr').length === n, SAMPLE_STUDENTS);
  });

  await check('grid shows 59 rows and every Total equals GT.store.results()', async () => {
    await resetSample();
    assert.equal(await page.locator('.gt-grid tbody tr.gr').count(), SAMPLE_STUDENTS);
    const totalC = await gridCol('total');
    const mismatches = await page.evaluate((c) => {
      const r = GT.store.results(), d = GT.store.course().settings.decimals, bad = [];
      document.querySelectorAll('.gt-grid tbody tr.gr').forEach((tr) => {
        const want = GT.util.formatNumber(r.byId[tr.getAttribute('data-sid')].total, d);
        const td = tr.querySelector('td[data-c="' + c + '"]').cloneNode(true);
        td.querySelectorAll('.sr-only').forEach((x) => x.remove()); // "incomplete" for screen readers
        const got = td.textContent.trim();
        if (got !== want) bad.push(tr.getAttribute('data-sid') + ': ' + got + ' != ' + want);
      });
      return bad;
    }, totalC);
    assert.deepEqual(mismatches, []);
    // One student checked by hand: raw / max x weight, i.e. 10% + 20% + 25% + 40% of the scores out
    // of 100, plus participation out of 5 at 5% (DECISIONS 1: its raw score is its points).
    const one = await page.evaluate(() => {
      const c = GT.store.course(), s = GT.calc.sortStudents(c, GT.store.results(), 'name', 'asc')[0];
      const it = GT.store.results().byId[s.id].items;
      const manual = it.a_p1.raw * 0.10 + it.a_p2.raw * 0.20 + it.a_t1.raw * 0.25 + it.a_t2.raw * 0.40 + it.a_part.raw * 5 / 5;
      const generic = c.assessments.reduce((sum, a) => sum + (it[a.id].raw || 0) * a.weight / a.maxScore, 0);
      return { manual, generic, total: GT.store.results().byId[s.id].total };
    });
    assert.ok(Math.abs(one.generic - one.total) < 1e-9, 'total ' + one.total + ' != raw / max x weight ' + one.generic);
    assert.ok(Math.abs(one.manual - one.total) < 1e-9, 'total ' + one.total + ' != hand sum ' + one.manual);
  });

  await check('keyboard edit of a Test 1 cell updates the Total and logs a history entry', async () => {
    await resetSample();
    const s = (await studentsByName()).find((x) => x.status === 'active' && typeof x.t1 === 'number' && x.t1 !== 77);
    const t1C = await gridCol('raw', 'Test 1');
    const totalC = await gridCol('total');
    const n = await historyCount();
    await gridCell(s.id, t1C).click();
    await page.keyboard.type('77');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.raw === 77, s.id);
    const total = await page.evaluate((id) => GT.store.results().byId[id].total, s.id);
    const expected = s.total - s.t1 * 0.25 + 77 * 0.25;
    assert.ok(Math.abs(total - expected) < 1e-9, 'total ' + total + ' != expected ' + expected);
    const want = await page.evaluate((t) => GT.util.formatNumber(t, GT.store.course().settings.decimals), total);
    // The view re-renders on the next animation frame: wait for the displayed Total.
    await page.waitForFunction(([id, c, w]) => {
      const td = document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"] td[data-c="' + c + '"]');
      if (!td) return false;
      const x = td.cloneNode(true);
      x.querySelectorAll('.sr-only').forEach((e) => e.remove());
      return x.textContent.trim() === w;
    }, [s.id, totalC, want]);
    const added = await historySince(n);
    assert.equal(added.length, 1, 'expected 1 history entry, got ' + added.length);
    assert.equal(added[0].kind, 'score');
    assert.equal(added[0].field, 'Test 1');
    assert.equal(added[0].oldValue, String(s.t1));
    assert.equal(added[0].newValue, '77');
    assert.equal(added[0].source, 'edit');
    assert.equal(added[0].studentId, s.id);
    // Enter moved the active cell down, and the History tab shows the change on top.
    await gotoView('history');
    const top = await page.locator('.hist-table tbody tr').first().innerText();
    assert.match(top, /Test 1/);
    assert.match(top, /77/);
  });

  await check('team score edit propagates to every member of the team except the override', async () => {
    await resetSample();
    const t = await page.evaluate(() => {
      const c = GT.store.course();
      for (const s of c.students) {
        for (const a of c.assessments) {
          const e = GT.model.getEntry(c.scores, s.id, a.id);
          if (a.teamGraded && s.teamId && e && e.override === true) {
            const members = GT.model.teamMembers(c, s.teamId).map((m) => m.id);
            return { aid: a.id, name: a.name, teamId: s.teamId, ovr: s.id, ovrRaw: e.value, members };
          }
        }
      }
      return null;
    });
    assert.ok(t, 'sample data should contain a per-member override');
    const target = t.members.find((m) => m !== t.ovr);
    const col = await gridCol('raw', t.name);
    const n = await historyCount();
    await gridCell(target, col).click();
    await page.keyboard.type('66');
    await page.keyboard.press('Enter');
    await page.waitForFunction(([tid, aid]) => {
      const e = GT.model.getEntry(GT.store.course().teamScores, tid, aid);
      return e && e.value === 66;
    }, [t.teamId, t.aid]);
    const seen = await page.evaluate(([ids, aid]) => ids.map((id) => {
      const d = GT.store.results().byId[id].items[aid];
      return { id, raw: d.raw, source: d.source };
    }), [t.members, t.aid]);
    for (const m of seen) {
      if (m.id === t.ovr) {
        assert.equal(m.source, 'override');
        assert.equal(m.raw, t.ovrRaw, 'the override member keeps their own score');
      } else {
        assert.equal(m.source, 'team');
        assert.equal(m.raw, 66, 'member ' + m.id + ' should see the new team score');
      }
    }
    const added = await historySince(n);
    const teamEntries = added.filter((h) => h.kind === 'team-score');
    assert.equal(teamEntries.length, 1);
    assert.equal(teamEntries[0].teamId, t.teamId);
    const propagated = added.filter((h) => h.kind === 'propagation').map((h) => h.studentId);
    assert.ok(!propagated.includes(t.ovr), 'no propagation entry for the override member');
    assert.ok(propagated.length >= 1, 'propagation entries are logged');
    // The ◆ marker stays on the override member's cell.
    assert.equal(await gridCell(t.ovr, col).locator('.mk-ovr').count(), 1);
  });

  await check('withdrawing a student removes them from rank, percentile and the class average', async () => {
    await resetSample();
    const top = await page.evaluate(() => {
      const r = GT.store.results();
      const id = r.activeIds.find((x) => r.byId[x].rank === 1);
      return { id, avg: r.average, n: r.activeIds.length };
    });
    await gotoView('students');
    await page.click(`.view-students button[data-act="status"][data-id="${top.id}"]`);
    await page.locator('dialog[open] .btn-primary', { hasText: 'Withdraw' }).click();
    await page.waitForFunction((id) => GT.store.results().byId[id].active === false, top.id);
    const after = await page.evaluate((id) => {
      const r = GT.store.results();
      const others = r.activeIds.map((x) => r.byId[x].total);
      return {
        rank: r.byId[id].rank, pct: r.byId[id].percentile, diff: r.byId[id].diffFromAverage,
        inActive: r.activeIds.includes(id), avg: r.average,
        mean: others.reduce((a, b) => a + b, 0) / others.length,
        hasRank1: r.activeIds.some((x) => r.byId[x].rank === 1), n: r.activeIds.length
      };
    }, top.id);
    assert.equal(after.rank, null);
    assert.equal(after.pct, null);
    assert.equal(after.diff, null);
    assert.equal(after.inActive, false);
    assert.equal(after.n, top.n - 1);
    assert.ok(Math.abs(after.avg - after.mean) < 1e-9, 'average ' + after.avg + ' != mean of active ' + after.mean);
    assert.ok(after.avg < top.avg, 'removing the top student lowers the average');
    assert.ok(after.hasRank1, 'another student is now rank 1');
    await gotoView('grades');
    const row = page.locator(`.gt-grid tbody tr[data-sid="${top.id}"]`);
    assert.match(await row.getAttribute('class'), /row-withdrawn/);
    const rankC = await gridCol('rank');
    assert.equal((await gridCell(top.id, rankC).textContent()).trim(), '—');
  });

  await check('paste of a 3x2 TSV block from Excel is one undoable transaction', async () => {
    await resetSample();
    const rows = (await studentsByName()).slice(0, 3);
    const t1C = await gridCol('raw', 'Test 1');
    const t2C = await gridCol('raw', 'Test 2');
    assert.equal(Number(t2C), Number(t1C) + 1, 'Test 2 follows Test 1');
    const n = await historyCount();
    await gridCell(rows[0].id, t1C).click();
    await page.evaluate((tsv) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', tsv);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, '11\t12\r\n13\t14\r\n15\tabc\r\n');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.raw === 15, rows[2].id);
    const got = await page.evaluate((ids) => ids.map((id) => {
      const it = GT.store.results().byId[id].items;
      return [it.a_t1.raw, it.a_t2.state === 'invalid' ? it.a_t2.text : it.a_t2.raw];
    }), rows.map((r) => r.id));
    assert.deepEqual(got, [[11, 12], [13, 14], [15, 'abc']]);
    const added = await historySince(n);
    assert.equal(added.length, 6);
    assert.ok(added.every((h) => h.source === 'paste' && h.kind === 'score'), 'all entries are paste scores');
    await page.waitForFunction(([id, c]) => {
      const td = document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"] td[data-c="' + c + '"]');
      return td && td.classList.contains('is-invalid') && td.textContent.trim() === 'abc';
    }, [rows[2].id, t2C]); // invalid text is kept and highlighted
    assert.match(await page.evaluate(() => GT.store.undoLabel()), /^Paste 6 cells$/);
    await page.keyboard.press('Control+z');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.raw !== 15, rows[2].id);
    const back = await page.evaluate((ids) => ids.map((id) => GT.store.results().byId[id].items.a_t1.raw), rows.map((r) => r.id));
    assert.deepEqual(back, rows.map((r) => r.t1), 'one undo reverts the whole paste');
  });

  await check('undo and redo (keyboard and toolbar) restore values and append history', async () => {
    await resetSample();
    const s = (await studentsByName()).find((x) => typeof x.t2 === 'number' && x.t2 !== 55);
    const t2C = await gridCol('raw', 'Test 2');
    await gridCell(s.id, t2C).click();
    await page.keyboard.type('55');
    await page.keyboard.press('Enter');
    const t2 = () => page.evaluate((id) => GT.store.results().byId[id].items.a_t2.raw, s.id);
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t2.raw === 55, s.id);
    const n = await historyCount();
    await page.keyboard.press('Control+z');
    await page.waitForFunction(([id, v]) => GT.store.results().byId[id].items.a_t2.raw === v, [s.id, s.t2]);
    const undoEntries = await historySince(n);
    assert.equal(undoEntries.length, 1);
    assert.equal(undoEntries[0].source, 'undo');
    await page.locator('#btn-redo:not([disabled])').waitFor(); // the header re-renders on the next frame
    await page.keyboard.press('Control+y');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t2.raw === 55, s.id);
    assert.equal((await historySince(n + 1))[0].source, 'redo');
    await page.click('#btn-undo');
    assert.equal(await t2(), s.t2);
    await page.click('#btn-redo');
    assert.equal(await t2(), 55);
    assert.ok((await historyCount()) === n + 4, 'history is append-only: undo/redo add entries');
  });

  await check('course menu (C3): add a course from the SE 6362 template (graduate), rename it, duplicate it and delete it; the other courses keep their data', async () => {
    await resetSample();
    const before = await page.evaluate(() => GT.store.state.courses.map((c) => c.id + ':' + c.students.length + ':' + c.history.length));
    await openMenuItem('#btn-course-menu', 'Add course');
    let dlg = page.locator('dialog[open]', { hasText: 'Add course' });
    await dlg.waitFor();
    await dlg.locator('[name="template"]').selectOption('SE6362');
    assert.equal(await dlg.locator('[name="level"]').inputValue(), 'graduate', 'the template sets its level');
    await dlg.locator('[name="code"]').fill('SE 9999');
    await dlg.locator('[name="title"]').fill('Smoke Course');
    await dlg.locator('.btn-primary').click();
    await page.waitForFunction(() => GT.store.course().code === 'SE 9999');
    const added = await page.evaluate(() => {
      const c = GT.store.course();
      return { id: c.id, n: GT.store.state.courses.length, students: c.students.length, level: c.level, title: c.title,
        letters: GT.model.scaleLetters(c).join(' '), paper: c.assessments.some((a) => a.id === 'a_paper') };
    });
    const { id: addedId, ...shape } = added;
    assert.ok(addedId);
    assert.deepEqual(shape, { n: 3, students: 0, level: 'graduate', title: 'Smoke Course', letters: 'A A- B+ B B- C+ C F', paper: true });
    await page.locator('#view .empty-state, #view .grid-empty').first().waitFor();
    await openMenuItem('#btn-course-menu', 'Edit course details');
    dlg = page.locator('dialog[open]', { hasText: 'Edit course details' });
    await dlg.waitFor();
    await dlg.locator('[name="title"]').fill('Smoke Course Renamed');
    await dlg.locator('.btn-primary').click();
    await page.waitForFunction(() => GT.store.course().title === 'Smoke Course Renamed' && /Smoke Course Renamed/.test(document.querySelector('#course-select option:checked').textContent));
    await openMenuItem('#btn-course-menu', 'Duplicate course');
    await page.waitForFunction((id) => GT.store.state.courses.length === 4 && GT.store.course().id !== id, added.id);
    const copy = await page.evaluate(() => ({ id: GT.store.course().id, title: GT.store.course().title }));
    assert.equal(copy.title, 'Smoke Course Renamed');
    // Delete the copy and the added course (typed confirmation).
    for (const id of [copy.id, added.id]) {
      await page.selectOption('#course-select', id);
      await page.waitForFunction((x) => GT.store.course().id === x, id);
      const code = await page.evaluate(() => GT.store.course().code);
      await openMenuItem('#btn-course-menu', 'Delete course');
      dlg = page.locator('dialog[open]', { hasText: 'Delete course' });
      await dlg.waitFor();
      await page.fill('#dlg-require', code);
      await dlg.locator('.btn-primary').click();
      await page.waitForFunction((x) => !GT.store.state.courses.some((c) => c.id === x), id);
    }
    assert.deepEqual(await page.evaluate(() => GT.store.state.courses.map((c) => c.id + ':' + c.students.length + ':' + c.history.length)), before);
  });

  await check('Paste roster (S3): No, Last Name, First Name and Team copied from Excel add the students and their new teams in one undoable step', async () => {
    await resetSample();
    const other = await page.evaluate(() => GT.store.state.courses.find((c) => c.template === 'SE6362').id);
    await page.selectOption('#course-select', other);
    await page.waitForFunction((id) => GT.store.course().id === id && GT.store.course().students.length === 0, other);
    await gotoView('students');
    await page.locator('.view-students [data-act="paste"]').first().click();
    const dlg = page.locator('dialog[open].roster-dlg');
    await dlg.waitFor();
    await page.fill('#rp-text', 'No\tLast Name\tFirst Name\tTeam\r\n1\tRoster\tOne\tTeam 1\r\n2\tRoster\tTwo\tTeam 1\r\n3\tRoster\tThree\tTeam 2\r\n');
    await page.waitForFunction(() => /^Add 3 students$/.test(document.querySelector('dialog[open] .dlg-foot .btn-primary').textContent));
    await dlg.locator('.dlg-foot .btn-primary').click();
    await page.waitForFunction(() => GT.store.course().students.length === 3);
    const got = await page.evaluate(() => {
      const c = GT.store.course();
      return c.students.map((s) => [s.no, s.lastName, s.firstName, (GT.model.findTeam(c, s.teamId) || {}).name, s.status]);
    });
    assert.deepEqual(got, [[1, 'Roster', 'One', 'Team 1', 'active'], [2, 'Roster', 'Two', 'Team 1', 'active'], [3, 'Roster', 'Three', 'Team 2', 'active']]);
    assert.equal(await page.evaluate(() => GT.store.undoLabel()), 'Paste roster');
    await page.click('#btn-undo');
    await page.waitForFunction(() => GT.store.course().students.length === 0 && GT.store.course().teams.length === 0);
  });

  await check('Grades search box and "Group by team" (G1, G3): the search filters the rows; grouping puts each student under a team row', async () => {
    await resetSample();
    await page.fill('.grid-toolbar .grid-search', 'Student 05');
    await page.waitForFunction(() => document.querySelectorAll('.gt-grid tbody tr.gr').length === 1);
    const hit = await page.evaluate(() => GT.model.findStudent(GT.store.course(), document.querySelector('.gt-grid tbody tr.gr').getAttribute('data-sid')).lastName);
    assert.equal(hit, 'Student 05');
    await page.fill('.grid-toolbar .grid-search', '');
    await page.waitForFunction((n) => document.querySelectorAll('.gt-grid tbody tr.gr').length === n, SAMPLE_STUDENTS);
    await page.click('.grid-toolbar [data-act="group"]');
    await page.waitForFunction(() => document.querySelectorAll('.gt-grid tbody tr.team-row').length >= GT.store.course().teams.length);
    const misplaced = await page.evaluate(() => {
      const c = GT.store.course(), bad = [];
      let team = null;
      document.querySelectorAll('.gt-grid tbody tr').forEach((tr) => {
        if (tr.classList.contains('team-row')) { team = tr.querySelector('.tl-name').textContent; return; }
        const s = GT.model.findStudent(c, tr.getAttribute('data-sid'));
        const t = s && GT.model.findTeam(c, s.teamId);
        if ((t ? t.name : 'No team') !== team) bad.push(s ? s.lastName : tr.getAttribute('data-sid'));
      });
      return bad;
    });
    assert.deepEqual(misplaced, []);
    await page.click('.grid-toolbar [data-act="group"]');
    await page.waitForFunction(() => !document.querySelector('.gt-grid tbody tr.team-row'));
  });

  // -------------------------------------------------------------- stage 2b: drop-down cells, final letters, finalize

  await check('participation is a drop-down list out of 5 (template max 5); a range is set to 5 in one transaction', async () => {
    await resetSample();
    // Every template (both courses) has participation max 5, weight 5%, list 5, 4.5, ..., 0 (DECISIONS 1, 8).
    const tpl = await page.evaluate(() => GT.store.state.courses.map((c) => {
      const a = c.assessments.find((x) => x.category === 'participation');
      return { code: c.code, max: a.maxScore, weight: a.weight, choices: a.choices, values: GT.model.choiceValues(a) };
    }));
    assert.equal(tpl.length, 2);
    for (const t of tpl) {
      assert.equal(t.max, 5, t.code + ' participation max');
      assert.equal(t.weight, 5, t.code + ' participation weight');
      assert.deepEqual(t.choices, { step: 0.5 });
      assert.deepEqual(t.values, [5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0]);
    }
    const pC = await gridCol('raw', 'Class/Project Participation');
    assert.match(await page.locator(`.gt-grid thead th[data-c="${pC}"]`).innerText(), /max 5 · list/);
    // Five consecutive active rows; two of them start below 5, so the band really changes something.
    const band = await activeRun(5);
    await page.evaluate((ids) => GT.store.transact('Setup', (c) => ids.forEach((id) => GT.model.setEntry(c.scores, id, 'a_part', { value: 3 }))), band.slice(0, 2));
    await page.waitForFunction(([id, c]) => {
      const td = document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"] td[data-c="' + c + '"]');
      return td && td.textContent.trim().startsWith('3');
    }, [band[0], pC]);
    const before = await page.evaluate((ids) => ids.map((id) => GT.store.results().byId[id].items.a_part.raw), band);
    const n = await historyCount();
    await selectRows(band, pC);
    await page.keyboard.press('Enter');
    const dd = page.locator('select.dd-editor');
    await dd.waitFor();
    const list = await dd.evaluate((el) => ({
      labels: [...el.options].map((o) => o.textContent),
      group: el.querySelector('optgroup') ? el.querySelector('optgroup').label : null
    }));
    assert.deepEqual(list.labels, ['(empty)', '5', '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1', '0.5', '0']);
    assert.equal(list.group, 'For 5 students');
    await page.keyboard.type('5'); // type-ahead in the list
    assert.equal(await dd.inputValue(), '5');
    await page.keyboard.press('Enter');
    await page.waitForFunction((ids) => ids.every((id) => GT.store.results().byId[id].items.a_part.raw === 5), band);
    assert.equal(await page.evaluate(() => GT.store.undoLabel()), 'Class/Project Participation 5 for 5 students');
    const added = await historySince(n);
    assert.equal(added.length, before.filter((v) => v !== 5).length, 'one entry per changed student');
    assert.ok(added.every((h) => h.kind === 'score' && h.field === 'Class/Project Participation' && h.newValue === '5'));
    // One undo step reverts the whole range.
    await page.keyboard.press('Control+z');
    await page.waitForFunction(([ids, vals]) => ids.every((id, i) => GT.store.results().byId[id].items.a_part.raw === vals[i]), [band, before]);
  });

  await check('typing or pasting a value that is not on the participation list is rejected; nothing is stored', async () => {
    await resetSample();
    const pC = await gridCol('raw', 'Class/Project Participation');
    const [sid] = await activeRun(1);
    const entry = (id) => page.evaluate((x) => GT.model.getEntry(GT.store.course().scores, x, 'a_part') || null, id);
    const before = await entry(sid);
    const n = await historyCount();
    const editor = page.locator('.gt-grid input.cell-editor');
    await gridCell(sid, pC).click();
    for (const bad of ['4.3', '7', 'abc']) {
      await clearToasts();
      await page.keyboard.type(bad);
      await editor.waitFor();
      assert.equal(await editor.getAttribute('aria-invalid'), 'true', bad + ' is marked red while typing');
      await page.keyboard.press('Enter');
      await waitToast(/^Choose a value from the list \(0–5 in steps of 0\.5\)\.$/);
      assert.equal(await editor.count(), 1, 'the editor stays open to fix ' + bad);
      await page.keyboard.press('Escape');
      await editor.waitFor({ state: 'detached' });
    }
    assert.deepEqual(await entry(sid), before, 'no invalid text is stored in a drop-down cell');
    assert.equal(await historyCount(), n);
    // A value from the list typed straight in is stored.
    await page.keyboard.type('3.5');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_part.raw === 3.5, sid);
    // Paste is validated the same way: values off the list are skipped and reported.
    const rows = await activeRun(3);
    const prev = await page.evaluate((ids) => ids.map((id) => GT.store.results().byId[id].items.a_part.raw), rows);
    await clearToasts();
    await gridCell(rows[0], pC).click();
    await pasteText('4.5\r\n9\r\nx\r\n');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_part.raw === 4.5, rows[0]);
    await waitToast(/2 values were not on the drop-down list/);
    const after = await page.evaluate((ids) => ids.map((id) => GT.store.results().byId[id].items.a_part.raw), rows);
    assert.deepEqual(after.slice(1), prev.slice(1), 'skipped cells keep their value');
  });

  await check('Finalize scores locks score cells (typing is refused with a toast); final letters stay editable', async () => {
    await resetSample();
    const n = await historyCount();
    await page.click('.grid-grades-bar [data-act="finalize"]');
    const dlg = page.locator('dialog[open]', { hasText: 'Data check' });
    await dlg.waitFor();
    const checks = await dlg.locator('.fz-checks').innerText();
    assert.match(checks, /Weights add up to 100%/);
    assert.match(checks, /needs confirmation/); // the placeholder settings
    assert.match(checks, /Final letters: 0 of 57 assigned/);
    await page.fill('#fz-note', 'Smoke test note');
    await dlg.locator('.btn-primary').click();
    await page.waitForFunction(() => GT.model.isFinalized(GT.store.course()));
    const added = await historySince(n);
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, 'settings');
    assert.equal(added[0].field, 'Scores finalized');
    assert.equal(added[0].oldValue, 'no');
    assert.match(added[0].newValue, /^yes \(\d{4}-\d{2}-\d{2}\)$/);
    assert.equal(await page.evaluate(() => GT.store.course().finalized.note), 'Smoke test note');
    // The banner, then a fresh sort by total, high to low.
    const banner = page.locator('.grid-lock-banner');
    await banner.waitFor();
    assert.match(await banner.innerText(), /Scores finalized on .+Score cells are locked; final letters stay editable\..*Smoke test note/s);
    await waitRowsSorted('total', 'desc');
    assert.deepEqual(await page.evaluate(() => [GT.store.state.ui.gridPrefs.sort, GT.store.state.ui.gridPrefs.dir]), ['total', 'desc']);
    assert.equal(await page.locator('.grid-grades-bar [data-act="finalize"]').isHidden(), true);
    assert.equal(await page.locator('.gt-grid.locked').count(), 1);
    // Typing, Delete and paste on a score cell change nothing.
    const t1C = await gridCol('raw', 'Test 1');
    const pC = await gridCol('raw', 'Class/Project Participation');
    const [sid] = await activeRun(1, 2);
    const entries = (id) => page.evaluate((x) => {
      const c = GT.store.course();
      return [GT.model.getEntry(c.scores, x, 'a_t1') || null, GT.model.getEntry(c.scores, x, 'a_part') || null];
    }, id);
    const before = await entries(sid);
    const h0 = await historyCount();
    await clearToasts();
    await gridCell(sid, t1C).click();
    await page.keyboard.type('12');
    await waitToast(/^Scores are finalized\. Unlock them to edit\./);
    assert.equal(await page.locator('.gt-grid .cell-editor').count(), 0, 'no editor opens on a locked cell');
    await page.keyboard.press('Delete');
    await pasteText('1');
    await gridCell(sid, pC).click();
    await page.keyboard.press('Enter');
    await page.keyboard.type('5');
    assert.equal(await page.locator('select.dd-editor, .gt-grid .cell-editor').count(), 0, 'the participation list is locked too');
    assert.deepEqual(await entries(sid), before, 'locked scores are unchanged');
    assert.equal(await historyCount(), h0);
    // Final letters stay editable: type a letter (case-insensitive) into the Final letter cell.
    const fC = await gridCol('final');
    await gridCell(sid, fC).click();
    await page.keyboard.type('b+');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => GT.model.findStudent(GT.store.course(), id).finalLetter === 'B+', sid);
    const last = (await historySince(h0)).slice(-1)[0];
    assert.equal(last.kind, 'final-letter');
    assert.equal(last.newValue, 'B+');
  });

  await check('sorted by total high–low, a range of rows gets its final letter from the drop-down in one transaction', async () => {
    await resetSample();
    await sortTotalDesc();
    const fC = await gridCol('final');
    const ids = await rowIds();
    const band = await activeRun(4);
    const n = await historyCount();
    await selectRows(band, fC);
    await page.keyboard.press('Enter');
    const dd = page.locator('select.dd-editor');
    await dd.waitFor();
    const list = await dd.evaluate((el) => ({
      labels: [...el.options].map((o) => o.textContent),
      group: el.querySelector('optgroup') ? el.querySelector('optgroup').label : null
    }));
    assert.deepEqual(list.labels, ['(none)', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F']);
    assert.equal(list.group, 'For 4 students');
    await page.keyboard.type('a'); // type-ahead: the exact letter first
    assert.equal(await dd.inputValue(), 'A');
    await page.keyboard.press('Enter');
    await page.waitForFunction((a) => a.every((id) => GT.model.findStudent(GT.store.course(), id).finalLetter === 'A'), band);
    assert.equal(await page.evaluate(() => GT.store.undoLabel()), 'Final letter A for 4 students');
    const added = await historySince(n);
    assert.equal(added.length, 4);
    assert.ok(added.every((h) => h.kind === 'final-letter' && h.field === 'Final letter' && h.oldValue === '' && h.newValue === 'A'));
    assert.deepEqual(added.map((h) => h.studentId).sort(), band.slice().sort());
    // Rows keep their place; the cursor waits on the row below the band for the next one.
    assert.deepEqual(await rowIds(), ids);
    const next = ids[ids.indexOf(band[band.length - 1]) + 1];
    assert.equal(await page.evaluate(() => document.querySelector('.gt-grid td.is-active').parentNode.getAttribute('data-sid')), next);
    // The next band by keyboard: Shift+Down twice, then type the letter (a text box that applies to the band).
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    const band2 = ids.slice(ids.indexOf(next), ids.indexOf(next) + 3);
    const active2 = await page.evaluate((a) => a.filter((id) => GT.model.findStudent(GT.store.course(), id).status === 'active'), band2);
    await page.keyboard.type('a-');
    await page.keyboard.press('Enter');
    await page.waitForFunction((a) => a.every((id) => GT.model.findStudent(GT.store.course(), id).finalLetter === 'A-'), active2);
    // A thin rule marks the end of each band while sorted by total (high to low).
    await page.waitForFunction((id) => document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"]').classList.contains('band-end'), band[band.length - 1]);
    // The letters chip counts them; one undo removes the second band only.
    await page.waitForFunction((k) => /Final letters: \d+ of 57 assigned/.test(document.querySelector('[data-act="letters-chip"]').textContent) &&
      document.querySelector('[data-act="letters-chip"]').textContent.includes(k + ' of'), 4 + active2.length);
    await page.keyboard.press('Control+z');
    await page.waitForFunction((a) => a.every((id) => GT.model.findStudent(GT.store.course(), id).finalLetter === null), active2);
    assert.deepEqual(await finalLetters(band), ['A', 'A', 'A', 'A']);
  });

  await check('a mouse pick in a drop-down list saves at once; a list opened next by keyboard only browses until Enter', async () => {
    await resetSample();
    await sortTotalDesc();
    const fC = await gridCol('final');
    const [s1, s2] = await activeRun(2);
    const dd = page.locator('select.dd-editor');
    const listValue = () => page.evaluate(() => { const s = document.querySelector('.gt-grid select.dd-editor'); return s ? s.value : null; });
    /** Centre of an option of the open list, found on screen (a real mouse click, not selectOption). */
    const optionPoint = (value) => page.evaluate((v) => {
      const r = document.querySelector('.gt-grid select.dd-editor').getBoundingClientRect();
      let top = null, bottom = null;
      for (let y = Math.ceil(r.top) + 1; y < r.bottom; y++) {
        const e = document.elementFromPoint(r.left + r.width / 2, y);
        if (e && e.tagName === 'OPTION' && e.value === v) { if (top === null) top = y; bottom = y; }
      }
      return top === null ? null : { x: r.left + r.width / 2, y: (top + bottom) / 2 };
    }, value);
    const pickB = async (sid) => {
      await gridCell(sid, fC).click();
      await page.keyboard.press('Enter');
      await dd.waitFor();
      const p = await optionPoint('B');
      assert.ok(p, 'option B is visible in the list');
      await page.mouse.click(p.x, p.y);
      await dd.waitFor({ state: 'detached' });
      assert.deepEqual(await finalLetters([sid]), ['B'], 'a mouse pick saves at once');
    };
    // Same row: Enter reopens the list on B and ArrowDown only browses.
    await pickB(s1);
    await page.keyboard.press('Enter');
    await dd.waitFor();
    assert.equal(await listValue(), 'B');
    await page.keyboard.press('ArrowDown');
    assert.equal(await listValue(), 'B-', 'the list is still open on B-');
    assert.deepEqual(await finalLetters([s1]), ['B'], 'nothing saved while browsing');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => GT.model.findStudent(GT.store.course(), id).finalLetter === 'B-', s1);
    // Next row: ArrowDown, Enter, ArrowDown right after a mouse pick leaves the next student alone.
    await pickB(s1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await dd.waitFor();
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await listValue(), null, 'the next list stays open');
    assert.deepEqual(await finalLetters([s2]), [null], 'the next student is unchanged');
    await page.keyboard.press('Escape');
    await dd.waitFor({ state: 'detached' });
    assert.deepEqual(await finalLetters([s1, s2]), ['B', null]);
  });

  await check('a drop-down list opened on any visible row shows its top options (not under the sticky header)', async () => {
    await resetSample();
    await sortTotalDesc();
    const fC = await gridCol('final');
    const ids = await rowIds();
    const dd = page.locator('select.dd-editor');
    const hidden = [];
    for (const sid of ids.slice(0, 16)) {
      const visible = await gridCell(sid, fC).evaluate((td) => {
        const w = td.closest('.grid-wrap').getBoundingClientRect(), r = td.getBoundingClientRect();
        return r.top >= w.top && r.bottom <= w.bottom;
      });
      if (!visible) continue;
      await gridCell(sid, fC).click();
      await page.keyboard.press('Enter');
      await dd.waitFor();
      const miss = await page.evaluate(() => {
        const sel = document.querySelector('.gt-grid select.dd-editor');
        const r = sel.getBoundingClientRect();
        const out = [];
        for (let y = r.top + 6; y < r.top + 60; y += 6) {
          const e = document.elementFromPoint(r.left + r.width / 2, y);
          if (!e || (e !== sel && !sel.contains(e))) out.push(Math.round(y - r.top) + 'px: ' + (e ? e.tagName : 'nothing'));
        }
        return out;
      });
      if (miss.length) hidden.push(sid + ' ' + miss[0]);
      await page.keyboard.press('Escape');
      await dd.waitFor({ state: 'detached' });
    }
    assert.deepEqual(hidden, [], 'list covered by another element');
  });

  await check('History shows final-letter entries (more than 10 in one step: one summary entry)', async () => {
    await resetSample();
    await sortTotalDesc();
    const fC = await gridCol('final');
    const ids = await rowIds();
    const n = await historyCount();
    const [top] = await activeRun(1);
    await gridCell(top, fC).click();
    await page.keyboard.type('A');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => GT.model.findStudent(GT.store.course(), id).finalLetter === 'A', top);
    // Twelve rows below it in one band (withdrawn students are skipped).
    const start = ids.indexOf(top) + 1;
    const block = ids.slice(start, start + 12);
    const active = await page.evaluate((a) => a.filter((id) => GT.model.findStudent(GT.store.course(), id).status === 'active'), block);
    assert.ok(active.length > 10, 'the band needs more than 10 active students');
    await selectRows(block, fC);
    await page.keyboard.press('Enter');
    await page.locator('select.dd-editor').waitFor();
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await page.waitForFunction((a) => a.every((id) => GT.model.findStudent(GT.store.course(), id).finalLetter === 'B'), active);
    const added = await historySince(n);
    assert.equal(added.length, 2);
    assert.equal(added[0].kind, 'final-letter');
    assert.equal(added[0].field, 'Final letter');
    assert.equal(added[0].studentId, top);
    assert.equal(added[0].newValue, 'A');
    assert.equal(added[1].kind, 'final-letter');
    assert.equal(added[1].field, 'Final letters');
    assert.equal(added[1].newValue, active.length + ' changed');
    assert.match(added[1].note, /^Students No \d+/);
    // The History tab lists both under the Grades filter, with the "Final letter" badge.
    await gotoView('history');
    await page.click('.view-history [data-act="group"][data-group="grades"]');
    await page.waitForFunction(() => document.querySelector('.view-history [data-act="group"][data-group="grades"]').getAttribute('aria-pressed') === 'true');
    const rows = page.locator('.hist-table tbody tr');
    const first = await rows.nth(0).innerText();
    assert.match(first, /Final letters/);
    assert.match(first, new RegExp(active.length + ' changed'));
    const second = await rows.nth(1).innerText();
    assert.match(second, /Final letter/);
    assert.match(second, /\bA\b/);
    assert.equal(await rows.nth(0).locator('.hist-kind.hk-final').count(), 1);
    // The summary keeps every student: "Show n students" lists them all (names carry class pii).
    assert.equal(await rows.nth(0).locator('details.hist-details li').count(), active.length);
    assert.equal(await rows.nth(0).locator('details.hist-details li .pii').count(), active.length);
    // Filtered to one student of the band (the note lists only 10 by No), History shows that student's own letter.
    const bandStudent = await page.evaluate((a) => {
      const c = GT.store.course();
      return a.map((id) => GT.model.findStudent(c, id)).sort((x, y) => y.no - x.no)[0].id;
    }, active);
    const bandName = await page.evaluate((id) => GT.model.studentName(GT.model.findStudent(GT.store.course(), id)), bandStudent);
    await page.evaluate((id) => GT.app.navigate('history', { studentId: id }), bandStudent);
    await page.waitForFunction((id) => { const s = document.querySelector('.view-history #hv-student'); return s && s.value === id; }, bandStudent);
    const own = page.locator('.hist-table tbody tr.hist-part');
    await own.first().waitFor();
    assert.equal(await own.count(), 1);
    assert.equal(await own.getAttribute('data-id'), added[1].id, 'the row is the summary entry (a note attaches to it)');
    assert.equal(await own.locator('.hc-who .pii').innerText(), bandName);
    assert.equal(await own.locator('.hc-field').innerText(), 'Final letter');
    assert.match(await own.locator('.hc-change .hist-new').textContent(), /B$/);
    assert.equal(await own.locator('.hc-note').innerText(), 'Part of "Final letters: ' + active.length + ' changed"');
    // Export CSV (filtered): the summary row, then only this student's own row.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('.view-history [data-act="export"]')]);
    const file = path.join(TMP, download.suggestedFilename());
    await download.saveAs(file);
    const csvRows = await page.evaluate((text) => GT.csv.parse(text.replace(/^﻿/, '')), fs.readFileSync(file, 'utf8'));
    const bandRows = csvRows.filter((r) => r[5] === 'Final letter' && /^Part of/.test(r[8]));
    assert.equal(bandRows.length, 1);
    assert.equal(bandRows[0][3], bandName);
    assert.equal(bandRows[0][7], 'B');
  });

  await check('rows keep their place after an edit under a sort; "Order changed: re-sort" appears and re-sorts', async () => {
    await resetSample();
    await sortTotalDesc();
    const ids = await rowIds();
    const resort = page.locator('.grid-toolbar [data-act="resort"]');
    assert.equal(await resort.isHidden(), true);
    // Raise the lowest active student's Test 2 to 100: their total climbs, but the row stays put.
    const all = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      return c.students.map((s) => ({ id: s.id, status: s.status, t2: r.byId[s.id].items.a_t2.raw }));
    });
    const low = ids.slice().reverse().find((id) => all.find((x) => x.id === id && x.status === 'active' && x.t2 !== 100));
    const t2C = await gridCol('raw', 'Test 2');
    await gridCell(low, t2C).click();
    await page.keyboard.type('100');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t2.raw === 100, low);
    await resort.waitFor();
    assert.deepEqual(await rowIds(), ids, 'an edit never reorders rows');
    const fresh = await freshOrder('total', 'desc');
    assert.notDeepEqual(fresh, ids);
    await resort.click();
    await waitRowsSorted('total', 'desc');
    await resort.waitFor({ state: 'hidden' });
    // Name sort follows the same rule: a renamed student keeps their row until re-sort.
    await page.selectOption('.grid-toolbar .grid-sort-select', 'name:asc');
    await waitRowsSorted('name', 'asc');
    const byName = await rowIds();
    const lastC = await gridCol('last');
    await gridCell(byName[0], lastC).click();
    await page.keyboard.type('Zzzz');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => GT.model.findStudent(GT.store.course(), id).lastName === 'Zzzz', byName[0]);
    await resort.waitFor();
    assert.deepEqual(await rowIds(), byName);
    await resort.click();
    await waitRowsSorted('name', 'asc');
    assert.equal((await rowIds()).slice(-1)[0], byName[0]);
  });

  await check('Meeting view shows only the meeting columns, sorted by total, and restores the previous view', async () => {
    // The absence columns read GT.attendance.summary (stage 3); a stub stands in until it exists.
    // It is installed before the reset, so the grid builds its columns with it.
    const stubbed = await page.evaluate(() => {
      if (GT.attendance && typeof GT.attendance.summary === 'function') return null;
      const created = !GT.attendance;
      GT.attendance = GT.attendance || {};
      GT.attendance.summary = () => ({ excused: 1, unexcused: 2, totalAbsences: 3, recorded: 10, warning: null,
        longestStreak: 1, overThreshold: false, overTotalThreshold: false });
      return { created };
    });
    try {
      await resetSample();
      await page.waitForFunction(() => document.querySelector('.gt-grid thead th.h-attUnx'));
      const tdFont = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.gt-grid tbody td.c-final')).fontSize));
      const normalFont = await tdFont();
      await page.click('.grid-grades-bar [data-act="meeting"]');
      await page.waitForFunction(() => document.querySelector('.gt-grid.meeting'));
      assert.equal(await page.locator('.grid-grades-bar [data-act="meeting"]').getAttribute('aria-pressed'), 'true');
      const heads = await page.$$eval('.gt-grid thead th', (ths) => ths.map((th) => {
        const kind = [...th.classList].find((c) => c.startsWith('h-'));
        return kind === 'h-raw' ? 'raw:' + th.querySelector('.h-name').textContent.trim() : kind;
      }));
      assert.deepEqual(heads, ['h-no', 'h-last', 'h-first', 'raw:Project I', 'raw:Project II', 'raw:Test 1', 'raw:Test 2', 'h-total',
        'h-attExc', 'h-attUnx', 'h-attTot', 'raw:Class/Project Participation', 'h-letter', 'h-final', 'h-rank']);
      const labels = await page.$$eval('.gt-grid thead th.h-attExc, .gt-grid thead th.h-attUnx, .gt-grid thead th.h-attTot, .gt-grid thead th.h-letter, .gt-grid thead th.h-final',
        (ths) => ths.map((th) => th.textContent.replace(/\s+/g, ' ').trim()));
      assert.match(labels[0], /Excused \(allowed\)/);
      assert.match(labels[1], /Unexcused \(not allowed\)/);
      assert.match(labels[2], /Total absences/);
      assert.match(labels[3], /Suggested/);
      assert.match(labels[4], /Final letter/);
      // Participation and the final letter are marked "fill in the meeting"; the text is larger.
      const pC = await gridCol('raw', 'Class/Project Participation');
      assert.ok(await page.locator(`.gt-grid thead th[data-c="${pC}"]`).evaluate((th) => th.classList.contains('to-fill')));
      assert.ok(await page.locator('.gt-grid thead th.h-final').evaluate((th) => th.classList.contains('to-fill')));
      assert.ok((await tdFont()) > normalFont, 'larger text in the Meeting view');
      await waitRowsSorted('total', 'desc');
      const prefs = await page.evaluate(() => GT.store.state.ui.gridPrefs);
      assert.equal(prefs.meeting, true);
      assert.deepEqual([prefs.sort, prefs.dir], ['total', 'desc']);
      // Keyboard-reachable: the toggle is a real button that takes focus.
      await page.focus('.grid-grades-bar [data-act="meeting"]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('.gt-grid.meeting'));
      assert.equal(await page.locator('.gt-grid thead th.h-team').count(), 1, 'the Team column is back');
      assert.equal(await page.locator('.gt-grid thead th.h-weighted').count() > 0, true, 'the weighted columns are back');
      await waitRowsSorted('name', 'asc');
    } finally {
      // Remove the stub; the next resetSample rebuilds the grid without it.
      if (stubbed) await page.evaluate((created) => { if (created) delete GT.attendance; else delete GT.attendance.summary; }, stubbed.created);
    }
  });

  await check('Meeting view at 1280 px: the absence columns, Participation, Final letter and Rank all fit without scrolling', async () => {
    // The instructor fills Participation and Final letter in the meeting, looking at the absences (DECISIONS 5, 6).
    await resetSample();
    assert.equal(page.viewportSize().width, 1280);
    await page.click('.grid-grades-bar [data-act="meeting"]');
    await page.waitForFunction(() => document.querySelector('.gt-grid.meeting thead th.h-attUnx'));
    const m = await page.evaluate(() => {
      const t = document.querySelector('.gt-grid.meeting'), wrap = t.closest('.grid-wrap');
      const wr = wrap.getBoundingClientRect();
      const right = wr.left + wrap.clientLeft + wrap.clientWidth;
      const edge = (sel) => { const th = t.querySelector('thead th' + sel); return th ? Math.round(th.getBoundingClientRect().right) : null; };
      // Header text is never clipped, and the absence header names stay on one line.
      const clipped = [...t.querySelectorAll('thead th')].filter((th) => th.scrollWidth > th.clientWidth + 1).map((th) => th.className);
      const wrapped = [...t.querySelectorAll('thead th.h-attExc .h-name, thead th.h-attUnx .h-name, thead th.h-attTot .h-name, thead th.h-final .h-name')]
        .filter((n) => n.getClientRects().length !== 1 || n.getBoundingClientRect().height > parseFloat(getComputedStyle(n).lineHeight) * 1.5)
        .map((n) => n.textContent);
      return { right: Math.round(right), overflow: wrap.scrollWidth - wrap.clientWidth, final: edge('.h-final'), rank: edge('.h-rank'),
        part: edge('.to-fill.h-raw'), unx: edge('.h-attUnx'), clipped, wrapped };
    });
    assert.ok(m.final !== null && m.rank !== null && m.part !== null && m.unx !== null, JSON.stringify(m));
    assert.ok(m.final <= m.right, 'Final letter is cut off: ' + JSON.stringify(m));
    assert.ok(m.rank <= m.right, 'Rank is cut off: ' + JSON.stringify(m));
    assert.ok(m.overflow <= 0, 'the meeting grid scrolls sideways: ' + JSON.stringify(m));
    assert.deepEqual(m.clipped, []);
    assert.deepEqual(m.wrapped, []);
    await page.click('.grid-grades-bar [data-act="meeting"]');
    await page.waitForFunction(() => !document.querySelector('.gt-grid.meeting'));
  });

  await check('Meeting view at 1280 px, SE 6362 with attendance on: every column fits; with long names, Final letter and Rank stay pinned on screen', async () => {
    // STAGE6 carry-over: the graduate course has one more item (Term Paper), so its meeting columns were
    // 78 px too wide with the absence columns, and Final letter and Rank were off screen.
    await resetSample();
    const cid = await page.evaluate(() => {
      const c = GT.store.state.courses.find((x) => x.template === 'SE6362');
      GT.store.setActiveCourse(c.id);
      GT.store.transact('Load sample data', (co) => GT.sample.loadInto(co, { lateWork: true }), { source: 'sample', historyMode: 'bulk', courseId: c.id });
      GT.store.transact('Attendance on', (co) => GT.attendance.setMode(co, 'per-session'), { courseId: c.id });
      return c.id;
    });
    await page.waitForFunction((id) => GT.store.course().id === id && document.querySelectorAll('.gt-grid tbody tr.gr').length === GT.store.course().students.length &&
      document.querySelector('.gt-grid thead th.h-attUnx'), cid);
    await page.click('.grid-grades-bar [data-act="meeting"]');
    await page.waitForFunction(() => document.querySelector('.gt-grid.meeting thead th.h-attUnx'));
    const measure = () => page.evaluate(() => {
      const t = document.querySelector('.gt-grid.meeting'), wrap = t.closest('.grid-wrap');
      const wr = wrap.getBoundingClientRect();
      const left = wr.left + wrap.clientLeft, right = left + wrap.clientWidth;
      const box = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; };
      const row = t.querySelector('tbody tr.gr:not(.row-withdrawn)');
      return {
        left: Math.round(left), right: Math.round(right), overflow: wrap.scrollWidth - wrap.clientWidth, scrollLeft: wrap.scrollLeft,
        final: box(t.querySelector('thead th.h-final')), rank: box(t.querySelector('thead th.h-rank')),
        finalTd: box(row.querySelector('td.c-final')), rankTd: box(row.querySelector('td.c-rank')),
        clipped: [...t.querySelectorAll('thead th')].filter((th) => th.scrollWidth > th.clientWidth + 1).map((th) => th.className),
        names: [...t.querySelectorAll('tbody tr.gr:not(.row-withdrawn) td.c-last, tbody tr.gr:not(.row-withdrawn) td.c-first')]
          .filter((td) => td.scrollWidth > td.clientWidth).map((td) => td.textContent)
      };
    });
    const m = await measure();
    assert.ok(m.overflow <= 0, 'the meeting grid scrolls sideways: ' + JSON.stringify(m));
    for (const k of ['final', 'rank', 'finalTd', 'rankTd']) assert.ok(m[k].r <= m.right && m[k].l >= m.left, k + ' is off screen: ' + JSON.stringify(m));
    assert.deepEqual(m.clipped, [], 'header text is clipped');
    assert.deepEqual(m.names, [], 'names are cut off');
    // Names longer than the meeting columns allow: the table is wider than the window again, and Final
    // letter and Rank stay pinned on the right edge (sticky), without scrolling sideways.
    const long = await page.evaluate(() => {
      const s = GT.store.course().students.find((x) => x.status === 'active');
      GT.store.transact('Long names', (c) => { const t = GT.model.findStudent(c, s.id); t.lastName = 'Abcdefghijklmnopqrstuvwxyz-Abcdefgh'; t.firstName = 'Abcdefghijklmnopqrstuvwxyz'; });
      return s.id;
    });
    await page.waitForFunction(() => { const w = document.querySelector('.gt-grid.meeting').closest('.grid-wrap'); return w.scrollWidth > w.clientWidth; });
    await page.evaluate(() => { document.querySelector('.gt-grid.meeting').closest('.grid-wrap').scrollLeft = 0; });
    const p = await measure();
    assert.equal(p.scrollLeft, 0);
    for (const k of ['final', 'rank', 'finalTd', 'rankTd']) assert.ok(p[k].r <= p.right && p[k].l >= p.left, k + ' is not pinned on screen: ' + JSON.stringify(p));
    assert.ok(p.final.r <= p.rank.l + 1, 'Final letter and Rank overlap');
    // Moving with the keyboard to a column under the pinned ones scrolls it out from under them.
    const totalC = await gridCol('total');
    const sugC = await gridCol('letter');
    await gridCell(long, totalC).click();
    for (let i = Number(totalC); i < Number(sugC); i++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(([id, c]) => {
      const td = document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"] td[data-c="' + c + '"]');
      const fin = document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"] td.c-final');
      return td && td.classList.contains('is-active') && td.getBoundingClientRect().right <= fin.getBoundingClientRect().left + 1;
    }, [long, sugC]);
    await page.click('.grid-grades-bar [data-act="meeting"]');
    await page.waitForFunction(() => !document.querySelector('.gt-grid.meeting'));
  });

  await check('Unlock scores asks first, is logged in History, and score cells are editable again', async () => {
    await resetSample();
    // Finalize from Settings → Grading status: it opens the Grades tab's Finalize dialog.
    await gotoView('settings');
    await page.click('.view-settings [data-act="finalize"]');
    const dlg = page.locator('dialog[open]', { hasText: 'Data check' });
    await dlg.waitFor();
    await dlg.locator('.btn-primary').click();
    await page.waitForFunction(() => GT.model.isFinalized(GT.store.course()) && GT.store.state.ui.activeView === 'grades');
    await page.locator('.grid-lock-banner').waitFor();
    const n = await historyCount();
    await page.click('.grid-lock-banner [data-act="unlock"]');
    const confirm = page.locator('dialog[open]', { hasText: 'Unlock scores?' });
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /logged in the change history/);
    await confirm.locator('.btn-primary').click();
    await page.waitForFunction(() => !GT.model.isFinalized(GT.store.course()));
    const added = await historySince(n);
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, 'settings');
    assert.equal(added[0].field, 'Scores finalized');
    assert.match(added[0].oldValue, /^yes \(\d{4}-\d{2}-\d{2}\)$/);
    assert.equal(added[0].newValue, 'no');
    await page.locator('.grid-lock-banner').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.gt-grid.locked').count(), 0);
    // Score cells take edits again.
    const [sid] = await activeRun(1);
    const t1C = await gridCol('raw', 'Test 1');
    await gridCell(sid, t1C).click();
    await page.keyboard.type('66');
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.raw === 66, sid);
    // Both steps are in the History tab.
    await gotoView('history');
    const text = await page.locator('.hist-table tbody').innerText();
    assert.equal((text.match(/Scores finalized/g) || []).length, 2);
  });

  await check('the effective Letter Grade is the final letter once one is set; the suggestion stays visible', async () => {
    await resetSample();
    const s = (await studentsByName()).find((x) => x.status === 'active');
    const r0 = await page.evaluate((id) => GT.store.results().byId[id], s.id);
    assert.equal(r0.finalLetter, null);
    assert.equal(r0.effectiveLetter, r0.letter);
    assert.equal(r0.letterSource, 'cutoffs');
    const other = r0.letter === 'F' ? 'A' : 'F';
    const fC = await gridCol('final');
    const sugC = await gridCol('letter');
    await gridCell(s.id, fC).click();
    await page.keyboard.type(other.toLowerCase());
    await page.keyboard.press('Enter');
    await page.waitForFunction(([id, l]) => GT.store.results().byId[id].effectiveLetter === l, [s.id, other]);
    const r1 = await page.evaluate((id) => {
      const res = GT.store.results();
      return { r: res.byId[id], summary: res.letterSummary };
    }, s.id);
    assert.equal(r1.r.finalLetter, other);
    assert.equal(r1.r.letter, r0.letter, 'the suggestion is unchanged');
    assert.equal(r1.r.letterSource, 'manual');
    assert.equal(r1.r.letterDiffers, true);
    assert.equal(r1.r.finalLetterValid, true);
    assert.equal(r1.summary.assigned, 1);
    assert.equal(r1.summary.manualDiffers, 1);
    // The grid shows both: the Suggested cell and the Final letter with the "differs" dot.
    await page.waitForFunction(([id, c]) => {
      const td = document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"] td[data-c="' + c + '"]');
      return td && td.querySelector('.mk-diff');
    }, [s.id, fC]);
    assert.equal(await cellText(s.id, sugC), r0.letter);
    assert.match(await cellText(s.id, fC), new RegExp('^' + other));
    assert.match(await gridCell(s.id, fC).getAttribute('title'), new RegExp('Differs from the cutoff suggestion \\(' + r0.letter.replace('+', '\\+') + '\\)'));
    // The Students tab shows the final letter too.
    await gotoView('students');
    assert.match(await page.locator(`.view-students tr[data-sid="${s.id}"] td.st-final`).innerText(), new RegExp(other));
    // Delete clears it: the effective letter is the suggestion again.
    await gotoView('grades');
    await gridCell(s.id, fC).click();
    await page.keyboard.press('Delete');
    await page.waitForFunction(([id, l]) => {
      const r = GT.store.results().byId[id];
      return r.finalLetter === null && r.effectiveLetter === l && r.letterSource === 'cutoffs';
    }, [s.id, r0.letter]);
  });

  await check('a weight change in Settings shows the weights banner (and removing it hides it)', async () => {
    await resetSample();
    await gotoView('settings');
    assert.equal(await page.locator('#banners .banner', { hasText: 'not 100%' }).count(), 0);
    const input = page.locator('.view-settings input[data-role="weight-input"][data-aid="a_t1"]');
    await input.fill('30');
    await input.press('Enter');
    await page.waitForFunction(() => GT.store.course().assessments.find((a) => a.id === 'a_t1').weight === 30);
    const banner = page.locator('#banners .banner-warn', { hasText: 'add up to 105%' });
    await banner.waitFor();
    assert.match(await page.evaluate(() => GT.store.course().history.slice(-1)[0].field), /Weight/i);
    // "Fix in Settings" jumps to the assessments card, below the sticky header.
    await page.evaluate(() => window.scrollTo(0, 0));
    await banner.locator('[data-act="goto"]').click();
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-sec-host="assessments"]');
      const head = document.querySelector('.app-head').getBoundingClientRect().bottom;
      const r = card && card.getBoundingClientRect();
      return r && r.top >= head - 1 && r.top < window.innerHeight;
    });
    const again = page.locator('.view-settings input[data-role="weight-input"][data-aid="a_t1"]');
    await again.fill('25');
    await again.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#banners .banner-warn') ||
      ![...document.querySelectorAll('#banners .banner')].some((b) => /not 100%/.test(b.textContent)));
  });

  await check('marking a placeholder confirmed updates the Settings tab count', async () => {
    await resetSample();
    await gotoView('settings');
    const count = () => page.locator('#tab-settings .count').textContent();
    const before = Number(await count());
    assert.equal(before, await page.evaluate(() => GT.model.unconfirmedPlaceholders(GT.store.course()).length));
    assert.ok(before > 0);
    const btn = page.locator('.view-settings button[data-act="ph-confirm"]').first();
    const key = await btn.getAttribute('data-key');
    await btn.click();
    await page.waitForFunction((k) => GT.model.isConfirmed(GT.store.course(), k), key);
    await page.waitForFunction((n) => document.querySelector('#tab-settings .count') &&
      Number(document.querySelector('#tab-settings .count').textContent) === n, before - 1);
    const last = await page.evaluate(() => GT.store.course().history.slice(-1)[0]);
    assert.equal(last.kind, 'settings');
    assert.match(last.field, /^Confirmation: /);
    assert.equal(last.newValue, 'confirmed');
  });

  // ---------------------------------------------------------------- stage 3: attendance

  await check('Attendance: SE 4351 has 26 sessions and a 59 x 26 marking grid that renders in under 30 ms', async () => {
    await resetSample();
    const c = await page.evaluate(() => ({
      sessions: GT.store.course().attendance.sessions.length,
      template: GT.model.createCourse('SE4351').attendance.sessions.length,
      mode: GT.store.course().attendance.mode,
      streakDefault: GT.store.course().attendance.excusedCountsTowardStreak
    }));
    assert.deepEqual(c, { sessions: 26, template: 26, mode: 'per-session', streakDefault: false });
    await gotoAttendanceGrid();
    assert.equal(await page.locator('.att-grid thead th.ses').count(), 26);
    assert.equal(await page.locator('.att-mode[data-mode="per-session"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-f="excstreak"]').isChecked(), false, 'excused absences do not count toward a streak by default');
    // Performance: the body of 59 x 26 cells (one innerHTML string). Best of three re-renders.
    const ms = [];
    for (let i = 0; i < 3; i++) {
      await page.click('[data-act="withdrawn"]'); // hide withdrawn (57 rows), then show them again (59 rows)
      await page.waitForFunction((n) => document.querySelectorAll('.att-grid tbody tr[data-sid]').length === n, SAMPLE_STUDENTS - 2);
      await page.click('[data-act="withdrawn"]');
      await page.waitForFunction((n) => document.querySelectorAll('.att-grid tbody tr[data-sid]').length === n, SAMPLE_STUDENTS);
      ms.push(await page.evaluate(() => GT.views.attendance.lastRenderMs()));
    }
    assert.ok(Math.min(...ms) < 30, 'grid body render took ' + ms.join(', ') + ' ms');
    // The summary columns and the footer counts are the core's numbers.
    assert.deepEqual(await attSummaryMismatches(), []);
    const foot = await page.evaluate(() => {
      const c = GT.store.course(), ses = c.attendance.sessions[0];
      const n = GT.attendance.sessionCounts(c, ses.id);
      const cell = (k) => document.querySelector('.att-grid tfoot tr.f' + k).cells[1].textContent.trim();
      return { got: [cell(1), cell(2), cell(3), cell(4)].join(), want: [n.present, n.absent, n.excused, n.unmarked].join() };
    });
    assert.equal(foot.got, foot.want);
  });

  await check('Attendance: SE 6362 starts off (no absence columns in Grades); turning it on works', async () => {
    await resetSample();
    const other = await page.evaluate(() => {
      const c = GT.store.state.courses[1];
      GT.store.transact('Load sample data', (cc) => GT.sample.loadInto(cc), { courseId: c.id, source: 'sample', historyMode: 'bulk' });
      return { id: c.id, code: c.code, mode: c.attendance.mode };
    });
    assert.equal(other.code, 'SE 6362');
    assert.equal(other.mode, 'off');
    await page.selectOption('#course-select', other.id);
    // Wait for the rows of SE 6362 (the SE 4351 grid is still on screen until the switch re-renders it).
    await page.waitForFunction(() => {
      const ids = new Set(GT.store.course().students.map((s) => s.id));
      const rows = [...document.querySelectorAll('.gt-grid tbody tr.gr')];
      return GT.store.course().code === 'SE 6362' && rows.length === ids.size && rows.every((tr) => ids.has(tr.getAttribute('data-sid')));
    });
    assert.equal(await page.locator('.gt-grid thead th.h-attExc, .gt-grid thead th.h-attUnx, .gt-grid thead th.h-attTot').count(), 0,
      'no absence columns while attendance is off');
    await gotoView('attendance');
    await page.locator('.att-off-state').waitFor();
    assert.match(await page.locator('.att-off-state').textContent(), /not tracked for SE 6362/);
    const h0 = await historyCount();
    await page.click('.att-off-state [data-act="turn-on"][data-mode="per-session"]');
    await page.waitForFunction(() => GT.store.course().attendance.mode === 'per-session');
    await page.waitForFunction(() => document.querySelectorAll('.att-grid thead th.ses').length === 26);
    const added = await historySince(h0);
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, 'settings');
    assert.equal(added[0].newValue, 'Per session');
    await gotoView('grades');
    await page.waitForFunction(() => document.querySelector('.gt-grid thead th.h-attUnx'));
    const g = await gridAbsenceMismatches();
    assert.ok(g.rows > 0);
    assert.deepEqual(g.bad, []);
    await page.selectOption('#course-select', await page.evaluate(() => GT.store.state.courses[0].id));
  });

  await check('Grades grid: Excused, Unexcused and Total absences next to every SE 4351 student equal the core summary', async () => {
    await resetSample();
    let g = await gridAbsenceMismatches();
    assert.equal(g.rows, SAMPLE_STUDENTS);
    assert.deepEqual(g.bad, []);
    // A re-render and a copy of the three columns for every row compute attendance once for the course,
    // not once per row (summary() rescans every student's marks: quadratic at 300 students).
    const excC = await gridCol('attExc'), totC = await gridCol('attTot');
    const ids = await rowIds();
    await gridCell(ids[0], excC).click();
    await gridCell(ids[ids.length - 1], totC).click({ modifiers: ['Shift'] });
    const spy = await page.evaluate(async ([sid, n]) => {
      const A = GT.attendance, orig = { summary: A.summary, courseSummary: A.courseSummary };
      const calls = { summary: 0, courseSummary: 0 };
      A.summary = function () { calls.summary++; return orig.summary.apply(this, arguments); };
      A.courseSummary = function () { calls.courseSummary++; return orig.courseSummary.apply(this, arguments); };
      try {
        const r0 = GT.views.grades.lastRenderMs();
        GT.store.transact('Edit Test 1', (c) => GT.model.setEntry(c.scores, sid, 'a_t1', { value: 11 }));
        // The view re-renders on the next animation frame; a frame callback added now runs after it.
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const render = { ...calls, rendered: GT.views.grades.lastRenderMs() !== r0 || calls.courseSummary > 0 };
        calls.summary = 0; calls.courseSummary = 0;
        const dt = new DataTransfer();
        document.activeElement.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
        const copy = { ...calls, lines: dt.getData('text/plain').split('\r\n').length };
        return { render, copy };
      } finally {
        A.summary = orig.summary;
        A.courseSummary = orig.courseSummary;
      }
    }, [ids[1], ids.length]);
    assert.equal(spy.render.rendered, true, 'the grid did not re-render');
    assert.equal(spy.render.summary, 0, 'per-row summary() calls in a render');
    assert.equal(spy.render.courseSummary, 1);
    assert.deepEqual(spy.copy, { summary: 0, courseSummary: 1, lines: SAMPLE_STUDENTS });
    g = await gridAbsenceMismatches();
    assert.deepEqual(g.bad, []);
    await page.keyboard.press('Escape');
    // The fail and drop students: warning icon and tooltip on the Unexcused cell.
    const tips = await page.evaluate(() => {
      const c = GT.store.course(), cs = GT.attendance.courseSummary(c);
      const unxC = document.querySelector('.gt-grid thead th.h-attUnx').getAttribute('data-c');
      const tip = (kind) => {
        const w = cs.warnings.find((x) => x.kind === kind);
        return document.querySelector('.gt-grid tbody tr[data-sid="' + w.studentId + '"] td[data-c="' + unxC + '"]').title;
      };
      return { fail: tip('fail'), drop: tip('drop'), threshold: tip('threshold') };
    });
    assert.match(tips.fail, /4 consecutive absences: the syllabus says F/);
    assert.match(tips.drop, /3 consecutive absences: the syllabus says one letter grade drop/);
    assert.match(tips.threshold, /Above the unexcused-absence threshold \(3\)/);
    // The Columns menu hides and shows each absence column.
    await page.click('.grid-toolbar [data-act="columns"]');
    const item = page.locator('.grid-cols-menu [data-key="attUnexcused"]');
    assert.equal(await item.getAttribute('aria-checked'), 'true');
    await item.click();
    await page.waitForFunction(() => !document.querySelector('.gt-grid thead th.h-attUnx') && document.querySelector('.gt-grid thead th.h-attExc'));
    await page.locator('.grid-cols-menu [data-key="attUnexcused"]').click();
    await page.waitForFunction(() => document.querySelector('.gt-grid thead th.h-attUnx'));
    await page.keyboard.press('Escape');
    if (await page.locator('.grid-cols-menu').count()) await page.click('.grid-toolbar [data-act="columns"]');
    await page.waitForFunction(() => !document.querySelector('.grid-cols-menu'));
    // Totals-only mode: the columns read the typed totals; attendance off: the columns are hidden.
    await page.evaluate(() => GT.store.transact('Totals', (c) => {
      GT.attendance.setMode(c, 'totals');
      GT.attendance.setSessionsHeld(c, 20);
      GT.attendance.setTotals(c, c.students[0].id, { absent: 7, excused: 2 });
    }));
    await page.waitForFunction(() => {
      const c = GT.store.course(), sid = c.students[0].id;
      const unxC = document.querySelector('.gt-grid thead th.h-attUnx');
      const td = unxC && document.querySelector('.gt-grid tbody tr[data-sid="' + sid + '"] td[data-c="' + unxC.getAttribute('data-c') + '"]');
      return td && /7/.test(td.textContent);
    });
    g = await gridAbsenceMismatches();
    assert.deepEqual(g.bad, []);
    await page.evaluate(() => GT.store.transact('Off', (c) => GT.attendance.setMode(c, 'off')));
    await page.waitForFunction(() => !document.querySelector('.gt-grid thead th.h-attExc, .gt-grid thead th.h-attUnx, .gt-grid thead th.h-attTot'));
  });

  await check('Attendance: a 3-run gives the drop warning, a 4-run the fail warning; grades never change', async () => {
    await resetSample();
    const before = await gradeSnapshot();
    await gotoAttendanceGrid();
    const sid = await quietStudent();
    // Sessions 1-6 present (one range, one transaction), then 2-4 absent: a run of exactly 3.
    await selectAttRange(sid, 1, 6);
    await page.keyboard.press('p');
    await page.waitForFunction((s) => document.querySelector(`.att-grid tr[data-sid="${s}"]`).cells[3 + 6].textContent === 'P', sid);
    const h0 = await historyCount();
    await selectAttRange(sid, 2, 4);
    await page.keyboard.press('a');
    await page.waitForFunction((s) => GT.attendance.summary(GT.store.course(), s).warning === 'drop', sid);
    assert.equal((await historySince(h0)).length, 3, 'three marks: one history entry each (<= 5 per transaction)');
    assert.deepEqual([await markOf(sid, 1), await markOf(sid, 2), await markOf(sid, 3), await markOf(sid, 4), await markOf(sid, 5)], ['P', 'A', 'A', 'A', 'P']);
    const chip = page.locator(`.att-grid tbody tr[data-sid="${sid}"] .sr-warn .att-chip`);
    await page.waitForFunction((s) => /3 in a row: 1 letter drop/.test(document.querySelector(`.att-grid tbody tr[data-sid="${s}"] .sr-warn`).textContent), sid);
    assert.match(await chip.getAttribute('class'), /\bwarn\b/);
    // The Warnings card lists the student with the dates of the run.
    const dates = await page.evaluate((s) => GT.store.course().attendance.sessions.slice(2, 5)
      .map((x) => GT.util.MONTH_SHORT[Number(x.date.slice(5, 7)) - 1] + ' ' + Number(x.date.slice(8, 10))).join(', '), sid);
    const card = page.locator(`.att-warn-list .aw-item[data-sid="${sid}"]`);
    await card.waitFor();
    assert.match(await card.textContent(), /3 in a row: 1 letter drop \(warning only\)/);
    assert.ok((await card.textContent()).includes(dates), 'streak dates ' + dates);
    // One more absence (keyboard: select session 5, type a): a run of 4, fail.
    await attCell(sid, 5).click();
    await page.keyboard.press('a');
    await page.waitForFunction((s) => GT.attendance.summary(GT.store.course(), s).warning === 'fail', sid);
    await page.waitForFunction((s) => /4 in a row: F per syllabus/.test(document.querySelector(`.att-grid tbody tr[data-sid="${s}"] .sr-warn`).textContent), sid);
    assert.match(await chip.getAttribute('class'), /\bdanger\b/);
    assert.equal(await page.locator(`.att-grid tbody tr[data-sid="${sid}"]`).evaluate((tr) => tr.classList.contains('w-fail')), true);
    // Rates, counts and highlights in the summary columns equal the core summary.
    assert.deepEqual(await attSummaryMismatches(), []);
    // Warnings only (T5): totals, letters and ranks are exactly as before.
    assert.equal(await gradeSnapshot(), before);
    // The Grades grid shows the fail warning on the Unexcused cell; the letter is untouched.
    await gotoView('grades');
    const tip = await page.evaluate((s) => {
      const unxC = document.querySelector('.gt-grid thead th.h-attUnx').getAttribute('data-c');
      const td = document.querySelector('.gt-grid tbody tr[data-sid="' + s + '"] td[data-c="' + unxC + '"]');
      return { title: td.title, icon: !!td.querySelector('.mk-att') };
    }, sid);
    assert.ok(tip.icon);
    assert.match(tip.title, /4 consecutive absences: the syllabus says F \(warning only/);
    assert.equal(await gradeSnapshot(), before);
  });

  await check('Attendance: excused (allowed) absences do not make a streak by default; the setting makes them count', async () => {
    await resetSample();
    await gotoAttendanceGrid();
    const sid = await quietStudent();
    await selectAttRange(sid, 1, 6);
    await page.keyboard.press('p');
    await page.waitForFunction((s) => document.querySelector(`.att-grid tr[data-sid="${s}"]`).cells[3 + 6].textContent === 'P', sid);
    const { exc0, unx0 } = await page.evaluate((s) => {
      const sm = GT.attendance.summary(GT.store.course(), s);
      return { exc0: sm.excused, unx0: sm.unexcused };
    }, sid);
    // Four excused absences in a row (right-click menu on a selected range).
    await selectAttRange(sid, 2, 5);
    await attCell(sid, 3).click({ button: 'right' });
    await page.locator('.menu [role="menuitem"]', { hasText: 'Excused (allowed)' }).click();
    await page.waitForFunction(([s, n]) => GT.attendance.summary(GT.store.course(), s).excused === n + 4, [sid, exc0]);
    let sm = await page.evaluate((s) => GT.attendance.summary(GT.store.course(), s), sid);
    assert.equal(sm.warning, null, 'excused absences alone never warn by default');
    assert.equal(sm.longestStreak < 2, true);
    assert.equal(await page.locator(`.att-grid tbody tr[data-sid="${sid}"] .sr-warn .att-chip`).count(), 0);
    assert.equal(await page.locator(`.att-warn-list .aw-item[data-sid="${sid}"]`).count(), 0);
    // Tick "Excused absences count toward a streak": the same four now give the fail warning.
    const h0 = await historyCount();
    await page.locator('[data-f="excstreak"]').check();
    await page.waitForFunction(() => GT.store.course().attendance.excusedCountsTowardStreak === true);
    sm = await page.evaluate((s) => GT.attendance.summary(GT.store.course(), s), sid);
    assert.equal(sm.warning, 'fail');
    assert.equal(sm.unexcused, unx0, 'the unexcused count does not change');
    await page.waitForFunction((s) => /4 in a row: F per syllabus/.test(document.querySelector(`.att-grid tbody tr[data-sid="${s}"] .sr-warn`).textContent), sid);
    const logged = await historySince(h0);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].kind, 'settings');
    assert.equal(logged[0].field, 'Excused absences count toward a streak');
    // Untick: back to no warning.
    await page.locator('[data-f="excstreak"]').uncheck();
    await page.waitForFunction((s) => GT.attendance.summary(GT.store.course(), s).warning === null, sid);
    await page.waitForFunction((s) => !document.querySelector(`.att-grid tbody tr[data-sid="${s}"] .sr-warn .att-chip`), sid);
  });

  await check('Attendance: "Mark everyone without a mark as Present" is one transaction and one history entry', async () => {
    await resetSample();
    await gotoAttendanceGrid();
    const ses = await page.evaluate(() => GT.store.course().attendance.sessions[5]);
    // Clear the session first (header menu, with a confirmation that says how many marks go).
    await page.click(`.att-grid thead button.ses-btn[data-ses="${ses.id}"]`);
    await page.locator('.menu [role="menuitem"]', { hasText: 'Clear this session' }).click();
    await page.locator('dialog[open]').waitFor();
    assert.match(await page.locator('dialog[open]').textContent(), /59 marks/);
    await page.locator('dialog[open] .btn-primary').click();
    await page.waitForFunction((id) => GT.attendance.markCount(GT.store.course(), id) === 0, ses.id);
    const h0 = await historyCount();
    await page.click(`.att-grid thead button.ses-btn[data-ses="${ses.id}"]`);
    await page.locator('.menu [role="menuitem"]', { hasText: 'Mark everyone without a mark as Present' }).click();
    await page.waitForFunction((id) => GT.attendance.markCount(GT.store.course(), id) === 57, ses.id);
    const added = await historySince(h0);
    assert.equal(added.length, 1, 'one history entry');
    assert.equal(added[0].kind, 'attendance');
    assert.equal(added[0].newValue, '57 marks changed');
    const counts = await page.evaluate((id) => GT.attendance.sessionCounts(GT.store.course(), id), ses.id);
    assert.equal(counts.present, 57);
    assert.equal(counts.unmarked, 0);
    await page.waitForFunction(() => document.querySelector('.att-grid tfoot tr.f1').cells[1 + 5].textContent.trim() === '57');
    // One undo step restores the cleared session.
    await page.click('#btn-undo');
    await page.waitForFunction((id) => GT.attendance.markCount(GT.store.course(), id) === 0, ses.id);
  });

  await check('Attendance: Roll call marks the current student and advances; "Mark remaining present" fills the rest', async () => {
    await resetSample();
    await gotoAttendanceGrid();
    const ses = await page.evaluate(() => {
      const c = GT.store.course(), s = c.attendance.sessions[3];
      GT.store.transact('Clear', (cc) => GT.attendance.clearSession(cc, s.id));
      return s;
    });
    await page.click('[data-act="roll"]');
    await page.locator('dialog[open] .rc-list').waitFor();
    await page.selectOption('#rc-ses', ses.id);
    // Keys go to the current row (not to the session drop-down, where a letter would pick an option).
    await page.locator('dialog[open] .rc-row.is-current .rc-b').first().focus();
    const order = await page.$$eval('dialog[open] .rc-row', (rows) => rows.map((r) => r.getAttribute('data-sid')));
    assert.equal(order.length, 57, 'active students only');
    await page.waitForFunction((sid) => document.querySelector('dialog[open] .rc-row.is-current').getAttribute('data-sid') === sid, order[0]);
    const current = () => page.$eval('dialog[open] .rc-row.is-current', (r) => r.getAttribute('data-sid'));
    const stored = (sid) => page.evaluate(([s, id]) => (GT.store.course().attendance.records[s] || {})[id] || '', [sid, ses.id]);
    await page.keyboard.press('a');
    await page.waitForFunction((sid) => document.querySelector('dialog[open] .rc-row.is-current').getAttribute('data-sid') === sid, order[1]);
    assert.equal(await stored(order[0]), 'A');
    await page.keyboard.press('e');
    await page.waitForFunction((sid) => document.querySelector('dialog[open] .rc-row.is-current').getAttribute('data-sid') === sid, order[2]);
    assert.equal(await stored(order[1]), 'E');
    await page.keyboard.press('p');
    assert.equal(await current(), order[3]);
    assert.equal(await stored(order[2]), 'P');
    assert.match(await page.locator('dialog[open] .rc-progress').textContent(), /3 of 57/);
    assert.equal(await page.locator(`dialog[open] .rc-row[data-sid="${order[0]}"] .rc-b[data-m="A"]`).getAttribute('aria-pressed'), 'true');
    // Up, then Delete clears the mark of that student.
    await page.keyboard.press('ArrowUp');
    assert.equal(await current(), order[2]);
    await page.keyboard.press('Delete');
    await page.waitForFunction(([s, id]) => !(GT.store.course().attendance.records[s] || {})[id], [order[2], ses.id]);
    const h0 = await historyCount();
    await page.click('dialog[open] [data-rc="rest"]');
    await page.waitForFunction((id) => GT.attendance.sessionCounts(GT.store.course(), id).unmarked === 0, ses.id);
    const added = await historySince(h0);
    assert.equal(added.length, 1);
    assert.equal(added[0].newValue, '55 marks changed');
    assert.deepEqual([await stored(order[0]), await stored(order[1]), await stored(order[2])], ['A', 'E', 'P']);
    assert.match(await page.locator('dialog[open] .rc-progress').textContent(), /57 of 57/);
    await page.locator('dialog[open] .dlg-foot .btn-primary').click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    // The grid shows the marks.
    await page.waitForFunction(([s, j]) => document.querySelector(`.att-grid tr[data-sid="${s}"]`).cells[3 + j].textContent === 'A', [order[0], 3]);
  });

  await check('Attendance: totals-only inputs accept whole numbers only; switching modes keeps the per-session marks', async () => {
    await resetSample();
    await gotoAttendanceGrid();
    const records = await page.evaluate(() => JSON.stringify(GT.store.course().attendance.records));
    await page.click('.att-mode[data-mode="totals"]');
    await page.locator('table.att-totals tbody tr[data-sid]').first().waitFor();
    assert.equal(await page.evaluate(() => GT.store.course().attendance.mode), 'totals');
    // Sessions held so far: the rate denominator.
    await page.fill('[data-f="held"]', '20');
    await page.press('[data-f="held"]', 'Enter');
    await page.waitForFunction(() => GT.store.course().attendance.totalsSessionsHeld === 20);
    const rows = await page.$$eval('table.att-totals tbody tr[data-sid]', (trs) => trs.map((tr) => tr.getAttribute('data-sid')));
    const sid = rows[0];
    const input = `[data-f="t:absent:${sid}"]`, err = `[data-err="t:absent:${sid}"]`;
    const before = await page.evaluate((s) => JSON.stringify(GT.store.course().attendance.totals[s] || null), sid);
    const h0 = await historyCount();
    for (const bad of ['2.5', '-1', 'abc', '3%']) {
      await page.fill(input, bad);
      await page.press(input, 'Enter');
      await page.waitForFunction((e) => document.querySelector(e).textContent.trim() !== '', err);
      assert.equal(await page.locator(input).evaluate((el) => el.classList.contains('is-invalid')), true, bad + ' is marked invalid');
      assert.equal(await page.evaluate((s) => JSON.stringify(GT.store.course().attendance.totals[s] || null), sid), before, bad + ' was not saved');
    }
    assert.equal(await historyCount(), h0, 'nothing refused is logged');
    assert.match(await page.locator(err).textContent(), /whole number/);
    // A whole number is saved; Enter moves to the next student.
    await page.fill(input, '3');
    await page.press(input, 'Enter');
    await page.waitForFunction((s) => GT.store.course().attendance.totals[s].absent === 3, sid);
    await page.waitForFunction((next) => document.activeElement && document.activeElement.getAttribute('data-f') === 't:absent:' + next, rows[1]);
    assert.equal((await page.locator(err).textContent()).trim(), '');
    // The row's numbers are the core's (rates over 20 sessions); streaks are n/a.
    // (The table re-renders on the next frame after the save.)
    await page.waitForFunction((s) => {
      const tr = document.querySelector(`table.att-totals tr[data-sid="${s}"]`);
      const sm = GT.attendance.summary(GT.store.course(), s);
      const want = [String(sm.totalAbsences), GT.util.formatPercent(sm.absenceRate, 1), GT.util.formatPercent(sm.unexcusedRate, 1), 'n/a in totals mode'];
      return !!tr && [...tr.cells].slice(4).map((td) => td.textContent.trim()).join('|') === want.join('|');
    }, sid);
    // Back to per session: every mark is still there.
    await page.click('.att-mode[data-mode="per-session"]');
    await page.waitForFunction((n) => document.querySelectorAll('.att-grid tbody tr[data-sid]').length === n, SAMPLE_STUDENTS);
    assert.equal(await page.evaluate(() => JSON.stringify(GT.store.course().attendance.records)), records);
    assert.deepEqual(await attSummaryMismatches(), []);
  });

  await check('Student details: attendance numbers, streak dates and every absence by date (excused vs unexcused)', async () => {
    await resetSample();
    const fail = await page.evaluate(() => {
      const c = GT.store.course(), w = GT.attendance.courseSummary(c).warnings.find((x) => x.kind === 'fail');
      const sm = GT.attendance.summary(c, w.studentId);
      const md = (d) => GT.util.MONTH_SHORT[Number(d.slice(5, 7)) - 1] + ' ' + Number(d.slice(8, 10));
      return { sid: w.studentId, sm, dates: w.streak.dates.map(md) };
    });
    await page.evaluate((s) => { GT.ui.openStudent(s); }, fail.sid);
    await page.locator('dialog[open] .sd-att-section').waitFor();
    const tiles = await page.$$eval('dialog[open] .sd-att-value', (v) => v.map((x) => x.textContent.trim()));
    const pct = (x) => page.evaluate((v) => GT.util.formatPercent(v, 1), x);
    assert.deepEqual(tiles, [String(fail.sm.excused), String(fail.sm.unexcused), String(fail.sm.totalAbsences),
      await pct(fail.sm.absenceRate), await pct(fail.sm.unexcusedRate), String(fail.sm.longestStreak)]);
    const warn = await page.locator('dialog[open] .sd-att-warn[data-att-warn="fail"]').textContent();
    assert.match(warn, /4 absences in a row/);
    assert.ok(warn.includes(fail.dates.join(', ')), 'streak dates ' + fail.dates.join(', '));
    assert.match(warn, /Warning only/);
    // Absences by date: one row per A or E mark, with the stored mark.
    const list = await page.$$eval('dialog[open] .sd-att-list tbody tr', (trs) => trs.map((tr) => [tr.getAttribute('data-att-date'), tr.getAttribute('data-att-mark')]));
    const want = await page.evaluate((s) => {
      const c = GT.store.course(), row = c.attendance.records[s] || {};
      return GT.attendance.heldSessions(c).filter((x) => row[x.id] === 'A' || row[x.id] === 'E').map((x) => [x.date, row[x.id]]);
    }, fail.sid);
    assert.deepEqual(list, want);
    assert.equal(list.length, fail.sm.totalAbsences);
    // The excused student: 4 excused (allowed) rows, no warning.
    await page.evaluate(() => document.querySelectorAll('dialog').forEach((d) => { d.close(); d.remove(); }));
    const exc = await page.evaluate(() => GT.store.course().students.find((s) => /excused by the instructor/.test(s.notes || '')).id);
    await page.evaluate((s) => { GT.ui.openStudent(s); }, exc);
    await page.locator('dialog[open] .sd-att-section').waitFor();
    assert.equal(await page.locator('dialog[open] .sd-att-list tbody tr[data-att-mark="E"]').count(), 4);
    assert.equal(await page.locator('dialog[open] .sd-att-list tbody tr[data-att-mark="A"]').count(), 0);
    assert.equal(await page.locator('dialog[open] .sd-att-warn').count(), 0);
    assert.match(await page.locator('dialog[open] .sd-att-list').textContent(), /Excused \(allowed, instructor-approved\)/);
    // "Open in Attendance" closes the dialog and selects the student's row.
    await page.click('dialog[open] [data-sd="attendance"]');
    await page.waitForFunction(() => GT.store.state.ui.activeView === 'attendance' && !document.querySelector('dialog[open]'));
    await page.waitForFunction((s) => document.querySelector(`.att-grid tbody tr.row-active[data-sid="${s}"]`), exc);
  });

  await check('Withdrawn students keep their absence numbers but get no attendance warning in Grades, Student details or Attendance', async () => {
    // Warnings cover active students only (STAGE3 §1): the three views must agree.
    await resetSample();
    const ids = await page.evaluate(() => {
      const c = GT.store.course();
      const w = c.students.find((s) => s.status === 'withdrawn');
      const a = GT.calc.sortStudents(c, GT.store.results(), 'name', 'asc').find((x) => {
        const sm = GT.attendance.summary(c, x.id);
        return x.status === 'active' && !sm.warning && !sm.overThreshold && sm.longestStreak < 2;
      });
      // Both: absent (not allowed) in the first 5 sessions, a run of 5 (fail) and above the threshold (3).
      GT.store.transact('Absent x5', (cc) => [w.id, a.id].forEach((sid) =>
        cc.attendance.sessions.slice(0, 5).forEach((x) => GT.attendance.setMark(cc, sid, x.id, 'A'))));
      const sw = GT.attendance.summary(GT.store.course(), w.id);
      return { w: w.id, a: a.id, warning: sw.warning, over: sw.overThreshold, unexcused: sw.unexcused };
    });
    assert.equal(ids.warning, 'fail');
    assert.equal(ids.over, true);
    // Grades grid: the numbers, but no icon, warning class or warning tooltip for the withdrawn row.
    await page.waitForFunction((s) => document.querySelector(`.gt-grid tbody tr[data-sid="${s}"] td.is-att-fail`), ids.a);
    const unxC = await gridCol('attUnx');
    assert.equal(await gridCell(ids.w, unxC).count(), 1, 'the withdrawn row is shown in Grades');
    const wCell = await gridCell(ids.w, unxC).evaluate((td) => ({ cls: td.className, icon: !!td.querySelector('.mk-att'), title: td.title }));
    assert.equal(wCell.icon, false);
    assert.doesNotMatch(wCell.cls, /is-att-warn|is-att-fail/);
    assert.doesNotMatch(wCell.title, /syllabus says F|Above the/);
    assert.match(wCell.title, /Withdrawn: no attendance warning/);
    assert.equal(await cellText(ids.w, unxC), String(ids.unexcused));
    assert.equal(await page.locator(`.gt-grid tbody tr[data-sid="${ids.w}"] td.is-att-warn`).count(), 0);
    assert.deepEqual((await gridAbsenceMismatches()).bad, []);
    // Student details: no F/drop or threshold callout and no highlight; the numbers and dates stay.
    await page.evaluate((s) => { GT.ui.openStudent(s); }, ids.w);
    await page.locator('dialog[open] .sd-att-section').waitFor();
    assert.equal(await page.locator('dialog[open] .sd-att-warn').count(), 0);
    assert.equal(await page.locator('dialog[open] .sd-att-section .is-over').count(), 0);
    assert.match(await page.locator('dialog[open] .sd-att-wd').textContent(), /Withdrawn: no attendance warning/);
    assert.equal(await page.locator('dialog[open] .sd-att-unx .sd-att-value').textContent(), String(ids.unexcused));
    assert.equal(await page.locator('dialog[open] .sd-att-list tbody tr[data-att-mark="A"]').count(), ids.unexcused);
    await page.evaluate(() => document.querySelectorAll('dialog').forEach((d) => { d.close(); d.remove(); }));
    // The active student with the same marks does get the warnings.
    await page.evaluate((s) => { GT.ui.openStudent(s); }, ids.a);
    await page.locator('dialog[open] .sd-att-warn[data-att-warn="fail"]').waitFor();
    assert.equal(await page.locator('dialog[open] .sd-att-unx.is-over').count(), 1);
    await page.evaluate(() => document.querySelectorAll('dialog').forEach((d) => { d.close(); d.remove(); }));
    // Attendance: the Warnings card lists the active student only; the withdrawn row has no warning class.
    await gotoView('attendance');
    await page.locator(`.att-warn-list .aw-item[data-sid="${ids.a}"]`).waitFor();
    assert.equal(await page.locator(`.att-warn-list .aw-item[data-sid="${ids.w}"]`).count(), 0);
    const wRow = page.locator(`.att-grid tbody tr[data-sid="${ids.w}"]`);
    if (!(await wRow.count())) await page.click('.view-root [data-act="withdrawn"]');
    await wRow.waitFor();
    assert.doesNotMatch(await wRow.getAttribute('class'), /w-fail|w-drop/);
    assert.equal(await wRow.locator('.sr-unx.over').count(), 0);
  });

  await check('Settings: the unexcused-threshold placeholder covers the total-absence threshold; both thresholds highlight', async () => {
    await resetSample();
    await gotoView('settings');
    const item = page.locator('.view-settings [data-ph="unexcusedThreshold"]');
    await item.waitFor();
    const text = await item.textContent();
    assert.match(text, /total-absence threshold/i);
    assert.match(text, /Total-absence threshold: off/);
    await item.locator('[data-act="open-view"]').click();
    await page.waitForFunction(() => GT.store.state.ui.activeView === 'attendance');
    await page.locator('[data-card="settings"] [data-f="tthr"]').waitFor();
    // Optional total threshold: 5 highlights the Total cell of everyone above 5; empty turns it off.
    const h0 = await historyCount();
    await page.fill('[data-f="tthr"]', '5');
    await page.press('[data-f="tthr"]', 'Enter');
    await page.waitForFunction(() => GT.store.course().attendance.totalAbsenceThreshold === 5);
    const logged = await historySince(h0);
    assert.equal(logged.length, 1);
    assert.deepEqual([logged[0].kind, logged[0].field, logged[0].oldValue, logged[0].newValue], ['settings', 'Total-absence threshold', 'off', '5']);
    const over = await page.evaluate(() => {
      const c = GT.store.course();
      return c.students.filter((s) => GT.attendance.summary(c, s.id).overTotalThreshold).length;
    });
    assert.ok(over > 0);
    await page.waitForFunction((n) => document.querySelectorAll('.att-grid tbody td.sr-tot.over').length === n, over);
    assert.deepEqual(await attSummaryMismatches(), []);
    // The Needs-confirmation item shows the new value.
    await gotoView('settings');
    assert.match(await page.locator('.view-settings [data-ph="unexcusedThreshold"]').textContent(), /more than 5 absences in total/);
    await gotoView('attendance');
    // A bad threshold is refused inline and not saved.
    await page.fill('[data-f="thr"]', '2.5');
    await page.press('[data-f="thr"]', 'Enter');
    await page.waitForFunction(() => document.querySelector('[data-err="thr"]').textContent.trim() !== '');
    assert.equal(await page.evaluate(() => GT.store.course().attendance.unexcusedThreshold), 3);
    await page.fill('[data-f="tthr"]', '');
    await page.press('[data-f="tthr"]', 'Enter');
    await page.waitForFunction(() => GT.store.course().attendance.totalAbsenceThreshold === null);
  });

  // ---------------------------------------------------------------- stage 4: export and import

  let exportedCsv = null; // the CSV of the next check, imported by the one after it
  let excelFromVendor = false; // set once an .xlsx export has loaded ExcelJS from vendor/ (checked at the end)

  await check('Export: the default preset downloads an .xlsx with the previous sheet\'s columns, real formulas that give the app\'s totals and letters, a frozen header and a filter (ExcelJS from file://, offline)', async () => {
    await resetSample();
    const net0 = network.length;
    await gotoView('exchange');
    assert.equal(await page.inputValue('#xc-preset'), 'builtin:previous');
    const keys = await page.evaluate(() => GT.views.exchange.exportKeys());
    assert.deepEqual(keys, await page.evaluate(() => GT.exporter.builtInPresets(GT.store.course())[0].columns));
    assert.equal(await page.evaluate(() => typeof window.ExcelJS), 'undefined', 'ExcelJS is loaded only when a workbook is made or read');
    await page.locator('#xc-check .xc-check-list').waitFor(); // the data check is shown above the buttons
    const x = await downloadFrom('#xc-dl-xlsx', 'suggested');
    assert.match(x.name, /^SE4351-grades-\d{4}-\d{2}-\d{2}_\d{4}\.xlsx$/);
    await page.locator('#xc-export-status .xc-status-ok').waitFor();
    const lib = await page.evaluate(() => ({
      ready: !!(window.ExcelJS && typeof ExcelJS.Workbook === 'function'),
      src: [...document.scripts].map((s) => s.src).filter((s) => /exceljs/i.test(s))
    }));
    assert.ok(lib.ready, 'ExcelJS did not initialize');
    assert.deepEqual(lib.src, [new URL('vendor/exceljs.min.js', APP_URL).href], 'ExcelJS must come from the local vendor folder');
    assert.deepEqual(network.slice(net0), [], 'the export made network requests');
    excelFromVendor = true;

    const { wb, ws, header } = await readXlsx(x.file);
    assert.deepEqual(header, PREVIOUS_LAYOUT);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Grades', 'Settings']);
    assert.deepEqual([ws.views[0].state, ws.views[0].xSplit, ws.views[0].ySplit], ['frozen', 3, 1]);
    assert.equal(ws.autoFilter, 'A1:S1');
    assert.match(readZipEntry(fs.readFileSync(x.file), 'xl/workbook.xml'), /<calcPr[^>]*fullCalcOnLoad="1"/);
    const app = await appRows();
    assert.equal(ws.actualRowCount, SAMPLE_STUDENTS + 1);
    const sheet = miniSheet(ws);
    const bad = [];
    app.forEach((s, i) => {
      const r = i + 2;
      const row = ws.getRow(r);
      const val = (c) => row.getCell(c).value;
      if (val(1) !== s.no || val(2) !== s.last || val(3) !== s.first) bad.push(r + ': not ' + s.last + ', ' + s.first);
      // Weighted = raw / max × weight (a late penalty would add MAX(0,raw-P)); each gives the app's number.
      for (let k = 0; k < 5; k++) {
        const f = row.getCell(9 + k).formula;
        if (!/^(MAX\(0,)?[D-H]\d+(-[\d.]+\))?\/\d+\*\d+$/.test(f || '')) bad.push(r + ': weighted formula ' + f);
        if (Math.abs(sheet.value('IJKLM'.charAt(k) + r) - s.weighted[k]) > 1e-9) bad.push(r + ': weighted ' + k);
      }
      if (row.getCell(14).formula !== 'ROUND(SUM(I' + r + ':M' + r + '),10)') bad.push(r + ': total formula ' + row.getCell(14).formula);
      if (val(14).result !== s.total || sheet.value('N' + r) !== s.total) bad.push(r + ': total ' + sheet.value('N' + r) + ' != ' + s.total);
      // No final letters yet: Letter Grade is the suggestion, a nested IF on the Total.
      if (!String(row.getCell(15).formula).startsWith('IF(N' + r + '>=97,"A+",IF(N' + r + '>=93,"A",')) bad.push(r + ': letter formula');
      if (val(15).result !== s.letter || sheet.value('O' + r) !== s.letter) bad.push(r + ': letter ' + sheet.value('O' + r) + ' != ' + s.letter);
      if ([val(16), val(17), val(18)].join() !== s.att.join()) bad.push(r + ': absences ' + [val(16), val(17), val(18)] + ' != ' + s.att);
      if (val(19) !== (s.status === 'withdrawn' ? 'Withdrawn' : 'Active')) bad.push(r + ': status ' + val(19));
    });
    assert.deepEqual(bad.slice(0, 5), []);
    assert.ok(app.some((s) => s.status === 'withdrawn'), 'the sample has a withdrawn student, exported with Status "Withdrawn"');
    assert.match(noteText(ws.getRow(1).getCell(9).note), /^= raw ÷ max × weight/);

    // Read back through the Import card: a Letter Grade column of formulas holds suggestions, so it is not
    // matched to the final letter (a CSV cannot tell; there it is, and the step-3 note says so).
    await page.setInputFiles('#xc-file', x.file);
    await page.locator('#xc-next-2').waitFor();
    assert.equal(await page.evaluate(() => GT.views.exchange.importState().sheetIndex), 0);
    await page.click('#xc-next-2');
    await page.locator('#xc-next-3').waitFor();
    const mapping = (await page.evaluate(() => GT.views.exchange.importState())).mapping;
    assert.deepEqual(mapping.slice(0, 16), ['no', 'lastName', 'firstName', 'raw:a_p1', 'raw:a_p2', 'raw:a_t1', 'raw:a_t2', 'raw:a_part',
      'weighted:a_p1', 'weighted:a_p2', 'weighted:a_t1', 'weighted:a_t2', 'weighted:a_part', 'ignore', 'ignore', 'excused']);
    await page.click('#xc-imp-body [data-act="imp-restart"]');
    await page.locator('#xc-pick').waitFor();
    assert.deepEqual(network.slice(net0), [], 'reading the workbook made network requests');
  });

  await check('Export after final letters: Letter Grade holds each student\'s effective letter; the CSV has a BOM, the same header and the same values', async () => {
    await resetSample();
    const picked = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      const act = GT.calc.sortStudents(c, r, 'total', 'desc').filter((s) => s.status === 'active');
      const other = (id) => (r.byId[id].letter === 'B' ? 'B-' : 'B');
      const set = [[act[0].id, r.byId[act[0].id].letter], [act[1].id, other(act[1].id)], [act[act.length - 1].id, 'F']];
      GT.store.transact('Final letters', (cc) => set.forEach(([id, l]) => GT.model.setFinalLetter(cc, id, l)));
      return set;
    });
    await gotoView('exchange');
    const x = await downloadFrom('#xc-dl-xlsx', 'final');
    const { ws, header } = await readXlsx(x.file);
    assert.deepEqual(header, PREVIOUS_LAYOUT);
    const app = await appRows();
    assert.equal(app.filter((s) => s.source === 'manual').length, picked.length);
    const bad = [];
    app.forEach((s, i) => {
      const cell = ws.getRow(i + 2).getCell(15);
      if (cell.formula) bad.push(s.last + ': Letter Grade is a formula');
      if (cell.value !== s.effective) bad.push(s.last + ': ' + cell.value + ' != ' + s.effective);
      const manual = /Final letter assigned by the instructor/.test(noteText(cell.note));
      if (manual !== (s.source === 'manual')) bad.push(s.last + ': note');
      if (!ws.getRow(i + 2).getCell(14).formula) bad.push(s.last + ': Total is not a formula');
    });
    assert.deepEqual(bad.slice(0, 5), []);

    const c = await downloadFrom('#xc-dl-csv', 'final');
    assert.match(c.name, /^SE4351-grades-\d{4}-\d{2}-\d{2}_\d{4}\.csv$/);
    const bytes = fs.readFileSync(c.file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM (Excel reads the file as UTF-8)');
    const text = bytes.toString('utf8');
    assert.equal(text.slice(1).split('\r\n')[0], PREVIOUS_LAYOUT.join(','));
    const rows = csvCore.parse(text);
    assert.equal(rows.length, SAMPLE_STUDENTS + 1);
    app.forEach((s, i) => {
      const row = rows[i + 1];
      assert.deepEqual([row[1], row[2], Number(row[13]), row[14], row[18]],
        [s.last, s.first, s.total, s.effective, s.status === 'withdrawn' ? 'Withdrawn' : 'Active']);
    });
    exportedCsv = { file: c.file, name: c.name, app };
  });

  await check('Import: the exported CSV into a new empty SE 4351 course gives every student the same total and letter; one Undo reverts it', async () => {
    assert.ok(exportedCsv, 'needs the CSV of the previous check');
    await page.evaluate(() => GT.store.addCourse(GT.model.createCourse('SE4351', { code: 'SE 4351 copy' })));
    await page.waitForFunction(() => GT.store.course().code === 'SE 4351 copy' && GT.store.course().students.length === 0);
    const h0 = await historyCount();
    const r = await importThroughCard(exportedCsv.file, {
      atMapping: (st) => {
        assert.deepEqual(st.mapping, ['no', 'lastName', 'firstName', 'raw:a_p1', 'raw:a_p2', 'raw:a_t1', 'raw:a_t2', 'raw:a_part',
          'weighted:a_p1', 'weighted:a_p2', 'weighted:a_t1', 'weighted:a_t2', 'weighted:a_part', 'ignore', 'finalLetter',
          'excused', 'absent', 'absencesTotal', 'status']);
        assert.equal(st.options.matchBy, 'name');
      },
      atPreview: (st) => assert.deepEqual([st.counts.new, st.counts.update, st.counts.skip], [SAMPLE_STUDENTS, 0, 0])
    });
    assert.equal(r.counts.new, SAMPLE_STUDENTS);
    const got = await appRows();
    const want = exportedCsv.app;
    assert.equal(got.length, want.length);
    const key = (s) => s.last + '\u0001' + s.first;
    const byName = new Map(got.map((s) => [key(s), s]));
    const bad = [];
    want.forEach((w) => {
      const g = byName.get(key(w));
      if (!g) { bad.push('missing ' + w.last); return; }
      if (g.total !== w.total) bad.push(w.last + ': total ' + g.total + ' != ' + w.total);
      if (g.effective !== w.effective) bad.push(w.last + ': letter ' + g.effective + ' != ' + w.effective);
      if (g.status !== w.status || g.no !== w.no) bad.push(w.last + ': status or No');
    });
    assert.deepEqual(bad.slice(0, 5), []);
    // Absence counts are stored as attendance totals (the new course stays per-session unless the TA switches).
    const totals = await page.evaluate(() => {
      const c = GT.store.course();
      return c.students.map((s) => { const t = c.attendance.totals[s.id] || {}; return [s.lastName + '\u0001' + s.firstName, (t.excused || 0) + ',' + (t.absent || 0)]; });
    });
    totals.forEach(([k, t]) => { const w = want.find((s) => key(s) === k); assert.equal(t, w.att[0] + ',' + w.att[1], k); });
    const added = await historySince(h0);
    assert.ok(added.length > 0 && added.every((e) => e.source === 'import'), 'every history entry of the import has source "import"');
    assert.equal(await page.evaluate(() => GT.store.undoLabel()), 'Import ' + path.basename(exportedCsv.file));
    await page.click('#btn-undo');
    await page.waitForFunction(() => GT.store.course().students.length === 0);
    await page.locator('.xc-done', { hasText: 'The import was undone' }).waitFor();
  });

  await check('Import: a CSV with the previous TA\'s headers (fake names) is matched automatically; scores, final letters and absences arrive', async () => {
    await resetSample();
    const rows = [OLD_SHEET_HEADERS,
      [1, 'Oldsheet', 'Student 01', 94, 88, 80, 70, 9.4, 17.6, 20, 28, 5, 80, 'B', '', 2],
      [2, 'Oldsheet', 'Student 02', 90, 85, 92.5, 81, 9, 17, 23.125, 32.4, 4.5, 86.025, 'b+', '', 0],
      [3, 'Oldsheet', 'Student 03', 70, 75, 55, 60, 7, 15, 13.75, 24, 3, 62.75, 'D', '', 5]];
    const file = path.join(TMP, 'previous-sheet.csv');
    fs.writeFileSync(file, csvCore.stringify(rows, { bom: true, eol: '\r\n' }));
    const other = await page.evaluate(() => GT.store.state.courses[1].id);
    await page.selectOption('#course-select', other);
    await page.waitForFunction((id) => GT.store.course().id === id, other);
    assert.equal(await page.evaluate(() => GT.store.course().attendance.mode), 'off');
    await importThroughCard(file, {
      atMapping: async (st) => {
        assert.deepEqual(st.mapping, ['no', 'lastName', 'firstName', 'raw:a_p1', 'raw:a_p2', 'raw:a_t1', 'raw:a_t2',
          'weighted:a_p1', 'weighted:a_p2', 'weighted:a_t1', 'weighted:a_t2', 'weighted:a_part', 'ignore', 'finalLetter', 'ignore', 'absencesTotal']);
        // Attendance is off in SE 6362: switching it to "Totals only" is offered and ticked.
        assert.equal(st.options.switchAttendanceToTotals, true);
        assert.equal(await page.isChecked('#xc-opt-att'), true);
        assert.match(await page.locator('.xc-map-notes').innerText(), /final letter/);
      },
      atPreview: (st) => {
        assert.equal(st.counts.new, 3);
        assert.equal(st.counts.lettersSkipped, 1, '"D" is not a letter of the graduate scale');
      }
    });
    const got = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      return {
        mode: c.attendance.mode,
        students: GT.calc.sortStudents(c, r, 'name', 'asc').map((s) => {
          const sm = GT.attendance.summary(c, s.id);
          return [s.no, s.lastName, s.firstName, ...['a_p1', 'a_p2', 'a_t1', 'a_t2', 'a_part'].map((a) => r.byId[s.id].items[a].raw),
            r.byId[s.id].total, s.finalLetter, sm.excused, sm.unexcused];
        })
      };
    });
    assert.equal(got.mode, 'totals');
    assert.deepEqual(got.students, [
      [1, 'Oldsheet', 'Student 01', 94, 88, 80, 70, 5, 80, 'B', 0, 2],
      [2, 'Oldsheet', 'Student 02', 90, 85, 92.5, 81, 4.5, 86.025, 'B+', 0, 0],
      [3, 'Oldsheet', 'Student 03', 70, 75, 55, 60, 3, 62.75, null, 0, 5]
    ]);
  });

  await check('Import into a finalized course: score changes are blocked (scores unchanged), final letters still arrive', async () => {
    await resetSample();
    const who = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      const act = GT.calc.sortStudents(c, r, 'name', 'asc').filter((s) => s.status === 'active' && typeof r.byId[s.id].items.a_t1.raw === 'number');
      GT.store.transact('Finalize scores', (cc) => GT.model.finalize(cc, new Date().toISOString(), ''));
      return act.slice(0, 2).map((s) => ({ id: s.id, last: s.lastName, first: s.firstName, t1: r.byId[s.id].items.a_t1.raw }));
    });
    const file = path.join(TMP, 'finalized.csv');
    fs.writeFileSync(file, csvCore.stringify([['Last Name', 'First Name', 'Test 1', 'Letter Grade'],
      [who[0].last, who[0].first, who[0].t1 === 50 ? 51 : 50, 'A'], [who[1].last, who[1].first, 'abc', 'B-']], { eol: '\r\n' }));
    const before = await gradeSnapshot();
    const h0 = await historyCount();
    await importThroughCard(file, {
      atMapping: async () => {
        await page.locator('.xc-final-note').waitFor();
        assert.match(await page.locator('#xc-map tr[data-col="2"]').innerText(), /blocked/);
      },
      atPreview: async (st) => {
        assert.equal(st.counts.blocked, 2);
        assert.equal(st.counts.changes, 2, 'only the two final letters change');
        assert.equal(await page.locator('.xc-changes tr.is-blocked').count(), 2);
      }
    });
    const after = await page.evaluate((ids) => {
      const c = GT.store.course(), r = GT.store.results();
      return ids.map((id) => [r.byId[id].items.a_t1.raw, GT.model.findStudent(c, id).finalLetter]);
    }, who.map((w) => w.id));
    assert.deepEqual(after, [[who[0].t1, 'A'], [who[1].t1, 'B-']]);
    // Totals, suggested letters and ranks are untouched.
    assert.equal(await gradeSnapshot(), before);
    const added = await historySince(h0);
    assert.deepEqual(added.map((e) => [e.source, e.field]), [['import', 'Final letter'], ['import', 'Final letter']]);
  });

  await check('Import (review V4R3-1): a letter typed into "Letter Grade" of an "Everything" export is imported as the final letter, or reported when "Final Letter" disagrees', async () => {
    await resetSample();
    // X has no final letter before the export; Y has one.
    const who = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      const act = GT.calc.sortStudents(c, r, 'name', 'asc').filter((s) => s.status === 'active');
      const x = act[0], y = act[1];
      const yFinal = r.byId[y.id].letter === 'B' ? 'B-' : 'B';
      GT.store.transact('Final letter', (cc) => GT.model.setFinalLetter(cc, y.id, yFinal));
      const other = (l) => (l === 'D' ? 'C' : 'D');
      return {
        x: { id: x.id, last: x.lastName, first: x.firstName, typed: other(r.byId[x.id].letter) },
        y: { id: y.id, last: y.lastName, first: y.firstName, final: yFinal, typed: other(yFinal) }
      };
    });
    await gotoView('exchange');
    await page.selectOption('#xc-preset', 'builtin:everything');
    await page.waitForFunction(() => JSON.stringify(GT.views.exchange.exportKeys()) === JSON.stringify(GT.exporter.builtInPresets(GT.store.course())[2].columns));
    const x = await downloadFrom('#xc-dl-xlsx', 'everything');
    const dst = path.join(TMP, 'everything-typed.xlsx');
    await editExport(x.file, dst, (ws, col, rowOf) => {
      ['Letter Grade', 'Suggested Letter (cutoffs)', 'Final Letter'].forEach((h) => assert.ok(col(h) > 0, 'the "Everything" export has ' + h));
      const cx = ws.getCell(rowOf(who.x.last, who.x.first), col('Letter Grade'));
      const cy = ws.getCell(rowOf(who.y.last, who.y.first), col('Letter Grade'));
      assert.match(noteText(cx.note), /^Suggestion from the cutoffs: /);
      assert.match(noteText(cy.note), /^Final letter assigned by the instructor/);
      cx.value = who.x.typed; // typed over a suggestion: "Final Letter" is empty for X
      cy.value = who.y.typed; // typed over Y's final letter: "Final Letter" still has the old one
    });
    const h0 = await historyCount();
    await importThroughCard(dst, {
      atMapping: async (st) => {
        const header = (await readXlsx(dst)).header;
        assert.equal(st.mapping[header.indexOf('Letter Grade')], 'ignore');
        assert.equal(st.mapping[header.indexOf('Final Letter')], 'finalLetter');
        const notes = (await page.locator('.xc-map-notes').innerText()).replace(/\s+/g, ' ');
        assert.match(notes, /Column [A-Z]+ \("Letter Grade"\) has 1 letter changed in the spreadsheet after the export\. It is imported as the final letter when column [A-Z]+ \("Final Letter"\) is empty for that student\./);
      },
      atPreview: async (st) => {
        assert.equal(st.counts.lettersFromOtherColumn, 1);
        assert.equal(st.counts.lettersNotImported, 1);
        const tiles = (await page.locator('.xc-counts').innerText()).replace(/\s+/g, ' ');
        assert.match(tiles, /1 final letter taken from another letter column/);
        assert.match(tiles, /1 final letter not imported/);
        const issues = await page.locator('.xc-issues').innerText();
        assert.ok(issues.includes('gives ' + who.y.typed + ', but final letters are read from column'), 'the conflict is reported: ' + issues);
      }
    });
    assert.deepEqual(await finalLetters([who.x.id, who.y.id]), [who.x.typed, who.y.final]);
    // (Absence totals of the file are stored too: this course records attendance per session.)
    const letters = (await historySince(h0)).filter((e) => e.field === 'Final letter');
    assert.deepEqual(letters.map((e) => [e.source, e.studentId, e.newValue]), [['import', who.x.id, who.x.typed]]);
  });

  await check('Import (review V4R3-2): step 3 counts the letters marked as final letters and those typed in after the export apart', async () => {
    await resetSample();
    await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      const s = GT.calc.sortStudents(c, r, 'name', 'asc').filter((x) => x.status === 'active')[10];
      GT.store.transact('Final letter', (cc) => GT.model.setFinalLetter(cc, s.id, r.byId[s.id].letter === 'A' ? 'B' : 'A'));
    });
    await gotoView('exchange');
    assert.equal(await page.inputValue('#xc-preset'), 'builtin:previous');
    const x = await downloadFrom('#xc-dl-xlsx', 'marked');
    const dst = path.join(TMP, 'marked-typed.xlsx');
    await editExport(x.file, dst, (ws, col) => {
      let typed = 0;
      for (let r = 2; r <= ws.rowCount && typed < 2; r++) {
        const cell = ws.getCell(r, col('Letter Grade'));
        if (/^Final letter assigned/.test(noteText(cell.note)) || !cellValue(cell)) continue;
        cell.value = cellValue(cell) === 'D' ? 'C' : 'D';
        typed++;
      }
      assert.equal(typed, 2);
    });
    await page.setInputFiles('#xc-file', dst);
    await page.locator('#xc-next-2').waitFor();
    await page.click('#xc-next-2');
    await page.locator('#xc-next-3').waitFor();
    const notes = page.locator('.xc-map-notes');
    assert.match((await notes.innerText()).replace(/\s+/g, ' '), new RegExp('Column O \\("Letter Grade"\\) comes from a Grade Tracker file: only its 1 letter marked as a final letter ' +
      '\\(assigned by the instructor\\) and its 2 letters changed in the spreadsheet after the export are imported as final letters\\. ' +
      'The other letters were suggestions from the cutoffs and are not stored\\.'));
    assert.doesNotMatch(await notes.innerHTML(), /marked as <strong>final letters<\/strong>/, 'the typed letters are not called "marked"');
    await page.click('#xc-imp-body [data-act="imp-restart"]');
    await page.locator('#xc-pick').waitFor();
  });

  // ---------------------------------------------------------------- stage 5: statistics

  await check('Statistics: the eLearning panel equals GT.stats.describe of the active totals; the 12 bins add up to Count', async () => {
    await resetSample();
    await gotoStats();
    const want = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      const totals = r.activeIds.map((id) => r.byId[id].total);
      const d = GT.stats.describe(totals);
      return {
        d, shown: Object.fromEntries(Object.keys(d).map((k) => [k, GT.util.formatNumber(d[k], c.settings.decimals)])),
        bins: GT.stats.bins10(totals).map((b) => b.count), labels: GT.stats.bins10(totals).map((b) => b.label),
        status: GT.stats.statusDistribution(c, r)
      };
    });
    assert.equal(want.d.count, SAMPLE_STUDENTS - 2, 'the sample has 2 withdrawn students, left out');
    const p = await statsPanel();
    for (const k of ['count', 'min', 'max', 'range', 'mean', 'median', 'sd', 'variance']) {
      assert.equal(Number(p[k].v), want.d[k], k + ' (value)');
      assert.equal(p[k].text, k === 'count' ? String(want.d.count) : want.shown[k], k + ' (as shown)');
    }
    assert.equal(p.bins.length, 12);
    assert.deepEqual(p.bins, want.bins);
    assert.equal(p.bins.reduce((a, b) => a + b, 0), want.d.count, 'the bins add up to Count');
    assert.deepEqual(await page.$$eval('#st-overview [data-bin]', (tds) => tds.map((td) => td.closest('tr').querySelector('th').textContent.trim())), want.labels);
    assert.deepEqual(want.labels, ['Greater than 100', '90 - 100', '80 - 89', '70 - 79', '60 - 69', '50 - 59', '40 - 49', '30 - 39', '20 - 29', '10 - 19', '0 - 9', 'Less than 0']);
    assert.deepEqual(p.status, want.status);
    assert.match(await page.textContent('#st-overview .st-pop'), new RegExp('Active students only \\(n = ' + want.d.count + '\\)'));
  });

  await check('Statistics: every chart is inline SVG (no library) with role="img", <title>, <desc> and a <title> per mark; "Show as table" works (ST3)', async () => {
    await resetSample();
    await gotoStats();
    const charts = await page.$$eval('#view svg.st-svg', (svgs) => svgs.map((s) => ({
      cls: s.getAttribute('class'), role: s.getAttribute('role'), title: !!s.querySelector(':scope > title'), desc: !!s.querySelector(':scope > desc'),
      marks: s.querySelectorAll('g > title').length
    })));
    assert.ok(charts.length >= 5, 'charts: ' + charts.length);
    charts.forEach((x) => {
      assert.equal(x.role, 'img', x.cls);
      assert.ok(x.title && x.desc, x.cls + ': <title> and <desc>');
      assert.ok(x.marks > 0, x.cls + ': a <title> per mark');
    });
    // The only script outside js/ is ExcelJS from vendor/, loaded by an .xlsx export earlier in the run.
    assert.deepEqual(await page.evaluate(() => [...document.scripts].map((sc) => sc.src).filter((src) => src && !/\/js\/[\w/.-]+\.js$/.test(src) && !/\/vendor\/exceljs\.min\.js$/.test(src))),
      [], 'no chart library is loaded');
    // "Show as table" on the histogram: one table row per bar (10-point bars by default).
    const bars = await page.$$eval('#st-hist .st-mark', (g) => g.length);
    assert.equal(bars, 10);
    await page.click('#st-hist [data-act="table"]');
    await page.waitForFunction((n) => document.querySelectorAll('#st-hist table tbody tr').length === n, bars);
    await page.click('#st-hist [data-act="table"]');
    await page.waitForFunction(() => document.querySelector('#st-hist [data-act="table"]').getAttribute('aria-pressed') === 'false' &&
      document.querySelectorAll('#st-hist .st-mark').length === 10);
  });

  await check('Statistics: a withdrawn student\'s scores change nothing in the panel; withdrawing an active student does', async () => {
    await resetSample();
    await gotoStats();
    const before = await statsPanel();
    const wid = await page.evaluate(() => {
      const w = GT.store.course().students.find((s) => s.status === 'withdrawn');
      GT.store.transact('Withdrawn scores', (c) => { GT.model.setEntry(c.scores, w.id, 'a_t1', { value: 100 }); GT.model.setEntry(c.scores, w.id, 'a_t2', { value: 0 }); });
      return w.id;
    });
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.raw === 100, wid);
    await rendered();
    assert.deepEqual(await statsPanel(), before);
    await page.evaluate(() => {
      const s = GT.store.course().students.find((x) => x.status === 'active');
      GT.store.transact('Withdraw', (c) => { GT.model.findStudent(c, s.id).status = 'withdrawn'; });
    });
    await page.waitForFunction((n) => Number(document.querySelector('#st-overview [data-stat="count"]').getAttribute('data-v')) === n, Number(before.count.v) - 1);
    const after = await statsPanel();
    assert.equal(after.bins.reduce((a, b) => a + b, 0), Number(after.count.v));
    assert.equal(after.status.withdrawn, before.status.withdrawn + 1);
  });

  await check('Statistics: the what-if result chosen in the UI equals calc.neededScore (the chosen letter and the every-letter table)', async () => {
    await resetSample();
    await gotoStats();
    const sid = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      return GT.calc.sortStudents(c, r, 'name', 'asc').filter((x) => x.status === 'active')[7].id;
    });
    await page.selectOption('#st-wi-s', sid);
    await page.selectOption('#st-wi-a', 'a_t2');
    await page.selectOption('#st-wi-l', 'B+');
    const want = await page.evaluate((id) => {
      const c = GT.store.course(), s = GT.model.findStudent(c, id);
      const n = GT.calc.neededScore(c, s, 'a_t2', 'B+');
      return {
        needed: String(n.needed), kind: n.alreadyReached ? 'reached' : n.reachable ? 'needs' : 'unreachable',
        table: GT.model.scaleLetters(c).map((l) => [l, String(GT.calc.neededScore(c, s, 'a_t2', l).needed)])
      };
    }, sid);
    await page.waitForFunction(([id, w]) => {
      const out = document.querySelector('#st-whatif [data-wi-out]');
      return out && document.querySelector('#st-wi-s').value === id && document.querySelector('#st-wi-a').value === 'a_t2' &&
        document.querySelector('#st-wi-l').value === 'B+' && out.getAttribute('data-needed') === w.needed;
    }, [sid, want]);
    assert.equal(await page.getAttribute('#st-whatif [data-wi-out]', 'data-wi-out'), want.kind);
    assert.deepEqual(await page.$$eval('#st-whatif [data-wl]', (tds) => tds.map((td) => [td.getAttribute('data-wl'), td.getAttribute('data-needed')])), want.table);
  });

  await check('Statistics: cutoff planner sandbox edits change nothing stored until "Apply cutoffs to Settings"; Apply is one undoable step', async () => {
    await resetSample();
    await gotoStats();
    const stored = () => page.evaluate(() => ({
      scale: JSON.stringify(GT.store.course().settings.letterScale), history: GT.store.course().history.length, undo: GT.store.canUndo() && GT.store.undoLabel()
    }));
    const before = await stored();
    const idx = await page.evaluate(() => GT.views.stats.sandbox().findIndex((x) => x.letter === 'B'));
    const input = page.locator('[data-sb="' + idx + '"]');
    await input.fill('81.5');
    await page.waitForFunction((i) => GT.views.stats.sandbox()[i].min === 81.5, idx);
    await input.press('ArrowUp'); // nudges by 0.5
    await page.waitForFunction((i) => GT.views.stats.sandbox()[i].min === 82, idx);
    // The simulated letters follow live: the list of students whose letter would change.
    const changes = await page.evaluate(() => GT.stats.simulate(GT.store.course(), GT.store.results(), GT.views.stats.sandbox()).changes.length);
    await page.waitForFunction((n) => new RegExp(n + ' students?').test(document.querySelector('#st-planner .st-pl-sum').textContent), changes);
    assert.deepEqual(await stored(), before, 'typing in the sandbox stores nothing and adds no undo step');
    await page.click('[data-act="sb-apply"]');
    const dlg = page.locator('dialog[open]');
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /needs confirmation/);
    await dlg.locator('.dlg-foot .btn-primary').click();
    await page.waitForFunction(() => GT.store.course().settings.letterScale.find((x) => x.letter === 'B').min === 82);
    assert.equal(await page.evaluate(() => GT.store.undoLabel()), 'Apply cutoffs from the planner');
    assert.equal(await page.evaluate(() => GT.model.isConfirmed(GT.store.course(), 'letterScale')), false, 'the cutoffs stay a placeholder until confirmed in Settings');
    await page.evaluate(() => GT.store.undo());
    await page.waitForFunction((s) => JSON.stringify(GT.store.course().settings.letterScale) === s, before.scale);
  });

  await check('Statistics: "Use these as final letters…" sets the final letters (students without one, by default) in ONE undoable step', async () => {
    await resetSample();
    await gotoStats();
    const manual = await page.evaluate(() => {
      const id = GT.store.results().activeIds[4];
      GT.store.transact('Final letter', (c) => GT.model.setFinalLetter(c, id, 'F'));
      return id;
    });
    await page.waitForFunction(() => /^1 of 57 final letters assigned/.test(document.querySelector('#st-letters [data-stat="assigned"]').textContent));
    const want = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results(), sb = GT.views.stats.sandbox();
      return { n: GT.stats.simulate(c, r, sb).finalChanges.onlyEmpty, items: GT.stats.lettersFromScale(c, r, sb, { onlyEmpty: true }) };
    });
    assert.equal(want.n, 56);
    await page.click('[data-act="sb-final"]');
    const dlg = page.locator('dialog[open]');
    await dlg.waitFor();
    assert.equal(await dlg.locator('input[name="st-uf"]:checked').inputValue(), 'empty', '"Only students without a final letter" is the default');
    assert.match(await dlg.locator('.dlg-foot .btn-primary').innerText(), /Set 56 final letters/);
    await dlg.locator('.dlg-foot .btn-primary').click();
    await dlg.waitFor({ state: 'detached' });
    await page.waitForFunction(() => /^57 of 57 final letters assigned/.test(document.querySelector('#st-letters [data-stat="assigned"]').textContent));
    const after = await page.evaluate(() => {
      const c = GT.store.course();
      return {
        letters: Object.fromEntries(c.students.map((s) => [s.id, s.finalLetter])),
        withdrawn: c.students.filter((s) => s.status === 'withdrawn').map((s) => s.finalLetter), label: GT.store.undoLabel()
      };
    });
    assert.equal(after.letters[manual], 'F', 'a final letter chosen by hand stays');
    assert.deepEqual(after.withdrawn, [null, null], 'withdrawn students are skipped');
    want.items.forEach((it) => assert.equal(after.letters[it.studentId], it.letter));
    assert.match(after.label, /Use planner letters as final letters/);
    // One step: Ctrl+Z takes every one of them back (only the hand-picked F stays).
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Control+z');
    await page.waitForFunction((id) => GT.store.course().students.filter((s) => s.finalLetter !== null).map((s) => s.id).join() === id, manual);
  });

  // ---------------------------------------------------------------- stage 6: late work, Summary tab, polish

  await check('Late work (Ctrl+L): 1 week late lowers the total by weight × 10 / 100; "penalty waived" restores it; undo works; History has "late" entries', async () => {
    await resetSample();
    const s = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      const x = GT.calc.sortStudents(c, r, 'name', 'asc').find((st) => st.status === 'active' && r.byId[st.id].items.a_t1.state === 'number' &&
        r.byId[st.id].items.a_t1.raw >= 20 && !r.byId[st.id].items.a_t1.weeksLate);
      return { id: x.id, total: r.byId[x.id].total, raw: r.byId[x.id].items.a_t1.raw };
    });
    const weight = await page.evaluate(() => GT.model.findAssessment(GT.store.course(), 'a_t1').weight);
    const t1C = await gridCol('raw', 'Test 1');
    const h0 = await historyCount();
    const dlg = await openLateWork(s.id, t1C);
    assert.match(await dlg.locator('.late-where').innerText(), /Individual score/);
    await page.fill('#late-weeks', '1');
    const preview = await dlg.locator('#late-preview').innerText();
    assert.ok(preview.includes('Raw ' + s.raw + ' − 10 (1 week × 10 points) = ' + (s.raw - 10)), preview);
    assert.match(preview, /→ weighted/);
    await page.keyboard.press('Enter');
    await dlg.waitFor({ state: 'detached' });
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.weeksLate === 1, s.id);
    const late = await page.evaluate((id) => GT.store.results().byId[id].total, s.id);
    assert.ok(Math.abs(late - (s.total - weight * 10 / 100)) < 1e-9, 'total ' + late + ' != ' + s.total + ' − ' + weight + ' × 10 / 100');
    assert.deepEqual(await page.evaluate((n) => GT.store.course().history.slice(n).map((h) => [h.kind, h.field, h.oldValue, h.newValue]), h0),
      [['late', 'Test 1: weeks late', '', '1']]);
    // The cell shows the "L1" badge, and the focus is back on it.
    await page.waitForFunction(([id, c]) => {
      const td = document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"] td[data-c="' + c + '"]');
      return td && td.querySelector('.mk-late') && td.querySelector('.mk-late').textContent === 'L1' && document.activeElement === td;
    }, [s.id, t1C]);
    assert.match(await gridCell(s.id, t1C).getAttribute('title'), /1 week late: −10 points, adjusted score/);
    // Waive it, through the cell menu this time (Shift+F10).
    await page.keyboard.press('Shift+F10');
    await page.locator('.menu [role="menuitem"]', { hasText: 'Late work (1 week)' }).click();
    await dlg.waitFor();
    await page.check('#late-waived');
    assert.match(await dlg.locator('#late-preview').innerText(), /Penalty waived/);
    await dlg.locator('.btn-primary').click();
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.waived === true, s.id);
    assert.ok(Math.abs((await page.evaluate((id) => GT.store.results().byId[id].total, s.id)) - s.total) < 1e-9, 'waived restores the total');
    await page.waitForFunction(([id, c]) => {
      const b = document.querySelector('.gt-grid tbody tr[data-sid="' + id + '"] td[data-c="' + c + '"] .mk-late');
      return b && b.classList.contains('is-waived') && b.textContent === 'L1✓';
    }, [s.id, t1C]);
    // Undo the waiver, then the late work.
    await page.keyboard.press('Control+z');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.waived === false, s.id);
    assert.ok(Math.abs((await page.evaluate((id) => GT.store.results().byId[id].total, s.id)) - late) < 1e-9);
    await page.keyboard.press('Control+z');
    await page.waitForFunction((id) => GT.store.results().byId[id].items.a_t1.weeksLate === 0, s.id);
    assert.ok(Math.abs((await page.evaluate((id) => GT.store.results().byId[id].total, s.id)) - s.total) < 1e-9);
    assert.deepEqual(await page.evaluate((n) => GT.store.course().history.slice(n).map((h) => h.source + ':' + h.kind), h0),
      ['edit:late', 'edit:late', 'undo:late', 'undo:late']);
    // The History tab lists them as late-work changes.
    await gotoView('history');
    assert.match(await page.locator('.hist-table tbody tr').first().innerText(), /weeks late|waived/i);
  });

  await check('Late work: on a team-graded cell without an override it goes on the team score and reaches every member', async () => {
    await resetSample();
    const info = await page.evaluate(() => {
      const c = GT.store.course(), r = GT.store.results();
      const t = c.teams.find((tm) => GT.model.teamMembers(c, tm.id).every((m) => !(GT.model.getEntry(c.scores, m.id, 'a_p1') || {}).override));
      return { team: t.id, name: t.name, members: GT.model.teamMembers(c, t.id).map((m) => ({ id: m.id, total: r.byId[m.id].total })) };
    });
    const p1C = await gridCol('raw', 'Project I');
    const dlg = await openLateWork(info.members[0].id, p1C);
    assert.match((await dlg.locator('.late-where').innerText()).replace(/\s+/g, ' '), new RegExp(info.name + ' team score.*whole team'));
    await page.fill('#late-weeks', '2');
    await dlg.locator('.btn-primary').click();
    await page.waitForFunction((t) => (GT.model.getEntry(GT.store.course().teamScores, t, 'a_p1') || {}).weeksLate === 2, info.team);
    const after = await page.evaluate((ids) => ids.map((id) => GT.store.results().byId[id].total), info.members.map((m) => m.id));
    // Project I weighs 10%: 2 weeks = 20 points off the raw score = 2 points off the total.
    info.members.forEach((m, i) => assert.ok(Math.abs(after[i] - (m.total - 2)) < 1e-9, 'member ' + i + ': ' + after[i] + ' != ' + (m.total - 2)));
    const own = await page.evaluate((ids) => ids.map((id) => GT.model.getEntry(GT.store.course().scores, id, 'a_p1') || null), info.members.map((m) => m.id));
    assert.ok(own.every((e) => !e || !e.weeksLate), 'no member entry gets the late info');
  });

  await check('Late work: in a finalized course the dialog opens read-only ("Unlock them to change late work")', async () => {
    await resetSample();
    await page.evaluate(() => GT.store.transact('Finalize scores', (c) => GT.model.finalize(c, new Date().toISOString(), '')));
    await page.locator('.gt-grid.locked').waitFor();
    const [sid] = await activeRun(1);
    const t1C = await gridCol('raw', 'Test 1');
    const before = await page.evaluate((id) => JSON.stringify(GT.model.getEntry(GT.store.course().scores, id, 'a_t1') || null), sid);
    const dlg = await openLateWork(sid, t1C);
    assert.match(await dlg.innerText(), /Scores are finalized\. Unlock them to change late work/);
    assert.equal(await page.isDisabled('#late-weeks'), true);
    assert.equal(await page.isDisabled('#late-waived'), true);
    await dlg.locator('.btn-primary').click(); // Close
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate((id) => JSON.stringify(GT.model.getEntry(GT.store.course().scores, id, 'a_t1') || null), sid), before);
  });

  await check('Summary: totals, letters and ranks equal the results; withdrawn students come last, marked W', async () => {
    await resetSample();
    await gotoSummary();
    const got = await summaryTable();
    const want = await summaryExpected();
    assert.equal(got.rows.length, SAMPLE_STUDENTS);
    assert.deepEqual(got.rows, want);
    assert.equal(got.letterHead, 'Letter (suggested)', 'no final letters yet: the column holds the suggestion');
    const nWd = want.filter((r) => r.wd).length;
    assert.equal(nWd, 2);
    assert.ok(got.rows.slice(-nWd).every((r) => r.wd && r.letter === 'W' && r.rank === '—'), 'withdrawn students last, marked W, not ranked');
    assert.ok(got.rows.slice(0, -nWd).every((r) => !r.wd));
  });

  await check('Summary: the letter column says "Letter (suggested)" until final letters exist, then "Final letter" ("—" for students without one)', async () => {
    await resetSample();
    await gotoSummary();
    const items = await page.evaluate(() => {
      const act = GT.store.course().students.filter((s) => s.status === 'active').slice(0, 3);
      const it = act.map((s, i) => ({ studentId: s.id, letter: ['A', 'B+', 'C'][i] }));
      GT.store.transact('Final letters', (c) => GT.model.setFinalLetters(c, it));
      return it;
    });
    await page.waitForFunction(() => document.querySelector('.sum-grades thead th.sum-c-letter').textContent.replace(/\s+/g, ' ').trim() === 'Final letter');
    const got = await summaryTable();
    assert.deepEqual(got.rows, await summaryExpected());
    assert.equal(got.rows.filter((r) => r.letter === '—').length, SAMPLE_STUDENTS - 2 - items.length);
    await page.evaluate((it) => GT.store.transact('Clear', (c) => GT.model.setFinalLetters(c, it.map((x) => ({ studentId: x.studentId, letter: null })))), items);
    await page.waitForFunction(() => document.querySelector('.sum-grades thead th.sum-c-letter').textContent.replace(/\s+/g, ' ').trim() === 'Letter (suggested)');
  });

  await check('Summary: "Hide names (use No only)" removes every student name from the page', async () => {
    await resetSample();
    await clearToasts();
    await gotoSummary();
    await page.click('.sum-opts input[data-pref="hideNames"]');
    await page.waitForFunction(() => !document.querySelector('.sum-grades .sum-c-name'));
    const leaks = await page.evaluate(() => {
      const html = document.documentElement.outerHTML, out = [];
      GT.store.course().students.forEach((s) => [s.lastName, s.firstName].forEach((n) => { if (n && html.includes(n)) out.push(n); }));
      return out;
    });
    assert.deepEqual(leaks, []);
    assert.equal(await page.locator('.sum-grades tbody tr[data-sid]').count(), SAMPLE_STUDENTS, 'every row stays, by No');
    await page.click('.sum-opts input[data-pref="hideNames"]');
    await page.waitForFunction(() => document.querySelector('.sum-grades .sum-c-name .pii'));
  });

  await check('Summary: page.pdf (Letter, landscape) makes a PDF; print hides the options and the app chrome and never blurs names', async () => {
    await resetSample();
    await page.evaluate(() => GT.store.setUi({ privacy: true }));
    await gotoSummary();
    await page.waitForFunction(() => document.body.classList.contains('privacy-on'));
    await page.emulateMedia({ media: 'print' });
    try {
      const vis = await page.evaluate(() => ({
        options: getComputedStyle(document.querySelector('.sum-options')).display,
        chrome: getComputedStyle(document.querySelector('.app-head')).display,
        thead: getComputedStyle(document.querySelector('.sum-grades thead')).display,
        blur: getComputedStyle(document.querySelector('.sum-grades .pii')).filter,
        background: getComputedStyle(document.body).backgroundColor
      }));
      assert.deepEqual(vis, { options: 'none', chrome: 'none', thead: 'table-header-group', blur: 'none', background: 'rgb(255, 255, 255)' });
      const file = path.join(TMP, 'summary.pdf');
      await page.pdf({ path: file, format: 'Letter', landscape: true, printBackground: true });
      const pdf = fs.readFileSync(file).toString('latin1');
      assert.ok(pdf.startsWith('%PDF-'), 'not a PDF file');
      assert.match(pdf, /\/MediaBox\s*\[\s*0 0 792 612\s*\]/, 'Letter landscape (792 × 612 points)');
      const pages = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
      assert.ok(pages >= 1 && pages <= 6, pages + ' pages');
    } finally {
      await page.emulateMedia({ media: 'screen' });
      await page.evaluate(() => GT.store.setUi({ privacy: false }));
    }
  });

  await check('every tab renders in light and dark mode, and at 390 px, with no console error and no sideways page scrolling', async () => {
    await resetSample({ lateWork: true });
    const errors0 = consoleErrors.length + pageErrors.length;
    const tabs = await page.$$eval('#tabs .tab', (els) => els.map((e) => e.getAttribute('data-view')));
    assert.deepEqual(tabs, ['grades', 'students', 'attendance', 'stats', 'settings', 'history', 'exchange', 'summary']);
    const sweep = async (label) => {
      for (const id of tabs) {
        await gotoView(id);
        await rendered();
        const r = await page.evaluate(() => ({
          failed: /failed to render/.test(document.getElementById('view').textContent),
          overflow: document.documentElement.scrollWidth - window.innerWidth
        }));
        assert.equal(r.failed, false, label + ': ' + id + ' failed to render');
        assert.ok(r.overflow <= 0, label + ': ' + id + ' scrolls sideways by ' + r.overflow + ' px');
      }
    };
    try {
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => GT.store.setUi({ theme: t }), theme);
        await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme);
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), theme === 'dark' ? 'rgb(15, 20, 25)' : 'rgb(246, 247, 249)');
        await sweep(theme);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await sweep('390 px, dark');
    } finally {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.evaluate(() => GT.store.setUi({ theme: 'light' }));
    }
    assert.deepEqual(consoleErrors.concat(pageErrors).slice(errors0), [], 'errors while the tabs rendered');
    assert.equal(consoleErrors.length + pageErrors.length, errors0);
  });

  await check('every tab shows a friendly empty state for a course without students (Attendance: also when it is off)', async () => {
    await resetSample();
    const other = await page.evaluate(() => GT.store.state.courses.find((c) => c.template === 'SE6362').id);
    await page.selectOption('#course-select', other);
    await page.waitForFunction((id) => GT.store.course().id === id && GT.store.course().students.length === 0, other);
    const expected = {
      grades: ['.grid-empty', /No students in SE 6362 yet/],
      students: ['.empty-state', /No students in SE 6362 yet/],
      attendance: ['.att-off-state', /Attendance is not tracked for SE 6362/],
      stats: ['.st-empty', /No statistics yet/],
      settings: ['.view-settings', /Assessments and weights/],
      history: ['.hist-empty-host', /No changes recorded yet/],
      exchange: ['.view-exchange', /no students yet/],
      summary: ['.sum-empty', /No students in this course yet/]
    };
    for (const id of Object.keys(expected)) {
      await gotoView(id);
      const [sel, re] = expected[id];
      const el = page.locator('#view ' + sel).first();
      await el.waitFor();
      assert.match(await el.innerText(), re, id);
      assert.equal(/failed to render/.test(await page.locator('#view').innerText()), false, id + ' failed to render');
    }
    // Attendance turned on, still without students: the no-students state.
    await gotoView('attendance');
    await page.click('.att-off-state [data-act="turn-on"][data-mode="per-session"]');
    await page.locator('#view .att-empty', { hasText: 'No students yet' }).waitFor();
  });

  await check('Help / About from the status bar: what the app is, offline, where the data is stored, a backup reminder, version 1.0.0 and a relative README.md link', async () => {
    await resetSample();
    await page.click('#statusbar [data-act="about"]');
    const dlg = page.locator('dialog[open]', { hasText: 'About Grade Tracker' });
    await dlg.waitFor();
    const text = (await dlg.innerText()).replace(/\s+/g, ' ');
    for (const re of [/Version 1\.0\.0/, /grade book for teaching assistants/, /Offline and private/, /no student data leaves this computer/,
      /Where your data is stored/, /Only in this browser, on this computer: IndexedDB/, /clearing this browser’s site data or browsing data deletes it/,
      /Back up regularly/, /Last backup: /, /README\.md/]) assert.match(text, re);
    assert.equal(await page.evaluate(() => GT.app.VERSION), JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    const link = dlg.locator('a.about-readme');
    assert.equal(await link.getAttribute('href'), 'README.md', 'a relative link');
    const href = await link.evaluate((a) => a.href);
    assert.equal(href, new URL('README.md', APP_URL).href);
    assert.ok(fs.existsSync(fileURLToPath(href)), 'README.md is next to index.html');
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-act')), 'about', 'the focus returns to the Help button');
  });

  await check('the shortcuts list ("?") names every shortcut that exists, and "/", Alt+↓, Space and Alt+1…8 work', async () => {
    await resetSample();
    const t1C = await gridCol('raw', 'Test 1');
    const [sid] = await activeRun(1);
    await gridCell(sid, t1C).click();
    await page.keyboard.press('?');
    const dlg = page.locator('dialog[open]', { hasText: 'Keyboard shortcuts' });
    await dlg.waitFor();
    const list = await dlg.evaluate((d) => [...d.querySelectorAll('.shortcut-h')].map((h) => {
      const rows = [], cells = [...h.nextElementSibling.children];
      for (let i = 0; i + 1 < cells.length; i += 2) rows.push([cells[i].textContent.replace(/\s+/g, ' ').trim(), cells[i + 1].textContent]);
      return { group: h.textContent, rows };
    }));
    assert.deepEqual(list.map((g) => g.group), ['Everywhere', 'Grades grid', 'Attendance grid (per session)', 'Roll call', 'Statistics and Import / Export']);
    const has = (group, keys, re) => {
      const g = list.find((x) => x.group === group);
      assert.ok(g && g.rows.some((r) => r[0] === keys && re.test(r[1])), group + ': no "' + keys + '" row matching ' + re);
    };
    has('Everywhere', 'Ctrl+Z / Ctrl+Y', /Undo \/ redo/);
    has('Everywhere', 'Alt+1 … Alt+8', /Switch tabs/);
    has('Everywhere', '/', /search box/);
    has('Everywhere', '?', /this list/);
    for (const k of ['Arrow keys', 'Tab / Shift+Tab', 'Enter', 'F2', 'Shift+Arrow / Shift+Click', 'Shift+Space / Ctrl+Space', 'Ctrl+A', 'Ctrl+Enter',
      'Home / End', 'Ctrl+Home / Ctrl+End', 'PageUp / PageDown', 'Ctrl+Arrow', 'Delete / Backspace', 'Esc', 'Ctrl+C / Ctrl+V']) has('Grades grid', k, /./);
    has('Grades grid', 'Alt+↓', /drop-down list \(Final letter, Class\/Project Participation, Team\)/);
    has('Grades grid', 'Shift+F10 / Menu key', /Cell and column actions/);
    has('Grades grid', 'Ctrl+L', /Late work of the active score cell/);
    has('Attendance grid (per session)', 'P / A / E', /Present \/ Absent \(not allowed\) \/ Excused \(allowed\)/);
    has('Attendance grid (per session)', 'Space', /Present, Absent, Excused, no mark/);
    has('Attendance grid (per session)', 'Delete / Backspace', /Clear the mark/);
    has('Roll call', 'P / A / E', /current student/);
    has('Roll call', '↑ / ↓', /Previous \/ next student/);
    has('Statistics and Import / Export', 'Alt+↑ / Alt+↓', /move the column/);
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    // "/" jumps to the search box.
    await gridCell(sid, t1C).click();
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('grid-search'));
    // Alt+↓ opens the Final letter drop-down list; Esc closes it without a change.
    const fC = await gridCol('final');
    await gridCell(sid, fC).click();
    await page.keyboard.press('Alt+ArrowDown');
    await page.locator('select.dd-editor').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('select.dd-editor').waitFor({ state: 'detached' });
    assert.equal((await finalLetters([sid]))[0], null);
    // Attendance: Delete clears a mark; Space then changes it: no mark → Present → Absent → Excused → no mark.
    await gotoAttendanceGrid();
    const quiet = await quietStudent();
    const j = 2;
    await attCell(quiet, j).click();
    await page.keyboard.press('Delete');
    await page.waitForFunction(([id, k]) => {
      const c = GT.store.course(), ses = c.attendance.sessions[k];
      return !(c.attendance.records[id] || {})[ses.id];
    }, [quiet, j]);
    for (const want of ['P', 'A', 'E', '']) {
      await page.keyboard.press('Space');
      await page.waitForFunction(([id, k, w]) => {
        const c = GT.store.course(), ses = c.attendance.sessions[k];
        return ((c.attendance.records[id] || {})[ses.id] || '') === w;
      }, [quiet, j, want]);
    }
    // Alt+1 … Alt+8 switch tabs, in tab order.
    const tabs = await page.$$eval('#tabs .tab', (els) => els.map((e) => e.getAttribute('data-view')));
    for (let i = tabs.length - 1; i >= 0; i--) {
      await page.keyboard.press('Alt+' + (i + 1));
      await page.waitForFunction((v) => GT.store.state.ui.activeView === v, tabs[i]);
    }
  });

  await check('privacy mode blurs every student name (.pii) in the Grades, Students and Attendance views', async () => {
    await resetSample();
    await page.click('#btn-privacy');
    await page.waitForFunction(() => document.body.classList.contains('privacy-on'));
    for (const view of ['grades', 'students', 'attendance']) {
      await gotoView(view);
      const r = await page.evaluate(() => {
        const names = new Set();
        GT.store.course().students.forEach((s) => { names.add(s.lastName); names.add(s.firstName); names.add(s.lastName + ', ' + s.firstName); });
        const walker = document.createTreeWalker(document.getElementById('view'), NodeFilter.SHOW_TEXT);
        let shown = 0; const exposed = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n.nodeValue.trim();
          if (!names.has(t)) continue;
          shown++;
          const pii = n.parentElement.closest('.pii');
          if (!pii || !/blur/.test(getComputedStyle(pii).filter)) exposed.push(t);
        }
        return { shown, exposed: exposed.slice(0, 5) };
      });
      assert.ok(r.shown >= SAMPLE_STUDENTS, view + ': names should be on screen (' + r.shown + ')');
      assert.deepEqual(r.exposed, [], view + ': names not blurred');
    }
    await page.click('#btn-privacy');
    await page.waitForFunction(() => !document.body.classList.contains('privacy-on'));
    const filter = await page.locator('#view .pii').first().evaluate((e) => getComputedStyle(e).filter);
    assert.equal(filter, 'none');
  });

  await check('dark theme applies from the theme menu', async () => {
    await resetSample();
    await openMenuItem('#btn-theme', 'Dark');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
    const dark = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      grid: getComputedStyle(document.querySelector('.gt-grid td')).color
    }));
    assert.equal(dark.bg, 'rgb(15, 20, 25)');
    assert.equal(dark.scheme, 'dark');
    assert.equal(await page.evaluate(() => GT.store.state.ui.theme), 'dark');
    await openMenuItem('#btn-theme', 'Light');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 247, 249)');
  });

  await check('backup download and restore round trip', async () => {
    await resetSample();
    const sid = (await studentsByName())[0].id;
    await page.evaluate((id) => {
      GT.store.setMeta({ lastBackupAt: null });
      GT.store.transact('Probe', (c) => {
        c.title = 'Backup Probe';
        GT.model.setEntry(c.scores, id, 'a_t2', { value: 42.5 });
      });
    }, sid);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup-chip')]);
    const file = path.join(TMP, download.suggestedFilename());
    await download.saveAs(file);
    assert.match(download.suggestedFilename(), /^grade-tracker-backup-\d{4}-\d{2}-\d{2}_\d{4}\.json$/);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(json.app, 'grade-tracker');
    assert.equal(json.kind, 'backup');
    assert.equal(json.state.courses[0].students.length, SAMPLE_STUDENTS);
    assert.equal(json.state.courses[0].title, 'Backup Probe');
    await page.waitForFunction(() => GT.store.state.meta.lastBackupAt !== null &&
      /just now/.test(document.getElementById('backup-chip').textContent));
    // Change the data, then restore the file through Data → Restore.
    await page.evaluate(() => GT.store.transact('Wreck', (c) => { c.title = 'Changed'; c.students.splice(0, 10); }));
    await page.click('#btn-data-menu');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('.menu [role="menuitem"]', { hasText: 'Restore from backup' }).click()
    ]);
    await chooser.setFiles(file);
    await page.locator('dialog[open]', { hasText: 'Restore from backup?' }).waitFor();
    const first = page.locator('#rs-backup-first');
    if (await first.count()) await first.uncheck();
    await page.locator('dialog[open] .btn-primary', { hasText: 'Restore' }).click();
    await page.waitForFunction(() => GT.store.course().title === 'Backup Probe');
    const r = await page.evaluate((id) => ({
      n: GT.store.course().students.length,
      t2: GT.store.results().byId[id].items.a_t2.raw,
      last: GT.store.course().history.slice(-1)[0].source,
      canUndo: GT.store.canUndo()
    }), sid);
    assert.equal(r.n, SAMPLE_STUDENTS);
    assert.equal(r.t2, 42.5);
    assert.equal(r.last, 'restore');
    assert.equal(r.canUndo, false, 'restore clears the undo stack');
    await page.locator('#view .gt-grid').waitFor();
  });

  await check('the last-backup indicator turns into a reminder when the last backup is more than 7 days old (R5)', async () => {
    await resetSample();
    await page.evaluate(() => GT.store.setMeta({ lastBackupAt: new Date(Date.now() - 8 * 86400000).toISOString() }));
    await page.locator('#banners', { hasText: 'Your last backup was 8 days ago' }).waitFor();
    assert.match(await page.getAttribute('#backup-chip', 'class'), /btn-backup-stale/);
    assert.match(await page.getAttribute('#backup-chip', 'aria-label'), /^Backup: /);
    await page.evaluate(() => GT.store.setMeta({ lastBackupAt: new Date(Date.now() - 6 * 86400000).toISOString() }));
    await page.waitForFunction(() => !/Your last backup was/.test(document.getElementById('banners').textContent) &&
      !document.getElementById('backup-chip').classList.contains('btn-backup-stale'));
    await page.evaluate(() => GT.store.setMeta({ lastBackupAt: null }));
    await page.locator('#banners', { hasText: 'No backup yet.' }).waitFor();
  });

  await check('data persists in IndexedDB across a reload', async () => {
    await resetSample();
    const sid = (await studentsByName())[1].id;
    await page.evaluate((id) => {
      GT.store.transact('Edit Test 1', (c) => GT.model.setEntry(c.scores, id, 'a_t1', { value: 12.25 }));
      GT.app.navigate('students');
    }, sid);
    await page.evaluate(() => GT.store.flush());
    await page.reload();
    await ready();
    await page.locator('.view-students').waitFor();
    const r = await page.evaluate((id) => ({
      n: GT.store.course().students.length,
      t1: GT.store.results().byId[id].items.a_t1.raw,
      backend: GT.storage.backend(),
      tab: document.querySelector('#tabs [aria-selected="true"]').getAttribute('data-view'),
      logged: GT.store.course().history.some((h) => h.studentId === id && h.newValue === '12.25')
    }), sid);
    assert.equal(r.n, SAMPLE_STUDENTS);
    assert.equal(r.t1, 12.25);
    assert.equal(r.backend, 'indexeddb');
    assert.equal(r.tab, 'students');
    assert.equal(r.logged, true);
  });

  await check('an edit made while a save is running is still saved by flush() (page hidden)', async () => {
    await resetSample();
    await page.evaluate(() => GT.store.flush());
    const r = await page.evaluate(async () => {
      const orig = GT.storage.save;
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      GT.storage.save = (st) => orig(st).then(() => sleep(200)); // a slow disk
      try {
        GT.store.transact('A', (c) => { c.code = 'FLUSH-A'; });
        await sleep(450); // the save of A is running
        GT.store.transact('B', (c) => { c.code = 'FLUSH-B'; });
        await sleep(250); // the save of A has finished; B is waiting for its timer
        const phase = GT.store.saveStatus().phase;
        await GT.store.flush();
        return { phase, after: GT.store.saveStatus().phase };
      } finally {
        GT.storage.save = orig;
      }
    });
    assert.equal(r.phase, 'pending', 'B is not saved yet, so the status must not say saved');
    assert.equal(r.after, 'saved');
    assert.equal(JSON.parse(await idbStored('state')).courses[0].code, 'FLUSH-B');
  });

  await check('a mark made just before a reload is kept (synchronous copy when the page goes away), also mid-save', async () => {
    await resetSample();
    await gotoAttendanceGrid();
    await page.evaluate(() => GT.store.flush());
    const sid = (await studentsByName())[0].id;
    const want = (await markOf(sid, 5)) === 'A' ? 'E' : 'A';
    await attCell(sid, 5).click();
    await page.keyboard.press(want.toLowerCase());
    assert.equal(await markOf(sid, 5), want);
    assert.equal(await page.evaluate(() => GT.store.saveStatus().phase), 'pending', 'the autosave has not run yet');
    await page.reload(); // at once: the IndexedDB save started on pagehide cannot commit in time
    await ready();
    assert.equal(await markOf(sid, 5), want, 'a mark made right before a reload was lost');
    // A save that is still running when the page goes away (it never commits): the change is kept too.
    const want2 = want === 'A' ? 'E' : 'A';
    await page.evaluate(async ([s, m]) => {
      GT.storage.save = () => new Promise(() => {}); // a save that dies with the page
      const ses = GT.store.course().attendance.sessions[5];
      GT.store.transact('Mark', (c) => GT.attendance.setMark(c, s, ses.id, m));
      await new Promise((res) => setTimeout(res, 450));
      if (GT.store.saveStatus().phase !== 'saving') throw new Error('expected a running save');
    }, [sid, want2]);
    await page.reload();
    await ready();
    assert.equal(await markOf(sid, 5), want2, 'a mark saved by a save that never finished was lost');
    // The next IndexedDB save includes the copy and removes it, so it can never win over newer data.
    await page.evaluate(() => GT.store.transact('Edit', (c) => { c.title = c.title + '.'; }));
    await page.evaluate(() => GT.store.flush());
    assert.equal(await page.evaluate(() => localStorage.getItem('grade-tracker:state')), null);
    const stored = JSON.parse(await idbStored('state'));
    const ses5 = stored.courses[0].attendance.sessions[5].id;
    assert.equal(stored.courses[0].attendance.records[sid][ses5], want2);
  });

  await check('keyboard focus stays on the tabs and the status bar across autosave re-renders', async () => {
    await resetSample();
    // Every change autosaves after a short delay, and the 'saved' notification re-renders the shell:
    // wait for that, then for the re-render (the change was made just before, so the phase is 'pending').
    const afterAutosave = async () => {
      await page.waitForFunction(() => GT.store.saveStatus().phase === 'saved');
      await rendered();
    };
    await afterAutosave(); // the reset's own autosave
    const focused = () => page.evaluate(() => {
      const a = document.activeElement;
      return a ? (a.id || a.getAttribute('data-act') || a.tagName) : null;
    });
    await page.focus('#tab-grades');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => GT.store.state.ui.activeView === 'students');
    await afterAutosave(); // navigation autosaves
    assert.equal(await focused(), 'tab-students');
    // The tab after Students (Attendance since stage 3), read from the tab strip.
    const next = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('#tabs .tab')].map((t) => t.getAttribute('data-view'));
      return ids[ids.indexOf('students') + 1];
    });
    assert.equal(next, 'attendance');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((v) => GT.store.state.ui.activeView === v, next);
    await afterAutosave();
    assert.equal(await focused(), 'tab-' + next);
    await page.focus('#statusbar [data-act="shortcuts"]');
    await page.evaluate(() => GT.store.transact('Title', (c) => { c.title = c.title + '.'; }));
    await afterAutosave();
    assert.equal(await focused(), 'shortcuts');
    // The Help button (stage 6) is written once with Shortcuts, so it keeps the focus too.
    await page.focus('#statusbar [data-act="about"]');
    await page.evaluate(() => GT.store.transact('Title', (c) => { c.title = c.title + '.'; }));
    await afterAutosave();
    assert.equal(await focused(), 'about');
    await gotoView('grades');
  });

  await check('dialogs are named by their title; transact() refuses a deleted course id', async () => {
    await resetSample();
    await page.evaluate(() => { GT.ui.dialog.confirm({ title: 'Probe dialog title', message: 'x' }); });
    const name = await page.evaluate(() => {
      const d = document.querySelector('dialog[open]');
      const t = document.getElementById(d.getAttribute('aria-labelledby'));
      return t && d.contains(t) ? t.textContent : null;
    });
    assert.equal(name, 'Probe dialog title');
    await page.keyboard.press('Escape');
    const r = await page.evaluate(() => {
      const before = GT.store.state.courses.map((c) => c.title);
      let error = null;
      try { GT.store.transact('Stale', (c) => { c.title = 'WRONG COURSE'; }, { courseId: 'c_deleted_meanwhile' }); } catch (e) { error = e.message; }
      return { error, same: JSON.stringify(before) === JSON.stringify(GT.store.state.courses.map((c) => c.title)) };
    });
    assert.match(String(r.error), /Course not found/);
    assert.equal(r.same, true);
  });

  await check('a newer localStorage copy (IndexedDB failed last session) wins on load, then is removed', async () => {
    await resetSample();
    await page.evaluate(() => GT.store.flush());
    await page.evaluate(() => {
      const st = JSON.parse(JSON.stringify(GT.store.state));
      st.courses[0].code = 'FROM-LOCALSTORAGE';
      st.meta.lastSavedAt = new Date(Date.now() + 60000).toISOString();
      localStorage.setItem('grade-tracker:state', JSON.stringify(st));
    });
    await page.reload();
    await ready();
    assert.equal(await page.evaluate(() => GT.store.state.courses[0].code), 'FROM-LOCALSTORAGE');
    await page.evaluate(() => GT.store.transact('Edit', (c) => { c.title = c.title + '.'; }));
    await page.evaluate(() => GT.store.flush());
    assert.equal(await page.evaluate(() => localStorage.getItem('grade-tracker:state')), null);
    assert.equal(JSON.parse(await idbStored('state')).courses[0].code, 'FROM-LOCALSTORAGE');
  });

  await check('unreadable saved data shows the banner and is never overwritten (localStorage backend)', async () => {
    const BAD = '{"app":"grade-tracker","courses":[{"code":"TRUNCATED';
    await withLocalStoragePage((bad) => {
      if (!sessionStorage.getItem('gt-seeded')) { sessionStorage.setItem('gt-seeded', '1'); localStorage.setItem('grade-tracker:state', bad); }
    }, BAD, async (p) => {
      assert.equal(await p.evaluate(() => GT.storage.backend()), 'localstorage');
      await p.locator('#banners', { hasText: 'Saved data could not be read' }).waitFor();
      await p.evaluate(() => GT.store.transact('Edit', (c) => { c.title = 'edited'; }));
      await p.evaluate(() => GT.store.flush());
      assert.equal(await p.evaluate(() => localStorage.getItem('grade-tracker:state')), BAD);
      const [download] = await Promise.all([p.waitForEvent('download'), p.click('#banners [data-act="download-raw"]')]);
      const file = path.join(TMP, 'unreadable.json');
      await download.saveAs(file);
      assert.equal(fs.readFileSync(file, 'utf8'), BAD);
    });
  });

  await check('localStorage backend: a state larger than half the quota still saves', async () => {
    await withLocalStoragePage(null, null, async (p) => {
      await p.evaluate(() => GT.store.transact('Load sample data', (c) => GT.sample.loadInto(c), { source: 'sample', historyMode: 'bulk' }));
      await p.evaluate(() => GT.store.flush());
      const r = await p.evaluate(async () => {
        const KEY = 'grade-tracker:state';
        // Simulated quota: room for two copies of the current state, not for the old copy plus a bigger new one.
        const limit = 2 * localStorage.getItem(KEY).length + 100;
        const orig = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          let total = 0;
          for (let i = 0; i < this.length; i++) { const key = this.key(i); if (key !== k) total += (this.getItem(key) || '').length; }
          if (total + String(v).length > limit) throw new DOMException('Simulated quota', 'QuotaExceededError');
          return orig.call(this, k, v);
        };
        try {
          GT.store.transact('Notes', (c) => { c.students[0].notes = 'n'.repeat(2000); });
          await GT.store.flush();
          return { status: GT.store.saveStatus(), notes: JSON.parse(localStorage.getItem(KEY)).courses[0].students[0].notes.length };
        } finally {
          Storage.prototype.setItem = orig;
        }
      });
      assert.equal(r.status.phase, 'saved', 'save failed: ' + r.status.error);
      assert.equal(r.notes, 2000);
    });
  });

  await check('delete all data (typed confirmation) empties storage, also after a reload', async () => {
    await resetSample();
    await page.evaluate(() => GT.store.flush());
    await openMenuItem('#btn-data-menu', 'Delete all data');
    const dlg = page.locator('dialog[open]', { hasText: 'Delete all data?' });
    await dlg.waitFor();
    await dlg.locator('.btn-primary').click(); // refused without the typed word
    assert.match(await dlg.locator('.dlg-error').innerText(), /Type DELETE/);
    await page.fill('#del-confirm', 'DELETE');
    await dlg.locator('.btn-primary').click();
    await page.waitForFunction(() => GT.store.state.courses.every((c) => c.students.length === 0));
    await page.locator('#view .empty-state').waitFor();
    await page.evaluate(() => GT.store.flush());
    await page.reload();
    await ready();
    const r = await page.evaluate(() => GT.store.state.courses.map((c) => c.code + ':' + c.students.length + ':' + c.history.length));
    assert.deepEqual(r, ['SE 4351:0:0', 'SE 6362:0:0']);
  });

  await check('no page errors during the run', async () => {
    assert.deepEqual(pageErrors, []);
  });

  await check('no console errors during the run', async () => {
    assert.deepEqual(consoleErrors, []);
  });

  await check('zero network requests other than file:, data: and blob: across the whole run (ExcelJS for the .xlsx export comes from vendor/)', async () => {
    assert.ok(excelFromVendor, 'the run exported an .xlsx with ExcelJS loaded from vendor/');
    assert.deepEqual(network, []);
  });
}

try {
  await run();
} catch (err) {
  results.push({ name: 'smoke test runner', ok: false, err });
  console.log('FAIL  smoke test runner\n      ' + (err && err.stack ? err.stack : err));
} finally {
  if (browser) await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed (' + results.length + ' checks)');
if (!failed.length) fs.rmSync(TMP, { recursive: true, force: true });
else console.log('Artifacts: ' + TMP);
process.exit(failed.length ? 1 : 0);
