/* Grade Tracker - deterministic fake sample data for the "Load sample data" button (C1, C2, C4).
 * Every name is obviously fake ("Student 01", NATO-alphabet first names). The same course template
 * and level always produce the same names, teams, scores and attendance; only ids differ per load.
 * Pure; runs in the browser (GT.sample) and in Node. See docs/DESIGN.md. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;
  var model = isNode ? require('./model.js') : root.GT.model;
  // Tables below are keyed by assessment id; restored files may use ids such as 'toString',
  // so every lookup checks own properties only.
  var hasOwn = util.hasOwn;

  var NATO = [
    'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett',
    'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango',
    'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'
  ];

  // 'large' mirrors SE 4351 (59 students, teams of 7 to 8); 'small' mirrors SE 6362 (10, teams of about 3).
  var DATASETS = {
    large: { studentCount: 59, teamSizes: [8, 8, 8, 7, 7, 7, 7, 7], withdrawn: 2, incomplete: 2, attendanceCases: true },
    small: { studentCount: 10, teamSizes: [4, 3, 3], withdrawn: 1, incomplete: 1, attendanceCases: false }
  };

  var NOTES = {
    withdrawn: 'Sample note: withdrew mid-semester',
    override: 'Sample note: team agreed in writing to an unequal Project I split',
    lateJoiner: 'Sample note: joined late'
  };

  function datasetKey(course) {
    if (course.template === 'SE4351') return 'large';
    if (course.template === 'SE6362') return 'small';
    return course.level === 'graduate' ? 'small' : 'large';
  }

  function profileFor(course) {
    var d = DATASETS[datasetKey(course)];
    return { studentCount: d.studentCount, teamSizes: d.teamSizes.slice() };
  }

  // ---------------------------------------------------------------- seeded randomness

  /** 32-bit FNV-1a hash of a string. */
  function hashString(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** mulberry32: a small seedable PRNG returning floats in [0, 1). */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createRng(seedText) {
    var next = mulberry32(hashString(String(seedText)));
    return {
      next: next,
      /** Integer in [min, max], both inclusive. */
      int: function (min, max) { return min + Math.floor(next() * (max - min + 1)); },
      /** Box-Muller normal sample. */
      normal: function (mean, sd) {
        var u = 1 - next(), v = next();
        return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      },
      /** Fisher-Yates shuffle of a copy. */
      shuffle: function (arr) {
        var a = arr.slice();
        for (var i = a.length - 1; i > 0; i--) {
          var j = Math.floor(next() * (i + 1));
          var t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
      }
    };
  }

  function range(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(i);
    return out;
  }

  // ---------------------------------------------------------------- roster and teams

  /** Maps student index -> team id: the shuffled order is cut into consecutive slices of `sizes`. */
  function assignTeams(order, sizes, teams) {
    var teamOf = [], pos = 0;
    sizes.forEach(function (size, t) {
      for (var k = 0; k < size; k++) teamOf[order[pos++]] = teams[t].id;
    });
    return teamOf;
  }

  /** Picks distinct student indices for every special role (withdrawn, incomplete, override, ...). */
  function pickRoles(rng, spec, n) {
    var order = rng.shuffle(range(n));
    var take = function (k) { return order.splice(0, k); };
    var roles = {
      withdrawn: take(spec.withdrawn),
      incomplete: take(spec.incomplete),
      override: take(1)[0],
      lateJoiner: take(1)[0],
      streak3: null, streak4: null, scattered: null
    };
    if (spec.attendanceCases) {
      roles.streak3 = take(1)[0];
      roles.streak4 = take(1)[0];
      roles.scattered = take(1)[0];
    }
    return roles;
  }

  function studentNotes(i, roles, hasOverride) {
    if (i === roles.withdrawn[0]) return NOTES.withdrawn;
    if (hasOverride && i === roles.override) return NOTES.override;
    if (i === roles.lateJoiner) return NOTES.lateJoiner;
    return '';
  }

  // ---------------------------------------------------------------- scores

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function roundHalf(x) { return util.fix(Math.round(x * 2) / 2); }

  /** A 0..100 percentage on the assessment's own scale, rounded to 0.5 and kept within 0..max.
   * An assessment with a drop-down list (DECISIONS 8) gets the nearest list value instead (ties go
   * to the higher value, like the 0.5 rounding): Participation out of 5 gets 3, 3.5, ..., 5. */
  function scaled(pct, assessment) {
    var max = assessment.maxScore;
    if (!(max > 0)) return 0;
    var list = model.choiceValues(assessment);
    if (!list.length) return clamp(roundHalf(pct * max / 100), 0, max);
    var exact = pct * max / 100, best = list[0], bestGap = Infinity;
    list.forEach(function (v) { // highest first, so a tie keeps the higher value
      var gap = util.fix(Math.abs(v - exact));
      if (gap < bestGap) { best = v; bestGap = gap; }
    });
    return best;
  }

  // Percentage generators for the template assessments (ids are stable, DESIGN 2.1). Participation
  // is out of 5 by default, so 60..100% becomes 3..5 in steps of 0.5 (see scaled).
  var GENERATORS = {
    a_p1: function (rng) { return rng.int(80, 98); },
    a_p2: function (rng) { return rng.int(78, 98); },
    a_t1: function (rng) { return roundHalf(clamp(rng.normal(80, 10), 40, 100)); },
    a_t2: function (rng) { return roundHalf(clamp(rng.normal(76, 12), 35, 100)); },
    a_part: function (rng) { return 60 + 5 * rng.int(0, 8); },
    a_paper: function (rng) { return rng.int(70, 98); }
  };
  function otherGenerator(rng) { return rng.int(60, 100); }

  // Projects are team work, so they get one value per team even when graded individually.
  var TEAM_WORK = { a_p1: true, a_p2: true };

  // Individual scores a withdrawn student never received (they keep Project I and Test 1).
  var WITHDRAWN_EMPTY = { a_t2: true, a_part: true, a_paper: true };

  function setValue(map, ownerId, aid, value) {
    if (!map[ownerId]) map[ownerId] = {};
    map[ownerId][aid] = { value: value };
  }

  function hasIndividualScore(ctx, student, a) {
    if (student.status === 'withdrawn' && hasOwn(WITHDRAWN_EMPTY, a.id)) return false;
    if (a.id === 'a_paper' && !hasOwn(ctx.paperWriters, student.id)) return false;
    return true;
  }

  /** Fills one assessment. Each assessment has its own random stream, so adding or removing one
   * assessment leaves the values of the others unchanged. Returns team percentages by team id. */
  function fillAssessment(ctx, a) {
    var course = ctx.course;
    var rng = ctx.stream('score:' + a.id);
    var gen = hasOwn(GENERATORS, a.id) ? GENERATORS[a.id] : otherGenerator;
    var teamPct = {};
    if (a.teamGraded || hasOwn(TEAM_WORK, a.id)) {
      course.teams.forEach(function (t) {
        var pct = gen(rng);
        teamPct[t.id] = pct;
        if (a.teamGraded) {
          setValue(course.teamScores, t.id, a.id, scaled(pct, a));
        } else {
          ctx.membersOf[t.id].forEach(function (s) {
            if (hasIndividualScore(ctx, s, a)) setValue(course.scores, s.id, a.id, scaled(pct, a));
          });
        }
      });
      return teamPct;
    }
    course.students.forEach(function (s) {
      var pct = gen(rng); // drawn for every student so skipped students do not shift later values
      if (hasIndividualScore(ctx, s, a)) setValue(course.scores, s.id, a.id, scaled(pct, a));
    });
    return teamPct;
  }

  /** Weighted, individually entered assessments, lowest-impact first, for the incomplete students. */
  function incompleteCandidates(assessments) {
    var prefer = ['a_part', 'a_t1'];
    var rank = function (a) { var i = prefer.indexOf(a.id); return i === -1 ? prefer.length : i; };
    return assessments
      .filter(function (a) { return !a.teamGraded && (a.weight || 0) > 0; })
      .sort(function (x, y) { return rank(x) - rank(y); });
  }

  function fillScores(ctx, roles) {
    var course = ctx.course;
    var students = course.students;
    var active = students.filter(function (s) { return s.status === 'active'; });
    // About 70% of active students hand in the (weight 0) term paper.
    var writers = ctx.stream('paper-writers').shuffle(active).slice(0, Math.round(active.length * 0.7));
    ctx.paperWriters = {};
    writers.forEach(function (s) { ctx.paperWriters[s.id] = true; });

    var teamPct = {};
    ctx.assessments.forEach(function (a) { teamPct[a.id] = fillAssessment(ctx, a); });

    var p1 = model.findAssessment(course, 'a_p1');
    if (p1 && p1.teamGraded) {
      var s = students[roles.override];
      course.scores[s.id] = course.scores[s.id] || {};
      course.scores[s.id].a_p1 = { value: scaled(teamPct.a_p1[s.teamId] - 10, p1), override: true };
    }

    var candidates = incompleteCandidates(ctx.assessments);
    if (candidates.length) {
      roles.incomplete.forEach(function (idx, k) {
        model.setEntry(course.scores, students[idx].id, candidates[k % candidates.length].id, null);
      });
    }
  }

  // ---------------------------------------------------------------- attendance

  var P_PRESENT = 0.93, P_ABSENT = 0.05; // the remaining 2% are excused

  /** Mostly present. Random absences never form a run of 3 or more; long runs are placed on purpose. */
  function randomMarks(rng, count) {
    var marks = [];
    for (var i = 0; i < count; i++) {
      var r = rng.next();
      var m = r < P_PRESENT ? 'P' : (r < P_PRESENT + P_ABSENT ? 'A' : 'E');
      if (m !== 'P' && i >= 2 && marks[i - 1] !== 'P' && marks[i - 2] !== 'P') m = 'P';
      marks.push(m);
    }
    return marks;
  }

  /** Overwrites marks with exactly `len` consecutive unexcused absences, framed by presences. */
  function placeRun(marks, rng, len) {
    if (marks.length < len + 2) return;
    var start = rng.int(1, marks.length - len - 1);
    for (var i = 0; i < len; i++) marks[start + i] = 'A';
    marks[start - 1] = 'P';
    marks[start + len] = 'P';
  }

  /** All present except `count` unexcused absences, one per segment and never two in a row. */
  function scatteredMarks(rng, total, count) {
    var marks = [];
    for (var i = 0; i < total; i++) marks.push('P');
    for (var k = 0; k < count; k++) {
      var lo = Math.floor(k * total / count);
      var hi = Math.floor((k + 1) * total / count) - 2; // keeps a gap before the next segment
      if (hi >= lo) marks[rng.int(lo, hi)] = 'A';
    }
    return marks;
  }

  function fillAttendance(ctx, roles) {
    var course = ctx.course;
    var att = course.attendance;
    var sessions = (att.sessions || []).slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    var records = {}, totals = {};
    if (sessions.length) {
      var rng = ctx.stream('attendance');
      var cases = ctx.stream('attendance-cases');
      course.students.forEach(function (s, i) {
        var marks = randomMarks(rng, sessions.length); // always drawn to keep the stream aligned
        if (i === roles.streak3) placeRun(marks, cases, 3);
        else if (i === roles.streak4) placeRun(marks, cases, 4);
        else if (i === roles.scattered) marks = scatteredMarks(cases, sessions.length, 5);
        var row = {}, absent = 0, excused = 0;
        sessions.forEach(function (ses, k) {
          row[ses.id] = marks[k];
          if (marks[k] === 'A') absent++;
          else if (marks[k] === 'E') excused++;
        });
        records[s.id] = row;
        totals[s.id] = { absent: absent, excused: excused };
      });
    }
    att.records = records;
    att.totals = totals;
    att.totalsSessionsHeld = sessions.length;
  }

  // ---------------------------------------------------------------- entry point

  /** Replaces the course's teams, students, scores, team scores and attendance marks/totals with
   * the sample dataset: no final letters, and the scores are not finalized (course.finalized = null).
   * Leaves assessments, settings, placeholders, history, export presets and the attendance
   * mode/sessions alone, and writes no history (the store logs one bulk entry). */
  function loadInto(course) {
    var spec = DATASETS[datasetKey(course)];
    var seed = String(course.template) + ':' + String(course.level);
    var stream = function (purpose) { return createRng(seed + '|' + purpose); };
    var n = spec.studentCount;

    var teams = spec.teamSizes.map(function (_, t) { return model.createTeam('Team ' + (t + 1)); });
    var teamOf = assignTeams(stream('teams').shuffle(range(n)), spec.teamSizes, teams);
    var roles = pickRoles(stream('roles'), spec, n);
    var p1 = model.findAssessment(course, 'a_p1');
    var hasOverride = !!(p1 && p1.teamGraded);

    var students = range(n).map(function (i) {
      return model.createStudent({
        no: i + 1,
        lastName: 'Student ' + String(i + 1).padStart(2, '0'),
        firstName: NATO[i % NATO.length],
        teamId: teamOf[i],
        status: roles.withdrawn.indexOf(i) !== -1 ? 'withdrawn' : 'active',
        notes: studentNotes(i, roles, hasOverride)
      });
    });

    course.teams = teams;
    course.students = students;
    course.scores = {};
    course.teamScores = {};
    course.finalized = null;

    var membersOf = {};
    teams.forEach(function (t) { membersOf[t.id] = []; });
    students.forEach(function (s) { membersOf[s.teamId].push(s); });
    var ctx = {
      course: course, assessments: course.assessments || [], stream: stream,
      membersOf: membersOf, paperWriters: {}
    };

    fillScores(ctx, roles);
    fillAttendance(ctx, roles);
    return { students: students.length, teams: teams.length };
  }

  var api = {
    profileFor: profileFor,
    loadInto: loadInto,
    createRng: createRng,
    NATO: NATO.slice()
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).sample = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
