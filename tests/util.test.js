'use strict';
/* Spec-derived tests for js/core/util.js (DESIGN.md 1.1 and 3; REQUIREMENTS K3, G4, T1).
 * Every expected value below was worked out by hand, not copied from the implementation. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('../js/core/util.js');

describe('util.fix (removes binary floating-point noise, 10 decimals)', () => {
  test('0.1 + 0.2 becomes exactly 0.3', () => {
    assert.notEqual(0.1 + 0.2, 0.3); // sanity: the raw float sum is noisy
    assert.equal(util.fix(0.1 + 0.2), 0.3);
  });

  test('values that are a hair under a decimal become that decimal', () => {
    assert.equal(util.fix(81.02499999999999), 81.025);
    assert.equal(util.fix(89.99999999999999), 90);
  });

  test('keeps 10 decimal places', () => {
    assert.equal(util.fix(1.23456789012), 1.2345678901);
    assert.equal(util.fix(74), 74);
  });
});

describe('util.roundTo (half away from zero, like Excel ROUND)', () => {
  test('81.025 to 2 decimals is 81.03 (naive Math.round gives 81.02)', () => {
    assert.equal(util.roundTo(81.025, 2), 81.03);
  });

  test('1.005 to 2 decimals is 1.01', () => {
    assert.equal(util.roundTo(1.005, 2), 1.01);
  });

  test('2.5 to 0 decimals is 3 and -2.5 is -3', () => {
    assert.equal(util.roundTo(2.5, 0), 3);
    assert.equal(util.roundTo(-2.5, 0), -3);
  });

  test('0.125 to 2 decimals is 0.13 and -0.125 is -0.13', () => {
    assert.equal(util.roundTo(0.125, 2), 0.13);
    assert.equal(util.roundTo(-0.125, 2), -0.13);
  });

  test('other classic float traps round the decimal way', () => {
    assert.equal(util.roundTo(2.675, 2), 2.68);
    assert.equal(util.roundTo(1.45, 1), 1.5);
    assert.equal(util.roundTo(84.5, 0), 85);
    assert.equal(util.roundTo(89.5, 0), 90);
    assert.equal(util.roundTo(0.5, 0), 1);
    assert.equal(util.roundTo(-0.5, 0), -1);
  });

  test('values below the half point round down', () => {
    assert.equal(util.roundTo(81.024, 2), 81.02);
    assert.equal(util.roundTo(84.49, 0), 84);
  });

  test('already-round values are unchanged', () => {
    assert.equal(util.roundTo(74, 2), 74);
    assert.equal(util.roundTo(74, 0), 74);
    assert.equal(util.roundTo(8.8, 2), 8.8);
  });
});

describe('util.parseScoreInput', () => {
  function num(input, expected) {
    const p = util.parseScoreInput(input);
    assert.equal(p.kind, 'number', `input ${JSON.stringify(input)} should parse as a number`);
    assert.equal(p.value, expected);
  }
  function empty(input) {
    assert.equal(util.parseScoreInput(input).kind, 'empty', `input ${JSON.stringify(input)} should be empty`);
  }
  function invalid(input, text) {
    const p = util.parseScoreInput(input);
    assert.equal(p.kind, 'invalid', `input ${JSON.stringify(input)} should be invalid`);
    if (text !== undefined) assert.equal(p.text, text);
  }

  test('plain integer "88"', () => num('88', 88));
  test('surrounding spaces " 88.5 "', () => num(' 88.5 ', 88.5));
  test('trailing percent sign "88%"', () => num('88%', 88));
  test('explicit plus sign "+7"', () => num('+7', 7));
  test('negative "-3"', () => num('-3', -3));
  test('leading decimal point ".5"', () => num('.5', 0.5));
  test('unicode minus sign "\\u22123" is -3', () => num('−3', -3));
  test('exponent notation "1e2" is 100 (as Excel reads it)', () => num('1e2', 100));

  test('empty string, whitespace only, null and undefined are empty', () => {
    empty('');
    empty('  ');
    empty(null);
    empty(undefined);
  });

  test('non-numeric text "abc" is invalid and keeps the text', () => invalid('abc', 'abc'));
  test('decimal comma "88,5" is invalid (ambiguous)', () => invalid('88,5'));
  test('mixed text "88 points" is invalid', () => invalid('88 points'));
});

describe('util.formatNumber', () => {
  test('trims trailing zeros by default', () => {
    assert.equal(util.formatNumber(74, 2), '74');
    assert.equal(util.formatNumber(81.5, 2), '81.5');
    assert.equal(util.formatNumber(81.35, 2), '81.35');
    assert.equal(util.formatNumber(0.1 + 0.2, 2), '0.3');
  });

  test('rounds half away from zero to the requested decimals', () => {
    assert.equal(util.formatNumber(81.025, 2), '81.03');
    assert.equal(util.formatNumber(84.5, 0), '85');
    assert.equal(util.formatNumber(-2.5, 0), '-3');
  });

  test('fixed option keeps trailing zeros', () => {
    assert.equal(util.formatNumber(74, 2, { fixed: true }), '74.00');
    assert.equal(util.formatNumber(74, 1, { fixed: true }), '74.0');
    assert.equal(util.formatNumber(8.8, 2, { fixed: true }), '8.80');
  });

  test('null and undefined format as an empty string', () => {
    assert.equal(util.formatNumber(null, 2), '');
    assert.equal(util.formatNumber(undefined, 2), '');
  });
});

describe('util.compareText', () => {
  test('numeric-aware: "Student 2" sorts before "Student 10"', () => {
    assert.ok(util.compareText('Student 2', 'Student 10') < 0);
    assert.ok(util.compareText('Student 10', 'Student 2') > 0);
  });

  test('case-insensitive', () => {
    assert.equal(util.compareText('student 01', 'STUDENT 01'), 0);
    // Plain code-point order would put "Bravo" before "alpha".
    assert.ok(util.compareText('alpha', 'Bravo') < 0);
    assert.ok(util.compareText('Bravo', 'alpha') > 0);
  });

  test('equal strings compare as 0', () => {
    assert.equal(util.compareText('Student 07', 'Student 07'), 0);
  });
});

describe('util.escapeHtml', () => {
  test('escapes &, <, > and double quotes', () => {
    assert.equal(
      util.escapeHtml('<a href="x">Tom & Jerry</a>'),
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;'
    );
  });

  test('escapes single quotes so attribute values are safe', () => {
    const out = util.escapeHtml("Student's note");
    assert.ok(!out.includes("'"), `single quote left unescaped in ${out}`);
    assert.ok(out.startsWith('Student&'));
    assert.ok(out.endsWith('s note'));
  });

  test('escapes an existing entity again (no double-unescape)', () => {
    assert.equal(util.escapeHtml('&lt;'), '&amp;lt;');
  });

  test('plain text is unchanged', () => {
    assert.equal(util.escapeHtml('Student 01'), 'Student 01');
  });
});

describe('util dates (ISO YYYY-MM-DD, time-zone safe)', () => {
  test('isIsoDate accepts real calendar dates', () => {
    assert.equal(util.isIsoDate('2026-09-03'), true);
    assert.equal(util.isIsoDate('2026-12-08'), true);
    assert.equal(util.isIsoDate('2024-02-29'), true); // leap year
  });

  test('isIsoDate rejects impossible dates and wrong formats', () => {
    assert.equal(util.isIsoDate('2026-02-30'), false);
    assert.equal(util.isIsoDate('2026-02-29'), false); // not a leap year
    assert.equal(util.isIsoDate('2026-13-01'), false);
    assert.equal(util.isIsoDate('2026-9-3'), false);
    assert.equal(util.isIsoDate('09/03/2026'), false);
    assert.equal(util.isIsoDate('abc'), false);
    assert.equal(util.isIsoDate(''), false);
    assert.equal(util.isIsoDate(null), false);
  });

  test('addDays crosses month and year ends', () => {
    assert.equal(util.addDays('2026-09-30', 1), '2026-10-01');
    assert.equal(util.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(util.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(util.addDays('2024-02-28', 1), '2024-02-29');
  });

  test('addDays across the US daylight-saving change stays on whole days', () => {
    // DST ends on 2026-11-01 in the US.
    assert.equal(util.addDays('2026-10-29', 5), '2026-11-03');
    assert.equal(util.addDays('2026-09-03', 7), '2026-09-10');
  });

  test("weekday('2026-09-03') is 4 (Thursday)", () => {
    assert.equal(util.weekday('2026-09-03'), 4);
  });

  test('weekday for other known dates (0 = Sunday)', () => {
    assert.equal(util.weekday('2026-12-08'), 2); // Tuesday
    assert.equal(util.weekday('2026-11-01'), 0); // Sunday
    assert.equal(util.weekday('2026-01-01'), 4); // Thursday
  });
});

// ---------------------------------------------------------------- review round 1 regressions

describe('util.roundTo edge cases (review F6)', () => {
  test('very large values round without turning into NaN', () => {
    assert.equal(util.roundTo(1e19, 2), 1e19);
    assert.equal(util.roundTo(1e20, 0), 1e20);
    assert.equal(util.roundTo(1e22, 2), 1e22);
    assert.equal(util.formatNumber(1e19, 2), '10000000000000000000');
  });

  test('negative decimals round to tens and hundreds like Excel ROUND(1234, -2)', () => {
    assert.equal(util.roundTo(1234, -2), 1200);
    assert.equal(util.roundTo(1250, -2), 1300);
    assert.equal(util.roundTo(-1250, -2), -1300);
    assert.equal(util.roundTo(85, -1), 90);
  });

  test('FIX_DECIMALS is the 10-decimal precision used by fix (for Excel ROUND parity)', () => {
    assert.equal(util.FIX_DECIMALS, 10);
    assert.equal(util.fix(4e-11), 0);
    assert.equal(util.fix(2e-10), 2e-10);
    assert.equal(util.fix(79.99999999999997), 80);
  });
});

describe('util.parseScoreInput magnitude limit (review F6)', () => {
  test('absurd magnitudes are invalid, so totals stay finite', () => {
    assert.deepEqual(util.parseScoreInput('1e308'), { kind: 'invalid', text: '1e308' });
    assert.equal(util.parseScoreInput('1e20').kind, 'invalid');
    assert.equal(util.parseScoreInput('-2000000').kind, 'invalid');
    assert.equal(util.parseScoreInput(1e7).kind, 'invalid');
    assert.equal(util.parseScoreInput(Infinity).kind, 'invalid');
  });

  test('large but plausible values are still numbers (flagged out of range by calc instead)', () => {
    assert.deepEqual(util.parseScoreInput('8500'), { kind: 'number', value: 8500 });
    assert.deepEqual(util.parseScoreInput('1e6'), { kind: 'number', value: 1000000 });
    assert.equal(util.MAX_INPUT_ABS, 1e6);
  });
});

describe('util.parseScoreInput percent of the max score (E2E-9)', () => {
  test('"x%" is x percent of the given max score', () => {
    assert.deepEqual(util.parseScoreInput('88%', 50), { kind: 'number', value: 44 });
    assert.deepEqual(util.parseScoreInput(' 88 % ', 30), { kind: 'number', value: 26.4 }); // 88 * 30 / 100
    assert.deepEqual(util.parseScoreInput('100%', 20), { kind: 'number', value: 20 });
    assert.deepEqual(util.parseScoreInput('88%', 100), { kind: 'number', value: 88 });
    assert.deepEqual(util.parseScoreInput('0%', 50), { kind: 'number', value: 0 });
  });

  test('without a % the max score changes nothing', () => {
    assert.deepEqual(util.parseScoreInput('88', 50), { kind: 'number', value: 88 });
    assert.deepEqual(util.parseScoreInput(88, 50), { kind: 'number', value: 88 });
  });

  test('without a usable max score the % is dropped (weights, curve, settings fields)', () => {
    assert.deepEqual(util.parseScoreInput('25%'), { kind: 'number', value: 25 });
    assert.deepEqual(util.parseScoreInput('25%', null), { kind: 'number', value: 25 });
    assert.deepEqual(util.parseScoreInput('25%', 0), { kind: 'number', value: 25 });
    assert.deepEqual(util.parseScoreInput('25%', -50), { kind: 'number', value: 25 });
    assert.deepEqual(util.parseScoreInput('25%', NaN), { kind: 'number', value: 25 });
  });

  test('a converted value above the magnitude limit is invalid', () => {
    assert.deepEqual(util.parseScoreInput('1e6%', 1000), { kind: 'invalid', text: '1e6%' });
  });

  test('invalid text stays invalid with a max score', () => {
    assert.deepEqual(util.parseScoreInput('abc%', 50), { kind: 'invalid', text: 'abc%' });
  });
});

describe('util.parseCount (whole, non-negative numbers; review F7)', () => {
  test('whole numbers parse', () => {
    assert.equal(util.parseCount('2'), 2);
    assert.equal(util.parseCount(' 0 '), 0);
    assert.equal(util.parseCount(3), 3);
  });

  test('fractions, percentages, negatives, text and blanks are rejected', () => {
    assert.equal(util.parseCount('1.5'), null);
    assert.equal(util.parseCount(1.5), null);
    assert.equal(util.parseCount('88%'), null);
    assert.equal(util.parseCount('2 %'), null);
    assert.equal(util.parseCount('-1'), null);
    assert.equal(util.parseCount('two'), null);
    assert.equal(util.parseCount(''), null);
    assert.equal(util.parseCount(null), null);
  });

  test('strict digits only: scientific notation, signs, separators and hex are rejected (review E2E3-13, DECISIONS 8)', () => {
    for (const bad of ['1e3', '1E3', '.5e1', '2e0', '+2', '1,000', '1 000', 'Infinity', '0x10', '٣', '3 absences', '1000001', 1e7, -1, NaN, Infinity, true, {}, []]) {
      assert.equal(util.parseCount(bad), null, JSON.stringify(bad));
    }
    assert.equal(util.parseCount('007'), 7);
    assert.equal(util.parseCount('2.0'), 2, 'a whole number written with ".0" is fine');
    assert.equal(util.parseCount('\u00a05\u00a0'), 5, 'non-breaking spaces around are trimmed');
    assert.equal(util.parseCount('1000000'), 1000000);
    assert.ok(Object.is(util.parseCount(-0), 0), '-0 becomes 0');
  });
});

describe('util.hasOwn and util.isSafeKey (review F2, F4)', () => {
  test('hasOwn ignores inherited names', () => {
    assert.equal(util.hasOwn({}, 'toString'), false);
    assert.equal(util.hasOwn({}, 'constructor'), false);
    assert.equal(util.hasOwn({ a: 1 }, 'a'), true);
    assert.equal(util.hasOwn(null, 'a'), false);
    assert.equal(util.hasOwn(JSON.parse('{"__proto__":1}'), '__proto__'), true);
  });

  test('isSafeKey rejects prototype keys and non-strings', () => {
    ['__proto__', 'constructor', 'prototype', '', null, 5].forEach((k) => assert.equal(util.isSafeKey(k), false, String(k)));
    ['s_1', 'toString', 'valueOf', 'a_t1'].forEach((k) => assert.equal(util.isSafeKey(k), true, k));
  });
});
