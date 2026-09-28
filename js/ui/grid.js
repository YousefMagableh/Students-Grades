/* Grade Tracker - Grades grid (GT.views.grades): an Excel-like sheet with one row per student.
 * Keyboard-first editing (type to replace, Enter/F2 to edit, Tab/Enter/arrows to move), range
 * selection, copy and paste of blocks from Excel, team scores with per-member overrides, sorting,
 * grouping by team, search and column toggles.
 * Browser only. See docs/DESIGN.md section 6 and the stage-2 spec, section 4. */
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
    { key: 'attendance', label: 'Attendance' }
  ];
  var SORTS = [
    { value: 'name:asc', label: 'Name A–Z' },
    { value: 'name:desc', label: 'Name Z–A' },
    { value: 'total:desc', label: 'Total high–low' },
    { value: 'total:asc', label: 'Total low–high' }
  ];
  // Identity column widths (px). The sticky offsets in css/grid.css (.sc1 … .sc4) match these.
  var W = { no: 52, last: 106, first: 136, team: 70, total: 74, letter: 60, rank: 54, pct: 90, diff: 62, att: 118 };
  var HEAD_PAD = 17;   // header cell padding (2 × 8 px) plus slack
  var BADGE_W = 21;    // compact placeholder badge in a header (with its margin)

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
  var listboxPointerAt = 0;
  var copyHandled = false;
  var pendingCopy = null;
  var lastRenderMs = 0;

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

  function getPrefs() {
    var p = (GT.store.state && GT.store.state.ui && GT.store.state.ui.gridPrefs) || {};
    var out = {
      sort: p.sort === 'total' ? 'total' : 'name',
      dir: p.dir === 'desc' ? 'desc' : 'asc',
      group: p.group === true,
      showWithdrawn: p.showWithdrawn !== false,
      cols: {}
    };
    var pc = util.isPlainObject(p.cols) ? p.cols : {};
    COL_TOGGLES.forEach(function (t) { out.cols[t.key] = pc[t.key] !== false; });
    return out;
  }

  function setPrefs(patch) {
    var p = getPrefs();
    Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    GT.store.setUi({ gridPrefs: p });
  }

  function attendanceAvailable(course) {
    return !!(course && course.attendance && course.attendance.mode !== 'off' &&
      GT.attendance && typeof GT.attendance.summary === 'function');
  }

  function attSummary(course, sid) {
    try { return GT.attendance.summary(course, sid); } catch (e) { return null; }
  }

  function transact(label, fn, opts) {
    try {
      return GT.store.transact(label, fn, opts);
    } catch (err) {
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

  function buildColumns(course, prefs) {
    var cols = [
      { key: 'no', kind: 'no', label: 'No', edit: 'text', sticky: 1, width: W.no, num: true },
      { key: 'last', kind: 'last', label: 'Last Name', edit: 'text', sticky: 2, width: W.last },
      { key: 'first', kind: 'first', label: 'First Name', edit: 'text', sticky: 3, width: W.first },
      { key: 'team', kind: 'team', label: 'Team', edit: 'team', sticky: 4, width: W.team }
    ];
    // Header names (bold 12px) wrap at spaces, so a column needs room for its longest word; the
    // small lines under the name (11px) do not wrap.
    var nameW = function (text) { return textWidth(text, 700, 12); };
    var subW = function (text) { return textWidth(text, 500, 11); };
    var longestWordW = function (text) {
      return String(text).split(/\s+/).reduce(function (m, w) { return Math.max(m, nameW(w)); }, 0);
    };
    var badgeW = function (key) { return key && !model.isConfirmed(course, key) ? BADGE_W : 0; };
    var rawWidth = function (a) {
      var maxLine = subW('max ' + num(a.maxScore, 4)) + badgeW('maxScores');
      // "10% · team" may wrap before "· team" (css/grid.css .hs-w).
      var weightLine = Math.max(subW(num(a.weight, 4) + '%') + badgeW(weightPlaceholderKey(a)), a.teamGraded ? subW('· team') : 0);
      return clamp(Math.max(longestWordW(a.name), maxLine, weightLine) + HEAD_PAD, 64, 150);
    };
    // Weighted headers read "Project I 10%": a short name stays on one line, the weight may wrap.
    var weightedWidth = function (a) {
      var name = String(a.name).length <= 12 ? nameW(a.name) : longestWordW(a.name);
      var weight = nameW(num(a.weight, 4) + '%') + badgeW(weightPlaceholderKey(a));
      return clamp(Math.max(name, weight, subW('weighted')) + HEAD_PAD, 56, 150);
    };
    course.assessments.forEach(function (a, i) {
      cols.push({ key: 'raw:' + a.id, kind: 'raw', aid: a.id, a: a, label: a.name, edit: 'score',
        group: Math.min(i + 1, 6), width: rawWidth(a), num: true });
    });
    if (prefs.cols.weighted) {
      course.assessments.forEach(function (a, i) {
        cols.push({ key: 'w:' + a.id, kind: 'weighted', aid: a.id, a: a, label: a.name + ' ' + num(a.weight, 4) + '%',
          ro: true, group: Math.min(i + 1, 6), width: weightedWidth(a), num: true });
      });
    }
    cols.push({ key: 'total', kind: 'total', label: 'Total', ro: true, width: W.total, num: true });
    cols.push({ key: 'letter', kind: 'letter', label: 'Letter', ro: true, width: W.letter });
    cols.push({ key: 'rank', kind: 'rank', label: 'Rank', ro: true, width: W.rank, num: true });
    if (prefs.cols.percentile) cols.push({ key: 'pct', kind: 'pct', label: 'Percentile', ro: true, width: W.pct, num: true });
    if (prefs.cols.diff) cols.push({ key: 'diff', kind: 'diff', label: '±Avg', ro: true, width: W.diff, num: true });
    if (prefs.cols.attendance && attendanceAvailable(course)) {
      cols.push({ key: 'att', kind: 'att', label: 'Absences', ro: true, width: W.att, num: true });
    }
    cols.forEach(function (c, i) { c.index = i; });
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

  function buildLayout(course, results, prefs) {
    var cols = buildColumns(course, prefs);
    var teamById = Object.create(null);
    course.teams.forEach(function (t) { teamById[t.id] = t; });
    var q = searchText.trim().toLowerCase();
    var sorted = calc.sortStudents(course, results, prefs.sort, prefs.dir);
    var visible = sorted.filter(function (s) {
      if (!prefs.showWithdrawn && s.status === 'withdrawn') return false;
      var t = s.teamId ? teamById[s.teamId] : null;
      return matches(s, q, t ? t.name : '');
    });
    var items = [], students = [];
    var push = function (s) { items.push({ type: 'student', s: s, r: students.length }); students.push(s); };
    if (prefs.group) {
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
    var rowOfSid = Object.create(null), colOfKey = Object.create(null);
    students.forEach(function (s, i) { rowOfSid[s.id] = i; });
    cols.forEach(function (c, i) { colOfKey[c.key] = i; });
    return {
      cols: cols, students: students, items: items, rowOfSid: rowOfSid, colOfKey: colOfKey,
      teamById: teamById, shown: visible.length, total: course.students.length, prefs: prefs
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
    if (!a) return;
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
    var th = dom.table.tHead && dom.table.tHead.rows[0] ? dom.table.tHead.rows[0].cells[a.c] : null;
    if (th) { th.classList.add('hdr-active'); painted.head = th; }
    if (rowEls[a.r]) { rowEls[a.r].classList.add('row-active'); painted.row = rowEls[a.r]; }
    sel.lastR = a.r;
  }

  function focusCell(td) {
    if (!td) return;
    if (!td.hasAttribute('tabindex')) td.setAttribute('tabindex', '-1');
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
    var right = 0;
    for (var i = 0; i < 4 && i < row.cells.length; i++) {
      var th = row.cells[i], cs = root.getComputedStyle(th);
      if (cs.position === 'sticky' && cs.left !== 'auto') right = th.getBoundingClientRect().right;
    }
    return right;
  }

  /** Scrolls the grid (and, if needed, the page) so the cell is fully visible below the sticky
   * header, above the sticky footer and right of the sticky identity columns. */
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
    } else {
      sel.active = refAt(r, c);
      sel.end = sel.active;
      if (sel.active.sid !== newRowSid) newRowSid = null;
    }
    paintSelection();
    focusActive();
    ensureVisible(cellAt(r, c));
  }

  function tabTarget(p, back) {
    var r = p.r, c = p.c + (back ? -1 : 1);
    if (c >= layout.cols.length) { c = 0; r++; } else if (c < 0) { c = layout.cols.length - 1; r--; }
    if (r < 0 || r >= layout.students.length) return null;
    return { r: r, c: c };
  }

  function editableAt(p) {
    return !!(p && layout.cols[p.c] && layout.cols[p.c].edit);
  }

  // ------------------------------------------------------------------ HTML builders

  /** Placeholder badge for an assessment's weight: the Term Paper weight and the project split are
   * unconfirmed defaults (placeholderBadge returns '' once the key is marked confirmed). */
  function weightBadge(course, a) {
    var key = weightPlaceholderKey(a);
    return key ? ui.placeholderBadge(course, key, { compact: true }) : '';
  }

  function headHtml(ctx) {
    var course = ctx.course, prefs = layout.prefs, dec = ctx.dec;
    var h = '<colgroup>';
    ctx.cols.forEach(function (col) { h += '<col style="width:' + col.width + 'px">'; });
    h += '</colgroup><thead><tr role="row" aria-rowindex="1">';
    ctx.cols.forEach(function (col, i) {
      var cls = 'h-' + col.kind + (col.sticky ? ' sc sc' + col.sticky : '') + (col.group ? ' g g' + col.group : '') +
        (col.ro ? ' ro' : '') + (col.num ? ' num' : '');
      var inner = '', title = '', aria = '';
      var a = col.a;
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
        case 'raw':
          inner = '<span class="h-name">' + esc(a.name) + '</span><span class="h-sub"><span class="hs">max ' + num(a.maxScore, 4) +
            ui.placeholderBadge(course, 'maxScores', { compact: true }) + '</span><span class="hs hs-w"><span class="sr-only"> · </span>' +
            '<span class="nowrap">' + num(a.weight, 4) + '%' + weightBadge(course, a) + '</span>' +
            (a.teamGraded ? ' <span class="nowrap">· team</span>' : '') + '</span></span>';
          title = a.name + ': max ' + num(a.maxScore, 4) + ', weight ' + num(a.weight, 4) + '%' +
            (a.teamGraded ? ', team-graded (one score per team, ◆ = per-member override)' : '');
          break;
        case 'weighted':
          inner = '<span class="h-name">' + esc(a.name) + ' <span class="nowrap">' + num(a.weight, 4) + '%' + weightBadge(course, a) +
            '</span></span><span class="h-sub">weighted</span>';
          title = 'Weighted points = raw ÷ ' + num(a.maxScore, 4) + ' × ' + num(a.weight, 4) + ' (calculated)';
          break;
        case 'letter': inner = 'Letter' + ui.placeholderBadge(course, 'letterScale', { compact: true }); title = 'Letter grade from the total'; break;
        case 'rank': inner = 'Rank'; title = 'Rank among active students'; break;
        case 'pct': inner = 'Percentile'; title = 'Percentile among active students'; break;
        case 'diff': inner = '±Avg'; title = 'Difference from the class average (active students)'; break;
        case 'att': inner = 'Absences'; title = 'Total absences (unexcused in brackets)'; break;
      }
      h += '<th role="columnheader" scope="col" data-c="' + i + '" class="' + cls + '"' + aria +
        (title ? ' title="' + esc(title) + '"' : '') + '>' + inner + '</th>';
    });
    return h + '</tr></thead>';
  }

  function studentRowHtml(ctx, s, r, ariaRow) {
    var course = ctx.course, cols = ctx.cols, dec = ctx.dec;
    var rs = ctx.results.byId[s.id];
    var wd = s.status === 'withdrawn';
    var team = s.teamId ? ctx.teamById[s.teamId] : null;
    var h = '<tr role="row" class="gr' + (wd ? ' row-withdrawn' : '') + '" data-r="' + r + '" data-sid="' + esc(s.id) +
      '" aria-rowindex="' + ariaRow + '">';
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      var cls, body = '', title = '', ro = !!col.ro;
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
          if (wd) body = '<span class="fn-wd">' + body + '<span class="badge wd-badge">Withdrawn</span></span>';
          break;
        case 'team':
          cls = 'c-team sc sc4';
          body = team ? esc(team.name) : '<span class="faint">—</span>';
          break;
        case 'raw': {
          var d = rs.items[col.aid];
          var a = col.a;
          var tips = [];
          cls = 'c-raw num g g' + col.group;
          if (d.state === 'invalid') {
            cls += ' is-invalid';
            body = esc(d.text);
            tips.push('Not a number: counted as 0');
          } else if (d.state === 'number') {
            body = esc(String(d.raw));
            if (d.outOfRange) { cls += ' is-range'; tips.push('Outside 0–' + num(a.maxScore, 4)); }
          } else {
            cls += ' is-empty';
            body = '–';
            tips.push('Empty: counted as 0');
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
          if (d.weeksLate > 0) {
            cls += ' is-late';
            tips.push(plural(d.weeksLate, 'week') + ' late' + (d.waived ? ' (penalty waived)' : ': −' + num(d.penalty, dec) + ' points'));
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
            title = (dw.penalty > 0 ? '(' + dw.raw + ' − ' + num(dw.penalty, dec) + ' late)' : String(dw.raw)) + ' ÷ ' +
              num(col.a.maxScore, 4) + ' × ' + num(col.a.weight, 4) + ' = ' + num(dw.weighted, 6);
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
          body = esc(rs.letter);
          break;
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
        case 'att': {
          cls = 'c-att num ro';
          var sm = attSummary(course, s.id);
          if (sm) {
            body = esc(sm.totalAbsences + ' (' + sm.unexcused + ' unexc.)');
            var at = [sm.totalAbsences + ' absences in ' + sm.recorded + ' recorded sessions', sm.unexcused + ' unexcused'];
            if (sm.warning === 'fail') at.push('Consecutive absences: F may apply (warning only)');
            else if (sm.warning === 'drop') at.push('Consecutive absences: one letter drop may apply (warning only)');
            if (sm.overThreshold) at.push('Above the unexcused-absence threshold');
            if (sm.warning || sm.overThreshold) {
              cls += ' is-att-warn';
              body = '<span class="mk-att" aria-hidden="true">' + ui.icon('alert') + '</span>' + body;
            }
            title = at.join('. ');
          }
          break;
        }
        default:
          cls = '';
      }
      h += '<td role="gridcell" data-c="' + i + '" class="' + cls + '"' + (ro ? ' aria-readonly="true"' : '') +
        (title ? ' title="' + esc(title) + '"' : '') + '>' + body + '</td>';
    }
    return h + '</tr>';
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
    var h = '<tr role="row" class="team-row" aria-rowindex="' + ariaRow + '"><th role="rowheader" scope="row" colspan="4" class="sc sc-span team-label">' +
      ui.icon('users', 'icon-sm') + ' <span class="tl-name">' + esc(team ? team.name : 'No team') + '</span><span class="tl-meta"> · ' +
      plural(all.length, 'member') + (wd ? ' (' + wd + ' withdrawn)' : '') + ' · team average ' + avg + '</span></th>';
    for (var i = 4; i < cols.length; i++) {
      var col = cols[i], inner = '', cls = 'tr-cell' + (col.group ? ' g g' + col.group : '') + (col.num ? ' num' : '');
      if (team && col.kind === 'raw' && col.a.teamGraded) {
        var e = model.getEntry(course.teamScores, team.id, col.aid);
        var p = calc.parseEntry(e);
        var txt = entryText(e);
        var bcls = 'team-score' + (p.state === 'invalid' ? ' is-invalid' : '') +
          (p.state === 'number' && (p.value < 0 || p.value > col.a.maxScore) ? ' is-range' : '');
        inner = '<button type="button" class="' + bcls + '" data-act="team-score" data-tid="' + esc(team.id) + '" data-aid="' + esc(col.aid) +
          '" tabindex="-1" title="' + esc(team.name + ' team score for ' + col.a.name + ' (click to edit)') + '">' +
          (txt ? esc(txt) : '<span class="faint">set…</span>') + '</button>';
      }
      h += '<td role="gridcell" aria-readonly="true" class="' + cls + '">' + inner + '</td>';
    }
    return h + '</tr>';
  }

  function footHtml(ctx, ariaRow) {
    var course = ctx.course, cols = ctx.cols, dec = ctx.dec, results = ctx.results;
    var active = course.students.filter(function (s) { return s.status !== 'withdrawn'; });
    var h = '<tfoot><tr role="row" class="avg-row" aria-rowindex="' + ariaRow + '"><th role="rowheader" scope="row" colspan="4" class="sc sc-span avg-label">' +
      'Class average <span class="muted">(active)</span></th>';
    for (var i = 4; i < cols.length; i++) {
      var col = cols[i], v = '', title = '';
      var cls = 'f-' + col.kind + (col.group ? ' g g' + col.group : '') + (col.num ? ' num' : '');
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
        title = 'Letter for the class average';
      }
      h += '<td role="gridcell" aria-readonly="true" class="' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + v + '</td>';
    }
    return h + '</tr></tfoot>';
  }

  // ------------------------------------------------------------------ rendering

  function toolbarHtml() {
    return '<div class="toolbar grid-toolbar">' +
      '<label class="search">' + ui.icon('search') + '<span class="sr-only">Search students</span>' +
      '<input type="search" class="grid-search" placeholder="Search name, No or team" title="Search (press / to jump here)" autocomplete="off" spellcheck="false"></label>' +
      '<label class="grid-sort"><span class="grid-sort-label">Sort</span><select class="grid-sort-select" aria-label="Sort rows">' +
      SORTS.map(function (o) { return '<option value="' + o.value + '">' + esc(o.label) + '</option>'; }).join('') + '</select></label>' +
      // On phones the button labels (.bl) are visually hidden and the legend folds behind "Legend".
      '<button type="button" class="btn btn-sm" data-act="group" aria-pressed="false" title="Group rows by team">' + ui.icon('layers') + '<span class="bl">Group by team</span></button>' +
      '<button type="button" class="btn btn-sm" data-act="withdrawn" aria-pressed="true">' + ui.icon('user') + '<span class="bl">Show withdrawn</span></button>' +
      '<button type="button" class="btn btn-sm" data-act="columns" aria-haspopup="menu" aria-expanded="false" title="Show or hide columns">' + ui.icon('grid') +
      '<span class="bl">Columns</span>' + ui.icon('chevron-down') + '</button>' +
      '<button type="button" class="btn btn-sm grid-legend-btn" data-act="legend" aria-expanded="false" aria-controls="grid-legend" title="Show the legend">' +
      ui.icon('info') + '<span class="bl">Legend</span></button>' +
      '<span class="spacer"></span>' +
      '<span class="grid-count muted small" aria-live="polite"></span>' +
      '<button type="button" class="btn btn-sm" data-act="paste-roster" title="Paste a roster copied from Excel">' + ui.icon('copy') + '<span class="bl">Paste roster</span></button>' +
      '<button type="button" class="btn btn-sm btn-primary" data-act="add-student" title="Add a student">' + ui.icon('plus') + '<span class="bl">Add student</span></button>' +
      '</div>';
  }

  function legendHtml() {
    return '<div class="grid-legend" id="grid-legend" aria-label="Legend">' +
      '<span><span class="lg-sw lg-empty">–</span>empty: counted as 0</span>' +
      '<span><span class="lg-sw lg-invalid"></span>red: not a number</span>' +
      '<span><span class="lg-sw lg-range"></span>yellow: outside 0 to max</span>' +
      '<span><span class="lg-mk mk-ovr">◆</span>per-member override</span>' +
      '<span><span class="lg-mk mk-team"></span>team score</span>' +
      '<span><span class="lg-mk inc">' + ICON_INCOMPLETE + '</span>incomplete total</span>' +
      '<span><span class="lg-sw lg-late"></span>late work (penalty in the tooltip)</span>' +
      '<span class="lg-hint">Type to replace · Enter or F2 to edit · Ctrl+C / Ctrl+V with Excel · right-click or Shift+F10 for cell actions · Esc, then Tab leaves the grid</span>' +
      '</div>';
  }

  function buildSkeleton(el, which) {
    closeColumnsMenu(false);
    el.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'page-header grid-head';
    el.appendChild(head);
    layout = null;
    rowEls = [];
    painted = { range: [], active: null, head: null, row: null };
    if (which !== 'grid') {
      var box = document.createElement('div');
      box.className = 'card grid-empty';
      el.appendChild(box);
      dom = { head: head, empty: box };
      return;
    }
    var tb = ui.el(toolbarHtml());
    var legend = ui.el(legendHtml());
    var wrap = ui.el('<div class="table-wrap grid-wrap"><table class="gt-grid" role="grid"></table></div>');
    el.appendChild(tb);
    el.appendChild(legend);
    el.appendChild(wrap);
    dom = {
      head: head, toolbar: tb, legend: legend, wrap: wrap, table: wrap.querySelector('table'),
      search: tb.querySelector('.grid-search'), sort: tb.querySelector('.grid-sort-select'),
      group: tb.querySelector('[data-act="group"]'), withdrawn: tb.querySelector('[data-act="withdrawn"]'),
      columns: tb.querySelector('[data-act="columns"]'), roster: tb.querySelector('[data-act="paste-roster"]'),
      count: tb.querySelector('.grid-count')
    };
    dom.search.value = searchText;
    dom.search.addEventListener('input', function () {
      searchText = dom.search.value;
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

  function renderHead(course, results) {
    var active = 0, wd = 0;
    course.students.forEach(function (s) { if (s.status === 'withdrawn') wd++; else active++; });
    var dec = decimalsOf(course);
    var h = '<div><h1>' + esc(course.code) + ' <span class="grid-title">' + esc(course.title) + '</span></h1><div class="sub">';
    if (!course.students.length) {
      h += 'No students yet';
    } else {
      var avg = results && results.average !== null ? num(results.average, dec) : '—';
      h += esc(active + ' active · ' + wd + ' withdrawn · class average ' + avg + ' (active students)');
    }
    var w = results ? results.weights : calc.weightStatus(course);
    if (!w.ok) {
      h += ' <button type="button" class="chip warn grid-weights" data-act="weights" title="' +
        (GT.views.settings ? 'Open Settings to fix the weights' : 'Weights should add up to 100%') + '">' +
        ui.icon('alert', 'icon-sm') + 'Weights sum to ' + esc(num(w.sum, 2)) + '%</button>';
    }
    dom.head.innerHTML = h + '</div></div>';
  }

  function renderEmpty(course) {
    var canRoster = typeof GT.ui.openRosterPaste === 'function';
    var canImport = !!GT.views.exchange;
    var canSample = !!(GT.sample && GT.app && GT.app.actions && GT.app.actions.loadSample);
    dom.empty.innerHTML = '<div class="empty-state">' + ui.icon('users', 'empty-ico') +
      '<h2>No students in ' + esc(course.code) + ' yet</h2>' +
      '<p>Add students one by one, paste a roster copied from Excel, or load fake sample data to try the app. ' +
      'Everything stays in this browser.</p><div class="actions">' +
      (canSample ? '<button type="button" class="btn btn-primary" data-act="load-sample">' + ui.icon('layers') + 'Load sample data</button>' : '') +
      (canRoster ? '<button type="button" class="btn" data-act="paste-roster">' + ui.icon('copy') + 'Paste roster</button>' : '') +
      '<button type="button" class="btn" data-act="add-student">' + ui.icon('plus') + 'Add student</button>' +
      (canImport ? '<button type="button" class="btn" data-act="import">' + ui.icon('upload') + 'Import from Excel/CSV</button>' : '') +
      '</div></div>';
  }

  function renderToolbar() {
    var p = getPrefs();
    var v = p.sort + ':' + p.dir;
    if (dom.sort.value !== v) dom.sort.value = v;
    dom.group.setAttribute('aria-pressed', p.group ? 'true' : 'false');
    dom.withdrawn.setAttribute('aria-pressed', p.showWithdrawn ? 'true' : 'false');
    dom.withdrawn.title = p.showWithdrawn ? 'Withdrawn students are shown greyed out. Click to hide them.' : 'Withdrawn students are hidden. Click to show them.';
    dom.roster.hidden = typeof GT.ui.openRosterPaste !== 'function';
    if (dom.search.value !== searchText && document.activeElement !== dom.search) dom.search.value = searchText;
    syncColumnsMenu();
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
      nActive: results.activeIds.length, openStudent: typeof GT.ui.openStudent === 'function'
    };
    var parts = [headHtml(ctx), '<tbody>'];
    var ariaRow = 2;
    for (var i = 0; i < layout.items.length; i++) {
      var it = layout.items[i];
      parts.push(it.type === 'team' ? teamRowHtml(ctx, it.team, ariaRow) : studentRowHtml(ctx, it.s, it.r, ariaRow));
      ariaRow++;
    }
    if (!layout.students.length) {
      parts.push('<tr class="no-rows"><td colspan="' + layout.cols.length + '"><div class="no-rows-msg">' +
        (searchText.trim() ? 'No students match “' + esc(searchText.trim()) + '”.' : 'No students to show. Withdrawn students are hidden.') +
        '</div></td></tr>');
      ariaRow++;
    }
    parts.push('</tbody>', footHtml(ctx, ariaRow));
    var table = dom.table;
    table.innerHTML = parts.join('');
    var width = 0;
    layout.cols.forEach(function (c) { width += c.width; });
    table.style.width = width + 'px';
    table.setAttribute('aria-rowcount', String(ariaRow));
    table.setAttribute('aria-colcount', String(layout.cols.length));
    table.setAttribute('aria-label', 'Grades for ' + course.code);
    table.classList.toggle('grouped', layout.prefs.group);
    rowEls = [];
    var trs = table.tBodies[0].rows;
    for (var k = 0; k < trs.length; k++) {
      var ri = trs[k].getAttribute('data-r');
      if (ri !== null) rowEls[+ri] = trs[k];
    }
    painted = { range: [], active: null, head: null, row: null };
    paintSelection();
    dom.count.textContent = layout.shown === layout.total ? plural(layout.total, 'student') :
      'Showing ' + layout.shown + ' of ' + layout.total;
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
    }
    var params = ctx.params && ctx.params !== lastParams ? ctx.params : null;
    if (params) lastParams = params;
    if (params && params.studentId && model.findStudent(course, params.studentId)) {
      var key = params.assessmentId ? 'raw:' + params.assessmentId : (sel.active ? sel.active.key : 'raw:' + (course.assessments[0] ? course.assessments[0].id : ''));
      sel.active = { sid: params.studentId, key: key };
      sel.end = sel.active;
      searchText = '';
      revealActive = true;
      dataDirty = true;
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
    renderToolbar();
    queueWrapTop();
    if (editing) { tableDirty = true; return; }
    if (!rebuilt && !dataDirty && !switchedCourse && !ctx.switched && layout) return;
    renderTable();
  }

  function destroy() {
    closeColumnsMenu(false);
    // Leaving the view (e.g. Alt+2) removes the container before the editor's focusout can commit:
    // save the typed value now, like a click elsewhere does.
    if (editing) {
      try { commitEdit(null, { soft: true }); } catch (e) { if (root.console) console.error(e); }
    }
    editing = null;
    drag = null;
    tabExit = false;
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
    return '';
  }

  function startEdit(how, initial) {
    if (editing || !layout) return;
    var p = posOf(sel.active);
    if (!p) return;
    var col = layout.cols[p.c];
    if (!col.edit) return;
    var course = cur();
    var s = model.findStudent(course, layout.students[p.r].id);
    var td = cellAt(p.r, p.c);
    if (!s || !td) return;
    var who = studentLabel(s);
    ensureVisible(td);
    if (col.edit === 'team') { openTeamEditor(td, s, course, who); return; }
    var a = col.aid ? model.findAssessment(course, col.aid) : null;
    var current = editText(course, s, col);
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-editor' + (col.kind === 'last' || col.kind === 'first' ? ' pii' : '') +
      (col.kind === 'raw' || col.kind === 'no' ? ' is-num' : '');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    if (col.kind === 'raw') input.setAttribute('inputmode', 'decimal');
    if (col.kind === 'no') input.setAttribute('inputmode', 'numeric');
    input.setAttribute('aria-label', (col.kind === 'raw' ? (a ? a.name : col.label) : col.label) + ' for ' + who);
    input.value = how === 'enter' ? (initial || '') : current;
    td.classList.add('is-editing');
    td.appendChild(input);
    editing = {
      sid: s.id, key: col.key, kind: col.edit, aid: col.aid || null, mode: how, input: input, td: td,
      original: current, max: a ? a.maxScore : null
    };
    input.classList.toggle('mode-edit', how === 'edit');
    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    var len = input.value.length;
    try { input.setSelectionRange(len, len); } catch (e2) { /* ignore */ }
    validateEditor();
  }

  function openTeamEditor(td, s, course, who) {
    var box = document.createElement('select');
    box.className = 'cell-editor team-editor';
    var current = s.teamId && model.findTeam(course, s.teamId) ? s.teamId : '';
    box.innerHTML = '<option value="">(no team)</option>' + course.teams.map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
    }).join('') + '<option value="' + NEW_TEAM + '">New team…</option>';
    box.size = Math.max(3, Math.min(10, course.teams.length + 2));
    box.value = current;
    box.setAttribute('aria-label', 'Team for ' + who + ' (Enter to choose, Esc to cancel)');
    td.classList.add('is-editing');
    td.appendChild(box);
    var wr = dom.wrap.getBoundingClientRect(), tr = td.getBoundingClientRect();
    if (tr.top + box.offsetHeight > wr.bottom - 4 && tr.bottom - box.offsetHeight > wr.top) box.classList.add('drop-up');
    editing = { sid: s.id, key: 'team', kind: 'team', aid: null, mode: 'edit', input: box, td: td, original: current, max: null };
    try { box.focus({ preventScroll: true }); } catch (e) { box.focus(); }
  }

  function validateEditor() {
    var ed = editing;
    if (!ed || ed.kind === 'team') return;
    var v = ed.input.value, bad = false, warn = false;
    if (ed.key === 'no') {
      var t = v.trim();
      bad = t !== '' && !(/^\d+$/.test(t) && parseInt(t, 10) >= 1);
    } else if (ed.kind === 'score') {
      var p = util.parseScoreInput(v);
      bad = p.kind === 'invalid';
      warn = p.kind === 'number' && (p.value < 0 || (ed.max !== null && p.value > ed.max));
    }
    ed.input.classList.toggle('is-bad', bad);
    ed.input.classList.toggle('is-warn', warn);
    ed.input.setAttribute('aria-invalid', bad ? 'true' : 'false');
  }

  function closeEditor(refocus) {
    var ed = editing;
    if (!ed) return;
    editing = null;
    if (ed.input.parentNode) ed.input.parentNode.removeChild(ed.input);
    ed.td.classList.remove('is-editing');
    if (refocus && ed.td.isConnected) focusCell(ed.td);
    if (tableDirty) { tableDirty = false; renderTable(); }
  }

  function cancelEdit() {
    closeEditor(true);
  }

  /** Commits the open editor. move: null | 'enter' | 'up' | 'down' | 'left' | 'right' | 'tab' | 'shift-tab'.
   * opts.soft: focus has moved elsewhere (blur or a click), so do not take it back. */
  function commitEdit(move, opts) {
    var ed = editing;
    if (!ed) return true;
    var o = opts || {};
    var value = ed.input.value;
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
    closeEditor(!o.soft);
    if (value !== ed.original) applyEdit(ed, value);
    if (move) moveAfterCommit(ed, move, wasNew);
    return true;
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
      r = Math.min(r + 1, nR - 1);
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
    moveTo(clamp(r, 0, nR - 1), clamp(c, 0, nC - 1), false);
  }

  /** Writes a typed score following the K5 rules. Returns what was written. */
  function writeScore(c, sid, aid, text) {
    var s = model.findStudent(c, sid), a = model.findAssessment(c, aid);
    if (!s || !a) return null;
    var team = a.teamGraded && s.teamId ? model.findTeam(c, s.teamId) : null;
    if (!team) {
      var prev = model.getEntry(c.scores, sid, aid);
      var e = model.entryFromInput(text, prev);
      delete e.override;
      model.setEntry(c.scores, sid, aid, model.isBlankEntry(e) ? null : e);
      return { kind: 'individual' };
    }
    var own = model.getEntry(c.scores, sid, aid);
    if (own && own.override === true) {
      var eo = model.entryFromInput(text, own);
      if (eo.override) { model.setEntry(c.scores, sid, aid, eo); return { kind: 'override' }; }
      model.clearOverride(c, sid, aid);
      return { kind: 'override-removed', team: team, teamText: entryText(model.getEntry(c.teamScores, team.id, aid)) };
    }
    var prevT = model.getEntry(c.teamScores, team.id, aid);
    model.setTeamScore(c, team.id, aid, model.entryFromInput(text, prevT));
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
    } else if (ed.kind === 'score') {
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
    ui.dialog.prompt({
      title: a.name + ': ' + team.name + ' team score',
      label: 'Team score (max ' + num(a.maxScore, 4) + ')',
      value: entryText(model.getEntry(course.teamScores, teamId, aid)),
      help: 'Applies to all ' + plural(members.length, 'member') + (overrides ? ' except ' + overrides + ' with a per-member override (◆)' : '') +
        '. Leave empty to clear it.',
      confirmText: 'Save team score'
    }).then(function (v) {
      if (v === null) { refocusGrid(); return; }
      refocusGrid();
      transact('Edit team score (' + a.name + ')', function (c) {
        model.setTeamScore(c, teamId, aid, model.entryFromInput(v, model.getEntry(c.teamScores, teamId, aid)));
      });
    });
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
    ui.dialog.form({
      title: 'Override ' + a.name + ' for ' + who,
      introHtml: '<div class="callout callout-warn" style="margin-bottom:12px">All members of a team get the same mark unless the team agrees ' +
        '<strong>in writing</strong> to an unequal split. The override is marked with ◆ and logged in History.</div>' +
        '<p class="muted small">' + esc(team.name) + ' team score: <strong>' + esc(teamText || 'empty') + '</strong>. Other members keep the team score.</p>',
      fields: [
        { name: 'value', label: a.name + ' score for ' + who + ' (max ' + num(a.maxScore, 4) + ')', value: teamText,
          help: 'Leave empty to give this student no score for this item.' },
        { name: 'reason', label: 'Reason (optional, saved with the change in History)', placeholder: 'e.g. team agreement email, Oct 12' }
      ],
      confirmText: 'Save override',
      validate: function (v) {
        return util.parseScoreInput(v.value).kind === 'invalid' ? 'Enter a number, or leave it empty.' : null;
      }
    }).then(function (v) {
      refocusGrid();
      if (!v) return;
      var before = (cur().history || []).length;
      transact('Override ' + a.name, function (c) {
        model.setOverride(c, sid, aid, model.entryFromInput(v.value, model.getEntry(c.teamScores, team.id, aid)));
      });
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

  // ------------------------------------------------------------------ clear, copy, paste

  function clearCells() {
    var rc = rectOf();
    if (!rc) return;
    var course = cur();
    // No is cleared only when the selection stays inside the No column (a wider Delete is about scores).
    var noOnly = rc.c1 === rc.c2 && layout.cols[rc.c1].kind === 'no';
    var targets = [], skipped = 0, skippedNo = 0;
    var teamClears = Object.create(null), teamClearList = [];
    for (var r = rc.r1; r <= rc.r2; r++) {
      for (var c = rc.c1; c <= rc.c2; c++) {
        var col = layout.cols[c], sid = layout.students[r].id;
        if (col.kind === 'raw') {
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
      if (skipped || skippedNo) {
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
    // A multi-cell Delete that would also empty the team score of members outside the selection asks first.
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
    transact(targets.length === 1 ? 'Clear cell' : 'Clear ' + targets.length + ' cells', function (c) {
      targets.forEach(function (t) {
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
    var msgs = [];
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
    var label = p ? layout.cols[p.c].label : 'This column';
    ui.toast(label + ' is calculated and cannot be edited. Edit the raw scores instead.', { type: 'info', timeout: 3000 });
  }

  function copyText(course, results, s, col) {
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
      case 'letter': return rs.letter || '';
      case 'rank': return wd || rs.rank === null ? '' : String(rs.rank);
      case 'pct': return wd || rs.percentile === null ? '' : num(rs.percentile, 0);
      case 'diff': return wd || rs.diffFromAverage === null ? '' : num(rs.diffFromAverage, dec);
      case 'att': {
        var sm = attendanceAvailable(course) ? attSummary(course, s.id) : null;
        return sm ? sm.totalAbsences + ' (' + sm.unexcused + ' unexc.)' : '';
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
    for (var r = rc.r1; r <= rc.r2; r++) {
      var s = model.findStudent(course, layout.students[r].id);
      var cells = [];
      for (var c = rc.c1; c <= rc.c2; c++) cells.push(tsvField(s ? copyText(course, results, s, layout.cols[c]) : ''));
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
        ops.push({ sid: sid, kind: col.kind, aid: col.aid || null, text: String(text) });
      }
    }
    var job = {
      ops: ops, skipped: skipped, fill: fill, source: o.source || 'paste',
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
    if (ops.length) {
      var label = (fill ? 'Fill ' : 'Paste ') + plural(ops.length, 'cell');
      focusUntil = nowMs() + 1500;
      transact(label, function (c) {
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
              return { studentId: op.sid, entry: model.entryFromInput(op.text, st ? model.effectiveEntry(c, st, asmt) : null) };
            });
            var out = model.setTeamScoreFromMembers(c, aid, rows);
            sum.overrides += out.overridesCreated;
            sum.propagated += (out.propagatedTo || []).length;
            sum.cells += rows.length;
          } else {
            byAid[aid].forEach(function (op) {
              var e = model.entryFromInput(op.text, model.getEntry(c.scores, op.sid, aid));
              delete e.override;
              model.setEntry(c.scores, op.sid, aid, model.isBlankEntry(e) ? null : e);
              sum.cells++;
            });
          }
        });
      }, { source: job.source });
      // Select the pasted area, like Excel. (If the re-render re-sorts the rows, renderTable
      // collapses it to the active cell.)
      if (posOf(job.selA) && posOf(job.selE)) {
        sel.active = job.selA;
        sel.end = job.selE;
        paintSelection();
        focusActive();
      }
    }
    var msg = [];
    if (ops.length) msg.push((fill ? 'Filled ' : 'Pasted ') + plural(sum.cells, 'cell') + '.');
    else msg.push('Nothing was pasted.');
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
    var warn = job.droppedRows || job.droppedCols || sum.badNo || !ops.length;
    ui.toast(msg.join(' '), { type: warn ? 'warn' : 'success', timeout: warn || sum.overrides || sum.kept ? 9000 : 4000 });
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
    var items = [{ heading: studentLabel(s) + ' · ' + col.label }];
    if (col.kind === 'raw' && a) {
      var team = a.teamGraded && s.teamId ? model.findTeam(course, s.teamId) : null;
      if (team) {
        var tv = entryText(model.getEntry(course.teamScores, team.id, a.id)) || 'empty';
        if (detail && detail.override) {
          items.push({ label: 'Remove override (use team score ' + tv + ')', icon: 'diamond', onSelect: function () { removeOverride(s.id, a.id); } });
          items.push({ label: 'Edit override value', icon: 'edit', hint: 'F2', onSelect: function () { startEdit('edit'); } });
        } else {
          items.push({ label: 'Override for this student only…', icon: 'diamond', onSelect: function () { overrideDialog(s.id, a.id); } });
        }
        items.push({ label: 'Edit team score…', icon: 'users', onSelect: function () { editTeamScore(team.id, a.id); } });
      } else {
        items.push({ label: 'Edit score', icon: 'edit', hint: 'F2', onSelect: function () { startEdit('edit'); } });
      }
      items.push({ label: multi ? 'Clear selected cells' : 'Clear score', icon: 'x', hint: 'Del', onSelect: clearCells });
    } else if (col.edit) {
      items.push({ label: col.kind === 'team' ? 'Change team…' : 'Edit ' + col.label.toLowerCase(), icon: 'edit', hint: col.kind === 'team' ? '' : 'F2', onSelect: function () { startEdit('edit'); } });
    }
    items.push({ label: multi ? 'Copy selection' : 'Copy', icon: 'copy', hint: 'Ctrl+C', onSelect: copySelection });
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
    var toggles = COL_TOGGLES.filter(function (t) { return t.key !== 'attendance' || attendanceAvailable(course); });
    var m = document.createElement('div');
    m.className = 'menu grid-cols-menu';
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Show columns');
    m.innerHTML = '<div class="menu-label">Show columns</div>' + toggles.map(function (t) {
      return '<button type="button" role="menuitemcheckbox" tabindex="-1" data-key="' + t.key + '" aria-checked="false">' +
        ui.icon('check', 'cm-check') + '<span>' + esc(t.label) + '</span></button>';
    }).join('') + '<div class="menu-sep" role="separator"></div><div class="cm-note">Scores, Total, Letter and Rank are always shown.</div>';
    document.body.appendChild(m);
    var items = ui.$$('[role="menuitemcheckbox"]', m);
    var toggle = function (b) {
      var p = getPrefs();
      var key = b.getAttribute('data-key');
      p.cols[key] = !p.cols[key];
      b.setAttribute('aria-checked', p.cols[key] ? 'true' : 'false');
      GT.store.setUi({ gridPrefs: p });
    };
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[role="menuitemcheckbox"]');
      if (b) toggle(b);
    });
    m.addEventListener('keydown', function (e) {
      var i = items.indexOf(document.activeElement);
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
    if (items[0]) items[0].focus();
  }

  // ------------------------------------------------------------------ actions

  function addStudent() {
    var course = cur();
    if (!course) return;
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
      if (editing.kind === 'team') listboxPointerAt = nowMs();
      return;
    }
    var hit = cellFromEvent(e);
    if (!hit) return;
    tabExit = false;
    if (e.target.closest('button')) return;
    if (e.button === 2) {
      if (!inRect(hit.r, hit.c)) {
        if (editing) commitEdit(null, { soft: true });
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
    if (editing) commitEdit(null, { soft: true });
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
    if (editableAt(hit)) startEdit('edit'); else notifyReadOnly();
  }

  function onContextMenu(e) {
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
    if (editing && editing.kind === 'team' && t && t.tagName === 'OPTION' && editing.input.contains(t)) {
      commitEdit(null, {});
      return;
    }
    var b = t && t.closest ? t.closest('[data-act]') : null;
    if (!b || !boundEl || !boundEl.contains(b)) return;
    var act = b.getAttribute('data-act');
    if (act === 'group') setPrefs({ group: !getPrefs().group });
    else if (act === 'withdrawn') setPrefs({ showWithdrawn: !getPrefs().showWithdrawn });
    else if (act === 'columns') openColumnsMenu(b);
    else if (act === 'legend') toggleLegend(b);
    else if (act === 'add-student') addStudent();
    else if (act === 'paste-roster') { if (typeof GT.ui.openRosterPaste === 'function') GT.ui.openRosterPaste(); }
    else if (act === 'load-sample') { if (GT.app && GT.app.actions && GT.app.actions.loadSample) GT.app.actions.loadSample(); }
    else if (act === 'import') { if (GT.views.exchange && GT.app) GT.app.navigate('exchange'); }
    else if (act === 'weights') { if (GT.views.settings && GT.app) GT.app.navigate('settings', { section: 'assessments' }); }
    else if (act === 'sort') toggleSort(b.getAttribute('data-sort'));
    else if (act === 'team-score') editTeamScore(b.getAttribute('data-tid'), b.getAttribute('data-aid'));
    else if (act === 'details') {
      var tr = b.closest('tr[data-r]');
      var r = tr ? parseInt(tr.getAttribute('data-r'), 10) : NaN;
      if (!isNaN(r) && layout && layout.students[r] && typeof GT.ui.openStudent === 'function') GT.ui.openStudent(layout.students[r].id);
    }
  }

  function onChange(e) {
    if (editing && editing.kind === 'team' && e.target === editing.input && nowMs() - listboxPointerAt < 1500) commitEdit(null, {});
  }

  function onInput(e) {
    if (editing && e.target === editing.input) validateEditor();
  }

  function onFocusOut(e) {
    if (editing && e.target === editing.input) commitEdit(null, { soft: true });
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
    var handled = true;
    if (k === 'Enter' && !e.altKey) {
      e.preventDefault();
      if (mod && ed.kind !== 'team' && hasRange()) {
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
    } else if (ed.kind !== 'team' && k === 'F2') {
      e.preventDefault();
      ed.mode = ed.mode === 'enter' ? 'edit' : 'enter';
      ed.input.classList.toggle('mode-edit', ed.mode === 'edit');
    } else if (ed.kind !== 'team' && ed.mode === 'enter' && !mod && !e.altKey &&
      (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight')) {
      e.preventDefault();
      commitEdit(k === 'ArrowUp' ? 'up' : k === 'ArrowDown' ? 'down' : k === 'ArrowLeft' ? 'left' : 'right', {});
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
      if (e.altKey) return;
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
      if (editableAt(a)) startEdit('edit');
      else { tabStartKey = null; moveTo(a.r + (shift ? -1 : 1), a.c, false); }
      return;
    }
    if (k === 'F2') {
      e.preventDefault();
      if (editableAt(a)) startEdit('edit'); else notifyReadOnly();
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
      if (!editableAt(a)) { notifyReadOnly(); return; }
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
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (!isActiveView() || ui.isTypingTarget(e.target) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      focusSearch();
    });
  }

  GT.views.grades = {
    id: 'grades',
    title: 'Grades',
    render: render,
    destroy: destroy,
    /** Diagnostics for tests: duration of the last table build in ms. */
    lastRenderMs: function () { return lastRenderMs; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
