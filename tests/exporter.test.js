'use strict';
/* Tests for js/core/exporter.js (STAGE 4 section 1 and its addendum; REQUIREMENTS E1-E3).
 * Formula parity is checked with an independent evaluator (tests/helpers/mini-excel.js): every exported
 * Total and letter formula must give exactly the app's total and letter. Fake data only; no file is
 * written to disk (ExcelJS works on in-memory buffers). */
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
const mx = require('./helpers/mini-excel.js');
const zlib = require('node:zlib');

const NOW = '2026-10-01T12:00:00.000Z';

// ---------------------------------------------------------------- helpers

function sampleCourse(template) {
  const c = model.createCourse(template);
  sample.loadInto(c);
  return c;
}

function activeIndividuals(c) {
  return calc.sortStudents(c, null, 'name', 'asc').filter((s) => s.status === 'active');
}

/** Late entries: 1 week on Test 1, 2 weeks on Test 2, 1 week waived on Test 1, a late team score on
 * Project I (every member of that team), and 2 weeks late on the sample's Project I override. */
function addLate(c) {
  const list = activeIndividuals(c);
  const t1 = (s) => model.getEntry(c.scores, s.id, 'a_t1');
  const t2 = (s) => model.getEntry(c.scores, s.id, 'a_t2');
  const withT1 = list.filter((s) => t1(s) && typeof t1(s).value === 'number');
  const withT2 = list.filter((s) => t2(s) && typeof t2(s).value === 'number');
  model.setEntry(c.scores, withT1[0].id, 'a_t1', model.withLate(t1(withT1[0]), 1, false));
  model.setEntry(c.scores, withT2[1].id, 'a_t2', model.withLate(t2(withT2[1]), 2, false));
  model.setEntry(c.scores, withT1[2].id, 'a_t1', model.withLate(t1(withT1[2]), 1, true));
  const team = c.teams[0];
  model.setEntry(c.teamScores, team.id, 'a_p1', model.withLate(model.getEntry(c.teamScores, team.id, 'a_p1'), 1, false));
  const over = c.students.find((s) => { const e = model.getEntry(c.scores, s.id, 'a_p1'); return e && e.override; });
  if (over) model.setEntry(c.scores, over.id, 'a_p1', model.withLate(model.getEntry(c.scores, over.id, 'a_p1'), 2, false));
  return { late1: withT1[0], late2: withT2[1], waived: withT1[2], team, over };
}

/** Final letters on a few students: one equal to the suggestion, one different, one withdrawn. */
function addFinalLetters(c) {
  const res = calc.computeCourse(c);
  const list = activeIndividuals(c);
  const letters = model.scaleLetters(c);
  model.setFinalLetter(c, list[0].id, res.byId[list[0].id].letter);
  const other = letters.find((l) => l !== res.byId[list[1].id].letter);
  model.setFinalLetter(c, list[1].id, other);
  const wd = c.students.find((s) => s.status === 'withdrawn');
  model.setFinalLetter(c, wd.id, letters[letters.length - 1]);
  return { same: list[0], different: list[1], withdrawn: wd };
}

function sheetFromBuild(sh, options) {
  const cells = {};
  sh.columns.forEach((col, ci) => { cells[mx.refName(ci + 1, 1)] = col.label; });
  sh.rows.forEach((row, ri) => row.forEach((cell, ci) => {
    const ref = mx.refName(ci + 1, ri + 2);
    if (cell.f) cells[ref] = { formula: cell.f };
    else cells[ref] = typeof cell.exact === 'number' ? cell.exact : cell.v;
  }));
  return mx.createSheet(cells, options);
}

function sheetFromWorksheet(ws, options) {
  const cells = {};
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      if (v && typeof v === 'object' && typeof v.formula === 'string') cells[cell.address] = { formula: v.formula };
      else if (v && typeof v === 'object' && Array.isArray(v.richText)) cells[cell.address] = v.richText.map((x) => x.text).join('');
      else cells[cell.address] = v;
    });
  });
  return mx.createSheet(cells, options);
}

async function loadWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

/** Reads one file from a .xlsx (zip) buffer through its central directory (no zip library needed). */
function readZipEntry(arrayBuffer, name) {
  const b = Buffer.from(arrayBuffer);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'zip end record');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(p), 0x02014b50);
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const entry = b.toString('utf8', p + 46, p + 46 + nameLen);
    if (entry === name) {
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('No ' + name + ' in the zip');
}

/** Checks every row: Total and the letter columns evaluate to the app's values; weighted cells too.
 * `sheet` may be a function (options) -> sheet: then it is checked with Excel's ROUND and with a
 * naive binary ROUND (as in HyperFormula). */
function assertParity(c, res, sh, sheet, label) {
  if (typeof sheet === 'function') {
    const n = assertParity(c, res, sh, sheet(), label);
    assertParity(c, res, sh, sheet({ naiveRound: true }), label + ' (naive ROUND)');
    return n;
  }
  const col = (key) => sh.columns.findIndex((x) => x.key === key) + 1;
  const tc = col('total'), lc = col('letter'), sc = col('suggestedLetter');
  let checked = 0;
  sh.rowMeta.forEach((meta, ri) => {
    const r = res.byId[meta.studentId];
    const row = ri + 2;
    if (tc) {
      const t = sheet.value(mx.refName(tc, row));
      assert.equal(t, r.total, `${label}: total of row ${row} (${meta.studentId})`);
      checked++;
    }
    if (lc) assert.equal(sheet.value(mx.refName(lc, row)), r.effectiveLetter, `${label}: Letter Grade of row ${row}`);
    if (sc) assert.equal(sheet.value(mx.refName(sc, row)), r.letter, `${label}: suggested letter of row ${row}`);
    c.assessments.forEach((a) => {
      const wc = col('weighted:' + a.id);
      if (!wc) return;
      const w = sheet.value(mx.refName(wc, row));
      assert.equal(util.fix(w), r.items[a.id].weighted, `${label}: weighted ${a.id} of row ${row}`);
    });
  });
  return checked;
}

const DEFAULT = (c) => exporter.builtInPresets(c)[0].columns;
const EVERYTHING = (c) => exporter.builtInPresets(c)[2].columns;

// ================================================================ the evaluator itself

describe('mini-excel helper (independent evaluator)', () => {
  test('ROUND is half away from zero on the 15-digit value, like Excel', () => {
    assert.equal(mx.evaluate('ROUND(81.025,2)'), 81.03);
    assert.equal(mx.evaluate('ROUND(2.675,2)'), 2.68);
    assert.equal(mx.evaluate('ROUND(-2.5,0)'), -3);
    assert.equal(mx.evaluate('ROUND(2.5,0)'), 3);
    assert.equal(mx.evaluate('ROUND(89.99999999999999,10)'), 90);
    assert.equal(mx.evaluate('ROUND(1234.5678,-2)'), 1200);
    assert.equal(mx.evaluate('ROUND(0,2)'), 0);
  });

  test('references, ranges, SUM, MAX, IF, blanks and comparisons', () => {
    const s = mx.createSheet({ A1: 2, B1: 'text', C1: null, D1: 5, E1: { formula: 'SUM(A1:D1)' }, F1: { formula: 'A1*$D$1' } });
    assert.equal(s.value('E1'), 7);
    assert.equal(s.value('F1'), 10);
    assert.equal(mx.evaluate('C1+1', s), 1);
    assert.equal(mx.evaluate('MAX(0,C1-10)/100*10', s), 0);
    assert.equal(mx.evaluate('IF(A1>=2,"yes","no")', s), 'yes');
    assert.equal(mx.evaluate('IF(A1>=3,"A""+",IF(A1>=2,"B","C"))', s), 'B');
    assert.equal(mx.evaluate('IF(-5>=0,"x","F")'), 'F');
    assert.equal(mx.evaluate('1+-2.5'), -1.5);
    assert.throws(() => mx.evaluate('B1+1', s), /#VALUE!/);
    assert.throws(() => mx.evaluate('LOOKUP(1,A1:D1)', s), /Unsupported/);
  });
});

// ================================================================ catalog and presets

describe('columnsFor: the column catalog', () => {
  test('keys and labels, including "Project I 10%" like the old sheet', () => {
    const c = model.createCourse('SE4351');
    const cols = exporter.columnsFor(c);
    const label = (k) => cols.find((x) => x.key === k).label;
    assert.equal(label('no'), 'No');
    assert.equal(label('lastName'), 'Last Name');
    assert.equal(label('firstName'), 'First Name');
    assert.equal(label('team'), 'Team');
    assert.equal(label('status'), 'Status');
    assert.equal(label('notes'), 'Notes');
    assert.equal(label('raw:a_p1'), 'Project I');
    assert.equal(label('weighted:a_p1'), 'Project I 10%');
    assert.equal(label('weighted:a_p2'), 'Project II 20%');
    assert.equal(label('weighted:a_t1'), 'Test 1 25%');
    assert.equal(label('weighted:a_t2'), 'Test 2 40%');
    assert.equal(label('weighted:a_part'), 'Class/Project Participation 5%');
    assert.equal(label('late:a_t1'), 'Test 1: weeks late');
    assert.equal(label('total'), 'Total');
    assert.equal(label('letter'), 'Letter Grade');
    assert.equal(label('suggestedLetter'), 'Suggested Letter (cutoffs)');
    assert.equal(label('finalLetter'), 'Final Letter');
    assert.equal(label('rank'), 'Rank');
    assert.equal(label('percentile'), 'Percentile');
    assert.equal(label('diffAvg'), 'Diff. from average');
    assert.equal(label('incomplete'), 'Missing scores');
    assert.equal(label('excused'), 'Excused (allowed)');
    assert.equal(label('unexcused'), 'Unexcused (not allowed)');
    assert.equal(label('absences'), 'Total absences');
    assert.equal(label('absenceRate'), 'Absence rate %');
    assert.equal(label('unexcusedRate'), 'Unexcused rate %');
    assert.ok(cols.find((x) => x.key === 'late:a_t1').available);
    assert.ok(cols.every((x) => x.available), 'SE4351 is per-session: every column available');
  });

  test('attendance columns are unavailable, with a reason, while attendance is off', () => {
    const c = model.createCourse('SE6362');
    const att = exporter.columnsFor(c).filter((x) => x.group === 'attendance');
    assert.deepEqual(att.map((x) => x.key), ['excused', 'unexcused', 'absences', 'absenceRate', 'unexcusedRate']);
    att.forEach((x) => { assert.equal(x.available, false); assert.equal(x.reason, 'Attendance is off for this course'); });
    assert.equal(exporter.columnsFor(c).find((x) => x.key === 'weighted:a_paper').label, 'Term Paper 0%');
    attendance.setMode(c, 'totals');
    assert.ok(exporter.columnsFor(c).filter((x) => x.group === 'attendance').every((x) => x.available));
  });

  test('a fractional weight is labeled as entered', () => {
    const c = model.createCourse('custom');
    c.assessments[0].weight = 12.5;
    assert.equal(exporter.columnsFor(c).find((x) => x.key === 'weighted:a_p1').label, 'Project I 12.5%');
  });
});

describe('presets', () => {
  test('the default preset has the old-sheet order, three absence columns, then Status', () => {
    const c = model.createCourse('SE4351');
    const p = exporter.builtInPresets(c);
    assert.deepEqual(p.map((x) => x.id), ['builtin:previous', 'builtin:compact', 'builtin:everything']);
    assert.equal(p[0].name, 'Previous sheet layout (default)');
    assert.deepEqual(p[0].columns, [
      'no', 'lastName', 'firstName',
      'raw:a_p1', 'raw:a_p2', 'raw:a_t1', 'raw:a_t2', 'raw:a_part',
      'weighted:a_p1', 'weighted:a_p2', 'weighted:a_t1', 'weighted:a_t2', 'weighted:a_part',
      'total', 'letter', 'excused', 'unexcused', 'absences', 'status'
    ]);
    assert.equal(p[1].name, 'Names, total and letter');
    assert.deepEqual(p[1].columns, ['no', 'lastName', 'firstName', 'team', 'total', 'letter', 'status']);
    assert.equal(p[2].name, 'Everything');
    assert.deepEqual(p[2].columns, exporter.columnsFor(c).map((x) => x.key));
  });

  test('the default preset adds the weeks-late column of each item with late work, so the file gives its totals back (review V4R1-7)', () => {
    const c = sampleCourse('SE4351');
    const base = DEFAULT(c);
    assert.ok(!base.some((k) => /^late:/.test(k)), 'the sample has no late work');
    const s = c.students.find((x) => x.status === 'active' && typeof (model.getEntry(c.scores, x.id, 'a_t1') || {}).value === 'number');
    model.setEntry(c.scores, s.id, 'a_t1', model.withLate(model.getEntry(c.scores, s.id, 'a_t1'), 2, false));
    const w = c.students.find((x) => x !== s && x.status === 'active');
    model.setEntry(c.scores, w.id, 'a_part', model.withLate(model.getEntry(c.scores, w.id, 'a_part') || { value: null }, 1, true));
    const team = c.teams.find((t) => c.students.some((x) => x.teamId === t.id));
    model.setEntry(c.teamScores, team.id, 'a_p2', model.withLate(model.getEntry(c.teamScores, team.id, 'a_p2'), 1, false));
    const keys = DEFAULT(c);
    // In assessment order, right after the weighted columns (the SUM range stays one block).
    assert.deepEqual(keys.slice(13, 17), ['late:a_p2', 'late:a_t1', 'late:a_part', 'total']);
    assert.deepEqual(keys.filter((k) => !/^late:/.test(k)), base);
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, keys);
    const tc = sh.columns.findIndex((x) => x.key === 'total');
    assert.match(sh.rows[0][tc].f, /SUM\(I2:M2\)/);
    const row = sh.rowMeta.findIndex((m) => m.studentId === s.id);
    assert.equal(sh.rows[row][sh.columns.findIndex((x) => x.key === 'late:a_t1')].v, 2);
    assert.equal(sh.rows[sh.rowMeta.findIndex((m) => m.studentId === w.id)][sh.columns.findIndex((x) => x.key === 'late:a_part')].v, '1 (waived)');
    // An individual entry of a team-graded item that the team score hides does not count.
    const c2 = sampleCourse('SE4351');
    const member = c2.students.find((x) => x.teamId);
    model.setEntry(c2.scores, member.id, 'a_p1', { value: 50, weeksLate: 3 });
    assert.ok(!DEFAULT(c2).includes('late:a_p1'));
  });

  test('"Everything" leaves out unavailable columns; user presets follow the built-ins', () => {
    const c = model.createCourse('SE6362');
    const every = exporter.builtInPresets(c)[2].columns;
    assert.ok(!every.includes('excused'));
    assert.ok(every.includes('raw:a_paper'));
    const mine = exporter.makePreset('  Instructor  ', ['no', 'total', 7]);
    assert.match(mine.id, /^xp_/);
    assert.equal(mine.name, 'Instructor');
    assert.deepEqual(mine.columns, ['no', 'total']);
    c.exportPresets.push(mine, { id: 'bad' });
    const all = exporter.allPresets(c);
    assert.equal(all.length, 4);
    assert.equal(all[3].id, mine.id);
    assert.equal(all[3].builtIn, false);
  });

  test('unknown keys are skipped silently; unavailable ones with their reason; repeats once', () => {
    const c = model.createCourse('SE6362');
    const r = exporter.resolveColumns(c, ['no', 'raw:a_gone', 'weighted:a_gone', 'absences', 'no', 'total']);
    assert.deepEqual(r.columns.map((x) => x.key), ['no', 'total']);
    assert.deepEqual(r.skipped.map((x) => [x.key, x.reason]), [
      ['raw:a_gone', 'unknown'], ['weighted:a_gone', 'unknown'], ['absences', 'Attendance is off for this course']
    ]);
    const sh = exporter.buildSheet(c, calc.computeCourse(c), ['no', 'raw:a_gone', 'absences', 'total']);
    assert.deepEqual(sh.columns.map((x) => x.key), ['no', 'total']);
    assert.equal(sh.notes.length, 1);
    assert.match(sh.notes[0], /Attendance is off for this course/);
    assert.ok(!/a_gone/.test(sh.notes.join(' ')), 'unknown keys are not reported');
  });
});

// ================================================================ formula parity (E3)

describe('formula parity: every Total and letter formula gives the app\'s value', () => {
  for (const template of ['SE4351', 'SE6362']) {
    for (const rounding of ['none', 'hundredth', 'integer']) {
      for (const curve of [0, 2.5]) {
        test(`${template}, rounding ${rounding}, curve ${curve}, late entries, with and without final letters`, () => {
          const c = sampleCourse(template);
          c.settings.rounding = rounding;
          c.settings.curve = curve;
          const late = addLate(c);
          const keySets = [DEFAULT(c), EVERYTHING(c), ['lastName', 'firstName', 'raw:a_t2', 'raw:a_t1', 'weighted:a_t1', 'total', 'suggestedLetter', 'letter']];
          let res = calc.computeCourse(c);
          // Sanity: the late entries really change the numbers, and the waived one does not.
          assert.ok(res.byId[late.late1.id].items.a_t1.penalty === 10);
          assert.ok(res.byId[late.late2.id].items.a_t2.penalty === 20);
          assert.equal(res.byId[late.waived.id].items.a_t1.penalty, 0);
          for (const keys of keySets) {
            const sh = exporter.buildSheet(c, res, keys);
            const n = assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), `${template}/${rounding}/${curve}`);
            assert.equal(n, c.students.length);
            // No final letters yet: the Letter Grade column is a formula.
            const lc = sh.columns.findIndex((x) => x.key === 'letter');
            assert.ok(sh.rows.every((row) => typeof row[lc].f === 'string'));
          }
          addFinalLetters(c);
          res = calc.computeCourse(c);
          for (const keys of keySets.concat([EVERYTHING(c).concat(['suggestedLetter'])])) {
            const sh = exporter.buildSheet(c, res, keys);
            assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), `${template}/${rounding}/${curve}/final`);
          }
        });
      }
    }
  }

  for (const template of ['SE4351', 'SE6362']) {
    test(`${template}: the real .xlsx (write, then ExcelJS load) keeps formulas that evaluate to the app's values`, async () => {
      for (const rounding of ['none', 'hundredth', 'integer']) {
        const c = sampleCourse(template);
        c.settings.rounding = rounding;
        c.settings.curve = 2.5;
        addLate(c);
        addFinalLetters(c);
        const res = calc.computeCourse(c);
        const keys = EVERYTHING(c);
        const buf = await exporter.toWorkbook(ExcelJS, c, res, keys, { now: NOW });
        assert.ok(buf instanceof ArrayBuffer);
        const wb = await loadWorkbook(buf);
        const ws = wb.getWorksheet('Grades');
        const sh = exporter.buildSheet(c, res, keys);
        assertParity(c, res, sh, (o) => sheetFromWorksheet(ws, o), `${template}/${rounding}/xlsx`);
        // Formulas and cached results survive the round trip.
        const tc = sh.columns.findIndex((x) => x.key === 'total') + 1;
        const sc = sh.columns.findIndex((x) => x.key === 'suggestedLetter') + 1;
        sh.rowMeta.forEach((meta, ri) => {
          const v = ws.getRow(ri + 2).getCell(tc).value;
          assert.equal(v.formula, sh.rows[ri][tc - 1].f);
          assert.equal(v.result, res.byId[meta.studentId].total);
          const l = ws.getRow(ri + 2).getCell(sc).value;
          assert.equal(l.result, res.byId[meta.studentId].letter);
        });
      }
    });
  }
});

describe('totals exactly at a cutoff', () => {
  function oneStudent(scores, settings) {
    const c = model.createCourse('SE4351');
    Object.assign(c.settings, settings || {});
    const s = model.createStudent({ no: 1, lastName: 'Student 01', firstName: 'Alpha' });
    c.students.push(s);
    Object.keys(scores).forEach((aid) => model.setEntry(c.scores, s.id, aid, { value: scores[aid] }));
    return { c, s };
  }

  function evalRow(c) {
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, EVERYTHING(c).concat(['suggestedLetter']));
    assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), 'cutoff');
    const sheet = sheetFromBuild(sh);
    const col = (k) => sh.columns.findIndex((x) => x.key === k) + 1;
    return { res, sh, total: sheet.value(mx.refName(col('total'), 2)), letter: sheet.value(mx.refName(col('suggestedLetter'), 2)) };
  }

  test('82, 94, 81.6, 94, 5 is exactly 90 (A-) although R/M*W adds up to 89.99999999999999', () => {
    const naive = 82 / 100 * 10 + 94 / 100 * 20 + 81.6 / 100 * 25 + 94 / 100 * 40 + 5 / 5 * 5;
    assert.ok(naive < 90, 'the plain spreadsheet sum falls just below the cutoff');
    for (const rounding of ['none', 'hundredth', 'integer']) {
      const { c } = oneStudent({ a_p1: 82, a_p2: 94, a_t1: 81.6, a_t2: 94, a_part: 5 }, { rounding });
      const r = evalRow(c);
      assert.equal(r.total, 90);
      assert.equal(r.letter, 'A-');
      assert.equal(r.res.byId[c.students[0].id].letter, 'A-');
    }
  });

  test('why the formulas look the way they do (negative controls)', () => {
    // Without the ROUND(…,10), the 82/94/81.6/94/5 student would be a B+ in the spreadsheet.
    const { c } = oneStudent({ a_p1: 82, a_p2: 94, a_t1: 81.6, a_t2: 94, a_part: 5 });
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, DEFAULT(c));
    const sheet = sheetFromBuild(sh);
    const f = sh.rows[0][sh.columns.findIndex((x) => x.key === 'total')].f;
    assert.equal(f, 'ROUND(SUM(I2:M2),10)');
    assert.ok(mx.evaluate('SUM(I2:M2)', sheet) < 90);
    assert.equal(mx.evaluate(exporter.letterFormula(c, 'SUM(I2:M2)'), sheet), 'B+');
    assert.equal(mx.evaluate(exporter.letterFormula(c, '(' + f + ')'), sheet), 'A-');
    // A half cent: ROUND(ROUND(x,10),2) gives 79.72 in an engine whose ROUND works on the binary value;
    // the exported form gives 79.73 everywhere, like the app.
    const naive = mx.createSheet({ A1: 79.72499999999999 }, { naiveRound: true });
    const excel = mx.createSheet({ A1: 79.72499999999999 });
    assert.equal(mx.evaluate('ROUND(ROUND(A1,10),2)', naive), 79.72);
    assert.equal(mx.evaluate('ROUND(ROUND(A1,10),2)', excel), 79.73);
    assert.equal(mx.evaluate('ROUND(ROUND(A1*100,8),0)/100', naive), 79.73);
    assert.equal(mx.evaluate('ROUND(ROUND(A1*100,8),0)/100', excel), 79.73);
    assert.equal(util.roundTo(79.72499999999999, 2), 79.73);
    assert.equal(mx.evaluate('ROUND(ROUND(-A1*100,8),0)/100', naive), -79.73);
  });

  test('rounding decides the letter exactly as in the app (89.995 and 89.5)', () => {
    // 89.995: Test 2 = 89.995 on every item (weights sum to 100): none -> B+, hundredth -> 90 (A-)
    const all = (v) => ({ a_p1: v, a_p2: v, a_t1: v, a_t2: v, a_part: util.fix(v / 20) });
    let r = evalRow(oneStudent(all(89.995), { rounding: 'none' }).c);
    assert.equal(r.total, 89.995); assert.equal(r.letter, 'B+');
    r = evalRow(oneStudent(all(89.995), { rounding: 'hundredth' }).c);
    assert.equal(r.total, 90); assert.equal(r.letter, 'A-');
    r = evalRow(oneStudent(all(89.5), { rounding: 'integer' }).c);
    assert.equal(r.total, 90); assert.equal(r.letter, 'A-');
    r = evalRow(oneStudent(all(89.49), { rounding: 'integer' }).c);
    assert.equal(r.total, 89); assert.equal(r.letter, 'B+');
    // With a curve: 87.5 + 2.5 = 90
    r = evalRow(oneStudent(all(87.5), { rounding: 'none', curve: 2.5 }).c);
    assert.equal(r.total, 90); assert.equal(r.letter, 'A-');
    // Every cutoff of the scale, reached exactly
    for (const row of model.defaultLetterScale('undergraduate')) {
      r = evalRow(oneStudent(all(row.min), {}).c);
      assert.equal(r.total, row.min);
      assert.equal(r.letter, row.letter);
    }
  });

  test('a total below 0 is F, and a negative curve is written as a subtraction', () => {
    const { c } = oneStudent({ a_t1: -40 }, { curve: -2.5 });
    const r = evalRow(c);
    assert.equal(r.total, -12.5);
    assert.equal(r.letter, 'F');
    const f = r.sh.rows[0][r.sh.columns.findIndex((x) => x.key === 'total')].f;
    assert.match(f, /-2\.5,10\)$/);
    assert.ok(!f.includes('+-'));
  });

  test('random sweep: odd max scores and weights, late work, curves and every rounding mode', () => {
    const rng = sample.createRng('exporter-sweep');
    const c = model.createCourse('custom');
    c.assessments = [
      model.createAssessment({ id: 'a_x1', name: 'Quiz 1', maxScore: 30, weight: 12.5 }),
      model.createAssessment({ id: 'a_x2', name: 'Quiz 2', maxScore: 7, weight: 17.5 }),
      model.createAssessment({ id: 'a_x3', name: 'Lab', maxScore: 45, weight: 33, teamGraded: false }),
      model.createAssessment({ id: 'a_x4', name: 'Exam', maxScore: 100, weight: 32 }),
      model.createAssessment({ id: 'a_x5', name: 'Extra', maxScore: 3, weight: 5 })
    ];
    for (let i = 0; i < 300; i++) {
      const s = model.createStudent({ no: i + 1, lastName: 'Student ' + String(i + 1).padStart(3, '0'), firstName: 'Sweep' });
      c.students.push(s);
      c.assessments.forEach((a) => {
        if (rng.next() < 0.05) return; // empty
        const v = util.fix(Math.round(rng.next() * a.maxScore * 10) / 10);
        const e = { value: v };
        if (rng.next() < 0.1) { e.weeksLate = rng.int(1, 3); if (rng.next() < 0.3) e.waived = true; }
        model.setEntry(c.scores, s.id, a.id, e);
      });
    }
    for (const rounding of ['none', 'hundredth', 'integer']) {
      for (const curve of [0, 2.5, 1.37, -3]) {
        c.settings.rounding = rounding;
        c.settings.curve = curve;
        const res = calc.computeCourse(c);
        for (const keys of [EVERYTHING(c), ['no', 'raw:a_x1', 'raw:a_x2', 'weighted:a_x3', 'total', 'letter'], ['no', 'total', 'letter']]) {
          const sh = exporter.buildSheet(c, res, keys);
          assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), `sweep/${rounding}/${curve}`);
        }
      }
    }
  });
});

// ================================================================ formulas as text

describe('formula text', () => {
  test('weighted: R/M*W, or MAX(0,R-P)/M*W when late; waived has no penalty', () => {
    const c = sampleCourse('SE4351');
    const late = addLate(c);
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, DEFAULT(c));
    const ci = (k) => sh.columns.findIndex((x) => x.key === k);
    const rowOf = (s) => sh.rowMeta.findIndex((m) => m.studentId === s.id);
    const L = (k) => exporter.colLetter(ci(k) + 1);
    let r = rowOf(late.late1);
    assert.equal(sh.rows[r][ci('weighted:a_t1')].f, `MAX(0,${L('raw:a_t1')}${r + 2}-10)/100*25`);
    r = rowOf(late.late2);
    assert.equal(sh.rows[r][ci('weighted:a_t2')].f, `MAX(0,${L('raw:a_t2')}${r + 2}-20)/100*40`);
    r = rowOf(late.waived);
    assert.equal(sh.rows[r][ci('weighted:a_t1')].f, `${L('raw:a_t1')}${r + 2}/100*25`);
    assert.match(sh.rows[0][ci('weighted:a_p1')].f, new RegExp('^(MAX\\(0,)?' + L('raw:a_p1') + '2(-\\d+\\))?/100\\*10$'));
    assert.equal(sh.rows[0][ci('weighted:a_part')].f, `${L('raw:a_part')}2/5*5`);
    // Total: SUM over the contiguous weighted cells; letter: nested IF over the scale.
    assert.equal(sh.rows[0][ci('total')].f, `ROUND(SUM(${L('weighted:a_p1')}2:${L('weighted:a_part')}2),10)`);
    assert.equal(sh.rows[0][ci('letter')].f,
      `IF(${L('total')}2>=97,"A+",IF(${L('total')}2>=93,"A",IF(${L('total')}2>=90,"A-",IF(${L('total')}2>=87,"B+",` +
      `IF(${L('total')}2>=83,"B",IF(${L('total')}2>=80,"B-",IF(${L('total')}2>=77,"C+",IF(${L('total')}2>=73,"C",` +
      `IF(${L('total')}2>=70,"C-",IF(${L('total')}2>=67,"D+",IF(${L('total')}2>=63,"D",IF(${L('total')}2>=60,"D-","F"))))))))))))`);
  });

  test('rounding and curve wrappers', () => {
    const c = sampleCourse('SE6362');
    const keys = DEFAULT(c);
    const f = () => {
      const sh = exporter.buildSheet(c, calc.computeCourse(c), keys);
      return sh.rows[0][sh.columns.findIndex((x) => x.key === 'total')].f;
    };
    // SE6362 default preset: the Term Paper (weight 0, last weighted column O) adds nothing, so the
    // range stops at N.
    assert.equal(f(), 'ROUND(SUM(J2:N2),10)');
    c.settings.curve = 2.5;
    assert.equal(f(), 'ROUND(SUM(J2:N2)+2.5,10)');
    c.settings.rounding = 'hundredth';
    assert.equal(f(), 'ROUND(ROUND((SUM(J2:N2)+2.5)*100,8),0)/100');
    c.settings.curve = 0;
    assert.equal(f(), 'ROUND(ROUND(SUM(J2:N2)*100,8),0)/100');
    c.settings.curve = 2.5;
    c.settings.rounding = 'integer';
    c.settings.curve = 0;
    assert.equal(f(), 'ROUND(ROUND(SUM(J2:N2),10),0)');
  });

  test('the graduate scale letter formula; quotes in letters are doubled', () => {
    const c = model.createCourse('SE6362');
    assert.equal(exporter.letterFormula(c, 'T2'),
      'IF(T2>=93,"A",IF(T2>=90,"A-",IF(T2>=87,"B+",IF(T2>=83,"B",IF(T2>=80,"B-",IF(T2>=77,"C+",IF(T2>=70,"C","F")))))))');
    c.settings.letterScale = [{ letter: 'P"', min: 50 }, { letter: 'F', min: 0 }];
    assert.equal(exporter.letterFormula(c, 'B2'), 'IF(B2>=50,"P""","F")');
    assert.equal(mx.evaluate(exporter.letterFormula(c, 'B2'), mx.createSheet({ B2: 50 })), 'P"');
  });

  test('a subset without raw columns falls back to static weighted values; without weighted, raw expressions', () => {
    const c = sampleCourse('SE4351');
    const late = addLate(c);
    const res = calc.computeCourse(c);
    // Weighted without raw: static values, and the Total sums those cells.
    let sh = exporter.buildSheet(c, res, ['lastName', 'firstName', 'weighted:a_p1', 'weighted:a_p2', 'weighted:a_t1', 'weighted:a_t2', 'weighted:a_part', 'total', 'letter']);
    sh.rows.forEach((row, ri) => {
      const r = res.byId[sh.rowMeta[ri].studentId];
      [2, 3, 4, 5, 6].forEach((ci) => { assert.equal(row[ci].f, undefined); });
      assert.equal(row[4].v, r.items.a_t1.weighted);
      assert.equal(row[7].f, `ROUND(SUM(C${ri + 2}:G${ri + 2}),10)`);
    });
    const lr = sh.rowMeta.findIndex((m) => m.studentId === late.late1.id);
    assert.match(sh.rows[lr][4].note, /1 week late, −10 points/);
    assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), 'weighted only');
    // Raw only: the Total spells out each item.
    sh = exporter.buildSheet(c, res, ['lastName', 'raw:a_p1', 'raw:a_p2', 'raw:a_t1', 'raw:a_t2', 'raw:a_part', 'total']);
    const rf = sh.rows[lr][6].f;
    assert.ok(rf.includes(`+MAX(0,D${lr + 2}-10)/100*25+E${lr + 2}/100*40+F${lr + 2}/5*5,10)`), rf);
    assert.match(rf, new RegExp(`^ROUND\\((MAX\\(0,)?B${lr + 2}(-10\\))?/100\\*10\\+(MAX\\(0,)?C${lr + 2}(-\\d+\\))?/100\\*20\\+`));
    assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), 'raw only');
    // Neither: static full-precision terms.
    sh = exporter.buildSheet(c, res, ['lastName', 'raw:a_p1', 'total', 'letter']);
    assert.match(sh.rows[0][2].f, /^ROUND\(B2\/100\*10\+[\d.]+\+[\d.]+\+[\d.]+\+[\d.]+,10\)$/);
    assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), 'mostly static');
    // No Total column: the letter is a static value.
    sh = exporter.buildSheet(c, res, ['lastName', 'letter', 'suggestedLetter']);
    assert.equal(sh.rows[0][1].f, undefined);
    assert.equal(sh.rows[0][2].f, undefined);
    assert.equal(sh.rows[0][1].v, res.byId[sh.rowMeta[0].studentId].letter);
  });

  test('a non-contiguous weighted block adds the cells one by one', () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, ['raw:a_p1', 'weighted:a_p1', 'raw:a_p2', 'weighted:a_p2', 'raw:a_t1', 'weighted:a_t1', 'raw:a_t2', 'weighted:a_t2', 'raw:a_part', 'weighted:a_part', 'total']);
    assert.equal(sh.rows[0][10].f, 'ROUND(B2+D2+F2+H2+J2,10)');
    assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), 'interleaved');
  });
});

// ================================================================ rows, cells and notes

describe('buildSheet rows and cells', () => {
  test('name order with withdrawn students included (blank rank and percentile), or by No', () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const keys = ['no', 'lastName', 'firstName', 'rank', 'percentile', 'diffAvg', 'status'];
    const sh = exporter.buildSheet(c, res, keys);
    assert.equal(sh.rows.length, 59);
    const names = sh.rows.map((r) => r[1].v + '|' + r[2].v);
    const sorted = calc.sortStudents(c, res, 'name', 'asc').map((s) => s.lastName + '|' + s.firstName);
    assert.deepEqual(names, sorted);
    const wd = sh.rows.filter((r) => r[6].v === 'Withdrawn');
    assert.equal(wd.length, 2);
    wd.forEach((r) => {
      assert.equal(r[3].v, null);
      assert.equal(r[4].v, null);
      assert.equal(r[5].v, null);
      assert.equal(r[0].style, 'withdrawn');
    });
    assert.ok(sh.rows.filter((r) => r[6].v === 'Active').every((r) => typeof r[3].v === 'number'));
    const byNo = exporter.buildSheet(c, res, keys, { sort: 'no' });
    assert.deepEqual(byNo.rows.map((r) => r[0].v), c.students.map((s) => s.no).sort((a, b) => a - b));
  });

  test('empty scores are null; invalid text is null with a note; overrides and out-of-range are marked', () => {
    const c = sampleCourse('SE4351');
    const list = activeIndividuals(c);
    model.setEntry(c.scores, list[0].id, 'a_t1', { value: null, text: 'abc' });
    model.setEntry(c.scores, list[1].id, 'a_t2', { value: 120 });
    model.setEntry(c.scores, list[2].id, 'a_part', { value: 4.2 });
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, DEFAULT(c));
    const ci = (k) => sh.columns.findIndex((x) => x.key === k);
    const rowOf = (s) => sh.rows[sh.rowMeta.findIndex((m) => m.studentId === s.id)];
    const inv = rowOf(list[0])[ci('raw:a_t1')];
    assert.equal(inv.v, null);
    assert.equal(inv.note, 'Entered text "abc" is not a number, so it counts as 0');
    assert.equal(inv.style, 'invalid');
    assert.equal(rowOf(list[1])[ci('raw:a_t2')].v, 120);
    assert.equal(rowOf(list[1])[ci('raw:a_t2')].style, 'invalid');
    assert.match(rowOf(list[2])[ci('raw:a_part')].note, /Not one of the list values/);
    const over = c.students.find((s) => { const e = model.getEntry(c.scores, s.id, 'a_p1'); return e && e.override; });
    const oc = rowOf(over)[ci('raw:a_p1')];
    const team = model.getEntry(c.teamScores, over.teamId, 'a_p1').value;
    assert.equal(oc.style, 'override');
    assert.equal(oc.note, `Per-member override (team score ${team}). An unequal split needs the team's written agreement.`);
    // The incomplete sample students have a null raw score.
    const empties = sh.rows.filter((r) => [ci('raw:a_t1'), ci('raw:a_t2'), ci('raw:a_part')].some((i) => r[i].v === null));
    assert.ok(empties.length >= 1);
    assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), 'invalid');
  });

  test('an empty or invalid late score keeps its penalty in the formula, so a score typed in the file later loses it too (review PARITY-1)', () => {
    const c = sampleCourse('SE4351');
    const list = activeIndividuals(c);
    const a = list[0], b = list[1];
    model.setEntry(c.scores, a.id, 'a_t1', { value: null, weeksLate: 2 });
    model.setEntry(c.scores, b.id, 'a_t1', { value: null, text: 'late?', weeksLate: 1 });
    const res = calc.computeCourse(c);
    const keys = ['lastName', 'raw:a_t1', 'weighted:a_t1', 'late:a_t1', 'total'];
    const sh = exporter.buildSheet(c, res, keys);
    const ri = (s) => sh.rowMeta.findIndex((m) => m.studentId === s.id);
    const ra = sh.rows[ri(a)], rb = sh.rows[ri(b)];
    assert.equal(ra[2].f, `MAX(0,B${ri(a) + 2}-20)/100*25`);
    assert.equal(rb[2].f, `MAX(0,B${ri(b) + 2}-10)/100*25`);
    assert.equal(ra[1].note, '2 weeks late, −20 points');
    assert.equal(ra[3].note, '−20 points');
    assert.match(rb[1].note, /1 week late, −10 points/);
    assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), 'empty late');
    // The instructor types 80 into the empty cell: the file gives what the app gives for 80.
    const cells = {};
    sh.rows.forEach((row, r) => row.forEach((cell, ci) => { cells[mx.refName(ci + 1, r + 2)] = cell.f ? { formula: cell.f } : cell.v; }));
    cells['B' + (ri(a) + 2)] = 80;
    const typed = model.entryFromInput(80, model.getEntry(c.scores, a.id, 'a_t1'), 100);
    model.setEntry(c.scores, a.id, 'a_t1', typed);
    const after = calc.computeCourse(c).byId[a.id];
    const sheet = mx.createSheet(cells);
    assert.equal(sheet.value('C' + (ri(a) + 2)), after.items.a_t1.weighted);
    assert.equal(after.items.a_t1.weighted, 15);
  });

  test('a Total with fixed numbers says which items they are (review PARITY-3)', () => {
    const c = sampleCourse('SE4351');
    c.settings.curve = 2.5;
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, ['lastName', 'raw:a_t1', 'weighted:a_t2', 'total']);
    const tn = sh.columns[3].note;
    assert.match(tn, /Project I, Project II, Class\/Project Participation are not in this file, so their weighted points are written into the formula as fixed numbers/);
    const r = res.byId[sh.rowMeta[0].studentId];
    assert.equal(sh.rows[0][3].note, `Fixed numbers in this formula: Project I ${util.fix(r.items.a_p1.weighted)}, Project II ${util.fix(r.items.a_p2.weighted)}, ` +
      `Class/Project Participation ${util.fix(r.items.a_part.weighted)}; curve +2.5.`);
    // The default layout has none.
    const d = exporter.buildSheet(c, res, DEFAULT(c));
    assert.ok(!/fixed numbers/.test(d.columns.find((x) => x.key === 'total').note));
    assert.equal(d.rows[0][d.columns.findIndex((x) => x.key === 'total')].note, undefined);
  });

  test('late cells: notes on the raw cell and the weeks-late column', () => {
    const c = sampleCourse('SE4351');
    const late = addLate(c);
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, ['lastName', 'raw:a_t1', 'raw:a_t2', 'late:a_t1', 'late:a_t2', 'raw:a_p1', 'late:a_p1']);
    const rowOf = (s) => sh.rows[sh.rowMeta.findIndex((m) => m.studentId === s.id)];
    assert.equal(rowOf(late.late1)[1].note, '1 week late, −10 points');
    assert.equal(rowOf(late.late1)[3].v, 1);
    assert.equal(rowOf(late.late2)[2].note, '2 weeks late, −20 points');
    assert.equal(rowOf(late.late2)[4].v, 2);
    assert.equal(rowOf(late.waived)[1].note, '1 week late, penalty waived');
    assert.equal(rowOf(late.waived)[3].v, '1 (waived)');
    const member = c.students.find((s) => s.teamId === late.team.id && s.id !== (late.over && late.over.id));
    assert.equal(rowOf(member)[5].note, '1 week late, −10 points');
    assert.equal(rowOf(member)[6].v, 1);
    assert.equal(rowOf(activeIndividuals(c).find((s) => s.teamId !== late.team.id && s !== late.late1 && s !== late.waived))[3].v, null);
  });

  test('stage 6: the sample\'s late work (lateWork) in the default preset: penalty formula, waived without one, notes and weeks', () => {
    for (const template of ['SE4351', 'SE6362']) {
      const c = model.createCourse(template);
      sample.loadInto(c, { lateWork: true });
      // Plus participation (max 5) 1 week late: P = 10 × 5 / 100 = 0.5, scaled to its max.
      const p = activeIndividuals(c).find((s) => model.getEntry(c.scores, s.id, 'a_part'));
      model.setEntry(c.scores, p.id, 'a_part', model.withLate(model.getEntry(c.scores, p.id, 'a_part'), 1, false));
      const res = calc.computeCourse(c);
      const keys = DEFAULT(c);
      // The weeks-late columns follow the weighted block, so the Total stays one SUM range.
      assert.deepEqual(keys.filter((k) => /^late:/.test(k)), ['late:a_p1', 'late:a_t1', 'late:a_part']);
      assert.equal(keys.indexOf('late:a_p1'), keys.indexOf('weighted:' + c.assessments[c.assessments.length - 1].id) + 1);
      const sh = exporter.buildSheet(c, res, keys);
      const ci = (k) => sh.columns.findIndex((x) => x.key === k);
      const L = (k) => exporter.colLetter(ci(k) + 1);
      let nT1 = 0, nP1 = 0;
      sh.rowMeta.forEach((m, ri) => {
        const row = sh.rows[ri], r = res.byId[m.studentId], n = ri + 2;
        const t1 = r.items.a_t1, p1 = r.items.a_p1, part = r.items.a_part;
        if (t1.weeksLate) {
          nT1++;
          // Not waived: the penalty comes off the raw cell before weighting.
          assert.equal(row[ci('weighted:a_t1')].f, `MAX(0,${L('raw:a_t1')}${n}-10)/100*25`);
          assert.equal(row[ci('raw:a_t1')].note, '1 week late, −10 points');
          assert.equal(row[ci('late:a_t1')].v, 1);
          assert.equal(row[ci('late:a_t1')].note, '−10 points');
        } else {
          assert.equal(row[ci('weighted:a_t1')].f, `${L('raw:a_t1')}${n}/100*25`);
          assert.equal(row[ci('late:a_t1')].v, null);
        }
        if (p1.weeksLate) {
          nP1++;
          // Waived (pre-approved): no penalty in the formula, "1 (waived)" in the weeks-late column.
          assert.equal(p1.waived, true);
          assert.equal(row[ci('weighted:a_p1')].f, `${L('raw:a_p1')}${n}/100*10`);
          assert.equal(row[ci('raw:a_p1')].note, '1 week late, penalty waived');
          assert.equal(row[ci('late:a_p1')].v, '1 (waived)');
          assert.equal(row[ci('late:a_p1')].note, 'Penalty waived');
        }
        if (part.weeksLate) {
          assert.equal(row[ci('weighted:a_part')].f, `MAX(0,${L('raw:a_part')}${n}-0.5)/5*5`);
          assert.equal(row[ci('raw:a_part')].note, '1 week late, −0.5 points');
        }
      });
      assert.equal(nT1, 1, template);
      assert.ok(nP1 >= 3, template + ': every member of the waived team');
      assert.match(sh.columns[ci('late:a_t1')].note, /"2 \(waived\)" for pre-approved late work/);
      // The spreadsheet's own arithmetic gives the app's weighted points, totals and letters.
      assertParity(c, res, sh, (o) => sheetFromBuild(sh, o), template + ' sample late');
    }
  });

  test('without a Total column, Letter Grade holds plain suggestions, each with its letter in a note (review V4R2-1)', () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, ['lastName', 'firstName', 'letter']);
    sh.rows.forEach((row, ri) => {
      const r = res.byId[sh.rowMeta[ri].studentId];
      assert.equal(row[2].f, undefined);
      assert.equal(row[2].v, r.letter);
      assert.equal(row[2].note, exporter.SUGGESTED_LETTER_NOTE + r.letter + '\nNo final letter assigned yet.');
    });
    // With the Total column the letter is a formula, without a note.
    const f = exporter.buildSheet(c, res, ['lastName', 'firstName', 'total', 'letter']);
    f.rows.forEach((row) => { assert.ok(row[3].f.startsWith('IF(')); assert.equal(row[3].note, undefined); });
  });

  test('final letters: Letter Grade is the effective letter (static) with notes; Suggested stays a formula', () => {
    const c = sampleCourse('SE4351');
    const fl = addFinalLetters(c);
    const res = calc.computeCourse(c);
    const keys = ['lastName', 'firstName', 'total', 'letter', 'suggestedLetter', 'finalLetter'];
    const sh = exporter.buildSheet(c, res, keys);
    sh.rows.forEach((row, ri) => {
      const r = res.byId[sh.rowMeta[ri].studentId];
      assert.equal(row[3].f, undefined);
      assert.equal(row[3].v, r.effectiveLetter);
      // Review V4R2-1: a suggestion carries its letter in a note, so a letter typed over it in the
      // spreadsheet is recognized on import.
      assert.equal(row[3].note, r.letterSource === 'manual' ? 'Final letter assigned by the instructor'
        : 'Suggestion from the cutoffs: ' + r.letter + '\nNo final letter assigned yet.');
      assert.ok(row[4].f.startsWith('IF('));
      assert.equal(row[5].v, r.finalLetter === null ? '' : r.finalLetter);
      assert.equal(row[5].f, undefined);
    });
    const diff = sh.rows[sh.rowMeta.findIndex((m) => m.studentId === fl.different.id)];
    assert.notEqual(diff[3].v, res.byId[fl.different.id].letter);
    assert.match(sh.columns[3].note, /^Final letters assigned by the instructor/);
    assert.match(sh.notes.join(' '), /final letters/);
  });

  test('attendance columns come from GT.attendance.summary', () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const sh = exporter.buildSheet(c, res, ['lastName', 'firstName', 'excused', 'unexcused', 'absences', 'absenceRate', 'unexcusedRate']);
    let excusedSeen = 0;
    sh.rowMeta.forEach((m, ri) => {
      const sm = attendance.summary(c, m.studentId);
      assert.deepEqual(sh.rows[ri].slice(2).map((x) => x.v), [sm.excused, sm.unexcused, sm.totalAbsences, sm.absenceRate, sm.unexcusedRate]);
      if (sm.excused) excusedSeen++;
    });
    assert.ok(excusedSeen > 0);
  });

  test('widths stay within 5..40 (names at least 14); header notes; tints per assessment', () => {
    const c = sampleCourse('SE4351');
    c.students[0].notes = 'x'.repeat(200);
    c.settings.curve = 2.5;
    c.settings.rounding = 'hundredth';
    const sh = exporter.buildSheet(c, calc.computeCourse(c), EVERYTHING(c));
    sh.columns.forEach((col) => {
      assert.ok(col.width >= 5 && col.width <= 40, col.key + ' width ' + col.width);
      if (col.key === 'lastName' || col.key === 'firstName') assert.ok(col.width >= 14);
    });
    assert.equal(sh.columns.find((x) => x.key === 'notes').width, 40);
    assert.equal(sh.columns.find((x) => x.key === 'no').width, 5);
    const w = sh.columns.find((x) => x.key === 'weighted:a_p1');
    assert.match(w.note, /^= raw ÷ max × weight/);
    assert.match(sh.columns.find((x) => x.key === 'total').note, /^= sum of weighted \+ curve \(2\.5\), rounding: nearest 0\.01/);
    const ln = sh.columns.find((x) => x.key === 'letter').note;
    assert.match(ln, /A\+ ≥ 97, A ≥ 93/);
    assert.match(ln, /F below 60/);
    assert.match(ln, /PLACEHOLDER: not confirmed by the instructor/);
    const tints = ['a_p1', 'a_p2', 'a_t1', 'a_t2', 'a_part'].map((id) => sh.columns.find((x) => x.key === 'raw:' + id).tint);
    assert.deepEqual(tints, ['FFE2EFDA', 'FFFCE4D6', 'FFDDEBF7', 'FFF8DCEF', 'FFE9E1F5']);
    assert.equal(sh.columns.find((x) => x.key === 'weighted:a_t1').tint, 'FFDDEBF7');
    assert.equal(sh.columns.find((x) => x.key === 'total').tint, null);
    c.placeholders.letterScale = { confirmed: true, confirmedAt: NOW };
    const ln2 = exporter.buildSheet(c, calc.computeCourse(c), ['total', 'letter']).columns[1].note;
    assert.ok(!/PLACEHOLDER/.test(ln2));
  });

  test('a sixth assessment is tinted grey', () => {
    const c = model.createCourse('SE6362');
    const cols = exporter.buildSheet(c, calc.computeCourse(c), ['raw:a_paper', 'weighted:a_paper']).columns;
    assert.deepEqual(cols.map((x) => x.tint), ['FFEDEDED', 'FFEDEDED']);
  });

  test('an empty course exports a header only', () => {
    const c = model.createCourse('SE4351');
    const sh = exporter.buildSheet(c, calc.computeCourse(c), DEFAULT(c));
    assert.equal(sh.rows.length, 0);
    assert.equal(sh.columns.length, DEFAULT(c).length);
  });
});

// ================================================================ workbook

describe('toWorkbook (ExcelJS in Node)', () => {
  test('Grades sheet: header style, frozen panes, autoFilter, widths, tints, borders, Status, withdrawn font', async () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const keys = DEFAULT(c);
    const buf = await exporter.toWorkbook(ExcelJS, c, res, keys, { now: NOW });
    const wb = await loadWorkbook(buf);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Grades', 'Settings']);
    const ws = wb.getWorksheet('Grades');
    const sh = exporter.buildSheet(c, res, keys);
    const header = ws.getRow(1).values.slice(1);
    assert.deepEqual(header, sh.columns.map((x) => x.label));
    assert.deepEqual(header.slice(0, 8), ['No', 'Last Name', 'First Name', 'Project I', 'Project II', 'Test 1', 'Test 2', 'Class/Project Participation']);
    assert.deepEqual(header.slice(8, 13), ['Project I 10%', 'Project II 20%', 'Test 1 25%', 'Test 2 40%', 'Class/Project Participation 5%']);
    assert.deepEqual(header.slice(13), ['Total', 'Letter Grade', 'Excused (allowed)', 'Unexcused (not allowed)', 'Total absences', 'Status']);
    const view = ws.views[0];
    assert.equal(view.state, 'frozen');
    assert.equal(view.ySplit, 1);
    assert.equal(view.xSplit, 3);
    assert.equal(ws.autoFilter, 'A1:S1');
    const h1 = ws.getRow(1).getCell(1);
    assert.equal(h1.font.bold, true);
    assert.equal(h1.alignment.wrapText, true);
    assert.equal(h1.fill.fgColor.argb, 'FFBFBFBF');
    assert.equal(ws.getRow(1).getCell(4).fill.fgColor.argb, 'FFE2EFDA');
    assert.equal(ws.getRow(1).getCell(9).fill.fgColor.argb, 'FFE2EFDA');
    assert.equal(ws.getRow(2).getCell(4).fill.fgColor.argb, 'FFE2EFDA');
    assert.equal(ws.getRow(2).getCell(12).fill.fgColor.argb, 'FFF8DCEF');
    assert.equal(ws.getRow(2).getCell(1).border.top.style, 'thin');
    assert.equal(ws.getRow(1).getCell(19).border.bottom.style, 'thin');
    sh.columns.forEach((col, i) => assert.equal(ws.getColumn(i + 1).width, col.width));
    assert.match(ws.getRow(1).getCell(9).note, /^= raw ÷ max × weight/);
    // Status column and a withdrawn row in grey
    const statusCol = header.indexOf('Status') + 1;
    const wdRow = sh.rowMeta.findIndex((m) => m.withdrawn) + 2;
    assert.equal(ws.getRow(wdRow).getCell(statusCol).value, 'Withdrawn');
    assert.equal(ws.getRow(wdRow).getCell(2).font.color.argb, 'FF808080');
    assert.equal(ws.getRow(2).getCell(statusCol).value, 'Active');
  });

  test('the workbook asks for a full recalculation on load (calcPr fullCalcOnLoad in workbook.xml)', async () => {
    const c = sampleCourse('SE6362');
    const buf = await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), DEFAULT(c), { now: NOW });
    const xml = readZipEntry(buf, 'xl/workbook.xml');
    assert.match(xml, /<calcPr[^>]*fullCalcOnLoad="1"/);
    const core = readZipEntry(buf, 'docProps/core.xml');
    assert.match(core, /Grade Tracker/);
    assert.match(core, /2026-10-01T12:00:00Z/);
  });

  test('Settings sheet: course, assessments, rounding, curve, letters, finalized, placeholders, generated line', async () => {
    const c = sampleCourse('SE4351');
    c.settings.curve = 2.5;
    addFinalLetters(c);
    model.finalize(c, '2026-12-10T15:00:00.000Z', 'after the meeting');
    const buf = await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), DEFAULT(c), { now: NOW });
    const wb = await loadWorkbook(buf);
    const st = wb.getWorksheet('Settings');
    const rows = [];
    st.eachRow((row) => rows.push(row.values.slice(1)));
    const find = (label) => rows.find((r) => r[0] === label);
    assert.equal(find('Course')[0], 'Course');
    assert.equal(rows.find((r) => r[0] === 'Course' && r[1])[1], 'SE 4351 - Requirements Engineering');
    const d0 = new Date(NOW), two = (n) => String(n).padStart(2, '0');
    assert.match(find('Exported')[1], new RegExp('^' + d0.getFullYear() + '-' + two(d0.getMonth() + 1) + '-' + two(d0.getDate()) + ' ' +
      two(d0.getHours()) + ':' + two(d0.getMinutes()) + ' \\(local time, UTC[+-]\\d{2}:\\d{2}\\)$'));
    assert.deepEqual(find('Project I'), ['Project I', 100, 10, 'yes', '']);
    assert.deepEqual(find('Class/Project Participation'), ['Class/Project Participation', 5, 5, 'no', '0–5 in steps of 0.5']);
    assert.equal(find('Rounding of the total')[1], 'none');
    assert.equal(find('Curve (points added to the total)')[1], 2.5);
    assert.match(find('Late work')[1], /^10 points per week late/);
    assert.match(find('Letter Grade column')[1], /^Final letters assigned by the instructor \(2 of 57 active students\)/);
    assert.match(find('Scores finalized')[1], /^Yes, on 2026-12-1[01] \(after the meeting\)$/);
    assert.deepEqual(find('A+'), ['A+', 97]);
    assert.ok(rows.some((r) => /^Letter scale \(PLACEHOLDER/.test(r[0])));
    assert.ok(find('Letter-grade cutoffs'));
    assert.ok(find('Max scores'));
    assert.equal(rows[rows.length - 1][0], 'Generated by Grade Tracker (offline). Formulas in the Grades sheet recalculate if you edit raw scores.');
    // Without final letters and not finalized
    const d = sampleCourse('SE6362');
    const rows2 = exporter.settingsRows(d, calc.computeCourse(d), NOW).filter(Array.isArray);
    assert.equal(rows2.find((r) => r[0] === 'Letter Grade column')[1], 'Suggestions from the cutoffs (no final letters assigned yet)');
    assert.equal(rows2.find((r) => r[0] === 'Scores finalized')[1], 'No');
    assert.equal(rows2.find((r) => r[0] === 'Attendance')[1], 'Off');
  });

  test('the export time is local, like the file name (review S4-SPEC-4, E2E-16)', () => {
    const { execFileSync } = require('node:child_process');
    const script = "const m=require('./js/core/model.js'),x=require('./js/core/exporter.js');" +
      "const c=m.createCourse('SE4351');console.log(x.settingsRows(c,null,'2026-12-16T01:00:00.000Z').find((r)=>r[0]==='Exported')[1]);";
    const out = (tz) => execFileSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), env: Object.assign({}, process.env, { TZ: tz }) }).toString().trim();
    assert.equal(out('America/Chicago'), '2026-12-15 19:00 (local time, UTC-06:00)');
    assert.equal(out('UTC'), '2026-12-16 01:00 (local time, UTC+00:00)');
    assert.equal(out('Asia/Kolkata'), '2026-12-16 06:30 (local time, UTC+05:30)');
  });

  test('computed numbers get the course\'s display decimals; the values keep full precision (review PARITY-4)', async () => {
    const c = sampleCourse('SE4351');
    c.assessments.find((a) => a.id === 'a_t1').maxScore = 30;
    const res = calc.computeCourse(c);
    const keys = EVERYTHING(c);
    const wb = await loadWorkbook(await exporter.toWorkbook(ExcelJS, c, res, keys, { now: NOW }));
    const ws = wb.getWorksheet('Grades');
    const sh = exporter.buildSheet(c, res, keys);
    const at = (key) => sh.columns.findIndex((x) => x.key === key) + 1;
    ['weighted:a_t1', 'total', 'percentile', 'diffAvg', 'absenceRate', 'unexcusedRate'].forEach((k) => assert.equal(ws.getRow(2).getCell(at(k)).numFmt, '0.00', k));
    ['no', 'raw:a_t1', 'rank', 'excused', 'letter'].forEach((k) => assert.equal(ws.getRow(2).getCell(at(k)).numFmt, undefined, k));
    const w = ws.getRow(2).getCell(at('weighted:a_t1')).value;
    assert.equal(w.result, sh.rows[0][at('weighted:a_t1') - 1].v);
    c.settings.rounding = 'integer';
    c.settings.decimals = 1;
    const sh2 = exporter.buildSheet(c, calc.computeCourse(c), keys);
    assert.equal(sh2.columns.find((x) => x.key === 'total').numFmt, '0');
    assert.equal(sh2.columns.find((x) => x.key === 'weighted:a_p1').numFmt, '0.0');
  });

  test('options: no Settings sheet; a Change history sheet from GT.history.toRows', async () => {
    const c = sampleCourse('SE6362');
    c.history.push({ id: 'h1', ts: NOW, source: 'edit', kind: 'score', studentName: 'Student 01, Alpha', teamName: 'Team 1', field: 'Test 1', oldValue: '80', newValue: '85', note: '' });
    const buf = await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), DEFAULT(c), { now: NOW, includeSettings: false, includeHistory: true });
    const wb = await loadWorkbook(buf);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Grades', 'Change history']);
    const hs = wb.getWorksheet('Change history');
    assert.equal(hs.getRow(1).getCell(1).value, 'Timestamp (ISO)');
    assert.equal(hs.getRow(2).getCell(6).value, 'Test 1');
    assert.equal(hs.getRow(2).getCell(8).value, '85');
    assert.equal(hs.views[0].ySplit, 1);
  });

  test('freeze covers the leading identity columns; a formula-looking name stays text', async () => {
    const c = sampleCourse('SE6362');
    c.students[0].lastName = '=HYPERLINK("x")';
    const keys = ['no', 'lastName', 'firstName', 'team', 'total', 'letter', 'status'];
    const wb = await loadWorkbook(await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), keys, { now: NOW }));
    const ws = wb.getWorksheet('Grades');
    assert.equal(ws.views[0].xSplit, 4);
    let found = false;
    ws.eachRow((row) => { if (row.getCell(2).value === '=HYPERLINK("x")') found = true; });
    assert.ok(found, 'kept as a plain string, not a formula');
    const wb2 = await loadWorkbook(await exporter.toWorkbook(ExcelJS, c, calc.computeCourse(c), ['total', 'no'], { now: NOW }));
    assert.equal(wb2.getWorksheet('Grades').views[0].xSplit, 0);
  });

  test('rejects clearly without ExcelJS', async () => {
    const c = model.createCourse('SE4351');
    await assert.rejects(exporter.toWorkbook(null, c, null, DEFAULT(c)), /ExcelJS/);
  });
});

// ================================================================ CSV

describe('toCsv', () => {
  test('BOM, CRLF, header, values only', () => {
    const c = sampleCourse('SE4351');
    const res = calc.computeCourse(c);
    const text = exporter.toCsv(c, res, DEFAULT(c));
    assert.equal(text.charCodeAt(0), 0xFEFF);
    assert.ok(text.includes('\r\n'));
    const rows = csv.parse(text);
    assert.deepEqual(rows[0], ['No', 'Last Name', 'First Name', 'Project I', 'Project II', 'Test 1', 'Test 2', 'Class/Project Participation',
      'Project I 10%', 'Project II 20%', 'Test 1 25%', 'Test 2 40%', 'Class/Project Participation 5%', 'Total', 'Letter Grade',
      'Excused (allowed)', 'Unexcused (not allowed)', 'Total absences', 'Status']);
    assert.equal(rows.length, 60);
    const sh = exporter.buildSheet(c, res, DEFAULT(c));
    rows.slice(1).forEach((row, ri) => {
      const r = res.byId[sh.rowMeta[ri].studentId];
      assert.equal(Number(row[13]), r.total);
      assert.equal(row[14], r.effectiveLetter);
      assert.ok(!row.some((v) => v.startsWith('ROUND(') || v.startsWith('IF(')));
    });
  });

  test('escaping and the formula guard; numbers are not guarded', () => {
    const c = sampleCourse('SE6362');
    c.students[0].lastName = '=cmd|calc';
    c.students[1].lastName = 'Smith, "Jr"';
    c.students[2].notes = 'line one\nline two';
    const res = calc.computeCourse(c);
    const text = exporter.toCsv(c, res, ['lastName', 'notes', 'diffAvg']);
    assert.ok(text.includes("'=cmd|calc"));
    assert.ok(text.includes('"Smith, ""Jr"""'));
    assert.ok(text.includes('"line one\nline two"'));
    const rows = csv.parse(text);
    const negative = rows.slice(1).find((r) => r[2].startsWith('-'));
    assert.ok(negative, 'a negative difference from the average is written as a plain number');
    assert.ok(!rows.slice(1).some((r) => r[2].startsWith("'")));
  });
});

// ================================================================ data check

describe('dataCheck', () => {
  const texts = (c) => exporter.dataCheck(c, calc.computeCourse(c)).items;

  test('sample course: not finalized, placeholders (cutoffs first), empty scores, withdrawn, overrides', () => {
    const c = sampleCourse('SE4351');
    const items = texts(c);
    const t = items.map((x) => x.level + ': ' + x.text);
    assert.equal(t[0], 'warn: Scores not finalized yet.');
    assert.ok(t.includes('warn: The letter-grade cutoffs are placeholders, not confirmed by the instructor.'));
    assert.ok(t.indexOf('warn: The letter-grade cutoffs are placeholders, not confirmed by the instructor.') < t.findIndex((x) => x.startsWith('info: Not confirmed yet:')));
    assert.ok(t.some((x) => /^warn: .+: 1 active student without a score \(counts as 0\)\.$/.test(x)));
    assert.ok(t.includes('info: 2 withdrawn students included, with Status "Withdrawn" and no rank.'));
    assert.ok(t.includes('info: 1 per-member override on team-graded items (noted in the file).'));
    assert.ok(t.includes('info: No final letters assigned yet: Letter Grade holds the suggestions from the cutoffs.'));
    assert.ok(!t.some((x) => /weights add up/.test(x)));
  });

  test('participation still empty, invalid and out-of-range entries, weights, finalized, final letters, order issues', () => {
    const c = sampleCourse('SE6362');
    const act = activeIndividuals(c);
    act.slice(0, 3).forEach((s) => model.setEntry(c.scores, s.id, 'a_part', null));
    model.setEntry(c.scores, act[3].id, 'a_t1', { value: null, text: 'n/a' });
    model.setEntry(c.scores, act[4].id, 'a_t2', { value: 101 });
    c.assessments[0].weight = 15;
    model.finalize(c, '2026-12-10T15:00:00.000Z', '');
    const res = calc.computeCourse(c);
    const sorted = calc.sortStudents(c, res, 'total', 'desc').filter((s) => s.status === 'active');
    model.setFinalLetter(c, sorted[0].id, 'B');
    model.setFinalLetter(c, sorted[sorted.length - 1].id, 'A');
    const t = texts(c).map((x) => x.level + ': ' + x.text);
    assert.match(t[0], /^info: Scores finalized on 2026-12-1[01]\.$/);
    assert.ok(t.includes('warn: The weights add up to 105%, not 100%.'));
    assert.ok(t.some((x) => /^warn: Class\/Project Participation is still empty for [34] active students/.test(x)));
    assert.ok(t.includes('warn: 1 entry not a number (exported as empty; each counts as 0).'));
    assert.ok(t.includes('warn: 1 score outside 0 to the max score (counted as entered).'));
    assert.ok(t.some((x) => /^info: \d+ active students without a final letter/.test(x)));
    assert.ok(t.includes('warn: 1 pair of final letters out of order (a lower total has a higher letter).'));
  });

  test('final letters equal to the suggestion: the CSV cannot mark them as final (review V4R2-3)', () => {
    const c = sampleCourse('SE4351');
    const act = activeIndividuals(c);
    const res = calc.computeCourse(c);
    const csvLine = (t) => t.filter((x) => /A CSV file cannot show/.test(x.text));
    assert.deepEqual(csvLine(texts(c)), [], 'no final letters');
    model.setFinalLetter(c, act[0].id, res.byId[act[0].id].letter === 'B' ? 'B-' : 'B');
    assert.deepEqual(csvLine(texts(c)), [], 'a final letter other than the suggestion reads back as final');
    model.setFinalLetter(c, act[1].id, res.byId[act[1].id].letter);
    assert.deepEqual(csvLine(texts(c)), [{ level: 'info', text: '1 final letter equals the suggestion from the cutoffs. A CSV file cannot show that it is final: ' +
      'imported back, it stays a suggestion. The Excel file marks final letters, and the "Final Letter" column (in the "Everything" preset) keeps them in both formats.' }]);
    model.setFinalLetter(c, act[2].id, res.byId[act[2].id].letter);
    assert.match(csvLine(texts(c))[0].text, /^2 final letters equal the suggestion from the cutoffs\. A CSV file cannot show that they are final: imported back, they stay suggestions\./);
  });

  test('an empty course says so', () => {
    const t = texts(model.createCourse('custom')).map((x) => x.text);
    assert.ok(t.includes('This course has no students yet.'));
  });
});
