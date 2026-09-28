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
 * Grades tab (light theme, privacy off). Every check that needs data starts here. */
async function resetSample() {
  await page.evaluate(() => {
    document.querySelectorAll('dialog').forEach((d) => { try { d.close(); } catch (e) { /* closed */ } d.remove(); });
    if (GT.ui.closeMenu) GT.ui.closeMenu();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const st = GT.model.createDefaultState();
    st.ui.theme = 'light';
    st.meta.lastBackupAt = new Date().toISOString(); // keep the backup reminder banner out of the way
    GT.store.replaceState(st, 'test');
    GT.store.transact('Load sample data', (c) => GT.sample.loadInto(c), { source: 'sample', historyMode: 'bulk' });
    GT.app.navigate('grades');
  });
  await page.waitForFunction((n) => document.querySelectorAll('.gt-grid tbody tr.gr').length === n, SAMPLE_STUDENTS);
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
    // One student checked by hand: 10% + 20% + 25% + 40% + 5% of the raw scores.
    const one = await page.evaluate(() => {
      const c = GT.store.course(), s = GT.calc.sortStudents(c, GT.store.results(), 'name', 'asc')[0];
      const it = GT.store.results().byId[s.id].items;
      const manual = it.a_p1.raw * 0.10 + it.a_p2.raw * 0.20 + it.a_t1.raw * 0.25 + it.a_t2.raw * 0.40 + it.a_part.raw * 0.05;
      return { manual, total: GT.store.results().byId[s.id].total };
    });
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

  await check('privacy mode blurs every student name (.pii) in the grid and Students views', async () => {
    await resetSample();
    await page.click('#btn-privacy');
    await page.waitForFunction(() => document.body.classList.contains('privacy-on'));
    for (const view of ['grades', 'students']) {
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
    const filter = await page.locator('.view-students .pii').first().evaluate((e) => getComputedStyle(e).filter);
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

  await check('zero network requests other than file:, data: and blob:', async () => {
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
