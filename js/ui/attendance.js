/* Grade Tracker - Attendance view (GT.views.attendance), stage 3 (T1-T6, X7).
 *
 * Modes (per course): per session (marking grid, session manager, roll call), totals only (a table of
 * absence counts) and off (an empty state with a "turn on" button). Changing the mode keeps every mark
 * and every total, so switching back shows them again.
 *
 * Words used everywhere: "Excused (allowed, instructor-approved)" and "Absent (not allowed, unexcused)"
 * (DECISIONS 3). Unexcused absences drive the threshold highlight; by default excused absences do not
 * count toward a consecutive-absence streak (DECISIONS 6). Warnings never change a grade (T5), and
 * attendance never feeds participation (T6).
 *
 * Summaries, streaks and the mark/session mutators come from GT.attendance (js/core/attendance.js).
 * Every call is guarded, so the view never crashes when that module is missing. Every change goes
 * through GT.store.transact (one undo step, logged in the change history).
 *
 * The marking grid is one innerHTML string for the body (59 x 26 cells in a few ms) with delegated
 * events; the table keeps keyboard focus (aria-activedescendant), so re-renders never drop it. A change
 * of a few marks made here (typing P/A/E, roll call) patches just those cells, their rows' summaries and
 * the column counts (patchGrid), so marking stays instant even for large classes. The summary columns are
 * pinned on the right only when the grid is wide enough to show at least 6 sessions next to them.
 * Browser only. Privacy: student names carry class "pii". Colors come from css/base.css tokens. */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model;
  var ui = GT.ui = GT.ui || {};
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  // ------------------------------------------------------------------ constants

  var MODES = [
    { id: 'per-session', label: 'Per session', help: 'Mark Present, Absent or Excused for each class meeting.' },
    { id: 'totals', label: 'Totals only', help: 'Type each student’s absence counts, without dates.' },
    { id: 'off', label: 'Off', help: 'Attendance is not tracked. Nothing entered is deleted.' }
  ];
  var MODE_LABEL = { 'per-session': 'Per session', totals: 'Totals only', off: 'Off' };
  var MARK_NAME = { P: 'Present', A: 'Absent', E: 'Excused' };
  var MARK_LONG = { P: 'Present', A: 'Absent (not allowed, unexcused)', E: 'Excused (allowed, instructor-approved)' };
  var CYCLE = { '': 'P', P: 'A', A: 'E', E: '' };
  /** Fall 2026 TR pattern, used when model.FALL_2026_TR is not available. */
  var FALL_TR = { start: '2026-09-03', end: '2026-12-08', weekdays: [2, 4], exclude: ['2026-11-24', '2026-11-26'] };
  var WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
  var LABEL_MAX = 60;

  /** Identity columns before the first session column (No, Last, First). */
  var FIRST = 3;
  /** Column widths in px. Keep in sync with css/attendance.css (sticky offsets). */
  var W = { no: 46, last: 128, first: 112, ses: 48, exc: 66, unx: 80, tot: 60, arate: 64, urate: 80, streak: 64, warn: 178 };
  var SUMMARY_KEYS = ['exc', 'unx', 'tot', 'arate', 'urate', 'streak', 'warn'];
  var SUMMARY_W = SUMMARY_KEYS.reduce(function (a, k) { return a + W[k]; }, 0);
  var LEFT_W = W.no + W.last + W.first;
  /** The summary columns stay pinned on the right only while at least this many session columns remain
   * visible between them and the name columns; otherwise they scroll with the sessions (class sr-static). */
  var MIN_VISIBLE_SESSIONS = 6;
  /** A mark change touching at most this many cells patches the grid in place instead of rebuilding it. */
  var PATCH_MAX_CELLS = 60;

  var CELL_P = '<td class="m mp">P</td>';
  var CELL_A = '<td class="m ma">A</td>';
  var CELL_E = '<td class="m me">E</td>';

  // ------------------------------------------------------------------ module state (per open view)

  var boundEl = null;        // the container the listeners are bound to
  var dom = null;            // element references of the current skeleton
  var contentKind = null;    // 'per-session' | 'totals' | 'off' | 'nocore' | 'none'
  var gridKind = null;       // inside per-session: 'grid' | 'nostudents' | 'nosessions'
  var lastCourseId = null;
  var lastParams = null;
  var dataDirty = true;
  var searchText = '';
  var searchTimer = null;
  var needScrollToActive = false;
  var lastRenderMs = 0;
  var globalBound = false;
  /** The rendered grid: visible rows (students), sessions and lookups by id. */
  var gv = { rows: [], sessions: [], rowIdx: {}, colIdx: {}, byId: {}, held: {}, counts: [] };
  /** Selection by identity, so it survives re-renders: a = anchor, b = active cell ({ sid, ses }). */
  var sel = { a: null, b: null };
  var decorated = [];
  var drag = null;           // { moved, armed } while the mouse button is down in the grid
  var armedCycle = null;     // the cell a second click cycles
  var invalid = {};          // data-f -> { value, msg }: typed values that were refused (kept across re-renders)
  var dirtyVersion = 0;      // counts every reason to re-render (store changes, search, preferences)
  var patchHint = null;      // { version, courseId, cells: [{ sid, ses }] }: the last change was only these marks
  var endHold = null;        // { sid, ses }: a mark just set on the last row; the next P/A/E there is ignored

  // ------------------------------------------------------------------ small helpers

  function icon(name, cls) { return ui.icon(name, cls); }
  function str(x) { return x === null || x === undefined ? '' : String(x); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function whole(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
  function logErr(e) { if (root.console) console.error(e); }
  /** 'P' | 'A' | 'E' for a mark key, else ''. A Latin layout uses the typed letter (so AZERTY works);
   * a non-Latin layout (e.g. Arabic) types another letter on those keys, so the physical key decides. */
  function markKey(e) {
    var k = e && typeof e.key === 'string' ? e.key : '';
    if (k.length !== 1) return '';
    if (k.charCodeAt(0) < 128) {
      var up = k.toUpperCase();
      return up === 'P' || up === 'A' || up === 'E' ? up : '';
    }
    var code = typeof e.code === 'string' ? e.code : '';
    return code === 'KeyP' ? 'P' : code === 'KeyA' ? 'A' : code === 'KeyE' ? 'E' : '';
  }
  function markDirty() { dataDirty = true; dirtyVersion++; }

  /** The computer's local calendar date (the "today" the TA sees on the wall clock). */
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function wdOf(iso) { return util.isIsoDate(iso) ? util.WEEKDAY_SHORT[util.weekday(iso)] : ''; }
  function mdOf(iso) {
    if (!util.isIsoDate(iso)) return str(iso);
    return util.MONTH_SHORT[parseInt(iso.slice(5, 7), 10) - 1] + ' ' + parseInt(iso.slice(8, 10), 10);
  }
  function shortDate(iso) { return (wdOf(iso) + ' ' + mdOf(iso)).trim(); }
  function longDate(iso) { return util.isIsoDate(iso) ? shortDate(iso) + ', ' + iso.slice(0, 4) : str(iso); }
  function sesName(s) { return s ? shortDate(s.date) + (s.label ? ' (' + s.label + ')' : '') : ''; }
  function pct(x) { return typeof x === 'number' && isFinite(x) ? util.formatPercent(x, 1) : ''; }
  function studentName(s) { return model.studentName ? model.studentName(s) : (s.lastName || '') + ', ' + (s.firstName || ''); }
  function byName(a, b) {
    if (GT.calc && GT.calc.compareByName) return GT.calc.compareByName(a, b);
    return util.compareText(a.lastName, b.lastName) || util.compareText(a.firstName, b.firstName);
  }
  function modeOf(course) {
    var m = course && course.attendance ? course.attendance.mode : 'off';
    return m === 'per-session' || m === 'totals' ? m : 'off';
  }
  function sessionsOf(course) {
    var a = course && course.attendance;
    return a && Array.isArray(a.sessions) ? a.sessions : [];
  }
  function recordsOf(course) {
    var a = course && course.attendance;
    return a && util.isPlainObject(a.records) ? a.records : {};
  }
  function markAt(course, sid, sesId) {
    var rec = recordsOf(course);
    var row = util.hasOwn(rec, sid) ? rec[sid] : null;
    var m = row && util.hasOwn(row, sesId) ? row[sesId] : '';
    return m === 'P' || m === 'A' || m === 'E' ? m : '';
  }
  /** Marks per session id (every student, withdrawn included): what deleting a session removes. */
  function marksPerSession(course) {
    var out = {};
    var rec = recordsOf(course);
    (course && Array.isArray(course.students) ? course.students : []).forEach(function (s) {
      var row = s && util.hasOwn(rec, s.id) ? rec[s.id] : null;
      if (!util.isPlainObject(row)) return;
      Object.keys(row).forEach(function (k) {
        var m = row[k];
        if (m === 'P' || m === 'A' || m === 'E') out[k] = (out[k] || 0) + 1;
      });
    });
    return out;
  }
  function thresholdOf(course) {
    var t = course && course.attendance ? course.attendance.unexcusedThreshold : null;
    return typeof t === 'number' && isFinite(t) ? t : 3;
  }
  function totalThresholdOf(course) {
    var t = course && course.attendance ? course.attendance.totalAbsenceThreshold : null;
    return typeof t === 'number' && isFinite(t) ? t : null;
  }
  function dropOf(course) { var d = course && course.attendance ? course.attendance.dropStreak : 3; return typeof d === 'number' && isFinite(d) ? d : 3; }
  function failOf(course) { var f = course && course.attendance ? course.attendance.failStreak : 4; return typeof f === 'number' && isFinite(f) ? f : 4; }

  // ------------------------------------------------------------------ the core module (guarded)

  function coreFn(name) {
    var a = GT.attendance;
    return a && typeof a[name] === 'function' ? a[name] : null;
  }
  function coreReady() { return !!(coreFn('summary') && coreFn('courseSummary')); }
  /** Calls a read-only core function; any problem gives `dflt` (logged), never an exception. */
  function read(name, args, dflt) {
    var f = coreFn(name);
    if (!f) return dflt;
    try {
      var v = f.apply(GT.attendance, args);
      return v === undefined || v === null ? dflt : v;
    } catch (e) { logErr(e); return dflt; }
  }
  /** A core mutator for use inside a transaction; throws a readable error when it is missing. */
  function mut(name) {
    var f = coreFn(name);
    if (!f) throw new Error('The attendance module (js/core/attendance.js) is not loaded, so this change cannot be made.');
    return function () { return f.apply(GT.attendance, arguments); };
  }
  /** One undoable, logged change. Errors are shown as a toast and return undefined (nothing is saved). */
  function tx(label, mutator, opts) {
    try {
      return GT.store.transact(label, mutator, opts);
    } catch (e) {
      logErr(e);
      ui.toast('Not saved: ' + (e && e.message ? e.message : String(e)), { type: 'error' });
      return undefined;
    }
  }
  function setMarksIn(c, list) {
    var many = coreFn('setMarks');
    if (many) return many.call(GT.attendance, c, list);
    var one = mut('setMark');
    var n = 0;
    list.forEach(function (x) { if (markAt(c, x.studentId, x.sessionId) !== (x.mark || '')) { one(c, x.studentId, x.sessionId, x.mark || null); n++; } });
    return n;
  }

  // ------------------------------------------------------------------ preferences (ui.attendancePrefs)

  function getPrefs() {
    var st = GT.store && GT.store.state;
    var p = st && st.ui && util.isPlainObject(st.ui.attendancePrefs) ? st.ui.attendancePrefs : {};
    return { showWithdrawn: p.showWithdrawn !== false, summary: p.summary !== false };
  }
  function setPrefs(patch) {
    var p = getPrefs();
    Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    markDirty();
    GT.store.setUi({ attendancePrefs: p });
  }

  if (GT.store && GT.store.subscribe) {
    GT.store.subscribe(function (info) {
      var t = info && info.type;
      if (t === 'saved' || t === 'annotate') return;
      if (t === 'ui' && !(info.patch && util.hasOwn(info.patch, 'attendancePrefs'))) return;
      markDirty();
    });
  }

  /** Runs one undoable change of marks only, and remembers which cells it touched, so the next render can
   * patch those cells instead of rebuilding the grid. Returns what tx returns. */
  function txMarks(label, cells, mutator, opts) {
    var v0 = dirtyVersion;
    var clean = !dataDirty; // everything before this change is already on screen
    var courseId = opts && opts.courseId ? opts.courseId : (GT.store.course() || {}).id;
    var ret = tx(label, mutator, opts);
    // Exactly one notification (this transaction) and nothing else: the change was these marks only.
    patchHint = clean && dirtyVersion === v0 + 1 && cells && cells.length <= PATCH_MAX_CELLS
      ? { version: dirtyVersion, courseId: courseId, cells: cells } : null;
    return ret;
  }

  function isActiveView() {
    return !!(boundEl && document.body.contains(boundEl) && GT.store && GT.store.state && GT.store.state.ui.activeView === 'attendance');
  }

  // ------------------------------------------------------------------ render

  function render(el, ctx) {
    if (el !== boundEl) bindContainer(el);
    bindGlobal();
    var course = ctx.course;
    if (!course) {
      el.innerHTML = '<div class="empty-state"><h2>No course</h2><p>Add a course from the course menu.</p></div>';
      dom = null;
      contentKind = 'none';
      return;
    }
    var courseChanged = course.id !== lastCourseId;
    if (courseChanged) {
      lastCourseId = course.id;
      sel = { a: null, b: null };
      searchText = '';
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      if (dom && dom.search) dom.search.value = ''; // the box would show the old query without filtering by it
      invalid = {};
      endHold = null;
      needScrollToActive = true;
      if (ui.closeMenu) ui.closeMenu();
    }
    var params = ctx.params && ctx.params !== lastParams ? ctx.params : null;
    if (params) lastParams = params;

    var mode = modeOf(course);
    var kind = mode === 'off' ? 'off' : (coreReady() ? mode : 'nocore');
    var rebuilt = false;
    // Keyboard focus inside the content, which a rebuild below may remove (e.g. "Turn on attendance").
    var hadFocus = !!(dom && dom.content && document.activeElement && dom.content.contains(document.activeElement));
    if (!dom) { buildShell(el); rebuilt = true; }
    if (kind !== contentKind) {
      buildContent(kind);
      contentKind = kind;
      rebuilt = true;
      needScrollToActive = true;
    }
    if (contentKind === 'per-session') queueSize(); // a banner above may have come or gone
    var hint = patchHint;
    patchHint = null;
    if (!rebuilt && !dataDirty && !courseChanged && !ctx.switched && !params) return;
    dataDirty = false;
    try {
      var cs = mode !== 'off' && coreReady() ? read('courseSummary', [course], null) : null;
      updateTop(course, mode, cs);
      // Only a few marks changed since the last render: patch those cells instead of rebuilding the grid.
      var patched = !rebuilt && !courseChanged && !ctx.switched && !params && !!hint && hint.version === dirtyVersion &&
        hint.courseId === course.id && kind === 'per-session' && gridKind === 'grid' && patchGrid(course, cs, hint.cells);
      if (patched) updateCards(course, kind, cs);
      else updateContent(course, kind, cs);
    } catch (e) {
      logErr(e);
      dom.content.innerHTML = '<div class="callout callout-danger"><strong>Attendance could not be shown.</strong> ' + esc(e && e.message) +
        '<br>Your data is safe. Try another tab or reload the page.</div>';
      contentKind = 'error';
      return;
    }
    if (hadFocus && (!document.activeElement || document.activeElement === document.body)) focusModeButton();
    if (params && params.studentId && model.findStudent(course, params.studentId)) {
      setTimeout(function () { jumpToStudent(params.studentId); }, 0);
    } else if (params && (params.section === 'settings' || params.section === 'warnings')) {
      setTimeout(function () { gotoCard(params.section); }, 0);
    } else if (needScrollToActive && kind === 'per-session' && gridKind === 'grid') {
      needScrollToActive = false;
      if (sel.b && gv.rowIdx[sel.b.sid] !== undefined && gv.colIdx[sel.b.ses] !== undefined) ensureVisible(activeTd());
      else jumpToToday(false);
    }
  }

  function destroy() {
    if (ui.closeMenu) ui.closeMenu();
    drag = null;
    armedCycle = null;
    patchHint = null;
    endHold = null;
  }

  /** A stable place for keyboard focus when the focused control disappeared: the selected mode button. */
  function focusModeButton() {
    var b = dom && dom.modes ? dom.modes.querySelector('.att-mode[aria-pressed="true"]') || dom.modes.querySelector('.att-mode') : null;
    if (!b) return;
    try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); }
  }

  // ------------------------------------------------------------------ skeleton

  function bindContainer(el) {
    boundEl = el;
    dom = null;
    contentKind = null;
    gridKind = null;
    el.addEventListener('click', onClick);
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mouseover', onMouseOver);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('focusin', onFocusIn);
  }

  function bindGlobal() {
    if (globalBound) return;
    globalBound = true;
    document.addEventListener('mouseup', function () { if (drag) drag = null; });
    root.addEventListener('resize', function () { if (isActiveView()) sizeWrap(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (!isActiveView() || ui.isTypingTarget(e.target) || document.querySelector('dialog[open]')) return;
      var s = boundEl.querySelector('.att-search');
      if (!s) return;
      e.preventDefault();
      s.focus();
      s.select();
    });
  }

  function buildShell(el) {
    var modes = MODES.map(function (m) {
      return '<button type="button" class="att-mode" data-act="mode" data-mode="' + m.id + '" aria-pressed="false">' +
        '<span class="am-name">' + esc(m.label) + '</span><span class="am-help">' + esc(m.help) + '</span></button>';
    }).join('');
    el.innerHTML =
      '<div class="page-header att-head">' +
        '<div class="att-head-text"><h1 class="att-title"><span class="att-code"></span><span class="att-title-sub">Attendance</span></h1>' +
        '<div class="sub att-sub"></div></div>' +
        '<div class="att-modes" role="group" aria-label="Attendance mode">' + modes + '</div>' +
      '</div>' +
      '<div class="att-content"></div>';
    dom = {
      code: el.querySelector('.att-code'),
      sub: el.querySelector('.att-sub'),
      modes: el.querySelector('.att-modes'),
      content: el.querySelector('.att-content')
    };
    contentKind = null;
    gridKind = null;
  }

  function buildContent(kind) {
    var c = dom.content;
    gridKind = null;
    dom.table = dom.thead = dom.tbody = dom.tfoot = dom.wrap = dom.gridHost = dom.narrowNote = null;
    dom.search = dom.cards = dom.count = dom.totalsBody = null;
    if (kind === 'off') {
      c.innerHTML = '<div class="card att-off"></div>';
      dom.off = c.querySelector('.att-off');
      return;
    }
    if (kind === 'nocore') {
      c.innerHTML = '<div class="callout callout-warn att-nocore">' + icon('alert') +
        ' <strong>The attendance calculations are not loaded.</strong> Keep the <span class="mono">js</span> folder next to ' +
        '<span class="mono">index.html</span> and reload the page. Your marks are safe.</div>';
      return;
    }
    var tools = searchHtml() +
      '<button type="button" class="btn btn-sm" data-act="withdrawn" aria-pressed="false">' + icon('eye') + '<span class="bl">Show withdrawn</span></button>';
    if (kind === 'per-session') {
      c.innerHTML =
        '<div class="toolbar att-toolbar">' + tools +
          '<button type="button" class="btn btn-sm" data-act="summary-cols" aria-pressed="true" title="Show or hide the summary columns on the right">' + icon('layers') + '<span class="bl">Summary columns</span></button>' +
          '<span class="toolbar-sep"></span>' +
          '<button type="button" class="btn btn-sm" data-act="today" title="Scroll to the session of today (or the next one)">' + icon('calendar') + '<span class="bl">Jump to today</span></button>' +
          '<button type="button" class="btn btn-sm btn-primary" data-act="roll" title="Take roll for one session, student by student, with big buttons">' + icon('users') + '<span class="bl">Take roll…</span></button>' +
          '<button type="button" class="btn btn-sm" data-act="sessions" title="Add, edit, delete or generate class sessions">' + icon('edit') + '<span class="bl">Sessions…</span></button>' +
          '<span class="spacer"></span><span class="att-count muted small"></span>' +
        '</div>' +
        '<div class="att-legend" aria-label="Legend">' +
          '<span><span class="lg-m mp">P</span>Present</span>' +
          '<span><span class="lg-m ma">A</span>Absent (not allowed, unexcused)</span>' +
          '<span><span class="lg-m me">E</span>Excused (allowed, instructor-approved)</span>' +
          '<span><span class="lg-m"></span>blank: not recorded</span>' +
          '<span class="lg-hint">Click a cell twice, or type P, A or E. Shift+arrows select several cells. Right-click for more.</span>' +
        '</div>' +
        '<div class="att-narrow-note" hidden>' + icon('info') +
          '<span>Narrow window: the absence totals and warnings are at the right end of each row.</span>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-act="to-totals">Show totals ' + icon('chevron-right') + '</button></div>' +
        '<div class="att-gridhost"></div>' +
        '<div class="att-cards"><section class="card att-warn-card" data-card="warnings" aria-label="Warnings"></section>' +
        '<section class="card att-set-card" data-card="settings" aria-label="Attendance settings"></section></div>';
      dom.gridHost = c.querySelector('.att-gridhost');
      dom.narrowNote = c.querySelector('.att-narrow-note');
    } else {
      c.innerHTML =
        '<div class="toolbar att-toolbar att-totals-bar">' +
          '<div class="att-held"><label for="att-held">Sessions held so far</label>' +
          '<input id="att-held" type="text" inputmode="numeric" class="att-num" data-f="held" autocomplete="off" aria-describedby="att-held-help att-held-err">' +
          '<span id="att-held-help" class="help att-held-help">The rates divide by this number.</span>' +
          '<span class="att-ferr" id="att-held-err" data-err="held" role="alert"></span></div>' +
          '<span class="toolbar-sep"></span>' + tools +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn btn-sm" data-act="fill-totals" hidden>' + icon('copy') + '<span class="bl">Fill from per-session marks…</span></button>' +
          '<span class="att-count muted small"></span>' +
        '</div>' +
        '<div class="callout att-totals-note">' + icon('info') + '<span>Consecutive-absence (streak) warnings are <strong>n/a in totals mode</strong>: they need the date of each absence. ' +
          'Switch to <em>Per session</em> to get them. Type whole numbers; press Enter to go to the next student.</span></div>' +
        '<div class="table-wrap att-totals-wrap"><table class="table att-totals"><thead><tr>' +
          '<th scope="col" class="num">No</th><th scope="col">Name</th>' +
          '<th scope="col" class="t-in">Absent<span class="h-sub">(not allowed, unexcused)</span></th>' +
          '<th scope="col" class="t-in">Excused<span class="h-sub">(allowed, instructor-approved)</span></th>' +
          '<th scope="col" class="num">Total<span class="h-sub">absences</span></th>' +
          '<th scope="col" class="num">Absence<span class="h-sub">rate</span></th>' +
          '<th scope="col" class="num">Unexcused<span class="h-sub">rate</span></th>' +
          '<th scope="col">Streak warning</th>' +
        '</tr></thead><tbody></tbody></table></div>' +
        '<div class="att-cards"><section class="card att-warn-card" data-card="warnings" aria-label="Warnings"></section>' +
        '<section class="card att-set-card" data-card="settings" aria-label="Attendance settings"></section></div>';
      dom.totalsBody = c.querySelector('.att-totals tbody');
    }
    dom.search = c.querySelector('.att-search');
    dom.search.value = searchText;
    dom.count = c.querySelector('.att-count');
    dom.warnCard = c.querySelector('.att-warn-card');
    dom.setCard = c.querySelector('.att-set-card');
  }

  function searchHtml() {
    return '<label class="search att-search-box">' + icon('search') + '<span class="sr-only">Search students</span>' +
      '<input type="search" class="att-search" placeholder="Search name or No  ( / )" autocomplete="off" spellcheck="false" data-f="search"></label>';
  }

  // ------------------------------------------------------------------ header (course, mode)

  function updateTop(course, mode, cs) {
    dom.code.textContent = course.code || 'Course';
    ui.$$('.att-mode', dom.modes).forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
    var sub;
    var active = course.students.filter(function (s) { return s.status !== 'withdrawn'; }).length;
    if (mode === 'per-session') {
      var held = coreReady() ? read('heldSessions', [course], []).length : 0;
      sub = plural(sessionsOf(course).length, 'session') + ' · ' + held + ' held so far · ' + plural(active, 'active student');
    } else if (mode === 'totals') {
      sub = 'Totals only · ' + plural(whole(course.attendance.totalsSessionsHeld), 'session') + ' held so far · ' + plural(active, 'active student');
    } else {
      sub = 'Attendance is off for this course.';
    }
    var warnN = mode !== 'off' && cs && Array.isArray(cs.warnings) ? uniqueStudents(cs.warnings) : 0;
    setHtmlKeep(dom.sub, esc(sub) + (warnN ? ' <button type="button" class="chip warn att-warn-chip" data-act="goto-warnings" title="Show the warnings list">' +
      icon('alert') + plural(warnN, 'student') + ' with warnings</button>' : ''), focusModeButton);
  }

  function uniqueStudents(warnings) {
    var seen = {};
    var n = 0;
    warnings.forEach(function (w) { if (w && !seen[w.studentId]) { seen[w.studentId] = true; n++; } });
    return n;
  }

  // ------------------------------------------------------------------ content

  function updateContent(course, kind, cs) {
    if (kind === 'off') { renderOff(course); return; }
    if (kind === 'nocore') return;
    var p = getPrefs();
    var wbtn = dom.content.querySelector('[data-act="withdrawn"]');
    if (wbtn) {
      wbtn.setAttribute('aria-pressed', p.showWithdrawn ? 'true' : 'false');
      wbtn.title = p.showWithdrawn ? 'Withdrawn students are shown greyed out. Click to hide them.' : 'Withdrawn students are hidden. Click to show them.';
    }
    cs = cs || read('courseSummary', [course], null) || { byStudent: {}, warnings: [] };
    if (kind === 'per-session') renderPerSession(course, cs, p);
    else renderTotals(course, cs, p);
    updateCards(course, kind, cs);
  }

  function updateCards(course, kind, cs) {
    cs = cs || { byStudent: {}, warnings: [] };
    setHtmlKeep(dom.warnCard, warningsCardHtml(course, cs, kind));
    setHtmlKeep(dom.setCard, settingsCardHtml(course, kind));
    restoreInvalid(dom.setCard);
  }

  /** Visible students in name order (search and the withdrawn filter applied). */
  function visibleStudents(course, p) {
    var q = searchText.trim().toLowerCase();
    return course.students.slice().sort(byName).filter(function (s) {
      if (!p.showWithdrawn && s.status === 'withdrawn') return false;
      if (!q) return true;
      var hay = (str(s.no) + ' ' + str(s.lastName) + ' ' + str(s.firstName) + ' ' + str(s.firstName) + ' ' + str(s.lastName)).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function countText(course, shown, p) {
    var total = course.students.length;
    var wd = course.students.filter(function (s) { return s.status === 'withdrawn'; }).length;
    var t = shown === total ? plural(total, 'student') : shown + ' of ' + plural(total, 'student');
    if (wd && !p.showWithdrawn) t += ' · ' + wd + ' withdrawn hidden';
    return t;
  }

  // ------------------------------------------------------------------ off mode

  function renderOff(course) {
    var marks = 0;
    var m = marksPerSession(course);
    Object.keys(m).forEach(function (k) { marks += m[k]; });
    var totals = course.attendance && util.isPlainObject(course.attendance.totals) ? Object.keys(course.attendance.totals).length : 0;
    var kept = marks || totals ? '<p class="att-off-kept">' + icon('check') + ' Attendance entered earlier is kept' +
      (marks ? ' (' + plural(marks, 'mark') + ')' : '') + ' and comes back when you turn attendance on.</p>' : '';
    var html = '<div class="empty-state att-off-state">' + icon('calendar', 'att-off-ico') +
      '<h2>Attendance is not tracked for ' + esc(course.code || 'this course') + ' this semester</h2>' +
      '<p>Attendance is <strong>off</strong> for this course, so the Grades tab shows no absence columns. ' +
      'You can turn it on at any time; nothing else changes, and turning it off again deletes nothing.</p>' + kept +
      '<div class="actions">' +
        '<button type="button" class="btn btn-primary" data-act="turn-on" data-mode="per-session">' + icon('calendar') + 'Turn on attendance (per session)</button>' +
        '<button type="button" class="btn" data-act="turn-on" data-mode="totals">Use totals only</button>' +
      '</div>' +
      '<ul class="att-off-modes">' + MODES.filter(function (x) { return x.id !== 'off'; }).map(function (x) {
        return '<li><strong>' + esc(x.label) + ':</strong> ' + esc(x.help) + '</li>';
      }).join('') + '</ul></div>';
    setHtmlKeep(dom.off, html);
  }

  // ------------------------------------------------------------------ per-session mode: the grid

  function renderPerSession(course, cs, p) {
    var students = course.students;
    var sessions = sessionsOf(course);
    var want = !students.length ? 'nostudents' : !sessions.length ? 'nosessions' : 'grid';
    if (want !== gridKind) {
      gridKind = want;
      if (want === 'grid') {
        dom.gridHost.innerHTML = '<div class="att-wrap"><table class="att-grid" role="grid" tabindex="0" aria-label="Attendance marks: rows are students, columns are class sessions">' +
          '<thead></thead><tbody></tbody><tfoot></tfoot></table></div>';
        dom.wrap = dom.gridHost.querySelector('.att-wrap');
        dom.table = dom.gridHost.querySelector('.att-grid');
        dom.thead = dom.table.tHead;
        dom.tbody = dom.table.tBodies[0];
        dom.tfoot = dom.table.tFoot;
        decorated = [];
      } else {
        dom.wrap = dom.table = dom.thead = dom.tbody = dom.tfoot = null;
        dom.gridHost.innerHTML = want === 'nostudents'
          ? '<div class="empty-state att-empty">' + icon('users', 'att-off-ico') + '<h2>No students yet</h2>' +
            '<p>Add students in <strong>Students &amp; Teams</strong> (paste a roster, or load sample data from the course menu). Their rows appear here.</p>' +
            '<div class="actions"><button type="button" class="btn btn-primary" data-act="goto-students">' + icon('users') + 'Open Students &amp; Teams</button></div></div>'
          : '<div class="empty-state att-empty">' + icon('calendar', 'att-off-ico') + '<h2>No class sessions yet</h2>' +
            '<p>Add the dates your class meets. <strong>Generate</strong> fills a whole semester at once (for example every Tuesday and Thursday), and you can edit or delete any date later.</p>' +
            '<div class="actions"><button type="button" class="btn btn-primary" data-act="sessions-gen">' + icon('calendar') + 'Generate sessions…</button>' +
            '<button type="button" class="btn" data-act="sessions">' + icon('plus') + 'Add one session…</button></div></div>';
      }
    }
    var rows = visibleStudents(course, p);
    dom.count.textContent = countText(course, rows.length, p);
    var sb = dom.content.querySelector('[data-act="summary-cols"]');
    if (sb) sb.setAttribute('aria-pressed', p.summary ? 'true' : 'false');
    if (want !== 'grid') { gv = { rows: [], sessions: [], rowIdx: {}, colIdx: {}, byId: {}, held: {}, counts: [] }; return; }
    renderGrid(course, cs, rows, sessions, p);
  }

  function heldMap(course) {
    var held = {};
    read('heldSessions', [course], []).forEach(function (s) { if (s && s.id) held[s.id] = true; });
    return held;
  }

  function renderGrid(course, cs, rows, sessions, p) {
    var t0 = now();
    var hostW = dom.gridHost ? dom.gridHost.clientWidth : 0; // read before any write (no forced layout)
    var held = heldMap(course);
    var byId = {};
    course.students.forEach(function (s) { byId[s.id] = s; });
    var rowIdx = {}, colIdx = {};
    rows.forEach(function (s, i) { rowIdx[s.id] = i; });
    sessions.forEach(function (s, j) { colIdx[s.id] = j; });
    var counts = sessions.map(function (s) { return held[s.id] ? read('sessionCounts', [course, s.id], null) : null; });
    var oldRowIdx = gv.rowIdx || {}, oldColIdx = gv.colIdx || {};
    gv = { rows: rows, sessions: sessions, rowIdx: rowIdx, colIdx: colIdx, byId: byId, held: held, counts: counts };

    // The active cell's student or session is gone (deleted, or filtered out by the search): stay on the
    // nearest remaining row and column, so the next key still marks a cell and the TA keeps their place.
    // With no row at all (a search without a match) the selection is kept for when the rows come back.
    if (sel.b && rows.length && sessions.length && (rowIdx[sel.b.sid] === undefined || colIdx[sel.b.ses] === undefined)) {
      var r0 = rowIdx[sel.b.sid], c0 = colIdx[sel.b.ses];
      if (r0 === undefined) r0 = oldRowIdx[sel.b.sid] === undefined ? 0 : Math.min(oldRowIdx[sel.b.sid], rows.length - 1);
      if (c0 === undefined) c0 = oldColIdx[sel.b.ses] === undefined ? 0 : Math.min(oldColIdx[sel.b.ses], sessions.length - 1);
      sel = { a: null, b: { sid: rows[r0].id, ses: sessions[c0].id } };
      endHold = null;
    }
    if (sel.a && (rowIdx[sel.a.sid] === undefined || colIdx[sel.a.ses] === undefined)) sel.a = null;

    var today = todayIso();
    var summaryOn = p.summary;
    dom.table.classList.toggle('no-summary', !summaryOn);
    applyPinning(hostW, summaryOn);
    var width = LEFT_W + sessions.length * W.ses + (summaryOn ? SUMMARY_W : 0);
    dom.table.style.width = width + 'px';
    setHtml(dom.thead, headHtml(course, sessions, held, counts, today));

    // Body: one string (59 x 26 cells in a few ms).
    var tb = now();
    var rec = recordsOf(course);
    var S = sessions.length;
    var ids = new Array(S), blank = new Array(S);
    for (var j = 0; j < S; j++) {
      ids[j] = sessions[j].id;
      blank[j] = held[ids[j]] ? '<td></td>' : '<td class="u"></td>';
    }
    var thr = thresholdOf(course), tthr = totalThresholdOf(course);
    var byStudent = cs && util.isPlainObject(cs.byStudent) ? cs.byStudent : {};
    var parts = new Array(rows.length);
    for (var r = 0; r < rows.length; r++) {
      var s = rows[r];
      var sm = util.hasOwn(byStudent, s.id) ? byStudent[s.id] : read('summary', [course, s.id], null);
      var wd = s.status === 'withdrawn';
      var rcls = rowClass(s, sm);
      var h = '<tr data-sid="' + esc(s.id) + '"' + (rcls ? ' class="' + rcls + '"' : '') + '>' +
        '<td class="sc sc1 c-no">' + esc(str(s.no)) + '</td>' +
        '<td class="sc sc2 c-last"><span class="pii">' + esc(s.lastName) + '</span></td>' +
        '<td class="sc sc3 c-first"><span class="pii">' + esc(s.firstName) + '</span>' + (wd ? '<span class="badge wd-badge">Withdrawn</span>' : '') + '</td>';
      var row = util.hasOwn(rec, s.id) ? rec[s.id] : null;
      for (j = 0; j < S; j++) {
        var m = row && util.hasOwn(row, ids[j]) ? row[ids[j]] : '';
        h += m === 'P' ? CELL_P : m === 'A' ? CELL_A : m === 'E' ? CELL_E : blank[j];
      }
      if (summaryOn) h += summaryCells(sm, thr, tthr, wd);
      parts[r] = h + '</tr>';
    }
    dom.tbody.innerHTML = parts.join('') ||
      '<tr class="no-rows"><td colspan="' + (FIRST + S + (summaryOn ? SUMMARY_KEYS.length : 0)) + '"><div class="no-rows-msg">No student matches the search.</div></td></tr>';
    var bodyMs = now() - tb;
    setHtml(dom.tfoot, footHtml(sessions, held, counts, summaryOn));
    // decorate() first clears the previous decoration, including a header cell that survived because the
    // header markup did not change (otherwise two session dates end up highlighted).
    decorate();
    queueSize();
    lastRenderMs = bodyMs;
    gv.renderMs = now() - t0;
  }

  /** Patches a mark-only change in place: the changed cells, their rows' summary cells and warning stripe,
   * and the header and footer counts. Much cheaper than rebuilding every row (no full table layout), so
   * typing P, A, E stays instant. Returns false when a full rebuild is needed instead: a session became
   * held or not held (every blank cell of that column changes), or the grid no longer matches. */
  function patchGrid(course, cs, cells) {
    if (!dom || !dom.table || !dom.tbody || !cells || !cells.length) return false;
    var sessions = sessionsOf(course);
    if (sessions.length !== gv.sessions.length) return false;
    for (var j = 0; j < sessions.length; j++) if (!sessions[j] || sessions[j].id !== gv.sessions[j].id) return false;
    var held = heldMap(course);
    var hk = Object.keys(held);
    if (hk.length !== Object.keys(gv.held).length || hk.some(function (id) { return !gv.held[id]; })) return false;
    var i, x, r, c;
    for (i = 0; i < cells.length; i++) {
      x = cells[i];
      if (gv.colIdx[x.ses] === undefined) return false;
      r = gv.rowIdx[x.sid];
      if (r !== undefined && (!dom.tbody.rows[r] || dom.tbody.rows[r].getAttribute('data-sid') !== x.sid)) return false;
    }
    var p = getPrefs();
    var byStudent = cs && util.isPlainObject(cs.byStudent) ? cs.byStudent : {};
    var thr = thresholdOf(course), tthr = totalThresholdOf(course);
    var rowsDone = {}, colsDone = {};
    undecorate();
    for (i = 0; i < cells.length; i++) {
      x = cells[i];
      c = gv.colIdx[x.ses];
      colsDone[c] = true;
      r = gv.rowIdx[x.sid];
      if (r === undefined) continue; // not shown (search, or withdrawn hidden): only the counts change
      var td = dom.tbody.rows[r].cells[FIRST + c];
      if (!td) continue;
      var m = markAt(course, x.sid, x.ses);
      td.textContent = m;
      if (m) td.className = 'm m' + m.toLowerCase();
      else if (held[x.ses]) td.removeAttribute('class'); // the "not recorded" dot (css :not([class]))
      else td.className = 'u';
      rowsDone[r] = true;
    }
    Object.keys(rowsDone).forEach(function (k) {
      var s = gv.rows[+k];
      var row = dom.tbody.rows[+k];
      var sm = util.hasOwn(byStudent, s.id) ? byStudent[s.id] : read('summary', [course, s.id], null);
      var rc = rowClass(s, sm);
      if (rc) row.className = rc; else row.removeAttribute('class');
      if (!p.summary) return;
      ui.$$('td.sr', row).forEach(function (cell) { row.removeChild(cell); });
      row.insertAdjacentHTML('beforeend', summaryCells(sm, thr, tthr, s.status === 'withdrawn'));
    });
    Object.keys(colsDone).forEach(function (k) {
      var ses = gv.sessions[+k];
      gv.counts[+k] = held[ses.id] ? read('sessionCounts', [course, ses.id], null) : null;
    });
    setHtml(dom.thead, headHtml(course, gv.sessions, held, gv.counts, todayIso()));
    setHtml(dom.tfoot, footHtml(gv.sessions, held, gv.counts, p.summary));
    decorate();
    return true;
  }

  /** The row's classes: withdrawn (muted, never a warning: warnings cover active students only), or the
   * syllabus warning stripe. */
  function rowClass(s, sm) {
    if (s.status === 'withdrawn') return 'wd';
    return sm && sm.warning === 'fail' ? 'w-fail' : sm && sm.warning === 'drop' ? 'w-drop' : '';
  }

  /** Pins the summary columns only when enough session columns stay visible between them and the names;
   * otherwise they scroll with the sessions and a one-line note says where they are. Decided from the
   * width the grid gets (not the window), so a zoomed laptop or a half-screen window works too. */
  function applyPinning(hostW, summaryOn) {
    if (!dom || !dom.table) return;
    if (!hostW) hostW = dom.gridHost ? dom.gridHost.clientWidth : 0;
    if (!hostW) return; // not laid out (hidden): keep the current state
    var unpin = !!summaryOn && hostW - LEFT_W - SUMMARY_W < MIN_VISIBLE_SESSIONS * W.ses;
    dom.table.classList.toggle('sr-static', unpin);
    if (dom.narrowNote) dom.narrowNote.hidden = !unpin;
  }

  function headHtml(course, sessions, held, counts, today) {
    var h = '<tr><th scope="col" class="sc sc1 c-no">No</th><th scope="col" class="sc sc2 c-last">Last name</th>' +
      '<th scope="col" class="sc sc3 c-first">First name</th>';
    var marks = marksPerSession(course);
    var active = course.students.filter(function (s) { return s.status !== 'withdrawn'; }).length;
    sessions.forEach(function (s, j) {
      var isHeld = !!held[s.id];
      var cnt = counts[j];
      var marked = cnt ? whole(cnt.present) + whole(cnt.absent) + whole(cnt.excused) : 0;
      var title = longDate(s.date) + (s.label ? ' · ' + s.label : '') + '\n' +
        (isHeld ? marked + ' of ' + active + ' active students marked' : 'Not held yet: nobody has a mark') +
        (s.date === today ? '\nToday' : '') + '\nClick for options: mark everyone present, edit, delete.';
      h += '<th scope="col" class="ses' + (isHeld ? '' : ' unheld') + (s.date === today ? ' today' : '') + '">' +
        '<button type="button" class="ses-btn" tabindex="-1" data-act="ses-menu" data-ses="' + esc(s.id) + '" aria-haspopup="menu" title="' + esc(title) + '"' +
        ' aria-label="' + esc(longDate(s.date) + (s.label ? ', ' + s.label : '') + (isHeld ? '' : ', not held yet') + ', ' + plural(marks[s.id] || 0, 'mark') + '. Session options') + '">' +
        '<span class="s-wd">' + esc(wdOf(s.date)) + '</span><span class="s-md">' + esc(mdOf(s.date)) + '</span>' +
        (s.label ? '<span class="s-lb">' + esc(s.label) + '</span>' : '') + '</button></th>';
    });
    if (!getPrefs().summary) return h + '</tr>';
    var thr = thresholdOf(course), tthr = totalThresholdOf(course);
    return h +
      '<th scope="col" class="sr sr-exc num" title="Excused absences: allowed, approved by the instructor">Excused<span class="h-sub">(allowed)</span></th>' +
      '<th scope="col" class="sr sr-unx num" title="Unexcused absences: not allowed. Highlighted above ' + thr + '">Unexcused<span class="h-sub">(not allowed)</span></th>' +
      '<th scope="col" class="sr sr-tot num" title="Excused + unexcused' + (tthr !== null ? '. Highlighted above ' + tthr : '') + '">Total<span class="h-sub">absences</span></th>' +
      '<th scope="col" class="sr sr-arate num" title="Total absences as a percentage of the sessions recorded for the student">Absence<span class="h-sub">rate</span></th>' +
      '<th scope="col" class="sr sr-urate num" title="Unexcused absences as a percentage of the sessions recorded for the student">Unexcused<span class="h-sub">rate</span></th>' +
      '<th scope="col" class="sr sr-streak num" title="Most consecutive absences (sessions nobody marked are skipped)">Longest<span class="h-sub">streak</span></th>' +
      '<th scope="col" class="sr sr-warn" title="Syllabus: ' + dropOf(course) + ' in a row means one letter grade drop, ' + failOf(course) + ' in a row means F. Warnings only: grades never change automatically.">' +
        'Syllabus warning<span class="h-sub">warning only</span></th></tr>';
  }

  /** The 7 summary cells of a row. A withdrawn student gets the numbers but no warning (no chip, no
   * threshold highlight): warnings cover active students only, like the warnings list. */
  function summaryCells(sm, thr, tthr, withdrawn) {
    if (!sm) return '<td class="sr sr-exc num"></td><td class="sr sr-unx num"></td><td class="sr sr-tot num"></td><td class="sr sr-arate num"></td>' +
      '<td class="sr sr-urate num"></td><td class="sr sr-streak num"></td><td class="sr sr-warn"></td>';
    var rec = whole(sm.recorded);
    var of = ' of ' + plural(rec, 'recorded session');
    var unx = whole(sm.unexcused), tot = whole(sm.totalAbsences), streak = whole(sm.longestStreak);
    var over = !withdrawn && !!sm.overThreshold, overT = !withdrawn && !!sm.overTotalThreshold;
    var h = '<td class="sr sr-exc num' + (sm.excused ? '' : ' zero') + '">' + whole(sm.excused) + '</td>' +
      '<td class="sr sr-unx num' + (over ? ' over' : unx ? '' : ' zero') + '"' +
        (over ? ' title="Above the unexcused-absence threshold (' + thr + ')"' : '') + '>' + unx + '</td>' +
      '<td class="sr sr-tot num' + (overT ? ' over' : tot ? '' : ' zero') + '"' +
        (overT ? ' title="Above the total-absence threshold (' + tthr + ')"' : '') + '>' + tot + '</td>' +
      '<td class="sr sr-arate num" title="' + tot + of + '">' + (pct(sm.absenceRate) || '<span class="faint">—</span>') + '</td>' +
      '<td class="sr sr-urate num" title="' + unx + of + '">' + (pct(sm.unexcusedRate) || '<span class="faint">—</span>') + '</td>' +
      '<td class="sr sr-streak num' + (streak >= 2 ? '' : ' zero') + '">' + streak + '</td>' +
      '<td class="sr sr-warn">' + (!withdrawn ? warnChip(sm) : sm.warning || sm.overThreshold || sm.overTotalThreshold
        ? '<span class="faint small" title="Warnings cover active students only">withdrawn: no warning</span>' : '') + '</td>';
    return h;
  }

  /** The row's syllabus chip: fail (danger) or drop (warn), with "(warning only)" in view (T5: the grade
   * never changes). */
  function warnChip(sm) {
    if (!sm || !sm.warning) return '';
    var n = whole(sm.longestStreak);
    if (sm.warning === 'fail') {
      return '<span class="chip danger att-chip" title="' + n + ' consecutive absences: the syllabus says F. Warning only: the grade is not changed.">' +
        n + ' in a row: F per syllabus <span class="att-chip-note">(warning only)</span></span>';
    }
    if (sm.warning === 'drop') {
      return '<span class="chip warn att-chip" title="' + n + ' consecutive absences: the syllabus says one letter grade drop. Warning only: the grade is not changed.">' +
        n + ' in a row: 1 letter drop <span class="att-chip-note">(warning only)</span></span>';
    }
    return '';
  }

  function footHtml(sessions, held, counts, summaryOn) {
    var rowsDef = [['present', 'Present'], ['absent', 'Absent'], ['excused', 'Excused'], ['unmarked', 'Not marked']];
    return rowsDef.map(function (d, k) {
      var h = '<tr class="f' + (k + 1) + '"><th scope="row" colspan="3" class="sc sc-span f-label">' + d[1] +
        (k === 0 ? '<span class="f-note">active students</span>' : '') + '</th>';
      sessions.forEach(function (s, j) {
        var c = counts[j];
        if (!c) { h += '<td class="u"></td>'; return; }
        var v = whole(c[d[0]]);
        var cls = v === 0 ? 'zero' : d[0] === 'absent' ? 'fa' : d[0] === 'excused' ? 'fe' : d[0] === 'unmarked' ? 'fu' : 'fp';
        h += '<td class="' + cls + '">' + v + '</td>';
      });
      if (summaryOn) h += '<td class="sr sr-span" colspan="' + SUMMARY_KEYS.length + '">' +
        (k === 0 ? '<span class="f-note">Per session, active students only</span>' : '') + '</td>';
      return h + '</tr>';
    }).join('');
  }

  var sizeQueued = false;
  function queueSize() {
    if (sizeQueued) return;
    sizeQueued = true;
    (root.requestAnimationFrame || setTimeout)(function () { sizeQueued = false; sizeWrap(); });
  }
  /** Makes the grid's scroll box end just above the bottom of the window. */
  function sizeWrap() {
    if (!dom || !dom.wrap || !dom.wrap.isConnected) return;
    applyPinning(0, getPrefs().summary); // the window (or zoom) may have changed the width the grid gets
    var top = dom.wrap.getBoundingClientRect().top + (root.scrollY || root.pageYOffset || 0);
    dom.wrap.style.setProperty('--att-top', Math.round(top) + 'px');
  }

  // ------------------------------------------------------------------ selection

  function activeTd() {
    if (!sel.b || !dom || !dom.tbody) return null;
    var r = gv.rowIdx[sel.b.sid], c = gv.colIdx[sel.b.ses];
    if (r === undefined || c === undefined) return null;
    var tr = dom.tbody.rows[r];
    return tr ? tr.cells[FIRST + c] || null : null;
  }

  function range() {
    if (!sel.b) return null;
    var r1 = gv.rowIdx[sel.b.sid], c1 = gv.colIdx[sel.b.ses];
    if (r1 === undefined || c1 === undefined) return null;
    var a = sel.a && gv.rowIdx[sel.a.sid] !== undefined && gv.colIdx[sel.a.ses] !== undefined ? sel.a : sel.b;
    var r0 = gv.rowIdx[a.sid], c0 = gv.colIdx[a.ses];
    return { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1), ar: r1, ac: c1 };
  }

  function undecorate() {
    decorated.forEach(function (el) {
      el.classList.remove('is-active', 'in-range', 'row-active', 'hdr-active');
      if (!el.className) el.removeAttribute('class'); // a blank cell keeps its "not recorded" dot (css :not([class]))
      if (el.id === 'att-active') el.removeAttribute('id');
      if (el.hasAttribute('aria-selected')) el.removeAttribute('aria-selected');
      if (el.tagName === 'TD' && el.hasAttribute('aria-label')) el.removeAttribute('aria-label');
    });
    decorated = [];
    // Belt and braces: exactly one session header may be highlighted.
    if (dom && dom.thead) ui.$$('.hdr-active', dom.thead).forEach(function (th) { th.classList.remove('hdr-active'); });
  }

  function decorate() {
    undecorate();
    if (!dom || !dom.table) return;
    var rg = range();
    if (!rg) { dom.table.removeAttribute('aria-activedescendant'); return; }
    var rows = dom.tbody.rows;
    if (rg.r0 !== rg.r1 || rg.c0 !== rg.c1) {
      for (var r = rg.r0; r <= rg.r1; r++) {
        var tr = rows[r];
        if (!tr) continue;
        for (var c = rg.c0; c <= rg.c1; c++) {
          var cell = tr.cells[FIRST + c];
          if (cell) { cell.classList.add('in-range'); cell.setAttribute('aria-selected', 'true'); decorated.push(cell); }
        }
      }
    }
    var atr = rows[rg.ar];
    var td = atr ? atr.cells[FIRST + rg.ac] : null;
    if (!td) return;
    td.classList.add('is-active');
    td.id = 'att-active';
    decorated.push(td);
    atr.classList.add('row-active');
    decorated.push(atr);
    var th = dom.thead.rows[0] ? dom.thead.rows[0].cells[FIRST + rg.ac] : null;
    if (th) { th.classList.add('hdr-active'); decorated.push(th); }
    var s = gv.rows[rg.ar], ses = gv.sessions[rg.ac];
    var m = markAt(GT.store.course(), s.id, ses.id);
    td.setAttribute('aria-label', studentName(s) + ', ' + longDate(ses.date) + (ses.label ? ' ' + ses.label : '') + ': ' + (m ? MARK_LONG[m] : 'not recorded'));
    dom.table.setAttribute('aria-activedescendant', 'att-active');
  }

  function setActive(r, c, extend) {
    if (!gv.rows.length || !gv.sessions.length) return;
    r = Math.max(0, Math.min(gv.rows.length - 1, r));
    c = Math.max(0, Math.min(gv.sessions.length - 1, c));
    endHold = null;
    var cell = { sid: gv.rows[r].id, ses: gv.sessions[c].id };
    if (extend) { if (!sel.a) sel.a = sel.b || cell; }
    else sel.a = null;
    sel.b = cell;
    decorate();
    ensureVisible(activeTd());
  }

  function move(dr, dc, extend) {
    var r = sel.b ? gv.rowIdx[sel.b.sid] : undefined;
    var c = sel.b ? gv.colIdx[sel.b.ses] : undefined;
    if (r === undefined || c === undefined) { setActive(0, defaultCol(), false); return; }
    setActive(r + dr, c + dc, extend);
  }

  /** The column of the session nearest to today (on or after), for a first selection. */
  function defaultCol() {
    var course = GT.store.course();
    var idx = read('nearestSessionIndex', [course, todayIso()], 0);
    var s = sessionsOf(course)[idx];
    var c = s ? gv.colIdx[s.id] : undefined;
    return c === undefined ? 0 : c;
  }

  /** Scrolls the grid's own box (not the page) so the cell is not under a sticky column, header or footer. */
  function ensureVisible(td) {
    if (!td || !dom.wrap) return;
    var wrap = dom.wrap;
    var summaryW = getPrefs().summary && stickyRight() ? SUMMARY_W : 0;
    var leftW = stickyLeftWidth();
    var headH = dom.thead.offsetHeight || 0, footH = dom.tfoot.offsetHeight || 0;
    var x = td.offsetLeft, w = td.offsetWidth, y = td.offsetTop, h = td.offsetHeight;
    if (x < wrap.scrollLeft + leftW) wrap.scrollLeft = Math.max(0, x - leftW);
    else if (x + w > wrap.scrollLeft + wrap.clientWidth - summaryW) wrap.scrollLeft = x + w - wrap.clientWidth + summaryW;
    if (y < wrap.scrollTop + headH) wrap.scrollTop = Math.max(0, y - headH);
    else if (y + h > wrap.scrollTop + wrap.clientHeight - footH) wrap.scrollTop = y + h - wrap.clientHeight + footH;
  }
  /** Body cells tell whether a column is pinned: header cells are sticky anyway (for the top edge). */
  function firstBodyRow() {
    var tr = dom.tbody ? dom.tbody.rows[0] : null;
    return tr && !tr.classList.contains('no-rows') ? tr : null;
  }
  function stickyRight() {
    var tr = firstBodyRow();
    var td = tr ? tr.querySelector('.sr-exc') : null;
    return !!(td && root.getComputedStyle(td).position === 'sticky');
  }
  function stickyLeftWidth() {
    var tr = firstBodyRow();
    var cells = tr ? tr.querySelectorAll('.sc') : [];
    var wsum = 0, i, cs;
    for (i = 0; i < cells.length; i++) {
      if (root.getComputedStyle(cells[i]).position === 'sticky') wsum += cells[i].offsetWidth;
    }
    if (!tr && dom.thead) {
      // No body row (the search matches nobody): the header cells, which are sticky for the top edge
      // too, count only when they also stick on the left (left is not 'auto').
      cells = dom.thead.querySelectorAll('tr:first-child th.sc');
      for (i = 0; i < cells.length; i++) {
        cs = root.getComputedStyle(cells[i]);
        if (cs.position === 'sticky' && cs.left !== 'auto') wsum += cells[i].offsetWidth;
      }
    }
    return wsum || W.no + W.last;
  }

  /** 'Show totals' (narrow window: the summary columns scroll with the sessions). Scrolls so the summary
   * starts right after the pinned name columns: Excused, Unexcused and Total, the numbers the instructor
   * needs, are always in view. Scrolling to the very end would push them under the names whenever the
   * summary is wider than the room left beside them; when it fits, this still shows all of it. */
  function showTotals() {
    if (!dom || !dom.wrap) return;
    var wrap = dom.wrap;
    var max = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    var th = dom.thead ? dom.thead.querySelector('tr:first-child th.sr-exc') : null;
    wrap.scrollLeft = th ? Math.max(0, Math.min(th.offsetLeft - stickyLeftWidth(), max)) : max;
  }

  function focusGrid() {
    if (!dom || !dom.table) return;
    try { dom.table.focus({ preventScroll: true }); } catch (e) { dom.table.focus(); }
  }

  function cellFromEvent(e) {
    if (!dom || !dom.tbody) return null;
    var td = e.target.closest ? e.target.closest('td') : null;
    if (!td || !dom.tbody.contains(td)) return null;
    var tr = td.parentNode;
    var r = tr.sectionRowIndex, c = td.cellIndex - FIRST;
    if (!gv.rows[r]) return null;
    return { td: td, r: r, c: c, isMark: c >= 0 && c < gv.sessions.length };
  }

  // ------------------------------------------------------------------ marking

  /** The selected cells as [{ sid, ses }], plus whether the range spans several rows. */
  function selectedCells() {
    var rg = range();
    if (!rg) return { list: [], multiRow: false };
    var list = [];
    for (var r = rg.r0; r <= rg.r1; r++) {
      for (var c = rg.c0; c <= rg.c1; c++) list.push({ sid: gv.rows[r].id, ses: gv.sessions[c].id });
    }
    return { list: list, multiRow: rg.r1 > rg.r0 };
  }

  /** Sets (or clears, mark = null) the selected cells in ONE transaction. A range over several rows skips
   * withdrawn students. advance: after a single cell, move down one row. */
  function applyMark(mark, advance) {
    var course = GT.store.course();
    if (!course || !sel.b) return;
    var cells = selectedCells();
    var skippedIds = {}, skipped = 0;
    var list = [];
    cells.list.forEach(function (x) {
      var s = gv.byId[x.sid];
      if (cells.multiRow && s && s.status === 'withdrawn') {
        if (!skippedIds[x.sid]) { skippedIds[x.sid] = true; skipped++; } // students, not cells
        return;
      }
      list.push({ studentId: x.sid, sessionId: x.ses, mark: mark || null });
    });
    if (!list.length) {
      ui.toast('Only withdrawn students are selected. Select a single withdrawn student’s cell to change it.', { type: 'warn' });
      return;
    }
    var what = mark ? MARK_NAME[mark] : 'cleared';
    var ses = gv.sessions[gv.colIdx[sel.b.ses]];
    var label = list.length === 1 ? 'Attendance ' + (ses ? shortDate(ses.date) : '') + ': ' + what : 'Attendance: ' + list.length + ' cells ' + what;
    var changed = txMarks(label, list.map(function (x) { return { sid: x.studentId, ses: x.sessionId }; }),
      function (c) { return setMarksIn(c, list); });
    if (changed === undefined) return;
    if (list.length > 1 || skipped) {
      ui.toast((list.length === 1 ? '1 cell ' : list.length + ' cells ') + (mark ? 'set to ' + MARK_LONG[mark] : 'cleared') +
        (skipped ? '. ' + plural(skipped, 'withdrawn student') + ' skipped.' : '.'), { type: 'success' });
    }
    if (advance && list.length === 1 && !cells.multiRow && cells.list.length === 1) {
      var r = gv.rowIdx[sel.b.sid];
      if (r !== undefined && r >= gv.rows.length - 1) {
        // The last row: there is no next student. Say so, and keep the next mark key from silently
        // overwriting this mark (a quick typist expects the cursor to have moved on).
        endHold = { sid: sel.b.sid, ses: sel.b.ses };
        ui.toast('That was the last student in the list' + (ses ? ' for ' + sesName(ses) : '') + '.', { type: 'info' });
      } else {
        move(1, 0, false);
      }
    }
  }

  function cycleActive() {
    var course = GT.store.course();
    if (!course || !sel.b) return;
    var rg = range();
    if (rg && (rg.r0 !== rg.r1 || rg.c0 !== rg.c1)) {
      // Space cycles ONE cell; on a range it would give every selected cell the same mark.
      var n = (rg.r1 - rg.r0 + 1) * (rg.c1 - rg.c0 + 1);
      ui.toast('Space changes one cell. To set all ' + n + ' selected cells, type P, A or E (Delete clears them).', { type: 'info' });
      return;
    }
    endHold = null;
    var next = CYCLE[markAt(course, sel.b.sid, sel.b.ses)] || '';
    applyMark(next || null, false);
  }

  function markEveryonePresent(sesId) {
    var course = GT.store.course();
    var ses = findSession(course, sesId);
    if (!ses) return;
    var n = tx('Mark everyone present (' + shortDate(ses.date) + ')', function (c) {
      return mut('markAllPresent')(c, sesId, { activeOnly: true });
    });
    if (n === undefined) return;
    if (!n) ui.toast('Every active student already has a mark for ' + sesName(ses) + '.', { type: 'info' });
    else ui.toast(plural(n, 'student') + ' without a mark set to Present for ' + sesName(ses) + '. Undo with Ctrl+Z.', { type: 'success' });
  }

  function findSession(course, id) {
    var list = sessionsOf(course);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // ------------------------------------------------------------------ menus

  function openCellMenu(pos) {
    var course = GT.store.course();
    if (!course || !sel.b) return;
    var cells = selectedCells();
    var ses = findSession(course, sel.b.ses);
    var s = gv.byId[sel.b.sid];
    var n = cells.list.length;
    var items = [
      // No names here: a menu heading cannot be blurred in privacy mode.
      { heading: n > 1 ? n + ' cells selected' : (s && typeof s.no === 'number' ? 'No ' + s.no + ' · ' : '') + sesName(ses) },
      { label: 'Present', hint: 'P', icon: 'check', onSelect: function () { applyMark('P'); } },
      { label: 'Absent (not allowed)', hint: 'A', icon: 'x', onSelect: function () { applyMark('A'); } },
      { label: 'Excused (allowed)', hint: 'E', icon: 'info', onSelect: function () { applyMark('E'); } },
      { label: 'Clear', hint: 'Del', icon: 'trash', onSelect: function () { applyMark(null); } },
      { separator: true },
      { label: 'Mark everyone without a mark as Present', icon: 'users', onSelect: function () { markEveryonePresent(ses.id); } },
      { label: 'Session options…', icon: 'calendar', onSelect: function () { openSessionMenu(ses.id, headerButton(ses.id)); } }
    ];
    if (s && typeof ui.openStudent === 'function') items.push({ label: 'Student details…', icon: 'user', onSelect: function () { ui.openStudent(s.id); } });
    ui.menu(pos, items, { returnFocus: dom.table });
  }

  function headerButton(sesId) {
    if (!dom || !dom.thead) return null;
    var c = gv.colIdx[sesId];
    var th = c !== undefined && dom.thead.rows[0] ? dom.thead.rows[0].cells[FIRST + c] : null;
    return th ? th.querySelector('.ses-btn') : null;
  }

  function openSessionMenu(sesId, anchor) {
    var course = GT.store.course();
    var ses = findSession(course, sesId);
    if (!ses) return;
    var marks = marksOf(course, sesId);
    var items = [
      { heading: longDate(ses.date) + (ses.label ? ' · ' + ses.label : '') },
      { label: 'Mark everyone without a mark as Present', icon: 'check', onSelect: function () { markEveryonePresent(sesId); } },
      { label: 'Take roll for this session…', icon: 'users', onSelect: function () { openRollCall(sesId); } },
      { label: 'Edit date/label…', icon: 'edit', onSelect: function () { editSession(sesId); } },
      { separator: true },
      { label: 'Clear this session…', icon: 'x', disabled: marks === 0, hint: marks ? plural(marks, 'mark') : 'no marks', onSelect: function () { clearSession(sesId); } },
      { label: 'Delete session…', icon: 'trash', danger: true, onSelect: function () { deleteSession(sesId); } }
    ];
    var pos = anchor && anchor.isConnected ? anchor : { x: 200, y: 200 };
    ui.menu(pos, items, { returnFocus: dom && dom.table ? dom.table : null });
  }

  // ------------------------------------------------------------------ sessions: edit, clear, delete

  /** Checks a session date and label. Returns an error message or null.
   * A second session on the same date is allowed only with a label (e.g. a make-up class). */
  function sessionError(course, date, label, exceptId) {
    if (!util.isIsoDate(date)) return 'Enter a date, for example 2026-09-03.';
    label = cleanLabel(label);
    if (label.length > LABEL_MAX) return 'Keep the label to ' + LABEL_MAX + ' characters or fewer.';
    var same = sessionsOf(course).filter(function (s) { return s.id !== exceptId && s.date === date; });
    if (!same.length) return null;
    if (!label && (exceptId === null || same.some(function (s) { return !cleanLabel(s.label); }))) {
      return 'There is already a session on ' + shortDate(date) + '. Add a label (for example "Make-up class") to keep both.';
    }
    if (same.some(function (s) { return cleanLabel(s.label).toLowerCase() === label.toLowerCase(); })) {
      return 'There is already a session on ' + shortDate(date) + ' with this label. Use a different label.';
    }
    return null;
  }
  function cleanLabel(x) { return str(x).replace(/\s+/g, ' ').trim(); }
  /** Marks a session holds (students of the course, withdrawn included): what clearing or deleting it removes. */
  function marksOf(course, sesId) {
    var n = read('markCount', [course, sesId], null);
    return typeof n === 'number' ? n : (marksPerSession(course)[sesId] || 0);
  }

  function editSession(sesId) {
    var course = GT.store.course();
    var ses = findSession(course, sesId);
    if (!ses) return;
    ui.dialog.form({
      title: 'Edit session',
      introHtml: '<p class="muted">' + esc(longDate(ses.date)) + '. Its marks stay with it when you change the date.</p>',
      confirmText: 'Save',
      fields: [
        { name: 'date', label: 'Date', type: 'date', value: ses.date, required: true },
        { name: 'label', label: 'Label (optional)', value: ses.label || '', placeholder: 'e.g. Test review, Make-up class', help: 'Shown under the date in the grid.' }
      ],
      validate: function (v) { return sessionError(GT.store.course(), String(v.date || '').trim(), String(v.label || '').trim(), sesId); }
    }).then(function (v) {
      if (!v) return;
      var date = String(v.date).trim(), label = String(v.label || '').trim();
      if (date === ses.date && label === (ses.label || '')) return;
      tx('Edit session ' + shortDate(ses.date), function (c) { mut('updateSession')(c, sesId, { date: date, label: label }); });
    });
  }

  function clearSession(sesId) {
    var course = GT.store.course();
    var ses = findSession(course, sesId);
    if (!ses) return Promise.resolve(false);
    var marks = marksOf(course, sesId);
    if (!marks) { ui.toast(sesName(ses) + ' has no marks.', { type: 'info' }); return Promise.resolve(false); }
    return ui.dialog.confirm({
      title: 'Clear ' + sesName(ses) + '?',
      message: 'All ' + plural(marks, 'mark') + ' of this session will be removed. The session stays in the list. You can undo this with Ctrl+Z.',
      confirmText: 'Clear ' + plural(marks, 'mark'), danger: true
    }).then(function (ok) {
      if (!ok) return false;
      tx('Clear session ' + shortDate(ses.date), function (c) { mut('clearSession')(c, sesId); });
      return true;
    });
  }

  function deleteSession(sesId) {
    var course = GT.store.course();
    var ses = findSession(course, sesId);
    if (!ses) return Promise.resolve(false);
    var marks = marksOf(course, sesId);
    return ui.dialog.confirm({
      title: 'Delete the session on ' + sesName(ses) + '?',
      message: marks
        ? plural(marks, 'mark') + ' will be lost: every student’s mark for this session is deleted with it. You can undo this with Ctrl+Z.'
        : 'Nobody has a mark for this session, so no marks will be lost. You can undo this with Ctrl+Z.',
      confirmText: marks ? 'Delete session and ' + plural(marks, 'mark') : 'Delete session', danger: true
    }).then(function (ok) {
      if (!ok) return false;
      tx('Delete session ' + shortDate(ses.date), function (c) { mut('removeSession')(c, sesId); });
      return true;
    });
  }

  // ------------------------------------------------------------------ jump to today

  function jumpToToday(announce) {
    var course = GT.store.course();
    if (!course || !dom || !dom.table || !gv.sessions.length) {
      if (announce) ui.toast('There are no sessions yet. Use Sessions… to add them.', { type: 'info' });
      return;
    }
    var today = todayIso();
    var idx = read('nearestSessionIndex', [course, today], -1);
    var ses = sessionsOf(course)[idx];
    var c = ses ? gv.colIdx[ses.id] : undefined;
    if (c === undefined) return;
    var r = sel.b && gv.rowIdx[sel.b.sid] !== undefined ? gv.rowIdx[sel.b.sid] : 0;
    if (gv.rows.length) {
      sel = { a: null, b: { sid: gv.rows[r].id, ses: ses.id } };
      decorate();
    }
    // Put the session a little right of the name columns, so the previous sessions stay in view.
    var th = dom.thead.rows[0] ? dom.thead.rows[0].cells[FIRST + c] : null;
    if (th) dom.wrap.scrollLeft = Math.max(0, th.offsetLeft - stickyLeftWidth() - 2 * W.ses);
    ensureVisible(activeTd());
    if (announce) {
      focusGrid();
      ui.toast(ses.date === today ? 'Today: ' + sesName(ses) + '.' :
        (ses.date > today ? 'No class today (' + shortDate(today) + '). Next session: ' + sesName(ses) + '.' :
          'The last session was ' + sesName(ses) + '.'), { type: 'info' });
    }
  }

  // ------------------------------------------------------------------ totals-only mode

  function renderTotals(course, cs, p) {
    var att = course.attendance;
    var rows = visibleStudents(course, p);
    dom.count.textContent = countText(course, rows.length, p);
    var held = dom.content.querySelector('[data-f="held"]');
    if (held && document.activeElement !== held && !invalid.held) held.value = String(whole(att.totalsSessionsHeld));
    var heldHelp = dom.content.querySelector('.att-held-help');
    if (heldHelp) {
      var needHeld = whole(att.totalsSessionsHeld) === 0;
      heldHelp.textContent = needHeld ? 'Type how many sessions were held so far: the rates need it.' : 'The rates divide by this number.';
      heldHelp.classList.toggle('is-needed', needHeld);
    }
    restoreInvalid(dom.content.querySelector('.att-totals-bar'));
    var fill = dom.content.querySelector('[data-act="fill-totals"]');
    if (fill) {
      var hasRecords = Object.keys(recordsOf(course)).some(function (sid) { return util.isPlainObject(recordsOf(course)[sid]) && Object.keys(recordsOf(course)[sid]).length; });
      fill.hidden = !hasRecords;
    }
    var thr = thresholdOf(course), tthr = totalThresholdOf(course);
    var byStudent = cs && util.isPlainObject(cs.byStudent) ? cs.byStudent : {};
    var totals = util.isPlainObject(att.totals) ? att.totals : {};
    var heldN = whole(att.totalsSessionsHeld);
    var html = rows.map(function (s) {
      var sm = util.hasOwn(byStudent, s.id) ? byStudent[s.id] : read('summary', [course, s.id], null);
      var t = util.hasOwn(totals, s.id) && util.isPlainObject(totals[s.id]) ? totals[s.id] : {};
      var wd = s.status === 'withdrawn';
      var name = studentName(s);
      var unx = sm ? whole(sm.unexcused) : whole(t.absent), tot = sm ? whole(sm.totalAbsences) : whole(t.absent) + whole(t.excused);
      var over = !wd && sm && sm.overThreshold, overT = !wd && sm && sm.overTotalThreshold; // active students only
      var tooMany = heldN > 0 && tot > heldN;
      return '<tr data-sid="' + esc(s.id) + '"' + (wd ? ' class="row-withdrawn"' : '') + '>' +
        '<td class="num">' + esc(str(s.no)) + '</td>' +
        '<td class="t-name"><span class="pii">' + esc(name) + '</span>' + (wd ? ' <span class="badge wd-badge">Withdrawn</span>' : '') + '</td>' +
        '<td class="t-in">' + countInput('t:absent:' + s.id, t.absent, 'Absent (not allowed, unexcused) for ' + name, over ? 'Above the unexcused-absence threshold (' + thr + ')' : '') + '</td>' +
        '<td class="t-in">' + countInput('t:excused:' + s.id, t.excused, 'Excused (allowed, instructor-approved) for ' + name, '') + '</td>' +
        '<td class="num' + (overT ? ' over' : '') + (tooMany ? ' too-many' : '') + '"' +
          (overT ? ' title="Above the total-absence threshold (' + tthr + ')"' : tooMany ? ' title="More absences than sessions held (' + heldN + ')"' : '') + '>' + tot +
          (tooMany ? ' ' + icon('alert', 'icon-sm') : '') + '</td>' +
        '<td class="num">' + (sm && pct(sm.absenceRate) || '<span class="faint">—</span>') + '</td>' +
        '<td class="num">' + (sm && pct(sm.unexcusedRate) || '<span class="faint">—</span>') + '</td>' +
        '<td class="muted small">n/a in totals mode</td></tr>';
    }).join('') || '<tr><td colspan="8" class="muted">' + (course.students.length ? 'No student matches the search.' : 'No students yet. Add them in Students &amp; Teams.') + '</td></tr>';
    setHtmlKeep(dom.totalsBody, html);
    restoreInvalid(dom.totalsBody);
  }

  function countInput(f, value, label, overTitle) {
    var v = typeof value === 'number' && isFinite(value) ? String(value) : '0';
    return '<input type="text" inputmode="numeric" class="att-num' + (overTitle ? ' over' : '') + '" data-f="' + esc(f) + '" value="' + v + '"' +
      ' aria-label="' + esc(label) + '"' + (overTitle ? ' title="' + esc(overTitle) + '"' : '') + ' autocomplete="off">' +
      '<span class="att-ferr" data-err="' + esc(f) + '" role="alert"></span>';
  }

  function commitTotal(input) {
    var f = input.getAttribute('data-f');
    var parts = f.split(':');
    var field = parts[1], sid = parts.slice(2).join(':');
    var v = util.parseCount(input.value);
    if (v === null) return fieldError(f, input.value, 'Type a whole number, 0 or more.');
    clearFieldError(f);
    var course = GT.store.course();
    var t = course.attendance && util.isPlainObject(course.attendance.totals) && util.hasOwn(course.attendance.totals, sid) ? course.attendance.totals[sid] : {};
    if (whole(t[field]) === v && util.hasOwn(t, field)) { input.value = String(v); return true; }
    var s = model.findStudent(course, sid);
    var patch = {};
    patch[field] = v;
    tx('Absence totals' + (s && typeof s.no === 'number' ? ' (No ' + s.no + ')' : ''), function (c) { mut('setTotals')(c, sid, patch); });
    return true;
  }

  function commitHeld(input) {
    var v = util.parseCount(input.value);
    if (v === null) return fieldError('held', input.value, 'Type a whole number, 0 or more.');
    clearFieldError('held');
    var course = GT.store.course();
    if (whole(course.attendance.totalsSessionsHeld) === v) return true;
    tx('Sessions held (totals)', function (c) {
      var f = coreFn('setSessionsHeld');
      if (f) f.call(GT.attendance, c, v); else c.attendance.totalsSessionsHeld = v;
    });
    return true;
  }

  function fillTotalsFromMarks() {
    var course = GT.store.course();
    var from = read('totalsFromRecords', [course], null);
    if (!from) { ui.toast('The attendance module is not loaded.', { type: 'error' }); return; }
    var hasTotals = Object.keys(course.attendance.totals || {}).some(function (sid) {
      var t = course.attendance.totals[sid];
      return t && (whole(t.absent) || whole(t.excused));
    }) || whole(course.attendance.totalsSessionsHeld) > 0;
    var go = function () {
      var ok = tx('Fill totals from per-session marks', function (c) {
        var f = mut('totalsFromRecords')(c);
        var setTotals = mut('setTotals');
        c.students.forEach(function (s) {
          var t = util.hasOwn(f.totals, s.id) ? f.totals[s.id] : { absent: 0, excused: 0 };
          setTotals(c, s.id, { absent: t.absent, excused: t.excused });
        });
        c.attendance.totalsSessionsHeld = f.held;
        return true;
      });
      if (ok) ui.toast('Totals filled from the per-session marks (' + plural(from.held, 'session') + ' held).', { type: 'success' });
    };
    ui.dialog.confirm({
      title: 'Fill totals from per-session marks?',
      message: 'Each student’s Absent and Excused counts, and "Sessions held so far" (' + from.held + '), are set from the per-session marks.' +
        (hasTotals ? ' The totals typed so far are replaced.' : '') + ' The per-session marks are not changed. You can undo this with Ctrl+Z.',
      confirmText: 'Fill totals', danger: hasTotals
    }).then(function (ok) { if (ok) go(); });
  }

  // ------------------------------------------------------------------ inline field errors

  function fieldError(f, value, msg) {
    invalid[f] = { value: value, msg: msg };
    restoreInvalid(boundEl);
    return false;
  }
  function clearFieldError(f) {
    if (!util.hasOwn(invalid, f)) return;
    delete invalid[f];
    var el = boundEl && boundEl.querySelector('[data-f="' + cssEsc(f) + '"]');
    if (el) { el.classList.remove('is-invalid'); el.removeAttribute('aria-invalid'); }
    var err = boundEl && boundEl.querySelector('[data-err="' + cssEsc(f) + '"]');
    if (err) err.textContent = '';
  }
  /** Shows refused values again (with their message) after a re-render replaced the inputs. */
  function restoreInvalid(scope) {
    if (!scope) return;
    Object.keys(invalid).forEach(function (f) {
      var el = scope.querySelector('[data-f="' + cssEsc(f) + '"]');
      if (!el) return;
      if (el.value !== invalid[f].value) el.value = invalid[f].value;
      el.classList.add('is-invalid');
      el.setAttribute('aria-invalid', 'true');
      var err = scope.querySelector('[data-err="' + cssEsc(f) + '"]');
      if (err) err.textContent = invalid[f].msg;
    });
  }
  function cssEsc(s) {
    return root.CSS && root.CSS.escape ? root.CSS.escape(s) : String(s).replace(/["\\\]\[]/g, '\\$&');
  }

  /** Replaces a region's markup only when it changed; the focused control (matched by data-f or data-act)
   * keeps focus, its caret and any value typed but not saved yet. */
  function setHtmlKeep(host, html, fallback) {
    if (!host || host.__attHtml === html) return;
    var ae = document.activeElement;
    var had = ae && host.contains(ae) ? ae : null;
    var key = had ? (had.getAttribute('data-f') ? '[data-f="' + cssEsc(had.getAttribute('data-f')) + '"]' :
      had.getAttribute('data-act') ? '[data-act="' + cssEsc(had.getAttribute('data-act')) + '"]' + (had.getAttribute('data-sid') ? '[data-sid="' + cssEsc(had.getAttribute('data-sid')) + '"]' : '') : null) : null;
    var typed = had && (had.tagName === 'INPUT' || had.tagName === 'TEXTAREA') && had.type !== 'checkbox' && had.value !== had.defaultValue ? had.value : null;
    var start = null, end = null;
    try { start = had ? had.selectionStart : null; end = had ? had.selectionEnd : null; } catch (e) { start = end = null; }
    host.innerHTML = html;
    host.__attHtml = html;
    if (!had) return;
    var next = key ? host.querySelector(key) : null;
    if (!next) {
      // The focused control is gone (e.g. "Mark confirmed" after confirming): keep keyboard focus nearby
      // instead of letting it drop to the page.
      var first = host.querySelector('input:not([type="hidden"]):not([disabled]), button:not([disabled]), select, textarea');
      if (first) { try { first.focus({ preventScroll: true }); } catch (e4) { first.focus(); } }
      else if (typeof fallback === 'function') fallback();
      else focusModeButton();
      return;
    }
    if (typed !== null) next.value = typed;
    try { next.focus({ preventScroll: true }); } catch (e2) { next.focus(); }
    if (start !== null && typeof next.setSelectionRange === 'function') {
      try { next.setSelectionRange(start, end); } catch (e3) { /* not a text field */ }
    }
  }
  function setHtml(host, html) {
    if (!host || host.__attHtml === html) return;
    host.innerHTML = html;
    host.__attHtml = html;
  }

  // ------------------------------------------------------------------ cards: warnings

  function streakDates(course, sm) {
    var dates = {};
    sessionsOf(course).forEach(function (s) { dates[s.id] = s.date; });
    var d = dropOf(course);
    var list = (Array.isArray(sm.streaks) ? sm.streaks : []).filter(function (st) { return st && whole(st.length) >= d; });
    if (!list.length) list = (Array.isArray(sm.streaks) ? sm.streaks : []).filter(function (st) { return st && whole(st.length) === whole(sm.longestStreak); });
    return list.map(function (st) {
      if (Array.isArray(st.sessionIds) && st.sessionIds.length) {
        return st.sessionIds.map(function (id) { return mdOf(dates[id] || ''); }).filter(Boolean).join(', ');
      }
      return mdOf(st.startDate) + ' – ' + mdOf(st.endDate);
    }).filter(Boolean);
  }

  function firstStreakSession(course, sm) {
    var list = (sm && Array.isArray(sm.streaks) ? sm.streaks : []).filter(function (st) { return st && whole(st.length) === whole(sm.longestStreak); });
    var st = list[0];
    if (st && Array.isArray(st.sessionIds) && st.sessionIds.length) return st.sessionIds[0];
    if (st && st.startDate) {
      var s = sessionsOf(course).filter(function (x) { return x.date === st.startDate; })[0];
      if (s) return s.id;
    }
    return null;
  }

  function warningsCardHtml(course, cs, kind) {
    var warnings = cs && Array.isArray(cs.warnings) ? cs.warnings : [];
    var byStudent = cs && util.isPlainObject(cs.byStudent) ? cs.byStudent : {};
    var groups = [], idx = {};
    warnings.forEach(function (w) {
      if (!w || !w.studentId) return;
      if (!util.hasOwn(idx, w.studentId)) { idx[w.studentId] = groups.length; groups.push({ sid: w.studentId, kinds: [], details: [] }); }
      var g = groups[idx[w.studentId]];
      if (g.kinds.indexOf(w.kind) === -1) g.kinds.push(w.kind);
      if (typeof w.detail === 'string' && w.detail) g.details.push(w.detail);
    });
    var head = '<div class="card-header"><h2>' + icon('alert') + ' Warnings' + (groups.length ? ' <span class="badge badge-warn">' + groups.length + '</span>' : '') + '</h2>' +
      '<span class="muted small">Active students only. Warnings never change grades.</span></div>';
    if (!groups.length) {
      return head + '<div class="card-body"><p class="muted att-no-warn">' + icon('check') + ' No warnings: nobody has ' + dropOf(course) +
        ' absences in a row' + (kind === 'totals' ? ' (n/a in totals mode)' : '') + ' or is above a threshold.</p></div>';
    }
    var thr = thresholdOf(course), tthr = totalThresholdOf(course);
    var items = groups.map(function (g) {
      var s = model.findStudent(course, g.sid);
      if (!s) return '';
      var sm = util.hasOwn(byStudent, g.sid) ? byStudent[g.sid] : read('summary', [course, g.sid], null) || {};
      var chips = [], lines = [];
      g.kinds.forEach(function (k) {
        var n = whole(sm.longestStreak);
        if (k === 'fail') chips.push('<span class="chip danger att-chip">' + n + ' in a row: F per syllabus <span class="att-chip-note">(warning only)</span></span>');
        else if (k === 'drop') chips.push('<span class="chip warn att-chip">' + n + ' in a row: 1 letter drop <span class="att-chip-note">(warning only)</span></span>');
        else if (k === 'threshold') chips.push('<span class="chip warn att-chip">Unexcused above ' + thr + '</span>');
        else if (k === 'total-threshold') chips.push('<span class="chip warn att-chip">Total absences above ' + (tthr === null ? '' : tthr) + '</span>');
      });
      if (g.kinds.indexOf('fail') !== -1 || g.kinds.indexOf('drop') !== -1) {
        var dates = streakDates(course, sm);
        if (dates.length) lines.push('Absences in a row: ' + dates.join('; '));
      }
      lines.push(whole(sm.unexcused) + ' unexcused (not allowed) · ' + whole(sm.excused) + ' excused (allowed) · ' +
        whole(sm.totalAbsences) + ' in total of ' + plural(whole(sm.recorded), 'recorded session'));
      if (!lines.length && g.details.length) lines.push(g.details.join(' · '));
      return '<li class="aw-item" data-sid="' + esc(g.sid) + '">' +
        '<div class="aw-main"><span class="aw-no">No ' + esc(str(s.no)) + '</span> <span class="pii aw-name">' + esc(studentName(s)) + '</span>' +
        '<span class="aw-chips">' + chips.join('') + '</span></div>' +
        '<div class="aw-detail small muted">' + lines.map(esc).join('<br>') + '</div>' +
        '<div class="aw-actions"><button type="button" class="btn btn-sm" data-act="jump" data-sid="' + esc(g.sid) + '">' +
          icon('chevron-right') + (kind === 'totals' ? 'Show in the table' : 'Show in the grid') + '</button>' +
        (typeof ui.openStudent === 'function' ? '<button type="button" class="btn btn-sm btn-ghost" data-act="student" data-sid="' + esc(g.sid) + '">' + icon('user') + 'Details</button>' : '') +
        '</div></li>';
    }).join('');
    return head + '<div class="card-body"><ul class="att-warn-list">' + items + '</ul></div>';
  }

  // ------------------------------------------------------------------ cards: settings

  function settingsCardHtml(course, kind) {
    var a = course.attendance;
    var badge = ui.placeholderBadge ? ui.placeholderBadge(course, 'unexcusedThreshold') : '';
    var confirmed = model.isConfirmed ? model.isConfirmed(course, 'unexcusedThreshold') : true;
    var thr = thresholdOf(course), tthr = totalThresholdOf(course);
    var perSession = kind === 'per-session';
    return '<div class="card-header"><h2>' + icon('settings') + ' Attendance settings</h2><span class="muted small">For ' + esc(course.code || 'this course') + ' only</span></div>' +
      '<div class="card-body att-set">' +
      '<div class="field"><label for="att-thr">Unexcused-absence threshold ' + badge + '</label>' +
        '<div class="att-inline"><input id="att-thr" type="text" inputmode="numeric" class="att-num" data-f="thr" value="' + thr + '" autocomplete="off" aria-describedby="att-thr-help att-thr-err">' +
        '<span class="muted">Highlight students with <strong>more than</strong> this many unexcused (not allowed) absences.</span></div>' +
        '<span class="att-ferr" id="att-thr-err" data-err="thr" role="alert"></span>' +
        '<div class="help" id="att-thr-help">' + (course.template === 'SE4351' || course.template === 'SE6362'
          ? 'The syllabus mentions a threshold but does not state it' : 'No threshold is on file for this course') +
        (confirmed ? '.' : ', so this number needs confirmation.') +
        (!confirmed ? ' <button type="button" class="btn btn-sm btn-ghost att-confirm" data-act="confirm-thr">' + icon('check') + 'Mark confirmed</button>' : '') + '</div></div>' +
      '<div class="field"><label for="att-tthr">Total-absence threshold <span class="muted">(optional)</span> ' + badge + '</label>' +
        '<div class="att-inline"><input id="att-tthr" type="text" inputmode="numeric" class="att-num" data-f="tthr" value="' + (tthr === null ? '' : tthr) + '" placeholder="off" autocomplete="off" aria-describedby="att-tthr-help att-tthr-err">' +
        '<span class="muted">Highlight students with more than this many absences in total (allowed + not allowed).</span></div>' +
        '<span class="att-ferr" id="att-tthr-err" data-err="tthr" role="alert"></span>' +
        '<div class="help" id="att-tthr-help">Leave it empty to turn it off (the default). The syllabus says total absences should not exceed "a certain threshold" without giving the number.</div></div>' +
      '<div class="field"><label class="check"><input type="checkbox" data-f="excstreak"' + (a.excusedCountsTowardStreak ? ' checked' : '') + ' aria-describedby="att-exc-help"> ' +
        'Excused absences count toward a streak</label>' +
        '<div class="help" id="att-exc-help">Off by default, because you chose it: allowed (excused, instructor-approved) absences should not count against the student, ' +
        'so only unexcused absences make a streak and an excused absence breaks it. The original request counted every absence; tick this to count excused ones too.' +
        (perSession ? '' : ' Streaks are used in per-session mode only.') + '</div></div>' +
      '<fieldset class="field att-rule"><legend>Consecutive-absence rule <span class="muted">(from the syllabus)</span></legend>' +
        '<div class="att-inline att-rule-row"><label for="att-drop">One letter grade drop at</label>' +
        '<input id="att-drop" type="text" inputmode="numeric" class="att-num" data-f="drop" value="' + dropOf(course) + '" autocomplete="off" aria-describedby="att-rule-help att-drop-err">' +
        '<span>in a row</span><span class="att-rule-sep" aria-hidden="true">·</span><label for="att-fail">F at</label>' +
        '<input id="att-fail" type="text" inputmode="numeric" class="att-num" data-f="fail" value="' + failOf(course) + '" autocomplete="off" aria-describedby="att-rule-help att-drop-err">' +
        '<span>in a row</span></div>' +
        '<span class="att-ferr" id="att-drop-err" data-err="drop" role="alert"></span>' +
        '<div class="help" id="att-rule-help">The F number must be larger than the drop number, and the drop number at least 2 (the syllabus: 3 and 4).' +
        (perSession ? '' : ' Used in per-session mode only.') + '</div></fieldset>' +
      '<div class="callout att-policy">' +
        '<p><strong>Warnings never change grades.</strong> The attendance policy has exceptions (for example medical or family reasons), so the instructor decides; ' +
        'the app only shows the warning.</p>' +
        '<p><strong>Attendance does not feed Class/Project Participation.</strong> Participation is entered by hand in the Grades tab.</p></div>' +
      '</div>';
  }

  function commitSetting(input) {
    var f = input.getAttribute('data-f');
    var course = GT.store.course();
    if (!course) return;
    var a = course.attendance;
    if (f === 'thr') {
      var v = util.parseCount(input.value);
      if (v === null) return fieldError('thr', input.value, 'Type a whole number, 0 or more (for example 3).');
      clearFieldError('thr');
      if (v !== a.unexcusedThreshold) tx('Unexcused-absence threshold', function (c) { c.attendance.unexcusedThreshold = v; });
    } else if (f === 'tthr') {
      var raw = input.value.trim();
      var t = raw === '' ? null : util.parseCount(raw);
      if (raw !== '' && t === null) return fieldError('tthr', input.value, 'Type a whole number, 0 or more, or leave it empty to turn it off.');
      clearFieldError('tthr');
      if (t !== totalThresholdOf(course) || (t === null && a.totalAbsenceThreshold !== null && a.totalAbsenceThreshold !== undefined)) {
        tx('Total-absence threshold', function (c) { c.attendance.totalAbsenceThreshold = t; });
      }
    } else if (f === 'drop' || f === 'fail') {
      var dEl = boundEl.querySelector('[data-f="drop"]'), fEl = boundEl.querySelector('[data-f="fail"]');
      var d = util.parseCount(dEl ? dEl.value : ''), fl = util.parseCount(fEl ? fEl.value : '');
      var msg = null;
      if (d === null || fl === null) msg = 'Type whole numbers (the syllabus: drop at 3, F at 4).';
      else if (d < 2) msg = 'The drop number must be at least 2.';
      else if (fl <= d) msg = 'The F number must be larger than the drop number (for example drop at 3, F at 4).';
      else if (fl > 1000) msg = 'That is more sessions than a semester has.';
      if (msg) {
        invalid.drop = { value: dEl ? dEl.value : '', msg: msg };
        invalid.fail = { value: fEl ? fEl.value : '', msg: '' };
        restoreInvalid(boundEl);
        return;
      }
      clearFieldError('drop');
      clearFieldError('fail');
      if (d !== dropOf(course) || fl !== failOf(course)) {
        tx('Consecutive-absence rule', function (c) { c.attendance.dropStreak = d; c.attendance.failStreak = fl; });
      }
    } else if (f === 'excstreak') {
      var on = !!input.checked;
      if (on !== !!a.excusedCountsTowardStreak) tx('Excused absences count toward a streak: ' + (on ? 'yes' : 'no'), function (c) { c.attendance.excusedCountsTowardStreak = on; });
    }
  }

  function confirmThreshold() {
    var course = GT.store.course();
    var info = course && model.placeholderInfo ? model.placeholderInfo(course, 'unexcusedThreshold') : null;
    if (!info) return;
    tx('Mark confirmed: ' + info.label, function (c) {
      if (!util.isPlainObject(c.placeholders)) c.placeholders = {};
      c.placeholders.unexcusedThreshold = { confirmed: true, confirmedAt: util.nowIso() };
    });
    ui.toast(info.label + ' marked confirmed.', { type: 'success' });
  }

  // ------------------------------------------------------------------ mode

  function setMode(m) {
    var course = GT.store.course();
    if (!course || model.ATTENDANCE_MODES && model.ATTENDANCE_MODES.indexOf(m) === -1) return;
    if (modeOf(course) === m) return;
    var ok = tx('Attendance mode: ' + MODE_LABEL[m], function (c) {
      var f = coreFn('setMode');
      if (f) f.call(GT.attendance, c, m); else c.attendance.mode = m;
      return true;
    });
    if (!ok) return;
    if (m === 'off') ui.toast('Attendance is off for ' + (course.code || 'this course') + '. Marks and totals are kept; turn it back on at any time.', { type: 'info' });
    else ui.toast('Attendance: ' + MODE_LABEL[m] + '.', { type: 'success' });
  }

  // ------------------------------------------------------------------ params (navigate from other views)

  function gotoCard(which) {
    var card = boundEl && boundEl.querySelector('[data-card="' + which + '"]');
    if (!card) return;
    card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    flash(card);
  }

  function flash(el) {
    if (!el) return;
    el.classList.remove('att-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('att-flash');
    setTimeout(function () { el.classList.remove('att-flash'); }, 1700);
  }

  function jumpToStudent(sid) {
    var course = GT.store.course();
    if (!course || !boundEl) return;
    var s = model.findStudent(course, sid);
    if (!s) return;
    var p = getPrefs();
    var hidden = (s.status === 'withdrawn' && !p.showWithdrawn);
    if (searchText && visibleStudents(course, p).indexOf(s) === -1) {
      searchText = '';
      if (dom.search) dom.search.value = '';
      markDirty();
    }
    if (hidden) { setPrefs({ showWithdrawn: true }); }
    if (dataDirty) { dataDirty = false; updateContent(course, contentKind); }
    if (contentKind === 'totals') {
      var inp = dom.totalsBody && dom.totalsBody.querySelector('tr[data-sid="' + cssEsc(sid) + '"] input');
      if (inp) {
        inp.closest('tr').scrollIntoView({ block: 'center' });
        flash(inp.closest('tr'));
        inp.focus({ preventScroll: true });
        inp.select();
      }
      return;
    }
    if (!dom.table || gv.rowIdx[sid] === undefined) return;
    var cs = read('summary', [course, sid], null);
    var sesId = firstStreakSession(course, cs) || (sel.b ? sel.b.ses : null);
    var c = sesId && gv.colIdx[sesId] !== undefined ? gv.colIdx[sesId] : defaultCol();
    var r = gv.rowIdx[sid];
    dom.wrap.scrollIntoView({ block: 'start', behavior: 'auto' });
    setActive(r, c, false);
    var td = activeTd();
    if (td) {
      var th = dom.thead.rows[0].cells[FIRST + c];
      if (th) dom.wrap.scrollLeft = Math.max(0, th.offsetLeft - stickyLeftWidth() - W.ses);
      ensureVisible(td);
    }
    flash(dom.tbody.rows[r]);
    focusGrid();
  }

  // ------------------------------------------------------------------ events

  function onClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (b && boundEl.contains(b)) {
      var act = b.getAttribute('data-act');
      switch (act) {
        case 'mode': setMode(b.getAttribute('data-mode')); return;
        case 'turn-on': setMode(b.getAttribute('data-mode')); return;
        case 'withdrawn': setPrefs({ showWithdrawn: !getPrefs().showWithdrawn }); return;
        case 'summary-cols': setPrefs({ summary: !getPrefs().summary }); return;
        case 'today': jumpToToday(true); return;
        case 'roll': openRollCall(null); return;
        case 'sessions': openSessions({}); return;
        case 'sessions-gen': openSessions({ generate: true }); return;
        case 'goto-students': if (GT.app && GT.app.navigate) GT.app.navigate('students'); return;
        case 'goto-warnings': gotoCard('warnings'); return;
        case 'to-totals': showTotals(); return;
        case 'ses-menu': e.preventDefault(); openSessionMenu(b.getAttribute('data-ses'), b); return;
        case 'jump': jumpToStudent(b.getAttribute('data-sid')); return;
        case 'student': if (typeof ui.openStudent === 'function') ui.openStudent(b.getAttribute('data-sid')); return;
        case 'confirm-thr': confirmThreshold(); return;
        case 'fill-totals': fillTotalsFromMarks(); return;
        default: return;
      }
    }
    var cell = cellFromEvent(e);
    if (cell && cell.isMark && armedCycle && !e.shiftKey &&
      armedCycle.sid === gv.rows[cell.r].id && armedCycle.ses === gv.sessions[cell.c].id) {
      armedCycle = null;
      cycleActive();
    }
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    var cell = cellFromEvent(e);
    if (!cell) return;
    if (!cell.isMark) {
      // A name cell: select that row in the current (or today's) column.
      if (!gv.sessions.length) return;
      var c = sel.b && gv.colIdx[sel.b.ses] !== undefined ? gv.colIdx[sel.b.ses] : defaultCol();
      e.preventDefault();
      setActive(cell.r, c, e.shiftKey);
      focusGrid();
      return;
    }
    e.preventDefault();
    var single = !sel.a || (sel.a.sid === sel.b.sid && sel.a.ses === sel.b.ses);
    var wasActive = !!sel.b && single && gv.rows[cell.r].id === sel.b.sid && gv.sessions[cell.c].id === sel.b.ses;
    if (e.shiftKey && sel.b) {
      setActive(cell.r, cell.c, true);
      armedCycle = null;
    } else {
      setActive(cell.r, cell.c, false);
      armedCycle = wasActive ? { sid: gv.rows[cell.r].id, ses: gv.sessions[cell.c].id } : null;
      drag = { moved: false };
    }
    focusGrid();
  }

  function onMouseOver(e) {
    if (!drag || !(e.buttons & 1)) { if (drag && !(e.buttons & 1)) drag = null; return; }
    var cell = cellFromEvent(e);
    if (!cell || !cell.isMark) return;
    var cur = sel.b ? { r: gv.rowIdx[sel.b.sid], c: gv.colIdx[sel.b.ses] } : null;
    if (cur && cur.r === cell.r && cur.c === cell.c) return;
    drag.moved = true;
    armedCycle = null;
    if (!sel.a) sel.a = sel.b;
    sel.b = { sid: gv.rows[cell.r].id, ses: gv.sessions[cell.c].id };
    decorate();
  }

  function onContextMenu(e) {
    var cell = cellFromEvent(e);
    if (!cell || !cell.isMark) return;
    e.preventDefault();
    var rg = range();
    var inside = rg && cell.r >= rg.r0 && cell.r <= rg.r1 && cell.c >= rg.c0 && cell.c <= rg.c1;
    if (!inside) setActive(cell.r, cell.c, false);
    focusGrid();
    openCellMenu({ x: e.clientX, y: e.clientY });
  }

  function onFocusIn(e) {
    // Focusing the grid with Tab (no selection yet) selects today's session in the first row.
    if (dom && dom.table && e.target === dom.table && !sel.b && gv.rows.length && gv.sessions.length) {
      setActive(0, defaultCol(), false);
    }
  }

  function onInput(e) {
    var t = e.target;
    if (t.classList.contains('att-search')) {
      searchText = t.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = null;
        markDirty();
        if (GT.app && GT.app.render) GT.app.render();
      }, 120);
      return;
    }
    var f = t.getAttribute && t.getAttribute('data-f');
    if (f && util.hasOwn(invalid, f) && t.type !== 'checkbox') {
      // Typing again hides the old message until the value is committed again.
      var err = boundEl.querySelector('[data-err="' + cssEsc(f) + '"]');
      if (err) err.textContent = '';
      t.classList.remove('is-invalid');
      t.removeAttribute('aria-invalid');
      invalid[f].value = t.value;
    }
  }

  function onChange(e) {
    var t = e.target;
    var f = t.getAttribute && t.getAttribute('data-f');
    if (!f || f === 'search') return;
    if (f === 'held') commitHeld(t);
    else if (f.indexOf('t:') === 0) commitTotal(t);
    else commitSetting(t);
  }

  function onKeyDown(e) {
    var t = e.target;
    if (dom && dom.table && t === dom.table) { gridKey(e); return; }
    var f = t.getAttribute && t.getAttribute('data-f');
    if (!f) return;
    if (f === 'search') {
      if (e.key === 'Escape' && t.value) { e.preventDefault(); t.value = ''; searchText = ''; markDirty(); if (GT.app && GT.app.render) GT.app.render(); }
      else if (e.key === 'Enter' || e.key === 'ArrowDown') {
        if (dom.table && gv.rows.length) { e.preventDefault(); if (!sel.b) setActive(0, defaultCol(), false); focusGrid(); }
      }
      return;
    }
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (t.type === 'checkbox') return;
    if (f.indexOf('t:') === 0) {
      // Totals table: commit, then go to the same field of the next (or previous) student.
      e.preventDefault();
      var ok = commitTotal(t);
      if (ok === false) return;
      var field = f.split(':')[1];
      var tr = t.closest('tr');
      var dest = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? tr.previousElementSibling : tr.nextElementSibling;
      var sid = dest ? dest.getAttribute('data-sid') : null;
      if (!sid) return;
      var key = '[data-f="' + cssEsc('t:' + field + ':' + sid) + '"]';
      // The change re-renders the table on the next frame: focus the new input after that.
      var go = function () {
        var el = dom.totalsBody && dom.totalsBody.querySelector(key);
        if (el) { el.focus(); el.select(); }
      };
      go();
      setTimeout(go, 40);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (f === 'held') commitHeld(t);
      else commitSetting(t);
    }
  }

  function gridKey(e) {
    var k = e.key;
    var mod = e.ctrlKey || e.metaKey;
    if (!gv.rows.length || !gv.sessions.length) return;
    if (!sel.b && /^(Arrow|Home|End|Page|Enter|Tab| )/.test(k)) {
      if (k !== 'Tab') { e.preventDefault(); setActive(0, defaultCol(), false); }
      return;
    }
    var rg = range();
    var r = rg ? rg.ar : 0, c = rg ? rg.ac : 0;
    var lastR = gv.rows.length - 1, lastC = gv.sessions.length - 1;
    switch (k) {
      case 'ArrowUp': e.preventDefault(); setActive(mod ? 0 : r - 1, c, e.shiftKey); return;
      case 'ArrowDown': e.preventDefault(); setActive(mod ? lastR : r + 1, c, e.shiftKey); return;
      case 'ArrowLeft': e.preventDefault(); setActive(r, mod ? 0 : c - 1, e.shiftKey); return;
      case 'ArrowRight': e.preventDefault(); setActive(r, mod ? lastC : c + 1, e.shiftKey); return;
      case 'Home': e.preventDefault(); setActive(mod ? 0 : r, 0, e.shiftKey); return;
      case 'End': e.preventDefault(); setActive(mod ? lastR : r, lastC, e.shiftKey); return;
      case 'PageUp': e.preventDefault(); setActive(r - 10, c, e.shiftKey); return;
      case 'PageDown': e.preventDefault(); setActive(r + 10, c, e.shiftKey); return;
      case 'Enter': e.preventDefault(); setActive(e.shiftKey ? r - 1 : r + 1, c, false); return;
      case 'Tab':
        if ((e.shiftKey && c === 0) || (!e.shiftKey && c === lastC)) return; // leave the grid
        e.preventDefault();
        setActive(r, e.shiftKey ? c - 1 : c + 1, false);
        return;
      case 'Escape':
        if (sel.a) { e.preventDefault(); sel.a = null; decorate(); }
        return;
      case 'Delete': case 'Backspace': e.preventDefault(); applyMark(null, false); return;
      case ' ': case 'Spacebar': e.preventDefault(); cycleActive(); return;
      case 'ContextMenu': e.preventDefault(); openCellMenuAtActive(); return;
      case 'F10': if (e.shiftKey) { e.preventDefault(); openCellMenuAtActive(); } return;
      default: break;
    }
    if (mod || e.altKey) return;
    var up = markKey(e);
    if (up) {
      e.preventDefault();
      var many = rg && (rg.r0 !== rg.r1 || rg.c0 !== rg.c1);
      if (!many && endHold && sel.b && endHold.sid === sel.b.sid && endHold.ses === sel.b.ses) {
        ui.toast('End of the list: this key was ignored, so the last student’s mark is not overwritten by accident. To change it, press Space or right-click the cell.', { type: 'info' });
        return;
      }
      applyMark(up, !many);
    }
  }

  function openCellMenuAtActive() {
    var td = activeTd();
    if (!td) return;
    ensureVisible(td);
    var r = td.getBoundingClientRect();
    openCellMenu({ x: r.left, y: r.bottom + 2 });
  }

  // ------------------------------------------------------------------ session manager (dialog)

  function openSessions(o) {
    var course = GT.store.course();
    if (!course) return;
    var courseId = course.id;
    var tpl = model.FALL_2026_TR || FALL_TR;
    var body = document.createElement('div');
    body.className = 'sm';
    body.innerHTML =
      '<p class="muted sm-intro">Class meetings in date order. A session counts once somebody has a mark in it; sessions nobody marked yet are ignored in every count. ' +
      'Deleting a session deletes its marks.</p>' +
      '<div class="sm-list-host"></div>' +
      '<section class="sm-add" aria-labelledby="sm-add-h"><h3 id="sm-add-h">Add a session</h3>' +
        '<div class="field-row"><div class="field"><label for="sm-date">Date</label><input type="date" id="sm-date" data-sm-input="add"></div>' +
        '<div class="field sm-label-field"><label for="sm-label">Label <span class="muted">(optional)</span></label><input type="text" id="sm-label" maxlength="' + LABEL_MAX + '" placeholder="e.g. Make-up class" data-sm-input="add" autocomplete="off"></div>' +
        '<button type="button" class="btn" data-sm="add">' + icon('plus') + 'Add session</button></div>' +
        '<div class="sm-err" data-sm-err="add" role="alert"></div></section>' +
      '<section class="sm-gen" aria-labelledby="sm-gen-h"><div class="sm-gen-head"><h3 id="sm-gen-h">Generate sessions</h3>' +
        '<button type="button" class="btn btn-sm" data-sm="gen-toggle" aria-expanded="false" aria-controls="sm-gen-body">' + icon('calendar') + 'Generate…</button></div>' +
        '<div id="sm-gen-body" class="sm-gen-body" hidden>' +
          '<p class="help">Adds every chosen weekday between the two dates. Sessions already in the list, and their marks, are always kept: only missing dates are added.</p>' +
          '<div class="field-row"><div class="field"><label for="sm-g-start">First day</label><input type="date" id="sm-g-start" data-sm-gen value="' + esc(tpl.start) + '"></div>' +
          '<div class="field"><label for="sm-g-end">Last day</label><input type="date" id="sm-g-end" data-sm-gen value="' + esc(tpl.end) + '"></div></div>' +
          '<fieldset class="sm-days"><legend>Weekdays</legend>' + WEEKDAYS.map(function (d) {
            return '<label class="check"><input type="checkbox" data-sm-gen data-day="' + d[0] + '"' + ((tpl.weekdays || []).indexOf(d[0]) !== -1 ? ' checked' : '') + '> ' + d[1] + '</label>';
          }).join('') + '</fieldset>' +
          '<div class="field"><label for="sm-g-ex">Skip these dates (holidays)</label>' +
          '<textarea id="sm-g-ex" rows="2" data-sm-gen spellcheck="false">' + esc((tpl.exclude || []).join(', ')) + '</textarea>' +
          '<div class="help">One date per line or separated by commas, written like 2026-11-26.</div></div>' +
          '<div class="sm-g-preview" aria-live="polite"></div>' +
          '<div class="sm-err" data-sm-err="gen" role="alert"></div>' +
          '<button type="button" class="btn btn-primary" data-sm="gen">' + icon('plus') + 'Add these sessions</button>' +
        '</div></section>';

    var listHost = body.querySelector('.sm-list-host');
    var unsubscribe = null;

    function cur() {
      var c = GT.store.course();
      return c && c.id === courseId ? c : null;
    }

    function renderList() {
      var c = cur();
      if (!c) { listHost.innerHTML = '<p class="muted">This course is no longer open.</p>'; return; }
      var list = sessionsOf(c);
      var marks = marksPerSession(c);
      var heldN = list.filter(function (s) { return marks[s.id]; }).length;
      var today = todayIso();
      if (!list.length) {
        var lost = document.activeElement && listHost.contains(document.activeElement);
        listHost.innerHTML = '<p class="sm-empty muted">' + icon('calendar') + ' No sessions yet. Add one below, or use <strong>Generate</strong> to fill the semester.</p>';
        if (lost) focusAddDate();
        return;
      }
      // The focused list button (a nested confirm or edit dialog gives focus back to it before this runs).
      var ae = document.activeElement;
      var focusKey = ae && listHost.contains(ae) ? ae.getAttribute('data-sm') + '|' + ae.getAttribute('data-id') : null;
      var focusRow = focusKey && ae.closest && ae.closest('tr') ? ae.closest('tr').sectionRowIndex : -1;
      listHost.innerHTML = '<div class="sm-summary">' + plural(list.length, 'session') + ' · ' + heldN + ' held (with marks)</div>' +
        // On a phone the # and Day columns hide (the weekday moves into the date), so both buttons fit.
        '<div class="table-wrap sm-table-wrap"><table class="table sm-table"><thead><tr><th scope="col" class="num sm-c-no">#</th><th scope="col">Date</th><th scope="col" class="sm-c-day">Day</th>' +
        '<th scope="col">Label</th><th scope="col" class="num">Marks</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        list.map(function (s, i) {
          var n = marks[s.id] || 0;
          var nm = sesName(s);
          return '<tr data-id="' + esc(s.id) + '"' + (s.date === today ? ' class="sm-today"' : '') + '><td class="num sm-c-no">' + (i + 1) + '</td>' +
            '<td class="nowrap"><span class="sm-wd">' + esc(wdOf(s.date)) + ' </span>' + esc(mdOf(s.date)) + '<span class="sm-yr">, ' + esc(str(s.date).slice(0, 4)) + '</span>' +
              (s.date === today ? ' <span class="badge badge-accent">today</span>' : '') + '</td>' +
            '<td class="sm-c-day">' + esc(wdOf(s.date)) + '</td><td class="sm-c-label">' + (s.label ? esc(s.label) : '<span class="faint">—</span>') + '</td>' +
            '<td class="num">' + (n ? n : '<span class="faint" title="Not held yet">0</span>') + '</td>' +
            '<td class="sm-actions">' +
              '<button type="button" class="btn btn-sm btn-ghost btn-icon" data-sm="edit" data-id="' + esc(s.id) + '" aria-label="' + esc('Edit ' + nm) + '" title="Edit date or label">' + icon('edit') + '</button>' +
              '<button type="button" class="btn btn-sm btn-ghost btn-icon sm-del" data-sm="del" data-id="' + esc(s.id) + '" aria-label="' + esc('Delete ' + nm) + '" title="Delete session">' + icon('trash') + '</button>' +
            '</td></tr>';
        }).join('') + '</tbody></table></div>';
      if (focusKey) {
        var parts = focusKey.split('|');
        var el = listHost.querySelector('[data-sm="' + cssEsc(parts[0]) + '"][data-id="' + cssEsc(parts[1]) + '"]');
        if (!el && focusRow >= 0) {
          // That session was deleted: the same button on the row that took its place (or the one above),
          // so keyboard focus stays in the list instead of dropping to the page.
          var trs = listHost.querySelectorAll('.sm-table tbody tr');
          var tr = trs[Math.min(focusRow, trs.length - 1)];
          el = tr ? tr.querySelector('[data-sm="' + cssEsc(parts[0]) + '"]') : null;
        }
        if (el) el.focus();
        else focusAddDate();
      }
    }

    function focusAddDate() {
      var d = body.querySelector('#sm-date');
      if (d && body.isConnected) d.focus();
    }

    function genInput() {
      var start = body.querySelector('#sm-g-start').value.trim();
      var end = body.querySelector('#sm-g-end').value.trim();
      var weekdays = ui.$$('[data-day]', body).filter(function (x) { return x.checked; }).map(function (x) { return parseInt(x.getAttribute('data-day'), 10); });
      var tokens = body.querySelector('#sm-g-ex').value.split(/[\s,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      var bad = tokens.filter(function (x) { return !util.isIsoDate(x); });
      var err = null;
      if (!util.isIsoDate(start)) err = 'Choose the first day.';
      else if (!util.isIsoDate(end)) err = 'Choose the last day.';
      else if (end < start) err = 'The last day is before the first day.';
      else if (util.daysBetween(start, end) > 800) err = 'Choose a range of two years or less.';
      else if (!weekdays.length) err = 'Tick at least one weekday.';
      else if (bad.length) err = 'Not a date: ' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? ', …' : '') + '. Write dates like 2026-11-26.';
      return { start: start, end: end, weekdays: weekdays, exclude: tokens.filter(util.isIsoDate), error: err };
    }

    /** Generated sessions merged into the course's list (existing sessions and ids always kept). */
    function generated(c, g) {
      var existing = sessionsOf(c);
      // mergeSessions keeps every existing session, gives a generated one a free id when its id is taken,
      // and never reuses an id that marks still carry (pass the course): marks whose session was lost
      // (a restored file) must not reappear on a new session and count as absences.
      var gen = model.generateSessions({ start: g.start, end: g.end, weekdays: g.weekdays, exclude: g.exclude });
      var merged = read('mergeSessions', [existing, gen, c], null);
      return { gen: gen, merged: merged };
    }

    function preview() {
      var c = cur();
      var out = body.querySelector('.sm-g-preview');
      var errEl = body.querySelector('[data-sm-err="gen"]');
      var btn = body.querySelector('[data-sm="gen"]');
      var g = genInput();
      errEl.textContent = g.error || '';
      if (g.error || !c) { out.textContent = ''; btn.disabled = true; return null; }
      var r = generated(c, g);
      if (!r.merged) { out.textContent = ''; errEl.textContent = 'The attendance module is not loaded, so sessions cannot be generated.'; btn.disabled = true; return null; }
      var added = r.merged.length - sessionsOf(c).length;
      var already = r.gen.length - added;
      out.innerHTML = added
        ? icon('info') + ' Adds <strong>' + plural(added, 'new session') + '</strong>' + (already ? ' (' + plural(already, 'date') + ' already in the list stay as they are)' : '') +
          '. Result: ' + plural(r.merged.length, 'session') + '.'
        : icon('check') + ' Every date is already in the list: nothing to add.';
      btn.disabled = !added;
      return added ? g : null;
    }

    function addOne() {
      var c = cur();
      if (!c) return;
      var dateEl = body.querySelector('#sm-date'), labelEl = body.querySelector('#sm-label');
      var errEl = body.querySelector('[data-sm-err="add"]');
      var date = dateEl.value.trim(), label = labelEl.value.trim();
      var err = sessionError(c, date, label, null);
      if (err) { errEl.textContent = err; dateEl.focus(); return; }
      errEl.textContent = '';
      var ok = tx('Add session ' + shortDate(date), function (cc) { return mut('addSession')(cc, { date: date, label: label }) || true; }, { courseId: courseId });
      if (ok === undefined) return;
      ui.toast('Session added: ' + shortDate(date) + (label ? ' (' + label + ')' : '') + '.', { type: 'success' });
      dateEl.value = '';
      labelEl.value = '';
      dateEl.focus();
    }

    function generate() {
      var g = preview();
      if (!g) return;
      var added = 0;
      var ok = tx('Generate sessions', function (c) {
        var before = sessionsOf(c).length;
        var r = generated(c, g);
        if (!r.merged) throw new Error('The attendance module is not loaded.');
        c.attendance.sessions = r.merged;
        added = r.merged.length - before;
        return true;
      }, { courseId: courseId });
      if (ok === undefined) return;
      ui.toast(plural(added, 'session') + ' added. Existing sessions and marks were kept.', { type: 'success' });
      preview();
    }

    return ui.dialog.open({
      title: 'Class sessions · ' + (course.code || ''),
      body: body,
      wide: true,
      buttons: [{ text: 'Done', value: true, primary: true }],
      initialFocus: o && o.generate ? '[data-sm="gen"]' : '#sm-date',
      onMount: function (dlg) {
        renderList();
        unsubscribe = GT.store.subscribe(function (info) {
          if (info && (info.type === 'saved' || info.type === 'ui' || info.type === 'annotate')) return;
          if (!dlg.isConnected) return;
          renderList();
          if (!body.querySelector('#sm-gen-body').hidden) preview();
        });
        var toggle = body.querySelector('[data-sm="gen-toggle"]');
        var genBody = body.querySelector('#sm-gen-body');
        function openGen(open) {
          genBody.hidden = !open;
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          toggle.lastChild.textContent = open ? 'Hide' : 'Generate…';
          if (open) {
            preview();
            if (genBody.scrollIntoView) genBody.scrollIntoView({ block: 'nearest' });
          }
        }
        if (o && o.generate) {
          openGen(true);
          setTimeout(function () { var b = body.querySelector('#sm-g-start'); if (b) b.focus(); }, 0);
        }
        body.addEventListener('click', function (e) {
          var b = e.target.closest ? e.target.closest('[data-sm]') : null;
          if (!b) return;
          var act = b.getAttribute('data-sm'), id = b.getAttribute('data-id');
          if (act === 'add') addOne();
          else if (act === 'gen-toggle') openGen(genBody.hidden);
          else if (act === 'gen') generate();
          else if (act === 'edit') editSession(id);
          else if (act === 'del') deleteSession(id);
        });
        body.addEventListener('input', function (e) {
          if (e.target.hasAttribute('data-sm-gen')) preview();
          if (e.target.getAttribute('data-sm-input') === 'add') body.querySelector('[data-sm-err="add"]').textContent = '';
        });
        body.addEventListener('change', function (e) { if (e.target.hasAttribute('data-sm-gen')) preview(); });
        // Ctrl+Z / Ctrl+Y work here too (the page shortcuts are off while a dialog is open), so the
        // "You can undo this with Ctrl+Z" of a delete is true without closing this window first.
        dlg.addEventListener('keydown', function (e) {
          var t = e.target;
          // A text field with text in it keeps its own undo; an empty field or a date picker has none.
          var fieldUndo = ui.isTypingTarget(t) && t.type !== 'date' && t.type !== 'checkbox' && t.value !== '';
          if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented || fieldUndo) return;
          var k = String(e.key || '').toLowerCase();
          var redo = (k === 'z' && e.shiftKey) || k === 'y';
          if (k !== 'z' && !redo) return;
          e.preventDefault();
          if (!cur()) return;
          var label = redo ? GT.store.redoLabel() : GT.store.undoLabel();
          var ok = redo ? GT.store.redo() : GT.store.undo();
          ui.toast(ok ? (redo ? 'Redone: ' : 'Undone: ') + label + '.' : (redo ? 'Nothing to redo.' : 'Nothing to undo.'), { type: ok ? 'success' : 'info' });
        });
        body.addEventListener('keydown', function (e) {
          // Enter in the add row adds the session (instead of closing the dialog).
          if (e.key === 'Enter' && e.target.getAttribute('data-sm-input') === 'add') {
            e.preventDefault();
            e.stopPropagation();
            addOne();
          } else if (e.key === 'Enter' && e.target.hasAttribute('data-sm-gen') && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
            e.preventDefault();
            e.stopPropagation();
            generate();
          }
        });
      }
    }).then(function () {
      if (unsubscribe) unsubscribe();
    });
  }

  // ------------------------------------------------------------------ roll call (dialog)

  function openRollCall(sesId) {
    var course = GT.store.course();
    if (!course) return;
    if (!coreFn('setMarks') && !coreFn('setMark')) { ui.toast('The attendance module is not loaded.', { type: 'error' }); return; }
    var courseId = course.id;
    var sessions = sessionsOf(course);
    if (!sessions.length) {
      ui.toast('There are no sessions yet. Add them first.', { type: 'info' });
      openSessions({ generate: true });
      return;
    }
    var students = course.students.filter(function (s) { return s.status !== 'withdrawn'; }).sort(byName);
    if (!students.length) { ui.toast('There are no active students in this course yet.', { type: 'info' }); return; }
    var idx = read('nearestSessionIndex', [course, todayIso()], 0);
    var ses = (sesId && findSession(course, sesId)) || sessions[idx] || sessions[0];
    var current = 0;
    var dlgEl = null;

    var body = document.createElement('div');
    body.className = 'rc';
    function optionText(c, s) {
      var cnt = read('sessionCounts', [c, s.id], null);
      var n = cnt ? whole(cnt.present) + whole(cnt.absent) + whole(cnt.excused) : 0;
      return longDate(s.date) + (s.label ? ' · ' + s.label : '') + (n ? ' (' + n + ' of ' + students.length + ' marked)' : '');
    }
    function sessionOptions() {
      var c = GT.store.course();
      return sessionsOf(c).map(function (s) {
        return '<option value="' + esc(s.id) + '"' + (s.id === ses.id ? ' selected' : '') + '>' + esc(optionText(c, s)) + '</option>';
      }).join('');
    }
    /** Keeps the "(n of 57 marked)" of every session in the drop-down current (the selection stays). */
    function refreshOptions() {
      var c = c0();
      var select = body.querySelector('#rc-ses');
      if (!c || !select) return;
      ui.$$('option', select).forEach(function (o) {
        var s = findSession(c, o.value);
        var t = s ? optionText(c, s) : null;
        if (t !== null && o.textContent !== t) o.textContent = t;
      });
    }
    body.innerHTML =
      '<div class="rc-top"><div class="field rc-ses-field"><label for="rc-ses">Session</label><select id="rc-ses">' + sessionOptions() + '</select></div>' +
      '<div class="rc-progress" aria-live="polite"></div>' +
      '<button type="button" class="btn" data-rc="rest">' + icon('check') + 'Mark remaining present</button></div>' +
      '<p class="help rc-help">Press <kbd>P</kbd> present, <kbd>A</kbd> absent (not allowed), <kbd>E</kbd> excused (allowed): the next student is selected. ' +
      '<kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>Delete</kbd> clears. Every mark is saved at once.</p>' +
      // Shown in place of the help once the last student has had a turn (same spot, so nothing jumps).
      '<p class="rc-end" role="status" hidden>' + icon('check') + '<span>End of the list: every student has had a turn. Press <strong>Done</strong> to close, ' +
        'or <kbd>↑</kbd> to go back to the last student. Keys typed now change nothing.</span></p>' +
      '<ol class="rc-list">' + students.map(function (s, i) {
        var nid = 'rc-n-' + i;
        return '<li class="rc-row" data-i="' + i + '" data-sid="' + esc(s.id) + '">' +
          '<span class="rc-no">' + esc(str(s.no)) + '</span><span class="rc-name pii" id="' + nid + '">' + esc(studentName(s)) + '</span>' +
          '<span class="rc-btns">' +
            '<button type="button" class="rc-b rc-p" data-m="P" aria-pressed="false" aria-describedby="' + nid + '" tabindex="-1">P<span class="rc-bl">Present</span></button>' +
            '<button type="button" class="rc-b rc-a" data-m="A" aria-pressed="false" aria-describedby="' + nid + '" tabindex="-1">A<span class="rc-bl">Absent</span></button>' +
            '<button type="button" class="rc-b rc-e" data-m="E" aria-pressed="false" aria-describedby="' + nid + '" tabindex="-1">E<span class="rc-bl">Excused</span></button>' +
            '<button type="button" class="rc-x btn btn-ghost btn-icon btn-sm" data-m="" aria-label="Clear" aria-describedby="' + nid + '" title="Clear the mark" tabindex="-1">' + icon('x') + '</button>' +
          '</span></li>';
      }).join('') + '</ol>';

    var list = body.querySelector('.rc-list');
    var rowsEls = ui.$$('.rc-row', list);

    function c0() { var c = GT.store.course(); return c && c.id === courseId ? c : null; }

    function paintRow(i) {
      var c = c0();
      if (!c) return;
      var li = rowsEls[i];
      var m = markAt(c, students[i].id, ses.id);
      li.setAttribute('data-mark', m);
      ui.$$('.rc-b', li).forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-m') === m ? 'true' : 'false'); });
    }
    function paintAll() {
      for (var i = 0; i < rowsEls.length; i++) paintRow(i);
      progress();
    }
    function progress() {
      var c = c0();
      if (!c) return;
      var marked = 0, p = 0, a = 0, e = 0;
      students.forEach(function (s) {
        var m = markAt(c, s.id, ses.id);
        if (m) marked++;
        if (m === 'P') p++; else if (m === 'A') a++; else if (m === 'E') e++;
      });
      body.querySelector('.rc-progress').innerHTML = '<strong>' + marked + ' of ' + students.length + '</strong> marked' +
        ' <span class="muted">(' + p + ' present, ' + a + ' absent, ' + e + ' excused)</span>';
      var rest = body.querySelector('[data-rc="rest"]');
      rest.disabled = marked === students.length;
      rest.lastChild.textContent = marked === students.length ? 'Everyone has a mark' : 'Mark remaining present (' + (students.length - marked) + ')';
      refreshOptions();
    }
    function atEnd() { return current >= rowsEls.length; }
    /** Makes row i the current one. Past the last row is the end of the list: no row is current (so a key
     * typed now cannot overwrite the last student's mark) and Done gets the focus. */
    function setCurrent(i, focus) {
      current = i >= rowsEls.length ? rowsEls.length : Math.max(0, i);
      rowsEls.forEach(function (li, k) {
        var on = k === current;
        li.classList.toggle('is-current', on);
        ui.$$('button', li).forEach(function (b) { b.tabIndex = on ? 0 : -1; });
      });
      var endEl = body.querySelector('.rc-end'), helpEl = body.querySelector('.rc-help');
      if (endEl) endEl.hidden = !atEnd();
      if (helpEl) helpEl.hidden = atEnd();
      if (atEnd()) {
        var done = dlgEl ? dlgEl.querySelector('.dlg-foot .btn-primary') : null;
        if (focus && done) { try { done.focus({ preventScroll: true }); } catch (e) { done.focus(); } }
        return;
      }
      var li = rowsEls[current];
      if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
      if (focus) {
        var target = li.querySelector('.rc-b[aria-pressed="true"]') || li.querySelector('.rc-b');
        if (target) target.focus({ preventScroll: true });
      }
    }
    function mark(i, m) {
      var s = students[i];
      var c = c0();
      if (!c || !s) return;
      if (markAt(c, s.id, ses.id) !== m) {
        var r = txMarks('Roll call ' + shortDate(ses.date), [{ sid: s.id, ses: ses.id }], function (cc) {
          return setMarksIn(cc, [{ studentId: s.id, sessionId: ses.id, mark: m || null }]);
        }, { courseId: courseId });
        if (r === undefined) return;
      }
      paintRow(i);
      progress();
    }

    return ui.dialog.open({
      title: 'Take roll',
      body: body,
      wide: true,
      buttons: [{ text: 'Done', value: true, primary: true }],
      // The current row (the first student without a mark), not row 0: onMount below marks it before the
      // dialog picks this focus target, so Space/Enter act on the highlighted student.
      initialFocus: '.rc-row.is-current .rc-b',
      onMount: function (dlg) {
        dlgEl = dlg;
        paintAll();
        var firstOpen = 0;
        for (var i = 0; i < students.length; i++) { if (!markAt(c0(), students[i].id, ses.id)) { firstOpen = i; break; } }
        setCurrent(firstOpen, true);
        body.querySelector('#rc-ses').addEventListener('change', function (e) {
          var s = findSession(c0(), e.target.value);
          if (!s) return;
          ses = s;
          paintAll();
          var k = 0;
          for (var j = 0; j < students.length; j++) { if (!markAt(c0(), students[j].id, ses.id)) { k = j; break; } }
          setCurrent(k, false);
        });
        body.addEventListener('click', function (e) {
          var li = e.target.closest ? e.target.closest('.rc-row') : null;
          var b = e.target.closest ? e.target.closest('[data-m]') : null;
          if (e.target.closest && e.target.closest('[data-rc="rest"]')) { markRest(); return; }
          if (!li) return;
          var i2 = parseInt(li.getAttribute('data-i'), 10);
          if (b) {
            var m = b.getAttribute('data-m');
            mark(i2, m);
            setCurrent(m ? i2 + 1 : i2, true);
          } else {
            setCurrent(i2, true);
          }
        });
        dlg.addEventListener('keydown', function (e) {
          if (e.target.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
          var k = e.key;
          var up = markKey(e);
          if (up) {
            e.preventDefault();
            if (atEnd()) return; // after the last student: nothing to mark (see .rc-end)
            mark(current, up);
            setCurrent(current + 1, true);
          } else if (k === 'Delete' || k === 'Backspace') {
            e.preventDefault();
            if (atEnd()) return;
            mark(current, '');
            setCurrent(current, true);
          } else if (k === 'ArrowDown') {
            e.preventDefault();
            if (!atEnd()) setCurrent(Math.min(current + 1, rowsEls.length - 1), true);
          } else if (k === 'ArrowUp') {
            e.preventDefault();
            setCurrent(atEnd() ? rowsEls.length - 1 : current - 1, true);
          } else if ((k === 'ArrowLeft' || k === 'ArrowRight') && e.target.closest && e.target.closest('.rc-row')) {
            e.preventDefault();
            var btns = ui.$$('button', e.target.closest('.rc-row'));
            var at = btns.indexOf(document.activeElement);
            var nx = btns[Math.max(0, Math.min(btns.length - 1, at + (k === 'ArrowRight' ? 1 : -1)))];
            if (nx) nx.focus();
          }
        });
        function markRest() {
          var n = tx('Roll call ' + shortDate(ses.date) + ': mark remaining present', function (c) {
            return mut('markAllPresent')(c, ses.id, { activeOnly: true });
          }, { courseId: courseId });
          if (n === undefined) return;
          paintAll();
          ui.toast(n ? plural(n, 'student') + ' marked present.' : 'Everyone already has a mark.', { type: n ? 'success' : 'info' });
        }
      }
    });
  }

  // ------------------------------------------------------------------ register

  GT.views.attendance = {
    id: 'attendance',
    title: 'Attendance',
    render: render,
    destroy: destroy,
    /** Diagnostics for tests: duration of the last grid body build (string + innerHTML) in ms. */
    lastRenderMs: function () { return lastRenderMs; },
    /** Opens the session manager / roll call from elsewhere (e.g. a test or another view). */
    openSessions: function (o) { return openSessions(o || {}); },
    openRollCall: function (sesId) { return openRollCall(sesId || null); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
