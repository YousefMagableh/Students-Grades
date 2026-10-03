'use strict';
/* Spec-derived tests for js/core/stats.js (STAGE5.md section 1 and its Addendum; DESIGN.md section 10;
 * REQUIREMENTS ST1-ST3, S2). Every expected number is worked out by hand in the comments. Fake data only. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../js/core/util.js');
const model = require('../js/core/model.js');
const calc = require('../js/core/calc.js');
const attendance = require('../js/core/attendance.js');
const sample = require('../js/core/sample.js');
const stats = require('../js/core/stats.js');

// ---------------------------------------------------------------- helpers

const P1 = 'a_p1', P2 = 'a_p2', T1 = 'a_t1', T2 = 'a_t2', PART = 'a_part';
const FIVE = [P1, P2, T1, T2, PART];

function near(actual, expected, eps) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < (eps || 1e-9), `expected ${actual} to be close to ${expected}`);
}
function addTeam(c, name) { const t = model.createTeam(name); c.teams.push(t); return t; }
function addStudent(c, lastName, firstName, extra) {
  const s = model.createStudent(Object.assign({ lastName, firstName, no: c.students.length + 1 }, extra || {}));
  c.students.push(s);
  return s;
}
function setScore(c, s, aid, value) { model.setEntry(c.scores, s.id, aid, { value }); }
function setInvalid(c, s, aid, text) { model.setEntry(c.scores, s.id, aid, { value: null, text }); }
function setTeamScore(c, t, aid, value) { model.setEntry(c.teamScores, t.id, aid, { value }); }
function asmt(c, aid) { return model.findAssessment(c, aid); }
/** A student without a team whose total is exactly v: v on the max-100 items and v / 20 on
 * participation (out of 5); the default weights sum to 100. */
function withTotal(c, lastName, firstName, v, extra) {
  const s = addStudent(c, lastName, firstName, extra);
  FIVE.forEach((aid) => setScore(c, s, aid, util.fix(v * asmt(c, aid).maxScore / 100)));
  return s;
}
const counts = (bins) => bins.map((b) => b.count);
const byLetter = (rows) => Object.fromEntries(rows.map((x) => [x.letter, x.count]));

/* The main fixture (SE 4351: weights P1 10, P2 20, T1 25, T2 40, participation 5 out of 5; the
 * undergraduate placeholder scale A+ 97, A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 73, C- 70, D+ 67,
 * D 63, D- 60, F 0). Team A: P1 90, P2 80. Team B: P1 70, P2 100.
 *
 *  student                 team  P1          P2          T1     T2   Part     total
 *  S1 Student 01, Alpha    A     90 -> 9     80 -> 16    80     90   5        9 + 16 + 20 + 36 + 5    = 86     B
 *  S2 Student 02, Bravo    A     60 (ovr)->6 80 -> 16    70     75   4        6 + 16 + 17.5 + 30 + 4  = 73.5   C
 *  S3 Student 03, Charlie  A     90 -> 9     50 (ovr)    100    100  'abc'    9 + 10 + 25 + 40 + 0    = 84     WITHDRAWN
 *  S4 Student 04, Delta    B     70 -> 7     100 -> 20   60     50   3        7 + 20 + 15 + 20 + 3    = 65     D
 *  S5 Student 05, Echo     B     70 -> 7     100 -> 20   'abs'  95   4.5      7 + 20 + 0 + 38 + 4.5   = 69.5   D+ (incomplete)
 *  S6 Student 06, Foxtrot  -     100 (own)   (empty)     92     96   5        10 + 0 + 23 + 38.4 + 5  = 76.4   C  (incomplete)
 *
 * Active totals: 86, 73.5, 65, 69.5, 76.4. Final letters: S2 'C+', S4 'F' (and the withdrawn S3 'A'). */
/** S3: withdrawn member of team A with an override, an invalid entry and a final letter (total 84). */
function addWithdrawn(c, tA) {
  const s3 = addStudent(c, 'Student 03', 'Charlie', { teamId: tA.id, status: 'withdrawn', finalLetter: 'A' });
  model.setOverride(c, s3.id, P2, { value: 50 });
  setScore(c, s3, T1, 100); setScore(c, s3, T2, 100); setInvalid(c, s3, PART, 'abc');
  return s3;
}
function fixture(opts) {
  const o = opts || {};
  const c = model.createCourse('SE4351');
  const tA = addTeam(c, 'Team A');
  const tB = addTeam(c, 'Team B');
  setTeamScore(c, tA, P1, 90); setTeamScore(c, tA, P2, 80);
  setTeamScore(c, tB, P1, 70); setTeamScore(c, tB, P2, 100);
  const s1 = addStudent(c, 'Student 01', 'Alpha', { teamId: tA.id });
  setScore(c, s1, T1, 80); setScore(c, s1, T2, 90); setScore(c, s1, PART, 5);
  const s2 = addStudent(c, 'Student 02', 'Bravo', { teamId: tA.id, finalLetter: 'C+' });
  model.setOverride(c, s2.id, P1, { value: 60 });
  setScore(c, s2, T1, 70); setScore(c, s2, T2, 75); setScore(c, s2, PART, 4);
  const s3 = o.withdrawn === false ? null : addWithdrawn(c, tA);
  const s4 = addStudent(c, 'Student 04', 'Delta', { teamId: tB.id, finalLetter: 'F' });
  setScore(c, s4, T1, 60); setScore(c, s4, T2, 50); setScore(c, s4, PART, 3);
  const s5 = addStudent(c, 'Student 05', 'Echo', { teamId: tB.id });
  setInvalid(c, s5, T1, 'abs'); setScore(c, s5, T2, 95); setScore(c, s5, PART, 4.5);
  const s6 = addStudent(c, 'Student 06', 'Foxtrot');
  setScore(c, s6, P1, 100); setScore(c, s6, T1, 92); setScore(c, s6, T2, 96); setScore(c, s6, PART, 5);
  return { c, tA, tB, s1, s2, s3, s4, s5, s6 };
}

// ================================================================ describe()

describe('describe: known vectors (sample SD n - 1, QUARTILE.INC)', () => {
  test('n = 0: count 0 and every other field null (also for nothing but non-numbers)', () => {
    const empty = {
      count: 0, min: null, max: null, range: null, mean: null, median: null, sd: null, variance: null,
      sdPopulation: null, variancePopulation: null, q1: null, q3: null, iqr: null
    };
    assert.deepEqual(stats.describe([]), empty);
    assert.deepEqual(stats.describe([null, undefined, NaN, Infinity, -Infinity, '88', {}]), empty);
    assert.deepEqual(stats.describe(null), empty);
    assert.deepEqual(stats.describe(undefined), empty);
  });

  test('n = 1: sd and variance are null (sample), population ones 0, quartiles all equal the value', () => {
    assert.deepEqual(stats.describe([83.4]), {
      count: 1, min: 83.4, max: 83.4, range: 0, mean: 83.4, median: 83.4, sd: null, variance: null,
      sdPopulation: 0, variancePopulation: 0, q1: 83.4, q3: 83.4, iqr: 0
    });
  });

  test('n = 2: [70, 80] mean 75, sample variance 50 (sd sqrt 50), population variance 25 (sd 5), Q1 72.5, Q3 77.5', () => {
    // Deviations from 75: -5, +5; sum of squares 50. Sample: 50 / (2 - 1) = 50; population: 50 / 2 = 25.
    // QUARTILE.INC: h = (n - 1) p = 0.25 -> 70 + 0.25 * 10 = 72.5; h = 0.5 -> 75; h = 0.75 -> 77.5.
    const d = stats.describe([80, 70]);
    assert.equal(d.count, 2);
    assert.equal(d.min, 70);
    assert.equal(d.max, 80);
    assert.equal(d.range, 10);
    assert.equal(d.mean, 75);
    assert.equal(d.median, 75);
    assert.equal(d.variance, 50);
    assert.equal(d.sd, 7.0710678119); // sqrt(50) = 7.07106781186547..., 10 decimals
    assert.equal(d.variancePopulation, 25);
    assert.equal(d.sdPopulation, 5);
    assert.equal(d.q1, 72.5);
    assert.equal(d.q3, 77.5);
    assert.equal(d.iqr, 5);
  });

  test('10 values [46, 96, 75, 88, 62, 81, 70, 93, 55, 84]: mean 75, median 78, Q1 64, Q3 87, SS 2486', () => {
    // Sum 750 -> mean 75. Sorted: 46 55 62 70 75 81 84 88 93 96 (positions 0..9).
    // QUARTILE.INC: Q1 h = 9 * 0.25 = 2.25 -> 62 + 0.25 * (70 - 62) = 64;
    //               Q2 h = 4.5 -> 75 + 0.5 * (81 - 75) = 78;
    //               Q3 h = 6.75 -> 84 + 0.75 * (88 - 84) = 87; IQR 23.
    // Squared deviations: 841 400 169 25 0 36 81 169 324 441 -> 2486.
    // Sample variance 2486 / 9 = 276.2222222222; population 2486 / 10 = 248.6.
    const v = [46, 96, 75, 88, 62, 81, 70, 93, 55, 84];
    const copy = v.slice();
    const d = stats.describe(v);
    assert.deepEqual(v, copy, 'input not reordered');
    assert.equal(d.count, 10);
    assert.equal(d.min, 46);
    assert.equal(d.max, 96);
    assert.equal(d.range, 50);
    assert.equal(d.mean, 75);
    assert.equal(d.median, 78);
    assert.equal(d.q1, 64);
    assert.equal(d.q3, 87);
    assert.equal(d.iqr, 23);
    assert.equal(d.variance, 276.2222222222);
    assert.equal(d.sd, util.fix(Math.sqrt(2486 / 9)));
    near(d.sd, 16.6199, 1e-4);
    assert.equal(d.variancePopulation, 248.6);
    assert.equal(d.sdPopulation, util.fix(Math.sqrt(248.6)));
    near(d.sdPopulation, 15.7671, 1e-4);
    // Same as Excel QUARTILE.INC(…, k) and PERCENTILE.INC.
    assert.deepEqual([0, 1, 2, 3, 4].map((k) => stats.quartileInc(v, k)), [46, 64, 78, 87, 96]);
    assert.equal(stats.percentileInc(v, 0.9), 93.3); // h = 8.1 -> 93 + 0.1 * 3
    assert.equal(stats.percentileInc(v, 0.1), 54.1); // h = 0.9 -> 46 + 0.9 * 9
  });

  test('QUARTILE.INC interpolation on [1, 2, 3, 4] (1.75, 2.5, 3.25) and exact positions on 5 values', () => {
    // n = 4: Q1 h = 0.75 -> 1 + 0.75 = 1.75; Q2 h = 1.5 -> 2.5; Q3 h = 2.25 -> 3.25.
    const d = stats.describe([4, 1, 3, 2]);
    assert.equal(d.q1, 1.75);
    assert.equal(d.median, 2.5);
    assert.equal(d.q3, 3.25);
    assert.equal(d.iqr, 1.5);
    // n = 5: h = 1, 2, 3 land on values.
    const e = stats.describe([50, 10, 40, 20, 30]);
    assert.deepEqual([e.q1, e.median, e.q3], [20, 30, 40]);
    // Sample variance: deviations -20 -10 0 10 20 -> 1000 / 4 = 250.
    assert.equal(e.variance, 250);
  });

  test('non-numbers are ignored, and binary noise is removed (0.1 + 0.2)', () => {
    const d = stats.describe([75, null, 46, NaN, '99', 96, undefined]);
    assert.equal(d.count, 3);
    assert.equal(d.mean, 72.3333333333); // 217 / 3
    assert.equal(d.median, 75);
    assert.equal(stats.describe([0.1, 0.2]).mean, 0.15);
    assert.equal(stats.describe([0.1, 0.2]).range, 0.1);
    assert.equal(stats.describe([83.4, 83.4, 83.4]).variance, 0);
  });

  test('quartileInc / percentileInc reject bad arguments', () => {
    assert.equal(stats.quartileInc([1, 2], 5), null);
    assert.equal(stats.quartileInc([1, 2], 1.5), null);
    assert.equal(stats.percentileInc([1, 2], -0.1), null);
    assert.equal(stats.percentileInc([1, 2], 1.1), null);
    assert.equal(stats.percentileInc([], 0.5), null);
  });
});

// ================================================================ bins10()

describe('bins10: the eLearning GRADE DISTRIBUTION bins', () => {
  const LABELS = ['Greater than 100', '90 - 100', '80 - 89', '70 - 79', '60 - 69', '50 - 59', '40 - 49',
    '30 - 39', '20 - 29', '10 - 19', '0 - 9', 'Less than 0'];

  test('12 bins with the exact labels, in panel order, and their bounds', () => {
    const b = stats.bins10([]);
    assert.deepEqual(b.map((x) => x.label), LABELS);
    assert.deepEqual(counts(b), new Array(12).fill(0));
    assert.deepEqual([b[0].lo, b[0].hi], [100, null]);
    assert.deepEqual([b[1].lo, b[1].hi], [90, 100]);
    assert.deepEqual([b[2].lo, b[2].hi], [80, 90]);
    assert.deepEqual([b[10].lo, b[10].hi], [0, 10]);
    assert.deepEqual([b[11].lo, b[11].hi], [null, 0]);
    assert.deepEqual(stats.BINS10.map((x) => x.label), LABELS);
    assert.equal(typeof stats.BINS10_RULE, 'string');
    assert.ok(stats.BINS10_RULE.includes('89.99'));
    b.forEach((x) => assert.equal(typeof x.rule, 'string'));
  });

  test('edges: 100 and 90 -> 90 - 100; 89.99 -> 80 - 89; 79.995 -> 70 - 79; 0 -> 0 - 9; -0.5 -> Less than 0; 100.5 -> Greater than 100', () => {
    const one = (v) => stats.bins10([v]).findIndex((x) => x.count === 1);
    assert.equal(LABELS[one(100)], '90 - 100');
    assert.equal(LABELS[one(90)], '90 - 100');
    assert.equal(LABELS[one(89.99)], '80 - 89');
    assert.equal(LABELS[one(79.995)], '70 - 79');
    assert.equal(LABELS[one(80)], '80 - 89');
    assert.equal(LABELS[one(10)], '10 - 19');
    assert.equal(LABELS[one(9.99)], '0 - 9');
    assert.equal(LABELS[one(0)], '0 - 9');
    assert.equal(LABELS[one(-0.5)], 'Less than 0');
    assert.equal(LABELS[one(100.5)], 'Greater than 100');
    assert.equal(LABELS[one(100.0000000000001)], '90 - 100', 'binary noise above 100 is still 100');
    const all = stats.bins10([100, 90, 89.99, 0, -0.5, 100.5, 79.995]);
    assert.deepEqual(counts(all), [1, 2, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1]);
    assert.equal(util.sum(counts(all)), 7);
  });

  test('bin10Index and non-numbers (ignored, so the counts add up to describe().count)', () => {
    assert.equal(stats.bin10Index(100.5), 0);
    assert.equal(stats.bin10Index(95), 1);
    assert.equal(stats.bin10Index(85), 2);
    assert.equal(stats.bin10Index(5), 10);
    assert.equal(stats.bin10Index(-1), 11);
    assert.equal(stats.bin10Index(null), -1);
    assert.equal(stats.bin10Index(NaN), -1);
    assert.equal(stats.bin10Index('50'), -1);
    const vals = [55, null, NaN, '70', 72, Infinity];
    assert.equal(util.sum(counts(stats.bins10(vals))), stats.describe(vals).count);
  });
});

// ================================================================ histogram()

describe('histogram: generic chart bins', () => {
  test('defaults (width 10, 0..100): 10 bins, last one closed, values outside folded in with flags', () => {
    // -3, 0, 9.99 -> 0-10 (one from below); 10 -> 10-20; 95, 100, 105 -> 90-100 (one from above).
    const h = stats.histogram([0, 9.99, 10, 95, 100, 105, -3, null, NaN]);
    assert.equal(h.length, 10);
    assert.deepEqual(h.map((b) => b.label), ['0–10', '10–20', '20–30', '30–40', '40–50', '50–60', '60–70', '70–80', '80–90', '90–100']);
    assert.deepEqual([h[0].lo, h[0].hi, h[9].lo, h[9].hi], [0, 10, 90, 100]);
    assert.deepEqual(counts(h), [3, 1, 0, 0, 0, 0, 0, 0, 0, 3]);
    assert.deepEqual([h[0].below, h[0].above], [1, 0]);
    assert.deepEqual([h[9].below, h[9].above], [0, 1]);
    h.slice(1, 9).forEach((b) => assert.deepEqual([b.below, b.above], [0, 0]));
  });

  test('width 5: 20 bins; 100 and 95 in 95-100, 94.99 in 90-95', () => {
    const h = stats.histogram([100, 95, 94.99, 0, 4.99, 5], 5);
    assert.equal(h.length, 20);
    assert.equal(h[19].label, '95–100');
    assert.equal(h[19].count, 2);
    assert.equal(h[18].count, 1);
    assert.equal(h[0].count, 2);
    assert.equal(h[1].count, 1);
    assert.equal(util.sum(counts(h)), 6);
  });

  test('custom range, uneven width, binary edges and bad arguments', () => {
    // 0..100 by 7: ceil(100 / 7) = 15 bins, the last one 98-100.
    const h7 = stats.histogram([98, 99.5, 100], 7);
    assert.equal(h7.length, 15);
    assert.deepEqual([h7[14].lo, h7[14].hi, h7[14].count], [98, 100, 3]);
    // 0.3 / 0.1 is 2.9999999999999996 in binary; it still belongs to 0.3-0.4.
    const h01 = stats.histogram([0.3, 0.7], 0.1, 0, 1);
    assert.equal(h01.length, 10);
    assert.equal(h01[3].count, 1);
    assert.equal(h01[3].lo, 0.3);
    assert.equal(h01[7].count, 1);
    // 50..60 by 2: 5 bins.
    const h2 = stats.histogram([49, 50, 59.9, 60, 61], 2, 50, 60);
    assert.deepEqual(counts(h2), [2, 0, 0, 0, 3]);
    assert.equal(h2[0].below, 1);
    assert.equal(h2[4].above, 1);
    // A width that is not above 0 means 10; hi <= lo means hi = lo + width.
    assert.equal(stats.histogram([], 0).length, 10);
    assert.equal(stats.histogram([], -5).length, 10);
    assert.equal(stats.histogram([], NaN).length, 10);
    const one = stats.histogram([5], 10, 0, 0);
    assert.equal(one.length, 1);
    assert.deepEqual([one[0].lo, one[0].hi, one[0].count], [0, 10, 1]);
    assert.ok(stats.histogram([], 1e-9).length <= 1000);
  });
});

// ================================================================ course fixture

describe('course statistics on the fixture (withdrawn excluded, effective letters)', () => {
  test('fixture totals and letters are as worked out above', () => {
    const f = fixture();
    const r = calc.computeCourse(f.c);
    const t = (s) => r.byId[s.id].total;
    assert.deepEqual([t(f.s1), t(f.s2), t(f.s3), t(f.s4), t(f.s5), t(f.s6)], [86, 73.5, 84, 65, 69.5, 76.4]);
    assert.deepEqual([f.s1, f.s2, f.s4, f.s5, f.s6].map((s) => r.byId[s.id].letter), ['B', 'C', 'D', 'D+', 'C']);
    assert.deepEqual([f.s1, f.s2, f.s4, f.s5, f.s6].map((s) => r.byId[s.id].effectiveLetter), ['B', 'C+', 'F', 'D+', 'C']);
  });

  test('activeTotals + describe: the panel numbers (n = 5) equal the class average', () => {
    const f = fixture();
    const r = calc.computeCourse(f.c);
    const totals = stats.activeTotals(f.c, r);
    assert.deepEqual(totals, [86, 73.5, 65, 69.5, 76.4]); // course order, withdrawn S3 (84) left out
    const d = stats.describe(totals);
    // Sorted 65, 69.5, 73.5, 76.4, 86; sum 370.4 -> mean 74.08 (= results.average).
    // Q1 h = 1 -> 69.5; Q2 h = 2 -> 73.5; Q3 h = 3 -> 76.4; IQR 6.9.
    // Squared deviations from 74.08: 82.4464 + 20.9764 + 0.3364 + 5.3824 + 142.0864 = 251.228.
    assert.equal(d.count, 5);
    assert.equal(d.mean, 74.08);
    assert.equal(d.mean, r.average);
    assert.equal(d.median, 73.5);
    assert.equal(d.q1, 69.5);
    assert.equal(d.q3, 76.4);
    assert.equal(d.iqr, 6.9);
    assert.equal(d.min, 65);
    assert.equal(d.max, 86);
    assert.equal(d.range, 21);
    assert.equal(d.variance, 62.807); // 251.228 / 4
    assert.equal(d.variancePopulation, 50.2456); // 251.228 / 5
    assert.equal(d.sd, util.fix(Math.sqrt(62.807)));
    // Without results the module computes them.
    assert.deepEqual(stats.activeTotals(f.c), totals);
    assert.deepEqual(stats.activeTotals(f.c, null), totals);
  });

  test('statusDistribution: active 5, withdrawn 1, complete 3, incomplete 2, invalid 1, overrides 1', () => {
    // Incomplete: S5 (T1 invalid) and S6 (P2 empty: no team, so P2 is an individual item).
    // Invalid entries: S5's T1 only (S3's participation 'abc' is withdrawn). Overrides: S2's P1 only (S3's P2 excluded).
    const f = fixture();
    assert.deepEqual(stats.statusDistribution(f.c, calc.computeCourse(f.c)), {
      active: 5, withdrawn: 1, complete: 3, incomplete: 2, invalidEntries: 1, overrides: 1
    });
    assert.deepEqual(stats.statusDistribution(fixture({ withdrawn: false }).c), {
      active: 5, withdrawn: 0, complete: 3, incomplete: 2, invalidEntries: 1, overrides: 1
    });
  });

  test('letterDistribution: effective letters by default, suggested on request, scale order, pct of active', () => {
    const f = fixture();
    const r = calc.computeCourse(f.c);
    const eff = stats.letterDistribution(f.c, r);
    // Every scale letter has a row, highest cutoff first.
    assert.deepEqual(eff.map((x) => x.letter), ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F']);
    assert.deepEqual(eff.map((x) => x.min), [97, 93, 90, 87, 83, 80, 77, 73, 70, 67, 63, 60, 0]);
    eff.forEach((x) => assert.equal(x.inScale, true));
    // Effective: B (S1), C+ (S2 final), C (S6), D+ (S5), F (S4 final). The withdrawn S3's final A is not counted.
    assert.deepEqual(byLetter(eff), { 'A+': 0, A: 0, 'A-': 0, 'B+': 0, B: 1, 'B-': 0, 'C+': 1, C: 1, 'C-': 0, 'D+': 1, D: 0, 'D-': 0, F: 1 });
    assert.equal(eff.find((x) => x.letter === 'B').pct, 20);
    assert.equal(eff.find((x) => x.letter === 'A').pct, 0);
    // Suggested: B (S1), C (S2, S6), D+ (S5), D (S4).
    const sug = stats.letterDistribution(f.c, r, { letters: 'suggested' });
    assert.deepEqual(byLetter(sug), { 'A+': 0, A: 0, 'A-': 0, 'B+': 0, B: 1, 'B-': 0, 'C+': 0, C: 2, 'C-': 0, 'D+': 1, D: 1, 'D-': 0, F: 0 });
    assert.equal(sug.find((x) => x.letter === 'C').pct, 40);
    assert.deepEqual(stats.letterDistribution(f.c, r, { letters: 'effective' }), eff);
    assert.deepEqual(stats.letterDistribution(f.c), eff);
    // "n of N final letters assigned" comes from results.letterSummary.
    assert.equal(r.letterSummary.assigned, 2);
    assert.equal(r.letterSummary.active, 5);
  });

  test('letterDistribution: a final letter outside the scale gets its own row at the end (inScale false)', () => {
    const f = fixture();
    f.s1.finalLetter = 'P'; // e.g. a letter the scale no longer has
    const rows = stats.letterDistribution(f.c, calc.computeCourse(f.c));
    assert.equal(rows.length, 14);
    assert.deepEqual(rows[13], { letter: 'P', min: null, count: 1, pct: 20, inScale: false });
    assert.equal(util.sum(rows.map((x) => x.count)), 5);
    // A graduate course lists only its 8 letters.
    const g = model.createCourse('SE6362');
    withTotal(g, 'Student 01', 'Alpha', 88);
    assert.deepEqual(stats.letterDistribution(g).map((x) => x.letter), ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'F']);
    assert.equal(stats.letterDistribution(g).find((x) => x.letter === 'B+').count, 1);
  });

  test('passRate: passingLetter and its fallback, effective vs suggested letters', () => {
    const f = fixture();
    const r = calc.computeCourse(f.c);
    // Default undergraduate passing letter D-. Effective: S4 holds a final F -> 4 of 5 pass.
    assert.deepEqual(stats.passRate(f.c, r), { passing: 4, total: 5, pct: 80, passingLetter: 'D-', unknown: 0 });
    // Suggested: B, C, D, D+, C are all D- or better -> 5 of 5.
    assert.deepEqual(stats.passRate(f.c, r, { letters: 'suggested' }), { passing: 5, total: 5, pct: 100, passingLetter: 'D-', unknown: 0 });
    // Passing letter C+: suggested only S1 (B) -> 1 of 5 = 20%; effective S1 (B) and S2 (C+ final) -> 40%.
    f.c.settings.passingLetter = 'C+';
    assert.deepEqual(stats.passRate(f.c, r, { letters: 'suggested' }), { passing: 1, total: 5, pct: 20, passingLetter: 'C+', unknown: 0 });
    assert.deepEqual(stats.passRate(f.c, r), { passing: 2, total: 5, pct: 40, passingLetter: 'C+', unknown: 0 });
    // Passing letter C: B, C+ and C pass (effective) -> 3 of 5 = 60%.
    f.c.settings.passingLetter = 'C';
    assert.equal(stats.passRate(f.c, r).passing, 3);
    assert.equal(stats.passRate(f.c, r).pct, 60);
    // A passing letter the scale does not have falls back to the level's default (model.passingLetterFor).
    f.c.settings.passingLetter = 'Z';
    assert.equal(stats.passRate(f.c, r).passingLetter, 'D-');
    // A final letter outside the scale is unknown and does not pass.
    f.c.settings.passingLetter = 'D-';
    f.s1.finalLetter = 'P';
    assert.deepEqual(stats.passRate(f.c), { passing: 3, total: 5, pct: 60, passingLetter: 'D-', unknown: 1 });
  });

  test('passRate: graduate default C, a 1/3 percentage, and no active students', () => {
    const g = model.createCourse('SE6362');
    withTotal(g, 'Student 01', 'Alpha', 72);  // C (70)
    withTotal(g, 'Student 02', 'Bravo', 69.99); // F
    withTotal(g, 'Student 03', 'Charlie', 60); // F
    withTotal(g, 'Student 04', 'Delta', 95, { status: 'withdrawn' });
    assert.deepEqual(stats.passRate(g), { passing: 1, total: 3, pct: 33.3333333333, passingLetter: 'C', unknown: 0 });
    const empty = model.createCourse('SE4351');
    assert.deepEqual(stats.passRate(empty), { passing: 0, total: 0, pct: null, passingLetter: 'D-', unknown: 0 });
  });
});

// ================================================================ withdrawn students everywhere

describe('withdrawn students are excluded everywhere (S2)', () => {
  function everything(c) {
    const r = calc.computeCourse(c);
    const scale = [{ letter: 'A', min: 90 }, { letter: 'B', min: 80 }, { letter: 'C', min: 70 }, { letter: 'D', min: 60 }];
    const sim = stats.simulate(c, r, scale);
    return {
      totals: stats.activeTotals(c, r),
      describe: stats.describe(stats.activeTotals(c, r)),
      bins: stats.bins10(stats.activeTotals(c, r)),
      partPct: stats.assessmentValues(c, r, PART, { percent: true }),
      p2: stats.assessmentValues(c, r, P2),
      letters: stats.letterDistribution(c, r),
      suggested: stats.letterDistribution(c, r, { letters: 'suggested' }),
      pass: stats.passRate(c, r),
      perAssessment: stats.perAssessment(c, r),
      perTeam: stats.perTeam(c, r).map((x) => Object.assign({}, x, { members: 'n/a' })),
      topBottom: stats.topBottom(c, r, 3),
      borderline: stats.borderline(c, r, 10),
      gaps: stats.gaps(c, r, 0),
      simulate: { distribution: sim.distribution, students: sim.students, finalChanges: sim.finalChanges, byId: sim.byId },
      letters2: stats.lettersFromScale(c, r, scale)
    };
  }

  test('adding a withdrawn student (team member with an override, invalid entry, final letter, absences) changes no statistic', () => {
    const f = fixture({ withdrawn: false });
    const ses = f.c.attendance.sessions;
    attendance.setMark(f.c, f.s1.id, ses[0].id, 'A');
    const before = everything(f.c);
    const s3 = addWithdrawn(f.c, f.tA);
    attendance.setMark(f.c, s3.id, ses[0].id, 'A');
    attendance.setMark(f.c, s3.id, ses[1].id, 'A');
    assert.equal(calc.computeCourse(f.c).byId[s3.id].total, 84);
    assert.deepEqual(everything(f.c), before);
    // Only the roster count and the status column show the withdrawn student.
    assert.equal(stats.perTeam(f.c)[0].members, 3);
    assert.equal(stats.perTeam(f.c)[0].activeMembers, 2);
    assert.equal(stats.statusDistribution(f.c).withdrawn, 1);
  });

  test('a course whose students are all withdrawn: empty statistics, no crash', () => {
    const c = model.createCourse('SE4351');
    withTotal(c, 'Student 01', 'Alpha', 90, { status: 'withdrawn' });
    const r = calc.computeCourse(c);
    assert.deepEqual(stats.activeTotals(c, r), []);
    assert.equal(stats.describe(stats.activeTotals(c, r)).count, 0);
    assert.equal(stats.statusDistribution(c, r).active, 0);
    assert.equal(stats.statusDistribution(c, r).withdrawn, 1);
    stats.letterDistribution(c, r).forEach((x) => { assert.equal(x.count, 0); assert.equal(x.pct, null); });
    assert.equal(stats.passRate(c, r).pct, null);
    stats.perAssessment(c, r).forEach((x) => { assert.equal(x.n, 0); assert.equal(x.missing, 0); assert.equal(x.mean, null); assert.equal(x.meanPct, null); });
    assert.deepEqual(stats.perTeam(c, r), []);
    assert.deepEqual(stats.topBottom(c, r), { top: [], bottom: [] });
    assert.deepEqual(stats.borderline(c, r), []);
    assert.deepEqual(stats.gaps(c, r), []);
    const sim = stats.simulate(c, r, c.settings.letterScale);
    assert.deepEqual([sim.students, sim.changes, sim.byId, sim.finalChanges], [[], [], {}, { onlyEmpty: 0, all: 0 }]);
    assert.deepEqual(stats.lettersFromScale(c, r, c.settings.letterScale), []);
  });
});

// ================================================================ perAssessment()

describe('perAssessment: effective entries, team scores, overrides, participation out of 5', () => {
  test('one entry per assessment with n / missing / invalid and stats of the raw scores', () => {
    const f = fixture();
    const pa = stats.perAssessment(f.c, calc.computeCourse(f.c));
    assert.deepEqual(pa.map((x) => x.assessmentId), FIVE);
    const by = Object.fromEntries(pa.map((x) => [x.assessmentId, x]));

    // Project I (team-graded): S1 90 (team A), S2 60 (override), S4 70 and S5 70 (team B), S6 100 (no team: own).
    // Mean 390 / 5 = 78; sorted 60 70 70 90 100 -> median 70. Squared deviations 144 324 64 64 484 = 1080 -> variance 270.
    assert.deepEqual(by[P1], {
      assessmentId: P1, name: 'Project I', maxScore: 100, weight: 10, teamGraded: true,
      n: 5, missing: 0, invalid: 0, mean: 78, median: 70, min: 60, max: 100,
      sd: util.fix(Math.sqrt(270)), meanPct: 78
    });
    // Project II: team A 80 twice (the withdrawn S3's override 50 is not counted), team B 100 twice, S6 empty.
    // Mean 360 / 4 = 90; median h = 1.5 -> 80 + 0.5 * 20 = 90; deviations +-10 -> 400 / 3.
    assert.equal(by[P2].n, 4);
    assert.equal(by[P2].missing, 1);
    assert.equal(by[P2].invalid, 0);
    assert.equal(by[P2].mean, 90);
    assert.equal(by[P2].median, 90);
    assert.deepEqual([by[P2].min, by[P2].max], [80, 100]);
    assert.equal(by[P2].sd, util.fix(Math.sqrt(400 / 3)));
    // Test 1: 80, 70, 60, 92 (S5 invalid 'abs' counts as missing AND invalid). Mean 302 / 4 = 75.5; median (70 + 80) / 2 = 75.
    assert.deepEqual([by[T1].n, by[T1].missing, by[T1].invalid, by[T1].mean, by[T1].median, by[T1].min, by[T1].max], [4, 1, 1, 75.5, 75, 60, 92]);
    assert.equal(by[T1].meanPct, 75.5);
    // Test 2: 90, 75, 50, 95, 96 -> 406 / 5 = 81.2; median 90.
    assert.deepEqual([by[T2].n, by[T2].mean, by[T2].median, by[T2].min, by[T2].max], [5, 81.2, 90, 50, 96]);
    // Participation (max 5): 5, 4, 3, 4.5, 5 -> mean 21.5 / 5 = 4.3; meanPct = 4.3 * 100 / 5 = 86 (its OWN max).
    assert.deepEqual([by[PART].maxScore, by[PART].weight, by[PART].n, by[PART].mean, by[PART].median, by[PART].min, by[PART].max],
      [5, 5, 5, 4.3, 4.5, 3, 5]);
    assert.equal(by[PART].meanPct, 86);
    // n + missing = active students, for every item.
    pa.forEach((x) => assert.equal(x.n + x.missing, 5));
  });

  test('assessmentValues: raw values and percent of max; participation 4.5 of 5 is 90% -> 90 - 100', () => {
    const f = fixture();
    const r = calc.computeCourse(f.c);
    assert.deepEqual(stats.assessmentValues(f.c, r, PART), [5, 4, 3, 4.5, 5]);
    const pct = stats.assessmentValues(f.c, r, PART, { percent: true });
    assert.deepEqual(pct, [100, 80, 60, 90, 100]);
    // 100, 90, 100 -> '90 - 100'; 80 -> '80 - 89'; 60 -> '60 - 69'.
    assert.deepEqual(counts(stats.bins10(pct)), [0, 3, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(stats.assessmentValues(f.c, r, P1), [90, 60, 70, 70, 100]);
    assert.deepEqual(stats.assessmentValues(f.c, r, 'a_nope'), []);
    // Max 30: 24 of 30 is 80% exactly (multiply first: 24 * 100 / 30).
    asmt(f.c, T1).maxScore = 30;
    setScore(f.c, f.s1, T1, 24);
    assert.equal(stats.assessmentValues(f.c, calc.computeCourse(f.c), T1, { percent: true })[0], 80);
  });

  test('a late penalty does not change the raw score used here; an empty item has null stats', () => {
    const c = model.createCourse('SE6362'); // has Term Paper (weight 0)
    const s = withTotal(c, 'Student 01', 'Alpha', 80);
    model.setEntry(c.scores, s.id, T1, { value: 80, weeksLate: 1 });
    const pa = stats.perAssessment(c);
    assert.equal(pa.find((x) => x.assessmentId === T1).mean, 80);
    const paper = pa.find((x) => x.assessmentId === 'a_paper');
    assert.deepEqual([paper.weight, paper.n, paper.missing, paper.mean, paper.median, paper.sd, paper.meanPct], [0, 0, 1, null, null, null, null]);
    assert.equal(pa.find((x) => x.assessmentId === T2).sd, null, 'one value: no sample SD');
  });
});

// ================================================================ perTeam()

describe('perTeam', () => {
  test('one entry per team plus "No team"; active members only; team scores; overrides; avgUnexcused', () => {
    const f = fixture();
    const ses = f.c.attendance.sessions;
    // Unexcused (A) marks: S1 2, S2 1, S4 1, S5 0 (one E), S6 0; the withdrawn S3 has 2 (ignored).
    const marks = [[f.s1, 'A', 'A'], [f.s2, 'P', 'A'], [f.s3, 'A', 'A'], [f.s4, 'A', 'P'], [f.s5, 'E', 'P'], [f.s6, 'P', 'P']];
    marks.forEach(([s, m0, m1]) => {
      attendance.setMark(f.c, s.id, ses[0].id, m0);
      attendance.setMark(f.c, s.id, ses[1].id, m1);
    });
    const teams = stats.perTeam(f.c, calc.computeCourse(f.c));
    // Team A: S1 86, S2 73.5 -> mean 79.75; S3 withdrawn counts only in members. Avg unexcused (2 + 1) / 2 = 1.5.
    assert.deepEqual(teams[0], {
      teamId: f.tA.id, name: 'Team A', members: 3, activeMembers: 2, mean: 79.75, min: 73.5, max: 86,
      teamScores: { [P1]: 90, [P2]: 80 }, overrides: 1, avgUnexcused: 1.5
    });
    // Team B: 65, 69.5 -> 67.25. Avg unexcused (1 + 0) / 2 = 0.5.
    assert.deepEqual(teams[1], {
      teamId: f.tB.id, name: 'Team B', members: 2, activeMembers: 2, mean: 67.25, min: 65, max: 69.5,
      teamScores: { [P1]: 70, [P2]: 100 }, overrides: 0, avgUnexcused: 0.5
    });
    // No team: S6 76.4.
    assert.deepEqual(teams[2], {
      teamId: null, name: 'No team', members: 1, activeMembers: 1, mean: 76.4, min: 76.4, max: 76.4,
      teamScores: {}, overrides: 0, avgUnexcused: 0
    });
    assert.equal(teams.length, 3);
  });

  test('attendance off: no avgUnexcused key; totals mode uses the totals', () => {
    const f = fixture();
    attendance.setMode(f.c, 'off');
    stats.perTeam(f.c).forEach((x) => assert.equal('avgUnexcused' in x, false));
    attendance.setMode(f.c, 'totals');
    attendance.setSessionsHeld(f.c, 20);
    attendance.setTotals(f.c, f.s1.id, { absent: 3, excused: 1 });
    attendance.setTotals(f.c, f.s2.id, { absent: 2 });
    attendance.setTotals(f.c, f.s3.id, { absent: 9 }); // withdrawn
    const teams = stats.perTeam(f.c);
    assert.equal(teams[0].avgUnexcused, 2.5); // (3 + 2) / 2
    assert.equal(teams[1].avgUnexcused, 0);
  });

  test('empty teams, an unknown team id, an empty or invalid team score, and "No team" only for active students', () => {
    const c = model.createCourse('SE4351');
    const t1 = addTeam(c, 'Team 1');
    const t2 = addTeam(c, 'Team 2');
    const t3 = addTeam(c, 'Team 3');
    model.setEntry(c.teamScores, t1.id, P1, { value: null, text: 'tbd' });
    setTeamScore(c, t1, P2, 88);
    withTotal(c, 'Student 01', 'Alpha', 70, { teamId: t1.id });
    withTotal(c, 'Student 02', 'Bravo', 80, { teamId: t2.id, status: 'withdrawn' });
    withTotal(c, 'Student 03', 'Charlie', 60, { status: 'withdrawn' }); // no team, withdrawn
    let teams = stats.perTeam(c);
    assert.deepEqual(teams.map((x) => x.name), ['Team 1', 'Team 2', 'Team 3'], 'no "No team" entry for a withdrawn student');
    assert.deepEqual(teams[0].teamScores, { [P1]: null, [P2]: 88 });
    assert.deepEqual([teams[1].members, teams[1].activeMembers, teams[1].mean, teams[1].min, teams[1].max], [1, 0, null, null, null]);
    assert.deepEqual([teams[2].members, teams[2].activeMembers, teams[2].mean, teams[2].avgUnexcused], [0, 0, null, null]);
    // A student whose team no longer exists is in "No team".
    withTotal(c, 'Student 04', 'Delta', 90, { teamId: 't_gone' });
    teams = stats.perTeam(c);
    assert.equal(teams.length, 4);
    assert.deepEqual([teams[3].teamId, teams[3].name, teams[3].members, teams[3].activeMembers, teams[3].mean], [null, 'No team', 2, 1, 90]);
  });
});

// ================================================================ topBottom()

describe('topBottom: ties by name, active only, effective letters', () => {
  /* Totals (inserted in reverse name order, so storage order is not name order):
   *   Student 06 Foxtrot 60, Student 05 Echo 70, Student 04 Delta 70, Student 03 Charlie 80,
   *   Student 02 Bravo 90, Student 01 Alpha 90; withdrawn Student 00 Zulu 99 and Student 07 Golf 10.
   * Competition ranks: 90 90 -> 1 1; 80 -> 3; 70 70 -> 4 4; 60 -> 6. */
  function ties() {
    const c = model.createCourse('SE4351');
    const s = {};
    s.f = withTotal(c, 'Student 06', 'Foxtrot', 60);
    s.e = withTotal(c, 'Student 05', 'Echo', 70);
    s.d = withTotal(c, 'Student 04', 'Delta', 70);
    s.c = withTotal(c, 'Student 03', 'Charlie', 80);
    s.b = withTotal(c, 'Student 02', 'Bravo', 90, { finalLetter: 'A' });
    s.a = withTotal(c, 'Student 01', 'Alpha', 90);
    withTotal(c, 'Student 00', 'Zulu', 99, { status: 'withdrawn' });
    withTotal(c, 'Student 07', 'Golf', 10, { status: 'withdrawn' });
    return { c, s };
  }

  test('n = 2 and 3: equal totals ordered by name in both lists, bottom lowest first, ranks shared', () => {
    const { c, s } = ties();
    const r = calc.computeCourse(c);
    const tb2 = stats.topBottom(c, r, 2);
    assert.deepEqual(tb2.top, [
      { studentId: s.a.id, total: 90, letter: 'A-', rank: 1 },
      { studentId: s.b.id, total: 90, letter: 'A', rank: 1 } // final letter A (effective)
    ]);
    assert.deepEqual(tb2.bottom, [
      { studentId: s.f.id, total: 60, letter: 'D-', rank: 6 },
      { studentId: s.d.id, total: 70, letter: 'C-', rank: 4 } // Delta before Echo (name)
    ]);
    const tb3 = stats.topBottom(c, r, 3);
    assert.deepEqual(tb3.top.map((x) => x.studentId), [s.a.id, s.b.id, s.c.id]);
    assert.equal(tb3.top[2].rank, 3);
    assert.deepEqual(tb3.bottom.map((x) => x.studentId), [s.f.id, s.d.id, s.e.id]);
    assert.deepEqual(tb3.bottom.map((x) => x.rank), [6, 4, 4]);
  });

  test('suggested letters on request; default n = 5; n = 0; n above the class size; withdrawn never listed', () => {
    const { c, s } = ties();
    const r = calc.computeCourse(c);
    assert.equal(stats.topBottom(c, r, 2, { letters: 'suggested' }).top[1].letter, 'A-');
    const d = stats.topBottom(c, r);
    assert.equal(d.top.length, 5);
    assert.equal(d.bottom.length, 5);
    assert.deepEqual(d.top.map((x) => x.total), [90, 90, 80, 70, 70]);
    assert.deepEqual(d.bottom.map((x) => x.total), [60, 70, 70, 80, 90]);
    assert.deepEqual(stats.topBottom(c, r, 0), { top: [], bottom: [] });
    const all = stats.topBottom(c, r, 50);
    assert.equal(all.top.length, 6);
    assert.equal(all.bottom.length, 6);
    assert.equal(all.top[5].studentId, s.f.id);
    assert.ok(!all.top.some((x) => x.total === 99 || x.total === 10));
  });
});

// ================================================================ borderline()

describe('borderline: within N points below the next letter, in each rounding mode', () => {
  /* Unrounded totals: 97.5 (A+, top band), 92.995, 89.6, 89.4, 86, 85.9; withdrawn 89.9.
   * Undergraduate cutoffs: A+ 97, A 93, A- 90, B+ 87, B 83. */
  function border(rounding) {
    const c = model.createCourse('SE4351');
    c.settings.rounding = rounding;
    const s = {};
    s.top = withTotal(c, 'Student 01', 'Alpha', 97.5);
    s.a = withTotal(c, 'Student 02', 'Bravo', 92.995);
    s.b = withTotal(c, 'Student 03', 'Charlie', 89.6);
    s.c = withTotal(c, 'Student 04', 'Delta', 89.4);
    s.d = withTotal(c, 'Student 05', 'Echo', 86);
    s.e = withTotal(c, 'Student 06', 'Foxtrot', 85.9);
    s.w = withTotal(c, 'Student 07', 'Golf', 89.9, { status: 'withdrawn' });
    return { c, s };
  }
  const gapsOf = (list) => list.map((x) => [x.studentId, x.nextLetter, x.gap]);

  test('fixture totals are exact', () => {
    const { c, s } = border('none');
    const r = calc.computeCourse(c);
    assert.deepEqual([s.top, s.a, s.b, s.c, s.d, s.e].map((x) => r.byId[x.id].totalUnrounded), [97.5, 92.995, 89.6, 89.4, 86, 85.9]);
  });

  test("rounding 'none': gap = cutoff - total; 85.9 (1.1 below B+) is out; the top band never listed", () => {
    const { c, s } = border('none');
    assert.equal(calc.minTotalForLetter('A', c.settings), 93);
    const list = stats.borderline(c, calc.computeCourse(c), 1);
    // 92.995 -> A at 93: 0.005; 89.6 -> A- at 90: 0.4; 89.4: 0.6; 86 -> B+ at 87: exactly 1 (included).
    assert.deepEqual(gapsOf(list), [[s.a.id, 'A', 0.005], [s.b.id, 'A-', 0.4], [s.c.id, 'A-', 0.6], [s.d.id, 'B+', 1]]);
    assert.deepEqual(list[1], {
      studentId: s.b.id, total: 89.6, totalUnrounded: 89.6, letter: 'B+', suggestedLetter: 'B+', nextLetter: 'A-',
      cutoff: 90, minTotal: 90, gap: 0.4, finalAtOrAboveNext: false
    });
    // Wider window: 85.9 joins (1.1); default window is 1.
    assert.deepEqual(stats.borderline(c, null, 1.5).map((x) => x.studentId), [s.a.id, s.b.id, s.c.id, s.d.id, s.e.id]);
    assert.deepEqual(stats.borderline(c), list);
    assert.deepEqual(stats.borderline(c, null, 0.5).map((x) => x.studentId), [s.a.id, s.b.id]);
    assert.deepEqual(stats.borderline(c, null, 0), []);
  });

  test("rounding 'integer': the threshold is cutoff - 0.5 (89.6 already earns A-; 89.4 is 0.1 short)", () => {
    const { c, s } = border('integer');
    assert.equal(calc.minTotalForLetter('A-', c.settings), 89.5);
    assert.equal(calc.minTotalForLetter('B+', c.settings), 86.5);
    const list = stats.borderline(c, calc.computeCourse(c), 1);
    // 92.995 rounds to 93 (A); next A+ needs 96.5: 3.505 away. 89.6 rounds to 90 (A-); next A needs 92.5: 2.9 away.
    // 89.4 -> 89 (B+): A- needs 89.5 -> 0.1. 86 (B): B+ needs 86.5 -> 0.5. 85.9 -> 86 (B): 0.6.
    assert.deepEqual(gapsOf(list), [[s.c.id, 'A-', 0.1], [s.d.id, 'B+', 0.5], [s.e.id, 'B+', 0.6]]);
    assert.deepEqual([list[0].total, list[0].totalUnrounded, list[0].cutoff, list[0].minTotal], [89, 89.4, 90, 89.5]);
  });

  test("rounding 'hundredth': the threshold is cutoff - 0.005 (92.995 rounds to 93.00 = A)", () => {
    const { c, s } = border('hundredth');
    assert.equal(calc.minTotalForLetter('A-', c.settings), 89.995);
    const list = stats.borderline(c, calc.computeCourse(c), 1);
    // 92.995 -> 93 (A): A+ needs 96.995, 4 away. 89.6: 89.995 - 89.6 = 0.395. 89.4: 0.595. 86: 86.995 - 86 = 0.995.
    // 85.9: 1.095 (out).
    assert.deepEqual(gapsOf(list), [[s.b.id, 'A-', 0.395], [s.c.id, 'A-', 0.595], [s.d.id, 'B+', 0.995]]);
  });

  test('the curve counts (totalUnrounded includes it); effective letters; finalAtOrAboveNext', () => {
    const { c, s } = border('none');
    c.settings.curve = 0.5; // 89.4 -> 89.9 (0.1 from A-), 89.6 -> 90.1 (A-; A at 93 is 2.9 away)
    s.c.finalLetter = 'A-'; // raised by hand
    s.d.finalLetter = 'C'; // lowered by hand
    const list = stats.borderline(c, null, 1);
    // 92.995 + 0.5 = 93.495 (A; A+ 3.505 away). 86.5 -> B+ needs 87: 0.5. 86.4: 0.6.
    assert.deepEqual(gapsOf(list), [[s.c.id, 'A-', 0.1], [s.d.id, 'B+', 0.5], [s.e.id, 'B+', 0.6]]);
    assert.deepEqual([list[0].letter, list[0].suggestedLetter, list[0].finalAtOrAboveNext], ['A-', 'B+', true]);
    assert.deepEqual([list[1].letter, list[1].suggestedLetter, list[1].finalAtOrAboveNext], ['C', 'B', false]);
    assert.equal(stats.borderline(c, null, 1, { letters: 'suggested' })[0].letter, 'B+');
    // The withdrawn student (89.9 + 0.5 = 90.4) is never listed.
    assert.ok(!stats.borderline(c, null, 50).some((x) => x.studentId === s.w.id));
  });

  test('equal gaps: ordered by name', () => {
    const c = model.createCourse('SE4351');
    const z = withTotal(c, 'Student 09', 'Zulu', 89.5);
    const y = withTotal(c, 'Student 02', 'Yankee', 89.5);
    const x = withTotal(c, 'Student 05', 'Xray', 82.5);
    assert.deepEqual(stats.borderline(c).map((it) => [it.studentId, it.gap]), [[y.id, 0.5], [x.id, 0.5], [z.id, 0.5]]);
  });

  test('a total below every cutoff (negative curve) still finds the next letter above F', () => {
    const c = model.createCourse('SE4351');
    c.settings.curve = -1;
    const s = withTotal(c, 'Student 01', 'Alpha', 60.5); // 59.5: F, 0.5 below D- (60)
    const t = withTotal(c, 'Student 02', 'Bravo', 0.5); // -0.5: F (below every cutoff), D- is 60.5 away
    const list = stats.borderline(c, null, 100);
    assert.deepEqual(list.map((x) => [x.studentId, x.letter, x.nextLetter, x.gap]), [[s.id, 'F', 'D-', 0.5], [t.id, 'F', 'D-', 60.5]]);
  });
});

// ================================================================ gaps()

describe('gaps: natural breaks between the sorted active totals', () => {
  test('fixture totals 65, 69.5, 73.5, 76.4, 86 (withdrawn 84 ignored): gaps 9.6, 4.5, 4, 2.9', () => {
    const f = fixture();
    const r = calc.computeCourse(f.c);
    assert.deepEqual(stats.gaps(f.c, r, 1), [
      { below: 76.4, above: 86, gap: 9.6, mid: 81.2, countAbove: 1 },
      { below: 65, above: 69.5, gap: 4.5, mid: 67.25, countAbove: 4 },
      { below: 69.5, above: 73.5, gap: 4, mid: 71.5, countAbove: 3 },
      { below: 73.5, above: 76.4, gap: 2.9, mid: 74.95, countAbove: 2 }
    ]);
    assert.deepEqual(stats.gaps(f.c, r), stats.gaps(f.c, r, 1), 'default minGap 1');
    assert.deepEqual(stats.gaps(f.c, r, 4).map((g) => g.gap), [9.6, 4.5, 4], 'gap >= minGap is kept');
    assert.deepEqual(stats.gaps(f.c, r, 4.5).map((g) => g.gap), [9.6, 4.5]);
    assert.deepEqual(stats.gaps(f.c, r, 10), []);
  });

  test('equal totals never form a gap; equal gaps are ordered by the higher total first', () => {
    const c = model.createCourse('SE4351');
    [90, 90, 80, 70, 70, 60].forEach((v, i) => withTotal(c, 'Student 0' + i, 'Alpha', v));
    assert.deepEqual(stats.gaps(c, null, 0).map((g) => [g.below, g.above, g.gap, g.countAbove]), [
      [80, 90, 10, 2], [70, 80, 10, 3], [60, 70, 10, 5]
    ]);
  });

  test('gaps use the rounded total (the value the Suggested letter uses)', () => {
    const c = model.createCourse('SE4351');
    c.settings.rounding = 'integer';
    withTotal(c, 'Student 01', 'Alpha', 89.4); // 89
    withTotal(c, 'Student 02', 'Bravo', 85.9); // 86
    assert.deepEqual(stats.gaps(c), [{ below: 86, above: 89, gap: 3, mid: 87.5, countAbove: 1 }]);
    assert.deepEqual(stats.gaps(model.createCourse('SE4351')), []);
  });
});

// ================================================================ simulate() and lettersFromScale()

describe('simulate and lettersFromScale (cutoff planner)', () => {
  // Fixture: S1 86, S2 73.5 (final C+), S4 65 (final F), S5 69.5, S6 76.4; withdrawn S3 84 (final A).
  // Sandbox (unsorted, no F row): A 90, B 80, C 70, D 60 -> normalized A 90, B 80, C 70, D 60, F 0.
  const SANDBOX = [{ letter: 'C', min: 70 }, { letter: 'A', min: 90 }, { letter: 'D', min: 60 }, { letter: 'B', min: 80 }];

  test('simulated letters, distribution and changes against the effective letters; nothing is saved', () => {
    const f = fixture();
    const before = JSON.stringify(f.c);
    const sandboxBefore = JSON.stringify(SANDBOX);
    const r = calc.computeCourse(f.c);
    const sim = stats.simulate(f.c, r, SANDBOX);
    assert.equal(JSON.stringify(f.c), before, 'course unchanged');
    assert.equal(JSON.stringify(SANDBOX), sandboxBefore, 'sandbox unchanged');
    assert.deepEqual(sim.scale, [
      { letter: 'A', min: 90 }, { letter: 'B', min: 80 }, { letter: 'C', min: 70 }, { letter: 'D', min: 60 }, { letter: 'F', min: 0 }
    ]);
    // 86 -> B, 76.4 -> C, 73.5 -> C, 69.5 -> D, 65 -> D.
    assert.deepEqual(sim.byId, { [f.s1.id]: 'B', [f.s2.id]: 'C', [f.s4.id]: 'D', [f.s5.id]: 'D', [f.s6.id]: 'C' });
    assert.deepEqual(sim.distribution, [
      { letter: 'A', min: 90, count: 0, pct: 0, inScale: true },
      { letter: 'B', min: 80, count: 1, pct: 20, inScale: true },
      { letter: 'C', min: 70, count: 2, pct: 40, inScale: true },
      { letter: 'D', min: 60, count: 2, pct: 40, inScale: true },
      { letter: 'F', min: 0, count: 0, pct: 0, inScale: true }
    ]);
    // Students by total descending; current = effective letter.
    assert.deepEqual(sim.students, [
      { studentId: f.s1.id, total: 86, suggested: 'B', finalLetter: null, current: 'B', simulated: 'B', changed: false },
      { studentId: f.s6.id, total: 76.4, suggested: 'C', finalLetter: null, current: 'C', simulated: 'C', changed: false },
      { studentId: f.s2.id, total: 73.5, suggested: 'C', finalLetter: 'C+', current: 'C+', simulated: 'C', changed: true },
      { studentId: f.s5.id, total: 69.5, suggested: 'D+', finalLetter: null, current: 'D+', simulated: 'D', changed: true },
      { studentId: f.s4.id, total: 65, suggested: 'D', finalLetter: 'F', current: 'F', simulated: 'D', changed: true }
    ]);
    assert.deepEqual(sim.changes.map((x) => x.studentId), [f.s2.id, f.s5.id, f.s4.id]);
    // "Use these as final letters": without a final letter -> S1, S6, S5 (3); all -> also S2 (C+ -> C) and S4 (F -> D).
    assert.deepEqual(sim.finalChanges, { onlyEmpty: 3, all: 5 });
  });

  test("{ letters: 'suggested' }: current is the cutoff suggestion", () => {
    const f = fixture();
    const sim = stats.simulate(f.c, null, SANDBOX, { letters: 'suggested' });
    // Only S5 changes: D+ -> D (S4's suggestion is already D).
    assert.deepEqual(sim.changes.map((x) => [x.studentId, x.current, x.simulated]), [[f.s5.id, 'D+', 'D']]);
  });

  test("the course's own scale changes no suggested letter and matches letterDistribution (suggested)", () => {
    const f = fixture();
    const r = calc.computeCourse(f.c);
    const sim = stats.simulate(f.c, r, f.c.settings.letterScale, { letters: 'suggested' });
    assert.deepEqual(sim.changes, []);
    assert.deepEqual(sim.distribution, stats.letterDistribution(f.c, r, { letters: 'suggested' }));
  });

  test('simulate works from the rounded total (rounding integer: 89.6 -> 90 = A-)', () => {
    const c = model.createCourse('SE4351');
    c.settings.rounding = 'integer';
    const s = withTotal(c, 'Student 01', 'Alpha', 89.6);
    assert.equal(stats.simulate(c, null, c.settings.letterScale).byId[s.id], 'A-');
    assert.equal(stats.simulate(c, null, [{ letter: 'A', min: 90.4 }]).byId[s.id], 'F', 'total 90 is below 90.4');
  });

  test('lettersFromScale: all active students (course order) or only those without a final letter', () => {
    const f = fixture();
    const r = calc.computeCourse(f.c);
    assert.deepEqual(stats.lettersFromScale(f.c, r, SANDBOX), [
      { studentId: f.s1.id, letter: 'B' }, { studentId: f.s2.id, letter: 'C' }, { studentId: f.s4.id, letter: 'D' },
      { studentId: f.s5.id, letter: 'D' }, { studentId: f.s6.id, letter: 'C' }
    ]);
    assert.deepEqual(stats.lettersFromScale(f.c, r, SANDBOX, { onlyEmpty: true }), [
      { studentId: f.s1.id, letter: 'B' }, { studentId: f.s5.id, letter: 'D' }, { studentId: f.s6.id, letter: 'C' }
    ]);
  });

  test('lettersFromScale + model.setFinalLetters: changed counts equal finalChanges, letters equal the simulation', () => {
    const a = fixture();
    const simA = stats.simulate(a.c, null, SANDBOX);
    const outA = model.setFinalLetters(a.c, stats.lettersFromScale(a.c, null, SANDBOX, { onlyEmpty: true }));
    assert.equal(outA.changed, simA.finalChanges.onlyEmpty);
    assert.equal(outA.skipped, 0);
    assert.deepEqual([a.s1, a.s2, a.s3, a.s4, a.s5, a.s6].map((s) => s.finalLetter), ['B', 'C+', 'A', 'F', 'D', 'C']);

    const b = fixture();
    const simB = stats.simulate(b.c, null, SANDBOX);
    const outB = model.setFinalLetters(b.c, stats.lettersFromScale(b.c, null, SANDBOX));
    assert.equal(outB.changed, simB.finalChanges.all);
    const r = calc.computeCourse(b.c);
    r.activeIds.forEach((id) => assert.equal(r.byId[id].effectiveLetter, simB.byId[id]));
    assert.equal(b.s3.finalLetter, 'A', 'withdrawn student untouched');
    // Applying again changes nothing.
    assert.deepEqual(stats.simulate(b.c, null, SANDBOX).finalChanges, { onlyEmpty: 0, all: 0 });
  });

  test('letters outside the course scale are left out; letters are spelled as the course scale spells them', () => {
    const f = fixture();
    // P is not an undergraduate letter: everyone below 80 gets P and is left out; 86 -> A.
    const odd = [{ letter: 'A', min: 80 }, { letter: 'P', min: 60 }];
    assert.deepEqual(stats.lettersFromScale(f.c, null, odd), [{ studentId: f.s1.id, letter: 'A' }]);
    const sim = stats.simulate(f.c, null, odd);
    assert.deepEqual(sim.finalChanges, { onlyEmpty: 1, all: 1 });
    assert.equal(sim.byId[f.s2.id], 'P');
    // 'b+' is matched to the scale's 'B+'.
    assert.deepEqual(stats.lettersFromScale(f.c, null, [{ letter: 'b+', min: 80 }]).slice(0, 1), [{ studentId: f.s1.id, letter: 'B+' }]);
  });

  test('a malformed sandbox scale falls back like normalizeLetterScale (default scale for the level)', () => {
    const f = fixture();
    const sim = stats.simulate(f.c, null, [{ letter: '', min: 50 }, { letter: 'X', min: -1 }, null]);
    assert.deepEqual(sim.scale, model.defaultLetterScale('undergraduate'));
    assert.equal(sim.byId[f.s1.id], 'B');
  });
});

// ================================================================ sample data invariants

describe('sample data (SE 4351 and SE 6362): invariants the Statistics view relies on', () => {
  ['SE4351', 'SE6362'].forEach((tpl) => {
    test(`${tpl}: panel = describe(active totals), bins add up to Count, letters add up to active, n + missing = active`, () => {
      const c = model.createCourse(tpl);
      sample.loadInto(c);
      const r = calc.computeCourse(c);
      const totals = stats.activeTotals(c, r);
      const d = stats.describe(totals);
      const st = stats.statusDistribution(c, r);
      assert.equal(d.count, r.activeIds.length);
      assert.equal(st.active, d.count);
      assert.equal(st.active + st.withdrawn, c.students.length);
      assert.equal(st.complete + st.incomplete, st.active);
      assert.equal(d.mean, r.average);
      assert.equal(util.sum(counts(stats.bins10(totals))), d.count);
      assert.equal(util.sum(counts(stats.histogram(totals))), d.count);
      assert.equal(util.sum(counts(stats.histogram(totals, 5))), d.count);
      assert.equal(util.sum(stats.letterDistribution(c, r).map((x) => x.count)), d.count);
      near(util.sum(stats.letterDistribution(c, r).map((x) => x.pct)), 100, 1e-6);
      stats.perAssessment(c, r).forEach((x) => assert.equal(x.n + x.missing, d.count));
      const teams = stats.perTeam(c, r);
      assert.equal(util.sum(teams.map((x) => x.activeMembers)), d.count);
      assert.equal('avgUnexcused' in teams[0], c.attendance.mode !== 'off');
      const tb = stats.topBottom(c, r);
      assert.equal(tb.top[0].total, d.max);
      assert.equal(tb.bottom[0].total, d.min);
      assert.equal(tb.top[0].rank, 1);
      // Gaps between neighbours add up to the range.
      near(util.sum(stats.gaps(c, r, 0).map((g) => g.gap)), d.range, 1e-6);
      // Each borderline student is really below the next letter's threshold.
      stats.borderline(c, r, 2).forEach((b) => {
        assert.ok(b.gap > 0 && b.gap <= 2);
        assert.equal(r.byId[b.studentId].letter, b.suggestedLetter);
        near(r.byId[b.studentId].totalUnrounded + b.gap, calc.minTotalForLetter(b.nextLetter, c.settings));
      });
    });
  });
});
