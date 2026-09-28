/* Grade Tracker - import (E4): reading .xlsx worksheets and CSV into rows of text, guessing the column
 * mapping (the previous TA's sheet maps exactly), planning the import (match students, parse values,
 * preview every change) and applying it inside the caller's GT.store.transact.
 * See docs/DESIGN.md section 9. Pure: ExcelJS is passed in where a workbook must be read, and this
 * module never loads it. Runs in the browser (GT.importer) and in Node.
 *
 * plan() is exact: it applies the import to a scratch copy of the course and reports the differences,
 * so team-graded columns (majority -> team score, the rest -> overrides), team moves and propagation
 * to teammates show up in the preview exactly as apply() will do them. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;
  var model = isNode ? require('./model.js') : root.GT.model;
  var calc = isNode ? require('./calc.js') : root.GT.calc;
  // Loaded after this file in some pages: resolved when first needed, not at load time.
  var nodeDeps = isNode ? { csv: require('./csv.js'), attendance: require('./attendance.js') } : null;
  function dep(name) {
    var m = isNode ? nodeDeps[name] : (root.GT && root.GT[name]);
    if (!m) throw new Error('Grade Tracker module "' + name + '" is not loaded.');
    return m;
  }

  var hasOwn = util.hasOwn;
  var fix = util.fix;

  var FINALIZED_REASON = 'Scores are finalized: unlock them in the Grades tab first';
  var XLS_MESSAGE = 'Open it in Excel and use Save As → Excel Workbook (.xlsx), then import that file.';
  var OTHER_FILE_MESSAGE = 'Choose an Excel workbook (.xlsx) or a CSV file (.csv).';

  // ---------------------------------------------------------------- reading files

  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

  /** Text of an ExcelJS cell value: numbers as their string, formulas as their result, rich text
   * joined, hyperlinks as their text, dates as YYYY-MM-DD, errors and null as ''. */
  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return isFinite(v) ? String(fix(v)) : '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (isDate(v)) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      if (Array.isArray(v.richText)) {
        return v.richText.map(function (r) { return r && r.text !== undefined && r.text !== null ? String(r.text) : ''; }).join('');
      }
      if (hasOwn(v, 'error')) return '';
      if (hasOwn(v, 'formula') || hasOwn(v, 'sharedFormula')) return hasOwn(v, 'result') ? cellText(v.result) : '';
      if (hasOwn(v, 'text')) return cellText(v.text);
      if (hasOwn(v, 'result')) return cellText(v.result);
    }
    return '';
  }

  function isBlank(s) { return s === null || s === undefined || String(s).trim() === ''; }

  /** Drops trailing empty rows and makes every row as wide as the widest non-empty content. */
  function tidyRows(rows) {
    var list = (Array.isArray(rows) ? rows : []).map(function (r) {
      return (Array.isArray(r) ? r : []).map(function (c) {
        if (c === null || c === undefined) return '';
        if (typeof c === 'number') return isFinite(c) ? String(fix(c)) : '';
        return typeof c === 'string' ? c : cellText(c);
      });
    });
    var width = 0;
    list.forEach(function (r) {
      for (var i = r.length - 1; i >= 0; i--) {
        if (!isBlank(r[i])) { width = Math.max(width, i + 1); break; }
      }
    });
    var last = -1;
    list.forEach(function (r, i) { if (r.some(function (c) { return !isBlank(c); })) last = i; });
    return list.slice(0, last + 1).map(function (r) {
      var out = r.slice(0, width);
      while (out.length < width) out.push('');
      return out;
    });
  }

  /** Rows of text from an ExcelJS worksheet (row 1 of the sheet is index 0). */
  function rowsFromWorksheet(ws) {
    if (!ws || typeof ws.getRow !== 'function') return [];
    var count = ws.rowCount || 0;
    var rows = [];
    for (var r = 1; r <= count; r++) {
      var row = ws.getRow(r);
      var n = row && row.cellCount ? row.cellCount : 0;
      var cells = [];
      for (var c = 1; c <= n; c++) cells.push(cellText(row.getCell(c).value));
      rows.push(cells);
    }
    return tidyRows(rows);
  }

  /** 0-based indexes of the columns whose non-empty cells are mostly formulas (at least half). A
   * "Letter Grade" column of formulas holds suggestions from cutoffs, not final letters, so
   * guessMapping leaves it unmapped when it is told about these columns. */
  function formulaColumnsOf(ws) {
    var out = [];
    if (!ws || typeof ws.getRow !== 'function') return out;
    var filled = [], formulas = [];
    for (var r = 1; r <= (ws.rowCount || 0); r++) {
      var row = ws.getRow(r);
      var n = row && row.cellCount ? row.cellCount : 0;
      for (var c = 1; c <= n; c++) {
        var v = row.getCell(c).value;
        if (v === null || v === undefined || v === '') continue;
        filled[c - 1] = (filled[c - 1] || 0) + 1;
        if (typeof v === 'object' && (hasOwn(v, 'formula') || hasOwn(v, 'sharedFormula'))) formulas[c - 1] = (formulas[c - 1] || 0) + 1;
      }
    }
    formulas.forEach(function (f, i) { if (f && f * 2 >= filled[i]) out.push(i); });
    return out;
  }

  /** Reads an .xlsx (ArrayBuffer or Uint8Array) with the given ExcelJS. Resolves with
   * [{ name, hidden, rows, formulaColumns }] per worksheet; rejects with a readable message. */
  function readWorkbook(ExcelJS, data) {
    return Promise.resolve().then(function () {
      if (!ExcelJS || typeof ExcelJS.Workbook !== 'function') throw new Error('The Excel library (ExcelJS) is not available.');
      var wb = new ExcelJS.Workbook();
      return wb.xlsx.load(data).then(function () {
        return wb.worksheets.map(function (ws) {
          return {
            name: ws.name,
            hidden: ws.state === 'hidden' || ws.state === 'veryHidden',
            rows: rowsFromWorksheet(ws),
            formulaColumns: formulaColumnsOf(ws)
          };
        });
      }, function () {
        throw new Error('This file could not be read as an Excel workbook (.xlsx). ' + XLS_MESSAGE);
      });
    });
  }

  /** Rows of text from CSV / TSV text (delimiter detected; BOM and quotes handled). */
  function rowsFromCsv(text) {
    return tidyRows(dep('csv').parse(text));
  }

  /** 'xlsx' | 'csv' | 'xls' | 'other' from a file name. */
  function fileKind(name) {
    var n = String(name || '').toLowerCase();
    if (/\.(xlsx|xlsm)$/.test(n)) return 'xlsx';
    if (/\.(csv|tsv|txt)$/.test(n)) return 'csv';
    if (/\.xls$/.test(n)) return 'xls';
    return 'other';
  }

  /** Index of the first row with at least 2 non-empty cells that are not numbers; 0 when none. */
  function detectHeaderRow(rows) {
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i++) {
      var row = Array.isArray(list[i]) ? list[i] : [];
      var n = 0;
      for (var j = 0; j < row.length; j++) {
        var t = row[j] === null || row[j] === undefined ? '' : String(row[j]);
        if (t.trim() !== '' && util.parseScoreInput(t).kind === 'invalid') n++;
      }
      if (n >= 2) return i;
    }
    return 0;
  }

  // ---------------------------------------------------------------- targets and mapping

  function assessmentsOf(course) {
    return course && Array.isArray(course.assessments) ? course.assessments : [];
  }

  function num(x) { return typeof x === 'number' && isFinite(x) ? String(fix(x)) : ''; }

  /** Mapping targets for the column selects: [{ key, label, group, score? }]. `score: true` marks the
   * targets that change scores (blocked while the course is finalized). */
  function targetsFor(course) {
    var out = [{ key: 'ignore', label: '(ignore this column)', group: 'Other' }];
    var add = function (key, label, group, extra) {
      var t = { key: key, label: label, group: group };
      if (extra) Object.keys(extra).forEach(function (k) { t[k] = extra[k]; });
      out.push(t);
    };
    add('no', 'No', 'Student');
    add('lastName', 'Last name', 'Student');
    add('firstName', 'First name', 'Student');
    add('fullName', 'Full name ("Last, First" or "First Last")', 'Student');
    add('team', 'Team', 'Student');
    add('status', 'Status (active / withdrawn)', 'Student');
    add('notes', 'Notes', 'Student');
    var list = assessmentsOf(course);
    list.forEach(function (a) {
      add('raw:' + a.id, a.name + ' (score out of ' + num(a.maxScore) + ')', 'Scores', { score: true, assessmentId: a.id });
    });
    list.forEach(function (a) {
      if (!((a.weight || 0) > 0)) return; // value ÷ 0 cannot be converted back
      add('weighted:' + a.id, 'Weighted ' + a.name + ' (converted to raw = value ÷ weight × max)', 'Scores', { score: true, assessmentId: a.id });
    });
    list.forEach(function (a) {
      add('late:' + a.id, a.name + ': weeks late', 'Scores', { score: true, assessmentId: a.id });
    });
    add('finalLetter', 'Final letter', 'Letters');
    add('absent', 'Unexcused absences (not allowed), attendance totals', 'Attendance', { attendance: true });
    add('excused', 'Excused absences (allowed), attendance totals', 'Attendance', { attendance: true });
    add('absencesTotal', 'Total absences (stored as unexcused)', 'Attendance', { attendance: true });
    return out;
  }

  function isScoreTarget(key) {
    return typeof key === 'string' && /^(raw|weighted|late):/.test(key);
  }

  function isAttendanceTarget(key) {
    return key === 'absent' || key === 'excused' || key === 'absencesTotal';
  }

  /** Header tokens: lower case, punctuation dropped except '%' (a token of its own). */
  function tokensOf(text) {
    return String(text === null || text === undefined ? '' : text).toLowerCase()
      .replace(/%/g, ' % ')
      .replace(/[!-$&-/:-@[-`{-~ -¿ -⁯←-⯿]/g, ' ')
      .trim().split(/\s+/).filter(function (t) { return t !== ''; });
  }

  var ROMAN_RE = /^(i{1,3}|iv|vi{0,3}|ix|x{1,3})$/;
  var NO_HEADERS = ['no', 'no.', '#', 'number', 'student no', 'student no.', 'student #', 'student number', 'nr', 'nr.'];
  var PHRASES = {
    lastName: ['last name', 'last', 'lastname', 'surname', 'family name', 'last names'],
    firstName: ['first name', 'first', 'firstname', 'given name', 'first names', 'given names'],
    fullName: ['name', 'names', 'student', 'students', 'student name', 'student names', 'full name'],
    team: ['team', 'team name', 'group', 'group name', 'team no', 'team number'],
    status: ['status', 'student status', 'enrollment', 'enrollment status'],
    notes: ['notes', 'note', 'comments', 'comment', 'remarks']
  };
  var IGNORE_WORDS = ['total', 'sum', 'rank', 'percentile', 'average', 'avg', 'mean', 'diff', 'difference', 'missing', 'count'];

  function findRun(tokens, run) {
    if (!run.length) return -1;
    for (var i = 0; i + run.length <= tokens.length; i++) {
      var ok = true;
      for (var j = 0; j < run.length; j++) if (tokens[i + j] !== run[j]) { ok = false; break; }
      if (ok && !(tokens[i + run.length] && ROMAN_RE.test(tokens[i + run.length]))) return i;
    }
    return -1;
  }

  /** Best guess for one header: { key, score } (higher score wins when two columns claim a target). */
  function guessOne(header, course) {
    var none = { key: 'ignore', score: 0 };
    var text = String(header === null || header === undefined ? '' : header).trim();
    if (text === '') return none;
    var lower = text.toLowerCase().replace(/\s+/g, ' ');
    if (NO_HEADERS.indexOf(lower) !== -1) return { key: 'no', score: 3 };
    var tokens = tokensOf(text);
    if (!tokens.length) return none;
    var joined = tokens.join(' ');
    var keys = Object.keys(PHRASES);
    for (var k = 0; k < keys.length; k++) {
      if (PHRASES[keys[k]].indexOf(joined) !== -1) return { key: keys[k], score: 3 };
    }
    var has = function (t) { return tokens.indexOf(t) !== -1; };
    if (has('rate')) return none;
    if (has('unexcused')) return { key: 'absent', score: 3 };
    if (has('excused')) return { key: 'excused', score: 3 };
    if (has('absence') || has('absences')) return { key: 'absencesTotal', score: 2 };
    if (joined === 'absent' || joined === 'absents') return { key: 'absent', score: 2 };
    if (has('suggested')) return none;
    if (has('letter')) return { key: 'finalLetter', score: has('final') ? 3 : 2 };
    if (joined === 'grade' || joined === 'final grade') return { key: 'finalLetter', score: 1 };
    if (IGNORE_WORDS.some(has)) return none;

    var best = null;
    assessmentsOf(course).forEach(function (a) {
      var run = tokensOf(a.name);
      var pos = findRun(tokens, run);
      if (pos === -1) return;
      var score = run.length * 10 + (run.length === tokens.length ? 5 : 0);
      if (!best || score > best.score) best = { a: a, end: pos + run.length, score: score };
    });
    if (!best) {
      var cat = has('participation') ? 'participation' : (has('paper') ? 'paper' : null);
      var hit = cat ? assessmentsOf(course).filter(function (a) { return a.category === cat; })[0] : null;
      if (hit) best = { a: hit, end: 0, score: 5 };
    }
    if (!best) return none;
    var a = best.a;
    if (has('late')) return { key: 'late:' + a.id, score: best.score };
    var lastTok = tokens[tokens.length - 1];
    var trailingWeight = tokens.length > best.end && /^\d+(\.\d+)?$/.test(lastTok) && Number(lastTok) === a.weight;
    if (has('%') || trailingWeight) {
      return (a.weight || 0) > 0 ? { key: 'weighted:' + a.id, score: best.score } : none;
    }
    return { key: 'raw:' + a.id, score: best.score };
  }

  /** Target key per header cell. The previous TA's sheet maps exactly (DESIGN section 9). When two
   * columns claim the same target, the stronger match keeps it (ties: the first column) and the other
   * is set to 'ignore', so "Final Letter" wins over "Letter Grade". opts.formulaColumns (from
   * readWorkbook): a letter column made of formulas is left unmapped, because it holds suggestions. */
  function guessMapping(headerCells, course, opts) {
    var formulaCols = opts && Array.isArray(opts.formulaColumns) ? opts.formulaColumns : [];
    var guesses = (Array.isArray(headerCells) ? headerCells : []).map(function (h, i) {
      var g = guessOne(h, course);
      return g.key === 'finalLetter' && formulaCols.indexOf(i) !== -1 ? { key: 'ignore', score: 0 } : g;
    });
    var owner = Object.create(null);
    guesses.forEach(function (g, i) {
      if (g.key === 'ignore') return;
      var cur = owner[g.key];
      if (cur === undefined || g.score > guesses[cur].score) owner[g.key] = i;
    });
    return guesses.map(function (g, i) { return g.key !== 'ignore' && owner[g.key] === i ? g.key : 'ignore'; });
  }

  /** Targets mapped from more than one column: [{ key, columns: [index, …] }] (for a warning). */
  function duplicateTargets(mapping) {
    var at = Object.create(null), order = [];
    (Array.isArray(mapping) ? mapping : []).forEach(function (k, i) {
      if (typeof k !== 'string' || k === 'ignore') return;
      if (!at[k]) { at[k] = []; order.push(k); }
      at[k].push(i);
    });
    return order.filter(function (k) { return at[k].length > 1; }).map(function (k) { return { key: k, columns: at[k] }; });
  }

  // ---------------------------------------------------------------- plan

  function normalizeOptions(o) {
    var x = o || {};
    return {
      matchBy: x.matchBy === 'no' ? 'no' : 'name',
      createMissing: x.createMissing !== false,
      emptyCells: x.emptyCells === 'clear' ? 'clear' : 'keep',
      overwrite: x.overwrite !== false,
      switchAttendanceToTotals: x.switchAttendanceToTotals === true
    };
  }

  function normName(s) {
    return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function normFull(s) {
    return normName(String(s === null || s === undefined ? '' : s).replace(/,/g, ' '));
  }

  /** "Last, First" or "First Last" (the last word is the last name). */
  function splitFullName(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t === '') return { lastName: '', firstName: '' };
    var comma = t.indexOf(',');
    if (comma !== -1) return { lastName: t.slice(0, comma).trim(), firstName: t.slice(comma + 1).trim() };
    var sp = t.lastIndexOf(' ');
    if (sp === -1) return { lastName: t, firstName: '' };
    return { lastName: t.slice(sp + 1), firstName: t.slice(0, sp) };
  }

  var STATUS_WORDS = {
    withdrawn: 'withdrawn', w: 'withdrawn', wd: 'withdrawn', dropped: 'withdrawn', drop: 'withdrawn',
    inactive: 'withdrawn', withdraw: 'withdrawn', active: 'active', a: 'active', enrolled: 'active'
  };

  function parseStatus(text) {
    var t = normName(text);
    if (t === '') return { kind: 'empty' };
    return hasOwn(STATUS_WORDS, t) ? { kind: 'value', value: STATUS_WORDS[t] } : { kind: 'invalid' };
  }

  /** Weeks late: "2", "2 (waived)", "2 waived"; '' is empty. */
  function parseLate(text) {
    var t = String(text || '').trim();
    if (t === '') return { kind: 'empty' };
    var m = /^(\d+(?:\.0*)?)\s*(?:\(\s*waived\s*\)|waived)?$/i.exec(t);
    if (!m) return { kind: 'invalid' };
    var weeks = util.parseCount(m[1]);
    if (weeks === null) return { kind: 'invalid' };
    return { kind: 'value', weeks: weeks, waived: /waived/i.test(t) && weeks > 0 };
  }

  function scoreText(e) {
    if (!e) return '';
    if (typeof e.value === 'number') return num(e.value);
    return e.text ? String(e.text) : '';
  }

  function lateText(e) {
    var w = e && typeof e.weeksLate === 'number' && e.weeksLate > 0 ? e.weeksLate : 0;
    return w ? w + (e.waived ? ' (waived)' : '') : '';
  }

  function teamNameOf(course, s) {
    var t = s && s.teamId ? model.findTeam(course, s.teamId) : null;
    return t ? t.name : '';
  }

  function totalsOf(course, sid) {
    var att = course.attendance && util.isPlainObject(course.attendance) ? course.attendance : null;
    var t = att && util.isPlainObject(att.totals) && hasOwn(att.totals, sid) && util.isPlainObject(att.totals[sid]) ? att.totals[sid] : null;
    return t;
  }

  function scaleList(course) { return model.scaleLetters(course).join(', '); }

  /** Plans an import (pure: `course` is not changed). rows: string[][]; headerIndex: the header row;
   * mapping: a target key per column (see targetsFor). options: { matchBy: 'name'|'no', createMissing,
   * emptyCells: 'keep'|'clear', overwrite, switchAttendanceToTotals }. Returns
   * { items: [{ rowIndex, action: 'update'|'new'|'skip', reason?, studentId?, name, changes: [{ field,
   *   oldValue, newValue, blocked?, reason?, notOnList?, outOfRange?, invalid? }], issues: [{ field,
   *   value, message }] }], counts: { update, new, skip, changes, overrides, invalid, blocked,
   *   notOnList, lettersSkipped, kept, unchanged, propagated }, propagated: [{ studentId, name, changes }],
   *   notes: [string], errors: [string], options, finalized }. */
  function plan(course, rows, headerIndex, mapping, options) {
    var o = normalizeOptions(options);
    var list = tidyRows(rows);
    var hi = typeof headerIndex === 'number' && headerIndex >= 0 && headerIndex < list.length ? Math.floor(headerIndex) : 0;
    var header = list[hi] || [];
    var validKeys = Object.create(null);
    targetsFor(course).forEach(function (t) { validKeys[t.key] = t; });
    var cols = Object.create(null);
    var notes = [], errors = [];
    var colName = function (i) { return '"' + (header[i] !== undefined && String(header[i]).trim() !== '' ? String(header[i]).trim() : 'column ' + (i + 1)) + '"'; };
    (Array.isArray(mapping) ? mapping : []).forEach(function (key, ci) {
      if (typeof key !== 'string' || key === 'ignore') return;
      if (!validKeys[key]) { notes.push('Column ' + colName(ci) + ' is ignored: its target no longer exists.'); return; }
      if (cols[key] !== undefined) {
        notes.push('Column ' + colName(ci) + ' is ignored: ' + validKeys[key].label + ' is already read from column ' + colName(cols[key]) + '.');
        return;
      }
      cols[key] = ci;
    });
    var list2 = assessmentsOf(course);
    list2.forEach(function (a) {
      if (cols['raw:' + a.id] !== undefined && cols['weighted:' + a.id] !== undefined) {
        notes.push('Column ' + colName(cols['weighted:' + a.id]) + ' is ignored: the raw ' + a.name + ' score is read from column ' + colName(cols['raw:' + a.id]) + '.');
        delete cols['weighted:' + a.id];
      }
    });
    if (cols.absent !== undefined && cols.absencesTotal !== undefined) {
      notes.push('Column ' + colName(cols.absencesTotal) + ' is ignored: unexcused absences are read from column ' + colName(cols.absent) + '.');
      delete cols.absencesTotal;
    }
    var finalized = model.isFinalized(course);
    var scoreMapped = Object.keys(cols).some(isScoreTarget);
    if (finalized && scoreMapped) notes.push(FINALIZED_REASON + ' Score columns are shown in the preview but not imported.');
    var attMapped = Object.keys(cols).some(isAttendanceTarget);
    if (!attMapped) o.switchAttendanceToTotals = false; // offered only when an attendance column is mapped
    var attMode = course.attendance && course.attendance.mode ? course.attendance.mode : 'off';
    if (attMapped && attMode !== 'totals') {
      notes.push(o.switchAttendanceToTotals
        ? 'Attendance switches to totals-only mode. Enter "Sessions held so far" in the Attendance tab for the rates.'
        : 'Attendance is ' + (attMode === 'off' ? 'off' : 'recorded per session') + ' for this course: imported absence totals are stored, but shown only in totals-only mode.');
    }
    var nameMapped = cols.lastName !== undefined || cols.firstName !== undefined || cols.fullName !== undefined;
    if (o.matchBy === 'no' && cols.no === undefined) errors.push('Map a column to No to match students by No.');
    if (o.matchBy === 'name' && !nameMapped) errors.push('Map the name columns (Last name and First name, or Full name) to match students by name.');

    var counts = { update: 0, 'new': 0, skip: 0, changes: 0, overrides: 0, invalid: 0, blocked: 0, notOnList: 0, lettersSkipped: 0, kept: 0, unchanged: 0, propagated: 0 };
    var items = [];

    // Indexes of the course's students.
    var students = Array.isArray(course.students) ? course.students : [];
    var byKey = Object.create(null), byLast = Object.create(null), byFirst = Object.create(null), byFull = Object.create(null), byNo = Object.create(null);
    var push = function (map, k, s) { if (!map[k]) map[k] = []; if (map[k].indexOf(s) === -1) map[k].push(s); };
    students.forEach(function (s) {
      var l = normName(s.lastName), f = normName(s.firstName);
      push(byKey, l + '\u0001' + f, s);
      push(byLast, l, s);
      push(byFirst, f, s);
      push(byFull, normFull(s.firstName + ' ' + s.lastName), s);
      push(byFull, normFull(s.lastName + ' ' + s.firstName), s);
      if (typeof s.no === 'number') push(byNo, String(s.no), s);
    });
    var matchedRow = Object.create(null), newRow = Object.create(null);

    for (var ri = hi + 1; ri < list.length && !errors.length; ri++) {
      var row = list[ri];
      if (!row.some(function (c) { return !isBlank(c); })) continue;
      if (row.every(function (c, i) { return normName(c) === normName(header[i]); })) {
        items.push({ rowIndex: ri, action: 'skip', reason: 'Repeated header row', name: '', changes: [], issues: [] });
        continue;
      }
      items.push(planRow(ri, row));
    }

    function cell(row, key) {
      return cols[key] === undefined ? undefined : String(row[cols[key]] === undefined ? '' : row[cols[key]]);
    }

    function rowNames(row) {
      var last = cell(row, 'lastName'), first = cell(row, 'firstName'), full = cell(row, 'fullName');
      var fromParts = (last !== undefined && last.trim() !== '') || (first !== undefined && first.trim() !== '');
      if (fromParts || full === undefined || full.trim() === '') {
        return { lastName: (last || '').replace(/\s+/g, ' ').trim(), firstName: (first || '').replace(/\s+/g, ' ').trim(), full: null, fromParts: fromParts };
      }
      var sp = splitFullName(full);
      return { lastName: sp.lastName, firstName: sp.firstName, full: full, fromParts: false };
    }

    function displayName(n) {
      if (n.full !== null && n.full !== undefined) return n.full.replace(/\s+/g, ' ').trim();
      return model.studentName(n);
    }

    function matchByName(n) {
      if (n.full) return byFull[normFull(n.full)] || [];
      var l = normName(n.lastName), f = normName(n.firstName);
      if (cols.lastName !== undefined && cols.firstName !== undefined) return byKey[l + '\u0001' + f] || [];
      if (cols.lastName !== undefined) return byLast[l] || [];
      return byFirst[f] || [];
    }

    function planRow(ri, row) {
      var n = rowNames(row);
      var item = { rowIndex: ri, action: 'skip', name: displayName(n), changes: [], issues: [], ops: null, blockedOps: [] };
      var hasName = n.lastName !== '' || n.firstName !== '';
      var candidates, student = null, newKey;
      var noText = cell(row, 'no');
      var noVal = noText === undefined || noText.trim() === '' ? null : util.parseCount(noText.trim());
      if (o.matchBy === 'no') {
        if (noVal === null) {
          item.reason = noText && noText.trim() !== '' ? 'No "' + noText.trim() + '" is not a whole number' : 'No is empty';
          return item;
        }
        candidates = byNo[String(noVal)] || [];
        newKey = 'no:' + noVal;
      } else {
        if (!hasName) { item.reason = 'No name'; return item; }
        candidates = matchByName(n);
        newKey = 'name:' + (n.full ? normFull(n.full) : normName(n.lastName) + '\u0001' + normName(n.firstName));
      }
      if (candidates.length > 1) {
        item.reason = candidates.length + ' students match ' + (o.matchBy === 'no' ? 'No ' + noVal : 'this name') + '; fix the duplicate first';
        return item;
      }
      if (candidates.length === 1) {
        student = candidates[0];
        if (matchedRow[student.id] !== undefined) {
          item.reason = 'Same student as row ' + (matchedRow[student.id] + 1);
          return item;
        }
        matchedRow[student.id] = ri;
        item.action = 'update';
        item.studentId = student.id;
        item.name = model.studentName(student);
      } else {
        if (!o.createMissing) { item.reason = 'No matching student in this course'; return item; }
        if (!hasName) { item.reason = 'No matching student, and no name to add one'; return item; }
        if (newRow[newKey] !== undefined) { item.reason = 'Same new student as row ' + (newRow[newKey] + 1); return item; }
        newRow[newKey] = ri;
        item.action = 'new';
      }
      item.ops = rowOps(item, row, n, student, noText, noVal);
      return item;
    }

    function issue(item, field, value, message) {
      item.issues.push({ field: field, value: value, message: message });
    }

    /** What to write for one row (after the overwrite / empty-cell rules). `student` is null for a new one. */
    function rowOps(item, row, n, student, noText, noVal) {
      var isNew = !student;
      var ops = { info: {}, letter: undefined, scores: {}, att: {} };
      var keep = o.emptyCells === 'keep';
      var fill = function (currentEmpty) { return isNew || o.overwrite || currentEmpty; };

      // No
      if (noText !== undefined) {
        if (noText.trim() !== '' && noVal === null) {
          issue(item, 'No', noText, 'Not a whole number; ignored');
          counts.invalid++;
        } else if (noVal !== null) {
          if (isNew) ops.info.no = noVal;
          else if (student.no !== noVal) {
            if (fill(typeof student.no !== 'number')) ops.info.no = noVal; else counts.kept++;
          }
        }
      }
      // Names: set for new students; for existing ones only when matched by No.
      if (isNew) {
        ops.info.lastName = n.lastName;
        ops.info.firstName = n.firstName;
      } else if (o.matchBy === 'no') {
        [['lastName', n.lastName], ['firstName', n.firstName]].forEach(function (p) {
          var mapped = p[0] === 'lastName' ? (cols.lastName !== undefined || cols.fullName !== undefined) : (cols.firstName !== undefined || cols.fullName !== undefined);
          if (!mapped || p[1] === '' || p[1] === student[p[0]]) return;
          if (fill(!student[p[0]])) ops.info[p[0]] = p[1]; else counts.kept++;
        });
      }
      // Team
      var teamText = cell(row, 'team');
      if (teamText !== undefined) {
        var tn = teamText.replace(/\s+/g, ' ').trim();
        var cur = isNew ? '' : teamNameOf(course, student);
        if (tn === '') {
          if (!isNew && !keep && cur !== '') ops.info.team = null;
        } else if (normName(tn) !== normName(cur)) {
          if (fill(cur === '')) ops.info.team = tn; else counts.kept++;
        }
      }
      // Status
      var stText = cell(row, 'status');
      if (stText !== undefined) {
        var st = parseStatus(stText);
        if (st.kind === 'invalid') {
          issue(item, 'Status', stText, 'Use Active or Withdrawn; ignored');
          counts.invalid++;
        } else {
          var want = st.kind === 'empty' ? (isNew || !keep ? 'active' : null) : st.value;
          if (want && (isNew || want !== student.status)) {
            if (isNew || o.overwrite) ops.info.status = want; else counts.kept++;
          }
        }
      }
      // Notes
      var ntText = cell(row, 'notes');
      if (ntText !== undefined) {
        var nt = ntText.trim();
        if (isNew) { if (nt !== '') ops.info.notes = nt; }
        else if (nt === '') { if (!keep && student.notes) ops.info.notes = ''; }
        else if (nt !== student.notes) { if (fill(!student.notes)) ops.info.notes = nt; else counts.kept++; }
      }
      // Final letter (allowed while finalized)
      var lt = cell(row, 'finalLetter');
      if (lt !== undefined) {
        var curL = isNew ? null : model.finalLetterOf(student);
        if (lt.trim() === '') {
          if (!isNew && !keep && curL !== null) ops.letter = null;
        } else {
          var letter = model.matchLetter(course, lt.trim());
          if (letter === null) {
            issue(item, 'Final letter', lt.trim(), '"' + lt.trim().slice(0, 20) + '" is not a letter of this course\'s scale (' + scaleList(course) + '); skipped');
            counts.lettersSkipped++;
          } else if (letter !== curL) {
            if (fill(curL === null)) ops.letter = letter; else counts.kept++;
          }
        }
      }
      // Scores
      list2.forEach(function (a) { scoreOps(item, ops, row, a, student); });
      // Attendance totals
      attOps(item, ops, row, student);
      return ops;
    }

    function scoreOps(item, ops, row, a, student) {
      var isNew = !student;
      var rawText = cell(row, 'raw:' + a.id);
      var wText = rawText === undefined ? cell(row, 'weighted:' + a.id) : undefined;
      var lateCell = cell(row, 'late:' + a.id);
      if (rawText === undefined && wText === undefined && lateCell === undefined) return;
      var cur = isNew ? null : calc.resolveEntry(course, student, a).entry;
      var curHas = model.hasScore(cur);
      var op = {};
      var shown = null; // what the file says, for blocked changes
      var text = rawText !== undefined ? rawText : wText;
      if (text !== undefined) {
        var t = text.trim();
        if (t === '') {
          if (o.emptyCells === 'clear' && !isNew && curHas) { op.set = true; op.clear = true; shown = ''; }
        } else {
          var p;
          if (rawText !== undefined) p = util.parseScoreInput(t, a.maxScore);
          else {
            p = util.parseScoreInput(t);
            if (p.kind === 'number') p = { kind: 'number', value: fix(p.value / a.weight * a.maxScore) };
          }
          if (p.kind === 'invalid') {
            counts.invalid++;
            if (model.hasChoices(a)) {
              issue(item, a.name, t, 'Not a number; ' + a.name + ' takes values from its list (' + model.describeChoices(a) + '); skipped');
            } else if (finalized) {
              // Listed as a blocked change below; nothing is stored while the scores are finalized.
              issue(item, a.name, t, 'Not a number; not imported because the scores are finalized');
              op.set = true; op.text = t; shown = t;
            } else {
              issue(item, a.name, t, 'Not a number: stored as text and counted as 0 (highlighted in the grid)');
              op.set = true; op.text = t; shown = t;
            }
          } else if (p.kind === 'number') {
            if (!util.isSaneNumber(p.value)) {
              counts.invalid++;
              issue(item, a.name, t, 'Number too large; skipped');
            } else {
              op.set = true; op.value = p.value; shown = num(p.value);
            }
          }
        }
        if (op.set && !isNew && !o.overwrite && curHas) { delete op.set; delete op.value; delete op.text; delete op.clear; counts.kept++; shown = null; }
      }
      if (lateCell !== undefined) {
        var lp = parseLate(lateCell);
        if (lp.kind === 'invalid') {
          counts.invalid++;
          issue(item, a.name + ': weeks late', lateCell.trim(), 'Use a whole number of weeks, optionally "(waived)"; ignored');
        } else if (lp.kind === 'value' || (o.emptyCells === 'clear' && !isNew)) {
          var weeks = lp.kind === 'value' ? lp.weeks : 0, waived = lp.kind === 'value' ? lp.waived : false;
          var curW = cur && cur.weeksLate > 0 ? cur.weeksLate : 0, curWv = !!(cur && cur.waived && curW);
          var same = weeks === curW && (!weeks || waived === curWv);
          if (!same || op.set) {
            if (!isNew && !o.overwrite && curW > 0 && !same) counts.kept++;
            else if (!same || weeks > 0) op.late = { weeks: weeks, waived: waived };
          }
        }
      }
      if (!op.set && !op.late) return;
      // Individual items: nothing to do when the value and late info are already what the file says.
      if (!a.teamGraded || isNew || !student.teamId || !model.findTeam(course, student.teamId)) {
        var nextKey = model.entryKey(previewEntry(op, cur, a));
        if (!isNew && nextKey === model.entryKey(cur)) return;
      }
      if (finalized) {
        if (isNew || model.entryKey(previewEntry(op, cur, a)) !== model.entryKey(cur)) {
          item.blockedOps.push({ field: a.name, oldValue: scoreText(cur) + (lateText(cur) ? ' (late ' + lateText(cur) + ')' : ''),
            newValue: (shown !== null ? shown : scoreText(cur)) + (op.late && op.late.weeks ? ' (late ' + op.late.weeks + (op.late.waived ? ', waived' : '') + ')' : '') });
        }
        return;
      }
      if (op.value !== undefined && model.hasChoices(a) && !model.isChoiceValue(a, op.value)) op.notOnList = true;
      ops.scores[a.id] = op;
    }

    function attOps(item, ops, row, student) {
      var isNew = !student;
      var aText = cell(row, 'absent'), eText = cell(row, 'excused'), tText = cell(row, 'absencesTotal');
      if (aText === undefined && eText === undefined && tText === undefined) return;
      var cur = isNew ? null : totalsOf(course, student.id);
      var curA = cur ? (cur.absent || 0) : 0, curE = cur ? (cur.excused || 0) : 0;
      var readCount = function (text, field) {
        if (text === undefined) return undefined;
        if (text.trim() === '') return o.emptyCells === 'clear' && !isNew ? 0 : undefined;
        var v = util.parseCount(text);
        if (v === null) {
          counts.invalid++;
          issue(item, field, text.trim(), 'Not a whole number of 0 or more; ignored');
          return undefined;
        }
        return v;
      };
      var e = readCount(eText, 'Excused absences');
      var a = readCount(aText, 'Unexcused absences');
      if (a === undefined && tText !== undefined) {
        var total = readCount(tText, 'Total absences');
        if (total !== undefined) {
          var ex = e !== undefined ? e : (eText !== undefined ? curE : 0);
          if (total < ex) {
            counts.invalid++;
            issue(item, 'Total absences', tText.trim(), 'Less than the excused absences (' + ex + '); ignored');
          } else a = total - ex;
        }
      }
      var next = {};
      if (a !== undefined && a !== curA) next.absent = a;
      if (e !== undefined && e !== curE) next.excused = e;
      if (!Object.keys(next).length) return;
      if (!isNew && !o.overwrite && cur) { counts.kept++; return; }
      ops.att = next;
    }

    // Simulate on a scratch copy: the preview is exactly what apply() will do.
    var simCourse = scratchCopy(course);
    var sim = applyItems(simCourse, items, o);
    counts.overrides = sim.summary.overridesCreated;

    var inFile = Object.create(null);
    items.forEach(function (item) {
      if (item.action === 'skip') { counts.skip++; return; }
      counts[item.action]++;
      if (item.studentId) inFile[item.studentId] = true;
      var before = item.studentId ? model.findStudent(course, item.studentId) : null;
      var after = model.findStudent(simCourse, sim.ids[item.rowIndex]);
      item.changes = diffStudent(course, before, simCourse, after, cols);
      Object.keys(item.ops.scores).forEach(function (aid) {
        if (!item.ops.scores[aid].notOnList) return;
        counts.notOnList++;
        var a = model.findAssessment(course, aid);
        item.changes.forEach(function (c) { if (c.field === a.name) c.notOnList = true; });
      });
      item.blockedOps.forEach(function (b) {
        item.changes.push({ field: b.field, oldValue: b.oldValue, newValue: b.newValue, blocked: true, reason: FINALIZED_REASON });
        counts.blocked++;
      });
      var real = item.changes.filter(function (c) { return !c.blocked; }).length;
      counts.changes += real;
      if (item.action === 'update' && !item.changes.length) counts.unchanged++;
    });

    var propagated = [];
    students.forEach(function (s) {
      if (inFile[s.id]) return;
      var after = model.findStudent(simCourse, s.id);
      var ch = diffStudent(course, s, simCourse, after, cols).filter(function (c) { return c.kind === 'score'; });
      if (ch.length) propagated.push({ studentId: s.id, name: model.studentName(s), changes: ch });
    });
    counts.propagated = propagated.length;

    return {
      items: items,
      counts: counts,
      propagated: propagated,
      notes: notes,
      errors: errors,
      options: o,
      finalized: finalized,
      headerIndex: hi,
      columns: Object.keys(cols).map(function (k) { return { key: k, column: cols[k] }; }),
      attendanceMapped: attMapped
    };
  }

  /** The entry the student would have after `op` (for comparisons only). */
  function previewEntry(op, cur, a) {
    var e;
    if (op.set) {
      if (op.clear) e = model.entryFromInput('', cur, a.maxScore);
      else if (op.text !== undefined) e = model.entryFromInput(op.text, cur, a.maxScore);
      else e = model.entryFromInput(op.value, cur, a.maxScore);
    } else e = cur ? util.clone(cur) : { value: null };
    if (op.late) e = model.withLate(e, op.late.weeks, op.late.waived);
    return e;
  }

  function scratchCopy(course) {
    var shallow = {};
    Object.keys(course).forEach(function (k) { if (k !== 'history') shallow[k] = course[k]; });
    var copy = util.clone(shallow);
    copy.history = [];
    return copy;
  }

  /** Field-by-field differences of one student between two versions of the course (null = absent). */
  function diffStudent(beforeCourse, before, afterCourse, after, cols) {
    var out = [];
    if (!after) return out;
    var add = function (field, kind, oldV, newV, extra) {
      var a = oldV === null || oldV === undefined ? '' : String(oldV);
      var b = newV === null || newV === undefined ? '' : String(newV);
      if (a === b) return;
      var c = { field: field, oldValue: a, newValue: b, kind: kind };
      if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
      out.push(c);
    };
    var val = function (s, k) { return s ? s[k] : ''; };
    add('No', 'info', before && typeof before.no === 'number' ? before.no : '', typeof after.no === 'number' ? after.no : '');
    add('Last name', 'info', val(before, 'lastName'), after.lastName);
    add('First name', 'info', val(before, 'firstName'), after.firstName);
    add('Team', 'info', before ? teamNameOf(beforeCourse, before) : '', teamNameOf(afterCourse, after));
    add('Status', 'info', before ? (before.status === 'withdrawn' ? 'Withdrawn' : 'Active') : '', after.status === 'withdrawn' ? 'Withdrawn' : 'Active');
    add('Notes', 'info', val(before, 'notes'), after.notes);
    assessmentsOf(afterCourse).forEach(function (a) {
      var ea = calc.resolveEntry(afterCourse, after, a);
      var eb = before ? calc.resolveEntry(beforeCourse, before, a) : null;
      var extra = {};
      if (ea.source === 'override' && (!eb || eb.source !== 'override')) extra.override = true;
      if (ea.entry && typeof ea.entry.value !== 'number' && ea.entry.text) extra.invalid = true;
      var da = calc.scoreDetail(afterCourse, after, a);
      if (da.outOfRange) extra.outOfRange = true;
      add(a.name, 'score', eb ? scoreText(eb.entry) : '', scoreText(ea.entry), extra);
      add(a.name + ': weeks late', 'score', eb ? lateText(eb.entry) : '', lateText(ea.entry));
    });
    add('Final letter', 'letter', before ? (model.finalLetterOf(before) || '') : '', model.finalLetterOf(after) || '');
    var ta = totalsOf(afterCourse, after.id), tb = before ? totalsOf(beforeCourse, before.id) : null;
    var attCols = cols && (cols.absent !== undefined || cols.excused !== undefined || cols.absencesTotal !== undefined);
    if (attCols || ta || tb) {
      add('Unexcused absences', 'attendance', tb ? tb.absent : (before ? 0 : ''), ta ? ta.absent : (tb || before ? 0 : ''));
      add('Excused absences', 'attendance', tb ? tb.excused : (before ? 0 : ''), ta ? ta.excused : (tb || before ? 0 : ''));
    }
    return out;
  }

  // ---------------------------------------------------------------- apply

  function applyItems(course, items, o) {
    var summary = { created: 0, updated: 0, skipped: 0, missing: 0, teamsCreated: 0, overridesCreated: 0, scores: 0, letters: 0, attendance: 0, modeSwitched: false };
    var ids = Object.create(null);
    var finalized = model.isFinalized(course);
    var teamByName = Object.create(null);
    (course.teams || []).forEach(function (t) { if (!teamByName[normName(t.name)]) teamByName[normName(t.name)] = t; });
    function teamIdFor(name) {
      if (name === null || name === undefined) return null;
      var key = normName(name);
      if (!teamByName[key]) {
        var t = model.createTeam(String(name).replace(/\s+/g, ' ').trim());
        course.teams.push(t);
        teamByName[key] = t;
        summary.teamsCreated++;
      }
      return teamByName[key].id;
    }

    // 1. Students (new ones, then identity fields and team moves).
    items.forEach(function (it) {
      if (it.action === 'skip' || !it.ops) { summary.skipped++; return; }
      var info = it.ops.info;
      var s;
      if (it.action === 'new') {
        s = model.createStudent({
          no: hasOwn(info, 'no') ? info.no : model.nextStudentNo(course),
          lastName: info.lastName || '',
          firstName: info.firstName || '',
          status: info.status === 'withdrawn' ? 'withdrawn' : 'active',
          notes: info.notes || '',
          teamId: info.team ? teamIdFor(info.team) : null
        });
        course.students.push(s);
        summary.created++;
      } else {
        s = model.findStudent(course, it.studentId);
        if (!s) { summary.missing++; return; }
        var touched = false;
        ['no', 'lastName', 'firstName', 'status', 'notes'].forEach(function (k) {
          if (hasOwn(info, k)) { s[k] = info[k]; touched = true; }
        });
        if (hasOwn(info, 'team')) {
          // While finalized, a team move keeps the student's visible scores (totals do not change).
          model.moveStudentToTeam(course, s.id, info.team === null ? null : teamIdFor(info.team), { keepScores: finalized });
          touched = true;
        }
        if (touched || it.ops.letter !== undefined || Object.keys(it.ops.scores).length || Object.keys(it.ops.att).length) summary.updated++;
      }
      ids[it.rowIndex] = s.id;
    });

    // 2. Final letters.
    items.forEach(function (it) {
      var sid = ids[it.rowIndex];
      if (!sid || it.ops.letter === undefined) return;
      try {
        if (model.setFinalLetter(course, sid, it.ops.letter)) summary.letters++;
      } catch (e) { /* the scale changed since the plan: the letter is skipped */ }
    });

    // 3. Scores: individual entries directly; team-graded columns through setTeamScoreFromMembers.
    if (!finalized) {
      assessmentsOf(course).forEach(function (a) {
        var teamRows = [];
        items.forEach(function (it) {
          var sid = ids[it.rowIndex];
          var op = sid && it.ops ? it.ops.scores[a.id] : null;
          if (!op) return;
          var s = model.findStudent(course, sid);
          var cur = calc.resolveEntry(course, s, a).entry;
          var entry = previewEntry(op, cur, a);
          summary.scores++;
          if (a.teamGraded && s.teamId && model.findTeam(course, s.teamId)) {
            teamRows.push({ studentId: sid, entry: entry });
          } else {
            if (entry) delete entry.override;
            model.setEntry(course.scores, sid, a.id, model.isBlankEntry(entry) ? null : entry);
          }
        });
        if (teamRows.length) summary.overridesCreated += model.setTeamScoreFromMembers(course, a.id, teamRows).overridesCreated;
      });
    }

    // 4. Attendance totals.
    var att = dep('attendance');
    items.forEach(function (it) {
      var sid = ids[it.rowIndex];
      if (!sid || !it.ops || !Object.keys(it.ops.att).length) return;
      try {
        if (att.setTotals(course, sid, it.ops.att)) summary.attendance++;
      } catch (e) { /* counts were checked by the plan */ }
    });
    if (o.switchAttendanceToTotals) summary.modeSwitched = att.setMode(course, 'totals');
    return { summary: summary, ids: ids };
  }

  /** Applies a plan from plan() to `course`, in place, inside the caller's GT.store.transact (ONE
   * transaction, so Undo reverts the whole import). Returns { created, updated, skipped, missing,
   * teamsCreated, overridesCreated, scores, letters, attendance, modeSwitched }. */
  function apply(course, thePlan) {
    if (!thePlan || !Array.isArray(thePlan.items)) throw new Error('Nothing to import: make a plan first.');
    if (thePlan.errors && thePlan.errors.length) throw new Error(thePlan.errors[0]);
    var o = normalizeOptions(thePlan.options);
    if (!thePlan.attendanceMapped) o.switchAttendanceToTotals = false;
    return applyItems(course, thePlan.items, o).summary;
  }

  var api = {
    FINALIZED_REASON: FINALIZED_REASON,
    XLS_MESSAGE: XLS_MESSAGE,
    OTHER_FILE_MESSAGE: OTHER_FILE_MESSAGE,
    cellText: cellText,
    rowsFromWorksheet: rowsFromWorksheet,
    formulaColumnsOf: formulaColumnsOf,
    readWorkbook: readWorkbook,
    rowsFromCsv: rowsFromCsv,
    fileKind: fileKind,
    detectHeaderRow: detectHeaderRow,
    targetsFor: targetsFor,
    isScoreTarget: isScoreTarget,
    isAttendanceTarget: isAttendanceTarget,
    guessMapping: guessMapping,
    duplicateTargets: duplicateTargets,
    splitFullName: splitFullName,
    plan: plan,
    apply: apply
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).importer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
