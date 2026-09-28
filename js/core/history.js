/* Grade Tracker - change history (G5): turns "course before" and "course after" into HistoryEntry records.
 * See docs/DESIGN.md section 4. Pure; runs in the browser (GT.history) and in Node.
 *
 * HistoryEntry = { id, ts, source, kind, studentId, studentName, teamId, teamName, field, fieldKey,
 *                  oldValue, newValue, note }, plus userNote / userNoteAt once the TA annotates it.
 * - The "Final letters: n changed" summary also carries details: [{ studentId, studentName, no,
 *   oldValue, newValue }], every student it changed (read them with entryDetails / involvesStudent).
 * - Values are display strings ('' = empty). Scores show as entered ("88.5"), invalid text as
 *   '"abc" (not a number)', booleans as 'yes' / 'no'.
 * - Names are snapshots ('Last, First'), so the log stays readable after renames and deletions.
 * - fieldKey is a stable machine key for the field: 'score:<aid>' (score, override, override-removed,
 *   propagation), 'teamScore:<aid>', 'late:<aid>.weeksLate', 'late:<aid>.waived', 'student.<field>'
 *   (including 'student.finalLetter'), 'finalLetters' (summary of many final letters), 'student',
 *   'team:<tid>', 'team:<tid>.name', 'assessment:<aid>', 'assessment:<aid>.<field>' (including
 *   '.choices'), 'assessments.order', 'course.<field>' (including 'course.finalized'), 'settings.<field>',
 *   'settings.letterScale.<letter>', 'placeholder:<key>', 'attendance.<field>', 'attendance.session:<sesId>',
 *   'attendance.sessions', 'attendance:<sesId>', 'attendance.totals.absent', 'attendance.totals.excused',
 *   'attendance', 'bulk'.
 *
 * diffCourse() never throws: input is read defensively (missing maps, odd values), and each group of
 * the diff runs on its own, so one unexpected shape cannot lose the rest of the log. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;
  var model = isNode ? require('./model.js') : root.GT.model;
  var calc = isNode ? require('./calc.js') : root.GT.calc;

  /** A transaction that changes at most this many attendance marks gets one entry per mark. */
  var MARK_LIMIT = 5;
  /** A transaction that changes more sessions than this gets one summary entry for them. */
  var SESSION_LIMIT = 10;
  /** Dates listed in an attendance summary note before "…". */
  var SUMMARY_DATES = 10;
  /** A transaction that changes more final letters than this gets one summary entry for them. */
  var LETTER_LIMIT = 10;
  /** Student numbers listed in a final-letter summary note before "…". */
  var SUMMARY_STUDENTS = 10;
  /** Longest value kept in an entry (notes, invalid text). */
  var VALUE_MAX = 200;

  var OVERRIDE_NOTE = "Per-member override: an unequal split needs the team's written agreement";

  var KINDS = ['score', 'team-score', 'propagation', 'override', 'override-removed', 'late', 'final-letter',
    'status', 'team-membership', 'student', 'settings', 'attendance', 'bulk'];
  var SOURCES = ['edit', 'paste', 'undo', 'redo', 'import', 'restore', 'sample', 'roster', 'system'];

  var KIND_LABELS = {
    'score': 'Score', 'team-score': 'Team score', 'propagation': 'Propagation', 'override': 'Override',
    'override-removed': 'Override removed', 'late': 'Late work', 'final-letter': 'Final letter', 'status': 'Status',
    'team-membership': 'Team', 'student': 'Student', 'settings': 'Settings', 'attendance': 'Attendance',
    'bulk': 'Bulk change'
  };

  /** Kind groups used by the History view filter. */
  var KIND_GROUPS = {
    grades: ['score', 'team-score', 'propagation', 'override', 'override-removed', 'late', 'final-letter'],
    students: ['status', 'team-membership', 'student'],
    settings: ['settings'],
    attendance: ['attendance'],
    other: ['bulk']
  };

  function kindGroup(kind) {
    var keys = Object.keys(KIND_GROUPS);
    for (var i = 0; i < keys.length; i++) {
      if (KIND_GROUPS[keys[i]].indexOf(kind) !== -1) return keys[i];
    }
    return 'other';
  }

  // ------------------------------------------------------------------ defensive readers

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function objOf(x) { return isObj(x) ? x : {}; }
  /** Own property of a plain object (never an inherited one such as "constructor"). */
  function own(o, k) {
    return isObj(o) && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
  }
  function str(x) { return x === null || x === undefined ? '' : String(x); }
  function idOf(x) { return isObj(x) && typeof x.id === 'string' && x.id !== '' ? x.id : null; }

  function trunc(s, max) {
    var t = str(s);
    var m = max || VALUE_MAX;
    return t.length > m ? t.slice(0, m - 1) + '…' : t;
  }

  /** Display string for a primitive setting value. */
  function prim(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'string') return trunc(v);
    try { return trunc(JSON.stringify(v)); } catch (e) { return trunc(String(v)); }
  }
  function yesNo(v) { return v ? 'yes' : 'no'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function capitalize(s) { var t = str(s); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }

  /** Plain objects with a string id, first occurrence of each id only. */
  function listWithIds(x) {
    var seen = new Set();
    return arr(x).filter(function (o) {
      var id = idOf(o);
      if (id === null || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function indexById(list) {
    var m = new Map();
    list.forEach(function (o) { m.set(o.id, o); });
    return m;
  }

  /** A read-only, well-shaped view of a (possibly partial) course object. */
  function view(course) {
    var raw = isObj(course) ? course : {};
    var v = {
      raw: raw,
      assessments: listWithIds(raw.assessments),
      teams: listWithIds(raw.teams),
      students: listWithIds(raw.students),
      scores: objOf(raw.scores),
      teamScores: objOf(raw.teamScores),
      settings: objOf(raw.settings),
      attendance: objOf(raw.attendance),
      placeholders: objOf(raw.placeholders)
    };
    v.aById = indexById(v.assessments);
    v.tById = indexById(v.teams);
    v.sById = indexById(v.students);
    // Shape handed to calc.resolveEntry: only the maps it reads, all well-formed.
    v.shim = { scores: v.scores, teamScores: v.teamScores, teams: v.teams };
    return v;
  }

  function entryIn(map, ownerId, assessmentId) {
    var e = own(own(map, ownerId), assessmentId);
    return isObj(e) ? e : null;
  }

  /** The student's team id when that team exists in this version of the course, else null. */
  function teamIdOf(v, s) {
    var t = s && typeof s.teamId === 'string' ? s.teamId : null;
    return t !== null && v.tById.has(t) ? t : null;
  }

  function teamNameOf(v, tid) {
    var t = tid !== null && tid !== undefined ? v.tById.get(tid) : null;
    return t ? str(t.name) : '';
  }

  /** Which stored entry the student sees (calc.resolveEntry on the cleaned-up view). */
  function resolve(v, s, a) {
    var r = calc.resolveEntry(v.shim, s, a);
    return {
      entry: isObj(r.entry) ? r.entry : null,
      source: r.source,
      teamId: teamIdOf(v, s)
    };
  }

  function weeksOf(e) {
    return isObj(e) && typeof e.weeksLate === 'number' && isFinite(e.weeksLate) && e.weeksLate > 0 ? e.weeksLate : 0;
  }

  /** Comparison key of the score part of an entry (value or invalid text; late info excluded). */
  function valueKey(e) {
    if (!isObj(e)) return '';
    if (typeof e.value === 'number' && isFinite(e.value)) return 'n:' + e.value;
    if (typeof e.text === 'string' && e.text !== '') return 't:' + e.text;
    return '';
  }

  function hasContent(e) {
    return valueKey(e) !== '' || weeksOf(e) > 0;
  }

  function invalidText(text) {
    return '"' + trunc(text) + '" (not a number)';
  }

  function lateText(weeks, waived) {
    if (!weeks) return '';
    return plural(weeks, 'week') + ' late' + (waived ? ', penalty waived' : '');
  }

  /** Display string of a score. `x` is a ScoreEntry, a calc.scoreDetail result, a number, a
   * boolean ('yes'/'no') or a string. Empty is ''. Numbers show exactly as entered (String(value));
   * invalid text shows as '"abc" (not a number)'. When `assessment` is given, late-work info is
   * appended the way the student's score reads for that assessment: '80 (1 week late)'. */
  function displayValue(x, assessment) {
    if (x === null || x === undefined) return '';
    if (typeof x === 'boolean') return x ? 'yes' : 'no';
    if (typeof x === 'number') return isFinite(x) ? String(x) : '';
    if (typeof x === 'string') return x;
    if (!isObj(x)) return '';
    var base;
    if (typeof x.state === 'string' && Object.prototype.hasOwnProperty.call(x, 'raw')) {
      // calc.scoreDetail(...)
      base = x.state === 'number' && typeof x.raw === 'number' ? String(x.raw)
        : (x.state === 'invalid' && x.text ? invalidText(x.text) : '');
    } else if (typeof x.value === 'number' && isFinite(x.value)) {
      base = String(x.value);
    } else if (typeof x.text === 'string' && x.text !== '') {
      base = invalidText(x.text);
    } else {
      base = '';
    }
    if (!assessment) return base;
    var late = lateText(weeksOf(x), !!x.waived);
    if (!late) return base;
    return base ? base + ' (' + late + ')' : '(' + late + ')';
  }

  function assessmentLabel(a) {
    var n = a ? str(a.name) : '';
    return n || 'Unnamed assessment';
  }

  function pct(w) { var t = prim(w); return t === '' ? '' : t + '%'; }

  /** The stored drop-down step of an assessment (DECISIONS 8), or 0 when it has none. */
  function choiceStep(a) {
    var c = isObj(a) ? a.choices : null;
    return isObj(c) && typeof c.step === 'number' && isFinite(c.step) && c.step > 0 ? c.step : 0;
  }

  function choicesLabel(a) {
    var step = choiceStep(a);
    return step ? 'yes (steps of ' + prim(step) + ')' : 'no';
  }

  function describeAssessment(a) {
    var step = choiceStep(a);
    return assessmentLabel(a) + ' (weight ' + pct(a.weight) + ', max ' + prim(a.maxScore) +
      (a.teamGraded ? ', team-graded' : '') + (step ? ', drop-down list in steps of ' + prim(step) : '') + ')';
  }

  function byName(x, y) {
    var c = 0;
    try { c = calc.compareByName(x, y) || 0; } catch (e) { c = 0; }
    if (c !== 0 && isFinite(c)) return c;
    return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
  }

  // ------------------------------------------------------------------ entry factory

  function blankEntry(ts, source) {
    return {
      id: util.uid('h'), ts: ts, source: source, kind: 'bulk',
      studentId: null, studentName: null, teamId: null, teamName: null,
      field: '', fieldKey: '', oldValue: '', newValue: '', note: ''
    };
  }

  /** f: { student, v (course view for the team name), teamId, teamName, field, fieldKey, oldValue, newValue, note }. */
  function add(ctx, kind, f) {
    var e = blankEntry(ctx.ts, ctx.source);
    e.kind = kind;
    if (f.student) {
      e.studentId = f.student.id;
      e.studentName = model.studentName(f.student);
    }
    var tid = f.teamId !== undefined ? f.teamId : (f.student ? teamIdOf(f.v || ctx.A, f.student) : null);
    if (tid) {
      e.teamId = tid;
      e.teamName = f.teamName !== undefined ? str(f.teamName) : (teamNameOf(f.v || ctx.A, tid) || teamNameOf(ctx.B, tid));
    }
    e.field = str(f.field);
    e.fieldKey = str(f.fieldKey);
    e.oldValue = str(f.oldValue);
    e.newValue = str(f.newValue);
    e.note = str(f.note);
    ctx.out.push(e);
    if (f.student && f.assessmentId) ctx.touched.add(f.student.id + '\u0000' + f.assessmentId);
    return e;
  }

  // ------------------------------------------------------------------ 1. course details and grade settings

  var COURSE_FIELDS = [
    ['code', 'Course code', prim],
    ['title', 'Course title', prim],
    ['term', 'Term', prim],
    ['level', 'Level', capitalize]
  ];

  var ROUNDING_LABELS = { none: 'No rounding', hundredth: 'Nearest 0.01', integer: 'Nearest integer' };
  function roundingLabel(v) { return typeof v === 'string' && own(ROUNDING_LABELS, v) ? ROUNDING_LABELS[v] : prim(v); }

  var SETTING_FIELDS = [
    ['decimals', 'Display decimals', prim],
    ['rounding', 'Rounding', roundingLabel],
    ['curve', 'Curve (points added to the total)', prim],
    ['latePointsPerWeek', 'Late penalty (points per week)', prim],
    ['passingLetter', 'Passing letter', prim]
  ];

  function scaleOf(list) {
    var map = new Map(), order = [];
    arr(list).forEach(function (x) {
      if (!isObj(x) || typeof x.letter !== 'string' || x.letter === '' || map.has(x.letter)) return;
      map.set(x.letter, x.min);
      order.push(x.letter);
    });
    return { map: map, order: order };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM-DD' of an ISO timestamp in local time (what the TA saw on screen); the text itself
   * when it is not a date. */
  function localDate(iso) {
    var d = new Date(iso);
    if (typeof iso !== 'string' || isNaN(d.getTime())) return trunc(iso, 40);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** course.finalized when it is well formed ({ at: non-empty string }), else null. */
  function finalizedOf(x) {
    return isObj(x) && typeof x.at === 'string' && x.at !== '' ? x : null;
  }

  function finalizedLabel(f) { return f ? 'yes (' + localDate(f.at) + ')' : 'no'; }

  /** Finalizing and unlocking the scores (STAGE2B): kind 'settings', field "Scores finalized". */
  function finalizedDiff(ctx) {
    var fb = finalizedOf(ctx.B.raw.finalized), fa = finalizedOf(ctx.A.raw.finalized);
    var o = finalizedLabel(fb), n = finalizedLabel(fa);
    var nb = fb ? str(fb.note) : '', na = fa ? str(fa.note) : '';
    if (o === n && nb === na && (!fb || !fa || str(fb.at) === str(fa.at))) return;
    var note;
    if (!fa) note = 'Score cells unlocked: scores can be edited again';
    else note = 'Score cells locked; final letters stay editable' + (na ? '. Note: ' + trunc(na) : '');
    add(ctx, 'settings', { field: 'Scores finalized', fieldKey: 'course.finalized', oldValue: o, newValue: n, note: trunc(note) });
  }

  function settingsSection(ctx) {
    var B = ctx.B, A = ctx.A;
    COURSE_FIELDS.forEach(function (f) {
      var o = f[2](B.raw[f[0]]), n = f[2](A.raw[f[0]]);
      if (o !== n) add(ctx, 'settings', { field: f[1], fieldKey: 'course.' + f[0], oldValue: o, newValue: n });
    });
    finalizedDiff(ctx);
    SETTING_FIELDS.forEach(function (f) {
      var o = f[2](B.settings[f[0]]), n = f[2](A.settings[f[0]]);
      if (o !== n) add(ctx, 'settings', { field: f[1], fieldKey: 'settings.' + f[0], oldValue: o, newValue: n });
    });
    var bs = scaleOf(B.settings.letterScale), as = scaleOf(A.settings.letterScale);
    as.order.forEach(function (letter) {
      var n = prim(as.map.get(letter));
      if (!bs.map.has(letter)) {
        add(ctx, 'settings', { field: 'Cutoff ' + letter, fieldKey: 'settings.letterScale.' + letter, oldValue: '', newValue: n, note: 'Letter added' });
        return;
      }
      var o = prim(bs.map.get(letter));
      if (o !== n) add(ctx, 'settings', { field: 'Cutoff ' + letter, fieldKey: 'settings.letterScale.' + letter, oldValue: o, newValue: n });
    });
    bs.order.forEach(function (letter) {
      if (as.map.has(letter)) return;
      add(ctx, 'settings', {
        field: 'Cutoff ' + letter, fieldKey: 'settings.letterScale.' + letter,
        oldValue: prim(bs.map.get(letter)), newValue: '', note: 'Letter removed'
      });
    });
  }

  // ------------------------------------------------------------------ 2. assessments

  function assessmentSection(ctx) {
    var B = ctx.B, A = ctx.A;
    A.assessments.forEach(function (a) {
      var b = B.aById.get(a.id);
      var key = 'assessment:' + a.id;
      if (!b) {
        add(ctx, 'settings', { field: 'Assessment', fieldKey: key, oldValue: '', newValue: describeAssessment(a), note: 'Assessment added' });
        return;
      }
      if (prim(b.name) !== prim(a.name)) {
        add(ctx, 'settings', { field: 'Assessment name', fieldKey: key + '.name', oldValue: prim(b.name), newValue: prim(a.name) });
      }
      var label = assessmentLabel(a);
      if (prim(b.maxScore) !== prim(a.maxScore)) {
        add(ctx, 'settings', { field: label + ': max score', fieldKey: key + '.maxScore', oldValue: prim(b.maxScore), newValue: prim(a.maxScore) });
      }
      if (prim(b.weight) !== prim(a.weight)) {
        add(ctx, 'settings', { field: label + ': weight', fieldKey: key + '.weight', oldValue: pct(b.weight), newValue: pct(a.weight) });
      }
      if (!!b.teamGraded !== !!a.teamGraded) {
        add(ctx, 'settings', {
          field: label + ': team-graded', fieldKey: key + '.teamGraded',
          oldValue: yesNo(b.teamGraded), newValue: yesNo(a.teamGraded),
          note: a.teamGraded ? 'Now team-graded: one score per team, shared by its members' : 'Now individually graded'
        });
      }
      if (prim(b.category) !== prim(a.category)) {
        add(ctx, 'settings', { field: label + ': category', fieldKey: key + '.category', oldValue: capitalize(prim(b.category)), newValue: capitalize(prim(a.category)) });
      }
      var cb = choicesLabel(b), ca = choicesLabel(a);
      if (cb !== ca) {
        add(ctx, 'settings', {
          field: label + ': drop-down list', fieldKey: key + '.choices', oldValue: cb, newValue: ca,
          note: ca === 'no' ? 'Scores are typed in freely' : 'Scores are chosen from a list (max down to 0)'
        });
      }
    });
    B.assessments.forEach(function (b) {
      if (A.aById.has(b.id)) return;
      var students = 0, teams = 0;
      Object.keys(B.scores).forEach(function (sid) { if (hasContent(entryIn(B.scores, sid, b.id))) students++; });
      Object.keys(B.teamScores).forEach(function (tid) { if (hasContent(entryIn(B.teamScores, tid, b.id))) teams++; });
      var note = students || teams
        ? 'Assessment removed with its scores (' + plural(students, 'student entry', 'student entries') + ', ' + plural(teams, 'team score') + ')'
        : 'Assessment removed (no scores were entered)';
      add(ctx, 'settings', { field: 'Assessment', fieldKey: 'assessment:' + b.id, oldValue: describeAssessment(b), newValue: '', note: note });
    });
    // Display order of the assessments present in both versions.
    var bOrder = B.assessments.filter(function (b) { return A.aById.has(b.id); });
    var aOrder = A.assessments.filter(function (a) { return B.aById.has(a.id); });
    var moved = bOrder.some(function (b, i) { return aOrder[i].id !== b.id; });
    if (moved) {
      add(ctx, 'settings', {
        field: 'Assessment order', fieldKey: 'assessments.order',
        oldValue: trunc(bOrder.map(assessmentLabel).join(', ')),
        newValue: trunc(aOrder.map(assessmentLabel).join(', '))
      });
    }
  }

  // ------------------------------------------------------------------ 3. placeholders ("needs confirmation")

  function placeholderSection(ctx) {
    var B = ctx.B, A = ctx.A;
    var keys = [];
    var seen = new Set();
    Object.keys(model.PLACEHOLDERS || {}).concat(Object.keys(B.placeholders), Object.keys(A.placeholders)).forEach(function (k) {
      if (!seen.has(k)) { seen.add(k); keys.push(k); }
    });
    keys.forEach(function (k) {
      var pb = own(B.placeholders, k), pa = own(A.placeholders, k);
      var cb = !!(isObj(pb) && pb.confirmed), ca = !!(isObj(pa) && pa.confirmed);
      if (cb === ca) return;
      var info = model.PLACEHOLDERS && Object.prototype.hasOwnProperty.call(model.PLACEHOLDERS, k) ? model.PLACEHOLDERS[k] : null;
      var label = info && info.label ? info.label : k;
      add(ctx, 'settings', {
        field: 'Confirmation: ' + label, fieldKey: 'placeholder:' + k,
        oldValue: cb ? 'confirmed' : 'needs confirmation', newValue: ca ? 'confirmed' : 'needs confirmation',
        note: ca ? 'Marked confirmed' : 'Confirmation undone'
      });
    });
  }

  // ------------------------------------------------------------------ 4. teams

  function teamSection(ctx) {
    var B = ctx.B, A = ctx.A;
    A.teams.forEach(function (t) {
      var b = B.tById.get(t.id);
      if (!b) {
        add(ctx, 'team-membership', { teamId: t.id, teamName: str(t.name), field: 'Team', fieldKey: 'team:' + t.id, oldValue: '', newValue: prim(t.name), note: 'Team created' });
      } else if (prim(b.name) !== prim(t.name)) {
        add(ctx, 'team-membership', { teamId: t.id, teamName: str(t.name), field: 'Team name', fieldKey: 'team:' + t.id + '.name', oldValue: prim(b.name), newValue: prim(t.name) });
      }
    });
    B.teams.forEach(function (t) {
      if (A.tById.has(t.id)) return;
      var members = B.students.filter(function (s) { return s.teamId === t.id; }).length;
      var scores = [];
      B.assessments.forEach(function (a) {
        var e = entryIn(B.teamScores, t.id, a.id);
        if (hasContent(e)) scores.push(assessmentLabel(a) + ' ' + displayValue(e, a));
      });
      add(ctx, 'team-membership', {
        teamId: t.id, teamName: str(t.name), field: 'Team', fieldKey: 'team:' + t.id,
        oldValue: prim(t.name), newValue: '',
        note: trunc('Team deleted (' + plural(members, 'member') + (scores.length ? '; team scores: ' + scores.join(', ') : '') + ')')
      });
    });
  }

  // ------------------------------------------------------------------ 5. students

  var STUDENT_FIELDS = [
    ['no', 'No'],
    ['lastName', 'Last Name'],
    ['firstName', 'First Name'],
    ['notes', 'Notes']
  ];

  function describeStudent(v, s) {
    var parts = [];
    if (typeof s.no === 'number' && isFinite(s.no)) parts.push('No ' + s.no);
    var t = teamNameOf(v, teamIdOf(v, s));
    if (t) parts.push(t);
    if (s.status === 'withdrawn') parts.push('withdrawn');
    return parts.join(', ');
  }

  function statusLabel(s) { return s === 'withdrawn' ? 'Withdrawn' : (s === 'active' ? 'Active' : prim(s)); }

  function studentSection(ctx) {
    var B = ctx.B, A = ctx.A;
    var added = A.students.filter(function (s) { return !B.sById.has(s.id); }).sort(byName);
    var removed = B.students.filter(function (s) { return !A.sById.has(s.id); }).sort(byName);
    var common = A.students.filter(function (s) { return B.sById.has(s.id); }).sort(byName);

    added.forEach(function (s) {
      // A student can come back with a final letter (undo of a deletion, import): say which.
      var d = describeStudent(A, s), letter = finalLetterOf(s);
      if (letter) d += (d ? ', ' : '') + 'final letter ' + trunc(letter, 40);
      add(ctx, 'student', { student: s, field: 'Student', fieldKey: 'student', oldValue: '', newValue: 'Added', note: d });
    });
    removed.forEach(function (s) {
      var d = describeStudent(B, s);
      var letter = finalLetterOf(s);
      add(ctx, 'student', {
        student: s, v: B, field: 'Student', fieldKey: 'student', oldValue: '', newValue: 'Deleted permanently',
        note: (d ? d + '. ' : '') + (letter
          ? 'Scores, overrides, attendance and the final letter (' + trunc(letter, 40) + ') were deleted with the student'
          : 'Scores, overrides and attendance were deleted with the student')
      });
    });
    common.forEach(function (s) {
      var b = B.sById.get(s.id);
      STUDENT_FIELDS.forEach(function (f) {
        var o = prim(b[f[0]]), n = prim(s[f[0]]);
        if (o !== n) add(ctx, 'student', { student: s, field: f[1], fieldKey: 'student.' + f[0], oldValue: trunc(o), newValue: trunc(n) });
      });
    });
    common.forEach(function (s) {
      var b = B.sById.get(s.id);
      var o = statusLabel(b.status), n = statusLabel(s.status);
      if (o === n) return;
      add(ctx, 'status', {
        student: s, field: 'Status', fieldKey: 'student.status', oldValue: o, newValue: n,
        note: s.status === 'withdrawn'
          ? 'Kept in history and exports; excluded from statistics, rank, percentile and class average'
          : 'Included again in statistics, rank, percentile and class average'
      });
    });
    common.forEach(function (s) {
      var b = B.sById.get(s.id);
      var tb = teamIdOf(B, b), ta = teamIdOf(A, s);
      if (tb === ta) return;
      add(ctx, 'team-membership', {
        student: s, field: 'Team', fieldKey: 'student.teamId',
        oldValue: teamNameOf(B, tb), newValue: teamNameOf(A, ta),
        note: ta ? '' : 'No team'
      });
    });
  }

  // ------------------------------------------------------------------ late-work fields (team and individual entries)

  function lateDiff(ctx, eB, eA, a, who) {
    var label = assessmentLabel(a);
    var wb = weeksOf(eB), wa = weeksOf(eA);
    if (wb !== wa) {
      add(ctx, 'late', Object.assign({}, who, {
        field: label + ': weeks late', fieldKey: 'late:' + a.id + '.weeksLate',
        oldValue: wb ? String(wb) : '', newValue: wa ? String(wa) : ''
      }));
    }
    var vb = !!(isObj(eB) && eB.waived), va = !!(isObj(eA) && eA.waived);
    if (vb !== va) {
      add(ctx, 'late', Object.assign({}, who, {
        field: label + ': penalty waived', fieldKey: 'late:' + a.id + '.waived',
        oldValue: yesNo(vb), newValue: yesNo(va)
      }));
    }
  }

  // ------------------------------------------------------------------ 6. team scores

  function teamScoreSection(ctx) {
    var B = ctx.B, A = ctx.A;
    var sizes = new Map();
    A.students.forEach(function (s) {
      var t = teamIdOf(A, s);
      if (t) sizes.set(t, (sizes.get(t) || 0) + 1);
    });
    A.assessments.forEach(function (a) {
      if (!a.teamGraded) return; // team scores of an individually graded item are not visible
      var aB = B.aById.get(a.id);
      A.teams.forEach(function (t) {
        var eB = aB && B.tById.has(t.id) ? entryIn(B.teamScores, t.id, a.id) : null;
        var eA = entryIn(A.teamScores, t.id, a.id);
        var note = 'Team score for ' + plural(sizes.get(t.id) || 0, 'member');
        if (valueKey(eB) !== valueKey(eA)) {
          add(ctx, 'team-score', {
            teamId: t.id, teamName: str(t.name), field: assessmentLabel(a), fieldKey: 'teamScore:' + a.id,
            oldValue: displayValue(eB), newValue: displayValue(eA), note: note
          });
        }
        lateDiff(ctx, eB, eA, a, { teamId: t.id, teamName: str(t.name), note: note });
      });
    });
  }

  // ------------------------------------------------------------------ 7. individual entries (scores[s][a])

  function allStudents(ctx) {
    var list = ctx.A.students.slice();
    ctx.B.students.forEach(function (s) { if (!ctx.A.sById.has(s.id)) list.push(s); });
    return list.sort(byName);
  }

  function overrideRemovedNote(ctx, a, tB, tA) {
    if (tA !== tB) {
      return tA ? 'Moved to ' + teamNameOf(ctx.A, tA) + ': uses its team score' : 'No team: uses the individual score';
    }
    if (!a.teamGraded) return 'Now individually graded';
    if (!tA) return 'No team: uses the individual score';
    return 'Now uses the team score';
  }

  function entrySection(ctx) {
    var B = ctx.B, A = ctx.A;
    var students = allStudents(ctx);
    A.assessments.forEach(function (a) {
      var aB = B.aById.get(a.id) || null; // null: assessment added in this change
      var label = assessmentLabel(a);
      var fieldKey = 'score:' + a.id;
      students.forEach(function (s) {
        var sA = A.sById.get(s.id) || null;
        var sB = B.sById.get(s.id) || null;
        if (!sA) {
          // Deleted student: record the scores that were deleted with them.
          if (!aB) return;
          var rDel = resolve(B, sB, aB);
          if (rDel.source === 'team' || !hasContent(rDel.entry)) return;
          add(ctx, 'score', {
            student: sB, v: B, assessmentId: a.id, field: label, fieldKey: fieldKey,
            oldValue: displayValue(rDel.entry, aB), newValue: '',
            note: 'Student deleted permanently' + (rDel.source === 'override' ? ' (had a per-member override)' : '')
          });
          return;
        }
        var existed = !!(sB && aB);
        var eB = existed ? entryIn(B.scores, s.id, a.id) : null;
        var eA = entryIn(A.scores, s.id, a.id);
        var rB = existed ? resolve(B, sB, aB) : null;
        var rA = resolve(A, sA, a);
        var bo = !!rB && rB.source === 'override';
        var ao = rA.source === 'override';
        var who = { student: sA, assessmentId: a.id };

        if (!bo && ao) {
          add(ctx, 'override', Object.assign({}, who, {
            field: label, fieldKey: fieldKey,
            oldValue: rB ? displayValue(rB.entry, aB) : '', newValue: displayValue(eA, a), note: OVERRIDE_NOTE
          }));
          return;
        }
        if (bo && !ao) {
          add(ctx, 'override-removed', Object.assign({}, who, {
            field: label, fieldKey: fieldKey,
            oldValue: displayValue(eB, aB), newValue: displayValue(rA.entry, a),
            note: overrideRemovedNote(ctx, a, rB.teamId, rA.teamId)
          }));
          return;
        }
        if (bo && ao) {
          if (valueKey(eB) !== valueKey(eA)) {
            add(ctx, 'override', Object.assign({}, who, {
              field: label, fieldKey: fieldKey, oldValue: displayValue(eB), newValue: displayValue(eA), note: 'Override value changed'
            }));
          }
          lateDiff(ctx, eB, eA, a, Object.assign({ note: 'Per-member override' }, who));
          return;
        }
        // No override on either side. The own entry matters only where the student sees it (not a
        // team member following the team score); visible changes caused by team scores, team moves
        // or a change of the team-graded flag are logged as 'propagation'.
        var visibleBefore = !rB || rB.source !== 'team';
        var visibleAfter = rA.source !== 'team';
        if (!visibleBefore || !visibleAfter) return;
        var note = a.teamGraded && !rA.teamId ? 'No team: individual score' : '';
        if (valueKey(eB) !== valueKey(eA)) {
          add(ctx, 'score', Object.assign({}, who, {
            field: label, fieldKey: fieldKey, oldValue: displayValue(eB), newValue: displayValue(eA), note: note
          }));
        }
        lateDiff(ctx, eB, eA, a, Object.assign({ note: note }, who));
      });
    });
  }

  // ------------------------------------------------------------------ 8. propagation (visible team-graded values)

  function propagationSection(ctx) {
    var B = ctx.B, A = ctx.A;
    var students = A.students.filter(function (s) { return B.sById.has(s.id); }).sort(byName);
    A.assessments.forEach(function (a) {
      var aB = B.aById.get(a.id);
      if (!aB || !(a.teamGraded || aB.teamGraded)) return;
      students.forEach(function (sA) {
        if (ctx.touched.has(sA.id + '\u0000' + a.id)) return;
        var sB = B.sById.get(sA.id);
        var rB = resolve(B, sB, aB), rA = resolve(A, sA, a);
        var o = displayValue(rB.entry, aB), n = displayValue(rA.entry, a);
        if (o === n) return;
        var note;
        if (rA.teamId !== rB.teamId) {
          note = rA.teamId ? 'Moved to ' + teamNameOf(A, rA.teamId) + ': uses its team score' : 'No team: uses the individual score';
        } else if (rA.source === 'team') {
          note = 'From ' + teamNameOf(A, rA.teamId) + ' team score';
        } else if (!a.teamGraded) {
          note = 'Now individually graded';
        } else {
          note = 'No team: uses the individual score';
        }
        add(ctx, 'propagation', {
          student: sA, field: assessmentLabel(a), fieldKey: 'score:' + a.id, oldValue: o, newValue: n, note: note
        });
      });
    });
  }

  // ------------------------------------------------------------------ 9. final letters (STAGE2B)

  function finalLetterOf(s) {
    return isObj(s) && typeof s.finalLetter === 'string' && s.finalLetter.trim() !== '' ? s.finalLetter : '';
  }

  /** Manually assigned final letters of students present before and after (added and deleted students
   * are covered by their own entries). Up to LETTER_LIMIT changes: one 'final-letter' entry each, in
   * name order. More: one summary entry "Final letters: n changed" whose note lists up to
   * SUMMARY_STUDENTS students by No and how many got each letter, and whose `details` keep every
   * student's change (name order), so each letter stays traceable per student (entryDetails,
   * involvesStudent, toRows). */
  function finalLetterSection(ctx) {
    var B = ctx.B, A = ctx.A;
    var changes = [];
    A.students.filter(function (s) { return B.sById.has(s.id); }).sort(byName).forEach(function (s) {
      var o = finalLetterOf(B.sById.get(s.id)), n = finalLetterOf(s);
      if (o !== n) changes.push({ student: s, o: o, n: n });
    });
    if (!changes.length) return;
    if (changes.length <= LETTER_LIMIT) {
      changes.forEach(function (c) {
        add(ctx, 'final-letter', {
          student: c.student, field: 'Final letter', fieldKey: 'student.finalLetter',
          oldValue: trunc(c.o, 40), newValue: trunc(c.n, 40)
        });
      });
      return;
    }
    var nos = changes.map(function (c) { return c.student.no; })
      .filter(function (no) { return typeof no === 'number' && isFinite(no); })
      .sort(function (x, y) { return x - y; });
    var listed = nos.slice(0, SUMMARY_STUDENTS);
    var who = listed.length
      ? 'Students No ' + listed.join(', ') + (changes.length > listed.length ? ', …' : '')
      : plural(changes.length, 'student');
    // How many students got each letter, in scale order; letters outside the scale next, cleared last.
    var counts = new Map();
    changes.forEach(function (c) { counts.set(c.n, (counts.get(c.n) || 0) + 1); });
    var scale = arr(A.settings.letterScale);
    var order = Array.from(counts.keys()).sort(function (x, y) {
      var ix = x === '' ? 1e9 : calc.letterIndex(scale, x), iy = y === '' ? 1e9 : calc.letterIndex(scale, y);
      if (ix === -1) ix = 1e8;
      if (iy === -1) iy = 1e8;
      return (ix - iy) || (x < y ? -1 : x > y ? 1 : 0);
    });
    var parts = order.map(function (l) { return (l === '' ? 'cleared' : trunc(l, 12)) + ' ×' + counts.get(l); });
    var e = add(ctx, 'final-letter', {
      field: 'Final letters', fieldKey: 'finalLetters', oldValue: '', newValue: changes.length + ' changed',
      note: trunc(who + '; ' + parts.join(', '))
    });
    e.details = changes.map(function (c) {
      return {
        studentId: c.student.id,
        studentName: model.studentName(c.student),
        no: typeof c.student.no === 'number' && isFinite(c.student.no) ? c.student.no : null,
        oldValue: trunc(c.o, 40),
        newValue: trunc(c.n, 40)
      };
    });
  }

  // ------------------------------------------------------------------ 10. attendance

  var MODE_LABELS = { 'per-session': 'Per session', totals: 'Totals only', off: 'Off' };
  function modeLabel(v) { return typeof v === 'string' && own(MODE_LABELS, v) ? MODE_LABELS[v] : prim(v); }

  var ATTENDANCE_FIELDS = [
    ['mode', 'Attendance mode', modeLabel],
    ['unexcusedThreshold', 'Unexcused-absence threshold', prim],
    ['excusedCountsTowardStreak', 'Excused absences count toward a streak', function (v) { return v === undefined || v === null ? '' : yesNo(v); }],
    ['dropStreak', 'Consecutive absences for a one-letter drop', prim],
    ['failStreak', 'Consecutive absences for an F', prim],
    ['totalsSessionsHeld', 'Sessions held (totals mode)', prim]
  ];

  var MARK_LABELS = { P: 'Present', A: 'Absent', E: 'Excused' };
  function markOf(x) { return typeof x === 'string' && own(MARK_LABELS, x) ? x : ''; }
  function markLabel(m) { return m ? MARK_LABELS[m] : ''; }

  function sessionsOf(att) {
    return listWithIds(att.sessions).map(function (x) {
      return { id: x.id, date: typeof x.date === 'string' ? x.date : '', label: typeof x.label === 'string' ? x.label : '' };
    });
  }

  function describeSession(s) { return s.label ? s.date + ' (' + s.label + ')' : s.date; }

  function countOf(x) { return typeof x === 'number' && isFinite(x) ? String(x) : ''; }

  function attendanceSection(ctx) {
    var B = ctx.B, A = ctx.A;
    var attB = B.attendance, attA = A.attendance;
    ATTENDANCE_FIELDS.forEach(function (f) {
      var o = f[2](attB[f[0]]), n = f[2](attA[f[0]]);
      if (o !== n) add(ctx, 'settings', { field: f[1], fieldKey: 'attendance.' + f[0], oldValue: o, newValue: n });
    });

    // Sessions
    var sesB = sessionsOf(attB), sesA = sessionsOf(attA);
    var mapB = indexById(sesB), mapA = indexById(sesA);
    var sesChanges = [];
    sesA.forEach(function (s) {
      var b = mapB.get(s.id);
      if (!b) sesChanges.push({ date: s.date, id: s.id, o: '', n: describeSession(s), note: 'Session added', type: 'added' });
      else if (b.date !== s.date || b.label !== s.label) {
        sesChanges.push({ date: s.date, id: s.id, o: describeSession(b), n: describeSession(s), note: 'Session changed', type: 'changed' });
      }
    });
    sesB.forEach(function (b) {
      if (!mapA.has(b.id)) sesChanges.push({ date: b.date, id: b.id, o: describeSession(b), n: '', note: 'Session removed', type: 'removed' });
    });
    if (sesChanges.length > SESSION_LIMIT) {
      var counts = { added: 0, changed: 0, removed: 0 };
      sesChanges.forEach(function (c) { counts[c.type]++; });
      var sesDates = sesChanges.map(function (c) { return c.date; }).sort();
      add(ctx, 'settings', {
        field: 'Sessions', fieldKey: 'attendance.sessions', oldValue: plural(sesB.length, 'session'), newValue: plural(sesA.length, 'session'),
        note: sesChanges.length + ' sessions changed (' + counts.added + ' added, ' + counts.removed + ' removed, ' + counts.changed + ' edited): ' +
          sesDates.slice(0, SUMMARY_DATES).join(', ') + (sesDates.length > SUMMARY_DATES ? ', …' : '')
      });
    } else {
      sesChanges.forEach(function (c) {
        add(ctx, 'settings', { field: 'Session ' + c.date, fieldKey: 'attendance.session:' + c.id, oldValue: c.o, newValue: c.n, note: c.note });
      });
    }

    // Marks (per student per session) and totals. Deleted students are covered by their deletion
    // entry, and marks of removed sessions by the session entry.
    var changes = [];
    var recB = objOf(attB.records), recA = objOf(attA.records);
    var sids = [];
    var seen = new Set();
    Object.keys(recB).concat(Object.keys(recA)).forEach(function (sid) {
      if (!seen.has(sid) && A.sById.has(sid)) { seen.add(sid); sids.push(sid); }
    });
    sids.forEach(function (sid) {
      var rowB = objOf(own(recB, sid)), rowA = objOf(own(recA, sid));
      var sesSeen = new Set();
      Object.keys(rowB).concat(Object.keys(rowA)).forEach(function (sesId) {
        if (sesSeen.has(sesId)) return;
        sesSeen.add(sesId);
        var ses = mapA.get(sesId);
        if (!ses) return;
        var mb = markOf(own(rowB, sesId)), ma = markOf(own(rowA, sesId));
        if (mb !== ma) changes.push({ type: 'mark', student: A.sById.get(sid), session: ses, o: markLabel(mb), n: markLabel(ma) });
      });
    });
    var totB = objOf(attB.totals), totA = objOf(attA.totals);
    var tSeen = new Set();
    var totalStudents = [];
    Object.keys(totB).concat(Object.keys(totA)).forEach(function (sid) {
      if (tSeen.has(sid) || !A.sById.has(sid)) return;
      tSeen.add(sid);
      totalStudents.push(A.sById.get(sid));
    });
    totalStudents.sort(byName).forEach(function (s) {
      var tb = objOf(own(totB, s.id)), ta = objOf(own(totA, s.id));
      [['absent', 'Absences (totals)'], ['excused', 'Excused (totals)']].forEach(function (f) {
        var o = countOf(tb[f[0]]), n = countOf(ta[f[0]]);
        if (o !== n) changes.push({ type: 'total', student: s, field: f[1], key: f[0], o: o, n: n });
      });
    });
    if (!changes.length) return;

    if (changes.length <= MARK_LIMIT) {
      var marks = changes.filter(function (c) { return c.type === 'mark'; }).sort(function (x, y) {
        return (x.session.date < y.session.date ? -1 : x.session.date > y.session.date ? 1 : 0) || byName(x.student, y.student) ||
          (x.session.id < y.session.id ? -1 : x.session.id > y.session.id ? 1 : 0);
      });
      marks.forEach(function (c) {
        add(ctx, 'attendance', {
          student: c.student, field: 'Attendance ' + c.session.date, fieldKey: 'attendance:' + c.session.id,
          oldValue: c.o, newValue: c.n, note: c.session.label || ''
        });
      });
      changes.filter(function (c) { return c.type === 'total'; }).forEach(function (c) {
        add(ctx, 'attendance', { student: c.student, field: c.field, fieldKey: 'attendance.totals.' + c.key, oldValue: c.o, newValue: c.n });
      });
      return;
    }

    var dateSet = new Set(), who = new Set(), totalCount = 0;
    changes.forEach(function (c) {
      who.add(c.student.id);
      if (c.type === 'mark') dateSet.add(c.session.date);
      else totalCount++;
    });
    var dates = Array.from(dateSet).sort();
    var parts = [];
    if (dates.length) parts.push('Sessions: ' + dates.slice(0, SUMMARY_DATES).join(', ') + (dates.length > SUMMARY_DATES ? ', …' : ''));
    if (totalCount) parts.push('absence totals changed');
    parts.push(plural(who.size, 'student'));
    add(ctx, 'attendance', {
      field: 'Attendance', fieldKey: 'attendance', oldValue: '', newValue: changes.length + ' marks changed', note: parts.join('; ')
    });
  }

  // ------------------------------------------------------------------ public API

  var SECTIONS = [
    { label: 'course details and settings', fn: settingsSection },
    { label: 'assessments', fn: assessmentSection },
    { label: 'placeholders', fn: placeholderSection },
    { label: 'teams', fn: teamSection },
    { label: 'students', fn: studentSection },
    { label: 'team scores', fn: teamScoreSection },
    { label: 'scores', fn: entrySection },
    { label: 'team propagation', fn: propagationSection },
    { label: 'final letters', fn: finalLetterSection },
    { label: 'attendance', fn: attendanceSection }
  ];

  /** Entries for every difference between two versions of a course (history itself is ignored).
   * opts: { ts = now, source = 'edit' }. Order: course details and settings (finalizing included),
   * assessments, placeholders, teams, students, team scores, individual entries, propagation, final
   * letters, attendance; within a group, assessment order, then student name order. Never throws. */
  function diffCourse(before, after, opts) {
    var o = isObj(opts) ? opts : {};
    var ctx = {
      ts: typeof o.ts === 'string' && o.ts ? o.ts : util.nowIso(),
      source: typeof o.source === 'string' && o.source ? o.source : 'edit',
      out: [],
      touched: new Set()
    };
    try {
      ctx.B = view(before);
      ctx.A = view(after);
    } catch (err) {
      return [bulkEntry({ ts: ctx.ts, source: ctx.source, field: 'Change log', note: 'The changes could not be itemized' })];
    }
    SECTIONS.forEach(function (sec) {
      try {
        sec.fn(ctx);
      } catch (err) {
        try {
          var e = blankEntry(ctx.ts, ctx.source);
          e.field = 'Change log';
          e.fieldKey = 'history.error';
          e.note = 'Some changes (' + sec.label + ') could not be itemized' + (err && err.message ? ': ' + trunc(err.message) : '');
          ctx.out.push(e);
        } catch (ignore) { /* nothing more to do */ }
      }
    });
    return ctx.out;
  }

  /** One summary entry for a change logged as a whole (e.g. loading sample data). */
  function bulkEntry(opts) {
    var o = isObj(opts) ? opts : {};
    var e = blankEntry(typeof o.ts === 'string' && o.ts ? o.ts : util.nowIso(), typeof o.source === 'string' && o.source ? o.source : 'edit');
    e.field = str(o.field) || 'Bulk change';
    e.fieldKey = 'bulk';
    e.note = str(o.note);
    return e;
  }

  // ------------------------------------------------------------------ summary details

  /** Field shown for one student's change inside a summary entry, by the summary's fieldKey. */
  var DETAIL_FIELDS = { finalLetters: 'Final letter' };

  /** The per-student changes a summary entry keeps in `details` (today: "Final letters: n changed"),
   * as [{ studentId, studentName, no (number|null), oldValue, newValue }] in the stored order (name
   * order). Read defensively (the log comes from saved files): malformed items are skipped, and any
   * entry without details gives []. */
  function entryDetails(e) {
    if (!isObj(e) || !Array.isArray(e.details)) return [];
    var out = [];
    e.details.forEach(function (d) {
      if (!isObj(d) || typeof d.studentId !== 'string' || d.studentId === '') return;
      out.push({
        studentId: d.studentId,
        studentName: str(d.studentName),
        no: typeof d.no === 'number' && isFinite(d.no) ? d.no : null,
        oldValue: str(d.oldValue),
        newValue: str(d.newValue)
      });
    });
    return out;
  }

  /** One student's change inside a summary entry ({ studentId, studentName, no, oldValue, newValue }),
   * or null when the entry has no details for that student. */
  function detailFor(e, studentId) {
    if (typeof studentId !== 'string' || studentId === '') return null;
    var list = entryDetails(e);
    for (var i = 0; i < list.length; i++) if (list[i].studentId === studentId) return list[i];
    return null;
  }

  /** True when the entry concerns the student: its own studentId, or one of its summary details (a
   * band of final letters). This is what the History view's student filter matches. */
  function involvesStudent(e, studentId) {
    if (!isObj(e) || typeof studentId !== 'string' || studentId === '') return false;
    if (e.studentId === studentId) return true;
    if (!Array.isArray(e.details)) return false;
    for (var i = 0; i < e.details.length; i++) {
      var d = e.details[i];
      if (isObj(d) && d.studentId === studentId) return true;
    }
    return false;
  }

  var ROW_HEADER = ['Timestamp (ISO)', 'Source', 'Kind', 'Student', 'Team', 'Field', 'Old value', 'New value', 'Note', 'User note', 'User note time (ISO)'];

  /** Rows for a CSV export of history entries: [header, ...rows]. A summary entry with details (e.g.
   * "Final letters: 12 changed") is followed by one row per student it changed, so the export is a
   * complete per-student record. opts: { studentId } limits those detail rows to one student (the
   * History view's student filter). */
  function toRows(entries, opts) {
    var only = isObj(opts) && typeof opts.studentId === 'string' && opts.studentId !== '' ? opts.studentId : null;
    var rows = [ROW_HEADER.slice()];
    arr(entries).forEach(function (e) {
      if (!isObj(e)) return;
      rows.push([
        str(e.ts), str(e.source), str(e.kind), str(e.studentName), str(e.teamName), str(e.field),
        str(e.oldValue), str(e.newValue), str(e.note), str(e.userNote), e.userNote ? str(e.userNoteAt) : ''
      ]);
      var details = entryDetails(e);
      if (!details.length) return;
      var field = own(DETAIL_FIELDS, str(e.fieldKey)) || str(e.field);
      var part = 'Part of "' + str(e.field) + (str(e.newValue) ? ': ' + str(e.newValue) : '') + '"';
      details.forEach(function (d) {
        if (only && d.studentId !== only) return;
        rows.push([str(e.ts), str(e.source), str(e.kind), d.studentName, '', field, d.oldValue, d.newValue, part, '', '']);
      });
    });
    return rows;
  }

  var api = {
    diffCourse: diffCourse,
    bulkEntry: bulkEntry,
    displayValue: displayValue,
    toRows: toRows,
    entryDetails: entryDetails,
    detailFor: detailFor,
    involvesStudent: involvesStudent,
    kindGroup: kindGroup,
    KINDS: KINDS,
    SOURCES: SOURCES,
    KIND_LABELS: KIND_LABELS,
    KIND_GROUPS: KIND_GROUPS,
    MARK_LIMIT: MARK_LIMIT,
    LETTER_LIMIT: LETTER_LIMIT,
    OVERRIDE_NOTE: OVERRIDE_NOTE
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).history = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
