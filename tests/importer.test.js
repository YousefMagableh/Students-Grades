'use strict';
/* Tests for js/core/importer.js (STAGE 4 section 2 and its addendum; REQUIREMENTS E4).
 * Fake data only; every file is built in memory (no .xlsx or .csv is written to disk). */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('../vendor/exceljs.min.js');
const util = require('../js/core/util.js');
const model = require('../js/core/model.js');
const calc = require('../js/core/calc.js');
const csv = require('../js/core/csv.js');
const sample = require('../js/core/sample.js');
const attendance = require('../js/core/attendance.js');
const exporter = require('../js/core/exporter.js');
const importer = require('../js/core/importer.js');

// The previous TA's sheet, column by column (the 15th header is blank).
const OLD_HEADERS = ['No', 'Last Name', 'First Name', 'Final Project I', 'Final Project II', 'Test 1', 'Test 2',
  'Project I 10%', 'Project II 20%', 'Test 1 25%', 'Test 2 40%', 'Class Participation 5%', 'Total', 'Letter Grade', '', 'No of Absence'];

// ---------------------------------------------------------------- helpers

function sampleCourse(template) {
  const c = model.createCourse(template);
  sample.loadInto(c);
  return c;
}

/** An empty copy of the course: same assessments and settings, no students, teams, scores or attendance data. */
function emptyCopy(c) {
  const copy = model.createCourse(c.template);
  copy.assessments = util.clone(c.assessments);
  copy.settings = util.clone(c.settings);
  copy.attendance.mode = c.attendance.mode;
  return copy;
}

function addStudent(c, lastName, firstName, extra) {
  const s = model.createStudent(Object.assign({ lastName, firstName, no: c.students.length + 1 }, extra || {}));
  c.students.push(s);
  return s;
}

function addTeam(c, name) {
  const t = model.createTeam(name);
  c.teams.push(t);
  return t;
}

function eff(c, s, aid) {
  return model.effectiveEntry(c, s, model.findAssessment(c, aid));
}

function effValue(c, s, aid) {
  const e = eff(c, s, aid);
  return e && typeof e.value === 'number' ? e.value : (e && e.text ? 't:' + e.text : null);
}

/** Plans with the guessed mapping of the header row (detected) and applies. */
function importRows(c, rows, options, mappingOverride) {
  const hi = importer.detectHeaderRow(rows);
  const mapping = mappingOverride || importer.guessMapping(rows[hi], c);
  const p = importer.plan(c, rows, hi, mapping, options || {});
  const summary = importer.apply(c, p);
  return { plan: p, summary, mapping };
}

function csvRows(rows) {
  return importer.rowsFromCsv(csv.stringify(rows, { bom: true }));
}

function byName(c, last, first) {
  return c.students.find((s) => s.lastName === last && s.firstName === first);
}

// ================================================================ reading files

describe('reading files', () => {
  test('rowsFromWorksheet converts every kind of cell value and trims trailing empty rows and columns', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Grades');
    ws.getCell('A1').value = 'Name';
    ws.getCell('B1').value = 'Score';
    ws.getCell('C1').value = 'When';
    ws.getCell('A2').value = { richText: [{ text: 'Student ' }, { font: { bold: true }, text: '01' }] };
    ws.getCell('B2').value = 94;
    ws.getCell('C2').value = new Date(Date.UTC(2026, 8, 3));
    ws.getCell('A3').value = { text: 'Student 02', hyperlink: 'mailto:nobody@example.invalid' };
    ws.getCell('B3').value = { formula: 'B2/2', result: 47 };
    ws.getCell('C3').value = { error: '#N/A' };
    ws.getCell('A4').value = 'Student 03';
    ws.getCell('B4').value = 9.399999999999999;
    ws.getCell('C4').value = true;
    ws.getCell('D4').value = null;
    ws.getCell('B6').value = '';
    ws.getCell('A5').value = { formula: 'A1', result: { error: '#REF!' } };
    const expected = [
      ['Name', 'Score', 'When'],
      ['Student 01', '94', '2026-09-03'],
      ['Student 02', '47', ''],
      ['Student 03', '9.4', 'TRUE']
    ];
    assert.deepEqual(importer.rowsFromWorksheet(ws), expected);
    // The same after writing and loading the file.
    const buf = await wb.xlsx.writeBuffer();
    const sheets = await importer.readWorkbook(ExcelJS, buf);
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0].name, 'Grades');
    assert.equal(sheets[0].hidden, false);
    assert.deepEqual(sheets[0].rows, expected);
  });

  test('a formula without a cached result reads as empty; empty and missing worksheets give no rows', () => {
    assert.equal(importer.cellText({ formula: 'A1*2' }), '');
    assert.equal(importer.cellText({ sharedFormula: 'A1', result: 5 }), '5');
    assert.equal(importer.cellText({ text: { richText: [{ text: 'a' }, { text: 'b' }] }, hyperlink: 'x' }), 'ab');
    assert.equal(importer.cellText(NaN), '');
    assert.deepEqual(importer.rowsFromWorksheet(null), []);
    const ws = new ExcelJS.Workbook().addWorksheet('Empty');
    assert.deepEqual(importer.rowsFromWorksheet(ws), []);
  });

  test('readWorkbook rejects a file that is not an .xlsx, with the Save As advice', async () => {
    await assert.rejects(importer.readWorkbook(ExcelJS, new Uint8Array([1, 2, 3, 4]).buffer), /Save As → Excel Workbook \(\.xlsx\)/);
    await assert.rejects(importer.readWorkbook(null, new ArrayBuffer(0)), /ExcelJS/);
  });

  test('rowsFromCsv: BOM, quotes, semicolons, ragged rows padded', () => {
    assert.deepEqual(importer.rowsFromCsv('﻿No;Name\r\n1;"Student, 01"\r\n2\r\n\r\n'), [['No', 'Name'], ['1', 'Student, 01'], ['2', '']]);
  });

  test('fileKind and the .xls advice', () => {
    assert.equal(importer.fileKind('Grades.XLSX'), 'xlsx');
    assert.equal(importer.fileKind('export.csv'), 'csv');
    assert.equal(importer.fileKind('FinalGradeSE6361SortedbyName.xls'), 'xls');
    assert.equal(importer.fileKind('notes.pdf'), 'other');
    assert.equal(importer.XLS_MESSAGE, 'Open it in Excel and use Save As → Excel Workbook (.xlsx), then import that file.');
  });

  test('detectHeaderRow skips title rows and numeric rows', () => {
    assert.equal(importer.detectHeaderRow([['Fall 2026'], ['', ''], ['1', '2', '3'], ['No', 'Last Name', 'First Name'], ['1', 'Student 01', 'Alpha']]), 3);
    assert.equal(importer.detectHeaderRow([['1', '2'], ['3', '4']]), 0);
    assert.equal(importer.detectHeaderRow([]), 0);
    assert.equal(importer.detectHeaderRow([['90%', '85'], ['Name', 'Score']]), 1);
  });
});

// ================================================================ mapping

describe('targets and guessMapping', () => {
  test('targetsFor lists every target with the spec labels', () => {
    const c = model.createCourse('SE6362');
    const t = importer.targetsFor(c);
    const keys = t.map((x) => x.key);
    ['ignore', 'no', 'lastName', 'firstName', 'fullName', 'team', 'status', 'notes', 'raw:a_p1', 'raw:a_paper',
      'weighted:a_p1', 'weighted:a_part', 'late:a_t1', 'finalLetter', 'absent', 'excused', 'absencesTotal'].forEach((k) => assert.ok(keys.includes(k), k));
    assert.ok(!keys.includes('weighted:a_paper'), 'a weight-0 item has no weighted target');
    const label = (k) => t.find((x) => x.key === k).label;
    assert.equal(label('weighted:a_p1'), 'Weighted Project I (converted to raw = value ÷ weight × max)');
    assert.equal(label('absencesTotal'), 'Total absences (stored as unexcused)');
    assert.equal(label('finalLetter'), 'Final letter');
    assert.ok(t.filter((x) => x.score).every((x) => importer.isScoreTarget(x.key)));
    assert.ok(importer.isAttendanceTarget('absencesTotal'));
    assert.ok(!importer.isScoreTarget('finalLetter'));
  });

  test('the previous TA\'s sheet maps exactly', () => {
    for (const template of ['SE4351', 'SE6362']) {
      const c = model.createCourse(template);
      assert.deepEqual(importer.guessMapping(OLD_HEADERS, c), [
        'no', 'lastName', 'firstName', 'raw:a_p1', 'raw:a_p2', 'raw:a_t1', 'raw:a_t2',
        'weighted:a_p1', 'weighted:a_p2', 'weighted:a_t1', 'weighted:a_t2', 'weighted:a_part',
        'ignore', 'finalLetter', 'ignore', 'absencesTotal'
      ]);
    }
  });

  test('other common headers', () => {
    const c = model.createCourse('SE6362');
    const g = (h) => importer.guessMapping([h], c)[0];
    assert.equal(g('Status'), 'status');
    assert.equal(g('Team'), 'team');
    assert.equal(g('Notes'), 'notes');
    assert.equal(g('Name'), 'fullName');
    assert.equal(g('Student'), 'fullName');
    assert.equal(g('Term Paper'), 'raw:a_paper');
    assert.equal(g('Participation'), 'raw:a_part');
    assert.equal(g('Class/Project Participation'), 'raw:a_part');
    assert.equal(g('Class/Project Participation 5%'), 'weighted:a_part');
    assert.equal(g('Project II'), 'raw:a_p2');
    assert.equal(g('project i'), 'raw:a_p1');
    assert.equal(g('Project I 10'), 'weighted:a_p1', 'a trailing number equal to the weight');
    assert.equal(g('Test 1: weeks late'), 'late:a_t1');
    assert.equal(g('No.'), 'no');
    assert.equal(g('#'), 'no');
    assert.equal(g('Student No'), 'no');
    assert.equal(g('No of Absence'), 'absencesTotal');
    assert.equal(g('Excused (allowed)'), 'excused');
    assert.equal(g('Unexcused (not allowed)'), 'absent');
    assert.equal(g('Total absences'), 'absencesTotal');
    assert.equal(g('Absence rate %'), 'ignore');
    assert.equal(g('Suggested Letter (cutoffs)'), 'ignore');
    assert.equal(g('Final Letter'), 'finalLetter');
    assert.equal(g('Rank'), 'ignore');
    assert.equal(g('Total'), 'ignore');
    assert.equal(g('Term Paper 0%'), 'ignore', 'a weight-0 item cannot be converted from weighted points');
    assert.equal(g('Something else'), 'ignore');
  });

  test('"Project I" never matches "Project II", and a plain "Project" item not "Project II"', () => {
    const c = model.createCourse('custom');
    c.assessments = [model.createAssessment({ id: 'a_proj', name: 'Project', weight: 30 }), model.createAssessment({ id: 'a_t', name: 'Test', weight: 70 })];
    const g = (h) => importer.guessMapping([h], c)[0];
    assert.equal(g('Project'), 'raw:a_proj');
    assert.equal(g('Final Project'), 'raw:a_proj');
    assert.equal(g('Project II'), 'ignore');
    assert.equal(g('Project 30%'), 'weighted:a_proj');
  });

  test('the stronger match keeps a target claimed twice ("Final Letter" beats "Letter Grade")', () => {
    const c = model.createCourse('SE4351');
    assert.deepEqual(importer.guessMapping(['Letter Grade', 'Final Letter'], c), ['ignore', 'finalLetter']);
    assert.deepEqual(importer.guessMapping(['Test 1', 'Test 1'], c), ['raw:a_t1', 'ignore']);
    assert.deepEqual(importer.duplicateTargets(['no', 'raw:a_t1', 'ignore', 'raw:a_t1', 'ignore']), [{ key: 'raw:a_t1', columns: [1, 3] }]);
  });
});

// ================================================================ plan and apply

describe('the previous TA\'s sheet (CSV) into a course', () => {
  const ROWS = [
    OLD_HEADERS,
    [1, 'Student 01', 'Alpha', 94, 88, 80.5, 70, 9.4, 17.6, 20.125, 28, 4.5, 79.625, 'C+', '', 2],
    [2, 'Student 02', 'Bravo', 90, 85, '', 70, 9, 17, 0, 28, 0, 54, 'F', '', 0],
    [3, 'Student 03', 'Charlie', 100, 100, 100, 100, 10, 20, 25, 40, 5, 100, 'A+', '', '']
  ];

  test('new students with raw scores, participation from its 5% column, letters and absences', () => {
    const c = model.createCourse('SE4351');
    const { plan, summary } = importRows(c, csvRows(ROWS));
    assert.deepEqual(plan.counts.new, 3);
    assert.equal(plan.counts.skip, 0);
    assert.equal(plan.counts.invalid, 0);
    assert.equal(summary.created, 3);
    assert.ok(plan.notes.some((n) => /"Project I 10%" is ignored: the raw Project I score/.test(n)));
    const s1 = byName(c, 'Student 01', 'Alpha');
    assert.equal(s1.no, 1);
    assert.equal(effValue(c, s1, 'a_p1'), 94);
    assert.equal(effValue(c, s1, 'a_t1'), 80.5);
    assert.equal(effValue(c, s1, 'a_part'), 4.5);
    assert.equal(s1.finalLetter, 'C+');
    assert.deepEqual(c.attendance.totals[s1.id], { absent: 2, excused: 0 });
    const res = calc.computeCourse(c);
    assert.equal(res.byId[s1.id].total, 79.625);
    const s2 = byName(c, 'Student 02', 'Bravo');
    assert.equal(effValue(c, s2, 'a_t1'), null, 'an empty raw cell stays empty');
    assert.equal(res.byId[s2.id].total, 54);
    assert.equal(res.byId[byName(c, 'Student 03', 'Charlie').id].total, 100);
    // Attendance stays per-session unless the switch is chosen; the plan says so.
    assert.equal(c.attendance.mode, 'per-session');
    assert.ok(plan.notes.some((n) => /shown only in totals-only mode/.test(n)));
  });

  test('switchAttendanceToTotals turns on totals-only mode; sessions held is left for the user', () => {
    const c = model.createCourse('SE6362');
    const { summary } = importRows(c, csvRows(ROWS), { switchAttendanceToTotals: true });
    assert.equal(summary.modeSwitched, true);
    assert.equal(c.attendance.mode, 'totals');
    assert.equal(c.attendance.totalsSessionsHeld, 0);
    const sm = attendance.summary(c, byName(c, 'Student 01', 'Alpha').id);
    assert.equal(sm.unexcused, 2);
    assert.equal(sm.totalAbsences, 2);
  });

  test('weighted-only columns are converted back to raw (value ÷ weight × max)', () => {
    const c = model.createCourse('SE4351');
    const rows = csvRows([
      ['Last Name', 'First Name', 'Project I 10%', 'Test 1 25%', 'Test 2 40%', 'Class Participation 5%'],
      ['Student 01', 'Alpha', 9.4, 20.125, 28.4, 4.5],
      ['Student 02', 'Bravo', '8.35', '0', '', '3']
    ]);
    const { plan } = importRows(c, rows);
    assert.deepEqual(plan.mapping || importer.guessMapping(rows[0], c), ['lastName', 'firstName', 'weighted:a_p1', 'weighted:a_t1', 'weighted:a_t2', 'weighted:a_part']);
    const s1 = byName(c, 'Student 01', 'Alpha'), s2 = byName(c, 'Student 02', 'Bravo');
    assert.equal(effValue(c, s1, 'a_p1'), 94);
    assert.equal(effValue(c, s1, 'a_t1'), 80.5);
    assert.equal(effValue(c, s1, 'a_t2'), 71);
    assert.equal(effValue(c, s1, 'a_part'), 4.5);
    assert.equal(effValue(c, s2, 'a_p1'), 83.5);
    assert.equal(effValue(c, s2, 'a_t1'), 0);
    assert.equal(effValue(c, s2, 'a_t2'), null);
  });
});

describe('matching students', () => {
  function course() {
    const c = model.createCourse('SE4351');
    addStudent(c, 'Student 01', 'Alpha');
    addStudent(c, 'Student 02', 'Bravo');
    addStudent(c, 'Student 03', 'Charlie', { no: 30 });
    return c;
  }

  test('odd case and spacing still match by name; nothing new is created', () => {
    const c = course();
    const rows = [['Last Name', 'First Name', 'Test 1'], ['  STUDENT   01 ', 'alpha', '81'], ['student 02', ' BRAVO  ', '72']];
    const { plan } = importRows(c, rows);
    assert.equal(plan.counts.update, 2);
    assert.equal(plan.counts.new, 0);
    assert.equal(c.students.length, 3);
    assert.equal(effValue(c, c.students[0], 'a_t1'), 81);
    assert.equal(effValue(c, c.students[1], 'a_t1'), 72);
    assert.equal(c.students[0].lastName, 'Student 01', 'the stored spelling is kept');
    const item = plan.items[0];
    assert.equal(item.action, 'update');
    assert.equal(item.studentId, c.students[0].id);
    assert.equal(item.name, 'Student 01, Alpha');
    assert.deepEqual(item.changes.map((x) => [x.field, x.oldValue, x.newValue]), [['Test 1', '', '81']]);
  });

  test('a full-name column: "Last, First" and "First Last"', () => {
    const c = course();
    const rows = [['Name', 'Test 2'], ['Student 01, Alpha', '66'], ['Bravo Student 02', '77'], ['Delta Student 04', '88']];
    const { plan } = importRows(c, rows);
    assert.equal(plan.counts.update, 2);
    assert.equal(plan.counts.new, 1);
    assert.equal(effValue(c, c.students[0], 'a_t2'), 66);
    assert.equal(effValue(c, c.students[1], 'a_t2'), 77);
    const added = c.students[3];
    assert.equal(added.lastName, '04');
    assert.equal(added.firstName, 'Delta Student');
    assert.deepEqual(importer.splitFullName('Student 05, Echo'), { lastName: 'Student 05', firstName: 'Echo' });
  });

  test('no match: skipped without createMissing, added with it (No from the file or the next free No)', () => {
    let c = course();
    const rows = [['No', 'Last Name', 'First Name', 'Test 1'], ['7', 'Student 07', 'Golf', '90'], ['', 'Student 08', 'Hotel', '91']];
    let r = importRows(c, rows, { createMissing: false });
    assert.equal(r.plan.counts.skip, 2);
    assert.equal(r.plan.items[0].reason, 'No matching student in this course');
    assert.equal(c.students.length, 3);
    c = course();
    r = importRows(c, rows);
    assert.equal(r.plan.counts.new, 2);
    assert.equal(byName(c, 'Student 07', 'Golf').no, 7);
    assert.equal(byName(c, 'Student 08', 'Hotel').no, 31, 'max No (30) + 1');
    assert.equal(effValue(c, byName(c, 'Student 08', 'Hotel'), 'a_t1'), 91);
  });

  test('match by No; names change only then; rows without a No are skipped', () => {
    const c = course();
    const rows = [['No', 'Last Name', 'First Name', 'Test 1'], ['30', 'Student 03', 'Charles', '55'], ['x', 'Student 09', 'India', '1'], ['', 'Student 10', 'Juliett', '2']];
    const { plan } = importRows(c, rows, { matchBy: 'no', createMissing: false });
    assert.equal(c.students[2].firstName, 'Charles');
    assert.equal(effValue(c, c.students[2], 'a_t1'), 55);
    assert.equal(plan.items[1].reason, 'No "x" is not a whole number');
    assert.equal(plan.items[2].reason, 'No is empty');
  });

  test('duplicates: two rows for one student, an ambiguous name, a repeated header, empty rows', () => {
    const c = course();
    addStudent(c, 'Student 02', 'Bravo'); // a second student with the same name
    const rows = [['Last Name', 'First Name', 'Test 1'], ['Student 01', 'Alpha', '80'], [], ['Last Name', 'First Name', 'Test 1'], ['Student 01', 'Alpha', '81'], ['Student 02', 'Bravo', '70'], ['', '', '5']];
    const { plan } = importRows(c, rows);
    assert.deepEqual(plan.items.map((x) => x.action), ['update', 'skip', 'skip', 'skip', 'skip']);
    assert.equal(plan.items[1].reason, 'Repeated header row');
    assert.equal(plan.items[2].reason, 'Same student as row 2');
    assert.match(plan.items[3].reason, /^2 students match this name/);
    assert.equal(plan.items[4].reason, 'No name');
    assert.equal(effValue(c, c.students[0], 'a_t1'), 80, 'the first row wins');
  });

  test('errors: name columns or the No column must be mapped', () => {
    const c = course();
    const p = importer.plan(c, [['Test 1'], ['80']], 0, ['raw:a_t1'], {});
    assert.equal(p.items.length, 0);
    assert.match(p.errors[0], /Map the name columns/);
    assert.throws(() => importer.apply(c, p), /Map the name columns/);
    const q = importer.plan(c, [['Name', 'Test 1'], ['Student 01, Alpha', '80']], 0, ['fullName', 'raw:a_t1'], { matchBy: 'no' });
    assert.match(q.errors[0], /Map a column to No/);
  });

  test('plan never changes the course', () => {
    const c = sampleCourse('SE4351');
    const before = JSON.stringify(c);
    importer.plan(c, [['Last Name', 'First Name', 'Project I', 'Team', 'Status'], ['Student 01', 'Alpha', '50', 'Team 9', 'withdrawn'], ['Student 99', 'Zulu', '1', 'Team 1', '']], 0,
      ['lastName', 'firstName', 'raw:a_p1', 'team', 'status'], { emptyCells: 'clear' });
    assert.equal(JSON.stringify(c), before);
  });
});

describe('values', () => {
  function course() {
    const c = model.createCourse('SE4351');
    const a = addStudent(c, 'Student 01', 'Alpha', { notes: 'keep me' });
    model.setEntry(c.scores, a.id, 'a_t1', { value: 80 });
    model.setEntry(c.scores, a.id, 'a_t2', { value: 70 });
    addStudent(c, 'Student 02', 'Bravo');
    return c;
  }

  test('status words', () => {
    const c = model.createCourse('SE4351');
    const words = ['withdrawn', 'W', 'Dropped', 'inactive', 'active', '', 'Active', 'on leave'];
    const rows = [['Last Name', 'First Name', 'Status']].concat(words.map((w, i) => ['Student ' + (i + 1), 'X', w]));
    const { plan } = importRows(c, rows);
    assert.deepEqual(c.students.map((s) => s.status), ['withdrawn', 'withdrawn', 'withdrawn', 'withdrawn', 'active', 'active', 'active', 'active']);
    assert.equal(plan.counts.invalid, 1);
    assert.equal(plan.items[7].issues[0].message, 'Use Active or Withdrawn; ignored');
    // An existing student: an empty status keeps it (keep) or makes it active (clear).
    const d = model.createCourse('SE4351');
    addStudent(d, 'Student 01', 'Alpha', { status: 'withdrawn' });
    importRows(d, [['Last Name', 'First Name', 'Status'], ['Student 01', 'Alpha', '']]);
    assert.equal(d.students[0].status, 'withdrawn');
    importRows(d, [['Last Name', 'First Name', 'Status'], ['Student 01', 'Alpha', '']], { emptyCells: 'clear' });
    assert.equal(d.students[0].status, 'active');
  });

  test('empty cells: "keep" leaves scores and notes, "clear" empties them', () => {
    const rows = [['Last Name', 'First Name', 'Test 1', 'Test 2', 'Notes'], ['Student 01', 'Alpha', '', '75', '']];
    let c = course();
    let r = importRows(c, rows);
    assert.equal(effValue(c, c.students[0], 'a_t1'), 80);
    assert.equal(effValue(c, c.students[0], 'a_t2'), 75);
    assert.equal(c.students[0].notes, 'keep me');
    assert.deepEqual(r.plan.items[0].changes.map((x) => x.field), ['Test 2']);
    c = course();
    r = importRows(c, rows, { emptyCells: 'clear' });
    assert.equal(effValue(c, c.students[0], 'a_t1'), null);
    assert.equal(c.students[0].notes, '');
    assert.deepEqual(r.plan.items[0].changes.map((x) => [x.field, x.oldValue, x.newValue]), [['Notes', 'keep me', ''], ['Test 1', '80', ''], ['Test 2', '70', '75']]);
  });

  test('overwrite: false only fills empty scores (and other empty fields)', () => {
    const c = course();
    const rows = [['Last Name', 'First Name', 'Test 1', 'Test 2', 'Project I', 'Notes'], ['Student 01', 'Alpha', '99', '98', '97', 'new note'], ['Student 02', 'Bravo', '60', '61', '62', 'first note']];
    const { plan } = importRows(c, rows, { overwrite: false });
    const [a, b] = c.students;
    assert.equal(effValue(c, a, 'a_t1'), 80);
    assert.equal(effValue(c, a, 'a_t2'), 70);
    assert.equal(effValue(c, a, 'a_p1'), 97, 'was empty: filled');
    assert.equal(a.notes, 'keep me');
    assert.equal(effValue(c, b, 'a_t1'), 60);
    assert.equal(b.notes, 'first note');
    assert.equal(plan.counts.kept, 3);
  });

  test('invalid text: stored as text on free-entry items (counted), refused on list items', () => {
    const c = course();
    const rows = [['Last Name', 'First Name', 'Test 1', 'Participation'], ['Student 02', 'Bravo', 'abs', 'lots']];
    const { plan } = importRows(c, rows);
    assert.equal(plan.counts.invalid, 2);
    assert.equal(effValue(c, c.students[1], 'a_t1'), 't:abs');
    assert.equal(eff(c, c.students[1], 'a_part'), null);
    assert.deepEqual(plan.items[0].issues.map((x) => x.field), ['Test 1', 'Class/Project Participation']);
    assert.match(plan.items[0].issues[1].message, /takes values from its list \(0–5 in steps of 0\.5\); skipped/);
    const ch = plan.items[0].changes.find((x) => x.field === 'Test 1');
    assert.equal(ch.invalid, true);
  });

  test('a participation value not on the drop-down list is imported, counted and highlighted', () => {
    const c = course();
    const { plan } = importRows(c, [['Last Name', 'First Name', 'Participation'], ['Student 02', 'Bravo', '4.2'], ['Student 01', 'Alpha', '4.5']]);
    assert.equal(plan.counts.notOnList, 1);
    assert.equal(plan.items[0].changes[0].notOnList, true);
    assert.equal(effValue(c, c.students[1], 'a_part'), 4.2);
    assert.equal(calc.scoreDetail(c, c.students[1], model.findAssessment(c, 'a_part')).notOnList, true);
    assert.equal(calc.scoreDetail(c, c.students[0], model.findAssessment(c, 'a_part')).notOnList, false);
  });

  test('final letters: matched to the scale ("b+" -> "B+"); letters not in the scale are skipped and reported', () => {
    const c = model.createCourse('SE6362');
    addStudent(c, 'Student 01', 'Alpha');
    addStudent(c, 'Student 02', 'Bravo', { finalLetter: 'B' });
    addStudent(c, 'Student 03', 'Charlie', { finalLetter: 'A' });
    const rows = [['Last Name', 'First Name', 'Letter Grade'], ['Student 01', 'Alpha', 'b+'], ['Student 02', 'Bravo', 'D'], ['Student 03', 'Charlie', '']];
    let r = importRows(c, rows);
    assert.equal(c.students[0].finalLetter, 'B+');
    assert.equal(c.students[1].finalLetter, 'B');
    assert.equal(c.students[2].finalLetter, 'A');
    assert.equal(r.plan.counts.lettersSkipped, 1);
    assert.match(r.plan.items[1].issues[0].message, /^"D" is not a letter of this course's scale \(A, A-, B\+, B, B-, C\+, C, F\); skipped$/);
    r = importRows(c, rows, { emptyCells: 'clear' });
    assert.equal(c.students[2].finalLetter, null);
  });

  test('teams are created by name; a team change moves the student', () => {
    const c = model.createCourse('SE4351');
    const t1 = addTeam(c, 'Team 1');
    addStudent(c, 'Student 01', 'Alpha', { teamId: t1.id });
    const rows = [['Last Name', 'First Name', 'Team'], ['Student 01', 'Alpha', 'team 2'], ['Student 02', 'Bravo', 'TEAM 1'], ['Student 03', 'Charlie', 'team 2']];
    const { plan, summary } = importRows(c, rows);
    assert.equal(summary.teamsCreated, 1);
    assert.deepEqual(c.teams.map((t) => t.name), ['Team 1', 'team 2']);
    assert.equal(c.students[0].teamId, c.teams[1].id);
    assert.equal(c.students[1].teamId, t1.id);
    assert.equal(c.students[2].teamId, c.teams[1].id);
    assert.deepEqual(plan.items[0].changes.map((x) => [x.field, x.oldValue, x.newValue]), [['Team', 'Team 1', 'team 2']]);
  });

  test('weeks late, including "(waived)"', () => {
    const c = course();
    importRows(c, [['Last Name', 'First Name', 'Test 1: weeks late', 'Test 2: weeks late'], ['Student 01', 'Alpha', '2', '1 (waived)']]);
    const a = c.students[0];
    assert.deepEqual(eff(c, a, 'a_t1'), { value: 80, weeksLate: 2 });
    assert.deepEqual(eff(c, a, 'a_t2'), { value: 70, weeksLate: 1, waived: true });
    const res = calc.computeCourse(c);
    assert.equal(res.byId[a.id].items.a_t1.penalty, 20);
    assert.equal(res.byId[a.id].items.a_t2.penalty, 0);
    const { plan } = importRows(c, [['Last Name', 'First Name', 'Test 1: weeks late'], ['Student 01', 'Alpha', 'soon']]);
    assert.equal(plan.counts.invalid, 1);
  });

  test('attendance totals: unexcused and excused columns; a total with excused mapped subtracts them', () => {
    const c = model.createCourse('SE4351');
    addStudent(c, 'Student 01', 'Alpha');
    let { plan } = importRows(c, [['Last Name', 'First Name', 'Excused (allowed)', 'Unexcused (not allowed)', 'Total absences'], ['Student 01', 'Alpha', '2', '3', '5']]);
    assert.ok(plan.notes.some((n) => /"Total absences" is ignored/.test(n)));
    assert.deepEqual(c.attendance.totals[c.students[0].id], { absent: 3, excused: 2 });
    ({ plan } = importRows(c, [['Last Name', 'First Name', 'Excused', 'No of Absence'], ['Student 01', 'Alpha', '1', '6']]));
    assert.deepEqual(c.attendance.totals[c.students[0].id], { absent: 5, excused: 1 });
    ({ plan } = importRows(c, [['Last Name', 'First Name', 'Excused', 'No of Absence'], ['Student 01', 'Alpha', '4', '2'], ['Student 01', 'Alpha', 'x', '']]));
    assert.match(plan.items[0].issues[0].message, /Less than the excused absences \(4\)/);
    assert.deepEqual(c.attendance.totals[c.students[0].id], { absent: 5, excused: 4 });
  });
});

describe('team-graded columns', () => {
  function teamCourse() {
    const c = model.createCourse('SE4351');
    const t1 = addTeam(c, 'Team 1'), t2 = addTeam(c, 'Team 2');
    ['Alpha', 'Bravo', 'Charlie'].forEach((f, i) => addStudent(c, 'Student 0' + (i + 1), f, { teamId: t1.id }));
    ['Delta', 'Echo'].forEach((f, i) => addStudent(c, 'Student 0' + (i + 4), f, { teamId: t2.id }));
    return { c, t1, t2 };
  }

  test('members that agree give one team score and no overrides', () => {
    const { c, t1, t2 } = teamCourse();
    const rows = [['Last Name', 'First Name', 'Project I'], ['Student 01', 'Alpha', '90'], ['Student 02', 'Bravo', '90'], ['Student 03', 'Charlie', '90'], ['Student 04', 'Delta', '85'], ['Student 05', 'Echo', '85']];
    const { plan, summary } = importRows(c, rows);
    assert.equal(plan.counts.overrides, 0);
    assert.equal(summary.overridesCreated, 0);
    assert.equal(model.getEntry(c.teamScores, t1.id, 'a_p1').value, 90);
    assert.equal(model.getEntry(c.teamScores, t2.id, 'a_p1').value, 85);
    assert.deepEqual(Object.keys(c.scores), []);
  });

  test('a member that disagrees becomes an override (counted in the preview)', () => {
    const { c, t1 } = teamCourse();
    const rows = [['Last Name', 'First Name', 'Project I'], ['Student 01', 'Alpha', '90'], ['Student 02', 'Bravo', '80'], ['Student 03', 'Charlie', '90']];
    const { plan, summary } = importRows(c, rows);
    assert.equal(plan.counts.overrides, 1);
    assert.equal(summary.overridesCreated, 1);
    assert.equal(model.getEntry(c.teamScores, t1.id, 'a_p1').value, 90);
    assert.deepEqual(model.getEntry(c.scores, c.students[1].id, 'a_p1'), { value: 80, override: true });
    const ch = plan.items[1].changes.find((x) => x.field === 'Project I');
    assert.equal(ch.override, true);
  });

  test('unchanged members still vote, so one changed member does not move the whole team', () => {
    const { c, t1 } = teamCourse();
    model.setTeamScore(c, t1.id, 'a_p1', { value: 90 });
    const rows = [['Last Name', 'First Name', 'Project I'], ['Student 01', 'Alpha', '90'], ['Student 02', 'Bravo', '90'], ['Student 03', 'Charlie', '70']];
    const { plan } = importRows(c, rows);
    assert.equal(model.getEntry(c.teamScores, t1.id, 'a_p1').value, 90);
    assert.equal(effValue(c, c.students[2], 'a_p1'), 70);
    assert.deepEqual(plan.items.map((x) => x.changes.length), [0, 0, 1]);
    assert.equal(plan.counts.unchanged, 2);
  });

  test('members missing from the file see the new team score (reported as propagated)', () => {
    const { c, t1 } = teamCourse();
    model.setTeamScore(c, t1.id, 'a_p1', { value: 90 });
    const { plan } = importRows(c, [['Last Name', 'First Name', 'Project I'], ['Student 01', 'Alpha', '95']]);
    assert.equal(model.getEntry(c.teamScores, t1.id, 'a_p1').value, 95);
    assert.equal(plan.counts.propagated, 2);
    assert.deepEqual(plan.propagated.map((p) => p.changes.map((x) => [x.field, x.oldValue, x.newValue])), [[['Project I', '90', '95']], [['Project I', '90', '95']]]);
  });
});

describe('finalized courses', () => {
  test('score and participation changes are blocked; student info and final letters are imported', () => {
    const c = model.createCourse('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    model.setEntry(c.scores, a.id, 'a_t1', { value: 80 });
    model.setTeamScore(c, t.id, 'a_p1', { value: 90 });
    model.finalize(c, '2026-12-10T15:00:00.000Z', '');
    const before = calc.computeCourse(c).byId[a.id].total;
    const rows = [['Last Name', 'First Name', 'Test 1', 'Participation', 'Letter Grade', 'Notes', 'Team'],
      ['Student 01', 'Alpha', '85', '5', 'B', 'met in office hours', 'Team 2'],
      ['Student 02', 'Bravo', '70', '4', 'C', '', '']];
    const { plan } = importRows(c, rows);
    assert.ok(plan.finalized);
    assert.ok(plan.notes.some((n) => n.startsWith('Scores are finalized: unlock them in the Grades tab first')));
    const blocked = plan.items[0].changes.filter((x) => x.blocked);
    assert.deepEqual(blocked.map((x) => [x.field, x.oldValue, x.newValue, x.reason]), [
      ['Test 1', '80', '85', 'Scores are finalized: unlock them in the Grades tab first'],
      ['Class/Project Participation', '', '5', 'Scores are finalized: unlock them in the Grades tab first']
    ]);
    assert.equal(plan.counts.blocked, 4);
    assert.equal(effValue(c, a, 'a_t1'), 80);
    assert.equal(a.finalLetter, 'B');
    assert.equal(a.notes, 'met in office hours');
    // The team move keeps the visible scores while finalized, so the total does not change.
    assert.equal(model.findTeam(c, a.teamId).name, 'Team 2');
    assert.equal(effValue(c, a, 'a_p1'), 90);
    assert.equal(calc.computeCourse(c).byId[a.id].total, before);
    const b = byName(c, 'Student 02', 'Bravo');
    assert.equal(b.finalLetter, 'C');
    assert.equal(eff(c, b, 'a_t1'), null);
  });

  test('text that is not a number is blocked too, and the issue says it is not imported', () => {
    const c = model.createCourse('SE4351');
    const a = addStudent(c, 'Student 01', 'Alpha');
    model.setEntry(c.scores, a.id, 'a_t1', { value: 80 });
    model.finalize(c, '2026-12-10T15:00:00.000Z', '');
    const { plan } = importRows(c, [['Last Name', 'First Name', 'Test 1'], ['Student 01', 'Alpha', 'abc']]);
    const it = plan.items[0];
    assert.deepEqual(it.changes.map((x) => [x.field, x.oldValue, x.newValue, !!x.blocked]), [['Test 1', '80', 'abc', true]]);
    assert.deepEqual(it.issues.map((x) => x.message), ['Not a number; not imported because the scores are finalized']);
    assert.equal(plan.counts.blocked, 1);
    assert.equal(plan.counts.changes, 0);
    assert.equal(effValue(c, a, 'a_t1'), 80);
  });
});

// ================================================================ export -> import round trip

describe('round trip: export to .xlsx, read it back, import into an empty copy', () => {
  function prepare(template) {
    const c = sampleCourse(template);
    const act = calc.sortStudents(c, null, 'name', 'asc').filter((s) => s.status === 'active');
    // Late work (individual and team), final letters on a few students, one invalid entry, a note with a comma.
    const t1 = act.find((s) => { const e = model.getEntry(c.scores, s.id, 'a_t1'); return e && typeof e.value === 'number'; });
    model.setEntry(c.scores, t1.id, 'a_t1', model.withLate(model.getEntry(c.scores, t1.id, 'a_t1'), 2, false));
    const t2 = act.find((s) => s !== t1 && model.getEntry(c.scores, s.id, 'a_t2'));
    model.setEntry(c.scores, t2.id, 'a_t2', model.withLate(model.getEntry(c.scores, t2.id, 'a_t2'), 1, true));
    model.setEntry(c.teamScores, c.teams[1].id, 'a_p2', model.withLate(model.getEntry(c.teamScores, c.teams[1].id, 'a_p2'), 1, false));
    const res = calc.computeCourse(c);
    model.setFinalLetter(c, act[0].id, res.byId[act[0].id].letter);
    model.setFinalLetter(c, act[2].id, model.scaleLetters(c)[0]);
    model.setFinalLetter(c, c.students.find((s) => s.status === 'withdrawn').id, 'F');
    act[3].notes = 'Sample note: met, then emailed "twice"';
    return c;
  }

  async function roundTrip(c, keys, options) {
    const res = calc.computeCourse(c);
    const buf = await exporter.toWorkbook(ExcelJS, c, res, keys, { now: '2026-10-01T12:00:00.000Z' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const rows = importer.rowsFromWorksheet(wb.getWorksheet('Grades'));
    const copy = emptyCopy(c);
    const hi = importer.detectHeaderRow(rows);
    assert.equal(hi, 0);
    const mapping = importer.guessMapping(rows[hi], copy);
    const p = importer.plan(copy, rows, hi, mapping, Object.assign({ switchAttendanceToTotals: c.attendance.mode !== 'off' }, options || {}));
    assert.equal(p.counts.new, c.students.length);
    assert.equal(p.counts.skip, 0);
    assert.equal(p.counts.invalid, 0);
    const summary = importer.apply(copy, p);
    assert.equal(summary.created, c.students.length);
    return { copy, res, mapping, rows, plan: p };
  }

  function twin(copy, s) {
    const t = copy.students.find((x) => x.lastName === s.lastName && x.firstName === s.firstName);
    assert.ok(t, 'student ' + s.lastName + ' was imported');
    return t;
  }

  for (const template of ['SE4351', 'SE6362']) {
    test(`${template}, "Everything": raw scores, late work, totals, final letters, status, No, teams, notes and attendance`, async () => {
      const c = prepare(template);
      const { copy, res, mapping } = await roundTrip(c, exporter.builtInPresets(c)[2].columns);
      assert.ok(mapping.includes('finalLetter') && mapping.includes('team') && mapping.includes('late:a_t1'));
      const res2 = calc.computeCourse(copy);
      c.students.forEach((s) => {
        const t = twin(copy, s);
        c.assessments.forEach((a) => {
          assert.equal(model.entryKey(eff(copy, t, a.id)), model.entryKey(eff(c, s, a.id)), `${s.lastName} ${a.id}`);
        });
        assert.equal(res2.byId[t.id].total, res.byId[s.id].total);
        assert.equal(res2.byId[t.id].effectiveLetter, res.byId[s.id].effectiveLetter);
        assert.equal(model.finalLetterOf(t), model.finalLetterOf(s));
        assert.equal(t.status, s.status);
        assert.equal(t.no, s.no);
        assert.equal(t.notes, s.notes);
        assert.equal(copy.teams.find((x) => x.id === t.teamId).name, c.teams.find((x) => x.id === s.teamId).name);
        const a0 = attendance.summary(c, s.id), a1 = attendance.summary(copy, t.id);
        if (a0) {
          assert.equal(a1.mode, 'totals');
          assert.equal(a1.absent, a0.absent);
          assert.equal(a1.excused, a0.excused);
          assert.equal(a1.totalAbsences, a0.totalAbsences);
        } else assert.equal(a1, null);
      });
    });

    test(`${template}, default preset: effective raw scores, status, attendance; Letter Grade becomes the final letter`, async () => {
      const c = prepare(template);
      const { copy, res, mapping } = await roundTrip(c, exporter.builtInPresets(c)[0].columns);
      assert.equal(mapping[exporter.builtInPresets(c)[0].columns.indexOf('letter')], 'finalLetter');
      c.students.forEach((s) => {
        const t = twin(copy, s);
        c.assessments.forEach((a) => {
          assert.equal(effValue(copy, t, a.id), effValue(c, s, a.id), `${s.lastName} ${a.id}`);
        });
        assert.equal(t.status, s.status);
        assert.equal(t.finalLetter, res.byId[s.id].effectiveLetter);
        const a0 = attendance.summary(c, s.id), a1 = attendance.summary(copy, t.id);
        if (a0) assert.deepEqual([a1.absent, a1.excused], [a0.absent, a0.excused]);
      });
    });
  }

  test('a Letter Grade column of formulas (no final letters yet) is not guessed as final letters', async () => {
    const c = sampleCourse('SE6362');
    const res = calc.computeCourse(c);
    const keys = exporter.builtInPresets(c)[0].columns;
    const sheets = await importer.readWorkbook(ExcelJS, await exporter.toWorkbook(ExcelJS, c, res, keys, {}));
    const grades = sheets.find((x) => x.name === 'Grades');
    const letterCol = keys.indexOf('letter');
    assert.deepEqual(grades.formulaColumns, keys.map((k, i) => (/^(weighted:|total$|letter$)/.test(k) ? i : -1)).filter((i) => i >= 0));
    assert.equal(importer.guessMapping(grades.rows[0], c, { formulaColumns: grades.formulaColumns })[letterCol], 'ignore');
    assert.equal(importer.guessMapping(grades.rows[0], c)[letterCol], 'finalLetter');
    // With final letters the column holds plain values again.
    model.setFinalLetter(c, c.students[0].id, 'A');
    const again = await importer.readWorkbook(ExcelJS, await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), keys, {}));
    assert.ok(!again[0].formulaColumns.includes(letterCol));
    assert.equal(importer.guessMapping(again[0].rows[0], c, { formulaColumns: again[0].formulaColumns })[letterCol], 'finalLetter');
  });

  test('the exported CSV imports the same way (totals match)', () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const rows = importer.rowsFromCsv(exporter.toCsv(c, res, exporter.builtInPresets(c)[0].columns));
    const copy = emptyCopy(c);
    importRows(copy, rows);
    const res2 = calc.computeCourse(copy);
    c.students.forEach((s) => assert.equal(res2.byId[twin(copy, s).id].total, res.byId[s.id].total));
  });

  test('importing the same file again changes nothing', async () => {
    const c = prepare('SE4351');
    const { copy, rows, mapping } = await roundTrip(c, exporter.builtInPresets(c)[2].columns);
    const before = JSON.stringify(Object.assign({}, copy, { history: [] }));
    const p = importer.plan(copy, rows, 0, mapping, { switchAttendanceToTotals: true });
    assert.equal(p.counts.update, c.students.length);
    assert.equal(p.counts.changes, 0);
    assert.equal(p.counts.unchanged, c.students.length);
    importer.apply(copy, p);
    assert.equal(JSON.stringify(Object.assign({}, copy, { history: [] })), before);
  });
});
