'use strict';
/* Spec-derived tests for js/core/attendance.js (STAGE3 section 1, DESIGN.md section 7; REQUIREMENTS T1-T6, X7;
 * DECISIONS 3 and 6). Mandatory (the user listed them): consecutive-absence detection and per-session
 * attendance rates. Fake data only. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../js/core/util.js');
const model = require('../js/core/model.js');
const history = require('../js/core/history.js');
const sample = require('../js/core/sample.js');
const calc = require('../js/core/calc.js');
const att = require('../js/core/attendance.js');

// ---------------------------------------------------------------- helpers

const NATO = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];

/** A per-session course with `students` students (ids s_0, s_1, ...; "Student 01, Alpha", ...) and the
 * first `sessions` Tuesday/Thursday sessions from 2026-09-01. Default settings (excused do not count). */
function makeCourse(opts) {
  const o = Object.assign({ students: 3, sessions: 10, mode: 'per-session' }, opts || {});
  const c = model.createCourse('custom');
  c.attendance.mode = o.mode;
  c.attendance.sessions = model.generateSessions({ start: '2026-09-01', end: '2026-12-31', weekdays: [2, 4] }).slice(0, o.sessions);
  for (let i = 0; i < o.students; i++) {
    c.students.push(model.createStudent({ id: 's_' + i, no: i + 1, lastName: 'Student 0' + (i + 1), firstName: NATO[i] }));
  }
  return c;
}

/** Writes marks from a pattern: character k is session k ('P', 'A', 'E'; '.' = no mark). */
function marks(c, sid, pattern) {
  [...pattern].forEach((ch, k) => {
    if (ch !== '.') model.setEntry(c.attendance.records, sid, c.attendance.sessions[k].id, ch);
  });
}

/** Marks every student of the course present in the first n sessions (so they are held). */
function holdSessions(c, n, exceptSid) {
  c.students.forEach((s) => {
    if (s.id === exceptSid) return;
    marks(c, s.id, 'P'.repeat(n));
  });
}

const ses = (c, k) => c.attendance.sessions[k];
const pick = (sm, keys) => Object.fromEntries(keys.map((k) => [k, sm[k]]));

// ================================================================ templates and modes

describe('templates and modes (T1, T2)', () => {
  test('the Fall 2026 TR template gives 26 sessions (2026-09-03 to 2026-12-08, no Nov 24 or 26)', () => {
    const sessions = model.createCourse('SE4351').attendance.sessions;
    assert.equal(sessions.length, 26);
    assert.equal(sessions[0].date, '2026-09-03');
    assert.equal(sessions[25].date, '2026-12-08');
    const dates = sessions.map((s) => s.date);
    assert.ok(!dates.includes('2026-11-24') && !dates.includes('2026-11-26'));
    dates.forEach((d) => assert.ok([2, 4].includes(util.weekday(d)), d));
    assert.equal(model.createCourse('SE4351').attendance.mode, 'per-session');
  });

  test('off mode: summary is null, courseSummary is empty (SE 6362 starts off)', () => {
    const c = model.createCourse('SE6362');
    assert.equal(c.attendance.mode, 'off');
    c.students.push(model.createStudent({ id: 's_x', lastName: 'Student 01', firstName: 'Alpha' }));
    marks(c, 's_x', 'AAAA');
    assert.equal(att.summary(c, 's_x'), null);
    const cs = att.courseSummary(c);
    assert.deepEqual(cs, { mode: 'off', held: 0, total: 26, byStudent: {}, warnings: [] });
  });

  test('a course without attendance data, or with an unknown mode, reads as off', () => {
    assert.equal(att.summary({ students: [] }, 's_0'), null);
    assert.equal(att.summary(null, 's_0'), null);
    const c = makeCourse();
    c.attendance.mode = 'weekly';
    assert.equal(att.summary(c, 's_0'), null);
    assert.equal(att.courseSummary(c).mode, 'off');
    assert.deepEqual(att.heldSessions({}), []);
  });

  test('switching the mode keeps records and totals; switching back shows the same numbers', () => {
    const c = makeCourse();
    marks(c, 's_0', 'PAAAP');
    c.attendance.totals.s_0 = { absent: 2, excused: 1 };
    c.attendance.totalsSessionsHeld = 12;
    const before = att.summary(c, 's_0');
    assert.equal(att.setMode(c, 'totals'), true);
    assert.equal(att.summary(c, 's_0').mode, 'totals');
    assert.equal(att.setMode(c, 'off'), true);
    assert.equal(att.summary(c, 's_0'), null);
    assert.equal(att.setMode(c, 'per-session'), true);
    assert.equal(att.setMode(c, 'per-session'), false, 'no change');
    assert.deepEqual(att.summary(c, 's_0'), before);
    assert.deepEqual(c.attendance.totals.s_0, { absent: 2, excused: 1 });
    assert.throws(() => att.setMode(c, 'weekly'), /Unknown attendance mode/);
  });
});

// ================================================================ held sessions and per-session rates

describe('held sessions and per-session rates (T3)', () => {
  test('mandatory: 26 sessions, 20 held, 18 P + 1 A + 1 E gives recorded 20, total 2, unexcused 1, rates 10% and 5%', () => {
    const c = makeCourse({ students: 2, sessions: 26 });
    assert.equal(c.attendance.sessions.length, 26);
    marks(c, 's_0', 'PPPPPAPPPPPPEPPPPPPP');     // 20 marks: 18 P, 1 A, 1 E
    marks(c, 's_1', 'PPPPPPPPPPPPPPPPPPPP');
    assert.equal(att.heldSessions(c).length, 20);
    const sm = att.summary(c, 's_0');
    assert.deepEqual(pick(sm, ['mode', 'held', 'recorded', 'unmarked', 'present', 'absent', 'excused', 'totalAbsences', 'unexcused', 'absenceRate', 'unexcusedRate']), {
      mode: 'per-session', held: 20, recorded: 20, unmarked: 0, present: 18, absent: 1, excused: 1,
      totalAbsences: 2, unexcused: 1, absenceRate: 10, unexcusedRate: 5
    });
    assert.equal(att.courseSummary(c).held, 20);
    assert.equal(att.courseSummary(c).total, 26);
  });

  test('rates are percentages of the student\'s recorded sessions, and null when nothing is recorded', () => {
    const c = makeCourse({ students: 2, sessions: 6 });
    marks(c, 's_0', 'PAP');
    marks(c, 's_1', 'PPPPPP');
    const sm = att.summary(c, 's_0');
    assert.equal(sm.held, 6);
    assert.equal(sm.recorded, 3);
    assert.equal(sm.unmarked, 3);
    assert.equal(sm.absenceRate, util.fix(100 / 3));
    assert.equal(sm.unexcusedRate, util.fix(100 / 3));
    const none = att.summary(makeCourse(), 's_0');
    assert.equal(none.recorded, 0);
    assert.equal(none.absenceRate, null);
    assert.equal(none.unexcusedRate, null);
    assert.equal(none.longestStreak, 0);
    assert.equal(none.currentStreak, 0);
    assert.deepEqual(none.streaks, []);
    assert.equal(none.warning, null);
  });

  test('a session nobody marked is not held and not counted; a withdrawn student\'s mark makes it held', () => {
    const c = makeCourse({ students: 2, sessions: 5 });
    marks(c, 's_0', 'P.P');
    c.students[1].status = 'withdrawn';
    assert.deepEqual(att.heldSessions(c).map((s) => s.id), [ses(c, 0).id, ses(c, 2).id]);
    marks(c, 's_1', '...A');
    assert.deepEqual(att.heldSessions(c).map((s) => s.id), [ses(c, 0).id, ses(c, 2).id, ses(c, 3).id]);
    const sm = att.summary(c, 's_0');
    assert.equal(sm.held, 3);
    assert.equal(sm.recorded, 2);
  });

  test('marks of ids that are not students of the course, and invalid marks, are ignored', () => {
    const c = makeCourse({ students: 1, sessions: 4 });
    c.attendance.records.s_gone = { [ses(c, 0).id]: 'A' };
    c.attendance.records.s_0 = { [ses(c, 1).id]: 'X', [ses(c, 2).id]: 'A', ses_unknown: 'A' };
    c.attendance.records.s_bad = 'junk';
    assert.deepEqual(att.heldSessions(c).map((s) => s.id), [ses(c, 2).id]);
    const sm = att.summary(c, 's_0');
    assert.equal(sm.recorded, 1);
    assert.equal(sm.absent, 1);
  });

  test('heldSessions is in date order even when the stored list is not', () => {
    const c = makeCourse({ students: 1, sessions: 3 });
    marks(c, 's_0', 'PAP');
    c.attendance.sessions.reverse();
    assert.deepEqual(att.heldSessions(c).map((s) => s.date), ['2026-09-01', '2026-09-03', '2026-09-08']);
  });

  test('totals mode: counts from totals, recorded = sessions held so far; rates use it; streaks n/a', () => {
    const c = makeCourse({ mode: 'totals' });
    marks(c, 's_0', 'AAAA'); // per-session marks are ignored in totals mode
    c.attendance.totals.s_0 = { absent: 2, excused: 1 };
    c.attendance.totalsSessionsHeld = 20;
    const sm = att.summary(c, 's_0');
    assert.deepEqual(sm, {
      mode: 'totals', held: 20, recorded: 20, unmarked: 0, present: 17, absent: 2, excused: 1, totalAbsences: 3, unexcused: 2,
      absenceRate: 15, unexcusedRate: 10, longestStreak: null, currentStreak: null, streaks: [], streaksAvailable: false,
      excusedCountsTowardStreak: false, warning: null, overThreshold: false, overTotalThreshold: false, moreAbsencesThanSessions: false
    });
    // No row: zeros. No sessions held: rates null.
    assert.equal(att.summary(c, 's_1').totalAbsences, 0);
    c.attendance.totalsSessionsHeld = 0;
    const z = att.summary(c, 's_0');
    assert.equal(z.absenceRate, null);
    assert.equal(z.unexcusedRate, null);
    assert.equal(z.moreAbsencesThanSessions, true, 'more absences than sessions held is flagged');
    assert.equal(att.courseSummary(c).held, 0);
    assert.deepEqual(att.courseSummary(c).warnings, []);
  });

  test('totals mode: the thresholds work the same way, streak warnings never appear', () => {
    const c = makeCourse({ mode: 'totals' });
    c.attendance.totalsSessionsHeld = 20;
    c.attendance.totals.s_0 = { absent: 4, excused: 0 };
    c.attendance.totals.s_1 = { absent: 1, excused: 5 };
    c.attendance.totalAbsenceThreshold = 5;
    const cs = att.courseSummary(c);
    assert.equal(cs.held, 20);
    assert.deepEqual(cs.warnings.map((w) => [w.studentId, w.kind]), [['s_0', 'threshold'], ['s_1', 'total-threshold']]);
  });

  test('sessionCounts counts active students only (P / A / E / unmarked)', () => {
    const c = makeCourse({ students: 5, sessions: 2 });
    marks(c, 's_0', 'P');
    marks(c, 's_1', 'A');
    marks(c, 's_2', 'E');
    marks(c, 's_3', 'A');
    c.students[3].status = 'withdrawn';
    assert.deepEqual(att.sessionCounts(c, ses(c, 0).id), { present: 1, absent: 1, excused: 1, unmarked: 1, marked: 3, presentRate: util.fix(100 / 3) });
    assert.deepEqual(att.sessionCounts(c, ses(c, 1).id), { present: 0, absent: 0, excused: 0, unmarked: 4, marked: 0, presentRate: null });
    assert.equal(att.markCount(c, ses(c, 0).id), 4, 'markCount includes withdrawn students');
  });

  test('markLabel, parseMark, cycleMark', () => {
    assert.equal(att.markLabel('P'), 'Present');
    assert.equal(att.markLabel('A'), 'Absent');
    assert.equal(att.markLabel('E'), 'Excused');
    for (const x of ['', 'X', 'p', null, undefined, 3, 'toString']) assert.equal(att.markLabel(x), '');
    assert.deepEqual(att.parseMark(' p '), { kind: 'mark', mark: 'P' });
    assert.deepEqual(att.parseMark('Absent'), { kind: 'mark', mark: 'A' });
    assert.deepEqual(att.parseMark('e'), { kind: 'mark', mark: 'E' });
    assert.deepEqual(att.parseMark(''), { kind: 'empty' });
    assert.deepEqual(att.parseMark(null), { kind: 'empty' });
    assert.deepEqual(att.parseMark('x'), { kind: 'invalid', text: 'x' });
    assert.deepEqual(att.parseMark('toString'), { kind: 'invalid', text: 'toString' });
    assert.deepEqual([null, 'P', 'A', 'E'].map(att.cycleMark), ['P', 'A', 'E', null]);
  });
});

// ================================================================ consecutive absences (T5)

describe('consecutive-absence detection (T5, DECISIONS 6)', () => {
  function streakOf(pattern, countE) {
    const c = makeCourse({ students: 1, sessions: pattern.length });
    c.attendance.excusedCountsTowardStreak = !!countE;
    marks(c, 's_0', pattern);
    return att.summary(c, 's_0');
  }

  test('mandatory: a run of 3 unexcused absences gives "drop", a run of 4 gives "fail"', () => {
    const three = streakOf('PAAAP');
    assert.equal(three.longestStreak, 3);
    assert.equal(three.warning, 'drop');
    assert.deepEqual(three.streaks, [{
      startDate: '2026-09-03', endDate: '2026-09-10', length: 3,
      sessionIds: ['ses_20260903', 'ses_20260908', 'ses_20260910'], dates: ['2026-09-03', '2026-09-08', '2026-09-10']
    }]);
    const four = streakOf('PAAAAP');
    assert.equal(four.longestStreak, 4);
    assert.equal(four.warning, 'fail');
    assert.equal(streakOf('AAAAAAA').warning, 'fail', 'longer runs still fail');
    assert.equal(streakOf('AAPAAPAP').warning, null, 'runs of 2 give no warning');
    assert.equal(streakOf('AAPAAPAP').longestStreak, 2);
  });

  test('streaks lists runs of 2 or more, oldest first; longestStreak counts single absences too', () => {
    const sm = streakOf('APAAPAAAPA');
    assert.deepEqual(sm.streaks.map((r) => [r.startDate, r.length]), [['2026-09-08', 2], ['2026-09-17', 3]]);
    assert.equal(sm.longestStreak, 3);
    assert.equal(streakOf('PAP').longestStreak, 1);
    assert.deepEqual(streakOf('PAP').streaks, []);
  });

  test('default (excused do NOT count): an E inside a run breaks it; E alone never makes a streak', () => {
    assert.equal(model.createCourse('SE4351').attendance.excusedCountsTowardStreak, false);
    const sm = streakOf('AEA');
    assert.equal(sm.longestStreak, 1);
    assert.equal(sm.warning, null);
    assert.equal(sm.excused, 1, 'the excused absence is still counted as an absence');
    assert.equal(sm.totalAbsences, 3);
    assert.equal(streakOf('AAEAA').longestStreak, 2);
    assert.equal(streakOf('AAEAA').warning, null);
    assert.equal(streakOf('EEEE').longestStreak, 0);
    assert.equal(streakOf('EEEE').warning, null);
  });

  test('excusedCountsTowardStreak = true: the E counts toward the run', () => {
    const sm = streakOf('AEA', true);
    assert.equal(sm.longestStreak, 3);
    assert.equal(sm.warning, 'drop');
    assert.equal(sm.excusedCountsTowardStreak, true);
    assert.equal(streakOf('AAEAA', true).longestStreak, 5);
    assert.equal(streakOf('AAEAA', true).warning, 'fail');
    assert.equal(streakOf('EEEE', true).warning, 'fail');
    // Counts and rates do not depend on the setting.
    assert.deepEqual(pick(streakOf('AEA', true), ['absent', 'excused', 'totalAbsences', 'unexcused', 'absenceRate']),
      pick(streakOf('AEA'), ['absent', 'excused', 'totalAbsences', 'unexcused', 'absenceRate']));
  });

  test('data saved before stage 3 (schema 1, true stored as the old default) loads with excused NOT counting (review S3-SPEC-2 / R3-C3)', () => {
    const st = JSON.parse(JSON.stringify(model.createDefaultState()));
    st.schemaVersion = 1;
    const raw = st.courses[0];
    raw.attendance.excusedCountsTowardStreak = true;
    raw.students.push(model.createStudent({ id: 's_0', lastName: 'Student 01', firstName: 'Alpha' }));
    raw.students.push(model.createStudent({ id: 's_1', lastName: 'Student 02', firstName: 'Bravo' }));
    marks(raw, 's_0', 'PAEAE');
    marks(raw, 's_1', 'PEEEE');
    for (const load of [(x) => model.normalizeState(x), (x) => model.readBackup({ app: 'grade-tracker', kind: 'backup', schemaVersion: 1, state: x }).state]) {
      const c = load(JSON.parse(JSON.stringify(st))).courses[0];
      assert.equal(c.attendance.excusedCountsTowardStreak, false);
      const mixed = att.summary(c, 's_0');
      assert.deepEqual(pick(mixed, ['longestStreak', 'warning', 'unexcused', 'excused']), { longestStreak: 1, warning: null, unexcused: 2, excused: 2 });
      const allowed = att.summary(c, 's_1');
      assert.deepEqual(pick(allowed, ['longestStreak', 'warning', 'unexcused', 'excused']), { longestStreak: 0, warning: null, unexcused: 0, excused: 4 });
      assert.deepEqual(att.courseSummary(c).warnings, []);
    }
  });

  test('a session nobody marked is skipped: it does not break the run and is not counted', () => {
    const c = makeCourse({ students: 2, sessions: 6 });
    marks(c, 's_0', 'AA.A');
    marks(c, 's_1', 'PP.P');
    const sm = att.summary(c, 's_0');
    assert.equal(sm.held, 3);
    assert.equal(sm.recorded, 3);
    assert.equal(sm.longestStreak, 3);
    assert.equal(sm.warning, 'drop');
    assert.deepEqual(sm.streaks[0].sessionIds, [ses(c, 0).id, ses(c, 1).id, ses(c, 3).id]);
  });

  test('a held session where this student has no mark breaks the run and is not counted', () => {
    const c = makeCourse({ students: 2, sessions: 6 });
    marks(c, 's_0', 'AA.AA');
    marks(c, 's_1', 'PPPPP');
    const sm = att.summary(c, 's_0');
    assert.equal(sm.held, 5);
    assert.equal(sm.recorded, 4);
    assert.equal(sm.unmarked, 1);
    assert.equal(sm.absenceRate, 100);
    assert.equal(sm.longestStreak, 2);
    assert.equal(sm.warning, null);
  });

  test('present breaks the run; runs follow date order, not list order', () => {
    const c = makeCourse({ students: 1, sessions: 5 });
    marks(c, 's_0', 'AAPAA');
    c.attendance.sessions.reverse();
    const sm = att.summary(c, 's_0');
    assert.equal(sm.longestStreak, 2);
    assert.deepEqual(sm.streaks.map((r) => r.startDate), ['2026-09-01', '2026-09-10']);
  });

  test('currentStreak is the run ending at the latest recorded session (0 when that mark is no absence)', () => {
    assert.equal(streakOf('PAA').currentStreak, 2);
    assert.equal(streakOf('AAAP').currentStreak, 0);
    assert.equal(streakOf('AAAP').longestStreak, 3);
    assert.equal(streakOf('PAAE').currentStreak, 0, 'E ends it by default');
    assert.equal(streakOf('PAAE', true).currentStreak, 3);
    // Held sessions after the latest recorded one, where this student is unmarked, do not reset it.
    const c = makeCourse({ students: 2, sessions: 5 });
    marks(c, 's_0', 'PAA');
    marks(c, 's_1', 'PPPPP');
    assert.equal(att.summary(c, 's_0').currentStreak, 2);
  });

  test('custom drop/fail streak lengths', () => {
    const c = makeCourse({ students: 1, sessions: 8 });
    c.attendance.dropStreak = 2;
    c.attendance.failStreak = 5;
    marks(c, 's_0', 'AAPAAAA');
    assert.equal(att.summary(c, 's_0').warning, 'drop');
    marks(c, 's_0', '.......A');
    assert.equal(att.summary(c, 's_0').warning, 'fail');
  });

  test('warnings never change a grade (T5)', () => {
    const c = makeCourse({ students: 2, sessions: 6 });
    model.setEntry(c.scores, 's_0', 'a_t1', { value: 90 });
    const before = JSON.stringify(calc.computeCourse(c));
    marks(c, 's_0', 'AAAAAA');
    assert.equal(att.summary(c, 's_0').warning, 'fail');
    assert.equal(JSON.stringify(calc.computeCourse(c)), before);
  });
});

// ================================================================ thresholds (T4, DECISIONS 3)

describe('thresholds (T4, DECISIONS 3)', () => {
  test('overThreshold is strictly greater than the unexcused-absence threshold', () => {
    const c = makeCourse({ students: 3, sessions: 8 });
    c.attendance.unexcusedThreshold = 3;
    marks(c, 's_0', 'APAPAP');        // 3 unexcused
    marks(c, 's_1', 'APAPAPA');       // 4 unexcused
    marks(c, 's_2', 'EPEPEPEPE'.slice(0, 8)); // excused only
    assert.equal(att.summary(c, 's_0').overThreshold, false);
    assert.equal(att.summary(c, 's_1').overThreshold, true);
    assert.equal(att.summary(c, 's_2').overThreshold, false, 'excused (allowed) absences do not count');
    c.attendance.unexcusedThreshold = 0;
    assert.equal(att.summary(c, 's_0').overThreshold, true);
    assert.equal(att.summary(c, 's_2').overThreshold, false);
  });

  test('total-absence threshold: off (null) by default; strictly greater than; counts excused + unexcused', () => {
    const c = makeCourse({ students: 2, sessions: 10 });
    marks(c, 's_0', 'AEAEPPPP');      // 4 in total
    marks(c, 's_1', 'AEAEEPPP');      // 5 in total
    assert.equal(c.attendance.totalAbsenceThreshold, null);
    assert.equal(att.summary(c, 's_1').overTotalThreshold, false);
    c.attendance.totalAbsenceThreshold = 4;
    assert.equal(att.summary(c, 's_0').overTotalThreshold, false);
    assert.equal(att.summary(c, 's_1').overTotalThreshold, true);
    assert.equal(att.summary(c, 's_1').overThreshold, false, '2 unexcused: under the unexcused threshold');
  });
});

// ================================================================ course summary

describe('courseSummary', () => {
  test('warnings: active students only, sorted fail, drop, threshold, total-threshold, then name; byStudent has everyone', () => {
    const c = makeCourse({ students: 6, sessions: 10 });
    c.attendance.totalAbsenceThreshold = 5;
    marks(c, 's_0', 'PAAAPPPPPP');    // drop
    marks(c, 's_1', 'AAAAPAPAPP');    // fail + threshold (6 unexcused > 3) + total-threshold (6 > 5)
    marks(c, 's_2', 'PAAAPPPPPP');    // drop
    marks(c, 's_3', 'AAAAAPPPPP');    // fail, but withdrawn
    marks(c, 's_4', 'APAPAPAPPP');    // threshold (4 unexcused)
    marks(c, 's_5', 'EPEPEPEPEP');    // total-threshold only (5 excused... not > 5)
    c.students[3].status = 'withdrawn';
    // Name order differs from id order: rename so Student 03 sorts before Student 01 for the drops.
    c.students[2].lastName = 'Student 00';
    const cs = att.courseSummary(c);
    assert.equal(cs.mode, 'per-session');
    assert.equal(cs.held, 10);
    assert.equal(cs.total, 10);
    assert.deepEqual(Object.keys(cs.byStudent).sort(), ['s_0', 's_1', 's_2', 's_3', 's_4', 's_5']);
    assert.equal(cs.byStudent.s_3.warning, 'fail', 'withdrawn students still get a summary');
    assert.deepEqual(cs.warnings.map((w) => [w.studentId, w.kind]), [
      ['s_1', 'fail'], ['s_2', 'drop'], ['s_0', 'drop'], ['s_1', 'threshold'], ['s_4', 'threshold'], ['s_1', 'total-threshold']
    ]);
    const fail = cs.warnings[0];
    assert.equal(fail.detail, '4 consecutive absences: syllabus says F');
    assert.equal(fail.count, 4);
    assert.equal(fail.limit, 4);
    assert.deepEqual(fail.streak.dates, ['2026-09-01', '2026-09-03', '2026-09-08', '2026-09-10']);
    assert.equal(cs.warnings[1].detail, '3 consecutive absences: syllabus says one letter grade drop');
    assert.equal(cs.warnings[1].limit, 3);
    assert.equal(cs.warnings[3].detail, '6 unexcused absences: above the unexcused-absence threshold (3)');
    assert.equal(cs.warnings[3].streak, null);
    assert.equal(cs.warnings[5].detail, '6 absences in total (excused + unexcused): above the total-absence threshold (5)');
    c.attendance.excusedCountsTowardStreak = true;
    assert.ok(att.courseSummary(c).warnings.some((w) => w.studentId === 's_5' && w.kind === 'fail') === false, 'no run: E and P alternate');
  });

  test('a withdrawn student is excluded from sessionCounts and from warnings', () => {
    const c = makeCourse({ students: 2, sessions: 5 });
    marks(c, 's_0', 'AAAAA');
    marks(c, 's_1', 'PPPPP');
    c.students[0].status = 'withdrawn';
    assert.deepEqual(att.courseSummary(c).warnings, []);
    assert.deepEqual(att.sessionCounts(c, ses(c, 0).id), { present: 1, absent: 0, excused: 0, unmarked: 0, marked: 1, presentRate: 100 });
    c.students[0].status = 'active';
    assert.deepEqual(att.courseSummary(c).warnings.map((w) => w.kind), ['fail', 'threshold']);
  });

  test('totalsFromRecords counts A and E of held sessions per student', () => {
    const c = makeCourse({ students: 2, sessions: 5 });
    marks(c, 's_0', 'PAEA');
    marks(c, 's_1', 'P');
    assert.deepEqual(att.totalsFromRecords(c), { held: 4, totals: { s_0: { absent: 2, excused: 1 }, s_1: { absent: 0, excused: 0 } } });
  });
});

// ================================================================ sessions

describe('sessions: nearestSessionIndex, mergeSessions, add / update / remove', () => {
  test('nearestSessionIndex: the session on or after the date, else the last one', () => {
    const c = model.createCourse('SE4351');
    const dates = c.attendance.sessions.map((s) => s.date);
    assert.equal(att.nearestSessionIndex(c, '2026-08-20'), 0);
    assert.equal(att.nearestSessionIndex(c, '2026-09-03'), 0);
    assert.equal(att.nearestSessionIndex(c, '2026-09-04'), 1);
    assert.equal(dates[att.nearestSessionIndex(c, '2026-11-24')], '2026-12-01', 'Thanksgiving week is skipped');
    assert.equal(att.nearestSessionIndex(c, '2026-12-08'), 25);
    assert.equal(att.nearestSessionIndex(c, '2027-01-15'), 25);
    assert.equal(att.nearestSessionIndex(c, 'today'), -1);
    assert.equal(att.nearestSessionIndex(makeCourse({ sessions: 0 }), '2026-09-01'), -1);
  });

  test('mergeSessions keeps every existing session (id, label, marks), adds new dates, sorts, never drops', () => {
    const existing = [
      { id: 'ses_20260903', date: '2026-09-03', label: 'First day' },
      { id: 'ses_extra', date: '2026-09-05', label: 'Makeup' },          // not in the generated list
      { id: 'ses_20260908', date: '2026-09-09', label: '' }             // moved date, keeps its id
    ];
    const frozen = JSON.stringify(existing);
    const generated = model.generateSessions({ start: '2026-09-01', end: '2026-09-10', weekdays: [2, 4] });
    assert.deepEqual(generated.map((g) => g.date), ['2026-09-01', '2026-09-03', '2026-09-08', '2026-09-10']);
    const out = att.mergeSessions(existing, generated);
    assert.equal(JSON.stringify(existing), frozen, 'inputs are not changed');
    assert.notEqual(out, existing);
    assert.deepEqual(out, [
      { id: 'ses_20260901', date: '2026-09-01', label: '' },
      { id: 'ses_20260903', date: '2026-09-03', label: 'First day' },
      { id: 'ses_extra', date: '2026-09-05', label: 'Makeup' },
      { id: 'ses_20260908_2', date: '2026-09-08', label: '' },           // id taken by the moved session
      { id: 'ses_20260908', date: '2026-09-09', label: '' },
      { id: 'ses_20260910', date: '2026-09-10', label: '' }
    ]);
    // Merging again adds nothing; merging nothing keeps everything.
    assert.deepEqual(att.mergeSessions(out, generated), out);
    assert.deepEqual(att.mergeSessions(existing, []).map((s) => s.id), ['ses_20260903', 'ses_extra', 'ses_20260908']);
    assert.deepEqual(att.mergeSessions(null, generated).length, 4);
    assert.deepEqual(att.mergeSessions([], [{ date: 'bad' }, null, { date: '2026-09-01' }, { date: '2026-09-01' }]),
      [{ id: 'ses_20260901', date: '2026-09-01', label: '' }]);
  });

  test('mergeSessions on the template: marks survive a re-generate', () => {
    const c = model.createCourse('SE4351');
    c.students.push(model.createStudent({ id: 's_0', lastName: 'Student 01', firstName: 'Alpha' }));
    marks(c, 's_0', 'PAE');
    c.attendance.sessions.splice(5, 3);  // removed by hand
    const merged = att.mergeSessions(c.attendance.sessions, model.generateSessions(model.FALL_2026_TR));
    assert.equal(merged.length, 26);
    c.attendance.sessions = merged;
    assert.deepEqual(pick(att.summary(c, 's_0'), ['present', 'absent', 'excused']), { present: 1, absent: 1, excused: 1 });
  });

  test('addSession: in date order, id from the date; a second session on a date needs a distinct label', () => {
    const c = makeCourse({ sessions: 2 });
    const s = att.addSession(c, { date: '2026-09-02', label: '  Review  ' });
    assert.deepEqual(s, { id: 'ses_20260902', date: '2026-09-02', label: 'Review' });
    assert.deepEqual(c.attendance.sessions.map((x) => x.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.throws(() => att.addSession(c, { date: '2026-09-01' }), /already a session on 2026-09-01.*label/);
    const mk = att.addSession(c, { date: '2026-09-01', label: 'Makeup' });
    assert.equal(mk.id, 'ses_20260901_2');
    assert.throws(() => att.addSession(c, { date: '2026-09-01', label: 'makeup' }), /labeled "makeup"/);
    assert.throws(() => att.addSession(c, { date: '2026-02-30' }), /valid date/);
    assert.throws(() => att.addSession(c, {}), /valid date/);
    assert.equal(c.attendance.sessions.length, 4);
  });

  test('addSession never reuses an id that still has marks', () => {
    const c = makeCourse({ students: 1, sessions: 1 });
    c.attendance.records.s_0 = { ses_20260903: 'A' }; // stray marks for a session that is not listed
    assert.equal(att.addSession(c, { date: '2026-09-03' }).id, 'ses_20260903_2');
  });

  test('mergeSessions with the course (or a Set / array of taken ids) never reuses an id that marks without a session carry (review E2E3-12 / R3-C7)', () => {
    const c = makeCourse({ students: 1, sessions: 0 });
    c.attendance.records.s_0 = { ses_20260903: 'A' }; // a mark whose session was dropped (bad date in a restored file)
    const gen = model.generateSessions({ start: '2026-09-01', end: '2026-09-08', weekdays: [2, 4] });
    assert.deepEqual([...att.sessionIdsInUse(c)], ['ses_20260903']);
    const merged = att.mergeSessions(c.attendance.sessions, gen, c);
    assert.deepEqual(merged.map((x) => x.id), ['ses_20260901', 'ses_20260903_2', 'ses_20260908']);
    c.attendance.sessions = merged;
    const sm = att.summary(c, 's_0');
    assert.equal(sm.absent, 0, 'the old mark does not reappear on the new session');
    assert.equal(sm.recorded, 0);
    assert.deepEqual(att.heldSessions(c), []);
    // A Set or an array of ids works too; without `taken` the old behavior stays (existing ids only).
    assert.equal(att.mergeSessions([], gen, new Set(['ses_20260903']))[1].id, 'ses_20260903_2');
    assert.equal(att.mergeSessions([], gen, ['ses_20260903', 7, null])[1].id, 'ses_20260903_2');
    assert.equal(att.mergeSessions([], gen)[1].id, 'ses_20260903');
    for (const odd of [null, undefined, 'ses_20260903', 5, {}, { attendance: null }]) {
      assert.equal(att.mergeSessions([], gen, odd)[1].id, 'ses_20260903', String(odd));
    }
    assert.deepEqual([...att.sessionIdsInUse(null)], []);
    // Existing sessions keep their ids even though their marks make those ids "taken".
    const d = makeCourse({ students: 1, sessions: 2 });
    marks(d, 's_0', 'AP');
    assert.deepEqual(att.mergeSessions(d.attendance.sessions, gen, d).map((x) => x.id), ['ses_20260901', 'ses_20260903', 'ses_20260908']);
  });

  test('updateSession changes date/label, keeps the id and marks, re-sorts; clashes throw', () => {
    const c = makeCourse({ students: 1, sessions: 3 });
    marks(c, 's_0', 'PAE');
    const id = ses(c, 0).id;
    const out = att.updateSession(c, id, { date: '2026-09-09', label: 'Moved' });
    assert.deepEqual(out, { id, date: '2026-09-09', label: 'Moved' });
    assert.deepEqual(c.attendance.sessions.map((x) => x.id), ['ses_20260903', 'ses_20260908', id]);
    assert.equal(c.attendance.records.s_0[id], 'P');
    assert.equal(att.updateSession(c, id, { label: '' }).label, '');
    assert.throws(() => att.updateSession(c, id, { date: '2026-09-08' }), /already a session on 2026-09-08/);
    assert.throws(() => att.updateSession(c, id, { date: 'soon' }), /valid date/);
    assert.equal(ses(c, 2).date, '2026-09-09', 'unchanged after a refused edit');
    // Same date as another session is fine with a distinct label; editing one of them again is fine too.
    att.updateSession(c, id, { date: '2026-09-08', label: 'Lab' });
    assert.equal(att.updateSession(c, id, { label: 'Lab' }).label, 'Lab');
    assert.equal(att.updateSession(c, 'ses_nope', { label: 'x' }), null);
  });

  test('removeSession deletes the session and its marks (withdrawn included) and returns the count', () => {
    const c = makeCourse({ students: 3, sessions: 3 });
    marks(c, 's_0', 'PA');
    marks(c, 's_1', 'AA');
    c.students[1].status = 'withdrawn';
    const id = ses(c, 1).id;
    assert.equal(att.markCount(c, id), 2);
    assert.equal(att.removeSession(c, id), 2);
    assert.equal(c.attendance.sessions.length, 2);
    assert.deepEqual(c.attendance.records, { s_0: { [ses(c, 0).id]: 'P' }, s_1: { [ses(c, 0).id]: 'A' } });
    assert.equal(att.removeSession(c, id), 0, 'already gone: nothing happens');
    assert.equal(c.attendance.sessions.length, 2);
  });
});

// ================================================================ marks and totals (mutators)

describe('marks and totals', () => {
  test('setMark sets, changes and clears one mark; true only when it changed', () => {
    const c = makeCourse({ students: 2, sessions: 3 });
    const id = ses(c, 0).id;
    assert.equal(att.setMark(c, 's_0', id, 'a'), true);
    assert.equal(c.attendance.records.s_0[id], 'A');
    assert.equal(att.setMark(c, 's_0', id, 'A'), false);
    assert.equal(att.setMark(c, 's_0', id, 'Excused'), true);
    assert.equal(att.setMark(c, 's_0', id, null), true);
    assert.equal(util.hasOwn(c.attendance.records, 's_0'), false, 'an emptied row is removed');
    assert.equal(att.setMark(c, 's_0', id, ''), false);
    assert.throws(() => att.setMark(c, 's_0', id, 'L'), /not an attendance mark/);
    assert.equal(att.setMark(c, 's_nope', id, 'P'), false);
    assert.equal(att.setMark(c, 's_0', 'ses_nope', 'P'), false);
    assert.equal(att.setMark(c, '__proto__', id, 'P'), false);
    assert.deepEqual(c.attendance.records, {});
  });

  test('setMarks applies a range in one go, skipping invalid items', () => {
    const c = makeCourse({ students: 3, sessions: 3 });
    const items = [];
    for (const sid of ['s_0', 's_1', 's_2']) for (let k = 0; k < 2; k++) items.push({ studentId: sid, sessionId: ses(c, k).id, mark: 'A' });
    items.push({ studentId: 's_0', sessionId: ses(c, 2).id, mark: 'zzz' }, { studentId: 's_x', sessionId: ses(c, 2).id, mark: 'A' }, null);
    assert.equal(att.setMarks(c, items), 6);
    assert.equal(att.setMarks(c, items), 0, 'nothing changes the second time');
    assert.equal(att.setMarks(c, 'junk'), 0);
  });

  test('markAllPresent sets P only for students without a mark; active only by default', () => {
    const c = makeCourse({ students: 4, sessions: 2 });
    const id = ses(c, 0).id;
    marks(c, 's_0', 'A');
    c.students[3].status = 'withdrawn';
    assert.equal(att.markAllPresent(c, id), 2);
    assert.deepEqual(att.sessionCounts(c, id), { present: 2, absent: 1, excused: 0, unmarked: 0, marked: 3, presentRate: util.fix(200 / 3) });
    assert.equal(c.attendance.records.s_0[id], 'A', 'existing marks are kept');
    assert.equal(util.hasOwn(c.attendance.records, 's_3'), false);
    assert.equal(att.markAllPresent(c, id, { activeOnly: false }), 1);
    assert.equal(att.markAllPresent(c, id), 0);
    assert.equal(att.markAllPresent(c, 'ses_nope'), 0);
  });

  test('clearSession removes the session\'s marks and keeps the session', () => {
    const c = makeCourse({ students: 3, sessions: 2 });
    marks(c, 's_0', 'PA');
    marks(c, 's_1', 'E');
    assert.equal(att.clearSession(c, ses(c, 0).id), 2);
    assert.equal(c.attendance.sessions.length, 2);
    assert.deepEqual(c.attendance.records, { s_0: { [ses(c, 1).id]: 'A' } });
    assert.deepEqual(att.heldSessions(c).map((s) => s.id), [ses(c, 1).id]);
  });

  test('setTotals: whole numbers >= 0 (text through parseCount); invalid input throws and changes nothing', () => {
    const c = makeCourse({ mode: 'totals' });
    assert.equal(att.setTotals(c, 's_0', { absent: 2 }), true);
    assert.deepEqual(c.attendance.totals.s_0, { absent: 2, excused: 0 });
    assert.equal(att.setTotals(c, 's_0', { excused: '3' }), true);
    assert.deepEqual(c.attendance.totals.s_0, { absent: 2, excused: 3 });
    assert.equal(att.setTotals(c, 's_0', { absent: 2, excused: 3 }), false);
    for (const bad of [-1, 1.5, '1.5', 'two', '50%', '1e3', '+2', '1,000', NaN, Infinity, 1e7, true]) {
      assert.throws(() => att.setTotals(c, 's_0', { absent: bad }), /whole number of 0 or more/, String(bad));
    }
    assert.deepEqual(c.attendance.totals.s_0, { absent: 2, excused: 3 });
    assert.equal(att.setTotals(c, 's_1', { absent: 0, excused: 0 }), false, 'no row for zeros');
    assert.equal(util.hasOwn(c.attendance.totals, 's_1'), false);
    assert.equal(att.setTotals(c, 's_nope', { absent: 1 }), false);
    assert.equal(att.setSessionsHeld(c, '12'), true);
    assert.equal(c.attendance.totalsSessionsHeld, 12);
    assert.equal(att.setSessionsHeld(c, 12), false);
    assert.throws(() => att.setSessionsHeld(c, -3), /Sessions held must be a whole number/);
  });
});

// ================================================================ history integration

describe('history (G5)', () => {
  const TS = '2026-10-12T15:04:05.000Z';
  function change(c, fn) {
    const b = util.clone(c);
    delete b.history;
    fn(c);
    return history.diffCourse(b, c, { ts: TS, source: 'edit' });
  }

  test('"Mark everyone without a mark as Present" on the sample gives ONE summary entry', () => {
    const c = model.createCourse('SE4351');
    sample.loadInto(c);
    const id = ses(c, 0).id;
    att.clearSession(c, id);
    const out = change(c, (co) => { assert.equal(att.markAllPresent(co, id), 57); });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'attendance');
    assert.equal(out[0].newValue, '57 marks changed');
  });

  test('deleting a session says how many marks went with it (review E2E3-11)', () => {
    const c = model.createCourse('SE4351');
    sample.loadInto(c);
    const id = ses(c, 1).id;
    const n = att.markCount(c, id);
    assert.ok(n > 5);
    assert.equal(ses(c, 1).date, '2026-09-08');
    const out = change(c, (co) => { assert.equal(att.removeSession(co, id), n); });
    assert.deepEqual(out.map((e) => [e.kind, e.field, e.oldValue, e.newValue, e.note]),
      [['settings', 'Session 2026-09-08', '2026-09-08', '', 'Session removed with its ' + n + ' marks']]);
    const d = makeCourse({ students: 1, sessions: 3 });
    marks(d, 's_0', 'PA');
    assert.equal(change(d, (co) => att.removeSession(co, ses(co, 1).id))[0].note, 'Session removed with its 1 mark');
    assert.equal(change(d, (co) => att.removeSession(co, ses(co, 1).id))[0].note, 'Session removed', 'no marks: plain note');
    // Many sessions at once: the summary entry adds the marks deleted with them.
    const e = makeCourse({ students: 2, sessions: 12 });
    marks(e, 's_0', 'PPPPPPPPPPPP');
    marks(e, 's_1', 'AA');
    const many = change(e, (co) => { co.attendance.sessions = []; co.attendance.records = {}; });
    assert.equal(many.length, 1);
    assert.match(many[0].note, /^12 sessions changed \(0 added, 12 removed, 0 edited\): .*; 14 marks deleted with the removed sessions$/);
  });

  test('"Fill totals from per-session marks" is summarized as absence totals, not marks (review E2E3-11)', () => {
    const c = model.createCourse('SE4351');
    sample.loadInto(c);
    c.attendance.totals = {};
    const from = att.totalsFromRecords(c);
    const out = change(c, (co) => { co.students.forEach((s) => att.setTotals(co, s.id, from.totals[s.id])); });
    assert.equal(out.length, 1);
    const changed = Object.keys(c.attendance.totals).reduce((n, sid) => n + (c.attendance.totals[sid].absent !== undefined) + (c.attendance.totals[sid].excused !== undefined), 0);
    assert.equal(out[0].kind, 'attendance');
    assert.equal(out[0].newValue, changed + ' absence totals changed');
    assert.match(out[0].note, /^Absent and Excused counts \(totals mode\); \d+ students$/);
    // Marks and totals in one transaction: both counts.
    const d = makeCourse({ students: 3, sessions: 4 });
    const both = change(d, (co) => {
      marks(co, 's_0', 'PAPA');
      co.attendance.totals.s_1 = { absent: 1, excused: 2 };
      co.attendance.totals.s_2 = { absent: 3, excused: 0 };
    });
    assert.deepEqual(both.map((x) => x.newValue), ['4 marks and 4 absence totals changed']);
  });

  test('one mark gives one itemized entry; the total-absence threshold is logged as a setting', () => {
    const c = makeCourse({ students: 1, sessions: 2 });
    let out = change(c, (co) => att.setMark(co, 's_0', ses(co, 0).id, 'E'));
    assert.deepEqual(out.map((e) => [e.kind, e.field, e.oldValue, e.newValue]), [['attendance', 'Attendance 2026-09-01', '', 'Excused']]);
    out = change(c, (co) => { co.attendance.totalAbsenceThreshold = 6; });
    assert.deepEqual(out.map((e) => [e.kind, e.field, e.fieldKey, e.oldValue, e.newValue]),
      [['settings', 'Total-absence threshold', 'attendance.totalAbsenceThreshold', 'off', '6']]);
    out = change(c, (co) => { co.attendance.totalAbsenceThreshold = null; });
    assert.deepEqual(out.map((e) => [e.oldValue, e.newValue]), [['6', 'off']]);
    out = change(c, (co) => { delete co.attendance.totalAbsenceThreshold; });
    assert.deepEqual(out, [], 'missing and null both mean off');
  });
});

// ================================================================ sample data (C4)

describe('sample data', () => {
  function sampleCourse(countE) {
    const c = model.createCourse('SE4351');
    sample.loadInto(c);
    c.attendance.excusedCountsTowardStreak = !!countE;
    return c;
  }

  for (const countE of [false, true]) {
    test('SE 4351 sample: exactly one 3-run and one 4-run of unexcused absences (excused count: ' + countE + ')', () => {
      const c = sampleCourse(countE);
      const cs = att.courseSummary(c);
      assert.equal(cs.held, 26);
      const streaky = c.students.filter((s) => cs.byStudent[s.id].longestStreak >= 3);
      assert.equal(streaky.length, 2);
      const drop = cs.warnings.filter((w) => w.kind === 'drop');
      const fail = cs.warnings.filter((w) => w.kind === 'fail');
      assert.equal(drop.length, 1);
      assert.equal(fail.length, 1);
      for (const w of [drop[0], fail[0]]) {
        const row = c.attendance.records[w.studentId];
        assert.ok(w.streak.sessionIds.every((id) => row[id] === 'A'), 'the run is unexcused absences only');
        assert.equal(w.streak.length, w.kind === 'drop' ? 3 : 4);
      }
    });
  }

  test('SE 4351 sample: a student with several excused absences, so the Excused column is not all zeros', () => {
    const c = sampleCourse(false);
    const cs = att.courseSummary(c);
    const excused = c.students.filter((s) => s.status === 'active' && cs.byStudent[s.id].excused >= 4);
    assert.ok(excused.length >= 1);
    const e = excused.find((s) => /excused/.test(s.notes));
    assert.ok(e, 'the planted student has a note');
    assert.equal(cs.byStudent[e.id].unexcused, 0);
    assert.equal(cs.byStudent[e.id].excused, 4);
    assert.equal(cs.byStudent[e.id].longestStreak, 0);
    c.attendance.excusedCountsTowardStreak = true;
    assert.ok(att.summary(c, e.id).longestStreak < 2, 'the excused absences are never next to each other');
  });

  test('SE 4351 sample: summaries match the stored totals', () => {
    const c = sampleCourse(false);
    const cs = att.courseSummary(c);
    for (const s of c.students) {
      const t = c.attendance.totals[s.id];
      assert.equal(cs.byStudent[s.id].absent, t.absent);
      assert.equal(cs.byStudent[s.id].excused, t.excused);
      assert.equal(cs.byStudent[s.id].recorded, 26);
    }
    assert.deepEqual(att.totalsFromRecords(c), { held: 26, totals: c.attendance.totals });
  });
});
