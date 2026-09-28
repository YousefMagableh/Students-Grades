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

  test('to team: every student sees the same value before and after', () => {
    const { c } = setup();
    const before = visibleAll(c, 'a_t1');
    model.convertAssessmentToTeam(c, 'a_t1');
    assert.equal(byName(c, 'a_t1').teamGraded, true);
    assert.deepEqual(visibleAll(c, 'a_t1'), before);
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

  test('to individual after to team: every student sees the same value, no overrides, team entries gone', () => {
    const { c } = setup();
    const before = visibleAll(c, 'a_t1');
    model.convertAssessmentToTeam(c, 'a_t1');
    model.convertAssessmentToIndividual(c, 'a_t1');
    assert.equal(byName(c, 'a_t1').teamGraded, false);
    assert.deepEqual(visibleAll(c, 'a_t1'), before);
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

  test('without keepScores an existing override is kept', () => {
    const { c, t2, s } = setup();
    setScore(c, s, 'a_p1', 80, { override: true });
    model.moveStudentToTeam(c, s.id, t2.id);
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
