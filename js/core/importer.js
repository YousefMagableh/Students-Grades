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

  /** Reading limits. A stray cell far away (A1048576, XFD2) or a crafted file must not make the page
   * build millions of cells: rows after maxRows and columns after maxCols are never read. The UI
   * refuses more than 5,000 rows anyway, so these defaults only bound memory and time. */
  var DEFAULT_LIMITS = { maxRows: 10000, maxCols: 256 };

  function limitsOf(l) {
    var x = l || {};
    var pick = function (v, d) { return typeof v === 'number' && isFinite(v) && v >= 1 ? Math.floor(v) : d; };
    return { maxRows: pick(x.maxRows, DEFAULT_LIMITS.maxRows), maxCols: pick(x.maxCols, DEFAULT_LIMITS.maxCols) };
  }

  function textOf(c) {
    if (c === null || c === undefined) return '';
    if (typeof c === 'number') return isFinite(c) ? String(fix(c)) : '';
    return typeof c === 'string' ? c : cellText(c);
  }

  /** Drops trailing empty rows and makes every row as wide as the widest non-empty content. At most
   * limits.maxRows rows and limits.maxCols columns are kept (DEFAULT_LIMITS when not given). */
  function tidyRows(rows, limits) {
    var lim = limitsOf(limits);
    var src = Array.isArray(rows) ? rows : [];
    var count = Math.min(src.length, lim.maxRows);
    var list = [];
    for (var i = 0; i < count; i++) {
      var r = Array.isArray(src[i]) ? src[i] : [];
      var m = Math.min(r.length, lim.maxCols);
      var out = new Array(m);
      for (var j = 0; j < m; j++) out[j] = textOf(r[j]);
      list.push(out);
    }
    var width = 0, last = -1;
    list.forEach(function (r, i) {
      for (var k = r.length - 1; k >= 0; k--) {
        if (!isBlank(r[k])) { width = Math.max(width, k + 1); last = i; break; }
      }
    });
    return list.slice(0, last + 1).map(function (r) {
      var out = r.length > width ? r.slice(0, width) : r;
      while (out.length < width) out.push('');
      return out;
    });
  }

  // Notes of the static Letter Grade cells of a Grade Tracker export (exporter.js, DESIGN 8.2).
  var MANUAL_LETTER_NOTE = 'Final letter assigned by the instructor';
  var SUGGESTED_LETTER_NOTE = 'Suggestion from the cutoffs: ';
  // A withdrawn student without a final letter is exported with "W" and this note (exporter.js): "no
  // letter", never a final letter (unless another letter was typed over it after the export).
  var WITHDRAWN_LETTER = 'W';
  var WITHDRAWN_LETTER_NOTE = 'Withdrawn: no letter grade';

  function noteText(n) {
    if (typeof n === 'string') return n;
    if (n && typeof n === 'object' && Array.isArray(n.texts)) {
      return n.texts.map(function (t) { return t && typeof t.text === 'string' ? t.text : ''; }).join('');
    }
    return '';
  }

  function findRowOf(ws, r) {
    return typeof ws.findRow === 'function' ? ws.findRow(r) : ws.getRow(r); // findRow never creates a row
  }

  function findCellOf(row, c) {
    return typeof row.findCell === 'function' ? row.findCell(c) : row.getCell(c);
  }

  function isFormulaValue(v) {
    return v !== null && typeof v === 'object' && (hasOwn(v, 'formula') || hasOwn(v, 'sharedFormula'));
  }

  /** A formula that gives a letter: a text result (the exporter's nested IF on the total gives "A-"),
   * or, without a cached result, an IF formula with a quoted text in it. */
  function isLetterFormula(v) {
    if (!isFormulaValue(v)) return false;
    if (typeof v.result === 'string') return true;
    return typeof v.formula === 'string' && /^\s*=?\s*IF\s*\(/i.test(v.formula) && v.formula.indexOf('"') !== -1;
  }

  /** A letter compared loosely, as model.matchLetter does: case, spaces and dash variants ignored. */
  function letterKey(t) {
    return String(t === null || t === undefined ? '' : t).replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, '').toUpperCase();
  }

  /** The letter written in a "Suggestion from the cutoffs: <letter>" note, or null. */
  function suggestedLetterOfNote(text) {
    if (text.indexOf(SUGGESTED_LETTER_NOTE) !== 0) return null;
    return text.slice(SUGGESTED_LETTER_NOTE.length).split(/\r?\n/)[0];
  }

  /** Everything read from one ExcelJS worksheet, bounded by the limits:
   * { rows, formulaColumns, finalLetterCells: [[rowIndex, colIndex]], editedLetterCells: [[rowIndex,
   * colIndex]], truncatedRows, truncatedColumns }.
   * finalLetterCells are the cells whose note starts with "Final letter assigned by the instructor".
   * editedLetterCells are the letters changed after a Grade Tracker export (meaningful for such a file
   * only; readWorkbook): a cell whose text no longer matches its "Suggestion from the cutoffs: <letter>"
   * note (or no longer says "W" under its "Withdrawn: no letter grade" note), and a plain value below
   * row 1 in a column of letter formulas or of such notes (typed or pasted over the formula or the
   * noted cell).
   * A merged range gives its value to its first column only: the other cells of a horizontal span
   * (a title merged over A1:P1, a label over several score columns) read as '', as they look in
   * Excel; the cells below the first one of a vertical span keep the value (a team score merged
   * over the members' rows applies to each of them). */
  function scanWorksheet(ws, limits) {
    var lim = limitsOf(limits);
    var out = { rows: [], formulaColumns: [], finalLetterCells: [], editedLetterCells: [], truncatedRows: false, truncatedColumns: false };
    if (!ws || typeof ws.getRow !== 'function') return out;
    var count = ws.rowCount || 0;
    var last = Math.min(count, lim.maxRows);
    var rows = [], filled = [], formulas = [];
    // Per column: letter formulas or suggestion notes seen, and the plain cells without a letter note.
    var letterInfo = [], plain = [];
    for (var r = 1; r <= last; r++) {
      var row = findRowOf(ws, r);
      var cells = [];
      var n = row && row.cellCount ? row.cellCount : 0;
      if (n > lim.maxCols) {
        for (var x = lim.maxCols + 1; x <= n && !out.truncatedColumns; x++) {
          var far = findCellOf(row, x);
          if (far && far.value !== null && far.value !== undefined && far.value !== '') out.truncatedColumns = true;
        }
        n = lim.maxCols;
      }
      for (var c = 1; c <= n; c++) {
        var cell = findCellOf(row, c);
        if (!cell) { cells.push(''); continue; }
        var master = cell.master;
        if (master && master !== cell && master.col !== cell.col) { cells.push(''); continue; }
        var v = cell.value;
        var text = cellText(v);
        cells.push(text);
        if (v === null || v === undefined || v === '') continue;
        filled[c - 1] = (filled[c - 1] || 0) + 1;
        var note = noteText(cell.note);
        var manual = note.indexOf(MANUAL_LETTER_NOTE) === 0;
        if (manual) out.finalLetterCells.push([r - 1, c - 1]);
        if (isFormulaValue(v)) {
          formulas[c - 1] = (formulas[c - 1] || 0) + 1;
          if (isLetterFormula(v)) letterInfo[c - 1] = true;
          continue;
        }
        if (manual) continue;
        if (note.indexOf(WITHDRAWN_LETTER_NOTE) === 0) {
          // Not proof that the column's other cells are suggestions (they may have been pasted as values).
          if (text.trim() !== '' && letterKey(text) !== WITHDRAWN_LETTER) out.editedLetterCells.push([r - 1, c - 1]);
          continue;
        }
        var noted = suggestedLetterOfNote(note);
        if (noted !== null) {
          letterInfo[c - 1] = true;
          if (text.trim() !== '' && letterKey(text) !== letterKey(noted)) out.editedLetterCells.push([r - 1, c - 1]);
          continue;
        }
        if (r > 1 && text.trim() !== '') (plain[c - 1] = plain[c - 1] || []).push([r - 1, c - 1]);
      }
      rows.push(cells);
    }
    plain.forEach(function (list, ci) { if (list && letterInfo[ci]) out.editedLetterCells = out.editedLetterCells.concat(list); });
    out.editedLetterCells.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    for (var rr = lim.maxRows + 1; rr <= count && !out.truncatedRows; rr++) {
      var extra = findRowOf(ws, rr);
      if (extra && extra.hasValues) out.truncatedRows = true;
    }
    out.rows = tidyRows(rows, lim);
    formulas.forEach(function (f, i) { if (f && f * 2 >= filled[i]) out.formulaColumns.push(i); });
    return out;
  }

  /** Rows of text from an ExcelJS worksheet (row 1 of the sheet is index 0). limits: see tidyRows. */
  function rowsFromWorksheet(ws, limits) {
    return scanWorksheet(ws, limits).rows;
  }

  /** 0-based indexes of the columns whose non-empty cells are mostly formulas (at least half). A
   * "Letter Grade" column of formulas holds suggestions from cutoffs, not final letters, so
   * guessMapping leaves it unmapped when it is told about these columns. */
  function formulaColumnsOf(ws, limits) {
    return scanWorksheet(ws, limits).formulaColumns;
  }

  /** True when the workbook was written by Grade Tracker's exporter (its creator, or the last line of
   * its Settings sheet). */
  function isGradeTrackerWorkbook(wb) {
    if (wb && wb.creator === 'Grade Tracker') return true;
    var ws = wb && typeof wb.getWorksheet === 'function' ? wb.getWorksheet('Settings') : null;
    if (!ws) return false;
    var rows = rowsFromWorksheet(ws, { maxRows: 200, maxCols: 5 });
    return rows.some(function (r) { return /^Generated by Grade Tracker\b/.test(String(r[0] || '')); });
  }

  /** Reads an .xlsx (ArrayBuffer or Uint8Array) with the given ExcelJS. Resolves with
   * [{ name, hidden, rows, formulaColumns, finalLetterCells, editedLetterCells, truncatedRows,
   * truncatedColumns }] per worksheet; rejects with a readable message. limits: { maxRows, maxCols }
   * (DEFAULT_LIMITS).
   * finalLetterCells and editedLetterCells are null unless the file comes from Grade Tracker. Then
   * finalLetterCells lists the [row, col] cells that hold a letter the instructor chose: those marked
   * "Final letter assigned by the instructor", and those changed in the spreadsheet after the export
   * (editedLetterCells, see scanWorksheet: typed over a suggestion or over a letter formula). Pass it to
   * plan() as an option, so only those letters of an exported "Letter Grade" column become final
   * letters. A letter column with such typed letters is left out of formulaColumns, so guessMapping
   * maps it (its formulas stay suggestions: they are not in finalLetterCells); pass editedLetterCells to
   * guessMapping too, so a "Suggested Letter (cutoffs)" column with typed letters is mapped when no other
   * letter column is. */
  function readWorkbook(ExcelJS, data, limits) {
    return Promise.resolve().then(function () {
      if (!ExcelJS || typeof ExcelJS.Workbook !== 'function') throw new Error('The Excel library (ExcelJS) is not available.');
      var wb = new ExcelJS.Workbook();
      return wb.xlsx.load(data).then(function () {
        var fromApp = isGradeTrackerWorkbook(wb);
        return wb.worksheets.map(function (ws) {
          var scan = scanWorksheet(ws, limits);
          var edited = fromApp ? scan.editedLetterCells : null;
          var editedCol = Object.create(null);
          (edited || []).forEach(function (p) { editedCol[p[1]] = true; });
          return {
            name: ws.name,
            hidden: ws.state === 'hidden' || ws.state === 'veryHidden',
            rows: scan.rows,
            formulaColumns: scan.formulaColumns.filter(function (ci) { return !editedCol[ci]; }),
            finalLetterCells: fromApp ? scan.finalLetterCells.concat(edited).sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); }) : null,
            editedLetterCells: edited,
            truncatedRows: scan.truncatedRows,
            truncatedColumns: scan.truncatedColumns
          };
        });
      }, function () {
        throw new Error('This file could not be read as an Excel workbook (.xlsx). ' + XLS_MESSAGE);
      });
    });
  }

  var GUARDED_START = /^'(?=[=+\-@\t\r])/;
  var GUARDED_SEGMENT = /([;\t])'(?=[=+\-@\t\r])/g;
  var DECIMAL_COMMA = /^\s*[-+]?\d+,\d+\s*%?\s*$/;

  /** One CSV cell as the spreadsheet showed it: the apostrophe that a CSV formula guard (Grade
   * Tracker's export, GT.csv.stringify) puts before = + - @ is removed again, and in a ';'-separated
   * file (Excel in comma-decimal locales) "92,5" is the number 92.5. */
  function csvCell(c, delimiter) {
    var t = String(c);
    if (t.indexOf("'") !== -1) t = t.replace(GUARDED_START, '').replace(GUARDED_SEGMENT, '$1');
    if (delimiter === ';' && t.indexOf(',') !== -1 && DECIMAL_COMMA.test(t)) t = t.replace(',', '.');
    return t;
  }

  /** CSV / TSV text read like rowsFromCsv, with details: { rows, delimiter, truncatedRows,
   * truncatedColumns }. */
  function readCsv(text, limits) {
    var lim = limitsOf(limits);
    var table = dep('csv').parseTable(text, { maxRows: lim.maxRows, maxCols: lim.maxCols });
    var rows = table.rows.map(function (r) { return r.map(function (c) { return csvCell(c, table.delimiter); }); });
    return { rows: tidyRows(rows, lim), delimiter: table.delimiter, truncatedRows: table.truncatedRows, truncatedColumns: table.truncatedColumns };
  }

  /** Rows of text from CSV / TSV text (delimiter detected; BOM and quotes handled; the formula-guard
   * apostrophe removed; decimal commas in a ';'-separated file). limits: see tidyRows. */
  function rowsFromCsv(text, limits) {
    return readCsv(text, limits).rows;
  }

  /** 'xlsx' | 'csv' | 'xls' | 'other' from a file name. */
  function fileKind(name) {
    var n = String(name || '').toLowerCase();
    if (/\.(xlsx|xlsm)$/.test(n)) return 'xlsx';
    if (/\.(csv|tsv|txt)$/.test(n)) return 'csv';
    if (/\.xls$/.test(n)) return 'xls';
    return 'other';
  }

  var HEADER_SCAN_ROWS = 30;

  /** Index of the header row. Among the first 30 rows, the one whose cells guessMapping recognizes
   * the most (at least 2 different targets; the first such row on a tie), so a title row ("Course:",
   * "SE 4351") or a merged title above the headers is passed over. `course` (optional) adds its
   * assessment names. Otherwise the first row with at least 2 different non-empty cells that are not
   * numbers; 0 when none. */
  function detectHeaderRow(rows, course) {
    var list = Array.isArray(rows) ? rows : [];
    var best = -1, bestHits = 1;
    var scan = Math.min(list.length, HEADER_SCAN_ROWS);
    for (var i = 0; i < scan; i++) {
      var row = Array.isArray(list[i]) ? list[i] : [];
      var seen = Object.create(null), hits = 0;
      for (var j = 0; j < row.length && j < DEFAULT_LIMITS.maxCols; j++) {
        var k = guessOne(row[j], course).key;
        if (k !== 'ignore' && !seen[k]) { seen[k] = true; hits++; }
      }
      if (hits > bestHits) { best = i; bestHits = hits; }
    }
    if (best !== -1) return best;
    for (var r = 0; r < list.length; r++) {
      var cells = Array.isArray(list[r]) ? list[r] : [];
      var texts = Object.create(null), n = 0;
      for (var c = 0; c < cells.length; c++) {
        var t = cells[c] === null || cells[c] === undefined ? '' : String(cells[c]).trim();
        if (t === '' || util.parseScoreInput(t).kind !== 'invalid') continue;
        if (!texts[t.toLowerCase()]) { texts[t.toLowerCase()] = true; n++; }
      }
      if (n >= 2) return r;
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
      // A header that says 0% cannot be turned back into scores; any other weight in the header is
      // used by plan() for the conversion (the file may be older than a change of the weights).
      if (weightFromHeader(text) === 0) return none;
      return (a.weight || 0) > 0 ? { key: 'weighted:' + a.id, score: best.score } : none;
    }
    return { key: 'raw:' + a.id, score: best.score };
  }

  /** The weight written in a weighted column's header: the number before the last '%' ("Project II
   * 20%" -> 20, "Test 1 (12.5%)" -> 12.5, "Project I 10,5 %" -> 10.5); null when there is none. */
  function weightFromHeader(header) {
    var text = String(header === null || header === undefined ? '' : header);
    var re = /(\d+(?:[.,]\d+)?)\s*%/g, m, last = null;
    while ((m = re.exec(text)) !== null) last = m[1];
    if (last === null) return null;
    var n = Number(last.replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  /** Target key per header cell. The previous TA's sheet maps exactly (DESIGN section 9). When two
   * columns claim the same target, the stronger match keeps it (ties: the first column) and the other
   * is set to 'ignore', so "Final Letter" wins over "Letter Grade". opts.formulaColumns (from
   * readWorkbook): a letter column made of formulas is left unmapped, because it holds suggestions.
   * opts.editedLetterCells (from readWorkbook): a column with letters changed after the export is a
   * final-letter column, the weakest one (so "Suggested Letter (cutoffs)" with a typed letter is mapped
   * when the file has no other letter column that is; plan() compares the others, review V4R3-1). */
  function guessMapping(headerCells, course, opts) {
    var formulaCols = opts && Array.isArray(opts.formulaColumns) ? opts.formulaColumns : [];
    var edited = Object.create(null);
    (opts && Array.isArray(opts.editedLetterCells) ? opts.editedLetterCells : []).forEach(function (p) {
      if (Array.isArray(p) && typeof p[1] === 'number') edited[p[1]] = true;
    });
    var guesses = (Array.isArray(headerCells) ? headerCells : []).map(function (h, i) {
      var g = guessOne(h, course);
      if (edited[i] && (g.key === 'ignore' || g.key === 'finalLetter')) return { key: 'finalLetter', score: g.key === 'finalLetter' ? g.score : 1 };
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
      switchAttendanceToTotals: x.switchAttendanceToTotals === true,
      updateNames: x.updateNames === true,
      finalLetterCells: Array.isArray(x.finalLetterCells) ? x.finalLetterCells.filter(function (p) {
        return Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number';
      }) : null
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

  /** A team name without its "Team" / "Group" word and leading zeros: "Team 02" -> "2", "Group B" -> "b". */
  function looseTeamKey(name) {
    return normName(name).replace(/[#:.,_()\-\u2013\u2014]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^(team|group|grp|squad)( (no|nr|number))?( |$)/, '').replace(/\b0+(\d)/g, '$1').trim();
  }

  /** The team that a name from a file means: the first team with that exact name (case and spaces
   * ignored), else the one team whose name differs only in form ("2", "Team 2", "Team 02", "Group 2";
   * "B" and "Team B"); null when there is none or several. */
  function resolveTeam(teams, name) {
    var list = Array.isArray(teams) ? teams : [];
    var key = normName(name);
    if (key === '') return null;
    for (var i = 0; i < list.length; i++) if (normName(list[i].name) === key) return list[i];
    var loose = looseTeamKey(name);
    if (loose === '') return null;
    var hits = list.filter(function (t) { return looseTeamKey(t.name) === loose; });
    return hits.length === 1 ? hits[0] : null;
  }

  /** Words that name a summary row under the data ("Average", "Max", …), not a student. */
  var SUMMARY_WORDS = ['average', 'averages', 'avg', 'mean', 'median', 'mode', 'max', 'maximum', 'min', 'minimum',
    'total', 'totals', 'sum', 'count', 'std', 'stdev', 'std dev', 'st dev', 'sd', 'standard deviation', 'variance',
    'var', 'range', 'highest', 'lowest', 'high', 'low', 'class average', 'class avg', 'class mean', 'class median',
    'class total', 'overall average', 'grand total', 'statistics', 'stats'];
  var NAME_LIKE_SUMMARY_WORDS = ['max', 'min', 'high', 'low', 'mode', 'sd', 'var', 'range', 'count'];

  var STATUS_WORDS = {
    withdrawn: 'withdrawn', w: 'withdrawn', wd: 'withdrawn', dropped: 'withdrawn', drop: 'withdrawn',
    inactive: 'withdrawn', withdraw: 'withdrawn', active: 'active', a: 'active', enrolled: 'active'
  };

  function parseStatus(text) {
    var t = normName(text);
    if (t === '') return { kind: 'empty' };
    return hasOwn(STATUS_WORDS, t) ? { kind: 'value', value: STATUS_WORDS[t] } : { kind: 'invalid' };
  }

  // Weeks late as this app exports it ("2", "2 (waived)") or as a person may type it ("2 waived",
  // "1 week", "2 weeks late, penalty waived"). A whole number of weeks only (util.parseCount).
  var LATE_RE = /^(\d+(?:\.0*)?)\s*(?:(?:weeks?|wks?)\.?)?\s*(?:late)?\s*,?\s*(\(\s*(?:penalty\s+)?waived\s*\)|(?:penalty\s+)?waived)?$/i;
  var WAIVED_ONLY_RE = /^\(?\s*(?:penalty\s+)?waived\s*\)?$/i;

  /** Weeks late: { kind: 'empty' } for '', { kind: 'value', weeks, waived } for "2", "2 (waived)",
   * "2 waived", "1 week late", "2 weeks late, penalty waived"; { kind: 'waived' } for a bare "waived"
   * ("(waived)", "penalty waived"): the student's weeks late stay and the penalty is waived;
   * { kind: 'invalid' } otherwise (fractions, signs, text). */
  function parseLate(text) {
    var t = String(text || '').trim();
    if (t === '') return { kind: 'empty' };
    if (WAIVED_ONLY_RE.test(t)) return { kind: 'waived' };
    var m = LATE_RE.exec(t);
    if (!m) return { kind: 'invalid' };
    var weeks = util.parseCount(m[1]);
    if (weeks === null) return { kind: 'invalid' };
    return { kind: 'value', weeks: weeks, waived: !!m[2] && weeks > 0 };
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

  /** Whether a sheet looks like a Grade Tracker export, whose "Letter Grade" column mixes final letters
   * and suggestions: the letter column is headed "Letter Grade", and the sheet has a "Suggested Letter
   * (cutoffs)" column, or a "Status" column that holds only "Active" and "Withdrawn" (the export's words). */
  function looksLikeAppExport(rows, hi, letterCol) {
    var header = rows[hi] || [];
    if (tokensOf(header[letterCol]).join(' ') !== 'letter grade') return false;
    var statusCol = -1, suggested = false;
    header.forEach(function (h, i) {
      var t = tokensOf(h);
      if (t.join(' ') === 'status' && statusCol === -1) statusCol = i;
      if (t.indexOf('suggested') !== -1 && t.indexOf('letter') !== -1) suggested = true;
    });
    if (suggested) return true;
    if (statusCol === -1) return false;
    var seen = 0;
    for (var r = hi + 1; r < rows.length; r++) {
      var v = String(rows[r][statusCol] === undefined ? '' : rows[r][statusCol]).trim();
      if (v === '') continue;
      if (v !== 'Active' && v !== 'Withdrawn') return false;
      seen++;
    }
    return seen > 0;
  }

  /** Plans an import (pure: `course` is not changed). rows: string[][]; headerIndex: the header row;
   * mapping: a target key per column (see targetsFor). options: { matchBy: 'name'|'no', createMissing,
   * emptyCells: 'keep'|'clear', overwrite, switchAttendanceToTotals, updateNames (matching by No: take
   * the file's names too; default false: a row whose name differs is skipped), finalLetterCells (from
   * readWorkbook, for a file from Grade Tracker) }. Returns
   * { items: [{ rowIndex, action: 'update'|'new'|'skip', reason?, studentId?, name, changes: [{ field,
   *   oldValue, newValue, blocked?, reason?, notOnList?, outOfRange?, invalid?, override?,
   *   emptiedByMove? }], issues: [{ field, value, message }] }], counts: { update, new, skip, changes,
   *   overrides, invalid, blocked, notOnList, lettersSkipped, lettersAsSuggestion, lettersFromOtherColumn,
   *   lettersNotImported, lettersWithdrawn, duplicateNos, teamsCreated, scoresEmptied, kept, unchanged, propagated,
   *   totalsDiffer }, propagated: [{ studentId, name,
   *   changes }], notes: [string], errors: [string], options, finalized }. */
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
    // A weighted column converts back with the weight written in its header ("Project II 20%"), which
    // may be older than a change of the course's weights.
    var convertWeight = Object.create(null);
    list2.forEach(function (a) {
      var ci = cols['weighted:' + a.id];
      if (ci === undefined) return;
      var hw = weightFromHeader(header[ci]);
      if (hw === null || fix(hw) === fix(a.weight || 0)) return;
      if (!(hw > 0)) {
        notes.push('Column ' + colName(ci) + ' is ignored: a weight of 0% cannot be turned back into ' + a.name + ' scores.');
        delete cols['weighted:' + a.id];
        return;
      }
      convertWeight[a.id] = hw;
      notes.push('Column ' + colName(ci) + ' was made with a weight of ' + num(hw) + '%, but ' + a.name + ' weighs ' + num(a.weight) +
        '% in this course: its values are turned back into scores with ' + num(hw) + '% (value ÷ ' + num(hw) + ' × ' + num(a.maxScore) + ').');
    });
    // Final letters. A "Letter Grade" column of a file from Grade Tracker holds each student's final
    // letter or, without one, the suggestion from the cutoffs: a letter equal to the suggestion is not
    // stored as a final letter (the file cannot say the instructor chose it). With
    // options.finalLetterCells (readWorkbook) exactly the listed cells are final letters: those marked
    // "Final letter assigned by the instructor" and those changed in the file after the export.
    var letterMixed = false, notedLetter = Object.create(null);
    if (cols.finalLetter !== undefined && tokensOf(header[cols.finalLetter]).indexOf('final') === -1) {
      if (o.finalLetterCells) {
        letterMixed = true;
        o.finalLetterCells.forEach(function (p) { if (p[1] === cols.finalLetter) notedLetter[p[0]] = true; });
      } else letterMixed = looksLikeAppExport(list, hi, cols.finalLetter);
    }
    // The file's own "Total" column (not mapped: totals are always computed from the scores). It tells
    // a Grade Tracker letter that was the file's suggestion, and each total is compared with the one the
    // imported scores give here (a column left out, such as weeks late, or other weights, curve or
    // rounding would change it silently otherwise).
    var usedCol = Object.create(null);
    Object.keys(cols).forEach(function (k) { usedCol[cols[k]] = true; });
    var totalCol = -1;
    header.forEach(function (h, i) { if (totalCol === -1 && !usedCol[i] && tokensOf(h).join(' ') === 'total') totalCol = i; });
    // Final letters in the other letter columns of a Grade Tracker file (review V4R3-1): the "Everything"
    // preset has "Letter Grade", "Suggested Letter (cutoffs)" and "Final Letter", and only one of them is
    // mapped. The cells readWorkbook lists in finalLetterCells in a column that is not read (letters
    // typed in after the export, or marked "Final letter assigned by the instructor") are compared with
    // the mapped column row by row (otherLetterOf) or, when no column is mapped to Final letter,
    // reported (unmappedLetters): such a letter is never dropped without a word.
    var otherLetters = Object.create(null), otherTally = Object.create(null);
    if (o.finalLetterCells) {
      o.finalLetterCells.forEach(function (p) {
        if (p[0] <= hi || p[1] < 0 || usedCol[p[1]]) return;
        var at = otherLetters[p[0]] = otherLetters[p[0]] || [];
        if (at.indexOf(p[1]) === -1) at.push(p[1]);
      });
    }
    var tally = function (ci, what) {
      var t = otherTally[ci] = otherTally[ci] || { taken: 0, conflict: 0, unmapped: 0 };
      t[what]++;
    };
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

    var counts = { update: 0, 'new': 0, skip: 0, changes: 0, overrides: 0, invalid: 0, blocked: 0, notOnList: 0, lettersSkipped: 0,
      lettersAsSuggestion: 0, lettersFromOtherColumn: 0, lettersNotImported: 0, lettersWithdrawn: 0, duplicateNos: 0, teamsCreated: 0,
      scoresEmptied: 0, kept: 0, unchanged: 0, propagated: 0, totalsDiffer: 0 };
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

    /** The row's number in the "Total" column: { text, value, half } (half: half a unit of the last
     * decimal written, so "85" fits 85.125 and "85.13" fits 85.125), or null. */
    function fileTotalOf(row) {
      if (totalCol === -1 || !row) return null;
      var t = String(row[totalCol] === undefined || row[totalCol] === null ? '' : row[totalCol]).trim();
      var p = util.parseScoreInput(t);
      if (p.kind !== 'number') return null;
      var m = /\.(\d*)/.exec(t);
      var decimals = /e/i.test(t) ? 10 : Math.min(m ? m[1].length : 0, 10);
      return { text: t, value: p.value, half: 0.5 * Math.pow(10, -decimals) + 1e-9 };
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

    /** Whether the file's name fits the student (case and spaces ignored; an empty part on either
     * side is not compared). */
    function sameName(n, st) {
      if (n.full) {
        var f = normFull(n.full);
        return f === normFull(st.firstName + ' ' + st.lastName) || f === normFull(st.lastName + ' ' + st.firstName);
      }
      var same = function (a, b) { return normName(a) === '' || normName(b) === '' || normName(a) === normName(b); };
      return (cols.lastName === undefined || same(n.lastName, st.lastName)) && (cols.firstName === undefined || same(n.firstName, st.firstName));
    }

    /** The summary word of a row such as "Average" or "Max" under the data (one name cell only), else
     * null. When the file has one name column, words that are also names ("Max", "Min", "Low") do not count. */
    function summaryRowWord(n) {
      var text = n.full ? n.full : (n.lastName !== '' && n.firstName !== '' ? '' : n.lastName || n.firstName);
      var key = tokensOf(text).join(' ');
      if (key === '' || SUMMARY_WORDS.indexOf(key) === -1) return null;
      var bothParts = cols.lastName !== undefined && cols.firstName !== undefined && !n.full;
      if (!bothParts && NAME_LIKE_SUMMARY_WORDS.indexOf(key) !== -1) return null;
      return String(text).replace(/\s+/g, ' ').trim();
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
        if (o.matchBy === 'no' && !o.updateNames && !sameName(n, student)) {
          // The file may number its rows in another order: its scores would land on another student.
          item.reason = 'No ' + noVal + ' is a student with another name in this course; skipped (match by name, or choose to update names from the file)';
          return item;
        }
        if (matchedRow[student.id] !== undefined) {
          item.reason = 'Same student as row ' + (matchedRow[student.id] + 1);
          return item;
        }
        matchedRow[student.id] = ri;
        item.action = 'update';
        item.studentId = student.id;
        item.name = model.studentName(student);
      } else {
        if (o.matchBy === 'no' && hasName && matchByName(n).length) {
          item.reason = 'No ' + noVal + ' is not in this course, but a student with this name is; skipped (match by name, or correct the No)';
          return item;
        }
        if (!o.createMissing) { item.reason = 'No matching student in this course'; return item; }
        if (!hasName) { item.reason = 'No matching student, and no name to add one'; return item; }
        var summaryWord = noVal === null ? summaryRowWord(n) : null;
        if (summaryWord) { item.reason = 'Summary row ("' + summaryWord + '"), not a student'; return item; }
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

    /** The letters a row has in the other letter columns (otherLetters): [{ col, text, letter }], where
     * letter is null for text that is not a letter of the scale. */
    function otherLettersOf(item, row) {
      return (otherLetters[item.rowIndex] || []).map(function (ci) {
        var t = String(row[ci] === undefined || row[ci] === null ? '' : row[ci]).trim();
        return { col: ci, text: t, letter: t === '' ? null : model.matchLetter(course, t) };
      }).filter(function (x) { return x.text !== ''; });
    }

    /** The final letter a row takes from another letter column: { letter, col }, or null. `claim` is the
     * letter the mapped column gives (null: empty, a suggestion or not a letter). The other letter is
     * taken when the mapped column gives none, so a letter typed into "Letter Grade" is imported while
     * "Final Letter" is empty. When the columns disagree, the mapped column wins and every other letter
     * is reported. Only the file decides (not the student's current letter), so importing the same file
     * again gives the same result. */
    function otherLetterOf(item, row, claim) {
      var found = [];
      otherLettersOf(item, row).forEach(function (x) {
        if (x.letter === null) {
          issue(item, 'Final letter', x.text, 'Column ' + colName(x.col) + ': "' + x.text.slice(0, 20) + '" is not a letter of this course\'s scale (' +
            scaleList(course) + '); skipped');
          counts.lettersSkipped++;
          return;
        }
        if (x.letter !== claim && !found.some(function (f) { return f.letter === x.letter; })) found.push(x);
      });
      if (!found.length) return null;
      if (found.length === 1 && claim === null) return { letter: found[0].letter, col: found[0].col };
      found.forEach(function (f) {
        var others = found.filter(function (g) { return g !== f; }).map(function (g) { return g.letter + ' in column ' + colName(g.col); });
        issue(item, 'Final letter', f.letter, claim !== null
          ? 'Column ' + colName(f.col) + ' gives ' + f.letter + ', but final letters are read from column ' + colName(cols.finalLetter) + ', which gives ' + claim +
            ': ' + f.letter + ' is not imported. If the instructor chose ' + f.letter + ', set it in the Grades tab'
          : 'Column ' + colName(f.col) + ' gives ' + f.letter + ', but the file also has ' + others.join(' and ') +
            ': ' + (found.length === 2 ? 'neither' : 'none') + ' is imported. Set the final letter the instructor chose in the Grades tab');
        counts.lettersNotImported++;
        tally(f.col, 'conflict');
      });
      return null;
    }

    /** No column is mapped to Final letter: the letters of the other letter columns that would change
     * the student's final letter are reported (never imported). */
    function unmappedLetters(item, row, curL) {
      otherLettersOf(item, row).forEach(function (x) {
        if (x.letter !== null && x.letter === curL) return;
        issue(item, 'Final letter', x.text, 'Column ' + colName(x.col) + ' gives ' + (x.letter || '"' + x.text.slice(0, 20) + '"') +
          ' as a final letter (changed in the file after the export, or marked as a final letter), but no column is set to "Final letter"; not imported');
        counts.lettersNotImported++;
        tally(x.col, 'unmapped');
      });
    }

    /** Whether a row is a withdrawn student's: its Status cell says so or, without a Status column, the
     * matched student is withdrawn. */
    function rowWithdrawn(row, student) {
      var st = cell(row, 'status');
      if (st !== undefined) return parseStatus(st).value === 'withdrawn';
      return !!student && student.status === 'withdrawn';
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
      // Names: set for new students; for existing ones only when matched by No: an empty name part is
      // filled, another spelling is taken only with updateNames (case and spaces never count).
      if (isNew) {
        ops.info.lastName = n.lastName;
        ops.info.firstName = n.firstName;
      } else if (o.matchBy === 'no') {
        [['lastName', n.lastName], ['firstName', n.firstName]].forEach(function (p) {
          var mapped = p[0] === 'lastName' ? (cols.lastName !== undefined || cols.fullName !== undefined) : (cols.firstName !== undefined || cols.fullName !== undefined);
          if (!mapped || p[1] === '' || normName(p[1]) === normName(student[p[0]])) return;
          var empty = normName(student[p[0]]) === '';
          if (!empty && !o.updateNames) return;
          if (fill(empty)) ops.info[p[0]] = p[1]; else counts.kept++;
        });
      }
      // Team: "2", "Team 02" or "Group 2" is the existing "Team 2" (resolveTeam).
      var teamText = cell(row, 'team');
      if (teamText !== undefined) {
        var tn = teamText.replace(/\s+/g, ' ').trim();
        var cur = isNew ? '' : teamNameOf(course, student);
        if (tn === '') {
          if (!isNew && !keep && cur !== '') ops.info.team = null;
        } else if (normName(tn) !== normName(cur)) {
          var target = resolveTeam(course.teams, tn);
          var curTeam = !isNew && student.teamId ? model.findTeam(course, student.teamId) : null;
          if (!(target && curTeam && target.id === curTeam.id)) {
            if (fill(cur === '')) ops.info.team = tn; else counts.kept++;
          }
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
      var curL = isNew ? null : model.finalLetterOf(student);
      if (lt !== undefined) {
        var ltText = lt.trim();
        // "W" in a Grade Tracker "Letter Grade" column, on a withdrawn student's row: the export's mark for
        // "withdrawn, no letter grade" (not typed over after the export), so it reads as an empty cell.
        if (letterMixed && !notedLetter[item.rowIndex] && letterKey(ltText) === WITHDRAWN_LETTER && rowWithdrawn(row, student)) {
          ltText = '';
          counts.lettersWithdrawn++;
        }
        var letter = ltText === '' ? null : model.matchLetter(course, ltText);
        if (ltText !== '' && letter === null) {
          issue(item, 'Final letter', ltText, '"' + ltText.slice(0, 20) + '" is not a letter of this course\'s scale (' + scaleList(course) + '); skipped');
          counts.lettersSkipped++;
        }
        var suggestionCell = letter !== null && letterMixed && !notedLetter[item.rowIndex];
        var other = otherLetterOf(item, row, suggestionCell ? null : letter);
        if (other) {
          if (other.letter !== curL) {
            if (fill(curL === null)) { ops.letter = other.letter; counts.lettersFromOtherColumn++; tally(other.col, 'taken'); } else counts.kept++;
          }
        } else if (ltText === '') {
          if (!isNew && !keep && curL !== null) ops.letter = null;
        } else if (suggestionCell) {
          // Decided after the simulation, against the suggestion from the imported scores.
          ops.letterCandidate = { letter: letter, current: curL, unmarked: !!o.finalLetterCells };
        } else if (letter !== null && letter !== curL) {
          if (fill(curL === null)) ops.letter = letter; else counts.kept++;
        }
      } else unmappedLetters(item, row, curL);
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
            var w = hasOwn(convertWeight, a.id) ? convertWeight[a.id] : a.weight;
            if (p.kind === 'number') p = { kind: 'number', value: fix(p.value / w * a.maxScore) };
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
        if (lp.kind === 'waived') {
          // A bare "waived": the weeks late already stored stay, and the penalty is waived.
          var keepW = !isNew && cur && cur.weeksLate > 0 ? cur.weeksLate : 0;
          lp = keepW ? { kind: 'value', weeks: keepW, waived: true } : { kind: 'no-weeks' };
        }
        if (lp.kind === 'no-weeks') {
          counts.invalid++;
          issue(item, a.name + ': weeks late', lateCell.trim(), '"waived" needs the weeks late, for example "1 (waived)"; ignored');
        } else if (lp.kind === 'invalid') {
          counts.invalid++;
          issue(item, a.name + ': weeks late', lateCell.trim(), 'Use a whole number of weeks, optionally "(waived)"; ignored');
        } else if (lp.kind === 'value' || (lp.kind === 'empty' && o.emptyCells === 'clear' && !isNew)) {
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
          if (eText === undefined) {
            // Only a total (the old sheet's "No of Absence"): the excused absences already stored stay,
            // the rest is unexcused, so the student's total absences equal the file's. An emptied cell
            // ("clear") empties both.
            if (tText.trim() === '') { a = 0; e = 0; }
            else if (total < curE) {
              counts.invalid++;
              issue(item, 'Total absences', tText.trim(), 'Less than the ' + curE + ' excused absences already stored; ignored (change them in the Attendance tab)');
            } else a = total - curE;
          } else {
            var ex = e !== undefined ? e : curE;
            if (total < ex) {
              counts.invalid++;
              issue(item, 'Total absences', tText.trim(), 'Less than the excused absences (' + ex + '); ignored');
            } else a = total - ex;
          }
        }
      }
      var next = {};
      if (a !== undefined && a !== curA) next.absent = a;
      if (e !== undefined && e !== curE) next.excused = e;
      if (!Object.keys(next).length) return;
      if (!isNew && !o.overwrite && cur) { counts.kept++; return; }
      ops.att = next;
    }

    if (!errors.length) resolveNos();

    /** Keeps every No unique, as the Students tab does. A file No that another student keeps (or that
     * an earlier row of the file takes) is not given: an existing student keeps its No, a new one gets
     * the next free No. Numbers that are only swapped or moved around within the file are fine. New
     * students without a No get the next free numbers here, so they never take a No of a later row. */
    function resolveNos() {
      var proposal = Object.create(null);
      items.forEach(function (it) {
        if (it.action === 'update' && it.ops && hasOwn(it.ops.info, 'no')) proposal[it.studentId] = it;
      });
      var rejected = [];
      var changed = true;
      while (changed) {
        changed = false;
        var at = Object.create(null), order = [];
        var put = function (no, e) { if (!at[no]) { at[no] = []; order.push(no); } at[no].push(e); };
        students.forEach(function (st) {
          var it = proposal[st.id];
          if (it && hasOwn(it.ops.info, 'no')) put(it.ops.info.no, { item: it });
          else if (typeof st.no === 'number') put(st.no, { holder: st });
        });
        items.forEach(function (it) {
          if (it.action === 'new' && it.ops && hasOwn(it.ops.info, 'no')) put(it.ops.info.no, { item: it });
        });
        order.forEach(function (no) {
          var group = at[no];
          if (group.length < 2) return;
          var takers = group.filter(function (e) { return e.item; }).sort(function (x, y) { return x.item.rowIndex - y.item.rowIndex; });
          if (!takers.length) return; // two students already share it: not this import's doing
          var kept = group.some(function (e) { return e.holder; });
          (kept ? takers : takers.slice(1)).forEach(function (e) {
            delete e.item.ops.info.no;
            rejected.push({ item: e.item, no: Number(no), row: kept ? null : takers[0].item.rowIndex });
            changed = true;
          });
        });
      }
      var max = 0;
      var seeNo = function (no) { if (typeof no === 'number' && no > max) max = no; };
      students.forEach(function (st) {
        var it = proposal[st.id];
        seeNo(it && hasOwn(it.ops.info, 'no') ? it.ops.info.no : st.no);
      });
      items.forEach(function (it) { if (it.action === 'new' && it.ops && hasOwn(it.ops.info, 'no')) seeNo(it.ops.info.no); });
      items.forEach(function (it) {
        if (it.action === 'new' && it.ops && !hasOwn(it.ops.info, 'no')) it.ops.info.no = ++max;
      });
      rejected.forEach(function (x) {
        var why = x.row === null ? 'is already used by another student in this course' : 'is also given to row ' + (x.row + 1) + ' of the file';
        var then = x.item.action === 'new' ? 'given No ' + x.item.ops.info.no + ' instead' : 'the No is not changed';
        issue(x.item, 'No', String(x.no), 'No ' + x.no + ' ' + why + '; ' + then);
        counts.duplicateNos++;
      });
    }

    // Simulate on a scratch copy: the preview is exactly what apply() will do.
    var simCourse = scratchCopy(course);
    var sim = applyItems(simCourse, items, o);
    counts.overrides = sim.summary.overridesCreated;
    counts.teamsCreated = sim.summary.teamsCreated;

    // Letters of a Grade Tracker "Letter Grade" column: equal to the suggestion from the imported
    // scores -> a suggestion, not stored; otherwise a final letter, under the usual rules.
    items.forEach(function (it) {
      var cand = it.ops ? it.ops.letterCandidate : null;
      if (!cand) return;
      delete it.ops.letterCandidate;
      var sid = sim.ids[it.rowIndex];
      var simStudent = sid ? model.findStudent(simCourse, sid) : null;
      if (!simStudent || cand.letter === cand.current) return; // already this student's final letter
      var suggestion = calc.studentResult(simCourse, simStudent).letter;
      // The file's letter was the suggestion at the file's own total: compare with that one when the
      // file has it (a total that differs here must not turn the old suggestion into a final letter).
      var ft = fileTotalOf(list[it.rowIndex]);
      var fileSuggestion = ft ? calc.letterFor(ft.value, simCourse.settings.letterScale) : '';
      if (cand.unmarked) {
        // A cell of a Grade Tracker workbook that is neither marked "Final letter assigned by the
        // instructor" nor changed after the export (readWorkbook) holds the suggestion of that export:
        // never stored.
        counts.lettersAsSuggestion++;
        if (suggestion !== cand.letter) {
          // A letter that does not match the file's own total either is pointed out: a score changed in
          // the spreadsheet (the plain letter keeps the old suggestion), cutoffs changed here, or a
          // letter typed into a column that no longer tells (pasted as plain values).
          issue(it, 'Final letter', cand.letter, fileSuggestion && fileSuggestion !== cand.letter
            ? 'Not marked as a final letter in this Grade Tracker file; not stored. It does not match the file\'s total (' + ft.text + ' gives ' + fileSuggestion +
              ' with this course\'s cutoffs): a score or the cutoffs changed after the export, or the letter was typed in. If the instructor chose it, set it in the Grades tab. ' +
              'The suggestion here is ' + suggestion + '.'
            : 'The suggestion from the cutoffs in this Grade Tracker file (not a final letter); not stored. The suggestion here is ' + suggestion + '.');
        }
        return;
      }
      if ((fileSuggestion || suggestion) === cand.letter) { counts.lettersAsSuggestion++; return; }
      if (it.action === 'new' || o.overwrite || cand.current === null) {
        it.ops.letter = cand.letter;
        model.setFinalLetter(simCourse, sid, cand.letter);
      } else counts.kept++;
    });
    if (counts.lettersAsSuggestion) {
      var nl = counts.lettersAsSuggestion;
      notes.push(o.finalLetterCells
        ? 'Column ' + colName(cols.finalLetter) + ' comes from Grade Tracker: only its letters marked "Final letter assigned by the instructor", or changed in the file after the export, ' +
          'are imported as final letters. The other ' + (nl === 1 ? 'letter was a suggestion' : nl + ' letters were suggestions') + ' from the cutoffs, so ' + (nl === 1 ? 'it is' : 'they are') + ' not stored.'
        : 'Column ' + colName(cols.finalLetter) + ' looks like a file from Grade Tracker: it holds the final letters and, for students without one, ' +
          'the suggestion from the cutoffs. ' + (nl === 1 ? '1 letter equals' : nl + ' letters equal') +
          ' the suggestion, so ' + (nl === 1 ? 'it is' : 'they are') + ' not stored as final letters (the instructor assigns those in the Grades tab).');
    }
    if (counts.lettersWithdrawn) {
      var nw = counts.lettersWithdrawn;
      notes.push('Column ' + colName(cols.finalLetter) + ': "W" marks ' + (nw === 1 ? 'a withdrawn student' : nw + ' withdrawn students') +
        ' without a letter grade, so ' + (nw === 1 ? 'it is' : 'they are') + ' read as empty (no final letter).');
    }
    Object.keys(otherTally).map(Number).sort(function (a, b) { return a - b; }).forEach(function (ci) {
      var t = otherTally[ci];
      var n = function (k) { return k === 1 ? '1 letter' : k + ' letters'; };
      if (t.taken) {
        notes.push('Column ' + colName(ci) + ': ' + n(t.taken) + (t.taken === 1 ? ' was' : ' were') + ' changed in the spreadsheet after the export. ' +
          'Final letters are read from column ' + colName(cols.finalLetter) + ', which is empty for ' + (t.taken === 1 ? 'that student' : 'those students') + ', so ' +
          (t.taken === 1 ? 'the changed letter is imported as the final letter.' : 'the changed letters are imported as final letters.'));
      }
      if (t.conflict) {
        notes.push('Column ' + colName(ci) + ': ' + n(t.conflict) + ' ' + (t.conflict === 1 ? 'differs' : 'differ') + ' from the other letter columns of the file' +
          (cols.finalLetter !== undefined ? ' (final letters are read from column ' + colName(cols.finalLetter) + ')' : '') + ', so ' +
          (t.conflict === 1 ? 'it is' : 'they are') + ' not imported. Each one is listed under "Values to check": set the letter the instructor chose in the Grades tab.');
      }
      if (t.unmapped) {
        notes.push('Column ' + colName(ci) + ': ' + n(t.unmapped) + ' changed in the spreadsheet after the export, or marked as ' +
          (t.unmapped === 1 ? 'a final letter, ' : 'final letters, ') +
          (t.unmapped === 1 ? 'is' : 'are') + ' not imported, because no column is set to "Final letter". To import ' + (t.unmapped === 1 ? 'it' : 'them') +
          ', set column ' + colName(ci) + ' to "Final letter".');
      }
    });
    if (sim.summary.newTeams.length) {
      var shown = sim.summary.newTeams.slice(0, 8).map(function (t) { return '"' + t + '"'; }).join(', ');
      notes.push((sim.summary.newTeams.length === 1 ? 'A new team is' : sim.summary.newTeams.length + ' new teams are') + ' created: ' + shown +
        (sim.summary.newTeams.length > 8 ? ', …' : '') + '. Check that the Team column does not name existing teams in another way.');
    }

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
      // Team-graded scores that become empty because the student moves to a team without that score.
      if (before && item.changes.some(function (c) { return c.field === 'Team'; })) {
        assessmentsOf(course).forEach(function (a) {
          if (!a.teamGraded) return;
          item.changes.forEach(function (c) {
            if (c.field === a.name && c.oldValue !== '' && c.newValue === '') { c.emptiedByMove = true; counts.scoresEmptied++; }
          });
        });
      }
      item.blockedOps.forEach(function (b) {
        // A new team member of a finalized course gets the team score: the file's value is blocked
        // after that, so the blocked change starts from it (or is left out when it is the same).
        var applied = item.changes.filter(function (c) { return c.field === b.field && !c.blocked; })[0];
        var from = applied ? applied.newValue : b.oldValue;
        if (applied && from === b.newValue) return;
        item.changes.push({ field: b.field, oldValue: from, newValue: b.newValue, blocked: true, reason: FINALIZED_REASON });
        counts.blocked++;
      });
      var real = item.changes.filter(function (c) { return !c.blocked; }).length;
      counts.changes += real;
      if (item.action === 'update' && !item.changes.length) counts.unchanged++;
      // The file's total against the total from the imported scores (rows with blocked score changes
      // are left out: the blocked changes already explain the difference).
      var ft = scoreMapped && after && !(item.blockedOps && item.blockedOps.length) ? fileTotalOf(list[item.rowIndex]) : null;
      if (ft) {
        var r = calc.studentResult(simCourse, after);
        if (Math.abs(ft.value - r.total) > ft.half && Math.abs(ft.value - r.totalUnrounded) > ft.half) {
          issue(item, 'Total', ft.text, 'The file\'s total is ' + ft.text + ', but the imported scores give ' + num(r.total) +
            ' with this course\'s settings (the total is always computed from the scores)');
          counts.totalsDiffer++;
        }
      }
    });
    if (counts.totalsDiffer) {
      var td = counts.totalsDiffer;
      notes.push('Column ' + colName(totalCol) + ': ' + (td === 1 ? '1 student\'s total differs' : td + ' students\' totals differ') +
        ' from the total the imported scores give here. Totals are always computed from the scores, so check that the file has every score ' +
        'and weeks-late column, and that the weights, curve and rounding (Settings) match the file\'s.');
    }
    if (counts.scoresEmptied) {
      notes.push((counts.scoresEmptied === 1 ? '1 team-graded score becomes' : counts.scoresEmptied + ' team-graded scores become') +
        ' empty: the students move to a team that has no score for that item yet. Enter the new team\'s score in the Grades tab, or check the Team column.');
    }

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
    var add = function (field, kind, oldV, newV, extra, force) {
      var a = oldV === null || oldV === undefined ? '' : String(oldV);
      var b = newV === null || newV === undefined ? '' : String(newV);
      if (a === b && !force) return;
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
      // A score that becomes a per-member override is listed even when its value stays (a team move
      // while the scores are finalized keeps the visible score as an override).
      var becameOverride = ea.source === 'override' && (!eb || eb.source !== 'override');
      if (becameOverride) extra.override = true;
      if (ea.entry && typeof ea.entry.value !== 'number' && ea.entry.text) extra.invalid = true;
      var da = calc.scoreDetail(afterCourse, after, a);
      if (da.outOfRange) extra.outOfRange = true;
      add(a.name, 'score', eb ? scoreText(eb.entry) : '', scoreText(ea.entry), extra, becameOverride && !!eb);
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
    var summary = { created: 0, updated: 0, skipped: 0, missing: 0, teamsCreated: 0, newTeams: [], overridesCreated: 0, scores: 0, letters: 0, attendance: 0, modeSwitched: false };
    var ids = Object.create(null);
    var finalized = model.isFinalized(course);
    if (!Array.isArray(course.teams)) course.teams = [];
    function teamIdFor(name) {
      if (name === null || name === undefined) return null;
      var t = resolveTeam(course.teams, name);
      if (!t) {
        t = model.createTeam(String(name).replace(/\s+/g, ' ').trim());
        course.teams.push(t);
        summary.teamsCreated++;
        summary.newTeams.push(t.name);
      }
      return t.id;
    }
    function overrideSources(s) {
      var out = Object.create(null);
      assessmentsOf(course).forEach(function (a) { if (a.teamGraded) out[a.id] = calc.resolveEntry(course, s, a).source; });
      return out;
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
          // While finalized, a team move keeps the student's visible scores (totals do not change),
          // as per-member overrides where the new team's score differs: counted with the others.
          var sourcesBefore = overrideSources(s);
          model.moveStudentToTeam(course, s.id, info.team === null ? null : teamIdFor(info.team), { keepScores: finalized });
          var sourcesAfter = overrideSources(s);
          Object.keys(sourcesAfter).forEach(function (aid) {
            if (sourcesAfter[aid] === 'override' && sourcesBefore[aid] !== 'override') summary.overridesCreated++;
          });
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
   * teamsCreated, newTeams, overridesCreated, scores, letters, attendance, modeSwitched }. */
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
    DEFAULT_LIMITS: { maxRows: DEFAULT_LIMITS.maxRows, maxCols: DEFAULT_LIMITS.maxCols },
    cellText: cellText,
    rowsFromWorksheet: rowsFromWorksheet,
    formulaColumnsOf: formulaColumnsOf,
    readWorkbook: readWorkbook,
    readCsv: readCsv,
    rowsFromCsv: rowsFromCsv,
    fileKind: fileKind,
    detectHeaderRow: detectHeaderRow,
    targetsFor: targetsFor,
    isScoreTarget: isScoreTarget,
    isAttendanceTarget: isAttendanceTarget,
    guessMapping: guessMapping,
    duplicateTargets: duplicateTargets,
    weightFromHeader: weightFromHeader,
    resolveTeam: resolveTeam,
    splitFullName: splitFullName,
    plan: plan,
    apply: apply
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).importer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
