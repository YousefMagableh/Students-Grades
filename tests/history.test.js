'use strict';
/* Spec-derived tests for js/core/history.js (DESIGN.md section 4, STAGE2 section 2; REQUIREMENTS G5, K5, S2).
 * Every expected entry is written out by hand. Fake data only. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../js/core/util.js');
const model = require('../js/core/model.js');
const calc = require('../js/core/calc.js');
const history = require('../js/core/history.js');
const sample = require('../js/core/sample.js');

// ---------------------------------------------------------------- helpers

const TS = '2026-10-12T15:04:05.000Z';
const P1 = 'a_p1', P2 = 'a_p2', T1 = 'a_t1', T2 = 'a_t2', PART = 'a_part';
const SHAPE = ['id', 'ts', 'source', 'kind', 'studentId', 'studentName', 'teamId', 'teamName',
  'field', 'fieldKey', 'oldValue', 'newValue', 'note'].sort();
const OVERRIDE_NOTE = "Per-member override: an unequal split needs the team's written agreement";

function addTeam(c, name) { const t = model.createTeam(name); c.teams.push(t); return t; }
function addStudent(c, lastName, firstName, extra) {
  const s = model.createStudent(Object.assign({ lastName, firstName, no: c.students.length + 1 }, extra || {}));
  c.students.push(s);
  return s;
}
function score(c, s, aid, input) { model.setEntry(c.scores, s.id, aid, model.entryFromInput(input)); }

/** Course with two teams:
 * Team 1: Student 01 Alpha, Student 02 Bravo, Student 03 Charlie (override 95 on Project I).
 * Team 2: Student 04 Delta. No team: Student 05 Echo.
 * Team scores: Project I Team 1 = 90, Team 2 = 80. Test 1: Alpha 84, Echo 70. */
function setup() {
  const c = model.createCourse('SE4351');
  const t1 = addTeam(c, 'Team 1');
  const t2 = addTeam(c, 'Team 2');
  const alpha = addStudent(c, 'Student 01', 'Alpha', { teamId: t1.id });
  const bravo = addStudent(c, 'Student 02', 'Bravo', { teamId: t1.id });
  const charlie = addStudent(c, 'Student 03', 'Charlie', { teamId: t1.id });
  const delta = addStudent(c, 'Student 04', 'Delta', { teamId: t2.id });
  const echo = addStudent(c, 'Student 05', 'Echo');
  model.setTeamScore(c, t1.id, P1, { value: 90 });
  model.setTeamScore(c, t2.id, P1, { value: 80 });
  model.setOverride(c, charlie.id, P1, { value: 95 });
  score(c, alpha, T1, '84');
  score(c, echo, T1, '70');
  return { c, t1, t2, alpha, bravo, charlie, delta, echo };
}

function snap(c) { const x = util.clone(c); delete x.history; return x; }
function diff(before, after, opts) { return history.diffCourse(before, after, Object.assign({ ts: TS, source: 'edit' }, opts || {})); }
/** Applies fn to the course and returns the history entries for that change. */
function change(c, fn, opts) { const b = snap(c); fn(c); return diff(b, c, opts); }
/** Compact form for assertions: [kind, who, field, old, new]. */
const brief = (e) => [e.kind, e.studentName || e.teamName || '', e.field, e.oldValue, e.newValue];
const briefs = (list) => list.map(brief);
const kinds = (list) => list.map((e) => e.kind);
function session(c, i) { return c.attendance.sessions[i]; }
function mark(c, s, i, m) { model.setEntry(c.attendance.records, s.id, session(c, i).id, m); }

// ================================================================ entry shape

describe('entry shape', () => {
  test('every entry has the documented fields, display strings, the given ts and source, and a unique h_ id', () => {
    const { c, alpha, t1 } = setup();
    const out = change(c, (co) => {
      score(co, alpha, T2, '77.5');
      model.setTeamScore(co, t1.id, P1, { value: 91 });
      co.settings.curve = 2;
    }, { source: 'paste' });
    assert.ok(out.length >= 3);
    const ids = new Set();
    out.forEach((e) => {
      assert.deepEqual(Object.keys(e).sort(), SHAPE);
      assert.equal(e.ts, TS);
      assert.equal(e.source, 'paste');
      assert.match(e.id, /^h_/);
      assert.ok(!ids.has(e.id), 'ids are unique');
      ids.add(e.id);
      ['field', 'fieldKey', 'oldValue', 'newValue', 'note'].forEach((k) => assert.equal(typeof e[k], 'string', k));
      assert.ok(history.KINDS.includes(e.kind));
    });
    // Everything is plain JSON (it is stored in IndexedDB / localStorage and in backups).
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  });

  test('no difference gives no entries; the history array itself is ignored', () => {
    const { c } = setup();
    const before = snap(c);
    c.history.push({ id: 'h_x', kind: 'bulk' });
    assert.deepEqual(diff(before, c), []);
    assert.deepEqual(diff(c, util.clone(c)), []);
  });

  test('ts defaults to now and source to edit', () => {
    const { c, alpha } = setup();
    const b = snap(c);
    score(c, alpha, T2, '60');
    const [e] = history.diffCourse(b, c);
    assert.equal(e.source, 'edit');
    assert.ok(!isNaN(Date.parse(e.ts)));
  });
});

// ================================================================ scores

describe('individual scores', () => {
  test('a score edit: kind score, student snapshot, value exactly as entered', () => {
    const { c, alpha, t1 } = setup();
    const out = change(c, (co) => score(co, alpha, T1, '84.50'));
    // entryFromInput stores the number 84.5; String(84.5) is what the TA sees in the grid.
    assert.deepEqual(briefs(out), [['score', 'Student 01, Alpha', 'Test 1', '84', '84.5']]);
    assert.equal(out[0].studentId, alpha.id);
    assert.equal(out[0].teamId, t1.id);
    assert.equal(out[0].teamName, 'Team 1');
    assert.equal(out[0].fieldKey, 'score:' + T1);
  });

  test('entering, clearing and re-entering a score', () => {
    const { c, alpha } = setup();
    assert.deepEqual(briefs(change(c, (co) => score(co, alpha, T2, '0'))), [['score', 'Student 01, Alpha', 'Test 2', '', '0']]);
    assert.deepEqual(briefs(change(c, (co) => model.setEntry(co.scores, alpha.id, T2, null))), [['score', 'Student 01, Alpha', 'Test 2', '0', '']]);
  });

  test('invalid text is shown quoted with "(not a number)"', () => {
    const { c, echo } = setup();
    const out = change(c, (co) => score(co, echo, T1, 'abc'));
    assert.deepEqual(briefs(out), [['score', 'Student 05, Echo', 'Test 1', '70', '"abc" (not a number)']]);
    const back = change(c, (co) => score(co, echo, T1, '71'));
    assert.deepEqual(briefs(back), [['score', 'Student 05, Echo', 'Test 1', '"abc" (not a number)', '71']]);
  });

  test('a team-graded item of a student without a team is an individual score', () => {
    const { c, echo } = setup();
    const out = change(c, (co) => score(co, echo, P1, '88'));
    assert.deepEqual(briefs(out), [['score', 'Student 05, Echo', 'Project I', '', '88']]);
    assert.equal(out[0].note, 'No team: individual score');
    assert.equal(out[0].teamId, null);
  });

  test('a stale own entry of a team member (hidden behind the team score) is not logged', () => {
    const { c, alpha } = setup();
    const out = change(c, (co) => model.setEntry(co.scores, alpha.id, P1, { value: 12 }));
    assert.deepEqual(out, []);
  });

  test('late work: weeks late and penalty waived are kind late', () => {
    const { c, alpha } = setup();
    const out = change(c, (co) => model.setEntry(co.scores, alpha.id, T1, model.withLate(model.getEntry(co.scores, alpha.id, T1), 2, false)));
    assert.deepEqual(briefs(out), [['late', 'Student 01, Alpha', 'Test 1: weeks late', '', '2']]);
    assert.equal(out[0].fieldKey, 'late:' + T1 + '.weeksLate');
    const waived = change(c, (co) => model.setEntry(co.scores, alpha.id, T1, model.withLate(model.getEntry(co.scores, alpha.id, T1), 2, true)));
    assert.deepEqual(briefs(waived), [['late', 'Student 01, Alpha', 'Test 1: penalty waived', 'no', 'yes']]);
  });
});

// ================================================================ team scores, propagation, overrides (K5)

describe('team scores and propagation', () => {
  test('a team score change: 1 team-score entry, propagation for members without override, none for the override member', () => {
    const { c, t1, alpha, bravo } = setup();
    const out = change(c, (co) => model.setTeamScore(co, t1.id, P1, { value: 92 }));
    assert.deepEqual(briefs(out), [
      ['team-score', 'Team 1', 'Project I', '90', '92'],
      ['propagation', 'Student 01, Alpha', 'Project I', '90', '92'],
      ['propagation', 'Student 02, Bravo', 'Project I', '90', '92']
    ]);
    assert.equal(out[0].studentId, null);
    assert.equal(out[0].studentName, null);
    assert.equal(out[0].teamId, t1.id);
    assert.equal(out[0].note, 'Team score for 3 members');
    assert.equal(out[0].fieldKey, 'teamScore:' + P1);
    assert.deepEqual(out.slice(1).map((e) => e.studentId), [alpha.id, bravo.id]);
    out.slice(1).forEach((e) => {
      assert.equal(e.note, 'From Team 1 team score');
      assert.equal(e.teamName, 'Team 1');
      assert.equal(e.fieldKey, 'score:' + P1);
    });
  });

  test('clearing a team score and a one-member team (singular note)', () => {
    const { c, t2, delta } = setup();
    const out = change(c, (co) => model.setTeamScore(co, t2.id, P1, { value: null }));
    assert.deepEqual(briefs(out), [
      ['team-score', 'Team 2', 'Project I', '80', ''],
      ['propagation', 'Student 04, Delta', 'Project I', '80', '']
    ]);
    assert.equal(out[0].note, 'Team score for 1 member');
    assert.equal(out[1].studentId, delta.id);
  });

  test('stage 6: late work on a team entry (set, waive, remove): kind late for the team, propagation to members without override, adjusted values follow', () => {
    const { c, t1, alpha, bravo, charlie } = setup();
    const P1A = model.findAssessment(c, P1);
    const adjusted = (s) => calc.scoreDetail(c, s, P1A).adjusted;
    const total = (s) => calc.studentResult(c, s).total;
    const before = { alpha: total(alpha), bravo: total(bravo), charlie: total(charlie) };
    // 1. Team 1 handed Project I in 2 weeks late (what the "Late work…" dialog writes for a team cell).
    let out = change(c, (co) => model.setTeamScore(co, t1.id, P1, model.withLate(model.getEntry(co.teamScores, t1.id, P1), 2, false)));
    assert.deepEqual(briefs(out), [
      ['late', 'Team 1', 'Project I: weeks late', '', '2'],
      ['propagation', 'Student 01, Alpha', 'Project I', '90', '90 (2 weeks late)'],
      ['propagation', 'Student 02, Bravo', 'Project I', '90', '90 (2 weeks late)']
    ]);
    assert.equal(out[0].teamId, t1.id);
    assert.equal(out[0].studentId, null);
    assert.equal(out[0].fieldKey, 'late:' + P1 + '.weeksLate');
    assert.equal(out[0].note, 'Team score for 3 members');
    out.slice(1).forEach((e) => assert.equal(e.note, 'From Team 1 team score'));
    // Members see the adjusted score (90 − 20 = 70): 2 points off a 10% item; the override member (95) keeps hers.
    assert.equal(adjusted(alpha), 70);
    assert.equal(adjusted(bravo), 70);
    assert.equal(adjusted(charlie), 95);
    assert.equal(total(alpha), util.fix(before.alpha - 2));
    assert.equal(total(bravo), util.fix(before.bravo - 2));
    assert.equal(total(charlie), before.charlie);
    // 2. Waived (pre-approved): one late entry for the team, members back to 90.
    out = change(c, (co) => model.setTeamScore(co, t1.id, P1, model.withLate(model.getEntry(co.teamScores, t1.id, P1), 2, true)));
    assert.deepEqual(briefs(out), [
      ['late', 'Team 1', 'Project I: penalty waived', 'no', 'yes'],
      ['propagation', 'Student 01, Alpha', 'Project I', '90 (2 weeks late)', '90 (2 weeks late, penalty waived)'],
      ['propagation', 'Student 02, Bravo', 'Project I', '90 (2 weeks late)', '90 (2 weeks late, penalty waived)']
    ]);
    assert.equal(out[0].fieldKey, 'late:' + P1 + '.waived');
    assert.equal(adjusted(alpha), 90);
    assert.equal(total(alpha), before.alpha);
    // 3. Back on time (weeks 0): both fields logged, members back to the plain score.
    out = change(c, (co) => model.setTeamScore(co, t1.id, P1, model.withLate(model.getEntry(co.teamScores, t1.id, P1), 0, false)));
    assert.deepEqual(briefs(out), [
      ['late', 'Team 1', 'Project I: weeks late', '2', ''],
      ['late', 'Team 1', 'Project I: penalty waived', 'yes', 'no'],
      ['propagation', 'Student 01, Alpha', 'Project I', '90 (2 weeks late, penalty waived)', '90'],
      ['propagation', 'Student 02, Bravo', 'Project I', '90 (2 weeks late, penalty waived)', '90']
    ]);
    assert.deepEqual(model.getEntry(c.teamScores, t1.id, P1), { value: 90 });
    // Late info on the override member's own entry is hers alone: no team entry, no propagation.
    out = change(c, (co) => model.setEntry(co.scores, charlie.id, P1, model.withLate(model.getEntry(co.scores, charlie.id, P1), 1, false)));
    assert.deepEqual(briefs(out), [['late', 'Student 03, Charlie', 'Project I: weeks late', '', '1']]);
    assert.equal(out[0].note, 'Per-member override');
    assert.equal(adjusted(charlie), 85);
  });

  test('late info on a team score: kind late for the team, and members see it through propagation', () => {
    const { c, t2 } = setup();
    const out = change(c, (co) => model.setTeamScore(co, t2.id, P1, { value: 80, weeksLate: 1 }));
    assert.deepEqual(briefs(out), [
      ['late', 'Team 2', 'Project I: weeks late', '', '1'],
      ['propagation', 'Student 04, Delta', 'Project I', '80', '80 (1 week late)']
    ]);
    assert.equal(out[0].studentId, null);
  });

  test('override set: old = the team score the student saw, new = the override value', () => {
    const { c, bravo } = setup();
    const out = change(c, (co) => model.setOverride(co, bravo.id, P1, { value: 85 }));
    assert.deepEqual(briefs(out), [['override', 'Student 02, Bravo', 'Project I', '90', '85']]);
    assert.equal(out[0].note, OVERRIDE_NOTE);
    assert.equal(out[0].studentId, bravo.id);
  });

  test('override removed: old = override value, new = the team score seen now', () => {
    const { c, charlie } = setup();
    const out = change(c, (co) => model.clearOverride(co, charlie.id, P1));
    assert.deepEqual(briefs(out), [['override-removed', 'Student 03, Charlie', 'Project I', '95', '90']]);
    assert.equal(out[0].note, 'Now uses the team score');
  });

  test('clearing an override cell (blank input) is an override removal', () => {
    const { c, charlie } = setup();
    const out = change(c, (co) => {
      const e = model.entryFromInput('', model.getEntry(co.scores, charlie.id, P1));
      model.setEntry(co.scores, charlie.id, P1, model.isBlankEntry(e) ? null : e);
    });
    assert.deepEqual(kinds(out), ['override-removed']);
  });

  test('override value changed keeps kind override', () => {
    const { c, charlie } = setup();
    const out = change(c, (co) => model.setOverride(co, charlie.id, P1, { value: 97 }));
    assert.deepEqual(briefs(out), [['override', 'Student 03, Charlie', 'Project I', '95', '97']]);
    assert.equal(out[0].note, 'Override value changed');
  });

  test('team score + override in one change (paste of a team column): no propagation for the override member', () => {
    const { c, alpha, bravo, charlie } = setup();
    const out = change(c, (co) => {
      model.setTeamScoreFromMembers(co, P1, [
        { studentId: alpha.id, entry: model.entryFromInput('70') },
        { studentId: bravo.id, entry: model.entryFromInput('75') },
        { studentId: charlie.id, entry: model.entryFromInput('95', model.getEntry(co.scores, charlie.id, P1)) }
      ]);
    }, { source: 'paste' });
    // Majority by first-in-row-order tie: 70 becomes the team score; Bravo keeps 75 as an override.
    assert.deepEqual(briefs(out), [
      ['team-score', 'Team 1', 'Project I', '90', '70'],
      ['override', 'Student 02, Bravo', 'Project I', '90', '75'],
      ['propagation', 'Student 01, Alpha', 'Project I', '90', '70']
    ]);
  });
});

// ================================================================ teams and membership

describe('teams and team membership', () => {
  test('moving a student to another team: membership entry plus the new team score as propagation', () => {
    const { c, bravo, t2 } = setup();
    const out = change(c, (co) => model.moveStudentToTeam(co, bravo.id, t2.id));
    assert.deepEqual(briefs(out), [
      ['team-membership', 'Student 02, Bravo', 'Team', 'Team 1', 'Team 2'],
      ['propagation', 'Student 02, Bravo', 'Project I', '90', '80']
    ]);
    assert.equal(out[0].teamId, t2.id);
    assert.equal(out[0].teamName, 'Team 2');
    assert.equal(out[1].note, 'Moved to Team 2: uses its team score');
  });

  test('moving with keepScores keeps the old score as an override', () => {
    const { c, bravo, t2 } = setup();
    const out = change(c, (co) => model.moveStudentToTeam(co, bravo.id, t2.id, { keepScores: true }));
    assert.deepEqual(briefs(out), [
      ['team-membership', 'Student 02, Bravo', 'Team', 'Team 1', 'Team 2'],
      ['override', 'Student 02, Bravo', 'Project I', '90', '90']
    ]);
    assert.equal(out[1].note, OVERRIDE_NOTE);
  });

  test('moving an override member to no team removes the override', () => {
    const { c, charlie } = setup();
    const out = change(c, (co) => model.moveStudentToTeam(co, charlie.id, null));
    assert.deepEqual(briefs(out), [
      ['team-membership', 'Student 03, Charlie', 'Team', 'Team 1', ''],
      ['override-removed', 'Student 03, Charlie', 'Project I', '95', '']
    ]);
    assert.equal(out[1].note, 'No team: uses the individual score');
    assert.equal(out[0].teamId, null);
  });

  test('team created, renamed and deleted (members move to no team)', () => {
    const { c, t2, delta } = setup();
    let out = change(c, (co) => { co.teams.push(model.createTeam('Team 3', 't_three')); });
    assert.deepEqual(briefs(out), [['team-membership', 'Team 3', 'Team', '', 'Team 3']]);
    assert.equal(out[0].studentId, null);
    assert.equal(out[0].teamId, 't_three');
    assert.equal(out[0].note, 'Team created');

    out = change(c, (co) => { model.findTeam(co, t2.id).name = 'Team Two'; });
    assert.deepEqual(briefs(out), [['team-membership', 'Team Two', 'Team name', 'Team 2', 'Team Two']]);

    out = change(c, (co) => model.removeTeam(co, t2.id));
    assert.deepEqual(briefs(out), [
      ['team-membership', 'Team Two', 'Team', 'Team Two', ''],
      ['team-membership', 'Student 04, Delta', 'Team', 'Team Two', ''],
      ['propagation', 'Student 04, Delta', 'Project I', '80', '']
    ]);
    assert.equal(out[0].note, 'Team deleted (1 member; team scores: Project I 80)');
    assert.equal(out[2].note, 'No team: uses the individual score');
    assert.equal(out[2].studentId, delta.id);
  });
});

// ================================================================ students

describe('students', () => {
  test('adding a student', () => {
    const { c, t2 } = setup();
    const out = change(c, (co) => addStudent(co, 'Student 06', 'Foxtrot', { teamId: t2.id }));
    assert.deepEqual(briefs(out), [['student', 'Student 06, Foxtrot', 'Student', '', 'Added']]);
    assert.equal(out[0].teamName, 'Team 2');
    assert.equal(out[0].note, 'No 6, Team 2');
  });

  test('adding a student with scores (import): the scores are logged too; team scores are not propagation', () => {
    const { c, t1 } = setup();
    const out = change(c, (co) => {
      const s = addStudent(co, 'Student 06', 'Foxtrot', { teamId: t1.id });
      score(co, s, T1, '66');
    }, { source: 'import' });
    assert.deepEqual(briefs(out), [
      ['student', 'Student 06, Foxtrot', 'Student', '', 'Added'],
      ['score', 'Student 06, Foxtrot', 'Test 1', '', '66']
    ]);
  });

  test('removing a student permanently: name snapshot from before, deleted scores recorded, attendance not itemized', () => {
    const { c, echo } = setup();
    mark(c, echo, 0, 'A');
    mark(c, echo, 1, 'A');
    const out = change(c, (co) => model.deleteStudent(co, echo.id));
    assert.deepEqual(briefs(out), [
      ['student', 'Student 05, Echo', 'Student', '', 'Deleted permanently'],
      ['score', 'Student 05, Echo', 'Test 1', '70', '']
    ]);
    assert.equal(out[0].studentId, echo.id);
    assert.equal(out[1].note, 'Student deleted permanently');
  });

  test('withdrawing and reinstating a student: kind status', () => {
    const { c, bravo } = setup();
    let out = change(c, (co) => { model.findStudent(co, bravo.id).status = 'withdrawn'; });
    assert.deepEqual(briefs(out), [['status', 'Student 02, Bravo', 'Status', 'Active', 'Withdrawn']]);
    assert.match(out[0].note, /excluded from statistics, rank, percentile and class average/);
    out = change(c, (co) => { model.findStudent(co, bravo.id).status = 'active'; });
    assert.deepEqual(briefs(out), [['status', 'Student 02, Bravo', 'Status', 'Withdrawn', 'Active']]);
  });

  test('No, names and notes: kind student, the name snapshot is the new name, notes truncated to 200 characters', () => {
    const { c, alpha } = setup();
    let out = change(c, (co) => {
      const s = model.findStudent(co, alpha.id);
      s.no = 11;
      s.lastName = 'Student 99';
    });
    assert.deepEqual(briefs(out), [
      ['student', 'Student 99, Alpha', 'No', '1', '11'],
      ['student', 'Student 99, Alpha', 'Last Name', 'Student 01', 'Student 99']
    ]);
    const long = 'x'.repeat(300);
    out = change(c, (co) => { model.findStudent(co, alpha.id).notes = long; });
    assert.equal(out.length, 1);
    assert.equal(out[0].field, 'Notes');
    assert.equal(out[0].newValue.length, 200);
    assert.ok(out[0].newValue.endsWith('…'));
  });
});

// ================================================================ settings, assessments, placeholders

describe('course details, settings, assessments and placeholders', () => {
  test('a weight change', () => {
    const { c } = setup();
    const out = change(c, (co) => { model.findAssessment(co, T1).weight = 20; });
    assert.deepEqual(briefs(out), [['settings', '', 'Test 1: weight', '25%', '20%']]);
    assert.equal(out[0].studentId, null);
    assert.equal(out[0].fieldKey, 'assessment:' + T1 + '.weight');
  });

  test('letter cutoffs are logged per letter, including added and removed letters', () => {
    const { c } = setup();
    let out = change(c, (co) => { co.settings.letterScale.find((x) => x.letter === 'A').min = 94; });
    assert.deepEqual(briefs(out), [['settings', '', 'Cutoff A', '93', '94']]);
    out = change(c, (co) => {
      co.settings.letterScale = model.normalizeLetterScale(
        co.settings.letterScale.filter((x) => x.letter !== 'D-').concat([{ letter: 'A++', min: 99 }]), co.level);
    });
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Cutoff A++', '', '99'],
      ['settings', '', 'Cutoff D-', '60', '']
    ]);
    assert.equal(out[0].note, 'Letter added');
    assert.equal(out[1].note, 'Letter removed');
  });

  test('course details and grade settings', () => {
    const { c } = setup();
    const out = change(c, (co) => {
      co.code = 'SE 4351.001';
      co.level = 'graduate';
      co.settings.decimals = 1;
      co.settings.rounding = 'integer';
      co.settings.curve = 1.5;
      co.settings.latePointsPerWeek = 5;
      co.settings.passingLetter = 'C-';
    });
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Course code', 'SE 4351', 'SE 4351.001'],
      ['settings', '', 'Level', 'Undergraduate', 'Graduate'],
      ['settings', '', 'Display decimals', '2', '1'],
      ['settings', '', 'Rounding', 'No rounding', 'Nearest integer'],
      ['settings', '', 'Curve (points added to the total)', '0', '1.5'],
      ['settings', '', 'Late penalty (points per week)', '10', '5'],
      ['settings', '', 'Passing letter', 'D-', 'C-']
    ]);
  });

  test('placeholder confirmation and undoing it; confirmedAt alone is not a change', () => {
    const { c } = setup();
    let out = change(c, (co) => { co.placeholders.letterScale = { confirmed: true, confirmedAt: TS }; });
    assert.deepEqual(briefs(out), [['settings', '', 'Confirmation: Letter-grade cutoffs', 'needs confirmation', 'confirmed']]);
    assert.equal(out[0].fieldKey, 'placeholder:letterScale');
    out = change(c, (co) => { co.placeholders.letterScale.confirmedAt = '2026-10-13T00:00:00.000Z'; });
    assert.deepEqual(out, []);
    out = change(c, (co) => { co.placeholders.letterScale = { confirmed: false, confirmedAt: null }; });
    assert.deepEqual(briefs(out), [['settings', '', 'Confirmation: Letter-grade cutoffs', 'confirmed', 'needs confirmation']]);
  });

  test('assessment added and removed; scores of a removed assessment are covered by the removal entry', () => {
    const { c } = setup();
    let out = change(c, (co) => { co.assessments.push(model.createAssessment({ id: 'a_p3', name: 'Project III', weight: 10, teamGraded: true })); });
    assert.deepEqual(briefs(out), [['settings', '', 'Assessment', '', 'Project III (weight 10%, max 100, team-graded)']]);
    out = change(c, (co) => model.removeAssessment(co, T1));
    assert.deepEqual(briefs(out), [['settings', '', 'Assessment', 'Test 1 (weight 25%, max 100)', '']]);
    assert.equal(out[0].note, 'Assessment removed with its scores (2 student entries, 0 team scores)');
  });

  test('splitting an assessment: rename, reweight, new part', () => {
    const { c } = setup();
    const out = change(c, (co) => model.splitAssessment(co, P1, [
      { name: 'Questionnaire I', weight: 2.5 }, { name: 'Project I (presentation + deliverable)', weight: 7.5 }]));
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Assessment name', 'Project I', 'Questionnaire I'],
      ['settings', '', 'Questionnaire I: weight', '10%', '2.5%'],
      ['settings', '', 'Assessment', '', 'Project I (presentation + deliverable) (weight 7.5%, max 100, team-graded)']
    ]);
  });

  test('max score, category and order changes', () => {
    const { c } = setup();
    const out = change(c, (co) => {
      model.findAssessment(co, T2).maxScore = 50;
      model.findAssessment(co, T2).category = 'other';
      model.moveAssessment(co, T2, -1);
    });
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Test 2: max score', '100', '50'],
      ['settings', '', 'Test 2: category', 'Test', 'Other'],
      ['settings', '', 'Assessment order',
        'Project I, Project II, Test 1, Test 2, Class/Project Participation',
        'Project I, Project II, Test 2, Test 1, Class/Project Participation']
    ]);
  });

  test('switching an item to team-graded logs the flag and the resulting team scores, not phantom score removals', () => {
    const { c, alpha, bravo, charlie } = setup();
    score(c, bravo, T1, '84');
    score(c, charlie, T1, '60');
    const out = change(c, (co) => model.convertAssessmentToTeam(co, T1));
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Test 1: team-graded', 'no', 'yes'],
      ['team-score', 'Team 1', 'Test 1', '', '84'],
      ['override', 'Student 03, Charlie', 'Test 1', '60', '60']
    ]);
    assert.ok(!out.some((e) => e.studentId === alpha.id), 'Alpha still sees 84');
  });

  test('switching an item to individually graded: team scores become own entries without noise', () => {
    const { c, charlie } = setup();
    const out = change(c, (co) => model.convertAssessmentToIndividual(co, P1));
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Project I: team-graded', 'yes', 'no'],
      ['override-removed', 'Student 03, Charlie', 'Project I', '95', '95']
    ]);
    assert.equal(out[1].studentId, charlie.id);
    assert.equal(out[1].note, 'Now individually graded');
  });
});

// ================================================================ attendance

describe('attendance', () => {
  test('3 mark changes: one entry per mark, in session date then name order', () => {
    const { c, alpha, bravo } = setup();
    const out = change(c, (co) => {
      mark(co, bravo, 0, 'P');
      mark(co, alpha, 1, 'E');
      mark(co, alpha, 0, 'A');
    });
    assert.deepEqual(briefs(out), [
      ['attendance', 'Student 01, Alpha', 'Attendance 2026-09-03', '', 'Absent'],
      ['attendance', 'Student 02, Bravo', 'Attendance 2026-09-03', '', 'Present'],
      ['attendance', 'Student 01, Alpha', 'Attendance 2026-09-08', '', 'Excused']
    ]);
    assert.equal(out[0].studentId, alpha.id);
    assert.equal(out[0].fieldKey, 'attendance:' + session(c, 0).id);
    const cleared = change(c, (co) => model.setEntry(co.attendance.records, alpha.id, session(co, 0).id, null));
    assert.deepEqual(briefs(cleared), [['attendance', 'Student 01, Alpha', 'Attendance 2026-09-03', 'Absent', '']]);
  });

  test('20 mark changes: one summary entry listing the session dates (at most 10, then …)', () => {
    const { c, alpha, bravo } = setup();
    const out = change(c, (co) => {
      for (let i = 0; i < 10; i++) { mark(co, alpha, i, 'P'); mark(co, bravo, i, 'A'); }
    });
    assert.equal(out.length, 1);
    const e = out[0];
    assert.equal(e.kind, 'attendance');
    assert.equal(e.studentId, null);
    assert.equal(e.field, 'Attendance');
    assert.equal(e.newValue, '20 marks changed');
    assert.equal(e.note, 'Sessions: 2026-09-03, 2026-09-08, 2026-09-10, 2026-09-15, 2026-09-17, 2026-09-22, 2026-09-24, 2026-09-29, 2026-10-01, 2026-10-06; 2 students');
    const more = change(c, (co) => { for (let i = 0; i < 12; i++) mark(co, alpha, i, 'E'); });
    assert.equal(more.length, 1);
    assert.equal(more[0].newValue, '12 marks changed');
    assert.match(more[0].note, /2026-10-06, …; 1 student$/);
  });

  test('the limit is 5: 5 changes are itemized, 6 are summarized', () => {
    const a = setup();
    assert.equal(change(a.c, (co) => { for (let i = 0; i < 5; i++) mark(co, a.alpha, i, 'A'); }).length, 5);
    const b = setup();
    assert.equal(change(b.c, (co) => { for (let i = 0; i < 6; i++) mark(co, b.alpha, i, 'A'); }).length, 1);
  });

  test('totals mode counts and attendance settings', () => {
    const { c, alpha } = setup();
    const out = change(c, (co) => {
      co.attendance.mode = 'totals';
      co.attendance.unexcusedThreshold = 4;
      co.attendance.totalAbsenceThreshold = 6;
      co.attendance.excusedCountsTowardStreak = true;
      co.attendance.totals[alpha.id] = { absent: 2, excused: 1 };
    });
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Attendance mode', 'Per session', 'Totals only'],
      ['settings', '', 'Unexcused-absence threshold', '3', '4'],
      ['settings', '', 'Total-absence threshold', 'off', '6'],
      ['settings', '', 'Excused absences count toward a streak', 'no', 'yes'],
      ['attendance', 'Student 01, Alpha', 'Absences (totals)', '', '2'],
      ['attendance', 'Student 01, Alpha', 'Excused (totals)', '', '1']
    ]);
  });

  test('sessions added, relabeled and removed; many session changes become one summary', () => {
    const { c } = setup();
    let out = change(c, (co) => {
      co.attendance.sessions.push({ id: 'ses_20261210', date: '2026-12-10', label: 'Review' });
      co.attendance.sessions[0].label = 'First day';
    });
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Session 2026-09-03', '2026-09-03', '2026-09-03 (First day)'],
      ['settings', '', 'Session 2026-12-10', '', '2026-12-10 (Review)']
    ]);
    out = change(c, (co) => { co.attendance.sessions.splice(1, 1); });
    assert.deepEqual(briefs(out), [['settings', '', 'Session 2026-09-08', '2026-09-08', '']]);
    out = change(c, (co) => { co.attendance.sessions = []; });
    assert.equal(out.length, 1);
    assert.equal(out[0].field, 'Sessions');
    assert.equal(out[0].newValue, '0 sessions');
  });
});

// ================================================================ order and determinism

describe('deterministic order', () => {
  function bigChange(c, s) {
    c.settings.curve = 1;                                                    // settings
    c.assessments.push(model.createAssessment({ id: 'a_x', name: 'Quiz', weight: 0 })); // assessments
    c.placeholders.curve = { confirmed: true, confirmedAt: TS };              // placeholders
    c.teams.push(model.createTeam('Team 3', 't_3'));                          // teams
    addStudent(c, 'Student 00', 'Zulu', { id: 's_new' });                     // students: added
    model.findStudent(c, s.bravo.id).status = 'withdrawn';                    // students: status
    model.setTeamScore(c, s.t2.id, P1, { value: 81 });                        // team scores (+ propagation)
    score(c, s.echo, T2, '55');                                               // individual entries
    mark(c, s.alpha, 3, 'A');                                                 // attendance
  }

  test('groups: settings, assessments, placeholders, teams, students, team scores, entries, propagation, attendance', () => {
    const s = setup();
    const out = change(s.c, (co) => bigChange(co, s));
    assert.deepEqual(briefs(out), [
      ['settings', '', 'Curve (points added to the total)', '0', '1'],
      ['settings', '', 'Assessment', '', 'Quiz (weight 0%, max 100)'],
      ['settings', '', 'Confirmation: Curve', 'needs confirmation', 'confirmed'],
      ['team-membership', 'Team 3', 'Team', '', 'Team 3'],
      ['student', 'Student 00, Zulu', 'Student', '', 'Added'],
      ['status', 'Student 02, Bravo', 'Status', 'Active', 'Withdrawn'],
      ['team-score', 'Team 2', 'Project I', '80', '81'],
      ['score', 'Student 05, Echo', 'Test 2', '', '55'],
      ['propagation', 'Student 04, Delta', 'Project I', '80', '81'],
      ['attendance', 'Student 01, Alpha', 'Attendance 2026-09-15', '', 'Absent']
    ]);
  });

  test('same input, same entries; storage order of students does not matter (name order)', () => {
    const s = setup();
    const before = snap(s.c);
    bigChange(s.c, s);
    const strip = (list) => list.map((e) => Object.assign({}, e, { id: '' }));
    const a = strip(diff(before, s.c));
    const b = strip(diff(before, s.c));
    assert.deepEqual(a, b);
    // Students are kept in storage order; the log follows name order whatever that order is.
    const shuffled = util.clone(s.c);
    shuffled.students.reverse();
    const beforeShuffled = util.clone(before);
    beforeShuffled.students.reverse();
    assert.deepEqual(strip(diff(beforeShuffled, shuffled)), a);
  });

  test('several students and assessments: assessment order, then student name order', () => {
    const { c, alpha, echo, delta } = setup();
    const out = change(c, (co) => {
      score(co, echo, T2, '1');
      score(co, delta, T1, '2');
      score(co, alpha, T2, '3');
      score(co, echo, T1, '4');
    });
    assert.deepEqual(briefs(out), [
      ['score', 'Student 04, Delta', 'Test 1', '', '2'],
      ['score', 'Student 05, Echo', 'Test 1', '70', '4'],
      ['score', 'Student 01, Alpha', 'Test 2', '', '3'],
      ['score', 'Student 05, Echo', 'Test 2', '', '1']
    ]);
  });
});

// ================================================================ robustness

describe('robustness (never throws, partial courses)', () => {
  test('null, undefined, empty and garbage input', () => {
    assert.deepEqual(history.diffCourse(null, undefined), []);
    assert.deepEqual(history.diffCourse({}, {}), []);
    assert.deepEqual(history.diffCourse('x', 42, 'opts'), []);
    const garbage = {
      assessments: [null, 5, { id: 'a' }, { id: 'a', name: 'dup' }, { name: 'no id' }],
      teams: 'teams', students: [{ id: 's', lastName: 7 }, { id: 's' }, [], null],
      scores: { s: 'x', t: null, __proto__: null }, teamScores: 5,
      settings: { letterScale: 'A' }, attendance: { sessions: [{ id: 'ses', date: 3 }], records: { s: { ses: 'Z' } }, totals: [] },
      placeholders: null
    };
    assert.doesNotThrow(() => history.diffCourse(garbage, {}));
    assert.doesNotThrow(() => history.diffCourse({}, garbage));
    assert.doesNotThrow(() => history.diffCourse(garbage, garbage));
    assert.deepEqual(history.diffCourse(garbage, util.clone(garbage)), []);
  });

  test('partially shaped courses (missing maps) still produce entries', () => {
    const before = { assessments: [{ id: 'a', name: 'Quiz', maxScore: 10, weight: 5 }], students: [{ id: 's', lastName: 'Student 01', firstName: 'Alpha' }] };
    const after = util.clone(before);
    after.scores = { s: { a: { value: 7 } } };
    const out = diff(before, after);
    assert.deepEqual(briefs(out), [['score', 'Student 01, Alpha', 'Quiz', '', '7']]);
  });

  test('an unexpected failure in one group loses only that group', () => {
    const { c, alpha } = setup();
    const before = snap(c);
    score(c, alpha, T2, '50');
    c.settings.curve = 3;
    // A settings object whose property read throws.
    Object.defineProperty(c.settings, 'decimals', { get() { throw new Error('boom'); }, enumerable: true, configurable: true });
    const out = diff(before, c);
    assert.ok(out.some((e) => e.kind === 'score' && e.newValue === '50'), 'the score is still logged');
    assert.ok(out.some((e) => e.fieldKey === 'history.error' && /boom/.test(e.note)));
  });

  test('loading the sample data (and taking it away) diffs without errors', () => {
    ['SE4351', 'SE6362'].forEach((tpl) => {
      const c = model.createCourse(tpl);
      const empty = snap(c);
      sample.loadInto(c);
      const loaded = snap(c);
      const out = diff(empty, loaded);
      assert.ok(out.length > 0);
      assert.ok(!out.some((e) => e.fieldKey === 'history.error'));
      const back = diff(loaded, empty, { source: 'undo' });
      assert.ok(back.some((e) => e.newValue === 'Deleted permanently'));
      assert.ok(!back.some((e) => e.fieldKey === 'history.error'));
      [...out, ...back].forEach((e) => assert.ok(history.KINDS.includes(e.kind)));
    });
  });

  test('propagation agrees with calc.scoreDetail for every team member after a team edit on sample data', () => {
    const c = model.createCourse('SE4351');
    sample.loadInto(c);
    const before = snap(c);
    const team = c.teams[0];
    model.setTeamScore(c, team.id, P2, { value: 12 });
    const out = diff(before, c);
    const prop = out.filter((e) => e.kind === 'propagation').map((e) => e.studentId).sort();
    const a = model.findAssessment(c, P2);
    const expected = c.students.filter((s) => {
      const b = model.findStudent(before, s.id);
      return calc.scoreDetail(before, b, a).raw !== calc.scoreDetail(c, s, a).raw;
    }).map((s) => s.id).sort();
    assert.deepEqual(prop, expected);
    assert.equal(out.filter((e) => e.kind === 'team-score').length, 1);
  });
});

// ================================================================ bulkEntry, displayValue, toRows, kindGroup

describe('bulkEntry, displayValue, toRows', () => {
  test('bulkEntry', () => {
    const e = history.bulkEntry({ ts: TS, source: 'sample', field: 'Load sample data', note: 'fake data' });
    assert.deepEqual(Object.keys(e).sort(), SHAPE);
    assert.equal(e.kind, 'bulk');
    assert.equal(e.ts, TS);
    assert.equal(e.source, 'sample');
    assert.equal(e.field, 'Load sample data');
    assert.equal(e.note, 'fake data');
    assert.equal(e.studentId, null);
    assert.equal(e.oldValue, '');
    assert.equal(e.newValue, '');
    assert.match(e.id, /^h_/);
  });

  test('displayValue', () => {
    const a = { id: 'a', maxScore: 100 };
    assert.equal(history.displayValue(null), '');
    assert.equal(history.displayValue({ value: null }), '');
    assert.equal(history.displayValue({ value: 88.5 }), '88.5');
    assert.equal(history.displayValue({ value: 0 }), '0');
    assert.equal(history.displayValue({ value: -3 }), '-3');
    assert.equal(history.displayValue({ value: null, text: '8o' }), '"8o" (not a number)');
    assert.equal(history.displayValue(true), 'yes');
    assert.equal(history.displayValue(false), 'no');
    assert.equal(history.displayValue(12), '12');
    assert.equal(history.displayValue({ value: 80, weeksLate: 1 }), '80');
    assert.equal(history.displayValue({ value: 80, weeksLate: 1 }, a), '80 (1 week late)');
    assert.equal(history.displayValue({ value: 80, weeksLate: 2, waived: true }, a), '80 (2 weeks late, penalty waived)');
    assert.equal(history.displayValue({ value: null, weeksLate: 1 }, a), '(1 week late)');
    // A calc.scoreDetail result.
    const c = model.createCourse('SE4351');
    const s = addStudent(c, 'Student 01', 'Alpha');
    score(c, s, T1, 'abc');
    assert.equal(history.displayValue(calc.scoreDetail(c, s, model.findAssessment(c, T1))), '"abc" (not a number)');
    score(c, s, T1, '91');
    assert.equal(history.displayValue(calc.scoreDetail(c, s, model.findAssessment(c, T1))), '91');
    assert.equal(history.displayValue(calc.scoreDetail(c, s, model.findAssessment(c, T2))), '');
  });

  test('toRows: header plus one row per entry, user notes kept', () => {
    const { c, alpha } = setup();
    const out = change(c, (co) => score(co, alpha, T1, '85'));
    out[0].userNote = 'per instructor email, Oct 12';
    out[0].userNoteAt = '2026-10-12T16:00:00.000Z';
    const rows = history.toRows(out.concat([null, history.bulkEntry({ ts: TS, source: 'sample', field: 'Load sample data' })]));
    assert.deepEqual(rows[0], ['Timestamp (ISO)', 'Source', 'Kind', 'Student', 'Team', 'Field', 'Old value', 'New value', 'Note', 'User note', 'User note time (ISO)']);
    assert.deepEqual(rows[1], [TS, 'edit', 'score', 'Student 01, Alpha', 'Team 1', 'Test 1', '84', '85', '', 'per instructor email, Oct 12', '2026-10-12T16:00:00.000Z']);
    assert.deepEqual(rows[2], [TS, 'sample', 'bulk', '', '', 'Load sample data', '', '', '', '', '']);
    assert.equal(rows.length, 3);
    assert.deepEqual(history.toRows(undefined), [rows[0]]);
  });

  test('kindGroup matches the History view filter groups', () => {
    ['score', 'team-score', 'propagation', 'override', 'override-removed', 'late', 'final-letter'].forEach((k) => assert.equal(history.kindGroup(k), 'grades'));
    ['status', 'team-membership', 'student'].forEach((k) => assert.equal(history.kindGroup(k), 'students'));
    assert.equal(history.kindGroup('settings'), 'settings');
    assert.equal(history.kindGroup('attendance'), 'attendance');
    assert.equal(history.kindGroup('bulk'), 'other');
    assert.equal(history.kindGroup('nonsense'), 'other');
  });
});

// ================================================================ stage 2b: final letters, finalizing, drop-down lists

describe('final letters (STAGE2B)', () => {
  /** Course with 15 students (No 1..15), no teams. */
  function roster(n) {
    const c = model.createCourse('SE4351');
    const list = [];
    for (let i = 1; i <= (n || 15); i++) list.push(addStudent(c, 'Student ' + String(i).padStart(2, '0'), 'X'));
    return { c, list };
  }

  test('the kind is known, labeled and in the grades group', () => {
    assert.ok(history.KINDS.includes('final-letter'));
    assert.equal(history.KIND_LABELS['final-letter'], 'Final letter');
    assert.ok(history.KIND_GROUPS.grades.includes('final-letter'));
    assert.equal(history.LETTER_LIMIT, 10);
  });

  test('one letter set, changed and cleared: kind final-letter, field "Final letter", old and new values', () => {
    const { c, alpha, t1 } = setup();
    let out = change(c, (co) => model.setFinalLetter(co, alpha.id, 'B+'));
    assert.deepEqual(briefs(out), [['final-letter', 'Student 01, Alpha', 'Final letter', '', 'B+']]);
    assert.equal(out[0].studentId, alpha.id);
    assert.equal(out[0].teamId, t1.id);
    assert.equal(out[0].teamName, 'Team 1');
    assert.equal(out[0].fieldKey, 'student.finalLetter');
    assert.deepEqual(Object.keys(out[0]).sort(), SHAPE);
    out = change(c, (co) => model.setFinalLetter(co, alpha.id, 'A-'));
    assert.deepEqual(briefs(out), [['final-letter', 'Student 01, Alpha', 'Final letter', 'B+', 'A-']]);
    out = change(c, (co) => model.setFinalLetter(co, alpha.id, null));
    assert.deepEqual(briefs(out), [['final-letter', 'Student 01, Alpha', 'Final letter', 'A-', '']]);
    // Setting the same letter again logs nothing.
    model.setFinalLetter(c, alpha.id, 'C');
    assert.deepEqual(change(c, (co) => model.setFinalLetter(co, alpha.id, 'C')), []);
  });

  test('a letter change does not log a score or anything else, and undo logs the reverse', () => {
    const { c, bravo } = setup();
    const before = snap(c);
    model.setFinalLetter(c, bravo.id, 'A');
    const after = snap(c);
    assert.deepEqual(kinds(diff(before, after)), ['final-letter']);
    const back = diff(after, before, { source: 'undo' });
    assert.deepEqual(briefs(back), [['final-letter', 'Student 02, Bravo', 'Final letter', 'A', '']]);
    assert.equal(back[0].source, 'undo');
  });

  test('up to 10 changes are itemized in name order', () => {
    const { c, list } = roster(15);
    const out = change(c, (co) => {
      model.setFinalLetters(co, list.slice(0, 10).reverse().map((s) => ({ studentId: s.id, letter: 'A' })));
    });
    assert.equal(out.length, 10);
    assert.ok(out.every((e) => e.kind === 'final-letter' && e.field === 'Final letter' && e.newValue === 'A'));
    assert.deepEqual(out.map((e) => e.studentName), list.slice(0, 10).map((s) => model.studentName(s)));
  });

  test('more than 10 changes in one transaction: one summary "Final letters: n changed" listing up to 10 students by No', () => {
    const { c, list } = roster(15);
    list[14].finalLetter = 'F';
    const out = change(c, (co) => {
      // A band assignment: 4 A, 3 B, 4 C, and one letter cleared.
      const band = (from, to, letter) => list.slice(from, to).map((s) => ({ studentId: s.id, letter }));
      model.setFinalLetters(co, band(0, 4, 'A').concat(band(4, 7, 'B'), band(7, 11, 'C'), band(14, 15, null)));
    });
    assert.equal(out.length, 1);
    const e = out[0];
    assert.equal(e.kind, 'final-letter');
    assert.equal(e.field, 'Final letters');
    assert.equal(e.fieldKey, 'finalLetters');
    assert.equal(e.oldValue, '');
    assert.equal(e.newValue, '12 changed');
    assert.equal(e.studentId, null);
    assert.equal(e.studentName, null);
    assert.equal(e.note, 'Students No 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …; A ×4, B ×3, C ×4, cleared ×1');
    assert.equal(`${e.field}: ${e.newValue}`, 'Final letters: 12 changed');
    // Every student's change is kept (review F4), in name order, beyond the 10 listed in the note.
    assert.deepEqual(Object.keys(e).sort(), SHAPE.concat('details').sort());
    const changed = list.slice(0, 11).concat(list[14]);
    assert.deepEqual(e.details, changed.map((s, i) => ({
      studentId: s.id, studentName: model.studentName(s), no: s.no,
      oldValue: i === 11 ? 'F' : '', newValue: i < 4 ? 'A' : i < 7 ? 'B' : i < 11 ? 'C' : ''
    })));
  });

  test('a band summary stays traceable per student: involvesStudent, detailFor, entryDetails (review F4)', () => {
    const { c, list } = roster(15);
    const out = change(c, (co) => model.setFinalLetters(co, list.slice(0, 12).map((s) => ({ studentId: s.id, letter: 'A' }))));
    assert.equal(out.length, 1);
    const e = out[0];
    // The 12th student is not in the note, but the entry still concerns them.
    assert.equal(e.note, 'Students No 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …; A ×12');
    assert.equal(history.involvesStudent(e, list[11].id), true);
    assert.deepEqual(history.detailFor(e, list[11].id),
      { studentId: list[11].id, studentName: 'Student 12, X', no: 12, oldValue: '', newValue: 'A' });
    assert.equal(history.involvesStudent(e, list[12].id), false);
    assert.equal(history.detailFor(e, list[12].id), null);
    assert.equal(history.entryDetails(e).length, 12);
    // Undo logs the reverse, with the same details.
    const cleared = snap(c);
    cleared.students.forEach((s) => { s.finalLetter = null; });
    const back = diff(snap(c), cleared, { source: 'undo' });
    assert.equal(back.length, 1);
    assert.equal(history.detailFor(back[0], list[11].id).oldValue, 'A');
    assert.equal(history.detailFor(back[0], list[11].id).newValue, '');
    // Itemized entries match by their own studentId; they carry no details.
    const one = change(c, (co) => model.setFinalLetter(co, list[0].id, 'B'))[0];
    assert.equal(history.involvesStudent(one, list[0].id), true);
    assert.equal(history.involvesStudent(one, list[1].id), false);
    assert.deepEqual(history.entryDetails(one), []);
    assert.equal(history.detailFor(one, list[0].id), null);
  });

  test('details are read defensively (saved files may hold anything)', () => {
    const e = { studentId: null, details: [null, 5, 'x', [], { studentId: '' }, { studentId: 7 },
      { studentId: 's1', studentName: 3, no: 'No 1', oldValue: null, newValue: 'A' }, { studentId: 's2', no: NaN }] };
    assert.deepEqual(history.entryDetails(e), [
      { studentId: 's1', studentName: '3', no: null, oldValue: '', newValue: 'A' },
      { studentId: 's2', studentName: '', no: null, oldValue: '', newValue: '' }
    ]);
    assert.equal(history.involvesStudent(e, 's2'), true);
    assert.equal(history.involvesStudent(e, ''), false);
    assert.equal(history.involvesStudent(e, null), false);
    [null, undefined, 5, 'x', [], {}, { details: 'no' }, { details: { studentId: 's1' } }].forEach((x) => {
      assert.deepEqual(history.entryDetails(x), []);
      assert.equal(history.involvesStudent(x, 's1'), false);
      assert.equal(history.detailFor(x, 's1'), null);
    });
    assert.equal(history.involvesStudent({ studentId: 's9' }, 's9'), true);
  });

  test('toRows adds one row per student after a band summary; { studentId } keeps only that student (review F4)', () => {
    const { c, list } = roster(12);
    list[0].finalLetter = 'B';
    const out = change(c, (co) => model.setFinalLetters(co, list.map((s) => ({ studentId: s.id, letter: 'A' }))));
    out[0].userNote = 'meeting with Dr. X';
    out[0].userNoteAt = '2026-12-10T16:00:00.000Z';
    const rows = history.toRows(out);
    assert.equal(rows.length, 1 + 1 + 12);
    assert.deepEqual(rows[1], [TS, 'edit', 'final-letter', '', '', 'Final letters', '', '12 changed',
      'Students No 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …; A ×12', 'meeting with Dr. X', '2026-12-10T16:00:00.000Z']);
    assert.deepEqual(rows[2], [TS, 'edit', 'final-letter', 'Student 01, X', '', 'Final letter', 'B', 'A', 'Part of "Final letters: 12 changed"', '', '']);
    assert.deepEqual(rows[13], [TS, 'edit', 'final-letter', 'Student 12, X', '', 'Final letter', '', 'A', 'Part of "Final letters: 12 changed"', '', '']);
    const mine = history.toRows(out, { studentId: list[11].id });
    assert.equal(mine.length, 3);
    assert.deepEqual(mine[2], rows[13]);
    // A filter for a student outside the band keeps the summary row only; odd opts are ignored.
    assert.equal(history.toRows(out, { studentId: 'nobody' }).length, 2);
    assert.equal(history.toRows(out, { studentId: 5 }).length, 14);
    assert.equal(history.toRows(out, 'x').length, 14);
  });

  test('exactly 11 changes are summarized; students are listed by No, not by storage order', () => {
    const { c, list } = roster(11);
    c.students.reverse();
    const out = change(c, (co) => { list.forEach((s) => { s.finalLetter = 'B'; }); });
    assert.equal(out.length, 1);
    assert.equal(out[0].newValue, '11 changed');
    assert.equal(out[0].note, 'Students No 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …; B ×11');
  });

  test('the summary counts letters outside the scale after the scale letters', () => {
    const { c, list } = roster(12);
    const out = change(c, (co) => {
      list.forEach((s, i) => { s.finalLetter = i < 6 ? 'W' : 'A-'; });
    });
    assert.equal(out[0].note, 'Students No 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …; A- ×6, W ×6');
  });

  test('added and deleted students are covered by their own entries, not by final-letter entries', () => {
    const { c, alpha } = setup();
    alpha.finalLetter = 'B';
    const out = change(c, (co) => {
      co.students.push(model.createStudent({ lastName: 'Student 09', firstName: 'India', finalLetter: 'A' }));
      model.deleteStudent(co, alpha.id);
    });
    assert.ok(!out.some((e) => e.kind === 'final-letter'));
    assert.deepEqual(kinds(out).filter((k) => k === 'student'), ['student', 'student']);
    // Their notes say which final letter was deleted or came back (review F4).
    const added = out.find((e) => e.newValue === 'Added');
    const deleted = out.find((e) => e.newValue === 'Deleted permanently');
    assert.equal(added.note, 'final letter A');
    assert.equal(deleted.studentId, alpha.id);
    assert.equal(deleted.note, 'No 1, Team 1. Scores, overrides, attendance and the final letter (B) were deleted with the student');
    // Undoing the deletion brings the letter back, and the note says so.
    const restored = snap(c);
    restored.students.push(util.clone(alpha));
    const back = diff(snap(c), restored, { source: 'undo' });
    assert.equal(back.find((e) => e.newValue === 'Added').note, 'No 1, Team 1, final letter B');
  });

  test('a deleted student without a final letter keeps the usual note', () => {
    const { c, echo } = setup();
    const out = change(c, (co) => model.deleteStudent(co, echo.id));
    assert.equal(out[0].note, 'No 5. Scores, overrides and attendance were deleted with the student');
  });

  test('a scale change that leaves a letter outside the scale does not rewrite the letter or log it', () => {
    const { c, alpha } = setup();
    alpha.finalLetter = 'A+';
    const out = change(c, (co) => { co.settings.letterScale = model.defaultLetterScale('graduate'); });
    assert.ok(!out.some((e) => e.kind === 'final-letter'));
    assert.equal(alpha.finalLetter, 'A+');
  });

  test('odd stored letters (numbers, blanks) read as empty and never throw', () => {
    const before = { students: [{ id: 's', lastName: 'Student 01', finalLetter: 5 }] };
    const after = { students: [{ id: 's', lastName: 'Student 01', finalLetter: '  ' }] };
    assert.deepEqual(diff(before, after), []);
    after.students[0].finalLetter = 'C';
    assert.deepEqual(briefs(diff(before, after)), [['final-letter', 'Student 01', 'Final letter', '', 'C']]);
  });
});

describe('finalizing the scores (STAGE2B)', () => {
  // Noon UTC is the same calendar day in every time zone from UTC-11 to UTC+11.
  const AT = '2026-12-10T12:00:00.000Z';

  test('finalize: kind settings, field "Scores finalized", no -> yes (date), with the note', () => {
    const { c } = setup();
    const out = change(c, (co) => model.finalize(co, AT, 'Grading meeting'));
    assert.deepEqual(briefs(out), [['settings', '', 'Scores finalized', 'no', 'yes (2026-12-10)']]);
    assert.equal(out[0].fieldKey, 'course.finalized');
    assert.equal(out[0].note, 'Score cells locked; final letters stay editable. Note: Grading meeting');
  });

  test('unfinalize: yes (date) -> no, noted as unlocked', () => {
    const { c } = setup();
    model.finalize(c, AT, '');
    const out = change(c, (co) => model.unfinalize(co));
    assert.deepEqual(briefs(out), [['settings', '', 'Scores finalized', 'yes (2026-12-10)', 'no']]);
    assert.equal(out[0].note, 'Score cells unlocked: scores can be edited again');
  });

  test('finalizing again (new date or note) is logged; nothing changed logs nothing', () => {
    const { c } = setup();
    model.finalize(c, AT, '');
    assert.deepEqual(change(c, (co) => { co.finalized = { at: AT, note: '' }; }), []);
    let out = change(c, (co) => model.finalize(co, '2026-12-11T12:00:00.000Z', ''));
    assert.deepEqual(briefs(out), [['settings', '', 'Scores finalized', 'yes (2026-12-10)', 'yes (2026-12-11)']]);
    out = change(c, (co) => model.finalize(co, '2026-12-11T12:00:00.000Z', 'second meeting'));
    assert.equal(out.length, 1);
    assert.match(out[0].note, /Note: second meeting$/);
  });

  test('finalizing with letters copied in one transaction logs both, settings first', () => {
    const { c, alpha, bravo } = setup();
    const out = change(c, (co) => {
      model.finalize(co, AT, '');
      model.setFinalLetters(co, [{ studentId: alpha.id, letter: 'B' }, { studentId: bravo.id, letter: 'C' }]);
    });
    assert.deepEqual(kinds(out), ['settings', 'final-letter', 'final-letter']);
  });

  test('a malformed finalized value reads as not finalized', () => {
    assert.deepEqual(diff({ finalized: { at: '' } }, { finalized: 'yes' }), []);
    const out = diff({ finalized: 7 }, { finalized: { at: 'not a date' } });
    assert.deepEqual(briefs(out), [['settings', '', 'Scores finalized', 'no', 'yes (not a date)']]);
  });
});

describe('drop-down lists and participation out of 5 (DECISIONS 1, 8)', () => {
  test('turning a list off and on: "<name>: drop-down list"', () => {
    const { c } = setup();
    let out = change(c, (co) => { model.findAssessment(co, PART).choices = null; });
    assert.deepEqual(briefs(out), [['settings', '', 'Class/Project Participation: drop-down list', 'yes (steps of 0.5)', 'no']]);
    assert.equal(out[0].fieldKey, 'assessment:' + PART + '.choices');
    assert.equal(out[0].note, 'Scores are typed in freely');
    out = change(c, (co) => { model.findAssessment(co, T1).choices = { step: 5 }; });
    assert.deepEqual(briefs(out), [['settings', '', 'Test 1: drop-down list', 'no', 'yes (steps of 5)']]);
    assert.equal(out[0].note, 'Scores are chosen from a list (max down to 0)');
  });

  test('changing the step is logged; an equal list is not', () => {
    const { c } = setup();
    assert.deepEqual(change(c, (co) => { model.findAssessment(co, PART).choices = { step: 0.5 }; }), []);
    const out = change(c, (co) => { model.findAssessment(co, PART).choices = { step: 1 }; });
    assert.deepEqual(briefs(out), [['settings', '', 'Class/Project Participation: drop-down list', 'yes (steps of 0.5)', 'yes (steps of 1)']]);
  });

  test('a participation score typed out of 5 is logged as entered', () => {
    const { c, echo } = setup();
    const out = change(c, (co) => score(co, echo, PART, '4.5'));
    assert.deepEqual(briefs(out), [['score', 'Student 05, Echo', 'Class/Project Participation', '', '4.5']]);
  });

  test('an added or removed assessment with a list says so', () => {
    const { c } = setup();
    let out = change(c, (co) => { co.assessments.push(model.createAssessment({ id: 'a_q', name: 'Quiz', maxScore: 10, weight: 0, choices: { step: 1 } })); });
    assert.deepEqual(briefs(out), [['settings', '', 'Assessment', '', 'Quiz (weight 0%, max 10, drop-down list in steps of 1)']]);
    out = change(c, (co) => model.removeAssessment(co, PART));
    assert.deepEqual(briefs(out), [['settings', '', 'Assessment', 'Class/Project Participation (weight 5%, max 5, drop-down list in steps of 0.5)', '']]);
  });
});

describe('stage 2b robustness', () => {
  test('many letter changes with a garbage letter scale still give one summary and no error entry', () => {
    const students = [];
    for (let i = 1; i <= 12; i++) students.push({ id: 's' + i, no: i, lastName: 'Student ' + i });
    [[null, 5, { letter: 'A', min: 90 }], 'A', null].forEach((scale) => {
      const before = { settings: { letterScale: scale }, students };
      const after = util.clone(before);
      after.students.forEach((s) => { s.finalLetter = 'A'; });
      const out = diff(before, after);
      assert.ok(!out.some((e) => e.fieldKey === 'history.error'), JSON.stringify(out));
      assert.deepEqual(briefs(out), [['final-letter', '', 'Final letters', '', '12 changed']]);
      assert.equal(out[0].note, 'Students No 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …; A ×12');
    });
  });

  test('a summary for students without a No names only how many there are', () => {
    const students = [];
    for (let i = 1; i <= 11; i++) students.push({ id: 's' + i, lastName: 'Student ' + i });
    const after = util.clone({ students });
    after.students.forEach((s) => { s.finalLetter = 'B'; });
    const out = diff({ students }, after);
    assert.equal(out[0].note, '11 students; B ×11');
  });
});

describe('a roll call folded into one entry (GT.store.transact mergeKey, review CODE-6)', () => {
  const entry = {
    id: 'h1', ts: TS, source: 'edit', kind: 'attendance', studentId: null, studentName: null, teamId: null, teamName: null,
    field: 'Roll call Tue Oct 6', fieldKey: 'attendance', oldValue: '', newValue: '3 marks', note: '2 students', mergeKey: 'rollcall:s:1',
    details: [
      { studentId: 's1', studentName: 'Student 01, A', no: 1, field: 'Attendance 2026-10-06', oldValue: '', newValue: 'Present' },
      { studentId: 's2', studentName: 'Student 02, B', no: 2, field: 'Attendance 2026-10-06', oldValue: '', newValue: 'Absent' },
      { studentId: 's1', studentName: 'Student 01, A', no: 1, field: 'Attendance 2026-10-06', oldValue: 'Present', newValue: 'Excused' }
    ]
  };

  test('entryDetails keeps each item\'s own field; items without one are unchanged', () => {
    const list = history.entryDetails(entry);
    assert.equal(list.length, 3);
    assert.deepEqual(list[1], { studentId: 's2', studentName: 'Student 02, B', no: 2, oldValue: '', newValue: 'Absent', field: 'Attendance 2026-10-06' });
    assert.equal('field' in history.entryDetails({ details: [{ studentId: 's1', field: 7 }] })[0], false);
    assert.equal('field' in history.entryDetails({ details: [{ studentId: 's1', field: '' }] })[0], false);
  });

  test('detailFor gives one change per student: the first old value and the last new value', () => {
    assert.deepEqual(history.detailFor(entry, 's1'),
      { studentId: 's1', studentName: 'Student 01, A', no: 1, oldValue: '', newValue: 'Excused', field: 'Attendance 2026-10-06' });
    assert.equal(history.detailFor(entry, 's2').newValue, 'Absent');
    assert.equal(history.detailFor(entry, 's3'), null);
    assert.equal(history.involvesStudent(entry, 's2'), true);
  });

  test('toRows: one row per mark after the summary, with the mark\'s own field', () => {
    const rows = history.toRows([entry]);
    assert.equal(rows.length, 1 + 1 + 3);
    assert.deepEqual(rows[1].slice(0, 9), [TS, 'edit', 'attendance', '', '', 'Roll call Tue Oct 6', '', '3 marks', '2 students']);
    assert.deepEqual(rows[4], [TS, 'edit', 'attendance', 'Student 01, A', '', 'Attendance 2026-10-06', 'Present', 'Excused',
      'Part of "Roll call Tue Oct 6: 3 marks"', '', '']);
    assert.equal(history.toRows([entry], { studentId: 's2' }).length, 1 + 1 + 1);
  });
});
