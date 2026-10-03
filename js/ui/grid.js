/* Grade Tracker - Grades grid (GT.views.grades): an Excel-like sheet with one row per student.
 * Keyboard-first editing (type to replace, Enter/F2 to edit, Tab/Enter/arrows to move), range
 * selection, copy and paste of blocks from Excel, team scores with per-member overrides, sorting,
 * grouping by team, search and column toggles.
 * Stage 2b: the "Suggested" (cutoff) letter and the manual "Final letter" (drop-down), drop-down
 * score cells (assessment.choices), band assignment over a selected range, column fill menus,
 * finalize / unlock (locked score cells), a stable row order ("Order changed: re-sort"), the
 * Meeting view and the three absence columns.
 * Stage 6 (K4): late work. "Late work…" in the cell menu and Ctrl+L (also GT.ui.openLateWork) open a
 * dialog for weeks late and "penalty waived" (on the team entry for a team cell without an override),
 * read-only while the scores are finalized; raw cells show an "L2" / "L2✓" badge.
 * navigate('grades', { focus: { studentId, assessmentId } }) selects a raw score cell.
 * Browser only. See docs/DESIGN.md section 6, the stage-2 spec (section 4) and the stage-2b spec. */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model, calc = GT.calc, ui = GT.ui;
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  /* ---------------------------------------------------------------------------------------------
   * EXTENSION POINT (stage 6: late work and more). Each entry is a function (ctx) -> items[] whose
   * items (same shape as GT.ui.menu items) are appended to the cell menu after a separator.
   * ctx = { course, student, column: { key, kind, label, assessmentId }, assessment|null,
   *         detail|null (calc.scoreDetail), result (calc.studentResult + rank), selection: { rows, cols },
   *         store: GT.store, refocus: function () } -- re-read data through ctx.store when acting.
   * ------------------------------------------------------------------------------------------- */
  if (!Array.isArray(GT.gridCellMenuExtensions)) GT.gridCellMenuExtensions = [];

  var PAGE_ROWS = 10;
  var NEW_TEAM = '__new_team__';
  var COL_TOGGLES = [
    { key: 'weighted', label: 'Weighted scores' },
    { key: 'percentile', label: 'Percentile' },
    { key: 'diff', label: 'Difference from average' },
    { key: 'attExcused', label: 'Excused absences (allowed)', att: true },
    { key: 'attUnexcused', label: 'Unexcused absences (not allowed)', att: true },
    { key: 'attTotal', label: 'Total absences', att: true }
  ];
  var SORTS = [
    { value: 'name:asc', label: 'Name A–Z' },
    { value: 'name:desc', label: 'Name Z–A' },
    { value: 'total:desc', label: 'Total high–low' },
    { value: 'total:asc', label: 'Total low–high' }
  ];
  // Identity column widths (px). The sticky offsets in css/grid.css (.sc1 … .sc4) match these; the
  // Meeting view (larger text, no Team column) uses WM and its own offsets (.gt-grid.meeting .sc2/.sc3).
  var W = { no: 52, last: 106, first: 136, team: 70, total: 74, rank: 54, pct: 90, diff: 62 };
  var WM = { no: 56, last: 128, first: 132, total: 70, rank: 48, final: 90 };
  // Meeting view: Last and First Name are only as wide as the longest name needs (at most WM.last and
  // WM.first; meetingNameWidths), and a withdrawn student's badge is a short "W", so the meeting columns
  // fit at 1280 px (SE 6362 with attendance on). Final letter and Rank are also pinned on the right
  // (css/grid.css .pr1/.pr2, offsets from WM.rank), so they stay on screen whatever the names and the
  // window width.
  var HEAD_PAD = 17;   // header cell padding (2 × 8 px) plus slack
  // Meeting view: header cells have 6 px side padding (css/grid.css .gt-grid.meeting thead th) and a
  // placeholder badge may wrap under its text, so the decision columns (Participation, Suggested, Final
  // letter, Rank) stay on screen at 1280 px with the three absence columns shown.
  var HEAD_PAD_MEET = 13;
  var BADGE_W = 21;    // compact placeholder badge in a header (with its margin)
  var LOCKED_MSG = 'Scores are finalized. Unlock them to edit.';
  var LATE_LOCKED_MSG = 'Scores are finalized. Unlock them to change late work.';
  var LATE_MAX = 52;   // weeks late accepted in the dialog (a year; util.parseCount accepts more)
  var NOTE_MAX = 200;        // characters of the Finalize note (the banner shows at most NOTE_SHOWN)
  var NOTE_SHOWN = 120;
  var LETTERS_CONFIRM = 10;  // clearing more final letters than this at once asks first
  var WITHDRAWN_LETTER_TIP = 'Withdrawn: no letter';
  // Classes paintSelection() and placeDropButton() put on body cells; a patched cell keeps them.
  var PAINT_CLASSES = ['is-active', 'in-range', 'has-dd', 'is-editing', 'has-popup'];

  // Team-score marker: one masked span (css/grid.css) instead of an inline SVG per cell, to keep the
  // 59-row table cheap to lay out.
  var ICON_TEAM = '<span class="mk mk-team" aria-hidden="true"></span>';
  var ICON_OVR = '<span class="mk mk-ovr" aria-hidden="true">◆</span><span class="sr-only">override </span>';
  var ICON_INCOMPLETE = '<svg class="icon inc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7"/></svg>';

  // ------------------------------------------------------------------ transient view state

  var boundEl = null;        // container the delegated listeners are bound to
  var dom = null;            // persistent elements of the current container
  var mode = null;           // 'grid' | 'empty' | 'none'
  var lastCourseId = null;
  var searchText = '';
  var sel = { active: null, end: null, lastR: 0 };  // cell refs { sid, key } (stable across re-renders)
  var layout = null;         // visible rows and columns of the last render
  var rowEls = [];
  var painted = { range: [], active: null, head: null, row: null };
  var editing = null;        // { sid, key, kind, aid, mode, input, td, original, max }
  var drag = null;
  var tabStartKey = null;    // Excel: Tab, Tab, Enter returns to the column where tabbing started
  var tabExit = false;       // Esc was pressed: the next Tab / Shift+Tab leaves the grid
  var newRowSid = null;      // freshly added student: Enter on a name moves right
  var pendingEdit = null;    // { sid, key } to edit after the next render
  var revealActive = false;  // scroll the active cell into view after the next render
  var lastParams = null;     // navigate() params already applied (each navigate passes a new object)
  var focusUntil = 0;        // refocus the active cell on a render before this time (ms)
  var tableDirty = false;    // data changed while the editor was open
  var dataDirty = true;      // store changed since the last table build
  var teamToastShown = false;
  var readOnlyToastAt = 0;
  var colsMenu = null;
  var globalBound = false;
  var kbMenuAt = 0;
  var copyHandled = false;
  var pendingCopy = null;
  var lastRenderMs = 0;
  var lockedToastAt = 0;
  var ddToastAt = 0;
  var bandToastShown = false;
  var ddBtn = null;          // the ▾ button shown in the active drop-down cell
  // Stable row order (DECISIONS 7): per course id, the student ids in the order of the last sort
  // ({ sig, ids }). Edits never reorder rows. The snapshot is taken again only when the sort, the
  // grouping or the Meeting view changes, after "Finalize scores", or when the user clicks "Order
  // changed: re-sort". A search or the withdrawn filter only hides rows of the snapshot, a course
  // switch keeps each course's own snapshot, new students are appended at the end and removed ones
  // dropped.
  var orders = Object.create(null);
  var forceResort = false;
  // End of the list (E2E-2): a value committed with Enter or Down on the last row (Up on the first) cannot
  // move on, so the next typed key would silently replace it. { sid, key } of that cell: typed keys and
  // Enter there are ignored (with a message) until the user moves, clicks or edits it explicitly (F2).
  var endHold = null;
  var endHoldToastAt = 0;
  // The table as last built, so a data change patches only the cells whose markup changed (CODE-5):
  // { table, sig, items: [{ sid, tr, parts } | { team: true, tr, html }], foot }. sig: the header markup
  // and the row keys in order; any other change (columns, order, grouping, filter) rebuilds the table.
  var built = null;
  var leaveHooked = false;

  // Any store change except autosave/annotation invalidates the table.
  if (GT.store && GT.store.subscribe) {
    GT.store.subscribe(function (info) {
      if (!info || (info.type !== 'saved' && info.type !== 'annotate')) dataDirty = true;
    });
  }

  // ------------------------------------------------------------------ small helpers

  function cur() { return GT.store.course(); }
  function res() { return GT.store.results(); }
  function isActiveView() { return !!boundEl && document.body.contains(boundEl) && !!dom && !!dom.table; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function plural(n, word, pl) { return n + ' ' + (n === 1 ? word : (pl || word + 's')); }
  function nowMs() { return Date.now(); }

  function decimalsOf(course) {
    var d = course && course.settings ? course.settings.decimals : 2;
    return typeof d === 'number' && d >= 0 && d <= 6 ? d : 2;
  }

  function num(x, d) { return util.formatNumber(x, d); }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function studentLabel(s) {
    return 'Student No ' + (s && typeof s.no === 'number' ? s.no : '?');
  }

  /** Text of a stored entry as entered ('' when empty). */
  function entryText(e) {
    if (!e) return '';
    if (typeof e.value === 'number') return String(e.value);
    if (typeof e.text === 'string') return e.text;
    return '';
  }

  function detailText(d) {
    if (!d) return '';
    if (d.state === 'number') return String(d.raw);
    if (d.state === 'invalid') return d.text || '';
    return '';
  }

  /** The late penalty in points that weeksLate/waived carry on this item (calc.latePenalty), also for an
   * empty or invalid score, which calc does not deduct from yet (the penalty applies once a score is in). */
  function latePenaltyOf(course, a, weeks, waived) {
    return calc.latePenalty({ weeksLate: weeks, waived: !!waived }, a, course.settings);
  }

  /** The late badge of a raw cell: "L2" (penalty applied) or "L2✓" (waived, the L struck through).
   * The visible text is hidden from screen readers; they get the words instead. */
  function lateBadgeHtml(weeks, waived) {
    return '<span class="mk-late' + (waived ? ' is-waived' : '') + '" aria-hidden="true">' + (waived ? '<s>L</s>' : 'L') + weeks +
      (waived ? '✓' : '') + '</span><span class="sr-only">' + plural(weeks, 'week') + ' late' + (waived ? ', penalty waived' : '') + ', </span>';
  }

  function getPrefs() {
    var p = (GT.store.state && GT.store.state.ui && GT.store.state.ui.gridPrefs) || {};
    var out = {
      sort: p.sort === 'total' ? 'total' : 'name',
      dir: p.dir === 'desc' ? 'desc' : 'asc',
      group: p.group === true,
      showWithdrawn: p.showWithdrawn !== false,
      meeting: p.meeting === true,
      meetingPrev: typeof p.meetingPrev === 'string' ? p.meetingPrev : '',
      legend: p.legend === true,  // the legend is folded behind its button unless opened (UX-13)
      cols: {}
    };
    // Grouping by team is off in the Meeting view (it lists everyone by total, without the Team column).
    out.grouped = out.group && !out.meeting;
    var pc = util.isPlainObject(p.cols) ? p.cols : {};
    COL_TOGGLES.forEach(function (t) { out.cols[t.key] = pc[t.key] !== false; });
    return out;
  }

  function setPrefs(patch) {
    var p = getPrefs();
    delete p.grouped;
    Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    GT.store.setUi({ gridPrefs: p });
  }

  function attendanceAvailable(course) {
    return !!(course && course.attendance && course.attendance.mode !== 'off' &&
      GT.attendance && typeof GT.attendance.summary === 'function');
  }

  function attSummary(course, sid) {
    try { return GT.attendance.summary(course, sid) || null; } catch (e) { return null; }
  }

  /** Attendance summary by student id for one pass over many rows (a render, a copied range).
   * GT.attendance.courseSummary() finds the held sessions once for everyone; summary() per row would rescan
   * every student's marks for each row (quadratic: about 45 ms at 300 students). Computed on first use;
   * a student missing from it falls back to summary(). */
  function attLookup(course) {
    var byStudent = null;
    var cache = Object.create(null);
    return function (sid) {
      if (byStudent === null) {
        byStudent = false;
        if (typeof GT.attendance.courseSummary === 'function') {
          try { byStudent = GT.attendance.courseSummary(course).byStudent || false; } catch (e) { byStudent = false; }
        }
      }
      if (byStudent && Object.prototype.hasOwnProperty.call(byStudent, sid)) return byStudent[sid] || null;
      if (!(sid in cache)) cache[sid] = attSummary(course, sid);
      return cache[sid];
    };
  }

  function whole(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

  // ------------------------------------------------------------------ final letters, drop-down lists, lock
  // The core helpers (model.setFinalLetter(s), copySuggestedToFinal, finalize, unfinalize, isFinalized,
  // choiceValues, isChoiceValue; calc's finalLetter / letterDiffers / orderIssues / letterSummary /
  // notOnList) are used when present. The small fallbacks below only keep the grid working if a core
  // file is older than this view.

  function isFinalized(course) {
    if (!course) return false;
    if (typeof model.isFinalized === 'function') {
      try { return !!model.isFinalized(course); } catch (e) { /* fall back */ }
    }
    return !!(course.finalized && typeof course.finalized === 'object');
  }

  /** Letters of the course scale, highest first (model.scaleLetters: the Final letter drop-down order). */
  function scaleLetters(course) {
    if (typeof model.scaleLetters === 'function') {
      try { return model.scaleLetters(course); } catch (e) { /* fall back */ }
    }
    return ((course && course.settings && course.settings.letterScale) || []).slice()
      .sort(function (a, b) { return b.min - a.min; }).map(function (x) { return x.letter; });
  }

  function storedFinal(s) {
    return s && typeof s.finalLetter === 'string' && s.finalLetter !== '' ? s.finalLetter : null;
  }

  /** { letter|null, valid, differs, suggested } for a student, from calc when it reports them. */
  function finalInfo(s, rs, letterSet) {
    var fl = rs && rs.finalLetter !== undefined ? rs.finalLetter : storedFinal(s);
    if (fl === undefined || fl === '') fl = null;
    var suggested = rs ? rs.letter : '';
    var valid = rs && typeof rs.finalLetterValid === 'boolean' ? rs.finalLetterValid : (fl === null || !!letterSet[fl]);
    var differs = rs && typeof rs.letterDiffers === 'boolean' ? rs.letterDiffers : (fl !== null && fl !== suggested);
    return { letter: fl, valid: valid, differs: differs, suggested: suggested };
  }

  /** The drop-down values of an assessment (max, max − step, …, 0), or [] for free entry. */
  function choiceValues(a) {
    if (!a || !a.choices) return [];
    if (typeof model.choiceValues === 'function') {
      try {
        var v = model.choiceValues(a);
        if (Array.isArray(v)) return v;
      } catch (e) { /* fall back */ }
    }
    var step = a.choices.step, max = a.maxScore, out = [];
    if (!(step > 0) || !(max > 0) || max / step > 200) return out;
    for (var k = 0; k <= 200; k++) {
      var x = util.fix(max - k * step);
      if (x < 0) break;
      out.push(x);
    }
    if (out[out.length - 1] !== 0) out.push(0);
    return out;
  }

  function isChoiceValue(a, list, v) {
    if (typeof model.isChoiceValue === 'function') {
      try { return !!model.isChoiceValue(a, v); } catch (e) { /* fall back */ }
    }
    var fv = util.fix(v);
    return list.some(function (x) { return util.fix(x) === fv; });
  }

  /** "0–5 in steps of 0.5" */
  function choiceRange(a, list) {
    if (!list.length) return '';
    var step = a.choices && a.choices.step > 0 ? a.choices.step : null;
    return num(list[list.length - 1], 4) + '–' + num(list[0], 4) + (step ? ' in steps of ' + num(step, 4) : '');
  }

  /** Canonical letter for typed or pasted text: { empty } | { letter } | { bad }. Case-insensitive;
   * spaces are ignored and a typographic minus or dash counts as "-". */
  function matchLetter(course, text) {
    var raw = String(text === null || text === undefined ? '' : text);
    if (raw.trim() === '') return { empty: true };
    if (typeof model.matchLetter === 'function') {
      try {
        var m = model.matchLetter(course, raw);
        return m ? { letter: m } : { bad: true };
      } catch (e) { /* fall back */ }
    }
    var t = raw.replace(/[‐-―−]/g, '-').replace(/\s+/g, '').toLowerCase();
    var letters = scaleLetters(course);
    for (var i = 0; i < letters.length; i++) {
      if (letters[i].replace(/\s+/g, '').toLowerCase() === t) return { letter: letters[i] };
    }
    return { bad: true };
  }

  /** A typed or pasted value for a drop-down score cell: { empty } | { value } | { bad }. */
  function matchChoice(a, list, text) {
    var p = util.parseScoreInput(text, a ? a.maxScore : undefined);
    if (p.kind === 'empty') return { empty: true };
    if (p.kind === 'number' && isChoiceValue(a, list, p.value)) return { value: util.fix(p.value) };
    return { bad: true };
  }

  /** Writes final letters inside a transaction. pairs: [{ studentId, letter|null }] (validated).
   * Returns the number changed. */
  function writeFinalLetters(c, pairs) {
    if (typeof model.setFinalLetters === 'function') {
      var r = model.setFinalLetters(c, pairs);
      return typeof r === 'number' ? r : (r && typeof r.changed === 'number' ? r.changed : 0);
    }
    var ok = Object.create(null), n = 0;
    scaleLetters(c).forEach(function (l) { ok[l] = true; });
    pairs.forEach(function (p) {
      var st = model.findStudent(c, p.studentId);
      if (!st || (p.letter !== null && !ok[p.letter])) return;
      if (storedFinal(st) === p.letter) return;
      st.finalLetter = p.letter;
      n++;
    });
    return n;
  }

  /** Letter-order problems (calc.orderIssues, or computed here): id -> { above: [ids], below: [ids] }.
   * above = students with a higher total but a lower final letter; below = the reverse. */
  function orderIssueMap(course, results) {
    var list = Array.isArray(results.orderIssues) ? results.orderIssues : null;
    if (!list) {
      list = [];
      var rank = Object.create(null);
      scaleLetters(course).forEach(function (l, i) { rank[l] = i; });
      var act = course.students.filter(function (s) {
        var r = results.byId[s.id], fl = storedFinal(s);
        return s.status !== 'withdrawn' && fl !== null && rank[fl] !== undefined && r && typeof r.total === 'number' && isFinite(r.total);
      }).map(function (s) { return { id: s.id, t: util.fix(results.byId[s.id].total), k: rank[storedFinal(s)] }; });
      act.sort(function (x, y) { return y.t - x.t; });
      for (var i = 0; i < act.length; i++) {
        for (var j = i + 1; j < act.length; j++) {
          if (act[i].t > act[j].t && act[j].k < act[i].k) list.push({ higherTotalId: act[i].id, lowerTotalId: act[j].id });
        }
      }
    }
    var map = Object.create(null);
    var get = function (id) { return map[id] || (map[id] = { above: [], below: [] }); };
    list.forEach(function (p) {
      if (!p) return;
      get(p.lowerTotalId).above.push(p.higherTotalId);
      get(p.higherTotalId).below.push(p.lowerTotalId);
    });
    return { map: map, count: list.length, first: list[0] || null };
  }

  /** { assigned, unassigned, invalid, active } over active students. invalid: final letters that are
   * not letters of the current scale (kept, shown in red; the scale changed after they were chosen). */
  function letterSummary(course, results) {
    var nActive = results.activeIds.length;
    var ls = results.letterSummary;
    if (ls && typeof ls.unassigned === 'number') {
      return {
        unassigned: ls.unassigned, assigned: Math.max(0, nActive - ls.unassigned), active: nActive,
        invalid: typeof ls.invalid === 'number' ? ls.invalid : countInvalidLetters(course)
      };
    }
    var un = 0;
    course.students.forEach(function (s) { if (s.status !== 'withdrawn' && storedFinal(s) === null) un++; });
    return { unassigned: un, assigned: nActive - un, active: nActive, invalid: countInvalidLetters(course) };
  }

  /** True when the student's stored final letter is not a letter of the course's scale. */
  function invalidFinal(course, s, letterSet) {
    var fl = storedFinal(s);
    return fl !== null && !letterSet[fl];
  }

  function letterSetOf(course) {
    var set = Object.create(null);
    scaleLetters(course).forEach(function (l) { set[l] = true; });
    return set;
  }

  function countInvalidLetters(course) {
    var set = letterSetOf(course), n = 0;
    course.students.forEach(function (s) { if (s.status !== 'withdrawn' && invalidFinal(course, s, set)) n++; });
    return n;
  }

  function lockedCol(course, col) {
    return !!col && !!col.edit && col.kind !== 'final' && isFinalized(course);
  }

  function notifyLocked() {
    if (nowMs() - lockedToastAt < 3000) return;
    lockedToastAt = nowMs();
    ui.toast(LOCKED_MSG, { type: 'info', timeout: 5000, action: { label: 'Unlock…', fn: unlockScores } });
  }

  // Toasts stack at the bottom right, over the Final letter column where the meeting works. The grid's
  // step-by-step messages (finalize, band assignment) replace each other instead of piling up, and
  // the stack moves to the bottom left while it would cover the active cell (dodgeToasts).
  var lastGridToast = null;
  var TOASTS_LEFT = 'gt-toasts-left';
  var TOAST_READ_MS = 1500;  // a toast shown at least this long may give way to the cell being worked on

  function gridToast(msg, opts) {
    if (lastGridToast) lastGridToast();
    lastGridToast = ui.toast(msg, opts) || null;
    dodgeToasts();
    return lastGridToast;
  }

  /** Keeps the toasts off what the user is working on: the active cell and its open list or hint.
   * The stack moves to the other side; when both sides cover it (a phone), a plain success or info
   * toast that has been on screen for a while is closed (warnings, and toasts with a button, stay). */
  function dodgeToasts() {
    var host = document.getElementById('toasts');
    if (!host) return;
    var a = isActiveView() && layout ? posOf(sel.active) : null;
    var td = a ? cellAt(a.r, a.c) : null;
    if (!td || !host.children.length) { host.classList.remove(TOASTS_LEFT); return; }
    var work = [td];
    if (editing && editing.td === td) work.push(editing.input, editing.hint);
    var rects = work.filter(function (el) { return el && el.isConnected; }).map(function (el) { return el.getBoundingClientRect(); });
    var covering = function () {
      return Array.prototype.filter.call(host.children, function (t) {
        var r = t.getBoundingClientRect();
        return rects.some(function (c) { return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top; });
      });
    };
    if (!covering().length) return;
    var left = host.classList.contains(TOASTS_LEFT);
    host.classList.toggle(TOASTS_LEFT, !left);
    if (!covering().length) return;
    host.classList.toggle(TOASTS_LEFT, left); // covered on both sides: keep the usual place
    covering().forEach(function (t) {
      var plain = /(^|\s)(success|info)(\s|$)/.test(t.className) && !t.querySelector('button');
      if (plain && t.__gtAt && nowMs() - t.__gtAt >= TOAST_READ_MS && t.parentNode) t.parentNode.removeChild(t);
    });
  }

  // True when the last transact() below did not go through: the callers skip their "done" message.
  var txFailed = false;
  var conflictToastAt = 0;

  function transact(label, fn, opts) {
    txFailed = false;
    try {
      return GT.store.transact(label, fn, opts);
    } catch (err) {
      txFailed = true;
      if (err && err.conflict) {
        // Another tab saved newer data: this tab is read-only (store.js). Expected, so no console error;
        // one message, not one per keystroke.
        if (nowMs() - conflictToastAt > 1500) {
          conflictToastAt = nowMs();
          ui.toast('Not saved: ' + (err.message || 'Grade Tracker was changed in another tab. Reload to see the latest data.'), { type: 'warn', timeout: 7000 });
        }
        return undefined;
      }
      if (root.console) console.error(err);
      ui.toast('Could not save the change: ' + (err && err.message ? err.message : String(err)), { type: 'error' });
      return undefined;
    }
  }

  // ------------------------------------------------------------------ columns and rows

  /** The placeholder key behind an assessment's weight, or null. */
  function weightPlaceholderKey(a) {
    if (a.id === 'a_paper') return 'termPaperWeight';
    return a.category === 'project' ? 'projectSplit' : null;
  }

  // Header text widths, measured with the page font (canvas), so a header word is never split
  // mid-word and the "max 100 · 10%" lines are not cut off. Falls back to an estimate.
  var measure = { ctx: null, family: '', cache: Object.create(null) };
  function textWidth(text, weight, size) {
    var s = String(text);
    var key = weight + '/' + size + '/' + s;
    if (measure.cache[key] !== undefined) return measure.cache[key];
    if (measure.ctx === null) {
      measure.ctx = false;
      try {
        var cv = document.createElement('canvas');
        measure.ctx = (cv.getContext && cv.getContext('2d')) || false;
        measure.family = root.getComputedStyle(document.body).fontFamily || 'sans-serif';
      } catch (e) { measure.ctx = false; }
    }
    var w = s.length * size * 0.64;
    if (measure.ctx) {
      measure.ctx.font = weight + ' ' + size + 'px ' + measure.family;
      w = measure.ctx.measureText(s).width;
    }
    return (measure.cache[key] = Math.ceil(w));
  }

  /** Width (px) the cells of a raw column need for their late badges: per assessment id, the widest row
   * with a badge (padding, the team or override marker, the "L2✓" badge and the score as shown).
   * Columns without late work are not in the map. fontSize: the body text size (13, Meeting view 15). */
  function lateNeeds(course, results, fontSize) {
    var out = Object.create(null);
    if (!results || !results.byId) return out;
    course.students.forEach(function (s) {
      var r = results.byId[s.id];
      if (!r) return;
      course.assessments.forEach(function (a) {
        var d = r.items[a.id];
        if (!d || !(d.weeksLate > 0)) return;
        var badge = Math.max(18, textWidth('L' + d.weeksLate + (d.waived ? '✓' : ''), 700, 10.5) + 10) + 1; // css: .mk-late
        var marker = d.source === 'team' ? 16 : d.source === 'override' ? 12 : 0; // marker plus the badge's margin after it
        var text = d.state === 'number' ? String(d.raw) : d.state === 'invalid' ? String(d.text || '') : '–';
        var need = 16 + 4 + marker + badge + textWidth(text, d.state === 'number' && !d.outOfRange && !d.notOnList ? 400 : 600, fontSize);
        if (!(out[a.id] >= need)) out[a.id] = need;
      });
    });
    return out;
  }

  /** Meeting view: { last, first } column widths that fit the longest names shown (15px, weight 550, as
   * css/grid.css draws them), never wider than WM nor narrower than their headers. A withdrawn
   * student's first name may shrink to a few letters next to its "W" badge (as it does next to the
   * "Withdrawn" badge in the other view). */
  function meetingNameWidths(course, prefs) {
    var CELL = 20;                         // 2 × 8 px padding, the border and slack
    var nameW = function (t) { return textWidth(t, 550, 15); };
    var last = textWidth('Last Name', 700, 12) + 16 + HEAD_PAD_MEET;   // with the sort arrow
    var first = textWidth('First Name', 700, 12) + HEAD_PAD_MEET;
    var badge = textWidth('W', 650, 10) + 10 + 2 + 2 + 2;            // .wd-badge: padding, border, margin, gap
    course.students.forEach(function (s) {
      var wd = s.status === 'withdrawn';
      if (wd && !prefs.showWithdrawn) return;
      last = Math.max(last, nameW(s.lastName || '(no last name)') + CELL);
      first = Math.max(first, wd ? Math.min(nameW(s.firstName || ''), 24) + badge + CELL : nameW(s.firstName || '') + CELL);
    });
    return { last: clamp(Math.ceil(last), 72, WM.last), first: clamp(Math.ceil(first), 72, WM.first) };
  }

  function buildColumns(course, prefs, results) {
    var meet = prefs.meeting;
    var locked = isFinalized(course);
    var late = lateNeeds(course, results, meet ? 15 : 13);
    var w = meet ? WM : W;
    var pad = meet ? HEAD_PAD_MEET : HEAD_PAD;
    var names = meet ? meetingNameWidths(course, prefs) : w;
    var cols = [
      { key: 'no', kind: 'no', label: 'No', edit: 'text', sticky: 1, width: w.no, num: true },
      { key: 'last', kind: 'last', label: 'Last Name', edit: 'text', sticky: 2, width: names.last },
      { key: 'first', kind: 'first', label: 'First Name', edit: 'text', sticky: 3, width: names.first }
    ];
    if (!meet) cols.push({ key: 'team', kind: 'team', label: 'Team', edit: 'team', sticky: 4, width: W.team });
    // Header names (bold 12px) wrap at spaces, so a column needs room for its longest word; the
    // small lines under the name (11px) do not wrap.
    var nameW = function (text) { return textWidth(text, 700, 12); };
    var subW = function (text) { return textWidth(text, 500, 11); };
    var longestWordW = function (text) {
      return String(text).split(/\s+/).reduce(function (m, x) { return Math.max(m, nameW(x)); }, 0);
    };
    var badgeW = function (key) { return key && !model.isConfirmed(course, key) ? BADGE_W : 0; };
    var rawWidth = function (a, list) {
      // Meeting view: the maxScores badge may wrap under "max 100" (css/grid.css), and "fill in the
      // meeting" wraps at its spaces.
      var maxLine = subW('max ' + num(a.maxScore, 4) + (list.length ? ' · list' : '')) + (meet ? 0 : badgeW('maxScores'));
      // "10% · team" may wrap before "· team" (css/grid.css .hs-w).
      var weightLine = Math.max(subW(num(a.weight, 4) + '%') + badgeW(weightPlaceholderKey(a)), a.teamGraded ? subW('· team') : 0);
      // Meeting view: a short name that ends with a short word stays on one line ("Project" / "I" would
      // read badly); "Term Paper" may wrap at its space.
      var name = meet && String(a.name).length <= 12 && /(^|\s)\S{1,3}$/.test(String(a.name).trim()) ? nameW(a.name) : longestWordW(a.name);
      // A column with late work makes room for the "L2✓" badge next to the score (only as much as it needs,
      // so the Meeting view still fits at 1280 px).
      return Math.max(clamp(Math.max(name, maxLine, weightLine) + pad, 64, 164), late[a.id] ? Math.min(Math.ceil(late[a.id]), 200) : 0);
    };
    // Weighted headers read "Project I 10%": a short name stays on one line, the weight may wrap.
    var weightedWidth = function (a) {
      var name = String(a.name).length <= 12 ? nameW(a.name) : longestWordW(a.name);
      var weight = nameW(num(a.weight, 4) + '%') + badgeW(weightPlaceholderKey(a));
      return clamp(Math.max(name, weight, subW('weighted')) + HEAD_PAD, 56, 150);
    };
    var rawCol = function (a, i) {
      var list = choiceValues(a);
      return {
        key: 'raw:' + a.id, kind: 'raw', aid: a.id, a: a, label: a.name, edit: list.length ? 'choice' : 'score',
        dd: list.length > 0, choices: list, group: Math.min(i + 1, 6), width: rawWidth(a, list), num: true,
        // Participation is filled in the meeting (locked, like every score, once finalized).
        toFill: meet && a.category === 'participation' && !locked
      };
    };
    var simple = function (key, kind, label, width, extra) {
      var c = { key: key, kind: kind, label: label, width: width };
      Object.keys(extra || {}).forEach(function (k) { c[k] = extra[k]; });
      return c;
    };
    // Meeting view: the letterScale badge may wrap under "Suggested".
    var suggested = simple('letter', 'letter', 'Suggested', meet
      ? Math.max(64, nameW('Suggested'), subW('from cutoffs')) + pad
      : Math.max(64, nameW('Suggested') + badgeW('letterScale') + HEAD_PAD), { ro: true });
    var finalCol = simple('final', 'final', 'Final letter', meet ? WM.final : 86, { edit: 'letter', dd: true, toFill: meet });
    var total = simple('total', 'total', 'Total', w.total, { ro: true, num: true });
    var rank = simple('rank', 'rank', 'Rank', w.rank, { ro: true, num: true });
    var att = [];
    if (attendanceAvailable(course)) {
      // Header: the name, then a small line under it: "Excused" / "(allowed)", "Unexcused" / "(not allowed)",
      // "Total" / "absences" (the small line is kept on one line).
      var attW = function (a1, a2) { return clamp(Math.max(nameW(a1), subW(a2)) + pad, 58, 130); };
      if (prefs.cols.attExcused) att.push(simple('att:exc', 'attExc', 'Excused (allowed)', attW('Excused', '(allowed)'), { ro: true, num: true }));
      if (prefs.cols.attUnexcused) att.push(simple('att:unx', 'attUnx', 'Unexcused (not allowed)', attW('Unexcused', '(not allowed)'), { ro: true, num: true }));
      if (prefs.cols.attTotal) att.push(simple('att:tot', 'attTot', 'Total absences', attW('Total', 'absences'), { ro: true, num: true }));
    }
    var raws = course.assessments.map(rawCol);
    if (meet) {
      // Meeting view: scores, Total, absences, then what the instructor decides in the meeting
      // (participation and the final letter), next to the suggestion and the rank.
      var part = raws.filter(function (c) { return c.a.category === 'participation'; });
      cols = cols.concat(raws.filter(function (c) { return c.a.category !== 'participation'; }));
      cols.push(total);
      cols = cols.concat(att, part);
      finalCol.pinR = 2;
      rank.pinR = 1;
      cols.push(suggested, finalCol, rank);
    } else {
      cols = cols.concat(raws);
      if (prefs.cols.weighted) {
        course.assessments.forEach(function (a, i) {
          cols.push({ key: 'w:' + a.id, kind: 'weighted', aid: a.id, a: a, label: a.name + ' ' + num(a.weight, 4) + '%',
            ro: true, group: Math.min(i + 1, 6), width: weightedWidth(a), num: true });
        });
      }
      cols.push(total, suggested, finalCol, rank);
      if (prefs.cols.percentile) cols.push(simple('pct', 'pct', 'Percentile', W.pct, { ro: true, num: true }));
      if (prefs.cols.diff) cols.push(simple('diff', 'diff', '±Avg', W.diff, { ro: true, num: true }));
      cols = cols.concat(att);
    }
    var maxPin = 0;
    cols.forEach(function (c) { if (c.pinR > maxPin) maxPin = c.pinR; });
    cols.forEach(function (c, i) {
      c.index = i;
      c.pinCls = c.pinR ? ' pr pr' + c.pinR + (c.pinR === maxPin ? ' pr-first' : '') : '';
    });
    return cols;
  }

  function matches(s, q, teamName) {
    if (!q) return true;
    var last = (s.lastName || '').toLowerCase(), first = (s.firstName || '').toLowerCase();
    if (last.indexOf(q) !== -1 || first.indexOf(q) !== -1) return true;
    if ((last + ', ' + first).indexOf(q) !== -1 || (first + ' ' + last).indexOf(q) !== -1) return true;
    if (typeof s.no === 'number' && String(s.no) === q) return true;
    return !!teamName && teamName.toLowerCase().indexOf(q) !== -1;
  }

  /** Filters and (when grouping) arranges an ordered student list into table items. */
  function arrange(course, list, prefs, teamById) {
    var q = searchText.trim().toLowerCase();
    var visible = list.filter(function (s) {
      if (!prefs.showWithdrawn && s.status === 'withdrawn') return false;
      var t = s.teamId ? teamById[s.teamId] : null;
      return matches(s, q, t ? t.name : '');
    });
    var items = [], students = [];
    var push = function (s) { items.push({ type: 'student', s: s, r: students.length }); students.push(s); };
    if (prefs.grouped) {
      var buckets = Object.create(null);
      visible.forEach(function (s) {
        var k = s.teamId && teamById[s.teamId] ? s.teamId : '';
        (buckets[k] = buckets[k] || []).push(s);
      });
      course.teams.forEach(function (t) {
        if (!buckets[t.id]) return;
        items.push({ type: 'team', team: t });
        buckets[t.id].forEach(push);
      });
      if (buckets['']) {
        items.push({ type: 'team', team: null });
        buckets[''].forEach(push);
      }
    } else {
      visible.forEach(push);
    }
    return { items: items, students: students, shown: visible.length };
  }

  /** What the row-order snapshot depends on. The search and the withdrawn filter are not part of it:
   * arrange() filters the snapshot, so clearing a search shows the rows in their old places (E2E-3). */
  function orderSig(prefs) {
    return [prefs.sort, prefs.dir, prefs.grouped, prefs.meeting].join('|');
  }

  /** The course's row-order snapshot (DECISIONS 7), as student ids: a fresh sort when there is none yet,
   * the sort, grouping or Meeting view changed, or on "re-sort"; otherwise the old order, without the
   * students that are gone and with new students appended at the end (in the fresh order). */
  function orderIds(course, fresh, prefs) {
    var sig = orderSig(prefs);
    var snap = orders[course.id];
    if (forceResort || !snap || snap.sig !== sig) {
      snap = orders[course.id] = { sig: sig, ids: fresh.map(function (s) { return s.id; }) };
      return snap.ids;
    }
    var have = Object.create(null), seen = Object.create(null);
    course.students.forEach(function (s) { have[s.id] = true; });
    var ids = snap.ids.filter(function (id) { return have[id] === true && (seen[id] = true); });
    fresh.forEach(function (s) { if (!seen[s.id]) ids.push(s.id); });
    snap.ids = ids;
    return ids;
  }

  function buildLayout(course, results, prefs) {
    var cols = buildColumns(course, prefs, results);
    var teamById = Object.create(null);
    course.teams.forEach(function (t) { teamById[t.id] = t; });
    var fresh = calc.sortStudents(course, results, prefs.sort, prefs.dir);
    var ids = orderIds(course, fresh, prefs);
    forceResort = false;
    var byId = Object.create(null);
    course.students.forEach(function (s) { byId[s.id] = s; });
    var snap = ids.map(function (id) { return byId[id]; }).filter(Boolean);
    var got = arrange(course, snap, prefs, teamById);
    var want = arrange(course, fresh, prefs, teamById);
    var stale = got.students.length !== want.students.length || got.students.some(function (s, i) { return s !== want.students[i]; });
    var rowOfSid = Object.create(null), colOfKey = Object.create(null);
    got.students.forEach(function (s, i) { rowOfSid[s.id] = i; });
    cols.forEach(function (c, i) { colOfKey[c.key] = i; });
    var nId = 0;
    cols.forEach(function (c) { if (c.sticky) nId++; });
    return {
      cols: cols, students: got.students, items: got.items, rowOfSid: rowOfSid, colOfKey: colOfKey,
      teamById: teamById, shown: got.shown, total: course.students.length, prefs: prefs, stale: stale, nId: nId
    };
  }

  // ------------------------------------------------------------------ selection model

  function posOf(ref) {
    if (!ref || !layout) return null;
    var r = layout.rowOfSid[ref.sid], c = layout.colOfKey[ref.key];
    if (r === undefined || c === undefined) return null;
    return { r: r, c: c };
  }

  function refAt(r, c) {
    return { sid: layout.students[r].id, key: layout.cols[c].key };
  }

  function rectOf() {
    var a = posOf(sel.active);
    if (!a) return null;
    var e = posOf(sel.end) || a;
    return { r1: Math.min(a.r, e.r), r2: Math.max(a.r, e.r), c1: Math.min(a.c, e.c), c2: Math.max(a.c, e.c) };
  }

  function hasRange() {
    var rc = rectOf();
    return !!rc && (rc.r1 !== rc.r2 || rc.c1 !== rc.c2);
  }

  /** The cells a range covers (student ids and column keys), or null without a range. The range is
   * stored as two corner cells, so it only means the same cells while the rows between the corners
   * stay the same. */
  function rangeSignature() {
    if (!layout || !hasRange()) return null;
    var rc = rectOf();
    var ids = layout.students.slice(rc.r1, rc.r2 + 1).map(function (s) { return s.id; }).sort();
    var keys = layout.cols.slice(rc.c1, rc.c2 + 1).map(function (c) { return c.key; });
    return ids.join('\n') + '|' + keys.join('\n');
  }

  function inRect(r, c) {
    var rc = rectOf();
    return !!rc && r >= rc.r1 && r <= rc.r2 && c >= rc.c1 && c <= rc.c2;
  }

  function cellAt(r, c) {
    var tr = rowEls[r];
    return tr ? tr.cells[c] || null : null;
  }

  function defaultCol() {
    for (var i = 0; i < layout.cols.length; i++) if (layout.cols[i].kind === 'raw') return i;
    return 0;
  }

  /** After a rebuild: keep the active cell on the same student and column when still visible. */
  function normalizeSelection() {
    if (!layout.students.length) return;
    if (!posOf(sel.active)) {
      var r = sel.active ? layout.rowOfSid[sel.active.sid] : undefined;
      var c = sel.active ? layout.colOfKey[sel.active.key] : undefined;
      if (r === undefined) r = clamp(sel.lastR || 0, 0, layout.students.length - 1);
      if (c === undefined) c = defaultCol();
      sel.active = refAt(r, c);
      sel.end = sel.active;
    }
    if (!posOf(sel.end)) sel.end = sel.active;
  }

  function paintSelection() {
    var i;
    for (i = 0; i < painted.range.length; i++) {
      painted.range[i].classList.remove('in-range');
      painted.range[i].removeAttribute('aria-selected');
    }
    painted.range = [];
    var a = posOf(sel.active);
    var td = a ? cellAt(a.r, a.c) : null;
    // Roving tabindex: the previous cell keeps tabindex -1. Removing it outright would make a focused
    // cell unfocusable, and the browser would then blur it (focus would drop to <body>).
    if (painted.active && painted.active !== td) {
      painted.active.classList.remove('is-active');
      painted.active.setAttribute('tabindex', '-1');
    }
    if (painted.head) painted.head.classList.remove('hdr-active');
    if (painted.row) painted.row.classList.remove('row-active');
    painted.active = painted.head = painted.row = null;
    if (!a) { placeDropButton(null, null); return; }
    var rc = rectOf();
    if (rc.r1 !== rc.r2 || rc.c1 !== rc.c2) {
      for (var r = rc.r1; r <= rc.r2; r++) {
        var tr = rowEls[r];
        if (!tr) continue;
        for (var c = rc.c1; c <= rc.c2; c++) {
          var cell = tr.cells[c];
          if (!cell) continue;
          cell.classList.add('in-range');
          cell.setAttribute('aria-selected', 'true');
          painted.range.push(cell);
        }
      }
    }
    if (td) {
      td.classList.add('is-active');
      td.setAttribute('tabindex', '0');
      painted.active = td;
    }
    placeDropButton(td, layout.cols[a.c]);
    var th = dom.table.tHead && dom.table.tHead.rows[0] ? dom.table.tHead.rows[0].cells[a.c] : null;
    if (th) { th.classList.add('hdr-active'); painted.head = th; }
    if (rowEls[a.r]) { rowEls[a.r].classList.add('row-active'); painted.row = rowEls[a.r]; }
    sel.lastR = a.r;
  }

  /** The ▾ button of the active drop-down cell (Final letter, participation): a click opens the list,
   * like Alt+Down. One element, moved with the active cell. */
  function placeDropButton(td, col) {
    if (ddBtn && ddBtn.parentNode && ddBtn.parentNode !== td) {
      ddBtn.parentNode.classList.remove('has-dd');
      ddBtn.parentNode.removeChild(ddBtn);
    }
    if (!td || !col || !col.dd || lockedCol(cur(), col)) return;
    if (!ddBtn) {
      ddBtn = document.createElement('button');
      ddBtn.type = 'button';
      ddBtn.className = 'dd-btn';
      ddBtn.setAttribute('data-act', 'dd-open');
      ddBtn.setAttribute('tabindex', '-1');
      ddBtn.setAttribute('aria-hidden', 'true');
      ddBtn.title = 'Choose from the list (Alt+Down)';
    }
    if (ddBtn.parentNode !== td) td.appendChild(ddBtn);
    td.classList.add('has-dd');
  }

  function focusCell(td) {
    if (!td) return;
    if (!td.hasAttribute('tabindex')) td.setAttribute('tabindex', '-1');
    // Already focused: focus() would still bring style and layout up to date first (E2E-7).
    if (document.activeElement === td) return;
    try { td.focus({ preventScroll: true }); } catch (e) { td.focus(); }
  }

  function focusActive() {
    var a = posOf(sel.active);
    if (a) focusCell(cellAt(a.r, a.c));
  }

  /** Puts focus back on the active cell (after a dialog or menu), now and on the next re-render. */
  function refocusGrid() {
    focusUntil = nowMs() + 1500;
    var ae = document.activeElement;
    if (!ae || ae === document.body || (dom && dom.table && dom.table.contains(ae))) focusActive();
  }

  /** Publishes the grid's page offset as --grid-top, so css/grid.css can size the scroll box to end
   * above the bottom of the window (the class-average footer and the horizontal scrollbar stay in
   * view) whatever the banners, toolbar and legend above it take. Runs once per frame at most. */
  var wrapTopQueued = false;
  function syncWrapTop() {
    if (!dom || !dom.wrap || !dom.wrap.isConnected) return;
    var top = Math.round(dom.wrap.getBoundingClientRect().top + (root.pageYOffset || 0));
    if (top !== dom.gridTop) {
      dom.gridTop = top;
      dom.wrap.style.setProperty('--grid-top', top + 'px');
    }
  }
  function queueWrapTop() {
    if (wrapTopQueued) return;
    wrapTopQueued = true;
    (root.requestAnimationFrame || setTimeout)(function () {
      wrapTopQueued = false;
      syncWrapTop();
    });
  }

  /** Right edge of the identity columns pinned on the left. On phones (css/grid.css) the First Name
   * and Team headers are sticky only vertically (left: auto), so they do not count. */
  function stickyRight() {
    var row = dom.table.tHead && dom.table.tHead.rows[0];
    if (!row) return 0;
    // A column counts only when its body cells are pinned too (a header can be sticky on its own).
    var body = dom.table.querySelector('tbody tr.gr');
    var right = 0;
    for (var i = 0; i < 4 && i < row.cells.length; i++) {
      var th = row.cells[i], cs = root.getComputedStyle(th);
      if (cs.position !== 'sticky' || cs.left === 'auto') continue;
      var td = body ? body.querySelector('td[data-c="' + th.getAttribute('data-c') + '"]') : null;
      if (td && root.getComputedStyle(td).position !== 'sticky') continue;
      right = th.getBoundingClientRect().right;
    }
    return right;
  }

  /** Left edge of the columns pinned on the right (Meeting view: Final letter and Rank), or null when
   * none is pinned (other views, phones and print, where css/grid.css leaves them in place). */
  function pinnedLeft() {
    var row = dom.table.tHead && dom.table.tHead.rows[0];
    var th = row ? row.querySelector('th.pr-first') : null;
    if (!th || root.getComputedStyle(th).right === 'auto') return null;
    return th.getBoundingClientRect().left;
  }

  /** Scrolls the grid (and, if needed, the page) so the cell is fully visible below the sticky
   * header, above the sticky footer, right of the sticky identity columns and left of the columns
   * pinned on the right. */
  function ensureVisible(td) {
    if (!td || !dom || !dom.wrap) return;
    var wrap = dom.wrap;
    var wr = wrap.getBoundingClientRect(), cr = td.getBoundingClientRect();
    var head = dom.table.tHead ? dom.table.tHead.getBoundingClientRect().height : 0;
    var foot = dom.table.tFoot ? dom.table.tFoot.getBoundingClientRect().height : 0;
    var top = wr.top + wrap.clientTop + head;
    var bottom = wr.top + wrap.clientTop + wrap.clientHeight - foot;
    if (cr.top < top) wrap.scrollTop -= (top - cr.top);
    else if (cr.bottom > bottom) wrap.scrollTop += (cr.bottom - bottom);
    if (root.getComputedStyle(td).position !== 'sticky') {
      var left = Math.max(wr.left + wrap.clientLeft, stickyRight());
      var right = wr.left + wrap.clientLeft + wrap.clientWidth;
      var pl = pinnedLeft();
      if (pl !== null) right = Math.min(right, pl);
      if (cr.left < left) wrap.scrollLeft -= (left - cr.left);
      else if (cr.right > right) wrap.scrollLeft += (cr.right - right);
    }
    cr = td.getBoundingClientRect();
    var minTop = 0;
    ['.app-head', '.topbar', '#tabs'].forEach(function (sel2) {
      var el = document.querySelector(sel2);
      if (el && root.getComputedStyle(el).position === 'sticky') minTop = Math.max(minTop, el.getBoundingClientRect().bottom);
    });
    if (cr.bottom > root.innerHeight) root.scrollBy(0, cr.bottom - root.innerHeight + 6);
    else if (cr.top < minTop) root.scrollBy(0, cr.top - minTop - 6);
  }

  function moveTo(r, c, extend) {
    if (!layout || !layout.students.length) return;
    r = clamp(r, 0, layout.students.length - 1);
    c = clamp(c, 0, layout.cols.length - 1);
    if (extend) {
      sel.end = refAt(r, c);
      endHold = null;
    } else {
      sel.active = refAt(r, c);
      sel.end = sel.active;
      if (sel.active.sid !== newRowSid) newRowSid = null;
      // A move to another cell ends the hold; a key that cannot move (Down on the last row) keeps it.
      if (endHold && !heldAt(sel.active)) endHold = null;
    }
    paintSelection();
    focusActive();
    ensureVisible(cellAt(r, c));
    dodgeToasts();
  }

  function tabTarget(p, back) {
    var r = p.r, c = p.c + (back ? -1 : 1);
    if (c >= layout.cols.length) { c = 0; r++; } else if (c < 0) { c = layout.cols.length - 1; r--; }
    if (r < 0 || r >= layout.students.length) return null;
    return { r: r, c: c };
  }

  /** True when the cell can be edited now (not calculated, and not a score locked by "finalize"). */
  function editableAt(p) {
    var col = p && layout ? layout.cols[p.c] : null;
    return !!(col && col.edit && !lockedCol(cur(), col));
  }

  /** The selected rows a drop-down value applies to (band assignment): the active column of a range
   * that spans several rows. Withdrawn students are left out. null for a single row. */
  function bandRows() {
    var rc = rectOf(), a = posOf(sel.active);
    if (!rc || !a || rc.r1 === rc.r2) return null;
    var col = layout.cols[a.c];
    if (!col || !col.dd) return null;
    var sids = [], wd = 0;
    for (var r = rc.r1; r <= rc.r2; r++) {
      var s = layout.students[r];
      if (!s) continue;
      if (s.status === 'withdrawn') { wd++; continue; }
      sids.push(s.id);
    }
    return { sids: sids, withdrawn: wd, r1: rc.r1, r2: rc.r2, key: col.key };
  }

  // ------------------------------------------------------------------ HTML builders

  /** Placeholder badge for an assessment's weight: the Term Paper weight and the project split are
   * unconfirmed defaults (placeholderBadge returns '' once the key is marked confirmed). */
  function weightBadge(course, a) {
    var key = weightPlaceholderKey(a);
    return key ? ui.placeholderBadge(course, key, { compact: true }) : '';
  }

  /** Classes of a column pinned on the right (Meeting view): ' pr pr<n>', plus ' pr-first' on the
   * leftmost one, which draws the edge line. '' for every other column. */
  function pinClass(col) {
    return col.pinCls || '';
  }

  function headHtml(ctx) {
    var course = ctx.course, prefs = layout.prefs, dec = ctx.dec;
    var h = '<colgroup>';
    ctx.cols.forEach(function (col) { h += '<col style="width:' + col.width + 'px">'; });
    h += '</colgroup><thead><tr role="row" aria-rowindex="1">';
    ctx.cols.forEach(function (col, i) {
      var cls = 'h-' + col.kind + (col.sticky ? ' sc sc' + col.sticky : '') + (col.group ? ' g g' + col.group : '') +
        (col.ro ? ' ro' : '') + (col.num ? ' num' : '') + (col.toFill ? ' to-fill' : '') +
        (col.sticky && col.sticky === ctx.nId ? ' sc-last' : '') + pinClass(col);
      var inner = '', title = '', aria = '';
      var a = col.a;
      var fillTag = col.toFill ? '<span class="h-sub h-fill">fill in the meeting</span>' : '';
      switch (col.kind) {
        case 'no': inner = 'No'; title = 'Student number'; break;
        case 'last':
        case 'total': {
          var key = col.kind === 'last' ? 'name' : 'total';
          var on = prefs.sort === key;
          if (on) aria = ' aria-sort="' + (prefs.dir === 'asc' ? 'ascending' : 'descending') + '"';
          var sub = '';
          if (col.kind === 'total') {
            var bits = [];
            var curve = course.settings.curve;
            if (typeof curve === 'number' && curve !== 0) bits.push((curve > 0 ? '+' : '') + num(curve, dec) + ' curve' + ui.placeholderBadge(course, 'curve', { compact: true }));
            if (course.settings.rounding === 'integer') bits.push('rounded' + ui.placeholderBadge(course, 'rounding', { compact: true }));
            else if (course.settings.rounding === 'hundredth') bits.push('to 0.01' + ui.placeholderBadge(course, 'rounding', { compact: true }));
            sub = '<span class="h-sub">' + (bits.length ? bits.join(' · ') : 'sum') + '</span>';
          }
          inner = '<button type="button" class="th-sort" data-act="sort" data-sort="' + key + '" tabindex="-1" title="Sort by ' +
            (key === 'name' ? 'name (last name, then first name)' : 'total') + '"><span class="h-name">' + esc(col.label) + '</span>' +
            (on ? ui.icon(prefs.dir === 'asc' ? 'sort-asc' : 'sort-desc', 'sort-ico') : '') + '</button>' + sub;
          break;
        }
        case 'first': inner = 'First Name'; break;
        case 'team': inner = 'Team'; break;
        case 'raw': {
          var range = col.dd ? choiceRange(a, col.choices) : '';
          inner = (ctx.locked ? '<span class="h-lock" aria-hidden="true"></span>' : '') +
            '<span class="h-name">' + esc(a.name) + '</span><span class="h-sub"><span class="hs">max ' + num(a.maxScore, 4) +
            (col.dd ? ' · list' : '') + ui.placeholderBadge(course, 'maxScores', { compact: true }) + '</span><span class="hs hs-w"><span class="sr-only"> · </span>' +
            '<span class="nowrap">' + num(a.weight, 4) + '%' + weightBadge(course, a) + '</span>' +
            (a.teamGraded ? ' <span class="nowrap">· team</span>' : '') + '</span></span>' + fillTag +
            '<button type="button" class="th-menu" data-act="col-menu" data-aid="' + esc(a.id) + '" tabindex="-1" aria-haspopup="menu" aria-label="' +
            esc('Column actions for ' + a.name) + '" title="Column actions: fill, set or clear the whole column">' + ui.icon('dots') + '</button>';
          title = a.name + ': max ' + num(a.maxScore, 4) + ', weight ' + num(a.weight, 4) + '%' +
            (a.teamGraded ? ', team-graded (one score per team, ◆ = per-member override)' : '') +
            (col.dd ? '. Drop-down list: ' + range + ' (Enter or Alt+Down opens it; typing a value from the list also works)' : '') +
            (ctx.locked ? '. Locked: scores are finalized' : '');
          break;
        }
        case 'weighted':
          inner = '<span class="h-name">' + esc(a.name) + ' <span class="nowrap">' + num(a.weight, 4) + '%' + weightBadge(course, a) +
            '</span></span><span class="h-sub">weighted</span>';
          title = 'Weighted points = raw ÷ ' + num(a.maxScore, 4) + ' × ' + num(a.weight, 4) + ' (calculated)';
          break;
        case 'letter':
          inner = '<span class="h-name">Suggested' + ui.placeholderBadge(course, 'letterScale', { compact: true }) + '</span>' +
            '<span class="h-sub">from cutoffs</span>';
          title = 'Letter from the cutoffs: only a suggestion. The Final letter is the grade that counts.';
          break;
        case 'final':
          inner = '<span class="h-name">Final letter</span>' + (col.toFill ? fillTag : '<span class="h-sub">your choice</span>');
          title = 'The final letter grade, chosen by hand (Enter or Alt+Down opens the list; type a letter such as b+). ' +
            'Select several rows first to give them all the same letter.';
          break;
        case 'rank': inner = 'Rank'; title = 'Rank among active students'; break;
        case 'pct': inner = 'Percentile'; title = 'Percentile among active students'; break;
        case 'diff': inner = '±Avg'; title = 'Difference from the class average (active students)'; break;
        case 'attExc':
          inner = '<span class="h-name">Excused</span> <span class="h-sub nowrap">(allowed)</span>';
          title = 'Excused absences: allowed (approved by the instructor)';
          break;
        case 'attUnx':
          inner = '<span class="h-name">Unexcused</span> <span class="h-sub nowrap">(not allowed)</span>';
          title = 'Unexcused absences: not allowed. They drive the threshold highlight and the consecutive-absence warnings (warnings only)';
          break;
        case 'attTot':
          inner = '<span class="h-name">Total</span> <span class="h-sub nowrap">absences</span>';
          title = 'Excused + unexcused absences (for information)';
          break;
      }
      h += '<th role="columnheader" scope="col" data-c="' + i + '" class="' + cls + '"' + aria +
        (title ? ' title="' + esc(title) + '"' : '') + '>' + inner + '</th>';
    });
    return h + '</tr></thead>';
  }

  /** Markup of the attendance cells; the summary comes from GT.attendance (stage 3). */
  function attCell(ctx, s, kind) {
    var sm = ctx.att ? ctx.att(s.id) : null;
    if (!sm) return { cls: '', body: '<span class="faint">—</span>', title: 'No attendance recorded' };
    // Warnings cover active students only (STAGE3 §1, like the Attendance warnings list and its grid rows):
    // a withdrawn student keeps the numbers but gets no warning icon, class or warning tooltip.
    var wd = s.status === 'withdrawn';
    var warning = wd ? null : sm.warning;
    var over = !wd && !!sm.overThreshold;
    var overT = !wd && !!sm.overTotalThreshold;
    var WD_NOTE = 'Withdrawn: no attendance warning (warnings cover active students only)';
    var rec = whole(sm.recorded);
    var cls = '', body, title;
    if (kind === 'attExc') {
      body = String(whole(sm.excused));
      title = whole(sm.excused) + ' excused (allowed) absences in ' + plural(rec, 'recorded session');
    } else if (kind === 'attUnx') {
      body = String(whole(sm.unexcused));
      var tips = [whole(sm.unexcused) + ' unexcused (not allowed) absences in ' + plural(rec, 'recorded session')];
      if (warning === 'fail') tips.push(whole(sm.longestStreak) + ' consecutive absences: the syllabus says F (warning only, the grade is not changed)');
      else if (warning === 'drop') tips.push(whole(sm.longestStreak) + ' consecutive absences: the syllabus says one letter grade drop (warning only)');
      if (over) {
        var th = ctx.course.attendance && typeof ctx.course.attendance.unexcusedThreshold === 'number' ? ' (' + ctx.course.attendance.unexcusedThreshold + ')' : '';
        tips.push('Above the unexcused-absence threshold' + th);
      }
      if (warning || over) {
        cls = ' is-att-warn' + (warning === 'fail' ? ' is-att-fail' : '');
        body = '<span class="mk-att" aria-hidden="true">' + ui.icon('alert') + '</span><span class="sr-only">warning: </span>' + body;
      } else if (wd && (sm.warning || sm.overThreshold)) {
        tips.push(WD_NOTE);
      }
      title = tips.join('. ');
    } else {
      body = String(whole(sm.totalAbsences));
      title = whole(sm.totalAbsences) + ' absences in total (excused + unexcused) in ' + plural(rec, 'recorded session');
      if (overT) {
        cls = ' is-att-warn';
        var tt = ctx.course.attendance && typeof ctx.course.attendance.totalAbsenceThreshold === 'number' ? ' (' + ctx.course.attendance.totalAbsenceThreshold + ')' : '';
        title += '. Above the total-absence threshold' + tt;
        body = '<span class="mk-att" aria-hidden="true">' + ui.icon('alert') + '</span><span class="sr-only">warning: </span>' + body;
      } else if (wd && sm.overTotalThreshold) {
        title += '. ' + WD_NOTE;
      }
    }
    return { cls: cls, body: body, title: title };
  }

  /** One student row as parts: { cls: the row's classes, cells: [{ c: classes, ro, t: title (plain text),
   * b: inner HTML }] }. renderTable() writes them as markup (studentRowHtml) or patches only the cells
   * whose parts changed since the last render. */
  function studentRowParts(ctx, s) {
    var course = ctx.course, cols = ctx.cols, dec = ctx.dec;
    var rs = ctx.results.byId[s.id];
    var wd = s.status === 'withdrawn';
    var team = s.teamId ? ctx.teamById[s.teamId] : null;
    var out = { cls: 'gr' + (wd ? ' row-withdrawn' : '') + (ctx.bandEnd[s.id] ? ' band-end' : ''), cells: new Array(cols.length) };
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      var cls, body = '', title = '', ro = !!col.ro || (ctx.locked && !!col.edit && col.kind !== 'final');
      switch (col.kind) {
        case 'no':
          cls = 'c-no sc sc1 num';
          body = (ctx.openStudent ? '<button type="button" class="row-details" data-act="details" tabindex="-1" aria-label="Open details for ' +
            esc(studentLabel(s)) + '" title="Student details"></button>' : '') +
            (typeof s.no === 'number' ? s.no : '');
          break;
        case 'last':
          cls = 'c-last sc sc2';
          body = s.lastName ? '<span class="pii">' + esc(s.lastName) + '</span>' : '<span class="faint">(no last name)</span>';
          break;
        case 'first':
          cls = 'c-first sc sc3';
          body = s.firstName ? '<span class="pii">' + esc(s.firstName) + '</span>' : '';
          // Withdrawn: the name shrinks (ellipsis) so the badge always stays visible.
          // The Meeting view (narrower name columns) shows a short "W" badge.
          if (wd) {
            body = '<span class="fn-wd">' + body + (layout.prefs.meeting
              ? '<span class="badge wd-badge" title="Withdrawn"><span aria-hidden="true">W</span><span class="sr-only">Withdrawn</span></span>'
              : '<span class="badge wd-badge">Withdrawn</span>') + '</span>';
          }
          break;
        case 'team':
          cls = 'c-team sc sc4';
          body = team ? esc(team.name) : '<span class="faint">—</span>';
          break;
        case 'raw': {
          var d = rs.items[col.aid];
          var a = col.a;
          var tips = [];
          cls = 'c-raw num g g' + col.group + (col.dd ? ' c-dd' : '') + (col.toFill ? ' to-fill' : '');
          if (d.state === 'invalid') {
            cls += ' is-invalid';
            body = esc(d.text);
            tips.push('Not a number: counted as 0');
          } else if (d.state === 'number') {
            body = esc(String(d.raw));
            var offList = col.dd && (d.notOnList !== undefined ? !!d.notOnList : !isChoiceValue(a, col.choices, d.raw));
            if (d.outOfRange || offList) cls += ' is-range';
            if (d.outOfRange) tips.push('Outside 0–' + num(a.maxScore, 4));
            if (offList) tips.push('Not one of the list values (' + choiceRange(a, col.choices) + '): kept and counted');
          } else {
            cls += ' is-empty';
            body = '–';
            tips.push(col.toFill ? 'Empty: to fill in the meeting (counted as 0 until then)' : 'Empty: counted as 0');
          }
          // Late work (K4): a badge before the score, "L2" (penalty applied) or "L2✓" (waived).
          if (d.weeksLate > 0) {
            cls += ' is-late' + (d.waived ? ' is-waived' : '');
            body = lateBadgeHtml(d.weeksLate, d.waived) + body;
            var lateTip = plural(d.weeksLate, 'week') + ' late';
            if (d.waived) {
              lateTip += ', penalty waived (pre-approved): no points deducted';
            } else {
              var lp = latePenaltyOf(course, a, d.weeksLate, false);
              if (!(lp > 0)) lateTip += ': no points deducted (0 points per week in Settings)';
              else if (d.state === 'number') lateTip += ': −' + num(lp, 4) + ' points, adjusted score ' + num(d.adjusted, 4);
              else lateTip += ': −' + num(lp, 4) + ' points once a score is entered';
            }
            tips.push(lateTip + (d.source === 'team' ? ' (the team\'s late work)' : ''));
          }
          if (d.source === 'team') {
            body = ICON_TEAM + body;
            tips.push('Team score (' + (team ? team.name : 'team') + ')');
          } else if (d.source === 'override') {
            cls += ' is-ovr';
            body = ICON_OVR + body;
            var te = model.getEntry(course.teamScores, s.teamId, col.aid);
            tips.push('Per-member override. Team score: ' + (entryText(te) || 'empty') + '. An unequal split needs the team\'s written agreement.');
          } else if (a.teamGraded) {
            tips.push('No team: individual score');
          }
          title = tips.join('. ');
          break;
        }
        case 'weighted': {
          var dw = rs.items[col.aid];
          cls = 'c-w num ro g g' + col.group;
          if (dw.missing) {
            cls += ' is-empty';
            body = '0';
            title = (dw.state === 'invalid' ? 'Not a number' : 'Empty') + ': counts as 0';
          } else {
            body = num(dw.weighted, dec);
            var calcTip = ' ÷ ' + num(col.a.maxScore, 4) + ' × ' + num(col.a.weight, 4) + ' = ' + num(dw.weighted, 6);
            if (dw.penalty > 0) {
              // Adjusted after the late penalty (K4): the penalty comes off the raw score before weighting.
              cls += ' is-adjusted';
              title = 'Adjusted after late penalty: raw ' + num(dw.raw, 4) + ' − ' + num(dw.penalty, 4) + ' (' + plural(dw.weeksLate, 'week') + ' late) = ' +
                num(dw.adjusted, 4) + (dw.raw - dw.penalty < 0 ? ' (never below 0)' : '') + '; ' + num(dw.adjusted, 4) + calcTip;
            } else {
              title = String(dw.raw) + calcTip + (dw.weeksLate > 0 ? ' (' + plural(dw.weeksLate, 'week') + ' late, ' +
                (dw.waived ? 'penalty waived' : 'no points deducted') + ')' : '');
            }
          }
          break;
        }
        case 'total':
          cls = 'c-total num ro';
          if (rs.incomplete) {
            cls += ' is-incomplete';
            body = '<span class="inc" title="' + (rs.missingCount === 1 ? '1 weighted score is empty and counts as 0' :
              rs.missingCount + ' weighted scores are empty and count as 0') + '">' + ICON_INCOMPLETE +
              '<span class="sr-only">incomplete</span></span>';
          }
          body += num(rs.total, dec);
          break;
        case 'letter':
          cls = 'c-letter ro' + (wd ? ' muted' : '');
          // Withdrawn: "W", as on the Summary, not a cutoff letter (UX-8).
          body = wd ? 'W' : esc(rs.letter);
          title = wd ? WITHDRAWN_LETTER_TIP : 'Suggested by the cutoffs';
          break;
        case 'final': {
          var fi = finalInfo(s, rs, ctx.letterSet);
          var ft = [];
          cls = 'c-final c-dd' + (col.toFill ? ' to-fill' : '') + (wd ? ' muted' : '');
          if (fi.letter === null) {
            cls += ' is-empty';
            body = '–';
            ft.push(wd ? 'No final letter (withdrawn)' : 'No final letter yet');
          } else {
            body = '<span class="fl">' + esc(fi.letter) + '</span>';
            if (!fi.valid) {
              cls += ' is-invalid';
              ft.push('“' + fi.letter + '” is not a letter of this course\'s scale: choose again');
            } else if (fi.differs) {
              body += '<span class="mk-diff" aria-hidden="true"></span><span class="sr-only"> (differs from the suggestion)</span>';
              ft.push('Differs from the cutoff suggestion (' + (fi.suggested || '—') + ')');
            }
            var oi = ctx.issues.map[s.id];
            if (oi && !wd) {
              cls += ' is-order';
              body = '<span class="mk mk-order" aria-hidden="true"></span><span class="sr-only">letter order warning: </span>' + body;
              if (oi.above.length) ft.push('Higher letter than a student with a higher total (' + ctx.nosOf(oi.above) + ')');
              if (oi.below.length) ft.push('Lower letter than a student with a lower total (' + ctx.nosOf(oi.below) + ')');
            }
          }
          title = ft.join('. ');
          break;
        }
        case 'rank':
          cls = 'c-rank num ro';
          if (wd || rs.rank === null) { body = '<span class="faint">—</span>'; title = wd ? 'Withdrawn: not ranked' : ''; }
          else { body = String(rs.rank); title = rs.rank + ' of ' + ctx.nActive; }
          break;
        case 'pct':
          cls = 'c-pct num ro';
          body = wd || rs.percentile === null ? '<span class="faint">—</span>' : ordinal(Math.round(rs.percentile));
          break;
        case 'diff': {
          cls = 'c-diff num ro';
          var df = rs.diffFromAverage;
          if (wd || df === null) body = '<span class="faint">—</span>';
          else {
            var sd = util.roundTo(df, dec);
            body = sd > 0 ? '+' + num(df, dec) : (sd < 0 ? '−' + num(-df, dec) : '0');
            cls += sd > 0 ? ' pos' : (sd < 0 ? ' neg' : '');
          }
          break;
        }
        case 'attExc':
        case 'attUnx':
        case 'attTot': {
          var ac = attCell(ctx, s, col.kind);
          cls = 'c-att num ro' + ac.cls;
          body = ac.body;
          title = ac.title;
          break;
        }
        default:
          cls = '';
      }
      if (col.sticky && col.sticky === ctx.nId) cls += ' sc-last';
      cls += pinClass(col);
      out.cells[i] = { c: cls, ro: ro, t: title, b: body };
    }
    return out;
  }

  function cellHtml(cell, i) {
    return '<td role="gridcell" data-c="' + i + '" class="' + cell.c + '"' + (cell.ro ? ' aria-readonly="true"' : '') +
      (cell.t ? ' title="' + esc(cell.t) + '"' : '') + '>' + cell.b + '</td>';
  }

  function studentRowHtml(parts, s, r, ariaRow) {
    var h = '<tr role="row" class="' + parts.cls + '" data-r="' + r + '" data-sid="' + esc(s.id) + '" aria-rowindex="' + ariaRow + '">';
    for (var i = 0; i < parts.cells.length; i++) h += cellHtml(parts.cells[i], i);
    return h + '</tr>';
  }

  /** Brings a cell from its old parts to its new ones in place: the element (focus, tabindex, the ▾
   * button) stays, and the selection classes paintSelection() added are kept. */
  function patchCell(td, a, b) {
    if (a.c !== b.c) {
      var cl = td.classList, keep = '';
      for (var k = 0; k < PAINT_CLASSES.length; k++) if (cl.contains(PAINT_CLASSES[k])) keep += ' ' + PAINT_CLASSES[k];
      td.className = a.c + keep;
    }
    if (a.ro !== b.ro) {
      if (a.ro) td.setAttribute('aria-readonly', 'true'); else td.removeAttribute('aria-readonly');
    }
    if (a.t !== b.t) {
      if (a.t) td.setAttribute('title', a.t); else td.removeAttribute('title');
    }
    if (a.b !== b.b) {
      var hadBtn = !!ddBtn && ddBtn.parentNode === td;
      // Plain text (most changes: ±Avg, rank, totals) skips the HTML parser.
      if (/[<&]/.test(a.b)) td.innerHTML = a.b; else td.textContent = a.b;
      if (hadBtn) td.appendChild(ddBtn);
    }
  }

  function teamRowHtml(ctx, team, ariaRow) {
    var course = ctx.course, cols = ctx.cols;
    var all = team ? model.teamMembers(course, team.id)
      : course.students.filter(function (s) { return !s.teamId || !ctx.teamById[s.teamId]; });
    var totals = [], wd = 0;
    all.forEach(function (s) {
      if (s.status === 'withdrawn') { wd++; return; }
      var r = ctx.results.byId[s.id];
      if (r && typeof r.total === 'number' && isFinite(r.total)) totals.push(r.total);
    });
    var avg = totals.length ? num(util.fix(util.sum(totals) / totals.length), ctx.dec) : '—';
    var name = team ? team.name : 'No team';
    var members = plural(all.length, 'member') + (wd ? ' (' + wd + ' withdrawn)' : '');
    // Short enough for the identity columns ("· avg 78.91", UX-15); the whole line is in the tooltip.
    var full = name + ': ' + members + ' · ' + (team ? 'team average ' : 'average ') + avg + ' (active members)';
    var h = '<tr role="row" class="team-row" aria-rowindex="' + ariaRow + '"><th role="rowheader" scope="row" colspan="' + ctx.nId +
      '" class="sc sc-span team-label" title="' + esc(full) + '">' +
      ui.icon('users', 'icon-sm') + ' <span class="tl-name">' + esc(name) + '</span><span class="tl-meta"> · ' +
      esc(members) + ' · avg ' + avg + '</span></th>';
    for (var i = ctx.nId; i < cols.length; i++) {
      var col = cols[i], inner = '', cls = 'tr-cell' + (col.group ? ' g g' + col.group : '') + (col.num ? ' num' : '') + pinClass(col);
      if (team && col.kind === 'raw' && col.a.teamGraded) {
        var e = model.getEntry(course.teamScores, team.id, col.aid);
        var p = calc.parseEntry(e);
        var txt = entryText(e);
        var bcls = 'team-score' + (p.state === 'invalid' ? ' is-invalid' : '') +
          (p.state === 'number' && (p.value < 0 || p.value > col.a.maxScore) ? ' is-range' : '');
        var wl = e && typeof e.weeksLate === 'number' && e.weeksLate > 0 ? e.weeksLate : 0;
        var lateTxt = wl ? ' · ' + plural(wl, 'week') + ' late' + (e.waived ? ', penalty waived' : '') : '';
        inner = '<button type="button" class="' + bcls + '" data-act="team-score" data-tid="' + esc(team.id) + '" data-aid="' + esc(col.aid) +
          '" tabindex="-1" title="' + esc(team.name + ' team score for ' + col.a.name + lateTxt + ' (click to edit)') + '">' +
          (wl ? lateBadgeHtml(wl, !!e.waived) : '') + (txt ? esc(txt) : '<span class="faint">set…</span>') + '</button>';
      }
      h += '<td role="gridcell" aria-readonly="true" class="' + cls + '">' + inner + '</td>';
    }
    return h + '</tr>';
  }

  /** The class-average row (the <tr> inside <tfoot>). Its label cells line up with the pinned body
   * columns (UX-6): "Class average" over No and Last Name (pinned at every width), and a cell over First
   * Name (and Team) pinned like them, which css/grid.css leaves unpinned on phones, as the body cells are. */
  function footRowHtml(ctx, ariaRow) {
    var course = ctx.course, cols = ctx.cols, dec = ctx.dec, results = ctx.results;
    var active = course.students.filter(function (s) { return s.status !== 'withdrawn'; });
    var tip = 'Class average of the active students (withdrawn students are left out)';
    var h = '<tr role="row" class="avg-row" aria-rowindex="' + ariaRow + '"><th role="rowheader" scope="row" colspan="2" class="sc sc1 avg-label avg-a" title="' +
      esc(tip) + '">Class average</th><td role="gridcell" aria-readonly="true" colspan="' + (ctx.nId - 2) + '" class="sc sc3 avg-label avg-b sc-last" title="' +
      esc(tip) + '"><span class="muted">(active)</span></td>';
    for (var i = ctx.nId; i < cols.length; i++) {
      var col = cols[i], v = '', title = '';
      var cls = 'f-' + col.kind + (col.group ? ' g g' + col.group : '') + (col.num ? ' num' : '') + pinClass(col);
      if (col.kind === 'raw' || col.kind === 'weighted') {
        var sum = 0, n = 0;
        active.forEach(function (s) {
          var d = results.byId[s.id] && results.byId[s.id].items[col.aid];
          if (!d) return;
          if (col.kind === 'raw') { if (d.state === 'number') { sum += d.raw; n++; } } else { sum += d.weightedUnrounded; n++; }
        });
        if (n) v = num(util.fix(sum / n), dec);
        title = col.kind === 'raw' ? 'Average of ' + plural(n, 'entered score') + ' (active students)' : 'Average weighted points (empty counts as 0)';
      } else if (col.kind === 'total' && results.average !== null) {
        v = num(results.average, dec);
        title = 'Class average of ' + plural(results.activeIds.length, 'active student');
      } else if (col.kind === 'letter' && results.average !== null) {
        v = esc(calc.letterFor(results.average, course.settings.letterScale));
        title = 'Suggested letter for the class average';
      } else if (col.kind === 'final') {
        v = ctx.summary.assigned + '/' + ctx.summary.active;
        title = 'Final letters assigned (active students)';
      }
      h += '<td role="gridcell" aria-readonly="true" class="' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + v + '</td>';
    }
    return h + '</tr>';
  }

  // ------------------------------------------------------------------ rendering

  function toolbarHtml() {
    return '<div class="toolbar grid-toolbar">' +
      '<label class="search">' + ui.icon('search') + '<span class="sr-only">Search students</span>' +
      '<input type="search" class="grid-search" placeholder="Search name, No or team" title="Search (press / to jump here)" autocomplete="off" spellcheck="false"></label>' +
      '<label class="grid-sort"><span class="grid-sort-label">Sort</span><select class="grid-sort-select" aria-label="Sort rows">' +
      SORTS.map(function (o) { return '<option value="' + o.value + '">' + esc(o.label) + '</option>'; }).join('') + '</select></label>' +
      '<button type="button" class="btn btn-sm btn-primary grid-resort" data-act="resort" hidden ' +
      'title="Rows keep their place while you edit. Click to sort them again with the new values.">' + ui.icon('sort-desc') +
      '<span>Order changed: re-sort</span></button>' +
      // On phones the button labels (.bl) are visually hidden.
      '<button type="button" class="btn btn-sm" data-act="group" aria-pressed="false" title="Group rows by team">' + ui.icon('layers') + '<span class="bl">Group by team</span></button>' +
      '<button type="button" class="btn btn-sm" data-act="withdrawn" aria-pressed="true">' + ui.icon('user') + '<span class="bl">Show withdrawn</span></button>' +
      '<button type="button" class="btn btn-sm" data-act="columns" aria-haspopup="menu" aria-expanded="false" title="Show or hide columns">' + ui.icon('grid') +
      '<span class="bl">Columns</span>' + ui.icon('chevron-down') + '</button>' +
      '<span class="spacer"></span>' +
      '<span class="grid-count muted small" aria-live="polite"></span>' +
      '<button type="button" class="btn btn-sm" data-act="paste-roster" title="Paste a roster copied from Excel">' + ui.icon('copy') + '<span class="bl">Paste roster</span></button>' +
      '<button type="button" class="btn btn-sm btn-primary" data-act="add-student" title="Add a student">' + ui.icon('plus') + '<span class="bl">Add student</span></button>' +
      '</div>';
  }

  /** The "Final grades" bar: Meeting view, the letter summary, copy suggested letters, finalize. */
  function gradesBarHtml() {
    return '<div class="toolbar grid-grades-bar" role="group" aria-label="Final grades">' +
      '<span class="section-label">Final grades</span>' +
      '<button type="button" class="btn btn-sm" data-act="meeting" aria-pressed="false" ' +
      'title="Meeting view: scores, total, absences, participation and the final letter, in larger text, sorted by total">' +
      ui.icon('users') + '<span>Meeting view</span></button>' +
      '<button type="button" class="chip grid-letters-chip" data-act="letters-chip"></button>' +
      '<button type="button" class="chip warn grid-order-chip" data-act="order-chip" hidden></button>' +
      '<button type="button" class="btn btn-sm" data-act="copy-suggested" title="Fill the empty final letters of active students with the suggested (cutoff) letters">' +
      ui.icon('copy') + '<span>Copy suggested → final</span></button>' +
      '<span class="spacer"></span>' +
      // The legend folds behind this button at every width (UX-13; gridPrefs.legend remembers it open). It sits
      // here, right above the legend, so the main toolbar still fits on one line at 1280 px.
      '<button type="button" class="btn btn-sm grid-legend-btn" data-act="legend" aria-expanded="false" aria-controls="grid-legend" title="Show the legend">' +
      ui.icon('info') + '<span>Legend</span></button>' +
      '<button type="button" class="btn btn-sm" data-act="finalize" title="Check the data, then lock the score cells (final letters stay editable)">' +
      ui.icon('lock') + '<span>Finalize scores…</span></button>' +
      '</div>';
  }

  function legendHtml() {
    return '<div class="grid-legend" id="grid-legend" aria-label="Legend">' +
      '<span><span class="lg-sw lg-empty">–</span>empty: counted as 0</span>' +
      '<span><span class="lg-sw lg-invalid"></span>red: not a number (or not a letter of the scale)</span>' +
      '<span><span class="lg-sw lg-range"></span>yellow: outside 0 to max, or not a list value</span>' +
      '<span><span class="lg-mk mk-ovr">◆</span>per-member override</span>' +
      '<span><span class="lg-mk mk-team"></span>team score</span>' +
      '<span><span class="lg-mk inc">' + ICON_INCOMPLETE + '</span>incomplete total</span>' +
      '<span><span class="mk-late" aria-hidden="true">L2</span>2 weeks late: penalty applied (Ctrl+L)</span>' +
      '<span><span class="mk-late is-waived" aria-hidden="true"><s>L</s>2✓</span>late, penalty waived</span>' +
      '<span><span class="lg-mk"><span class="mk-diff"></span></span>final letter differs from the suggestion</span>' +
      '<span><span class="lg-mk mk-order"></span>letter out of order with the totals</span>' +
      '<span class="lg-hint">Type to replace · Enter or F2 to edit · Alt+↓ opens a drop-down list · select several rows, then choose a letter to give them all the same one · ' +
      'Ctrl+C / Ctrl+V with Excel · Ctrl+L late work · right-click or Shift+F10 for cell actions · Esc, then Tab leaves the grid</span>' +
      '</div>';
  }

  function buildSkeleton(el, which) {
    closeColumnsMenu(false);
    el.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'page-header grid-head';
    el.appendChild(head);
    layout = null;
    built = null;
    rowEls = [];
    painted = { range: [], active: null, head: null, row: null };
    if (which !== 'grid') {
      var box = document.createElement('div');
      box.className = 'card grid-empty';
      el.appendChild(box);
      dom = { head: head, empty: box };
      return;
    }
    var lockBanner = ui.el('<div class="callout grid-lock-banner" role="status" hidden></div>');
    var tb = ui.el(toolbarHtml());
    var bar = ui.el(gradesBarHtml());
    var legend = ui.el(legendHtml());
    var wrap = ui.el('<div class="table-wrap grid-wrap"><table class="gt-grid" role="grid"></table></div>');
    el.appendChild(lockBanner);
    el.appendChild(tb);
    el.appendChild(bar);
    el.appendChild(legend);
    el.appendChild(wrap);
    // An open list lifts its cell above the sticky header (has-popup). Once the grid scrolls the cell
    // up under the header, drop that lift so the list slides under the header instead of covering it.
    wrap.addEventListener('scroll', function () {
      if (!editing || !editing.td || !editing.td.isConnected) return;
      var thead = dom.table && dom.table.tHead;
      if (!thead) return;
      var under = editing.td.getBoundingClientRect().top < thead.getBoundingClientRect().bottom;
      var hasPopup = !!(editing.hint || editing.list);
      editing.td.classList.toggle('has-popup', hasPopup && !under);
    }, { passive: true });
    dom = {
      head: head, toolbar: tb, bar: bar, lockBanner: lockBanner, legend: legend, wrap: wrap, table: wrap.querySelector('table'),
      search: tb.querySelector('.grid-search'), sort: tb.querySelector('.grid-sort-select'),
      group: tb.querySelector('[data-act="group"]'), withdrawn: tb.querySelector('[data-act="withdrawn"]'),
      columns: tb.querySelector('[data-act="columns"]'), roster: tb.querySelector('[data-act="paste-roster"]'),
      add: tb.querySelector('[data-act="add-student"]'), resort: tb.querySelector('[data-act="resort"]'),
      count: tb.querySelector('.grid-count'),
      meeting: bar.querySelector('[data-act="meeting"]'), lettersChip: bar.querySelector('[data-act="letters-chip"]'),
      orderChip: bar.querySelector('[data-act="order-chip"]'), copySuggested: bar.querySelector('[data-act="copy-suggested"]'),
      finalize: bar.querySelector('[data-act="finalize"]'), legendBtn: bar.querySelector('[data-act="legend"]')
    };
    dom.search.value = searchText;
    dom.search.addEventListener('input', function () {
      searchText = dom.search.value;
      endHold = null;
      renderTable();
    });
    dom.search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (dom.search.value) { dom.search.value = ''; searchText = ''; renderTable(); } else focusActive();
      } else if ((e.key === 'Enter' || e.key === 'ArrowDown') && layout && layout.students.length) {
        e.preventDefault();
        normalizeSelection();
        paintSelection();
        focusActive();
        var a = posOf(sel.active);
        if (a) ensureVisible(cellAt(a.r, a.c));
      }
    });
    dom.sort.addEventListener('change', function () {
      var v = dom.sort.value.split(':');
      setPrefs({ sort: v[0], dir: v[1] });
    });
  }

  /** "SE 4351 · Requirements Engineering · Fall 2026": the course line under every page title (UX-16). */
  function courseLine(course) {
    return [course.code, course.title, course.term].filter(function (x) { return typeof x === 'string' && x.trim() !== ''; }).join(' · ');
  }

  function renderHead(course, results) {
    var active = 0, wd = 0;
    course.students.forEach(function (s) { if (s.status === 'withdrawn') wd++; else active++; });
    var dec = decimalsOf(course);
    // The shared page header: the tab name as the title, the course and the counts under it.
    var h = '<div><h1>Grades</h1><div class="sub"><span>' + esc(courseLine(course)) + ' · ';
    if (!course.students.length) {
      h += 'No students yet</span>';
    } else {
      var avg = results && results.average !== null ? num(results.average, dec) : '—';
      h += esc(active + ' active · ' + wd + ' withdrawn · class average ' + avg + ' (active students)') + '</span>';
    }
    var w = results ? results.weights : calc.weightStatus(course);
    if (!w.ok) {
      h += ' <button type="button" class="chip warn grid-weights" data-act="weights" title="' +
        (GT.views.settings ? 'Open Settings to fix the weights' : 'Weights should add up to 100%') + '">' +
        ui.icon('alert', 'icon-sm') + 'Weights sum to ' + esc(num(w.sum, 2)) + '%</button>';
    }
    setHtml(dom.head, h + '</div></div>');
  }

  function renderEmpty(course) {
    var canRoster = typeof GT.ui.openRosterPaste === 'function';
    var canImport = !!GT.views.exchange;
    var canSample = !!(GT.sample && GT.app && GT.app.actions && GT.app.actions.loadSample);
    // Finalized with no students (older data, or every student deleted): Add student and Paste roster
    // are refused, so the banner with its Unlock button is shown here too.
    var banner = isFinalized(course) ? '<div class="callout grid-lock-banner grid-empty-lock" role="status">' + lockBannerHtml(course, null) + '</div>' : '';
    var lockAttr = banner ? ' aria-disabled="true" title="Scores are finalized. Unlock them to add students."' : '';
    // Paste roster is the main way in (as on Students & Teams); the fake sample data comes last (UX-7).
    // Without the roster dialog, Add student takes the lead.
    setHtml(dom.empty, banner + '<div class="empty-state">' + ui.icon('users', 'empty-ico') +
      '<h2>No students in ' + esc(course.code) + ' yet</h2>' +
      '<p>Paste a roster copied from Excel, add students one by one, or import a file. To try the app first, load fake sample data. ' +
      'Everything stays in this browser.</p><div class="actions">' +
      (canRoster ? '<button type="button" class="btn btn-primary" data-act="paste-roster"' + lockAttr + '>' + ui.icon('copy') + 'Paste roster</button>' : '') +
      '<button type="button" class="btn' + (canRoster ? '' : ' btn-primary') + '" data-act="add-student"' + lockAttr + '>' + ui.icon('plus') + 'Add student</button>' +
      (canImport ? '<button type="button" class="btn" data-act="import">' + ui.icon('upload') + 'Import from Excel/CSV</button>' : '') +
      (canSample ? '<button type="button" class="btn" data-act="load-sample">' + ui.icon('layers') + 'Load sample data</button>' : '') +
      '</div></div>');
  }

  /** Sets innerHTML only when it changed (keeps focus on a button that stays the same). */
  function setHtml(el, html) {
    if (el.__html === html) return;
    var had = el.contains(document.activeElement) ? document.activeElement.getAttribute('data-act') : null;
    el.innerHTML = html;
    el.__html = html;
    if (had) {
      var again = el.querySelector('[data-act="' + had + '"]');
      if (again) again.focus();
    }
  }

  function renderToolbar(course, results) {
    var p = getPrefs();
    var v = p.sort + ':' + p.dir;
    if (dom.sort.value !== v) dom.sort.value = v;
    var locked = isFinalized(course);
    dom.group.setAttribute('aria-pressed', p.grouped ? 'true' : 'false');
    dom.group.disabled = p.meeting;
    dom.group.title = p.meeting ? 'Grouping by team is off in the Meeting view' : 'Group rows by team';
    dom.withdrawn.setAttribute('aria-pressed', p.showWithdrawn ? 'true' : 'false');
    dom.withdrawn.title = p.showWithdrawn ? 'Withdrawn students are shown greyed out. Click to hide them.' : 'Withdrawn students are hidden. Click to show them.';
    dom.roster.hidden = typeof GT.ui.openRosterPaste !== 'function';
    // Finalized: no new students (their names and scores could not be typed in).
    [dom.add, dom.roster].forEach(function (b) {
      if (locked) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });
    dom.add.title = locked ? 'Scores are finalized. Unlock them to add students.' : 'Add a student';
    if (dom.search.value !== searchText && document.activeElement !== dom.search) dom.search.value = searchText;
    dom.meeting.setAttribute('aria-pressed', p.meeting ? 'true' : 'false');
    // Meeting view: Add student and Paste roster are hidden, so the toolbar stays on one line (css).
    if (dom.toolbar.classList.contains('meeting-mode') !== p.meeting) {
      dom.toolbar.classList.toggle('meeting-mode', p.meeting);
      queueWrapTop();
    }
    // The legend is folded behind its button unless the user opened it (remembered in gridPrefs).
    if (dom.legend.classList.contains('is-open') !== p.legend) {
      dom.legend.classList.toggle('is-open', p.legend);
      queueWrapTop();
    }
    var lb = dom.legendBtn;
    if (lb) {
      lb.setAttribute('aria-expanded', p.legend ? 'true' : 'false');
      lb.title = p.legend ? 'Hide the legend' : 'Show the legend: what the colors and marks mean, and the keys';
    }
    dom.finalize.hidden = locked;
    setHtml(dom.lockBanner, lockBannerHtml(course, results));
    dom.lockBanner.hidden = !locked;
    if (results) {
      var sm = letterSummary(course, results);
      var all = sm.active > 0 && sm.unassigned === 0 && !sm.invalid;
      dom.lettersChip.className = 'chip grid-letters-chip' + (all ? ' ok' : ' warn');
      setHtml(dom.lettersChip, (all ? ui.icon('check', 'icon-sm') : '') + 'Final letters: ' + sm.assigned + ' of ' + sm.active + ' assigned' +
        (sm.invalid ? ' · ' + sm.invalid + ' not in the scale' : ''));
      var tips = [];
      if (sm.unassigned) tips.push(sm.unassigned + ' active student' + (sm.unassigned === 1 ? ' has' : 's have') + ' no final letter yet.');
      if (sm.invalid) {
        tips.push(plural(sm.invalid, 'final letter') + (sm.invalid === 1 ? ' is not a letter' : ' are not letters') + ' of the current scale (shown in red): choose another letter.');
      }
      dom.lettersChip.title = all ? 'Every active student has a final letter.' : tips.join(' ') + ' Click to go to the first one.';
      // Counted like the Settings "Grading status" card: pairs of students (the tooltip names the students).
      var oi = orderIssueMap(course, results);
      dom.orderChip.hidden = !oi.count;
      if (oi.count) {
        var n = Object.keys(oi.map).length;
        setHtml(dom.orderChip, ui.icon('alert', 'icon-sm') + plural(oi.count, 'order issue'));
        dom.orderChip.title = plural(oi.count, 'order issue') + ': a student with a lower total has a higher final letter than a student with a higher total (' +
          plural(n, 'student') + ' involved, marked ⚠ in Final letter). Click to go to the first one.';
      }
    }
    syncColumnsMenu();
  }

  /** The "Scores finalized" banner (grid and empty course). The date is in the computer's time zone;
   * a long note is shortened (the whole note is in the tooltip and in History). */
  function lockBannerHtml(course, results) {
    if (!isFinalized(course)) return '';
    var fz = course.finalized || {};
    var note = typeof fz.note === 'string' ? fz.note.trim() : '';
    var shortNote = note.length > NOTE_SHOWN ? note.slice(0, NOTE_SHOWN - 1).trim() + '…' : note;
    var nPart = results ? emptyMeetingCells(course, results) : 0;
    return ui.icon('lock') + '<span class="glb-text"><strong>Scores finalized' +
      (fz.at ? ' on ' + esc(ui.dateTime(fz.at)) : '') + '.</strong> Score cells are locked; final letters stay editable.' +
      (note ? ' <span class="muted glb-note"' + (shortNote !== note ? ' title="' + esc(note) + '"' : '') + '>Note: ' + esc(shortNote) + '</span>' : '') +
      (nPart ? '<span class="glb-part">' + ui.icon('alert', 'icon-sm') + esc(participationName(course)) + ' is empty for ' + esc(plural(nPart, 'active student')) +
        ' and is locked too. To set it in the meeting, unlock the scores first.</span>' : '') +
      '</span><button type="button" class="btn btn-sm" data-act="unlock">' + ui.icon('lock') + 'Unlock scores…</button>';
  }

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  /** Writes the whole table (new columns, row order, grouping or filter) and remembers its rows. */
  function buildTable(table, sig, head, items, noRows, foot) {
    var html = [head, '<tbody>'];
    for (var i = 0; i < items.length; i++) {
      var x = items[i];
      html.push(x.team ? x.html : studentRowHtml(x.parts, x.s, x.r, x.aria));
    }
    html.push(noRows, '</tbody><tfoot>', foot, '</tfoot>');
    table.innerHTML = html.join('');
    var trs = table.tBodies[0].rows, recs = [];
    rowEls = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (it.team) {
        recs.push({ team: true, tr: trs[k], html: it.html });
      } else {
        recs.push({ sid: it.sid, tr: trs[k], parts: it.parts });
        rowEls[it.r] = trs[k];
      }
    }
    built = { table: table, sig: sig, items: recs, foot: foot };
    painted = { range: [], active: null, head: null, row: null };
  }

  /** Same structure as the last build: updates only the cells, team rows and footer whose markup changed,
   * in place. The cells keep their elements, so focus, the selection and the ▾ button stay, and the
   * browser lays out only what changed (a full rebuild made focus() lay out all 300 rows: E2E-7). */
  function patchTable(table, items, foot) {
    var recs = built.items;
    for (var k = 0; k < items.length; k++) {
      var x = items[k], rec = recs[k];
      if (x.team) {
        if (rec.html !== x.html) {
          var tmp = document.createElement('tbody');
          tmp.innerHTML = x.html;
          var fresh = tmp.firstElementChild;
          rec.tr.parentNode.replaceChild(fresh, rec.tr);
          rec.tr = fresh;
          rec.html = x.html;
        }
        continue;
      }
      var a = x.parts, b = rec.parts, tr = rec.tr;
      if (a.cls !== b.cls) tr.className = a.cls + (tr.classList.contains('row-active') ? ' row-active' : '');
      var cells = tr.cells;
      for (var c = 0; c < a.cells.length; c++) {
        var na = a.cells[c], ob = b.cells[c];
        if (na.c !== ob.c || na.ro !== ob.ro || na.t !== ob.t || na.b !== ob.b) patchCell(cells[c], na, ob);
      }
      rec.parts = a;
    }
    if (built.foot !== foot && table.tFoot) {
      table.tFoot.innerHTML = foot;
      built.foot = foot;
    }
  }

  function renderTable() {
    if (!dom || !dom.table) return;
    var t0 = root.performance ? root.performance.now() : 0;
    var course = cur(), results = res();
    if (!course || !results) return;
    var ae = document.activeElement;
    var hadFocus = (ae && dom.table.contains(ae)) || (nowMs() < focusUntil && (!ae || ae === document.body));
    focusUntil = 0;
    var prevRange = rangeSignature();
    layout = buildLayout(course, results, getPrefs());
    normalizeSelection();
    // A re-sort, filter or grouping change (or new totals under a total sort) can move other rows
    // between the two corners: collapse the range to the active cell rather than let Delete, Copy or
    // a paste reach cells the user never selected.
    if (prevRange && rangeSignature() !== prevRange) sel.end = sel.active;
    var ctx = {
      course: course, results: results, cols: layout.cols, dec: decimalsOf(course), teamById: layout.teamById,
      nActive: results.activeIds.length, openStudent: typeof GT.ui.openStudent === 'function',
      nId: layout.nId, locked: isFinalized(course), letterSet: Object.create(null),
      issues: orderIssueMap(course, results), summary: letterSummary(course, results), bandEnd: Object.create(null), att: null
    };
    scaleLetters(course).forEach(function (l) { ctx.letterSet[l] = true; });
    var noById = Object.create(null);
    course.students.forEach(function (s) { noById[s.id] = s.no; });
    ctx.nosOf = function (ids) {
      var nos = ids.slice(0, 4).map(function (id) { return 'No ' + (typeof noById[id] === 'number' ? noById[id] : '?'); });
      return nos.join(', ') + (ids.length > 4 ? ' and ' + (ids.length - 4) + ' more' : '');
    };
    if (layout.cols.some(function (c) { return c.kind === 'attExc' || c.kind === 'attUnx' || c.kind === 'attTot'; })) {
      ctx.att = attLookup(course);
    }
    // Band boundaries: sorted by Total, high to low, a rule sits above the first row of each new final
    // letter (active students only), so the bands read like the old sheet.
    if (layout.prefs.sort === 'total' && layout.prefs.dir === 'desc' && !layout.prefs.grouped) {
      var prev = null, prevRow = null;
      layout.students.forEach(function (st, idx) {
        if (st.status === 'withdrawn') return;
        var fl = storedFinal(st) || '';
        if (prevRow !== null && fl !== prev) ctx.bandEnd[layout.students[idx - 1].id] = true;
        prev = fl;
        prevRow = idx;
      });
    }
    // Every row as parts (strings only). The DOM is then patched cell by cell when the structure (the
    // header markup and the rows in order) is the same as last time, else rebuilt (CODE-5, E2E-7).
    var head = headHtml(ctx);
    var items = [], keys = [];
    var ariaRow = 2;
    for (var i = 0; i < layout.items.length; i++) {
      var it = layout.items[i];
      if (it.type === 'team') {
        items.push({ team: true, html: teamRowHtml(ctx, it.team, ariaRow) });
        keys.push('#' + (it.team ? it.team.id : ''));
      } else {
        items.push({ sid: it.s.id, s: it.s, r: it.r, aria: ariaRow, parts: studentRowParts(ctx, it.s) });
        keys.push(it.s.id);
      }
      ariaRow++;
    }
    var noRows = '';
    if (!layout.students.length) {
      noRows = '<tr class="no-rows"><td colspan="' + layout.cols.length + '"><div class="no-rows-msg">' +
        (searchText.trim() ? 'No students match “' + esc(searchText.trim()) + '”.' : 'No students to show. Withdrawn students are hidden.') +
        '</div></td></tr>';
      ariaRow++;
    }
    var foot = footRowHtml(ctx, ariaRow);
    var table = dom.table;
    var sig = head + '\u0002' + keys.join('\n') + '\u0002' + noRows;
    if (built && built.table === table && built.sig === sig && !editing) patchTable(table, items, foot);
    else buildTable(table, sig, head, items, noRows, foot);
    var width = 0;
    layout.cols.forEach(function (c) { width += c.width; });
    if (table.style.width !== width + 'px') table.style.width = width + 'px';
    setAttr(table, 'aria-rowcount', String(ariaRow));
    setAttr(table, 'aria-colcount', String(layout.cols.length));
    setAttr(table, 'aria-label', 'Grades for ' + course.code);
    table.classList.toggle('grouped', layout.prefs.grouped);
    table.classList.toggle('meeting', layout.prefs.meeting);
    // Meeting view: First Name is pinned right after No and Last Name, whose width fits the names.
    var sc3 = layout.prefs.meeting ? (layout.cols[0].width + layout.cols[1].width) + 'px' : '';
    if (table.style.getPropertyValue('--sc3-left') !== sc3) {
      if (sc3) table.style.setProperty('--sc3-left', sc3); else table.style.removeProperty('--sc3-left');
    }
    table.classList.toggle('locked', ctx.locked);
    if (dom.resort && dom.resort.hidden !== !layout.stale) {
      dom.resort.hidden = !layout.stale;
      queueWrapTop();
    }
    paintSelection();
    var count = layout.shown === layout.total ? plural(layout.total, 'student') : 'Showing ' + layout.shown + ' of ' + layout.total;
    if (dom.count.textContent !== count) dom.count.textContent = count;
    dataDirty = false;
    tableDirty = false;
    if (hadFocus) focusActive();
    if (revealActive) {
      revealActive = false;
      var ra = posOf(sel.active);
      if (ra) ensureVisible(cellAt(ra.r, ra.c));
    }
    if (pendingEdit) {
      var pe = pendingEdit;
      pendingEdit = null;
      if (posOf(pe)) {
        sel.active = pe;
        sel.end = pe;
        paintSelection();
        var p = posOf(pe);
        ensureVisible(cellAt(p.r, p.c));
        startEdit('edit');
      }
    }
    lastRenderMs = root.performance ? root.performance.now() - t0 : 0;
    dodgeToasts();
  }

  function render(el, ctx) {
    if (el !== boundEl) {
      bindContainer(el);
      boundEl = el;
      dom = null;
      mode = null;
      editing = null;
      drag = null;
    }
    bindGlobal();
    ensureLeaveHook();
    var course = ctx.course;
    if (!course) {
      el.innerHTML = '<div class="empty-state"><h2>No course</h2><p>Add a course from the course menu.</p></div>';
      dom = null;
      mode = 'none';
      return;
    }
    var switchedCourse = course.id !== lastCourseId;
    if (switchedCourse) {
      lastCourseId = course.id;
      sel = { active: null, end: null, lastR: 0 };
      editing = null;
      newRowSid = null;
      tabStartKey = null;
      endHold = null;
    }
    var params = ctx.params && ctx.params !== lastParams ? ctx.params : null;
    if (params) lastParams = params;
    // navigate('grades', { studentId, assessmentId }) or navigate('grades', { focus: { studentId, assessmentId } })
    // selects that student's raw score cell (the Settings late-work list links here).
    var fp = params ? (util.isPlainObject(params.focus) ? params.focus : params) : null;
    var target = fp && typeof fp.studentId === 'string' ? model.findStudent(course, fp.studentId) : null;
    if (target) {
      var aidOk = typeof fp.assessmentId === 'string' && !!model.findAssessment(course, fp.assessmentId);
      var key = aidOk ? 'raw:' + fp.assessmentId : (sel.active ? sel.active.key : 'raw:' + (course.assessments[0] ? course.assessments[0].id : ''));
      sel.active = { sid: target.id, key: key };
      sel.end = sel.active;
      searchText = '';
      if (dom && dom.search) dom.search.value = '';
      revealActive = true;
      dataDirty = true;
      focusUntil = nowMs() + 1500; // the link that led here is gone: the cell takes the focus
      // A withdrawn student hidden by the filter is shown again, so the cell exists.
      if (target.status === 'withdrawn' && !getPrefs().showWithdrawn) setPrefs({ showWithdrawn: true });
    }
    var want = course.students.length ? 'grid' : 'empty';
    var rebuilt = false;
    if (want !== mode || !dom) {
      buildSkeleton(el, want);
      mode = want;
      rebuilt = true;
    }
    renderHead(course, ctx.results);
    if (mode === 'empty') { renderEmpty(course); return; }
    renderToolbar(course, ctx.results);
    queueWrapTop();
    if (editing) { tableDirty = true; return; }
    if (!rebuilt && !dataDirty && !switchedCourse && !ctx.switched && layout) return;
    renderTable();
  }

  /** Leave hook (CONTRACT §2, E2E-4): the page is being hidden, reloaded or closed. A score or name being
   * typed is saved as a click elsewhere would save it (an open drop-down list closes without a choice),
   * before app.js flushes the store. The cell keeps the focus for when the user comes back. */
  function commitOnLeave() {
    if (!editing) return;
    var had = document.activeElement === editing.input;
    leaveEditor();
    if (had && isActiveView() && !editing) focusActive();
  }

  /** app.js loads after this file: register the leave hook on the first render, once. */
  function ensureLeaveHook() {
    if (leaveHooked) return;
    if (GT.app && typeof GT.app.registerLeaveHook === 'function') {
      GT.app.registerLeaveHook(commitOnLeave);
      leaveHooked = true;
    }
  }

  function destroy() {
    closeColumnsMenu(false);
    // Leaving the view (e.g. Alt+2) removes the container before the editor's focusout can commit:
    // save the typed value now, like a click elsewhere does.
    if (editing) {
      try { leaveEditor(); } catch (e) { if (root.console) console.error(e); }
    }
    editing = null;
    drag = null;
    tabExit = false;
    var host = document.getElementById('toasts');
    if (host) host.classList.remove(TOASTS_LEFT);
  }

  // ------------------------------------------------------------------ editing

  function editText(course, s, col) {
    if (col.kind === 'no') return typeof s.no === 'number' ? String(s.no) : '';
    if (col.kind === 'last') return s.lastName || '';
    if (col.kind === 'first') return s.firstName || '';
    if (col.kind === 'raw') {
      var a = model.findAssessment(course, col.aid);
      return a ? detailText(calc.scoreDetail(course, s, a)) : '';
    }
    if (col.kind === 'final') return storedFinal(s) || '';
    return '';
  }

  /** The hint under a drop-down cell's text box: what may be typed, and how many rows it applies to. */
  function ddHintText(course, col, band) {
    var what = col.kind === 'final' ? 'Type a letter: ' + scaleLetters(course).join(' ') : 'Type a value from the list: ' + choiceRange(col.a, col.choices);
    return (band ? 'Applies to ' + plural(band.sids.length, 'selected student') + '. ' : '') + what + ' · Alt+↓ shows the list';
  }

  /** Keeps a popup that hangs off a cell (list, hint) inside the grid's scroll box: it opens upwards
   * when there is no room below, and grows to the left when there is no room on the right. While it
   * is open the cell sits over the sticky header and footer (css: has-popup), which it may cover. */
  function fitPopup(el, td) {
    td.classList.add('has-popup');
    var wr = dom.wrap.getBoundingClientRect(), tr = td.getBoundingClientRect();
    var h = el.offsetHeight, w = el.offsetWidth;
    var below = el.classList.contains('dd-hint') ? tr.bottom + h : tr.top + h;
    var above = el.classList.contains('dd-hint') ? tr.top - h : tr.bottom - h;
    if (below > wr.bottom - 4 && above > wr.top) el.classList.add('drop-up');
    if (tr.left + w > wr.left + dom.wrap.clientWidth - 4 && tr.right - w > wr.left) el.classList.add('grow-left');
  }

  function addHint(td, text, id) {
    var h = document.createElement('div');
    h.className = 'dd-hint';
    h.id = id;
    h.textContent = text;
    td.appendChild(h);
    fitPopup(h, td);
    return h;
  }

  /** Opens an editor on the active cell. how: 'enter' (typing replaces the value), 'edit' (Enter, F2,
   * double-click: keeps the value) or 'list' (Alt+Down). A drop-down cell (Final letter, a score with a
   * list) opens its list for 'edit' and 'list'; typing gives a text box whose value must be on the list. */
  function startEdit(how, initial) {
    if (editing || !layout) return;
    var p = posOf(sel.active);
    if (!p) return;
    // F2, a double-click, Alt+Down or a menu item edits the held cell on purpose: the hold ends.
    endHold = null;
    var col = layout.cols[p.c];
    if (!col.edit) return;
    var course = cur();
    if (lockedCol(course, col)) { notifyLocked(); return; }
    var s = model.findStudent(course, layout.students[p.r].id);
    var td = cellAt(p.r, p.c);
    if (!s || !td) return;
    var who = studentLabel(s);
    ensureVisible(td);
    if (col.edit === 'team') { openTeamEditor(td, s, course, who, col); return; }
    var band = col.dd ? bandRows() : null;
    if (col.dd && how !== 'enter') { openListEditor(td, s, course, col, band, null); return; }
    var a = col.aid ? model.findAssessment(course, col.aid) : null;
    var current = editText(course, s, col);
    var input = document.createElement('input');
    input.type = 'text';
    var numeric = col.kind === 'raw' || col.kind === 'no';
    input.className = 'cell-editor' + (col.kind === 'last' || col.kind === 'first' ? ' pii' : '') +
      (numeric ? ' is-num' : '') + (col.kind === 'final' ? ' is-letter' : '');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    if (col.kind === 'raw') input.setAttribute('inputmode', 'decimal');
    if (col.kind === 'no') input.setAttribute('inputmode', 'numeric');
    if (col.kind === 'final') input.setAttribute('autocapitalize', 'characters');
    input.setAttribute('aria-label', (col.kind === 'raw' ? (a ? a.name : col.label) : col.label) + ' for ' + who +
      (band ? ' and ' + plural(band.sids.length - (band.sids.indexOf(s.id) === -1 ? 0 : 1), 'other selected student') : ''));
    input.value = how === 'enter' ? (initial || '') : current;
    td.classList.add('is-editing');
    td.appendChild(input);
    editing = {
      sid: s.id, key: col.key, kind: col.edit, list: false, aid: col.aid || null, mode: how, input: input, td: td,
      original: current, max: a ? a.maxScore : null, col: col, band: band, hint: null
    };
    if (col.dd) {
      editing.hint = addHint(td, ddHintText(course, col, band), 'dd-hint-live');
      input.setAttribute('aria-describedby', 'dd-hint-live');
    }
    input.classList.toggle('mode-edit', how === 'edit');
    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    var len = input.value.length;
    try { input.setSelectionRange(len, len); } catch (e2) { /* ignore */ }
    validateEditor();
    if (editing && editing.hint) dodgeToasts();
  }

  function openTeamEditor(td, s, course, who, col) {
    var box = document.createElement('select');
    box.className = 'cell-editor list-editor team-editor';
    var current = s.teamId && model.findTeam(course, s.teamId) ? s.teamId : '';
    box.innerHTML = '<option value="">(no team)</option>' + course.teams.map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
    }).join('') + '<option value="' + NEW_TEAM + '">New team…</option>';
    box.size = Math.max(3, Math.min(10, course.teams.length + 2));
    box.value = current;
    box.setAttribute('aria-label', 'Team for ' + who + ' (Enter to choose, Esc to cancel)');
    td.classList.add('is-editing');
    td.appendChild(box);
    fitPopup(box, td);
    editing = { sid: s.id, key: 'team', kind: 'team', list: true, aid: null, mode: 'edit', input: box, td: td, original: current, max: null, col: col, band: null, hint: null, pointerAt: 0 };
    try { box.focus({ preventScroll: true }); } catch (e) { box.focus(); }
  }

  /** Index of the value that typed text means: an exact match first (letters ignore case and spaces;
   * numbers compare by value), else the first value that starts with it; -1 when none. Empty values
   * ("(none)", "(empty)") are never matched. */
  function findOption(values, kind, text) {
    var norm = function (x) { return String(x).replace(/[‐-―−]/g, '-').replace(/\s+/g, '').toLowerCase(); };
    var t = norm(text);
    if (t === '') return -1;
    var n = kind === 'choice' && /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
    var prefix = -1;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v === '') continue;
      if (norm(v) === t || (n !== null && util.fix(Number(v)) === util.fix(n))) return i;
      if (prefix === -1 && norm(v).indexOf(t) === 0) prefix = i;
    }
    return prefix;
  }

  /** The drop-down list (a native <select> shown as a list box) of a Final letter or list-score cell.
   * With a band (several selected rows), the chosen value applies to all of them. */
  function openListEditor(td, s, course, col, band, typed) {
    var box = document.createElement('select');
    box.className = 'cell-editor list-editor dd-editor';
    var opts;
    if (col.kind === 'final') {
      opts = [{ value: '', label: '(none)' }].concat(scaleLetters(course).map(function (l) { return { value: l, label: l }; }));
    } else {
      opts = [{ value: '', label: '(empty)' }].concat(col.choices.map(function (v) { return { value: String(v), label: String(v) }; }));
    }
    var optHtml = opts.map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; }).join('');
    // Band: the list says how many students the choice applies to (a group label inside the list).
    box.innerHTML = band ? '<optgroup label="' + esc('For ' + plural(band.sids.length, 'student')) + '">' + optHtml + '</optgroup>' : optHtml;
    box.size = Math.max(3, Math.min(band ? 15 : 14, opts.length + (band ? 1 : 0)));
    var current = listValueOf(course, s, col);
    // A band opens with nothing highlighted unless every selected row already has the same value, so
    // Enter or Tab without a choice never copies the active row's value to the whole band.
    var bandSame = true;
    if (band && band.sids.length) {
      var first = listValueOf(course, model.findStudent(course, band.sids[0]), col);
      bandSame = band.sids.every(function (id) { return listValueOf(course, model.findStudent(course, id), col) === first; });
      if (bandSame) current = first;
    }
    box.value = current;
    if (!bandSame || box.value !== current) box.selectedIndex = -1; // mixed band, or a value not on the list
    if (typed) box.selectedIndex = findOption(opts.map(function (x) { return x.value; }), col.edit, typed);
    var who = studentLabel(s);
    var others = band ? band.sids.filter(function (id) { return id !== s.id; }).length : 0;
    box.setAttribute('aria-label', (col.kind === 'final' ? 'Final letter' : col.a.name) + ' for ' + who +
      (others ? ' and ' + plural(others, 'other selected student') : '') + ' (Enter to choose, Esc to cancel)');
    td.classList.add('is-editing');
    td.appendChild(box);
    fitPopup(box, td);
    editing = {
      sid: s.id, key: col.key, kind: col.edit, list: true, aid: col.aid || null, mode: 'edit', input: box, td: td,
      original: current, max: col.a ? col.a.maxScore : null, col: col, band: band, bandSame: !!band && bandSame, hint: null, taBuf: '', taAt: 0,
      pointerAt: 0 // time of the last mouse press in this list (0 = none since it opened, or a key since)
    };
    try { box.focus({ preventScroll: true }); } catch (e) { box.focus(); }
    dodgeToasts();
  }

  /** A student's value as the drop-down list spells it: the letter or list value, '' when empty, and
   * '\u0000' for a value the list does not hold (invalid text). */
  function listValueOf(course, s, col) {
    if (!s) return '';
    if (col.kind === 'final') return storedFinal(s) || '';
    var d = calc.scoreDetail(course, s, col.a);
    return d.state === 'number' ? String(util.fix(d.raw)) : (d.state === 'invalid' ? '\u0000' : '');
  }

  /** Type-ahead in a drop-down list: "4" picks 4 (not 4.5), "b+" picks B+. */
  function listTypeAhead(k) {
    var ed = editing;
    var t = nowMs();
    if (t - ed.taAt > 1000) ed.taBuf = '';
    ed.taAt = t;
    ed.taBuf += k;
    var values = Array.prototype.map.call(ed.input.options, function (x) { return x.value; });
    var idx = findOption(values, ed.kind, ed.taBuf);
    if (idx === -1 && ed.taBuf.length > 1) {
      ed.taBuf = k;
      idx = findOption(values, ed.kind, k);
    }
    if (idx >= 0) ed.input.selectedIndex = idx;
    else ddBadToast(ed, ed.taBuf, false);
  }

  /** Alt+Down in a drop-down cell's text box: show the list instead, with the typed value picked. */
  function switchToList() {
    var ed = editing;
    if (!ed) return;
    var typed = ed.input.value;
    closeEditor(false);
    var p = posOf({ sid: ed.sid, key: ed.key });
    var course = cur();
    var s = model.findStudent(course, ed.sid);
    var td = p ? cellAt(p.r, p.c) : null;
    if (!s || !td) return;
    openListEditor(td, s, course, ed.col, ed.band, typed);
  }

  function ddBadMsg(ed, text) {
    if (ed.kind === 'letter') {
      return '“' + String(text).trim().slice(0, 20) + '” is not a letter of this course. Choose one of: ' + scaleLetters(cur()).join(', ') + '.';
    }
    return 'Choose a value from the list (' + choiceRange(ed.col.a, ed.col.choices) + ').';
  }

  function ddBadToast(ed, text, force) {
    if (!force && nowMs() - ddToastAt < 2500) return;
    ddToastAt = nowMs();
    ui.toast(ddBadMsg(ed, text), { type: 'warn', timeout: 5000 });
  }

  function validateEditor() {
    var ed = editing;
    if (!ed || ed.list) return;
    var v = ed.input.value, bad = false, warn = false;
    if (ed.key === 'no') {
      var t = v.trim();
      bad = t !== '' && !(/^\d+$/.test(t) && parseInt(t, 10) >= 1);
    } else if (ed.kind === 'score') {
      var p = util.parseScoreInput(v, ed.max);
      bad = p.kind === 'invalid';
      warn = p.kind === 'number' && (p.value < 0 || (ed.max !== null && p.value > ed.max));
    } else if (ed.kind === 'letter' || ed.kind === 'choice') {
      // Red as soon as the text can no longer become a value of the list, and never for text that
      // Enter would accept (a list value typed as a percentage of the max, "90%" = 4.5 of 5).
      if (v.trim() !== '') {
        bad = findOption(ed.kind === 'letter' ? scaleLetters(cur()) : ed.col.choices.map(String), ed.kind, v) === -1 &&
          !!(ed.kind === 'letter' ? matchLetter(cur(), v) : matchChoice(ed.col.a, ed.col.choices, v)).bad;
      }
    }
    ed.input.classList.toggle('is-bad', bad);
    ed.input.classList.toggle('is-warn', warn);
    ed.input.setAttribute('aria-invalid', bad ? 'true' : 'false');
  }

  function closeEditor(refocus) {
    var ed = editing;
    if (!ed) return;
    editing = null;
    removeEditor(ed, refocus);
  }

  /** Takes a closed editor (editing already null) out of its cell. */
  function removeEditor(ed, refocus) {
    if (ed.input.parentNode) ed.input.parentNode.removeChild(ed.input);
    if (ed.hint && ed.hint.parentNode) ed.hint.parentNode.removeChild(ed.hint);
    ed.td.classList.remove('is-editing', 'has-popup');
    if (refocus && ed.td.isConnected) focusCell(ed.td);
    if (tableDirty) { tableDirty = false; renderTable(); }
  }

  function cancelEdit() {
    closeEditor(true);
  }

  /** Focus or a click moved elsewhere: text is saved (like Excel); an open drop-down list closes
   * without choosing anything, like a native drop-down. */
  function leaveEditor() {
    if (!editing) return;
    if (editing.list && editing.kind !== 'team') closeEditor(false);
    else commitEdit(null, { soft: true });
  }

  /** Commits the open editor. move: null | 'enter' | 'up' | 'down' | 'left' | 'right' | 'tab' | 'shift-tab'.
   * opts.soft: focus has moved elsewhere (blur or a click), so do not take it back. */
  function commitEdit(move, opts) {
    var ed = editing;
    if (!ed) return true;
    var o = opts || {};
    if (ed.list && ed.kind !== 'team') {
      // Drop-down list: the highlighted option (nothing highlighted = nothing chosen).
      var chosen = ed.input.selectedIndex < 0 ? null : ed.input.value;
      closeEditor(!o.soft);
      if (chosen === null) {
        // Nothing chosen: nothing changes. Tab still moves on (it leaves the list).
        if (!o.soft && (move === 'tab' || move === 'shift-tab')) moveAfterCommit(ed, move, false);
        return true;
      }
      applyDropValue(ed, chosen === '' ? { empty: true } : (ed.kind === 'letter' ? { letter: chosen } : { value: Number(chosen) }), move, o,
        ed.bandSame && chosen === ed.original);
      return true;
    }
    var value = ed.input.value;
    if (ed.kind === 'letter' || ed.kind === 'choice') {
      // Typed into a drop-down cell: it must be a value of the list; nothing else is ever stored.
      var m = ed.kind === 'letter' ? matchLetter(cur(), value) : matchChoice(ed.col.a, ed.col.choices, value);
      if (m.bad) {
        if (o.soft) {
          closeEditor(false);
          ui.toast(ddBadMsg(ed, value) + ' Nothing was saved.', { type: 'warn', timeout: 6000 });
          return false;
        }
        ddBadToast(ed, value, true);
        ed.input.select();
        return false;
      }
      if (move && !o.soft && !ed.band) {
        // One cell: move on first, then write (see moveFirst).
        moveFirst(ed, move, false);
        applyDropValue(ed, m, null, o);
        keepGridFocus(ed);
        return true;
      }
      closeEditor(!o.soft);
      applyDropValue(ed, m, move, o);
      return true;
    }
    if (ed.key === 'no') {
      var t = value.trim();
      if (t !== '' && !(/^\d+$/.test(t) && parseInt(t, 10) >= 1)) {
        if (o.soft) {
          closeEditor(false);
          ui.toast('No must be a whole number above 0. That change was not saved.', { type: 'warn' });
          return false;
        }
        ui.toast('No must be a whole number above 0 (or empty).', { type: 'warn' });
        ed.input.select();
        return false;
      }
    }
    var wasNew = ed.sid === newRowSid;
    if (move && !o.soft) {
      moveFirst(ed, move, wasNew);
      if (value !== ed.original) applyEdit(ed, value);
      keepGridFocus(ed);
      return true;
    }
    closeEditor(!o.soft);
    if (value !== ed.original) applyEdit(ed, value);
    if (move) moveAfterCommit(ed, move, wasNew);
    return true;
  }

  /** A commit that moves on (Enter, Tab, an arrow): the next cell takes the focus while the table is still
   * laid out, and only then does the editor leave its cell. Focusing after the removal made focus() lay
   * out the whole table again on every committed edit (E2E-7: about 10 ms at 300 students). The rows
   * do not move in between (the order is a snapshot; the table re-renders on the next frame). */
  function moveFirst(ed, move, wasNew) {
    editing = null; // the editor's focusout and change events are ignored from here on
    moveAfterCommit(ed, move, wasNew);
    removeEditor(ed, false);
  }

  /** After a commit that moved on: the cell moved to has the focus. When nothing took it (the row is gone)
   * the grid keeps it; focus that went somewhere on purpose (a dialog) stays there. */
  function keepGridFocus(ed) {
    if (!dom || !dom.table) return;
    var ae = document.activeElement;
    if (ae && ae !== document.body) return;
    if (posOf(sel.active)) focusActive();
    else if (ed.td.isConnected) focusCell(ed.td);
  }

  /** Stores a value chosen (or typed) in a drop-down cell: for the one student, or for every student of
   * the band. m: { empty } | { letter } | { value }. Then moves like a score edit; after a band, the
   * cursor waits on the row below it, ready for the next band. unchanged: the band's list opened on
   * the value every row already has, and it was chosen again (nothing to write). */
  function applyDropValue(ed, m, move, o, unchanged) {
    var course = cur();
    var s = model.findStudent(course, ed.sid);
    if (!s) return;
    var band = ed.band && ed.band.sids.length ? ed.band : null;
    if (ed.band && !band) {
      ui.toast('Only withdrawn students are selected: nothing was changed.', { type: 'info' });
      return;
    }
    if (band && unchanged) {
      // Nothing to write; the cursor still moves below the band, ready for the next one.
    } else if (ed.kind === 'letter') {
      var letter = m.empty ? null : m.letter;
      if (band) {
        var n = 0;
        focusUntil = nowMs() + 1500;
        transact((letter ? 'Final letter ' + letter : 'Clear final letter') + ' for ' + plural(band.sids.length, 'student'), function (c) {
          n = writeFinalLetters(c, band.sids.map(function (id) { return { studentId: id, letter: letter }; }));
        });
        if (txFailed) return;
        var msg = (letter ? 'Final letter ' + letter + ' set for ' : 'Final letter cleared for ') + plural(band.sids.length, 'student') + '.' +
          (n < band.sids.length ? ' (' + (band.sids.length - n) + ' already had it.)' : '') +
          (ed.band.withdrawn ? ' ' + plural(ed.band.withdrawn, 'withdrawn student') + ' skipped.' : '');
        if (!bandToastShown && letter) {
          bandToastShown = true;
          msg += ' Next: select the next group of rows (Shift+↓ or Shift+click) and choose its letter.';
        }
        gridToast(msg, { type: 'success', timeout: 6000 });
      } else if (storedFinal(s) !== letter) {
        transact('Edit final letter', function (c) {
          writeFinalLetters(c, [{ studentId: ed.sid, letter: letter }]);
        });
      }
    } else {
      var text = m.empty ? '' : String(m.value);
      if (band) {
        runBlock({
          ops: band.sids.map(function (id) { return { sid: id, kind: 'raw', aid: ed.aid, text: text }; }),
          skipped: [], fill: true, source: 'edit', droppedRows: 0, droppedCols: 0, selA: null, selE: null,
          label: (text === '' ? 'Clear ' + ed.col.a.name : ed.col.a.name + ' ' + text) + ' for ' + plural(band.sids.length, 'student'),
          doneMsg: (text === '' ? ed.col.a.name + ' cleared for ' : ed.col.a.name + ' ' + text + ' set for ') + plural(band.sids.length, 'student') + '.' +
            (ed.band.withdrawn ? ' ' + plural(ed.band.withdrawn, 'withdrawn student') + ' skipped.' : '')
        }, null);
      } else if (text !== ed.original) {
        applyEdit(ed, text);
      }
    }
    if (o && o.soft) return;
    if (band) {
      var p = posOf({ sid: ed.sid, key: ed.key });
      var nR = layout.students.length;
      if (!p) return;
      tabStartKey = null;
      // A band that reaches the end of the list leaves the cursor in it: hold that cell (E2E-2).
      if (!move || move === 'enter' || move === 'down') {
        moveTo(Math.min(ed.band.r2 + 1, nR - 1), p.c, false);
        if (ed.band.r2 + 1 > nR - 1) holdAtEdge('last');
      } else if (move === 'up') {
        moveTo(Math.max(ed.band.r1 - 1, 0), p.c, false);
        if (ed.band.r1 - 1 < 0) holdAtEdge('first');
      } else moveAfterCommit(ed, move, false);
    } else if (move) {
      moveAfterCommit(ed, move, false);
    }
  }

  function moveAfterCommit(ed, move, wasNew) {
    var p = posOf({ sid: ed.sid, key: ed.key });
    if (!p) return;
    var nR = layout.students.length, nC = layout.cols.length;
    var r = p.r, c = p.c;
    if (move === 'enter' && wasNew && (ed.key === 'last' || ed.key === 'first')) { moveTo(r, c + 1, false); return; }
    if (move === 'enter') {
      if (tabStartKey !== null && layout.colOfKey[tabStartKey] !== undefined) c = layout.colOfKey[tabStartKey];
      tabStartKey = null;
      r++;
    } else if (move === 'up') { r--; tabStartKey = null; }
    else if (move === 'down') { r++; tabStartKey = null; }
    else if (move === 'left') { c--; tabStartKey = null; }
    else if (move === 'right') { c++; tabStartKey = null; }
    else if (move === 'tab' || move === 'shift-tab') {
      var t = tabTarget(p, move === 'shift-tab');
      if (!t) { moveTo(r, c, false); return; }
      if (tabStartKey === null) tabStartKey = ed.key;
      r = t.r; c = t.c;
    }
    var edge = (move === 'enter' || move === 'down') && r > nR - 1 ? 'last' : move === 'up' && r < 0 ? 'first' : null;
    moveTo(clamp(r, 0, nR - 1), clamp(c, 0, nC - 1), false);
    if (edge) holdAtEdge(edge);
  }

  /** True when `ref` is the cell held at the end of the list. */
  function heldAt(ref) {
    return !!endHold && !!ref && endHold.sid === ref.sid && endHold.key === ref.key;
  }

  /** A value was committed with Enter or Down on the last row (Up on the first): the cursor cannot move
   * on, so hold this cell. The next typed keys would otherwise replace the value just entered, silently
   * (E2E-2; the Attendance grid does the same). */
  function holdAtEdge(edge) {
    if (!sel.active) return;
    endHold = { sid: sel.active.sid, key: sel.active.key };
    endHoldToastAt = 0;
    ui.toast('That was the ' + edge + ' student in the list.', { type: 'info', timeout: 3500 });
  }

  /** A typed key (or Enter) on the held cell: not used. Says so (at most every few seconds while a quick
   * typist keeps going) and how to go on. */
  function endHoldKey() {
    if (nowMs() - endHoldToastAt < 4000) return;
    endHoldToastAt = nowMs();
    ui.toast('End of the list: that key was not used, so the value just entered is not replaced by accident. ' +
      'Move to a cell first (or press F2 to edit this one).', { type: 'warn', timeout: 6000 });
  }

  /** Writes a typed score following the K5 rules. Returns what was written. */
  function writeScore(c, sid, aid, text) {
    var s = model.findStudent(c, sid), a = model.findAssessment(c, aid);
    if (!s || !a) return null;
    var team = a.teamGraded && s.teamId ? model.findTeam(c, s.teamId) : null;
    if (!team) {
      var prev = model.getEntry(c.scores, sid, aid);
      var e = model.entryFromInput(text, prev, a.maxScore);
      delete e.override;
      model.setEntry(c.scores, sid, aid, model.isBlankEntry(e) ? null : e);
      return { kind: 'individual' };
    }
    var own = model.getEntry(c.scores, sid, aid);
    if (own && own.override === true) {
      var eo = model.entryFromInput(text, own, a.maxScore);
      if (eo.override) { model.setEntry(c.scores, sid, aid, eo); return { kind: 'override' }; }
      model.clearOverride(c, sid, aid);
      return { kind: 'override-removed', team: team, teamText: entryText(model.getEntry(c.teamScores, team.id, aid)) };
    }
    var prevT = model.getEntry(c.teamScores, team.id, aid);
    model.setTeamScore(c, team.id, aid, model.entryFromInput(text, prevT, a.maxScore));
    return { kind: 'team', team: team, members: model.teamMembers(c, team.id).length };
  }

  function applyEdit(ed, value) {
    var course = cur();
    var s = model.findStudent(course, ed.sid);
    if (!s) return;
    if (ed.key === 'no') {
      var t = value.trim();
      var newNo = t === '' ? null : parseInt(t, 10);
      var oldNo = s.no;
      transact('Edit No', function (c) {
        var st = model.findStudent(c, ed.sid);
        if (st) st.no = newNo;
      });
      if (txFailed) return;
      // Like Excel, a duplicate No is allowed (e.g. while swapping two numbers), but say so.
      if (newNo !== null && newNo !== oldNo && course.students.some(function (o) { return o.id !== ed.sid && o.no === newNo; })) {
        ui.toast('No ' + newNo + ' is also used by another student. Students & Teams → Renumber by name fixes the numbering.', { type: 'warn', timeout: 6000 });
      }
    } else if (ed.key === 'last' || ed.key === 'first') {
      var field = ed.key === 'last' ? 'lastName' : 'firstName';
      transact(ed.key === 'last' ? 'Edit last name' : 'Edit first name', function (c) {
        var st = model.findStudent(c, ed.sid);
        if (st) st[field] = value.trim();
      });
    } else if (ed.key === 'team') {
      changeTeam(ed.sid, value);
    } else if (ed.kind === 'score' || ed.kind === 'choice') {
      var a = model.findAssessment(course, ed.aid);
      if (!a) return;
      var info = null;
      transact('Edit ' + a.name, function (c) { info = writeScore(c, ed.sid, ed.aid, value); });
      if (!info) return;
      if (info.kind === 'team' && info.members > 1 && !teamToastShown) {
        teamToastShown = true;
        ui.toast('Team score updated for all ' + info.members + ' members of ' + info.team.name +
          '. To give one student a different score, use the cell menu → Override.', { type: 'info', timeout: 7000 });
      } else if (info.kind === 'override-removed') {
        ui.toast('Override removed: ' + studentLabel(s) + ' now uses the ' + info.team.name + ' team score' +
          (info.teamText ? ' (' + info.teamText + ')' : '') + '.', { type: 'info' });
      }
    }
  }

  // ------------------------------------------------------------------ teams

  function suggestTeamName(course) {
    var n = course.teams.length + 1;
    var taken = function (name) { return course.teams.some(function (t) { return t.name.toLowerCase() === name.toLowerCase(); }); };
    while (taken('Team ' + n)) n++;
    return 'Team ' + n;
  }

  function changeTeam(sid, value) {
    if (value === NEW_TEAM) {
      var course = cur();
      ui.dialog.prompt({
        title: 'New team', label: 'Team name', value: suggestTeamName(course), confirmText: 'Create team', required: true,
        validate: function (v) {
          var name = String(v || '').trim();
          if (!name) return 'Enter a team name.';
          if (cur().teams.some(function (t) { return t.name.toLowerCase() === name.toLowerCase(); })) return 'A team with this name already exists.';
          return null;
        }
      }).then(function (name) {
        if (name === null) { refocusGrid(); return; }
        moveStudent(sid, null, name.trim());
      });
      return;
    }
    moveStudent(sid, value || null, null);
  }

  function moveStudent(sid, teamId, newTeamName) {
    var course = cur();
    var s = model.findStudent(course, sid);
    if (!s) return;
    var current = s.teamId && model.findTeam(course, s.teamId) ? s.teamId : null;
    var target = newTeamName ? null : (teamId && model.findTeam(course, teamId) ? teamId : null);
    if (!newTeamName && target === current) return;
    var toTeam = !!(target || newTeamName);
    var targetName = newTeamName || (target ? model.findTeam(course, target).name : 'no team');
    var changed = course.assessments.filter(function (a) {
      if (!a.teamGraded) return false;
      var eff = model.effectiveEntry(course, s, a);
      if (!model.hasScore(eff)) return false;
      var next = target ? model.getEntry(course.teamScores, target, a.id) : null;
      return model.entryKey(eff) !== model.entryKey(next);
    });
    var who = studentLabel(s);
    var run = function (keep) {
      refocusGrid();
      var ok = transact(newTeamName ? 'Create team and move student' : 'Change team', function (c) {
        var tid = target;
        if (newTeamName) {
          var t = model.createTeam(newTeamName);
          c.teams.push(t);
          tid = t.id;
        }
        model.moveStudentToTeam(c, sid, tid, { keepScores: keep });
        return true;
      });
      if (!ok) return;
      ui.toast(who + (toTeam ? ' moved to ' + targetName + '.' : ' now has no team.') +
        (keep && changed.length ? (toTeam ? ' Current scores kept as per-member overrides (◆).' : ' Current scores kept as individual scores.') : ''),
      { type: 'success' });
    };
    if (!changed.length) { run(false); return; }
    var names = changed.map(function (a) { return a.name; }).join(', ');
    ui.dialog.open({
      title: 'Change team for ' + who,
      bodyHtml: '<p>' + esc(who) + ' has team-graded scores that differ from ' + esc(targetName === 'no team' ? 'having no team' : targetName + '\'s scores') +
        ': <strong>' + esc(names) + '</strong>.</p>' +
        '<p>Keep this student\'s current ' + esc(names) + ' score' + (changed.length > 1 ? 's' : '') +
        (toTeam ? ' (as per-member overrides ◆), or use the new team\'s scores?' : ' (as individual scores), or remove them?') + '</p>' +
        (toTeam ? '<p class="muted small">An unequal split within a team needs the team\'s written agreement. Every change is logged in History.</p>' : ''),
      buttons: [
        { text: 'Cancel', value: null },
        { spacer: true },
        { text: toTeam ? 'Use the new team\'s scores' : 'Remove the scores', value: 'team' },
        { text: toTeam ? 'Keep current scores (as overrides)' : 'Keep current scores', value: 'keep', primary: true }
      ]
    }).then(function (v) {
      if (!v) { refocusGrid(); return; }
      run(v === 'keep');
    });
  }

  function editTeamScore(teamId, aid) {
    var course = cur();
    var team = model.findTeam(course, teamId), a = model.findAssessment(course, aid);
    if (!team || !a) return;
    var members = model.teamMembers(course, teamId);
    var overrides = members.filter(function (m) {
      var own = model.getEntry(course.scores, m.id, aid);
      return own && own.override === true;
    }).length;
    var help = 'Applies to all ' + plural(members.length, 'member') + (overrides ? ' except ' + overrides + ' with a per-member override (◆)' : '');
    var entry = model.getEntry(course.teamScores, teamId, aid);
    var save = function (text) {
      refocusGrid();
      transact('Edit team score (' + a.name + ')', function (c) {
        model.setTeamScore(c, teamId, aid, model.entryFromInput(text, model.getEntry(c.teamScores, teamId, aid), a.maxScore));
      });
    };
    var list = choiceValues(a);
    if (list.length) {
      // A drop-down item (DECISIONS 8): the team score is chosen from the list, never typed. A stored
      // value that is not on the list (imported) can be kept as it is, but no new one can be entered.
      var fld = listField(a, list, entry, 'Team score: choose from the list (' + choiceRange(a, list) + ')', 'keep');
      fld.field.help = help + '. Choose (empty) to clear it.';
      ui.dialog.form({
        title: a.name + ': ' + team.name + ' team score',
        fields: [fld.field],
        confirmText: 'Save team score',
        validate: function (v) { return fld.check(v.value); }
      }).then(function (v) {
        if (!v || v.value === LIST_KEEP) { refocusGrid(); return; }
        save(v.value);
      });
      return;
    }
    ui.dialog.prompt({
      title: a.name + ': ' + team.name + ' team score',
      label: 'Team score (max ' + num(a.maxScore, 4) + ')',
      value: entryText(entry),
      help: help + '. Leave empty to clear it.',
      confirmText: 'Save team score'
    }).then(function (v) {
      if (v === null) { refocusGrid(); return; }
      save(v);
    });
  }

  var LIST_KEEP = '__keep__';
  var LIST_CHOOSE = '__choose__';

  /** A select field of a drop-down item's values plus "(empty)", for the team-score and override
   * dialogs. entry: the value shown first. When it is not a list value (imported data, invalid text),
   * the first option either keeps it unchanged (ifOff 'keep': value LIST_KEEP) or asks for a choice
   * (ifOff 'choose': LIST_CHOOSE, refused by check). Returns { field, check(value) -> error | null }. */
  function listField(a, list, entry, label, ifOff) {
    var opts = [{ value: '', label: '(empty)' }].concat(list.map(function (v) { return { value: String(v), label: String(v) }; }));
    var shown = entryText(entry);
    var value = '';
    if (model.hasScore(entry) && typeof entry.value === 'number' && isChoiceValue(a, list, entry.value)) {
      value = String(util.fix(entry.value));
    } else if (shown !== '') {
      if (ifOff === 'keep') {
        opts.unshift({ value: LIST_KEEP, label: 'Keep ' + shown.slice(0, 30) + ' (not on the list)' });
        value = LIST_KEEP;
      } else {
        opts.unshift({ value: LIST_CHOOSE, label: 'Choose a value… (' + shown.slice(0, 30) + ' is not on the list)' });
        value = LIST_CHOOSE;
      }
    }
    return {
      field: { name: 'value', label: label, type: 'select', value: value, options: opts },
      check: function (v) {
        if (v === LIST_KEEP || v === '') return null;
        if (v === LIST_CHOOSE || matchChoice(a, list, v).value === undefined) return 'Choose a value from the list (' + choiceRange(a, list) + '), or (empty).';
        return null;
      }
    };
  }

  function overrideDialog(sid, aid) {
    var course = cur();
    var s = model.findStudent(course, sid), a = model.findAssessment(course, aid);
    if (!s || !a || !s.teamId) return;
    var team = model.findTeam(course, s.teamId);
    if (!team) return;
    var teamEntry = model.getEntry(course.teamScores, team.id, aid);
    var teamText = entryText(teamEntry);
    var who = studentLabel(s);
    // A drop-down item (DECISIONS 8): the override is chosen from the list as well.
    var list = choiceValues(a);
    var fld = list.length ? listField(a, list, teamEntry, a.name + ' score for ' + who + ': choose from the list (' + choiceRange(a, list) + ')', 'choose') : null;
    var valueField = fld ? fld.field : { name: 'value', label: a.name + ' score for ' + who + ' (max ' + num(a.maxScore, 4) + ')', value: teamText };
    valueField.help = fld ? 'Choose (empty) to give this student no score for this item.' : 'Leave empty to give this student no score for this item.';
    ui.dialog.form({
      title: 'Override ' + a.name + ' for ' + who,
      introHtml: '<div class="callout callout-warn" style="margin-bottom:12px">All members of a team get the same mark unless the team agrees ' +
        '<strong>in writing</strong> to an unequal split. The override is marked with ◆ and logged in History.</div>' +
        '<p class="muted small">' + esc(team.name) + ' team score: <strong>' + esc(teamText || 'empty') + '</strong>. Other members keep the team score.</p>',
      fields: [
        valueField,
        { name: 'reason', label: 'Reason (optional, saved with the change in History)', placeholder: 'e.g. team agreement email, Oct 12' }
      ],
      confirmText: 'Save override',
      validate: function (v) {
        if (fld) return fld.check(v.value);
        return util.parseScoreInput(v.value, a.maxScore).kind === 'invalid' ? 'Enter a number, or leave it empty.' : null;
      }
    }).then(function (v) {
      refocusGrid();
      if (!v) return;
      var before = (cur().history || []).length;
      transact('Override ' + a.name, function (c) {
        model.setOverride(c, sid, aid, model.entryFromInput(v.value, model.getEntry(c.teamScores, team.id, aid), a.maxScore));
      });
      if (txFailed) return;
      var reason = String(v.reason || '').trim();
      if (reason && GT.store.annotateHistory) {
        (cur().history || []).slice(before).forEach(function (h) {
          if (h.studentId === sid && (h.kind === 'override' || h.kind === 'score')) GT.store.annotateHistory(h.id, reason);
        });
      }
      ui.toast('Override saved for ' + who + ' (◆).', { type: 'success' });
    });
  }

  function removeOverride(sid, aid) {
    var course = cur();
    var s = model.findStudent(course, sid), a = model.findAssessment(course, aid);
    if (!s || !a) return;
    var team = s.teamId ? model.findTeam(course, s.teamId) : null;
    refocusGrid();
    var removed = transact('Remove override (' + a.name + ')', function (c) { return model.clearOverride(c, sid, aid); });
    if (removed) {
      var tv = team ? entryText(model.getEntry(cur().teamScores, team.id, aid)) : '';
      ui.toast('Override removed: ' + studentLabel(s) + ' now uses the team score' + (tv ? ' (' + tv + ')' : '') + '.', { type: 'success' });
    }
  }

  // ------------------------------------------------------------------ late work (K4, STAGE6 §1)

  /** Where the late-work info of a student's score lives (calc.resolveEntry): the team entry for a
   * team-graded item without an override (the team handed it in late, so it reaches every member
   * without an override), else the override or the individual entry. */
  function lateTarget(course, s, a) {
    var r = calc.resolveEntry(course, s, a);
    var team = r.source === 'team' ? model.findTeam(course, r.teamId) : null;
    return { source: team ? 'team' : r.source, entry: r.entry, team: team };
  }

  /** Writes weeks late / waived for one student's score into course `c` (inside a transaction).
   * Waived is kept only with weeks > 0; an individual entry left with nothing in it is removed. */
  function writeLate(c, sid, aid, weeks, waived) {
    var s = model.findStudent(c, sid), a = model.findAssessment(c, aid);
    if (!s || !a) return false;
    var t = lateTarget(c, s, a);
    var next = model.withLate(t.entry, weeks, weeks > 0 && waived === true);
    if (t.source === 'team') model.setTeamScore(c, t.team.id, aid, next);
    else model.setEntry(c.scores, sid, aid, t.source === 'individual' && model.isBlankEntry(next) ? null : next);
    return true;
  }

  /** calc.studentResult of `s` with the late info of item `a` replaced (the dialog's live preview);
   * the course itself is not changed. */
  function resultWithLate(course, s, a, weeks, waived) {
    var t = lateTarget(course, s, a);
    var next = model.withLate(t.entry, weeks, weeks > 0 && waived === true);
    var shim = Object.assign({}, course);
    var mapKey = t.source === 'team' ? 'teamScores' : 'scores';
    var owner = t.source === 'team' ? t.team.id : s.id;
    if (!util.isSafeKey(owner) || !util.isSafeKey(a.id)) return calc.studentResult(course, s); // never write such keys
    shim[mapKey] = Object.assign({}, course[mapKey]);
    shim[mapKey][owner] = Object.assign({}, course[mapKey][owner] || {});
    shim[mapKey][owner][a.id] = next;
    return calc.studentResult(shim, s);
  }

  /** "Raw 85 − 20 (2 weeks × 10 points) = 65 → weighted 16.25", or what applies instead. */
  function latePreviewHtml(course, s, a, weeks, waived) {
    var dec = decimalsOf(course);
    var before = calc.studentResult(course, s);
    var after = resultWithLate(course, s, a, weeks, waived);
    var d = after.items[a.id];
    var perWeek = typeof course.settings.latePointsPerWeek === 'number' ? course.settings.latePointsPerWeek : 10;
    var p = latePenaltyOf(course, a, weeks, false);
    var how = plural(weeks, 'week') + ' × ' + plural(util.fix(perWeek), 'point') + (a.maxScore !== 100 ? ' × ' + num(a.maxScore, 4) + ' ÷ 100' : '');
    var w = ' → weighted <strong>' + esc(num(d.weighted, Math.max(dec, 2))) + '</strong>';
    var line;
    if (d.state !== 'number') {
      var what = d.state === 'invalid' ? 'The score is not a number (counted as 0).' : 'No score yet (counted as 0).';
      if (!weeks) line = what + ' On time: no penalty.';
      else if (waived) line = what + ' Penalty waived: nothing will be deducted.';
      else if (!(p > 0)) line = what + ' Points per week is 0 (Settings), so nothing will be deducted.';
      else line = what + ' Once a score is entered, <strong>' + esc(num(p, 4)) + ' points</strong> come off it (' + esc(how) + ').';
    } else if (!weeks) {
      line = 'On time: raw ' + esc(num(d.raw, 4)) + ', no penalty' + w;
    } else if (waived) {
      line = 'Penalty waived (pre-approved): raw ' + esc(num(d.raw, 4)) + ', nothing deducted' + w +
        (p > 0 ? ' <span class="muted">(without the waiver: −' + esc(num(p, 4)) + ')</span>' : '');
    } else if (!(p > 0)) {
      line = 'Points per week is 0 (Settings), so nothing is deducted: raw ' + esc(num(d.raw, 4)) + w;
    } else {
      line = 'Raw ' + esc(num(d.raw, 4)) + ' − <strong>' + esc(num(p, 4)) + '</strong> (' + esc(how) + ') = <strong>' + esc(num(d.adjusted, 4)) + '</strong>' +
        (d.raw - p < 0 ? ' (never below 0)' : '') + w;
    }
    var same = util.fix(before.total) === util.fix(after.total);
    var total = 'Total for ' + esc(studentLabel(s)) + ': ' + (same
      ? '<strong>' + esc(num(after.total, dec)) + '</strong> (unchanged)'
      : esc(num(before.total, dec)) + ' → <strong>' + esc(num(after.total, dec)) + '</strong>' +
        (after.letter !== before.letter ? ' (suggested letter ' + esc(before.letter) + ' → ' + esc(after.letter) + ')' : ''));
    return '<div class="late-pv-line">' + line + '</div><div class="late-pv-total">' + total + '</div>';
  }

  /** The "Late work…" dialog of one raw score cell (cell menu, Ctrl+L, student details): weeks late
   * (util.parseCount, inline error), "Penalty waived (pre-approved)" and a live preview. Saves in ONE
   * transaction (model.withLate). Read-only while the scores are finalized (STAGE6 addendum 1). */
  function openLateDialog(sid, aid) {
    var course = cur();
    var s = course ? model.findStudent(course, sid) : null;
    var a = course ? model.findAssessment(course, aid) : null;
    if (!s || !a) return;
    var courseId = course.id;
    var locked = isFinalized(course);
    var t = lateTarget(course, s, a);
    var e = t.entry;
    var weeks0 = e && typeof e.weeksLate === 'number' && e.weeksLate > 0 ? e.weeksLate : 0;
    var waived0 = weeks0 > 0 && !!(e && e.waived);
    var who = studentLabel(s);
    var name = model.studentName(s);
    var ownTeam = s.teamId ? model.findTeam(course, s.teamId) : null;
    var where;
    if (t.source === 'team') {
      var members = model.teamMembers(course, t.team.id);
      var ovr = members.filter(function (m) {
        var own = model.getEntry(course.scores, m.id, aid);
        return own && own.override === true;
      }).length;
      where = '<strong>' + esc(t.team.name) + ' team score.</strong> ' + esc(a.name) + ' is team-graded, so late work set here applies to the ' +
        '<strong>whole team</strong> (' + esc(plural(members.length, 'member')) + '): the team handed it in late.' +
        (ovr ? ' ' + esc(plural(ovr, 'member')) + ' with a per-member override (◆) ' + (ovr === 1 ? 'keeps its' : 'keep their') + ' own late work.' : '');
    } else if (t.source === 'override') {
      where = '<strong>Per-member override (◆).</strong> Late work set here applies to ' + esc(who) + ' only; the ' +
        esc(ownTeam ? ownTeam.name : 'team') + ' team score keeps its own.';
    } else {
      where = '<strong>Individual score.</strong> Late work set here applies to ' + esc(who) + ' only' +
        (a.teamGraded ? ' (no team, so the score is individual).' : '.');
    }
    var perWeek = typeof course.settings.latePointsPerWeek === 'number' ? course.settings.latePointsPerWeek : 10;
    var d0 = calc.scoreDetail(course, s, a);
    var scoreTxt = d0.state === 'number' ? num(d0.raw, 4) : d0.state === 'invalid' ? '“' + d0.text + '” (not a number)' : 'empty';
    var bodyHtml =
      '<div class="late-dlg">' +
      '<p class="late-who">' + (name ? '<span class="pii">' + esc(name) + '</span>' : esc(who)) +
      (ownTeam ? ' · ' + esc(ownTeam.name) : ' · no team') + (s.status === 'withdrawn' ? ' · withdrawn' : '') + '</p>' +
      (locked ? '<div class="callout callout-warn late-locked" role="note">' + ui.icon('lock') + '<span>' + esc(LATE_LOCKED_MSG) + '</span></div>' : '') +
      '<div class="callout late-where">' + ui.icon(t.source === 'team' ? 'users' : t.source === 'override' ? 'diamond' : 'user') + '<span>' + where + '</span></div>' +
      '<p class="late-score muted">Score: <strong>' + esc(scoreTxt) + '</strong> out of ' + esc(num(a.maxScore, 4)) + ' · weight ' + esc(num(a.weight, 4)) + '%</p>' +
      '<div class="field late-field"><label for="late-weeks">Weeks late</label>' +
      '<input id="late-weeks" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="8" value="' + weeks0 + '"' +
      ' aria-describedby="late-weeks-help late-weeks-err"' + (locked ? ' disabled' : '') + '>' +
      '<div class="help" id="late-weeks-help">A whole number: 0 means on time. Each week costs ' + esc(plural(util.fix(perWeek), 'point')) +
      ' on a 100-point score' + (a.maxScore !== 100 ? ' (scaled to the max of ' + esc(num(a.maxScore, 4)) + ')' : '') + ', never below 0.</div>' +
      '<div class="late-err" id="late-weeks-err" role="alert"></div></div>' +
      '<div class="field late-field"><label class="check"><input type="checkbox" id="late-waived"' + (waived0 ? ' checked' : '') + (locked ? ' disabled' : '') + '> ' +
      'Penalty waived (pre-approved)</label><div class="help">Tick it when the instructor approved the late submission in advance: ' +
      'the weeks stay on record and no points are deducted.</div></div>' +
      '<div class="late-preview" id="late-preview" aria-live="polite"></div>' +
      '<p class="muted small late-foot">Points per week is a course setting (Settings → Late work). Changes are logged in History and can be undone (Ctrl+Z).</p>' +
      '</div>';

    var dlgEl = null;
    /** { weeks } | { error } for the typed weeks. */
    function readWeeks() {
      var raw = dlgEl ? dlgEl.querySelector('#late-weeks').value : String(weeks0);
      if (String(raw).trim() === '') return { weeks: 0 };
      var v = util.parseCount(raw);
      if (v === null) return { error: 'Enter a whole number of weeks, 0 or more (for example 1). Fractions, signs and text are not accepted.' };
      if (v > LATE_MAX) return { error: 'At most ' + LATE_MAX + ' weeks.' };
      return { weeks: v };
    }
    function refresh() {
      if (!dlgEl) return;
      var c = cur();
      var st = c && c.id === courseId ? model.findStudent(c, sid) : null;
      var as = c && c.id === courseId ? model.findAssessment(c, aid) : null;
      var r = readWeeks();
      var input = dlgEl.querySelector('#late-weeks');
      var err = dlgEl.querySelector('#late-weeks-err');
      var cb = dlgEl.querySelector('#late-waived');
      var pv = dlgEl.querySelector('#late-preview');
      input.classList.toggle('is-invalid', !!r.error);
      input.setAttribute('aria-invalid', r.error ? 'true' : 'false');
      err.textContent = r.error || '';
      if (!locked) cb.disabled = !r.error && r.weeks === 0;
      if (!st || !as) { pv.textContent = 'This student or assessment no longer exists.'; return; }
      if (r.error) { pv.classList.add('is-stale'); return; }
      pv.classList.remove('is-stale');
      try {
        pv.innerHTML = latePreviewHtml(c, st, as, r.weeks, cb.checked);
      } catch (ex) {
        if (root.console) console.error(ex);
        pv.textContent = '';
      }
    }
    var buttons = locked
      ? [{ text: 'Unlock scores…', value: 'unlock' }, { spacer: true }, { text: 'Close', value: null, primary: true }]
      : [{ text: 'Cancel', value: null }, {
        text: 'Save', primary: true,
        validate: function () {
          var r = readWeeks();
          if (r.error) {
            refresh();
            var inp = dlgEl.querySelector('#late-weeks');
            inp.focus();
            inp.select();
            return r.error;
          }
          return null;
        },
        value: function () { return { weeks: readWeeks().weeks, waived: dlgEl.querySelector('#late-waived').checked }; }
      }];
    ui.dialog.open({
      title: 'Late work: ' + a.name + ' · ' + who,
      bodyHtml: bodyHtml,
      buttons: buttons,
      initialFocus: locked ? '.dlg-foot .btn-primary' : '#late-weeks',
      onMount: function (dlg) {
        dlgEl = dlg;
        dlg.classList.add('late-dialog');
        var input = dlg.querySelector('#late-weeks');
        input.addEventListener('input', refresh);
        dlg.querySelector('#late-waived').addEventListener('change', refresh);
        refresh();
        if (!locked) setTimeout(function () { try { input.select(); } catch (ex) { /* gone */ } }, 0);
      }
    }).then(function (v) {
      if (isActiveView()) refocusGrid();
      if (v === 'unlock') { unlockScores(); return; }
      if (!v || typeof v !== 'object') return;
      var c = cur();
      if (!c || c.id !== courseId) { ui.toast('The course changed: the late work was not saved.', { type: 'warn' }); return; }
      if (isFinalized(c)) { notifyLate(); return; }
      var st = model.findStudent(c, sid), as = model.findAssessment(c, aid);
      if (!st || !as) { ui.toast('This student or assessment no longer exists: nothing was saved.', { type: 'warn' }); return; }
      var tNow = lateTarget(c, st, as);
      var en = tNow.entry;
      var wNow = en && typeof en.weeksLate === 'number' && en.weeksLate > 0 ? en.weeksLate : 0;
      var vNow = wNow > 0 && !!(en && en.waived);
      var waived = v.weeks > 0 && v.waived;
      if (wNow === v.weeks && vNow === waived) return; // nothing changed
      var label = 'Late work: ' + as.name + (tNow.source === 'team' ? ' (' + tNow.team.name + ')' : ' for ' + studentLabel(st));
      var ok = transact(label, function (cc) { return writeLate(cc, sid, aid, v.weeks, waived); });
      if (!ok) return;
      var p = latePenaltyOf(cur(), as, v.weeks, false);
      var what = !v.weeks ? 'on time (no late work)'
        : plural(v.weeks, 'week') + ' late' + (waived ? ', penalty waived' : (p > 0 ? ', −' + num(p, 4) + ' points' : ''));
      ui.toast(as.name + (tNow.source === 'team' ? ' for ' + tNow.team.name + ' (' + plural(model.teamMembers(cur(), tNow.team.id).length, 'member') + ')' : ' for ' + studentLabel(st)) +
        ': ' + what + '. Undo with Ctrl+Z.', { type: 'success' });
    });
  }

  function notifyLate() {
    if (nowMs() - lockedToastAt < 3000) return;
    lockedToastAt = nowMs();
    ui.toast(LATE_LOCKED_MSG, { type: 'info', timeout: 5000, action: { label: 'Unlock…', fn: unlockScores } });
  }

  // ------------------------------------------------------------------ clear, copy, paste

  function clearCells() {
    var rc = rectOf();
    if (!rc) return;
    endHold = null;
    var course = cur();
    var locked = isFinalized(course);
    // No is cleared only when the selection stays inside the No column (a wider Delete is about scores).
    var noOnly = rc.c1 === rc.c2 && layout.cols[rc.c1].kind === 'no';
    var targets = [], skipped = 0, skippedNo = 0, skippedLocked = 0;
    var teamClears = Object.create(null), teamClearList = [];
    for (var r = rc.r1; r <= rc.r2; r++) {
      for (var c = rc.c1; c <= rc.c2; c++) {
        var col = layout.cols[c], sid = layout.students[r].id;
        if (col.kind === 'final') {
          targets.push({ sid: sid, final: true }); // final letters stay editable after finalizing
        } else if (locked && col.edit) {
          skippedLocked++;
        } else if (col.kind === 'raw') {
          var t = { sid: sid, aid: col.aid };
          // A team-graded cell without an override clears the TEAM score (K5), for every member.
          var s = model.findStudent(course, sid), a = col.a;
          var team = a.teamGraded && s && s.teamId ? model.findTeam(course, s.teamId) : null;
          var own = team ? model.getEntry(course.scores, sid, a.id) : null;
          if (team && !(own && own.override === true)) {
            t.teamClear = true;
            var k = team.id + '\n' + a.id;
            if (!teamClears[k]) {
              teamClears[k] = { team: team, a: a, selected: Object.create(null), had: model.hasScore(model.getEntry(course.teamScores, team.id, a.id)) };
              teamClearList.push(teamClears[k]);
            }
            teamClears[k].selected[sid] = true;
          }
          targets.push(t);
        } else if (col.kind === 'no') {
          if (noOnly) targets.push({ sid: sid, no: true }); else skippedNo++;
        } else if (col.kind === 'last' || col.kind === 'first' || col.kind === 'team') skipped++;
      }
    }
    if (!targets.length) {
      if (skippedLocked) {
        notifyLocked();
      } else if (skipped || skippedNo) {
        ui.toast((skippedNo ? 'No, names and teams are not cleared with Delete (select only No cells to clear them).' :
          'Names and teams are not cleared with Delete.') + ' Press F2 (or double-click) to edit the cell.', { type: 'info' });
      } else {
        notifyReadOnly();
      }
      return;
    }
    var left = [];
    if (skippedNo) left.push('No');
    if (skipped) left.push('names', 'teams');
    if (skippedLocked) left.push('finalized scores');
    // Many final letters at once (Ctrl+A, then Delete) ask first: they are the grades being decided.
    var nLetters = 0;
    targets.forEach(function (t) { if (t.final && storedFinal(model.findStudent(course, t.sid)) !== null) nLetters++; });
    if (nLetters > LETTERS_CONFIRM) {
      var rest = targets.filter(function (t) { return !t.final; });
      ui.dialog.open({
        title: 'Clear ' + plural(nLetters, 'final letter') + '?',
        bodyHtml: '<p>The selection includes the <strong>Final letter</strong> column: Delete clears the final letter of <strong>' +
          esc(plural(nLetters, 'student')) + '</strong>' + (rest.length ? ', together with the other selected cells.' : '.') + '</p>' +
          '<p class="muted small">Undo with Ctrl+Z. Every change is logged in History.</p>',
        buttons: [{ text: 'Cancel', value: null }, { spacer: true }]
          .concat(rest.length ? [{ text: 'Keep the final letters', value: 'rest' }] : [])
          .concat([{ text: rest.length ? 'Clear all selected cells' : 'Clear ' + plural(nLetters, 'final letter'), value: 'all', primary: true, danger: true }])
      }).then(function (v) {
        refocusGrid();
        if (!v) return;
        if (v === 'rest') left.push('final letters');
        clearTeamCheck(course, v === 'rest' ? rest : targets, teamClearList, left);
      });
      return;
    }
    clearTeamCheck(course, targets, teamClearList, left);
  }

  /** A multi-cell Delete that would also empty the team score of members outside the selection asks first. */
  function clearTeamCheck(course, targets, teamClearList, left) {
    var outside = Object.create(null), outsideTeams = [], outsideAsmts = [];
    if (targets.length > 1) {
      teamClearList.forEach(function (tc) {
        if (!tc.had) return;
        var n = 0;
        model.teamMembers(course, tc.team.id).forEach(function (m) {
          if (tc.selected[m.id]) return;
          var ownM = model.getEntry(course.scores, m.id, tc.a.id);
          if (ownM && ownM.override === true) return; // keeps its own score
          outside[m.id] = true;
          n++;
        });
        if (!n) return;
        if (outsideTeams.indexOf(tc.team.name) === -1) outsideTeams.push(tc.team.name);
        if (outsideAsmts.indexOf(tc.a.name) === -1) outsideAsmts.push(tc.a.name);
      });
    }
    var nOutside = Object.keys(outside).length;
    if (!nOutside) { doClear(targets, left); return; }
    var others = targets.filter(function (t) { return !t.teamClear; });
    ui.dialog.open({
      title: 'Clear team scores?',
      bodyHtml: '<p>The selection includes team-graded cells. Deleting them clears the <strong>team score</strong> (' + esc(outsideAsmts.join(', ')) +
        ') of ' + esc(outsideTeams.join(', ')) + ', which also empties it for <strong>' + esc(plural(nOutside, 'team member')) +
        '</strong> outside the selection.</p><p class="muted small">Undo with Ctrl+Z. Every change is logged in History.</p>',
      buttons: [
        { text: 'Cancel', value: null },
        { spacer: true }
      ].concat(others.length ? [{ text: 'Clear the other cells only', value: 'others' }] : []).concat([
        { text: 'Clear team scores too', value: 'all', primary: true }
      ])
    }).then(function (v) {
      refocusGrid();
      if (!v) return;
      if (v === 'others') left.push('team scores');
      doClear(v === 'others' ? others : targets, left);
    });
  }

  function doClear(targets, left) {
    var teams = Object.create(null), removed = [];
    focusUntil = nowMs() + 1500;
    var finals = targets.filter(function (t) { return t.final; });
    var label = targets.length === 1 ? (finals.length ? 'Clear final letter' : 'Clear cell') : 'Clear ' + targets.length + ' cells';
    var nLetters = 0;
    transact(label, function (c) {
      if (finals.length) nLetters = writeFinalLetters(c, finals.map(function (t) { return { studentId: t.sid, letter: null }; }));
      targets.forEach(function (t) {
        if (t.final) return;
        if (t.no) {
          var st = model.findStudent(c, t.sid);
          if (st) st.no = null;
          return;
        }
        var had = model.getEntry(c.teamScores, (model.findStudent(c, t.sid) || {}).teamId, t.aid);
        var info = writeScore(c, t.sid, t.aid, '');
        if (info && info.kind === 'team' && model.hasScore(had)) teams[info.team.name] = info.members;
        if (info && info.kind === 'override-removed') removed.push({ sid: t.sid, aid: t.aid, tid: info.team.id, team: info.team.name });
      });
    });
    if (txFailed) return;
    var msgs = [];
    // Say what a wide Delete did to the final letters (the rest of the message lists what it left alone).
    if (nLetters && targets.length > 1) msgs.push(plural(nLetters, 'final letter') + ' cleared.');
    var tn = Object.keys(teams);
    if (tn.length) msgs.push('Team score cleared for ' + tn.map(function (n) { return n + ' (' + plural(teams[n], 'member') + ')'; }).join(', ') + '.');
    // Delete on a ◆ cell removes the override: the student then gets the team score, not an empty cell.
    if (removed.length === 1) {
      var rm = removed[0], after = cur();
      var tv = entryText(model.getEntry(after.teamScores, rm.tid, rm.aid));
      msgs.push('Override removed for ' + studentLabel(model.findStudent(after, rm.sid)) + ': now uses the ' + rm.team + ' score (' +
        (tv || 'empty') + ').');
    } else if (removed.length > 1) {
      msgs.push(removed.length + ' overrides (◆) removed: those students now use their team\'s score.');
    }
    if (left && left.length) {
      var list = left.length > 1 ? left.slice(0, -1).join(', ') + ' and ' + left[left.length - 1] : left[0];
      msgs.push(list.charAt(0).toUpperCase() + list.slice(1) + ' were left as they are.');
    }
    if (msgs.length) ui.toast(msgs.join(' ') + ' Undo with Ctrl+Z.', { type: 'info', timeout: 6000 });
  }

  function notifyReadOnly() {
    if (nowMs() - readOnlyToastAt < 5000) return;
    readOnlyToastAt = nowMs();
    var p = posOf(sel.active);
    var col = p ? layout.cols[p.c] : null;
    if (col && col.kind === 'letter') {
      ui.toast('Suggested comes from the letter cutoffs and cannot be edited. Choose the Final letter instead (next column).', { type: 'info', timeout: 4000 });
      return;
    }
    if (col && (col.kind === 'attExc' || col.kind === 'attUnx' || col.kind === 'attTot')) {
      ui.toast('Absences come from the Attendance tab.', { type: 'info', timeout: 3000 });
      return;
    }
    var label = col ? col.label : 'This column';
    ui.toast(label + ' is calculated and cannot be edited. Edit the raw scores instead.', { type: 'info', timeout: 3000 });
  }

  /** att: an attLookup(course) shared by the cells of one copy (optional). */
  function copyText(course, results, s, col, att) {
    var rs = results.byId[s.id];
    var dec = decimalsOf(course);
    var wd = s.status === 'withdrawn';
    switch (col.kind) {
      case 'no': return typeof s.no === 'number' ? String(s.no) : '';
      case 'last': return s.lastName || '';
      case 'first': return s.firstName || '';
      case 'team': { var t = s.teamId ? model.findTeam(course, s.teamId) : null; return t ? t.name : ''; }
      case 'raw': return detailText(rs.items[col.aid]);
      case 'weighted': return num(rs.items[col.aid] ? rs.items[col.aid].weighted : 0, dec);
      case 'total': return num(rs.total, dec);
      case 'letter': return wd ? 'W' : rs.letter || '';
      case 'final': return storedFinal(s) || '';
      case 'rank': return wd || rs.rank === null ? '' : String(rs.rank);
      case 'pct': return wd || rs.percentile === null ? '' : num(rs.percentile, 0);
      case 'diff': return wd || rs.diffFromAverage === null ? '' : num(rs.diffFromAverage, dec);
      case 'attExc':
      case 'attUnx':
      case 'attTot': {
        var sm = !attendanceAvailable(course) ? null : att ? att(s.id) : attSummary(course, s.id);
        if (!sm) return '';
        return String(whole(col.kind === 'attExc' ? sm.excused : col.kind === 'attUnx' ? sm.unexcused : sm.totalAbsences));
      }
    }
    return '';
  }

  function tsvField(v) {
    var s = String(v);
    return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function selectionTsv() {
    var rc = rectOf();
    if (!rc) return '';
    var course = cur(), results = res(), lines = [];
    var att = attLookup(course); // computed only if an absence column is copied
    for (var r = rc.r1; r <= rc.r2; r++) {
      var s = model.findStudent(course, layout.students[r].id);
      var cells = [];
      for (var c = rc.c1; c <= rc.c2; c++) cells.push(tsvField(s ? copyText(course, results, s, layout.cols[c], att) : ''));
      lines.push(cells.join('\t'));
    }
    return lines.join('\r\n');
  }

  function copiedToast() {
    var rc = rectOf();
    if (!rc) return;
    var n = (rc.r2 - rc.r1 + 1) * (rc.c2 - rc.c1 + 1);
    ui.toast(n === 1 ? 'Copied 1 cell.' : 'Copied ' + (rc.r2 - rc.r1 + 1) + ' × ' + (rc.c2 - rc.c1 + 1) + ' cells (paste into Excel or back here).',
      { type: 'success', timeout: 2500 });
  }

  function execCopy(text) {
    pendingCopy = text;
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    pendingCopy = null;
    return ok;
  }

  function copySelection() {
    var text = selectionTsv();
    if (!text && !rectOf()) return;
    var fail = function () { ui.toast('Could not copy to the clipboard. Use Ctrl+C on the selected cells.', { type: 'warn' }); };
    if (root.navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(copiedToast, function () { if (execCopy(text)) copiedToast(); else fail(); });
    } else if (execCopy(text)) {
      copiedToast();
    } else {
      fail();
    }
  }

  /** Parses clipboard text (Excel/Sheets TSV). Uses GT.csv when present; otherwise a local parser
   * with the same rules: tabs split cells, newlines split rows (quotes may wrap either), one trailing
   * newline is dropped, and text without tabs is one cell per line. */
  function parseClipboard(text) {
    if (GT.csv && typeof GT.csv.parseClipboard === 'function') {
      try { return GT.csv.parseClipboard(text); } catch (e) { /* fall back */ }
    }
    var s = String(text === null || text === undefined ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (s === '') return [];
    if (s.charAt(s.length - 1) === '\n') s = s.slice(0, -1);
    if (s.indexOf('\t') === -1) return s.split('\n').map(function (l) { return [l]; });
    var rows = [], row = [], field = '', inQ = false, fieldStart = true;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (s.charAt(i + 1) === '"') { field += '"'; i++; } else inQ = false;
        } else field += ch;
        continue;
      }
      if (ch === '"' && fieldStart) { inQ = true; fieldStart = false; continue; }
      fieldStart = false;
      if (ch === '\t') { row.push(field); field = ''; fieldStart = true; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; fieldStart = true; }
      else field += ch;
    }
    row.push(field);
    rows.push(row);
    return rows;
  }

  /** Applies a pasted block (or fills the selected range with a single value) in ONE transaction. */
  function applyBlock(block, opts) {
    var o = opts || {};
    if (!layout || !layout.students.length || !block || !block.length) return;
    var a = posOf(sel.active), rc = rectOf();
    if (!a || !rc) return;
    endHold = null;
    var single = block.length === 1 && block[0].length === 1;
    var isRange = rc.r1 !== rc.r2 || rc.c1 !== rc.c2;
    var fill = single && isRange;
    var r0 = isRange ? rc.r1 : a.r, c0 = isRange ? rc.c1 : a.c;
    var width = 0;
    block.forEach(function (row) { width = Math.max(width, row.length); });
    var nRows = fill ? rc.r2 - rc.r1 + 1 : block.length;
    var nCols = fill ? rc.c2 - rc.c1 + 1 : width;
    var nR = layout.students.length, nC = layout.cols.length;
    var ops = [], skipped = [], skippedSeen = Object.create(null);
    var course = cur(), locked = isFinalized(course);
    var bad = { letters: 0, list: 0, listRanges: [], locked: 0 };
    for (var i = 0; i < nRows && r0 + i < nR; i++) {
      var sid = layout.students[r0 + i].id;
      for (var j = 0; j < nCols && c0 + j < nC; j++) {
        var text = fill ? block[0][0] : block[i][j];
        if (text === undefined || text === null) continue;
        var col = layout.cols[c0 + j];
        if (!col.edit) {
          if (!skippedSeen[col.key]) { skippedSeen[col.key] = true; skipped.push(col.label); }
          continue;
        }
        if (locked && col.kind !== 'final') { bad.locked++; continue; }
        var op = { sid: sid, kind: col.kind, aid: col.aid || null, text: String(text) };
        // Drop-down cells take only values of their list: anything else is skipped and reported.
        if (col.kind === 'final') {
          var ml = matchLetter(course, op.text);
          if (ml.bad) { bad.letters++; continue; }
          op.letter = ml.empty ? null : ml.letter;
        } else if (col.dd) {
          var mc = matchChoice(col.a, col.choices, op.text);
          if (mc.bad) {
            bad.list++;
            var rg = col.a.name + ': ' + choiceRange(col.a, col.choices);
            if (bad.listRanges.indexOf(rg) === -1) bad.listRanges.push(rg);
            continue;
          }
          op.text = mc.empty ? '' : String(mc.value);
        }
        ops.push(op);
      }
    }
    if (!ops.length && bad.locked && !bad.letters && !bad.list) { notifyLocked(); return; }
    var job = {
      ops: ops, skipped: skipped, fill: fill, source: o.source || 'paste', bad: bad,
      droppedRows: Math.max(0, r0 + nRows - nR), droppedCols: Math.max(0, c0 + nCols - nC),
      // The pasted area, as cell refs taken now (a dialog may come first).
      selA: refAt(r0, c0), selE: refAt(Math.min(r0 + nRows - 1, nR - 1), Math.min(c0 + nCols - 1, nC - 1))
    };
    var moves = teamMoveCheck(ops);
    if (!moves.students) { runBlock(job, null); return; }
    // Like the Team cell editor: team moves that would change team-graded scores ask first, because
    // keeping them creates per-member overrides, which need the team's written agreement (K5).
    ui.dialog.open({
      title: (fill ? 'Fill' : 'Paste') + ' changes teams',
      bodyHtml: '<p>' + esc(plural(moves.students, 'student')) + ' changing team ' + (moves.students === 1 ? 'has' : 'have') +
        ' team-graded scores that differ from the new team\'s: <strong>' + esc(moves.asmts.join(', ')) + '</strong>.</p>' +
        '<p>Keep their current scores (as per-member overrides ◆), or use the new team\'s scores?</p>' +
        '<p class="muted small">An unequal split within a team needs the team\'s written agreement. A student left without a team keeps ' +
        'the current scores as individual scores, or has none with "Use the new team\'s scores". Every change is logged in History.</p>',
      buttons: [
        { text: 'Cancel', value: null },
        { spacer: true },
        { text: 'Use the new team\'s scores', value: 'team' },
        { text: 'Keep current scores (as overrides)', value: 'keep', primary: true }
      ]
    }).then(function (v) {
      refocusGrid();
      if (!v) { ui.toast((fill ? 'Fill' : 'Paste') + ' cancelled. Nothing was changed.', { type: 'info' }); return; }
      runBlock(job, v === 'keep');
    });
  }

  /** Team cells in a paste that move a student whose team-graded scores differ from the new team's
   * (none for a new team or no team). Returns { students, asmts: [names] }. */
  function teamMoveCheck(ops) {
    var course = cur();
    var out = { students: 0, asmts: [] };
    var tg = course.assessments.filter(function (x) { return x.teamGraded; });
    if (!tg.length) return out;
    var byName = Object.create(null);
    course.teams.forEach(function (t) { byName[t.name.trim().toLowerCase()] = t.id; });
    ops.forEach(function (op) {
      if (op.kind !== 'team') return;
      var s = model.findStudent(course, op.sid);
      if (!s) return;
      var name = op.text.trim();
      var target = name ? (byName[name.toLowerCase()] || NEW_TEAM) : null;
      var current = s.teamId && model.findTeam(course, s.teamId) ? s.teamId : null;
      if (target === current) return;
      var hit = false;
      tg.forEach(function (x) {
        var eff = model.effectiveEntry(course, s, x);
        if (!model.hasScore(eff)) return;
        var next = target && target !== NEW_TEAM ? model.getEntry(course.teamScores, target, x.id) : null;
        if (model.entryKey(eff) === model.entryKey(next)) return;
        hit = true;
        if (out.asmts.indexOf(x.name) === -1) out.asmts.push(x.name);
      });
      if (hit) out.students++;
    });
    return out;
  }

  /** keep: null (no team move changes scores), true (keep them as overrides) or false (use the new
   * team's scores). */
  function runBlock(job, keep) {
    var ops = job.ops, fill = job.fill;
    var sum = { cells: 0, overrides: 0, moved: 0, unteamed: 0, kept: 0, badNo: 0, newTeams: 0, propagated: 0 };
    // Junk in pasted scores (E2E-5) is stored as typed (red: not a number, counted as 0; yellow: outside
    // 0 to max), like a typed value: the message says how many, so a green "Pasted 60 cells." never
    // hides them. Drop-down columns only ever take list values (checked in applyBlock).
    var junk = { nan: 0, range: 0, maxes: [] };
    var course0 = cur();
    ops.forEach(function (op) {
      if (op.kind !== 'raw') return;
      var asmt = model.findAssessment(course0, op.aid);
      if (!asmt) return;
      var ps = util.parseScoreInput(op.text, asmt.maxScore);
      if (ps.kind === 'invalid') junk.nan++;
      else if (ps.kind === 'number' && (ps.value < 0 || ps.value > asmt.maxScore)) {
        junk.range++;
        if (junk.maxes.indexOf(asmt.maxScore) === -1) junk.maxes.push(asmt.maxScore);
      }
    });
    if (ops.length) {
      var label = (fill ? 'Fill ' : 'Paste ') + plural(ops.length, 'cell');
      focusUntil = nowMs() + 1500;
      transact(job.label || label, function (c) {
        var finals = ops.filter(function (op) { return op.kind === 'final'; });
        if (finals.length) {
          writeFinalLetters(c, finals.map(function (op) { return { studentId: op.sid, letter: op.letter }; }));
          sum.cells += finals.length;
        }
        var teamByName = Object.create(null);
        c.teams.forEach(function (t) { teamByName[t.name.trim().toLowerCase()] = t.id; });
        // Identity columns first, so team moves apply before team-graded scores.
        ops.forEach(function (op) {
          var st = model.findStudent(c, op.sid);
          if (!st) return;
          if (op.kind === 'no') {
            var t = op.text.trim();
            if (t === '') st.no = null;
            else if (/^\d+$/.test(t) && parseInt(t, 10) >= 1) st.no = parseInt(t, 10);
            else { sum.badNo++; return; }
            sum.cells++;
          } else if (op.kind === 'last') { st.lastName = op.text.trim(); sum.cells++; }
          else if (op.kind === 'first') { st.firstName = op.text.trim(); sum.cells++; }
          else if (op.kind === 'team') {
            var name = op.text.trim(), tid = null;
            if (name) {
              tid = teamByName[name.toLowerCase()];
              if (!tid) {
                var team = model.createTeam(name);
                c.teams.push(team);
                tid = team.id;
                teamByName[name.toLowerCase()] = tid;
                sum.newTeams++;
              }
            }
            var before = st.teamId || null;
            model.moveStudentToTeam(c, st.id, tid, { keepScores: keep === true });
            if ((st.teamId || null) !== before) {
              sum.moved++;
              if (!st.teamId) sum.unteamed++;
              else if (keep === true) {
                c.assessments.forEach(function (x) {
                  var e = x.teamGraded ? model.getEntry(c.scores, st.id, x.id) : null;
                  if (e && e.override === true) sum.kept++;
                });
              }
            }
            sum.cells++;
          }
        });
        var byAid = Object.create(null), order = [];
        ops.forEach(function (op) {
          if (op.kind !== 'raw') return;
          if (!byAid[op.aid]) { byAid[op.aid] = []; order.push(op.aid); }
          byAid[op.aid].push(op);
        });
        order.forEach(function (aid) {
          var asmt = model.findAssessment(c, aid);
          if (!asmt) return;
          if (asmt.teamGraded) {
            var rows = byAid[aid].map(function (op) {
              var st = model.findStudent(c, op.sid);
              return { studentId: op.sid, entry: model.entryFromInput(op.text, st ? model.effectiveEntry(c, st, asmt) : null, asmt.maxScore) };
            });
            var out = model.setTeamScoreFromMembers(c, aid, rows);
            sum.overrides += out.overridesCreated;
            sum.propagated += (out.propagatedTo || []).length;
            sum.cells += rows.length;
          } else {
            byAid[aid].forEach(function (op) {
              var e = model.entryFromInput(op.text, model.getEntry(c.scores, op.sid, aid), asmt.maxScore);
              delete e.override;
              model.setEntry(c.scores, op.sid, aid, model.isBlankEntry(e) ? null : e);
              sum.cells++;
            });
          }
        });
      }, { source: job.source });
      if (txFailed) return; // not written (read-only tab, or an error): transact() said so
      // Select the pasted area, like Excel. (If the re-render re-sorts the rows, renderTable
      // collapses it to the active cell.)
      if (job.selA && posOf(job.selA) && posOf(job.selE)) {
        sel.active = job.selA;
        sel.end = job.selE;
        paintSelection();
        focusActive();
      }
    }
    var msg = [], jb = job.bad || { letters: 0, list: 0, listRanges: [], locked: 0 };
    if (ops.length) msg.push(job.doneMsg || ((fill ? 'Filled ' : 'Pasted ') + plural(sum.cells, 'cell') + '.'));
    else msg.push('Nothing was pasted.');
    if (ops.length && junk.nan) {
      msg.push(plural(junk.nan, 'value') + (junk.nan === 1 ? ' is not a number' : ' are not numbers') + ' (shown in red, counted as 0).');
    }
    if (ops.length && junk.range) {
      msg.push(plural(junk.range, 'value') + (junk.range === 1 ? ' is' : ' are') + ' outside ' +
        (junk.maxes.length === 1 ? '0–' + num(junk.maxes[0], 4) : '0 to the column\'s max') + ' (shown in yellow).');
    }
    if (jb.letters) {
      msg.push(plural(jb.letters, 'value') + ' in Final letter ' + (jb.letters === 1 ? 'was not a letter' : 'were not letters') +
        ' of this course (' + scaleLetters(cur()).join(', ') + ') and ' + (jb.letters === 1 ? 'was' : 'were') + ' skipped.');
    }
    if (jb.list) {
      msg.push(plural(jb.list, 'value') + (jb.list === 1 ? ' was' : ' were') + ' not on the drop-down list (' + jb.listRanges.join('; ') +
        ') and ' + (jb.list === 1 ? 'was' : 'were') + ' skipped.');
    }
    if (jb.locked) msg.push(plural(jb.locked, 'score cell') + ' not changed: scores are finalized (unlock them to edit).');
    if (sum.overrides) {
      msg.push(sum.overrides + ' team-graded value' + (sum.overrides === 1 ? '' : 's') + ' differed from ' +
        (sum.overrides === 1 ? 'its' : 'their') + ' team\'s score and ' + (sum.overrides === 1 ? 'was' : 'were') +
        ' saved as per-member override' + (sum.overrides === 1 ? '' : 's') + ' (◆).');
    }
    if (sum.propagated) msg.push('Team scores also apply to ' + plural(sum.propagated, 'other team member') + '.');
    if (job.skipped.length) msg.push('Calculated columns were skipped (' + job.skipped.join(', ') + ').');
    if (job.droppedRows) msg.push(plural(job.droppedRows, 'row') + ' past the end of the list ' + (job.droppedRows === 1 ? 'was' : 'were') + ' not pasted.');
    if (job.droppedCols) msg.push(plural(job.droppedCols, 'column') + ' past the last column ' + (job.droppedCols === 1 ? 'was' : 'were') + ' not pasted.');
    if (sum.badNo) msg.push(plural(sum.badNo, 'value') + ' in No ' + (sum.badNo === 1 ? 'was not a whole number and was' : 'were not whole numbers and were') + ' skipped.');
    if (sum.moved) {
      msg.push(plural(sum.moved, 'student') + ' changed team' + (sum.newTeams ? ' (' + plural(sum.newTeams, 'new team') + ' created)' : '') +
        (sum.unteamed ? '; ' + sum.unteamed + ' of them now ' + (sum.unteamed === 1 ? 'has' : 'have') + ' no team' : '') + '.');
    }
    if (sum.kept) {
      msg.push(sum.kept + ' team-graded score' + (sum.kept === 1 ? ' was' : 's were') + ' kept as per-member override' +
        (sum.kept === 1 ? '' : 's') + ' (◆) for students who changed team.');
    } else if (keep === false && sum.moved) {
      msg.push('Students who changed team now use their new team\'s scores.');
    }
    var warn = job.droppedRows || job.droppedCols || sum.badNo || !ops.length || jb.letters || jb.list || jb.locked ||
      (ops.length && (junk.nan || junk.range));
    (job.doneMsg ? gridToast : ui.toast)(msg.join(' '), { type: warn ? 'warn' : 'success', timeout: warn || sum.overrides || sum.kept ? 9000 : 4000 });
  }

  // ------------------------------------------------------------------ cell menu

  function openCellMenu(point) {
    var p = posOf(sel.active);
    if (!p) return;
    var course = cur(), results = res();
    var s = model.findStudent(course, layout.students[p.r].id);
    if (!s) return;
    var col = layout.cols[p.c];
    var td = cellAt(p.r, p.c);
    var a = col.aid ? model.findAssessment(course, col.aid) : null;
    var rs = results.byId[s.id];
    var detail = a && rs ? rs.items[a.id] : null;
    var multi = hasRange();
    var locked = lockedCol(course, col);
    var band = col.dd && !locked ? bandRows() : null;
    var items = [{ heading: studentLabel(s) + ' · ' + col.label }];
    if (locked) {
      items.push({ label: 'Scores are finalized: unlock to edit…', icon: 'lock', onSelect: unlockScores });
    } else if (col.kind === 'final') {
      if (band) {
        items.push({ label: 'Set final letter for ' + plural(band.sids.length, 'selected student') + ' ▸', icon: 'edit', hint: 'Enter', onSelect: function () { startEdit('list'); } });
      } else {
        items.push({ label: 'Choose final letter ▸', icon: 'edit', hint: 'Enter', onSelect: function () { startEdit('list'); } });
        var fl = storedFinal(s);
        if (rs && rs.letter && fl !== rs.letter && scaleLetters(course).indexOf(rs.letter) !== -1) {
          items.push({
            label: 'Use the suggested letter (' + rs.letter + ')', icon: 'check',
            onSelect: function () {
              refocusGrid();
              transact('Edit final letter', function (c) { writeFinalLetters(c, [{ studentId: s.id, letter: rs.letter }]); });
            }
          });
        }
      }
      items.push({ label: multi ? 'Clear selected cells' : 'Clear final letter', icon: 'x', hint: 'Del', onSelect: clearCells });
    } else if (col.kind === 'raw' && a) {
      var team = a.teamGraded && s.teamId ? model.findTeam(course, s.teamId) : null;
      if (col.dd) {
        items.push({
          label: band ? 'Set ' + a.name + ' for ' + plural(band.sids.length, 'selected student') + ' ▸' : 'Choose from the list ▸',
          icon: 'edit', hint: 'Enter', onSelect: function () { startEdit('list'); }
        });
      }
      if (team) {
        var tv = entryText(model.getEntry(course.teamScores, team.id, a.id)) || 'empty';
        if (detail && detail.override) {
          items.push({ label: 'Remove override (use team score ' + tv + ')', icon: 'diamond', onSelect: function () { removeOverride(s.id, a.id); } });
          if (!col.dd) items.push({ label: 'Edit override value', icon: 'edit', hint: 'F2', onSelect: function () { startEdit('edit'); } });
        } else {
          items.push({ label: 'Override for this student only…', icon: 'diamond', onSelect: function () { overrideDialog(s.id, a.id); } });
        }
        items.push({ label: 'Edit team score…', icon: 'users', onSelect: function () { editTeamScore(team.id, a.id); } });
      } else if (!col.dd) {
        items.push({ label: 'Edit score', icon: 'edit', hint: 'F2', onSelect: function () { startEdit('edit'); } });
      }
      items.push({ label: multi ? 'Clear selected cells' : 'Clear score', icon: 'x', hint: 'Del', onSelect: clearCells });
    } else if (col.edit) {
      items.push({ label: col.kind === 'team' ? 'Change team…' : 'Edit ' + col.label.toLowerCase(), icon: 'edit', hint: col.kind === 'team' ? '' : 'F2', onSelect: function () { startEdit('edit'); } });
    }
    if (col.kind === 'raw' && a) {
      // Late work (K4): weeks late and "penalty waived" of this cell (read-only while finalized).
      items.push({
        label: detail && detail.weeksLate > 0 ? 'Late work (' + plural(detail.weeksLate, 'week') + (detail.waived ? ', waived' : '') + ')…' : 'Late work…',
        icon: 'clock', hint: 'Ctrl+L', onSelect: function () { openLateDialog(s.id, a.id); }
      });
    }
    items.push({ label: multi ? 'Copy selection' : 'Copy', icon: 'copy', hint: 'Ctrl+C', onSelect: copySelection });
    if (col.kind === 'raw' && a && !locked) {
      // The whole column (the header's ⋯ button offers the same, for the mouse).
      items.push({ separator: true });
      items = items.concat(columnItems(a.id));
    }
    items.push({ separator: true });
    items.push({
      label: 'Open student details', icon: 'user', disabled: typeof GT.ui.openStudent !== 'function',
      onSelect: function () { if (typeof GT.ui.openStudent === 'function') GT.ui.openStudent(s.id); }
    });
    if (GT.views.history && GT.app && typeof GT.app.navigate === 'function') {
      items.push({ label: 'Show changes in History', icon: 'history', onSelect: function () { GT.app.navigate('history', { studentId: s.id }); } });
    }
    var rc = rectOf();
    var extCtx = {
      course: course, student: s, assessment: a, detail: detail, result: rs,
      column: { key: col.key, kind: col.kind, label: col.label, assessmentId: col.aid || null },
      selection: {
        rows: layout.students.slice(rc.r1, rc.r2 + 1).map(function (x) { return x.id; }),
        cols: layout.cols.slice(rc.c1, rc.c2 + 1).map(function (x) { return x.key; })
      },
      // Scores are finalized: extensions that change scores (late work) should offer "unlock" instead.
      finalized: isFinalized(course),
      store: GT.store, refocus: refocusGrid
    };
    var ext = [];
    GT.gridCellMenuExtensions.forEach(function (fn) {
      if (typeof fn !== 'function') return;
      try {
        var more = fn(extCtx);
        if (Array.isArray(more)) ext = ext.concat(more.filter(Boolean));
      } catch (e) { if (root.console) console.error('grid cell menu extension failed', e); }
    });
    if (ext.length) { items.push({ separator: true }); items = items.concat(ext); }
    var pt = point;
    if (!pt && td) {
      var r = td.getBoundingClientRect();
      pt = { x: r.left + 6, y: r.bottom + 2 };
    }
    ui.menu(pt || { x: 20, y: 20 }, items, { returnFocus: td });
  }

  // ------------------------------------------------------------------ column actions (fill, set, clear)

  function columnItems(aid) {
    var a = model.findAssessment(cur(), aid);
    if (!a) return [];
    return [
      { heading: 'Whole column: ' + a.name },
      { label: 'Fill empty cells of active students with…', icon: 'edit', onSelect: function () { fillColumn(aid, 'empty'); } },
      { label: 'Set every active student to…', icon: 'users', onSelect: function () { fillColumn(aid, 'all'); } },
      { label: 'Clear column…', icon: 'x', danger: true, onSelect: function () { fillColumn(aid, 'clear'); } }
    ];
  }

  /** The ⋯ menu of a raw-score header (or right-click / Shift+F10 on it). */
  function openColumnMenu(anchor, aid) {
    var course = cur();
    var a = model.findAssessment(course, aid);
    if (!a) return;
    var items;
    if (isFinalized(course)) {
      items = [{ heading: a.name }, { label: 'Scores are finalized: unlock to edit…', icon: 'lock', onSelect: unlockScores }];
    } else {
      items = columnItems(aid);
      items[0] = { heading: a.name };
    }
    ui.menu(anchor, items, { returnFocus: anchor && anchor.focus ? anchor : null });
  }

  /** Column fill (ONE transaction each). mode: 'empty' (fill the empty cells of active students),
   * 'all' (set every active student) or 'clear'. Team-graded columns write team scores; members with
   * an override keep it for 'empty' (its value is filled when empty) and lose it for 'all'. */
  function fillColumn(aid, mode) {
    var course = cur();
    var a = model.findAssessment(course, aid);
    if (!a) return;
    if (isFinalized(course)) { notifyLocked(); return; }
    var results = res();
    var active = course.students.filter(function (s) { return s.status !== 'withdrawn'; });
    var filled = 0;
    active.forEach(function (s) {
      var d = results.byId[s.id] && results.byId[s.id].items[aid];
      if (d && d.state !== 'empty') filled++;
    });
    var empties = active.length - filled;
    var list = choiceValues(a);
    var run = function (text) {
      var info = { n: 0, teams: 0, overrides: 0 };
      focusUntil = nowMs() + 1500;
      var label = mode === 'empty' ? 'Fill empty ' + a.name + ' cells' : mode === 'all' ? 'Set ' + a.name + ' for every active student' : 'Clear ' + a.name;
      transact(label, function (c) {
        var asmt = model.findAssessment(c, aid);
        if (!asmt) return;
        var teams = Object.create(null);
        c.students.forEach(function (s) {
          if (s.status === 'withdrawn') return;
          var team = asmt.teamGraded && s.teamId ? model.findTeam(c, s.teamId) : null;
          var eff = model.effectiveEntry(c, s, asmt);
          if (mode === 'empty' && model.hasScore(eff)) return;
          if (mode === 'clear' && !model.hasScore(eff)) return;
          var own = team ? model.getEntry(c.scores, s.id, aid) : null;
          if (team && own && own.override === true) {
            if (mode === 'empty') { writeScore(c, s.id, aid, text); info.n++; return; }
            model.clearOverride(c, s.id, aid);
            info.overrides++;
          }
          if (team) { teams[team.id] = true; info.n++; return; }
          writeScore(c, s.id, aid, mode === 'clear' ? '' : text);
          info.n++;
        });
        Object.keys(teams).forEach(function (tid) {
          var prev = model.getEntry(c.teamScores, tid, aid);
          model.setTeamScore(c, tid, aid, model.entryFromInput(mode === 'clear' ? '' : text, prev, asmt.maxScore));
          info.teams++;
        });
      });
      if (txFailed) return;
      var msg = mode === 'clear' ? a.name + ' cleared for ' + plural(info.n, 'active student') + '.' :
        (mode === 'empty' ? 'Filled ' + plural(info.n, 'empty cell') : a.name + ' set to ' + text + ' for ' + plural(info.n, 'active student')) +
        (mode === 'empty' ? ' of ' + a.name + ' with ' + text : '') + '.';
      if (info.teams) msg += ' ' + plural(info.teams, 'team score') + ' written (they apply to every member).';
      if (info.overrides) msg += ' ' + plural(info.overrides, 'per-member override') + ' (◆) removed.';
      ui.toast(msg + ' Undo with Ctrl+Z.', { type: 'success', timeout: 6000 });
    };
    if (mode === 'clear') {
      if (!filled) { ui.toast(a.name + ' is already empty for every active student.', { type: 'info' }); return; }
      ui.dialog.confirm({
        title: 'Clear ' + a.name + '?',
        messageHtml: '<p>This clears <strong>' + esc(a.name) + '</strong> for ' + esc(plural(filled, 'active student')) + ' who have a score.' +
          (a.teamGraded ? ' Team scores are cleared too (for every member of those teams).' : '') + '</p>' +
          '<p class="muted small">Withdrawn students keep their scores. Late-work details stay. Undo with Ctrl+Z; every change is logged in History.</p>',
        confirmText: 'Clear ' + plural(filled, 'score'), danger: true
      }).then(function (ok) { refocusGrid(); if (ok) run(''); });
      return;
    }
    if (mode === 'empty' && !empties) { ui.toast('Every active student already has a ' + a.name + ' score.', { type: 'info' }); return; }
    var intro = mode === 'empty'
      ? '<p>Fills the <strong>' + esc(plural(empties, 'empty cell')) + '</strong> of ' + esc(a.name) + ' (active students only). Scores already entered stay as they are.</p>'
      : '<div class="callout callout-warn" style="margin-bottom:12px">This gives <strong>every active student</strong> (' + esc(String(active.length)) + ') the same ' +
        esc(a.name) + ' score' + (filled ? ', replacing ' + esc(plural(filled, 'score')) + ' already entered' : '') + '.' +
        (a.teamGraded ? ' Team scores are written, and per-member overrides (◆) are removed.' : '') + '</div>';
    var field = list.length
      ? { name: 'value', label: a.name + ' (choose from the list)', type: 'select', value: String(list[0]),
        options: list.map(function (v) { return { value: String(v), label: String(v) }; }) }
      : { name: 'value', label: a.name + ' (0 to ' + num(a.maxScore, 4) + ')', value: '', required: true };
    ui.dialog.form({
      title: mode === 'empty' ? 'Fill empty ' + a.name + ' cells' : 'Set ' + a.name + ' for every active student',
      introHtml: intro + '<p class="muted small">Undo with Ctrl+Z. Every change is logged in History.</p>',
      fields: [field],
      confirmText: mode === 'empty' ? 'Fill ' + plural(empties, 'cell') : 'Set ' + plural(active.length, 'student'),
      danger: mode === 'all' && filled > 0,
      validate: function (v) {
        if (list.length) return matchChoice(a, list, v.value).value !== undefined ? null : 'Choose a value from the list.';
        var ps = util.parseScoreInput(v.value, a.maxScore);
        if (ps.kind !== 'number') return 'Enter a number.';
        if (ps.value < 0 || ps.value > a.maxScore) return 'Enter a number from 0 to ' + num(a.maxScore, 4) + '.';
        return null;
      }
    }).then(function (v) {
      refocusGrid();
      if (!v) return;
      var ps = util.parseScoreInput(v.value, a.maxScore);
      if (ps.kind !== 'number') return;
      run(String(ps.value));
    });
  }

  // ------------------------------------------------------------------ final grades: finalize, unlock, copy suggested

  /** Data check before finalizing (active students). Empty participation cells are counted apart
   * (meeting: [{ name, n }]): participation is set in the grading meeting (DECISIONS 5), and
   * finalizing locks it. */
  function countIssues(course, results) {
    var out = { missing: [], invalid: [], nMissing: 0, nInvalid: 0, meeting: [], nMeeting: 0 };
    var active = course.students.filter(function (s) { return s.status !== 'withdrawn'; });
    course.assessments.forEach(function (a) {
      var list = choiceValues(a);
      var miss = 0, inv = 0;
      active.forEach(function (s) {
        var d = results.byId[s.id] && results.byId[s.id].items[a.id];
        if (!d) return;
        if (d.state === 'empty' && (a.weight || 0) > 0) miss++;
        else if (d.state === 'invalid' || d.outOfRange ||
          (list.length && d.state === 'number' && (d.notOnList !== undefined ? d.notOnList : !isChoiceValue(a, list, d.raw)))) inv++;
      });
      if (miss && a.category === 'participation') {
        out.meeting.push({ name: a.name, n: miss });
        out.nMeeting = Math.max(out.nMeeting, miss);
        miss = 0;
      }
      if (miss) out.missing.push(a.name + ': ' + miss + ' empty');
      if (inv) out.invalid.push(a.name + ': ' + inv);
      out.nMissing += miss;
      out.nInvalid += inv;
    });
    return out;
  }

  /** Active students with an empty participation cell (the "fill in the meeting" column). */
  /** The name of the course's participation item ("Class/Project Participation" in both templates). */
  function participationName(course) {
    var a = course ? course.assessments.filter(function (x) { return x.category === 'participation'; })[0] : null;
    return a && a.name ? a.name : 'Class/Project Participation';
  }

  function emptyMeetingCells(course, results) {
    var n = 0;
    var part = course.assessments.filter(function (a) { return a.category === 'participation' && (a.weight || 0) > 0; });
    if (!part.length) return 0;
    course.students.forEach(function (s) {
      if (s.status === 'withdrawn' || !results.byId[s.id]) return;
      if (part.some(function (a) { var d = results.byId[s.id].items[a.id]; return d && d.state === 'empty'; })) n++;
    });
    return n;
  }

  function finalizeDialog() {
    var course = cur(), results = res();
    if (!course || !results || isFinalized(course)) return;
    if (!results.activeIds.length) {
      // Nothing to finalize: the lock would only block adding the first students.
      ui.toast(course.students.length ? 'Every student is withdrawn: there are no scores to finalize.' :
        'Add students first: there are no scores to finalize yet.', { type: 'info', timeout: 5000 });
      return;
    }
    var iss = countIssues(course, results);
    var ph = model.unconfirmedPlaceholders(course);
    var w = results.weights;
    var ls = letterSummary(course, results);
    var row = function (state, title, detail) {
      return '<li class="fz-' + state + '">' + ui.icon(state === 'ok' ? 'check' : state === 'warn' ? 'alert' : 'info') +
        '<div><strong>' + esc(title) + '</strong>' + (detail ? '<div class="muted small">' + detail + '</div>' : '') + '</div></li>';
    };
    // Participation is set in the grading meeting (DECISIONS 5), and finalizing locks it: say so on its own.
    var meetingRow = iss.meeting.length ? row('warn',
      iss.meeting.map(function (m) { return m.name; }).join(', ') + (iss.meeting.length > 1 ? ' are' : ' is') + ' empty for ' + plural(iss.nMeeting, 'student'),
      'It is usually set in the grading meeting (Meeting view). <strong>Finalizing now locks it</strong>: to set it afterwards you would ' +
      'have to unlock the scores. To set it first, choose Cancel.') : '';
    var html = '<p>Finalizing <strong>locks the score cells</strong> (scores, participation, team scores, overrides, late work, names, No and teams) so they cannot ' +
      'be changed by accident. <strong>Final letters stay editable.</strong> You can unlock later; both steps are logged in History.</p>' +
      '<p class="section-label" style="margin:12px 0 6px">Data check</p><ul class="fz-checks">' +
      meetingRow +
      (iss.nMissing ? row('warn', plural(iss.nMissing, 'empty score') + ' (counted as 0)', esc(iss.missing.join(' · '))) :
        row('ok', meetingRow ? 'No other missing scores' : 'No missing scores')) +
      (iss.nInvalid ? row('warn', plural(iss.nInvalid, 'invalid or out-of-range entry', 'invalid or out-of-range entries'), esc(iss.invalid.join(' · '))) : row('ok', 'No invalid or out-of-range entries')) +
      (ph.length ? row('warn', plural(ph.length, 'setting') + ' still marked “needs confirmation”', esc(ph.map(function (x) { return x.label; }).join(' · '))) :
        row('ok', 'Every placeholder setting is confirmed')) +
      (w.ok ? row('ok', 'Weights add up to 100%') : row('warn', 'Weights add up to ' + num(w.sum, 2) + '%, not 100%')) +
      (ls.unassigned ? row('info', 'Final letters: ' + ls.assigned + ' of ' + ls.active + ' assigned', 'You assign them after finalizing (sorted by total, high to low).') :
        ls.invalid ? '' : row('ok', 'Every active student has a final letter')) +
      (ls.invalid ? row('warn', plural(ls.invalid, 'final letter') + ' not in the current letter scale',
        'Shown in red in Final letter (the scale was changed after they were chosen). Choose a letter of the scale for ' +
        (ls.invalid === 1 ? 'that student' : 'those students') + '.') : '') +
      '</ul>' +
      '<label class="check" style="margin-top:12px"><input type="checkbox" id="fz-copy"> Copy the suggested letters into empty final letters</label>' +
      '<div class="help muted small" style="margin:2px 0 10px 22px">Optional. The cutoffs are only suggestions; you can change any letter afterwards.</div>' +
      '<div class="field"><label for="fz-note">Note (optional, shown on the banner and saved with the change)</label>' +
      '<input id="fz-note" type="text" maxlength="' + NOTE_MAX + '" autocomplete="off" placeholder="e.g. reviewed with the instructor, Dec 10"></div>';
    ui.dialog.open({
      title: 'Finalize scores',
      bodyHtml: html,
      wide: true,
      initialFocus: '#fz-copy',
      buttons: [
        { text: 'Cancel', value: null },
        { spacer: true },
        {
          text: 'Finalize scores', primary: true,
          value: function (dlg) { return { copy: dlg.querySelector('#fz-copy').checked, note: dlg.querySelector('#fz-note').value.trim().slice(0, NOTE_MAX) }; }
        }
      ]
    }).then(function (v) {
      refocusGrid();
      if (!v) return;
      var copied = 0;
      var ok = transact('Finalize scores', function (c) {
        if (typeof model.finalize === 'function') model.finalize(c, util.nowIso(), v.note);
        else c.finalized = { at: util.nowIso(), note: v.note };
        if (v.copy) copied = copySuggested(c);
        return true;
      });
      if (!ok) return;
      // Sort by total, high to low (a fresh order, one flat list: grouping by team is turned off, so
      // the bands and their rules follow the class ranking), and start at the top of Final letter.
      forceResort = true;
      var p = getPrefs();
      var ungrouped = p.grouped;
      if (p.sort !== 'total' || p.dir !== 'desc' || ungrouped) {
        var patch = { sort: 'total', dir: 'desc' };
        if (ungrouped) patch.group = false;
        setPrefs(patch);
      } else {
        dataDirty = true;
      }
      var first = firstFinalCell();
      if (first) { sel.active = first; sel.end = first; revealActive = true; }
      gridToast('Scores finalized and sorted by total, high to low' + (ungrouped ? ' (grouping by team is off)' : '') + '.' +
        (copied ? ' ' + plural(copied, 'suggested letter') + ' copied into empty final letters.' : '') +
        ' Assign final letters: select a group of rows in Final letter, then choose a letter (Enter).', { type: 'success', timeout: 8000 });
    });
  }

  /** The first active student's Final letter cell in the new order (after a re-sort). */
  function firstFinalCell() {
    var course = cur(), results = res();
    var p = getPrefs();
    var list = calc.sortStudents(course, results, 'total', 'desc').filter(function (s) { return s.status !== 'withdrawn' || p.showWithdrawn; });
    var s = list.filter(function (x) { return x.status !== 'withdrawn'; })[0] || list[0];
    return s ? { sid: s.id, key: 'final' } : null;
  }

  /** Copies the suggested letters into the empty final letters of active students (inside a
   * transaction). Returns the number set. */
  function copySuggested(c) {
    var results = calc.computeCourse(c);
    if (typeof model.copySuggestedToFinal === 'function') {
      return model.copySuggestedToFinal(c, results, { onlyEmpty: true, activeOnly: true }) || 0;
    }
    var pairs = [];
    c.students.forEach(function (s) {
      if (s.status === 'withdrawn' || storedFinal(s) !== null) return;
      var r = results.byId[s.id];
      if (r && r.letter) pairs.push({ studentId: s.id, letter: r.letter });
    });
    return writeFinalLetters(c, pairs);
  }

  function copySuggestedAction() {
    var course = cur(), results = res();
    if (!course || !results) return;
    var ls = letterSummary(course, results);
    if (!ls.unassigned) {
      ui.toast('Every active student already has a final letter. Nothing to copy.' + (ls.invalid ? ' ' + plural(ls.invalid, 'of them is not a letter', 'of them are not letters') +
        ' of the current scale (shown in red): choose another letter for ' + (ls.invalid === 1 ? 'it.' : 'them.') : ''),
      { type: ls.invalid ? 'warn' : 'info', timeout: ls.invalid ? 6000 : 4000 });
      return;
    }
    ui.dialog.confirm({
      title: 'Copy suggested letters?',
      messageHtml: '<p>Fills the <strong>' + esc(plural(ls.unassigned, 'empty final letter')) + '</strong> of active students with the suggested letter ' +
        'from the cutoffs. Final letters already chosen stay as they are.</p>' +
        (model.isConfirmed(course, 'letterScale') ? '' : '<p class="callout callout-warn">The letter cutoffs are placeholders that still need confirmation.</p>') +
        '<p class="muted small">You can change any letter afterwards. Undo with Ctrl+Z.</p>',
      confirmText: 'Copy ' + plural(ls.unassigned, 'letter')
    }).then(function (ok) {
      refocusGrid();
      if (!ok) return;
      var n = 0;
      transact('Copy suggested letters', function (c) { n = copySuggested(c); });
      if (txFailed) return;
      ui.toast(n ? plural(n, 'suggested letter') + ' copied into empty final letters.' : 'No letter was copied.', { type: n ? 'success' : 'info' });
    });
  }

  function unlockScores() {
    var course = cur();
    if (!course || !isFinalized(course)) return;
    ui.dialog.confirm({
      title: 'Unlock scores?',
      messageHtml: '<p>Score cells become editable again. Final letters are not changed.</p>' +
        '<p class="muted small">The unlock is logged in the change history (“Scores finalized: yes → no”). You can finalize again at any time.</p>',
      confirmText: 'Unlock scores'
    }).then(function (ok) {
      refocusGrid();
      if (!ok) return;
      transact('Unlock scores', function (c) {
        if (typeof model.unfinalize === 'function') model.unfinalize(c);
        else c.finalized = null;
      });
      if (txFailed) return;
      ui.toast('Scores unlocked. Score cells can be edited again.', { type: 'success' });
    });
  }

  /** Selects the Final letter cell of a student (chips: first without a letter, first out of order). */
  function gotoFinal(sid) {
    if (!sid || !layout) return;
    var ref = { sid: sid, key: 'final' };
    if (!posOf(ref)) {
      // Hidden by the search or the withdrawn filter: clear them first.
      if (searchText) { searchText = ''; if (dom && dom.search) dom.search.value = ''; }
      renderTable();
      if (!posOf(ref)) return;
    }
    sel.active = ref;
    sel.end = ref;
    paintSelection();
    focusActive();
    var p = posOf(ref);
    ensureVisible(cellAt(p.r, p.c));
  }

  /** The letters chip: the first active student (in row order) without a final letter, or with one
   * that is not a letter of the current scale. */
  function gotoFirstUnassigned() {
    if (!layout) return;
    var course = cur(), set = letterSetOf(course);
    var todo = function (s) { return s.status !== 'withdrawn' && (storedFinal(s) === null || invalidFinal(course, s, set)); };
    var hit = layout.students.filter(todo)[0] || course.students.filter(todo)[0];
    if (hit) gotoFinal(hit.id);
  }

  function gotoFirstOrderIssue() {
    var course = cur(), results = res();
    var oi = orderIssueMap(course, results);
    if (!oi.first || !layout) return;
    var ids = Object.keys(oi.map);
    var hit = layout.students.filter(function (s) { return ids.indexOf(s.id) !== -1; })[0];
    gotoFinal(hit ? hit.id : oi.first.lowerTotalId);
  }

  // ------------------------------------------------------------------ meeting view and re-sort

  function toggleMeeting() {
    var p = getPrefs();
    if (!p.meeting) {
      setPrefs({ meeting: true, meetingPrev: p.sort + ':' + p.dir, sort: 'total', dir: 'desc' });
      gridToast('Meeting view: sorted by total, high to low. ' + participationName(cur()) + ' and Final letter are highlighted to fill in the meeting.', { type: 'info', timeout: 5000 });
    } else {
      var prev = String(p.meetingPrev || '').split(':');
      var patch = { meeting: false, meetingPrev: '' };
      if ((prev[0] === 'name' || prev[0] === 'total') && (prev[1] === 'asc' || prev[1] === 'desc')) { patch.sort = prev[0]; patch.dir = prev[1]; }
      setPrefs(patch);
    }
    revealActive = true;
  }

  function resort() {
    forceResort = true;
    endHold = null;
    revealActive = true;
    focusUntil = nowMs() + 1500;
    renderTable();
    focusActive();
  }

  // ------------------------------------------------------------------ columns menu (checkbox popover)

  function syncColumnsMenu() {
    if (!colsMenu) return;
    var p = getPrefs();
    ui.$$('[role="menuitemcheckbox"]', colsMenu.el).forEach(function (b) {
      b.setAttribute('aria-checked', p.cols[b.getAttribute('data-key')] ? 'true' : 'false');
    });
  }

  function placeColumnsMenu() {
    if (!colsMenu) return;
    var r = colsMenu.anchor.getBoundingClientRect(), m = colsMenu.el;
    var x = Math.max(8, Math.min(r.left, root.innerWidth - m.offsetWidth - 8));
    var y = r.bottom + 4;
    if (y + m.offsetHeight > root.innerHeight - 8) y = Math.max(8, r.top - m.offsetHeight - 4);
    m.style.left = x + 'px';
    m.style.top = y + 'px';
  }

  function closeColumnsMenu(returnFocus) {
    if (!colsMenu) return;
    var cm = colsMenu;
    colsMenu = null;
    document.removeEventListener('mousedown', cm.onDoc, true);
    root.removeEventListener('resize', cm.onResize);
    root.removeEventListener('scroll', cm.onScroll, true);
    if (cm.el.parentNode) cm.el.parentNode.removeChild(cm.el);
    cm.anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus && cm.anchor.isConnected) cm.anchor.focus();
  }

  function openColumnsMenu(anchor) {
    if (colsMenu) { closeColumnsMenu(true); return; }
    ui.closeMenu();
    var course = cur();
    var meet = getPrefs().meeting;
    var hasAtt = attendanceAvailable(course);
    // The Meeting view has a fixed set of columns; only the absence columns can be hidden there.
    var toggles = COL_TOGGLES.filter(function (t) { return t.att ? hasAtt : !meet; });
    var m = document.createElement('div');
    m.className = 'menu grid-cols-menu';
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Show columns');
    m.innerHTML = '<div class="menu-label">Show columns</div>' + toggles.map(function (t) {
      return '<button type="button" role="menuitemcheckbox" tabindex="-1" data-key="' + t.key + '" aria-checked="false">' +
        ui.icon('check', 'cm-check') + '<span>' + esc(t.label) + '</span></button>';
    }).join('') + '<div class="menu-sep" role="separator"></div><div class="cm-note">' +
      (meet ? 'The Meeting view shows a fixed set of columns. ' : '') + 'Scores, Total, Suggested, Final letter and Rank are always shown.' +
      (hasAtt ? '' : ' Absence columns appear when attendance is on.') + '</div>';
    document.body.appendChild(m);
    var items = ui.$$('[role="menuitemcheckbox"]', m);
    var toggle = function (b) {
      var p = getPrefs();
      delete p.grouped;
      var key = b.getAttribute('data-key');
      p.cols[key] = !p.cols[key];
      b.setAttribute('aria-checked', p.cols[key] ? 'true' : 'false');
      GT.store.setUi({ gridPrefs: p });
    };
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[role="menuitemcheckbox"]');
      if (b) toggle(b);
    });
    if (!items.length) m.setAttribute('tabindex', '-1');
    m.addEventListener('keydown', function (e) {
      var i = items.indexOf(document.activeElement);
      if (!items.length && e.key !== 'Escape' && e.key !== 'Tab') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeColumnsMenu(true); }
      else if (e.key === 'Tab') { e.preventDefault(); closeColumnsMenu(true); }
      else if ((e.key === ' ' || e.key === 'Enter') && i !== -1) { e.preventDefault(); toggle(items[i]); }
    });
    colsMenu = {
      el: m, anchor: anchor,
      onDoc: function (e) { if (!m.contains(e.target) && !anchor.contains(e.target)) closeColumnsMenu(false); },
      onResize: function () { closeColumnsMenu(false); },
      onScroll: function (e) { if (!m.contains(e.target)) placeColumnsMenu(); }
    };
    anchor.setAttribute('aria-expanded', 'true');
    syncColumnsMenu();
    placeColumnsMenu();
    setTimeout(function () {
      if (colsMenu && colsMenu.el === m) {
        document.addEventListener('mousedown', colsMenu.onDoc, true);
        root.addEventListener('resize', colsMenu.onResize);
        root.addEventListener('scroll', colsMenu.onScroll, true);
      }
    }, 0);
    if (items[0]) items[0].focus(); else m.focus();
  }

  // ------------------------------------------------------------------ actions

  function addStudent() {
    var course = cur();
    if (!course) return;
    if (isFinalized(course)) { notifyLocked(); return; }
    var no = model.nextStudentNo(course);
    var sid = null;
    if (searchText) { searchText = ''; if (dom && dom.search) dom.search.value = ''; }
    transact('Add student', function (c) {
      var s = model.createStudent({ no: no });
      c.students.push(s);
      sid = s.id;
    });
    if (!sid) return;
    newRowSid = sid;
    tabStartKey = null;
    pendingEdit = { sid: sid, key: 'last' };
    focusUntil = nowMs() + 1500;
    ui.toast('Student No ' + no + ' added. Type the last name, then Enter for the first name.', { type: 'success', timeout: 3500 });
  }

  function toggleSort(key) {
    var p = getPrefs();
    if (p.sort === key) setPrefs({ dir: p.dir === 'asc' ? 'desc' : 'asc' });
    else setPrefs({ sort: key, dir: key === 'total' ? 'desc' : 'asc' });
  }

  function toggleLegend(b) {
    if (!dom || !dom.legend) return;
    var open = !dom.legend.classList.contains('is-open');
    dom.legend.classList.toggle('is-open', open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    queueWrapTop();
    setPrefs({ legend: open });
  }

  function focusSearch() {
    if (!dom || !dom.search) return;
    dom.search.focus();
    dom.search.select();
  }

  // ------------------------------------------------------------------ events

  function cellFromEvent(e) {
    if (!dom || !dom.table || !layout) return null;
    var t = e.target;
    var td = t && t.closest ? t.closest('td[data-c]') : null;
    if (!td || !dom.table.contains(td)) return null;
    var r = parseInt(td.parentNode.getAttribute('data-r'), 10), c = parseInt(td.getAttribute('data-c'), 10);
    if (isNaN(r) || isNaN(c) || !layout.students[r] || !layout.cols[c]) return null;
    return { td: td, r: r, c: c };
  }

  function onMouseDown(e) {
    if (editing && editing.input.contains(e.target)) {
      // A press in this open list: the 'change' that follows is a pointer pick (see onChange).
      if (editing.list) editing.pointerAt = nowMs();
      return;
    }
    // The typing hint hangs over the next rows but is not part of them (css: pointer-events: none).
    // Should a click still land on it, it means the cell underneath, never the cell being edited.
    var hit;
    if (editing && editing.hint && editing.hint.contains(e.target)) {
      editing.hint.style.visibility = 'hidden';
      var under = document.elementFromPoint(e.clientX, e.clientY);
      editing.hint.style.visibility = '';
      hit = under ? cellFromEvent({ target: under }) : null;
      if (!hit) { e.preventDefault(); return; }
    } else {
      hit = cellFromEvent(e);
    }
    if (!hit) return;
    tabExit = false;
    endHold = null;
    if (e.target.closest('button')) return;
    if (e.button === 2) {
      if (!inRect(hit.r, hit.c)) {
        if (editing) leaveEditor();
        tabStartKey = null;
        sel.active = refAt(hit.r, hit.c);
        sel.end = sel.active;
        paintSelection();
      }
      focusActive();
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    if (editing) leaveEditor();
    tabStartKey = null;
    if (e.shiftKey && posOf(sel.active)) {
      sel.end = refAt(hit.r, hit.c);
      drag = null;
    } else {
      sel.active = refAt(hit.r, hit.c);
      sel.end = sel.active;
      if (sel.active.sid !== newRowSid) newRowSid = null;
      drag = { on: true };
    }
    paintSelection();
    focusActive();
    dodgeToasts();
  }

  function onMouseOver(e) {
    if (!drag) return;
    if (!(e.buttons & 1)) { drag = null; return; }
    var hit = cellFromEvent(e);
    if (!hit) return;
    var end = posOf(sel.end);
    if (end && end.r === hit.r && end.c === hit.c) return;
    sel.end = refAt(hit.r, hit.c);
    paintSelection();
  }

  function onDblClick(e) {
    var hit = cellFromEvent(e);
    if (!hit || editing || e.target.closest('button')) return;
    sel.active = refAt(hit.r, hit.c);
    sel.end = sel.active;
    paintSelection();
    if (editableAt(hit)) startEdit('edit');
    else if (lockedCol(cur(), layout.cols[hit.c])) notifyLocked();
    else notifyReadOnly();
  }

  function onContextMenu(e) {
    var th = e.target && e.target.closest ? e.target.closest('thead th.h-raw') : null;
    if (th && dom && dom.table && dom.table.contains(th)) {
      var mb = th.querySelector('[data-act="col-menu"]');
      if (mb) {
        e.preventDefault();
        var fromKeyboard = e.button !== 2 || (e.clientX === 0 && e.clientY === 0);
        openColumnMenu(fromKeyboard ? mb : { x: e.clientX, y: e.clientY }, mb.getAttribute('data-aid'));
      }
      return;
    }
    var hit = cellFromEvent(e);
    if (!hit) return;
    e.preventDefault();
    // Some platforms follow Shift+F10 / the menu key with a contextmenu event: the menu is already open.
    if (e.button !== 2 && nowMs() - kbMenuAt < 600) return;
    if (!inRect(hit.r, hit.c)) {
      sel.active = refAt(hit.r, hit.c);
      sel.end = sel.active;
      paintSelection();
    }
    focusActive();
    var keyboard = e.button !== 2 || (e.clientX === 0 && e.clientY === 0);
    openCellMenu(keyboard ? null : { x: e.clientX, y: e.clientY });
  }

  function onClick(e) {
    var t = e.target;
    if (editing && editing.list && t && t.tagName === 'OPTION' && editing.input.contains(t)) {
      commitEdit(null, {});
      return;
    }
    var b = t && t.closest ? t.closest('[data-act]') : null;
    if (!b || !boundEl || !boundEl.contains(b)) return;
    var act = b.getAttribute('data-act');
    if (act === 'group') { if (!getPrefs().meeting) setPrefs({ group: !getPrefs().group }); }
    else if (act === 'withdrawn') setPrefs({ showWithdrawn: !getPrefs().showWithdrawn });
    else if (act === 'columns') openColumnsMenu(b);
    else if (act === 'legend') toggleLegend(b);
    else if (act === 'add-student') addStudent();
    else if (act === 'paste-roster') {
      if (isFinalized(cur())) notifyLocked();
      else if (typeof GT.ui.openRosterPaste === 'function') GT.ui.openRosterPaste();
    }
    else if (act === 'resort') resort();
    else if (act === 'meeting') toggleMeeting();
    else if (act === 'finalize') finalizeDialog();
    else if (act === 'unlock') unlockScores();
    else if (act === 'copy-suggested') copySuggestedAction();
    else if (act === 'letters-chip') gotoFirstUnassigned();
    else if (act === 'order-chip') gotoFirstOrderIssue();
    else if (act === 'col-menu') openColumnMenu(b, b.getAttribute('data-aid'));
    else if (act === 'dd-open') {
      var a0 = posOf(sel.active);
      if (a0 && editableAt(a0) && !editing) startEdit('list');
    }
    else if (act === 'load-sample') { if (GT.app && GT.app.actions && GT.app.actions.loadSample) GT.app.actions.loadSample(); }
    else if (act === 'import') { if (GT.views.exchange && GT.app) GT.app.navigate('exchange'); }
    else if (act === 'weights') { if (GT.views.settings && GT.app) GT.app.navigate('settings', { section: 'assessments' }); }
    else if (act === 'sort') toggleSort(b.getAttribute('data-sort'));
    else if (act === 'team-score') {
      if (isFinalized(cur())) notifyLocked();
      else editTeamScore(b.getAttribute('data-tid'), b.getAttribute('data-aid'));
    }
    else if (act === 'details') {
      var tr = b.closest('tr[data-r]');
      var r = tr ? parseInt(tr.getAttribute('data-r'), 10) : NaN;
      if (!isNaN(r) && layout && layout.students[r] && typeof GT.ui.openStudent === 'function') GT.ui.openStudent(layout.students[r].id);
    }
  }

  /** A pick with the mouse (or a finger) in an open list saves at once. Chromium also fires 'change'
   * on every arrow key in a list, so only a change that follows a press in this same list counts:
   * the press time belongs to the editor (a new list starts without one) and any key clears it. */
  function onChange(e) {
    var ed = editing;
    if (ed && ed.list && e.target === ed.input && ed.pointerAt && nowMs() - ed.pointerAt < 1500) commitEdit(null, {});
  }

  function onInput(e) {
    if (editing && e.target === editing.input) validateEditor();
  }

  function onFocusOut(e) {
    if (!editing || e.target !== editing.input) return;
    leaveEditor();
  }

  function onKeyDown(e) {
    if (editing && e.target === editing.input) { editorKey(e); return; }
    var hit = cellFromEvent(e);
    if (!hit) return;
    gridKey(e);
  }

  function editorKey(e) {
    var ed = editing, k = e.key, mod = e.ctrlKey || e.metaKey;
    if (e.isComposing) return;
    ed.pointerAt = 0; // browsing a list with the keyboard never saves until Enter or Tab (see onChange)
    var handled = true;
    var ddText = !ed.list && ed.col && ed.col.dd;
    if (k === 'Enter' && !e.altKey) {
      e.preventDefault();
      // Ctrl+Enter fills the selected range with the typed value (a drop-down cell already applies
      // what it gets to every selected row).
      if (mod && !ed.list && !ddText && hasRange()) {
        var v = ed.input.value;
        closeEditor(true);
        applyBlock([[v]], { source: 'edit' });
      } else {
        commitEdit(e.shiftKey ? 'up' : 'enter', {});
      }
    } else if (k === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      commitEdit(e.shiftKey ? 'shift-tab' : 'tab', {});
    } else if (k === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (ddText && e.altKey && !mod && (k === 'ArrowDown' || k === 'ArrowUp')) {
      e.preventDefault();
      switchToList();
    } else if (!ed.list && k === 'F2') {
      e.preventDefault();
      ed.mode = ed.mode === 'enter' ? 'edit' : 'enter';
      ed.input.classList.toggle('mode-edit', ed.mode === 'edit');
    } else if (!ed.list && ed.mode === 'enter' && !mod && !e.altKey &&
      (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight')) {
      e.preventDefault();
      commitEdit(k === 'ArrowUp' ? 'up' : k === 'ArrowDown' ? 'down' : k === 'ArrowLeft' ? 'left' : 'right', {});
    } else if (mod && !e.altKey && !e.shiftKey && (k === 'l' || k === 'L') && ed.col && ed.col.kind === 'raw') {
      // Ctrl+L while typing a score: save it first (like Enter without moving), then "Late work…".
      e.preventDefault();
      var lsid = ed.sid, laid = ed.aid;
      if (commitEdit(null, {})) openLateDialog(lsid, laid);
    } else if (ed.list && ed.kind !== 'team' && !mod && !e.altKey && k.length === 1 && k !== ' ') {
      // Type-ahead in the list: "4" picks 4 (not 4.5); "b+" picks B+.
      e.preventDefault();
      listTypeAhead(k);
    } else {
      handled = false;
    }
    if (handled) e.stopPropagation();
  }

  function gridKey(e) {
    var k = e.key, mod = e.ctrlKey || e.metaKey, shift = e.shiftKey;
    var a = posOf(sel.active);
    if (!a || e.isComposing) return;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return;
    var exit = tabExit;
    tabExit = false;
    var end = posOf(sel.end) || a;
    var nR = layout.students.length, nC = layout.cols.length;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
      if (e.altKey) {
        // Alt+Down opens the drop-down list of a Final letter, list-score or Team cell.
        if (k === 'ArrowDown' && !mod && !shift) {
          var ac = layout.cols[a.c];
          if (ac.dd || ac.edit === 'team') {
            e.preventDefault();
            if (editableAt(a)) startEdit('list');
            else if (lockedCol(cur(), ac)) notifyLocked();
          }
        }
        return;
      }
      e.preventDefault();
      var base = shift ? end : a;
      var dr = k === 'ArrowUp' ? -1 : (k === 'ArrowDown' ? 1 : 0);
      var dc = k === 'ArrowLeft' ? -1 : (k === 'ArrowRight' ? 1 : 0);
      var r = base.r + dr, c = base.c + dc;
      if (mod) {
        if (dr) r = dr < 0 ? 0 : nR - 1;
        if (dc) c = dc < 0 ? 0 : nC - 1;
      }
      tabStartKey = null;
      moveTo(r, c, shift);
      return;
    }
    if (k === 'Tab' && !mod && !e.altKey) {
      // Esc, then Tab (or the first/last cell): let focus leave the grid. Only the active cell is in
      // the tab order, so the browser moves on to the controls after (or before) the table.
      if (exit) return;
      var t = tabTarget(a, shift);
      if (!t) return;
      e.preventDefault();
      if (tabStartKey === null) tabStartKey = layout.cols[a.c].key;
      moveTo(t.r, t.c, false);
      return;
    }
    if (k === 'Home' || k === 'End') {
      e.preventDefault();
      var b2 = shift ? end : a;
      if (mod) moveTo(k === 'Home' ? 0 : nR - 1, k === 'Home' ? 0 : nC - 1, shift);
      else moveTo(b2.r, k === 'Home' ? 0 : nC - 1, shift);
      tabStartKey = null;
      return;
    }
    if (k === 'PageUp' || k === 'PageDown') {
      e.preventDefault();
      var b3 = shift ? end : a;
      moveTo(b3.r + (k === 'PageUp' ? -PAGE_ROWS : PAGE_ROWS), b3.c, shift);
      tabStartKey = null;
      return;
    }
    if (k === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      // The cell held at the end of the list: Enter is part of the typing that ran past the last row.
      if (heldAt(sel.active)) { endHoldKey(); return; }
      if (editableAt(a)) { startEdit('edit'); return; }
      // A locked score (finalized) says why it does not open, like F2 and typing; Enter still moves on.
      if (lockedCol(cur(), layout.cols[a.c])) notifyLocked();
      tabStartKey = null;
      moveTo(a.r + (shift ? -1 : 1), a.c, false);
      return;
    }
    if (k === 'F2') {
      e.preventDefault();
      if (editableAt(a)) startEdit('edit');
      else if (lockedCol(cur(), layout.cols[a.c])) notifyLocked();
      else notifyReadOnly();
      return;
    }
    if ((k === 'Delete' || k === 'Backspace') && !mod && !e.altKey) {
      e.preventDefault();
      clearCells();
      return;
    }
    if (k === 'Escape') {
      if (hasRange()) { e.preventDefault(); sel.end = sel.active; paintSelection(); }
      tabExit = true;
      return;
    }
    if ((k === 'F10' && shift) || k === 'ContextMenu') {
      e.preventDefault();
      kbMenuAt = nowMs();
      openCellMenu(null);
      return;
    }
    if (mod && !e.altKey && !shift && (k === 'l' || k === 'L')) {
      // Ctrl+L (Cmd+L): "Late work…" of the active score cell. The browser's address-bar shortcut is
      // blocked only here, while a grid cell has the focus.
      e.preventDefault();
      var lc = layout.cols[a.c];
      if (lc && lc.kind === 'raw') openLateDialog(layout.students[a.r].id, lc.aid);
      else ui.toast('Late work belongs to a score: move to a raw score cell (for example Test 1), then press Ctrl+L.', { type: 'info' });
      return;
    }
    if (mod && !e.altKey && (k === 'a' || k === 'A')) {
      e.preventDefault();
      sel.active = refAt(0, 0);
      sel.end = refAt(nR - 1, nC - 1);
      paintSelection();
      focusActive();
      return;
    }
    if (mod && !e.altKey && !shift && (k === 'c' || k === 'C')) {
      // The browser fires a copy event next (handled below); fall back to the async API if it does not.
      copyHandled = false;
      setTimeout(function () { if (!copyHandled) copySelection(); }, 0);
      return;
    }
    if (k === ' ' && (shift || mod) && !e.altKey) {
      e.preventDefault();
      if (shift && !mod) { sel.active = refAt(a.r, 0); sel.end = refAt(end.r, nC - 1); }
      else { sel.active = refAt(0, a.c); sel.end = refAt(nR - 1, end.c); }
      paintSelection();
      focusActive();
      return;
    }
    if (!mod && !e.altKey && k.length === 1) {
      if (k === '/') { e.preventDefault(); focusSearch(); return; }
      if (k === '?') return; // app shortcut list
      e.preventDefault();
      e.stopPropagation();
      if (heldAt(sel.active)) { endHoldKey(); return; }
      if (!editableAt(a)) {
        if (lockedCol(cur(), layout.cols[a.c])) notifyLocked(); else notifyReadOnly();
        return;
      }
      startEdit('enter', layout.cols[a.c].edit === 'team' ? null : k);
    }
  }

  function onCopy(e) {
    if (pendingCopy !== null) {
      if (e.clipboardData) { e.clipboardData.setData('text/plain', pendingCopy); e.preventDefault(); }
      copyHandled = true;
      return;
    }
    if (!isActiveView() || editing || document.querySelector('dialog[open]')) return;
    var ae = document.activeElement;
    if (!ae || !dom.table.contains(ae) || ae.tagName !== 'TD') return;
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/plain', selectionTsv());
    e.preventDefault();
    copyHandled = true;
    copiedToast();
  }

  function onPaste(e) {
    if (!isActiveView() || editing || document.querySelector('dialog[open]')) return;
    var ae = document.activeElement;
    var t = e.target && e.target.nodeType === 1 ? e.target : null;
    var inGrid = (ae && ae.tagName === 'TD' && dom.table.contains(ae)) || (t && t.tagName === 'TD' && dom.table.contains(t));
    if (!inGrid || (t && ui.isTypingTarget(t))) return;
    var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    e.preventDefault();
    if (!text) { ui.toast('The clipboard has no text to paste.', { type: 'info' }); return; }
    applyBlock(parseClipboard(text), { source: 'paste' });
  }

  function bindContainer(el) {
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mouseover', onMouseOver);
    el.addEventListener('dblclick', onDblClick);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('keydown', onKeyDown);
  }

  function bindGlobal() {
    if (globalBound) return;
    globalBound = true;
    document.addEventListener('mouseup', function () { drag = null; });
    root.addEventListener('resize', function () { if (isActiveView()) queueWrapTop(); });
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    // A toast from anywhere (autosave, undo, the grid) must not sit on the active cell.
    var host = document.getElementById('toasts');
    if (host && typeof root.MutationObserver === 'function') {
      new root.MutationObserver(function (list) {
        list.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { n.__gtAt = nowMs(); }); });
        try { dodgeToasts(); } catch (e) { /* layout not ready: the next move tries again */ }
      }).observe(host, { childList: true });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (!isActiveView() || ui.isTypingTarget(e.target) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      focusSearch();
    });
  }

  /** Opens the "Finalize scores" dialog from another view (Settings, Grading status card). Switches to
   * the Grades tab first, so the new Total high–low order and the Final letter column are on screen
   * once the scores are finalized. */
  GT.ui.openFinalize = function () {
    if (isActiveView() || !GT.app || typeof GT.app.navigate !== 'function') { setTimeout(finalizeDialog, 0); return; }
    GT.app.navigate('grades');
    // The app renders on the next animation frame: open the dialog after that render.
    var opened = false;
    var open = function () { if (!opened) { opened = true; finalizeDialog(); } };
    if (root.requestAnimationFrame) root.requestAnimationFrame(function () { setTimeout(open, 0); });
    setTimeout(open, 300); // frames do not run in a hidden tab
  };

  /** Opens the "Late work…" dialog of a student's score from any view (student details). */
  GT.ui.openLateWork = function (studentId, assessmentId) { openLateDialog(studentId, assessmentId); };

  GT.views.grades = {
    id: 'grades',
    title: 'Grades',
    render: render,
    destroy: destroy,
    /** Diagnostics for tests: duration of the last table build in ms. */
    lastRenderMs: function () { return lastRenderMs; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
