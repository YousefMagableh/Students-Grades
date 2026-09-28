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
