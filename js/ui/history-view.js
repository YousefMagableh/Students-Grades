/* Grade Tracker - History view (GT.views.history): the course's append-only change log (G5).
 * Newest first, filterable by kind group, source, student, free text and date range; the TA can add a
 * note to any entry (GT.store.annotateHistory) and export the filtered entries as CSV.
 * Browser only. Filters persist in GT.store.state.ui.historyPrefs.
 * Privacy: student names (and name/notes values) carry class "pii"; the student filter lists only the
 * student's No while privacy mode is on, because a native dropdown cannot be blurred. */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util;
  var ui = GT.ui = GT.ui || {};
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  var PAGE = 300;             // rows rendered per "page" (Show more adds another page)
  var NOTE_MAX = 1000;        // longest note the TA can attach to an entry
  var SEARCH_SAVE_MS = 350;   // debounce for persisting the search text

  var GROUPS = [
    { id: 'all', label: 'All' },
    { id: 'grades', label: 'Grades' },
    { id: 'students', label: 'Students & teams' },
    { id: 'settings', label: 'Settings' },
    { id: 'attendance', label: 'Attendance' },
    { id: 'other', label: 'Other' }
  ];
  var GROUP_IDS = GROUPS.map(function (g) { return g.id; });

  /** Used only when js/core/history.js is not loaded (it exports the same tables). */
  var FALLBACK_KIND_GROUPS = {
    grades: ['score', 'team-score', 'propagation', 'override', 'override-removed', 'late'],
    students: ['status', 'team-membership', 'student'],
    settings: ['settings'],
    attendance: ['attendance'],
    other: ['bulk']
  };
  var FALLBACK_KIND_LABELS = {
    'score': 'Score', 'team-score': 'Team score', 'propagation': 'Propagation', 'override': 'Override',
    'override-removed': 'Override removed', 'late': 'Late work', 'status': 'Status',
    'team-membership': 'Team', 'student': 'Student', 'settings': 'Settings', 'attendance': 'Attendance',
    'bulk': 'Bulk change'
  };

  /** Kind badge styles: each kind gets its own look (colors come from css/base.css tokens). */
  var KIND_STYLE = {
    'score': { cls: 'hk-score' },
    'team-score': { cls: 'hk-team-score', icon: 'users' },
    'propagation': { cls: 'badge-info', icon: 'layers' },
    'override': { cls: 'badge-accent', icon: 'diamond' },
    'override-removed': { cls: 'badge-accent hk-dashed', icon: 'diamond' },
    'late': { cls: 'hk-late', icon: 'clock' },
    'status': { cls: 'hk-status' },
    'team-membership': { cls: 'hk-team' },
    'student': { cls: 'hk-student' },
    'settings': { cls: 'hk-settings' },
    'attendance': { cls: 'badge-success', icon: 'calendar' },
    'bulk': { cls: 'hk-bulk' }
  };

  var SOURCE_INFO = {
    edit: { label: 'Edit', icon: 'edit' },
    paste: { label: 'Paste', icon: 'copy' },
    undo: { label: 'Undo', icon: 'undo', cls: 'hs-undo' },
    redo: { label: 'Redo', icon: 'redo', cls: 'hs-undo' },
    import: { label: 'Import', icon: 'upload' },
    restore: { label: 'Restore', icon: 'database' },
    sample: { label: 'Sample data', icon: 'layers' },
    roster: { label: 'Roster paste', icon: 'users' },
    system: { label: 'System', icon: 'settings' }
  };
  var SOURCE_ORDER = ['edit', 'paste', 'undo', 'redo', 'import', 'restore', 'sample', 'roster', 'system'];

  /** Field keys whose old/new values are student names or notes (pii). */
  var PII_FIELD_KEYS = { 'student.lastName': true, 'student.firstName': true, 'student.notes': true };
  var PII_FIELDS = { 'Last name': true, 'Last Name': true, 'First name': true, 'First Name': true, 'Notes': true };

  // ------------------------------------------------------------------ module state (per open view)

  var boundEl = null;        // the container the listeners are bound to
  var lastCtx = null;
  var cur = null;            // current filters; source of truth while the view is open
  var prefsObj = null;       // the ui.historyPrefs object cur was read from or last saved as
  var limit = PAGE;
  var lastCourseId = null;
  var lastParams = null;
  var lastBodyHtml = null;
  var lastStudentSig = null;
  var lastSourceSig = null;
  var visible = [];          // entries that match the filters (all pages), newest first
  var sortCache = { key: null, hist: null, list: [] };
  var docBound = false;
  var saveSearchLater = util.debounce(function () { persist(); }, SEARCH_SAVE_MS);

  // ------------------------------------------------------------------ helpers

  function icon(name, cls) { return ui.icon(name, cls); }
  function str(x) { return x === null || x === undefined ? '' : String(x); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fmtCount(n) {
    try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); }
  }
  function isDay(s) { return typeof s === 'string' && (util.isIsoDate ? util.isIsoDate(s) : /^\d{4}-\d{2}-\d{2}$/.test(s)); }
  function privacyOn() { var st = GT.store && GT.store.state; return !!(st && st.ui && st.ui.privacy); }

  function kindGroups() { return GT.history && GT.history.KIND_GROUPS ? GT.history.KIND_GROUPS : FALLBACK_KIND_GROUPS; }
  function kindLabel(kind) {
    var labels = GT.history && GT.history.KIND_LABELS ? GT.history.KIND_LABELS : FALLBACK_KIND_LABELS;
    return util.hasOwn(labels, kind) ? labels[kind] : (str(kind) || 'Change');
  }
  function groupOf(kind) {
    if (GT.history && GT.history.kindGroup) return GT.history.kindGroup(kind);
    var groups = kindGroups();
    var keys = Object.keys(groups);
    for (var i = 0; i < keys.length; i++) if (groups[keys[i]].indexOf(kind) !== -1) return keys[i];
    return 'other';
  }
  function sourceLabel(src) {
    return util.hasOwn(SOURCE_INFO, src) ? SOURCE_INFO[src].label : (str(src) || 'Unknown');
  }

  /** Local calendar day "YYYY-MM-DD" of an ISO timestamp (the date filter uses the computer's time zone). */
  function localDay(ts) {
    var d = new Date(ts);
    if (!ts || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function exportAvailable() {
    return !!(GT.csv && typeof GT.csv.stringify === 'function' && GT.history && typeof GT.history.toRows === 'function');
  }

  // ------------------------------------------------------------------ preferences (ui.historyPrefs)

  function normalizePrefs(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    return {
      group: GROUP_IDS.indexOf(r.group) !== -1 ? r.group : 'all',
      source: typeof r.source === 'string' ? r.source.slice(0, 40) : '',
      student: typeof r.student === 'string' ? r.student.slice(0, 80) : '',
      q: typeof r.q === 'string' ? r.q.slice(0, 200) : '',
      from: isDay(r.from) ? r.from : '',
      to: isDay(r.to) ? r.to : ''
    };
  }

  function storedPrefs() {
    var st = GT.store && GT.store.state;
    return st && st.ui ? st.ui.historyPrefs : null;
  }

  function readPrefs() {
    prefsObj = storedPrefs() || null;
    return normalizePrefs(prefsObj);
  }

  function persist() {
    saveSearchLater.cancel();
    if (!cur || !GT.store || !GT.store.setUi) return;
    var saved = normalizePrefs(storedPrefs());
    var same = Object.keys(cur).every(function (k) { return saved[k] === cur[k]; });
    if (same) return;
    prefsObj = normalizePrefs(cur);
    GT.store.setUi({ historyPrefs: prefsObj });
  }

  function filtersActive(studentValid) {
    return cur.group !== 'all' || cur.source !== '' || (studentValid && cur.student !== '') ||
      cur.q.trim() !== '' || cur.from !== '' || cur.to !== '';
  }

  // ------------------------------------------------------------------ data

  /** The course's history, newest first (sorted by timestamp, ties: later entry first). Cached. */
  function sortedEntries(course) {
    var hist = Array.isArray(course.history) ? course.history : [];
    var last = hist.length ? hist[hist.length - 1] : null;
    var key = course.id + '|' + hist.length + '|' + (last && last.id ? last.id : '');
    if (sortCache.key === key && sortCache.hist === hist) return sortCache.list;
    var list = [];
    for (var i = 0; i < hist.length; i++) {
      if (hist[i] && typeof hist[i] === 'object') list.push({ e: hist[i], i: i, ts: str(hist[i].ts) });
    }
    list.sort(function (a, b) {
      if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
      return b.i - a.i;
    });
    sortCache = { key: key, hist: hist, list: list.map(function (x) { return x.e; }) };
    return sortCache.list;
  }

  /** Student filter options: current students (name order) plus students that exist only in the history. */
  function studentOptions(course, entries) {
    var priv = privacyOn();
    var cmp = GT.calc && GT.calc.compareByName ? GT.calc.compareByName : function (a, b) {
      return util.compareText(a.lastName, b.lastName) || util.compareText(a.firstName, b.firstName);
    };
    var seen = Object.create(null);
    var out = course.students.slice().sort(cmp).map(function (s) {
      seen[s.id] = true;
      var no = typeof s.no === 'number' ? 'No ' + s.no : 'No number';
      var name = GT.model && GT.model.studentName ? GT.model.studentName(s) : str(s.lastName) + ', ' + str(s.firstName);
      var label = priv ? no : no + ' · ' + (name || '(no name)');
      if (s.status === 'withdrawn') label += ' (withdrawn)';
      return { id: s.id, label: label };
    });
    var gone = [];
    entries.forEach(function (e) {
      if (!e.studentId || seen[e.studentId]) return;
      seen[e.studentId] = true;
      gone.push({ id: e.studentId, name: str(e.studentName) });
    });
    gone.sort(function (a, b) { return util.compareText(a.name, b.name); });
    gone.forEach(function (g, i) {
      out.push({ id: g.id, label: priv ? 'Deleted student ' + (i + 1) : (g.name || '(no name)') + ' (deleted)' });
    });
    return out;
  }

  function sourceOptions(entries) {
    var present = Object.create(null);
    entries.forEach(function (e) { present[str(e.source)] = true; });
    if (cur.source) present[cur.source] = true;
    var list = SOURCE_ORDER.filter(function (s) { return present[s]; });
    Object.keys(present).sort().forEach(function (s) {
      if (s && list.indexOf(s) === -1) list.push(s);
    });
    return list;
  }

  function haystack(e) {
    return [e.studentName, e.teamName, e.field, e.oldValue, e.newValue, e.note, e.userNote,
      kindLabel(e.kind), e.kind, sourceLabel(e.source), e.source].map(str).join('\n').toLowerCase();
  }

  /** Every filter except the kind group (so the group buttons can show counts). */
  function matcher(studentId) {
    var tokens = cur.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var from = cur.from, to = cur.to, source = cur.source;
    return function (e) {
      if (source && str(e.source) !== source) return false;
      if (studentId && e.studentId !== studentId) return false;
      if (from || to) {
        var day = localDay(e.ts);
        if (!day) return false;
        if (from && day < from) return false;
        if (to && day > to) return false;
      }
      if (tokens.length) {
        var h = haystack(e);
        for (var i = 0; i < tokens.length; i++) if (h.indexOf(tokens[i]) === -1) return false;
      }
      return true;
    };
  }

  function findEntry(course, id) {
    var hist = course && Array.isArray(course.history) ? course.history : [];
    for (var i = hist.length - 1; i >= 0; i--) if (hist[i] && hist[i].id === id) return hist[i];
    return null;
  }

  // ------------------------------------------------------------------ HTML pieces

  function kindBadge(kind) {
    var st = util.hasOwn(KIND_STYLE, kind) ? KIND_STYLE[kind] : { cls: 'hk-bulk' };
    return '<span class="badge hist-kind ' + st.cls + '">' + (st.icon ? icon(st.icon) : '') + esc(kindLabel(kind)) + '</span>';
  }

  function sourceBadge(src) {
    var info = util.hasOwn(SOURCE_INFO, src) ? SOURCE_INFO[src] : { label: str(src) || 'Unknown' };
    return '<span class="badge hist-src' + (info.cls ? ' ' + info.cls : '') + '">' + (info.icon ? icon(info.icon) : '') +
      esc(info.label) + '</span>';
  }

  function isPiiValue(e) {
    return util.hasOwn(PII_FIELD_KEYS, str(e.fieldKey)) || (!!e.studentId && util.hasOwn(PII_FIELDS, str(e.field)));
  }

  /** Old -> new, compact: the old value is struck through and muted. */
  function changeHtml(e) {
    var o = str(e.oldValue), n = str(e.newValue);
    if (o === '' && n === '') return '<span class="faint">—</span>';
    var pii = isPiiValue(e) ? ' pii' : '';
    var newHtml = n === ''
      ? '<span class="hist-new hist-empty"><span class="sr-only">to </span>empty</span>'
      : '<span class="hist-new' + pii + '"><span class="sr-only">to </span>' + esc(n) + '</span>';
    if (o === '') {
      // "empty -> 90" is useful for a student's or team's value; elsewhere (added items, summaries) show just the new value.
      var g = groupOf(e.kind);
      if ((g !== 'grades' && g !== 'attendance') || (!e.studentId && !e.teamId)) return newHtml;
      return '<span class="hist-old hist-empty"><span class="sr-only">from </span>empty</span>' +
        '<span class="hist-arrow" aria-hidden="true">→</span>' + newHtml;
    }
    return '<span class="hist-old' + pii + '"><span class="sr-only">from </span>' + esc(o) + '</span>' +
      '<span class="hist-arrow" aria-hidden="true">→</span>' + newHtml;
  }

  function whoHtml(e) {
    if (e.studentId || str(e.studentName) !== '') {
      var name = str(e.studentName);
      return '<span class="pii hist-name">' + (name ? esc(name) : '<em class="faint">(no name)</em>') + '</span>' +
        (e.teamName ? '<span class="hist-sub">' + esc(e.teamName) + '</span>' : '');
    }
    if (str(e.teamName) !== '') {
      return '<span class="hist-team">' + icon('users', 'icon-sm') + esc(e.teamName) + '</span>';
    }
    return '<span class="faint">Course</span>';
  }

  function userNoteHtml(e) {
    var id = esc(e.id);
    if (str(e.userNote) !== '') {
      var at = e.userNoteAt ? 'Note added ' + ui.dateTime(e.userNoteAt) : 'Your note';
      return '<div class="hist-un" title="' + esc(at) + '">' +
        '<span class="hist-un-icon" aria-hidden="true">' + icon('note') + '</span>' +
        '<span class="pii hist-un-text">' + esc(e.userNote) + '</span>' +
        '<button type="button" class="btn btn-ghost btn-icon btn-sm hist-un-edit" data-act="note" data-id="' + id + '" ' +
        'aria-label="Edit your note" title="Edit your note">' + icon('edit') + '</button></div>';
    }
    return '<button type="button" class="btn btn-ghost btn-sm hist-add-note" data-act="note" data-id="' + id + '" ' +
      'title="Record why this changed (for example: per instructor email, Oct 12)">' + icon('plus') + 'Add note</button>';
  }

  function rowHtml(e) {
    var ts = str(e.ts);
    var note = str(e.note);
    return '<tr data-id="' + esc(e.id) + '">' +
      '<td class="hc-when"><time datetime="' + esc(ts) + '" title="' + esc(ts) + '">' + esc(ui.dateTime(ts) || ts || '—') + '</time></td>' +
      '<td class="hc-who">' + whoHtml(e) + '</td>' +
      '<td class="hc-field">' + (e.field ? esc(e.field) : '<span class="faint">—</span>') + '</td>' +
      '<td class="hc-change">' + changeHtml(e) + '</td>' +
      '<td class="hc-kind">' + kindBadge(e.kind) + '</td>' +
      '<td class="hc-src">' + sourceBadge(e.source) + '</td>' +
      '<td class="hc-note">' + (note ? '<span class="hist-note" title="' + esc(note) + '">' + esc(note) + '</span>' : '') + '</td>' +
      '<td class="hc-user">' + userNoteHtml(e) + '</td>' +
      '</tr>';
  }

  function skeletonHtml() {
    var groups = GROUPS.map(function (g) {
      return '<button type="button" data-act="group" data-group="' + g.id + '" aria-pressed="false">' + esc(g.label) +
        '<span class="hist-seg-count" data-count="' + g.id + '"></span></button>';
    }).join('');
    return '' +
      '<div class="page-header">' +
        '<div><h1>Change history</h1><div class="sub" data-ref="sub"></div></div>' +
        '<div class="toolbar"><button type="button" class="btn" data-act="export">' + icon('download') + 'Export CSV</button></div>' +
      '</div>' +
      '<p class="muted hist-explain">' + icon('info') + '<span>This log is append-only: every change is kept with its time and source. ' +
        'Undo and redo add new entries and never erase old ones. Add your own note to any entry to record why a grade changed.</span></p>' +
      '<section class="card hist-filters" aria-label="History filters"><div class="card-body">' +
        '<div class="hist-filter-row">' +
          '<div class="segmented hist-groups" role="group" aria-label="Kind of change">' + groups + '</div>' +
        '</div>' +
        '<div class="hist-filter-row">' +
          '<div class="field hist-f-search"><label for="hv-q">Search</label>' +
            '<div class="search">' + icon('search') + '<input type="search" id="hv-q" data-ref="q" placeholder="Field, value, note…" autocomplete="off" spellcheck="false"></div></div>' +
          '<div class="field"><label for="hv-source">Source</label><select id="hv-source" data-ref="source"></select></div>' +
          '<div class="field hist-f-student"><label for="hv-student">Student</label><select id="hv-student" data-ref="student"></select></div>' +
          '<div class="field"><label for="hv-from">From</label><input type="date" id="hv-from" data-ref="from"></div>' +
          '<div class="field"><label for="hv-to">To</label><input type="date" id="hv-to" data-ref="to"></div>' +
          '<button type="button" class="btn btn-ghost btn-sm hist-clear" data-act="clear">' + icon('x') + 'Clear filters</button>' +
        '</div>' +
      '</div></section>' +
      '<div class="hist-count" data-ref="count" role="status" aria-live="polite"></div>' +
      '<div class="table-wrap hist-wrap" data-ref="wrap"><table class="table hist-table">' +
        '<caption class="sr-only">Change history, newest first</caption>' +
        '<thead><tr>' +
          '<th scope="col" class="hc-when">When</th><th scope="col" class="hc-who">Student / Team</th>' +
          '<th scope="col" class="hc-field">Field</th><th scope="col" class="hc-change">Old → New</th>' +
          '<th scope="col" class="hc-kind">Kind</th><th scope="col" class="hc-src">Source</th>' +
          '<th scope="col" class="hc-note">Note</th><th scope="col" class="hc-user">Your note</th>' +
        '</tr></thead><tbody data-ref="tbody"></tbody></table></div>' +
      '<div class="hist-empty-host" data-ref="empty"></div>' +
      '<div class="hist-more" data-ref="more"></div>';
  }

  // ------------------------------------------------------------------ rendering

  function ref(name) { return boundEl ? boundEl.querySelector('[data-ref="' + name + '"]') : null; }

  function setIfIdle(el, value) {
    if (el && document.activeElement !== el && el.value !== value) el.value = value;
  }

  /** Rebuilds a select's options only when they changed and the user is not using the control.
   *  Returns the signature now shown (the old one when the rebuild had to wait). */
  function syncSelect(el, options, value, sig, lastSig) {
    if (sig !== lastSig) {
      if (document.activeElement === el) return lastSig;
      el.innerHTML = options.map(function (o) {
        return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
      }).join('');
      el.value = value;
      return sig;
    }
    if (document.activeElement !== el && el.value !== value) el.value = value;
    return sig;
  }

  function update() {
    if (!boundEl || !lastCtx) return;
    var course = lastCtx.course;
    var sub = ref('sub');
    if (!course) {
      sub.textContent = '';
      ref('tbody').innerHTML = '';
      lastBodyHtml = '';
      ref('wrap').hidden = true;
      setHtml(ref('count'), '');
      setHtml(ref('more'), '');
      setHtml(ref('empty'), '<div class="empty-state"><h2>No course selected</h2><p>Add or select a course to see its change history.</p></div>');
      lastCourseId = null;
      boundEl.querySelector('.hist-filters').hidden = true;
      visible = [];
      syncExport();
      return;
    }
    boundEl.querySelector('.hist-filters').hidden = false;
    if (course.id !== lastCourseId) {
      lastCourseId = course.id;
      limit = PAGE;
    }
    sub.textContent = (GT.model && GT.model.courseLabel ? GT.model.courseLabel(course) : str(course.code)) +
      (course.term ? ' · ' + course.term : '');

    var all = sortedEntries(course);

    // Student and source selects.
    var studs = studentOptions(course, all);
    var studentValid = cur.student !== '' && studs.some(function (o) { return o.id === cur.student; });
    var studentValue = studentValid ? cur.student : '';
    var studentSel = ref('student');
    var sOpts = [{ value: '', label: 'All students' }].concat(studs.map(function (o) { return { value: o.id, label: o.label }; }));
    var sSig = sOpts.map(function (o) { return o.value + '\u0001' + o.label; }).join('\u0002');
    lastStudentSig = syncSelect(studentSel, sOpts, studentValue, sSig, lastStudentSig);
    // Names appear in the options only while privacy mode is off.
    studentSel.classList.toggle('pii', !privacyOn());

    var srcs = sourceOptions(all);
    var srcOpts = [{ value: '', label: 'All sources' }].concat(srcs.map(function (s) { return { value: s, label: sourceLabel(s) }; }));
    var srcSig = srcOpts.map(function (o) { return o.value; }).join('\u0002');
    lastSourceSig = syncSelect(ref('source'), srcOpts, cur.source, srcSig, lastSourceSig);

    setIfIdle(ref('q'), cur.q);
    var fromEl = ref('from'), toEl = ref('to');
    setIfIdle(fromEl, cur.from);
    setIfIdle(toEl, cur.to);
    if (cur.to) fromEl.max = cur.to; else fromEl.removeAttribute('max');
    if (cur.from) toEl.min = cur.from; else toEl.removeAttribute('min');

    // Filter: everything but the group first (for the group counts), then the group.
    var base = all.filter(matcher(studentValue));
    var counts = { all: base.length };
    GROUP_IDS.forEach(function (g) { if (g !== 'all') counts[g] = 0; });
    base.forEach(function (e) {
      var g = groupOf(e.kind);
      counts[util.hasOwn(counts, g) ? g : 'other']++;
    });
    GROUPS.forEach(function (g) {
      var btn = boundEl.querySelector('[data-act="group"][data-group="' + g.id + '"]');
      btn.setAttribute('aria-pressed', cur.group === g.id ? 'true' : 'false');
      var c = btn.querySelector('.hist-seg-count');
      var txt = fmtCount(counts[g.id] || 0);
      if (c.textContent !== txt) c.textContent = txt;
    });
    visible = cur.group === 'all' ? base : base.filter(function (e) { return groupOf(e.kind) === cur.group; });
    var shown = visible.slice(0, limit);

    // Table body (only touched when its content changed, keeping focus on the same button).
    var html = shown.map(rowHtml).join('');
    var tbody = ref('tbody');
    if (html !== lastBodyHtml) {
      var act = document.activeElement;
      var keep = act && tbody.contains(act) && act.getAttribute('data-act')
        ? { act: act.getAttribute('data-act'), id: act.getAttribute('data-id') } : null;
      tbody.innerHTML = html;
      lastBodyHtml = html;
      if (keep) {
        var again = tbody.querySelector('[data-act="' + keep.act + '"][data-id="' + cssEscape(keep.id) + '"]') ||
          tbody.querySelector('tr[data-id="' + cssEscape(keep.id) + '"] [data-act="note"]');
        if (again) again.focus();
      }
    }
    ref('wrap').hidden = shown.length === 0;

    // Count line, empty states, Show more.
    var active = filtersActive(studentValid);
    boundEl.querySelector('.hist-clear').hidden = !active;
    var count = ref('count');
    var empty = ref('empty');
    var rangeWarn = cur.from && cur.to && cur.from > cur.to
      ? ' <span class="hist-warn">' + icon('alert', 'icon-sm') + 'The From date is after the To date.</span>' : '';
    if (!all.length) {
      setHtml(count, '');
      setHtml(empty, '<div class="empty-state"><h2>No changes recorded yet</h2>' +
        '<p>Every change to this course (scores, team scores, overrides, students, teams, settings and attendance) will appear here, newest first.</p></div>');
    } else if (!visible.length) {
      setHtml(count, '<span>Showing 0 of ' + fmtCount(all.length) + ' changes.</span>' + rangeWarn);
      setHtml(empty, '<div class="empty-state hist-none"><h2>No changes match these filters</h2>' +
        '<div class="actions"><button type="button" class="btn" data-act="clear">' + icon('x') + 'Clear filters</button></div></div>');
    } else {
      setHtml(empty, '');
      var txt = 'Showing <strong>' + fmtCount(shown.length) + '</strong> of <strong>' + fmtCount(visible.length) + '</strong> ' +
        (active ? 'matching changes' : (visible.length === 1 ? 'change' : 'changes'));
      if (active) txt += ' <span class="faint">(' + fmtCount(all.length) + ' in total)</span>';
      setHtml(count, '<span>' + txt + '.</span>' + rangeWarn);
    }
    var more = ref('more');
    var remaining = visible.length - shown.length;
    var moreHtml = remaining > 0
      ? '<button type="button" class="btn" data-act="more">' + icon('chevron-down') + 'Show more</button>' +
        '<span class="muted small">' + fmtCount(remaining) + ' older ' + (remaining === 1 ? 'change' : 'changes') + ' not shown yet' +
        (remaining > PAGE ? ' (' + fmtCount(PAGE) + ' more per click)' : '') + '</span>'
      : '';
    var hadFocus = more.contains(document.activeElement);
    if (setHtml(more, moreHtml)) {
      if (hadFocus) {
        var b = more.querySelector('button');
        if (b) b.focus();
        else if (tbody.lastElementChild) {
          var last = tbody.lastElementChild.querySelector('[data-act="note"]');
          if (last) last.focus();
        }
      }
    }
    syncExport();
  }

  /** Sets innerHTML only when the markup changed (compares with what was last set, not the serialized DOM). */
  function setHtml(el, html) {
    if (el.__gtHtml === html) return false;
    el.innerHTML = html;
    el.__gtHtml = html;
    return true;
  }

  function cssEscape(s) {
    var v = str(s);
    if (root.CSS && root.CSS.escape) return root.CSS.escape(v);
    return v.replace(/["\\]/g, '\\$&');
  }

  function syncExport() {
    var btn = boundEl && boundEl.querySelector('[data-act="export"]');
    if (!btn) return;
    var ok = exportAvailable();
    var n = visible.length;
    btn.disabled = !ok || n === 0;
    btn.title = !ok ? 'CSV export is not available (the CSV or history module did not load).'
      : n === 0 ? 'Nothing to export: no changes match the filters.'
        : 'Download the ' + plural(n, 'change') + ' that match the filters as a CSV file (all pages, newest first).';
  }

  // ------------------------------------------------------------------ actions

  function changeFilter(patch, persistNow) {
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    limit = PAGE;
    update();
    if (persistNow) persist(); else saveSearchLater();
  }

  function clearFilters() {
    changeFilter({ group: 'all', source: '', student: '', q: '', from: '', to: '' }, true);
    var q = ref('q');
    if (q) q.focus();
  }

  function doExport() {
    var course = GT.store.course();
    if (!course) return;
    if (!exportAvailable()) {
      ui.toast('CSV export is not available: the CSV or history module did not load. Reload the page and try again.', { type: 'error' });
      return;
    }
    var list = visible.slice();
    if (!list.length) { ui.toast('Nothing to export: no changes match the filters.', { type: 'warn' }); return; }
    var text;
    try {
      text = GT.csv.stringify(GT.history.toRows(list), { bom: true });
    } catch (err) {
      ui.toast('Could not create the CSV file: ' + (err && err.message ? err.message : String(err)), { type: 'error' });
      return;
    }
    var name = 'grade-history-' + ui.slug(course.code) + '-' + ui.fileStamp() + '.csv';
    ui.download(name, text, 'text/csv;charset=utf-8');
    ui.toast('Exported ' + plural(list.length, 'change') + ' to ' + name + '.', { type: 'success' });
  }

  function noteDialogIntro(e) {
    var who = '';
    if (e.studentId || e.studentName) who = '<span class="pii">' + esc(str(e.studentName) || '(no name)') + '</span>';
    else if (e.teamName) who = esc(e.teamName);
    return '<div class="hist-dlg-summary">' +
      '<div class="hist-dlg-meta"><time datetime="' + esc(e.ts) + '">' + esc(ui.dateTime(e.ts)) + '</time>' +
        kindBadge(e.kind) + sourceBadge(e.source) + '</div>' +
      '<div class="hist-dlg-what">' + (who ? who + ' · ' : '') + '<strong>' + esc(e.field || 'Change') + '</strong></div>' +
      '<div class="hist-dlg-change">' + changeHtml(e) + '</div>' +
      (e.note ? '<div class="hist-dlg-note small muted">' + esc(e.note) + '</div>' : '') +
      '</div>';
  }

  function editNote(id) {
    var course = GT.store.course();
    var e = findEntry(course, id);
    if (!e) { ui.toast('This history entry no longer exists.', { type: 'warn' }); return; }
    if (!GT.store.annotateHistory) { ui.toast('Notes are not available in this version.', { type: 'error' }); return; }
    var had = str(e.userNote) !== '';
    ui.dialog.form({
      title: had ? 'Edit your note' : 'Add a note to this change',
      introHtml: noteDialogIntro(e),
      fields: [{
        name: 'note', label: 'Your note', type: 'textarea', rows: 4, pii: true, value: str(e.userNote),
        placeholder: 'For example: Changed per instructor email, Oct 12',
        help: 'Saved with this entry (in backups and the CSV export). The change itself is not modified. Leave empty to remove the note.'
      }],
      confirmText: 'Save note',
      validate: function (v) {
        return str(v.note).trim().length > NOTE_MAX ? 'Keep the note under ' + NOTE_MAX + ' characters.' : null;
      }
    }).then(function (v) {
      if (!v) return;
      var text = str(v.note).trim();
      if (text === str(e.userNote)) return;
      GT.store.annotateHistory(id, text);
      ui.toast(text ? 'Note saved.' : 'Note removed.', { type: 'success' });
    });
  }

  // ------------------------------------------------------------------ events

  function bind(el) {
    el.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!t || !el.contains(t) || t.disabled) return;
      var act = t.getAttribute('data-act');
      if (act === 'group') changeFilter({ group: t.getAttribute('data-group') }, true);
      else if (act === 'clear') clearFilters();
      else if (act === 'export') doExport();
      else if (act === 'note') editNote(t.getAttribute('data-id'));
      else if (act === 'more') { limit += PAGE; update(); }
    });
    el.addEventListener('input', function (ev) {
      var r = ev.target.getAttribute && ev.target.getAttribute('data-ref');
      if (r === 'q') changeFilter({ q: ev.target.value.slice(0, 200) }, false);
    });
    el.addEventListener('change', function (ev) {
      var r = ev.target.getAttribute && ev.target.getAttribute('data-ref');
      if (r === 'source' || r === 'student') changeFilter(r === 'source' ? { source: ev.target.value } : { student: ev.target.value }, true);
      else if (r === 'from' || r === 'to') {
        var v = isDay(ev.target.value) ? ev.target.value : '';
        changeFilter(r === 'from' ? { from: v } : { to: v }, true);
      } else if (r === 'q') persist();
    });
    el.addEventListener('keydown', function (ev) {
      var r = ev.target.getAttribute && ev.target.getAttribute('data-ref');
      if (r === 'q' && ev.key === 'Escape' && ev.target.value !== '') {
        ev.preventDefault();
        ev.stopPropagation();
        ev.target.value = '';
        changeFilter({ q: '' }, true);
      }
    });
  }

  function bindDocOnce() {
    if (docBound) return;
    docBound = true;
    // "/" focuses the search box while the History view is open.
    document.addEventListener('keydown', function (ev) {
      if (!boundEl || !document.body.contains(boundEl)) return;
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ui.isTypingTarget && ui.isTypingTarget(ev.target)) return;
      if (document.querySelector('dialog[open]')) return;
      var q = ref('q');
      if (q && !q.closest('[hidden]')) { ev.preventDefault(); q.focus(); q.select(); }
    });
  }

  // ------------------------------------------------------------------ view

  function render(el, ctx) {
    lastCtx = ctx;
    if (el !== boundEl) {
      boundEl = el;
      cur = readPrefs();
      limit = PAGE;
      lastCourseId = null;
      lastBodyHtml = null;
      lastStudentSig = null;
      lastSourceSig = null;
      el.innerHTML = skeletonHtml();
      bind(el);
      bindDocOnce();
    }
    // Preferences replaced from outside (restore from backup, delete all data): start from them.
    var stored = storedPrefs() || null;
    if (stored !== prefsObj && !saveSearchLater.pending()) {
      cur = readPrefs();
      limit = PAGE;
    }
    // navigate('history', { studentId }) opens the log filtered to one student.
    var p = ctx.params;
    if (p && p !== lastParams) {
      lastParams = p;
      if (typeof p.studentId === 'string' && p.studentId) {
        cur = normalizePrefs({ group: 'all', student: p.studentId });
        limit = PAGE;
        setTimeout(persist, 0);
      }
    }
    update();
  }

  function destroy() {
    if (saveSearchLater.pending()) persist();
    lastBodyHtml = null;
  }

  GT.views.history = {
    id: 'history',
    title: 'History',
    render: render,
    destroy: destroy
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
