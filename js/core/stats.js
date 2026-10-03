/* Grade Tracker - statistics (ST1-ST3, stage 5): descriptive statistics with QUARTILE.INC quartiles,
 * the eLearning 10-point bins, chart histogram bins, status / letter distributions, pass rate,
 * per-assessment and per-team summaries, top and bottom performers, borderline students, natural gaps
 * between totals, and the cutoff-planner simulation. See docs/DESIGN.md section 10.
 *
 * Every course function reads ACTIVE students only (S2) from `results` (calc.computeCourse(course));
 * pass null to have it computed here. Letters are the EFFECTIVE letters (the final letter when one is
 * set, else the cutoff suggestion; DECISIONS 2) unless { letters: 'suggested' } is passed.
 * Pure (no DOM, no clock); runs in the browser (GT.stats) and in Node. Results pass through util.fix. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;
  var model = isNode ? require('./model.js') : root.GT.model;
  var calc = isNode ? require('./calc.js') : root.GT.calc;
  var attendance = isNode ? require('./attendance.js') : root.GT.attendance;
  var fix = util.fix;
  var hasOwn = util.hasOwn;

  /** Most bins histogram() builds; a smaller width is widened to fit. */
  var MAX_HISTOGRAM_BINS = 1000;

  // ---------------------------------------------------------------- numbers

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** The finite numbers of `values`, in their order (null, NaN, text and Infinity are ignored). */
  function numbers(values) {
    var out = [];
    if (!Array.isArray(values)) return out;
    for (var i = 0; i < values.length; i++) if (isNum(values[i])) out.push(values[i]);
    return out;
  }

  function ascending(a, b) { return a - b; }

  /** QUARTILE.INC / PERCENTILE.INC on ascending values (R type 7): position h = (n - 1) p from 0,
   * linear interpolation between the two neighbours. Null for no values. */
  function quantileSorted(sorted, p) {
    var n = sorted.length;
    if (!n) return null;
    var h = fix((n - 1) * p);
    var lo = Math.floor(h);
    if (lo >= n - 1) return fix(sorted[n - 1]);
    if (lo < 0) return fix(sorted[0]);
    return fix(sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]));
  }

  /** Excel PERCENTILE.INC(values, p) for 0 <= p <= 1; null for no values or a p outside [0, 1]. */
  function percentileInc(values, p) {
    if (!isNum(p) || p < 0 || p > 1) return null;
    return quantileSorted(numbers(values).sort(ascending), p);
  }

  /** Excel QUARTILE.INC(values, k) for k = 0..4 (0 = min, 2 = median, 4 = max); null otherwise. */
  function quartileInc(values, k) {
    if (k !== 0 && k !== 1 && k !== 2 && k !== 3 && k !== 4) return null;
    return percentileInc(values, k / 4);
  }

  /** Descriptive statistics of the finite numbers in `values`:
   * { count, min, max, range, mean, median, sd, variance, sdPopulation, variancePopulation, q1, q3, iqr }.
   * sd / variance are the SAMPLE statistics (n - 1; Excel STDEV.S / VAR.S), null when count < 2;
   * the population ones divide by n (0 for one value). Quartiles are QUARTILE.INC; median = Q2.
   * count = 0 gives count 0 and every other field null. The mean is fix(util.sum(values) / n), the
   * same formula as calc.computeCourse's class average. */
  function describe(values) {
    var xs = numbers(values);
    var n = xs.length;
    var out = {
      count: n, min: null, max: null, range: null, mean: null, median: null, sd: null, variance: null,
      sdPopulation: null, variancePopulation: null, q1: null, q3: null, iqr: null
    };
    if (!n) return out;
    var mean = util.sum(xs) / n; // summed in the given order, like the class average
    var ss = 0;
    for (var i = 0; i < n; i++) { var d = xs[i] - mean; ss += d * d; }
    var sorted = xs.slice().sort(ascending);
    out.min = fix(sorted[0]);
    out.max = fix(sorted[n - 1]);
    out.range = fix(sorted[n - 1] - sorted[0]);
    out.mean = fix(mean);
    out.median = quantileSorted(sorted, 0.5);
    out.q1 = quantileSorted(sorted, 0.25);
    out.q3 = quantileSorted(sorted, 0.75);
    out.iqr = fix(out.q3 - out.q1);
    out.variancePopulation = fix(ss / n);
    out.sdPopulation = fix(Math.sqrt(ss / n));
    if (n >= 2) {
      out.variance = fix(ss / (n - 1));
      out.sd = fix(Math.sqrt(ss / (n - 1)));
    }
    return out;
  }

  // ---------------------------------------------------------------- eLearning bins and histogram

  /** The eLearning "GRADE DISTRIBUTION" bins, in panel order. lo / hi are the numeric bounds:
   * 'Greater than 100' is v > 100 (hi null); '90 - 100' is 90 <= v <= 100; '10k - (10k+9)' is
   * 10k <= v < 10k + 10 (so 89.99 is in '80 - 89'); 'Less than 0' is v < 0 (lo null). */
  var BINS10 = [
    { label: 'Greater than 100', lo: 100, hi: null, rule: 'more than 100' },
    { label: '90 - 100', lo: 90, hi: 100, rule: '90 to 100, both included' }
  ];
  for (var k10 = 8; k10 >= 0; k10--) {
    BINS10.push({
      label: (10 * k10) + ' - ' + (10 * k10 + 9), lo: 10 * k10, hi: 10 * k10 + 10,
      rule: 'at least ' + (10 * k10) + ' and below ' + (10 * k10 + 10)
    });
  }
  BINS10.push({ label: 'Less than 0', lo: null, hi: 0, rule: 'below 0' });

  /** One sentence for the UI tooltip that explains the eLearning bins. */
  var BINS10_RULE = 'Bins as on the eLearning panel: "90 - 100" includes both 90 and 100; every other ' +
    'bin starts at its first number and stops just below the next ten, so 89.99 is in "80 - 89". ' +
    'Values above 100 and below 0 have their own bins.';

  /** Index (0-11, in BINS10 order) of the eLearning bin for v; -1 for anything but a finite number. */
  function bin10Index(v) {
    if (!isNum(v)) return -1;
    var x = fix(v);
    if (x > 100) return 0;
    if (x >= 90) return 1;
    if (x < 0) return 11;
    return 10 - Math.floor(fix(x / 10)); // 0 <= x < 90: k = 0..8 -> index 10..2
  }

  /** The 12 eLearning bins for `values`: [{ label, lo, hi, rule, count }] in panel order
   * ('Greater than 100', '90 - 100', '80 - 89', ..., '0 - 9', 'Less than 0'). Non-numbers are ignored,
   * so the counts add up to describe(values).count. */
  function bins10(values) {
    var out = BINS10.map(function (b) { return { label: b.label, lo: b.lo, hi: b.hi, rule: b.rule, count: 0 }; });
    numbers(values).forEach(function (v) { out[bin10Index(v)].count++; });
    return out;
  }

  function numLabel(x) { return String(fix(x)); }

  /** Generic bins for the histogram chart: ceil((hi - lo) / width) bins [{ lo, hi, label, count,
   * below, above }]. Each bin holds lo <= v < hi, the LAST one lo <= v <= hi (so 100 lands in 90-100).
   * Values below `lo` are counted in the first bin and values above `hi` in the last; `below` and
   * `above` say how many of the bin's count came from outside the range (0 everywhere else), so the
   * chart can mark them. label: '90–100' (en dash). Defaults: width 10, lo 0, hi 100; a width that is
   * not a number above 0 means 10, hi <= lo means hi = lo + width. Non-numbers are ignored. */
  function histogram(values, width, lo, hi) {
    var w = isNum(width) && width > 0 ? width : 10;
    var a = isNum(lo) ? lo : 0;
    var b = isNum(hi) ? hi : 100;
    if (!(b > a)) b = fix(a + w);
    var n = Math.max(1, Math.ceil(fix((b - a) / w)));
    if (n > MAX_HISTOGRAM_BINS) { n = MAX_HISTOGRAM_BINS; w = (b - a) / n; }
    var bins = [];
    for (var i = 0; i < n; i++) {
      var blo = fix(a + i * w);
      var bhi = i === n - 1 ? fix(b) : fix(a + (i + 1) * w);
      bins.push({ lo: blo, hi: bhi, label: numLabel(blo) + '–' + numLabel(bhi), count: 0, below: 0, above: 0 });
    }
    numbers(values).forEach(function (v) {
      var x = fix(v);
      if (x < a) { bins[0].count++; bins[0].below++; return; }
      if (x > b) { bins[n - 1].count++; bins[n - 1].above++; return; }
      var j = Math.min(n - 1, Math.floor(fix((x - a) / w)));
      // Guard the bin edges against the last binary digit (the bin bounds are what the chart shows).
      while (j > 0 && x < bins[j].lo) j--;
      while (j < n - 1 && x >= bins[j].hi) j++;
      bins[j].count++;
    });
    return bins;
  }

  // ---------------------------------------------------------------- reading a course

  function resultsOf(course, results) {
    return results && util.isPlainObject(results.byId) ? results : calc.computeCourse(course);
  }

  function studentsOf(course) {
    return course && Array.isArray(course.students) ? course.students.filter(util.isPlainObject) : [];
  }

  /** [{ s, r }] for the active students with a result, in course.students order. */
  function activeRows(course, results) {
    var out = [];
    studentsOf(course).forEach(function (s) {
      if (s.status === 'withdrawn') return;
      var r = hasOwn(results.byId, s.id) ? results.byId[s.id] : null;
      if (r && r.active) out.push({ s: s, r: r });
    });
    return out;
  }

  function useSuggested(opts) { return !!(opts && opts.letters === 'suggested'); }

  function letterOf(r, opts) {
    var l = useSuggested(opts) ? r.letter : r.effectiveLetter;
    return typeof l === 'string' ? l : '';
  }

  /** A scale read defensively: well-formed rows, highest cutoff first (stable), each letter once. */
  function scaleRows(scale) {
    var rows = [];
    (Array.isArray(scale) ? scale : []).forEach(function (x, i) {
      if (util.isPlainObject(x) && typeof x.letter === 'string' && x.letter !== '' && isNum(x.min)) {
        rows.push({ letter: x.letter, min: x.min, i: i });
      }
    });
    rows.sort(function (a, b) { return (b.min - a.min) || (a.i - b.i); });
    var seen = Object.create(null), out = [];
    rows.forEach(function (x) {
      if (seen[x.letter]) return;
      seen[x.letter] = true;
      out.push({ letter: x.letter, min: x.min });
    });
    return out;
  }

  function indexIn(rows, letter) {
    for (var i = 0; i < rows.length; i++) if (rows[i].letter === letter) return i;
    return -1;
  }

  function settingsOf(course) {
    return course && util.isPlainObject(course.settings) ? course.settings : {};
  }

  /** Letter counts in scale order: [{ letter, min, count, pct, inScale: true }], then one row
   * { min: null, inScale: false } per other non-empty letter met (e.g. a final letter a scale change
   * removed). pct = 100 count / letters.length (null when there are none). */
  function distributionOf(scale, letters) {
    var rows = scaleRows(scale).map(function (x) {
      return { letter: x.letter, min: x.min, count: 0, pct: null, inScale: true };
    });
    var at = Object.create(null);
    rows.forEach(function (x, i) { at[x.letter] = i; });
    letters.forEach(function (l) {
      if (typeof l !== 'string' || l === '') return;
      if (at[l] === undefined) {
        at[l] = rows.length;
        rows.push({ letter: l, min: null, count: 0, pct: null, inScale: false });
      }
      rows[at[l]].count++;
    });
    var n = letters.length;
    rows.forEach(function (x) { x.pct = n ? fix(100 * x.count / n) : null; });
    return rows;
  }

  // ---------------------------------------------------------------- values for the panel and charts

  /** Totals (rounded by the course's rounding mode, as in the grid) of the active students, in
   * course.students order; non-finite totals are left out. describe() of these = the panel. */
  function activeTotals(course, results) {
    var res = resultsOf(course, results);
    return activeRows(course, res).map(function (x) { return x.r.total; }).filter(isNum);
  }

  /** Raw numeric scores of the active students on one assessment (the effective entry: team score,
   * override or own score; as entered, before any late penalty), in course.students order; empty and
   * invalid cells are left out. { percent: true } gives percent of the item's own max
   * (v * 100 / maxScore, so participation 4.5 of 5 is 90). [] for an unknown assessment, and with
   * percent for a max score that is not above 0. */
  function assessmentValues(course, results, assessmentId, opts) {
    var res = resultsOf(course, results);
    var a = model.findAssessment(course, assessmentId);
    if (!a) return [];
    var pct = !!(opts && opts.percent);
    if (pct && !(a.maxScore > 0)) return [];
    var out = [];
    activeRows(course, res).forEach(function (x) {
      var d = x.r.items && hasOwn(x.r.items, a.id) ? x.r.items[a.id] : null;
      if (!d || d.state !== 'number' || !isNum(d.raw)) return;
      out.push(pct ? fix(d.raw * 100 / a.maxScore) : d.raw);
    });
    return out;
  }

  // ---------------------------------------------------------------- distributions

  /** The STATUS DISTRIBUTION column: { active, withdrawn, complete, incomplete, invalidEntries,
   * overrides }. complete / incomplete split the active students (incomplete = at least one empty or
   * invalid score on an item with weight > 0, calc's `incomplete`). invalidEntries and overrides count
   * ENTRIES (cells) of active students: invalid text, and team-graded scores held as a per-member
   * override. withdrawn counts every withdrawn student (shown as "Withdrawn (excluded)"). */
  function statusDistribution(course, results) {
    var res = resultsOf(course, results);
    var rows = activeRows(course, res);
    var out = {
      active: rows.length,
      withdrawn: studentsOf(course).filter(function (s) { return s.status === 'withdrawn'; }).length,
      complete: 0, incomplete: 0, invalidEntries: 0, overrides: 0
    };
    rows.forEach(function (x) {
      if (x.r.incomplete) out.incomplete++; else out.complete++;
      out.invalidEntries += x.r.invalidCount || 0;
      out.overrides += x.r.overrideCount || 0;
    });
    return out;
  }

  /** Letter distribution of the active students in scale order (highest first):
   * [{ letter, min, count, pct, inScale }]. Every scale letter has a row (count 0 included); a letter
   * outside the scale (a final letter the scale no longer has) gets an extra row at the end with
   * min null and inScale false. pct is of all active students. opts.letters: 'effective' (default) |
   * 'suggested'. "n of N final letters assigned": results.letterSummary.assigned / .active. */
  function letterDistribution(course, results, opts) {
    var res = resultsOf(course, results);
    var letters = activeRows(course, res).map(function (x) { return letterOf(x.r, opts); });
    return distributionOf(settingsOf(course).letterScale, letters);
  }

  /** Pass rate of the active students: { passing, total, pct, passingLetter, unknown }. A student
   * passes when their letter is passingLetter or a higher letter of the scale. passingLetter =
   * model.passingLetterFor(scale, settings.passingLetter, course.level) (the setting when the scale has
   * it). unknown = students whose letter is not in the scale (counted as not passing). pct is null when
   * total is 0. opts.letters: 'effective' (default) | 'suggested'. */
  function passRate(course, results, opts) {
    var res = resultsOf(course, results);
    var scale = scaleRows(settingsOf(course).letterScale);
    var passingLetter = scale.length ? model.passingLetterFor(scale, settingsOf(course).passingLetter, course.level) : null;
    var passIdx = passingLetter === null ? -1 : indexIn(scale, passingLetter);
    var rows = activeRows(course, res);
    var passing = 0, unknown = 0;
    rows.forEach(function (x) {
      var i = indexIn(scale, letterOf(x.r, opts));
      if (i === -1) unknown++;
      else if (i <= passIdx) passing++;
    });
    return {
      passing: passing,
      total: rows.length,
      pct: rows.length ? fix(100 * passing / rows.length) : null,
      passingLetter: passingLetter,
      unknown: unknown
    };
  }

  // ---------------------------------------------------------------- per assessment / per team

  /** One entry per assessment (course order): { assessmentId, name, maxScore, weight, teamGraded, n,
   * missing, invalid, mean, median, min, max, sd, meanPct }. Uses the raw numeric scores of the active
   * students (assessmentValues: the effective entry, so a team score counts once per member and an
   * override replaces it). n = students with a number; missing = students without one (empty or
   * invalid, so n + missing = active students); invalid = those of them holding invalid text.
   * sd is the sample SD (null when n < 2). meanPct = mean * 100 / maxScore (the item's OWN max:
   * participation is out of 5); null when n = 0. */
  function perAssessment(course, results) {
    var res = resultsOf(course, results);
    var rows = activeRows(course, res);
    return (Array.isArray(course.assessments) ? course.assessments : []).map(function (a) {
      var vals = [], missing = 0, invalid = 0;
      rows.forEach(function (x) {
        var d = x.r.items && hasOwn(x.r.items, a.id) ? x.r.items[a.id] : null;
        if (d && d.state === 'number' && isNum(d.raw)) { vals.push(d.raw); return; }
        missing++;
        if (d && d.state === 'invalid') invalid++;
      });
      var st = describe(vals);
      return {
        assessmentId: a.id,
        name: a.name,
        maxScore: a.maxScore,
        weight: a.weight,
        teamGraded: !!a.teamGraded,
        n: st.count,
        missing: missing,
        invalid: invalid,
        mean: st.mean,
        median: st.median,
        min: st.min,
        max: st.max,
        sd: st.sd,
        meanPct: st.count && a.maxScore > 0 ? fix(util.sum(vals) * 100 / (a.maxScore * st.count)) : null
      };
    });
  }

  /** One entry per team (course.teams order), then { teamId: null, name: 'No team' } when at least one
   * active student has no team (or a team id that no longer exists):
   * { teamId, name, members, activeMembers, mean, min, max, teamScores: { aid: number|null },
   *   overrides [, avgUnexcused] }.
   * members counts every member (withdrawn included, for the roster); everything else uses active
   * members only. mean / min / max are of their totals (null when none). teamScores holds the team's
   * stored score for each team-graded assessment (null when empty or invalid; {} for 'No team').
   * overrides = per-member override entries of active members. avgUnexcused (only when attendance is
   * not off) = mean unexcused absences of the active members (null when none). */
  function perTeam(course, results) {
    var res = resultsOf(course, results);
    var teams = Array.isArray(course.teams) ? course.teams.filter(util.isPlainObject) : [];
    var teamAssessments = (Array.isArray(course.assessments) ? course.assessments : []).filter(function (a) { return a.teamGraded; });
    var att = attendance && typeof attendance.courseSummary === 'function' ? attendance.courseSummary(course) : null;
    var attOn = !!(att && att.mode !== 'off');
    var groups = teams.map(function (t) { return { team: t, members: [] }; });
    var at = Object.create(null);
    groups.forEach(function (g, i) { if (typeof g.team.id === 'string' && at[g.team.id] === undefined) at[g.team.id] = i; });
    var noTeam = { team: null, members: [] };
    studentsOf(course).forEach(function (s) {
      var i = typeof s.teamId === 'string' ? at[s.teamId] : undefined;
      (i === undefined ? noTeam : groups[i]).members.push(s);
    });
    var isActive = function (s) {
      return s.status !== 'withdrawn' && hasOwn(res.byId, s.id) && res.byId[s.id].active;
    };
    if (noTeam.members.some(isActive)) groups.push(noTeam);
    return groups.map(function (g) {
      var active = g.members.filter(isActive);
      var st = describe(active.map(function (s) { return res.byId[s.id].total; }));
      var scores = {};
      if (g.team) {
        teamAssessments.forEach(function (a) {
          var p = calc.parseEntry(model.getEntry(course.teamScores, g.team.id, a.id));
          scores[a.id] = p.state === 'number' ? p.value : null;
        });
      }
      var entry = {
        teamId: g.team ? g.team.id : null,
        name: g.team ? g.team.name : 'No team',
        members: g.members.length,
        activeMembers: active.length,
        mean: st.mean,
        min: st.min,
        max: st.max,
        teamScores: scores,
        overrides: active.reduce(function (n, s) { return n + (res.byId[s.id].overrideCount || 0); }, 0)
      };
      if (attOn) {
        var abs = active.map(function (s) {
          var sm = hasOwn(att.byStudent, s.id) ? att.byStudent[s.id] : null;
          return sm ? sm.unexcused : null;
        });
        entry.avgUnexcused = describe(abs).mean;
      }
      return entry;
    });
  }

  // ---------------------------------------------------------------- students

  function byTotalDesc(x, y) { return (y.r.total - x.r.total) || calc.compareByName(x.s, y.s); }
  function byTotalAsc(x, y) { return (x.r.total - y.r.total) || calc.compareByName(x.s, y.s); }

  /** Top and bottom n active students by total: { top, bottom }, items { studentId, total, letter,
   * rank } (rank = results' competition rank: equal totals share it). top is highest first, bottom
   * LOWEST first; equal totals are ordered by name (last, first, No) in both. The lists may overlap
   * when there are fewer than 2n students. n defaults to 5 (a whole number >= 0). Students with a
   * non-finite total are left out. opts.letters: 'effective' (default) | 'suggested'. */
  function topBottom(course, results, n, opts) {
    var res = resultsOf(course, results);
    var k = isNum(n) && n >= 0 ? Math.floor(n) : 5;
    var list = activeRows(course, res).filter(function (x) { return isNum(x.r.total); });
    var item = function (x) {
      return { studentId: x.s.id, total: x.r.total, letter: letterOf(x.r, opts), rank: x.r.rank === undefined ? null : x.r.rank };
    };
    return {
      top: list.slice().sort(byTotalDesc).slice(0, k).map(item),
      bottom: list.slice().sort(byTotalAsc).slice(0, k).map(item)
    };
  }

  /** Active students just below the next letter: totalUnrounded within `within` points (default 1)
   * BELOW calc.minTotalForLetter of the letter above their cutoff band, so the rounding mode counts
   * (with 'integer', 89.5 already earns a 90 cutoff). Items, by gap ascending then name:
   * { studentId, total, totalUnrounded, letter, suggestedLetter, nextLetter, cutoff, minTotal, gap,
   *   finalAtOrAboveNext }:
   * - letter = the effective letter (opts.letters 'suggested' gives the suggestion); suggestedLetter =
   *   the cutoff letter; nextLetter = the scale letter just above the band the total is in;
   * - cutoff = nextLetter's cutoff in the scale; minTotal = calc.minTotalForLetter(nextLetter);
   *   gap = minTotal - totalUnrounded (> 0, <= within);
   * - finalAtOrAboveNext = a final letter is set that is nextLetter or higher (already raised).
   * Students in the top band have no next letter and are never listed. */
  function borderline(course, results, within, opts) {
    var res = resultsOf(course, results);
    var w = isNum(within) ? fix(within) : 1;
    var settings = settingsOf(course);
    var scale = scaleRows(settings.letterScale);
    var out = [];
    activeRows(course, res).forEach(function (x) {
      var r = x.r;
      if (!isNum(r.total) || !isNum(r.totalUnrounded) || !scale.length) return;
      var t = fix(r.total);
      // The band the total is in (calc.letterFor): the first cutoff it reaches, else the lowest letter.
      var p = scale.length - 1;
      for (var i = 0; i < scale.length; i++) if (t >= fix(scale[i].min)) { p = i; break; }
      var q = p - 1;
      while (q >= 0 && !(fix(scale[q].min) > t)) q--;
      if (q < 0) return;
      var next = scale[q];
      var minTotal = calc.minTotalForLetter(next.letter, settings);
      if (!isNum(minTotal)) return;
      var gap = fix(minTotal - r.totalUnrounded);
      if (!(gap > 0) || gap > w) return;
      var fi = r.finalLetter === null || r.finalLetter === undefined ? -1 : indexIn(scale, r.finalLetter);
      out.push({
        s: x.s,
        item: {
          studentId: x.s.id,
          total: r.total,
          totalUnrounded: r.totalUnrounded,
          letter: letterOf(r, opts),
          suggestedLetter: r.letter,
          nextLetter: next.letter,
          cutoff: next.min,
          minTotal: minTotal,
          gap: gap,
          finalAtOrAboveNext: fi !== -1 && fi <= q
        }
      });
    });
    out.sort(function (a, b) { return (a.item.gap - b.item.gap) || calc.compareByName(a.s, b.s); });
    return out.map(function (x) { return x.item; });
  }

  /** Natural breaks between the active totals (the values the Suggested letter uses): for each pair of
   * neighbouring distinct totals in ascending order whose difference is >= minGap (default 1), an item
   * { below, above, gap, mid, countAbove } (mid = halfway; countAbove = active students with a total of
   * `above` or more). Sorted by gap descending, then by `above` descending. Equal totals never form a
   * gap (gap > 0 always). */
  function gaps(course, results, minGap) {
    var res = resultsOf(course, results);
    var mg = isNum(minGap) ? fix(minGap) : 1;
    var t = activeTotals(course, res).map(fix).sort(ascending);
    var out = [];
    for (var i = 1; i < t.length; i++) {
      var d = fix(t[i] - t[i - 1]);
      if (d > 0 && d >= mg) {
        out.push({ below: t[i - 1], above: t[i], gap: d, mid: fix((t[i - 1] + t[i]) / 2), countAbove: t.length - i });
      }
    }
    out.sort(function (a, b) { return (b.gap - a.gap) || (b.above - a.above); });
    return out;
  }

  // ---------------------------------------------------------------- cutoff planner

  /** The course-scale letter setFinalLetters would store for `letter` (model.matchLetter), or null. */
  function courseLetter(course, letter) {
    return typeof letter === 'string' && letter !== '' ? model.matchLetter(course, letter) : null;
  }

  /** What a hypothetical scale would do, without changing anything. The scale goes through
   * model.normalizeLetterScale(scale, course.level) and each active student's `total` (rounded by the
   * course's rounding mode, like the Suggested letter) through calc.letterFor. Returns
   * { scale, distribution, byId, students, changes, finalChanges }:
   * - scale: the normalized scale (highest cutoff first); distribution: as letterDistribution, for the
   *   simulated letters over that scale; byId: { studentId: simulated letter } (active students);
   * - students: [{ studentId, total, suggested, finalLetter, current, simulated, changed }] for every
   *   active student, total descending then name (non-finite totals last, simulated ''); current =
   *   the effective letter (opts.letters 'suggested': the suggestion); changed = simulated !== current;
   * - changes: the students rows with changed true (same order);
   * - finalChanges: { onlyEmpty, all } = how many stored final letters "Use these as final letters"
   *   would change with each choice (= lettersFromScale(..., { onlyEmpty }) items that differ from the
   *   stored final letter). */
  function simulate(course, results, scale, opts) {
    var res = resultsOf(course, results);
    var norm = model.normalizeLetterScale(scale, course.level);
    var rows = activeRows(course, res);
    var byId = {};
    var list = rows.map(function (x) {
      var r = x.r;
      var sim = calc.letterFor(r.total, norm);
      byId[x.s.id] = sim;
      var current = letterOf(r, opts);
      return {
        s: x.s,
        row: {
          studentId: x.s.id,
          total: r.total,
          suggested: r.letter,
          finalLetter: r.finalLetter === undefined ? null : r.finalLetter,
          current: current,
          simulated: sim,
          changed: sim !== current
        }
      };
    });
    list.sort(function (a, b) {
      var fa = isNum(a.row.total), fb = isNum(b.row.total);
      if (fa !== fb) return fa ? -1 : 1;
      return (fa ? b.row.total - a.row.total : 0) || calc.compareByName(a.s, b.s);
    });
    var students = list.map(function (x) { return x.row; });
    var finalChanges = { onlyEmpty: 0, all: 0 };
    students.forEach(function (row) {
      var l = courseLetter(course, row.simulated);
      if (l === null || l === row.finalLetter) return;
      finalChanges.all++;
      if (row.finalLetter === null) finalChanges.onlyEmpty++;
    });
    return {
      scale: norm,
      distribution: distributionOf(norm, students.map(function (row) { return row.simulated; })),
      byId: byId,
      students: students,
      changes: students.filter(function (row) { return row.changed; }),
      finalChanges: finalChanges
    };
  }

  /** The items for "Use these as final letters…": [{ studentId, letter }] for the active students
   * (course.students order) with the letter `scale` gives their total (as simulate), spelled as the
   * course's scale spells it (model.matchLetter). Students whose simulated letter is not a letter of
   * the course's scale are left out (a sandbox that only moves cutoffs never causes this).
   * opts.onlyEmpty (default false): only students without a final letter. Pass the result to
   * model.setFinalLetters inside ONE GT.store.transact (one undo step). */
  function lettersFromScale(course, results, scale, opts) {
    var res = resultsOf(course, results);
    var onlyEmpty = !!(opts && opts.onlyEmpty);
    var norm = model.normalizeLetterScale(scale, course.level);
    var out = [];
    activeRows(course, res).forEach(function (x) {
      if (onlyEmpty && model.finalLetterOf(x.s) !== null) return;
      var l = courseLetter(course, calc.letterFor(x.r.total, norm));
      if (l !== null) out.push({ studentId: x.s.id, letter: l });
    });
    return out;
  }

  var api = {
    BINS10: BINS10.map(function (b) { return { label: b.label, lo: b.lo, hi: b.hi, rule: b.rule }; }),
    BINS10_RULE: BINS10_RULE,
    describe: describe,
    percentileInc: percentileInc,
    quartileInc: quartileInc,
    bin10Index: bin10Index,
    bins10: bins10,
    histogram: histogram,
    activeTotals: activeTotals,
    assessmentValues: assessmentValues,
    statusDistribution: statusDistribution,
    letterDistribution: letterDistribution,
    passRate: passRate,
    perAssessment: perAssessment,
    perTeam: perTeam,
    topBottom: topBottom,
    borderline: borderline,
    gaps: gaps,
    simulate: simulate,
    lettersFromScale: lettersFromScale
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).stats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
