'use strict';
/* Spec-derived tests for js/core/csv.js (STAGE2 section 3; REQUIREMENTS G1 paste, S3 roster paste,
 * E1/E4 CSV export and import). Expected rows are written out by hand. Fake data only. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const csv = require('../js/core/csv.js');

describe('parse (RFC 4180)', () => {
  test('simple rows with CRLF, LF and CR line endings', () => {
    const want = [['No', 'Last Name', 'First Name'], ['1', 'Student 01', 'Alpha']];
    assert.deepEqual(csv.parse('No,Last Name,First Name\r\n1,Student 01,Alpha'), want);
    assert.deepEqual(csv.parse('No,Last Name,First Name\n1,Student 01,Alpha'), want);
    assert.deepEqual(csv.parse('No,Last Name,First Name\r1,Student 01,Alpha'), want);
  });

  test('quoted fields: delimiters, doubled quotes and line breaks inside quotes', () => {
    const text = 'Name,Notes,Score\r\n"Student 01, Alpha","Said ""hi""\r\nthen left",85\r\n"Student 02","",90';
    assert.deepEqual(csv.parse(text), [
      ['Name', 'Notes', 'Score'],
      ['Student 01, Alpha', 'Said "hi"\r\nthen left', '85'],
      ['Student 02', '', '90']
    ]);
    assert.deepEqual(csv.parse('"a\nb",c\n"d\re",f'), [['a\nb', 'c'], ['d\re', 'f']]);
  });

  test('a UTF-8 BOM is stripped', () => {
    assert.deepEqual(csv.parse('﻿No,Name\r\n1,Student 01\r\n'), [['No', 'Name'], ['1', 'Student 01']]);
    assert.deepEqual(csv.parse('﻿"No";"Name"', { delimiter: ';' }), [['No', 'Name']]);
  });

  test('a single trailing empty line is dropped, a second one is kept as an empty row', () => {
    assert.deepEqual(csv.parse('a,b\r\n'), [['a', 'b']]);
    assert.deepEqual(csv.parse('a,b\n\n'), [['a', 'b'], ['']]);
    assert.deepEqual(csv.parse(''), []);
    assert.deepEqual(csv.parse(null), []);
    assert.deepEqual(csv.parse('\n'), [['']]);
  });

  test('empty fields and trailing delimiters are kept', () => {
    assert.deepEqual(csv.parse('a,,c,\n,,,'), [['a', '', 'c', ''], ['', '', '', '']]);
    assert.deepEqual(csv.parse('a,""'), [['a', '']]);
  });

  test('stray quotes that do not open a proper quoted field are plain text', () => {
    assert.deepEqual(csv.parse('5" tall,x'), [['5" tall', 'x']]);
    assert.deepEqual(csv.parse('a,"unterminated\nb,c'), [['a', '"unterminated'], ['b', 'c']]);
    assert.deepEqual(csv.parse('"Nick" Smith,x'), [['"Nick" Smith', 'x']]);
  });

  test('explicit delimiters', () => {
    assert.deepEqual(csv.parse('a;b,c', { delimiter: ';' }), [['a', 'b,c']]);
    assert.deepEqual(csv.parse('a\tb,c', { delimiter: '\t' }), [['a', 'b,c']]);
    assert.deepEqual(csv.parse('a;b,c', { delimiter: ',' }), [['a;b', 'c']]);
  });
});

describe('delimiter detection (auto)', () => {
  test('the most frequent of tab, comma and semicolon in the first non-empty line', () => {
    assert.equal(csv.detectDelimiter('No;Last Name;First Name\n1;Student 01;Alpha'), ';');
    assert.equal(csv.detectDelimiter('No,Last Name,First Name'), ',');
    assert.equal(csv.detectDelimiter('\n\nNo;Name;Team,Size\n1,2,3,4,5'), ';');
    assert.deepEqual(csv.parse('No;Name;Score\n1;Student 01;85,5'), [['No', 'Name', 'Score'], ['1', 'Student 01', '85,5']]);
  });

  test('tab wins whenever it is present', () => {
    assert.equal(csv.detectDelimiter('a,b,c,d\te'), '\t');
    assert.deepEqual(csv.parse('Name\tNotes\nStudent 01, Alpha\tx;y'), [['Name', 'Notes'], ['Student 01, Alpha', 'x;y']]);
  });

  test('delimiters inside quotes do not count; ties and no candidate give a comma', () => {
    assert.equal(csv.detectDelimiter('"a;b;c;d",e,f'), ',');
    assert.equal(csv.detectDelimiter('a,b;c'), ',');
    assert.equal(csv.detectDelimiter('Student 01'), ',');
    assert.equal(csv.detectDelimiter(''), ',');
  });
});

describe('parseClipboard (Excel / Sheets TSV)', () => {
  test('a 3 x 4 block with empty cells, as Excel copies it (CRLF after every row)', () => {
    const text = '90\t\t80\t75\r\n\t85\t\t\r\n70\tabc\t\t100\r\n';
    assert.deepEqual(csv.parseClipboard(text), [
      ['90', '', '80', '75'],
      ['', '85', '', ''],
      ['70', 'abc', '', '100']
    ]);
  });

  test('one column pastes: one cell per line', () => {
    assert.deepEqual(csv.parseClipboard('85\r\n\r\n92\r\n'), [['85'], [''], ['92']]);
    assert.deepEqual(csv.parseClipboard('Student 01, Alpha\nStudent 02, Bravo\n'), [['Student 01, Alpha'], ['Student 02, Bravo']]);
  });

  test('a single line without a tab is one cell, kept exactly', () => {
    assert.deepEqual(csv.parseClipboard('85'), [['85']]);
    assert.deepEqual(csv.parseClipboard('85\n'), [['85']]);
    assert.deepEqual(csv.parseClipboard('Student 01, Alpha; Team 2'), [['Student 01, Alpha; Team 2']]);
    assert.deepEqual(csv.parseClipboard('"quoted" text'), [['"quoted" text']]);
  });

  test('only one trailing line break is trimmed; an empty clipboard gives no rows; a copied empty cell gives one', () => {
    assert.deepEqual(csv.parseClipboard('a\tb\r\n\t\r\n'), [['a', 'b'], ['', '']]);
    assert.deepEqual(csv.parseClipboard(''), []);
    assert.deepEqual(csv.parseClipboard(null), []);
    assert.deepEqual(csv.parseClipboard('\r\n'), [['']]);
  });

  test('an Excel cell with a line break inside is quoted on the clipboard', () => {
    assert.deepEqual(csv.parseClipboard('Student 01\t"line 1\nline 2"\r\nStudent 02\tx\r\n'), [
      ['Student 01', 'line 1\nline 2'],
      ['Student 02', 'x']
    ]);
    assert.deepEqual(csv.parseClipboard('"line 1\nline 2"\nnext\n'), [['line 1\nline 2'], ['next']]);
  });

  test('commas and semicolons are not delimiters on the clipboard', () => {
    assert.deepEqual(csv.parseClipboard('Student 01, Alpha\t85,5\r\n'), [['Student 01, Alpha', '85,5']]);
  });
});

describe('stringify', () => {
  test('quotes fields with the delimiter, a quote, CR or LF; every row ends with CRLF', () => {
    const out = csv.stringify([['No', 'Name', 'Notes'], [1, 'Student 01, Alpha', 'said "hi"\nthen left'], [2, 'Student 02', 'a\rb']]);
    assert.equal(out, 'No,Name,Notes\r\n1,"Student 01, Alpha","said ""hi""\nthen left"\r\n2,Student 02,"a\rb"\r\n');
  });

  test('null and undefined are empty; numbers and booleans are written plainly', () => {
    assert.equal(csv.stringify([[null, undefined, 0, 74.25, -3, true, false, NaN]]), ',,0,74.25,-3,TRUE,FALSE,\r\n');
    assert.equal(csv.stringify([]), '');
  });

  test('BOM, delimiter and eol options', () => {
    assert.equal(csv.stringify([['a', 'b;c']], { bom: true, delimiter: ';', eol: '\n' }), '﻿a;"b;c"\n');
    assert.equal(csv.stringify([['a', 'b c', 'd,e']], { delimiter: '\t' }), 'a\tb c\td,e\r\n');
  });

  test('formula guard: text starting with =, +, -, @, tab or CR gets an apostrophe; JS numbers are untouched', () => {
    const out = csv.stringify([['=SUM(A1:A9)', '+1', '-5', '@cmd', '\tx', '\rx', -5, 'Student 01', 'a=b']]);
    assert.equal(out, "'=SUM(A1:A9),'+1,'-5,'@cmd,'\tx,\"'\rx\",-5,Student 01,a=b\r\n");
    assert.equal(csv.stringify([['=1+1', '-5']], { guardFormulas: false }), '=1+1,-5\r\n');
    // A guarded cell that also needs quotes.
    assert.equal(csv.stringify([['=HYPERLINK("x")']]), '"\'=HYPERLINK(""x"")"\r\n');
  });

  test('formula guard in a ";" locale (review code-4): the part after a ";" or a tab is guarded too', () => {
    assert.equal(csv.stringify([['x;=1+1;y']]), "x;'=1+1;y\r\n");
    assert.equal(csv.stringify([['a', 'b;=cmd|\' /C calc\'!A0']]), "a,b;'=cmd|' /C calc'!A0\r\n");
    assert.equal(csv.stringify([['met;-late', 'x\t@y', 'a; =b', 'ok;x']]), "met;'-late,x\t'@y,a; =b,ok;x\r\n");
    assert.equal(csv.stringify([['x;=1+1']], { guardFormulas: false }), 'x;=1+1\r\n');
    // Split on ';' as Excel would in such a locale: no part starts with a formula character.
    const line = csv.stringify([['Student 01', 'x;=1+1;y', 'b;+2']]).trim();
    csv.parse(line, { delimiter: ';' })[0].forEach((part) => assert.ok(!/^[=+\-@]/.test(part), part));
  });

  test('parseTable: limits on rows and columns, with flags when something is left out', () => {
    assert.deepEqual(csv.parseTable('a,b,c\n1,2,3\n4,5,6\n', { maxRows: 2, maxCols: 2 }),
      { rows: [['a', 'b'], ['1', '2']], delimiter: ',', truncatedRows: true, truncatedColumns: true });
    assert.deepEqual(csv.parseTable('a;b;\n1;2;\n\n\n', { maxRows: 2, maxCols: 2 }),
      { rows: [['a', 'b'], ['1', '2']], delimiter: ';', truncatedRows: false, truncatedColumns: false }, 'only empty cells and lines were left out');
    assert.deepEqual(csv.parseTable('a,b'), { rows: [['a', 'b']], delimiter: ',', truncatedRows: false, truncatedColumns: false });
    assert.equal(csv.parse('\n'.repeat(100000), { maxRows: 10 }).length, 10);
  });

  test('round trip: parse(stringify(rows)) gives the rows back', () => {
    const rows = [
      ['No', 'Last Name', 'First Name', 'Notes', 'Score'],
      ['1', 'Student 01', 'Alpha', 'line 1\r\nline 2', '85'],
      ['2', 'Student 02, Jr.', '', 'He said "ok"', ''],
      [''],
      ['3', ' spaced ', 'x;y', '\tlead', '99.5'],
      ['']
    ];
    [',', ';', '\t'].forEach((d) => {
      const text = csv.stringify(rows, { delimiter: d, guardFormulas: false, bom: true });
      assert.deepEqual(csv.parse(text, { delimiter: d }), rows, 'delimiter ' + JSON.stringify(d));
    });
    assert.deepEqual(csv.parse(csv.stringify(rows, { guardFormulas: false })), rows, 'auto-detected comma');
  });

  test('round trip through the clipboard parser (TSV copy from the grid)', () => {
    const block = [['90', '', '80'], ['', 'abc', ''], ['70', '85', '100']];
    assert.deepEqual(csv.parseClipboard(csv.stringify(block, { delimiter: '\t', guardFormulas: false })), block);
  });
});
