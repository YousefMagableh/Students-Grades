'use strict';
/* Tests for js/store.js (DESIGN.md section 5): transactions, change history, undo/redo, autosave.
 * store.js is a browser classic script; here it runs in Node against the real core modules and an
 * in-memory storage stub. Fake data only. */
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../js/core/util.js');
const model = require('../js/core/model.js');
const calc = require('../js/core/calc.js');
const history = require('../js/core/history.js');

const saved = [];
globalThis.GT = { util, model, calc, history };
globalThis.GT.storage = {
  save: (state) => { saved.push(JSON.parse(JSON.stringify(state))); return Promise.resolve(); },
  backend: () => 'memory'
};
require('../js/store.js');
const store = globalThis.GT.store;

// ---------------------------------------------------------------- helpers

const P1 = 'a_p1', T1 = 'a_t1';

function addTeam(c, name) { const t = model.createTeam(name); c.teams.push(t); return t; }
function addStudent(c, lastName, firstName, extra) {
  const s = model.createStudent(Object.assign({ lastName, firstName, no: c.students.length + 1 }, extra || {}));
  c.students.push(s);
  return s;
}

/** Fresh app state: course A (active) with Team 1 = Alpha, Bravo, Charlie (override 95 on Project I),
 * team score 90, Test 1 Alpha 84; course B (SE 6362) with one student. */
function setup() {
  const state = model.createDefaultState();
  const c = state.courses[0];
  const t1 = addTeam(c, 'Team 1');
  const alpha = addStudent(c, 'Student 01', 'Alpha', { teamId: t1.id });
  const bravo = addStudent(c, 'Student 02', 'Bravo', { teamId: t1.id });
  const charlie = addStudent(c, 'Student 03', 'Charlie', { teamId: t1.id });
  model.setTeamScore(c, t1.id, P1, { value: 90 });
  model.setOverride(c, charlie.id, P1, { value: 95 });
  model.setEntry(c.scores, alpha.id, T1, { value: 84 });
  const other = state.courses[1];
  const zulu = addStudent(other, 'Student 01', 'Zulu');
  model.setEntry(other.scores, zulu.id, T1, { value: 50 });
  store.init(state, 'memory');
  return { state, c, other, t1, alpha, bravo, charlie, zulu };
}

function t1Score(c, s) { const e = model.getEntry(c.scores, s.id, T1); return e ? e.value : null; }
function setT1(s, input) {
  return (co) => model.setEntry(co.scores, s.id, T1, model.entryFromInput(input, model.getEntry(co.scores, s.id, T1)));
}
function dataOf(c) { const x = JSON.parse(JSON.stringify(c)); delete x.history; delete x.updatedAt; return x; }

let events = [];
let unsubscribe = null;
beforeEach(() => {
  events = [];
  unsubscribe = store.subscribe((info) => events.push(info));
});
// Save now, so no autosave timer is left behind and the test process exits promptly.
afterEach(async () => {
  if (unsubscribe) unsubscribe();
  await store.flush();
});

// ================================================================ transact + history

describe('transact logs change history', () => {
  test('a score edit: one score entry, undo step, updatedAt, subscribers notified', () => {
    const { c, alpha } = setup();
    const n = c.history.length;
    const ret = store.transact('Edit Test 1', (co) => { setT1(alpha, '88')(co); return 'done'; });
    assert.equal(ret, 'done');
    assert.equal(t1Score(c, alpha), 88);
    const added = c.history.slice(n);
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, 'score');
    assert.equal(added[0].source, 'edit');
    assert.equal(added[0].studentId, alpha.id);
    assert.equal(added[0].studentName, 'Student 01, Alpha');
    assert.equal(added[0].field, 'Test 1');
    assert.equal(added[0].oldValue, '84');
    assert.equal(added[0].newValue, '88');
    assert.equal(c.updatedAt, added[0].ts);
    assert.equal(store.canUndo(), true);
    assert.equal(store.undoLabel(), 'Edit Test 1');
    assert.equal(store.canRedo(), false);
    const ev = events.filter((e) => e.type === 'transact');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].label, 'Edit Test 1');
    assert.deepEqual(ev[0].entries, added);
  });

  test('a team score edit logs the team score and its propagation to members without override', () => {
    const { c, t1, alpha, bravo } = setup();
    const n = c.history.length;
    store.transact('Edit Project I', (co) => model.setTeamScore(co, t1.id, P1, { value: 92 }), { source: 'paste' });
    const added = c.history.slice(n);
    assert.deepEqual(added.map((e) => [e.kind, e.studentId || e.teamId, e.oldValue, e.newValue, e.source]), [
      ['team-score', t1.id, '90', '92', 'paste'],
      ['propagation', alpha.id, '90', '92', 'paste'],
      ['propagation', bravo.id, '90', '92', 'paste']
    ]);
    assert.equal(added[1].note, 'From Team 1 team score');
  });

  test('an override is logged as kind override', () => {
    const { c, bravo } = setup();
    const n = c.history.length;
    store.transact('Override Project I', (co) => model.setOverride(co, bravo.id, P1, { value: 85 }));
    const added = c.history.slice(n);
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, 'override');
    assert.equal(added[0].oldValue, '90');
    assert.equal(added[0].newValue, '85');
    assert.equal(added[0].note, history.OVERRIDE_NOTE);
  });

  test('opts.note is appended to every entry note', () => {
    const { c, t1 } = setup();
    const n = c.history.length;
    store.transact('Edit Project I', (co) => model.setTeamScore(co, t1.id, P1, { value: 70 }), { note: 'per instructor email' });
    const added = c.history.slice(n);
    assert.equal(added[0].note, 'Team score for 3 members | per instructor email');
    assert.equal(added[1].note, 'From Team 1 team score | per instructor email');
  });

  test('historyMode bulk logs one bulk entry; historyMode none logs nothing but can still be undone', () => {
    const { c, alpha } = setup();
    const n = c.history.length;
    store.transact('Load sample data', (co) => { setT1(alpha, '10')(co); setT1(co.students[1], '20')(co); },
      { source: 'sample', historyMode: 'bulk', note: 'fake data' });
    assert.equal(c.history.length, n + 1);
    const b = c.history[n];
    assert.equal(b.kind, 'bulk');
    assert.equal(b.source, 'sample');
    assert.equal(b.field, 'Load sample data');
    assert.equal(b.note, 'fake data');
    store.transact('Quiet', setT1(alpha, '11'), { historyMode: 'none' });
    assert.equal(c.history.length, n + 1);
    assert.equal(t1Score(c, alpha), 11);
    assert.equal(store.undoLabel(), 'Quiet');
  });

  test('a no-op transact adds no undo step, no entries and no notification', () => {
    const { c, alpha } = setup();
    const n = c.history.length;
    const before = dataOf(c);
    const ret = store.transact('Nothing', (co) => { model.findStudent(co, alpha.id).lastName = 'Student 01'; return 42; });
    assert.equal(ret, 42);
    assert.equal(c.history.length, n);
    assert.equal(store.canUndo(), false);
    assert.deepEqual(dataOf(c), before);
    assert.equal(events.filter((e) => e.type === 'transact').length, 0);
  });

  test('a change without history entries (undoable option off, export preset) behaves as documented', () => {
    const { c } = setup();
    const n = c.history.length;
    store.transact('Save preset', (co) => { co.exportPresets.push({ id: 'xp_1', name: 'Mine', columns: ['no'] }); }, { undoable: false });
    assert.equal(c.exportPresets.length, 1);
    assert.equal(c.history.length, n);
    assert.equal(store.canUndo(), false);
  });

  test('a failing history diff never blocks the change (the store catches it)', () => {
    const { c, alpha } = setup();
    const real = history.diffCourse;
    const realError = console.error;
    history.diffCourse = () => { throw new Error('diff exploded'); };
    console.error = () => {};
    try {
      store.transact('Edit Test 1', setT1(alpha, '77'));
    } finally {
      history.diffCourse = real;
      console.error = realError;
    }
    assert.equal(t1Score(c, alpha), 77);
    assert.equal(store.canUndo(), true);
  });

  test('the mutator throwing restores the course and rethrows; nothing is logged or undoable', () => {
    const { c, alpha } = setup();
    const before = dataOf(c);
    const n = c.history.length;
    assert.throws(() => store.transact('Broken', (co) => {
      setT1(alpha, '1')(co);
      co.students.push(model.createStudent({ lastName: 'Student 99' }));
      co.settings.curve = 5;
      co.extraKey = true;
      throw new Error('nope');
    }), /nope/);
    assert.deepEqual(dataOf(c), before);
    assert.equal('extraKey' in c, false);
    assert.equal(c.history.length, n);
    assert.equal(store.canUndo(), false);
    assert.equal(events.length, 0);
  });

  test('results() reflects a transaction immediately (memo invalidated)', () => {
    const { alpha } = setup();
    const t0 = store.results().byId[alpha.id].total;
    store.transact('Edit Test 1', setT1(alpha, '100'));
    const t1 = store.results().byId[alpha.id].total;
    // Test 1 weighs 25%: (100 - 84) x 0.25 = 4 more points.
    assert.equal(util.fix(t1 - t0), 4);
  });
});

// ================================================================ undo / redo

describe('undo and redo', () => {
  test('undo restores the data and appends undo entries; history never shrinks', () => {
    const { c, alpha } = setup();
    store.transact('Edit Test 1', setT1(alpha, '88'));
    const logged = c.history.slice();
    assert.equal(store.undo(), true);
    assert.equal(t1Score(c, alpha), 84);
    assert.ok(c.history.length > logged.length);
    assert.deepEqual(c.history.slice(0, logged.length), logged, 'older entries are untouched');
    const added = c.history.slice(logged.length);
    assert.equal(added.length, 1);
    assert.equal(added[0].source, 'undo');
    assert.equal(added[0].kind, 'score');
    assert.equal(added[0].oldValue, '88');
    assert.equal(added[0].newValue, '84');
    assert.equal(added[0].note, 'Undo of "Edit Test 1"');
    assert.equal(store.canUndo(), false);
    assert.equal(store.canRedo(), true);
    assert.equal(store.redoLabel(), 'Edit Test 1');
    assert.equal(store.undo(), false, 'nothing left to undo');
  });

  test('undo of a team edit restores team score, overrides and logs the reverse propagation', () => {
    const { c, t1, charlie } = setup();
    const before = dataOf(c);
    store.transact('Paste Project I', (co) => {
      model.setTeamScore(co, t1.id, P1, { value: 60 });
      model.clearOverride(co, charlie.id, P1);
    }, { source: 'paste' });
    const n = c.history.length;
    store.undo();
    assert.deepEqual(dataOf(c), before);
    const added = c.history.slice(n);
    assert.deepEqual(added.map((e) => e.kind), ['team-score', 'override', 'propagation', 'propagation']);
    added.forEach((e) => { assert.equal(e.source, 'undo'); assert.match(e.note, /Undo of "Paste Project I"$/); });
  });

  test('redo re-applies the change and logs redo entries', () => {
    const { c, alpha } = setup();
    store.transact('Edit Test 1', setT1(alpha, '88'));
    store.undo();
    const n = c.history.length;
    assert.equal(store.redo(), true);
    assert.equal(t1Score(c, alpha), 88);
    const added = c.history.slice(n);
    assert.equal(added.length, 1);
    assert.equal(added[0].source, 'redo');
    assert.equal(added[0].newValue, '88');
    assert.equal(added[0].note, 'Redo of "Edit Test 1"');
    assert.equal(store.canRedo(), false);
    assert.equal(store.canUndo(), true);
    assert.equal(store.redo(), false);
    // Undo again after redo.
    store.undo();
    assert.equal(t1Score(c, alpha), 84);
  });

  test('undo and redo of a bulk step log one bulk entry each (not an itemized diff)', () => {
    const { c, alpha, bravo } = setup();
    store.transact('Load sample data', (co) => { setT1(alpha, '10')(co); setT1(bravo, '20')(co); },
      { source: 'sample', historyMode: 'bulk' });
    let n = c.history.length;
    assert.equal(store.undo(), true);
    assert.equal(t1Score(c, alpha), 84);
    assert.equal(t1Score(c, bravo), null);
    let added = c.history.slice(n);
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, 'bulk');
    assert.equal(added[0].source, 'undo');
    assert.equal(added[0].field, 'Load sample data');
    assert.equal(added[0].note, 'Undo of "Load sample data"');
    n = c.history.length;
    assert.equal(store.redo(), true);
    assert.equal(t1Score(c, bravo), 20);
    added = c.history.slice(n);
    assert.equal(added.length, 1);
    assert.equal(added[0].kind, 'bulk');
    assert.equal(added[0].source, 'redo');
    assert.equal(added[0].note, 'Redo of "Load sample data"');
    // The mode survives the round trip: a second undo is still one bulk entry.
    n = c.history.length;
    store.undo();
    assert.equal(c.history.length, n + 1);
    assert.equal(c.history[n].kind, 'bulk');
  });

  test('undo still logs when the course history array is missing', () => {
    const { c, alpha } = setup();
    store.transact('Edit Test 1', setT1(alpha, '88'));
    delete c.history;
    assert.equal(store.undo(), true);
    assert.equal(t1Score(c, alpha), 84);
    assert.ok(Array.isArray(c.history));
    assert.equal(c.history.length, 1);
    assert.equal(c.history[0].source, 'undo');
  });

  test('several steps undo in reverse order', () => {
    const { c, alpha } = setup();
    store.transact('A', setT1(alpha, '1'));
    store.transact('B', setT1(alpha, '2'));
    store.transact('C', setT1(alpha, '3'));
    assert.equal(store.undoLabel(), 'C');
    store.undo();
    assert.equal(t1Score(c, alpha), 2);
    store.undo();
    assert.equal(t1Score(c, alpha), 1);
    assert.equal(store.redoLabel(), 'B');
    store.redo();
    assert.equal(t1Score(c, alpha), 2);
  });

  test('a new transaction clears the redo stack', () => {
    const { c, alpha, bravo } = setup();
    store.transact('Edit Test 1', setT1(alpha, '88'));
    store.undo();
    assert.equal(store.canRedo(), true);
    store.transact('Edit Test 1 (Bravo)', setT1(bravo, '70'));
    assert.equal(store.canRedo(), false);
    assert.equal(store.redo(), false);
    assert.equal(t1Score(c, alpha), 84);
    assert.equal(t1Score(c, bravo), 70);
  });

  test('the undo stack is capped at 200 steps', () => {
    const { c, alpha } = setup();
    for (let i = 1; i <= 205; i++) store.transact('Step ' + i, setT1(alpha, String(i)));
    let undone = 0;
    while (store.undo()) undone++;
    assert.equal(undone, 200);
    // The 5 oldest steps fell off: the value after step 5 remains.
    assert.equal(t1Score(c, alpha), 5);
    assert.equal(store.canUndo(), false);
  });

  test('each course has its own undo and redo stacks', () => {
    const { state, c, other, alpha, zulu } = setup();
    store.transact('Edit A', setT1(alpha, '88'));
    store.setActiveCourse(other.id);
    assert.equal(store.course().id, other.id);
    assert.equal(store.canUndo(), false, 'course B has nothing to undo');
    store.transact('Edit B', setT1(zulu, '55'));
    assert.equal(store.undoLabel(), 'Edit B');
    store.undo();
    assert.equal(t1Score(other, zulu), 50);
    assert.equal(t1Score(c, alpha), 88, 'course A untouched by undo in course B');
    assert.equal(store.canRedo(), true);
    store.setActiveCourse(c.id);
    assert.equal(store.undoLabel(), 'Edit A');
    assert.equal(store.canRedo(), false);
    store.undo();
    assert.equal(t1Score(c, alpha), 84);
    assert.equal(t1Score(other, zulu), 50);
    // A transaction on a course that is not active goes to that course's stack.
    store.transact('Edit B again', setT1(zulu, '66'), { courseId: other.id });
    assert.equal(t1Score(other, zulu), 66);
    assert.equal(store.canUndo(), false, 'active course A has no undo step');
    store.setActiveCourse(other.id);
    assert.equal(store.undoLabel(), 'Edit B again');
    assert.equal(state.activeCourseId, other.id);
  });
});

// ================================================================ annotateHistory, autosave

describe('annotateHistory and autosave', () => {
  test('annotateHistory sets userNote and userNoteAt on the entry; unknown ids are ignored', () => {
    const { c, alpha } = setup();
    store.transact('Edit Test 1', setT1(alpha, '88'));
    const entry = c.history[c.history.length - 1];
    const n = c.history.length;
    store.annotateHistory(entry.id, 'Changed per instructor email, Oct 12');
    assert.equal(entry.userNote, 'Changed per instructor email, Oct 12');
    assert.ok(!isNaN(Date.parse(entry.userNoteAt)));
    assert.equal(c.history.length, n, 'annotating adds no entry');
    assert.ok(events.some((e) => e.type === 'annotate'));
    store.annotateHistory('h_missing', 'x');
    assert.equal(c.history.length, n);
    // The note survives a later undo (history is never rolled back).
    store.undo();
    assert.equal(c.history.find((e) => e.id === entry.id).userNote, 'Changed per instructor email, Oct 12');
    // And shows in the CSV rows.
    const rows = history.toRows([entry]);
    assert.equal(rows[1][9], 'Changed per instructor email, Oct 12');
  });

  test('changes are autosaved through GT.storage (flush saves now)', async () => {
    const { c, alpha } = setup();
    saved.length = 0;
    store.transact('Edit Test 1', setT1(alpha, '99'));
    assert.equal(store.saveStatus().phase, 'pending');
    await store.flush();
    assert.equal(saved.length, 1);
    const sc = saved[0].courses.find((x) => x.id === c.id);
    assert.equal(model.getEntry(sc.scores, alpha.id, T1).value, 99);
    assert.equal(sc.history[sc.history.length - 1].newValue, '99');
    assert.equal(store.saveStatus().phase, 'saved');
    assert.equal(store.saveStatus().backend, 'memory');
  });
});

// ================================================================ two tabs: conflict (read-only) mode

/** Swaps GT.storage functions for one test (restored by the returned function). */
function stubStorage(patch) {
  const prev = {};
  Object.keys(patch).forEach((k) => { prev[k] = globalThis.GT.storage[k]; globalThis.GT.storage[k] = patch[k]; });
  return () => Object.keys(prev).forEach((k) => {
    if (prev[k] === undefined) delete globalThis.GT.storage[k]; else globalThis.GT.storage[k] = prev[k];
  });
}
function conflictErr() { const e = new Error('changed in another tab'); e.conflict = true; return e; }

describe('a save that finds newer data from another tab (compare-and-swap conflict)', () => {
  test('the store goes read-only: phase conflict, autosave stops, transact throws and changes nothing', async () => {
    const { c, alpha } = setup();
    let calls = 0;
    const restore = stubStorage({ save: () => { calls++; return Promise.reject(conflictErr()); } });
    try {
      store.transact('Edit Test 1', setT1(alpha, '88'));
      await store.flush();
      assert.equal(calls, 1);
      assert.equal(store.saveStatus().phase, 'conflict');
      assert.equal(store.readOnly(), true);
      assert.ok(events.some((e) => e.type === 'conflict'));
      assert.ok(events.some((e) => e.type === 'saved' && e.ok === false));
      // Every data change is refused before anything changes.
      const before = dataOf(c);
      const n = c.history.length;
      assert.throws(() => store.transact('Edit again', setT1(alpha, '1')), (e) => e.conflict === true && /another tab/.test(e.message));
      assert.deepEqual(dataOf(c), before);
      assert.equal(c.history.length, n);
      assert.throws(() => store.addCourse(model.createCourse('custom', { code: 'X' })), (e) => e.conflict === true);
      assert.throws(() => store.deleteCourse(c.id), (e) => e.conflict === true);
      assert.throws(() => store.moveCourse(c.id, 1), (e) => e.conflict === true);
      assert.throws(() => store.replaceState(model.createDefaultState(), 'restore'), (e) => e.conflict === true);
      assert.equal(store.canUndo(), false);
      assert.equal(store.undo(), false, 'undo changes nothing while read-only');
      assert.equal(t1Score(c, alpha), 88);
      assert.equal(store.annotateHistory(c.history[c.history.length - 1].id, 'note'), false);
      // UI-only settings change on screen but are never saved (no save is even attempted).
      store.setUi({ theme: 'dark' });
      store.setActiveCourse(store.state.courses[1].id);
      assert.equal(store.state.ui.theme, 'dark');
      await store.flush();
      await new Promise((r) => setTimeout(r, 450));
      assert.equal(calls, 1, 'no save after the conflict');
      assert.equal(store.saveStatus().phase, 'conflict');
      assert.equal(store.flushOnLeave(), false);
      // The edit made before the conflict was never stored: leaving would lose it.
      assert.equal(store.hasUnsavedData(), true);
    } finally {
      restore();
    }
    // A new boot (reload) starts writable again.
    setup();
    assert.equal(store.readOnly(), false);
    assert.equal(store.saveStatus().phase, 'idle');
  });

  test('a UI-only click in a stale tab fails into the conflict too (it never writes the old data back)', async () => {
    setup();
    const written = [];
    const restore = stubStorage({ save: (st) => { written.push(st); return Promise.reject(conflictErr()); } });
    try {
      store.setUi({ privacy: true });
      await store.flush();
      assert.equal(written.length, 1, 'the click is saved through the same compare-and-swap');
      assert.equal(store.saveStatus().phase, 'conflict');
      assert.equal(store.hasUnsavedData(), false, 'only a UI setting was not saved: nothing to warn about');
    } finally {
      restore();
    }
  });

  test('checkConflict: a stale tab (another tab said it saved) goes read-only without saving; an up-to-date one does not', async () => {
    setup();
    let stale = false;
    let saves = 0;
    const restore = stubStorage({ isStale: () => Promise.resolve(stale), save: () => { saves++; return Promise.resolve(); } });
    try {
      assert.equal(await store.checkConflict(), false);
      assert.equal(store.readOnly(), false);
      stale = true;
      assert.equal(await store.checkConflict(), true);
      assert.equal(store.readOnly(), true);
      assert.equal(store.saveStatus().phase, 'conflict');
      assert.equal(saves, 0);
    } finally {
      restore();
    }
  });

  test('another failure is an error, not a conflict: the store stays writable and retries on flush', async () => {
    const { alpha } = setup();
    let fail = true;
    const realError = console.error;
    console.error = () => {};
    const restore = stubStorage({ save: () => (fail ? Promise.reject(new Error('QuotaExceededError')) : Promise.resolve()) });
    try {
      store.transact('Edit Test 1', setT1(alpha, '70'));
      await store.flush();
      assert.equal(store.saveStatus().phase, 'error');
      assert.equal(store.readOnly(), false);
      assert.equal(store.hasUnsavedData(), true, 'a failed save warns before the page closes');
      fail = false;
      await store.flush();
      assert.equal(store.saveStatus().phase, 'saved');
      assert.equal(store.hasUnsavedData(), false);
    } finally {
      restore();
      console.error = realError;
    }
  });

  test('a paused save (err.paused, unreadable saved data) is an error that is not logged as a failure', async () => {
    const { alpha } = setup();
    const logged = [];
    const realError = console.error;
    console.error = (...a) => logged.push(a);
    const restore = stubStorage({ save: () => { const e = new Error('Saving is paused'); e.paused = true; return Promise.reject(e); } });
    try {
      store.transact('Edit Test 1', setT1(alpha, '71'));
      await store.flush();
      assert.equal(store.saveStatus().phase, 'error');
      assert.match(store.saveStatus().error, /paused/);
      assert.equal(logged.length, 0);
      assert.equal(store.hasUnsavedData(), true);
    } finally {
      restore();
      console.error = realError;
    }
    await store.flush();
  });

  test('clearAll deletes through storage.clear first, then replaces the state; it is refused while read-only', async () => {
    const { alpha } = setup();
    const order = [];
    const restore = stubStorage({ clear: () => { order.push('clear'); return Promise.resolve(); } });
    try {
      store.transact('Edit Test 1', setT1(alpha, '72')); // a pending autosave is cancelled, not written after the clear
      const fresh = model.createDefaultState();
      saved.length = 0;
      await store.clearAll(fresh, 'delete-all');
      order.push('replaced');
      assert.deepEqual(order, ['clear', 'replaced']);
      assert.equal(store.state, fresh);
      assert.ok(events.some((e) => e.type === 'replace' && e.source === 'delete-all'));
      await store.flush();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].courses[0].students.length, 0, 'only the fresh state was saved after the clear');
    } finally {
      restore();
    }
    setup();
    const restore2 = stubStorage({ save: () => Promise.reject(conflictErr()) });
    try {
      store.setUi({ theme: 'light' });
      await store.flush();
      assert.throws(() => store.clearAll(model.createDefaultState()), (e) => e.conflict === true);
    } finally {
      restore2();
    }
  });
});

describe('leaving the page (flushOnLeave) and unsaved data', () => {
  test('IndexedDB: an emergency copy keeps the change; UI-only changes are not unsaved data', async () => {
    const { alpha } = setup();
    let copies = 0;
    let saves = 0;
    const restore = stubStorage({
      saveSync: () => { copies++; return true; },
      backend: () => 'indexeddb',
      save: () => { saves++; return new Promise(() => {}); } // dies with the page
    });
    try {
      store.setUi({ privacy: true });
      assert.equal(store.hasUnsavedData(), false, 'a UI setting is not course data');
      store.transact('Edit Test 1', setT1(alpha, '73'));
      assert.equal(store.hasUnsavedData(), true);
      assert.equal(store.flushOnLeave(), true);
      assert.equal(copies, 1);
      assert.equal(saves, 1, 'the normal save starts too');
      assert.equal(store.hasUnsavedData(), false, 'the emergency copy keeps it');
      assert.equal(store.flushOnLeave(), false, 'nothing new: no second copy');
      assert.equal(copies, 1);
    } finally {
      restore();
    }
    setup(); // the never-ending save above is abandoned with the "page"
  });

  test('IndexedDB without room for the emergency copy: the change is still unsaved (the page warns)', () => {
    const { alpha } = setup();
    const restore = stubStorage({ saveSync: () => false, backend: () => 'indexeddb', save: () => new Promise(() => {}) });
    try {
      store.transact('Edit Test 1', setT1(alpha, '74'));
      assert.equal(store.flushOnLeave(), false);
      assert.equal(store.hasUnsavedData(), true);
    } finally {
      restore();
    }
    setup();
  });

  test('localStorage: saveSync is a complete save, so nothing is pending afterwards', async () => {
    const { alpha } = setup();
    let saves = 0;
    const restore = stubStorage({ saveSync: () => true, backend: () => 'localstorage', save: () => { saves++; return Promise.resolve(); } });
    try {
      store.transact('Edit Test 1', setT1(alpha, '75'));
      assert.equal(store.flushOnLeave(), true);
      assert.equal(store.saveStatus().phase, 'saved');
      assert.equal(store.hasUnsavedData(), false);
      await store.flush();
      assert.equal(saves, 0, 'not saved twice');
      assert.ok(events.some((e) => e.type === 'saved' && e.ok === true));
    } finally {
      restore();
    }
  });

  test('a conflict found by saveSync makes the store read-only', () => {
    const { alpha } = setup();
    const restore = stubStorage({ saveSync: () => { throw conflictErr(); }, backend: () => 'localstorage' });
    try {
      store.transact('Edit Test 1', setT1(alpha, '76'));
      assert.equal(store.flushOnLeave(), false);
      assert.equal(store.saveStatus().phase, 'conflict');
    } finally {
      restore();
    }
    setup();
  });
});

// ================================================================ undo step ids, merged roll-call entries

describe('undoStepId', () => {
  test('every pushed step gets a new id, even with the same label', () => {
    const { alpha } = setup();
    assert.equal(store.undoStepId(), null);
    store.transact('Same', setT1(alpha, '1'));
    const a = store.undoStepId();
    store.transact('Same', setT1(alpha, '2'));
    const b = store.undoStepId();
    assert.ok(a && b && a !== b);
    store.undo();
    assert.equal(store.undoStepId(), a);
    store.redo();
    assert.notEqual(store.undoStepId(), b, 'a redone step is a new step');
  });
});

describe('transact mergeKey (roll call: one history entry per roll call)', () => {
  function addSession(c) {
    const ses = { id: 'ses_1', date: '2026-10-06', label: 'Tue Oct 6' };
    c.attendance.sessions.push(ses);
    return ses;
  }
  function mark(sid, m) {
    return (co) => { co.attendance.records[sid] = co.attendance.records[sid] || {}; co.attendance.records[sid].ses_1 = m; };
  }
  const KEY = 'rollcall:ses_1:1000';

  test('the first mark is a normal entry with the key; the next ones fold into ONE summary entry with every change', () => {
    const { c, alpha, bravo, charlie } = setup();
    addSession(c);
    const n = c.history.length;
    store.transact('Roll call Tue Oct 6', mark(alpha.id, 'P'), { mergeKey: KEY });
    assert.equal(c.history.length, n + 1);
    const first = c.history[n];
    assert.equal(first.kind, 'attendance');
    assert.equal(first.studentId, alpha.id);
    assert.equal(first.mergeKey, KEY);
    store.transact('Roll call Tue Oct 6', mark(bravo.id, 'A'), { mergeKey: KEY });
    assert.equal(c.history.length, n + 1, 'merged, not appended');
    let e = c.history[n];
    assert.notEqual(e.id, first.id);
    assert.equal(e.kind, 'attendance');
    assert.equal(e.field, 'Roll call Tue Oct 6');
    assert.equal(e.fieldKey, 'attendance');
    assert.equal(e.newValue, '2 marks');
    assert.equal(e.studentId, null);
    assert.equal(e.mergeKey, KEY);
    assert.equal(e.source, 'edit');
    // Each change as the per-mark entry described it (the mark labels come from GT.history).
    assert.deepEqual(e.details.map((d) => [d.studentId, d.studentName, d.no, d.field, d.oldValue]), [
      [alpha.id, 'Student 01, Alpha', 1, 'Attendance 2026-10-06', first.oldValue],
      [bravo.id, 'Student 02, Bravo', 2, 'Attendance 2026-10-06', first.oldValue]
    ]);
    assert.equal(e.details[0].newValue, first.newValue);
    assert.notEqual(e.details[1].newValue, first.newValue, 'Absent, not Present');
    store.transact('Roll call Tue Oct 6', mark(charlie.id, 'E'), { mergeKey: KEY });
    store.transact('Roll call Tue Oct 6', mark(alpha.id, 'A'), { mergeKey: KEY }); // marked again: listed again
    assert.equal(c.history.length, n + 1);
    e = c.history[n];
    assert.equal(e.newValue, '4 marks');
    assert.equal(e.note, '3 students');
    assert.deepEqual(e.details.map((d) => d.studentId), [alpha.id, bravo.id, charlie.id, alpha.id]);
    // The History helpers read the details: the student filter, one student's own change, the CSV rows.
    assert.equal(history.involvesStudent(e, charlie.id), true);
    const own = history.detailFor(e, alpha.id);
    assert.equal(own.oldValue, '');
    assert.equal(own.newValue, e.details[3].newValue, 'first old value, last new value');
    const rows = history.toRows([e]);
    assert.equal(rows.length, 1 + 1 + 4);
    assert.equal(rows[2][5], 'Attendance 2026-10-06');
    assert.equal(rows[2][8], 'Part of "Roll call Tue Oct 6: 4 marks"');
  });

  test('undo and redo stay per mark; after an undo the next mark starts a new entry', () => {
    const { c, alpha, bravo, charlie } = setup();
    addSession(c);
    store.transact('Roll call', mark(alpha.id, 'P'), { mergeKey: KEY });
    store.transact('Roll call', mark(bravo.id, 'P'), { mergeKey: KEY });
    const n = c.history.length;
    assert.equal(store.undo(), true);
    assert.equal((c.attendance.records[bravo.id] || {}).ses_1, undefined, 'only the last mark is undone');
    assert.equal(c.attendance.records[alpha.id].ses_1, 'P');
    assert.equal(c.history.length, n + 1);
    assert.equal(c.history[n].source, 'undo');
    assert.equal(store.redo(), true);
    assert.equal(c.attendance.records[bravo.id].ses_1, 'P');
    const m = c.history.length;
    store.transact('Roll call', mark(charlie.id, 'P'), { mergeKey: KEY });
    assert.equal(c.history.length, m + 1, 'the last entry is the redo: appended, not merged into it');
    assert.equal(c.history[m].studentId, charlie.id);
  });

  test('no merge for another key, an entry older than 30 minutes, or an entry the TA annotated', () => {
    const { c, alpha, bravo, charlie, zulu } = setup();
    addSession(c);
    store.transact('Roll call', mark(alpha.id, 'P'), { mergeKey: KEY });
    let n = c.history.length;
    store.transact('Roll call', mark(bravo.id, 'P'), { mergeKey: 'rollcall:ses_1:2000' });
    assert.equal(c.history.length, n + 1, 'another roll call');
    c.history[c.history.length - 1].ts = new Date(Date.now() - 31 * 60000).toISOString();
    n = c.history.length;
    store.transact('Roll call', mark(charlie.id, 'P'), { mergeKey: 'rollcall:ses_1:2000' });
    assert.equal(c.history.length, n + 1, 'too old');
    store.annotateHistory(c.history[c.history.length - 1].id, 'came late');
    n = c.history.length;
    store.transact('Roll call', mark(charlie.id, 'A'), { mergeKey: 'rollcall:ses_1:2000' });
    assert.equal(c.history.length, n + 1, 'an annotated entry is kept as it is');
    // A transaction without the key never merges.
    n = c.history.length;
    store.transact('Mark', mark(alpha.id, 'E'));
    assert.equal(c.history.length, n + 1);
    assert.equal(c.history[n].mergeKey, undefined);
    assert.ok(zulu);
  });

  test('a merge changes the undo mark (history length stays, the last entry id changes)', () => {
    const { c, alpha, bravo } = setup();
    addSession(c);
    store.transact('Roll call', mark(alpha.id, 'P'), { mergeKey: KEY });
    const id1 = c.history[c.history.length - 1].id;
    const len = c.history.length;
    const step1 = store.undoStepId();
    store.transact('Roll call', mark(bravo.id, 'P'), { mergeKey: KEY });
    assert.equal(c.history.length, len);
    assert.notEqual(c.history[c.history.length - 1].id, id1);
    assert.notEqual(store.undoStepId(), step1);
  });
});
