/* Grade Tracker - attendance (T1-T6, X7): held sessions, per-student counts and rates, consecutive-
 * absence streaks and warnings, per-session counts, and the helpers that change attendance data.
 * See docs/DESIGN.md section 7. Pure; runs in the browser (GT.attendance) and in Node.
 *
 * Marks: 'P' present, 'A' absent (not allowed, unexcused), 'E' excused (allowed, instructor-approved).
 * - A session is HELD when at least one student of the course (active or withdrawn) has a mark for it.
 *   Sessions nobody has marked are ignored: not counted, and they do not break a streak.
 * - A held session where a student has no mark is "unknown" for that student: not counted, and it
 *   BREAKS the student's streak (no warning is ever based on a guess).
 * - A streak is a run of consecutive held sessions whose marks count as absences: 'A' always; 'E' only
 *   when attendance.excusedCountsTowardStreak is true (default false, DECISIONS 6).
 * - Warnings never change a grade (T5). Attendance never feeds participation (T6).
 *
 * The mutators (setMark, setMarks, markAllPresent, clearSession, addSession, updateSession,
 * removeSession, setTotals, setSessionsHeld, setMode) change the course in place; call them inside
 * GT.store.transact so the change is saved, logged and undoable. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;
  var model = isNode ? require('./model.js') : root.GT.model;
  var hasOwn = util.hasOwn;
  var fix = util.fix;

  var MARKS = ['P', 'A', 'E'];
  var MARK_LABELS = { P: 'Present', A: 'Absent', E: 'Excused' };
  var MARK_WORDS = { P: 'P', PRESENT: 'P', A: 'A', ABSENT: 'A', E: 'E', EXCUSED: 'E' };
  var MODES = ['per-session', 'totals', 'off'];
  var WARNING_ORDER = { fail: 0, drop: 1, threshold: 2, 'total-threshold': 3 };
  var DEFAULT_DROP = 3, DEFAULT_FAIL = 4;

  // ---------------------------------------------------------------- reading the data defensively

  function isObj(x) { return util.isPlainObject(x); }

  function attOf(course) {
    return course && isObj(course.attendance) ? course.attendance : null;
  }

  function modeOf(att) {
    return att && typeof att.mode === 'string' && MODES.indexOf(att.mode) !== -1 ? att.mode : 'off';
  }

  function isMark(x) { return x === 'P' || x === 'A' || x === 'E'; }

  /** The student's mark for a session ('P' | 'A' | 'E'), or null. Own properties only. */
  function markIn(att, studentId, sessionId) {
    if (!att || !isObj(att.records) || !hasOwn(att.records, studentId)) return null;
    var row = att.records[studentId];
    if (!isObj(row) || !hasOwn(row, sessionId)) return null;
    return isMark(row[sessionId]) ? row[sessionId] : null;
  }

  function studentsOf(course) {
    return course && Array.isArray(course.students) ? course.students.filter(isObj) : [];
  }

  function isActive(s) { return s.status === 'active'; }

  // Shape check only (fast: summary() runs for every grid row); normalizeCourse already rejects
  // impossible dates such as 2026-02-30, and the mutators check dates with util.isIsoDate.
  var DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

  /** Sessions with a date and a usable id, in date order (stable: same-date sessions keep list order). */
  function datedSessions(att) {
    var list = att && Array.isArray(att.sessions) ? att.sessions : [];
    var out = [], sorted = true;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!isObj(s) || !util.isSafeKey(s.id) || typeof s.date !== 'string' || !DATE_SHAPE.test(s.date)) continue;
      if (out.length && out[out.length - 1].date > s.date) sorted = false;
      out.push(s);
    }
    if (sorted) return out;
    return out.map(function (s, k) { return { s: s, k: k }; })
      .sort(function (a, b) { return a.s.date < b.s.date ? -1 : a.s.date > b.s.date ? 1 : a.k - b.k; })
      .map(function (x) { return x.s; });
  }

  function findSession(att, sessionId) {
    var list = att && Array.isArray(att.sessions) ? att.sessions : [];
    for (var i = 0; i < list.length; i++) if (isObj(list[i]) && list[i].id === sessionId) return list[i];
    return null;
  }

  /** Held sessions in date order: sessions at least one student of the course has a mark for. */
  function heldOf(course, att) {
    var sessions = datedSessions(att);
    if (!att || !isObj(att.records) || !sessions.length) return [];
    var rows = [];
    var students = course && Array.isArray(course.students) ? course.students : [];
    for (var i = 0; i < students.length; i++) {
      var s = students[i];
      if (isObj(s) && hasOwn(att.records, s.id) && isObj(att.records[s.id])) rows.push(att.records[s.id]);
    }
    return sessions.filter(function (ses) {
      for (var j = 0; j < rows.length; j++) {
        if (hasOwn(rows[j], ses.id) && isMark(rows[j][ses.id])) return true;
      }
      return false;
    });
  }

  /** A stored count: a sane number of at least 0, else 0. */
  function count(x) { return util.isSaneNumber(x) && x > 0 ? x : 0; }

  function rate(n, of) { return of > 0 ? fix(100 * n / of) : null; }

  function streakLimits(att) {
    var drop = util.isSaneNumber(att.dropStreak) && att.dropStreak >= 1 ? att.dropStreak : DEFAULT_DROP;
    var fail = util.isSaneNumber(att.failStreak) && att.failStreak >= 1 ? att.failStreak : DEFAULT_FAIL;
    return { drop: drop, fail: fail };
  }

  function threshold(x) { return util.isSaneNumber(x) && x >= 0 ? x : null; }

  function compareByName(a, b) {
    return util.compareText(a.lastName, b.lastName) ||
      util.compareText(a.firstName, b.firstName) ||
      ((typeof a.no === 'number' ? a.no : Infinity) - (typeof b.no === 'number' ? b.no : Infinity)) || 0;
  }

  // ---------------------------------------------------------------- marks

  /** Label of a mark: 'P' -> 'Present', 'A' -> 'Absent', 'E' -> 'Excused', anything else -> ''. */
  function markLabel(m) {
    return typeof m === 'string' && hasOwn(MARK_LABELS, m) ? MARK_LABELS[m] : '';
  }

  /** Reads a typed, pasted or imported mark: 'P', 'a', ' e ', 'Present', 'absent', 'EXCUSED'.
   * Returns { kind: 'mark', mark } | { kind: 'empty' } (blank, null, undefined) | { kind: 'invalid', text }. */
  function parseMark(input) {
    if (input === null || input === undefined) return { kind: 'empty' };
    var t = String(input).trim();
    if (t === '') return { kind: 'empty' };
    var k = t.toUpperCase();
    if (hasOwn(MARK_WORDS, k)) return { kind: 'mark', mark: MARK_WORDS[k] };
    return { kind: 'invalid', text: t };
  }

  /** The next mark when cycling with Space: blank -> P -> A -> E -> blank. */
  function cycleMark(m) {
    if (m === 'P') return 'A';
    if (m === 'A') return 'E';
    if (m === 'E') return null;
    return 'P';
  }

  /** The mark (or null) a mutator should store for `mark`; throws a readable Error for anything else. */
  function markToStore(mark) {
    var p = parseMark(mark);
    if (p.kind === 'empty') return null;
    if (p.kind === 'mark') return p.mark;
    throw new Error('"' + p.text.slice(0, 20) + '" is not an attendance mark. Use P (present), A (absent, not allowed) or E (excused, allowed).');
  }

  // ---------------------------------------------------------------- sessions (read)

  /** Sessions at least one student (active or withdrawn) has a mark for, in date order. */
  function heldSessions(course) {
    var att = attOf(course);
    return att ? heldOf(course, att) : [];
  }

  /** Index (in course.attendance.sessions) of the earliest session on or after isoDate; when every
   * session is earlier, the latest session. -1 when there are no sessions or isoDate is not a date. */
  function nearestSessionIndex(course, isoDate) {
    var att = attOf(course);
    var list = att && Array.isArray(att.sessions) ? att.sessions : [];
    if (!util.isIsoDate(isoDate)) return -1;
    var after = -1, last = -1;
    list.forEach(function (s, i) {
      if (!isObj(s) || !util.isIsoDate(s.date)) return;
      if (s.date >= isoDate && (after === -1 || s.date < list[after].date)) after = i;
      if (last === -1 || s.date >= list[last].date) last = i;
    });
    return after !== -1 ? after : last;
  }

  /** Marks for a session by students of the course (withdrawn included): the marks removeSession
   * and clearSession delete, so a confirmation can say how many will be lost. */
  function markCount(course, sessionId) {
    var att = attOf(course);
    var n = 0;
    studentsOf(course).forEach(function (s) { if (markIn(att, s.id, sessionId)) n++; });
    return n;
  }

  /** Counts for one session over ACTIVE students: { present, absent, excused, unmarked, marked,
   * presentRate } (presentRate = 100 x present / marked, null when nobody is marked). */
  function sessionCounts(course, sessionId) {
    var att = attOf(course);
    var out = { present: 0, absent: 0, excused: 0, unmarked: 0, marked: 0, presentRate: null };
    studentsOf(course).forEach(function (s) {
      if (!isActive(s)) return;
      var m = markIn(att, s.id, sessionId);
      if (m === 'P') out.present++;
      else if (m === 'A') out.absent++;
      else if (m === 'E') out.excused++;
      else out.unmarked++;
    });
    out.marked = out.present + out.absent + out.excused;
    out.presentRate = rate(out.present, out.marked);
    return out;
  }

  // ---------------------------------------------------------------- per-student summary

  function runOf(sessions) {
    return {
      startDate: sessions[0].date,
      endDate: sessions[sessions.length - 1].date,
      length: sessions.length,
      sessionIds: sessions.map(function (s) { return s.id; }),
      dates: sessions.map(function (s) { return s.date; })
    };
  }

  function thresholdFlags(att, out) {
    var ut = threshold(att.unexcusedThreshold);
    var tt = threshold(att.totalAbsenceThreshold);
    out.overThreshold = ut !== null && out.unexcused > ut;
    out.overTotalThreshold = tt !== null && out.totalAbsences > tt;
  }

  function perSessionSummary(att, studentId, held) {
    var countE = att.excusedCountsTowardStreak === true;
    var present = 0, absent = 0, excused = 0, recorded = 0;
    var runs = [], cur = null, lastRecorded = -1, lastRun = null;
    held.forEach(function (ses, i) {
      var m = markIn(att, studentId, ses.id);
      if (m) {
        recorded++;
        lastRecorded = i;
        if (m === 'P') present++;
        else if (m === 'A') absent++;
        else excused++;
      }
      if (m === 'A' || (m === 'E' && countE)) {
        if (!cur) { cur = []; runs.push(cur); }
        cur.push(ses);
        lastRun = cur; // the run holding the latest counted absence
      } else {
        cur = null; // present, excused (when it does not count) and unknown break the run
      }
    });
    var longest = 0;
    runs.forEach(function (r) { if (r.length > longest) longest = r.length; });
    // The run that ends at the student's latest recorded session (0 when that mark is no absence).
    var current = lastRun && lastRun[lastRun.length - 1] === held[lastRecorded] ? lastRun.length : 0;
    var lim = streakLimits(att);
    var totalAbsences = absent + excused;
    var out = {
      mode: 'per-session',
      held: held.length,
      recorded: recorded,
      unmarked: held.length - recorded,
      present: present,
      absent: absent,
      excused: excused,
      totalAbsences: totalAbsences,
      unexcused: absent,
      absenceRate: rate(totalAbsences, recorded),
      unexcusedRate: rate(absent, recorded),
      longestStreak: longest,
      currentStreak: current,
      streaks: runs.filter(function (r) { return r.length >= 2; }).map(runOf),
      streaksAvailable: true,
      excusedCountsTowardStreak: countE,
      warning: longest > 0 && longest >= lim.fail ? 'fail' : (longest > 0 && longest >= lim.drop ? 'drop' : null),
      overThreshold: false,
      overTotalThreshold: false,
      moreAbsencesThanSessions: false
    };
    thresholdFlags(att, out);
    return out;
  }

  function totalsSummary(att, studentId) {
    var t = isObj(att.totals) && hasOwn(att.totals, studentId) && isObj(att.totals[studentId]) ? att.totals[studentId] : {};
    var absent = count(t.absent), excused = count(t.excused);
    var recorded = count(att.totalsSessionsHeld);
    var totalAbsences = fix(absent + excused);
    var out = {
      mode: 'totals',
      held: recorded,
      recorded: recorded,
      unmarked: 0,
      present: Math.max(0, fix(recorded - totalAbsences)),
      absent: absent,
      excused: excused,
      totalAbsences: totalAbsences,
      unexcused: absent,
      absenceRate: rate(totalAbsences, recorded),
      unexcusedRate: rate(absent, recorded),
      longestStreak: null,
      currentStreak: null,
      streaks: [],
      streaksAvailable: false,
      excusedCountsTowardStreak: att.excusedCountsTowardStreak === true,
      warning: null,
      overThreshold: false,
      overTotalThreshold: false,
      moreAbsencesThanSessions: totalAbsences > recorded
    };
    thresholdFlags(att, out);
    return out;
  }

  function summaryWith(course, att, mode, studentId, held) {
    if (mode === 'totals') return totalsSummary(att, studentId);
    return perSessionSummary(att, studentId, held || heldOf(course, att));
  }

  /** Attendance summary of one student; null when attendance is off for the course.
   * { mode, held, recorded, unmarked, present, absent, excused, totalAbsences, unexcused, absenceRate,
   *   unexcusedRate, longestStreak, currentStreak, streaks: [{ startDate, endDate, length, sessionIds,
   *   dates }], streaksAvailable, excusedCountsTowardStreak, warning: null|'drop'|'fail',
   *   overThreshold, overTotalThreshold, moreAbsencesThanSessions } (DESIGN 7.2). */
  function summary(course, studentId) {
    var att = attOf(course);
    var mode = modeOf(att);
    if (mode === 'off') return null;
    return summaryWith(course, att, mode, studentId, null);
  }

  function warningDetail(kind, sm, att) {
    if (kind === 'fail') return sm.longestStreak + ' consecutive absences: syllabus says F';
    if (kind === 'drop') return sm.longestStreak + ' consecutive absences: syllabus says one letter grade drop';
    if (kind === 'threshold') {
      return sm.unexcused + ' unexcused absences: above the unexcused-absence threshold (' + threshold(att.unexcusedThreshold) + ')';
    }
    return sm.totalAbsences + ' absences in total (excused + unexcused): above the total-absence threshold (' + threshold(att.totalAbsenceThreshold) + ')';
  }

  /** The student's longest run (the oldest one when several are equally long). */
  function longestRun(sm) {
    var best = null;
    (sm.streaks || []).forEach(function (r) { if (!best || r.length > best.length) best = r; });
    return best;
  }

  /** Attendance of the whole course: { mode, held, total, byStudent: { sid: summary }, warnings }.
   * held = held sessions (per-session) or totalsSessionsHeld (totals); total = sessions.length.
   * warnings: one item per active student and kind, sorted fail, drop, threshold, total-threshold,
   * then by name: { studentId, kind, detail, count, limit, streak } (streak: the longest run, for
   * fail/drop; null otherwise). Off: byStudent {} and warnings []. */
  function courseSummary(course) {
    var att = attOf(course);
    var mode = modeOf(att);
    var total = att && Array.isArray(att.sessions) ? att.sessions.length : 0;
    var out = { mode: mode, held: 0, total: total, byStudent: {}, warnings: [] };
    if (mode === 'off') return out;
    var held = mode === 'per-session' ? heldOf(course, att) : null;
    out.held = mode === 'per-session' ? held.length : count(att.totalsSessionsHeld);
    var lim = streakLimits(att);
    var students = studentsOf(course);
    var items = [];
    students.forEach(function (s) {
      if (!util.isSafeKey(s.id)) return;
      var sm = summaryWith(course, att, mode, s.id, held);
      out.byStudent[s.id] = sm;
      if (!isActive(s)) return;
      var push = function (kind, n, limit, streak) {
        items.push({ s: s, w: { studentId: s.id, kind: kind, detail: warningDetail(kind, sm, att), count: n, limit: limit, streak: streak } });
      };
      if (sm.warning === 'fail') push('fail', sm.longestStreak, lim.fail, longestRun(sm));
      else if (sm.warning === 'drop') push('drop', sm.longestStreak, lim.drop, longestRun(sm));
      if (sm.overThreshold) push('threshold', sm.unexcused, threshold(att.unexcusedThreshold), null);
      if (sm.overTotalThreshold) push('total-threshold', sm.totalAbsences, threshold(att.totalAbsenceThreshold), null);
    });
    items.sort(function (a, b) {
      return (WARNING_ORDER[a.w.kind] - WARNING_ORDER[b.w.kind]) || compareByName(a.s, b.s);
    });
    out.warnings = items.map(function (x) { return x.w; });
    return out;
  }

  /** Per-student counts from the per-session marks, for filling the totals-only table:
   * { held, totals: { sid: { absent, excused } } } (students of the course, held sessions only). */
  function totalsFromRecords(course) {
    var att = attOf(course);
    var held = att ? heldOf(course, att) : [];
    var totals = {};
    studentsOf(course).forEach(function (s) {
      if (!util.isSafeKey(s.id)) return;
      var a = 0, e = 0;
      held.forEach(function (ses) {
        var m = markIn(att, s.id, ses.id);
        if (m === 'A') a++;
        else if (m === 'E') e++;
      });
      totals[s.id] = { absent: a, excused: e };
    });
    return { held: held.length, totals: totals };
  }

  // ---------------------------------------------------------------- sessions (merge, ids)

  function byDateStable(list) {
    return list.map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) {
        var da = isObj(a.s) && typeof a.s.date === 'string' ? a.s.date : '￿';
        var db = isObj(b.s) && typeof b.s.date === 'string' ? b.s.date : '￿';
        return da < db ? -1 : da > db ? 1 : a.i - b.i;
      })
      .map(function (x) { return x.s; });
  }

  /** A session id for `date` not used by any session or record: 'ses_YYYYMMDD', else '_2', '_3', ... */
  function freeId(date, used) {
    var base = 'ses_' + date.replace(/-/g, '');
    if (!used.has(base)) return base;
    for (var k = 2; ; k++) if (!used.has(base + '_' + k)) return base + '_' + k;
  }

  function usedIds(att) {
    var used = new Set();
    (Array.isArray(att.sessions) ? att.sessions : []).forEach(function (s) { if (isObj(s) && typeof s.id === 'string') used.add(s.id); });
    if (isObj(att.records)) {
      Object.keys(att.records).forEach(function (sid) {
        if (isObj(att.records[sid])) Object.keys(att.records[sid]).forEach(function (k) { used.add(k); });
      });
    }
    return used;
  }

  /** The session ids a course already uses: its sessions' ids and every session id in its attendance
   * records. Marks can outlive their session (a restored file whose session had a bad date and was
   * dropped), and a new session must never pick up such old marks. Returns a Set. */
  function sessionIdsInUse(course) {
    var att = attOf(course);
    return att ? usedIds(att) : new Set();
  }

  /** mergeSessions' optional `taken`: a course (its sessionIdsInUse), a Set or an array of ids. */
  function takenIds(taken) {
    var out = new Set();
    if (!taken) return out;
    if (isObj(taken) && isObj(taken.attendance)) return sessionIdsInUse(taken);
    if (typeof taken.forEach === 'function' && (Array.isArray(taken) || typeof taken.has === 'function')) {
      taken.forEach(function (id) { if (typeof id === 'string') out.add(id); });
    }
    return out;
  }

  /** Merges generated sessions into the existing list and returns a NEW list sorted by date. Every
   * existing session is kept as it is (id, date, label, so its marks stay attached); a generated
   * session is added only when no existing session has its date (and each date once). An added
   * session whose id is already taken gets a free one ('ses_YYYYMMDD_2'). Never drops a session.
   * `taken` (optional, recommended): the course, or a Set / array of ids that are in use too. Pass the
   * course so a generated id never reuses an id that marks without a session still carry (those old
   * marks would otherwise reappear on the new session and count as absences). */
  function mergeSessions(existing, generated, taken) {
    var out = [];
    var dates = new Set(), used = takenIds(taken);
    (Array.isArray(existing) ? existing : []).forEach(function (s) {
      if (!isObj(s)) return;
      var c = Object.assign({}, s);
      out.push(c);
      if (typeof c.date === 'string') dates.add(c.date);
      if (typeof c.id === 'string') used.add(c.id);
    });
    (Array.isArray(generated) ? generated : []).forEach(function (g) {
      if (!isObj(g) || !util.isIsoDate(g.date) || dates.has(g.date)) return;
      var id = util.isSafeKey(g.id) && !used.has(g.id) ? g.id : freeId(g.date, used);
      used.add(id);
      dates.add(g.date);
      out.push({ id: id, date: g.date, label: typeof g.label === 'string' ? g.label : '' });
    });
    return byDateStable(out);
  }

  // ---------------------------------------------------------------- mutators (use inside GT.store.transact)

  function ensureAtt(course) {
    if (!course || !isObj(course.attendance)) throw new Error('This course has no attendance data.');
    var att = course.attendance;
    if (!Array.isArray(att.sessions)) att.sessions = [];
    if (!isObj(att.records)) att.records = {};
    if (!isObj(att.totals)) att.totals = {};
    return att;
  }

  function hasStudent(course, studentId) {
    return util.isSafeKey(studentId) && !!model.findStudent(course, studentId);
  }

  /** Sets (or, with null / '' / undefined, clears) one mark. Accepts what parseMark accepts; another
   * value throws a readable Error. Returns true when the stored mark changed; false when it did not,
   * or when the student or session does not exist. An emptied student row is removed. */
  function setMark(course, studentId, sessionId, mark) {
    var next = markToStore(mark);
    var att = ensureAtt(course);
    if (!hasStudent(course, studentId) || !util.isSafeKey(sessionId) || !findSession(att, sessionId)) return false;
    var prev = markIn(att, studentId, sessionId);
    if (prev === next) return false;
    model.setEntry(att.records, studentId, sessionId, next);
    return true;
  }

  /** Several marks in one go (a selected range, roll call): items = [{ studentId, sessionId, mark }].
   * Invalid marks and unknown students or sessions are skipped, never thrown. Returns the number of
   * marks that changed. Use it inside one transaction for ONE undo step. */
  function setMarks(course, items) {
    var n = 0;
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (!isObj(it)) return;
      try {
        if (setMark(course, it.studentId, it.sessionId, it.mark)) n++;
      } catch (e) { /* skipped: not a mark */ }
    });
    return n;
  }

  /** "Mark everyone without a mark as Present" (roll call): sets 'P' for every student with no mark
   * for the session; opts.activeOnly (default true) skips withdrawn students. Marks already set are
   * never changed. Returns the number of marks set (0 for an unknown session). */
  function markAllPresent(course, sessionId, opts) {
    var activeOnly = !(opts && opts.activeOnly === false);
    var att = ensureAtt(course);
    if (!util.isSafeKey(sessionId) || !findSession(att, sessionId)) return 0;
    var n = 0;
    studentsOf(course).forEach(function (s) {
      if (activeOnly && !isActive(s)) return;
      if (!util.isSafeKey(s.id) || markIn(att, s.id, sessionId)) return;
      model.setEntry(att.records, s.id, sessionId, 'P');
      n++;
    });
    return n;
  }

  /** Removes every mark stored for the session (students' rows only; the session stays). */
  function dropMarks(att, sessionId) {
    if (!isObj(att.records)) return;
    Object.keys(att.records).forEach(function (sid) {
      var row = att.records[sid];
      if (isObj(row) && hasOwn(row, sessionId)) model.setEntry(att.records, sid, sessionId, null);
    });
  }

  /** Clears every mark of the session (the session stays). Returns markCount before clearing. */
  function clearSession(course, sessionId) {
    var att = ensureAtt(course);
    if (!util.isSafeKey(sessionId)) return 0;
    var n = markCount(course, sessionId);
    dropMarks(att, sessionId);
    return n;
  }

  function cleanLabel(x) {
    return x === null || x === undefined ? '' : String(x).replace(/\s+/g, ' ').trim();
  }

  /** Two sessions may share a date only when they can be told apart: at most one of them unlabeled,
   * and labels different (ignoring case). Throws a readable Error otherwise. */
  function checkDate(att, date, label, selfId) {
    if (!util.isIsoDate(date)) throw new Error('Enter a valid date (YYYY-MM-DD).');
    var same = (Array.isArray(att.sessions) ? att.sessions : []).filter(function (s) {
      return isObj(s) && s.date === date && s.id !== selfId;
    });
    if (!same.length) return;
    var key = label.toLowerCase();
    var clash = same.some(function (s) { return cleanLabel(s.label).toLowerCase() === key; });
    if (clash) {
      throw new Error(label
        ? 'There is already a session on ' + date + ' labeled "' + label + '". Use a different label.'
        : 'There is already a session on ' + date + '. Give this one a label (for example "Makeup") to keep both.');
    }
  }

  function sortSessions(att) {
    att.sessions = byDateStable(att.sessions);
  }

  /** Adds a session { date: 'YYYY-MM-DD', label } in date order and returns it. A second session on
   * the same date needs a label (and labels on one date must differ); a bad date or a clash throws a
   * readable Error. The id is 'ses_YYYYMMDD' (or '_2', '_3', ... when taken). */
  function addSession(course, fields) {
    var att = ensureAtt(course);
    var f = isObj(fields) ? fields : {};
    var date = typeof f.date === 'string' ? f.date.trim() : '';
    var label = cleanLabel(f.label);
    if (!util.isIsoDate(date)) throw new Error('Enter a valid date (YYYY-MM-DD).');
    var taken = att.sessions.some(function (s) { return isObj(s) && s.date === date; });
    if (taken && !label) {
      throw new Error('There is already a session on ' + date + '. Give the new one a label (for example "Makeup") to add a second session that day.');
    }
    checkDate(att, date, label, null);
    var ses = { id: freeId(date, usedIds(att)), date: date, label: label };
    att.sessions.push(ses);
    sortSessions(att);
    return ses;
  }

  /** Changes a session's date and/or label; its id (and so its marks) stay. The list is re-sorted.
   * Returns the session, or null when there is no such session. Bad dates or clashes throw. */
  function updateSession(course, sessionId, patch) {
    var att = ensureAtt(course);
    var ses = findSession(att, sessionId);
    if (!ses) return null;
    var p = isObj(patch) ? patch : {};
    var date = p.date !== undefined ? (typeof p.date === 'string' ? p.date.trim() : '') : ses.date;
    var label = p.label !== undefined ? cleanLabel(p.label) : cleanLabel(ses.label);
    checkDate(att, date, label, ses.id);
    ses.date = date;
    ses.label = label;
    sortSessions(att);
    return ses;
  }

  /** Deletes a session and its marks. Returns the number of marks removed (markCount); 0 when there
   * is no such session (nothing changes). */
  function removeSession(course, sessionId) {
    var att = ensureAtt(course);
    var ses = findSession(att, sessionId);
    if (!ses) return 0;
    var n = markCount(course, sessionId);
    att.sessions = att.sessions.filter(function (s) { return s !== ses; });
    dropMarks(att, sessionId);
    return n;
  }

  /** A whole number >= 0 (numbers, or text through util.parseCount); throws a readable Error otherwise. */
  function wholeCount(x, what) {
    var v = typeof x === 'number' ? x : util.parseCount(x);
    if (typeof v !== 'number' || !util.isSaneNumber(v) || v < 0 || Math.floor(v) !== v) {
      throw new Error(what + ' must be a whole number of 0 or more.');
    }
    return v;
  }

  /** Totals-only mode: sets a student's counts; fields: { absent?, excused? } (missing ones keep the
   * current value). Values are whole numbers >= 0 (text through util.parseCount); anything else throws
   * a readable Error and nothing changes. Returns true when a stored count changed; false for an
   * unknown student. A student without a row who is set to 0 and 0 gets no row. */
  function setTotals(course, studentId, fields) {
    var att = ensureAtt(course);
    var f = isObj(fields) ? fields : {};
    var hasA = f.absent !== undefined, hasE = f.excused !== undefined;
    var a = hasA ? wholeCount(f.absent, 'Absent (unexcused)') : null;
    var e = hasE ? wholeCount(f.excused, 'Excused') : null;
    if (!hasStudent(course, studentId)) return false;
    var had = hasOwn(att.totals, studentId) && isObj(att.totals[studentId]);
    var cur = had ? att.totals[studentId] : {};
    var next = { absent: hasA ? a : count(cur.absent), excused: hasE ? e : count(cur.excused) };
    if (!had && next.absent === 0 && next.excused === 0) return false;
    if (had && cur.absent === next.absent && cur.excused === next.excused) return false;
    att.totals[studentId] = next;
    return true;
  }

  /** Totals-only mode: sets "sessions held so far" (the rate denominator), a whole number >= 0.
   * Throws a readable Error for anything else. Returns true when it changed. */
  function setSessionsHeld(course, n) {
    var att = ensureAtt(course);
    var v = wholeCount(n, 'Sessions held');
    if (att.totalsSessionsHeld === v) return false;
    att.totalsSessionsHeld = v;
    return true;
  }

  /** Switches the attendance mode ('per-session' | 'totals' | 'off'). Records, totals and sessions
   * are kept, so switching back shows them again. Throws for an unknown mode; true when it changed. */
  function setMode(course, mode) {
    var att = ensureAtt(course);
    if (MODES.indexOf(mode) === -1) throw new Error('Unknown attendance mode "' + String(mode) + '".');
    if (att.mode === mode) return false;
    att.mode = mode;
    return true;
  }

  var api = {
    MARKS: MARKS.slice(),
    MODES: MODES.slice(),
    markLabel: markLabel,
    parseMark: parseMark,
    cycleMark: cycleMark,
    heldSessions: heldSessions,
    nearestSessionIndex: nearestSessionIndex,
    markCount: markCount,
    sessionCounts: sessionCounts,
    summary: summary,
    courseSummary: courseSummary,
    totalsFromRecords: totalsFromRecords,
    mergeSessions: mergeSessions,
    sessionIdsInUse: sessionIdsInUse,
    setMark: setMark,
    setMarks: setMarks,
    markAllPresent: markAllPresent,
    clearSession: clearSession,
    addSession: addSession,
    updateSession: updateSession,
    removeSession: removeSession,
    setTotals: setTotals,
    setSessionsHeld: setSessionsHeld,
    setMode: setMode
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).attendance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
