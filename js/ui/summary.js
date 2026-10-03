/* Grade Tracker - printable Summary tab (GT.views.summary), stage 6 (STAGE6 §2 and Addendum §3).
 *
 * A print-first course summary for the grading meeting with the instructor:
 *   1. header: course code, title, term, level, generated date and time, student counts, finalized status
 *   2. one line naming every placeholder setting that is still unconfirmed
 *   3. assessments and weights, plus the grade settings (cutoffs, rounding, curve, late rule, ...)
 *   4. the grade table, sorted by name: No, Last, First, Team, raw scores (participation always), optional
 *      weighted points, Total, the effective letter, Rank, and the absence columns when attendance is on.
 *      Withdrawn students come last, marked W. The letter column is "Letter (suggested)" while no final
 *      letter is assigned, else "Final letter" with "—" for students who have none yet.
 *   5. statistics of the active totals: count, average, median, sample standard deviation, min, max, pass rate, letter distribution
 *   6. a notes and signature area for the instructor.
 * The option bar above the page (withdrawn, raw, weighted, hide names, Print) is screen only (.no-print).
 * Preferences live in GT.store.state.ui.summaryPrefs (GT.store.setUi). css/summary.css holds the print rules
 * (Letter landscape, 12 mm margins, repeated table header, no row split, no privacy blur).
 *
 * Statistics use GT.stats (js/core/stats.js) when it is loaded and returns well-formed results, else the small
 * local helpers below (same definitions: sample SD with n - 1, median of the middle pair).
 * Browser only. All dynamic text is escaped; on screen, names carry class "pii" (privacy blur). */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model, calc = GT.calc;
  var ui = GT.ui = GT.ui || {};
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  // ------------------------------------------------------------------ constants

  var DEFAULT_PREFS = { withdrawn: true, raw: true, weighted: false, hideNames: false };
  var OPTIONS = [
    { key: 'withdrawn', label: 'Include withdrawn students', title: 'Withdrawn students are listed last and marked W' },
    { key: 'raw', label: 'Raw scores', title: 'One column per assessment. Class/Project Participation is always shown.' },
    { key: 'weighted', label: 'Weighted scores', title: 'Points each assessment adds to the total (raw ÷ max × weight)' },
    { key: 'hideNames', label: 'Hide names (use No only)', title: 'Leaves out Last Name and First Name, for printing or sharing without names' }
  ];
  var ROUNDING_TEXT = {
    none: 'No rounding',
    hundredth: 'Nearest 0.01',
    integer: 'Nearest integer (halves away from zero, like Excel ROUND)'
  };
  var DASH = '—';

  // ------------------------------------------------------------------ module state

  var boundEl = null;
  var dom = null;
  var dirty = true;
  var lastHtml = null;
  var lastCourseId = null;
  var printBound = false;
  var savedTitle = null;

  // ------------------------------------------------------------------ small helpers

  function logErr(e) { if (root.console) console.error(e); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function num(x, d) { return util.formatNumber(x, d === undefined ? 2 : d); }
  /** A total, weighted points or a statistic as the Grades and Statistics tabs show it: rounded to the
   * course's display decimals, trailing zeros dropped (80.5, 86), '' for no value. */
  function shown(x, d) { return isNum(x) ? util.formatNumber(x, d) : ''; }
  /** "SE 4351 · Requirements Engineering · Fall 2026": the subtitle of every tab's page header. */
  function courseLine(course) {
    return course ? [course.code, course.title, course.term].filter(function (x) { return typeof x === 'string' && x.trim() !== ''; }).join(' · ') : '';
  }
  function decimalsOf(course) {
    var d = course && course.settings ? course.settings.decimals : 2;
    return isNum(d) && d >= 0 && d <= 6 ? Math.floor(d) : 2;
  }
  function sortedScale(course) {
    var list = course && course.settings && Array.isArray(course.settings.letterScale) ? course.settings.letterScale : [];
    return list.filter(function (x) { return util.isPlainObject(x) && typeof x.letter === 'string' && isNum(x.min); })
      .slice().sort(function (a, b) { return b.min - a.min; });
  }
  function isParticipation(a) { return a && a.category === 'participation'; }
  function dateOnly(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function nowText() {
    var iso = new Date().toISOString();
    return ui.dateTime ? ui.dateTime(iso) : iso;
  }
  function localIsoDate() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  /** Superscript marker; the legend under the table explains it. */
  function mk(text, title, cls) {
    return '<sup class="sum-mk' + (cls ? ' ' + cls : '') + '" title="' + esc(title) + '">' + esc(text) + '</sup>';
  }
  /** Dagger for a placeholder value that is not confirmed yet (empty once confirmed). */
  function phMark(course, key) {
    if (!course || model.isConfirmed(course, key)) return '';
    var info = model.placeholderInfo(course, key);
    if (!info) return '';
    return '<sup class="sum-ph" title="' + esc(info.label + ': not confirmed. ' + info.note) + '">†</sup>';
  }

  // ------------------------------------------------------------------ preferences (ui.summaryPrefs)

  function getPrefs() {
    var st = GT.store && GT.store.state;
    var p = st && st.ui && util.isPlainObject(st.ui.summaryPrefs) ? st.ui.summaryPrefs : {};
    var out = {};
    Object.keys(DEFAULT_PREFS).forEach(function (k) { out[k] = typeof p[k] === 'boolean' ? p[k] : DEFAULT_PREFS[k]; });
    return out;
  }
  function setPrefs(patch) {
    var p = getPrefs();
    Object.keys(patch).forEach(function (k) { if (util.hasOwn(DEFAULT_PREFS, k)) p[k] = !!patch[k]; });
    dirty = true;
    GT.store.setUi({ summaryPrefs: p });
  }

  if (GT.store && GT.store.subscribe) {
    GT.store.subscribe(function (info) {
      var t = info && info.type;
      if (t === 'saved' || t === 'annotate' || t === 'meta') return;
      dirty = true;
    });
  }

  // ------------------------------------------------------------------ statistics (GT.stats when complete, else local)

  function statsApi() {
    var s = GT.stats;
    return s && typeof s.describe === 'function' && typeof s.letterDistribution === 'function' && typeof s.passRate === 'function' ? s : null;
  }

  /** count, mean, median, sample SD (n - 1; null when n < 2), min, max of the finite values. */
  function localDescribe(values) {
    var v = (values || []).filter(isNum).slice().sort(function (a, b) { return a - b; });
    var n = v.length;
    if (!n) return { count: 0, mean: null, median: null, sd: null, min: null, max: null };
    var mean = util.fix(util.sum(v) / n);
    var mid = Math.floor(n / 2);
    var median = n % 2 ? v[mid] : util.fix((v[mid - 1] + v[mid]) / 2);
    var sd = null;
    if (n > 1) {
      var m = util.sum(v) / n, ss = 0;
      v.forEach(function (x) { ss += (x - m) * (x - m); });
      sd = util.fix(Math.sqrt(ss / (n - 1)));
    }
    return { count: n, mean: mean, median: median, sd: sd, min: v[0], max: v[n - 1] };
  }

  function describe(values) {
    var api = statsApi();
    var n = (values || []).filter(isNum).length;
    if (api) {
      try {
        var d = api.describe(values);
        var ok = d && d.count === n && (n === 0 || [d.mean, d.median, d.min, d.max].every(isNum)) && (n < 2 || isNum(d.sd));
        if (ok) return { count: d.count, mean: d.mean, median: d.median, sd: n < 2 ? null : d.sd, min: d.min, max: d.max };
      } catch (e) { logErr(e); }
    }
    return localDescribe(values);
  }

  /** Active students' effective letters (final letter when assigned, else the suggestion), in scale order.
   * Letters that are not on the scale are counted under "Other". */
  function localLetterDistribution(course, results) {
    var scale = sortedScale(course);
    var counts = Object.create(null), other = 0, n = 0;
    results.activeIds.forEach(function (id) {
      var r = results.byId[id];
      if (!r) return;
      n++;
      var l = r.effectiveLetter;
      if (calc.letterIndex(scale, l) === -1) { other++; return; }
      counts[l] = (counts[l] || 0) + 1;
    });
    var seen = Object.create(null);
    var rows = [];
    scale.forEach(function (x) {
      if (seen[x.letter]) return;
      seen[x.letter] = true;
      rows.push({ letter: x.letter, count: counts[x.letter] || 0 });
    });
    return { rows: rows, other: other, n: n };
  }

  function letterDistribution(course, results) {
    var local = localLetterDistribution(course, results);
    var api = statsApi();
    if (api) {
      try {
        var d = api.letterDistribution(course, results);
        var ok = Array.isArray(d) && d.every(function (x) { return x && typeof x.letter === 'string' && isNum(x.count) && x.count >= 0; });
        if (ok) {
          var sum = 0, seen = Object.create(null), rows = [];
          d.forEach(function (x) {
            if (seen[x.letter]) return;
            seen[x.letter] = true;
            sum += x.count;
            rows.push({ letter: x.letter, count: x.count });
          });
          if (sum <= local.n) return { rows: rows, other: local.n - sum, n: local.n };
        }
      } catch (e) { logErr(e); }
    }
    return local;
  }

  function localPassRate(course, results) {
    var scale = sortedScale(course);
    var pl = model.passingLetterFor ? model.passingLetterFor(scale, course.settings.passingLetter, course.level) : course.settings.passingLetter;
    var pIdx = calc.letterIndex(scale, pl);
    var passing = 0, total = 0;
    results.activeIds.forEach(function (id) {
      var r = results.byId[id];
      if (!r) return;
      total++;
      var i = calc.letterIndex(scale, r.effectiveLetter);
      if (i !== -1 && pIdx !== -1 && i <= pIdx) passing++;
    });
    return { passing: passing, total: total, pct: total ? util.fix(100 * passing / total) : null, passingLetter: pl };
  }

  function passRate(course, results) {
    var local = localPassRate(course, results);
    var api = statsApi();
    if (api) {
      try {
        var p = api.passRate(course, results);
        if (p && isNum(p.passing) && isNum(p.total) && p.passing >= 0 && p.passing <= p.total) {
          return {
            passing: p.passing, total: p.total,
            pct: isNum(p.pct) ? p.pct : (p.total ? util.fix(100 * p.passing / p.total) : null),
            passingLetter: typeof p.passingLetter === 'string' && p.passingLetter ? p.passingLetter : local.passingLetter
          };
        }
      } catch (e) { logErr(e); }
    }
    return local;
  }

  function activeTotals(results) {
    return results.activeIds.map(function (id) { return results.byId[id] ? results.byId[id].total : null; }).filter(isNum);
  }

  // ------------------------------------------------------------------ attendance (guarded)

  function attendanceMode(course) {
    var m = course && course.attendance ? course.attendance.mode : 'off';
    return m === 'per-session' || m === 'totals' ? m : 'off';
  }
  function attendanceSummary(course) {
    if (attendanceMode(course) === 'off') return null;
    var a = GT.attendance;
    if (!a || typeof a.courseSummary !== 'function') return null;
    try {
      var cs = a.courseSummary(course);
      return cs && util.isPlainObject(cs.byStudent) ? cs : null;
    } catch (e) { logErr(e); return null; }
  }

  // ------------------------------------------------------------------ document: header and confirmation line

  function headerHtml(course, results) {
    var active = results.activeIds.length;
    var withdrawn = course.students.length - active;
    var level = course.level === 'graduate' ? 'Graduate' : course.level === 'undergraduate' ? 'Undergraduate' : '';
    var meta = [course.term, level].filter(function (x) { return x; }).map(esc).join(' · ');
    var status = model.isFinalized(course)
      ? 'Scores finalized ' + esc(dateOnly(course.finalized.at))
      : 'Draft: scores not finalized';
    var students = plural(active, 'active student') + (withdrawn ? ' · ' + withdrawn + ' withdrawn' : '');
    return '<header class="sum-head">' +
      '<div class="sum-head-main">' +
        '<div class="sum-kicker">Course grade summary</div>' +
        '<h2 class="sum-title"><span class="sum-code">' + esc(course.code || 'Course') + '</span>' +
          (course.title ? '<span class="sum-title-sep" aria-hidden="true">·</span><span class="sum-title-text">' + esc(course.title) + '</span>' : '') +
        '</h2>' +
        (meta ? '<div class="sum-meta">' + meta + '</div>' : '') +
      '</div>' +
      '<dl class="sum-facts">' +
        '<div><dt>Generated</dt><dd><time class="sum-generated"></time></dd></div>' +
        '<div><dt>Students</dt><dd>' + esc(students) + '</dd></div>' +
        '<div><dt>Status</dt><dd>' + status + '</dd></div>' +
      '</dl>' +
    '</header>';
  }

  function confirmLineHtml(course) {
    var list = model.unconfirmedPlaceholders(course);
    if (!list.length) {
      return '<p class="sum-confirm sum-confirm-ok">' + ui.icon('check') +
        '<span>All placeholder settings are confirmed with the instructor.</span></p>';
    }
    var names = list.map(function (p) { return '<span class="sum-confirm-item">' + esc(p.label) + '</span>'; }).join('<span class="sum-dot" aria-hidden="true"> · </span>');
    return '<p class="sum-confirm">' + ui.icon('alert') +
      '<span><strong>Placeholders, not yet confirmed with the instructor (†):</strong> ' + names + '.</span></p>';
  }

  // ------------------------------------------------------------------ document: weights and grade settings

  function weightsHtml(course, results) {
    var dec = 2;
    var rows = course.assessments.map(function (a) {
      var weightMark = a.category === 'project' ? phMark(course, 'projectSplit') : a.id === 'a_paper' ? phMark(course, 'termPaperWeight') : '';
      return '<tr><th scope="row">' + esc(a.name) + '</th>' +
        '<td class="num">' + esc(num(a.maxScore, dec)) + '</td>' +
        '<td class="num">' + esc(num(a.weight || 0, dec)) + '%' + weightMark + '</td>' +
        '<td>' + (a.teamGraded ? 'Team' : 'Individual') + '</td></tr>';
    }).join('');
    if (!rows) rows = '<tr><td colspan="4" class="sum-empty-cell">No assessments yet.</td></tr>';
    var w = results.weights || calc.weightStatus(course);
    var sumCell = esc(num(w.sum, dec)) + '%' + (w.ok ? '' : ' <span class="sum-warn-text">(not 100%)</span>');
    return '<section class="sum-sec sum-weights" aria-labelledby="sum-h-weights">' +
      '<h3 class="sum-h" id="sum-h-weights">Assessments and weights</h3>' +
      '<table class="sum-table sum-mini">' +
        '<thead><tr><th scope="col">Assessment</th><th scope="col" class="num">Max' + phMark(course, 'maxScores') + '</th>' +
        '<th scope="col" class="num">Weight</th><th scope="col">Graded</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><th scope="row">Total</th><td></td><td class="num">' + sumCell + '</td><td></td></tr></tfoot>' +
      '</table>' +
      '<p class="sum-note">Weighted points = raw ÷ max × weight. Total = sum of weighted points' +
        (course.settings.curve ? ' plus the curve' : '') + '. An empty score counts as 0.</p>' +
    '</section>';
  }

  function scaleText(course) {
    var s = sortedScale(course);
    return s.map(function (x, i) {
      if (i === s.length - 1 && i > 0 && x.min === 0) return x.letter + ' below ' + num(s[i - 1].min);
      return x.letter + ' ' + num(x.min);
    }).join(' · ');
  }

  function settingsHtml(course, results) {
    var st = course.settings;
    var dec = decimalsOf(course);
    var rows = [];
    function row(label, valueHtml, key) {
      rows.push('<tr><th scope="row">' + esc(label) + (key ? phMark(course, key) : '') + '</th><td>' + valueHtml + '</td></tr>');
    }
    row('Letter cutoffs', esc(scaleText(course) || 'No letter scale'), 'letterScale');
    row('Rounding', esc(ROUNDING_TEXT[st.rounding] || String(st.rounding)) + '<span class="sum-aside"> · totals shown with up to ' + plural(dec, 'decimal') + '</span>', 'rounding');
    row('Curve', esc(isNum(st.curve) && st.curve ? (st.curve > 0 ? '+' : '') + num(st.curve) + ' points added to every total' : 'None (0 points)'), 'curve');
    var perWeek = isNum(st.latePointsPerWeek) ? st.latePointsPerWeek : 10;
    row('Late work', esc(perWeek > 0
      ? num(perWeek) + ' points per week late on a 100-point score (scaled for other max scores), before weighting, unless the penalty is waived'
      : 'No late penalty (0 points per week)'), 'lateWork');
    var pr = localPassRate(course, results);
    row('Passing grade', esc((pr.passingLetter || '') + ' or better (pass rate)'), 'passingLetter');
    var mode = attendanceMode(course);
    if (mode === 'off') {
      row('Attendance', 'Not tracked');
    } else {
      var att = course.attendance;
      var parts = [mode === 'per-session' ? 'Per session' : 'Totals only'];
      var cs = attendanceSummary(course);
      if (cs && isNum(cs.held)) parts.push(plural(cs.held, 'session') + ' held');
      parts.push('highlight above ' + num(isNum(att.unexcusedThreshold) ? att.unexcusedThreshold : 3) + ' unexcused');
      if (isNum(att.totalAbsenceThreshold)) parts.push('or above ' + num(att.totalAbsenceThreshold) + ' in total');
      rows.push('<tr><th scope="row">Attendance' + phMark(course, 'unexcusedThreshold') + '</th><td>' + esc(parts.join(' · ')) +
        '<span class="sum-aside"> · warnings only, never applied to a grade</span></td></tr>');
    }
    var ls = results.letterSummary || { active: 0, assigned: 0 };
    var finalText = !ls.active ? 'No active students'
      : !ls.assigned ? 'None assigned yet: the letter column shows the suggestion from the cutoffs'
        : ls.assigned === ls.active ? 'All ' + ls.active + ' assigned'
          : ls.assigned + ' of ' + ls.active + ' assigned; ' + DASH + ' marks a student without one yet';
    row('Final letters', esc(finalText));
    return '<section class="sum-sec sum-settings" aria-labelledby="sum-h-settings">' +
      '<h3 class="sum-h" id="sum-h-settings">Grade settings</h3>' +
      '<table class="sum-table sum-mini sum-kv"><tbody>' + rows.join('') + '</tbody></table>' +
    '</section>';
  }

  // ------------------------------------------------------------------ document: the grade table

  /** Header label with an optional second line. Only long names (e.g. "Class/Project Participation") may
   * wrap; short ones such as "Test 1" stay on one line. */
  function headLabel(name, sub) {
    var long = String(name).length > 14 && /\s|\//.test(String(name));
    return '<span class="sum-hn' + (long ? ' sum-hn-long' : '') + '">' + esc(name) + '</span>' +
      (sub ? ' <span class="sum-sub">' + esc(sub) + '</span>' : '');
  }

  /** Column model: { key, group, head, cls, cell(row, used) -> html }. */
  function buildColumns(course, results, prefs, ctx) {
    var cols = [];
    var dec = decimalsOf(course);
    cols.push({ key: 'no', head: headLabel('No'), cls: 'num sum-c-no', cell: function (row) { return isNum(row.s.no) ? esc(String(row.s.no)) : ''; } });
    if (!prefs.hideNames) {
      cols.push({ key: 'last', head: headLabel('Last Name'), cls: 'sum-c-name', cell: function (row) { return '<span class="pii">' + esc(row.s.lastName || '') + '</span>'; } });
      cols.push({ key: 'first', head: headLabel('First Name'), cls: 'sum-c-name', cell: function (row) { return '<span class="pii">' + esc(row.s.firstName || '') + '</span>'; } });
    }
    if (course.teams.length) {
      cols.push({ key: 'team', head: headLabel('Team'), cls: 'sum-c-team', cell: function (row) { return row.s.teamId && ctx.teams[row.s.teamId] ? esc(ctx.teams[row.s.teamId]) : ''; } });
    }
    var rawItems = prefs.raw ? course.assessments : course.assessments.filter(isParticipation);
    var rawGroup = prefs.raw && rawItems.length > 1 ? 'Raw scores' : null;
    rawItems.forEach(function (a) {
      cols.push({
        key: 'raw:' + a.id, group: rawGroup, cls: 'num sum-c-raw',
        head: headLabel(a.name, 'of ' + num(a.maxScore) + (a.teamGraded ? ', team' : '')),
        cell: function (row, used) { return rawCell(row.r.items[a.id], a, dec, used); }
      });
    });
    if (prefs.weighted) {
      course.assessments.filter(function (a) { return (a.weight || 0) > 0; }).forEach(function (a) {
        cols.push({
          key: 'w:' + a.id, group: 'Weighted points', cls: 'num sum-c-w',
          head: headLabel(a.name, num(a.weight || 0) + '%'),
          cell: function (row) {
            var d = row.r.items[a.id];
            return d && !d.missing ? esc(shown(d.weighted, dec)) : '';
          }
        });
      });
    }
    cols.push({
      key: 'total', head: headLabel('Total'), cls: 'num sum-c-total',
      cell: function (row, used) {
        var r = row.r;
        var out = esc(shown(r.total, dec));
        if (r.incomplete) { used.incomplete = true; out += mk('*', 'Incomplete: ' + plural(r.missingCount, 'weighted score') + ' empty, counted as 0'); }
        return out;
      }
    });
    cols.push({
      key: 'letter', cls: 'sum-c-letter',
      head: ctx.assignedAny ? headLabel('Final letter') : headLabel('Letter', '(suggested)'),
      cell: function (row, used) {
        var r = row.r;
        if (!r.active) { used.withdrawn = true; return 'W'; }
        if (!ctx.assignedAny) return esc(r.letter || '');
        if (r.finalLetter === null) { used.noFinal = true; return '<span class="sum-none">' + DASH + '</span>'; }
        var out = esc(r.finalLetter);
        if (!r.finalLetterValid) { used.bad = true; out += mk('!', 'Not a letter of the current scale', 'sum-mk-bad'); }
        return out;
      }
    });
    cols.push({
      key: 'rank', head: headLabel('Rank'), cls: 'num sum-c-rank',
      cell: function (row) { return isNum(row.r.rank) ? esc(String(row.r.rank)) : '<span class="sum-none">' + DASH + '</span>'; }
    });
    if (ctx.att) {
      var att = course.attendance;
      var thr = isNum(att.unexcusedThreshold) ? att.unexcusedThreshold : 3;
      var totThr = isNum(att.totalAbsenceThreshold) ? att.totalAbsenceThreshold : null;
      var smOf = function (row) { return util.hasOwn(ctx.att.byStudent, row.s.id) ? ctx.att.byStudent[row.s.id] : null; };
      cols.push({
        key: 'att:exc', group: 'Absences', cls: 'num sum-c-att', head: headLabel('Excused', '(allowed)'),
        cell: function (row) { var sm = smOf(row); return sm && isNum(sm.excused) ? esc(String(sm.excused)) : ''; }
      });
      cols.push({
        key: 'att:unx', group: 'Absences', cls: 'num sum-c-att', head: headLabel('Unexcused', '(not allowed)'),
        cell: function (row, used) {
          var sm = smOf(row);
          if (!sm || !isNum(sm.unexcused)) return '';
          var out = esc(String(sm.unexcused));
          if (sm.overThreshold) { used.over = true; out += mk('▲', 'Above the unexcused-absence threshold (' + num(thr) + ')', 'sum-mk-warn'); }
          if ((sm.warning === 'drop' || sm.warning === 'fail') && isNum(sm.longestStreak)) {
            used.streak = true;
            out += mk('S' + sm.longestStreak, sm.longestStreak + ' consecutive absences: ' +
              (sm.warning === 'fail' ? 'syllabus says F' : 'syllabus says one letter grade drop') + ' (warning only)', 'sum-mk-warn');
          }
          return out;
        }
      });
      cols.push({
        key: 'att:tot', group: 'Absences', cls: 'num sum-c-att', head: headLabel('Total'),
        cell: function (row, used) {
          var sm = smOf(row);
          if (!sm || !isNum(sm.totalAbsences)) return '';
          var out = esc(String(sm.totalAbsences));
          if (sm.overTotalThreshold && totThr !== null) { used.over = true; out += mk('▲', 'Above the total-absence threshold (' + num(totThr) + ')', 'sum-mk-warn'); }
          return out;
        }
      });
    }
    return cols;
  }

  function rawCell(d, a, dec, used) {
    if (!d) return '';
    var out = '';
    if (d.state === 'invalid') {
      used.bad = true;
      return '<span class="sum-bad">' + esc(d.text) + '</span>' + mk('!', 'Not a number: counts as 0', 'sum-mk-bad');
    }
    if (d.state !== 'number') return '';
    out = esc(num(d.raw, Math.max(dec, 2)));
    if (d.outOfRange) { used.bad = true; out += mk('!', 'Outside 0–' + num(a.maxScore), 'sum-mk-bad'); }
    if (d.override) { used.override = true; out += mk('◆', 'Per-member override of the team score'); }
    if (d.weeksLate > 0) {
      if (d.waived) {
        used.waived = true;
        out += mk('L' + d.weeksLate + '✓', plural(d.weeksLate, 'week') + ' late, penalty waived (pre-approved)', 'sum-mk-waived');
      } else {
        used.late = true;
        out += mk('L' + d.weeksLate, plural(d.weeksLate, 'week') + ' late: −' + num(d.penalty) + ' points, counted as ' + num(d.adjusted), 'sum-mk-warn');
      }
    }
    return out;
  }

  /** The grade table's header rows. `cont` is the "(continued)" line: the first header row, shown only in
   * print, where the browser repeats the header on every page, so pages 2+ name the course (on page 1 the
   * Grades heading covers it; css/summary.css). */
  function theadHtml(cols, cont) {
    var grouped = cols.some(function (c) { return c.group; });
    var top = [], bottom = [];
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      if (!grouped) { top.push('<th scope="col" class="' + c.cls + '">' + c.head + '</th>'); continue; }
      if (!c.group) { top.push('<th scope="col" rowspan="2" class="' + c.cls + '">' + c.head + '</th>'); continue; }
      var span = 1;
      while (i + span < cols.length && cols[i + span].group === c.group) span++;
      top.push('<th scope="colgroup" colspan="' + span + '" class="sum-group">' + esc(c.group) + '</th>');
      for (var j = i; j < i + span; j++) bottom.push('<th scope="col" class="' + cols[j].cls + '">' + cols[j].head + '</th>');
      i += span - 1;
    }
    var contRow = cont ? '<tr class="sum-cont"><th scope="colgroup" colspan="' + cols.length + '">' + esc(cont) + '</th></tr>' : '';
    return '<thead>' + contRow + '<tr>' + top.join('') + '</tr>' + (grouped ? '<tr>' + bottom.join('') + '</tr>' : '') + '</thead>';
  }

  function rowHtml(cols, row, used) {
    return '<tr data-sid="' + esc(row.s.id) + '"' + (row.r.active ? '' : ' class="sum-wd"') + '>' +
      cols.map(function (c) { return '<td class="' + c.cls + '">' + c.cell(row, used) + '</td>'; }).join('') + '</tr>';
  }

  function legendHtml(course, used) {
    var att = course.attendance || {};
    var drop = isNum(att.dropStreak) ? att.dropStreak : 3;
    var fail = isNum(att.failStreak) ? att.failStreak : 4;
    var items = [];
    function add(sym, text, cls) {
      items.push('<span class="sum-leg"><span class="sum-leg-sym' + (cls ? ' ' + cls : '') + '">' + esc(sym) + '</span> ' + esc(text) + '</span>');
    }
    if (used.incomplete) add('*', 'Incomplete: an empty score counts as 0');
    if (used.withdrawn) add('W', 'Withdrawn: not counted in rank or statistics');
    if (used.noFinal) add(DASH, 'No final letter assigned yet');
    if (used.override) add('◆', 'Per-member override of the team score');
    if (used.late) add('L2', 'Weeks late, penalty applied (the total uses the reduced score)', 'sum-mk-warn');
    if (used.waived) add('L2✓', 'Late, penalty waived', 'sum-mk-waived');
    if (used.over) add('▲', 'Above the absence threshold', 'sum-mk-warn');
    if (used.streak) add('S' + drop, 'Consecutive absences (syllabus: ' + drop + ' in a row = one letter grade drop, ' + fail + ' = F); a warning only', 'sum-mk-warn');
    if (used.bad) add('!', 'Check this entry (not a number, out of range, or a letter not on the scale)', 'sum-mk-bad');
    return items.length ? '<p class="sum-legend">' + items.join('') + '</p>' : '';
  }

  function gradesHtml(course, results, prefs, att) {
    var teams = Object.create(null);
    course.teams.forEach(function (t) { teams[t.id] = t.name; });
    var ls = results.letterSummary || { assigned: 0 };
    var ctx = { teams: teams, assignedAny: ls.assigned > 0, att: att };
    var cols = buildColumns(course, results, prefs, ctx);
    var sorted = calc.sortStudents(course, results, 'name', 'asc').filter(function (s) { return results.byId[s.id]; });
    var active = sorted.filter(function (s) { return results.byId[s.id].active; });
    var withdrawn = sorted.filter(function (s) { return !results.byId[s.id].active; });
    var used = Object.create(null);
    var head = '<h3 class="sum-h" id="sum-h-grades">Grades' +
      '<span class="sum-h-note">Sorted by last name, then first name' + (prefs.withdrawn && withdrawn.length ? '; withdrawn students last (W)' : '') + '</span></h3>';
    if (!sorted.length) {
      return '<section class="sum-sec sum-grades-sec" aria-labelledby="sum-h-grades">' + head +
        '<p class="sum-empty">No students in this course yet. Add them in Students &amp; Teams, paste a roster, or load the sample data from the course menu.</p></section>';
    }
    var body = '<tbody>' + active.map(function (s) { return rowHtml(cols, { s: s, r: results.byId[s.id] }, used); }).join('') + '</tbody>';
    if (prefs.withdrawn && withdrawn.length) {
      body += '<tbody class="sum-wd-group"><tr class="sum-group-row"><th scope="rowgroup" colspan="' + cols.length + '">Withdrawn (' + withdrawn.length +
        '): listed for the record, not counted in rank or statistics</th></tr>' +
        withdrawn.map(function (s) { return rowHtml(cols, { s: s, r: results.byId[s.id] }, used); }).join('') + '</tbody>';
    }
    if (!active.length && !(prefs.withdrawn && withdrawn.length)) {
      body = '<tbody><tr><td colspan="' + cols.length + '" class="sum-empty-cell">No active students. Tick "Include withdrawn students" to list the withdrawn ones.</td></tr></tbody>';
    }
    var foot = [];
    if (!prefs.withdrawn && withdrawn.length) foot.push(plural(withdrawn.length, 'withdrawn student') + ' not shown.');
    if (prefs.hideNames) foot.push('Names left out: students are identified by No.');
    return '<section class="sum-sec sum-grades-sec" aria-labelledby="sum-h-grades">' + head +
      '<div class="sum-table-wrap"><table class="sum-table sum-grades" data-cols="' + cols.length + '">' + theadHtml(cols, (course.code ? course.code + ' · ' : '') + 'Course grade summary (continued)') + body + '</table></div>' +
      legendHtml(course, used) +
      (foot.length ? '<p class="sum-note">' + esc(foot.join(' ')) + '</p>' : '') +
    '</section>';
  }

  // ------------------------------------------------------------------ document: statistics

  function statsHtml(course, results) {
    var dec = decimalsOf(course);
    var d = describe(activeTotals(results));
    var head = '<h3 class="sum-h" id="sum-h-stats">Statistics<span class="sum-h-note">Totals of active students only; withdrawn students are excluded</span></h3>';
    if (!d.count) {
      return '<section class="sum-sec sum-stats" aria-labelledby="sum-h-stats">' + head + '<p class="sum-empty">No active students with a total yet.</p></section>';
    }
    var pr = passRate(course, results);
    // The Statistics tab's names (UX-17): Average, Standard deviation.
    var cells = [
      ['Count', String(d.count)],
      ['Average', shown(d.mean, dec)],
      ['Median', shown(d.median, dec)],
      ['Standard deviation', d.sd === null ? DASH : shown(d.sd, dec), 'sample, n − 1'],
      ['Minimum', shown(d.min, dec)],
      ['Maximum', shown(d.max, dec)]
    ];
    var passHead = esc('Pass rate (' + (pr.passingLetter || '?') + ' or better)') + phMark(course, 'passingLetter');
    var passVal = pr.total ? esc(util.formatPercent(pr.pct, 1)) + ' <span class="sum-aside">(' + pr.passing + ' of ' + pr.total + ')</span>' : DASH;
    var figures = '<table class="sum-table sum-figures"><thead><tr>' +
      cells.map(function (c) { return '<th scope="col" class="num">' + esc(c[0]) + (c[2] ? ' <span class="sum-sub">' + esc(c[2]) + '</span>' : '') + '</th>'; }).join('') +
      '<th scope="col" class="num">' + passHead + '</th></tr></thead><tbody><tr>' +
      cells.map(function (c) { return '<td class="num">' + esc(c[1]) + '</td>'; }).join('') +
      '<td class="num">' + passVal + '</td></tr></tbody></table>';

    var dist = letterDistribution(course, results);
    var ls = results.letterSummary || { active: 0, assigned: 0 };
    var basis = !ls.assigned ? 'suggested letters from the cutoffs'
      : ls.assigned === ls.active ? 'final letters'
        : 'final letters where assigned, otherwise the suggested letter';
    var letters = dist.rows.slice();
    if (dist.other) letters.push({ letter: 'Other', count: dist.other });
    var n = dist.n || 0;
    var distTable = '<table class="sum-table sum-dist"><thead><tr><th scope="col">Letter</th>' +
      letters.map(function (x) { return '<th scope="col" class="num">' + esc(x.letter) + '</th>'; }).join('') +
      '</tr></thead><tbody><tr><th scope="row">Students</th>' +
      letters.map(function (x) { return '<td class="num' + (x.count ? '' : ' sum-zero') + '">' + x.count + '</td>'; }).join('') +
      '</tr><tr><th scope="row">Share</th>' +
      letters.map(function (x) { return '<td class="num' + (x.count ? '' : ' sum-zero') + '">' + esc(n ? util.formatPercent(100 * x.count / n, 0) : '') + '</td>'; }).join('') +
      '</tr></tbody></table>';
    return '<section class="sum-sec sum-stats" aria-labelledby="sum-h-stats">' + head +
      '<div class="sum-table-wrap sum-wrap-plain">' + figures + '</div>' +
      '<h4 class="sum-h4">Letter distribution <span class="sum-h-note">' + esc(basis) + '</span></h4>' +
      '<div class="sum-table-wrap sum-wrap-plain">' + distTable + '</div>' +
    '</section>';
  }

  // ------------------------------------------------------------------ document: notes and signatures

  function signHtml() {
    var line = function (label, cls) {
      return '<div class="sum-sign' + (cls ? ' ' + cls : '') + '"><div class="sum-sign-line"></div><div class="sum-sign-label">' + esc(label) + '</div></div>';
    };
    return '<section class="sum-sec sum-signoff" aria-labelledby="sum-h-notes">' +
      '<h3 class="sum-h" id="sum-h-notes">Notes from the grading meeting</h3>' +
      '<div class="sum-lines" aria-hidden="true"><div></div><div></div><div></div><div></div></div>' +
      '<div class="sum-sign-row">' +
        line('Instructor (name and signature)') + line('Date', 'sum-sign-date') +
        line('Teaching assistant (name and signature)') + line('Date', 'sum-sign-date') +
      '</div>' +
    '</section>';
  }

  // ------------------------------------------------------------------ document

  function docHtml(course, results, prefs) {
    if (!course) {
      return '<div class="empty-state"><h2>No course</h2><p>Add a course from the course menu to print its summary.</p></div>';
    }
    var res = results || calc.computeCourse(course);
    var att = attendanceSummary(course);
    return headerHtml(course, res) +
      confirmLineHtml(course) +
      '<div class="sum-two">' + weightsHtml(course, res) + settingsHtml(course, res) + '</div>' +
      gradesHtml(course, res, prefs, att) +
      statsHtml(course, res) +
      signHtml() +
      '<p class="sum-footer">Grade Tracker · ' + esc(course.code || '') + ' · Confidential: student grades. Generated offline on this computer.</p>';
  }

  // ------------------------------------------------------------------ shell (screen-only options)

  function buildShell(el) {
    var opts = OPTIONS.map(function (o) {
      return '<label class="check sum-opt" title="' + esc(o.title) + '"><input type="checkbox" data-pref="' + o.key + '"> ' + esc(o.label) + '</label>';
    }).join('');
    el.innerHTML =
      '<div class="page-header sum-screen-head no-print">' +
        '<div><h1>Summary</h1><div class="sub"><span class="sum-course"></span><span class="sum-course-sep"> · </span>A print-ready page for the grading meeting. The options bar is not printed.</div></div>' +
        '<button type="button" class="btn btn-primary" data-act="print" title="Print or save as PDF (Ctrl+P)">' + ui.icon('print') + '<span>Print…</span></button>' +
      '</div>' +
      '<div class="card sum-options no-print" role="group" aria-label="Print options">' +
        '<div class="sum-opts">' + opts + '</div>' +
        '<p class="sum-hint">' + ui.icon('info') + '<span><strong>Landscape recommended.</strong> The page is set up for Letter paper, landscape. ' +
          'If the print dialog shows portrait, switch Layout to Landscape. Names print unblurred even in privacy mode; tick “Hide names” to leave them out.</span></p>' +
      '</div>' +
      '<article class="sum-paper" aria-label="Course grade summary (print preview)"></article>';
    dom = { doc: el.querySelector('.sum-paper'), opts: el.querySelector('.sum-opts'), course: el.querySelector('.sum-course'), courseSep: el.querySelector('.sum-course-sep') };
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var key = t.getAttribute('data-pref');
      if (!key || !util.hasOwn(DEFAULT_PREFS, key)) return;
      var patch = {};
      patch[key] = !!t.checked;
      setPrefs(patch);
    });
    el.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-act="print"]') : null;
      if (!b) return;
      stampGenerated();
      root.print();
    });
  }

  function syncOptions() {
    if (!dom || !dom.opts) return;
    var p = getPrefs();
    Array.prototype.forEach.call(dom.opts.querySelectorAll('input[data-pref]'), function (cb) {
      var v = !!p[cb.getAttribute('data-pref')];
      if (cb.checked !== v) cb.checked = v;
    });
  }

  /** Page header subtitle: "SE 4351 · Requirements Engineering · Fall 2026 · …" (the pattern of every tab). */
  function syncCourseLine(course) {
    if (!dom || !dom.course) return;
    var t = courseLine(course);
    if (dom.course.textContent !== t) dom.course.textContent = t;
    dom.courseSep.hidden = !t;
  }

  function stampGenerated() {
    if (!dom || !dom.doc) return;
    var t = dom.doc.querySelector('.sum-generated');
    if (!t) return;
    t.textContent = nowText();
    t.setAttribute('datetime', new Date().toISOString());
  }

  function isActiveView() {
    return !!(boundEl && document.body.contains(boundEl) && GT.store && GT.store.state && GT.store.state.ui.activeView === 'summary');
  }

  /** Printing from the Summary tab (Print button or Ctrl+P): fresh "Generated" time, and a document title that
   * names the course and date, which browsers use as the default PDF file name. Restored after printing. */
  function bindPrintOnce() {
    if (printBound) return;
    printBound = true;
    root.addEventListener('beforeprint', function () {
      if (!isActiveView()) return;
      stampGenerated();
      var c = GT.store.course();
      if (savedTitle === null) savedTitle = document.title;
      document.title = (c ? (ui.slug ? ui.slug(c.code) : String(c.code || 'course')) + ' grade summary ' : 'Grade summary ') + localIsoDate();
    });
    root.addEventListener('afterprint', restoreTitle);
  }
  function restoreTitle() {
    if (savedTitle !== null) { document.title = savedTitle; savedTitle = null; }
  }

  // ------------------------------------------------------------------ view

  function render(el, ctx) {
    if (el !== boundEl) {
      boundEl = el;
      buildShell(el);
      lastHtml = null;
      dirty = true;
    }
    bindPrintOnce();
    syncOptions();
    var course = ctx.course || null;
    syncCourseLine(course);
    var cid = course ? course.id : null;
    if (!dirty && !ctx.switched && cid === lastCourseId && lastHtml !== null) return;
    dirty = false;
    lastCourseId = cid;
    var html;
    try {
      html = docHtml(course, ctx.results, getPrefs());
    } catch (e) {
      logErr(e);
      html = '<div class="callout callout-danger"><strong>The summary could not be built.</strong> ' + esc(e && e.message) +
        '<br>Your data is safe. Try another tab or reload the page.</div>';
    }
    if (html !== lastHtml) {
      dom.doc.innerHTML = html;
      lastHtml = html;
      stampGenerated();
    }
  }

  function destroy() {
    restoreTitle();
  }

  GT.views.summary = {
    id: 'summary',
    title: 'Summary',
    render: render,
    destroy: destroy,
    /** The options in effect (ui.summaryPrefs with defaults). */
    prefs: getPrefs,
    /** The local statistics helper (used when GT.stats is not complete), exposed for tests. */
    localDescribe: localDescribe
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
