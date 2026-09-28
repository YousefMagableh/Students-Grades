/* Grade Tracker - data model: schema, course templates, placeholders, normalization, backups.
 * See docs/DESIGN.md section 2. Pure; runs in the browser (GT.model) and in Node. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;
  var hasOwn = util.hasOwn;
  var isSafeKey = util.isSafeKey;

  var SCHEMA_VERSION = 1;
  var APP_ID = 'grade-tracker';

  // ---------------------------------------------------------------- letter scales (K6)

  var UNDERGRAD_SCALE = [
    ['A+', 97], ['A', 93], ['A-', 90], ['B+', 87], ['B', 83], ['B-', 80],
    ['C+', 77], ['C', 73], ['C-', 70], ['D+', 67], ['D', 63], ['D-', 60], ['F', 0]
  ];
  var GRAD_SCALE = [
    ['A', 93], ['A-', 90], ['B+', 87], ['B', 83], ['B-', 80], ['C+', 77], ['C', 70], ['F', 0]
  ];

  function defaultLetterScale(level) {
    var src = level === 'graduate' ? GRAD_SCALE : UNDERGRAD_SCALE;
    return src.map(function (p) { return { letter: p[0], min: p[1] }; });
  }

  function defaultPassingLetter(level) {
    return level === 'graduate' ? 'C' : 'D-';
  }

  /** Cleans a letter scale (restore, Settings edits): drops malformed rows (including a negative
   * min, which would shadow the failing letter), sorts by min descending, and keeps the invariant
   * "the lowest cutoff is 0" (F unless the scale names its own bottom letter at 0, e.g. Pass/Fail):
   * a bottom F above 0 is moved to 0, and a scale whose lowest cutoff is above 0 gets
   * { letter: 'F', min: 0 } appended. An empty result falls back to the default scale for the
   * level. Returns a new array. */
  function normalizeLetterScale(list, level) {
    var scale = (Array.isArray(list) ? list : []).filter(function (x) {
      return util.isPlainObject(x) && typeof x.letter === 'string' && x.letter !== '' &&
        util.isSaneNumber(x.min) && x.min >= 0;
    }).map(function (x) { return { letter: x.letter, min: x.min === 0 ? 0 : x.min }; }); // -0 -> 0
    if (!scale.length) return defaultLetterScale(level);
    scale.sort(function (a, b) { return b.min - a.min; });
    var last = scale[scale.length - 1];
    if (last.min > 0) {
      if (last.letter === 'F') last.min = 0;
      else scale.push({ letter: 'F', min: 0 });
    }
    return scale;
  }

  /** The passing letter to use with `scale`: `preferred` when the scale has it, else the level's
   * default when present, else the lowest letter above the bottom (failing) one. */
  function passingLetterFor(scale, preferred, level) {
    var has = function (l) { return typeof l === 'string' && scale.some(function (x) { return x.letter === l; }); };
    if (has(preferred)) return preferred;
    var dflt = defaultPassingLetter(level);
    if (has(dflt)) return dflt;
    return scale.length > 1 ? scale[scale.length - 2].letter : (scale[0] ? scale[0].letter : dflt);
  }

  // ---------------------------------------------------------------- sessions (T1)

  /** Generates class sessions on the given weekdays (0=Sun..6=Sat) from start to end inclusive,
   * skipping `exclude` dates. Session ids are deterministic: "ses_YYYYMMDD". */
  function generateSessions(opts) {
    var start = opts.start, end = opts.end;
    var weekdays = opts.weekdays || [2, 4];
    var exclude = {};
    (opts.exclude || []).forEach(function (d) { exclude[d] = true; });
    var out = [];
    if (!util.isIsoDate(start) || !util.isIsoDate(end) || start > end) return out;
    for (var d = start, guard = 0; d <= end && guard < 2000; d = util.addDays(d, 1), guard++) {
      if (weekdays.indexOf(util.weekday(d)) !== -1 && !exclude[d]) {
        out.push({ id: 'ses_' + d.replace(/-/g, ''), date: d, label: '' });
      }
    }
    return out;
  }

  var FALL_2026_TR = {
    start: '2026-09-03', end: '2026-12-08', weekdays: [2, 4],
    exclude: ['2026-11-24', '2026-11-26']
  };

  // ---------------------------------------------------------------- templates (C1, C2, A1, A4)

  function baseAssessments() {
    return [
      { id: 'a_p1', name: 'Project I', maxScore: 100, weight: 10, teamGraded: true, category: 'project' },
      { id: 'a_p2', name: 'Project II', maxScore: 100, weight: 20, teamGraded: true, category: 'project' },
      { id: 'a_t1', name: 'Test 1', maxScore: 100, weight: 25, teamGraded: false, category: 'test' },
      { id: 'a_t2', name: 'Test 2', maxScore: 100, weight: 40, teamGraded: false, category: 'test' },
      // Out of 5 like the previous TA's sheet (5 = full marks), so the raw score equals the weighted
      // points; picked from a drop-down list 5, 4.5, ..., 0 (DECISIONS 1 and 8).
      { id: 'a_part', name: 'Class/Project Participation', maxScore: 5, weight: 5, teamGraded: false, category: 'participation', choices: { step: 0.5 } }
    ].map(createAssessment);
  }

  var TEMPLATES = {
    SE4351: {
      code: 'SE 4351', title: 'Requirements Engineering', level: 'undergraduate',
      assessments: baseAssessments,
      attendanceMode: 'per-session', sessions: FALL_2026_TR
    },
    SE6362: {
      code: 'SE 6362', title: 'Software Architectural Design', level: 'graduate',
      assessments: function () {
        var a = baseAssessments();
        a.push(createAssessment({ id: 'a_paper', name: 'Term Paper', maxScore: 100, weight: 0, teamGraded: false, category: 'paper' }));
        return a;
      },
      attendanceMode: 'off', sessions: FALL_2026_TR
    },
    custom: {
      code: 'New Course', title: 'Untitled course', level: 'undergraduate',
      assessments: baseAssessments,
      attendanceMode: 'off', sessions: null
    }
  };

  // ---------------------------------------------------------------- placeholders (K3, K4, K6, K8, A4, A5, T4)

  var PLACEHOLDERS = {
    letterScale: {
      label: 'Letter-grade cutoffs',
      note: function (c) {
        return c.level === 'graduate'
          ? 'Official cutoffs not known yet. Placeholder graduate scale: A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 70, below 70 F.'
          : 'Official cutoffs not known yet. Placeholder undergraduate scale: A+ 97, A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 73, C- 70, D+ 67, D 63, D- 60, below 60 F.';
      }
    },
    rounding: {
      label: 'Rounding of the total',
      note: function () { return 'Not specified by the instructor. Default: no rounding.'; }
    },
    curve: {
      label: 'Curve',
      note: function () { return 'Not specified by the instructor. Default: no curve (0 points).'; }
    },
    lateWork: {
      label: 'Late-work exceptions',
      note: function (c) {
        if (c.template === 'SE6362') {
          return 'Syllabus: 10 points deducted for each week passed. Pre-approval exceptions and scaling for non-100 max scores are assumptions.';
        }
        if (c.template === 'SE4351') {
          return 'Syllabus: 10 points deducted for each week passed, if without pre-approval. Which cases count as pre-approved, and scaling for non-100 max scores, are assumptions.';
        }
        return 'No syllabus rule on file for this course. Default: 10 points per week late (scaled for non-100 max scores) unless the penalty is waived.';
      }
    },
    maxScores: {
      label: 'Max scores',
      note: function () {
        return 'Every assessment defaults to a max score of 100 until the real maximums are known, except ' +
          'Class/Project Participation, which is out of 5 like the previous TA\'s sheet (5 = full marks; ' +
          'weight 5%, so the score equals the points added to the total), chosen from a drop-down list in steps of 0.5.';
      }
    },
    projectSplit: {
      label: 'Project split',
      note: function (c) {
        if (c.template === 'SE4351') {
          return 'Syllabus lists Questionnaire (2 x 2.5 = 5) + Presentation and Deliverable (25) inside the 30% Project. Defaults use Project I 10% and Project II 20% (team-graded). Split or rename project items in Settings when confirmed.';
        }
        if (c.template === 'SE6362') {
          return 'Syllabus says "Project (approx. 10 + 20) 30%". Defaults use Project I 10% and Project II 20% (team-graded).';
        }
        return 'Default project items: Project I 10% and Project II 20% (team-graded). Split or rename them in Settings as needed.';
      }
    },
    termPaperWeight: {
      label: 'Term Paper weight',
      note: function () { return 'The syllabus describes a term paper but gives no weight. Default weight: 0%.'; }
    },
    unexcusedThreshold: {
      label: 'Unexcused-absence threshold',
      note: function () { return 'The syllabus mentions "a certain threshold" but does not state it. Placeholder: highlight above 3 unexcused absences.'; }
    },
    passingLetter: {
      label: 'Passing grade (pass rate)',
      note: function (c) {
        return 'Pass rate counts students at or above ' + (c.settings && c.settings.passingLetter ? c.settings.passingLetter : defaultPassingLetter(c.level)) + '. Not confirmed by the instructor.';
      }
    }
  };

  /** Placeholder keys for a course. projectSplit applies to every course (both syllabi say
   * "approx. 10 + 20"); termPaperWeight only while the course has the Term Paper item (a_paper). */
  function placeholderKeys(course) {
    var keys = ['letterScale', 'rounding', 'curve', 'lateWork', 'maxScores', 'projectSplit'];
    var hasPaper = (course.assessments || []).some(function (a) { return a.id === 'a_paper'; });
    if (hasPaper) keys.push('termPaperWeight');
    keys.push('unexcusedThreshold', 'passingLetter');
    return keys;
  }

  function defaultPlaceholders(course) {
    var out = {};
    placeholderKeys(course).forEach(function (k) { out[k] = { confirmed: false, confirmedAt: null }; });
    return out;
  }

  function placeholderInfo(course, key) {
    if (!hasOwn(PLACEHOLDERS, key)) return null;
    var p = PLACEHOLDERS[key];
    var st = (hasOwn(course.placeholders, key) && course.placeholders[key]) || { confirmed: false, confirmedAt: null };
    return { key: key, label: p.label, note: p.note(course), confirmed: !!st.confirmed, confirmedAt: st.confirmedAt || null };
  }

  function unconfirmedPlaceholders(course) {
    return placeholderKeys(course)
      .map(function (k) { return placeholderInfo(course, k); })
      .filter(function (p) { return p && !p.confirmed; });
  }

  function isConfirmed(course, key) {
    return !!(hasOwn(course.placeholders, key) && course.placeholders[key] && course.placeholders[key].confirmed);
  }

  // ---------------------------------------------------------------- factories

  function defaultSettings(level) {
    return {
      decimals: 2,
      rounding: 'none',
      curve: 0,
      latePointsPerWeek: 10,
      letterScale: defaultLetterScale(level),
      passingLetter: defaultPassingLetter(level)
    };
  }

  function defaultAttendance(mode, sessions) {
    return {
      mode: mode || 'off',
      sessions: sessions || [],
      records: {},
      totals: {},
      totalsSessionsHeld: 0,
      unexcusedThreshold: 3,
      excusedCountsTowardStreak: true,
      dropStreak: 3,
      failStreak: 4
    };
  }

  function createCourse(templateKey, overrides) {
    var key = hasOwn(TEMPLATES, templateKey) ? templateKey : 'custom';
    var t = TEMPLATES[key];
    var now = util.nowIso();
    var course = {
      id: util.uid('c'),
      template: key,
      code: t.code,
      title: t.title,
      level: t.level,
      term: 'Fall 2026',
      createdAt: now,
      updatedAt: now,
      assessments: t.assessments(),
      teams: [],
      students: [],
      scores: {},
      teamScores: {},
      attendance: defaultAttendance(t.attendanceMode, t.sessions ? generateSessions(t.sessions) : []),
      settings: defaultSettings(t.level),
      placeholders: {},
      exportPresets: [],
      finalized: null,
      history: []
    };
    if (overrides) {
      Object.keys(overrides).forEach(function (k) { course[k] = overrides[k]; });
      if (overrides.level && !overrides.settings) {
        course.settings.letterScale = defaultLetterScale(overrides.level);
        course.settings.passingLetter = defaultPassingLetter(overrides.level);
      }
    }
    course.placeholders = defaultPlaceholders(course);
    return course;
  }

  function createDefaultState() {
    var a = createCourse('SE4351');
    var b = createCourse('SE6362');
    return {
      app: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      courses: [a, b],
      activeCourseId: a.id,
      ui: { theme: 'system', privacy: false, activeView: 'grades' },
      meta: { createdAt: util.nowIso(), lastSavedAt: null, lastBackupAt: null }
    };
  }

  function createStudent(fields) {
    var f = fields || {};
    return {
      id: f.id || util.uid('s'),
      no: typeof f.no === 'number' && isFinite(f.no) ? f.no : null,
      lastName: f.lastName ? String(f.lastName).trim() : '',
      firstName: f.firstName ? String(f.firstName).trim() : '',
      teamId: f.teamId || null,
      status: f.status === 'withdrawn' ? 'withdrawn' : 'active',
      notes: f.notes ? String(f.notes) : '',
      finalLetter: cleanFinalLetter(f.finalLetter)
    };
  }

  function createTeam(name, id) {
    return { id: id || util.uid('t'), name: name || 'Team' };
  }

  /** New assessment. A max score must be above 0 (else 100) and a weight at least 0 (else 0).
   * `choices` is kept only when it is a valid drop-down list for that max score (normalizeChoices). */
  function createAssessment(fields) {
    var f = fields || {};
    var maxScore = util.isSaneNumber(f.maxScore) && f.maxScore > 0 ? f.maxScore : 100;
    return {
      id: f.id || util.uid('a'),
      name: f.name ? String(f.name) : 'New assessment',
      maxScore: maxScore,
      weight: util.isSaneNumber(f.weight) && f.weight >= 0 ? f.weight : 0,
      teamGraded: !!f.teamGraded,
      category: f.category || 'other',
      choices: normalizeChoices(f.choices, maxScore)
    };
  }

  // ---------------------------------------------------------------- drop-down lists (DECISIONS 8)

  /** Longest drop-down list kept: maxScore / step may be at most this (201 values with 0). */
  var MAX_CHOICE_STEPS = 200;

  /** Cleans an assessment's `choices` for its max score: { step } when step is a sane number above 0
   * and maxScore / step <= MAX_CHOICE_STEPS; otherwise null (free numeric entry). Returns a new object. */
  function normalizeChoices(choices, maxScore) {
    if (!util.isPlainObject(choices)) return null;
    var step = choices.step;
    if (!util.isSaneNumber(step) || !(step > 0)) return null;
    if (!util.isSaneNumber(maxScore) || !(maxScore > 0)) return null;
    if (util.fix(maxScore / step) > MAX_CHOICE_STEPS) return null;
    return { step: step };
  }

  var NO_CHOICES = { values: [], set: new Set() };

  /** The list for a max score and a stored `choices` value: { values (highest first), set }. */
  function buildChoiceList(choices, maxScore) {
    var c = normalizeChoices(choices, maxScore);
    if (!c) return NO_CHOICES;
    var values = [];
    for (var k = 0; k <= MAX_CHOICE_STEPS; k++) {
      var v = util.fix(maxScore - k * c.step);
      if (!(v > 0)) break;
      values.push(v);
    }
    values.push(0);
    return { values: values, set: new Set(values) };
  }

  /** Lists already built, per assessment object. calc checks every score of a drop-down item against
   * its list (students x assessments per computeCourse), so the up to 201 values are built once per
   * assessment instead of once per score. Each memo records the maxScore and step it was built from and
   * is rebuilt when either changed, so an assessment edited in place never reads a stale list. */
  var choiceMemo = typeof WeakMap === 'function' ? new WeakMap() : null;

  function choiceList(assessment) {
    if (!util.isPlainObject(assessment)) return NO_CHOICES;
    var choices = assessment.choices;
    var step = util.isPlainObject(choices) ? choices.step : undefined;
    var max = assessment.maxScore;
    var m = choiceMemo ? choiceMemo.get(assessment) : null;
    if (m && m.max === max && m.step === step) return m.list;
    var list = buildChoiceList(choices, max);
    if (choiceMemo) choiceMemo.set(assessment, { max: max, step: step, list: list });
    return list;
  }

  /** The drop-down values of an assessment, highest first: max, max - step, ... while above 0, then 0
   * (max 5, step 0.5 -> 5, 4.5, ..., 0.5, 0: 11 values; max 5, step 2 -> 5, 3, 1, 0). Values pass
   * through util.fix, so 5 - 3 x 0.1 is 4.7. Empty when the assessment has no valid choices.
   * Returns a new array each time (callers may change it). */
  function choiceValues(assessment) {
    return choiceList(assessment).values.slice();
  }

  /** True when the assessment has a (valid) drop-down list. */
  function hasChoices(assessment) {
    return choiceList(assessment).values.length > 0;
  }

  /** True when `value` is one of the assessment's drop-down values (compared after util.fix, so
   * 4.5 and 4.500000000000001 match). False when the assessment has no drop-down list. */
  function isChoiceValue(assessment, value) {
    if (typeof value !== 'number' || !isFinite(value)) return false;
    return choiceList(assessment).set.has(util.fix(value));
  }

  /** Human description of a drop-down list: '0–5 in steps of 0.5'; '' without a list. */
  function describeChoices(assessment) {
    var values = choiceValues(assessment);
    if (!values.length) return '';
    return '0–' + values[0] + ' in steps of ' + assessment.choices.step;
  }

  /** Reads typed or pasted text for a drop-down cell (DECISIONS 8: no invalid text is stored there):
   * { kind: 'empty' } for blank text; { kind: 'number', value } when it is a list value (as the list
   * spells it: "4.50" and "90%" of 5 give 4.5); otherwise { kind: 'invalid', text, message } with the
   * message 'Choose a value from the list (0–5 in steps of 0.5).'. For an assessment without a list
   * this is util.parseScoreInput (numbers and invalid text as usual). */
  function parseChoiceInput(assessment, input) {
    var max = util.isPlainObject(assessment) ? assessment.maxScore : undefined;
    var p = util.parseScoreInput(input, max);
    if (!hasChoices(assessment) || p.kind === 'empty') return p;
    if (p.kind === 'number' && isChoiceValue(assessment, p.value)) return { kind: 'number', value: util.fix(p.value) };
    return {
      kind: 'invalid',
      text: p.kind === 'number' ? String(p.value) : p.text,
      message: 'Choose a value from the list (' + describeChoices(assessment) + ').'
    };
  }

  // ---------------------------------------------------------------- final letters and finalizing (STAGE2B)

  /** A stored final letter: any string with visible text (kept as is), else null. Whether it is a
   * letter of the course's scale is reported by calc (finalLetterValid); it is never dropped here. */
  function cleanFinalLetter(x) {
    return typeof x === 'string' && x.trim() !== '' ? x : null;
  }

  /** The student's final letter, or null when none is set. */
  function finalLetterOf(student) {
    return student ? cleanFinalLetter(student.finalLetter) : null;
  }

  /** Letters of the course's scale, highest cutoff first (the order of the Final letter drop-down).
   * Reads the scale defensively (unsorted or odd rows are fine); each letter appears once. */
  function scaleLetters(course) {
    var list = course && course.settings && Array.isArray(course.settings.letterScale) ? course.settings.letterScale : [];
    var rows = [];
    list.forEach(function (x, i) {
      if (util.isPlainObject(x) && typeof x.letter === 'string' && x.letter !== '' && typeof x.min === 'number' && isFinite(x.min)) {
        rows.push({ letter: x.letter, min: x.min, i: i });
      }
    });
    rows.sort(function (a, b) { return (b.min - a.min) || (a.i - b.i); });
    var out = [];
    rows.forEach(function (x) { if (out.indexOf(x.letter) === -1) out.push(x.letter); });
    return out;
  }

  /** True when `letter` is exactly a letter of the course's scale. */
  function isScaleLetter(course, letter) {
    return typeof letter === 'string' && scaleLetters(course).indexOf(letter) !== -1;
  }

  function letterKey(t) {
    return String(t).replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, '').toUpperCase();
  }

  /** The scale letter that typed or pasted text means, or null: an exact match first, else a
   * case-insensitive one that ignores spaces and reads dash variants as '-' ("b+" -> "B+",
   * " a- " -> "A-", "A\u2212" -> "A-"). Null for empty text, non-strings or a letter not in the scale. */
  function matchLetter(course, text) {
    if (typeof text !== 'string' || text.trim() === '') return null;
    var letters = scaleLetters(course);
    if (letters.indexOf(text) !== -1) return text;
    var key = letterKey(text);
    var hits = letters.filter(function (l) { return letterKey(l) === key; });
    return hits.length === 1 ? hits[0] : null;
  }

  /** Sets (or, with null / undefined / blank text, clears) a student's final letter. The letter must
   * be in the course's scale (matched like matchLetter and stored as the scale spells it); anything
   * else throws an Error with a readable message. Returns true when the stored letter changed; false
   * when it did not, or when the student does not exist. */
  function setFinalLetter(course, studentId, letter) {
    var next = null;
    if (letter !== null && letter !== undefined && !(typeof letter === 'string' && letter.trim() === '')) {
      next = matchLetter(course, letter);
      if (next === null) {
        var shown = typeof letter === 'string' ? letter.trim() : String(letter);
        throw new Error('"' + shown.slice(0, 40) + '" is not a letter of this course\'s scale (' + scaleLetters(course).join(', ') + ').');
      }
    }
    var s = findStudent(course, studentId);
    if (!s) return false;
    var prev = finalLetterOf(s);
    s.finalLetter = next;
    return prev !== next;
  }

  /** Sets several final letters in one go (band assignment, paste): items = [{ studentId, letter }]
   * (letter null clears). Invalid letters and unknown students are skipped, never thrown.
   * Returns { changed, skipped, skippedItems: [{ studentId, letter, reason: 'letter'|'student' }] }. */
  function setFinalLetters(course, items) {
    var changed = 0, skippedItems = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
      var sid = util.isPlainObject(it) && it.studentId !== undefined ? it.studentId : null;
      var letter = util.isPlainObject(it) && it.letter !== undefined ? it.letter : null;
      if (!util.isPlainObject(it) || !findStudent(course, sid)) {
        skippedItems.push({ studentId: sid, letter: letter, reason: 'student' });
        return;
      }
      try {
        if (setFinalLetter(course, sid, letter)) changed++;
      } catch (e) {
        skippedItems.push({ studentId: sid, letter: letter, reason: 'letter' });
      }
    });
    return { changed: changed, skipped: skippedItems.length, skippedItems: skippedItems };
  }

  /** Copies each student's suggested letter (results.byId[id].letter from calc.computeCourse) into
   * the final letter. opts: { onlyEmpty = true (letters already set stay, invalid ones included),
   * activeOnly = true (withdrawn students are skipped) }. Suggestions that are not scale letters and
   * students without a result are skipped. Returns the number of final letters that changed. */
  function copySuggestedToFinal(course, results, opts) {
    var o = opts || {};
    var onlyEmpty = o.onlyEmpty !== false;
    var activeOnly = o.activeOnly !== false;
    var byId = results && util.isPlainObject(results.byId) ? results.byId : {};
    var letters = scaleLetters(course);
    var n = 0;
    (course.students || []).forEach(function (s) {
      if (activeOnly && s.status === 'withdrawn') return;
      if (onlyEmpty && finalLetterOf(s) !== null) return;
      var r = hasOwn(byId, s.id) ? byId[s.id] : null;
      if (!r || typeof r.letter !== 'string' || letters.indexOf(r.letter) === -1) return;
      if (finalLetterOf(s) !== r.letter) n++;
      s.finalLetter = r.letter;
    });
    return n;
  }

  /** Marks the scores as finalized: course.finalized = { at, note }. The grid then locks score cells;
   * final letters stay editable. Finalizing again replaces the date and note. Returns the new value. */
  function finalize(course, isoNow, note) {
    course.finalized = {
      at: typeof isoNow === 'string' && isoNow !== '' ? isoNow : util.nowIso(),
      note: typeof note === 'string' ? note : ''
    };
    return course.finalized;
  }

  /** Unlocks the scores (course.finalized = null). Returns true when the course was finalized. */
  function unfinalize(course) {
    var was = isFinalized(course);
    course.finalized = null;
    return was;
  }

  function isFinalized(course) {
    return !!(course && util.isPlainObject(course.finalized) && typeof course.finalized.at === 'string' && course.finalized.at !== '');
  }

  /** A stored `finalized` value: { at, note } when `at` is a non-empty string (a missing note is ''), else null. */
  function normalizeFinalized(x) {
    if (!util.isPlainObject(x) || typeof x.at !== 'string' || x.at === '') return null;
    return { at: x.at, note: typeof x.note === 'string' ? x.note : '' };
  }

  // ---------------------------------------------------------------- lookups

  function findById(list, id) {
    if (!list || id === null || id === undefined) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function findTeam(course, id) { return findById(course.teams, id); }
  function findStudent(course, id) { return findById(course.students, id); }
  function findAssessment(course, id) { return findById(course.assessments, id); }
  function findCourse(state, id) { return findById(state.courses, id); }

  function studentName(s) {
    if (!s) return '';
    var last = s.lastName || '', first = s.firstName || '';
    if (last && first) return last + ', ' + first;
    return last || first;
  }

  function nextStudentNo(course) {
    var max = 0;
    (course.students || []).forEach(function (s) {
      if (typeof s.no === 'number' && s.no > max) max = s.no;
    });
    return max + 1;
  }

  function teamMembers(course, teamId) {
    return (course.students || []).filter(function (s) { return s.teamId === teamId; });
  }

  // ---------------------------------------------------------------- score-entry helpers

  /** The stored entry for owner/assessment in a scores or teamScores map, or null. */
  function getEntry(map, ownerId, assessmentId) {
    if (!hasOwn(map, ownerId)) return null;
    var row = map[ownerId];
    return hasOwn(row, assessmentId) && row[assessmentId] ? row[assessmentId] : null;
  }

  /** Writes an entry, or deletes it when `entry` is null (an emptied owner row is removed).
   * Unsafe keys ("__proto__", "constructor", "prototype") are ignored. */
  function setEntry(map, ownerId, assessmentId, entry) {
    if (!isSafeKey(ownerId) || !isSafeKey(assessmentId)) return;
    if (entry === null || entry === undefined) {
      if (!hasOwn(map, ownerId) || !util.isPlainObject(map[ownerId])) return;
      delete map[ownerId][assessmentId];
      if (Object.keys(map[ownerId]).length === 0) delete map[ownerId];
      return;
    }
    if (!hasOwn(map, ownerId) || !util.isPlainObject(map[ownerId])) map[ownerId] = {};
    map[ownerId][assessmentId] = entry;
  }

  /** Builds a ScoreEntry from user input (string or number). Keeps late info from `prev`, and its
   * override flag unless the input is empty: clearing an override cell hands the member back to
   * the team score (K5). Pass the assessment's `maxScore` so "88%" is read as 88 percent of it
   * (44 on a 50-point item); without it the "%" is dropped (util.parseScoreInput). */
  function entryFromInput(input, prev, maxScore) {
    var p = util.parseScoreInput(input, maxScore);
    var e = {};
    if (p.kind === 'number') e.value = p.value;
    else if (p.kind === 'invalid') { e.value = null; e.text = p.text; }
    else e.value = null;
    if (prev) {
      if (prev.weeksLate) e.weeksLate = prev.weeksLate;
      if (prev.waived) e.waived = true;
      if (prev.override && p.kind !== 'empty') e.override = true;
    }
    return e;
  }

  /** True when the entry carries no information (empty value, no text, no late info, no override). */
  function isBlankEntry(e) {
    if (!e) return true;
    return (e.value === null || e.value === undefined) && !e.text && !e.weeksLate && !e.waived && !e.override;
  }

  /** True when the entry holds a score: a number, or invalid text (late info alone is no score). */
  function hasScore(e) {
    return !!e && (typeof e.value === 'number' || (typeof e.text === 'string' && e.text !== ''));
  }

  /** Comparison key for "same visible score": the value (or invalid text) plus the late-work info
   * that changes the score (weeks late, and whether that penalty is waived). */
  function entryKey(e) {
    if (!e) return 'empty';
    var k = typeof e.value === 'number' ? 'n:' + e.value : (e.text ? 't:' + e.text : 'empty');
    var wl = typeof e.weeksLate === 'number' && e.weeksLate > 0 ? e.weeksLate : 0;
    if (wl) k += '|late:' + wl + (e.waived ? ':waived' : '');
    return k;
  }

  function sortedMembers(course, teamId) {
    return teamMembers(course, teamId).slice().sort(function (a, b) {
      return util.compareText(a.lastName, b.lastName) || util.compareText(a.firstName, b.firstName) ||
        ((a.no || 0) - (b.no || 0));
    });
  }

  /** Given member entries of one team, returns the entry to use as the team score:
   * the most frequent entryKey; ties go to the entry seen first in the given order. */
  function majorityEntry(entries) {
    var counts = Object.create(null), firstIdx = Object.create(null), best = null;
    entries.forEach(function (e, i) {
      var k = entryKey(e);
      counts[k] = (counts[k] || 0) + 1;
      if (firstIdx[k] === undefined) firstIdx[k] = i;
    });
    Object.keys(counts).forEach(function (k) {
      if (best === null || counts[k] > counts[best] || (counts[k] === counts[best] && firstIdx[k] < firstIdx[best])) best = k;
    });
    return best === null ? null : entries[firstIdx[best]];
  }

  function stripOverride(e) {
    if (!e) return null;
    var c = util.clone(e);
    delete c.override;
    return c;
  }

  /** What a team member sees for a team-graded item (own override, else the team score),
   * whatever the assessment's teamGraded flag currently is. */
  function memberEntry(course, student, assessmentId) {
    var own = getEntry(course.scores, student.id, assessmentId);
    if (own && own.override === true) return own;
    return getEntry(course.teamScores, student.teamId, assessmentId);
  }

  /** Sets team scores from per-member rows (paste/import of a team-graded column; K5).
   * rows: [{ studentId, entry }] (entry null = empty). A row is an "override row" when its member
   * holds an override now or its entry has override: true (entryFromInput keeps the flag when a
   * value is typed or pasted over an override cell). For each team with rows:
   * - Override rows never vote: an unequal split is never made the whole team's score.
   * - Only other rows holding a score vote (blank cells abstain). Withdrawn members vote only when
   *   no active member of that team has a score in those rows.
   * - Team score = the most frequent vote (entryKey, so late info counts; ties: first in row
   *   order). No votes clears the team score; a team whose rows are all override rows keeps it.
   * - An override row pasted back unchanged (same entryKey as the member's override, an empty
   *   one included) is left as it is, so pasting unchanged cells back changes nothing.
   * - Other rows equal to the team score follow it (own entry and any override removed); other
   *   rows with a score keep their entry as an override. Blank rows follow the team score (a blank
   *   over an override hands the member back, like clearing the cell). No empty override is created.
   * - Members not in `rows` are not written. Without an override they see the new team score, like
   *   typing it in one member's cell; `propagatedTo` lists those whose visible score changed.
   * Rows for students without a team are written as individual entries.
   * Returns { overridesCreated (members who had no override before), teamsSet, propagatedTo }. */
  function setTeamScoreFromMembers(course, assessmentId, rows) {
    var byTeam = Object.create(null), order = [], overridesCreated = 0, teamsSet = 0, propagatedTo = [];
    rows.forEach(function (r) {
      var s = findStudent(course, r.studentId);
      if (!s) return;
      if (!s.teamId || !findTeam(course, s.teamId)) {
        setEntry(course.scores, s.id, assessmentId, isBlankEntry(r.entry) ? null : stripOverride(r.entry));
        return;
      }
      if (!byTeam[s.teamId]) { byTeam[s.teamId] = []; order.push(s.teamId); }
      var own = getEntry(course.scores, s.id, assessmentId);
      var held = !!own && own.override === true;
      byTeam[s.teamId].push({
        student: s, entry: r.entry, own: own, held: held,
        isOverride: held || !!(r.entry && r.entry.override === true)
      });
    });
    order.forEach(function (teamId) {
      var list = byTeam[teamId];
      var inRows = Object.create(null);
      list.forEach(function (x) { inRows[x.student.id] = true; });
      var others = teamMembers(course, teamId).filter(function (m) { return !inRows[m.id]; });
      var othersBefore = others.map(function (m) { return entryKey(memberEntry(course, m, assessmentId)); });

      var plain = list.filter(function (x) { return !x.isOverride; });
      var teamEntry;
      if (plain.length) {
        var voters = plain.filter(function (x) { return hasScore(x.entry) && x.student.status !== 'withdrawn'; });
        if (!voters.length) voters = plain.filter(function (x) { return hasScore(x.entry); });
        var team = majorityEntry(voters.map(function (x) { return x.entry; }));
        teamEntry = team ? stripOverride(team) : null;
        setEntry(course.teamScores, teamId, assessmentId, teamEntry);
        teamsSet++;
      } else {
        teamEntry = getEntry(course.teamScores, teamId, assessmentId); // only override rows: keep it
      }
      var teamKey = entryKey(teamEntry);
      list.forEach(function (x) {
        // An override cell pasted back unchanged keeps its override (an empty one included).
        if (x.held && entryKey(x.entry) === entryKey(x.own)) return;
        if (hasScore(x.entry) && entryKey(x.entry) !== teamKey) {
          setOverride(course, x.student.id, assessmentId, x.entry);
          if (!x.held) overridesCreated++;
        } else {
          // The team score now represents this member; drop any stale individual entry or override.
          setEntry(course.scores, x.student.id, assessmentId, null);
        }
      });
      others.forEach(function (m, i) {
        if (entryKey(memberEntry(course, m, assessmentId)) !== othersBefore[i]) propagatedTo.push(m.id);
      });
    });
    return { overridesCreated: overridesCreated, teamsSet: teamsSet, propagatedTo: propagatedTo };
  }

  /** The entry a student currently sees for a team-graded assessment (override or team score),
   * or their individual entry when they have no team. Mirrors calc.resolveEntry. */
  function effectiveEntry(course, student, assessment) {
    if (assessment.teamGraded && student.teamId && findTeam(course, student.teamId)) {
      return memberEntry(course, student, assessment.id);
    }
    return getEntry(course.scores, student.id, assessment.id);
  }

  /** Sets (or, with a blank entry, clears) a team's score for a team-graded assessment. */
  function setTeamScore(course, teamId, assessmentId, entry) {
    setEntry(course.teamScores, teamId, assessmentId, isBlankEntry(entry) ? null : stripOverride(entry));
  }

  /** Gives a team member an explicit override (K5): the entry is stored with override: true.
   * An empty entry (null or { value: null }) is an explicit "no score for this member" override. */
  function setOverride(course, studentId, assessmentId, entry) {
    var o = stripOverride(entry) || { value: null };
    o.override = true;
    setEntry(course.scores, studentId, assessmentId, o);
  }

  /** Removes a member's override so they see the team score again. True when one was removed. */
  function clearOverride(course, studentId, assessmentId) {
    var own = getEntry(course.scores, studentId, assessmentId);
    if (!own || own.override !== true) return false;
    setEntry(course.scores, studentId, assessmentId, null);
    return true;
  }

  /** Copy of `entry` (null = empty) with late-work info set (K4). weeksLate 0 or less removes it;
   * waived is stored only when true. Other fields (value, text, override) are kept. */
  function withLate(entry, weeksLate, waived) {
    var e = entry ? util.clone(entry) : { value: null };
    if (util.isSaneNumber(weeksLate) && weeksLate > 0) e.weeksLate = weeksLate; else delete e.weeksLate;
    if (waived === true) e.waived = true; else delete e.waived;
    return e;
  }

  /** Moves a student to another team, or to no team with newTeamId null. Nothing changes when the
   * student is already in that team.
   * Without keepScores, team-graded scores follow the new team: the student's own entries for
   * team-graded items are removed, overrides included (an unequal split was agreed within the old
   * team), so without a team those items are empty.
   * With keepScores, the student's current team-graded scores are kept wherever the new team's
   * score differs: as overrides in the new team, or as individual entries without a team. An empty
   * score is not kept as an override; the student then follows the new team's score. */
  function moveStudentToTeam(course, studentId, newTeamId, opts) {
    var s = findStudent(course, studentId);
    if (!s) return;
    var target = newTeamId && findTeam(course, newTeamId) ? newTeamId : null;
    var current = s.teamId && findTeam(course, s.teamId) ? s.teamId : null;
    if (target === current) { s.teamId = target; return; }
    var keep = !!(opts && opts.keepScores);
    var before = Object.create(null);
    course.assessments.forEach(function (a) {
      if (a.teamGraded) before[a.id] = effectiveEntry(course, s, a);
    });
    s.teamId = target;
    course.assessments.forEach(function (a) {
      if (!a.teamGraded) return;
      var prev = before[a.id];
      if (!keep) {
        setEntry(course.scores, s.id, a.id, null);
      } else if (target) {
        if (!hasScore(prev) || entryKey(prev) === entryKey(getEntry(course.teamScores, target, a.id))) {
          setEntry(course.scores, s.id, a.id, null);
        } else {
          setOverride(course, s.id, a.id, prev);
        }
      } else {
        setEntry(course.scores, s.id, a.id, isBlankEntry(prev) ? null : stripOverride(prev));
      }
    });
  }

  /** Switches an individually graded assessment to team-graded (K5). For each team, the members'
   * individual entries (in name order) go through setTeamScoreFromMembers: every entered score is
   * preserved (the majority becomes the team score, the rest overrides) and members without a
   * score follow the team score. Students without a team keep individual entries.
   * Does nothing when the assessment is already team-graded. Returns { overridesCreated }. */
  function convertAssessmentToTeam(course, assessmentId) {
    var a = findAssessment(course, assessmentId);
    if (!a || a.teamGraded) return { overridesCreated: 0 };
    var created = 0;
    course.teams.forEach(function (t) {
      var members = sortedMembers(course, t.id);
      if (!members.length) return;
      var rows = members.map(function (s) {
        var e = stripOverride(getEntry(course.scores, s.id, assessmentId));
        // An override flag means nothing on an individual item: store the entry without it, so
        // every member votes (setTeamScoreFromMembers keeps held overrides out of the vote).
        if (e) setEntry(course.scores, s.id, assessmentId, e);
        return { studentId: s.id, entry: e };
      });
      var res = setTeamScoreFromMembers(course, assessmentId, rows);
      created += res.overridesCreated;
    });
    a.teamGraded = true;
    return { overridesCreated: created };
  }

  /** Switches an assessment to individually graded, copying each student's effective
   * (team or override) entry into their individual entry. */
  function convertAssessmentToIndividual(course, assessmentId) {
    var a = findAssessment(course, assessmentId);
    // Already individual: nothing to convert (and members' own entries must not be touched).
    if (!a || !a.teamGraded) return;
    course.students.forEach(function (s) {
      var eff = s.teamId && findTeam(course, s.teamId)
        ? memberEntry(course, s, assessmentId)
        : getEntry(course.scores, s.id, assessmentId);
      setEntry(course.scores, s.id, assessmentId, isBlankEntry(eff) ? null : stripOverride(eff));
    });
    Object.keys(course.teamScores).forEach(function (tid) {
      setEntry(course.teamScores, tid, assessmentId, null);
    });
    a.teamGraded = false;
  }

  function indexById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  /** Moves an assessment up (delta -1) or down (+1) in display order. Returns true when it moved. */
  function moveAssessment(course, assessmentId, delta) {
    var i = indexById(course.assessments, assessmentId);
    var j = i + delta;
    if (i === -1 || j < 0 || j >= course.assessments.length) return false;
    var tmp = course.assessments[i];
    course.assessments[i] = course.assessments[j];
    course.assessments[j] = tmp;
    return true;
  }

  /** Splits one assessment into parts (A5: e.g. Project I 10% -> Questionnaire I 2.5% + Project I 7.5%).
   * parts: [{ name, weight }] with 2+ parts whose weights sum to the original weight.
   * The original keeps its id and scores and becomes part 1; the other parts are new, empty, and share its
   * max score, team-graded flag and category. Returns the new assessments' ids. Throws on invalid parts. */
  function splitAssessment(course, assessmentId, parts) {
    var i = indexById(course.assessments, assessmentId);
    if (i === -1) throw new Error('Assessment not found.');
    if (!Array.isArray(parts) || parts.length < 2) throw new Error('A split needs at least two parts.');
    var orig = course.assessments[i];
    var total = 0;
    parts.forEach(function (p) {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) throw new Error('Every part needs a name.');
      if (typeof p.weight !== 'number' || !isFinite(p.weight) || p.weight < 0) throw new Error('Every part needs a weight of 0 or more.');
      total += p.weight;
    });
    if (Math.abs(util.fix(total) - (orig.weight || 0)) > 1e-9) {
      throw new Error('The parts add up to ' + util.fix(total) + '%, but ' + orig.name + ' is worth ' + orig.weight + '%.');
    }
    orig.name = parts[0].name.trim();
    orig.weight = parts[0].weight;
    var ids = [];
    parts.slice(1).forEach(function (p, k) {
      var a = createAssessment({
        name: p.name.trim(), weight: p.weight, maxScore: orig.maxScore,
        teamGraded: orig.teamGraded, category: orig.category, choices: orig.choices
      });
      course.assessments.splice(i + 1 + k, 0, a);
      ids.push(a.id);
    });
    return ids;
  }

  /** Sets No = 1..N in name order (last name, then first name), withdrawn students included. */
  function renumberByName(course) {
    var list = course.students.slice().sort(function (a, b) {
      return util.compareText(a.lastName, b.lastName) || util.compareText(a.firstName, b.firstName) ||
        ((typeof a.no === 'number' ? a.no : Infinity) - (typeof b.no === 'number' ? b.no : Infinity)) || 0;
    });
    list.forEach(function (s, k) { s.no = k + 1; });
  }

  /** Permanently deletes a student with their scores, overrides and attendance.
   * (The UI recommends withdrawing instead: withdrawn students stay in history and exports.) */
  function deleteStudent(course, studentId) {
    var i = indexById(course.students, studentId);
    if (i === -1) return false;
    course.students.splice(i, 1);
    if (util.hasOwn(course.scores, studentId)) delete course.scores[studentId];
    var att = course.attendance || {};
    if (att.records && util.hasOwn(att.records, studentId)) delete att.records[studentId];
    if (att.totals && util.hasOwn(att.totals, studentId)) delete att.totals[studentId];
    return true;
  }

  /** Deletes an assessment with every score for it (individual entries, overrides, team scores).
   * Export presets are left alone; the exporter skips columns of missing assessments.
   * Returns true when the assessment existed. */
  function removeAssessment(course, assessmentId) {
    var i = indexById(course.assessments, assessmentId);
    if (i === -1) return false;
    course.assessments.splice(i, 1);
    Object.keys(course.scores).forEach(function (sid) { setEntry(course.scores, sid, assessmentId, null); });
    Object.keys(course.teamScores).forEach(function (tid) { setEntry(course.teamScores, tid, assessmentId, null); });
    return true;
  }

  /** Deletes a team. Its members move to no team through moveStudentToTeam (opts.keepScores keeps
   * their current team-graded scores as individual entries), then the team's scores are deleted.
   * Returns the ids of the members that were moved. */
  function removeTeam(course, teamId, opts) {
    var i = indexById(course.teams, teamId);
    if (i === -1) return [];
    var moved = teamMembers(course, teamId).map(function (s) { return s.id; });
    moved.forEach(function (sid) { moveStudentToTeam(course, sid, null, opts); });
    course.teams.splice(i, 1);
    if (hasOwn(course.teamScores, teamId)) delete course.teamScores[teamId];
    return moved;
  }

  // ---------------------------------------------------------------- normalization
  // Data read from files is untrusted: ids must pass util.isSafeKey, lookups use own properties
  // only, and numbers must be finite and within util.MAX_INPUT_ABS.

  function num(x, dflt) {
    return util.isSaneNumber(x) ? x : dflt;
  }

  function normalizeEntry(e) {
    if (!util.isPlainObject(e)) return null;
    var out = { value: null };
    if (util.isSaneNumber(e.value)) out.value = e.value;
    else if (typeof e.value === 'number' && isFinite(e.value)) out.text = String(e.value); // absurd size: show as invalid
    if (out.value === null && !out.text && typeof e.text === 'string' && e.text !== '') out.text = e.text;
    var wl = num(e.weeksLate, 0);
    if (wl > 0) out.weeksLate = wl;
    if (e.waived === true) out.waived = true;
    if (e.override === true) out.override = true;
    return out;
  }

  function normalizeEntryMap(map) {
    var out = {};
    if (!util.isPlainObject(map)) return out;
    Object.keys(map).forEach(function (owner) {
      if (!isSafeKey(owner) || !util.isPlainObject(map[owner])) return;
      Object.keys(map[owner]).forEach(function (aid) {
        if (!isSafeKey(aid)) return;
        var e = normalizeEntry(map[owner][aid]);
        if (e) setEntry(out, owner, aid, e);
      });
    });
    return out;
  }

  var ROUNDING_MODES = ['none', 'hundredth', 'integer'];
  var ATTENDANCE_MODES = ['per-session', 'totals', 'off'];
  var MARKS = { P: true, A: true, E: true };

  /** An id read from a file, or undefined (so a new one is made) when it is unsafe or already used. */
  function freshId(id, seen) {
    return isSafeKey(id) && !seen[id] ? id : undefined;
  }

  function normalizeCourse(raw) {
    if (!util.isPlainObject(raw)) throw new Error('Course data is not an object.');
    var template = typeof raw.template === 'string' && hasOwn(TEMPLATES, raw.template) ? raw.template : 'custom';
    var level = raw.level === 'graduate' ? 'graduate' : 'undergraduate';
    var c = {
      id: isSafeKey(raw.id) ? raw.id : util.uid('c'),
      template: template,
      code: typeof raw.code === 'string' ? raw.code : TEMPLATES[template].code,
      title: typeof raw.title === 'string' ? raw.title : TEMPLATES[template].title,
      level: level,
      term: typeof raw.term === 'string' ? raw.term : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : util.nowIso(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : util.nowIso()
    };

    var seenA = Object.create(null);
    c.assessments = (Array.isArray(raw.assessments) ? raw.assessments : []).filter(util.isPlainObject).map(function (a) {
      var out = createAssessment({
        id: freshId(a.id, seenA),
        name: typeof a.name === 'string' ? a.name : 'Assessment',
        maxScore: num(a.maxScore, 100),
        weight: num(a.weight, 0),
        teamGraded: a.teamGraded === true,
        category: typeof a.category === 'string' ? a.category : 'other',
        choices: a.choices
      });
      seenA[out.id] = true;
      return out;
    });

    var seenT = Object.create(null);
    c.teams = (Array.isArray(raw.teams) ? raw.teams : []).filter(util.isPlainObject).map(function (t) {
      var out = createTeam(typeof t.name === 'string' ? t.name : 'Team', freshId(t.id, seenT));
      seenT[out.id] = true;
      return out;
    });

    var seenS = Object.create(null);
    c.students = (Array.isArray(raw.students) ? raw.students : []).filter(util.isPlainObject).map(function (s) {
      var out = createStudent({
        id: freshId(s.id, seenS),
        no: num(s.no, null),
        lastName: typeof s.lastName === 'string' ? s.lastName : '',
        firstName: typeof s.firstName === 'string' ? s.firstName : '',
        teamId: typeof s.teamId === 'string' && seenT[s.teamId] ? s.teamId : null,
        status: s.status,
        notes: typeof s.notes === 'string' ? s.notes : '',
        finalLetter: s.finalLetter
      });
      seenS[out.id] = true;
      return out;
    });

    c.scores = normalizeEntryMap(raw.scores);
    c.teamScores = normalizeEntryMap(raw.teamScores);

    var rs = util.isPlainObject(raw.settings) ? raw.settings : {};
    var ds = defaultSettings(level);
    var scale = normalizeLetterScale(rs.letterScale, level);
    c.settings = {
      decimals: Math.max(0, Math.min(6, Math.round(num(rs.decimals, ds.decimals)))),
      rounding: ROUNDING_MODES.indexOf(rs.rounding) !== -1 ? rs.rounding : 'none',
      curve: num(rs.curve, 0),
      latePointsPerWeek: Math.max(0, num(rs.latePointsPerWeek, 10)),
      letterScale: scale,
      passingLetter: passingLetterFor(scale, rs.passingLetter, level)
    };

    var ra = util.isPlainObject(raw.attendance) ? raw.attendance : {};
    var att = defaultAttendance(ATTENDANCE_MODES.indexOf(ra.mode) !== -1 ? ra.mode : 'off', []);
    var seenSes = Object.create(null);
    att.sessions = (Array.isArray(ra.sessions) ? ra.sessions : []).filter(function (x) {
      return util.isPlainObject(x) && util.isIsoDate(x.date);
    }).map(function (x) {
      var id = freshId(x.id, seenSes) || util.uid('ses');
      seenSes[id] = true;
      return { id: id, date: x.date, label: typeof x.label === 'string' ? x.label : '' };
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    if (util.isPlainObject(ra.records)) {
      Object.keys(ra.records).forEach(function (sid) {
        if (!isSafeKey(sid)) return;
        var row = ra.records[sid];
        if (!util.isPlainObject(row)) return;
        Object.keys(row).forEach(function (sesId) {
          var mark = row[sesId];
          if (isSafeKey(sesId) && typeof mark === 'string' && hasOwn(MARKS, mark)) setEntry(att.records, sid, sesId, mark);
        });
      });
    }
    if (util.isPlainObject(ra.totals)) {
      Object.keys(ra.totals).forEach(function (sid) {
        if (!isSafeKey(sid)) return;
        var t = ra.totals[sid];
        if (!util.isPlainObject(t)) return;
        att.totals[sid] = { absent: Math.max(0, num(t.absent, 0)), excused: Math.max(0, num(t.excused, 0)) };
      });
    }
    att.totalsSessionsHeld = Math.max(0, num(ra.totalsSessionsHeld, 0));
    att.unexcusedThreshold = Math.max(0, num(ra.unexcusedThreshold, 3));
    att.excusedCountsTowardStreak = ra.excusedCountsTowardStreak !== false;
    att.dropStreak = Math.max(1, num(ra.dropStreak, 3));
    att.failStreak = Math.max(1, num(ra.failStreak, 4));
    c.attendance = att;

    var ph = defaultPlaceholders(c);
    if (util.isPlainObject(raw.placeholders)) {
      Object.keys(ph).forEach(function (k) {
        var p = hasOwn(raw.placeholders, k) ? raw.placeholders[k] : null;
        if (util.isPlainObject(p) && p.confirmed === true) {
          ph[k] = { confirmed: true, confirmedAt: typeof p.confirmedAt === 'string' ? p.confirmedAt : null };
        }
      });
    }
    c.placeholders = ph;

    var seenP = Object.create(null);
    c.exportPresets = (Array.isArray(raw.exportPresets) ? raw.exportPresets : []).filter(function (p) {
      return util.isPlainObject(p) && typeof p.name === 'string' && Array.isArray(p.columns);
    }).map(function (p) {
      var id = freshId(p.id, seenP) || util.uid('xp');
      seenP[id] = true;
      return {
        id: id,
        name: p.name,
        columns: p.columns.filter(function (k) { return typeof k === 'string'; })
      };
    });

    c.finalized = normalizeFinalized(raw.finalized);
    c.history = (Array.isArray(raw.history) ? raw.history : []).filter(util.isPlainObject);
    return c;
  }

  function normalizeState(raw) {
    if (!util.isPlainObject(raw)) throw new Error('Not a Grade Tracker data file (expected a JSON object).');
    if (raw.app !== APP_ID) {
      // Restore replaces all data (R4), so a JSON file from another tool must never pass.
      throw new Error(raw.app === undefined
        ? 'Not a Grade Tracker data file (the "app": "grade-tracker" marker is missing).'
        : 'Not a Grade Tracker data file (app is "' + String(raw.app) + '").');
    }
    if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION) {
      throw new Error('This data was saved by a newer version of Grade Tracker (schema ' + raw.schemaVersion + ').');
    }
    if (!Array.isArray(raw.courses)) throw new Error('Not a Grade Tracker data file (no course list).');
    var seen = Object.create(null);
    var courses = raw.courses.map(function (c) {
      var n = normalizeCourse(c);
      if (seen[n.id]) n.id = util.uid('c');
      seen[n.id] = true;
      return n;
    });
    var ui = util.isPlainObject(raw.ui) ? raw.ui : {};
    var meta = util.isPlainObject(raw.meta) ? raw.meta : {};
    var out = {
      app: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      courses: courses,
      activeCourseId: typeof raw.activeCourseId === 'string' && seen[raw.activeCourseId]
        ? raw.activeCourseId : (courses[0] ? courses[0].id : null),
      ui: {
        theme: ['system', 'light', 'dark'].indexOf(ui.theme) !== -1 ? ui.theme : 'system',
        privacy: ui.privacy === true,
        activeView: typeof ui.activeView === 'string' ? ui.activeView : 'grades'
      },
      meta: {
        createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : util.nowIso(),
        lastSavedAt: typeof meta.lastSavedAt === 'string' ? meta.lastSavedAt : null,
        lastBackupAt: typeof meta.lastBackupAt === 'string' ? meta.lastBackupAt : null
      }
    };
    // Per-view preferences (ui.gridPrefs, ui.historyPrefs, ...) survive as shallow plain objects.
    Object.keys(ui).forEach(function (k) {
      if (/^[a-zA-Z]+Prefs$/.test(k) && util.isPlainObject(ui[k])) {
        var prefs = {};
        Object.keys(ui[k]).forEach(function (pk) {
          var v = ui[k][pk];
          if (util.isSafeKey && !util.isSafeKey(pk)) return;
          if (v === null || ['string', 'number', 'boolean'].indexOf(typeof v) !== -1) prefs[pk] = v;
          else if (util.isPlainObject(v)) prefs[pk] = JSON.parse(JSON.stringify(v));
        });
        out.ui[k] = prefs;
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- backup files (R4)

  function wrapBackup(state, isoNow) {
    return {
      app: APP_ID,
      kind: 'backup',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: isoNow || util.nowIso(),
      state: state
    };
  }

  /** Validates a parsed backup file. Accepts the wrapped format or a bare state object. */
  function readBackup(obj) {
    if (!util.isPlainObject(obj)) throw new Error('This file is not a Grade Tracker backup.');
    var rawState = obj.kind === 'backup' && util.isPlainObject(obj.state) ? obj.state : obj;
    if (obj.kind === 'backup' && obj.app !== APP_ID) throw new Error('This file is not a Grade Tracker backup.');
    // A wrapped backup carries the app marker on the envelope; a bare state must carry its own.
    if (rawState !== obj && rawState.app === undefined) rawState = Object.assign({ app: APP_ID }, rawState);
    var state = normalizeState(rawState);
    return {
      state: state,
      summary: {
        exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : null,
        courses: state.courses.map(function (c) {
          return { code: c.code, title: c.title, students: c.students.length };
        })
      }
    };
  }

  function duplicateCourse(course, isoNow) {
    var ts = isoNow || util.nowIso();
    var copy = util.clone(course);
    copy.id = util.uid('c');
    copy.code = (course.code || 'Course') + ' (copy)';
    copy.createdAt = ts;
    copy.updatedAt = ts;
    copy.history = [{
      id: util.uid('h'), ts: ts, source: 'system', kind: 'bulk',
      studentId: null, studentName: null, teamId: null, teamName: null,
      field: 'Course', fieldKey: 'course', oldValue: '', newValue: copy.code,
      note: 'Duplicated from ' + (course.code || '') + (course.title ? ' - ' + course.title : '')
    }];
    return copy;
  }

  function courseLabel(c) {
    if (!c) return '';
    return c.title ? c.code + ' - ' + c.title : c.code;
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    APP_ID: APP_ID,
    TEMPLATES: TEMPLATES,
    PLACEHOLDERS: PLACEHOLDERS,
    FALL_2026_TR: FALL_2026_TR,
    ROUNDING_MODES: ROUNDING_MODES,
    ATTENDANCE_MODES: ATTENDANCE_MODES,
    defaultLetterScale: defaultLetterScale,
    defaultPassingLetter: defaultPassingLetter,
    normalizeLetterScale: normalizeLetterScale,
    passingLetterFor: passingLetterFor,
    defaultSettings: defaultSettings,
    defaultAttendance: defaultAttendance,
    generateSessions: generateSessions,
    placeholderKeys: placeholderKeys,
    placeholderInfo: placeholderInfo,
    unconfirmedPlaceholders: unconfirmedPlaceholders,
    isConfirmed: isConfirmed,
    createCourse: createCourse,
    createDefaultState: createDefaultState,
    createStudent: createStudent,
    createTeam: createTeam,
    createAssessment: createAssessment,
    findTeam: findTeam,
    findStudent: findStudent,
    findAssessment: findAssessment,
    findCourse: findCourse,
    studentName: studentName,
    nextStudentNo: nextStudentNo,
    teamMembers: teamMembers,
    sortedMembers: sortedMembers,
    getEntry: getEntry,
    setEntry: setEntry,
    entryFromInput: entryFromInput,
    isBlankEntry: isBlankEntry,
    hasScore: hasScore,
    entryKey: entryKey,
    majorityEntry: majorityEntry,
    setTeamScoreFromMembers: setTeamScoreFromMembers,
    effectiveEntry: effectiveEntry,
    setTeamScore: setTeamScore,
    setOverride: setOverride,
    clearOverride: clearOverride,
    withLate: withLate,
    moveStudentToTeam: moveStudentToTeam,
    convertAssessmentToTeam: convertAssessmentToTeam,
    convertAssessmentToIndividual: convertAssessmentToIndividual,
    removeAssessment: removeAssessment,
    removeTeam: removeTeam,
    moveAssessment: moveAssessment,
    splitAssessment: splitAssessment,
    renumberByName: renumberByName,
    deleteStudent: deleteStudent,
    normalizeCourse: normalizeCourse,
    normalizeState: normalizeState,
    wrapBackup: wrapBackup,
    readBackup: readBackup,
    duplicateCourse: duplicateCourse,
    courseLabel: courseLabel,
    MAX_CHOICE_STEPS: MAX_CHOICE_STEPS,
    normalizeChoices: normalizeChoices,
    choiceValues: choiceValues,
    hasChoices: hasChoices,
    isChoiceValue: isChoiceValue,
    describeChoices: describeChoices,
    parseChoiceInput: parseChoiceInput,
    finalLetterOf: finalLetterOf,
    scaleLetters: scaleLetters,
    isScaleLetter: isScaleLetter,
    matchLetter: matchLetter,
    setFinalLetter: setFinalLetter,
    setFinalLetters: setFinalLetters,
    copySuggestedToFinal: copySuggestedToFinal,
    finalize: finalize,
    unfinalize: unfinalize,
    isFinalized: isFinalized,
    normalizeFinalized: normalizeFinalized
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).model = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
