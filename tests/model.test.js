'use strict';
/* Spec-derived tests for js/core/model.js (DESIGN.md section 2; REQUIREMENTS C1-C4, A1-A5, K5, K6, T1, T2, R4).
 * Expected values are worked out by hand from REQUEST.md / REQUIREMENTS.md / DESIGN.md.
 * Fake data only. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../js/core/util.js');
const model = require('../js/core/model.js');
const calc = require('../js/core/calc.js');

// ---------------------------------------------------------------- helpers

const UG_SCALE = [
  { letter: 'A+', min: 97 }, { letter: 'A', min: 93 }, { letter: 'A-', min: 90 },
  { letter: 'B+', min: 87 }, { letter: 'B', min: 83 }, { letter: 'B-', min: 80 },
  { letter: 'C+', min: 77 }, { letter: 'C', min: 73 }, { letter: 'C-', min: 70 },
  { letter: 'D+', min: 67 }, { letter: 'D', min: 63 }, { letter: 'D-', min: 60 },
  { letter: 'F', min: 0 }
];
const GRAD_SCALE = [
  { letter: 'A', min: 93 }, { letter: 'A-', min: 90 }, { letter: 'B+', min: 87 },
  { letter: 'B', min: 83 }, { letter: 'B-', min: 80 }, { letter: 'C+', min: 77 },
  { letter: 'C', min: 70 }, { letter: 'F', min: 0 }
];

// Tuesdays and Thursdays from 2026-09-03 to 2026-12-08, minus 2026-11-24 and 2026-11-26 (counted by hand).
const FALL_2026_SESSIONS = [
  '2026-09-03', '2026-09-08', '2026-09-10', '2026-09-15', '2026-09-17', '2026-09-22', '2026-09-24', '2026-09-29',
  '2026-10-01', '2026-10-06', '2026-10-08', '2026-10-13', '2026-10-15', '2026-10-20', '2026-10-22', '2026-10-27', '2026-10-29',
  '2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12', '2026-11-17', '2026-11-19',
  '2026-12-01', '2026-12-03', '2026-12-08'
];

const BASE_KEYS = ['letterScale', 'rounding', 'curve', 'lateWork', 'maxScores', 'projectSplit', 'unexcusedThreshold', 'passingLetter'];

function course(template) { return model.createCourse(template || 'SE4351'); }
function addTeam(c, name) { const t = model.createTeam(name); c.teams.push(t); return t; }
function addStudent(c, lastName, firstName, extra) {
  const s = model.createStudent(Object.assign({ lastName, firstName, no: c.students.length + 1 }, extra || {}));
  c.students.push(s);
  return s;
}
function setScore(c, s, aid, value, extra) { model.setEntry(c.scores, s.id, aid, Object.assign({ value }, extra || {})); }
function setTeamScore(c, t, aid, value, extra) { model.setEntry(c.teamScores, t.id, aid, Object.assign({ value }, extra || {})); }
function visible(c, s, aid) {
  const d = calc.scoreDetail(c, s, model.findAssessment(c, aid));
  return { state: d.state, raw: d.raw, text: d.text };
}
function visibleAll(c, aid) {
  const out = {};
  c.students.forEach((s) => { out[s.id] = visible(c, s, aid); });
  return out;
}
function sorted(arr) { return arr.slice().sort(); }
function byName(c, aid) { return model.findAssessment(c, aid); }
function roundTrip(x) { return JSON.parse(JSON.stringify(x)); }

// ---------------------------------------------------------------- default state and templates

describe('default state (C1, C2, C4)', () => {
  test('has SE 4351 and SE 6362, no students, SE 4351 active', () => {
    const st = model.createDefaultState();
    assert.equal(st.app, 'grade-tracker');
    assert.equal(st.schemaVersion, 1);
    assert.equal(st.courses.length, 2);
    const [a, b] = st.courses;
    assert.equal(a.code, 'SE 4351');
    assert.equal(a.title, 'Requirements Engineering');
    assert.equal(a.level, 'undergraduate');
    assert.equal(a.template, 'SE4351');
    assert.equal(b.code, 'SE 6362');
    assert.equal(b.title, 'Software Architectural Design');
    assert.equal(b.level, 'graduate');
    assert.equal(b.template, 'SE6362');
    assert.deepEqual(a.students, []);
    assert.deepEqual(b.students, []);
    assert.deepEqual(a.teams, []);
    assert.deepEqual(b.teams, []);
    assert.equal(st.activeCourseId, a.id);
    assert.notEqual(a.id, b.id);
    assert.equal(st.meta.lastBackupAt, null);
  });

  test('courses are independent objects (no shared sub-objects)', () => {
    const st = model.createDefaultState();
    const [a, b] = st.courses;
    assert.notEqual(a.settings, b.settings);
    assert.notEqual(a.settings.letterScale, b.settings.letterScale);
    assert.notEqual(a.attendance.sessions, b.attendance.sessions);
    a.settings.curve = 5;
    assert.equal(b.settings.curve, 0);
  });
});

describe('assessment defaults (A1, A2, A4)', () => {
  const FIVE = [
    { id: 'a_p1', name: 'Project I', maxScore: 100, weight: 10, teamGraded: true },
    { id: 'a_p2', name: 'Project II', maxScore: 100, weight: 20, teamGraded: true },
    { id: 'a_t1', name: 'Test 1', maxScore: 100, weight: 25, teamGraded: false },
    { id: 'a_t2', name: 'Test 2', maxScore: 100, weight: 40, teamGraded: false },
    { id: 'a_part', name: 'Class/Project Participation', maxScore: 100, weight: 5, teamGraded: false }
  ];
  const pick = (a) => ({ id: a.id, name: a.name, maxScore: a.maxScore, weight: a.weight, teamGraded: a.teamGraded });

  test('SE 4351 has exactly the five defaults, weights summing to 100', () => {
    const c = course('SE4351');
    assert.deepEqual(c.assessments.map(pick), FIVE);
    assert.equal(c.assessments.reduce((s, a) => s + a.weight, 0), 100);
    assert.ok(!c.assessments.some((a) => a.name === 'Term Paper'));
  });

  test('SE 6362 has the five defaults plus Term Paper with weight 0', () => {
    const c = course('SE6362');
    assert.deepEqual(c.assessments.slice(0, 5).map(pick), FIVE);
    assert.equal(c.assessments.length, 6);
    const paper = c.assessments[5];
    assert.equal(paper.id, 'a_paper');
    assert.equal(paper.name, 'Term Paper');
    assert.equal(paper.weight, 0);
    assert.equal(paper.maxScore, 100);
    assert.equal(paper.teamGraded, false);
    assert.equal(paper.category, 'paper');
    assert.equal(c.assessments.reduce((s, a) => s + a.weight, 0), 100);
  });

  test('createAssessment defaults: max 100, weight 0, not team-graded, new id', () => {
    const a = model.createAssessment({ name: 'Questionnaire' });
    assert.equal(a.name, 'Questionnaire');
    assert.equal(a.maxScore, 100);
    assert.equal(a.weight, 0);
    assert.equal(a.teamGraded, false);
    assert.ok(typeof a.id === 'string' && a.id.startsWith('a_'));
  });
});

describe('settings defaults (K3, K4, K6)', () => {
  test('SE 4351: undergraduate letter scale, no rounding, no curve, 10 points per week, pass at D-', () => {
    const s = course('SE4351').settings;
    assert.deepEqual(s.letterScale, UG_SCALE);
    assert.equal(s.rounding, 'none');
    assert.equal(s.curve, 0);
    assert.equal(s.latePointsPerWeek, 10);
    assert.equal(s.decimals, 2);
    assert.equal(s.passingLetter, 'D-');
  });

  test('SE 6362: graduate letter scale (no A+, no C-, no D letters), pass at C', () => {
    const s = course('SE6362').settings;
    assert.deepEqual(s.letterScale, GRAD_SCALE);
    const letters = s.letterScale.map((x) => x.letter);
    ['A+', 'C-', 'D+', 'D', 'D-'].forEach((l) => assert.ok(!letters.includes(l), `graduate scale must not contain ${l}`));
    assert.equal(s.rounding, 'none');
    assert.equal(s.curve, 0);
    assert.equal(s.latePointsPerWeek, 10);
    assert.equal(s.passingLetter, 'C');
  });
});

describe('attendance defaults (T1, T2, T4, T5)', () => {
  test('SE 4351 is per-session with exactly 26 Tue/Thu sessions from 2026-09-03 to 2026-12-08', () => {
    const att = course('SE4351').attendance;
    assert.equal(att.mode, 'per-session');
    const dates = att.sessions.map((s) => s.date);
    assert.equal(dates.length, 26);
    assert.equal(dates[0], '2026-09-03');
    assert.equal(dates[dates.length - 1], '2026-12-08');
    assert.deepEqual(dates, FALL_2026_SESSIONS);
  });

  test('SE 4351 sessions skip 2026-11-24 and 2026-11-26 and fall only on Tuesdays and Thursdays', () => {
    const att = course('SE4351').attendance;
    const dates = att.sessions.map((s) => s.date);
    assert.ok(!dates.includes('2026-11-24'));
    assert.ok(!dates.includes('2026-11-26'));
    dates.forEach((d) => assert.ok([2, 4].includes(util.weekday(d)), `${d} is not a Tuesday or Thursday`));
  });

  test('sessions are ascending with unique ids', () => {
    const att = course('SE4351').attendance;
    const dates = att.sessions.map((s) => s.date);
    assert.deepEqual(dates, dates.slice().sort());
    const ids = att.sessions.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('SE 6362 attendance is off by default, with the session list prefilled', () => {
    const att = course('SE6362').attendance;
    assert.equal(att.mode, 'off');
    assert.deepEqual(att.sessions.map((s) => s.date), FALL_2026_SESSIONS);
  });

  test('attendance settings defaults: threshold 3, excused counts toward streak, streaks 3 and 4, no records', () => {
    const att = course('SE4351').attendance;
    assert.equal(att.unexcusedThreshold, 3);
    assert.equal(att.excusedCountsTowardStreak, true);
    assert.equal(att.dropStreak, 3);
    assert.equal(att.failStreak, 4);
    assert.deepEqual(att.records, {});
  });

  test('custom course: attendance off with no sessions', () => {
    const c = course('custom');
    assert.equal(c.code, 'New Course');
    assert.equal(c.attendance.mode, 'off');
    assert.deepEqual(c.attendance.sessions, []);
  });
});

describe('placeholders ("needs confirmation")', () => {
  test('SE 4351 keys: the base list, without termPaperWeight', () => {
    const c = course('SE4351');
    assert.deepEqual(sorted(model.placeholderKeys(c)), sorted(BASE_KEYS));
  });

  test('SE 6362 keys: the base list plus termPaperWeight', () => {
    const c = course('SE6362');
    assert.deepEqual(sorted(model.placeholderKeys(c)), sorted(BASE_KEYS.concat('termPaperWeight')));
  });

  test('every placeholder is unconfirmed by default, with a label and a note', () => {
    ['SE4351', 'SE6362'].forEach((tpl) => {
      const c = course(tpl);
      const keys = model.placeholderKeys(c);
      keys.forEach((k) => assert.equal(c.placeholders[k].confirmed, false, `${tpl} ${k} should be unconfirmed`));
      const open = model.unconfirmedPlaceholders(c);
      assert.deepEqual(sorted(open.map((p) => p.key)), sorted(keys));
      open.forEach((p) => {
        assert.ok(typeof p.label === 'string' && p.label.length > 0);
        assert.ok(typeof p.note === 'string' && p.note.length > 0);
      });
    });
  });

  test('a confirmed placeholder drops out of the unconfirmed list', () => {
    const c = course('SE4351');
    c.placeholders.rounding = { confirmed: true, confirmedAt: '2026-09-28T10:00:00.000Z' };
    const keys = model.unconfirmedPlaceholders(c).map((p) => p.key);
    assert.ok(!keys.includes('rounding'));
    assert.equal(keys.length, BASE_KEYS.length - 1);
    assert.equal(model.isConfirmed(c, 'rounding'), true);
    assert.equal(model.isConfirmed(c, 'curve'), false);
  });
});

describe('small helpers', () => {
  test('studentName is "Last, First" and tolerates a missing part', () => {
    assert.equal(model.studentName({ lastName: 'Student 01', firstName: 'Alpha' }), 'Student 01, Alpha');
    assert.equal(model.studentName({ lastName: 'Student 01', firstName: '' }), 'Student 01');
    assert.equal(model.studentName({ lastName: '', firstName: 'Alpha' }), 'Alpha');
  });

  test('nextStudentNo is max(no) + 1', () => {
    const c = course('SE4351');
    assert.equal(model.nextStudentNo(c), 1);
    c.students.push(model.createStudent({ no: 3, lastName: 'Student 03' }));
    c.students.push(model.createStudent({ no: 7, lastName: 'Student 07' }));
    c.students.push(model.createStudent({ no: 5, lastName: 'Student 05' }));
    assert.equal(model.nextStudentNo(c), 8);
  });

  test('createStudent defaults: active, no team, empty notes, prefixed id', () => {
    const s = model.createStudent({ lastName: 'Student 01', firstName: 'Alpha' });
    assert.equal(s.status, 'active');
    assert.equal(s.teamId, null);
    assert.equal(s.notes, '');
    assert.ok(s.id.startsWith('s_'));
  });
});

// ---------------------------------------------------------------- normalize / backup

describe('normalizeState', () => {
  function assertReadableError(fn) {
    assert.throws(fn, (e) => {
      assert.ok(e instanceof Error, 'should throw an Error');
      assert.ok(!(e instanceof TypeError), `should be a deliberate error, got TypeError: ${e.message}`);
      assert.ok(typeof e.message === 'string' && e.message.length > 10, 'message should be readable');
      assert.ok(!/undefined|Cannot read/.test(e.message), `message should not be a raw JS error: ${e.message}`);
      return true;
    });
  }

  test('throws a readable Error on garbage', () => {
    assertReadableError(() => model.normalizeState(null));
    assertReadableError(() => model.normalizeState(undefined));
    assertReadableError(() => model.normalizeState(42));
    assertReadableError(() => model.normalizeState('hello'));
    assertReadableError(() => model.normalizeState([1, 2, 3]));
    assertReadableError(() => model.normalizeState({ foo: 'bar' }));
    assertReadableError(() => model.normalizeState({ app: 'some-other-app', courses: [] }));
  });

  test('a JSON round trip of the default state returns an equivalent state', () => {
    const st = model.createDefaultState();
    const back = model.normalizeState(roundTrip(st));
    assert.deepEqual(back, st);
  });

  test('a JSON round trip of a populated state returns an equivalent state', () => {
    const st = model.createDefaultState();
    const c = st.courses[0];
    const t = addTeam(c, 'Team 1');
    const s1 = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id, notes: 'fake note' });
    const s2 = addStudent(c, 'Student 02', 'Bravo', { status: 'withdrawn' });
    setTeamScore(c, t, 'a_p1', 88);
    setScore(c, s1, 'a_p1', 80, { override: true });
    setScore(c, s1, 'a_t1', 90, { weeksLate: 1, waived: true });
    model.setEntry(c.scores, s2.id, 'a_t1', { value: null, text: 'abc' });
    c.attendance.records[s1.id] = { [c.attendance.sessions[0].id]: 'P', [c.attendance.sessions[1].id]: 'A', [c.attendance.sessions[2].id]: 'E' };
    c.settings.curve = 1.5;
    c.settings.rounding = 'hundredth';
    c.placeholders.rounding = { confirmed: true, confirmedAt: '2026-09-28T10:00:00.000Z' };
    c.exportPresets.push({ id: 'xp_1', name: 'Mine', columns: ['no', 'lastName'] });
    c.history.push({
      id: 'h_1', ts: '2026-09-28T10:00:00.000Z', source: 'edit', kind: 'score', studentId: s1.id,
      studentName: 'Student 01, Alpha', teamId: null, teamName: null, field: 'Test 1', fieldKey: 'a_t1',
      oldValue: '', newValue: '90', note: ''
    });
    st.ui.theme = 'dark';
    st.ui.privacy = true;
    st.meta.lastBackupAt = '2026-09-27T10:00:00.000Z';
    const back = model.normalizeState(roundTrip(st));
    assert.deepEqual(back, st);
  });

  test('fills missing fields with defaults', () => {
    const st = model.normalizeState({
      app: 'grade-tracker',
      courses: [{ template: 'SE4351', code: 'SE 4351', title: 'Requirements Engineering', level: 'undergraduate',
        students: [{ lastName: 'Student 01', firstName: 'Alpha' }] }]
    });
    assert.equal(st.app, 'grade-tracker');
    assert.equal(st.schemaVersion, 1);
    assert.equal(st.courses.length, 1);
    const c = st.courses[0];
    assert.ok(typeof c.id === 'string' && c.id.length > 0);
    assert.equal(st.activeCourseId, c.id);
    assert.deepEqual(c.teams, []);
    assert.deepEqual(c.scores, {});
    assert.deepEqual(c.teamScores, {});
    assert.deepEqual(c.history, []);
    assert.deepEqual(c.exportPresets, []);
    assert.equal(c.settings.rounding, 'none');
    assert.equal(c.settings.curve, 0);
    assert.equal(c.settings.latePointsPerWeek, 10);
    assert.equal(c.settings.decimals, 2);
    assert.deepEqual(c.settings.letterScale, UG_SCALE);
    assert.equal(c.settings.passingLetter, 'D-');
    assert.ok(['per-session', 'totals', 'off'].includes(c.attendance.mode));
    assert.ok(Array.isArray(c.attendance.sessions));
    assert.deepEqual(c.attendance.records, {});
    assert.equal(c.attendance.unexcusedThreshold, 3);
    assert.equal(c.attendance.excusedCountsTowardStreak, true);
    assert.deepEqual(sorted(Object.keys(c.placeholders)), sorted(BASE_KEYS));
    Object.keys(c.placeholders).forEach((k) => assert.equal(c.placeholders[k].confirmed, false));
    const s = c.students[0];
    assert.ok(typeof s.id === 'string' && s.id.length > 0);
    assert.equal(s.status, 'active');
    assert.equal(s.teamId, null);
    assert.equal(s.notes, '');
    assert.equal(st.ui.theme, 'system');
    assert.equal(st.ui.privacy, false);
    assert.equal(st.meta.lastBackupAt, null);
  });

  test('graduate course with no letter scale gets the graduate default', () => {
    const st = model.normalizeState({ app: 'grade-tracker', courses: [{ template: 'SE6362', level: 'graduate' }] });
    assert.deepEqual(st.courses[0].settings.letterScale, GRAD_SCALE);
    assert.equal(st.courses[0].settings.passingLetter, 'C');
  });

  test('drops invalid entries and repairs invalid settings', () => {
    const st = model.normalizeState({
      app: 'grade-tracker',
      courses: [{
        id: 'c_1', template: 'SE4351', code: 'SE 4351', level: 'undergraduate',
        teams: [{ id: 't_1', name: 'Team 1' }, 'junk'],
        students: [{ id: 's_1', lastName: 'Student 01', firstName: 'Alpha', teamId: 't_1' }, null, 42, 'junk'],
        scores: {
          s_1: { a_t1: { value: 80 }, a_t2: 'junk', a_part: null, a_p1: 42 },
          s_2: 'junk'
        },
        teamScores: { t_1: { a_p1: { value: 90 }, a_p2: [1, 2] } },
        attendance: {
          mode: 'per-session',
          sessions: [{ id: 'ses_a', date: '2026-09-08' }, { id: 'ses_b', date: '2026-02-30' }, { id: 'ses_c', date: '2026-09-03' }, 'junk'],
          records: { s_1: { ses_a: 'P', ses_c: 'X' } }
        },
        settings: { rounding: 'banana' }
      }]
    });
    const c = st.courses[0];
    assert.equal(c.students.length, 1);
    assert.equal(c.students[0].id, 's_1');
    assert.equal(c.teams.length, 1);
    assert.deepEqual(c.scores, { s_1: { a_t1: { value: 80 } } });
    assert.deepEqual(c.teamScores, { t_1: { a_p1: { value: 90 } } });
    assert.deepEqual(c.attendance.sessions.map((s) => s.date), ['2026-09-03', '2026-09-08']);
    assert.deepEqual(c.attendance.records, { s_1: { ses_a: 'P' } });
    assert.equal(c.settings.rounding, 'none');
  });

  test('sorts the letter scale by cutoff, descending, and drops malformed rows', () => {
    const st = model.normalizeState({
      app: 'grade-tracker',
      courses: [{
        template: 'SE4351',
        settings: { letterScale: [{ letter: 'F', min: 0 }, { letter: 'C', min: 70 }, { letter: 'A', min: 90 }, { letter: 'B', min: 80 }, { letter: '?', min: 'abc' }, 'junk'] }
      }]
    });
    assert.deepEqual(st.courses[0].settings.letterScale, [
      { letter: 'A', min: 90 }, { letter: 'B', min: 80 }, { letter: 'C', min: 70 }, { letter: 'F', min: 0 }
    ]);
  });
});

describe('backup files (R4)', () => {
  test('wrapBackup has the documented envelope', () => {
    const st = model.createDefaultState();
    const w = model.wrapBackup(st, '2026-09-28T12:00:00.000Z');
    assert.equal(w.app, 'grade-tracker');
    assert.equal(w.kind, 'backup');
    assert.equal(w.schemaVersion, 1);
    assert.equal(w.exportedAt, '2026-09-28T12:00:00.000Z');
    assert.equal(w.state, st);
  });

  test('readBackup accepts the wrapped format and summarizes it', () => {
    const st = model.createDefaultState();
    addStudent(st.courses[1], 'Student 01', 'Alpha');
    addStudent(st.courses[1], 'Student 02', 'Bravo');
    const file = roundTrip(model.wrapBackup(st, '2026-09-28T12:00:00.000Z'));
    const r = model.readBackup(file);
    assert.deepEqual(r.state, st);
    assert.equal(r.summary.exportedAt, '2026-09-28T12:00:00.000Z');
    assert.deepEqual(r.summary.courses, [
      { code: 'SE 4351', title: 'Requirements Engineering', students: 0 },
      { code: 'SE 6362', title: 'Software Architectural Design', students: 2 }
    ]);
  });

  test('readBackup accepts a bare state object', () => {
    const st = model.createDefaultState();
    const r = model.readBackup(roundTrip(st));
    assert.deepEqual(r.state, st);
    assert.equal(r.summary.courses.length, 2);
  });

  test('readBackup rejects objects that are not Grade Tracker data', () => {
    const st = model.createDefaultState();
    assert.throws(() => model.readBackup(null), Error);
    assert.throws(() => model.readBackup('backup'), Error);
    assert.throws(() => model.readBackup([]), Error);
    assert.throws(() => model.readBackup({ hello: 'world' }), Error);
    assert.throws(() => model.readBackup({ app: 'other-app', courses: [] }), Error);
    assert.throws(() => model.readBackup({ app: 'other-app', kind: 'backup', schemaVersion: 1, state: roundTrip(st) }), Error);
  });
});

describe('duplicateCourse (C3)', () => {
  function populated() {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const s = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    setTeamScore(c, t, 'a_p1', 88);
    setScore(c, s, 'a_t1', 90);
    c.history.push({ id: 'h_1', ts: '2026-09-01T00:00:00.000Z', source: 'edit', kind: 'score', note: '' });
    c.history.push({ id: 'h_2', ts: '2026-09-02T00:00:00.000Z', source: 'edit', kind: 'score', note: '' });
    return { c, s, t };
  }

  test('new id, " (copy)" code, same content', () => {
    const { c } = populated();
    const copy = model.duplicateCourse(c, '2026-09-28T12:00:00.000Z');
    assert.notEqual(copy.id, c.id);
    assert.equal(copy.code, 'SE 4351 (copy)');
    assert.equal(copy.title, c.title);
    assert.deepEqual(copy.students, c.students);
    assert.deepEqual(copy.scores, c.scores);
    assert.deepEqual(copy.teamScores, c.teamScores);
    assert.deepEqual(copy.assessments, c.assessments);
    assert.deepEqual(copy.settings, c.settings);
  });

  test('history is reset to a single entry that notes the source', () => {
    const { c } = populated();
    const copy = model.duplicateCourse(c, '2026-09-28T12:00:00.000Z');
    assert.equal(copy.history.length, 1);
    assert.ok(JSON.stringify(copy.history[0]).includes('SE 4351'));
    assert.equal(c.history.length, 2);
  });

  test('the copy is independent: mutating it does not affect the original', () => {
    const { c, s, t } = populated();
    const copy = model.duplicateCourse(c, '2026-09-28T12:00:00.000Z');
    copy.students[0].lastName = 'Changed';
    copy.scores[s.id].a_t1.value = 1;
    copy.teamScores[t.id].a_p1.value = 2;
    copy.settings.curve = 5;
    copy.settings.letterScale[0].min = 99;
    copy.assessments[0].weight = 50;
    copy.attendance.sessions.pop();
    copy.history.push({ id: 'h_x' });
    assert.equal(c.students[0].lastName, 'Student 01');
    assert.equal(c.scores[s.id].a_t1.value, 90);
    assert.equal(c.teamScores[t.id].a_p1.value, 88);
    assert.equal(c.settings.curve, 0);
    assert.equal(c.settings.letterScale[0].min, 97);
    assert.equal(c.assessments[0].weight, 10);
    assert.equal(c.attendance.sessions.length, 26);
    assert.equal(c.history.length, 2);
  });
});

// ---------------------------------------------------------------- team-graded helpers (K5)

describe('setTeamScoreFromMembers (paste/import of a team-graded column)', () => {
  function setup() {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    const d = addStudent(c, 'Student 03', 'Charlie', { teamId: t.id });
    const loner = addStudent(c, 'Student 04', 'Delta');
    return { c, t, a, b, d, loner };
  }

  test('all members agree: team score only, no overrides', () => {
    const { c, t, a, b, d } = setup();
    const res = model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: a.id, entry: { value: 85 } },
      { studentId: b.id, entry: { value: 85 } },
      { studentId: d.id, entry: { value: 85 } }
    ]);
    assert.equal(res.overridesCreated, 0);
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 85);
    [a, b, d].forEach((s) => {
      const own = model.getEntry(c.scores, s.id, 'a_p1');
      assert.ok(!own || own.override !== true, 'no override expected');
      const det = calc.scoreDetail(c, s, byName(c, 'a_p1'));
      assert.equal(det.raw, 85);
      assert.equal(det.source, 'team');
    });
  });

  test('disagreement: majority becomes the team score, the others become overrides', () => {
    const { c, t, a, b, d } = setup();
    const res = model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: a.id, entry: { value: 85 } },
      { studentId: b.id, entry: { value: 70 } },
      { studentId: d.id, entry: { value: 85 } }
    ]);
    assert.equal(res.overridesCreated, 1);
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 85);
    const ob = model.getEntry(c.scores, b.id, 'a_p1');
    assert.equal(ob.value, 70);
    assert.equal(ob.override, true);
    [a, d].forEach((s) => {
      const own = model.getEntry(c.scores, s.id, 'a_p1');
      assert.ok(!own || own.override !== true);
    });
    assert.deepEqual(visible(c, a, 'a_p1'), { state: 'number', raw: 85, text: null });
    assert.deepEqual(visible(c, b, 'a_p1'), { state: 'number', raw: 70, text: null });
    assert.equal(calc.scoreDetail(c, b, byName(c, 'a_p1')).source, 'override');
    assert.deepEqual(visible(c, d, 'a_p1'), { state: 'number', raw: 85, text: null });
  });

  test('a stale override is removed when the pasted value matches the team score', () => {
    const { c, a, b, d } = setup();
    setScore(c, a, 'a_p1', 60, { override: true });
    model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: a.id, entry: { value: 90 } },
      { studentId: b.id, entry: { value: 90 } },
      { studentId: d.id, entry: { value: 90 } }
    ]);
    const det = calc.scoreDetail(c, a, byName(c, 'a_p1'));
    assert.equal(det.raw, 90);
    assert.equal(det.source, 'team');
  });

  test('a student without a team gets an individual entry', () => {
    const { c, loner } = setup();
    model.setTeamScoreFromMembers(c, 'a_p1', [{ studentId: loner.id, entry: { value: 77 } }]);
    const own = model.getEntry(c.scores, loner.id, 'a_p1');
    assert.equal(own.value, 77);
    assert.ok(own.override !== true);
    const det = calc.scoreDetail(c, loner, byName(c, 'a_p1'));
    assert.equal(det.raw, 77);
    assert.equal(det.source, 'individual');
  });
});

describe('convertAssessmentToTeam / convertAssessmentToIndividual preserve visible values', () => {
  function setup() {
    const c = course('SE4351');
    const t1 = addTeam(c, 'Team 1');
    const t2 = addTeam(c, 'Team 2');
    const t3 = addTeam(c, 'Team 3');
    const s1 = addStudent(c, 'Student 01', 'Alpha', { teamId: t1.id });
    const s2 = addStudent(c, 'Student 02', 'Bravo', { teamId: t1.id });
    const s3 = addStudent(c, 'Student 03', 'Charlie', { teamId: t1.id });
    // Team 2: stored out of name order on purpose; tie between 75 and 65.
    const s6 = addStudent(c, 'Student 06', 'Foxtrot', { teamId: t2.id });
    const s5 = addStudent(c, 'Student 05', 'Echo', { teamId: t2.id });
    // Team 3: mostly empty, one number, one invalid text.
    const s7 = addStudent(c, 'Student 07', 'Golf', { teamId: t3.id });
    const s8 = addStudent(c, 'Student 08', 'Hotel', { teamId: t3.id });
    const s9 = addStudent(c, 'Student 09', 'India', { teamId: t3.id });
    const s10 = addStudent(c, 'Student 10', 'Juliet', { teamId: t3.id });
    const loner = addStudent(c, 'Student 04', 'Delta');
    setScore(c, s1, 'a_t1', 80);
    setScore(c, s2, 'a_t1', 80);
    setScore(c, s3, 'a_t1', 70);
    setScore(c, s5, 'a_t1', 75);
    setScore(c, s6, 'a_t1', 65);
    setScore(c, s9, 'a_t1', 50);
    model.setEntry(c.scores, s10.id, 'a_t1', { value: null, text: 'abs' });
    setScore(c, loner, 'a_t1', 60);
    return { c, t1, t2, t3, s1, s2, s3, s5, s6, s7, s8, s9, s10, loner };
  }

  // Team 3 (Student 07 and 08 empty, Student 09 50, Student 10 'abs'): blank cells do not vote
  // (DESIGN 2.3), so the vote is 50 vs 'abs', a tie won by Student 09 (first by name). Team score 50;
  // Student 10 keeps 'abs' as an override; Students 07 and 08 had no score and follow the team (50).
  function expectedAfterToTeam(before, ids) {
    const out = Object.assign({}, before);
    [ids.s7, ids.s8].forEach((s) => { out[s.id] = { state: 'number', raw: 50, text: null }; });
    return out;
  }

  test('to team: every entered score is preserved; members with no score follow the team score', () => {
    const ids = setup();
    const { c, t3, s7, s8, s10 } = ids;
    const before = visibleAll(c, 'a_t1');
    model.convertAssessmentToTeam(c, 'a_t1');
    assert.equal(byName(c, 'a_t1').teamGraded, true);
    assert.deepEqual(visibleAll(c, 'a_t1'), expectedAfterToTeam(before, ids));
    assert.equal(model.getEntry(c.teamScores, t3.id, 'a_t1').value, 50);
    assert.deepEqual(model.getEntry(c.scores, s10.id, 'a_t1'), { value: null, text: 'abs', override: true });
    [s7, s8].forEach((s) => {
      assert.equal(model.getEntry(c.scores, s.id, 'a_t1'), null, 'no empty override');
      assert.equal(calc.scoreDetail(c, s, byName(c, 'a_t1')).source, 'team');
    });
  });

  test('to team: majority is the team score, differing member keeps an override, loner stays individual', () => {
    const { c, t1, s1, s3, loner } = setup();
    model.convertAssessmentToTeam(c, 'a_t1');
    assert.equal(model.getEntry(c.teamScores, t1.id, 'a_t1').value, 80);
    const o = model.getEntry(c.scores, s3.id, 'a_t1');
    assert.equal(o.value, 70);
    assert.equal(o.override, true);
    assert.equal(calc.scoreDetail(c, s1, byName(c, 'a_t1')).source, 'team');
    assert.equal(calc.scoreDetail(c, s3, byName(c, 'a_t1')).source, 'override');
    const ld = calc.scoreDetail(c, loner, byName(c, 'a_t1'));
    assert.equal(ld.source, 'individual');
    assert.equal(ld.raw, 60);
  });

  test('to team: a tie goes to the value of the first member by name', () => {
    const { c, t2, s5, s6 } = setup();
    model.convertAssessmentToTeam(c, 'a_t1');
    // Student 05 (75) sorts before Student 06 (65).
    assert.equal(model.getEntry(c.teamScores, t2.id, 'a_t1').value, 75);
    assert.equal(calc.scoreDetail(c, s5, byName(c, 'a_t1')).source, 'team');
    const o = model.getEntry(c.scores, s6.id, 'a_t1');
    assert.equal(o.value, 65);
    assert.equal(o.override, true);
  });

  test('to individual after to team: every student keeps the value seen as team-graded, no overrides, team entries gone', () => {
    const ids = setup();
    const { c } = ids;
    const before = visibleAll(c, 'a_t1');
    model.convertAssessmentToTeam(c, 'a_t1');
    const asTeam = visibleAll(c, 'a_t1');
    assert.deepEqual(asTeam, expectedAfterToTeam(before, ids));
    model.convertAssessmentToIndividual(c, 'a_t1');
    assert.equal(byName(c, 'a_t1').teamGraded, false);
    assert.deepEqual(visibleAll(c, 'a_t1'), asTeam);
    Object.keys(c.scores).forEach((sid) => {
      const e = c.scores[sid].a_t1;
      assert.ok(!e || e.override !== true, 'override flags must be cleared');
    });
    Object.keys(c.teamScores).forEach((tid) => {
      assert.equal(model.getEntry(c.teamScores, tid, 'a_t1'), null);
    });
  });

  test('to individual on Project I with a team score and an override', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    const loner = addStudent(c, 'Student 03', 'Charlie');
    setTeamScore(c, t, 'a_p1', 88);
    setScore(c, b, 'a_p1', 80, { override: true });
    setScore(c, loner, 'a_p1', 66);
    const before = visibleAll(c, 'a_p1');
    model.convertAssessmentToIndividual(c, 'a_p1');
    assert.deepEqual(visibleAll(c, 'a_p1'), before);
    assert.deepEqual(visible(c, a, 'a_p1'), { state: 'number', raw: 88, text: null });
    assert.deepEqual(visible(c, b, 'a_p1'), { state: 'number', raw: 80, text: null });
    assert.equal(model.getEntry(c.scores, a.id, 'a_p1').value, 88);
    assert.ok(model.getEntry(c.scores, b.id, 'a_p1').override !== true);
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1'), null);
    assert.equal(calc.scoreDetail(c, b, byName(c, 'a_p1')).source, 'individual');
  });
});

describe('moveStudentToTeam', () => {
  function setup() {
    const c = course('SE4351');
    const t1 = addTeam(c, 'Team 1');
    const t2 = addTeam(c, 'Team 2');
    const t3 = addTeam(c, 'Team 3');
    const s = addStudent(c, 'Student 01', 'Alpha', { teamId: t1.id });
    addStudent(c, 'Student 02', 'Bravo', { teamId: t1.id });
    setTeamScore(c, t1, 'a_p1', 88);
    setTeamScore(c, t2, 'a_p1', 70);
    setTeamScore(c, t3, 'a_p1', 88);
    return { c, t1, t2, t3, s };
  }
  const det = (c, s) => calc.scoreDetail(c, s, byName(c, 'a_p1'));

  test('without keepScores: scores follow the new team', () => {
    const { c, t2, s } = setup();
    model.moveStudentToTeam(c, s.id, t2.id);
    assert.equal(s.teamId, t2.id);
    assert.equal(det(c, s).raw, 70);
    assert.equal(det(c, s).source, 'team');
  });

  test('with keepScores: the old score is kept as an override in the new team', () => {
    const { c, t2, s } = setup();
    model.moveStudentToTeam(c, s.id, t2.id, { keepScores: true });
    assert.equal(s.teamId, t2.id);
    assert.equal(det(c, s).raw, 88);
    assert.equal(det(c, s).source, 'override');
  });

  test('with keepScores into a team with the same score: no override needed', () => {
    const { c, t3, s } = setup();
    model.moveStudentToTeam(c, s.id, t3.id, { keepScores: true });
    assert.equal(det(c, s).raw, 88);
    assert.equal(det(c, s).source, 'team');
  });

  test('with keepScores to no team: the old score becomes an individual entry', () => {
    const { c, s } = setup();
    model.moveStudentToTeam(c, s.id, null, { keepScores: true });
    assert.equal(s.teamId, null);
    assert.equal(det(c, s).raw, 88);
    assert.equal(det(c, s).source, 'individual');
  });

  test('without keepScores to no team: the student has no score for the team item', () => {
    const { c, s } = setup();
    model.moveStudentToTeam(c, s.id, null);
    assert.equal(s.teamId, null);
    assert.equal(det(c, s).state, 'empty');
  });

  test('without keepScores an old-team override is dropped: the unequal split belonged to the old team', () => {
    const { c, t2, s } = setup();
    setScore(c, s, 'a_p1', 80, { override: true });
    model.moveStudentToTeam(c, s.id, t2.id);
    assert.equal(det(c, s).raw, 70);
    assert.equal(det(c, s).source, 'team');
    assert.equal(model.getEntry(c.scores, s.id, 'a_p1'), null);
  });

  test('without keepScores to no team, an old override does not turn into an individual score', () => {
    const { c, s } = setup();
    setScore(c, s, 'a_p1', 80, { override: true });
    model.moveStudentToTeam(c, s.id, null);
    assert.equal(det(c, s).state, 'empty');
  });

  test('with keepScores, an empty score is not kept as an override (the student follows the new team)', () => {
    const { c, t1, t2, s } = setup();
    model.setEntry(c.teamScores, t1.id, 'a_p1', null);
    model.moveStudentToTeam(c, s.id, t2.id, { keepScores: true });
    assert.equal(model.getEntry(c.scores, s.id, 'a_p1'), null);
    assert.equal(det(c, s).raw, 70);
    assert.equal(det(c, s).source, 'team');
  });

  test('with keepScores, a differing late-work status is kept as an override (review F3)', () => {
    const { c, t1, t3, s } = setup();
    // Team 1: 88 one week late (adjusted 78); Team 3: 88 on time.
    model.setEntry(c.teamScores, t1.id, 'a_p1', { value: 88, weeksLate: 1 });
    assert.equal(det(c, s).adjusted, 78);
    model.moveStudentToTeam(c, s.id, t3.id, { keepScores: true });
    assert.equal(det(c, s).adjusted, 78);
    assert.equal(det(c, s).source, 'override');
    assert.deepEqual(model.getEntry(c.scores, s.id, 'a_p1'), { value: 88, weeksLate: 1, override: true });
  });

  test('moving a student into the team they are already in changes nothing', () => {
    const { c, t1, s } = setup();
    setScore(c, s, 'a_p1', 80, { override: true });
    model.moveStudentToTeam(c, s.id, t1.id);
    assert.equal(det(c, s).raw, 80);
    assert.equal(det(c, s).source, 'override');
  });

  test('individually graded items are untouched by a move', () => {
    const { c, t2, s } = setup();
    setScore(c, s, 'a_t1', 91);
    model.moveStudentToTeam(c, s.id, t2.id, { keepScores: true });
    assert.equal(calc.scoreDetail(c, s, byName(c, 'a_t1')).raw, 91);
  });
});

describe('entryFromInput', () => {
  test('a number string becomes a numeric entry', () => {
    assert.deepEqual(model.entryFromInput('88'), { value: 88 });
    assert.deepEqual(model.entryFromInput(' 88.5% '), { value: 88.5 });
  });

  test('a number value becomes a numeric entry', () => {
    assert.deepEqual(model.entryFromInput(90), { value: 90 });
  });

  test('invalid text keeps the text with a null value', () => {
    assert.deepEqual(model.entryFromInput('abc'), { value: null, text: 'abc' });
  });

  test('empty input gives a null value without text', () => {
    const e = model.entryFromInput('');
    assert.equal(e.value, null);
    assert.ok(!e.text);
    assert.ok(model.isBlankEntry(e));
  });

  test('keeps late info and the override flag from the previous entry', () => {
    const prev = { value: 80, weeksLate: 1, waived: true, override: true };
    assert.deepEqual(model.entryFromInput('75', prev), { value: 75, weeksLate: 1, waived: true, override: true });
    assert.deepEqual(model.entryFromInput('abc', prev), { value: null, text: 'abc', weeksLate: 1, waived: true, override: true });
    const cleared = model.entryFromInput('', { value: 80, weeksLate: 2 });
    assert.equal(cleared.value, null);
    assert.equal(cleared.weeksLate, 2);
  });

  test('does not invent late info when the previous entry had none', () => {
    assert.deepEqual(model.entryFromInput('75', { value: 80 }), { value: 75 });
  });
});

// ---------------------------------------------------------------- review round 1 regressions

describe('restore never pollutes Object.prototype (review F2)', () => {
  const CLEAN = () => ['a_t1', 'a_t2', 'ses_20260903'].forEach((k) => { delete Object.prototype[k]; delete Object[k]; });

  test('"__proto__" and "constructor" owners in scores, teamScores and attendance are dropped', () => {
    const base = roundTrip(course('SE4351'));
    base.students = [{ id: 's1', lastName: 'Student 01', firstName: 'Alpha' }];
    const json = JSON.stringify({ app: 'grade-tracker', kind: 'backup', state: { app: 'grade-tracker', courses: [base] } })
      .replace('"scores":{}', '"scores":{"__proto__":{"a_t2":{"value":100}},"constructor":{"a_t1":{"value":77}},"s1":{"a_t1":{"value":50}}}')
      .replace('"teamScores":{}', '"teamScores":{"__proto__":{"a_p1":{"value":90}}}')
      .replace('"records":{}', '"records":{"__proto__":{"ses_20260903":"A"},"s1":{"__proto__":"A","ses_20260903":"P"}}')
      .replace('"totals":{}', '"totals":{"__proto__":{"absent":2,"excused":0}}');
    try {
      const { state } = model.readBackup(JSON.parse(json));
      assert.equal(({}).a_t2, undefined);
      assert.equal(({}).a_p1, undefined);
      assert.equal(({}).ses_20260903, undefined);
      assert.equal(Object.a_t1, undefined);
      const c = state.courses[0];
      assert.deepEqual(c.scores, { s1: { a_t1: { value: 50 } } });
      assert.deepEqual(c.teamScores, {});
      assert.deepEqual(c.attendance.records, { s1: { ses_20260903: 'P' } });
      assert.deepEqual(c.attendance.totals, {});
      // The student's total uses only their own Test 1 score: 50 x 25 / 100 = 12.5.
      assert.equal(calc.studentResult(c, c.students[0]).total, 12.5);
    } finally {
      CLEAN();
    }
  });

  test('setEntry ignores unsafe keys and getEntry ignores inherited names', () => {
    const map = {};
    model.setEntry(map, '__proto__', 'a_t1', { value: 1 });
    model.setEntry(map, 'constructor', 'a_t1', { value: 1 });
    model.setEntry(map, 's_1', '__proto__', { value: 1 });
    assert.equal(({}).a_t1, undefined);
    assert.equal(Object.a_t1, undefined);
    assert.deepEqual(map, {});
    assert.equal(model.getEntry({}, 'toString', 'a_t1'), null);
    assert.equal(model.getEntry({ s_1: {} }, 's_1', 'toString'), null);
  });
});

describe('inherited names are not valid templates, marks or duplicate ids (review F4)', () => {
  test('templates "toString", "constructor" and "__proto__" become custom with custom defaults', () => {
    ['toString', 'constructor', '__proto__', 'valueOf'].forEach((tpl) => {
      const c = model.normalizeCourse(JSON.parse('{"template":' + JSON.stringify(tpl) + '}'));
      assert.equal(c.template, 'custom', tpl);
      assert.equal(c.code, 'New Course');
      assert.equal(c.title, 'Untitled course');
    });
    assert.equal(model.createCourse('constructor').template, 'custom');
    assert.equal(model.createCourse('toString').code, 'New Course');
  });

  test('ids named like Object.prototype members are kept with their data', () => {
    const c = model.normalizeCourse({
      template: 'SE4351',
      assessments: roundTrip(course('SE4351').assessments),
      teams: [{ id: 'toString', name: 'Team 1' }],
      students: [{ id: 'valueOf', lastName: 'Student 01', teamId: 'toString' }, { id: 's_2', lastName: 'Student 02', teamId: 'hasOwnProperty' }],
      scores: { valueOf: { a_t1: { value: 70 } } },
      attendance: { mode: 'per-session', sessions: [{ id: 'toString', date: '2026-09-03' }], records: { valueOf: { toString: 'A' } } }
    });
    assert.equal(c.students[0].id, 'valueOf');
    assert.equal(c.students[0].teamId, 'toString');
    assert.equal(c.students[1].teamId, null, 'a teamId naming an inherited member is dangling');
    assert.equal(c.teams[0].id, 'toString');
    assert.equal(c.attendance.sessions[0].id, 'toString');
    assert.deepEqual(c.attendance.records, { valueOf: { toString: 'A' } });
    assert.equal(calc.scoreDetail(c, c.students[0], model.findAssessment(c, 'a_t1')).raw, 70);
  });

  test('ids "__proto__", "constructor" and "prototype" are replaced', () => {
    const c = model.normalizeCourse(JSON.parse('{"id":"__proto__","students":[{"id":"__proto__"},{"id":"constructor"}],' +
      '"teams":[{"id":"prototype"}],"assessments":[{"id":"constructor","name":"X"}]}'));
    assert.ok(c.id.startsWith('c_'));
    c.students.forEach((s) => assert.ok(s.id.startsWith('s_'), s.id));
    assert.ok(c.teams[0].id.startsWith('t_'));
    assert.ok(c.assessments[0].id.startsWith('a_'));
  });

  test('attendance marks named like Object.prototype members are rejected', () => {
    const c = model.normalizeCourse(JSON.parse('{"attendance":{"sessions":[{"id":"ses_1","date":"2026-09-03"}],' +
      '"records":{"s_1":{"ses_1":"constructor"},"s_2":{"ses_1":"toString"},"s_3":{"ses_1":"__proto__"},"s_4":{"ses_1":"E"}}}}'));
    assert.deepEqual(c.attendance.records, { s_4: { ses_1: 'E' } });
  });

  test('activeCourseId naming an inherited member falls back to the first course', () => {
    const st = model.normalizeState({ app: 'grade-tracker', courses: [{ id: 'c_1' }], activeCourseId: 'constructor' });
    assert.equal(st.activeCourseId, 'c_1');
  });

  test('duplicate export preset ids are made unique', () => {
    const c = model.normalizeCourse({ exportPresets: [
      { id: 'p1', name: 'A', columns: ['no'] }, { id: 'p1', name: 'B', columns: ['no'] }, { id: '__proto__', name: 'C', columns: [] }
    ] });
    const ids = c.exportPresets.map((p) => p.id);
    assert.equal(ids[0], 'p1');
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids[2].startsWith('xp_'));
  });
});

describe('late-work info counts as part of a team score (review F3)', () => {
  function team3() {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    const d = addStudent(c, 'Student 03', 'Charlie', { teamId: t.id });
    return { c, t, a, b, d };
  }
  const adjusted = (c, list, aid) => list.map((s) => calc.scoreDetail(c, s, byName(c, aid)).adjusted);

  test('entryKey distinguishes weeks late and a waived penalty', () => {
    assert.notEqual(model.entryKey({ value: 80 }), model.entryKey({ value: 80, weeksLate: 1 }));
    assert.notEqual(model.entryKey({ value: 80, weeksLate: 2 }), model.entryKey({ value: 80, weeksLate: 2, waived: true }));
    assert.equal(model.entryKey({ value: 80, waived: true }), model.entryKey({ value: 80 }), 'waived without weeks late changes nothing');
    assert.equal(model.entryKey({ value: 80, override: true }), model.entryKey({ value: 80 }));
  });

  test('convertAssessmentToTeam keeps each adjusted score when late info differs', () => {
    [
      [{ value: 90, weeksLate: 1 }, { value: 90 }, { value: 90 }],
      [{ value: 80 }, { value: 80, weeksLate: 1 }, { value: 80 }],
      [{ value: 80, weeksLate: 2, waived: true }, { value: 80, weeksLate: 2 }, { value: 80, weeksLate: 2, waived: true }]
    ].forEach((entries) => {
      const { c, a, b, d } = team3();
      [a, b, d].forEach((s, i) => model.setEntry(c.scores, s.id, 'a_t1', entries[i]));
      const before = adjusted(c, [a, b, d], 'a_t1');
      model.convertAssessmentToTeam(c, 'a_t1');
      assert.deepEqual(adjusted(c, [a, b, d], 'a_t1'), before, JSON.stringify(entries));
    });
  });

  test('a pasted team column with one late member makes that member an override', () => {
    const { c, t, a, b, d } = team3();
    const res = model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: a.id, entry: { value: 90 } },
      { studentId: b.id, entry: { value: 90, weeksLate: 1 } },
      { studentId: d.id, entry: { value: 90 } }
    ]);
    assert.equal(res.overridesCreated, 1);
    assert.deepEqual(model.getEntry(c.teamScores, t.id, 'a_p1'), { value: 90 });
    assert.deepEqual(adjusted(c, [a, b, d], 'a_p1'), [90, 80, 90]);
  });
});

describe('convertAssessmentToTeam on an already team-graded item (review F5)', () => {
  test('does nothing: team scores and overrides stay', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const list = ['01', '02', '03'].map((n) => addStudent(c, `Student ${n}`, 'X', { teamId: t.id }));
    setTeamScore(c, t, 'a_p1', 90);
    setScore(c, list[2], 'a_p1', 70, { override: true });
    const beforeTeam = roundTrip(c.teamScores);
    const beforeScores = roundTrip(c.scores);
    assert.deepEqual(model.convertAssessmentToTeam(c, 'a_p1'), { overridesCreated: 0 });
    assert.deepEqual(c.teamScores, beforeTeam);
    assert.deepEqual(c.scores, beforeScores);
    assert.deepEqual(list.map((s) => visible(c, s, 'a_p1').raw), [90, 90, 70]);
  });
});

describe('blank cells and withdrawn members in team votes (review F2, second review)', () => {
  function setup(opts) {
    const c = course(opts && opts.template);
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id, status: opts && opts.aWithdrawn ? 'withdrawn' : 'active' });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    const d = opts && opts.two ? null : addStudent(c, 'Student 03', 'Charlie', { teamId: t.id });
    return { c, t, a, b, d };
  }

  test('a blank cell in a pasted team column does not create an empty override', () => {
    const { c, t, a, b, d } = setup();
    setScore(c, d, 'a_p1', 60, { override: true }); // an old override is cleared by the blank cell
    const res = model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: a.id, entry: { value: 90 } },
      { studentId: b.id, entry: { value: 90 } },
      { studentId: d.id, entry: null }
    ]);
    assert.equal(res.overridesCreated, 0);
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 90);
    assert.equal(model.getEntry(c.scores, d.id, 'a_p1'), null);
    const x = calc.scoreDetail(c, d, byName(c, 'a_p1'));
    assert.equal(x.raw, 90);
    assert.equal(x.source, 'team');
  });

  test('a single number among blanks becomes the team score', () => {
    const { c, t, a, b, d } = setup();
    model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: a.id, entry: { value: null } },
      { studentId: b.id, entry: null },
      { studentId: d.id, entry: { value: 75 } }
    ]);
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 75);
    assert.deepEqual(c.scores, {});
  });

  test('an all-blank team clears the team score', () => {
    const { c, t, a, b, d } = setup();
    setTeamScore(c, t, 'a_p1', 88);
    model.setTeamScoreFromMembers(c, 'a_p1', [a, b, d].map((s) => ({ studentId: s.id, entry: null })));
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1'), null);
  });

  test('a withdrawn member does not outvote an active member (SE 6362 team of 2)', () => {
    const { c, t, a, b } = setup({ template: 'SE6362', two: true, aWithdrawn: true });
    setScore(c, b, 'a_t1', 90);
    model.convertAssessmentToTeam(c, 'a_t1');
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_t1').value, 90);
    assert.equal(calc.scoreDetail(c, b, byName(c, 'a_t1')).source, 'team');
    assert.equal(model.getEntry(c.scores, a.id, 'a_t1'), null);
  });

  test('a withdrawn member with a different number keeps it as an override but does not win a tie', () => {
    const { c, t, a, b } = setup({ two: true, aWithdrawn: true });
    const res = model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: a.id, entry: { value: 0 } },
      { studentId: b.id, entry: { value: 85 } }
    ]);
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 85);
    assert.equal(res.overridesCreated, 1);
    assert.deepEqual(model.getEntry(c.scores, a.id, 'a_p1'), { value: 0, override: true });
  });

  test('withdrawn members vote when no active member has a score', () => {
    const { c, t, a, b } = setup({ two: true, aWithdrawn: true });
    model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: a.id, entry: { value: 70 } },
      { studentId: b.id, entry: null }
    ]);
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 70);
    assert.deepEqual(c.scores, {});
  });
});

describe('partial-team paste (review F3, second review)', () => {
  test('rows for part of a team set the team score; propagatedTo lists the other members it changed', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    const d = addStudent(c, 'Student 03', 'Charlie', { teamId: t.id });
    const e = addStudent(c, 'Student 04', 'Delta', { teamId: t.id });
    setTeamScore(c, t, 'a_p1', 90);
    setScore(c, e, 'a_p1', 70, { override: true });
    const res = model.setTeamScoreFromMembers(c, 'a_p1', [{ studentId: a.id, entry: { value: 80 } }]);
    assert.deepEqual(sorted(res.propagatedTo), sorted([b.id, d.id]));
    assert.deepEqual([a, b, d, e].map((s) => visible(c, s, 'a_p1').raw), [80, 80, 80, 70]);
  });

  test('propagatedTo is empty when every member is in the rows or nothing changes for the others', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    setTeamScore(c, t, 'a_p1', 90);
    assert.deepEqual(model.setTeamScoreFromMembers(c, 'a_p1', [{ studentId: a.id, entry: { value: 90 } }]).propagatedTo, []);
  });
});

describe('pasting over override members (third review V1)', () => {
  // What the grid does: each pasted cell goes through entryFromInput(text, prev) with prev = the
  // member's visible entry, so a non-empty cell over an override keeps override: true.
  const cellText = (e) => (e && typeof e.value === 'number' ? String(e.value) : (e && e.text) || '');
  function pasteRows(c, list, aid, texts) {
    return list.map((s, i) => {
      const prev = model.effectiveEntry(c, s, byName(c, aid));
      const text = texts ? texts[i] : cellText(prev);
      return { studentId: s.id, entry: model.entryFromInput(text, prev) };
    });
  }
  const shown = (c, list, aid) => list.map((s) => {
    const d = calc.scoreDetail(c, s, byName(c, aid));
    return (d.raw === null ? '-' : String(d.raw)) + (d.source === 'override' ? '*' : '');
  });
  function oneTeam(n) {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const list = [];
    for (let i = 1; i <= n; i++) list.push(addStudent(c, `Student 0${i}`, 'X', { teamId: t.id }));
    setTeamScore(c, t, 'a_p1', 90);
    return { c, t, list };
  }

  test('a name-sorted block over two teams pasted back unchanged changes nothing', () => {
    const c = course('SE4351');
    const t1 = addTeam(c, 'Team 1');
    const t2 = addTeam(c, 'Team 2');
    // Name order interleaves the teams: 01 T1, 02 T2, 03 T1, 04 T2, 05 T1, 06 T2.
    const list = [1, 2, 3, 4, 5, 6].map((n) => addStudent(c, `Student 0${n}`, 'X', { teamId: n % 2 ? t1.id : t2.id }));
    setTeamScore(c, t1, 'a_p1', 90);
    setTeamScore(c, t2, 'a_p1', 80);
    model.setOverride(c, list[0].id, 'a_p1', { value: 70 });
    const before = shown(c, list, 'a_p1');
    assert.deepEqual(before, ['70*', '80', '90', '80', '90', '80']);
    const scoresBefore = roundTrip(c.scores);
    const teamBefore = roundTrip(c.teamScores);
    const res = model.setTeamScoreFromMembers(c, 'a_p1', pasteRows(c, list.slice(0, 2), 'a_p1'));
    assert.deepEqual(shown(c, list, 'a_p1'), before);
    assert.deepEqual(res.propagatedTo, []);
    assert.equal(res.overridesCreated, 0);
    assert.deepEqual(c.scores, scoresBefore);
    assert.deepEqual(c.teamScores, teamBefore);
  });

  test('pasting back part of one team keeps the override on the same member', () => {
    const { c, list } = oneTeam(4);
    model.setOverride(c, list[0].id, 'a_p1', { value: 70 });
    const res = model.setTeamScoreFromMembers(c, 'a_p1', pasteRows(c, list.slice(0, 2), 'a_p1'));
    assert.deepEqual(shown(c, list, 'a_p1'), ['70*', '90', '90', '90']);
    assert.deepEqual(res.propagatedTo, []);
  });

  test('an empty override ("no score for this member") survives its blank cell being pasted back', () => {
    const { c, list } = oneTeam(3);
    model.setOverride(c, list[0].id, 'a_p1', null);
    const res = model.setTeamScoreFromMembers(c, 'a_p1', pasteRows(c, list.slice(0, 2), 'a_p1'));
    assert.deepEqual(shown(c, list, 'a_p1'), ['-*', '90', '90']);
    assert.deepEqual(model.getEntry(c.scores, list[0].id, 'a_p1'), { value: null, override: true });
    assert.deepEqual(res.propagatedTo, []);
  });

  test('an override value never becomes the team score, even when its rows outnumber the others', () => {
    const { c, t, list } = oneTeam(4);
    model.setOverride(c, list[0].id, 'a_p1', { value: 70 });
    model.setOverride(c, list[1].id, 'a_p1', { value: 60 });
    // Both override cells get 75; the one ordinary member in the rows is pasted back as 90.
    const res = model.setTeamScoreFromMembers(c, 'a_p1', pasteRows(c, list.slice(0, 3), 'a_p1', ['75', '75', '90']));
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 90);
    assert.deepEqual(shown(c, list, 'a_p1'), ['75*', '75*', '90', '90']);
    assert.equal(res.overridesCreated, 0, 'both members already had an override');
    assert.deepEqual(res.propagatedTo, []);
  });

  test('rows that are all override rows leave the team score alone', () => {
    const { c, t, list } = oneTeam(3);
    model.setOverride(c, list[0].id, 'a_p1', { value: 70 });
    const res = model.setTeamScoreFromMembers(c, 'a_p1', pasteRows(c, list.slice(0, 1), 'a_p1', ['65']));
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 90);
    assert.deepEqual(shown(c, list, 'a_p1'), ['65*', '90', '90']);
    assert.equal(res.teamsSet, 0);
    assert.deepEqual(res.propagatedTo, []);
  });

  test('the team score or a blank pasted over an override hands the member back to the team', () => {
    const { c, list } = oneTeam(3);
    model.setOverride(c, list[0].id, 'a_p1', { value: 70 });
    model.setOverride(c, list[1].id, 'a_p1', { value: 60 });
    const res = model.setTeamScoreFromMembers(c, 'a_p1', pasteRows(c, list.slice(0, 2), 'a_p1', ['90', '']));
    assert.deepEqual(shown(c, list, 'a_p1'), ['90', '90', '90']);
    assert.deepEqual(c.scores, {});
    assert.deepEqual(res.propagatedTo, []);
  });

  test('an entry flagged as an override is kept as one without voting', () => {
    const { c, t, list } = oneTeam(3);
    const res = model.setTeamScoreFromMembers(c, 'a_p1', [
      { studentId: list[0].id, entry: { value: 50, override: true } },
      { studentId: list[1].id, entry: { value: 85 } }
    ]);
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1').value, 85);
    assert.deepEqual(shown(c, list, 'a_p1'), ['50*', '85', '85']);
    assert.equal(res.overridesCreated, 1);
    assert.deepEqual(res.propagatedTo, [list[2].id]);
  });

  test('convertAssessmentToTeam ignores a stray override flag on an individual entry', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const list = ['01', '02', '03'].map((n) => addStudent(c, `Student ${n}`, 'X', { teamId: t.id }));
    setScore(c, list[0], 'a_t1', 90);
    setScore(c, list[1], 'a_t1', 70, { override: true }); // meaningless on an individual item
    setScore(c, list[2], 'a_t1', 70);
    const res = model.convertAssessmentToTeam(c, 'a_t1');
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_t1').value, 70, 'the majority (70) is the team score');
    assert.deepEqual(shown(c, list, 'a_t1'), ['90*', '70', '70']);
    assert.equal(res.overridesCreated, 1);
  });
});

describe('letter scale invariant: the lowest cutoff is 0, F unless the scale names its own (review F7 / F4, V2)', () => {
  test('a scale without an F row gets F 0 appended, and a low total gets F', () => {
    const c = model.normalizeCourse({ settings: { letterScale: [{ letter: 'A', min: 90 }, { letter: 'B', min: 80 }] } });
    assert.deepEqual(c.settings.letterScale, [{ letter: 'A', min: 90 }, { letter: 'B', min: 80 }, { letter: 'F', min: 0 }]);
    assert.equal(calc.letterFor(10, c.settings.letterScale), 'F');
    assert.equal(calc.letterFor(85, c.settings.letterScale), 'B');
  });

  test('a bottom F above 0 is moved to 0; a bottom row at 0 is kept', () => {
    assert.deepEqual(model.normalizeLetterScale([{ letter: 'A', min: 90 }, { letter: 'F', min: 50 }]),
      [{ letter: 'A', min: 90 }, { letter: 'F', min: 0 }]);
    assert.deepEqual(model.normalizeLetterScale([{ letter: 'A', min: 90 }, { letter: 'D-', min: 60 }]),
      [{ letter: 'A', min: 90 }, { letter: 'D-', min: 60 }, { letter: 'F', min: 0 }]);
    assert.deepEqual(model.normalizeLetterScale([{ letter: 'Pass', min: 50 }, { letter: 'Fail', min: 0 }]),
      [{ letter: 'Pass', min: 50 }, { letter: 'Fail', min: 0 }]);
    assert.deepEqual(model.normalizeLetterScale([], 'graduate'), GRAD_SCALE);
  });

  test('rows with a negative cutoff are dropped, so the lowest cutoff is 0 (third review V2)', () => {
    const s1 = model.normalizeLetterScale([{ letter: 'A', min: 90 }, { letter: 'D', min: -10 }]);
    assert.deepEqual(s1, [{ letter: 'A', min: 90 }, { letter: 'F', min: 0 }]);
    assert.equal(calc.letterFor(5, s1), 'F');
    assert.deepEqual(model.normalizeLetterScale([{ letter: 'A', min: 90 }, { letter: 'D', min: 60 }, { letter: 'F', min: -10 }]),
      [{ letter: 'A', min: 90 }, { letter: 'D', min: 60 }, { letter: 'F', min: 0 }]);
    assert.deepEqual(model.normalizeLetterScale([{ letter: 'D', min: -1 }], 'graduate'), GRAD_SCALE);
    const z = model.normalizeLetterScale([{ letter: 'A', min: 90 }, { letter: 'F', min: -0 }]);
    assert.ok(Object.is(z[1].min, 0), '-0 is stored as 0');
    const c = model.normalizeCourse({ settings: { letterScale: [{ letter: 'A', min: 90 }, { letter: 'D', min: -10 }] } });
    assert.deepEqual(c.settings.letterScale, [{ letter: 'A', min: 90 }, { letter: 'F', min: 0 }]);
    assert.equal(calc.studentResult(c, addStudent(c, 'Student 01', 'X')).letter, 'F');
  });

  test('every normalized scale is descending with its lowest cutoff at 0', () => {
    const inputs = [
      UG_SCALE, GRAD_SCALE, [], null, [{ letter: 'A', min: 90 }], [{ letter: 'F', min: 30 }],
      [{ letter: 'A', min: 90 }, { letter: 'D', min: -10 }], [{ letter: 'B', min: -5 }, { letter: 'A', min: -1 }],
      [{ letter: 'Pass', min: 50 }, { letter: 'Fail', min: 0 }], [{ letter: 'A', min: 1e7 }, { letter: 'B', min: NaN }]
    ];
    inputs.forEach((list) => {
      const scale = model.normalizeLetterScale(list);
      const tag = JSON.stringify(list);
      assert.ok(scale.length >= 1, tag);
      assert.equal(scale[scale.length - 1].min, 0, tag);
      scale.forEach((row, i) => {
        assert.ok(row.min >= 0, tag);
        if (i > 0) assert.ok(scale[i - 1].min >= row.min, tag);
      });
    });
  });

  test('passingLetter falls back to a letter that exists in the scale', () => {
    const c = model.normalizeCourse({ settings: { letterScale: [{ letter: 'A', min: 90 }, { letter: 'B', min: 80 }] } });
    assert.equal(c.settings.passingLetter, 'B'); // lowest letter above F; the default D- is not in this scale
    const g = model.normalizeCourse({ level: 'graduate', settings: { passingLetter: 'Q' } });
    assert.equal(g.settings.passingLetter, 'C');
    const k = model.normalizeCourse({ settings: { letterScale: UG_SCALE, passingLetter: 'C-' } });
    assert.equal(k.settings.passingLetter, 'C-');
  });
});

describe('negative or zero weights, max scores and late points (review F8)', () => {
  test('createAssessment keeps weight >= 0 and max score > 0', () => {
    const a = model.createAssessment({ name: 'X', weight: -10, maxScore: -100 });
    assert.equal(a.weight, 0);
    assert.equal(a.maxScore, 100);
    assert.equal(model.createAssessment({ maxScore: 0 }).maxScore, 100);
    assert.equal(model.createAssessment({ maxScore: 30, weight: 12.5 }).maxScore, 30);
    assert.equal(model.createAssessment({ maxScore: 30, weight: 12.5 }).weight, 12.5);
  });

  test('normalizeCourse repairs negative weights, max scores and points per week', () => {
    const c = model.normalizeCourse({
      assessments: [{ id: 'a_x', name: 'X', weight: -10, maxScore: -5 }, { id: 'a_y', name: 'Y', weight: 1e308, maxScore: 1e308 }],
      settings: { latePointsPerWeek: -10, curve: 1e308 }
    });
    assert.deepEqual(c.assessments.map((a) => [a.weight, a.maxScore]), [[0, 100], [0, 100]]);
    assert.equal(c.settings.latePointsPerWeek, 0);
    assert.equal(c.settings.curve, 0);
  });
});

describe('placeholder notes and scoping (review F5, second review)', () => {
  test('custom-course notes do not quote a syllabus', () => {
    const c = course('custom');
    ['lateWork', 'projectSplit'].forEach((k) => {
      assert.ok(!/syllabus says|^syllabus:/i.test(model.placeholderInfo(c, k).note), `${k}: ${model.placeholderInfo(c, k).note}`);
    });
    assert.match(model.placeholderInfo(course('SE4351'), 'lateWork').note, /pre-approval/);
    assert.match(model.placeholderInfo(course('SE6362'), 'projectSplit').note, /approx\. 10 \+ 20/);
  });

  test('termPaperWeight applies while the course has the Term Paper item', () => {
    const g = course('SE6362');
    g.assessments = g.assessments.filter((a) => a.id !== 'a_paper');
    assert.ok(!model.placeholderKeys(g).includes('termPaperWeight'));
    const u = course('SE4351');
    u.assessments.push(model.createAssessment({ id: 'a_paper', name: 'Term Paper', category: 'paper' }));
    assert.ok(model.placeholderKeys(u).includes('termPaperWeight'));
  });

  test('projectSplit applies to every course', () => {
    ['SE4351', 'SE6362', 'custom'].forEach((tpl) => assert.ok(model.placeholderKeys(course(tpl)).includes('projectSplit'), tpl));
  });
});

describe('restore requires the Grade Tracker marker (review F6, second review)', () => {
  test('a bare object with a courses array but no "app" is rejected', () => {
    assert.throws(() => model.readBackup({ courses: [{ title: 'x' }] }), /Not a Grade Tracker data file/);
    assert.throws(() => model.normalizeState({ courses: [] }), /marker is missing/);
  });

  test('a wrapped backup whose inner state lacks "app" is still accepted (the envelope has it)', () => {
    const st = roundTrip(model.createDefaultState());
    delete st.app;
    const r = model.readBackup({ app: 'grade-tracker', kind: 'backup', schemaVersion: 1, exportedAt: '2026-09-28T12:00:00.000Z', state: st });
    assert.equal(r.state.courses.length, 2);
  });
});

describe('override and late helpers (review F9)', () => {
  function setup() {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    return { c, t, a, b };
  }
  const det = (c, s) => calc.scoreDetail(c, s, byName(c, 'a_p1'));

  test('entryFromInput: clearing an override cell drops the override flag (member follows the team)', () => {
    const e = model.entryFromInput('', { value: 85, override: true });
    assert.deepEqual(e, { value: null });
    assert.ok(model.isBlankEntry(e));
    assert.deepEqual(model.entryFromInput('', { value: 85, override: true, weeksLate: 1 }), { value: null, weeksLate: 1 });
  });

  test('setTeamScore, setOverride and clearOverride', () => {
    const { c, t, a, b } = setup();
    model.setTeamScore(c, t.id, 'a_p1', { value: 90, override: true });
    assert.deepEqual(model.getEntry(c.teamScores, t.id, 'a_p1'), { value: 90 });
    model.setOverride(c, b.id, 'a_p1', { value: 80 });
    assert.equal(det(c, b).raw, 80);
    assert.equal(det(c, b).source, 'override');
    assert.equal(det(c, a).raw, 90);
    assert.equal(model.clearOverride(c, b.id, 'a_p1'), true);
    assert.equal(model.clearOverride(c, b.id, 'a_p1'), false);
    assert.equal(det(c, b).raw, 90);
    assert.equal(det(c, b).source, 'team');
    model.setOverride(c, b.id, 'a_p1', null); // explicit "no score" override
    assert.equal(det(c, b).state, 'empty');
    assert.equal(det(c, b).source, 'override');
    model.setTeamScore(c, t.id, 'a_p1', { value: null });
    assert.equal(model.getEntry(c.teamScores, t.id, 'a_p1'), null);
  });

  test('withLate sets and clears weeks late and the waived flag', () => {
    assert.deepEqual(model.withLate({ value: 90 }, 2, false), { value: 90, weeksLate: 2 });
    assert.deepEqual(model.withLate({ value: 90, weeksLate: 2 }, 0, true), { value: 90, waived: true });
    assert.deepEqual(model.withLate(null, 1), { value: null, weeksLate: 1 });
    const src = { value: 70, override: true };
    assert.deepEqual(model.withLate(src, 1, true), { value: 70, override: true, weeksLate: 1, waived: true });
    assert.deepEqual(src, { value: 70, override: true }, 'input is not mutated');
  });

  test('removeAssessment deletes the item and every score for it', () => {
    const { c, t, a, b } = setup();
    setTeamScore(c, t, 'a_p1', 90);
    setScore(c, b, 'a_p1', 80, { override: true });
    setScore(c, a, 'a_t1', 70);
    assert.equal(model.removeAssessment(c, 'a_p1'), true);
    assert.equal(model.findAssessment(c, 'a_p1'), null);
    assert.deepEqual(c.teamScores, {});
    assert.deepEqual(c.scores, { [a.id]: { a_t1: { value: 70 } } });
    assert.equal(model.removeAssessment(c, 'a_p1'), false);
  });

  test('removeTeam moves members to no team and deletes the team scores', () => {
    const { c, t, a, b } = setup();
    setTeamScore(c, t, 'a_p1', 90);
    setScore(c, b, 'a_p1', 80, { override: true });
    const moved = model.removeTeam(c, t.id, { keepScores: true });
    assert.deepEqual(sorted(moved), sorted([a.id, b.id]));
    assert.deepEqual(c.teams, []);
    assert.deepEqual(c.teamScores, {});
    assert.equal(a.teamId, null);
    assert.equal(det(c, a).raw, 90);
    assert.equal(det(c, a).source, 'individual');
    assert.equal(det(c, b).raw, 80);
    assert.equal(model.getEntry(c.scores, b.id, 'a_p1').override, undefined);
  });

  test('removeTeam without keepScores leaves the former members without team-graded scores', () => {
    const { c, t, a, b } = setup();
    setTeamScore(c, t, 'a_p1', 90);
    setScore(c, b, 'a_p1', 80, { override: true });
    model.removeTeam(c, t.id);
    assert.equal(det(c, a).state, 'empty');
    assert.equal(det(c, b).state, 'empty');
    assert.deepEqual(model.removeTeam(c, 't_missing'), []);
  });
});

test('convertAssessmentToIndividual is a no-op on an assessment that is already individual', () => {
  const model = require('../js/core/model.js');
  const calc = require('../js/core/calc.js');
  const c = model.createCourse('SE4351');
  const t = model.createTeam('Team 1');
  c.teams.push(t);
  const s1 = model.createStudent({ no: 1, lastName: 'Student 01', firstName: 'Alpha', teamId: t.id });
  const s2 = model.createStudent({ no: 2, lastName: 'Student 02', firstName: 'Bravo', teamId: t.id });
  c.students.push(s1, s2);
  model.setEntry(c.scores, s1.id, 'a_t1', { value: 81 });
  model.setEntry(c.scores, s2.id, 'a_t1', { value: 67 });
  const a = model.findAssessment(c, 'a_t1');
  model.convertAssessmentToIndividual(c, 'a_t1');
  assert.equal(calc.scoreDetail(c, s1, a).raw, 81);
  assert.equal(calc.scoreDetail(c, s2, a).raw, 67);
  assert.equal(a.teamGraded, false);
});

test('normalizeState keeps per-view preference objects in ui', () => {
  const model = require('../js/core/model.js');
  const st = model.createDefaultState();
  st.ui.gridPrefs = { sort: 'total', dir: 'desc', cols: { weighted: false } };
  st.ui.bogus = { x: 1 };
  const n = model.normalizeState(JSON.parse(JSON.stringify(st)));
  assert.deepEqual(n.ui.gridPrefs, { sort: 'total', dir: 'desc', cols: { weighted: false } });
  assert.equal(n.ui.bogus, undefined);
});

describe('stage 2 model helpers', () => {
  const model = require('../js/core/model.js');
  test('splitAssessment keeps scores on part 1 and adds empty parts that sum to the original weight', () => {
    const c = model.createCourse('SE4351');
    const s = model.createStudent({ no: 1, lastName: 'Student 01', firstName: 'Alpha' });
    c.students.push(s);
    model.setEntry(c.scores, s.id, 'a_p1', { value: 90 });
    const ids = model.splitAssessment(c, 'a_p1', [{ name: 'Questionnaire I', weight: 2.5 }, { name: 'Project I deliverable', weight: 7.5 }]);
    assert.equal(ids.length, 1);
    assert.equal(c.assessments[0].id, 'a_p1');
    assert.equal(c.assessments[0].name, 'Questionnaire I');
    assert.equal(c.assessments[0].weight, 2.5);
    assert.equal(c.assessments[1].name, 'Project I deliverable');
    assert.equal(c.assessments[1].weight, 7.5);
    assert.equal(c.assessments[1].teamGraded, true);
    assert.equal(model.getEntry(c.scores, s.id, 'a_p1').value, 90);
    assert.throws(() => model.splitAssessment(c, 'a_p2', [{ name: 'A', weight: 5 }, { name: 'B', weight: 5 }]), /add up to 10/);
    assert.throws(() => model.splitAssessment(c, 'a_p2', [{ name: 'A', weight: 20 }]), /two parts/);
  });
  test('moveAssessment swaps neighbours and refuses to move past the ends', () => {
    const c = model.createCourse('SE4351');
    assert.equal(model.moveAssessment(c, 'a_p2', -1), true);
    assert.deepEqual(c.assessments.map((a) => a.id).slice(0, 2), ['a_p2', 'a_p1']);
    assert.equal(model.moveAssessment(c, 'a_p2', -1), false);
  });
  test('renumberByName numbers students in name order, withdrawn included', () => {
    const c = model.createCourse('SE4351');
    c.students.push(model.createStudent({ no: 7, lastName: 'Student 10', firstName: 'Kilo' }));
    c.students.push(model.createStudent({ no: 3, lastName: 'Student 2', firstName: 'Bravo', status: 'withdrawn' }));
    c.students.push(model.createStudent({ no: 9, lastName: 'student 2', firstName: 'Alpha' }));
    model.renumberByName(c);
    assert.deepEqual(c.students.map((s) => s.no), [3, 2, 1]);
  });
  test('deleteStudent removes the student, scores and attendance', () => {
    const c = model.createCourse('SE4351');
    const s = model.createStudent({ no: 1, lastName: 'Student 01', firstName: 'Alpha' });
    c.students.push(s);
    model.setEntry(c.scores, s.id, 'a_t1', { value: 70 });
    c.attendance.records[s.id] = { ses_20260903: 'A' };
    c.attendance.totals[s.id] = { absent: 1, excused: 0 };
    assert.equal(model.deleteStudent(c, s.id), true);
    assert.equal(c.students.length, 0);
    assert.equal(c.scores[s.id], undefined);
    assert.equal(c.attendance.records[s.id], undefined);
    assert.equal(c.attendance.totals[s.id], undefined);
    assert.equal(model.deleteStudent(c, s.id), false);
  });
});
