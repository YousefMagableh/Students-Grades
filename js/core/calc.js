/* Grade Tracker - grade calculations (weighted points, totals, rounding, curve, late penalty,
 * team propagation, letter grades, final letters, rank, percentile). See docs/DESIGN.md section 3.
 * Pure; runs in the browser (GT.calc) and in Node. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;
  var model = isNode ? require('./model.js') : root.GT.model;
  var fix = util.fix;

  /** Classifies a ScoreEntry: empty, a number, or invalid text. */
  function parseEntry(entry) {
    if (!entry) return { state: 'empty', value: null, text: null };
    if (typeof entry.value === 'number' && isFinite(entry.value)) return { state: 'number', value: entry.value, text: null };
    if (typeof entry.text === 'string' && entry.text !== '') return { state: 'invalid', value: null, text: entry.text };
    return { state: 'empty', value: null, text: null };
  }

  /** Which stored entry applies to this student and assessment (K5). */
  function resolveEntry(course, student, assessment) {
    var own = model.getEntry(course.scores, student.id, assessment.id);
    if (assessment.teamGraded && student.teamId && model.findTeam(course, student.teamId)) {
      if (own && own.override === true) return { entry: own, source: 'override', teamId: student.teamId };
      return { entry: model.getEntry(course.teamScores, student.teamId, assessment.id), source: 'team', teamId: student.teamId };
    }
    return { entry: own, source: 'individual', teamId: student.teamId || null };
  }

  /** Late penalty in points on this assessment's own scale (K4):
   * weeksLate x pointsPerWeek, scaled by maxScore / 100. Zero when waived; never negative. */
  function latePenalty(entry, assessment, settings) {
    if (!entry || entry.waived) return 0;
    var weeks = typeof entry.weeksLate === 'number' && entry.weeksLate > 0 ? entry.weeksLate : 0;
    if (!weeks) return 0;
    var perWeek = settings && typeof settings.latePointsPerWeek === 'number' ? settings.latePointsPerWeek : 10;
    var max = typeof assessment.maxScore === 'number' ? assessment.maxScore : 100;
    if (!(perWeek > 0) || !(max > 0)) return 0;
    return fix(weeks * perWeek * max / 100);
  }

  function scoreDetail(course, student, assessment) {
    var r = resolveEntry(course, student, assessment);
    var p = parseEntry(r.entry);
    var max = assessment.maxScore;
    var weight = assessment.weight || 0;
    var missing = p.state !== 'number';
    var weeksLate = r.entry && r.entry.weeksLate > 0 ? r.entry.weeksLate : 0;
    var waived = !!(r.entry && r.entry.waived);
    var penalty = missing ? 0 : latePenalty(r.entry, assessment, course.settings);
    var adjusted = missing ? null : (penalty > 0 ? fix(Math.max(0, p.value - penalty)) : p.value);
    // Unrounded product, summed by studentResult; `weighted` is the display value (fix applied).
    // Rounding each item before summing would drift on max scores such as 30 (79.9999999999).
    var weightedUnrounded = (missing || !(max > 0)) ? 0 : adjusted * weight / max;
    var weighted = fix(weightedUnrounded);
    // A number that is not one of the drop-down values (restored or imported): kept and counted,
    // only highlighted (DECISIONS 8). The list is memoized per assessment in model (no rebuild per score).
    var notOnList = p.state === 'number' && model.hasChoices(assessment) && !model.isChoiceValue(assessment, p.value);
    return {
      assessmentId: assessment.id,
      state: p.state,
      raw: p.value,
      text: p.text,
      source: r.source,
      teamId: r.teamId,
      override: r.source === 'override',
      missing: missing,
      outOfRange: p.state === 'number' && (p.value < 0 || p.value > max),
      notOnList: notOnList,
      weeksLate: weeksLate,
      waived: waived,
      penalty: penalty,
      adjusted: adjusted,
      weighted: weighted,
      weightedUnrounded: weightedUnrounded
    };
  }

  function roundTotal(x, mode) {
    if (x === null || x === undefined) return x;
    if (mode === 'hundredth') return util.roundTo(x, 2);
    if (mode === 'integer') return util.roundTo(x, 0);
    return fix(x);
  }

  function sortedScale(scale) {
    return (scale || []).slice().sort(function (a, b) { return b.min - a.min; });
  }

  /** Position of `letter` in the scale sorted by cutoff, highest first (0 = best letter); -1 when
   * the letter is not in the scale. */
  function letterIndex(scale, letter) {
    if (typeof letter !== 'string' || letter === '' || !Array.isArray(scale)) return -1;
    var s = sortedScale(scale.filter(function (x) { return x !== null && typeof x === 'object'; }));
    for (var i = 0; i < s.length; i++) if (s[i].letter === letter) return i;
    return -1;
  }

  /** Letter for a total: the first cutoff (highest first) the total reaches; else the lowest letter. */
  function letterFor(total, scale) {
    var s = sortedScale(scale);
    if (!s.length) return '';
    if (total === null || total === undefined || !isFinite(total)) return '';
    var t = fix(total);
    for (var i = 0; i < s.length; i++) {
      if (t >= fix(s[i].min)) return s[i].letter;
    }
    return s[s.length - 1].letter;
  }

  function studentResult(course, student) {
    var items = {};
    var weighted = [];
    var missingCount = 0, invalidCount = 0, outOfRangeCount = 0, notOnListCount = 0, overrideCount = 0, lateCount = 0;
    course.assessments.forEach(function (a) {
      var d = scoreDetail(course, student, a);
      items[a.id] = d;
      weighted.push(d.weightedUnrounded);
      if (d.missing && (a.weight || 0) > 0) missingCount++;
      if (d.state === 'invalid') invalidCount++;
      if (d.outOfRange) outOfRangeCount++;
      if (d.notOnList) notOnListCount++;
      if (d.override) overrideCount++;
      if (d.weeksLate > 0) lateCount++;
    });
    var curve = typeof course.settings.curve === 'number' && isFinite(course.settings.curve) ? course.settings.curve : 0;
    var weightedSum = util.sum(weighted); // fix applied once, to the sum of unrounded items
    var totalUnrounded = fix(weightedSum + curve);
    var total = roundTotal(totalUnrounded, course.settings.rounding);
    var letter = letterFor(total, course.settings.letterScale);
    // The final letter is assigned by hand (STAGE2B); the cutoff letter is only a suggestion.
    var finalLetter = model.finalLetterOf(student);
    var finalLetterValid = finalLetter === null || letterIndex(course.settings.letterScale, finalLetter) !== -1;
    return {
      studentId: student.id,
      active: student.status !== 'withdrawn',
      items: items,
      weightedSum: weightedSum,
      curve: curve,
      totalUnrounded: totalUnrounded,
      total: total,
      letter: letter,
      finalLetter: finalLetter,
      finalLetterValid: finalLetterValid,
      effectiveLetter: finalLetter !== null ? finalLetter : letter,
      letterSource: finalLetter !== null ? 'manual' : 'cutoffs',
      letterDiffers: finalLetter !== null && finalLetter !== letter,
      orderIssue: false,
      incomplete: missingCount > 0,
      missingCount: missingCount,
      invalidCount: invalidCount,
      outOfRangeCount: outOfRangeCount,
      notOnListCount: notOnListCount,
      overrideCount: overrideCount,
      lateCount: lateCount,
      rank: null,
      percentile: null,
      diffFromAverage: null
    };
  }

  /** Weight check (A3): ok when the weights sum to 100 and none is negative. */
  function weightStatus(course) {
    var negative = false;
    var s = util.sum(course.assessments.map(function (a) {
      if ((a.weight || 0) < 0) negative = true;
      return a.weight || 0;
    }));
    return { sum: s, ok: Math.abs(s - 100) < 1e-9 && !negative };
  }

  /** Final letters out of order (STAGE2B): among active students with a final letter of the scale
   * (and a finite total), every pair where the student with the strictly lower total holds a strictly
   * higher letter. Equal totals never form a pair. `list` holds studentResult objects; pairs are in
   * total order (highest first, ties by name), as [{ higherTotalId, lowerTotalId }]. */
  function findOrderIssues(course, list) {
    var scale = course.settings.letterScale;
    var students = Object.create(null);
    course.students.forEach(function (s) { students[s.id] = s; });
    var rows = list.filter(function (r) {
      return r.active && r.finalLetter !== null && typeof r.total === 'number' && isFinite(r.total);
    }).map(function (r) {
      return { id: r.studentId, total: fix(r.total), idx: letterIndex(scale, r.finalLetter), s: students[r.studentId] };
    }).filter(function (x) { return x.idx !== -1; });
    rows.sort(function (a, b) { return (b.total - a.total) || compareByName(a.s, b.s); });
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      for (var j = i + 1; j < rows.length; j++) {
        // rows[j] has a lower or equal total; a smaller index is a higher letter.
        if (rows[j].total < rows[i].total && rows[j].idx < rows[i].idx) {
          out.push({ higherTotalId: rows[i].id, lowerTotalId: rows[j].id });
        }
      }
    }
    return out;
  }

  /** Results for every student plus class-level figures (K7). */
  function computeCourse(course) {
    var byId = {};
    var active = [];
    course.students.forEach(function (s) {
      var r = studentResult(course, s);
      byId[s.id] = r;
      // A non-finite total (only possible with absurd weights set in code) is kept out of the
      // average, rank and percentile instead of turning them into NaN.
      if (r.active && typeof r.total === 'number' && isFinite(r.total)) active.push(r);
    });
    var n = active.length;
    var average = n ? fix(util.sum(active.map(function (r) { return r.total; })) / n) : null;
    var totals = active.map(function (r) { return fix(r.total); }).sort(function (a, b) { return b - a; });
    active.forEach(function (r) {
      var t = fix(r.total);
      var higher = 0, lower = 0;
      for (var i = 0; i < totals.length; i++) {
        if (totals[i] > t) higher++;
        else if (totals[i] < t) lower++;
      }
      r.rank = higher + 1;
      r.percentile = n <= 1 ? 100 : fix(100 * lower / (n - 1));
      r.diffFromAverage = fix(r.total - average);
    });
    var activeIds = course.students.filter(function (s) { return byId[s.id].active; }).map(function (s) { return s.id; });
    var orderIssues = findOrderIssues(course, active);
    orderIssues.forEach(function (p) {
      byId[p.higherTotalId].orderIssue = true;
      byId[p.lowerTotalId].orderIssue = true;
    });
    var summary = { active: activeIds.length, assigned: 0, unassigned: 0, manualDiffers: 0, invalid: 0 };
    activeIds.forEach(function (id) {
      var r = byId[id];
      if (r.finalLetter === null) { summary.unassigned++; return; }
      summary.assigned++;
      if (r.letterDiffers) summary.manualDiffers++;
      if (!r.finalLetterValid) summary.invalid++;
    });
    return {
      byId: byId,
      activeIds: activeIds,
      average: average,
      weights: weightStatus(course),
      orderIssues: orderIssues,
      letterSummary: summary
    };
  }

  /** Smallest unrounded total (weighted sum + curve, before the rounding mode) that earns `letter`
   * with these settings: the cutoff itself with rounding 'none', ceil(cutoff) - 0.5 with 'integer',
   * and the cutoff rounded up to 0.01, minus 0.005, with 'hundredth' (Excel ROUND is half away from
   * zero). Meant for cutoffs above 0. Returns null when the letter is not in the scale. */
  function minTotalForLetter(letter, settings) {
    var s = settings || {};
    var scale = sortedScale(s.letterScale);
    var cut = null;
    for (var i = 0; i < scale.length; i++) {
      if (scale[i].letter === letter) { cut = fix(scale[i].min); break; }
    }
    if (cut === null) return null;
    if (s.rounding === 'integer') return fix(Math.ceil(cut) - 0.5);
    if (s.rounding === 'hundredth') return fix(Math.ceil(fix(cut * 100)) / 100 - 0.005);
    return cut;
  }

  /** What-if (ST2): the score on `assessmentId` (on its own scale, on time) that brings the student
   * to `letter`, with every other item at its current value (empty = 0). The item's own current
   * score is ignored. Returns { needed, reachable: needed <= maxScore, alreadyReached: needed <= 0 },
   * or null when the letter or assessment is unknown or the item has no weight or max score. */
  function neededScore(course, student, assessmentId, letter) {
    var a = model.findAssessment(course, assessmentId);
    if (!a || !((a.weight || 0) > 0) || !(a.maxScore > 0)) return null;
    var min = minTotalForLetter(letter, course.settings);
    if (min === null) return null;
    var r = studentResult(course, student);
    var others = 0; // unrounded, like the total (fixing it here would add up to 5e-11 of error)
    course.assessments.forEach(function (x) { if (x.id !== a.id) others += r.items[x.id].weightedUnrounded; });
    var exact = (min - r.curve - others) * a.maxScore / a.weight;
    var needed = fix(exact);
    // A repeating decimal (max 30: 26.666…) rounded down would fall a hair short; round it up instead.
    if (exact - needed > 1e-12) needed = fix(needed + Math.pow(10, -util.FIX_DECIMALS));
    return { needed: needed, reachable: needed <= a.maxScore, alreadyReached: needed <= 0 };
  }

  function compareByName(a, b) {
    return util.compareText(a.lastName, b.lastName) ||
      util.compareText(a.firstName, b.firstName) ||
      ((a.no === null || a.no === undefined ? Infinity : a.no) - (b.no === null || b.no === undefined ? Infinity : b.no)) || 0;
  }

  /** Returns a sorted copy of the course's students. key: 'name' | 'total' | 'no'. Ties by name. */
  function sortStudents(course, results, key, dir) {
    var sign = dir === 'desc' ? -1 : 1;
    var list = course.students.slice();
    list.sort(function (a, b) {
      var c = 0;
      if (key === 'total') {
        var ta = results && results.byId[a.id] ? results.byId[a.id].total : -Infinity;
        var tb = results && results.byId[b.id] ? results.byId[b.id].total : -Infinity;
        c = ta === tb ? 0 : (ta < tb ? -1 : 1);
        if (c !== 0) return sign * c;
        return compareByName(a, b);
      }
      if (key === 'no') {
        var na = typeof a.no === 'number' ? a.no : Infinity;
        var nb = typeof b.no === 'number' ? b.no : Infinity;
        c = na === nb ? 0 : (na < nb ? -1 : 1);
        if (c !== 0) return sign * c;
        return compareByName(a, b);
      }
      return sign * compareByName(a, b);
    });
    return list;
  }

  var api = {
    parseEntry: parseEntry,
    resolveEntry: resolveEntry,
    latePenalty: latePenalty,
    scoreDetail: scoreDetail,
    roundTotal: roundTotal,
    letterIndex: letterIndex,
    letterFor: letterFor,
    studentResult: studentResult,
    weightStatus: weightStatus,
    computeCourse: computeCourse,
    findOrderIssues: findOrderIssues,
    minTotalForLetter: minTotalForLetter,
    neededScore: neededScore,
    compareByName: compareByName,
    sortStudents: sortStudents
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).calc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
