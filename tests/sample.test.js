'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../js/core/model.js');
const calc = require('../js/core/calc.js');
const sample = require('../js/core/sample.js');

const NATO = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett',
  'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango',
  'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'
];

function loaded(template, overrides) {
  const course = model.createCourse(template, overrides);
  const result = sample.loadInto(course);
  return { course, result };
}

function teamSizes(course) {
  return course.teams.map((t) => course.students.filter((s) => s.teamId === t.id).length);
}

function marksOf(course, student) {
  const row = course.attendance.records[student.id] || {};
  return course.attendance.sessions.map((ses) => row[ses.id]);
}

/** Longest run of consecutive absences (A or E). */
function longestStreak(marks) {
  let cur = 0, best = 0;
  for (const m of marks) {
    if (m === 'A' || m === 'E') { cur++; best = Math.max(best, cur); } else cur = 0;
  }
  return best;
}

function allOverrides(course) {
  const out = [];
  for (const sid of Object.keys(course.scores)) {
    for (const aid of Object.keys(course.scores[sid])) {
      if (course.scores[sid][aid].override) out.push({ sid, aid, entry: course.scores[sid][aid] });
    }
  }
  return out;
}

function allEntries(course) {
  const out = [];
  for (const map of [course.scores, course.teamScores]) {
    for (const owner of Object.keys(map)) {
      for (const aid of Object.keys(map[owner])) out.push({ owner, aid, entry: map[owner][aid] });
    }
  }
  return out;
}

/** Everything a load produces, without ids, in storage order. */
function snapshot(course) {
  const teamName = (id) => (model.findTeam(course, id) || {}).name || null;
  return {
    students: course.students.map((s) => ({
      no: s.no, lastName: s.lastName, firstName: s.firstName, status: s.status, notes: s.notes,
      team: teamName(s.teamId),
      scores: course.assessments.map((a) => {
        const d = calc.scoreDetail(course, s, a);
        return [a.id, d.raw, d.source];
      }),
      marks: marksOf(course, s).join('')
    })),
    teamScores: course.teams.map((t) => [t.name, course.assessments.map((a) => {
      const e = model.getEntry(course.teamScores, t.id, a.id);
      return e ? e.value : null;
    })])
  };
}

test('profileFor: SE4351-like and SE6362-like datasets', () => {
  const big = { studentCount: 59, teamSizes: [8, 8, 8, 7, 7, 7, 7, 7] };
  const small = { studentCount: 10, teamSizes: [4, 3, 3] };
  assert.deepEqual(sample.profileFor(model.createCourse('SE4351')), big);
  assert.deepEqual(sample.profileFor(model.createCourse('SE6362')), small);
  assert.deepEqual(sample.profileFor(model.createCourse('custom')), big);
  assert.deepEqual(sample.profileFor(model.createCourse('custom', { level: 'graduate' })), small);
  // The returned array is a copy.
  sample.profileFor(model.createCourse('SE4351')).teamSizes.push(99);
  assert.deepEqual(sample.profileFor(model.createCourse('SE4351')), big);
});

test('SE4351: 59 students in 8 teams of 7 to 8', () => {
  const { course, result } = loaded('SE4351');
  assert.deepEqual(result, { students: 59, teams: 8 });
  assert.equal(course.students.length, 59);
  assert.deepEqual(course.teams.map((t) => t.name), ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6', 'Team 7', 'Team 8']);
  assert.deepEqual(teamSizes(course), [8, 8, 8, 7, 7, 7, 7, 7]);
  for (const s of course.students) assert.ok(model.findTeam(course, s.teamId), `${s.lastName} has a team`);
  assert.ok(course.teams.every((t) => /^t_/.test(t.id)) && course.students.every((s) => /^s_/.test(s.id)));
});

test('SE6362: 10 students in 3 teams of about 3', () => {
  const { course, result } = loaded('SE6362');
  assert.deepEqual(result, { students: 10, teams: 3 });
  assert.equal(course.students.length, 10);
  assert.deepEqual(teamSizes(course), [4, 3, 3]);
  for (const s of course.students) assert.ok(model.findTeam(course, s.teamId));
});

test('custom course follows its level', () => {
  assert.deepEqual(loaded('custom').result, { students: 59, teams: 8 });
  assert.deepEqual(loaded('custom', { level: 'graduate' }).result, { students: 10, teams: 3 });
});

test('names are obviously fake: "Student NN" + NATO first names, No in name order', () => {
  for (const tpl of ['SE4351', 'SE6362']) {
    const { course } = loaded(tpl);
    course.students.forEach((s, i) => {
      assert.match(s.lastName, /^Student \d\d$/);
      assert.equal(s.lastName, 'Student ' + String(i + 1).padStart(2, '0'));
      assert.equal(s.firstName, NATO[i % 26]);
      assert.equal(s.no, i + 1);
    });
    const byName = calc.sortStudents(course, null, 'name', 'asc').map((s) => s.no);
    assert.deepEqual(byName, course.students.map((_, i) => i + 1));
    const noted = course.students.filter((s) => s.notes !== '');
    assert.ok(noted.length >= 1 && noted.length <= 4, 'a few notes');
    for (const s of noted) assert.match(s.notes, /^Sample note: /);
  }
});

test('teams are shuffled, not contiguous blocks of the name order', () => {
  for (const tpl of ['SE4351', 'SE6362']) {
    const { course } = loaded(tpl);
    const contiguous = course.teams.filter((t) => {
      const nos = course.students.filter((s) => s.teamId === t.id).map((s) => s.no).sort((a, b) => a - b);
      return nos[nos.length - 1] - nos[0] === nos.length - 1;
    });
    assert.equal(contiguous.length, 0, `${tpl}: no team is a contiguous block`);
  }
});

test('deterministic: two loads give the same names, teams, scores and attendance', () => {
  for (const [tpl, ov] of [['SE4351'], ['SE6362'], ['custom', { level: 'graduate' }]]) {
    const a = loaded(tpl, ov).course;
    const b = loaded(tpl, ov).course;
    assert.deepEqual(snapshot(a), snapshot(b));
    // Loading again into the same course replaces the data (nothing is appended).
    const before = snapshot(a);
    sample.loadInto(a);
    assert.deepEqual(snapshot(a), before);
    assert.equal(a.students.length, before.students.length);
  }
  // Different datasets really differ.
  const big = snapshot(loaded('SE4351').course);
  const custom = snapshot(loaded('custom').course);
  assert.notDeepEqual(big.students.map((s) => s.scores), custom.students.map((s) => s.scores));
});

test('adding an assessment does not change the values of the other assessments', () => {
  const plain = loaded('SE4351').course;
  const extra = model.createCourse('SE4351');
  extra.assessments.splice(2, 0, model.createAssessment({ id: 'a_quiz', name: 'Quiz', weight: 0 }));
  sample.loadInto(extra);
  const strip = (snap) => snap.students.map((s) => s.scores.filter((x) => x[0] !== 'a_quiz'));
  assert.deepEqual(strip(snapshot(extra)), strip(snapshot(plain)));
});

test('withdrawn: exactly 2 (SE4351) and 1 (SE6362); they keep Project I and Test 1 but not Test 2', () => {
  for (const [tpl, expected] of [['SE4351', 2], ['SE6362', 1]]) {
    const { course } = loaded(tpl);
    const withdrawn = course.students.filter((s) => s.status === 'withdrawn');
    assert.equal(withdrawn.length, expected);
    assert.equal(course.students.filter((s) => s.status === 'active').length, course.students.length - expected);
    for (const s of withdrawn) {
      const detail = (aid) => calc.scoreDetail(course, s, model.findAssessment(course, aid));
      assert.equal(detail('a_p1').state, 'number');
      assert.equal(detail('a_t1').state, 'number');
      assert.equal(detail('a_t2').state, 'empty');
    }
  }
});

test('exactly one per-member override on Project I, 10 points below the team score', () => {
  for (const tpl of ['SE4351', 'SE6362']) {
    const { course } = loaded(tpl);
    const overrides = allOverrides(course);
    assert.equal(overrides.length, 1, tpl);
    const o = overrides[0];
    const s = model.findStudent(course, o.sid);
    assert.equal(o.aid, 'a_p1');
    assert.equal(s.status, 'active');
    const team = course.teamScores[s.teamId].a_p1.value;
    assert.equal(o.entry.value, team - 10);
    assert.deepEqual(o.entry, { value: team - 10, override: true });
    const d = calc.scoreDetail(course, s, model.findAssessment(course, 'a_p1'));
    assert.equal(d.source, 'override');
    const results = calc.computeCourse(course);
    assert.equal(course.students.filter((x) => results.byId[x.id].overrideCount > 0).length, 1);
  }
});

test('incomplete: 2 active students (SE4351) and 1 (SE6362), each missing one weighted score', () => {
  for (const [tpl, expected] of [['SE4351', 2], ['SE6362', 1]]) {
    const { course } = loaded(tpl);
    const results = calc.computeCourse(course);
    const incomplete = results.activeIds.filter((id) => results.byId[id].incomplete);
    assert.equal(incomplete.length, expected, tpl);
    for (const id of incomplete) assert.equal(results.byId[id].missingCount, 1);
  }
});

test('score ranges per assessment and team propagation', () => {
  const { course } = loaded('SE6362');
  for (const t of course.teams) {
    const p1 = course.teamScores[t.id].a_p1.value;
    const p2 = course.teamScores[t.id].a_p2.value;
    assert.ok(Number.isInteger(p1) && p1 >= 80 && p1 <= 98, `P1 ${p1}`);
    assert.ok(Number.isInteger(p2) && p2 >= 78 && p2 <= 98, `P2 ${p2}`);
  }
  const big = loaded('SE4351').course;
  for (const c of [course, big]) {
    for (const s of c.students) {
      const e = c.scores[s.id] || {};
      assert.equal(e.a_p2, undefined, 'Project II comes from the team score only');
      if (e.a_t1) assert.ok(e.a_t1.value >= 40 && e.a_t1.value <= 100 && Number.isInteger(e.a_t1.value * 2));
      if (e.a_t2) assert.ok(e.a_t2.value >= 35 && e.a_t2.value <= 100 && Number.isInteger(e.a_t2.value * 2));
      // Participation is out of 5 (DECISIONS 1): 3..5 in steps of 0.5, always a drop-down value.
      if (e.a_part) {
        assert.ok(e.a_part.value >= 3 && e.a_part.value <= 5 && Number.isInteger(e.a_part.value * 2), `participation ${e.a_part.value}`);
        assert.ok(model.isChoiceValue(model.findAssessment(c, 'a_part'), e.a_part.value));
      }
      if (e.a_paper) assert.ok(Number.isInteger(e.a_paper.value) && e.a_paper.value >= 70 && e.a_paper.value <= 98);
    }
  }
  // Test 1 and Test 2 look like normal distributions around 80 and 76.
  const mean = (aid) => {
    const vals = big.students.map((s) => big.scores[s.id] && big.scores[s.id][aid]).filter(Boolean).map((e) => e.value);
    return vals.reduce((x, y) => x + y, 0) / vals.length;
  };
  assert.ok(Math.abs(mean('a_t1') - 80) < 5, `Test 1 mean ${mean('a_t1')}`);
  assert.ok(Math.abs(mean('a_t2') - 76) < 6, `Test 2 mean ${mean('a_t2')}`);
  // Term paper (SE6362 only): about 70% of students, the rest empty.
  const papers = course.students.filter((s) => course.scores[s.id] && course.scores[s.id].a_paper).length;
  assert.ok(papers >= 5 && papers <= 8, `papers ${papers}`);
  assert.ok(big.students.every((s) => !big.scores[s.id] || !big.scores[s.id].a_paper));
});

test('every generated score is a number within 0..maxScore, with no late-work data', () => {
  for (const tpl of ['SE4351', 'SE6362']) {
    const { course } = loaded(tpl);
    for (const { aid, entry } of allEntries(course)) {
      const a = model.findAssessment(course, aid);
      assert.ok(a, `assessment ${aid} exists`);
      assert.equal(typeof entry.value, 'number');
      assert.ok(entry.value >= 0 && entry.value <= a.maxScore, `${aid} ${entry.value}`);
      assert.equal(entry.weeksLate, undefined);
      assert.equal(entry.waived, undefined);
      assert.equal(entry.text, undefined);
    }
  }
});

test('values scale to non-100 max scores; unknown assessments get 60..100%', () => {
  const course = model.createCourse('SE4351');
  model.findAssessment(course, 'a_t1').maxScore = 50;
  model.findAssessment(course, 'a_p1').maxScore = 20;
  course.assessments.push(model.createAssessment({ id: 'a_quiz', name: 'Quiz', maxScore: 10, weight: 0 }));
  course.assessments.push(model.createAssessment({ id: 'a_demo', name: 'Demo', maxScore: 100, weight: 0, teamGraded: true }));
  sample.loadInto(course);
  for (const { aid, entry } of allEntries(course)) {
    const a = model.findAssessment(course, aid);
    assert.ok(entry.value >= 0 && entry.value <= a.maxScore, `${aid} ${entry.value} <= ${a.maxScore}`);
    assert.ok(Number.isInteger(entry.value * 2), `${aid} ${entry.value} rounded to 0.5`);
  }
  for (const s of course.students.filter((x) => x.status === 'active')) {
    const e = course.scores[s.id] || {};
    assert.ok(e.a_quiz && e.a_quiz.value >= 6 && e.a_quiz.value <= 10, 'quiz filled on a 10-point scale');
  }
  for (const t of course.teams) {
    assert.ok(course.teamScores[t.id].a_p1.value >= 16 && course.teamScores[t.id].a_p1.value <= 19.6);
    const demo = course.teamScores[t.id].a_demo.value;
    assert.ok(demo >= 60 && demo <= 100, 'unknown team-graded assessment gets team scores');
  }
  const [o] = allOverrides(course);
  const s = model.findStudent(course, o.sid);
  assert.equal(o.entry.value, course.teamScores[s.teamId].a_p1.value - 2, '10 points on 100 = 2 points on 20');
});

test('respects the team-graded flag: an individual Project I is written per student', () => {
  const course = model.createCourse('SE4351');
  model.findAssessment(course, 'a_p1').teamGraded = false;
  sample.loadInto(course);
  assert.equal(allOverrides(course).length, 0);
  for (const t of course.teams) {
    assert.equal(course.teamScores[t.id].a_p1, undefined);
    assert.equal(typeof course.teamScores[t.id].a_p2.value, 'number');
    const values = course.students.filter((s) => s.teamId === t.id).map((s) => course.scores[s.id].a_p1.value);
    assert.equal(new Set(values).size, 1, 'team work: members share the value');
  }
  assert.ok(!course.students.some((s) => /unequal/.test(s.notes)), 'no override note without an override');
});

test('attendance SE4351: special streak cases, no other streak of 3+', () => {
  const { course } = loaded('SE4351');
  const sessions = course.attendance.sessions;
  assert.equal(sessions.length, 26);
  const rows = course.students.map((s) => ({ s, marks: marksOf(course, s) }));
  for (const { marks } of rows) {
    assert.equal(marks.length, 26);
    for (const m of marks) assert.ok(['P', 'A', 'E'].includes(m));
  }
  const streaky = rows.filter((r) => longestStreak(r.marks) >= 3);
  assert.equal(streaky.length, 2, 'only the two planted streaks');
  const three = streaky.filter((r) => longestStreak(r.marks) === 3);
  const four = streaky.filter((r) => longestStreak(r.marks) === 4);
  assert.equal(three.length, 1);
  assert.equal(four.length, 1);
  for (const r of [three[0], four[0]]) {
    assert.equal(r.s.status, 'active');
    const len = longestStreak(r.marks);
    assert.ok(r.marks.join('').includes('P' + 'A'.repeat(len) + 'P'), 'streak of unexcused absences');
  }
  const scattered = rows.filter((r) => r.s.status === 'active' &&
    r.marks.filter((m) => m === 'A').length >= 5 && longestStreak(r.marks) < 3);
  assert.ok(scattered.length >= 1, 'a student with 5 scattered unexcused absences');
  // Mostly present overall.
  const all = rows.flatMap((r) => r.marks);
  const share = (m) => all.filter((x) => x === m).length / all.length;
  assert.ok(share('P') > 0.85 && share('P') < 0.97, `present ${share('P')}`);
  assert.ok(share('A') > 0.02 && share('E') > 0.005);
  assert.equal(course.attendance.mode, 'per-session');
});

test('attendance SE4351: one active student with 4 excused (allowed) absences, never two in a row, no unexcused', () => {
  const { course } = loaded('SE4351');
  const rows = course.students.map((s) => ({ s, marks: marksOf(course, s) }));
  const planted = rows.filter((r) => /excused by the instructor/.test(r.s.notes));
  assert.equal(planted.length, 1);
  const { s, marks } = planted[0];
  assert.equal(s.status, 'active');
  assert.equal(marks.filter((m) => m === 'E').length, 4);
  assert.equal(marks.filter((m) => m === 'A').length, 0);
  assert.ok(!marks.join('').includes('EE'), marks.join(''));
  assert.deepEqual(course.attendance.totals[s.id], { absent: 0, excused: 4 });
  // Its own role: not one of the streak, scattered, withdrawn or override students.
  assert.equal(longestStreak(marks), 1);
  assert.ok(!course.scores[s.id] || !Object.values(course.scores[s.id]).some((e) => e.override));
  // The small dataset and a course without sessions have no such student.
  assert.ok(!loaded('SE6362').course.students.some((x) => /excused/.test(x.notes)));
  assert.ok(!loaded('custom').course.students.some((x) => /excused/.test(x.notes)));
});

test('attendance SE6362: filled although the mode is off, no streak of 3+', () => {
  const { course } = loaded('SE6362');
  assert.equal(course.attendance.mode, 'off');
  assert.equal(Object.keys(course.attendance.records).length, 10);
  for (const s of course.students) {
    const marks = marksOf(course, s);
    assert.equal(marks.length, course.attendance.sessions.length);
    assert.ok(marks.every((m) => ['P', 'A', 'E'].includes(m)));
    assert.ok(longestStreak(marks) < 3, `${s.lastName} ${marks.join('')}`);
  }
});

test('attendance totals match the records', () => {
  for (const tpl of ['SE4351', 'SE6362']) {
    const { course } = loaded(tpl);
    const att = course.attendance;
    assert.equal(att.totalsSessionsHeld, att.sessions.length);
    assert.deepEqual(Object.keys(att.totals).sort(), course.students.map((s) => s.id).sort());
    for (const s of course.students) {
      const marks = marksOf(course, s);
      assert.deepEqual(att.totals[s.id], {
        absent: marks.filter((m) => m === 'A').length,
        excused: marks.filter((m) => m === 'E').length
      });
    }
  }
});

test('a course without sessions gets no attendance data', () => {
  const { course } = loaded('custom');
  assert.deepEqual(course.attendance.sessions, []);
  assert.deepEqual(course.attendance.records, {});
  assert.deepEqual(course.attendance.totals, {});
  assert.equal(course.attendance.totalsSessionsHeld, 0);
});

test('loadInto leaves assessments, settings, placeholders, history, presets, mode and sessions alone', () => {
  const course = model.createCourse('SE4351');
  course.history.push({ id: 'h_1', ts: '2026-09-01T00:00:00.000Z', source: 'edit', kind: 'settings', note: 'earlier edit' });
  course.exportPresets.push({ id: 'xp_1', name: 'Mine', columns: ['no', 'lastName'] });
  course.placeholders.curve = { confirmed: true, confirmedAt: '2026-09-02T00:00:00.000Z' };
  course.settings.curve = 2;
  course.attendance.sessions[0].label = 'First day';
  // Old data that must be replaced.
  course.students.push(model.createStudent({ lastName: 'Old', firstName: 'Row' }));
  course.attendance.records.s_old = { ses_20260903: 'A' };
  const keep = (c) => JSON.parse(JSON.stringify({
    assessments: c.assessments, settings: c.settings, placeholders: c.placeholders, history: c.history,
    exportPresets: c.exportPresets, mode: c.attendance.mode, sessions: c.attendance.sessions,
    id: c.id, code: c.code, title: c.title, template: c.template, level: c.level,
    unexcusedThreshold: c.attendance.unexcusedThreshold, excusedCountsTowardStreak: c.attendance.excusedCountsTowardStreak
  }));
  const before = keep(course);
  sample.loadInto(course);
  assert.deepEqual(keep(course), before);
  assert.equal(course.history.length, 1, 'no history written');
  assert.ok(!course.students.some((s) => s.lastName === 'Old'));
  assert.equal(course.attendance.records.s_old, undefined);
  // The loaded course survives normalization unchanged (valid shape).
  const normalized = model.normalizeCourse(JSON.parse(JSON.stringify(course)));
  assert.deepEqual(normalized.students, course.students);
  assert.deepEqual(normalized.scores, course.scores);
  assert.deepEqual(normalized.teamScores, course.teamScores);
  assert.deepEqual(normalized.attendance.records, course.attendance.records);
});

test('calc.computeCourse runs on the sample: finite totals and a plausible average', () => {
  for (const [tpl, ov] of [['SE4351'], ['SE6362'], ['custom'], ['custom', { level: 'graduate' }]]) {
    const { course } = loaded(tpl, ov);
    const results = calc.computeCourse(course);
    assert.equal(results.weights.ok, true);
    for (const s of course.students) {
      const r = results.byId[s.id];
      assert.ok(Number.isFinite(r.total), `${s.lastName} total ${r.total}`);
      assert.ok(r.total >= 0 && r.total <= 100);
      assert.notEqual(r.letter, '');
    }
    assert.ok(results.average >= 60 && results.average <= 95, `${tpl} average ${results.average}`);
    assert.equal(results.activeIds.length, course.students.filter((s) => s.status === 'active').length);
    const ranks = results.activeIds.map((id) => results.byId[id].rank);
    assert.equal(Math.min(...ranks), 1);
  }
});

test('assessment ids such as "toString" get normal generated scores (third review V3)', () => {
  // A restored file may use ids that are also Object.prototype names; normalize keeps them.
  const state = model.normalizeState({
    app: 'grade-tracker',
    courses: [{
      template: 'custom', level: 'undergraduate',
      assessments: [
        { id: 'toString', name: 'Quiz', maxScore: 100, weight: 50, teamGraded: false },
        { id: 'valueOf', name: 'Lab', maxScore: 100, weight: 50, teamGraded: false }
      ]
    }]
  });
  const course = state.courses[0];
  assert.deepEqual(course.assessments.map((a) => a.id), ['toString', 'valueOf']);
  sample.loadInto(course);
  const withdrawn = course.students.filter((s) => s.status === 'withdrawn');
  assert.equal(withdrawn.length, 2);
  for (const aid of ['toString', 'valueOf']) {
    const values = [];
    for (const s of course.students) {
      const e = model.getEntry(course.scores, s.id, aid);
      if (!e) continue; // one of the two incomplete students
      assert.equal(typeof e.value, 'number', `${aid} ${s.lastName}`);
      assert.ok(e.value >= 60 && e.value <= 100, `${aid} ${s.lastName} ${e.value}`);
      values.push(e.value);
    }
    assert.ok(values.length >= course.students.length - 2, `${aid}: ${values.length} scores`);
    // Not treated as team work or as an item withdrawn students skip.
    for (const s of withdrawn) assert.ok(model.getEntry(course.scores, s.id, aid), `${aid} withdrawn ${s.lastName}`);
    for (const t of course.teams) {
      const inTeam = course.students.filter((s) => s.teamId === t.id)
        .map((s) => model.getEntry(course.scores, s.id, aid)).filter(Boolean).map((e) => e.value);
      assert.ok(new Set(inTeam).size > 1, `${aid}: one value per student, not per team`);
    }
  }
  const results = calc.computeCourse(course);
  const incomplete = course.students.filter((s) => results.byId[s.id].incomplete);
  assert.equal(incomplete.length, 2);
  for (const s of course.students) assert.ok(Number.isFinite(results.byId[s.id].total));
});

test('stage 2b: participation out of 5 on the drop-down list, no final letters, not finalized', () => {
  for (const tpl of ['SE4351', 'SE6362']) {
    const course = model.createCourse(tpl);
    model.finalize(course, '2026-12-10T12:00:00.000Z', 'before loading');
    course.students.push(model.createStudent({ lastName: 'Student 99', finalLetter: 'A' }));
    sample.loadInto(course);
    assert.equal(course.finalized, null, `${tpl}: loading sample data unlocks the scores`);
    assert.ok(course.students.every((s) => s.finalLetter === null), `${tpl}: no final letters`);
    const part = model.findAssessment(course, 'a_part');
    assert.equal(part.maxScore, 5);
    const values = course.students.map((s) => model.getEntry(course.scores, s.id, 'a_part')).filter(Boolean).map((e) => e.value);
    assert.ok(values.length > 0);
    for (const v of values) {
      assert.ok(model.isChoiceValue(part, v), `${tpl}: ${v} is a list value`);
      assert.ok(v >= 3 && v <= 5, `${tpl}: ${v}`);
    }
    const results = calc.computeCourse(course);
    assert.deepEqual(results.orderIssues, []);
    assert.equal(results.letterSummary.assigned, 0);
    assert.equal(results.letterSummary.unassigned, results.activeIds.length);
    for (const id of results.activeIds) {
      assert.equal(results.byId[id].letterSource, 'cutoffs');
      assert.equal(results.byId[id].notOnListCount, 0);
    }
  }
});

test('stage 2b: a drop-down item with another step gets list values (nearest, ties up)', () => {
  const course = model.createCourse('SE4351');
  model.findAssessment(course, 'a_part').choices = { step: 2 }; // 5, 3, 1, 0
  model.findAssessment(course, 'a_t1').choices = { step: 10 };  // 100, 90, ..., 0
  sample.loadInto(course);
  for (const aid of ['a_part', 'a_t1']) {
    const a = model.findAssessment(course, aid);
    for (const s of course.students) {
      const e = model.getEntry(course.scores, s.id, aid);
      if (e) assert.ok(model.isChoiceValue(a, e.value), `${aid} ${e.value}`);
    }
  }
});
