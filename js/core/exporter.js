/* Grade Tracker - export (E1-E3): column catalog, presets, the sheet model with real Excel formulas,
 * the .xlsx workbook (through ExcelJS, passed in by the caller), CSV, and the pre-export data check.
 * See docs/DESIGN.md section 8. Pure apart from toWorkbook, which only uses the ExcelJS object it is
 * given; this module never loads ExcelJS itself. Runs in the browser (GT.exporter) and in Node.
 *
 * Formula parity (E3): the formulas reproduce calc.js exactly, including totals that sit exactly on
 * a cutoff. Weighted = MAX(0,R-P)/M*W (late) or R/M*W; Total = ROUND(<sum>+<curve>,10) (the 10 decimals
 * mirror util.fix), then ROUND(…,0) for whole numbers, or ROUND(ROUND((<sum>+<curve>)*100,8),0)/100 for
 * 0.01 (see totalExpr); the suggested letter is a nested IF over the scale, highest cutoff first,
 * with the lowest letter as the else branch. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;
  var model = isNode ? require('./model.js') : root.GT.model;
  var calc = isNode ? require('./calc.js') : root.GT.calc;
  // Loaded after this file in some pages: resolved when first needed, not at load time.
  var nodeDeps = isNode ? {
    csv: require('./csv.js'),
    attendance: require('./attendance.js'),
    history: require('./history.js')
  } : null;
  function dep(name) {
    var m = isNode ? nodeDeps[name] : (root.GT && root.GT[name]);
    if (!m) throw new Error('Grade Tracker module "' + name + '" is not loaded.');
    return m;
  }
  function optDep(name) {
    return isNode ? nodeDeps[name] : (root.GT && root.GT[name]) || null;
  }

  var fix = util.fix;

  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var HEADER_FILL = 'FFBFBFBF';
  /** Header and body tint of each assessment's columns, in assessment order (like the old sheet). */
  var TINTS = ['FFE2EFDA', 'FFFCE4D6', 'FFDDEBF7', 'FFF8DCEF', 'FFE9E1F5'];
  var TINT_OTHER = 'FFEDEDED';
  var WITHDRAWN_FONT = 'FF808080';
  var INVALID_FONT = 'FFC00000';
  var BORDER_COLOR = 'FFA6A6A6';
  var IDENTITY_KEYS = ['no', 'lastName', 'firstName', 'team'];
  var NAME_KEYS = ['lastName', 'firstName'];
  var ATTENDANCE_KEYS = ['excused', 'unexcused', 'absences', 'absenceRate', 'unexcusedRate'];
  var ATTENDANCE_OFF = 'Attendance is off for this course';
  var PLACEHOLDER_LINE = 'PLACEHOLDER: not confirmed by the instructor';
  // Notes of the static Letter Grade cells (DESIGN 8.2). The importer reads them back (DESIGN 9.1): a
  // cell whose letter no longer matches its "Suggestion from the cutoffs: <letter>" note was changed in
  // the spreadsheet after the export, so it holds a letter the instructor chose.
  var MANUAL_LETTER_NOTE = 'Final letter assigned by the instructor';
  var SUGGESTED_LETTER_NOTE = 'Suggestion from the cutoffs: ';
  // A withdrawn student without a final letter gets "W" in Letter Grade (a static value, never the
  // cutoff formula), as on the Summary tab. The importer reads such a cell as "no letter".
  var WITHDRAWN_LETTER = 'W';
  var WITHDRAWN_LETTER_NOTE = 'Withdrawn: no letter grade';
  var ROUNDING_LABELS = { none: 'none', hundredth: 'nearest 0.01', integer: 'nearest whole number' };
  var MIN_WIDTH = 5, MAX_WIDTH = 40, NAME_MIN_WIDTH = 14;
  /** Computed number columns shown with the course's display decimals (besides the weighted ones). */
  var COMPUTED_KEYS = ['total', 'percentile', 'diffAvg', 'absenceRate', 'unexcusedRate'];

  // ---------------------------------------------------------------- small helpers

  function assessmentsOf(course) {
    return course && Array.isArray(course.assessments) ? course.assessments : [];
  }

  function tintFor(index) {
    return index < TINTS.length ? TINTS[index] : TINT_OTHER;
  }

  /** A number as formula text: plain decimal notation, full precision (String round-trips a double). */
  function lit(x) {
    var n = typeof x === 'number' && isFinite(x) ? x : 0;
    if (n === 0) return '0';
    var s = String(n);
    if (/e/i.test(s)) {
      s = n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
      if (/e/i.test(s) || s === '' || s === '-0') s = String(n); // huge values: Excel reads 1E+21 too
    }
    return s;
  }

  /** A readable number for notes and labels: 12.5, 10, 0.5. */
  function num(x) {
    return typeof x === 'number' && isFinite(x) ? String(fix(x)) : '';
  }

  /** Excel string literal: quotes doubled. */
  function str(s) {
    return '"' + String(s).replace(/"/g, '""') + '"';
  }

  /** Column number (1-based) to letters: 1 -> A, 27 -> AA. */
  function colLetter(n) {
    var s = '';
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /** Joins formula terms with '+', writing a negative term as '-x' instead of '+-x'. */
  function joinTerms(terms) {
    var out = '';
    terms.forEach(function (t, i) {
      if (i === 0) out = t;
      else if (t.charAt(0) === '-') out += t;
      else out += '+' + t;
    });
    return out;
  }

  function sortedScale(course) {
    var s = course && course.settings && Array.isArray(course.settings.letterScale) ? course.settings.letterScale : [];
    return s.filter(function (x) {
      return util.isPlainObject(x) && typeof x.letter === 'string' && typeof x.min === 'number' && isFinite(x.min);
    }).slice().sort(function (a, b) { return b.min - a.min; });
  }

  /** "A+ ≥ 97, A ≥ 93, …, D- ≥ 60, F below 60" */
  function cutoffText(course) {
    var s = sortedScale(course);
    if (!s.length) return '';
    var parts = [];
    for (var i = 0; i < s.length - 1; i++) parts.push(s[i].letter + ' ≥ ' + num(s[i].min));
    var last = s[s.length - 1];
    parts.push(s.length > 1 ? last.letter + ' below ' + num(s[s.length - 2].min) : last.letter + ' for every total');
    return parts.join(', ');
  }

  function roundingOf(course) {
    var r = course && course.settings ? course.settings.rounding : 'none';
    return r === 'hundredth' || r === 'integer' ? r : 'none';
  }

  function curveOf(course) {
    var c = course && course.settings ? course.settings.curve : 0;
    return typeof c === 'number' && isFinite(c) ? c : 0;
  }

  function latePerWeek(course) {
    var p = course && course.settings ? course.settings.latePointsPerWeek : 10;
    return typeof p === 'number' && isFinite(p) ? p : 10;
  }

  function attendanceMode(course) {
    var att = course && util.isPlainObject(course.attendance) ? course.attendance : null;
    var m = att ? att.mode : 'off';
    return m === 'per-session' || m === 'totals' ? m : 'off';
  }

  function hasAnyFinalLetter(course) {
    return (course.students || []).some(function (s) { return model.finalLetterOf(s) !== null; });
  }

  function letterScaleUnconfirmed(course) {
    return !model.isConfirmed(course, 'letterScale');
  }

  function localDate(iso) {
    var d = new Date(iso);
    if (typeof iso !== 'string' || isNaN(d.getTime())) return String(iso || '');
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** "2026-12-15 19:00 (local time, UTC-06:00)": the export time as the instructor's clock shows it
   * (the file name uses the same local time). */
  function localDateTime(iso) {
    var d = new Date(iso);
    if (typeof iso !== 'string' || isNaN(d.getTime())) return String(iso || '');
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var off = -d.getTimezoneOffset();
    var abs = Math.abs(off);
    return localDate(iso) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) +
      ' (local time, UTC' + (off < 0 ? '-' : '+') + p(Math.floor(abs / 60)) + ':' + p(abs % 60) + ')';
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /** Excel display format for computed numbers, from the course's display decimals: '0.00' for 2. The
   * stored values keep full precision, so formulas and totals are unchanged. */
  function numberFormat(decimals) {
    var d = typeof decimals === 'number' && isFinite(decimals) ? Math.max(0, Math.min(6, Math.round(decimals))) : 2;
    return d > 0 ? '0.' + new Array(d + 1).join('0') : '0';
  }

  /** The late penalty P in points (DESIGN 8.3, calc.latePenalty) of an item: also for an empty or
   * invalid score, which counts 0 anyway, so that a score typed into the file later loses it too, as
   * it does in the app (the entry keeps its weeks late). */
  function penaltyOf(d, a, course) {
    return calc.latePenalty({ weeksLate: d.weeksLate, waived: d.waived }, a, course.settings);
  }

  // ---------------------------------------------------------------- column catalog

  /** Every exportable column of the course, in catalog order:
   * [{ key, label, group, available, reason?, assessmentId? }]. Groups: 'student', 'raw', 'weighted',
   * 'late', 'result', 'letter', 'attendance'. Attendance columns are unavailable while the mode is off. */
  function columnsFor(course) {
    var out = [];
    function add(key, label, group, extra) {
      var c = { key: key, label: label, group: group, available: true };
      if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
      out.push(c);
    }
    add('no', 'No', 'student');
    add('lastName', 'Last Name', 'student');
    add('firstName', 'First Name', 'student');
    add('team', 'Team', 'student');
    var list = assessmentsOf(course);
    list.forEach(function (a) { add('raw:' + a.id, a.name, 'raw', { assessmentId: a.id }); });
    list.forEach(function (a) { add('weighted:' + a.id, a.name + ' ' + num(a.weight || 0) + '%', 'weighted', { assessmentId: a.id }); });
    list.forEach(function (a) { add('late:' + a.id, a.name + ': weeks late', 'late', { assessmentId: a.id }); });
    add('total', 'Total', 'result');
    add('letter', 'Letter Grade', 'letter');
    add('suggestedLetter', 'Suggested Letter (cutoffs)', 'letter');
    add('finalLetter', 'Final Letter', 'letter');
    add('rank', 'Rank', 'result');
    add('percentile', 'Percentile', 'result');
    add('diffAvg', 'Diff. from average', 'result');
    add('incomplete', 'Missing scores', 'result');
    var off = attendanceMode(course) === 'off';
    var att = function (key, label) {
      add(key, label, 'attendance', off ? { available: false, reason: ATTENDANCE_OFF } : null);
    };
    att('excused', 'Excused (allowed)');
    att('unexcused', 'Unexcused (not allowed)');
    att('absences', 'Total absences');
    att('absenceRate', 'Absence rate %');
    att('unexcusedRate', 'Unexcused rate %');
    add('status', 'Status', 'student');
    add('notes', 'Notes', 'student');
    return out;
  }

  /** Whether any student's effective entry of the item (own, team or override) is late, waived or not. */
  function hasLateWork(course, a) {
    return (Array.isArray(course.students) ? course.students : []).some(function (s) {
      var e = calc.resolveEntry(course, s, a).entry;
      return !!(e && typeof e.weeksLate === 'number' && e.weeksLate > 0);
    });
  }

  /** Built-in presets. The default mirrors the previous TA's sheet (E2) plus Status, and adds the
   * "<name>: weeks late" column of each item with late work: without it the file's raw scores would
   * not give its totals back (an import would lose the penalty). */
  function builtInPresets(course) {
    var list = assessmentsOf(course);
    var raw = list.map(function (a) { return 'raw:' + a.id; });
    var weighted = list.map(function (a) { return 'weighted:' + a.id; });
    var late = list.filter(function (a) { return hasLateWork(course, a); }).map(function (a) { return 'late:' + a.id; });
    var all = columnsFor(course).filter(function (c) { return c.available; }).map(function (c) { return c.key; });
    return [
      {
        id: 'builtin:previous',
        name: 'Previous sheet layout (default)',
        builtIn: true,
        columns: ['no', 'lastName', 'firstName'].concat(raw, weighted, late, ['total', 'letter', 'excused', 'unexcused', 'absences', 'status'])
      },
      { id: 'builtin:compact', name: 'Names, total and letter', builtIn: true, columns: ['no', 'lastName', 'firstName', 'team', 'total', 'letter', 'status'] },
      { id: 'builtin:everything', name: 'Everything', builtIn: true, columns: all }
    ];
  }

  /** Built-in presets followed by the course's own (course.exportPresets, well-formed ones only). */
  function allPresets(course) {
    var user = (course && Array.isArray(course.exportPresets) ? course.exportPresets : []).filter(function (p) {
      return util.isPlainObject(p) && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.columns);
    }).map(function (p) {
      return { id: p.id, name: p.name, builtIn: false, columns: p.columns.filter(function (k) { return typeof k === 'string'; }) };
    });
    return builtInPresets(course).concat(user);
  }

  /** A new user preset { id, name, columns } to push onto course.exportPresets inside
   * GT.store.transact(…, { historyMode: 'none' }). */
  function makePreset(name, columns) {
    return {
      id: util.uid('xp'),
      name: String(name === null || name === undefined ? '' : name).trim() || 'My preset',
      columns: (Array.isArray(columns) ? columns : []).filter(function (k) { return typeof k === 'string'; })
    };
  }

  /** Splits requested keys into the columns that will be exported and the ones skipped:
   * { columns: [catalog entry], skipped: [{ key, label, reason }] }. Unknown keys (for example an
   * assessment deleted since the preset was saved) are skipped silently (reason 'unknown'); unavailable
   * ones carry their reason; a repeated key is exported once. */
  function resolveColumns(course, columnKeys) {
    var catalog = columnsFor(course);
    var byKey = Object.create(null);
    catalog.forEach(function (c) { byKey[c.key] = c; });
    var seen = Object.create(null);
    var columns = [], skipped = [];
    (Array.isArray(columnKeys) ? columnKeys : []).forEach(function (k) {
      if (typeof k !== 'string' || seen[k]) return;
      seen[k] = true;
      var c = byKey[k];
      if (!c) { skipped.push({ key: k, label: k, reason: 'unknown' }); return; }
      if (!c.available) { skipped.push({ key: k, label: c.label, reason: c.reason || 'Not available' }); return; }
      columns.push(c);
    });
    return { columns: columns, skipped: skipped };
  }

  // ---------------------------------------------------------------- sheet model

  function statusLabel(s) {
    return s.status === 'withdrawn' ? 'Withdrawn' : 'Active';
  }

  function scoreNotes(d, a, course) {
    var notes = [];
    if (d.state === 'invalid') notes.push('Entered text "' + d.text + '" is not a number, so it counts as 0');
    if (d.override) {
      var team = d.teamId ? model.getEntry(course.teamScores, d.teamId, a.id) : null;
      var tv = team ? (typeof team.value === 'number' ? num(team.value) : (team.text ? team.text : 'empty')) : 'empty';
      notes.push('Per-member override (team score ' + tv + '). An unequal split needs the team\'s written agreement.');
    }
    if (d.weeksLate > 0) {
      if (d.waived) notes.push(plural(d.weeksLate, 'week') + ' late, penalty waived');
      else notes.push(plural(d.weeksLate, 'week') + ' late, −' + num(penaltyOf(d, a, course)) + ' points');
    }
    if (d.outOfRange) notes.push('Outside 0–' + num(a.maxScore) + '; counted as entered');
    if (d.notOnList) notes.push('Not one of the list values (' + model.describeChoices(a) + '); counted as entered');
    return notes;
  }

  function cellStyle(d) {
    if (d.state === 'invalid' || d.outOfRange) return 'invalid';
    if (d.override) return 'override';
    return null;
  }

  /** The nested IF that turns the total in `ref` into the suggested letter (calc.letterFor). */
  function letterFormula(course, ref) {
    var s = sortedScale(course);
    if (!s.length) return str('');
    var f = str(s[s.length - 1].letter);
    for (var i = s.length - 2; i >= 0; i--) {
      f = 'IF(' + ref + '>=' + lit(fix(s[i].min)) + ',' + str(s[i].letter) + ',' + f + ')';
    }
    return f;
  }

  /** Raw expression of one assessment: MAX(0,R-P)/M*W with a penalty, else R/M*W. */
  function weightedExpr(ref, d, a, course) {
    var pen = penaltyOf(d, a, course);
    var inner = pen > 0 ? 'MAX(0,' + ref + '-' + lit(pen) + ')' : ref;
    return inner + '/' + lit(a.maxScore) + '*' + lit(a.weight || 0);
  }

  /** The Total formula around `inner` (the sum plus the curve) for the rounding mode:
   * - none:      ROUND(inner,10)                     (10 decimals = util.FIX_DECIMALS, like util.fix)
   * - integer:   ROUND(ROUND(inner,10),0)            (a half is exact in binary: every app rounds it up)
   * - hundredth: ROUND(ROUND((inner)*100,8),0)/100   (= ROUND(ROUND(inner,10),2); scaling first makes a
   *   half cent exactly k + 0.5, so apps whose ROUND works on the binary value, such as HyperFormula,
   *   round 79.725 to 79.73 like Excel, LibreOffice and the app instead of 79.72) */
  function totalExpr(inner, mode) {
    if (mode === 'hundredth') {
      var scaled = /^SUM\([^()]*\)$/.test(inner) || /^[A-Z]+\d+$/.test(inner) ? inner : '(' + inner + ')';
      return 'ROUND(ROUND(' + scaled + '*100,8),0)/100';
    }
    if (mode === 'integer') return 'ROUND(ROUND(' + inner + ',10),0)';
    return 'ROUND(' + inner + ',10)';
  }

  function headerNote(col, course, a, ctx) {
    var ppw = latePerWeek(course);
    var placeholder = letterScaleUnconfirmed(course) ? '\n' + PLACEHOLDER_LINE : '';
    switch (col.group) {
      case 'raw':
        return 'Out of ' + num(a.maxScore) + '.' +
          (a.teamGraded ? ' Team-graded: every member gets the team score unless a per-member override is marked.' : '') +
          (model.hasChoices(a) ? ' Chosen from a list (' + model.describeChoices(a) + ').' : '') +
          ' An empty cell counts as 0.';
      case 'weighted':
        return '= raw ÷ max × weight (' + a.name + ' ÷ ' + num(a.maxScore) + ' × ' + num(a.weight || 0) + ').' +
          (ppw > 0 ? ' Late work: ' + num(ppw) + ' points per week late (on a 100-point scale) come off the raw score first, never below 0.' : '');
      case 'late':
        return 'Weeks late. Each week costs ' + num(ppw) + ' points on a 100-point scale (scaled to the max score), unless the penalty was waived. ' +
          'Write the weeks as a whole number, "2 (waived)" for pre-approved late work, and leave the cell empty when on time.';
      default:
        break;
    }
    switch (col.key) {
      case 'total':
        return '= sum of weighted + curve (' + num(curveOf(course)) + '), rounding: ' + ROUNDING_LABELS[roundingOf(course)] + '. ' +
          (ctx.staticItems.length
            ? ctx.staticItems.join(', ') + (ctx.staticItems.length === 1 ? ' is' : ' are') + ' not in this file, so ' +
              (ctx.staticItems.length === 1 ? 'its weighted points are' : 'their weighted points are') + ' written into the formula as fixed numbers (listed in each cell\'s note). '
            : '') +
          (roundingOf(course) === 'hundredth'
            ? 'Written as ROUND(ROUND(total×100,8),0)/100, the same as ROUND(total,2), so every spreadsheet app rounds a half cent up like the app does.'
            : 'The ROUND(…,10) mirrors the app\'s arithmetic, so a total exactly on a cutoff gets the same letter.');
      case 'letter':
        return (ctx.staticLetters
          ? 'Final letters assigned by the instructor. Students without one show the suggestion from the cutoffs: '
          : 'Letter from the cutoffs: ') + cutoffText(course) + '.' +
          (ctx.withdrawnW ? ' W: withdrawn, no letter grade.' : '') + placeholder;
      case 'suggestedLetter':
        return 'Suggestion from the cutoffs (the instructor assigns the final letter): ' + cutoffText(course) + '.' + placeholder;
      case 'finalLetter':
        return 'Assigned by hand by the instructor. Empty: not assigned yet.';
      case 'rank':
        return 'Among active students by total (1 = highest; ties share a rank). Withdrawn students have no rank.';
      case 'percentile':
        return 'Percent of the other active students with a lower total.';
      case 'diffAvg':
        return 'Total minus the class average of active students (' + num(ctx.average) + ').';
      case 'incomplete':
        return 'Weighted items without a score (each counts as 0).';
      case 'status':
        return 'Withdrawn students are kept, but left out of rank, percentile and the class average.';
      case 'excused':
        return 'Excused absences: allowed, approved by the instructor.';
      case 'unexcused':
        return 'Unexcused absences: not allowed.';
      case 'absences':
        return 'Excused + unexcused.';
      case 'absenceRate':
        return 'Total absences ÷ recorded sessions × 100.';
      case 'unexcusedRate':
        return 'Unexcused absences ÷ recorded sessions × 100.';
      default:
        return null;
    }
  }

  function displayLength(v, decimals) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return util.formatNumber(v, decimals).length;
    return String(v).split('\n').reduce(function (m, line) { return Math.max(m, line.length); }, 0);
  }

  /** The export as plain data (pure): { columns: [{ key, label, width, group, tint, note, numFmt }],
   * rows: [[cell]], rowMeta: [{ studentId, withdrawn }], skipped, notes }.
   * A cell is { v, f?, note?, style?: 'withdrawn'|'invalid'|'override', exact? }: v is the value
   * (numbers stay numbers, empty = null), f an Excel formula without '=' in A1 notation (row 1 is
   * the header), `exact` the full-precision number written to the .xlsx for a static weighted cell
   * (v is the rounded display value). opts: { sort: 'name' (default) | 'no' }. */
  function buildSheet(course, results, columnKeys, opts) {
    var o = opts || {};
    var res = results && results.byId ? results : calc.computeCourse(course);
    var resolved = resolveColumns(course, columnKeys);
    var cols = resolved.columns;
    var list = assessmentsOf(course);
    var aIndex = Object.create(null);
    list.forEach(function (a, i) { aIndex[a.id] = i; });
    var colIndex = Object.create(null); // key -> 1-based column number
    cols.forEach(function (c, i) { colIndex[c.key] = i + 1; });
    var mode = roundingOf(course);
    var curve = curveOf(course);
    var staticLetters = hasAnyFinalLetter(course);
    var attendance = optDep('attendance');
    var decimals = course.settings && typeof course.settings.decimals === 'number' ? course.settings.decimals : 2;
    var weightedNeeded = list.filter(function (a) { return (a.weight || 0) !== 0; });

    // SUM(range) when the weighted column of every item with a weight is exported and the columns
    // from the first to the last of them are all weighted columns. A weighted cell without its raw
    // column is a static value; in the .xlsx it holds the full-precision number, so the sum matches.
    var sumRange = null;
    if (weightedNeeded.length && weightedNeeded.every(function (a) { return colIndex['weighted:' + a.id]; })) {
      var idx = weightedNeeded.map(function (a) { return colIndex['weighted:' + a.id]; });
      var lo = Math.min.apply(null, idx), hi = Math.max.apply(null, idx);
      var contiguous = true;
      for (var k = lo; k <= hi; k++) {
        if (cols[k - 1].group !== 'weighted') { contiguous = false; break; }
      }
      if (contiguous) sumRange = { lo: lo, hi: hi };
    }

    // Items whose weighted points go into the Total as fixed numbers (neither column exported).
    var staticList = sumRange ? [] : weightedNeeded.filter(function (a) { return !colIndex['weighted:' + a.id] && !colIndex['raw:' + a.id]; });
    var ctx = {
      staticLetters: staticLetters, average: res.average, staticItems: staticList.map(function (a) { return a.name; }),
      withdrawnW: (course.students || []).some(function (s) { return s.status === 'withdrawn' && model.finalLetterOf(s) === null; })
    };
    var sortKey = o.sort === 'no' ? 'no' : 'name';
    var students = calc.sortStudents(course, res, sortKey, 'asc');
    var rows = [], rowMeta = [];

    students.forEach(function (s, i) {
      var r = res.byId[s.id] || calc.studentResult(course, s);
      var rowNo = i + 2;
      var withdrawn = s.status === 'withdrawn';
      var sm = attendance && attendanceMode(course) !== 'off' ? attendance.summary(course, s.id) : null;
      var ref = function (key) { return colLetter(colIndex[key]) + rowNo; };

      var totalFormula = (function () {
        var sum;
        if (sumRange) {
          sum = 'SUM(' + colLetter(sumRange.lo) + rowNo + ':' + colLetter(sumRange.hi) + rowNo + ')';
        } else {
          var terms = weightedNeeded.map(function (a) {
            var d = r.items[a.id];
            if (colIndex['weighted:' + a.id]) return ref('weighted:' + a.id);
            if (colIndex['raw:' + a.id]) return weightedExpr(ref('raw:' + a.id), d, a, course);
            return lit(d.weightedUnrounded); // full precision, like the app's sum
          });
          sum = terms.length ? joinTerms(terms) : '0';
        }
        var inner = curve !== 0 ? joinTerms([sum, lit(curve)]) : sum;
        return totalExpr(inner, mode);
      })();

      var row = cols.map(function (c) {
        var cell = { v: null };
        var a = c.assessmentId !== undefined ? list[aIndex[c.assessmentId]] : null;
        var d = a ? r.items[a.id] : null;
        switch (c.group) {
          case 'raw':
            cell.v = d.state === 'number' ? d.raw : null;
            var rn = scoreNotes(d, a, course);
            if (rn.length) cell.note = rn.join('\n');
            cell.style = cellStyle(d);
            break;
          case 'weighted':
            if (colIndex['raw:' + a.id]) {
              cell.f = weightedExpr(ref('raw:' + a.id), d, a, course);
              cell.v = d.weighted;
            } else {
              cell.v = d.weighted;
              if (d.weightedUnrounded !== d.weighted) cell.exact = d.weightedUnrounded;
              var wn = scoreNotes(d, a, course);
              if (wn.length) cell.note = wn.join('\n');
              cell.style = cellStyle(d);
            }
            break;
          case 'late':
            if (d.weeksLate > 0) {
              cell.v = d.waived ? d.weeksLate + ' (waived)' : d.weeksLate;
              cell.note = d.waived ? 'Penalty waived' : '−' + num(penaltyOf(d, a, course)) + ' points';
            }
            break;
          default:
            fillOther(cell, c.key);
        }
        if (!cell.style) delete cell.style;
        if (withdrawn && !cell.style) cell.style = 'withdrawn';
        return cell;
      });

      function fillOther(cell, key) {
        switch (key) {
          case 'no': cell.v = typeof s.no === 'number' ? s.no : null; break;
          case 'lastName': cell.v = s.lastName || ''; break;
          case 'firstName': cell.v = s.firstName || ''; break;
          case 'team':
            var t = s.teamId ? model.findTeam(course, s.teamId) : null;
            cell.v = t ? t.name : '';
            break;
          case 'status': cell.v = statusLabel(s); break;
          case 'notes': cell.v = s.notes || ''; break;
          case 'total':
            cell.f = totalFormula;
            cell.v = r.total;
            if (staticList.length) {
              cell.note = 'Fixed numbers in this formula: ' + staticList.map(function (a) { return a.name + ' ' + num(r.items[a.id].weighted); }).join(', ') +
                (curve !== 0 ? '; curve ' + (curve > 0 ? '+' : '') + num(curve) : '') + '.';
            }
            break;
          case 'letter':
            if (withdrawn && r.finalLetter === null) {
              cell.v = WITHDRAWN_LETTER;
              cell.note = WITHDRAWN_LETTER_NOTE;
              break;
            }
            if (staticLetters || !colIndex.total) {
              cell.v = staticLetters ? r.effectiveLetter : r.letter;
              if (staticLetters && r.letterSource === 'manual') {
                cell.note = MANUAL_LETTER_NOTE + (r.finalLetterValid ? '' : ' (not a letter of the current scale)');
              } else if (cell.v) {
                cell.note = SUGGESTED_LETTER_NOTE + cell.v + '\nNo final letter assigned yet.';
              }
            } else {
              cell.f = letterFormula(course, ref('total'));
              cell.v = r.letter;
            }
            break;
          case 'suggestedLetter':
            if (colIndex.total) {
              cell.f = letterFormula(course, ref('total'));
              cell.v = r.letter;
            } else cell.v = r.letter;
            break;
          case 'finalLetter':
            cell.v = r.finalLetter !== null ? r.finalLetter : '';
            if (r.finalLetter !== null && !r.finalLetterValid) cell.note = 'Not a letter of the current scale';
            break;
          case 'rank': cell.v = withdrawn ? null : r.rank; break;
          case 'percentile': cell.v = withdrawn ? null : r.percentile; break;
          case 'diffAvg': cell.v = withdrawn ? null : r.diffFromAverage; break;
          case 'incomplete': cell.v = r.missingCount; break;
          case 'excused': cell.v = sm ? sm.excused : null; break;
          case 'unexcused': cell.v = sm ? sm.unexcused : null; break;
          case 'absences': cell.v = sm ? sm.totalAbsences : null; break;
          case 'absenceRate': cell.v = sm ? sm.absenceRate : null; break;
          case 'unexcusedRate': cell.v = sm ? sm.unexcusedRate : null; break;
          default: break;
        }
      }

      rows.push(row);
      rowMeta.push({ studentId: s.id, withdrawn: withdrawn });
    });

    var columns = cols.map(function (c, ci) {
      var a = c.assessmentId !== undefined ? list[aIndex[c.assessmentId]] : null;
      var longest = c.label.length;
      rows.forEach(function (row) { longest = Math.max(longest, displayLength(row[ci].v, decimals)); });
      var width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, longest + 2));
      if (NAME_KEYS.indexOf(c.key) !== -1) width = Math.max(width, NAME_MIN_WIDTH);
      var tinted = a && (c.group === 'raw' || c.group === 'weighted' || c.group === 'late');
      return {
        key: c.key,
        label: c.label,
        width: width,
        group: c.group,
        tint: tinted ? tintFor(aIndex[a.id]) : null,
        note: headerNote(c, course, a, ctx),
        numFmt: c.group === 'weighted' || COMPUTED_KEYS.indexOf(c.key) !== -1
          ? (c.key === 'total' && mode === 'integer' ? '0' : numberFormat(decimals)) : null
      };
    });

    var notes = [];
    var unavailable = resolved.skipped.filter(function (x) { return x.reason !== 'unknown'; });
    if (unavailable.length) {
      var reasons = Object.create(null), order = [];
      unavailable.forEach(function (x) {
        if (!reasons[x.reason]) { reasons[x.reason] = []; order.push(x.reason); }
        reasons[x.reason].push(x.label);
      });
      order.forEach(function (why) { notes.push('Skipped (' + why + '): ' + reasons[why].join(', ') + '.'); });
    }
    if (staticLetters && colIndex.letter) {
      notes.push('Letter Grade holds the final letters (static values); students without one show the suggestion.');
    }
    return { columns: columns, rows: rows, rowMeta: rowMeta, skipped: resolved.skipped, notes: notes };
  }

  // ---------------------------------------------------------------- CSV

  /** The same columns as values only (no formulas): UTF-8 BOM, CRLF, formula guard. opts as buildSheet. */
  function toCsv(course, results, columnKeys, opts) {
    var sheet = buildSheet(course, results, columnKeys, opts);
    var out = [sheet.columns.map(function (c) { return c.label; })];
    sheet.rows.forEach(function (row) {
      out.push(row.map(function (cell) { return cell.v === null || cell.v === undefined ? '' : cell.v; }));
    });
    return dep('csv').stringify(out, { bom: true, eol: '\r\n', guardFormulas: true });
  }

  // ---------------------------------------------------------------- workbook (ExcelJS)

  function thinBorder() {
    var side = { style: 'thin', color: { argb: BORDER_COLOR } };
    return { top: side, left: side, bottom: side, right: side };
  }

  function fillOf(argb) {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb } };
  }

  function styleHeaderRow(row, count, fills) {
    for (var i = 1; i <= count; i++) {
      var cell = row.getCell(i);
      cell.font = { bold: true };
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
      cell.fill = fillOf(fills ? (fills[i - 1] || HEADER_FILL) : HEADER_FILL);
      cell.border = thinBorder();
    }
  }

  function headerHeight(columns) {
    var lines = 1;
    columns.forEach(function (c) {
      var per = Math.max(1, Math.floor((c.width || 10) - 1));
      lines = Math.max(lines, Math.ceil(c.label.length / per));
    });
    return 15 * Math.min(lines, 4) + 3;
  }

  function writeGrades(ws, sheet) {
    var n = sheet.columns.length;
    sheet.columns.forEach(function (c, i) { ws.getColumn(i + 1).width = c.width; });
    var header = ws.getRow(1);
    sheet.columns.forEach(function (c, i) {
      var cell = header.getCell(i + 1);
      cell.value = c.label;
      if (c.note) cell.note = c.note;
    });
    styleHeaderRow(header, n, sheet.columns.map(function (c) { return c.tint; }));
    header.height = headerHeight(sheet.columns);
    sheet.rows.forEach(function (row, ri) {
      var xr = ws.getRow(ri + 2);
      var withdrawn = sheet.rowMeta[ri] && sheet.rowMeta[ri].withdrawn;
      row.forEach(function (cell, ci) {
        var xc = xr.getCell(ci + 1);
        var col = sheet.columns[ci];
        if (cell.f) xc.value = { formula: cell.f, result: cell.v === null ? undefined : cell.v };
        else if (typeof cell.exact === 'number') xc.value = cell.exact;
        else xc.value = cell.v === undefined ? null : cell.v;
        if (cell.note) xc.note = cell.note;
        if (col.numFmt) xc.numFmt = col.numFmt;
        xc.border = thinBorder();
        if (col.tint) xc.fill = fillOf(col.tint);
        var font = {};
        if (withdrawn) { font.color = { argb: WITHDRAWN_FONT }; font.italic = true; }
        if (cell.style === 'invalid') font.color = { argb: INVALID_FONT };
        if (cell.style === 'override') font.bold = true;
        if (Object.keys(font).length) xc.font = font;
        if (col.key === 'notes') xc.alignment = { wrapText: true, vertical: 'top' };
      });
    });
    var xSplit = 0;
    while (xSplit < sheet.columns.length && IDENTITY_KEYS.indexOf(sheet.columns[xSplit].key) !== -1) xSplit++;
    ws.views = [{ state: 'frozen', xSplit: xSplit, ySplit: 1 }];
    if (n > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: n } };
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
  }

  /** Rows [label, value] (or longer) of the Settings sheet. */
  function settingsRows(course, results, iso) {
    var res = results && results.byId ? results : calc.computeCourse(course);
    var rows = [];
    var st = course.settings || {};
    var active = res.activeIds ? res.activeIds.length : 0;
    var withdrawn = (course.students || []).length - active;
    rows.push({ section: 'Course' });
    rows.push(['Course', model.courseLabel(course)]);
    rows.push(['Term', course.term || '']);
    rows.push(['Level', course.level || '']);
    rows.push(['Exported', localDateTime(iso)]);
    rows.push(['Students', active + ' active' + (withdrawn ? ', ' + withdrawn + ' withdrawn (included, Status "Withdrawn")' : '')]);
    rows.push([]);
    rows.push({ section: 'Assessments', header: ['Assessment', 'Max score', 'Weight %', 'Team-graded', 'Drop-down list'] });
    assessmentsOf(course).forEach(function (a) {
      rows.push([a.name, a.maxScore, a.weight || 0, a.teamGraded ? 'yes' : 'no', model.hasChoices(a) ? model.describeChoices(a) : '']);
    });
    var ws = calc.weightStatus(course);
    rows.push(['Weights sum', ws.sum, ws.ok ? 'OK' : 'Not 100']);
    rows.push([]);
    rows.push({ section: 'Grading' });
    rows.push(['Rounding of the total', ROUNDING_LABELS[roundingOf(course)]]);
    rows.push(['Curve (points added to the total)', curveOf(course)]);
    rows.push(['Late work', num(latePerWeek(course)) + ' points per week late on a 100-point scale (scaled to the max score), unless waived; never below 0']);
    rows.push(['Passing letter (pass rate)', st.passingLetter || '']);
    var ls = res.letterSummary || { active: active, assigned: 0 };
    var wdNoLetter = (course.students || []).some(function (s) { return s.status === 'withdrawn' && model.finalLetterOf(s) === null; });
    rows.push(['Letter Grade column', (hasAnyFinalLetter(course)
      ? 'Final letters assigned by the instructor (' + ls.assigned + ' of ' + ls.active + ' active students); students without one show the suggestion from the cutoffs'
      : 'Suggestions from the cutoffs (no final letters assigned yet)') +
      (wdNoLetter ? '; W for a withdrawn student without a final letter (no letter grade)' : '')]);
    rows.push(['Scores finalized', model.isFinalized(course)
      ? 'Yes, on ' + localDate(course.finalized.at) + (course.finalized.note ? ' (' + course.finalized.note + ')' : '')
      : 'No']);
    rows.push(['Attendance', attendanceMode(course) === 'off' ? 'Off' : (attendanceMode(course) === 'totals' ? 'Totals only' : 'Per session')]);
    rows.push([]);
    rows.push({ section: 'Letter scale' + (letterScaleUnconfirmed(course) ? ' (' + PLACEHOLDER_LINE + ')' : ''), header: ['Letter', 'Minimum total'] });
    sortedScale(course).forEach(function (x) { rows.push([x.letter, x.min]); });
    rows.push([]);
    var ph = model.unconfirmedPlaceholders(course);
    rows.push({ section: 'Not confirmed by the instructor yet' });
    if (!ph.length) rows.push(['(none)', 'Every placeholder setting is confirmed']);
    ph.forEach(function (p) { rows.push([p.label, p.note]); });
    rows.push([]);
    rows.push(['Generated by Grade Tracker (offline). Formulas in the Grades sheet recalculate if you edit raw scores.']);
    return rows;
  }

  function writeSettings(ws, rows) {
    ws.getColumn(1).width = 34;
    ws.getColumn(2).width = 60;
    [3, 4, 5].forEach(function (c) { ws.getColumn(c).width = 16; });
    var r = 1;
    rows.forEach(function (x) {
      var row = ws.getRow(r);
      if (Array.isArray(x)) {
        x.forEach(function (v, i) { row.getCell(i + 1).value = v; });
        if (x.length > 1) row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
        row.getCell(1).alignment = { vertical: 'top' };
      } else if (x && x.section) {
        row.getCell(1).value = x.section;
        row.getCell(1).font = { bold: true, size: 12 };
        if (x.header) {
          r++;
          var hr = ws.getRow(r);
          x.header.forEach(function (h, i) { hr.getCell(i + 1).value = h; });
          styleHeaderRow(hr, x.header.length, null);
        }
      }
      r++;
    });
  }

  function writeHistory(ws, course) {
    var rows = dep('history').toRows(course.history || []);
    var widths = [20, 8, 12, 22, 10, 22, 14, 14, 40, 30, 20];
    widths.forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
    rows.forEach(function (row, ri) {
      var xr = ws.getRow(ri + 1);
      row.forEach(function (v, ci) { xr.getCell(ci + 1).value = v; });
    });
    if (rows.length) {
      styleHeaderRow(ws.getRow(1), rows[0].length, null);
      ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: rows[0].length } };
    }
  }

  /** Builds the .xlsx and resolves with an ArrayBuffer. ExcelJS is passed in (GT.ui.loadExcel() in
   * the browser, require('vendor/exceljs.min.js') in Node). opts: { sort, includeSettings = true,
   * includeHistory = false, now (ISO time of the export, default now) }. */
  function toWorkbook(ExcelJS, course, results, columnKeys, opts) {
    var o = opts || {};
    return Promise.resolve().then(function () {
      if (!ExcelJS || typeof ExcelJS.Workbook !== 'function') throw new Error('The Excel library (ExcelJS) is not available.');
      var res = results && results.byId ? results : calc.computeCourse(course);
      var iso = typeof o.now === 'string' && o.now ? o.now : util.nowIso();
      var sheet = buildSheet(course, res, columnKeys, o);
      var wb = new ExcelJS.Workbook();
      wb.creator = 'Grade Tracker';
      wb.lastModifiedBy = 'Grade Tracker';
      var when = new Date(iso);
      if (!isNaN(when.getTime())) { wb.created = when; wb.modified = when; }
      wb.calcProperties.fullCalcOnLoad = true;
      writeGrades(wb.addWorksheet('Grades'), sheet);
      if (o.includeSettings !== false) writeSettings(wb.addWorksheet('Settings'), settingsRows(course, res, iso));
      if (o.includeHistory === true) writeHistory(wb.addWorksheet('Change history'), course);
      return wb.xlsx.writeBuffer();
    }).then(function (buf) {
      if (buf instanceof ArrayBuffer) return buf;
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    });
  }

  // ---------------------------------------------------------------- data check

  /** Pre-export check (never blocks the download): { items: [{ level: 'warn'|'info', text }] }. */
  function dataCheck(course, results) {
    var res = results && results.byId ? results : calc.computeCourse(course);
    var items = [];
    var warn = function (t) { items.push({ level: 'warn', text: t }); };
    var info = function (t) { items.push({ level: 'info', text: t }); };
    var students = course.students || [];
    var active = students.filter(function (s) { return s.status !== 'withdrawn'; });
    var list = assessmentsOf(course);

    if (model.isFinalized(course)) info('Scores finalized on ' + localDate(course.finalized.at) + '.');
    else warn('Scores not finalized yet.');

    var ws = calc.weightStatus(course);
    if (!ws.ok) warn('The weights add up to ' + num(ws.sum) + '%, not 100%.');

    var letterPh = !model.isConfirmed(course, 'letterScale');
    if (letterPh) warn('The letter-grade cutoffs are placeholders, not confirmed by the instructor.');

    var invalid = 0, outOfRange = 0, notOnList = 0, overrides = 0;
    list.forEach(function (a) {
      var empty = 0;
      active.forEach(function (s) {
        var d = res.byId[s.id] ? res.byId[s.id].items[a.id] : null;
        if (!d) return;
        if (d.state === 'empty') empty++;
      });
      if (!empty || !((a.weight || 0) > 0)) return;
      if (a.category === 'participation') {
        warn(a.name + ' is still empty for ' + plural(empty, 'active student') + ' (counts as 0 until it is set).');
      } else {
        warn(a.name + ': ' + plural(empty, 'active student') + ' without a score (counts as 0).');
      }
    });
    students.forEach(function (s) {
      var r = res.byId[s.id];
      if (!r) return;
      invalid += r.invalidCount;
      outOfRange += r.outOfRangeCount;
      notOnList += r.notOnListCount;
      overrides += r.overrideCount;
    });
    if (invalid) warn(plural(invalid, 'entry', 'entries') + ' not a number (exported as empty; each counts as 0).');
    if (outOfRange) warn(plural(outOfRange, 'score') + ' outside 0 to the max score (counted as entered).');
    if (notOnList) info(plural(notOnList, 'score') + ' not one of the drop-down values (counted as entered).');

    var ls = res.letterSummary;
    if (ls && ls.active) {
      if (ls.unassigned === ls.active) info('No final letters assigned yet: Letter Grade holds the suggestions from the cutoffs.');
      else if (ls.unassigned) info(plural(ls.unassigned, 'active student') + ' without a final letter (their suggestion is exported).');
      if (ls.invalid) warn(plural(ls.invalid, 'final letter') + ' not in the current letter scale.');
    }
    // Review V4R2-3: a CSV has no notes, so a final letter equal to the suggestion reads back as a
    // suggestion (the importer cannot tell them apart); the .xlsx marks it, the Final Letter column keeps it.
    var sameAsSuggestion = students.filter(function (s) {
      var r = res.byId[s.id];
      return r && r.finalLetter !== null && r.finalLetter === r.letter;
    }).length;
    if (sameAsSuggestion) {
      var one = sameAsSuggestion === 1;
      info((one ? '1 final letter equals' : sameAsSuggestion + ' final letters equal') + ' the suggestion from the cutoffs. A CSV file cannot show that ' +
        (one ? 'it is' : 'they are') + ' final: imported back, ' + (one ? 'it stays a suggestion' : 'they stay suggestions') +
        '. The Excel file marks final letters, and the "Final Letter" column (in the "Everything" preset) keeps them in both formats.');
    }
    var oi = Array.isArray(res.orderIssues) ? res.orderIssues.length : 0;
    if (oi) warn(plural(oi, 'pair') + ' of final letters out of order (a lower total has a higher letter).');
    if (overrides) info(plural(overrides, 'per-member override') + ' on team-graded items (noted in the file).');
    var wd = students.length - active.length;
    if (wd) info(plural(wd, 'withdrawn student') + ' included, with Status "Withdrawn" and no rank.');
    var others = model.unconfirmedPlaceholders(course).filter(function (p) { return p.key !== 'letterScale'; });
    if (others.length) info('Not confirmed yet: ' + others.map(function (p) { return p.label; }).join(', ') + '.');
    if (!students.length) warn('This course has no students yet.');
    return { items: items };
  }

  var api = {
    XLSX_MIME: XLSX_MIME,
    MANUAL_LETTER_NOTE: MANUAL_LETTER_NOTE,
    SUGGESTED_LETTER_NOTE: SUGGESTED_LETTER_NOTE,
    WITHDRAWN_LETTER: WITHDRAWN_LETTER,
    WITHDRAWN_LETTER_NOTE: WITHDRAWN_LETTER_NOTE,
    TINTS: TINTS.slice(),
    TINT_OTHER: TINT_OTHER,
    HEADER_FILL: HEADER_FILL,
    ATTENDANCE_KEYS: ATTENDANCE_KEYS.slice(),
    ATTENDANCE_OFF: ATTENDANCE_OFF,
    columnsFor: columnsFor,
    builtInPresets: builtInPresets,
    allPresets: allPresets,
    makePreset: makePreset,
    resolveColumns: resolveColumns,
    buildSheet: buildSheet,
    letterFormula: letterFormula,
    colLetter: colLetter,
    settingsRows: settingsRows,
    toCsv: toCsv,
    toWorkbook: toWorkbook,
    dataCheck: dataCheck
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).exporter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
