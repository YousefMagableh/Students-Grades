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

  test('detectHeaderRow (review E2E-2): a two-cell title row and a repeated title are passed over for the recognized headers', () => {
    const c = model.createCourse('SE4351');
    const rows = [['Course:', 'SE 4351'], ['Term:', 'Fall 2025'], OLD_HEADERS, ['1', 'Student 01', 'Alpha', '94']];
    assert.equal(importer.detectHeaderRow(rows), 2);
    assert.equal(importer.detectHeaderRow(rows, c), 2);
    const title = Array(16).fill('SE 6361 Final Grades Fall 2025');
    assert.equal(importer.detectHeaderRow([title, [], OLD_HEADERS]), 2);
    // Headers the app does not know: the first row with 2 different words.
    assert.equal(importer.detectHeaderRow([['Same', 'Same'], ['Alpha', 'Beta'], ['1', '2']]), 1);
    // An assessment name counts once a course is given.
    assert.equal(importer.detectHeaderRow([['Remarks', 'x'], ['Student', 'Term Paper', 'Participation']], model.createCourse('SE6362')), 1);
  });

  test('merged cells (review E2E-2, code-3): a title merged over the header columns is read once, so the header row is found', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getCell('A1').value = 'SE 6361 Final Grades Fall 2025';
    ws.mergeCells('A1:P1');
    ws.getRow(3).values = OLD_HEADERS;
    ws.getRow(4).values = [1, 'Student 01', 'Alpha', 94, 88, 80.5, 70, 9.4, 17.6, 20.125, 28, 4.5, 79.625, 'C+', '', 2];
    ws.getRow(5).values = [2, 'Student 02', 'Bravo', 94, 85, 70, 70, 9.4, 17, 17.5, 28, 5, 76.9, 'C', '', 0];
    ws.mergeCells('D4:D5'); // one team score over both members: each member keeps it
    ws.getCell('E6').value = 'Team 1 and Team 2';
    ws.mergeCells('E6:G6');
    const sheets = await importer.readWorkbook(ExcelJS, await wb.xlsx.writeBuffer());
    const rows = sheets[0].rows;
    assert.deepEqual(rows[0].slice(0, 3), ['SE 6361 Final Grades Fall 2025', '', '']);
    assert.equal(rows[0].filter((x) => x !== '').length, 1);
    assert.deepEqual([rows[3][3], rows[4][3]], ['94', '94']);
    assert.deepEqual(rows[5].slice(4, 7), ['Team 1 and Team 2', '', '']);
    const c = model.createCourse('SE4351');
    const hi = importer.detectHeaderRow(rows);
    assert.equal(hi, 2);
    assert.deepEqual(importer.guessMapping(rows[hi], c).slice(0, 7), ['no', 'lastName', 'firstName', 'raw:a_p1', 'raw:a_p2', 'raw:a_t1', 'raw:a_t2']);
    assert.equal(sheets[0].finalLetterCells, null, 'not a file from Grade Tracker');
    assert.equal(sheets[0].editedLetterCells, null);
  });

  test('reading limits (review code-1): a stray far cell never builds millions of cells', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getRow(1).values = ['No', 'Last Name', 'First Name'];
    for (let r = 2; r < 30; r++) ws.getRow(r).values = [r - 1, 'Student ' + r, 'Alpha'];
    ws.getCell(2, 16384).value = 'x'; // XFD2
    ws.getCell(60000, 1).value = 'y';
    const t0 = Date.now();
    const sheets = await importer.readWorkbook(ExcelJS, await wb.xlsx.writeBuffer());
    const g = sheets[0];
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(g.rows.length, 29, 'rows after the limit are not read');
    assert.equal(g.rows[0].length, 3, 'columns after the limit are not read');
    assert.equal(g.truncatedRows, true);
    assert.equal(g.truncatedColumns, true);
    const small = await importer.readWorkbook(ExcelJS, await wb.xlsx.writeBuffer(), { maxRows: 10, maxCols: 2 });
    assert.equal(small[0].rows.length, 10);
    assert.equal(small[0].rows[0].length, 2);
    assert.deepEqual(importer.DEFAULT_LIMITS, { maxRows: 10000, maxCols: 256 });
    // CSV: one last line of a million commas, and a text of blank lines.
    let text = 'No,Last Name,First Name\r\n';
    for (let i = 1; i < 50; i++) text += i + ',Student ' + i + ',Alpha\r\n';
    text += 'x' + ','.repeat(1000000) + 'y\r\n';
    const csvRead = importer.readCsv(text);
    assert.equal(csvRead.rows.length, 51);
    assert.equal(csvRead.rows[0].length, 3, 'the cells after column 256 are not read, so "y" does not widen the rows');
    assert.equal(csvRead.truncatedColumns, true);
    assert.equal(csvRead.truncatedRows, false);
    const many = importer.readCsv('No,Name\n' + '1,Student 01\n'.repeat(20), { maxRows: 5 });
    assert.equal(many.rows.length, 5);
    assert.equal(many.truncatedRows, true);
    assert.equal(importer.rowsFromCsv('\n'.repeat(3000000)).length, 0);
  });

  test('CSV: the formula-guard apostrophe of an export is removed (review E2E-6, code-5); decimal commas in a ";" file (review E2E-14)', () => {
    const text = csv.stringify([['Last Name', 'First Name', 'Notes'], ['-Hyphen', 'Alpha', '- late add'], ['+Plus', '@Charlie', '=HYPERLINK("x")'],
      ['Student 04', 'Delta', 'met; =1+1 later'], ['Student 05', 'Echo', "'quoted"]], { guardFormulas: true });
    assert.deepEqual(importer.rowsFromCsv(text), [['Last Name', 'First Name', 'Notes'], ['-Hyphen', 'Alpha', '- late add'], ['+Plus', '@Charlie', '=HYPERLINK("x")'],
      ['Student 04', 'Delta', 'met; =1+1 later'], ['Student 05', 'Echo', "'quoted"]]);
    assert.deepEqual(importer.rowsFromCsv('Last Name;First Name;Test 1;Notes\r\nStudent 01;Alpha;92,5;1,5 weeks\r\nStudent 02;Bravo;-3,25 %;x'),
      [['Last Name', 'First Name', 'Test 1', 'Notes'], ['Student 01', 'Alpha', '92.5', '1,5 weeks'], ['Student 02', 'Bravo', '-3.25 %', 'x']]);
    assert.deepEqual(importer.rowsFromCsv('Last Name,First Name,Test 1\r\nStudent 01,Alpha,"92,5"'), [['Last Name', 'First Name', 'Test 1'], ['Student 01', 'Alpha', '92,5']],
      'a comma file keeps "92,5" as it is (reported as not a number)');
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
    // The name columns are written as every view writes them (UX-17).
    assert.deepEqual(['lastName', 'firstName', 'fullName'].map(label), ['Last Name', 'First Name', 'Full Name ("Last, First" or "First Last")']);
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

  test('a weighted column converts with the weight in its header when the course weight changed (review S4-SPEC-2)', () => {
    const c = model.createCourse('SE4351');
    c.assessments.find((a) => a.id === 'a_p1').weight = 5;
    c.assessments.find((a) => a.id === 'a_p2').weight = 25;
    const rows = [['No', 'Last Name', 'First Name', 'Project I 10%', 'Project II 20%', 'Test 1 25%', 'Test 2 (0%)'], ['1', 'Fakeperson', 'Ann', '9.4', '17.6', '20', '5']];
    const mapping = importer.guessMapping(rows[0], c);
    assert.deepEqual(mapping, ['no', 'lastName', 'firstName', 'weighted:a_p1', 'weighted:a_p2', 'weighted:a_t1', 'ignore'], 'a 0% header is not guessed');
    const p = importer.plan(c, rows, 0, mapping, {});
    assert.deepEqual(p.items[0].changes.filter((x) => x.kind === 'score').map((x) => [x.field, x.newValue, !!x.outOfRange]),
      [['Project I', '94', false], ['Project II', '88', false], ['Test 1', '80', false]]);
    assert.ok(p.notes.some((n) => n === 'Column "Project II 20%" was made with a weight of 20%, but Project II weighs 25% in this course: its values are turned back into scores with 20% (value ÷ 20 × 100).'));
    assert.ok(!p.notes.some((n) => /"Test 1 25%" was made/.test(n)));
    // Mapped by hand, a 0% column cannot be converted.
    const q = importer.plan(c, rows, 0, ['no', 'lastName', 'firstName', 'ignore', 'ignore', 'ignore', 'weighted:a_t2'], {});
    assert.ok(q.notes.some((n) => /"Test 2 \(0%\)" is ignored: a weight of 0% cannot be turned back into Test 2 scores/.test(n)));
    assert.equal(importer.weightFromHeader('Test 1 (12.5%)'), 12.5);
    assert.equal(importer.weightFromHeader('Project I 10,5 %'), 10.5);
    assert.equal(importer.weightFromHeader('Final Project I'), null);
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

  test('match by No; names change only then, with updateNames; rows without a No are skipped', () => {
    const c = course();
    const rows = [['No', 'Last Name', 'First Name', 'Test 1'], ['30', 'Student 03', 'Charles', '55'], ['x', 'Student 09', 'India', '1'], ['', 'Student 10', 'Juliett', '2']];
    const { plan } = importRows(c, rows, { matchBy: 'no', createMissing: false, updateNames: true });
    assert.equal(c.students[2].firstName, 'Charles');
    assert.equal(effValue(c, c.students[2], 'a_t1'), 55);
    assert.equal(plan.items[1].reason, 'No "x" is not a whole number');
    assert.equal(plan.items[2].reason, 'No is empty');
  });

  test('match by No (review E2E-4): a row whose name is another student\'s is skipped, not renamed; case and spaces do not count', () => {
    const c = course();
    addStudent(c, 'Student 04', 'Delta');
    // The file numbers its rows in its own order: its row "4" is Student 03, and its "3" is Student 03 in odd case.
    const rows = [['No', 'Last Name', 'First Name', 'Test 1'],
      ['30', '  student 03 ', '  CHARLIE  ', '34'],
      ['4', 'Student 03', 'Charlie', '35'],
      ['12', 'Student 01', 'Alpha', '36']];
    const before = c.students.map((s) => s.lastName + ', ' + s.firstName);
    const { plan } = importRows(c, rows, { matchBy: 'no' });
    assert.deepEqual(plan.items.map((x) => x.action), ['update', 'skip', 'skip']);
    assert.match(plan.items[1].reason, /^No 4 is a student with another name in this course; skipped/);
    assert.match(plan.items[2].reason, /^No 12 is not in this course, but a student with this name is; skipped/);
    assert.deepEqual(plan.items[0].changes.map((x) => [x.field, x.oldValue, x.newValue]), [['Test 1', '', '34']]);
    assert.deepEqual(c.students.map((s) => s.lastName + ', ' + s.firstName), before, 'no student is renamed');
    assert.equal(effValue(c, c.students[2], 'a_t1'), 34);
    assert.equal(effValue(c, c.students[3], 'a_t1'), null, 'Student 04 does not get Student 03\'s score');
    assert.equal(c.students.length, 4, 'no duplicate student is added');
    // An empty name part is filled without updateNames.
    const d = model.createCourse('SE4351');
    addStudent(d, 'Student 05', '', { no: 5 });
    importRows(d, [['No', 'Last Name', 'First Name'], ['5', 'Student 05', 'Echo']], { matchBy: 'no' });
    assert.equal(d.students[0].firstName, 'Echo');
  });

  test('duplicate No (review S4-SPEC-1, E2E-3): an existing student keeps its No; a new student gets the next free one', () => {
    const c = model.createCourse('SE4351');
    addStudent(c, 'Alpha', 'A', { no: 1 });
    addStudent(c, 'Beta', 'B', { no: 2 });
    const rows = [['No', 'Last Name', 'First Name', 'Test 1'], ['1', 'Beta', 'B', '80'], ['2', 'Gamma', 'G', '70'], ['', 'Delta', 'D', '60'], ['5', 'Echo', 'E', '50'], ['5', 'Foxtrot', 'F', '40']];
    const { plan } = importRows(c, rows);
    assert.equal(plan.counts.duplicateNos, 3);
    assert.deepEqual(plan.items[0].issues.map((x) => x.message), ['No 1 is already used by another student in this course; the No is not changed']);
    assert.deepEqual(plan.items[1].issues.map((x) => x.message), ['No 2 is already used by another student in this course; given No 6 instead']);
    assert.deepEqual(plan.items[4].issues.map((x) => x.message), ['No 5 is also given to row 5 of the file; given No 8 instead']);
    assert.ok(!plan.items[0].changes.some((x) => x.field === 'No'), 'the preview does not show a No change');
    assert.deepEqual(c.students.map((s) => s.no + ' ' + s.lastName), ['1 Alpha', '2 Beta', '6 Gamma', '7 Delta', '5 Echo', '8 Foxtrot']);
    // Numbers that are swapped inside the file are fine.
    const d = model.createCourse('SE4351');
    addStudent(d, 'Alpha', 'A', { no: 1 });
    addStudent(d, 'Beta', 'B', { no: 2 });
    const r = importRows(d, [['No', 'Last Name', 'First Name'], ['2', 'Alpha', 'A'], ['1', 'Beta', 'B']]);
    assert.equal(r.plan.counts.duplicateNos, 0);
    assert.deepEqual(d.students.map((s) => s.no + ' ' + s.lastName), ['2 Alpha', '1 Beta']);
  });

  test('duplicate No: the sample course plus the previous TA\'s sheet with other names leaves every No unique', () => {
    const c = sampleCourse('SE4351');
    const rows = [['No', 'Last Name', 'First Name', 'Test 1'], ['1', 'Fakeperson', 'Ann', '80'], ['3', 'Testname', 'Bob', '81'], ['', 'Dummy', 'Cy', '82']];
    const { plan } = importRows(c, rows);
    assert.equal(plan.counts.new, 3);
    assert.equal(plan.counts.duplicateNos, 2);
    const nos = c.students.map((s) => s.no);
    assert.equal(new Set(nos).size, nos.length);
    assert.deepEqual(['Fakeperson', 'Testname', 'Dummy'].map((l) => c.students.find((s) => s.lastName === l).no), [60, 61, 62]);
    // A new student's preview lists the name fields as every view names them (UX-17).
    assert.deepEqual(plan.items[0].changes.filter((x) => x.kind === 'info').map((x) => [x.field, x.newValue]).slice(0, 3),
      [['No', '60'], ['Last Name', 'Fakeperson'], ['First Name', 'Ann']]);
  });

  test('summary rows under the data (review E2E-10) are skipped, not added as students', () => {
    const c = course();
    const rows = [['No', 'Last Name', 'First Name', 'Test 1'], ['1', 'Student 01', 'Alpha', '80'], ['', 'Average', '', '80'], ['', 'Class Average:', '', '80'],
      ['', '', 'Max', '90'], ['', 'Std Dev', '', '3.2'], ['', 'Max', 'Mustermann', '70']];
    const { plan } = importRows(c, rows);
    assert.deepEqual(plan.items.map((x) => x.action), ['update', 'skip', 'skip', 'skip', 'skip', 'new']);
    assert.equal(plan.items[1].reason, 'Summary row ("Average"), not a student');
    assert.equal(plan.items[3].reason, 'Summary row ("Max"), not a student');
    // With a single name column, a name like "Max" is a student.
    const d = course();
    const r = importRows(d, [['Name', 'Test 1'], ['Max', '70'], ['Average', '75']]);
    assert.deepEqual(r.plan.items.map((x) => x.action), ['new', 'skip']);
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
    assert.equal(p.errors[0], 'Map the name columns (Last Name and First Name, or Full Name) to match students by name.');
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

  test('team names that differ only in form ("2", "Team 02", "Group 2") are the existing team (review E2E-7)', () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const rows = [['Last Name', 'First Name', 'Team']].concat(c.students.map((s, i) => {
      const n = model.findTeam(c, s.teamId).name.replace('Team ', '');
      return [s.lastName, s.firstName, i % 3 === 0 ? n : (i % 3 === 1 ? 'Team 0' + n : 'group ' + n)];
    }));
    const before = JSON.stringify(c.teams);
    const { plan } = importRows(c, rows);
    assert.equal(plan.counts.changes, 0);
    assert.equal(plan.counts.teamsCreated, 0);
    assert.equal(JSON.stringify(c.teams), before);
    const res2 = calc.computeCourse(c);
    c.students.forEach((s) => assert.equal(res2.byId[s.id].total, res.byId[s.id].total));
    assert.equal(importer.resolveTeam([{ id: 'a', name: 'Team 2' }, { id: 'b', name: 'Group 2' }], '2'), null, 'two candidates: none');
    assert.equal(importer.resolveTeam([{ id: 'a', name: 'Team B' }], 'b').id, 'a');
  });

  test('moves to new teams: the preview counts the teams created and the team-graded scores that become empty (review E2E-7)', () => {
    const c = sampleCourse('SE4351');
    const act = c.students.filter((s) => s.status === 'active').slice(0, 3);
    const rows = [['Last Name', 'First Name', 'Team']].concat(act.map((s, i) => [s.lastName, s.firstName, 'Brand New ' + (i % 2)]));
    const p = importer.plan(c, rows, 0, importer.guessMapping(rows[0], c), {});
    assert.equal(p.counts.teamsCreated, 2);
    assert.equal(p.counts.scoresEmptied, 6, 'Project I and Project II of 3 students');
    assert.ok(p.items[0].changes.filter((x) => x.emptiedByMove).map((x) => x.field).join() === 'Project I,Project II');
    assert.ok(p.notes.some((n) => n.startsWith('2 new teams are created: "Brand New 0", "Brand New 1".')));
    assert.ok(p.notes.some((n) => n.startsWith('6 team-graded scores become empty')));
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

  test('weeks late (stage 6): typed spellings, a bare "waived", 0 and fractions', () => {
    const late = (text, start) => {
      const c = course();
      const a = c.students[0];
      if (start) model.setEntry(c.scores, a.id, 'a_t1', model.withLate(model.getEntry(c.scores, a.id, 'a_t1'), start.weeks, start.waived));
      const { plan } = importRows(c, [['Last Name', 'First Name', 'Test 1: weeks late'], ['Student 01', 'Alpha', text]]);
      return { e: eff(c, a, 'a_t1'), plan };
    };
    // Spellings a person may type: the weeks, a unit, "late", and the waiver.
    assert.deepEqual(late('1 week').e, { value: 80, weeksLate: 1 });
    assert.deepEqual(late('2 weeks late').e, { value: 80, weeksLate: 2 });
    assert.deepEqual(late('3 wk').e, { value: 80, weeksLate: 3 });
    assert.deepEqual(late('2 waived').e, { value: 80, weeksLate: 2, waived: true });
    assert.deepEqual(late('2 weeks late, penalty waived').e, { value: 80, weeksLate: 2, waived: true });
    assert.deepEqual(late('2.0 (Waived)').e, { value: 80, weeksLate: 2, waived: true });
    // A bare "waived" keeps the stored weeks late and waives the penalty.
    assert.deepEqual(late('waived', { weeks: 2, waived: false }).e, { value: 80, weeksLate: 2, waived: true });
    assert.deepEqual(late('(waived)', { weeks: 1, waived: false }).e, { value: 80, weeksLate: 1, waived: true });
    // ... and is refused without weeks late to keep.
    const none = late('waived');
    assert.deepEqual(none.e, { value: 80 });
    assert.equal(none.plan.counts.invalid, 1);
    assert.match(none.plan.items[0].issues[0].message, /"waived" needs the weeks late/);
    // 0 means on time: the late info is removed (a waiver goes with it).
    assert.deepEqual(late('0', { weeks: 2, waived: true }).e, { value: 80 });
    // Whole weeks only (util.parseCount): fractions, signs and words are refused and change nothing.
    for (const bad of ['1.5', '-1', '+2', 'two', '1e1', '2 days']) {
      const r = late(bad, { weeks: 1, waived: false });
      assert.deepEqual(r.e, { value: 80, weeksLate: 1 }, bad);
      assert.equal(r.plan.counts.invalid, 1, bad);
    }
  });

  test('weeks late of a team-graded item (stage 6): the late info reaches the team score, waived or not', () => {
    const c = model.createCourse('SE4351');
    const t = addTeam(c, 'Team 1');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t.id });
    const b = addStudent(c, 'Student 02', 'Bravo', { teamId: t.id });
    model.setTeamScore(c, t.id, 'a_p1', { value: 90 });
    importRows(c, [['Last Name', 'First Name', 'Project I', 'Project I: weeks late'], ['Student 01', 'Alpha', '90', '1'], ['Student 02', 'Bravo', '90', '1']]);
    assert.deepEqual(model.getEntry(c.teamScores, t.id, 'a_p1'), { value: 90, weeksLate: 1 });
    assert.equal(model.getEntry(c.scores, a.id, 'a_p1'), null, 'no override is created');
    assert.equal(calc.computeCourse(c).byId[b.id].items.a_p1.adjusted, 80);
    importRows(c, [['Last Name', 'First Name', 'Project I', 'Project I: weeks late'], ['Student 01', 'Alpha', '90', '1 (waived)'], ['Student 02', 'Bravo', '90', '1 (waived)']]);
    assert.deepEqual(model.getEntry(c.teamScores, t.id, 'a_p1'), { value: 90, weeksLate: 1, waived: true });
    assert.equal(calc.computeCourse(c).byId[b.id].items.a_p1.adjusted, 90);
  });

  test('weeks late round trip (stage 6): the exported late column, waived or not, imports back to the same late work and totals', () => {
    const c = model.createCourse('SE4351');
    sample.loadInto(c, { lateWork: true });
    // One more late entry with a penalty that reaches a whole team, and an override with its own waived late work.
    model.setTeamScore(c, c.teams[2].id, 'a_p2', model.withLate(model.getEntry(c.teamScores, c.teams[2].id, 'a_p2'), 2, false));
    const res = calc.computeCourse(c);
    const keys = exporter.builtInPresets(c)[0].columns;
    assert.ok(['late:a_p1', 'late:a_p2', 'late:a_t1'].every((k) => keys.includes(k)), keys.join());
    const sh = exporter.buildSheet(c, res, keys);
    const rows = [sh.columns.map((x) => x.label)].concat(sh.rows.map((r) => r.map((cell) => (cell.v === null || cell.v === undefined ? '' : String(cell.v)))));
    const copy = emptyCopy(c);
    importRows(copy, rows);
    const res2 = calc.computeCourse(copy);
    for (const s of c.students) {
      const t = byName(copy, s.lastName, s.firstName);
      for (const aid of ['a_p1', 'a_p2', 'a_t1']) {
        const d1 = res.byId[s.id].items[aid], d2 = res2.byId[t.id].items[aid];
        assert.deepEqual([d2.weeksLate, d2.waived, d2.penalty], [d1.weeksLate, d1.waived, d1.penalty], s.lastName + ' ' + aid);
      }
      assert.equal(res2.byId[t.id].total, res.byId[s.id].total, s.lastName);
    }
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

  test('a total alone ("No of Absence") keeps the excused absences already stored: the total equals the file (review E2E-5)', () => {
    const c = model.createCourse('SE6362');
    const a = addStudent(c, 'Student 01', 'Alpha');
    addStudent(c, 'Student 02', 'Bravo');
    c.attendance.mode = 'totals';
    c.attendance.totals[a.id] = { absent: 1, excused: 2 };
    const { plan } = importRows(c, [['Last Name', 'First Name', 'No of Absence'], ['Student 01', 'Alpha', '4'], ['Student 02', 'Bravo', '3']]);
    assert.deepEqual(plan.items[0].changes.map((x) => [x.field, x.oldValue, x.newValue]), [['Unexcused absences', '1', '2']]);
    assert.deepEqual(c.attendance.totals[a.id], { absent: 2, excused: 2 });
    assert.equal(attendance.summary(c, a.id).totalAbsences, 4);
    assert.deepEqual(c.attendance.totals[c.students[1].id], { absent: 3, excused: 0 });
    // Fewer than the excused ones: reported, nothing changes; an emptied cell ("clear") empties both.
    let r = importRows(c, [['Last Name', 'First Name', 'No of Absence'], ['Student 01', 'Alpha', '1']]);
    assert.equal(r.plan.items[0].issues[0].message, 'Less than the 2 excused absences already stored; ignored (change them in the Attendance tab)');
    assert.equal(r.plan.counts.invalid, 1);
    assert.deepEqual(c.attendance.totals[a.id], { absent: 2, excused: 2 });
    r = importRows(c, [['Last Name', 'First Name', 'No of Absence'], ['Student 01', 'Alpha', '']], { emptyCells: 'clear' });
    assert.deepEqual(c.attendance.totals[a.id], { absent: 0, excused: 0 });
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

  test('a team move keeps the scores as overrides: counted and shown; a new team member\'s blocked score starts from the team score (review E2E-11)', () => {
    const c = model.createCourse('SE4351');
    const t1 = addTeam(c, 'Team 1'), t2 = addTeam(c, 'Team 2');
    const a = addStudent(c, 'Student 01', 'Alpha', { teamId: t1.id });
    addStudent(c, 'Student 02', 'Bravo', { teamId: t2.id });
    model.setTeamScore(c, t1.id, 'a_p1', { value: 90 });
    model.setTeamScore(c, t2.id, 'a_p1', { value: 80 });
    model.finalize(c, '2026-12-10T15:00:00.000Z', '');
    const rows = [['Last Name', 'First Name', 'Team', 'Project I'], ['Student 01', 'Alpha', 'Team 2', ''], ['Student 03', 'Charlie', 'Team 2', '90']];
    const p = importer.plan(c, rows, 0, importer.guessMapping(rows[0], c), {});
    assert.equal(p.counts.overrides, 1);
    assert.deepEqual(p.items[0].changes.map((x) => [x.field, x.oldValue, x.newValue, !!x.override]), [['Team', 'Team 1', 'Team 2', false], ['Project I', '90', '90', true]]);
    const pi = p.items[1].changes.filter((x) => x.field === 'Project I').map((x) => [x.oldValue, x.newValue, !!x.blocked]);
    assert.deepEqual(pi, [['', '80', false], ['80', '90', true]]);
    const summary = importer.apply(c, p);
    assert.equal(summary.overridesCreated, 1);
    assert.equal(calc.resolveEntry(c, a, model.findAssessment(c, 'a_p1')).source, 'override');
    // The same value as the team score: no blocked row.
    const d = model.createCourse('SE4351');
    const u = addTeam(d, 'Team 2');
    model.setTeamScore(d, u.id, 'a_p1', { value: 80 });
    model.finalize(d, '2026-12-10T15:00:00.000Z', '');
    const q = importer.plan(d, [['Last Name', 'First Name', 'Team', 'Project I'], ['Student 03', 'Charlie', 'Team 2', '80']], 0, ['lastName', 'firstName', 'team', 'raw:a_p1'], {});
    assert.deepEqual(q.items[0].changes.filter((x) => x.field === 'Project I').map((x) => [x.oldValue, x.newValue, !!x.blocked]), [['', '80', false]]);
    assert.equal(q.counts.blocked, 0);
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

    test(`${template}, default preset: effective raw scores, status, attendance; Letter Grade letters other than the suggestion become final letters`, async () => {
      const c = prepare(template);
      const keys = exporter.builtInPresets(c)[0].columns;
      const { copy, res, mapping, plan: p } = await roundTrip(c, keys);
      assert.equal(mapping[keys.indexOf('letter')], 'finalLetter');
      const res2 = calc.computeCourse(copy);
      let asSuggestion = 0, asWithdrawn = 0;
      c.students.forEach((s) => {
        const t = twin(copy, s);
        c.assessments.forEach((a) => {
          assert.equal(effValue(copy, t, a.id), effValue(c, s, a.id), `${s.lastName} ${a.id}`);
        });
        assert.equal(t.status, s.status);
        // Review V4R1-7: the default preset carries the weeks-late columns of the late items, so every
        // total comes back (it had none, and the late student's total rose by the lost penalty).
        assert.equal(res2.byId[t.id].total, res.byId[s.id].total, s.lastName + ' total');
        // Review S4-SPEC-3 / E2E-1: the column mixes final letters and suggestions; a letter equal to
        // the suggestion stays a suggestion (withdrawn students too), the others become final letters.
        const r = res.byId[s.id];
        const want = r.finalLetter !== null && r.finalLetter !== r.letter ? r.finalLetter : null;
        // Review E2E-6: a withdrawn student without a final letter is exported as "W", read back as no letter.
        if (!r.active && r.finalLetter === null) asWithdrawn++;
        else if (r.effectiveLetter === r.letter) asSuggestion++;
        assert.equal(model.finalLetterOf(t), want, s.lastName);
        assert.equal(res2.byId[t.id].effectiveLetter, r.effectiveLetter, 'the letter shown is the file\'s');
        const a0 = attendance.summary(c, s.id), a1 = attendance.summary(copy, t.id);
        if (a0) assert.deepEqual([a1.absent, a1.excused], [a0.absent, a0.excused]);
      });
      assert.ok(asSuggestion > 0);
      assert.equal(p.counts.lettersAsSuggestion, asSuggestion);
      // SE 4351 has 2 withdrawn students (one with a final letter), SE 6362 one (with a final letter).
      assert.equal(asWithdrawn, template === 'SE4351' ? 1 : 0);
      assert.equal(p.counts.lettersWithdrawn, asWithdrawn);
      assert.equal(p.counts.lettersSkipped, 0, 'a "W" is not reported as a letter outside the scale');
      assert.equal(p.notes.some((n) => /^Column "Letter Grade": "W" marks a withdrawn student without a letter grade/.test(n)), asWithdrawn === 1, p.notes.join('\n'));
      assert.ok(p.notes.some((n) => /"Letter Grade" looks like a file from Grade Tracker/.test(n)));
      assert.ok(['late:a_p2', 'late:a_t1', 'late:a_t2'].every((k) => mapping[keys.indexOf(k)] === k));
      assert.equal(p.counts.totalsDiffer, 0);
    });

    test(`${template}, default preset through readWorkbook: exactly the letters marked as final become final letters`, async () => {
      const c = prepare(template);
      const keys = exporter.builtInPresets(c)[0].columns;
      const sheets = await importer.readWorkbook(ExcelJS, await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), keys, {}));
      const g = sheets.find((x) => x.name === 'Grades');
      const letterCol = keys.indexOf('letter');
      const manual = c.students.filter((s) => model.finalLetterOf(s) !== null).length;
      const wdW = c.students.filter((s) => s.status === 'withdrawn' && model.finalLetterOf(s) === null).length;
      assert.equal(wdW, template === 'SE4351' ? 1 : 0);
      assert.equal(g.finalLetterCells.length, manual);
      assert.ok(g.finalLetterCells.every((p) => p[1] === letterCol));
      assert.equal(sheets.find((x) => x.name === 'Settings').finalLetterCells.length, 0);
      const copy = emptyCopy(c);
      const mapping = importer.guessMapping(g.rows[0], copy, { formulaColumns: g.formulaColumns });
      const p = importer.plan(copy, g.rows, 0, mapping, { finalLetterCells: g.finalLetterCells, switchAttendanceToTotals: true });
      assert.equal(p.counts.lettersAsSuggestion, c.students.length - manual - wdW);
      assert.equal(p.counts.lettersWithdrawn, wdW);
      assert.ok(!p.items.some((it) => it.issues.some((x) => x.field === 'Final letter')), 'no "W" is reported');
      assert.ok(p.notes.some((n) => /comes from Grade Tracker: only its letters marked "Final letter assigned by the instructor"/.test(n)));
      importer.apply(copy, p);
      c.students.forEach((s) => assert.equal(model.finalLetterOf(twin(copy, s)), model.finalLetterOf(s), s.lastName));
      // Every total comes back (weeks-late columns included, review V4R1-7), so no unmarked letter
      // differs from the suggestion here.
      const res = calc.computeCourse(c), res2 = calc.computeCourse(copy);
      c.students.forEach((s) => assert.equal(res2.byId[twin(copy, s).id].total, res.byId[s.id].total, s.lastName));
      assert.equal(p.counts.totalsDiffer, 0);
      assert.ok(!p.items.some((it) => it.issues.length), JSON.stringify(p.items.map((it) => it.issues)));
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

  test('the exported CSV imports the same way (totals match, late work included: review V4R1-7)', () => {
    for (const template of ['SE4351', 'SE6362']) {
      for (const rounding of ['none', 'hundredth', 'integer']) {
        const c = prepare(template);
        c.settings.rounding = rounding;
        c.settings.curve = 2.5;
        const res = calc.computeCourse(c);
        const rows = importer.rowsFromCsv(exporter.toCsv(c, res, exporter.builtInPresets(c)[0].columns));
        const copy = emptyCopy(c);
        const { plan: p } = importRows(copy, rows);
        assert.equal(p.counts.totalsDiffer, 0);
        const res2 = calc.computeCourse(copy);
        c.students.forEach((s) => {
          const t = twin(copy, s), r = res.byId[s.id];
          assert.equal(res2.byId[t.id].total, r.total, `${template} ${rounding} ${s.lastName}`);
          assert.equal(res2.byId[t.id].effectiveLetter, r.effectiveLetter);
          assert.equal(model.finalLetterOf(t), r.finalLetter !== null && r.finalLetter !== r.letter ? r.finalLetter : null, s.lastName);
        });
      }
    }
  });

  test('a file without the weeks-late column (review V4R1-7): each total that differs is reported, and the file\'s suggestion is not stored as a final letter', () => {
    // A student whose 2 weeks late on Test 1 (−5 total points) change the suggested letter.
    const c = sampleCourse('SE4351');
    let late = null;
    for (const s of c.students) {
      const e = model.getEntry(c.scores, s.id, 'a_t1');
      if (s.status !== 'active' || !e || !(e.value >= 20)) continue;
      const before = calc.studentResult(c, s).letter;
      model.setEntry(c.scores, s.id, 'a_t1', model.withLate(e, 2, false));
      if (calc.studentResult(c, s).letter !== before) { late = s; break; }
      model.setEntry(c.scores, s.id, 'a_t1', e);
    }
    assert.ok(late, 'a student whose letter changes');
    const res = calc.computeCourse(c);
    // Another student has a final letter other than the suggestion: it must still arrive.
    const other = c.students.find((s) => s !== late && s.status === 'active');
    const otherLetter = model.scaleLetters(c).find((l) => l !== res.byId[other.id].letter);
    model.setFinalLetter(c, other.id, otherLetter);
    const res1 = calc.computeCourse(c);
    // A preset saved without the weeks-late columns.
    const keys = exporter.builtInPresets(c)[0].columns.filter((k) => !/^late:/.test(k));
    const rows = importer.rowsFromCsv(exporter.toCsv(c, res1, keys));
    const copy = emptyCopy(c);
    const { plan: p } = importRows(copy, rows);
    assert.equal(p.counts.totalsDiffer, 1);
    const item = p.items.find((it) => it.name === model.studentName(late));
    const res2 = calc.computeCourse(copy);
    const t = twin(copy, late);
    assert.equal(res2.byId[t.id].total, util.fix(res1.byId[late.id].total + 5), 'the file cannot say the work was late');
    assert.deepEqual(item.issues.map((x) => [x.field, x.value]), [['Total', String(res1.byId[late.id].total)]]);
    assert.match(item.issues[0].message, new RegExp('the imported scores give ' + String(res2.byId[t.id].total).replace('.', '\\.') + ' '));
    assert.ok(p.notes.some((n) => /^Column "Total": 1 student's total differs .* weeks-late column/.test(n)), p.notes.join('\n'));
    // The file's letter was the suggestion at the file's total: not a final letter (the letter shown here
    // follows the new total); the real final letter arrives.
    assert.equal(model.finalLetterOf(t), null);
    assert.notEqual(res2.byId[t.id].letter, res1.byId[late.id].letter);
    assert.equal(model.finalLetterOf(twin(copy, other)), otherLetter);
    // The 2 withdrawn students' "W" (review E2E-6) reads as no letter.
    const wdW = c.students.filter((s) => s.status === 'withdrawn').length;
    assert.equal(p.counts.lettersWithdrawn, wdW);
    assert.equal(p.counts.lettersAsSuggestion, c.students.length - 1 - wdW);

    // Another curve here: every total differs, and the letters are still read against the file's totals.
    const curved = emptyCopy(c);
    curved.settings.curve = 3;
    const { plan: p2 } = importRows(curved, rows);
    assert.equal(p2.counts.totalsDiffer, c.students.length);
    assert.equal(p2.counts.lettersAsSuggestion, c.students.length - 1 - wdW);
    c.students.forEach((s) => assert.equal(model.finalLetterOf(twin(curved, s)), s === other ? otherLetter : null));
  });

  test('the file\'s totals are compared up to the decimals the file shows; other rounding modes fit too (review V4R1-7)', () => {
    const row = (no, last, raws, total) => [no, last, 'Oldsheet', ...raws, '', '', '', '', '', total, '', '', ''];
    const rows = [OLD_HEADERS,
      row('1', 'Alpha', ['94', '88', '80', '70'], '75'), // 9.4 + 17.6 + 20 + 28 = 75
      row('2', 'Bravo', ['90', '85', '92.5', '81'], '81.53'), // 81.525, shown with 2 decimals
      row('3', 'Charlie', ['70', '75', '55', '60'], '59.8'), // 59.75, shown with 1 decimal
      row('4', 'Delta', ['50', '50', '50', '50'], '55'), // 47.5: wrong
      row('5', 'Echo', ['60', '60', '60', '60'], ''), // no total: not compared
      row('6', 'Foxtrot', ['80', '80', '80', '80'], 'n/a')]; // not a number: not compared
    for (const rounding of ['none', 'hundredth', 'integer']) {
      const c = model.createCourse('SE4351');
      c.settings.rounding = rounding;
      const { plan: p } = importRows(c, rows);
      assert.equal(p.counts.new, 6);
      assert.equal(p.counts.totalsDiffer, 1, rounding);
      const bad = p.items.filter((it) => it.issues.some((x) => x.field === 'Total'));
      assert.equal(bad.length, 1);
      assert.match(bad[0].name, /Delta/);
      assert.deepEqual(bad[0].issues.map((x) => x.value), ['55']);
    }
    // Without a mapped score column the totals are not compared (nothing here computes them from the file).
    const c = model.createCourse('SE4351');
    const { plan: p } = importRows(c, rows.map((r) => [r[0], r[1], r[2], r[12]]));
    assert.equal(p.counts.totalsDiffer, 0);
    // A "Total" column mapped to a score is a score column, not the file's total.
    const c2 = model.createCourse('SE4351');
    const { plan: p3 } = importRows(c2, [['Last Name', 'First Name', 'Test 1', 'Total'], ['Alpha', 'Oldsheet', '80', '90']], {},
      ['lastName', 'firstName', 'ignore', 'raw:a_t2']);
    assert.equal(p3.counts.totalsDiffer, 0);
  });

  test('"Names, total and letter" into an empty course: letters are read against the file\'s totals, not the empty scores (review V4R1-7)', () => {
    const c = prepare('SE4351');
    const res = calc.computeCourse(c);
    const rows = importer.rowsFromCsv(exporter.toCsv(c, res, exporter.builtInPresets(c)[1].columns));
    const copy = emptyCopy(c);
    const { plan: p } = importRows(copy, rows);
    assert.equal(p.counts.totalsDiffer, 0, 'no score column: nothing to compare');
    c.students.forEach((s) => {
      const r = res.byId[s.id];
      assert.equal(model.finalLetterOf(twin(copy, s)), r.finalLetter !== null && r.finalLetter !== r.letter ? r.finalLetter : null, s.lastName);
    });
  });

  test('the exported CSV imported into the same course changes nothing, not even the final letters (review E2E-1, E2E-6)', () => {
    const c = prepare('SE4351');
    c.students[0].notes = '- late add, moved from section 2';
    c.students[1].lastName = '+Plus';
    const res = calc.computeCourse(c);
    const before = c.students.map((s) => model.finalLetterOf(s));
    for (const keys of [exporter.builtInPresets(c)[0].columns, exporter.builtInPresets(c)[1].columns, ['lastName', 'firstName', 'notes', 'letter', 'status']]) {
      const rows = importer.rowsFromCsv(exporter.toCsv(c, res, keys));
      const p = importer.plan(c, rows, 0, importer.guessMapping(rows[0], c), {});
      assert.equal(p.counts.new, 0);
      assert.equal(p.counts.changes, 0, JSON.stringify(p.items.filter((i) => i.changes.length).map((i) => i.changes)));
      const wdW = c.students.filter((s, i) => s.status === 'withdrawn' && before[i] === null).length;
      assert.equal(p.counts.lettersWithdrawn, wdW, 'review E2E-6: "W" reads as no letter');
      assert.equal(p.counts.lettersAsSuggestion, c.students.length - before.filter((l) => l !== null).length - wdW);
      importer.apply(c, p);
      assert.deepEqual(c.students.map((s) => model.finalLetterOf(s)), before);
    }
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

// ================================================================ letters changed after an export

describe('letters the instructor changes in an exported workbook (review V4R2-1)', () => {
  const activeByName = (c) => calc.sortStudents(c, null, 'name', 'asc').filter((s) => s.status === 'active');

  /** The sheet row (1-based) of a student in an exported Grades sheet. */
  function sheetRow(ws, keys, s) {
    const l = keys.indexOf('lastName') + 1, f = keys.indexOf('firstName') + 1;
    for (let r = 2; r <= ws.rowCount; r++) {
      if (ws.getCell(r, l).value === s.lastName && ws.getCell(r, f).value === s.firstName) return r;
    }
    throw new Error('no row for ' + s.lastName);
  }

  /** Exports the default preset, lets `edit` change the Grades sheet as a spreadsheet user would, and
   * reads the saved file back. */
  async function exportEdited(c, edit) {
    const keys = exporter.builtInPresets(c)[0].columns;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), keys, {}));
    const ws = wb.getWorksheet('Grades');
    const col = keys.indexOf('letter') + 1;
    const at = (s) => ws.getCell(sheetRow(ws, keys, s), col);
    if (edit) edit(at, ws, keys);
    const sheets = await importer.readWorkbook(ExcelJS, await wb.xlsx.writeBuffer());
    const g = sheets.find((x) => x.name === 'Grades');
    return { g, keys, lc: col - 1, rowOf: (s) => sheetRow(ws, keys, s) - 1 };
  }

  function planFor(course, g) {
    const mapping = importer.guessMapping(g.rows[0], course, { formulaColumns: g.formulaColumns });
    return { mapping, plan: importer.plan(course, g.rows, 0, mapping, { finalLetterCells: g.finalLetterCells }) };
  }

  /** The issue of a letter that is neither marked final nor the suggestion at the file's total. */
  const mismatch = (total, fileLetter, here) => 'Not marked as a final letter in this Grade Tracker file; not stored. It does not match the file\'s total (' +
    total + ' gives ' + fileLetter + ' with this course\'s cutoffs): a score or the cutoffs changed after the export, or the letter was typed in. ' +
    'If the instructor chose it, set it in the Grades tab. The suggestion here is ' + here + '.';

  const letterChanges = (p) => p.items.filter((it) => it.changes.length)
    .map((it) => [it.name, it.changes.map((ch) => [ch.field, ch.oldValue, ch.newValue])]);

  test('a withdrawn student\'s "W" (review E2E-6) reads as no letter; a letter typed over it is a final letter; "W" on an active row is reported', async () => {
    const c = sampleCourse('SE4351');
    const wd = c.students.filter((s) => s.status === 'withdrawn');
    assert.equal(wd.length, 2);
    // Untouched: the "W" cells are neither final letters nor typed in, and the column stays a formula column.
    const plain = await exportEdited(c, null);
    assert.deepEqual(plain.g.editedLetterCells, []);
    assert.deepEqual(plain.g.finalLetterCells, []);
    assert.ok(plain.g.formulaColumns.includes(plain.lc));
    wd.forEach((s) => assert.equal(plain.g.rows[plain.rowOf(s)][plain.lc], 'W'));
    // The column mapped by hand: no change, no issue, one note.
    const mapping = importer.guessMapping(plain.g.rows[0], c, { formulaColumns: plain.g.formulaColumns });
    mapping[plain.lc] = 'finalLetter';
    const p0 = importer.plan(c, plain.g.rows, 0, mapping, { finalLetterCells: plain.g.finalLetterCells });
    assert.equal(p0.counts.changes, 0);
    assert.equal(p0.counts.lettersWithdrawn, 2);
    assert.ok(!p0.items.some((it) => it.issues.length), JSON.stringify(p0.items.map((it) => it.issues)));
    assert.ok(p0.notes.includes('Column "Letter Grade": "W" marks 2 withdrawn students without a letter grade, so they are read as empty (no final letter).'), p0.notes.join('\n'));
    // "D" typed over one "W" (its note stays): that one is a final letter.
    const { g, lc, rowOf } = await exportEdited(c, (at) => { at(wd[0]).value = 'D'; });
    assert.deepEqual(g.editedLetterCells, [[rowOf(wd[0]), lc]]);
    const { plan: p } = planFor(c, g);
    assert.deepEqual(letterChanges(p), [[model.studentName(wd[0]), [['Final letter', '', 'D']]]]);
    assert.equal(p.counts.lettersWithdrawn, 1);
    // A CSV (no notes): "W" reads as no letter on a withdrawn row only; on an active row it is reported.
    const keys = exporter.builtInPresets(c)[0].columns;
    const rows = importer.rowsFromCsv(exporter.toCsv(c, calc.computeCourse(c), keys));
    const act = rows.findIndex((r, i) => i > 0 && r[keys.indexOf('status')] === 'Active');
    rows[act][keys.indexOf('letter')] = 'W';
    const q = importer.plan(c, rows, 0, importer.guessMapping(rows[0], c), {});
    assert.equal(q.counts.lettersWithdrawn, 2);
    assert.equal(q.counts.lettersSkipped, 1);
    assert.equal(q.counts.changes, 0);
    const flagged = q.items.filter((it) => it.issues.length);
    assert.deepEqual(flagged.map((it) => it.rowIndex), [act]);
    assert.match(flagged[0].issues[0].message, /^"W" is not a letter of this course's scale/);
  });

  test('no final letters at export (a column of formulas): a letter typed over a formula is a final letter, the formulas stay suggestions', async () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const act = activeByName(c);
    const x = act[3], same = act[5];
    const typed = res.byId[x.id].letter === 'D' ? 'C' : 'D';
    // Untouched, the column is left unmapped (it holds suggestions only).
    const plain = await exportEdited(c, null);
    assert.ok(plain.g.formulaColumns.includes(plain.lc));
    assert.deepEqual(plain.g.editedLetterCells, []);
    assert.deepEqual(plain.g.finalLetterCells, []);
    const { g, lc, rowOf, keys } = await exportEdited(c, (at) => {
      assert.ok(at(x).formula, 'the exported letter is a formula');
      at(x).value = typed.toLowerCase(); // typed in lower case
      at(same).value = res.byId[same.id].letter; // the formula's own letter, typed over it
    });
    const want = [[rowOf(x), lc], [rowOf(same), lc]].sort((a, b) => a[0] - b[0]);
    assert.deepEqual(g.editedLetterCells, want);
    assert.deepEqual(g.finalLetterCells, want);
    assert.ok(!g.formulaColumns.includes(lc), 'the letter column is mapped now');
    assert.ok(g.formulaColumns.includes(keys.indexOf('total')));
    const { mapping, plan: p } = planFor(c, g);
    assert.equal(mapping[lc], 'finalLetter');
    assert.deepEqual(letterChanges(p).sort(), [
      [model.studentName(x), [['Final letter', '', typed]]],
      [model.studentName(same), [['Final letter', '', res.byId[same.id].letter]]]].sort());
    // The withdrawn students' "W" (static, review E2E-6) reads as no letter.
    const wd = c.students.filter((s) => s.status === 'withdrawn').length;
    assert.equal(p.counts.lettersWithdrawn, wd);
    assert.equal(p.counts.lettersAsSuggestion, c.students.length - 2 - wd);
    assert.ok(!p.items.some((it) => it.issues.length), JSON.stringify(p.items.map((it) => it.issues)));
    assert.ok(p.notes.some((n) => /only its letters marked "Final letter assigned by the instructor", or changed in the file after the export, are imported/.test(n)));
    importer.apply(c, p);
    assert.equal(model.finalLetterOf(x), typed);
    assert.equal(model.finalLetterOf(same), res.byId[same.id].letter);
    assert.equal(c.students.filter((s) => model.finalLetterOf(s) !== null).length, 2);
  });

  test('final letters at export (plain letters with notes): a changed suggestion is a final letter; an unchanged one is not, even after a score change or new cutoffs', async () => {
    const c = sampleCourse('SE4351');
    const act = activeByName(c);
    const res0 = calc.computeCourse(c);
    const m = act[0];
    model.setFinalLetter(c, m.id, res0.byId[m.id].letter === 'B' ? 'B-' : 'B');
    const res = calc.computeCourse(c);
    const x = act[2], same = act[4], pasted = act[6];
    const typed = res.byId[x.id].letter === 'D' ? 'C' : 'D';
    const pastedLetter = res.byId[pasted.id].letter === 'C' ? 'C-' : 'C';
    const mLetter = model.finalLetterOf(m) === 'A' ? 'A-' : 'A';
    // A student whose Test 2 score is raised in the spreadsheet, enough to change the suggestion: the
    // spreadsheet recalculates the Total, but the plain Letter Grade keeps the old suggestion.
    const t2 = model.findAssessment(c, 'a_t2');
    const stale = act.slice(7).find((s) => {
      const v = effValue(c, s, 'a_t2');
      return typeof v === 'number' && v <= 80 && calc.letterFor(util.fix(res.byId[s.id].total + 20 / t2.maxScore * t2.weight), c.settings.letterScale) !== res.byId[s.id].letter;
    });
    assert.ok(stale, 'a student whose suggestion changes');
    const newTotal = util.fix(res.byId[stale.id].total + 20 / t2.maxScore * t2.weight);
    const { g, lc, rowOf, keys } = await exportEdited(c, (at, ws, k) => {
      assert.match(String(at(x).note), /^Suggestion from the cutoffs: /);
      at(x).value = typed.toLowerCase();
      at(same).value = res.byId[same.id].letter.toLowerCase(); // the same letter typed again
      at(pasted).value = pastedLetter;
      at(pasted).note = undefined; // pasted from elsewhere: the note is gone
      at(m).value = mLetter; // the instructor changes a final letter
      const r = sheetRow(ws, k, stale);
      ws.getCell(r, k.indexOf('raw:a_t2') + 1).value = effValue(c, stale, 'a_t2') + 20;
      ws.getCell(r, k.indexOf('total') + 1).value = { formula: ws.getCell(r, k.indexOf('total') + 1).formula, result: newTotal };
    });
    assert.deepEqual(g.editedLetterCells, [[rowOf(x), lc], [rowOf(pasted), lc]].sort((a, b) => a[0] - b[0]));
    assert.deepEqual(g.finalLetterCells, [[rowOf(m), lc], [rowOf(x), lc], [rowOf(pasted), lc]].sort((a, b) => a[0] - b[0]));
    assert.equal(g.rows[rowOf(stale)][keys.indexOf('letter')], res.byId[stale.id].letter);

    // Into the course it came from.
    const course = util.clone(c);
    const { mapping, plan: p } = planFor(course, g);
    assert.equal(mapping[lc], 'finalLetter');
    const letters = (it) => it.changes.filter((ch) => ch.field === 'Final letter').map((ch) => [ch.oldValue, ch.newValue]);
    const item = (s) => p.items.find((it) => it.studentId === s.id);
    assert.deepEqual(letters(item(x)), [['', typed]]);
    assert.deepEqual(letters(item(pasted)), [['', pastedLetter]]);
    assert.deepEqual(letters(item(m)), [[model.finalLetterOf(m), mLetter]]);
    assert.deepEqual(letters(item(same)), []);
    assert.deepEqual(letters(item(stale)), [], 'the old suggestion is not a final letter');
    assert.deepEqual(item(stale).changes.map((ch) => ch.field), ['Test 2']);
    assert.equal(p.counts.totalsDiffer, 0);
    // The stale letter is pointed out (it does not match the file's total), and nothing else is.
    assert.deepEqual(p.items.filter((it) => it.issues.length).map((it) => it.studentId), [stale.id]);
    const newLetter = calc.letterFor(newTotal, c.settings.letterScale);
    assert.equal(item(stale).issues[0].message, mismatch(g.rows[rowOf(stale)][keys.indexOf('total')], newLetter, newLetter));
    importer.apply(course, p);
    const after = calc.computeCourse(course);
    assert.equal(course.students.filter((s) => model.finalLetterOf(s) !== null).length, 3);
    assert.equal(after.byId[stale.id].finalLetter, null);
    assert.equal(after.byId[stale.id].letter, calc.letterFor(newTotal, c.settings.letterScale));

    // Cutoffs changed since the export: the file's suggestions still are not stored.
    const moved = util.clone(c);
    moved.settings.letterScale.forEach((row) => { if (row.min > 0) row.min += 1.5; });
    const { plan: q } = planFor(moved, g);
    importer.apply(moved, q);
    assert.deepEqual(moved.students.filter((s) => model.finalLetterOf(s) !== null).map((s) => s.id).sort(), [m.id, x.id, pasted.id].sort());
  });

  test('a letter column pasted as plain values: letters cannot be told apart, so none is stored, and one that is not the file\'s suggestion is pointed out', async () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const x = activeByName(c)[3];
    const typed = res.byId[x.id].letter === 'D' ? 'C' : 'D';
    const { g, lc, rowOf, keys } = await exportEdited(c, (at, ws, k) => {
      const col = k.indexOf('letter') + 1;
      for (let r = 2; r <= ws.rowCount; r++) { // Paste Values (the withdrawn students' static "W" stays, with its note)
        const v = ws.getCell(r, col).value;
        if (v && typeof v === 'object' && 'formula' in v) ws.getCell(r, col).value = v.result;
      }
      at(x).value = typed;
    });
    assert.ok(!g.formulaColumns.includes(lc));
    assert.deepEqual(g.editedLetterCells, [], 'a "W" note does not make the pasted letters look typed in');
    const { plan: p } = planFor(c, g);
    assert.equal(p.counts.changes, 0);
    const wd = c.students.filter((s) => s.status === 'withdrawn').length;
    assert.equal(p.counts.lettersWithdrawn, wd);
    assert.equal(p.counts.lettersAsSuggestion, c.students.length - wd);
    const issues = p.items.filter((it) => it.issues.length);
    assert.equal(issues.length, 1);
    const total = g.rows[rowOf(x)][keys.indexOf('total')];
    assert.equal(issues[0].issues[0].message, mismatch(total, res.byId[x.id].letter, res.byId[x.id].letter));
  });
});

// ================================================================ letters in the other letter columns

describe('letters changed in the other letter columns of an export (review V4R3-1)', () => {
  const activeByName = (c) => calc.sortStudents(c, null, 'name', 'asc').filter((s) => s.status === 'active');

  /** Exports `keys` (default: the "Everything" preset), lets `edit(at)` change cells as a spreadsheet
   * user would (at(student, key) is that student's cell of column key), and reads the file back. */
  async function exportEdited(c, edit, keys) {
    const cols = keys || exporter.builtInPresets(c)[2].columns;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), cols, {}));
    const ws = wb.getWorksheet('Grades');
    const l = cols.indexOf('lastName') + 1, f = cols.indexOf('firstName') + 1;
    const rowOf = (s) => {
      for (let r = 2; r <= ws.rowCount; r++) if (ws.getCell(r, l).value === s.lastName && ws.getCell(r, f).value === s.firstName) return r;
      throw new Error('no row for ' + s.lastName);
    };
    if (edit) edit((s, key) => ws.getCell(rowOf(s), cols.indexOf(key) + 1));
    const g = (await importer.readWorkbook(ExcelJS, await wb.xlsx.writeBuffer())).find((x) => x.name === 'Grades');
    return { g, col: (key) => cols.indexOf(key), rowOf: (s) => rowOf(s) - 1 };
  }

  /** What the Import step passes today: formulaColumns to guessMapping, finalLetterCells to plan. */
  function planFor(course, g, mapping, options) {
    const m = mapping || importer.guessMapping(g.rows[0], course, { formulaColumns: g.formulaColumns });
    return { mapping: m, plan: importer.plan(course, g.rows, 0, m, Object.assign({ finalLetterCells: g.finalLetterCells }, options || {})) };
  }

  const letterChanges = (p) => p.items.filter((it) => it.changes.length)
    .map((it) => [it.name, it.changes.map((ch) => [ch.field, ch.oldValue, ch.newValue])]).sort();
  const issuesOf = (p) => p.items.filter((it) => it.issues.length).map((it) => [it.name, it.issues.map((i) => i.message)]).sort();
  /** A letter of the course's scale that is neither `letter` nor `avoid` (from the lower end). */
  const other = (c, letter, avoid) => model.scaleLetters(c).slice().reverse().find((l) => l !== 'F' && l !== letter && l !== avoid);

  test('no final letters at export: a letter typed into "Letter Grade" or "Suggested Letter (cutoffs)" is a final letter; "Final Letter" wins when it has another one', async () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const [x, y, z, w, v] = activeByName(c);
    const tx = other(c, res.byId[x.id].letter), ty = other(c, res.byId[y.id].letter, tx), tz = other(c, res.byId[z.id].letter);
    const tw = other(c, res.byId[w.id].letter), fw = other(c, res.byId[w.id].letter, tw);
    const { g, col } = await exportEdited(c, (at) => {
      assert.ok(at(x, 'letter').formula, 'the exported letter is a formula');
      assert.ok(at(y, 'suggestedLetter').formula);
      at(x, 'letter').value = tx.toLowerCase();
      at(y, 'suggestedLetter').value = ty;
      at(z, 'letter').value = tz; // typed into both columns: the same letter
      at(z, 'finalLetter').value = tz;
      at(w, 'letter').value = tw; // typed into both columns: two letters
      at(w, 'finalLetter').value = fw;
      at(v, 'letter').value = 'Z'; // not a letter of the scale
    });
    const { mapping, plan: p } = planFor(c, g);
    assert.equal(mapping[col('letter')], 'ignore');
    assert.equal(mapping[col('suggestedLetter')], 'ignore');
    assert.equal(mapping[col('finalLetter')], 'finalLetter');
    const name = (s) => model.studentName(s);
    assert.deepEqual(letterChanges(p), [
      [name(x), [['Final letter', '', tx]]],
      [name(y), [['Final letter', '', ty]]],
      [name(z), [['Final letter', '', tz]]],
      [name(w), [['Final letter', '', fw]]]].sort());
    assert.equal(p.counts.lettersFromOtherColumn, 2);
    assert.equal(p.counts.lettersNotImported, 1);
    assert.equal(p.counts.lettersSkipped, 1);
    assert.deepEqual(issuesOf(p), [
      [name(w), ['Column "Letter Grade" gives ' + tw + ', but final letters are read from column "Final Letter", which gives ' + fw + ': ' + tw +
        ' is not imported. If the instructor chose ' + tw + ', set it in the Grades tab']],
      [name(v), ['Column "Letter Grade": "Z" is not a letter of this course\'s scale (' + model.scaleLetters(c).join(', ') + '); skipped']]].sort());
    assert.ok(p.notes.includes('Column "Letter Grade": 1 letter was changed in the spreadsheet after the export. Final letters are read from column ' +
      '"Final Letter", which is empty for that student, so the changed letter is imported as the final letter.'), JSON.stringify(p.notes));
    assert.ok(p.notes.some((n) => n.indexOf('Column "Suggested Letter (cutoffs)": 1 letter was changed') === 0));
    assert.ok(p.notes.some((n) => n.indexOf('Column "Letter Grade": 1 letter differs from the other letter columns of the file (final letters are read from column "Final Letter"), so it is not imported.') === 0));
    importer.apply(c, p);
    assert.deepEqual([x, y, z, w, v].map((s) => model.finalLetterOf(s)), [tx, ty, tz, fw, null]);
    assert.equal(c.students.filter((s) => model.finalLetterOf(s) !== null).length, 4);

    // The same file again: nothing changes (the file alone decides, not the letters stored now).
    const { plan: again } = planFor(c, g);
    assert.equal(again.counts.changes, 0);
    assert.equal(again.counts.lettersNotImported, 1);
    // Existing final letters are kept when "Replace" is off.
    const d = sampleCourse('SE4351');
    const dx = d.students.find((s) => s.lastName === x.lastName && s.firstName === x.firstName);
    model.setFinalLetter(d, dx.id, other(c, tx));
    const { plan: kept } = planFor(d, g, null, { overwrite: false });
    assert.deepEqual(kept.items.find((it) => it.studentId === dx.id).changes, []);
    assert.equal(kept.counts.lettersFromOtherColumn, 1);
    assert.ok(kept.counts.kept >= 1);
  });

  test('final letters at export: a letter typed over a suggestion in "Letter Grade" is a final letter; one typed over a final letter is pointed out', async () => {
    const c = sampleCourse('SE6362');
    const act = activeByName(c);
    const res0 = calc.computeCourse(c);
    const m = act[4], x = act[1], same = act[2];
    model.setFinalLetter(c, m.id, other(c, res0.byId[m.id].letter));
    const res = calc.computeCourse(c);
    const tx = other(c, res.byId[x.id].letter), tm = other(c, model.finalLetterOf(m), res.byId[m.id].letter);
    const { g, col, rowOf } = await exportEdited(c, (at) => {
      assert.match(String(at(x, 'letter').note), /^Suggestion from the cutoffs: /);
      assert.match(String(at(m, 'letter').note), /^Final letter assigned by the instructor/);
      at(x, 'letter').value = tx;
      at(same, 'letter').value = res.byId[same.id].letter; // the suggestion typed again
      at(m, 'letter').value = tm; // "Final Letter" still has the old one
    });
    assert.deepEqual(g.editedLetterCells, [[rowOf(x), col('letter')]]);
    const { plan: p } = planFor(util.clone(c), g);
    assert.deepEqual(letterChanges(p), [[model.studentName(x), [['Final letter', '', tx]]]]);
    assert.equal(p.counts.lettersFromOtherColumn, 1);
    assert.equal(p.counts.lettersNotImported, 1);
    assert.deepEqual(issuesOf(p), [[model.studentName(m), ['Column "Letter Grade" gives ' + tm + ', but final letters are read from column "Final Letter", which gives ' +
      model.finalLetterOf(m) + ': ' + tm + ' is not imported. If the instructor chose ' + tm + ', set it in the Grades tab']]]);
    // Untouched, the export imports back without a change or an issue (its marked letters agree).
    const { g: plain } = await exportEdited(c, null);
    const { plan: q } = planFor(util.clone(c), plain);
    assert.equal(q.counts.changes, 0);
    assert.deepEqual(issuesOf(q), []);
    assert.equal(q.counts.lettersFromOtherColumn + q.counts.lettersNotImported, 0);
    // Into an empty course the marked letter comes from "Final Letter", and nothing is reported.
    const fresh = emptyCopy(c);
    const { plan: r } = planFor(fresh, plain);
    assert.equal(r.counts.new, c.students.length);
    assert.deepEqual(issuesOf(r), []);
    importer.apply(fresh, r);
    assert.deepEqual(fresh.students.filter((s) => model.finalLetterOf(s) !== null).map((s) => [s.lastName, model.finalLetterOf(s)]),
      [[m.lastName, model.finalLetterOf(m)]]);
  });

  test('no column mapped to Final letter: the changed letters are reported, not imported; mapping the column imports them', async () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const x = activeByName(c)[0];
    const tx = other(c, res.byId[x.id].letter);
    const { g, col } = await exportEdited(c, (at) => { at(x, 'letter').value = tx; });
    const guessed = importer.guessMapping(g.rows[0], c, { formulaColumns: g.formulaColumns });
    const off = guessed.map((k) => (k === 'finalLetter' ? 'ignore' : k));
    const { plan: p } = planFor(c, g, off);
    assert.equal(p.counts.changes, 0);
    assert.equal(p.counts.lettersNotImported, 1);
    assert.deepEqual(issuesOf(p), [[model.studentName(x), ['Column "Letter Grade" gives ' + tx + ' as a final letter (changed in the file after the export, ' +
      'or marked as a final letter), but no column is set to "Final letter"; not imported']]]);
    assert.ok(p.notes.includes('Column "Letter Grade": 1 letter changed in the spreadsheet after the export, or marked as a final letter, is not imported, ' +
      'because no column is set to "Final letter". To import it, set column "Letter Grade" to "Final letter".'), JSON.stringify(p.notes));
    const on = off.slice();
    on[col('letter')] = 'finalLetter';
    const { plan: q } = planFor(c, g, on);
    assert.deepEqual(letterChanges(q), [[model.studentName(x), [['Final letter', '', tx]]]]);
    assert.equal(q.counts.lettersNotImported, 0);
  });

  test('two other letter columns that disagree: neither is imported', async () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const x = activeByName(c)[0];
    const a = other(c, res.byId[x.id].letter), b = other(c, res.byId[x.id].letter, a);
    const { g } = await exportEdited(c, (at) => { at(x, 'letter').value = a; at(x, 'suggestedLetter').value = b; });
    const { plan: p } = planFor(c, g);
    assert.equal(p.counts.changes, 0);
    assert.equal(p.counts.lettersNotImported, 2);
    assert.deepEqual(issuesOf(p), [[model.studentName(x), [
      'Column "Letter Grade" gives ' + a + ', but the file also has ' + b + ' in column "Suggested Letter (cutoffs)": neither is imported. Set the final letter the instructor chose in the Grades tab',
      'Column "Suggested Letter (cutoffs)" gives ' + b + ', but the file also has ' + a + ' in column "Letter Grade": neither is imported. Set the final letter the instructor chose in the Grades tab']]]);
  });

  test('guessMapping with editedLetterCells: a "Suggested Letter (cutoffs)" column with a typed letter is mapped when no other letter column is', async () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const x = activeByName(c)[2];
    const tx = other(c, res.byId[x.id].letter);
    const keys = ['no', 'lastName', 'firstName', 'total', 'letter', 'suggestedLetter', 'status'];
    const { g, col } = await exportEdited(c, (at) => { at(x, 'suggestedLetter').value = tx; }, keys);
    // Without the typed cells, both letter columns (formulas) stay unmapped, and the letter is reported.
    const before = importer.guessMapping(g.rows[0], c, { formulaColumns: g.formulaColumns });
    assert.equal(before[col('letter')], 'ignore');
    assert.equal(before[col('suggestedLetter')], 'ignore');
    assert.equal(planFor(c, g, before).plan.counts.lettersNotImported, 1);
    const mapping = importer.guessMapping(g.rows[0], c, { formulaColumns: g.formulaColumns, editedLetterCells: g.editedLetterCells });
    assert.equal(mapping[col('letter')], 'ignore');
    assert.equal(mapping[col('suggestedLetter')], 'finalLetter');
    const { plan: p } = planFor(c, g, mapping);
    assert.deepEqual(letterChanges(p), [[model.studentName(x), [['Final letter', '', tx]]]]);
    assert.equal(p.counts.lettersNotImported, 0);
    // "Final Letter" and "Letter Grade" still win over it.
    assert.deepEqual(importer.guessMapping(['Letter Grade', 'Suggested Letter (cutoffs)', 'Final Letter'], c, { editedLetterCells: [[1, 0], [1, 1]] }),
      ['ignore', 'ignore', 'finalLetter']);
    assert.deepEqual(importer.guessMapping(['Letter Grade', 'Suggested Letter (cutoffs)'], c, { formulaColumns: [0], editedLetterCells: [[1, 0], [1, 1]] }),
      ['finalLetter', 'ignore']);
    // A CSV (no typed cells known) is unchanged: "Suggested Letter (cutoffs)" is never mapped.
    assert.deepEqual(importer.guessMapping(['Suggested Letter (cutoffs)'], c, {}), ['ignore']);
  });
});
