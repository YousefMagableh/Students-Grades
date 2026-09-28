'use strict';
/* Spec-derived tests for js/core/calc.js (DESIGN.md section 3; REQUIREMENTS K1-K8, S2, G3, V1).
 * Every expected number is computed by hand in the comments. Fake data only. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../js/core/util.js');
const model = require('../js/core/model.js');
const calc = require('../js/core/calc.js');

// ---------------------------------------------------------------- helpers

const P1 = 'a_p1', P2 = 'a_p2', T1 = 'a_t1', T2 = 'a_t2', PART = 'a_part', PAPER = 'a_paper';
const FIVE = [P1, P2, T1, T2, PART];

function course(template) { return model.createCourse(template || 'SE4351'); }
function addTeam(c, name) { const t = model.createTeam(name); c.teams.push(t); return t; }
function addStudent(c, lastName, firstName, extra) {
  const s = model.createStudent(Object.assign({ lastName, firstName, no: c.students.length + 1 }, extra || {}));
  c.students.push(s);
  return s;
}
function setScore(c, s, aid, value, extra) { model.setEntry(c.scores, s.id, aid, Object.assign({ value }, extra || {})); }
function setTeamScore(c, t, aid, value, extra) { model.setEntry(c.teamScores, t.id, aid, Object.assign({ value }, extra || {})); }
function asmt(c, aid) { return model.findAssessment(c, aid); }
function detail(c, s, aid) { return calc.scoreDetail(c, s, asmt(c, aid)); }
/** Sets the same percentage v on all five default items (student without a team, so team items are
 * individual): v itself on the max-100 items, and v / 20 on Class/Project Participation, which is out
 * of 5 (DECISIONS 1). With the default weights summing to 100, the total equals v. */
function fillAll(c, s, v) {
  FIVE.forEach((aid) => setScore(c, s, aid, util.fix(v * asmt(c, aid).maxScore / 100)));
}
/** Student (no team) with the given raw scores: { a_t1: 84.1, ... }. */
function studentWith(c, scores, name) {
  const s = addStudent(c, name || 'Student 01', 'Alpha');
  Object.keys(scores).forEach((aid) => setScore(c, s, aid, scores[aid]));
  return s;
}
function near(actual, expected, eps) {
  assert.ok(Math.abs(actual - expected) < (eps || 1e-9), `expected ${actual} to be close to ${expected}`);
}
const ids = (list) => list.map((s) => s.id);

// Hand-written letter tables (REQUEST.md): [letter, cutoff, next lower letter].
const UG_CUTS = [
  ['A+', 97, 'A'], ['A', 93, 'A-'], ['A-', 90, 'B+'], ['B+', 87, 'B'], ['B', 83, 'B-'], ['B-', 80, 'C+'],
  ['C+', 77, 'C'], ['C', 73, 'C-'], ['C-', 70, 'D+'], ['D+', 67, 'D'], ['D', 63, 'D-'], ['D-', 60, 'F']
];
const GRAD_CUTS = [
  ['A', 93, 'A-'], ['A-', 90, 'B+'], ['B+', 87, 'B'], ['B', 83, 'B-'], ['B-', 80, 'C+'], ['C+', 77, 'C'], ['C', 70, 'F']
];

// ================================================================ MANDATORY 1: the 74.0 example

describe('74.0 example (V1): Project I 90, Project II 85, Test 1 80, Test 2 70, Participation 0', () => {
  function build(template, participation) {
    const c = course(template);
    const team = addTeam(c, 'Team 1');
    const s = addStudent(c, 'Student 01', 'Alpha', { teamId: team.id });
    setTeamScore(c, team, P1, 90);
    setTeamScore(c, team, P2, 85);
    setScore(c, s, T1, 80);
    setScore(c, s, T2, 70);
    if (participation !== undefined) setScore(c, s, PART, participation);
    return { c, s };
  }

  test('74.0 example: SE 4351 total is exactly 74 with weighted items 9, 17, 20, 28, 0 and not incomplete', () => {
    const { c, s } = build('SE4351', 0);
    const r = calc.studentResult(c, s);
    // 90/100*10 = 9; 85/100*20 = 17; 80/100*25 = 20; 70/100*40 = 28; 0/5*5 = 0; sum = 74.
    // Participation is out of 5 (DECISIONS 1), and 0 is 0 on any scale.
    assert.equal(asmt(c, PART).maxScore, 5);
    assert.equal(r.items[PART].raw, 0);
    assert.equal(r.items[PART].notOnList, false); // 0 is on the drop-down list
    assert.equal(r.items[P1].weighted, 9);
    assert.equal(r.items[P2].weighted, 17);
    assert.equal(r.items[T1].weighted, 20);
    assert.equal(r.items[T2].weighted, 28);
    assert.equal(r.items[PART].weighted, 0);
    assert.equal(r.items[P1].source, 'team');
    assert.equal(r.items[P2].source, 'team');
    assert.equal(r.weightedSum, 74);
    assert.equal(r.totalUnrounded, 74);
    assert.equal(r.total, 74);
    assert.equal(util.formatNumber(r.total, 1, { fixed: true }), '74.0');
    assert.equal(r.incomplete, false);
    assert.equal(r.missingCount, 0);
    assert.equal(r.letter, 'C'); // 73 <= 74 < 77 on the undergraduate scale
  });

  test('74.0 example: same total through computeCourse', () => {
    const { c, s } = build('SE4351', 0);
    const res = calc.computeCourse(c);
    assert.equal(res.byId[s.id].total, 74);
    assert.equal(res.average, 74);
  });

  test('74.0 example with Participation empty: total 74 and incomplete', () => {
    const { c, s } = build('SE4351', undefined);
    const r = calc.studentResult(c, s);
    assert.equal(r.items[PART].weighted, 0);
    assert.equal(r.items[PART].missing, true);
    assert.equal(r.items[PART].state, 'empty');
    assert.equal(r.total, 74);
    assert.equal(r.incomplete, true);
    assert.equal(r.missingCount, 1);
  });

  test('74.0 example on SE 6362: the weight-0 Term Paper left empty does not make it incomplete', () => {
    const { c, s } = build('SE6362', 0);
    const r = calc.studentResult(c, s);
    assert.equal(r.items[PAPER].weighted, 0);
    assert.equal(r.total, 74);
    assert.equal(r.incomplete, false);
    assert.equal(r.letter, 'C'); // graduate: 70 <= 74 < 77
  });
});

// ================================================================ MANDATORY 2: team propagation with an override

describe('team propagation with a per-member override (K5)', () => {
  test('team propagation with a per-member override: team score, override, team change, override removal', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    const d = addStudent(c, 'Student 03', 'Charlie', { teamId: t.id });

    // Team Project I = 88 -> every member 88, weighted 88/100*10 = 8.8.
    setTeamScore(c, t, P1, 88);
    [a, b, d].forEach((s) => {
      const x = detail(c, s, P1);
      assert.equal(x.raw, 88);
      assert.equal(x.source, 'team');
      assert.equal(x.override, false);
      assert.equal(x.weighted, 8.8);
      assert.equal(x.teamId, t.id);
    });

    // Override Bravo to 80 -> Bravo 80 (weighted 8.0), others still 88.
    setScore(c, b, P1, 80, { override: true });
    let xb = detail(c, b, P1);
    assert.equal(xb.raw, 80);
    assert.equal(xb.source, 'override');
    assert.equal(xb.override, true);
    assert.equal(xb.weighted, 8);
    assert.equal(calc.studentResult(c, b).overrideCount, 1);
    [a, d].forEach((s) => {
      assert.equal(detail(c, s, P1).raw, 88);
      assert.equal(detail(c, s, P1).weighted, 8.8);
    });

    // Team score changes to 90 -> others 90 (weighted 9.0), Bravo keeps 80.
    setTeamScore(c, t, P1, 90);
    [a, d].forEach((s) => {
      const x = detail(c, s, P1);
      assert.equal(x.raw, 90);
      assert.equal(x.source, 'team');
      assert.equal(x.weighted, 9);
    });
    xb = detail(c, b, P1);
    assert.equal(xb.raw, 80);
    assert.equal(xb.source, 'override');
    assert.equal(xb.weighted, 8);

    // Remove the override -> Bravo follows the team again: 90.
    model.setEntry(c.scores, b.id, P1, null);
    xb = detail(c, b, P1);
    assert.equal(xb.raw, 90);
    assert.equal(xb.source, 'team');
    assert.equal(xb.override, false);
    assert.equal(xb.weighted, 9);
    assert.equal(calc.studentResult(c, b).overrideCount, 0);
  });

  test('a member entry without the override flag does not replace the team score', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    setTeamScore(c, t, P1, 88);
    setScore(c, a, P1, 50); // stale individual entry, no override flag
    const x = detail(c, a, P1);
    assert.equal(x.raw, 88);
    assert.equal(x.source, 'team');
  });

  test('a team-graded item with no team score is empty for members', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const x = detail(c, a, P2);
    assert.equal(x.state, 'empty');
    assert.equal(x.missing, true);
    assert.equal(x.weighted, 0);
    assert.equal(x.source, 'team');
  });

  test('team-graded assessment for a student with no team uses their individual entry', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const loner = addStudent(c, 'Student 02', 'Bravo');
    setTeamScore(c, t, P1, 88);
    setScore(c, loner, P1, 77);
    const x = detail(c, loner, P1);
    assert.equal(x.raw, 77);
    assert.equal(x.source, 'individual');
    assert.equal(x.weighted, 7.7);
  });

  test('a student whose team no longer exists also uses the individual entry', () => {
    const c = course('SE4351');
    const s = addStudent(c, 'Student 01', 'Alpha', { teamId: 't_deleted' });
    setScore(c, s, P1, 66);
    const x = detail(c, s, P1);
    assert.equal(x.raw, 66);
    assert.equal(x.source, 'individual');
  });
});

// ================================================================ MANDATORY 3: withdrawn student

describe('withdrawn student excluded from average and rank (S2, K7)', () => {
  test('withdrawn student excluded from average and rank: 3 actives + 1 withdrawn with the highest total', () => {
    const c = course('SE4351');
    const a = addStudent(c, 'Student 01', 'Alpha');
    const b = addStudent(c, 'Student 02', 'Bravo');
    const d = addStudent(c, 'Student 03', 'Charlie');
    const w = addStudent(c, 'Student 04', 'Delta', { status: 'withdrawn' });
    fillAll(c, a, 90);
    fillAll(c, b, 80);
    fillAll(c, d, 70);
    fillAll(c, w, 100);
    const res = calc.computeCourse(c);

    // Average of actives only: (90 + 80 + 70) / 3 = 80 (with the withdrawn 100 it would be 85).
    assert.equal(res.average, 80);
    assert.deepEqual(res.activeIds.slice().sort(), [a.id, b.id, d.id].sort());
    assert.ok(!res.activeIds.includes(w.id));

    assert.equal(res.byId[a.id].rank, 1);
    assert.equal(res.byId[b.id].rank, 2);
    assert.equal(res.byId[d.id].rank, 3);
    // Percentile = 100 * lower / (N - 1) with N = 3.
    assert.equal(res.byId[a.id].percentile, 100);
    assert.equal(res.byId[b.id].percentile, 50);
    assert.equal(res.byId[d.id].percentile, 0);
    assert.equal(res.byId[a.id].diffFromAverage, 10);
    assert.equal(res.byId[b.id].diffFromAverage, 0);
    assert.equal(res.byId[d.id].diffFromAverage, -10);

    const rw = res.byId[w.id];
    assert.equal(rw.active, false);
    assert.equal(rw.rank, null);
    assert.equal(rw.percentile, null);
    assert.equal(rw.diffFromAverage, null);
    // Still computed (kept in exports), just excluded from class figures.
    assert.equal(rw.total, 100);
    assert.equal(rw.letter, 'A+');
  });

  test('average is null when every student is withdrawn', () => {
    const c = course('SE4351');
    const w = addStudent(c, 'Student 01', 'Alpha', { status: 'withdrawn' });
    fillAll(c, w, 90);
    const res = calc.computeCourse(c);
    assert.equal(res.average, null);
    assert.deepEqual(res.activeIds, []);
    assert.equal(res.byId[w.id].rank, null);
  });
});

// ================================================================ MANDATORY 4: letter scales

describe('letter scales (K6)', () => {
  test('letter scales: undergraduate SE 4351 default scale is exactly the placeholder list', () => {
    const scale = course('SE4351').settings.letterScale;
    assert.deepEqual(scale.map((x) => [x.letter, x.min]), UG_CUTS.map((x) => [x[0], x[1]]).concat([['F', 0]]));
  });

  test('letter scales: graduate SE 6362 default scale is exactly the placeholder list', () => {
    const scale = course('SE6362').settings.letterScale;
    assert.deepEqual(scale.map((x) => [x.letter, x.min]), GRAD_CUTS.map((x) => [x[0], x[1]]).concat([['F', 0]]));
  });

  test('letter scales: undergraduate boundaries (at cutoff -> letter, cutoff - 0.01 -> next lower)', () => {
    const scale = course('SE4351').settings.letterScale;
    UG_CUTS.forEach(([letter, min, lower]) => {
      assert.equal(calc.letterFor(min, scale), letter, `${min} should be ${letter}`);
      assert.equal(calc.letterFor(util.fix(min - 0.01), scale), lower, `${min - 0.01} should be ${lower}`);
    });
  });

  test('letter scales: undergraduate extremes', () => {
    const scale = course('SE4351').settings.letterScale;
    assert.equal(calc.letterFor(100, scale), 'A+');
    assert.equal(calc.letterFor(105, scale), 'A+');
    assert.equal(calc.letterFor(59.99, scale), 'F');
    assert.equal(calc.letterFor(30, scale), 'F');
    assert.equal(calc.letterFor(0, scale), 'F');
    assert.equal(calc.letterFor(-5, scale), 'F');
  });

  test('letter scales: graduate boundaries (at cutoff -> letter, cutoff - 0.01 -> next lower)', () => {
    const scale = course('SE6362').settings.letterScale;
    GRAD_CUTS.forEach(([letter, min, lower]) => {
      assert.equal(calc.letterFor(min, scale), letter, `${min} should be ${letter}`);
      assert.equal(calc.letterFor(util.fix(min - 0.01), scale), lower, `${min - 0.01} should be ${lower}`);
    });
  });

  test('letter scales: graduate has no A+, C- or D letters (97 -> A, 72 -> C, 69.99 -> F)', () => {
    const scale = course('SE6362').settings.letterScale;
    assert.equal(calc.letterFor(97, scale), 'A');
    assert.equal(calc.letterFor(100, scale), 'A');
    assert.equal(calc.letterFor(72, scale), 'C');
    assert.equal(calc.letterFor(70, scale), 'C');
    assert.equal(calc.letterFor(69.99, scale), 'F');
    assert.equal(calc.letterFor(65, scale), 'F');
    assert.equal(calc.letterFor(60, scale), 'F');
    assert.equal(calc.letterFor(0, scale), 'F');
    const produced = new Set();
    for (let t = 0; t <= 100; t += 0.5) produced.add(calc.letterFor(t, scale));
    ['A+', 'C-', 'D+', 'D', 'D-'].forEach((l) => assert.ok(!produced.has(l), `graduate scale produced ${l}`));
  });

  test('letter scales: floating-point boundary, a total of 90 in decimal (89.99999999999999 naively) is A-', () => {
    // Project I 80 (8), Project II 80 (16), Test 1 88.6 (22.15), Test 2 99.5 (39.8), Participation 4.05 of 5 (4.05).
    // Decimal sum: 8 + 16 + 22.15 + 39.8 + 4.05 = 90.00 exactly.
    const raws = { [P1]: 80, [P2]: 80, [T1]: 88.6, [T2]: 99.5, [PART]: 4.05 };
    const weights = { [P1]: 10, [P2]: 20, [T1]: 25, [T2]: 40, [PART]: 5 };
    const maxes = { [P1]: 100, [P2]: 100, [T1]: 100, [T2]: 100, [PART]: 5 };
    const naive = FIVE.reduce((s, aid) => s + raws[aid] * weights[aid] / maxes[aid], 0);
    assert.ok(naive < 90, `precondition: naive float sum ${naive} should fall just below 90`);

    ['SE4351', 'SE6362'].forEach((tpl) => {
      const c = course(tpl);
      const t = addTeam(c, 'Team 1');
      const s = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
      setTeamScore(c, t, P1, 80);
      setTeamScore(c, t, P2, 80);
      setScore(c, s, T1, 88.6);
      setScore(c, s, T2, 99.5);
      setScore(c, s, PART, 4.05);
      const r = calc.studentResult(c, s);
      assert.equal(r.items[T1].weighted, 22.15);
      assert.equal(r.items[T2].weighted, 39.8);
      assert.equal(r.items[PART].weighted, 4.05);
      assert.equal(r.total, 90, `${tpl} total`);
      assert.equal(r.letter, 'A-', `${tpl} letter`);
    });
  });

  test('letter scales: letterFor compares after removing float noise', () => {
    const ug = course('SE4351').settings.letterScale;
    assert.equal(calc.letterFor(89.99999999999999, ug), 'A-');
    assert.equal(calc.letterFor(92.99999999999999, ug), 'A');
    assert.equal(calc.letterFor(89.99, ug), 'B+');
  });

  test('letter scales: an edited scale is used, and an unsorted scale still works', () => {
    const scale = [{ letter: 'F', min: 0 }, { letter: 'Pass', min: 50 }, { letter: 'Top', min: 85 }];
    assert.equal(calc.letterFor(85, scale), 'Top');
    assert.equal(calc.letterFor(84.99, scale), 'Pass');
    assert.equal(calc.letterFor(50, scale), 'Pass');
    assert.equal(calc.letterFor(49.99, scale), 'F');
  });
});

// ================================================================ K1: weighted points

describe('weighted points (K1)', () => {
  test('weighted = raw / max x weight on a non-100 max (45 / 50 x 10 = 9)', () => {
    const c = course('SE4351');
    Object.assign(asmt(c, T1), { maxScore: 50, weight: 10 });
    const s = studentWith(c, { [T1]: 45 });
    const x = detail(c, s, T1);
    assert.equal(x.weighted, 9);
    assert.equal(x.outOfRange, false);
  });

  test('another non-100 max: 17 / 20 x 10 = 8.5', () => {
    const c = course('SE4351');
    Object.assign(asmt(c, T1), { maxScore: 20, weight: 10 });
    const s = studentWith(c, { [T1]: 17 });
    assert.equal(detail(c, s, T1).weighted, 8.5);
  });

  test('max score 0 gives weighted 0 without NaN', () => {
    const c = course('SE4351');
    asmt(c, T1).maxScore = 0;
    const s = studentWith(c, { [T1]: 10, [T2]: 50 });
    const x = detail(c, s, T1);
    assert.equal(x.weighted, 0);
    const r = calc.studentResult(c, s);
    assert.ok(Number.isFinite(r.total), `total should be finite, got ${r.total}`);
    assert.equal(r.total, 20); // only Test 2: 50 / 100 x 40 = 20
  });

  test('weight 0 item contributes nothing', () => {
    const c = course('SE6362');
    const s = studentWith(c, { [PAPER]: 95 });
    const x = detail(c, s, PAPER);
    assert.equal(x.raw, 95);
    assert.equal(x.weighted, 0);
  });
});

// ================================================================ K2, G4: empty, invalid, out of range

describe('empty, invalid and out-of-range entries (K2, G4)', () => {
  test('invalid text counts as 0, state invalid, missing, and is counted in invalidCount', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [P1]: 100, [P2]: 100, [T2]: 100, [PART]: 5 });
    model.setEntry(c.scores, s.id, T1, model.entryFromInput('abc'));
    const x = detail(c, s, T1);
    assert.equal(x.state, 'invalid');
    assert.equal(x.missing, true);
    assert.equal(x.weighted, 0);
    assert.equal(x.text, 'abc');
    assert.equal(x.raw, null);
    const r = calc.studentResult(c, s);
    assert.equal(r.invalidCount, 1);
    assert.equal(r.incomplete, true);
    assert.equal(r.total, 75); // 10 + 20 + 0 + 40 + 5
  });

  test('parseEntry classifies empty, number and invalid entries', () => {
    assert.equal(calc.parseEntry(null).state, 'empty');
    assert.equal(calc.parseEntry({ value: null }).state, 'empty');
    assert.deepEqual(calc.parseEntry({ value: 88 }), { state: 'number', value: 88, text: null });
    assert.deepEqual(calc.parseEntry({ value: 0 }), { state: 'number', value: 0, text: null });
    const inv = calc.parseEntry({ value: null, text: 'abc' });
    assert.equal(inv.state, 'invalid');
    assert.equal(inv.value, null);
    assert.equal(inv.text, 'abc');
  });

  test('0 is a real score, not missing', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [T1]: 0 });
    const x = detail(c, s, T1);
    assert.equal(x.state, 'number');
    assert.equal(x.missing, false);
    assert.equal(x.raw, 0);
  });

  test('out of range (-5 and 105 on max 100) is flagged but used as entered', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [T1]: -5, [T2]: 105 });
    const x1 = detail(c, s, T1);
    const x2 = detail(c, s, T2);
    assert.equal(x1.outOfRange, true);
    assert.equal(x2.outOfRange, true);
    assert.equal(x1.weighted, -1.25); // -5 / 100 x 25
    assert.equal(x2.weighted, 42); // 105 / 100 x 40
    const r = calc.studentResult(c, s);
    assert.equal(r.outOfRangeCount, 2);
    assert.equal(r.total, 40.75);
  });

  test('0 and max are in range', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [T1]: 0, [T2]: 100 });
    assert.equal(detail(c, s, T1).outOfRange, false);
    assert.equal(detail(c, s, T2).outOfRange, false);
  });

  test('a student with no scores at all has total 0, incomplete, 5 missing', () => {
    const c = course('SE4351');
    const s = addStudent(c, 'Student 01', 'Alpha');
    const r = calc.studentResult(c, s);
    assert.equal(r.total, 0);
    assert.equal(r.incomplete, true);
    assert.equal(r.missingCount, 5);
    assert.equal(r.letter, 'F');
  });
});

// ================================================================ K3: rounding and curve

describe('rounding and curve (K3)', () => {
  // Test 1 84.1 -> 21.025, Test 2 100 -> 40, Project II 100 -> 20: total 81.025.
  const T81025 = { [T1]: 84.1, [T2]: 100, [P2]: 100 };
  // Test 1 98 -> 24.5, Test 2 100 -> 40, Project II 100 -> 20: total 84.5.
  const T845 = { [T1]: 98, [T2]: 100, [P2]: 100 };

  function totalWith(scores, rounding, curve) {
    const c = course('SE4351');
    c.settings.rounding = rounding;
    if (curve !== undefined) c.settings.curve = curve;
    const s = studentWith(c, scores);
    return calc.studentResult(c, s);
  }

  test('rounding none keeps 81.025 and 84.5', () => {
    assert.equal(totalWith(T81025, 'none').total, 81.025);
    assert.equal(totalWith(T845, 'none').total, 84.5);
  });

  test('rounding hundredth: 81.025 -> 81.03 (half away from zero), 84.5 stays', () => {
    const r = totalWith(T81025, 'hundredth');
    assert.equal(r.totalUnrounded, 81.025);
    assert.equal(r.total, 81.03);
    assert.equal(totalWith(T845, 'hundredth').total, 84.5);
  });

  test('rounding integer: 81.025 -> 81, 84.5 -> 85', () => {
    assert.equal(totalWith(T81025, 'integer').total, 81);
    assert.equal(totalWith(T845, 'integer').total, 85);
  });

  test('roundTotal directly', () => {
    assert.equal(calc.roundTotal(81.025, 'none'), 81.025);
    assert.equal(calc.roundTotal(81.025, 'hundredth'), 81.03);
    assert.equal(calc.roundTotal(81.025, 'integer'), 81);
    assert.equal(calc.roundTotal(84.5, 'integer'), 85);
    assert.equal(calc.roundTotal(84.49, 'integer'), 84);
  });

  test('the curve is added to the total before rounding (84.3 + 0.2 = 84.5 -> 85)', () => {
    // Test 1 97.2 -> 24.3, Test 2 100 -> 40, Project II 100 -> 20: 84.3.
    const r = totalWith({ [T1]: 97.2, [T2]: 100, [P2]: 100 }, 'integer', 0.2);
    assert.equal(r.weightedSum, 84.3);
    assert.equal(r.curve, 0.2);
    assert.equal(r.totalUnrounded, 84.5);
    assert.equal(r.total, 85); // rounding first would give 84 + 0.2 = 84.2
  });

  test('curve with no rounding: 74 + 2.5 = 76.5', () => {
    const r = totalWith({ [P1]: 90, [P2]: 85, [T1]: 80, [T2]: 70, [PART]: 0 }, 'none', 2.5);
    assert.equal(r.total, 76.5);
  });

  test('the letter uses the rounded total (89.5 -> 90 -> A- with integer rounding, B+ without)', () => {
    // Test 1 98 -> 24.5, Test 2 100 -> 40, Project II 100 -> 20, Participation 5 of 5 -> 5: 89.5.
    const scores = { [T1]: 98, [T2]: 100, [P2]: 100, [PART]: 5 };
    const ri = totalWith(scores, 'integer');
    assert.equal(ri.totalUnrounded, 89.5);
    assert.equal(ri.total, 90);
    assert.equal(ri.letter, 'A-');
    const rn = totalWith(scores, 'none');
    assert.equal(rn.total, 89.5);
    assert.equal(rn.letter, 'B+');
  });
});

// ================================================================ A3: weight status

describe('weightStatus (A3)', () => {
  test('default weights sum to 100 and are ok', () => {
    const c = course('SE4351');
    assert.deepEqual(calc.weightStatus(c), { sum: 100, ok: true });
    assert.deepEqual(calc.weightStatus(course('SE6362')), { sum: 100, ok: true });
  });

  test('weights summing to 95 are not ok', () => {
    const c = course('SE4351');
    asmt(c, T2).weight = 35;
    assert.deepEqual(calc.weightStatus(c), { sum: 95, ok: false });
    assert.deepEqual(calc.computeCourse(c).weights, { sum: 95, ok: false });
  });

  test('decimal weights that sum to 100 are ok despite float noise', () => {
    const c = course('SE4351');
    asmt(c, P1).weight = 10.1;
    asmt(c, P2).weight = 19.9;
    asmt(c, T1).weight = 25.3;
    asmt(c, T2).weight = 39.7;
    const w = calc.weightStatus(c);
    assert.equal(w.sum, 100);
    assert.equal(w.ok, true);
  });
});

// ================================================================ K7: rank, percentile, average

describe('rank, percentile and difference from average (K7)', () => {
  test('ties use competition ranking (1, 2, 2, 4) and share a percentile', () => {
    const c = course('SE4351');
    const a = addStudent(c, 'Student 01', 'Alpha');
    const b = addStudent(c, 'Student 02', 'Bravo');
    const d = addStudent(c, 'Student 03', 'Charlie');
    const e = addStudent(c, 'Student 04', 'Delta');
    fillAll(c, a, 90);
    fillAll(c, b, 80);
    fillAll(c, d, 80);
    fillAll(c, e, 70);
    const res = calc.computeCourse(c);
    assert.equal(res.byId[a.id].rank, 1);
    assert.equal(res.byId[b.id].rank, 2);
    assert.equal(res.byId[d.id].rank, 2);
    assert.equal(res.byId[e.id].rank, 4);
    // N = 4: 90 has 3 lower -> 100; 80 has 1 lower -> 33.33...; 70 has 0 lower -> 0.
    assert.equal(res.byId[a.id].percentile, 100);
    near(res.byId[b.id].percentile, 100 / 3, 1e-6);
    assert.equal(res.byId[b.id].percentile, res.byId[d.id].percentile);
    assert.equal(res.byId[e.id].percentile, 0);
    // Average (90 + 80 + 80 + 70) / 4 = 80.
    assert.equal(res.average, 80);
    assert.equal(res.byId[a.id].diffFromAverage, 10);
    assert.equal(res.byId[b.id].diffFromAverage, 0);
    assert.equal(res.byId[e.id].diffFromAverage, -10);
  });

  test('a single active student has rank 1 and percentile 100', () => {
    const c = course('SE4351');
    const a = addStudent(c, 'Student 01', 'Alpha');
    fillAll(c, a, 55);
    const res = calc.computeCourse(c);
    assert.equal(res.byId[a.id].rank, 1);
    assert.equal(res.byId[a.id].percentile, 100);
    assert.equal(res.byId[a.id].diffFromAverage, 0);
    assert.equal(res.average, 55);
  });

  test('all tied: every student is rank 1 and shares a percentile', () => {
    const c = course('SE4351');
    const list = [1, 2, 3].map((n) => addStudent(c, `Student 0${n}`, 'X'));
    list.forEach((s) => fillAll(c, s, 75));
    const res = calc.computeCourse(c);
    list.forEach((s) => {
      assert.equal(res.byId[s.id].rank, 1);
      assert.equal(res.byId[s.id].percentile, 0); // nobody is lower
    });
  });

  test('diffFromAverage is free of float noise (80.1 and 80.2 -> average 80.15, diffs -0.05 and 0.05)', () => {
    const c = course('SE4351');
    const a = addStudent(c, 'Student 01', 'Alpha');
    const b = addStudent(c, 'Student 02', 'Bravo');
    fillAll(c, a, 80.1);
    fillAll(c, b, 80.2);
    const res = calc.computeCourse(c);
    assert.equal(res.byId[a.id].total, 80.1);
    assert.equal(res.byId[b.id].total, 80.2);
    assert.equal(res.average, 80.15);
    assert.equal(res.byId[a.id].diffFromAverage, -0.05);
    assert.equal(res.byId[b.id].diffFromAverage, 0.05);
  });
});

// ================================================================ G3: sorting

describe('sortStudents (G3)', () => {
  test('by name: last name then first name, numeric-aware and case-insensitive', () => {
    const c = course('SE4351');
    const s10 = addStudent(c, 'Student 10', 'Alpha');
    const s2b = addStudent(c, 'Student 2', 'Bravo');
    const s3 = addStudent(c, 'student 3', 'Charlie');
    const s2a = addStudent(c, 'Student 2', 'alpha');
    const asc = calc.sortStudents(c, null, 'name', 'asc');
    assert.deepEqual(ids(asc), ids([s2a, s2b, s3, s10]));
    const desc = calc.sortStudents(c, null, 'name', 'desc');
    assert.deepEqual(ids(desc), ids([s10, s3, s2b, s2a]));
  });

  test('returns a new array and leaves the stored order alone', () => {
    const c = course('SE4351');
    const b = addStudent(c, 'Student 02', 'Bravo');
    const a = addStudent(c, 'Student 01', 'Alpha');
    const out = calc.sortStudents(c, null, 'name', 'asc');
    assert.notEqual(out, c.students);
    assert.deepEqual(ids(out), ids([a, b]));
    assert.deepEqual(ids(c.students), ids([b, a]));
  });

  test('by total ascending and descending, ties broken by name', () => {
    const c = course('SE4351');
    const a = addStudent(c, 'Student 03', 'Alpha');
    const b = addStudent(c, 'Student 01', 'Bravo');
    const d = addStudent(c, 'Student 02', 'Charlie');
    const e = addStudent(c, 'Student 04', 'Delta');
    fillAll(c, a, 80);
    fillAll(c, b, 80);
    fillAll(c, d, 90);
    fillAll(c, e, 70);
    const res = calc.computeCourse(c);
    assert.deepEqual(ids(calc.sortStudents(c, res, 'total', 'asc')), ids([e, b, a, d]));
    assert.deepEqual(ids(calc.sortStudents(c, res, 'total', 'desc')), ids([d, b, a, e]));
  });

  test('by no ascending and descending', () => {
    const c = course('SE4351');
    const s3 = addStudent(c, 'Student A', 'X', { no: 3 });
    const s1 = addStudent(c, 'Student B', 'X', { no: 1 });
    const s2 = addStudent(c, 'Student C', 'X', { no: 2 });
    assert.deepEqual(ids(calc.sortStudents(c, null, 'no', 'asc')), ids([s1, s2, s3]));
    assert.deepEqual(ids(calc.sortStudents(c, null, 'no', 'desc')), ids([s3, s2, s1]));
  });

  test('compareByName falls back to No when names are equal', () => {
    const x = { lastName: 'Student 05', firstName: 'Echo', no: 7 };
    const y = { lastName: 'student 05', firstName: 'echo', no: 3 };
    assert.ok(calc.compareByName(y, x) < 0);
    assert.ok(calc.compareByName(x, y) > 0);
  });
});

// ================================================================ K4: late work

describe('late penalty (K4)', () => {
  const settings10 = { latePointsPerWeek: 10 };

  test('1 week late on max 100 costs 10 points', () => {
    assert.equal(calc.latePenalty({ value: 90, weeksLate: 1 }, { maxScore: 100, weight: 40 }, settings10), 10);
  });

  test('2 weeks late on max 50 costs 10 points (5 per week, scaled)', () => {
    assert.equal(calc.latePenalty({ value: 40, weeksLate: 2 }, { maxScore: 50, weight: 25 }, settings10), 10);
  });

  test('waived penalty is 0', () => {
    assert.equal(calc.latePenalty({ value: 90, weeksLate: 3, waived: true }, { maxScore: 100, weight: 40 }, settings10), 0);
  });

  test('not late means no penalty', () => {
    assert.equal(calc.latePenalty({ value: 90 }, { maxScore: 100, weight: 40 }, settings10), 0);
    assert.equal(calc.latePenalty({ value: 90, weeksLate: 0 }, { maxScore: 100, weight: 40 }, settings10), 0);
  });

  test('points per week is a course setting (5 per week, 1 week on max 100 -> 5)', () => {
    assert.equal(calc.latePenalty({ value: 90, weeksLate: 1 }, { maxScore: 100, weight: 40 }, { latePointsPerWeek: 5 }), 5);
  });

  test('penalty applies before weighting (raw 90, 1 week late, weight 40 -> adjusted 80, weighted 32)', () => {
    const c = course('SE4351');
    const s = addStudent(c, 'Student 01', 'Alpha');
    setScore(c, s, T2, 90, { weeksLate: 1 });
    const x = detail(c, s, T2);
    assert.equal(x.raw, 90);
    assert.equal(x.weeksLate, 1);
    assert.equal(x.waived, false);
    assert.equal(x.penalty, 10);
    assert.equal(x.adjusted, 80);
    assert.equal(x.weighted, 32);
    const r = calc.studentResult(c, s);
    assert.equal(r.total, 32);
    assert.equal(r.lateCount, 1);
  });

  test('penalty never takes the adjusted score below 0 (score 5, 1 week late -> 0)', () => {
    const c = course('SE4351');
    const s = addStudent(c, 'Student 01', 'Alpha');
    setScore(c, s, T1, 5, { weeksLate: 1 });
    const x = detail(c, s, T1);
    assert.equal(x.adjusted, 0);
    assert.equal(x.weighted, 0);
    assert.equal(calc.studentResult(c, s).total, 0);
  });

  test('2 weeks late on a max-50 item: raw 40 -> adjusted 30 -> weighted 30 / 50 x 25 = 15', () => {
    const c = course('SE4351');
    asmt(c, T1).maxScore = 50;
    const s = addStudent(c, 'Student 01', 'Alpha');
    setScore(c, s, T1, 40, { weeksLate: 2 });
    const x = detail(c, s, T1);
    assert.equal(x.penalty, 10);
    assert.equal(x.adjusted, 30);
    assert.equal(x.weighted, 15);
  });

  test('waived late entry keeps the full score (raw 90 -> weighted 36)', () => {
    const c = course('SE4351');
    const s = addStudent(c, 'Student 01', 'Alpha');
    setScore(c, s, T2, 90, { weeksLate: 1, waived: true });
    const x = detail(c, s, T2);
    assert.equal(x.penalty, 0);
    assert.equal(x.adjusted, 90);
    assert.equal(x.weighted, 36);
    assert.equal(x.waived, true);
  });

  test('course setting of 5 points per week flows through scoreDetail (90 -> 85 -> 34)', () => {
    const c = course('SE4351');
    c.settings.latePointsPerWeek = 5;
    const s = addStudent(c, 'Student 01', 'Alpha');
    setScore(c, s, T2, 90, { weeksLate: 1 });
    const x = detail(c, s, T2);
    assert.equal(x.penalty, 5);
    assert.equal(x.adjusted, 85);
    assert.equal(x.weighted, 34);
  });

  test('a late team score applies to every member (90, 1 week late -> 80 -> 8)', () => {
    const c = course('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    setTeamScore(c, t, P1, 90, { weeksLate: 1 });
    [a, b].forEach((s) => {
      const x = detail(c, s, P1);
      assert.equal(x.adjusted, 80);
      assert.equal(x.weighted, 8);
    });
  });

  test('a missing score stays missing even when marked late', () => {
    const c = course('SE4351');
    const s = addStudent(c, 'Student 01', 'Alpha');
    model.setEntry(c.scores, s.id, T1, { value: null, weeksLate: 2 });
    const x = detail(c, s, T1);
    assert.equal(x.missing, true);
    assert.equal(x.adjusted, null);
    assert.equal(x.weighted, 0);
  });
});

// ================================================================ review round 1 regressions

describe('totals with non-100 max scores are exact (review F1)', () => {
  // All five SE 4351 items with max 30. Exact totals, worked by hand:
  // 20/30x10 + 20/30x20 + 22/30x25 + 28/30x40 + 26/30x5 = (200 + 400 + 550 + 1120 + 130) / 30 = 2400 / 30 = 80.
  // 20/30x10 + 20/30x20 + 20/30x25 + 29/30x40 + 28/30x5 = (200 + 400 + 500 + 1160 + 140) / 30 = 2400 / 30 = 80.
  // 20/30x10 + 20/30x20 + 22/30x25 + 28/30x40 + 23/30x5 = (200 + 400 + 550 + 1120 + 115) / 30 = 2385 / 30 = 79.5.
  function max30(rounding) {
    const c = course('SE4351');
    c.assessments.forEach((a) => { a.maxScore = 30; });
    if (rounding) c.settings.rounding = rounding;
    return c;
  }
  function withRaws(c, raws, name) {
    const s = addStudent(c, name, 'X');
    FIVE.forEach((aid, i) => setScore(c, s, aid, raws[i]));
    return s;
  }

  test('an exact total of 80 is 80 and B-, not 79.9999999999 and C+', () => {
    const c = max30();
    const s = withRaws(c, [20, 20, 22, 28, 26], 'Student 01');
    const r = calc.studentResult(c, s);
    assert.equal(r.weightedSum, 80);
    assert.equal(r.total, 80);
    assert.equal(r.letter, 'B-');
    // Display values per item are still rounded to 10 decimals: 20 / 30 x 10 = 6.6666666667.
    assert.equal(r.items[P1].weighted, 6.6666666667);
  });

  test('two students with the same exact total tie in rank and percentile', () => {
    const c = max30();
    const a = withRaws(c, [20, 20, 22, 28, 26], 'Student 01');
    const b = withRaws(c, [20, 20, 20, 29, 28], 'Student 02');
    const res = calc.computeCourse(c);
    assert.equal(res.byId[a.id].total, 80);
    assert.equal(res.byId[b.id].total, 80);
    assert.equal(res.byId[b.id].letter, 'B-');
    assert.equal(res.byId[a.id].rank, 1);
    assert.equal(res.byId[b.id].rank, 1);
    assert.equal(res.byId[a.id].percentile, res.byId[b.id].percentile);
  });

  test('integer rounding: an exact 79.5 rounds to 80 (B-) like Excel ROUND', () => {
    const c = max30('integer');
    const s = withRaws(c, [20, 20, 22, 28, 23], 'Student 01');
    const r = calc.studentResult(c, s);
    assert.equal(r.totalUnrounded, 79.5);
    assert.equal(r.total, 80);
    assert.equal(r.letter, 'B-');
  });

  test('every total on a max-30 grid matches exact arithmetic at the letter cutoffs', () => {
    // Totals are k / 30 for integer k (common denominator 30); check all combinations that hit
    // a cutoff exactly, varying Test 2 and Participation with the other items fixed.
    const c = max30();
    const s = addStudent(c, 'Student 01', 'X');
    let checked = 0;
    for (let t2 = 0; t2 <= 30; t2++) {
      for (let part = 0; part <= 30; part++) {
        [[20, 20, 22], [10, 30, 16], [19, 29, 1]].forEach(([p1, p2, t1]) => {
          const k = p1 * 10 + p2 * 20 + t1 * 25 + t2 * 40 + part * 5; // total = k / 30
          if (k % 30 !== 0) return;
          [P1, P2, T1, T2, PART].forEach((aid, i) => setScore(c, s, aid, [p1, p2, t1, t2, part][i]));
          const r = calc.studentResult(c, s);
          assert.equal(r.total, k / 30, `raws ${[p1, p2, t1, t2, part]}`);
          assert.equal(r.letter, calc.letterFor(k / 30, c.settings.letterScale));
          checked++;
        });
      }
    }
    assert.ok(checked > 20, `expected many exact totals, checked ${checked}`);
  });
});

describe('negative weights, max scores and late settings (review F8)', () => {
  test('weightStatus is not ok when a weight is negative, even if the sum is 100', () => {
    const c = course('SE4351');
    c.assessments = [model.createAssessment({ name: 'X', weight: 10 }), model.createAssessment({ name: 'Y', weight: 10 })];
    c.assessments[0].weight = 110;
    c.assessments[1].weight = -10;
    assert.deepEqual(calc.weightStatus(c), { sum: 100, ok: false });
  });

  test('the late penalty is never negative', () => {
    assert.equal(calc.latePenalty({ value: 50, weeksLate: 1 }, { maxScore: -100 }, { latePointsPerWeek: 10 }), 0);
    assert.equal(calc.latePenalty({ value: 50, weeksLate: 1 }, { maxScore: 100 }, { latePointsPerWeek: -10 }), 0);
    assert.equal(calc.latePenalty({ value: 50, weeksLate: 1 }, { maxScore: 0 }, { latePointsPerWeek: 10 }), 0);
  });
});

describe('non-finite totals stay out of class figures (review F6)', () => {
  test('a student whose total overflows gets no rank and does not poison the average', () => {
    const c = course('SE4351');
    const a = addStudent(c, 'Student 01', 'Alpha');
    const b = addStudent(c, 'Student 02', 'Bravo');
    fillAll(c, a, 80);
    fillAll(c, b, 90);
    model.setEntry(c.scores, b.id, T1, null); // b has no Test 1 score: 9 + 18 + 36 + 4.5 (4.5 of 5) = 67.5
    asmt(c, T1).weight = 1e308; // only reachable by setting the weight in code; normalize rejects it
    const res = calc.computeCourse(c);
    assert.ok(!Number.isFinite(res.byId[a.id].total)); // 80 x 1e308 overflows
    assert.equal(res.byId[a.id].rank, null);
    assert.equal(res.byId[a.id].diffFromAverage, null);
    assert.equal(res.byId[b.id].total, 67.5);
    assert.equal(res.byId[b.id].rank, 1);
    assert.equal(res.average, 67.5);
    assert.deepEqual(res.activeIds, [a.id, b.id]);
  });

  test('a stored score above the input limit is shown as invalid after a restore', () => {
    const raw = JSON.parse(JSON.stringify(course('SE4351')));
    raw.students = [{ id: 's_1', lastName: 'Student 01' }];
    raw.scores = { s_1: { a_t1: { value: 1e308 }, a_t2: { value: 50 } } };
    const c = model.normalizeState({ app: 'grade-tracker', courses: [raw] }).courses[0];
    assert.deepEqual(c.scores.s_1.a_t1, { value: null, text: '1e+308' });
    const r = calc.studentResult(c, c.students[0]);
    assert.equal(r.items[T1].state, 'invalid');
    assert.equal(r.total, 20);
  });
});

describe('what-if helpers (review F9: minTotalForLetter, neededScore)', () => {
  test('minTotalForLetter inverts the rounding mode', () => {
    const scale = course('SE4351').settings.letterScale;
    assert.equal(calc.minTotalForLetter('A-', { letterScale: scale, rounding: 'none' }), 90);
    assert.equal(calc.minTotalForLetter('A-', { letterScale: scale, rounding: 'integer' }), 89.5);
    assert.equal(calc.minTotalForLetter('A-', { letterScale: scale, rounding: 'hundredth' }), 89.995);
    assert.equal(calc.minTotalForLetter('B-', { letterScale: [{ letter: 'B-', min: 79.5 }, { letter: 'F', min: 0 }], rounding: 'integer' }), 79.5);
    assert.equal(calc.minTotalForLetter('Z', { letterScale: scale, rounding: 'none' }), null);
    // The returned totals really earn the letter, and a hair less does not.
    ['none', 'integer', 'hundredth'].forEach((mode) => {
      const min = calc.minTotalForLetter('A-', { letterScale: scale, rounding: mode });
      assert.equal(calc.letterFor(calc.roundTotal(min, mode), scale), 'A-', mode);
      assert.equal(calc.letterFor(calc.roundTotal(util.fix(min - 0.0001), mode), scale), 'B+', mode);
    });
  });

  test('neededScore: Test 2 needed for a B with the 74.0 example items', () => {
    // Project I 90 (9), Project II 85 (17), Test 1 80 (20), Participation 0: 46 without Test 2.
    // B needs 83: (83 - 46) / 40 x 100 = 92.5.
    const c = course('SE4351');
    const s = studentWith(c, { [P1]: 90, [P2]: 85, [T1]: 80, [T2]: 10, [PART]: 0 });
    const w = calc.neededScore(c, s, T2, 'B');
    assert.deepEqual(w, { needed: 92.5, reachable: true, alreadyReached: false });
    setScore(c, s, T2, 92.5);
    assert.equal(calc.studentResult(c, s).letter, 'B');
    // A+ needs (97 - 46) / 40 x 100 = 127.5: not reachable. F is already reached (needs <= 0).
    assert.equal(calc.neededScore(c, s, T2, 'A+').reachable, false);
    assert.equal(calc.neededScore(c, s, T2, 'F').alreadyReached, true);
  });

  test('neededScore with a repeating decimal is rounded up, so entering it really reaches the letter', () => {
    // Max scores 7, 30, 45, 15 (Test 2), 3. Other items: 3/7 x 10 + 23/30 x 20 + 10/45 x 25 + 1/3 x 5
    // = 30/7 + 46/3 + 50/9 + 5/3 = 1691/63. A+ needs 97: (97 - 1691/63) x 15/40 = 13260/504 = 26.30952380952…
    // Rounded to 10 decimals that is 26.3095238095, which falls short (Test 2's factor 40/15 magnifies
    // the cut digits), so the helper returns 26.3095238096.
    const c = course('SE4351');
    [[P1, 7], [P2, 30], [T1, 45], [T2, 15], [PART, 3]].forEach(([aid, max]) => { asmt(c, aid).maxScore = max; });
    const s = studentWith(c, { [P1]: 3, [P2]: 23, [T1]: 10, [PART]: 1 });
    const w = calc.neededScore(c, s, T2, 'A+');
    assert.equal(w.needed, 26.3095238096);
    assert.equal(w.reachable, false); // above the max of 15
    setScore(c, s, T2, w.needed);
    assert.equal(calc.studentResult(c, s).letter, 'A+');
    setScore(c, s, T2, 26.3095238095);
    assert.equal(calc.studentResult(c, s).letter, 'A');
    // The other targets are repeating decimals too; each returned score reaches its letter.
    ['C+', 'B-', 'B'].forEach((letter) => {
      const x = calc.neededScore(c, s, T2, letter);
      setScore(c, s, T2, x.needed);
      assert.equal(calc.studentResult(c, s).letter, letter, `${letter} with ${x.needed}`);
    });
  });

  test('neededScore follows rounding and curve, and is null for weight-0 items or unknown letters', () => {
    const c = course('SE6362');
    c.settings.rounding = 'integer';
    c.settings.curve = 1;
    const s = studentWith(c, { [P1]: 90, [P2]: 85, [T1]: 80, [PART]: 0 });
    // A- needs an unrounded total of 89.5; minus curve 1 and 46 from the other items: 42.5 / 40 x 100 = 106.25.
    assert.equal(calc.neededScore(c, s, T2, 'A-').needed, 106.25);
    assert.equal(calc.neededScore(c, s, PAPER, 'A'), null);
    assert.equal(calc.neededScore(c, s, T2, 'A+'), null);
  });
});

// ================================================================ stage 2b: drop-down values (notOnList)

describe('drop-down values: notOnList (DECISIONS 8)', () => {
  test('participation on the list (4.5, 0, 5) is not flagged; off the list (4.25) is flagged but still counted', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [PART]: 4.5 });
    let x = detail(c, s, PART);
    assert.equal(x.notOnList, false);
    assert.equal(x.weighted, 4.5); // 4.5 / 5 x 5
    [0, 5, 0.5].forEach((v) => {
      setScore(c, s, PART, v);
      assert.equal(detail(c, s, PART).notOnList, false, String(v));
    });
    setScore(c, s, PART, 4.25);
    x = detail(c, s, PART);
    assert.equal(x.notOnList, true);
    assert.equal(x.outOfRange, false);
    assert.equal(x.state, 'number');
    assert.equal(x.weighted, 4.25); // kept and counted as entered
    const r = calc.studentResult(c, s);
    assert.equal(r.notOnListCount, 1);
    assert.equal(r.total, 4.25);
  });

  test('a float-noisy list value (4.500000000000001) is on the list', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [PART]: 0.1 * 3 * 15 });
    assert.equal(detail(c, s, PART).notOnList, false);
  });

  test('a value above the max is both out of range and not on the list (100 typed on the 5-point scale)', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [PART]: 100 });
    const x = detail(c, s, PART);
    assert.equal(x.outOfRange, true);
    assert.equal(x.notOnList, true);
    assert.equal(x.weighted, 100); // 100 / 5 x 5: highlighted, never silently changed
  });

  test('empty and invalid cells, and items without a list, are never notOnList', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [T1]: 83.7 });
    assert.equal(detail(c, s, PART).notOnList, false); // empty
    model.setEntry(c.scores, s.id, PART, model.entryFromInput('good'));
    assert.equal(detail(c, s, PART).state, 'invalid');
    assert.equal(detail(c, s, PART).notOnList, false);
    assert.equal(detail(c, s, T1).notOnList, false); // free entry
    assert.equal(calc.studentResult(c, s).notOnListCount, 0);
  });

  test('turning the list off clears the flag; a team-graded item with a list checks the team score', () => {
    const c = course('SE4351');
    const s = studentWith(c, { [PART]: 4.25 });
    asmt(c, PART).choices = null;
    assert.equal(detail(c, s, PART).notOnList, false);
    const t = addTeam(c, 'Team 1');
    const m = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    asmt(c, P1).choices = { step: 10 };
    setTeamScore(c, t, P1, 85);
    assert.equal(detail(c, m, P1).notOnList, true);
    setTeamScore(c, t, P1, 90);
    assert.equal(detail(c, m, P1).notOnList, false);
  });

  test('each list is built once per assessment, not once per score (review F6), and follows in-place edits', () => {
    // 59 students x four 100-point items with 201-value lists (step 0.5) plus participation (11 values).
    const c = course('SE4351');
    FIVE.forEach((aid) => { if (asmt(c, aid).maxScore === 100) asmt(c, aid).choices = { step: 0.5 }; });
    for (let i = 1; i <= 59; i++) {
      const s = addStudent(c, 'Student ' + String(i).padStart(2, '0'), 'X');
      fillAll(c, s, 60 + 10 * (i % 5)); // participation 3, 3.5, ..., 5: every value is on its list
    }
    // Count the list work done in model (it calls util.fix once per list value it builds).
    const realFix = util.fix;
    let calls = 0;
    util.fix = function () { calls++; return realFix.apply(this, arguments); };
    let first, second;
    try {
      calc.computeCourse(c);
      first = calls;
      calls = 0;
      calc.computeCourse(c);
      second = calls;
    } finally {
      util.fix = realFix;
    }
    // Rebuilding the list for each of the 59 x 5 scores took about 59 x (4 x 202 + 12) = 48,000 calls.
    assert.ok(first < 2500, 'first computeCourse: ' + first + ' util.fix calls in model');
    assert.ok(second < 600, 'next computeCourse: ' + second + ' util.fix calls in model');
    const r = calc.computeCourse(c);
    assert.equal(c.students.reduce((n, s) => n + r.byId[s.id].notOnListCount, 0), 0);
    // A list changed in place (same assessment object) is read fresh: steps of 7 miss most values.
    asmt(c, T1).choices.step = 7;
    const s1 = c.students[0];
    setScore(c, s1, T1, 70);
    assert.equal(detail(c, s1, T1).notOnList, true); // 100, 93, ..., 2, 0: 70 is not on it
    setScore(c, s1, T1, 72);
    assert.equal(detail(c, s1, T1).notOnList, false);
    asmt(c, T1).maxScore = 99; // 99, 92, ..., 1, 0
    assert.equal(detail(c, s1, T1).notOnList, true);
    setScore(c, s1, T1, 71);
    assert.equal(detail(c, s1, T1).notOnList, false);
  });
});

// ================================================================ stage 2b: final letters

describe('final letters: effectiveLetter, letterDiffers, finalLetterValid (STAGE2B)', () => {
  function withTotal(c, name, total, extra) {
    const s = addStudent(c, name, 'X', extra);
    fillAll(c, s, total);
    return s;
  }

  test('no final letter: the suggestion from the cutoffs is the effective letter', () => {
    const c = course('SE4351');
    const s = withTotal(c, 'Student 01', 84);
    const r = calc.studentResult(c, s);
    assert.equal(r.letter, 'B');
    assert.equal(r.finalLetter, null);
    assert.equal(r.finalLetterValid, true);
    assert.equal(r.effectiveLetter, 'B');
    assert.equal(r.letterSource, 'cutoffs');
    assert.equal(r.letterDiffers, false);
  });

  test('a manual letter equal to the suggestion: manual, not different', () => {
    const c = course('SE4351');
    const s = withTotal(c, 'Student 01', 84);
    model.setFinalLetter(c, s.id, 'B');
    const r = calc.studentResult(c, s);
    assert.equal(r.finalLetter, 'B');
    assert.equal(r.effectiveLetter, 'B');
    assert.equal(r.letterSource, 'manual');
    assert.equal(r.letterDiffers, false);
    assert.equal(r.finalLetterValid, true);
  });

  test('83.65 graded A and 83.4 graded B, like the previous sheet: the manual letter wins', () => {
    const c = course('SE4351');
    const hi = withTotal(c, 'Student 01', 83.65);
    const lo = withTotal(c, 'Student 02', 83.4);
    model.setFinalLetter(c, hi.id, 'A');
    model.setFinalLetter(c, lo.id, 'B');
    const res = calc.computeCourse(c);
    assert.equal(res.byId[hi.id].letter, 'B'); // the cutoff suggestion
    assert.equal(res.byId[hi.id].effectiveLetter, 'A');
    assert.equal(res.byId[hi.id].letterDiffers, true);
    assert.equal(res.byId[lo.id].effectiveLetter, 'B');
    assert.equal(res.byId[lo.id].letterDiffers, false);
    assert.deepEqual(res.orderIssues, []);
  });

  test('finalLetterValid after a scale change: A+ is kept, flagged, and still the effective letter', () => {
    const c = course('SE4351');
    const s = withTotal(c, 'Student 01', 98);
    model.setFinalLetter(c, s.id, 'A+');
    assert.equal(calc.studentResult(c, s).finalLetterValid, true);
    c.settings.letterScale = model.defaultLetterScale('graduate'); // no A+
    const r = calc.studentResult(c, s);
    assert.equal(r.finalLetter, 'A+');
    assert.equal(r.finalLetterValid, false);
    assert.equal(r.effectiveLetter, 'A+');
    assert.equal(r.letterSource, 'manual');
    assert.equal(r.letter, 'A');
    assert.equal(r.letterDiffers, true);
    const res = calc.computeCourse(c);
    assert.equal(res.letterSummary.invalid, 1);
    assert.equal(res.letterSummary.assigned, 1);
    // Renaming the letter back in the scale makes it valid again.
    c.settings.letterScale = [{ letter: 'A+', min: 97 }].concat(model.defaultLetterScale('graduate'));
    assert.equal(calc.studentResult(c, s).finalLetterValid, true);
  });

  test('a blank stored letter counts as no letter', () => {
    const c = course('SE4351');
    const s = withTotal(c, 'Student 01', 70);
    s.finalLetter = '  ';
    const r = calc.studentResult(c, s);
    assert.equal(r.finalLetter, null);
    assert.equal(r.letterSource, 'cutoffs');
    assert.equal(r.effectiveLetter, 'C-');
  });

  test('letterIndex: position in the scale, highest first; -1 when absent', () => {
    const ug = course('SE4351').settings.letterScale;
    assert.equal(calc.letterIndex(ug, 'A+'), 0);
    assert.equal(calc.letterIndex(ug, 'B'), 4);
    assert.equal(calc.letterIndex(ug, 'F'), 12);
    assert.equal(calc.letterIndex(ug, 'Z'), -1);
    assert.equal(calc.letterIndex(ug, ''), -1);
    assert.equal(calc.letterIndex(ug, null), -1);
    assert.equal(calc.letterIndex(ug.slice().reverse(), 'A+'), 0, 'unsorted scales are sorted first');
    assert.equal(calc.letterIndex(undefined, 'A'), -1);
  });
});

describe('orderIssues and letterSummary (STAGE2B)', () => {
  function withTotal(c, name, total, letter, extra) {
    const s = addStudent(c, name, 'X', extra);
    fillAll(c, s, total);
    if (letter !== undefined) s.finalLetter = letter;
    return s;
  }

  test('no letters, no issues; summary counts every active student as unassigned', () => {
    const c = course('SE4351');
    withTotal(c, 'Student 01', 90);
    withTotal(c, 'Student 02', 80);
    withTotal(c, 'Student 03', 70, undefined, { status: 'withdrawn' });
    const res = calc.computeCourse(c);
    assert.deepEqual(res.orderIssues, []);
    assert.deepEqual(res.letterSummary, { active: 2, assigned: 0, unassigned: 2, manualDiffers: 0, invalid: 0 });
  });

  test('a lower total with a higher letter forms one pair { higherTotalId, lowerTotalId }', () => {
    const c = course('SE4351');
    const a = withTotal(c, 'Student 01', 91, 'B+');
    const b = withTotal(c, 'Student 02', 88, 'A-');
    const res = calc.computeCourse(c);
    assert.deepEqual(res.orderIssues, [{ higherTotalId: a.id, lowerTotalId: b.id }]);
    assert.equal(res.byId[a.id].orderIssue, true);
    assert.equal(res.byId[b.id].orderIssue, true);
  });

  test('ties never form a pair, whatever the letters', () => {
    const c = course('SE4351');
    const a = withTotal(c, 'Student 01', 85, 'B');
    const b = withTotal(c, 'Student 02', 85, 'A');
    const d = withTotal(c, 'Student 03', 85, 'C');
    const res = calc.computeCourse(c);
    assert.deepEqual(res.orderIssues, []);
    [a, b, d].forEach((s) => assert.equal(res.byId[s.id].orderIssue, false));
  });

  test('ties with float noise are still ties (80.1 via different items)', () => {
    const c = course('SE4351');
    const a = addStudent(c, 'Student 01', 'X');
    const b = addStudent(c, 'Student 02', 'X');
    fillAll(c, a, 80.1);
    // 80.1 again, reached differently: Test 2 91 (36.4), Test 1 83.4 (20.85), Project II 90.5 (18.1),
    // Project I 47.5 (4.75), Participation 0: 36.4 + 20.85 + 18.1 + 4.75 = 80.1.
    [[P1, 47.5], [P2, 90.5], [T1, 83.4], [T2, 91], [PART, 0]].forEach(([aid, v]) => setScore(c, b, aid, v));
    a.finalLetter = 'C';
    b.finalLetter = 'A';
    const res = calc.computeCourse(c);
    assert.equal(res.byId[a.id].total, 80.1);
    assert.equal(res.byId[b.id].total, 80.1);
    assert.deepEqual(res.orderIssues, []);
  });

  test('equal letters and letters in total order are fine; every out-of-order pair is listed', () => {
    const c = course('SE4351');
    const s1 = withTotal(c, 'Student 01', 95, 'A');
    const s2 = withTotal(c, 'Student 02', 90, 'A');
    const s3 = withTotal(c, 'Student 03', 85, 'B');
    const s4 = withTotal(c, 'Student 04', 80, 'A');   // above 2 of the 3 higher totals
    const s5 = withTotal(c, 'Student 05', 75, 'C');
    const s6 = withTotal(c, 'Student 06', 70, 'B');   // above s5 only
    const res = calc.computeCourse(c);
    // s4 (A) vs s3 (B): issue. s4 vs s1, s2 (A): same letter. s6 (B) vs s5 (C): issue. s6 vs s3 (B): same.
    assert.deepEqual(res.orderIssues, [
      { higherTotalId: s3.id, lowerTotalId: s4.id },
      { higherTotalId: s5.id, lowerTotalId: s6.id }
    ]);
    assert.deepEqual([s1, s2, s3, s4, s5, s6].map((s) => res.byId[s.id].orderIssue), [false, false, true, true, true, true]);
  });

  test('only students with a final letter of the scale are compared; withdrawn students never are', () => {
    const c = course('SE4351');
    const a = withTotal(c, 'Student 01', 95, 'C');
    withTotal(c, 'Student 02', 90);                                  // no letter
    withTotal(c, 'Student 03', 85, 'W');                             // not a scale letter
    withTotal(c, 'Student 04', 80, 'A', { status: 'withdrawn' });    // withdrawn
    const e = withTotal(c, 'Student 05', 75, 'B');
    const res = calc.computeCourse(c);
    assert.deepEqual(res.orderIssues, [{ higherTotalId: a.id, lowerTotalId: e.id }]);
  });

  test('pairs follow total order (highest first), not storage order', () => {
    const c = course('SE4351');
    const low = withTotal(c, 'Student 01', 60, 'A');
    const high = withTotal(c, 'Student 02', 99, 'F');
    const mid = withTotal(c, 'Student 03', 80, 'B');
    const res = calc.computeCourse(c);
    assert.deepEqual(res.orderIssues, [
      { higherTotalId: high.id, lowerTotalId: mid.id },
      { higherTotalId: high.id, lowerTotalId: low.id },
      { higherTotalId: mid.id, lowerTotalId: low.id }
    ]);
    assert.deepEqual(calc.findOrderIssues(c, Object.values(res.byId)), res.orderIssues);
  });

  test('letterSummary: assigned, unassigned (active without a letter), manualDiffers, invalid', () => {
    const c = course('SE4351');
    withTotal(c, 'Student 01', 95, 'A');     // suggestion A: same
    withTotal(c, 'Student 02', 88, 'A-');    // suggestion B+: differs
    withTotal(c, 'Student 03', 81);          // unassigned
    withTotal(c, 'Student 04', 74, 'W');     // outside the scale: assigned, differs, invalid
    withTotal(c, 'Student 05', 60, 'D', { status: 'withdrawn' }); // not counted
    withTotal(c, 'Student 06', 50, null, { status: 'withdrawn' }); // not counted
    const res = calc.computeCourse(c);
    assert.deepEqual(res.letterSummary, { active: 4, assigned: 3, unassigned: 1, manualDiffers: 2, invalid: 1 });
    assert.equal(res.letterSummary.assigned + res.letterSummary.unassigned, res.activeIds.length);
  });

  test('a withdrawn student keeps their final letter in the results (exports), outside the summary', () => {
    const c = course('SE4351');
    const w = withTotal(c, 'Student 01', 60, 'D', { status: 'withdrawn' });
    const res = calc.computeCourse(c);
    assert.equal(res.byId[w.id].effectiveLetter, 'D');
    assert.equal(res.byId[w.id].letterSource, 'manual');
    assert.deepEqual(res.letterSummary, { active: 0, assigned: 0, unassigned: 0, manualDiffers: 0, invalid: 0 });
  });

  test('bands like the previous sheet (A for the top 4, B for the next 3, C for the rest) have no issues', () => {
    const c = course('SE4351');
    const totals = [91.65, 90.2, 89.1, 88.4, 86.35, 84, 83.75, 81.4, 77.2, 71.9];
    const letters = ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'];
    totals.forEach((t, i) => withTotal(c, 'Student ' + String(i + 1).padStart(2, '0'), t, letters[i]));
    const res = calc.computeCourse(c);
    assert.deepEqual(res.orderIssues, []);
    assert.equal(res.letterSummary.assigned, 10);
    assert.equal(res.letterSummary.unassigned, 0);
    // Moving one student up a band out of order shows exactly that student's pairs.
    c.students[8].finalLetter = 'B'; // 77.2 now B, above 81.4's C
    const again = calc.computeCourse(c);
    assert.deepEqual(again.orderIssues, [{ higherTotalId: c.students[7].id, lowerTotalId: c.students[8].id }]);
  });
});

describe('stage 2b robustness', () => {
  test('letterIndex ignores junk rows and non-array scales', () => {
    assert.equal(calc.letterIndex([null, 5, { letter: 'B', min: 80 }, { letter: 'A', min: 90 }], 'B'), 1);
    assert.equal(calc.letterIndex('A', 'A'), -1);
    assert.equal(calc.letterIndex({ letter: 'A' }, 'A'), -1);
  });

  test('a course whose students all lack totals still has a letter summary and no order issues', () => {
    const c = course('SE4351');
    addStudent(c, 'Student 01', 'Alpha').finalLetter = 'A';
    const res = calc.computeCourse(c);
    assert.deepEqual(res.orderIssues, []);
    assert.equal(res.letterSummary.assigned, 1);
  });
});
