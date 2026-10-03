/* Grade Tracker - Import / Export view (GT.views.exchange, tab "Import / Export"). STAGE4 section 3.
 *
 * Export card: a preset (built-in or the TA's own, stored in course.exportPresets through a transact with
 * historyMode 'none'), a column picker (checkboxes, reorder with the up/down buttons, Alt+Up/Down or drag and
 * drop; columns that are not available are shown disabled with the reason), row order and extra sheets,
 * the pre-export data check (GT.exporter.dataCheck, never blocking), "Download Excel (.xlsx)" (ExcelJS is
 * loaded on demand through GT.ui.loadExcel) and "Download CSV", and the confidentiality reminder.
 *
 * Import card: a stepper. 1 choose a file (.xlsx or .csv; .xls and other formats get a plain explanation),
 * 2 sheet + header row (auto-detected) + preview, 3 match columns (guessed by GT.importer.guessMapping) and
 * options, 4 preview the changes, then Import = ONE GT.store.transact('Import <file>', …, { source:
 * 'import' }), so one Undo reverts the whole import and the History tab logs every change.
 *
 * The core modules (GT.exporter, GT.importer) are guarded: without them the cards say so, never crash.
 * Browser only. Student names carry class "pii". Options persist in GT.store.state.ui.exchangePrefs. */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util;
  var model = GT.model;
  var ui = GT.ui = GT.ui || {};
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  var MAX_FILE_BYTES = 25 * 1024 * 1024;  // a grade sheet is a few KB; this only stops a wrong file
  var MAX_ROWS = 5000;
  var MAX_COLS = 200;
  var PREVIEW_ROWS = 8;                   // data rows shown under the header row (step 2)
  var HEADER_CHOICES = 20;                // rows offered as the header row
  var SAMPLE_VALUES = 3;                  // sample values per column (step 3)
  var CHANGE_LIMIT = 50;                  // changes listed in the preview (step 4)
  var SKIP_LIMIT = 100;                   // skipped rows listed in the preview
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var DEFAULT_PRESET = 'builtin:previous';

  var XLS_HELP = 'Open it in Excel and use Save As \u2192 Excel Workbook (.xlsx), then import that file.';
  /** Saving again keeps a password, so an encrypted workbook needs the password removed first. */
  var PASSWORD_HELP = 'Open it in Excel, type the password, then choose File \u2192 Info \u2192 Protect Workbook \u2192 Encrypt with Password ' +
    '(on a Mac: File \u2192 Passwords), clear the password, press OK and save. Then import the file again.';

  /** Import targets whose values are student names or notes (sample values are pii). */
  var PII_TARGETS = { lastName: true, firstName: true, fullName: true, notes: true };
  var ATTENDANCE_TARGETS = { absent: true, excused: true, absencesTotal: true };
  var ATTENDANCE_MODE_LABELS = { off: 'Off', 'per-session': 'Per session', totals: 'Totals only' };
  var STUDENT_TARGETS = { no: true, lastName: true, firstName: true, fullName: true, team: true, status: true, notes: true };

  /** Labels for the plan's counts, in display order. An unknown numeric count gets its key spelled out in
   * words (countWords), never the raw key. */
  var COUNT_INFO = [
    { key: 'update', label: 'students updated', one: 'student updated', icon: 'user' },
    { key: 'new', label: 'new students', one: 'new student', icon: 'plus' },
    { key: 'changes', label: 'changes', one: 'change', icon: 'edit' },
    { key: 'unchanged', label: 'students already up to date', one: 'student already up to date', icon: 'check' },
    { key: 'skip', label: 'rows skipped', one: 'row skipped', icon: 'x', warn: true },
    { key: 'kept', label: 'existing values kept', one: 'existing value kept', icon: 'info',
      help: 'The file has another value, but "Replace scores that are already entered" is off, so Grade Tracker keeps what it has.' },
    { key: 'propagated', label: 'teammates updated through their team score', one: 'teammate updated through the team score', icon: 'users',
      help: 'Students who are not in the file, but whose team score (Project I, Project II…) changes because their teammates are.' },
    { key: 'overrides', label: 'team overrides', one: 'team override', icon: 'diamond',
      help: 'Team members whose score differs from the rest of their team keep it as a per-member override.' },
    { key: 'invalid', label: 'values that could not be read', one: 'value that could not be read', icon: 'alert', warn: true,
      help: 'Text in a score column is stored as entered, highlighted in red and counted as 0, like a typo in the grid; other cells that cannot be read are left out. Each one is listed under "Values to check".' },
    { key: 'notOnList', label: 'values not on the drop-down list', one: 'value not on the drop-down list', icon: 'alert', warn: true,
      help: 'Imported anyway (nothing is lost) and highlighted in the grid.' },
    { key: 'blocked', label: 'score changes blocked (scores are finalized)', one: 'score change blocked (scores are finalized)', icon: 'lock', warn: true,
      help: 'Unlock the scores in the Grades tab first to import them.' },
    { key: 'lettersSkipped', label: 'final letters not in the scale', one: 'final letter not in the scale', icon: 'alert', warn: true },
    { key: 'duplicateNos', label: 'No values already in use', one: 'No value already in use', icon: 'alert', warn: true,
      help: 'Every student keeps a different No: a No from the file that another student already has is not given (a new student gets the next free No). Each one is listed under "Values to check".' },
    { key: 'totalsDiffer', label: 'totals that differ from the file', one: 'total that differs from the file', icon: 'alert', warn: true,
      help: 'The file\'s Total is not the total the imported scores give here. Check for missing score or weeks-late columns, and the weights, curve and rounding in Settings. Each one is listed under "Values to check".' },
    { key: 'lettersAsSuggestion', label: 'letters kept as suggestions', one: 'letter kept as a suggestion', icon: 'info',
      help: 'The file comes from Grade Tracker: its letters that are only the suggestion from the cutoffs are not stored as final letters.' },
    { key: 'lettersFromOtherColumn', label: 'final letters taken from another letter column', one: 'final letter taken from another letter column', icon: 'info',
      help: 'The file comes from Grade Tracker and has more than one letter column. A letter changed after the export in "Letter Grade" (or "Suggested Letter (cutoffs)") is imported when the student\'s "Final Letter" cell is empty.' },
    { key: 'lettersNotImported', label: 'final letters not imported', one: 'final letter not imported', icon: 'alert', warn: true,
      help: 'A letter changed in the file after the export, or marked as a final letter, is not imported: it differs from the column final letters are read from, or no column is set to "Final letter". Each one is listed under "Values to check"; set the right letter in the Grades tab.' },
    { key: 'teamsCreated', label: 'new teams', one: 'new team', icon: 'users',
      help: 'Team names from the file that are not in this course ("2", "Team 02" and "Group 2" already count as "Team 2").' },
    { key: 'scoresEmptied', label: 'team scores emptied by a team move', one: 'team score emptied by a team move', icon: 'alert', warn: true,
      help: 'Students who move to a team that has no score yet for a team-graded item (Project I, Project II…) lose that score until the new team gets one. Each one is marked "emptied by the team move" below.' }
  ];

  // Small icons that GT.ui.icon does not have.
  var LOCAL_ICONS = {
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
    sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>'
  };

  // ------------------------------------------------------------------ module state

  var boundEl = null;
  var dom = null;             // { head, expBody, impBody, live }
  var lastCourseId = null;
  var dataDirty = true;
  var regionHtml = {};        // last markup written to each region (see patch)
  var expByCourse = {};       // courseId -> { presetId, list: [{ key, on }], catalogSig, edited }
  var busy = null;            // 'xlsx' while an Excel file is being built
  var expStatus = null;       // { kind: 'busy'|'ok'|'error', text, lib }
  var checkCache = { key: null, value: null };
  var drag = null;            // { key } while a column is dragged
  var imp = freshImport();
  var loadSeq = 0;
  var focusStepHeading = false;

  function freshImport() {
    return {
      step: 1,                // 1 file, 2 sheet/header, 3 mapping, 4 preview, 5 done
      courseId: null,
      loading: false,
      error: null,            // { title, html } shown on step 1
      notice: null,           // text shown on top of the current step (e.g. course changed)
      fileName: '',
      fileSize: 0,
      kind: '',               // 'xlsx' | 'csv'
      sheets: [],             // [{ name, hidden, rows: string[][], formulaColumns: number[], finalLetterCells: [[row, col]]|null, editedLetterCells: [[row, col]]|null }]
      sheetIndex: 0,
      headerIndex: 0,         // -1: the file has no header row (row 1 is a student)
      headerAuto: 0,
      headerKnown: {},        // column index -> true when its header cell is not a possible student name (see remap)
      mapping: [],
      options: { matchBy: 'name', createMissing: true, emptyCells: 'keep', overwrite: true, switchAttendanceToTotals: false, updateNames: false },
      plan: null,
      planError: null,
      planKey: null,
      result: null            // { counts, summary, label } after the import
    };
  }

  // ------------------------------------------------------------------ helpers

  function str(x) { return x === null || x === undefined ? '' : String(x); }
  /** Logs a program error. A save conflict (err.conflict: another tab saved newer data) is not one: the
   * store's message is shown to the user instead. */
  function logErr(e) { if (root.console && !(e && e.conflict)) console.error(e); }
  /** A failure the page explains to the user (missing library, unreadable file): a warning, not an error. */
  function logHandled(e) { if (root.console) console.warn(errText(e)); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  /** A count key that COUNT_INFO does not know, in words ("someNewCount" -> "some new count"). */
  function countWords(key) {
    var s = str(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    return s || 'other';
  }
  function errText(e) { return e && e.message ? e.message : String(e); }
  function privacyOn() { var st = GT.store && GT.store.state; return !!(st && st.ui && st.ui.privacy); }
  function icon(name, cls) {
    if (LOCAL_ICONS[name]) {
      return '<svg class="icon ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + LOCAL_ICONS[name] + '</svg>';
    }
    return ui.icon(name, cls);
  }
  /** A short note line: icon + html (already escaped by the caller). */
  function note(iconName, html, cls, role) {
    return '<p class="xc-note' + (cls ? ' ' + cls : '') + '"' + (role ? ' role="' + role + '"' : '') + '>' + icon(iconName, 'icon-sm') + '<span>' + html + '</span></p>';
  }
  function spinner() { return '<span class="xc-spinner" aria-hidden="true"></span>'; }
  function fmtCount(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }
  function fmtBytes(n) {
    if (!(n >= 0)) return '';
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return Math.round(n / 102.4) / 10 + ' KB';
    return Math.round(n / 104857.6) / 10 + ' MB';
  }
  /** Spreadsheet column letter: 0 -> A, 25 -> Z, 26 -> AA. */
  function colLetter(i) {
    var s = '';
    var n = i + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function localDate(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return str(iso);
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function isFinalized(course) {
    try { return !!(model.isFinalized && model.isFinalized(course)); } catch (e) { return false; }
  }
  function attendanceMode(course) {
    var m = course && course.attendance ? course.attendance.mode : 'off';
    return m === 'per-session' || m === 'totals' ? m : 'off';
  }

  function exporterReady() {
    var x = typeof GT.exporter !== 'undefined' ? GT.exporter : null;
    return !!(x && typeof x.columnsFor === 'function' && typeof x.builtInPresets === 'function');
  }
  function importerReady() {
    var x = typeof GT.importer !== 'undefined' ? GT.importer : null;
    return !!(x && typeof x.plan === 'function' && typeof x.apply === 'function' && typeof x.guessMapping === 'function' &&
      typeof x.targetsFor === 'function');
  }
  /** Calls GT.exporter / GT.importer; any problem gives `dflt` (logged), never an exception. */
  function safeCall(mod, name, args, dflt) {
    var m = typeof GT[mod] !== 'undefined' ? GT[mod] : null;
    if (!m || typeof m[name] !== 'function') return dflt;
    try {
      var v = m[name].apply(m, args);
      return v === undefined || v === null ? dflt : v;
    } catch (e) { logErr(e); return dflt; }
  }

  function announce(text) {
    if (!dom || !dom.live) return;
    dom.live.textContent = '';
    setTimeout(function () { if (dom && dom.live) dom.live.textContent = text; }, 30);
  }

  /** Focus target for a control after its region is rebuilt: its data-* identity (or id). */
  function focusSelector(el) {
    if (!el || !el.tagName) return null;
    // The data-* identity first: column checkboxes have ids by position, which change when a column moves.
    var sel = el.tagName.toLowerCase(), any = false;
    ['data-act', 'data-key', 'data-col'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (v !== null) { sel += '[' + a + '="' + v.replace(/["\\]/g, '\\$&') + '"]'; any = true; }
    });
    if (any) return sel;
    if (el.id) return '#' + (root.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    return null;
  }

  /** Writes a region only when its markup changed; keeps keyboard focus on the "same" control and the
   * region's own scroll position. */
  function patch(host, key, html) {
    if (!host) return false;
    if (regionHtml[key] === html && host.childNodes.length) return false;
    var ae = document.activeElement;
    var had = !!ae && ae !== host && host.contains(ae);
    var sel = had ? focusSelector(ae) : null;
    var scrollers = [];
    Array.prototype.forEach.call(host.querySelectorAll('[data-keep-scroll]'), function (s) {
      scrollers.push({ id: s.getAttribute('data-keep-scroll'), top: s.scrollTop, left: s.scrollLeft });
    });
    host.innerHTML = html;
    regionHtml[key] = html;
    scrollers.forEach(function (s) {
      var el = host.querySelector('[data-keep-scroll="' + s.id + '"]');
      if (el) { el.scrollTop = s.top; el.scrollLeft = s.left; }
    });
    if (had) {
      var next = sel ? host.querySelector(sel) : null;
      if (next && !next.disabled) { try { next.focus({ preventScroll: true }); } catch (e) { next.focus(); } }
    }
    return true;
  }

  function focusEl(el) {
    if (!el) return;
    try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
  }

  // ------------------------------------------------------------------ preferences (ui.exchangePrefs)

  function prefs() {
    var st = GT.store && GT.store.state;
    var p = st && st.ui && util.isPlainObject(st.ui.exchangePrefs) ? st.ui.exchangePrefs : {};
    return {
      sort: p.sort === 'no' ? 'no' : 'name',
      includeSettings: p.includeSettings !== false,
      includeHistory: p.includeHistory === true,
      presets: util.isPlainObject(p.presets) ? p.presets : {}
    };
  }
  function setPrefs(patchObj) {
    var p = prefs();
    Object.keys(patchObj).forEach(function (k) { p[k] = patchObj[k]; });
    // Keep only presets of courses that still exist, so the object does not grow forever.
    var ids = {};
    (GT.store.state.courses || []).forEach(function (c) { ids[c.id] = true; });
    var presets = {};
    Object.keys(p.presets || {}).forEach(function (cid) {
      if (ids[cid] && util.isSafeKey(cid) && typeof p.presets[cid] === 'string') presets[cid] = p.presets[cid];
    });
    p.presets = presets;
    GT.store.setUi({ exchangePrefs: p });
  }

  if (GT.store && GT.store.subscribe) {
    GT.store.subscribe(function (info) {
      var t = info && info.type;
      trackImport(info);
      if (t === 'saved' || t === 'annotate' || t === 'meta') return;
      // Privacy changes which header-row choices may show text (a native select cannot be blurred).
      if (t === 'ui' && !(info.patch && (util.hasOwn(info.patch, 'privacy') || util.hasOwn(info.patch, 'exchangePrefs')))) return;
      dataDirty = true;
    });
  }

  // ------------------------------------------------------------------ export: columns and presets

  function catalogFor(course) {
    var list = safeCall('exporter', 'columnsFor', [course], []);
    return (Array.isArray(list) ? list : []).filter(function (c) { return c && typeof c.key === 'string'; });
  }

  function presetsFor(course) {
    var built = safeCall('exporter', 'builtInPresets', [course], []);
    var out = (Array.isArray(built) ? built : []).filter(function (p) { return p && typeof p.id === 'string' && Array.isArray(p.columns); })
      .map(function (p) { return { id: p.id, name: str(p.name) || p.id, columns: p.columns, user: false }; });
    (Array.isArray(course.exportPresets) ? course.exportPresets : []).forEach(function (p) {
      if (p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.columns)) {
        out.push({ id: p.id, name: p.name, columns: p.columns, user: true });
      }
    });
    return out;
  }

  function findPreset(presets, id) {
    for (var i = 0; i < presets.length; i++) if (presets[i].id === id) return presets[i];
    return null;
  }

  function defaultPresetId(presets) {
    if (findPreset(presets, DEFAULT_PRESET)) return DEFAULT_PRESET;
    return presets.length ? presets[0].id : '';
  }

  /** The working list from a preset: its known columns first (checked, in its order; unknown keys are
   * skipped silently), then every other column of the catalog (unchecked, catalog order). */
  function listFromPreset(preset, catalog) {
    var known = {}, seen = {}, out = [];
    catalog.forEach(function (c) { known[c.key] = true; });
    (preset ? preset.columns : []).forEach(function (k) {
      if (typeof k === 'string' && known[k] && !seen[k]) { seen[k] = true; out.push({ key: k, on: true }); }
    });
    catalog.forEach(function (c) { if (!seen[c.key]) { seen[c.key] = true; out.push({ key: c.key, on: false }); } });
    return out;
  }

  /** The export state of a course, kept in step with the column catalog (assessments added, removed…). */
  function expState(course, catalog, presets) {
    var st = expByCourse[course.id];
    var sig = catalog.map(function (c) { return c.key; }).join('|');
    if (!st) {
      var saved = prefs().presets[course.id];
      var pid = saved && findPreset(presets, saved) ? saved : defaultPresetId(presets);
      st = expByCourse[course.id] = { presetId: pid, list: listFromPreset(findPreset(presets, pid), catalog), catalogSig: sig, edited: false };
      return st;
    }
    if (!findPreset(presets, st.presetId)) {
      // The selected preset was deleted (or undone): back to the default.
      st.presetId = defaultPresetId(presets);
      st.edited = false;
      st.catalogSig = null;
    }
    if (st.catalogSig !== sig) {
      if (!st.edited) {
        st.list = listFromPreset(findPreset(presets, st.presetId), catalog);
      } else {
        var known = {}, seen = {};
        catalog.forEach(function (c) { known[c.key] = true; });
        var next = st.list.filter(function (it) {
          if (!known[it.key] || seen[it.key]) return false;
          seen[it.key] = true;
          return true;
        });
        catalog.forEach(function (c) { if (!seen[c.key]) next.push({ key: c.key, on: false }); });
        st.list = next;
      }
      st.catalogSig = sig;
    } else if (!st.edited) {
      // Same catalog, but a user preset may have been changed (saved again, undo): follow it.
      var fromPreset = listFromPreset(findPreset(presets, st.presetId), catalog);
      if (JSON.stringify(fromPreset) !== JSON.stringify(st.list)) st.list = fromPreset;
    }
    return st;
  }

  function catalogMap(catalog) {
    var m = {};
    catalog.forEach(function (c) { m[c.key] = c; });
    return m;
  }

  /** Keys that will be exported: checked and available, in list order. */
  function exportKeys(st, cmap) {
    return st.list.filter(function (it) { return it.on && cmap[it.key] && cmap[it.key].available !== false; })
      .map(function (it) { return it.key; });
  }

  function isModified(st, presets, catalog) {
    var preset = findPreset(presets, st.presetId);
    var a = listFromPreset(preset, catalog).filter(function (it) { return it.on; }).map(function (it) { return it.key; });
    var b = st.list.filter(function (it) { return it.on; }).map(function (it) { return it.key; });
    return a.join('|') !== b.join('|');
  }

  var GROUP_LABELS = {
    identity: 'Student', student: 'Student', info: 'Student', id: 'Student',
    raw: 'Score', score: 'Score', scores: 'Score',
    weighted: 'Weighted', late: 'Late work',
    result: 'Result', results: 'Result', grade: 'Result', grades: 'Result', total: 'Result', stats: 'Result', letter: 'Letter',
    attendance: 'Attendance'
  };
  function groupLabel(g) {
    var s = str(g);
    if (util.hasOwn(GROUP_LABELS, s)) return GROUP_LABELS[s];
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  /** Column tint like the exported sheet: the assessment's position (1st green, 2nd orange, …). */
  function tintFor(course, key) {
    var m = /^(raw|weighted|late):(.+)$/.exec(key);
    if (!m) return 0;
    for (var i = 0; i < course.assessments.length; i++) {
      if (course.assessments[i].id === m[2]) return Math.min(i, 5) + 1;
    }
    return 0;
  }

  function dataCheckFor(course, results) {
    var key = course.id + ':' + (GT.store.version ? GT.store.version() : Math.random());
    if (checkCache.key === key) return checkCache.value;
    var res = safeCall('exporter', 'dataCheck', [course, results], null);
    var items = res && Array.isArray(res.items) ? res.items.filter(function (it) { return it && it.text; }) : null;
    checkCache = { key: key, value: items };
    return items;
  }

  // ------------------------------------------------------------------ render: skeleton

  function buildShell(el) {
    el.innerHTML =
      '<div class="page-header xc-head" id="xc-head"></div>' +
      '<section class="card xc-card" id="xc-export" aria-labelledby="xc-h-export">' +
        '<div class="card-header"><div class="xc-card-title">' +
          '<h2 id="xc-h-export">' + icon('download') + 'Export grades</h2>' +
          '<p class="xc-card-sub">Download this course\'s grades for the instructor: an Excel workbook with real formulas they can inspect, or a plain CSV file.</p>' +
        '</div></div>' +
        '<div class="card-body" id="xc-exp-body"></div>' +
      '</section>' +
      '<section class="card xc-card" id="xc-import" aria-labelledby="xc-h-import">' +
        '<div class="card-header"><div class="xc-card-title">' +
          '<h2 id="xc-h-import">' + icon('upload') + 'Import from a file</h2>' +
          '<p class="xc-card-sub">Bring students, scores, final letters or absences in from an Excel (.xlsx) or CSV file, for example the previous TA\'s grade sheet. Nothing changes until the last step.</p>' +
        '</div></div>' +
        '<div class="card-body xc-imp-body" id="xc-imp-body"></div>' +
        '<input type="file" id="xc-file" class="xc-file-input" tabindex="-1" aria-hidden="true" ' +
          'accept=".xlsx,.xlsm,.csv,.tsv,.txt,.xls,.ods,' + XLSX_MIME + ',text/csv">' +
      '</section>' +
      '<div class="sr-only" id="xc-live" aria-live="polite"></div>';
    dom = {
      head: el.querySelector('#xc-head'),
      expBody: el.querySelector('#xc-exp-body'),
      impBody: el.querySelector('#xc-imp-body'),
      file: el.querySelector('#xc-file'),
      live: el.querySelector('#xc-live')
    };
    regionHtml = {};
    dom.file.addEventListener('change', function () {
      var f = dom.file.files && dom.file.files[0] ? dom.file.files[0] : null;
      dom.file.value = '';
      if (f) loadFile(f);
    });
  }

  function render(el, ctx) {
    if (el !== boundEl) bindContainer(el);
    var course = ctx.course;
    if (!course) {
      el.innerHTML = '<div class="empty-state"><h2>No course</h2><p>Add a course from the course menu first.</p></div>';
      dom = null;
      regionHtml = {};
      return;
    }
    var rebuilt = false;
    if (!dom || !el.contains(dom.expBody)) { buildShell(el); rebuilt = true; }
    var courseChanged = course.id !== lastCourseId;
    if (courseChanged) {
      lastCourseId = course.id;
      busy = null;
      expStatus = null;
      onImportCourseChanged(course);
    }
    if (!rebuilt && !dataDirty && !courseChanged && !ctx.switched) return;
    dataDirty = false;
    try {
      renderHead(course);
      renderExport(course, ctx.results);
      renderImport(course);
    } catch (e) {
      logErr(e);
      if (dom && dom.expBody) {
        dom.expBody.innerHTML = '<div class="callout callout-danger"><strong>This page could not be shown.</strong> ' + esc(errText(e)) +
          '<br>Your data is safe. Try another tab or reload the page.</div>';
        regionHtml = {};
      }
    }
  }

  function refresh() {
    var course = GT.store.course();
    if (!dom || !course || !boundEl || !document.body.contains(boundEl)) return;
    renderExport(course, GT.store.results());
    renderImport(course);
  }

  function destroy() {
    if (ui.closeMenu) ui.closeMenu();
    drag = null;
  }

  /** The page subtitle of every view (UX-16): "SE 4351 · Requirements Engineering · Fall 2026". */
  function courseLine(course) {
    return [course.code, course.title, course.term].map(function (x) { return str(x).trim(); }).filter(Boolean).join(' \u00b7 ') || 'Course';
  }

  function renderHead(course) {
    patch(dom.head, 'head',
      '<div><h1>Import / Export</h1><div class="sub">' + esc(courseLine(course)) + '</div>' +
      '<div class="sub">Files are made and read on this computer only; nothing is uploaded.</div></div>');
  }

  // ------------------------------------------------------------------ render: export card

  function renderExport(course, results) {
    if (!exporterReady()) {
      patch(dom.expBody, 'exp', '<div class="callout callout-warn"><strong>Export is not available.</strong> The export module ' +
        '(js/core/exporter.js) is not loaded. Keep every file of Grade Tracker together and reload the page.</div>');
      return;
    }
    var catalog = catalogFor(course);
    var presets = presetsFor(course);
    var st = expState(course, catalog, presets);
    var cmap = catalogMap(catalog);
    var keys = exportKeys(st, cmap);
    var p = prefs();

    if (!dom.expBody.querySelector('#xc-exp-grid')) {
      regionHtml.exp = null;
      patch(dom.expBody, 'exp',
        '<div class="xc-exp-grid" id="xc-exp-grid">' +
          '<div class="xc-exp-cols">' +
            '<h3 class="xc-step-h"><span class="xc-num">1</span>Choose the columns</h3>' +
            '<div id="xc-presets"></div>' +
            '<div id="xc-colbar"></div>' +
            '<div id="xc-collist"></div>' +
          '</div>' +
          '<div class="xc-exp-side">' +
            '<h3 class="xc-step-h"><span class="xc-num">2</span>Options</h3>' +
            '<div id="xc-options"></div>' +
            '<h3 class="xc-step-h"><span class="xc-num">3</span>Check and download</h3>' +
            '<div id="xc-check"></div>' +
            '<div id="xc-download"></div>' +
          '</div>' +
        '</div>');
    }
    var body = dom.expBody;
    patch(body.querySelector('#xc-presets'), 'presets', presetBarHtml(st, presets, catalog));
    patch(body.querySelector('#xc-colbar'), 'colbar', colBarHtml(st, cmap, keys, presets, catalog));
    patch(body.querySelector('#xc-collist'), 'collist', colListHtml(course, st, cmap));
    patch(body.querySelector('#xc-options'), 'options', optionsHtml(p));
    patch(body.querySelector('#xc-check'), 'check', checkHtml(course, results));
    patch(body.querySelector('#xc-download'), 'download', downloadHtml(course, st, cmap, keys, p));
  }

  function presetBarHtml(st, presets, catalog) {
    var cur = findPreset(presets, st.presetId);
    var built = presets.filter(function (x) { return !x.user; });
    var mine = presets.filter(function (x) { return x.user; });
    function opt(x) {
      return '<option value="' + esc(x.id) + '"' + (x.id === st.presetId ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    }
    var modified = isModified(st, presets, catalog);
    var isUser = !!(cur && cur.user);
    return '<div class="xc-preset-row">' +
      '<div class="field xc-preset-field"><label for="xc-preset">Preset (a saved list of columns)</label>' +
        '<select id="xc-preset" data-act="preset">' +
          '<optgroup label="Built-in">' + built.map(opt).join('') + '</optgroup>' +
          (mine.length ? '<optgroup label="My presets">' + mine.map(opt).join('') + '</optgroup>' : '') +
        '</select></div>' +
      '<div class="xc-preset-actions">' +
        '<button type="button" class="btn btn-sm" data-act="preset-save">' + icon('save') + 'Save as preset\u2026</button>' +
        (isUser
          ? '<button type="button" class="btn btn-sm" data-act="preset-rename">' + icon('edit') + 'Rename</button>' +
            '<button type="button" class="btn btn-sm btn-danger" data-act="preset-delete">' + icon('trash') + 'Delete preset</button>'
          : '') +
      '</div>' +
    '</div>' +
    (modified ? note('info', 'Changed from the preset "' + esc(cur ? cur.name : '') + '". ' +
      'Use <strong>Save as preset\u2026</strong> to keep this choice, or <strong>Reset to preset</strong>.') : '');
  }

  function colBarHtml(st, cmap, keys) {
    var avail = st.list.filter(function (it) { return cmap[it.key] && cmap[it.key].available !== false; }).length;
    return '<div class="xc-colbar">' +
      '<span class="xc-colcount" id="xc-colcount"><strong>' + keys.length + '</strong> of ' + avail + ' columns selected</span>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-act="cols-all">Select all</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-act="cols-none">None</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-act="cols-reset">Reset to preset</button>' +
    '</div>';
  }

  function colListHtml(course, st, cmap) {
    var pos = 0;
    var n = st.list.length;
    var rows = st.list.map(function (it, i) {
      var c = cmap[it.key];
      if (!c) return '';
      var avail = c.available !== false;
      var exported = it.on && avail;
      var letter = exported ? colLetter(pos++) : '';
      var tint = tintFor(course, it.key);
      var label = str(c.label) || it.key;
      var id = 'xc-col-' + i;
      var cls = 'xc-col' + (exported ? '' : ' is-off') + (avail ? '' : ' is-unavail') + (tint ? ' xc-tint-' + tint : '');
      return '<li class="' + cls + '" data-key="' + esc(it.key) + '" draggable="true">' +
        '<span class="xc-grip" title="Drag to reorder">' + icon('grip') + '</span>' +
        '<span class="xc-col-pos" title="' + (letter ? 'Column ' + letter + ' in the file' : 'Not exported') + '">' + (letter || '\u2013') + '</span>' +
        '<label class="xc-col-main" for="' + id + '">' +
          '<input type="checkbox" id="' + id + '" data-act="col-toggle" data-key="' + esc(it.key) + '"' +
            (it.on ? ' checked' : '') + (avail ? '' : ' disabled') + '>' +
          '<span class="xc-col-text"><span class="xc-col-label">' + esc(label) + '</span>' +
            (avail ? '' : '<span class="xc-col-reason">' + icon('info', 'icon-sm') + ' ' + esc(str(c.reason) || 'Not available for this course') +
              (it.on ? ' (skipped)' : '') + '</span>') +
          '</span>' +
        '</label>' +
        (c.group ? '<span class="xc-col-group">' + esc(groupLabel(c.group)) + '</span>' : '') +
        '<span class="xc-col-moves">' +
          '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="col-up" data-key="' + esc(it.key) + '"' +
            (i === 0 ? ' disabled' : '') + ' aria-label="Move ' + esc(label) + ' up" title="Move up (Alt+\u2191)">' + icon('up') + '</button>' +
          '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="col-down" data-key="' + esc(it.key) + '"' +
            (i === n - 1 ? ' disabled' : '') + ' aria-label="Move ' + esc(label) + ' down" title="Move down (Alt+\u2193)">' + icon('down') + '</button>' +
        '</span>' +
      '</li>';
    }).join('');
    return '<ol class="xc-cols" id="xc-cols" aria-label="Columns to export, in file order" data-keep-scroll="cols">' + rows + '</ol>' +
      '<p class="xc-help">Tick the columns to include. Change the order with the arrow buttons (or Alt+\u2191 / Alt+\u2193 on a column, or drag it). ' +
      'The letter is the column in the file.</p>';
  }

  function optionsHtml(p) {
    return '<div class="xc-options">' +
      '<div class="field"><span class="label" id="xc-sort-l">Row order</span>' +
        '<div class="segmented" role="group" aria-labelledby="xc-sort-l">' +
          '<button type="button" data-act="sort" data-key="name" aria-pressed="' + (p.sort === 'name') + '">By name</button>' +
          '<button type="button" data-act="sort" data-key="no" aria-pressed="' + (p.sort === 'no') + '">By No</button>' +
        '</div>' +
        '<div class="help">' + (p.sort === 'no' ? 'By student number (No), smallest first.' : 'Last name, then first name, like the previous sheet.') +
          ' Withdrawn students are included and marked in the Status column.</div>' +
      '</div>' +
      '<div class="field"><span class="label">Extra sheets in the Excel file</span>' +
        '<label class="check"><input type="checkbox" id="xc-opt-settings" data-act="opt-settings"' + (p.includeSettings ? ' checked' : '') + '> ' +
          '"Settings" sheet: weights, letter cutoffs and settings still to confirm</label>' +
        '<label class="check"><input type="checkbox" id="xc-opt-history" data-act="opt-history"' + (p.includeHistory ? ' checked' : '') + '> ' +
          '"Change history" sheet: every logged change</label>' +
        '<div class="help">The CSV file holds only the grades table (values, no formulas).</div>' +
      '</div>' +
    '</div>';
  }

  function checkHtml(course, results) {
    var items = dataCheckFor(course, results);
    if (items === null) {
      return '<div class="xc-check"><p class="xc-help">The data check is not available.</p></div>';
    }
    var warn = items.filter(function (it) { return it.level === 'warn'; }).length;
    var head = items.length === 0
      ? '<p class="xc-check-ok">' + icon('check') + ' No problems found.</p>'
      : '<p class="xc-check-sum">' + (warn ? plural(warn, 'thing') + ' to look at' : 'Nothing to fix') +
        (items.length - warn ? (warn ? ', ' : ': ') + plural(items.length - warn, 'note') : '') + '</p>';
    return '<div class="xc-check" role="group" aria-label="Data check">' + head +
      (items.length ? '<ul class="xc-check-list">' + items.map(function (it) {
        var w = it.level === 'warn';
        return '<li class="' + (w ? 'is-warn' : 'is-info') + '">' + icon(w ? 'alert' : 'info') +
          '<span><span class="sr-only">' + (w ? 'Warning: ' : 'Note: ') + '</span>' + esc(str(it.text)) + '</span></li>';
      }).join('') + '</ul>' : '') +
      '<p class="xc-help">This check never blocks the download. It lists what the instructor may ask about.</p>' +
    '</div>';
  }

  function downloadHtml(course, st, cmap, keys, p) {
    var students = course.students.length;
    var withdrawn = course.students.filter(function (s) { return s.status === 'withdrawn'; }).length;
    var skipped = st.list.filter(function (it) { return it.on && cmap[it.key] && cmap[it.key].available === false; });
    var reasons = {};
    skipped.forEach(function (it) {
      var r = str(cmap[it.key].reason) || 'Not available for this course';
      (reasons[r] = reasons[r] || []).push(str(cmap[it.key].label) || it.key);
    });
    var none = keys.length === 0;
    var xBusy = busy === 'xlsx';
    var out = '<div class="xc-download">';
    out += '<p class="xc-summary">' + icon('sheet') + '<span>' + plural(keys.length, 'column') + ' \u00b7 ' + plural(students, 'student') +
      (withdrawn ? ' (' + withdrawn + ' withdrawn)' : '') + ' \u00b7 sorted by ' + (p.sort === 'no' ? 'No' : 'name') + '</span></p>';
    Object.keys(reasons).forEach(function (r) {
      out += note('alert', 'Skipped: ' + esc(reasons[r].join(', ')) + '. ' + esc(r) + '.', 'is-warn');
    });
    if (!students) out += note('info', 'This course has no students yet, so the file will have only the header row.');
    if (none) out += note('alert', 'Choose at least one column to download.', 'is-warn', 'alert');
    out += '<div class="xc-buttons">' +
      '<button type="button" class="btn btn-primary xc-dl" id="xc-dl-xlsx" data-act="download-xlsx"' + (none || xBusy ? ' disabled' : '') +
        (xBusy ? ' aria-busy="true"' : '') + '>' + (xBusy ? spinner() + 'Preparing\u2026' : icon('download') + 'Download Excel (.xlsx)') + '</button>' +
      '<button type="button" class="btn xc-dl" id="xc-dl-csv" data-act="download-csv"' + (none ? ' disabled' : '') + '>' + icon('download') + 'Download CSV</button>' +
    '</div>';
    out += '<p class="xc-help">In the Excel file, the weighted scores, Total and Letter Grade are real formulas, so the instructor can click a cell to see how it is calculated.</p>';
    out += '<div id="xc-export-status" class="xc-status" role="status" aria-live="polite">' + statusHtml() + '</div>';
    out += '<p class="xc-reminder">' + icon('lock') + '<span><strong>Exported files contain confidential grades.</strong> Keep them on this computer, ' +
      'out of shared or synced folders (OneDrive, Google Drive, Dropbox, iCloud) and out of the Grade Tracker folder. ' +
      'Delete copies you no longer need.</span></p>';
    return out + '</div>';
  }

  function statusHtml() {
    if (!expStatus) return '';
    if (expStatus.kind === 'busy') return '<span class="xc-status-busy">' + spinner() + esc(expStatus.text) + '</span>';
    if (expStatus.kind === 'ok') return '<span class="xc-status-ok">' + icon('check') + esc(expStatus.text) + '</span>';
    return '<div class="callout callout-danger xc-status-err" role="alert"><strong>' + esc(expStatus.title || 'The file could not be made.') + '</strong> ' +
      esc(expStatus.text) + '</div>';
  }

  // ------------------------------------------------------------------ export: actions

  function currentExport() {
    var course = GT.store.course();
    if (!course || !exporterReady()) return null;
    var catalog = catalogFor(course);
    var presets = presetsFor(course);
    var st = expState(course, catalog, presets);
    return { course: course, catalog: catalog, presets: presets, st: st, cmap: catalogMap(catalog) };
  }

  function editList(fn) {
    var x = currentExport();
    if (!x) return;
    fn(x.st, x);
    x.st.edited = true;
    refresh();
  }

  function moveKey(key, delta, fromKeyboard) {
    var x = currentExport();
    if (!x) return;
    var list = x.st.list;
    var i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].key === key) i = k;
    var j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    var item = list.splice(i, 1)[0];
    list.splice(j, 0, item);
    x.st.edited = true;
    refresh();
    var label = x.cmap[key] ? str(x.cmap[key].label) : key;
    announce(label + ' moved to position ' + (j + 1) + ' of ' + list.length + '.');
    if (fromKeyboard && dom) {
      // Keep focus on the moved column (the focused button may be disabled at the ends of the list).
      var sel = '[data-key="' + key.replace(/["\\]/g, '\\$&') + '"]';
      var btn = dom.expBody.querySelector('button[data-act="' + (delta < 0 ? 'col-up' : 'col-down') + '"]' + sel);
      if (!btn || btn.disabled) btn = dom.expBody.querySelector('input[data-act="col-toggle"]' + sel);
      if (btn) { try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); } btn.scrollIntoView({ block: 'nearest' }); }
    }
  }

  function dropKey(key, targetKey, after) {
    var x = currentExport();
    if (!x || key === targetKey) return;
    var list = x.st.list;
    var i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].key === key) i = k;
    if (i < 0) return;
    var item = list.splice(i, 1)[0];
    var t = -1;
    for (var m = 0; m < list.length; m++) if (list[m].key === targetKey) t = m;
    if (t < 0) { list.splice(i, 0, item); return; }
    list.splice(after ? t + 1 : t, 0, item);
    x.st.edited = true;
    refresh();
    var pos = list.indexOf(item) + 1;
    announce((x.cmap[key] ? str(x.cmap[key].label) : key) + ' moved to position ' + pos + ' of ' + list.length + '.');
  }

  function selectPreset(id) {
    var x = currentExport();
    if (!x) return;
    var preset = findPreset(x.presets, id);
    if (!preset) return;
    x.st.presetId = id;
    x.st.list = listFromPreset(preset, x.catalog);
    x.st.edited = false;
    var pp = prefs().presets;
    var next = {};
    Object.keys(pp).forEach(function (k) { next[k] = pp[k]; });
    next[x.course.id] = id;
    setPrefs({ presets: next }); // re-renders through the store
    refresh();
  }

  function presetNameError(name, presets, exceptId) {
    var n = name.trim();
    if (!n) return 'Enter a name.';
    if (n.length > 60) return 'Use at most 60 characters.';
    var clash = presets.filter(function (p) { return p.id !== exceptId && !p.user && p.name.toLowerCase() === n.toLowerCase(); });
    if (clash.length) return 'A built-in preset already has this name. Choose another name.';
    return null;
  }

  function savePreset() {
    var x = currentExport();
    if (!x) return;
    var cols = x.st.list.filter(function (it) { return it.on; }).map(function (it) { return it.key; });
    if (!cols.length) { ui.toast('Choose at least one column before saving a preset.', { type: 'warn' }); return; }
    var cur = findPreset(x.presets, x.st.presetId);
    ui.dialog.prompt({
      title: 'Save as preset',
      label: 'Preset name',
      value: cur && cur.user ? cur.name : '',
      placeholder: 'e.g. For the instructor',
      help: 'Saves the ' + plural(cols.length, 'ticked column') + ' in this order for ' + x.course.code + '. Using an existing name of yours replaces that preset.',
      required: true,
      validate: function (v) { return presetNameError(String(v || ''), x.presets, null); }
    }).then(function (name) {
      if (name === null || name === undefined) return;
      var n = String(name).trim();
      var existing = x.presets.filter(function (p) { return p.user && p.name.toLowerCase() === n.toLowerCase(); })[0];
      var go = existing
        ? ui.dialog.confirm({ title: 'Replace preset?', message: 'You already have a preset named "' + existing.name + '". Replace its columns with the current choice?', confirmText: 'Replace' })
        : Promise.resolve(true);
      return go.then(function (ok) {
        if (!ok) return;
        var id = existing ? existing.id : util.uid('xp');
        var done = tx(existing ? 'Update export preset "' + n + '"' : 'Save export preset "' + n + '"', function (c) {
          if (!Array.isArray(c.exportPresets)) c.exportPresets = [];
          var hit = c.exportPresets.filter(function (p) { return p && p.id === id; })[0];
          if (hit) { hit.name = n; hit.columns = cols.slice(); } else c.exportPresets.push({ id: id, name: n, columns: cols.slice() });
          return true;
        }, { historyMode: 'none', courseId: x.course.id });
        if (!done) return;
        var st = expByCourse[x.course.id];
        if (st) { st.presetId = id; st.edited = false; }
        var pp = prefs().presets, next = {};
        Object.keys(pp).forEach(function (k) { next[k] = pp[k]; });
        next[x.course.id] = id;
        setPrefs({ presets: next });
        ui.toast('Preset "' + n + '" saved.', { type: 'success' });
      });
    });
  }

  function renamePreset() {
    var x = currentExport();
    if (!x) return;
    var cur = findPreset(x.presets, x.st.presetId);
    if (!cur || !cur.user) return;
    ui.dialog.prompt({
      title: 'Rename preset', label: 'Preset name', value: cur.name, required: true,
      validate: function (v) {
        var err = presetNameError(String(v || ''), x.presets, cur.id);
        if (err) return err;
        var n = String(v).trim().toLowerCase();
        var dup = x.presets.filter(function (p) { return p.user && p.id !== cur.id && p.name.toLowerCase() === n; });
        return dup.length ? 'You already have a preset with this name.' : null;
      }
    }).then(function (name) {
      if (name === null || name === undefined) return;
      var n = String(name).trim();
      if (n === cur.name) return;
      tx('Rename export preset', function (c) {
        (c.exportPresets || []).forEach(function (p) { if (p && p.id === cur.id) p.name = n; });
      }, { historyMode: 'none', courseId: x.course.id });
    });
  }

  function deletePreset() {
    var x = currentExport();
    if (!x) return;
    var cur = findPreset(x.presets, x.st.presetId);
    if (!cur || !cur.user) return;
    ui.dialog.confirm({
      title: 'Delete preset?',
      message: 'Delete the preset "' + cur.name + '"? The columns shown now stay as they are. You can undo this (Ctrl+Z).',
      confirmText: 'Delete preset', danger: true
    }).then(function (ok) {
      if (!ok) return;
      var st = expByCourse[x.course.id];
      var keep = st ? st.list.map(function (it) { return { key: it.key, on: it.on }; }) : null;
      var done = tx('Delete export preset "' + cur.name + '"', function (c) {
        c.exportPresets = (c.exportPresets || []).filter(function (p) { return !p || p.id !== cur.id; });
        return true;
      }, { historyMode: 'none', courseId: x.course.id });
      if (!done) return;
      if (st) {
        st.presetId = defaultPresetId(presetsFor(x.course));
        if (keep) { st.list = keep; st.edited = true; }
      }
      ui.toast('Preset deleted.', { type: 'success' });
      refresh();
    });
  }

  /** One undoable change. Errors are shown as a toast and return undefined (nothing is saved). */
  function tx(label, mutator, opts) {
    try {
      var r = GT.store.transact(label, mutator, opts);
      return r === undefined ? true : r;
    } catch (e) {
      logErr(e);
      // Another tab saved newer data (read-only tab): the message says so; it is not a program error.
      ui.toast('Not saved: ' + errText(e), { type: e && e.conflict ? 'warn' : 'error' });
      return undefined;
    }
  }

  function exportOptions() {
    var p = prefs();
    var now = new Date().toISOString();
    return { sort: p.sort, includeSettings: p.includeSettings, includeHistory: p.includeHistory, now: now, exportedAt: now };
  }

  function downloadCsv() {
    var x = currentExport();
    if (!x) return;
    var keys = exportKeys(x.st, x.cmap);
    if (!keys.length) return;
    var name = ui.slug(x.course.code) + '-grades-' + ui.fileStamp() + '.csv';
    try {
      if (typeof GT.exporter.toCsv !== 'function') throw new Error('The CSV export is not available (js/core/exporter.js is incomplete).');
      var text = GT.exporter.toCsv(x.course, GT.store.results(), keys, exportOptions());
      ui.download(name, String(text), 'text/csv;charset=utf-8');
      expStatus = { kind: 'ok', text: 'Downloaded ' + name + '.' };
      ui.toast('CSV file downloaded (' + name + '). It contains confidential grades: keep it private.', { type: 'success' });
    } catch (e) {
      logErr(e);
      expStatus = { kind: 'error', title: 'The CSV file could not be made.', text: errText(e) };
    }
    refresh();
  }

  function downloadXlsx() {
    if (busy) return;
    var x = currentExport();
    if (!x) return;
    var keys = exportKeys(x.st, x.cmap);
    if (!keys.length) return;
    if (typeof GT.exporter.toWorkbook !== 'function') {
      expStatus = { kind: 'error', title: 'The Excel file could not be made.', text: 'The Excel export is not available (js/core/exporter.js is incomplete).' };
      refresh();
      return;
    }
    // A copy, so edits made while the file is built cannot mix two states in one file.
    var course = util.clone(x.course);
    var results = GT.store.results();
    var courseId = x.course.id;
    var name = ui.slug(course.code) + '-grades-' + ui.fileStamp() + '.xlsx';
    var opts = exportOptions();
    busy = 'xlsx';
    expStatus = { kind: 'busy', text: 'Loading the Excel library\u2026' };
    refresh();
    var libFailed = false;
    Promise.resolve().then(function () {
      if (!ui.loadExcel) throw new Error('GT.ui.loadExcel is missing.');
      return ui.loadExcel();
    }).catch(function (e) {
      libFailed = true;
      throw e;
    }).then(function (ExcelJS) {
      if (!ExcelJS || typeof ExcelJS.Workbook !== 'function') { libFailed = true; throw new Error('The Excel library did not initialize.'); }
      expStatus = { kind: 'busy', text: 'Building the Excel file\u2026' };
      refresh();
      return GT.exporter.toWorkbook(ExcelJS, course, results, keys, opts);
    }).then(function (buf) {
      var blob = buf instanceof Blob ? buf : new Blob([buf], { type: XLSX_MIME });
      ui.download(name, blob, XLSX_MIME);
      busy = null;
      expStatus = { kind: 'ok', text: 'Downloaded ' + name + '.' };
      ui.toast('Excel file downloaded (' + name + '). It contains confidential grades: keep it private.', { type: 'success' });
    }).catch(function (e) {
      if (libFailed) logHandled(e); else logErr(e);
      busy = null;
      expStatus = libFailed
        ? { kind: 'error', lib: true, title: 'The Excel library could not be loaded.',
          text: 'The file vendor/exceljs.min.js is missing or damaged. Keep the "vendor" folder next to index.html (copy the whole Grade Tracker folder again if needed), then reload the page. "Download CSV" still works.' }
        : { kind: 'error', title: 'The Excel file could not be made.', text: errText(e) + ' Your data is safe; "Download CSV" still works.' };
    }).then(function () {
      if (GT.store.course() && GT.store.course().id !== courseId) expStatus = null;
      refresh();
      if (dom) {
        var b = dom.expBody.querySelector('#xc-dl-xlsx');
        if (b && document.activeElement === document.body) { try { b.focus({ preventScroll: true }); } catch (e2) { b.focus(); } }
      }
    });
  }

  // ------------------------------------------------------------------ import: reading the file

  function extOf(name) {
    var m = /\.([^.\\/]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function friendlyError(title, html) { var e = new Error(title); e.friendly = { title: title, html: html }; return e; }

  /** 0-based columns of a worksheet that hold formulas (GT.importer.readWorkbook): a "Letter Grade" column
   * of formulas holds suggestions from the cutoffs, so guessMapping leaves it unmapped. */
  function formulaCols(list) {
    return (Array.isArray(list) ? list : []).filter(function (i) { return typeof i === 'number' && i >= 0 && i < MAX_COLS; });
  }

  /** [row, col] cells of a Grade Tracker workbook (GT.importer.readWorkbook): its finalLetterCells (the
   * letters the importer takes as final letters: those with the note "Final letter assigned by the
   * instructor" and those changed in the spreadsheet after the export) or its editedLetterCells (only the
   * changed ones). null for any other file: the importer then tells final letters from suggestions as
   * well as it can. */
  function letterCells(list) {
    if (!Array.isArray(list)) return null;
    return list.filter(function (p) {
      return Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' && p[0] >= 0 && p[1] >= 0;
    }).map(function (p) { return [p[0], p[1]]; });
  }

  /** Cells as text, at most MAX_ROWS + 1 rows and MAX_COLS columns. Only trailing empty cells and rows are
   * dropped, so column indexes stay those of the file (the mapping and formulaColumns rely on them). */
  function trimRows(rows) {
    var out = (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS + 1).map(function (r) {
      var cells = Array.isArray(r) ? r.slice(0, MAX_COLS) : [];
      cells = cells.map(function (v) { return v === null || v === undefined ? '' : String(v); });
      while (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
      return cells;
    });
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
  }

  function readAs(file, encoding) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error || new Error('Could not read the file.')); };
      r.readAsText(file, encoding);
    });
  }

  /** CSV text: UTF-8 first; Excel on Windows often saves "CSV (Comma delimited)" as Windows-1252, which
   * shows as replacement characters in UTF-8, so such a file is read again in that encoding. */
  function readTextSmart(file) {
    return readAs(file, 'utf-8').then(function (t) {
      if (t.indexOf('�') === -1) return t;
      return readAs(file, 'windows-1252').catch(function () { return t; });
    });
  }

  function readSheets(file) {
    var ext = extOf(file.name);
    if (file.size > MAX_FILE_BYTES) {
      return Promise.reject(friendlyError('This file is too large to be a grade sheet.',
        '<p>It is ' + esc(fmtBytes(file.size)) + '. Choose the Excel (.xlsx) or CSV file that holds the grades.</p>'));
    }
    if (ext === 'xls') {
      return Promise.reject(friendlyError('Old Excel files (.xls) cannot be read here.',
        '<p>' + esc(XLS_HELP) + '</p><p class="muted">Grade Tracker reads the newer Excel format (.xlsx) and CSV files.</p>'));
    }
    if (ext === 'xlsx' || ext === 'xlsm') {
      return ui.readArrayBuffer(file).then(function (buf) {
        var head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
        if (head.length === 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
          // Not a zip but an OLE container: Excel stores a password-protected .xlsx this way, and old .xls files too.
          throw friendlyError('This workbook is password-protected, or it is an old .xls file.',
            '<ul class="xc-plain-list">' +
              '<li><strong>If it opens in Excel only with a password:</strong> ' + esc(PASSWORD_HELP) + '</li>' +
              '<li><strong>If it opens without a password,</strong> it is an old .xls file that was renamed. ' + esc(XLS_HELP) + '</li>' +
            '</ul>');
        }
        if (head.length < 2 || head[0] !== 0x50 || head[1] !== 0x4b) {
          throw friendlyError('This file is not a real .xlsx workbook.',
            '<p>It may be an old .xls file or a CSV file that was renamed. ' + esc(XLS_HELP) + '</p>');
        }
        return ui.loadExcel().catch(function (e) {
          throw friendlyError('The Excel library could not be loaded.',
            '<p>The file vendor/exceljs.min.js is missing or damaged. Keep the "vendor" folder next to index.html, then reload the page. ' +
            'You can also save the sheet as CSV in Excel (File \u2192 Save As \u2192 CSV) and import that.</p><p class="muted">' + esc(errText(e)) + '</p>');
        }).then(function (ExcelJS) {
          var unreadable = function (e) {
            throw friendlyError('This Excel file could not be read.',
              '<p>It may be damaged. Open it in Excel, then use Save As \u2192 Excel Workbook (.xlsx) and import the new file.</p>' +
              '<p>If Excel asks for a password to open it: ' + esc(PASSWORD_HELP) + '</p>' +
              '<p class="muted">' + esc(errText(e)) + '</p>');
          };
          if (typeof GT.importer.readWorkbook === 'function') {
            return GT.importer.readWorkbook(ExcelJS, buf).then(function (list) {
              return (Array.isArray(list) ? list : []).map(function (x, i) {
                return { name: str(x && x.name) || 'Sheet ' + (i + 1), hidden: !!(x && x.hidden), rows: trimRows(x && x.rows),
                  formulaColumns: formulaCols(x && x.formulaColumns), finalLetterCells: letterCells(x && x.finalLetterCells),
                  editedLetterCells: letterCells(x && x.editedLetterCells) };
              });
            }, unreadable);
          }
          var wb = new ExcelJS.Workbook();
          return wb.xlsx.load(buf).catch(unreadable).then(function () {
            var sheets = [];
            wb.eachSheet(function (ws) {
              var rows = safeCall('importer', 'rowsFromWorksheet', [ws], []);
              sheets.push({ name: str(ws.name) || 'Sheet ' + (sheets.length + 1), hidden: ws.state === 'hidden' || ws.state === 'veryHidden', rows: trimRows(rows),
                formulaColumns: formulaCols(safeCall('importer', 'formulaColumnsOf', [ws], [])), finalLetterCells: null, editedLetterCells: null });
            });
            return sheets;
          });
        });
      });
    }
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      return readTextSmart(file).then(function (text) {
        var rows;
        if (typeof GT.importer.rowsFromCsv === 'function') rows = GT.importer.rowsFromCsv(String(text));
        else if (GT.csv && typeof GT.csv.parse === 'function') rows = GT.csv.parse(String(text));
        else throw new Error('The CSV reader (js/core/csv.js) is not loaded.');
        return [{ name: file.name, hidden: false, rows: trimRows(rows), formulaColumns: [], finalLetterCells: null, editedLetterCells: null }];
      });
    }
    return Promise.reject(friendlyError('This type of file cannot be imported.',
      '<p>Grade Tracker imports Excel workbooks (.xlsx) and CSV files (.csv). ' +
      (ext ? 'This file is a .' + esc(ext) + ' file. ' : '') +
      'If it is a spreadsheet, open it in Excel and use Save As \u2192 Excel Workbook (.xlsx), then import that file.</p>'));
  }

  function loadFile(file) {
    var course = GT.store.course();
    if (!course) return;
    if (!importerReady()) { refresh(); return; }
    var seq = ++loadSeq;
    imp = freshImport();
    imp.loading = true;
    imp.fileName = str(file.name) || 'file';
    imp.fileSize = file.size;
    imp.courseId = course.id;
    refresh();
    readSheets(file).then(function (sheets) {
      if (seq !== loadSeq) return;
      // Only the sheet the TA imports has to be small: a long helper sheet (a lookup list, an attendance
      // log) is offered disabled, and its rows are not kept.
      sheets.forEach(function (s) {
        if (s.rows.length > MAX_ROWS) { s.tooMany = true; s.rows = []; }
      });
      var usable = sheets.filter(function (s) { return !s.tooMany && s.rows.length > 0; });
      if (!usable.length) {
        if (sheets.some(function (s) { return s.tooMany; })) {
          throw friendlyError('This file has too many rows.', '<p>Grade Tracker imports up to ' + fmtCount(MAX_ROWS) + ' rows' +
            (sheets.length > 1 ? ' per sheet, and every sheet with data is longer' : '') + '. Choose the grade sheet of one course.</p>');
        }
        throw friendlyError('This file has no data.', '<p>Every sheet is empty. Choose the file that holds the grades.</p>');
      }
      imp.loading = false;
      imp.kind = extOf(file.name) === 'xlsx' || extOf(file.name) === 'xlsm' ? 'xlsx' : 'csv';
      imp.sheets = sheets;
      var first = -1;
      for (var i = 0; i < sheets.length && first < 0; i++) { if (!sheets[i].tooMany && !sheets[i].hidden && sheets[i].rows.length > 1) first = i; }
      for (var j = 0; j < sheets.length && first < 0; j++) { if (!sheets[j].tooMany && sheets[j].rows.length > 0) first = j; }
      setSheet(first);
      imp.step = 2;
      focusStepHeading = true;
      announce('File read. Step 2 of 4: check the sheet and the header row.');
    }).catch(function (e) {
      if (seq !== loadSeq) return;
      if (e && e.friendly) logHandled(e); else logErr(e);
      var keepName = imp.fileName;
      imp = freshImport();
      imp.error = e && e.friendly ? e.friendly
        : { title: 'This file could not be read.', html: '<p>' + esc(errText(e)) + '</p>' };
      imp.error.fileName = keepName;
    }).then(function () {
      if (seq === loadSeq) refresh();
    });
  }

  // ------------------------------------------------------------------ import: sheet, header row, mapping

  function curRows() {
    var s = imp.sheets[imp.sheetIndex];
    return s ? s.rows : [];
  }
  function colCount(rows) {
    var n = 0;
    rows.forEach(function (r) { if (r.length > n) n = r.length; });
    return n;
  }
  /** The header row's cells ('' for every column when the file has no header row). */
  function headerCells(rows, n) {
    var h = imp.headerIndex >= 0 ? rows[imp.headerIndex] || [] : [];
    var out = [];
    for (var i = 0; i < n; i++) out.push(h[i] === undefined ? '' : String(h[i]));
    return out;
  }

  /** Columns whose header cell guessMapping recognizes (index -> true). */
  function knownHeaders(cells, course) {
    var g = safeCall('importer', 'guessMapping', [cells, course, { formulaColumns: [] }], []);
    var out = {};
    (Array.isArray(g) ? g : []).forEach(function (k, i) { if (typeof k === 'string' && k !== 'ignore') out[i] = true; });
    return out;
  }

  /** How much a row looks like column names: { numbers: cells that are numbers, known: recognized names }.
   * A "header" with numbers and no known name is most likely the first student. */
  function headerLook(row, course) {
    var cells = (Array.isArray(row) ? row : []).map(str);
    var numbers = cells.filter(function (v) { return util.parseScoreInput(v).kind === 'number'; }).length;
    return { numbers: numbers, known: Object.keys(knownHeaders(cells, course)).length };
  }

  /** Text of a header cell that may be shown in labels and notes: a cell that is not a known column name
   * may be a student's name (a file without a header row), so it is left out in privacy mode. */
  function shownHeader(header, i) {
    var h = str(header[i]).trim();
    return h && privacyOn() && !imp.headerKnown[i] ? '' : h;
  }

  /** Rows and header index for GT.importer.plan. "No header row" (-1) reaches the importer as a blank
   * header row in front of the data, so every row of the file is read; `shift` turns the plan's row
   * indexes back into the file's. */
  function planInput() {
    var rows = curRows();
    if (imp.headerIndex >= 0) return { rows: rows, headerIndex: imp.headerIndex, shift: 0 };
    return { rows: [[]].concat(rows), headerIndex: 0, shift: 1 };
  }

  function setSheet(i) {
    imp.sheetIndex = Math.max(0, Math.min(i, imp.sheets.length - 1));
    var rows = curRows();
    var h = safeCall('importer', 'detectHeaderRow', [rows], 0);
    h = typeof h === 'number' && h >= 0 && h < rows.length ? h : 0;
    // Row 1 with numbers and no known column name is a student: the file has no header row.
    if (h === 0 && rows.length) {
      var look = headerLook(rows[0], GT.store.course());
      if (look.numbers > 0 && look.known === 0) h = -1;
    }
    imp.headerIndex = h;
    imp.headerAuto = h;
    remap();
  }

  /** The name columns as every view writes them (UX-17: "Last Name / First Name"), whatever the importer calls them. */
  var NAME_TARGET_LABELS = { lastName: 'Last Name', firstName: 'First Name', fullName: 'Full Name ("Last, First" or "First Last")' };
  var NAME_FIELD_LABELS = { 'Last name': 'Last Name', 'First name': 'First Name', 'Full name': 'Full Name' };

  function targetList(course) {
    var list = safeCall('importer', 'targetsFor', [course], []);
    list = (Array.isArray(list) ? list : []).filter(function (t) { return t && typeof t.key === 'string'; }).map(function (t) {
      if (!util.hasOwn(NAME_TARGET_LABELS, t.key) || t.label === NAME_TARGET_LABELS[t.key]) return t;
      var c = {};
      Object.keys(t).forEach(function (k) { c[k] = t[k]; });
      c.label = NAME_TARGET_LABELS[t.key];
      return c;
    });
    if (!list.some(function (t) { return t.key === 'ignore'; })) list.unshift({ key: 'ignore', label: 'Do not import' });
    return list;
  }

  function remap() {
    var course = GT.store.course();
    var rows = curRows();
    var n = colCount(rows);
    var sheet = imp.sheets[imp.sheetIndex];
    var cells = headerCells(rows, n);
    // Header cells that may be shown in privacy mode: all of a row with 2+ known column names (a real
    // header row, where "Total" is not a name either), else only the known ones.
    imp.headerKnown = knownHeaders(cells, course);
    if (Object.keys(imp.headerKnown).length >= 2) cells.forEach(function (c, i) { imp.headerKnown[i] = true; });
    // editedLetterCells: a letter column with letters typed in after a Grade Tracker export is a
    // final-letter column when no other column is (review V4R3-1; guessMapping reads only the column).
    var guess = safeCall('importer', 'guessMapping', [cells, course,
      { formulaColumns: sheet && Array.isArray(sheet.formulaColumns) ? sheet.formulaColumns : [],
        editedLetterCells: sheet && Array.isArray(sheet.editedLetterCells) ? sheet.editedLetterCells : null }], []);
    var valid = {};
    targetList(course).forEach(function (t) { valid[t.key] = true; });
    imp.mapping = [];
    for (var i = 0; i < n; i++) imp.mapping.push(guess && valid[guess[i]] ? guess[i] : 'ignore');
    imp.plan = null;
    imp.planKey = null;
    // Find students by No when the file has numbers but no names.
    var has = mappedSet();
    if (!has.lastName && !has.firstName && !has.fullName && has.no) imp.options.matchBy = 'no';
    else imp.options.matchBy = 'name';
    imp.options.switchAttendanceToTotals = hasAttendanceTarget() && attendanceMode(course) === 'off';
  }

  function mappedSet() {
    var m = {};
    imp.mapping.forEach(function (k) { if (k && k !== 'ignore') m[k] = (m[k] || 0) + 1; });
    return m;
  }
  function hasAttendanceTarget() {
    return imp.mapping.some(function (k) { return ATTENDANCE_TARGETS[k]; });
  }
  function isScoreTarget(k) { return /^(raw|weighted|late):/.test(str(k)); }

  /** Problems that stop step 3 from going on: [{ text }]. Duplicate targets, no way to find students, nothing mapped. */
  function mappingProblems(course) {
    var out = [];
    var m = mappedSet();
    var labels = {};
    targetList(course).forEach(function (t) { labels[t.key] = t.label; });
    Object.keys(m).forEach(function (k) {
      if (m[k] > 1) {
        var cols = [];
        imp.mapping.forEach(function (t, i) { if (t === k) cols.push(colLetter(i)); });
        out.push({ kind: 'dup', key: k, text: 'Columns ' + cols.join(' and ') + ' both go to "' + (labels[k] || k) + '". Choose one of them and set the other to "Do not import".' });
      }
    });
    if (!Object.keys(m).length) out.push({ kind: 'empty', text: 'Every column is set to "Do not import". Choose where at least one column goes.' });
    else if (imp.options.matchBy === 'name' && !m.fullName && !(m.lastName || m.firstName)) {
      out.push({ kind: 'id', text: 'To find students by name, match the Last Name and First Name columns (or one column with the full name). Or choose "Find students by: No" below.' });
    } else if (imp.options.matchBy === 'no' && !m.no) {
      out.push({ kind: 'id', text: 'To find students by No, match the column that holds the student number to "No". Or choose "Find students by: Name" below.' });
    }
    return out;
  }

  function planKeyFor(course) {
    return course.id + ':' + (GT.store.version ? GT.store.version() : 0) + ':' + imp.sheetIndex + ':' + imp.headerIndex + ':' +
      imp.mapping.join(',') + ':' + JSON.stringify(imp.options);
  }

  function ensurePlan(course) {
    var key = planKeyFor(course);
    if (imp.planKey === key && (imp.plan || imp.planError)) return;
    imp.planKey = key;
    imp.plan = null;
    imp.planError = null;
    try {
      var input = planInput();
      var p = GT.importer.plan(course, input.rows, input.headerIndex, imp.mapping.slice(), planOptions());
      if (!p || !Array.isArray(p.items)) throw new Error('The import module returned no plan.');
      imp.plan = p;
    } catch (e) {
      logErr(e);
      imp.planError = errText(e);
    }
  }

  function planOptions() {
    var o = imp.options;
    return {
      matchBy: o.matchBy, createMissing: !!o.createMissing, emptyCells: o.emptyCells, overwrite: !!o.overwrite,
      switchAttendanceToTotals: !!(o.switchAttendanceToTotals && hasAttendanceTarget()),
      // Matching by No: rename a student whose name in the file is spelled differently (off: such a row is skipped).
      updateNames: o.matchBy === 'no' && !!o.updateNames,
      finalLetterCells: planLetterCells()
    };
  }

  /** The marked final-letter cells of the current sheet, in the row indexes planInput gives the importer. */
  function planLetterCells() {
    var s = imp.sheets[imp.sheetIndex];
    var cells = s && Array.isArray(s.finalLetterCells) ? s.finalLetterCells : null;
    if (!cells) return null;
    var shift = planInput().shift;
    return cells.map(function (p) { return [p[0] + shift, p[1]]; });
  }

  /** A message of the plan with its "row N" in the file's numbering: without a header row, the plan
   * counts the blank header row put in front of the data (see planInput). Quoted text from the file is
   * left as it is. */
  function fileRowText(text, shift) {
    var s = str(text);
    if (!shift) return s;
    return s.replace(/"[^"]*"|\brow (\d+)\b/g, function (m, n) {
      if (n === undefined) return m;
      var v = parseInt(n, 10) - shift;
      return v >= 1 ? 'row ' + v : m;
    });
  }

  function onImportCourseChanged(course) {
    if (!imp.courseId || imp.courseId === course.id) { imp.courseId = course.id; return; }
    if (imp.loading) { imp.courseId = course.id; return; } // the columns are matched when reading ends
    if (imp.step >= 2 && imp.step <= 4) {
      // A file is open for another course: keep the file, match its columns again for this course.
      imp.courseId = course.id;
      remap();
      if (imp.step > 3) imp.step = 3;
      imp.notice = 'You switched to ' + course.code + ': the columns were matched again for this course. Check them before going on.';
      return;
    }
    loadSeq++;
    imp = freshImport();
    imp.courseId = course.id;
  }

  // ------------------------------------------------------------------ render: import card

  var STEPS = ['Choose file', 'Check the sheet', 'Match columns', 'Preview and import'];

  function renderImport(course) {
    if (!importerReady()) {
      patch(dom.impBody, 'imp', '<div class="callout callout-warn"><strong>Import is not available.</strong> The import module ' +
        '(js/core/importer.js) is not loaded. Keep every file of Grade Tracker together and reload the page.</div>');
      return;
    }
    var html = stepperHtml();
    if (imp.notice && imp.step >= 2 && imp.step <= 4) {
      html += '<div class="callout xc-notice" role="status">' + icon('info') + '<span>' + esc(imp.notice) + '</span></div>';
    }
    if (imp.step === 1) html += step1Html();
    else if (imp.step === 2) html += step2Html(course);
    else if (imp.step === 3) html += step3Html(course);
    else if (imp.step === 4) html += step4Html(course);
    else html += step5Html(course);
    var changed = patch(dom.impBody, 'imp', html);
    if (focusStepHeading) {
      focusStepHeading = false;
      var h = dom.impBody.querySelector('.xc-imp-step-h');
      if (h) focusEl(h);
    } else if (changed && document.activeElement === document.body) {
      var h2 = dom.impBody.querySelector('.xc-imp-step-h');
      if (h2) { try { h2.focus({ preventScroll: true }); } catch (e) { h2.focus(); } }
    }
  }

  function stepperHtml() {
    var cur = Math.min(imp.step, 4);
    var done = imp.step === 5;
    return '<ol class="xc-steps" aria-label="Import steps">' + STEPS.map(function (s, i) {
      var n = i + 1;
      var state = done || n < cur ? 'is-done' : n === cur ? 'is-current' : '';
      return '<li class="' + state + '"' + (n === cur && !done ? ' aria-current="step"' : '') + '>' +
        '<span class="xc-step-dot">' + (state === 'is-done' ? icon('check') : n) + '</span>' +
        '<span class="xc-step-label">' + esc(s) + '</span>' +
        (state === 'is-done' ? '<span class="sr-only"> (done)</span>' : '') + '</li>';
    }).join('') + '</ol>';
  }

  function stepHead(n, title, sub) {
    return '<h3 class="xc-imp-step-h" tabindex="-1"><span class="xc-num">' + n + '</span>' + esc(title) + '</h3>' +
      (sub ? '<p class="xc-step-sub">' + sub + '</p>' : '');
  }

  function step1Html() {
    var out = stepHead(1, 'Choose the file to import', null);
    if (imp.error) {
      out += '<div class="callout callout-danger xc-imp-error" role="alert"><strong>' + esc(imp.error.title) + '</strong>' +
        (imp.error.fileName ? ' <span class="muted">(' + esc(imp.error.fileName) + ')</span>' : '') + imp.error.html + '</div>';
    }
    out += '<div class="xc-drop" id="xc-drop">' +
      (imp.loading
        ? '<p class="xc-drop-busy" role="status">' + spinner() + 'Reading ' + esc(imp.fileName) + '\u2026</p>'
        : icon('upload', 'xc-drop-icon') +
          '<p class="xc-drop-title">Choose an Excel (.xlsx) or CSV (.csv) file</p>' +
          '<p class="xc-drop-sub">or drop it here</p>' +
          '<button type="button" class="btn btn-primary" data-act="pick-file" id="xc-pick">' + icon('file') + 'Choose file\u2026</button>') +
    '</div>' +
    '<div class="xc-imp-help">' +
      '<p><strong>What can I import?</strong></p>' +
      '<ul>' +
        '<li>The previous TA\'s grade sheet (No, Last Name, First Name, the scores, weighted columns such as "Project I 10%", Letter Grade, No of Absence). Its columns are matched automatically.</li>' +
        '<li>A class roster with Last Name and First Name, to add students.</li>' +
        '<li>A file downloaded from Grade Tracker (the Export card above).</li>' +
      '</ul>' +
      '<p class="muted">Old Excel files (.xls): ' + esc(XLS_HELP) + ' Nothing changes until you press Import on the last step, and one Undo (Ctrl+Z) reverts the whole import.</p>' +
    '</div>';
    return out;
  }

  function fileLine() {
    var rows = curRows();
    return '<p class="xc-file-line">' + icon('file') + '<span><strong>' + esc(imp.fileName) + '</strong> <span class="muted">(' +
      (imp.kind === 'xlsx' ? 'Excel workbook' : 'CSV file') + (imp.fileSize ? ', ' + esc(fmtBytes(imp.fileSize)) : '') + ', ' +
      plural(rows.length, 'row') + ')</span></span>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-act="imp-restart">Choose another file</button></p>';
  }

  /** Columns whose cells hold names or notes (by the current mapping). */
  function piiColumns() {
    var out = {};
    imp.mapping.forEach(function (k, i) { if (PII_TARGETS[k]) out[i] = true; });
    return out;
  }

  function step2Html(course) {
    var rows = curRows();
    var n = colCount(rows);
    var out = stepHead(2, 'Check the sheet and the header row',
      'The header row holds the column names (No, Last Name, \u2026). It was found automatically; change it only if the preview below looks wrong.');
    out += fileLine();
    out += '<div class="field-row xc-fields">';
    if (imp.sheets.length > 1) {
      out += '<div class="field"><label for="xc-sheet">Sheet</label><select id="xc-sheet" data-act="sheet">' +
        imp.sheets.map(function (s, i) {
          return '<option value="' + i + '"' + (i === imp.sheetIndex ? ' selected' : '') + (s.tooMany ? ' disabled' : '') + '>' + esc(s.name) + ' (' +
            (s.tooMany ? 'more than ' + fmtCount(MAX_ROWS) + ' rows: too long to import' : plural(s.rows.length, 'row')) +
            (s.hidden ? ', hidden in Excel' : '') + ')</option>';
        }).join('') + '</select></div>';
    }
    var priv = privacyOn();
    var choices = Math.min(rows.length, HEADER_CHOICES);
    if (imp.headerIndex >= choices) choices = imp.headerIndex + 1;
    var opts = '<option value="-1"' + (imp.headerIndex === -1 ? ' selected' : '') + '>No header row' +
      (imp.headerAuto === -1 ? ' (found automatically)' : '') + ': row 1 is a student</option>';
    for (var r = 0; r < choices; r++) {
      var cells = (rows[r] || []).filter(function (v) { return String(v).trim() !== ''; });
      var preview = priv ? '' : cells.slice(0, 4).join(' | ');
      if (preview.length > 60) preview = preview.slice(0, 57) + '\u2026';
      opts += '<option value="' + r + '"' + (r === imp.headerIndex ? ' selected' : '') + '>Row ' + (r + 1) +
        (r === imp.headerAuto ? ' (found automatically)' : '') + (preview ? ': ' + esc(preview) : '') + '</option>';
    }
    out += '<div class="field xc-header-field"><label for="xc-header-row">Header row</label><select id="xc-header-row" data-act="header-row" aria-describedby="xc-header-check">' + opts + '</select></div>';
    out += '</div>';

    var noHeader = imp.headerIndex < 0;
    var check = '';
    if (noHeader) {
      check = note('info', 'No header row: every row is read as a student, starting with row 1. On the next step, choose where each column goes.');
    } else {
      // A data row taken as the header row would never be imported, and nothing else would say so.
      var look = headerLook(rows[imp.headerIndex], course);
      if (look.numbers > 0 || look.known === 0) {
        var why = [];
        if (look.numbers) why.push(look.numbers === 1 ? 'holds a number' : 'holds numbers');
        if (!look.known) why.push('has no column name that Grade Tracker knows');
        check = note('alert', 'Check the header row: row ' + (imp.headerIndex + 1) + ' ' + why.join(' and ') + ', so it may be a student. ' +
          'If the file has no header row, choose <strong>No header row</strong> above; otherwise row ' + (imp.headerIndex + 1) + ' is not imported.', 'is-warn');
      }
    }
    out += '<div class="xc-header-check" id="xc-header-check">' + check + '</div>';

    var pii = piiColumns();
    var firstData = imp.headerIndex + 1;
    var dataRows = Math.max(0, rows.length - firstData);
    var last = Math.min(rows.length, firstData + PREVIEW_ROWS);
    var table = '<div class="table-wrap xc-preview-wrap" data-keep-scroll="preview"><table class="table xc-preview"><thead><tr><th class="xc-rownum" scope="col"><span class="sr-only">Row</span></th>';
    for (var c = 0; c < n; c++) table += '<th scope="col" class="xc-colhead">' + colLetter(c) + '</th>';
    table += '</tr></thead><tbody>';
    for (var i = Math.max(0, imp.headerIndex); i < last; i++) {
      var isHead = i === imp.headerIndex;
      table += '<tr' + (isHead ? ' class="xc-header-row"' : '') + '><th scope="row" class="xc-rownum">' + (i + 1) + '</th>';
      for (var k = 0; k < n; k++) {
        var v = rows[i] && rows[i][k] !== undefined ? rows[i][k] : '';
        // Name cells get no tooltip: it would show the name even in privacy mode. A header cell that is not
        // a known column name may be a name too (a file without a header row).
        var isPii = v !== '' && (isHead ? !imp.headerKnown[k] : pii[k]);
        var tip = !isPii || (isHead && !priv);
        table += '<td' + (isPii ? ' class="pii"' : '') + (tip ? ' title="' + esc(v) + '"' : '') + '>' + esc(v) + '</td>';
      }
      table += '</tr>';
    }
    table += '</tbody></table></div>';
    out += '<p class="xc-preview-cap">' + (noHeader
      ? 'Preview: the first ' + plural(last, 'row') + ' of ' + plural(dataRows, 'data row') + ' (no header row).'
      : 'Preview: the header row (highlighted) and the next ' + plural(Math.max(0, last - firstData), 'row') + ' of ' + plural(dataRows, 'data row') + '.') + '</p>';
    out += table;
    out += '<div class="xc-step-foot">' +
      '<button type="button" class="btn" data-act="imp-restart">' + icon('chevron-right', 'xc-flip') + 'Back</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-primary" data-act="imp-next" id="xc-next-2"' + (n === 0 ? ' disabled' : '') + '>Next: match the columns' + icon('chevron-right') + '</button>' +
    '</div>';
    return out;
  }

  function targetGroups(course) {
    var groups = [
      { id: 'student', label: 'Student details', items: [] },
      { id: 'raw', label: 'Scores', items: [] },
      { id: 'weighted', label: 'Weighted scores (converted back to scores)', items: [] },
      { id: 'late', label: 'Late work (weeks late)', items: [] },
      { id: 'letter', label: 'Final letter', items: [] },
      { id: 'att', label: 'Absences (totals)', items: [] },
      { id: 'other', label: 'Other', items: [] }
    ];
    var by = {};
    groups.forEach(function (g) { by[g.id] = g; });
    var ignore = null;
    targetList(course).forEach(function (t) {
      var k = t.key;
      if (k === 'ignore') { ignore = t; return; }
      var g = STUDENT_TARGETS[k] ? 'student' : /^raw:/.test(k) ? 'raw' : /^weighted:/.test(k) ? 'weighted' : /^late:/.test(k) ? 'late'
        : /letter/i.test(k) ? 'letter' : ATTENDANCE_TARGETS[k] ? 'att' : 'other';
      by[g].items.push(t);
    });
    return { ignore: ignore, groups: groups.filter(function (g) { return g.items.length; }) };
  }

  function targetSelect(i, current, tg, header) {
    var html = '<select data-act="map" data-col="' + i + '" id="xc-map-' + i + '" aria-label="Import column ' + colLetter(i) +
      (header ? ' (' + esc(header) + ')' : '') + ' into">';
    html += '<option value="ignore"' + (current === 'ignore' ? ' selected' : '') + '>Do not import</option>';
    tg.groups.forEach(function (g) {
      html += '<optgroup label="' + esc(g.label) + '">' + g.items.map(function (t) {
        return '<option value="' + esc(t.key) + '"' + (t.key === current ? ' selected' : '') + '>' + esc(t.label) + '</option>';
      }).join('') + '</optgroup>';
    });
    return html + '</select>';
  }

  function step3Html(course) {
    var rows = curRows();
    var n = colCount(rows);
    var header = headerCells(rows, n);
    var tg = targetGroups(course);
    var problems = mappingProblems(course);
    var dupKeys = {};
    problems.forEach(function (p) { if (p.kind === 'dup') dupKeys[p.key] = true; });
    var finalized = isFinalized(course);
    var m = mappedSet();

    var out = stepHead(3, 'Match each column to where it goes',
      (imp.headerIndex < 0
        ? 'The file has no header row, so nothing could be matched automatically. Use the sample values to choose where each column goes in <strong>Import into</strong>. '
        : 'Each column of the file was matched automatically. Check the <strong>Import into</strong> column and change anything that is wrong. ') +
      'Columns set to "Do not import" are skipped. Total is always calculated by Grade Tracker, so it is never imported.');
    out += fileLine();
    if (finalized) {
      out += '<div class="callout callout-warn xc-final-note">' + icon('lock') + ' <strong>Scores are finalized</strong> (' +
        esc(localDate(course.finalized.at)) + '). Score and participation columns will be skipped: unlock the scores in the Grades tab first to import them. ' +
        'Student details and final letters can still be imported. <button type="button" class="btn btn-sm" data-act="goto-grades">Open Grades</button></div>';
    }
    if (problems.length) {
      out += '<div class="callout callout-danger xc-problems" role="alert"><ul>' + problems.map(function (p) {
        return '<li>' + esc(p.text) + '</li>';
      }).join('') + '</ul></div>';
    }
    var pii = piiColumns();
    out += '<div class="table-wrap xc-map-wrap" data-keep-scroll="map"><table class="table xc-map" id="xc-map"><thead><tr>' +
      '<th scope="col">Column</th><th scope="col">Header in the file</th><th scope="col">Sample values</th><th scope="col">Import into</th></tr></thead><tbody>';
    for (var i = 0; i < n; i++) {
      var t = imp.mapping[i] || 'ignore';
      var samples = [];
      for (var r = imp.headerIndex + 1; r < rows.length && samples.length < SAMPLE_VALUES; r++) {
        var v = rows[r] && rows[r][i] !== undefined ? String(rows[r][i]).trim() : '';
        if (v !== '') samples.push(v);
      }
      var cls = (t === 'ignore' ? 'is-ignored' : '') + (dupKeys[t] ? ' is-dup' : '');
      // A header cell that is not a known column name may be a student's name (a file without a header row).
      var headText = header[i].trim()
        ? '<span' + (imp.headerKnown[i] ? '' : ' class="pii"') + '>' + esc(header[i]) + '</span>'
        : '<span class="muted">' + (imp.headerIndex < 0 ? '(no header row)' : '(blank)') + '</span>';
      out += '<tr class="' + cls.trim() + '" data-col="' + i + '">' +
        '<td class="xc-map-letter">' + colLetter(i) + '</td>' +
        '<td class="xc-map-header">' + headText + '</td>' +
        '<td class="xc-map-samples">' + (samples.length ? samples.map(function (s) {
          return '<span class="xc-sample' + (pii[i] ? ' pii"' : '" title="' + esc(s) + '"') + '>' + esc(s) + '</span>';
        }).join('') : '<span class="muted">(empty)</span>') + '</td>' +
        '<td class="xc-map-target">' + targetSelect(i, t, tg, shownHeader(header, i)) +
          (dupKeys[t] ? '<span class="badge badge-danger">' + icon('alert') + 'used twice</span>' : '') +
          (finalized && isScoreTarget(t) ? '<span class="badge badge-warn" title="Scores are finalized: unlock them in the Grades tab first">' + icon('lock') + 'blocked: scores are finalized</span>' : '') +
        '</td></tr>';
    }
    out += '</tbody></table></div>';

    // Options
    var o = imp.options;
    out += '<fieldset class="xc-imp-options"><legend>How to import</legend>' +
      '<div class="xc-opt"><span class="label" id="xc-match-l">Find existing students by</span>' +
        '<div class="segmented" role="group" aria-labelledby="xc-match-l">' +
          '<button type="button" data-act="opt-match" data-key="name" aria-pressed="' + (o.matchBy === 'name') + '">Name (last + first)</button>' +
          '<button type="button" data-act="opt-match" data-key="no" aria-pressed="' + (o.matchBy === 'no') + '">No (student number)</button>' +
        '</div><span class="xc-help">Capital letters and extra spaces are ignored.</span></div>' +
      updateNamesHtml(o) +
      '<label class="check"><input type="checkbox" id="xc-opt-create" data-act="opt-create"' + (o.createMissing ? ' checked' : '') + '> ' +
        'Add students who are not in ' + esc(course.code) + ' yet</label>' +
      '<div class="xc-opt"><span class="label" id="xc-empty-l">Empty cells in the file</span>' +
        '<div class="segmented" role="group" aria-labelledby="xc-empty-l">' +
          '<button type="button" data-act="opt-empty" data-key="keep" aria-pressed="' + (o.emptyCells === 'keep') + '">Keep what Grade Tracker has</button>' +
          '<button type="button" data-act="opt-empty" data-key="clear" aria-pressed="' + (o.emptyCells === 'clear') + '">Clear the value</button>' +
        '</div></div>' +
      '<label class="check"><input type="checkbox" id="xc-opt-overwrite" data-act="opt-overwrite"' + (o.overwrite ? ' checked' : '') + '> ' +
        'Replace scores that are already entered (untick to fill only empty scores)</label>';
    if (hasAttendanceTarget() && attendanceMode(course) !== 'totals') {
      var mode = attendanceMode(course);
      out += '<div class="xc-att-offer">' +
        '<label class="check"><input type="checkbox" id="xc-opt-att" data-act="opt-att"' + (o.switchAttendanceToTotals ? ' checked' : '') + '> ' +
          'Switch attendance for ' + esc(course.code) + ' to "Totals only"</label>' +
        '<p class="xc-help">' + (mode === 'off'
          ? 'Attendance is off for this course, so the imported absence counts would not be shown until you turn it on.'
          : 'This course records attendance per session. Imported counts are stored as totals and are used only in "Totals only" mode; your per-session marks are kept either way.') +
        ' After the import, enter the number of sessions held in the Attendance tab to get the absence rates.</p></div>';
    }
    out += '</fieldset>';
    var notes = mappingNotes(course, header);
    if (notes.length) {
      out += '<ul class="xc-map-notes">' + notes.map(function (t) { return '<li>' + icon('info', 'icon-sm') + '<span>' + t + '</span></li>'; }).join('') + '</ul>';
    }

    out += '<div class="xc-step-foot">' +
      '<button type="button" class="btn" data-act="imp-back">' + icon('chevron-right', 'xc-flip') + 'Back</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-primary" data-act="imp-next" id="xc-next-3"' + (problems.length ? ' disabled' : '') + '>Next: preview the changes' + icon('chevron-right') + '</button>' +
    '</div>';
    return out;
  }

  /** Matching by No with a name column mapped: whether a differently spelled name in the file renames
   * the student. Off (the default), such a row is skipped, because the file may number its students in
   * another order and its scores would land on another student. */
  function updateNamesHtml(o) {
    var m = mappedSet();
    if (o.matchBy !== 'no' || !(m.lastName || m.firstName || m.fullName)) return '';
    return '<div class="xc-opt-sub">' +
      '<label class="check"><input type="checkbox" id="xc-opt-names" data-act="opt-update-names"' + (o.updateNames ? ' checked' : '') +
        ' aria-describedby="xc-opt-names-h"> Update names from the file (to fix spellings)</label>' +
      '<p class="xc-help" id="xc-opt-names-h">' + (o.updateNames
        ? 'On: a student whose name in the file is spelled differently gets the file\'s spelling. Use this only when the file\'s No values are the students\' real numbers in this course.'
        : 'Off: a row whose name differs from the student with that No is skipped, because the file may number its students differently.') +
      '</p></div>';
  }

  /** Plain-language notes on the current mapping (html). */
  function mappingNotes(course, header) {
    var out = [];
    var colOf = function (key) { return imp.mapping.indexOf(key); };
    var name = function (i) { var h = shownHeader(header, i); return colLetter(i) + (h ? ' ("' + esc(h) + '")' : ''); };
    course.assessments.forEach(function (a) {
      var r = colOf('raw:' + a.id), w = colOf('weighted:' + a.id);
      if (r >= 0 && w >= 0) {
        out.push(esc(a.name) + ': the score comes from column ' + name(r) + '. Column ' + name(w) + ' holds the same score weighted, so it is not needed and is skipped.');
      } else if (w >= 0) {
        // The importer converts with the weight written in the header ("Project II 20%") when it differs
        // from this course's weight: the file's points were computed with that weight.
        var hw = typeof GT.importer.weightFromHeader === 'function' ? GT.importer.weightFromHeader(header[w]) : null;
        var cw = typeof a.weight === 'number' ? a.weight : 0;
        var differs = typeof hw === 'number' && isFinite(hw) && util.fix(hw) !== util.fix(cw);
        if (differs && !(hw > 0)) {
          out.push(esc(a.name) + ': column ' + name(w) + ' is skipped: its header says 0%, and a weight of 0% cannot be turned back into scores.');
        } else {
          var wUsed = differs ? hw : cw;
          out.push(esc(a.name) + ': column ' + name(w) + ' holds weighted points; each value is turned back into a score (value \u00f7 ' +
            esc(String(wUsed)) + ' \u00d7 ' + esc(String(a.maxScore)) + ').' +
            (differs ? ' The header says ' + esc(String(hw)) + '%, but ' + esc(a.name) + ' weighs ' + esc(String(cw)) +
              '% in this course, so the header\'s weight is used.' : ''));
        }
      }
    });
    var fl = colOf('finalLetter');
    if (fl >= 0) {
      var sheet = imp.sheets[imp.sheetIndex];
      // A Grade Tracker workbook lists the letters the importer takes as final letters (readWorkbook): the
      // marked ones and those changed in the spreadsheet after the export. They are counted apart: only
      // the first ones carry a mark the TA can find in the file.
      var counts = sheet && Array.isArray(sheet.finalLetterCells) && !/\bfinal\b/i.test(str(header[fl]))
        ? finalLetterCounts(sheet, fl) : null;
      if (counts && counts.marked + counts.edited === 0) {
        out.push('Column ' + name(fl) + ' comes from a Grade Tracker file that has no <strong>final letters</strong> yet: its letters are suggestions from the cutoffs, so none is stored as a final letter.');
      } else if (counts) {
        var parts = [];
        if (counts.marked) {
          parts.push('its ' + plural(counts.marked, 'letter') + ' marked as ' + (counts.marked === 1 ? 'a final letter' : 'final letters') + ' (assigned by the instructor)');
        }
        if (counts.edited) parts.push('its ' + plural(counts.edited, 'letter') + ' changed in the spreadsheet after the export');
        var one = counts.marked + counts.edited === 1;
        out.push('Column ' + name(fl) + ' comes from a Grade Tracker file: only ' + parts.join(' and ') + ' ' +
          (one ? 'is imported as a <strong>final letter</strong>' : 'are imported as <strong>final letters</strong>') +
          '. The other letters were suggestions from the cutoffs and are not stored.');
      } else {
        out.push('Column ' + name(fl) + ' sets each student\'s <strong>final letter</strong>. If those letters were only suggestions, set it to "Do not import". Letters that are not in this course\'s scale are skipped.');
      }
    }
    // Letters changed after the export in a letter column that is not read (the "Everything" preset has
    // three letter columns; review V4R3-1). The importer takes each one when the Final letter column is
    // empty for that student, and reports the rest (GT.importer.plan), so none is dropped silently.
    var sheetE = imp.sheets[imp.sheetIndex];
    var editedIn = {};
    (sheetE && Array.isArray(sheetE.editedLetterCells) ? sheetE.editedLetterCells : []).forEach(function (p) {
      if (p[0] > imp.headerIndex && p[1] !== fl && imp.mapping[p[1]] === 'ignore') editedIn[p[1]] = (editedIn[p[1]] || 0) + 1;
    });
    Object.keys(editedIn).forEach(function (k) {
      var ci = Number(k), n = editedIn[k];
      out.push('Column ' + name(ci) + ' has ' + plural(n, 'letter') + ' changed in the spreadsheet after the export. ' + (fl >= 0
        ? (n === 1 ? 'It is' : 'Each one is') + ' imported as the <strong>final letter</strong> when column ' + name(fl) +
          ' is empty for that student. A letter that differs from column ' + name(fl) + ' is not imported, and the preview lists it.'
        : (n === 1 ? 'It is' : 'They are') + ' not imported: set this column to "Final letter" to import ' + (n === 1 ? 'it' : 'them') + '.'));
    });
    var ab = colOf('absent'), at = colOf('absencesTotal');
    if (ab >= 0 && at >= 0) out.push('Column ' + name(at) + ' is skipped: unexcused absences come from column ' + name(ab) + '.');
    else if (at >= 0) {
      out.push('Column ' + name(at) + ' is one total: the excused (allowed) absences already stored stay, and the rest is stored as unexcused (not allowed) absences, so each student\'s total equals the file.');
    }
    return out;
  }

  /** The final letters of a Grade Tracker sheet in column col, below the header row: { marked } with
   * the note "Final letter assigned by the instructor", { edited } changed in the spreadsheet after the
   * export (both are in finalLetterCells; editedLetterCells tells them apart). */
  function finalLetterCounts(sheet, col) {
    var edited = Object.create(null);
    (Array.isArray(sheet.editedLetterCells) ? sheet.editedLetterCells : []).forEach(function (p) {
      if (p[1] === col) edited[p[0]] = true;
    });
    var out = { marked: 0, edited: 0 };
    sheet.finalLetterCells.forEach(function (p) {
      if (p[1] !== col || p[0] <= imp.headerIndex) return;
      if (edited[p[0]]) out.edited++;
      else out.marked++;
    });
    return out;
  }

  function targetLabel(course, key) {
    var k = str(key);
    var list = targetList(course);
    for (var i = 0; i < list.length; i++) if (list[i].key === k) return list[i].label;
    var m = /^(raw|weighted|late):(.+)$/.exec(k);
    if (m) {
      var a = model.findAssessment(course, m[2]);
      if (a) return m[1] === 'raw' ? a.name : m[1] === 'weighted' ? a.name + ' (weighted)' : a.name + ': weeks late';
    }
    return util.hasOwn(NAME_FIELD_LABELS, k) ? NAME_FIELD_LABELS[k] : k;
  }

  function valueHtml(v) {
    var s = str(v);
    return s === '' ? '<span class="muted">(empty)</span>' : esc(s);
  }

  function step4Html(course) {
    ensurePlan(course);
    var out = stepHead(4, 'Preview the changes', 'Nothing has changed yet. Check the summary, then press <strong>Import</strong>.');
    out += fileLine();
    if (imp.planError) {
      out += '<div class="callout callout-danger" role="alert"><strong>The preview could not be made.</strong> ' + esc(imp.planError) + '</div>';
      out += '<div class="xc-step-foot"><button type="button" class="btn" data-act="imp-back">' + icon('chevron-right', 'xc-flip') + 'Back</button></div>';
      return out;
    }
    var plan = imp.plan;
    var counts = plan.counts || {};
    var finalized = isFinalized(course);
    var errors = Array.isArray(plan.errors) ? plan.errors.filter(Boolean) : [];
    if (errors.length) {
      out += '<div class="callout callout-danger" role="alert"><strong>This import cannot run yet.</strong><ul class="xc-plain-list">' +
        errors.map(function (t) { return '<li>' + esc(str(t)) + '</li>'; }).join('') + '</ul></div>';
      out += '<div class="xc-step-foot"><button type="button" class="btn" data-act="imp-back">' + icon('chevron-right', 'xc-flip') + 'Back</button></div>';
      return out;
    }
    // Row numbers of the file (the plan counts a blank header row in front when the file has none);
    // fileRowText does the same for the "row N" inside the plan's messages.
    var shift = planInput().shift;
    var rowNoOf = function (it) { return typeof it.rowIndex === 'number' ? it.rowIndex + 1 - shift : ''; };
    // The attendance mode switch is a change of its own: it is applied even when every count is the same.
    var modeNow = attendanceMode(course);
    var switchMode = !!(plan.options && plan.options.switchAttendanceToTotals && plan.attendanceMapped !== false) && modeNow !== 'totals';
    var tiles = [];
    if (switchMode) {
      tiles.push('<div class="xc-count"><span class="xc-count-n">1</span><span class="xc-count-l">course setting changed (attendance mode)</span></div>');
    }
    COUNT_INFO.forEach(function (ci) {
      var v = counts[ci.key];
      if (typeof v !== 'number') return;
      if (!v && ['update', 'new', 'changes', 'skip'].indexOf(ci.key) === -1) return;
      tiles.push('<div class="xc-count' + (ci.warn && v ? ' is-warn' : '') + (v ? '' : ' is-zero') + '"' + (ci.help ? ' title="' + esc(ci.help) + '"' : '') + '>' +
        '<span class="xc-count-n">' + fmtCount(v) + '</span><span class="xc-count-l">' + esc(v === 1 ? ci.one : ci.label) + '</span></div>');
    });
    Object.keys(counts).forEach(function (k) {
      if (COUNT_INFO.some(function (ci) { return ci.key === k; })) return;
      if (typeof counts[k] !== 'number' || !counts[k]) return;
      tiles.push('<div class="xc-count"><span class="xc-count-n">' + fmtCount(counts[k]) + '</span><span class="xc-count-l">' + esc(countWords(k)) + '</span></div>');
    });
    out += '<div class="xc-counts">' + tiles.join('') + '</div>';
    var helps = COUNT_INFO.filter(function (ci) { return ci.help && counts[ci.key]; }).map(function (ci) {
      return '<li><strong>' + esc(ci.label.charAt(0).toUpperCase() + ci.label.slice(1)) + ':</strong> ' + esc(ci.help) + '</li>';
    });
    if (helps.length) out += '<ul class="xc-count-help">' + helps.join('') + '</ul>';
    if (finalized && counts.blocked) {
      out += '<div class="callout callout-warn xc-final-note">' + icon('lock') + ' Scores are finalized, so score changes are not imported. ' +
        '<button type="button" class="btn btn-sm" data-act="goto-grades">Open Grades</button></div>';
    }
    var finalReason = GT.importer.FINALIZED_REASON ? String(GT.importer.FINALIZED_REASON) : null;
    var planNotes = (Array.isArray(plan.notes) ? plan.notes.filter(Boolean) : []).filter(function (t) {
      // The finalized callout above already says this.
      return !(finalized && counts.blocked && finalReason && String(t).indexOf(finalReason) === 0);
    });
    if (planNotes.length) {
      out += '<ul class="xc-map-notes">' + planNotes.map(function (t) { return '<li>' + icon('info', 'icon-sm') + '<span>' + esc(str(t)) + '</span></li>'; }).join('') + '</ul>';
    }

    // Changes (first 50). The heading counts them the way the tiles do (UX-22): the student changes of the
    // "changes" tile, then what the list adds to them (team-score followers, blocked changes, the course setting).
    var changes = [];
    var total = 0, nItem = 0, nBlocked = 0, nPropagated = 0;
    if (switchMode) {
      total++;
      changes.push({ item: { action: 'course' }, ch: { field: 'Attendance mode', oldValue: ATTENDANCE_MODE_LABELS[modeNow], newValue: ATTENDANCE_MODE_LABELS.totals } });
    }
    plan.items.forEach(function (it) {
      if (!it || it.action === 'skip' || !Array.isArray(it.changes)) return;
      it.changes.forEach(function (ch) {
        total++;
        if (ch && (ch.blocked || ch.status === 'blocked')) nBlocked++; else nItem++;
        if (changes.length < CHANGE_LIMIT) changes.push({ item: it, ch: ch });
      });
    });
    // Teammates who are not in the file but follow a changed team score.
    (Array.isArray(plan.propagated) ? plan.propagated : []).forEach(function (p) {
      if (!p || !Array.isArray(p.changes)) return;
      p.changes.forEach(function (ch) {
        total++;
        nPropagated++;
        if (changes.length < CHANGE_LIMIT) changes.push({ item: { action: 'propagated', name: p.name }, ch: ch });
      });
    });
    var nStudent = typeof counts.changes === 'number' ? counts.changes : nItem;
    var countParts = [fmtCount(nStudent)];
    if (nPropagated) countParts.push(fmtCount(nPropagated) + ' via team score');
    if (nBlocked) countParts.push(fmtCount(nBlocked) + ' blocked');
    if (switchMode) countParts.push('1 course setting');
    out += '<h4 class="xc-sub-h">Changes' + (total ? ' <span class="muted">(' + countParts.join(' + ') +
      (total > CHANGE_LIMIT ? '; the first ' + CHANGE_LIMIT + ' are listed' : '') + ')</span>' : '') + '</h4>';
    var used = plan.items.filter(function (it) { return it && it.action !== 'skip'; }).length;
    if (!changes.length) {
      if (!plan.items.length) {
        out += note('alert', imp.headerIndex < 0
          ? 'This sheet has no data rows. Choose another sheet or another file.'
          : 'This file has no data rows under the header row (row ' + (imp.headerIndex + 1) + '). Choose another header row (Back) or another file.', 'is-warn');
      } else if (!used) {
        out += note('alert', 'Nothing to import: every row of the file is skipped. The reasons are listed under "Skipped rows" below.', 'is-warn');
      } else {
        out += note('info', 'Nothing to change: the file matches what is already in Grade Tracker' +
          (counts.kept ? ', except for ' + plural(counts.kept, 'value') + ' kept because "Replace scores that are already entered" is off' : '') + '.');
      }
    } else {
      out += '<div class="table-wrap xc-changes-wrap" data-keep-scroll="changes"><table class="table xc-changes"><thead><tr>' +
        '<th scope="col">Student</th><th scope="col">What</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>' +
        changes.map(function (x) {
          var it = x.item, ch = x.ch || {};
          if (it.action === 'course') {
            return '<tr class="xc-course-change"><td><span class="muted">Whole course</span></td><td>' + esc(str(ch.field)) + '</td>' +
              '<td class="xc-old">' + valueHtml(ch.oldValue) + '</td><td class="xc-new">' + valueHtml(ch.newValue) + '</td></tr>';
          }
          var blocked = ch.blocked || ch.status === 'blocked';
          var flags = (it.action === 'new' ? '<span class="badge badge-accent">new</span>' : '') +
            (it.action === 'propagated' ? '<span class="badge badge-info" title="Not in the file: follows the new team score">via team score</span>' : '') +
            (ch.outOfRange ? '<span class="badge badge-warn">out of range</span>' : '') +
            (blocked ? '<span class="badge badge-warn">' + icon('lock') + 'blocked</span>' : '') +
            (ch.invalid ? '<span class="badge badge-danger">not a number</span>' : '') +
            (ch.notOnList ? '<span class="badge badge-warn">not on the list</span>' : '') +
            (ch.emptiedByMove ? '<span class="badge badge-warn" title="The new team has no score for this item yet">emptied by the team move</span>' : '') +
            (ch.override ? '<span class="badge badge-accent">override</span>' : '');
          var isPiiField = /name|notes/i.test(str(ch.field));
          return '<tr' + (blocked ? ' class="is-blocked"' : '') + '><td><span class="pii">' + esc(str(it.name) || '(no name)') + '</span> ' + flags + '</td>' +
            '<td>' + esc(targetLabel(course, ch.field)) + '</td>' +
            '<td class="xc-old' + (isPiiField ? ' pii' : '') + '">' + valueHtml(ch.oldValue) + '</td>' +
            '<td class="xc-new' + (isPiiField ? ' pii' : '') + '">' + valueHtml(ch.newValue) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    // Values to check (rows that are imported, with a cell that is not)
    var issues = [];
    plan.items.forEach(function (it) {
      if (!it || it.action === 'skip' || !Array.isArray(it.issues)) return;
      it.issues.forEach(function (x) { if (x) issues.push({ item: it, x: x }); });
    });
    if (issues.length) {
      out += '<h4 class="xc-sub-h">Values to check <span class="muted">(' + fmtCount(issues.length) + ')</span></h4>' +
        '<ul class="xc-skipped xc-issues">' + issues.slice(0, SKIP_LIMIT).map(function (y) {
          var rowNo = rowNoOf(y.item);
          return '<li><span class="xc-skip-row">Row ' + esc(rowNo) + '</span>' +
            (y.item.name ? '<span class="pii">' + esc(y.item.name) + '</span>' : '') +
            '<span class="xc-issue-field">' + esc(str(y.x.field)) + (str(y.x.value) !== '' ? ' "' + esc(str(y.x.value).slice(0, 40)) + '"' : '') + '</span>' +
            '<span class="xc-skip-reason">' + esc(fileRowText(y.x.message, shift)) + '</span></li>';
        }).join('') + (issues.length > SKIP_LIMIT ? '<li class="muted">\u2026and ' + (issues.length - SKIP_LIMIT) + ' more</li>' : '') + '</ul>';
    }

    // Skipped rows
    var skipped = plan.items.filter(function (it) { return it && it.action === 'skip'; });
    if (skipped.length) {
      out += '<h4 class="xc-sub-h">Skipped rows <span class="muted">(' + fmtCount(skipped.length) + ')</span></h4>' +
        '<ul class="xc-skipped">' + skipped.slice(0, SKIP_LIMIT).map(function (it) {
          var rowNo = rowNoOf(it);
          return '<li><span class="xc-skip-row">Row ' + esc(rowNo) + '</span>' +
            (it.name ? '<span class="pii">' + esc(it.name) + '</span>' : '') +
            '<span class="xc-skip-reason">' + esc(fileRowText(it.reason, shift) || 'Skipped') + '</span></li>';
        }).join('') + (skipped.length > SKIP_LIMIT ? '<li class="muted">\u2026and ' + (skipped.length - SKIP_LIMIT) + ' more</li>' : '') + '</ul>';
    }

    var realChanges = typeof counts.changes === 'number' ? counts.changes : total;
    var importable = realChanges > 0 || (counts['new'] || 0) > 0 || switchMode;
    out += '<div class="callout xc-undo-note">' + icon('undo') + '<span>The import is <strong>one step</strong>: Undo (Ctrl+Z, or the Undo button at the top) reverts the whole import. ' +
      'Every change is also written to the History tab.</span></div>';
    out += '<div class="xc-step-foot">' +
      '<button type="button" class="btn" data-act="imp-back">' + icon('chevron-right', 'xc-flip') + 'Back</button>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-primary" data-act="imp-import" id="xc-import-btn"' + (importable ? '' : ' disabled') + '>' +
        icon('upload') + 'Import into ' + esc(course.code) + '</button>' +
    '</div>';
    return out;
  }

  function step5Html(course) {
    var r = imp.result || {};
    var c = r.counts || {};
    var parts = [];
    if (c.update) parts.push(plural(c.update, 'student') + ' updated');
    if (c['new']) parts.push(plural(c['new'], 'new student'));
    if (typeof c.changes === 'number' && (c.changes || !r.switched)) parts.push(plural(c.changes, 'change'));
    if (c.skip) parts.push(plural(c.skip, 'row') + ' skipped');
    var sum = r.summary && typeof r.summary === 'object' ? r.summary : {};
    if (sum.teamsCreated) parts.push(plural(sum.teamsCreated, 'team') + ' created');
    if (r.nothing) {
      return '<div class="xc-done">' +
        '<div class="xc-done-icon is-info">' + icon('info') + '</div>' +
        '<h3 class="xc-imp-step-h" tabindex="-1">Nothing was changed</h3>' +
        '<p>' + esc(imp.fileName) + ' matches what is already in ' + esc(course.code) + '.</p>' +
        '<div class="xc-done-actions">' +
          '<button type="button" class="btn btn-primary" data-act="imp-restart">Import another file</button>' +
        '</div></div>';
    }
    // Where the import is in the undo history (followed by trackImport).
    var tr = r.track || { state: 'applied', later: 0 };
    var st = GT.store;
    var undoBtn = 'Undo (Ctrl+Z, or the Undo button at the top)';
    var redoBtn = 'Redo (Ctrl+Y, or the Redo button at the top)';
    if (tr.state === 'undone' || tr.state === 'discarded') {
      var how;
      if (tr.state === 'discarded') {
        how = 'It can no longer be redone, because other changes were made after the undo. To bring the data in again, import the file again.';
      } else if (tr.later) {
        how = redoBtn + ' first re-applies the ' + plural(tr.later, 'other change') + ' you undid after it, then the whole import.';
      } else {
        how = st.redoLabel && st.redoLabel() === r.label ? redoBtn + ' applies it again.' : '';
      }
      return '<div class="xc-done">' +
        '<div class="xc-done-icon is-info">' + icon('undo') + '</div>' +
        '<h3 class="xc-imp-step-h" tabindex="-1">The import was undone</h3>' +
        '<p>Everything imported from ' + esc(imp.fileName) + ' was reverted.' + (how ? ' ' + how : '') + '</p>' +
        '<div class="xc-done-actions">' +
          (tr.state === 'discarded' ? '<button type="button" class="btn btn-primary" data-act="imp-again">' + icon('upload') + 'Import this file again</button>' : '') +
          '<button type="button" class="btn' + (tr.state === 'discarded' ? ' btn-ghost' : ' btn-primary') + '" data-act="imp-restart">Import another file</button>' +
        '</div></div>';
    }
    var undoText;
    if (tr.state === 'gone') {
      undoText = 'The data was replaced since (a backup was restored or all data was reset), so this import can no longer be undone.';
    } else if (tr.later) {
      undoText = 'You made ' + plural(tr.later, 'change') + ' after the import. ' + undoBtn + ' reverts ' + (tr.later === 1 ? 'that change' : 'those changes') +
        ' first, then the whole import in one step.';
    } else if (st.undoLabel && st.undoLabel() === r.label) {
      undoText = undoBtn + ' reverts the whole import in one step.';
    } else {
      undoText = '';
    }
    return '<div class="xc-done">' +
      '<div class="xc-done-icon">' + icon('check') + '</div>' +
      '<h3 class="xc-imp-step-h" tabindex="-1">Imported from ' + esc(imp.fileName) + '</h3>' +
      '<p>' + esc(parts.join(', ') || 'Done') + '.' + (r.switched ? ' Attendance now uses "Totals only": enter the number of sessions held in the Attendance tab.' : '') + '</p>' +
      '<p class="muted">' + (undoText ? undoText + ' ' : '') + 'Every change is listed in the History tab.</p>' +
      '<div class="xc-done-actions">' +
        '<button type="button" class="btn btn-primary" data-act="goto-grades">' + icon('grid') + 'Open Grades</button>' +
        '<button type="button" class="btn" data-act="goto-history">' + icon('history') + 'See the changes in History</button>' +
        '<button type="button" class="btn btn-ghost" data-act="imp-restart">Import another file</button>' +
      '</div></div>';
  }

  /** Follows the finished import through the course's undo and redo stacks (store notifications), so the
   * done card never claims the import is applied, or that Undo reverts it, when that is no longer true.
   * `later` counts the steps above the import on the stack it is on. States: 'applied' (on the undo
   * stack), 'undone' (on the redo stack), 'discarded' (undone, then another change cleared the redo
   * stack), 'gone' (all data was replaced or the course deleted). */
  function trackImport(info) {
    var r = imp.result;
    var t = r && r.track;
    if (!t || !info) return;
    if (info.type === 'replace' || (info.type === 'course-delete' && info.courseId === r.courseId)) { t.state = 'gone'; return; }
    if (info.courseId !== r.courseId || t.state === 'gone' || t.state === 'discarded') return;
    if (info.type === 'transact') {
      // A new change goes on the undo stack and empties the redo stack.
      if (t.state === 'applied') t.later++;
      else { t.state = 'discarded'; t.later = 0; }
    } else if (info.type === 'undo') {
      if (t.state === 'applied') { if (t.later) t.later--; else t.state = 'undone'; }
      else t.later++;
    } else if (info.type === 'redo') {
      if (t.state === 'undone') { if (t.later) t.later--; else t.state = 'applied'; }
      else t.later++;
    }
  }

  // ------------------------------------------------------------------ import: actions

  function goStep(n) {
    imp.step = n;
    focusStepHeading = true;
    if (n !== 4) { imp.plan = null; imp.planKey = null; }
    announce('Step ' + Math.min(n, 4) + ' of 4: ' + STEPS[Math.min(n, 4) - 1] + '.');
    refresh();
  }

  function doImport() {
    var course = GT.store.course();
    if (!course || !importerReady() || imp.step !== 4) return;
    var input = planInput();
    var rows = input.rows;
    var headerIndex = input.headerIndex;
    var mapping = imp.mapping.slice();
    var options = planOptions();
    var usedPlan = null;
    var summary;
    var label = 'Import ' + imp.fileName;
    var versionBefore = GT.store.version ? GT.store.version() : null;
    var modeBefore = attendanceMode(course);
    try {
      summary = GT.store.transact(label, function (c) {
        // Planned again on the live course, so the import matches the data exactly as it is now.
        usedPlan = GT.importer.plan(c, rows, headerIndex, mapping, options);
        return GT.importer.apply(c, usedPlan);
      }, { source: 'import', courseId: course.id });
    } catch (e) {
      logErr(e);
      imp.planError = null;
      ui.dialog.open({
        title: 'Nothing was imported',
        bodyHtml: '<p>' + esc(errText(e)) + '</p><p class="muted">Your data is unchanged.</p>',
        buttons: [{ text: 'OK', value: true, primary: true }]
      });
      return;
    }
    var counts = usedPlan && usedPlan.counts ? usedPlan.counts : {};
    // transact notifies (and so bumps the version) only when the course really changed.
    var changed = versionBefore === null ? true : GT.store.version() !== versionBefore;
    var cNow = GT.store.course();
    var switched = (summary && summary.modeSwitched === true) || (modeBefore !== 'totals' && !!cNow && attendanceMode(cNow) === 'totals');
    imp.result = {
      counts: counts, summary: summary, label: label, courseId: course.id, nothing: !changed, switched: switched,
      track: changed ? { state: 'applied', later: 0 } : null   // followed by trackImport from now on
    };
    imp.step = 5;
    focusStepHeading = true;
    if (!changed) {
      ui.toast('Nothing to import: the file matches what is already in Grade Tracker.', { type: 'info' });
    } else {
      var what = [];
      if (counts.changes || !switched) what.push(plural(counts.changes || 0, 'change'));
      if (counts['new']) what.push(plural(counts['new'], 'new student'));
      if (switched) what.push('attendance now uses "Totals only"');
      var msg = 'Imported ' + imp.fileName + ': ' + what.join(', ') + '. Undo (Ctrl+Z) reverts the whole import.';
      ui.toast(msg, { type: 'success', timeout: 9000, action: { label: 'Open Grades', fn: function () { if (GT.app) GT.app.navigate('grades'); } } });
    }
    announce('Import finished.');
    refresh();
  }

  // ------------------------------------------------------------------ events

  function bindContainer(el) {
    boundEl = el;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    el.addEventListener('dragend', onDragEnd);
  }

  function onClick(e) {
    var a = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!a || !boundEl.contains(a) || a.disabled) return;
    var act = a.getAttribute('data-act');
    var key = a.getAttribute('data-key');
    switch (act) {
      case 'col-up': moveKey(key, -1, true); break;
      case 'col-down': moveKey(key, 1, true); break;
      case 'cols-all':
        editList(function (st, x) { st.list.forEach(function (it) { if (x.cmap[it.key] && x.cmap[it.key].available !== false) it.on = true; }); });
        announce('All available columns selected.');
        break;
      case 'cols-none':
        editList(function (st) { st.list.forEach(function (it) { it.on = false; }); });
        announce('No columns selected.');
        break;
      case 'cols-reset': {
        var x = currentExport();
        if (x) selectPreset(x.st.presetId);
        announce('Columns reset to the preset.');
        break;
      }
      case 'preset-save': savePreset(); break;
      case 'preset-rename': renamePreset(); break;
      case 'preset-delete': deletePreset(); break;
      case 'sort': setPrefs({ sort: key === 'no' ? 'no' : 'name' }); break;
      case 'download-xlsx': downloadXlsx(); break;
      case 'download-csv': downloadCsv(); break;
      case 'pick-file':
        if (dom && dom.file) dom.file.click();
        break;
      case 'imp-restart':
        loadSeq++;
        imp = freshImport();
        focusStepHeading = true;
        refresh();
        break;
      case 'imp-back':
        imp.notice = null;
        goStep(Math.max(1, imp.step - 1));
        break;
      case 'imp-next':
        imp.notice = null;
        if (imp.step === 3 && mappingProblems(GT.store.course()).length) { refresh(); return; }
        goStep(Math.min(4, imp.step + 1));
        break;
      case 'imp-import': doImport(); break;
      case 'imp-again':
        // The import was undone and can no longer be redone: preview the same file again on today's data.
        if (!imp.sheets.length) break;
        imp.result = null;
        imp.notice = null;
        goStep(mappingProblems(GT.store.course()).length ? 3 : 4);
        break;
      case 'opt-match': imp.options.matchBy = key === 'no' ? 'no' : 'name'; imp.planKey = null; refresh(); break;
      case 'opt-empty': imp.options.emptyCells = key === 'clear' ? 'clear' : 'keep'; imp.planKey = null; refresh(); break;
      case 'goto-grades': if (GT.app) GT.app.navigate('grades'); break;
      case 'goto-history': if (GT.app) GT.app.navigate('history'); break;
      default: break;
    }
  }

  function onChange(e) {
    var t = e.target;
    var act = t.getAttribute ? t.getAttribute('data-act') : null;
    if (!act) return;
    switch (act) {
      case 'preset': selectPreset(t.value); break;
      case 'col-toggle': {
        var key = t.getAttribute('data-key');
        var on = t.checked;
        editList(function (st) { st.list.forEach(function (it) { if (it.key === key) it.on = on; }); });
        break;
      }
      case 'opt-settings': setPrefs({ includeSettings: t.checked }); break;
      case 'opt-history': setPrefs({ includeHistory: t.checked }); break;
      case 'sheet': {
        var si = parseInt(t.value, 10) || 0;
        if (imp.sheets[si] && !imp.sheets[si].tooMany) setSheet(si);
        refresh();
        break;
      }
      case 'header-row': {
        var h = parseInt(t.value, 10);
        if (h >= -1 && h < curRows().length) { imp.headerIndex = h; remap(); }
        refresh();
        break;
      }
      case 'map': {
        var col = parseInt(t.getAttribute('data-col'), 10);
        if (col >= 0 && col < imp.mapping.length) {
          var hadAtt = hasAttendanceTarget();
          imp.mapping[col] = t.value;
          if (!hadAtt && hasAttendanceTarget()) imp.options.switchAttendanceToTotals = attendanceMode(GT.store.course()) === 'off';
          imp.planKey = null;
        }
        refresh();
        break;
      }
      case 'opt-create': imp.options.createMissing = t.checked; imp.planKey = null; refresh(); break;
      case 'opt-overwrite': imp.options.overwrite = t.checked; imp.planKey = null; refresh(); break;
      case 'opt-att': imp.options.switchAttendanceToTotals = t.checked; imp.planKey = null; refresh(); break;
      case 'opt-update-names': imp.options.updateNames = t.checked; imp.planKey = null; refresh(); break;
      default: break;
    }
  }

  function onKeydown(e) {
    // Alt+Up / Alt+Down on a column of the picker moves it.
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    var li = e.target.closest ? e.target.closest('.xc-col') : null;
    if (!li || !boundEl.contains(li)) return;
    e.preventDefault();
    var key = li.getAttribute('data-key');
    moveKey(key, e.key === 'ArrowUp' ? -1 : 1, false);
    // Keep focus on the same kind of control of the moved column.
    var kind = e.target.getAttribute('data-act');
    var sel = '[data-key="' + key.replace(/["\\]/g, '\\$&') + '"]';
    var next = dom && dom.expBody.querySelector('[data-act="' + kind + '"]' + sel);
    if (!next || next.disabled) next = dom && dom.expBody.querySelector('input[data-act="col-toggle"]' + sel);
    if (next) { try { next.focus({ preventScroll: true }); } catch (err) { next.focus(); } next.scrollIntoView({ block: 'nearest' }); }
  }

  function isFileDrag(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  }

  function clearDropMarks() {
    if (!boundEl) return;
    Array.prototype.forEach.call(boundEl.querySelectorAll('.is-drop-before, .is-drop-after, .is-over'), function (n) {
      n.classList.remove('is-drop-before', 'is-drop-after', 'is-over');
    });
  }

  function onDragStart(e) {
    var li = e.target.closest ? e.target.closest('.xc-col') : null;
    if (!li) return;
    drag = { key: li.getAttribute('data-key') };
    li.classList.add('is-dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', drag.key);
    } catch (err) { /* old browsers */ }
  }

  /** A file may be dropped on the Import card while it waits for one (step 1). */
  function fileDropAllowed(e) {
    var zone = e.target && e.target.closest ? e.target.closest('#xc-import') : null;
    return !!zone && imp.step === 1 && !imp.loading;
  }

  function onDragOver(e) {
    if (isFileDrag(e)) {
      // Always handled: a file the page does not take would otherwise open in the tab and leave the app.
      // Elsewhere the drop is refused ("not allowed" pointer).
      e.preventDefault();
      var ok = fileDropAllowed(e);
      try { e.dataTransfer.dropEffect = ok ? 'copy' : 'none'; } catch (err) { /* read-only in old browsers */ }
      var dz = boundEl.querySelector('#xc-drop');
      if (dz) dz.classList.toggle('is-over', ok);
      return;
    }
    if (!drag) return;
    var li = e.target.closest ? e.target.closest('.xc-col') : null;
    if (!li || li.getAttribute('data-key') === drag.key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var r = li.getBoundingClientRect();
    var after = e.clientY > r.top + r.height / 2;
    clearDropMarks();
    li.classList.add(after ? 'is-drop-after' : 'is-drop-before');
  }

  function onDragLeave(e) {
    var dz = boundEl && boundEl.querySelector('#xc-drop');
    if (dz && dz.classList.contains('is-over') && !(e.relatedTarget && boundEl.querySelector('#xc-import').contains(e.relatedTarget))) {
      dz.classList.remove('is-over');
    }
  }

  function onDrop(e) {
    if (isFileDrag(e)) {
      e.preventDefault(); // never let the browser open the file instead
      clearDropMarks();
      if (!fileDropAllowed(e)) {
        if (imp.loading) return;
        var inImport = !!(e.target && e.target.closest && e.target.closest('#xc-import'));
        ui.toast(inImport || imp.step !== 1
          ? 'A file is already open in the import. Press "Choose another file" first, then drop the new file.'
          : 'To import a file, drop it on "Import from a file" below the Export card.', { type: 'info' });
        return;
      }
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
      return;
    }
    if (!drag) return;
    var li = e.target.closest ? e.target.closest('.xc-col') : null;
    e.preventDefault();
    var key = drag.key;
    drag = null;
    clearDropMarks();
    if (!li) { refresh(); return; }
    var r = li.getBoundingClientRect();
    dropKey(key, li.getAttribute('data-key'), e.clientY > r.top + r.height / 2);
  }

  function onDragEnd() {
    drag = null;
    clearDropMarks();
    if (boundEl) Array.prototype.forEach.call(boundEl.querySelectorAll('.is-dragging'), function (n) { n.classList.remove('is-dragging'); });
  }

  // Files dropped anywhere else on the page (tabs, header) must not open in the browser tab either: the
  // app would be left. Inside the view, onDragOver / onDrop decide.
  function exchangeActive() {
    return !!(GT.store && GT.store.state && GT.store.state.ui && GT.store.state.ui.activeView === 'exchange');
  }
  if (root.document) {
    root.document.addEventListener('dragover', function (e) {
      if (!isFileDrag(e) || !exchangeActive()) return;
      e.preventDefault();
      if (!(boundEl && boundEl.contains(e.target))) {
        try { e.dataTransfer.dropEffect = 'none'; } catch (err) { /* read-only in old browsers */ }
      }
    });
    root.document.addEventListener('drop', function (e) {
      if (isFileDrag(e) && exchangeActive()) e.preventDefault();
    });
  }

  GT.views.exchange = {
    id: 'exchange',
    title: 'Import / Export',
    render: render,
    destroy: destroy,
    /** For tests: the column keys the export would use now, the plan counts that have their own label and
     * help (countKeys; every count GT.importer.plan returns should be one of them), and the import state. */
    countKeys: function () { return COUNT_INFO.map(function (ci) { return ci.key; }); },
    exportKeys: function () {
      var x = currentExport();
      return x ? exportKeys(x.st, x.cmap) : [];
    },
    importState: function () {
      return { step: imp.step, fileName: imp.fileName, sheetIndex: imp.sheetIndex, headerIndex: imp.headerIndex, mapping: imp.mapping.slice(),
        options: JSON.parse(JSON.stringify(imp.options)), counts: imp.plan && imp.plan.counts ? JSON.parse(JSON.stringify(imp.plan.counts)) : null };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
