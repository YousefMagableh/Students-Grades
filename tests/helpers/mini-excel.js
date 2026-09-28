'use strict';
/* A tiny spreadsheet formula evaluator for the exporter tests (not a test file itself: npm test runs
 * tests/*.test.js only). It is written independently of js/core so it can check that the exported
 * formulas reproduce the app's numbers.
 *
 * Supported: numbers, strings ("" escapes a quote), TRUE/FALSE, + - * / ^ & (concatenation), unary
 * minus/plus, comparisons = <> < > <= >=, parentheses, A1 references and ranges within one sheet
 * ($ allowed), and the functions ROUND, SUM, MAX, MIN, IF, ABS.
 * Semantics follow Excel where it matters here:
 * - A blank cell is 0 in arithmetic and comparisons with numbers; SUM/MAX/MIN skip blanks and text
 *   inside ranges.
 * - ROUND(x, n) rounds half away from zero on the value as Excel sees it (15 significant digits), so
 *   ROUND(81.025, 2) = 81.03 and ROUND(89.99999999999999, 10) = 90.
 *   createSheet(cells, { naiveRound: true }) uses the binary value instead, as some engines do
 *   (HyperFormula: Math.round(x * 10^n) / 10^n, so ROUND(79.725, 2) = 79.72); the exporter's
 *   formulas must give the app's numbers either way.
 * - Text in arithmetic is an error (#VALUE!), which throws here.
 *
 *   const sheet = createSheet({ A1: 5, B1: { formula: 'A1*2' } });
 *   sheet.value('B1') // 10
 *   evaluate('ROUND(A1/3,2)', sheet) // 1.67 */

class ExcelError extends Error {}

// ---------------------------------------------------------------- tokenizer

const TOKEN_RE = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|("(?:[^"]|"")*")|(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)(?![A-Za-z0-9_(])|([A-Za-z_][A-Za-z0-9_.]*)(?=\s*\()|(TRUE|FALSE)\b|(<=|>=|<>|[-+*/^&=<>(),]))/y;

function tokenize(src) {
  const tokens = [];
  let s = String(src).trim();
  if (s.charAt(0) === '=') s = s.slice(1);
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < s.length) {
    if (/^\s*$/.test(s.slice(pos))) break;
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(s);
    if (!m) throw new ExcelError('Cannot read the formula at "' + s.slice(pos, pos + 12) + '" in ' + s);
    pos = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'str', v: m[2].slice(1, -1).replace(/""/g, '"') });
    else if (m[3] !== undefined) tokens.push({ t: 'ref', v: m[3].replace(/\$/g, '').toUpperCase() });
    else if (m[4] !== undefined) tokens.push({ t: 'fn', v: m[4].toUpperCase() });
    else if (m[5] !== undefined) tokens.push({ t: 'bool', v: m[5].toUpperCase() === 'TRUE' });
    else tokens.push({ t: 'op', v: m[6] });
  }
  return tokens;
}

// ---------------------------------------------------------------- parser (precedence climbing)

function parse(src) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => tokens[i] && tokens[i].t === 'op' && tokens[i].v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new ExcelError('Expected "' + v + '" in ' + src);
    i++;
  };

  function comparison() {
    let left = concat();
    while (peek() && peek().t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) {
      const op = tokens[i++].v;
      left = { k: 'bin', op, a: left, b: concat() };
    }
    return left;
  }
  function concat() {
    let left = additive();
    while (isOp('&')) { i++; left = { k: 'bin', op: '&', a: left, b: additive() }; }
    return left;
  }
  function additive() {
    let left = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++].v;
      left = { k: 'bin', op, a: left, b: multiplicative() };
    }
    return left;
  }
  function multiplicative() {
    let left = power();
    while (isOp('*') || isOp('/')) {
      const op = tokens[i++].v;
      left = { k: 'bin', op, a: left, b: power() };
    }
    return left;
  }
  function power() {
    let left = unary();
    while (isOp('^')) { i++; left = { k: 'bin', op: '^', a: left, b: unary() }; }
    return left;
  }
  function unary() {
    if (isOp('-')) { i++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { i++; return unary(); }
    return primary();
  }
  function primary() {
    const tk = tokens[i++];
    if (!tk) throw new ExcelError('Unexpected end of formula: ' + src);
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'str') return { k: 'str', v: tk.v };
    if (tk.t === 'bool') return { k: 'bool', v: tk.v };
    if (tk.t === 'ref') {
      if (tk.v.includes(':')) {
        const [from, to] = tk.v.split(':');
        return { k: 'range', from, to };
      }
      return { k: 'ref', v: tk.v };
    }
    if (tk.t === 'fn') {
      expect('(');
      const args = [];
      if (!isOp(')')) {
        args.push(comparison());
        while (isOp(',')) { i++; args.push(comparison()); }
      }
      expect(')');
      return { k: 'call', name: tk.v, args };
    }
    if (tk.t === 'op' && tk.v === '(') {
      const e = comparison();
      expect(')');
      return e;
    }
    throw new ExcelError('Unexpected "' + tk.v + '" in ' + src);
  }

  const tree = comparison();
  if (i !== tokens.length) throw new ExcelError('Unexpected "' + tokens[i].v + '" in ' + src);
  return tree;
}

// ---------------------------------------------------------------- references

function splitRef(ref) {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(ref);
  if (!m) throw new ExcelError('Bad reference ' + ref);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

function refName(col, row) {
  let s = '';
  let n = col;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s + row;
}

function expandRange(from, to) {
  const a = splitRef(from), b = splitRef(to);
  const out = [];
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
    for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) out.push(refName(c, r));
  }
  return out;
}

// ---------------------------------------------------------------- values and functions

const BLANK = null;

function toNumber(v) {
  if (v === BLANK || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new ExcelError('#VALUE!: text "' + v + '" used as a number');
}

/** Excel ROUND: half away from zero, applied to the value at 15 significant digits. */
function excelRound(x, digits) {
  const d = Math.trunc(toNumber(digits));
  const v = toNumber(x);
  if (!isFinite(v)) throw new ExcelError('#NUM!');
  if (v === 0) return 0;
  const sign = v < 0 ? -1 : 1;
  const [mant, expPart] = Math.abs(v).toPrecision(15).split('e');
  const exp = expPart ? Number(expPart) : 0;
  const shifted = Number(mant + 'e' + (exp + d));
  const rounded = Math.floor(shifted + 0.5);
  const out = sign * Number(rounded + 'e' + (-d));
  return out === 0 ? 0 : out;
}

function compare(a, b) {
  // Excel ordering: numbers < text < booleans; blank acts as 0 or "" depending on the other side.
  const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  let x = a, y = b;
  if (x === BLANK) x = typeof y === 'string' ? '' : typeof y === 'boolean' ? false : 0;
  if (y === BLANK) y = typeof x === 'string' ? '' : typeof x === 'boolean' ? false : 0;
  if (rank(x) !== rank(y)) return rank(x) - rank(y);
  if (typeof x === 'string') {
    const p = x.toLowerCase(), q = y.toLowerCase();
    return p < q ? -1 : p > q ? 1 : 0;
  }
  const p = Number(x), q = Number(y);
  return p < q ? -1 : p > q ? 1 : 0;
}

/** ROUND on the binary value (HyperFormula's way): half away from zero of x * 10^n. */
function naiveRound(x, digits) {
  const d = Math.trunc(toNumber(digits));
  const v = toNumber(x);
  const m = Math.pow(10, d);
  const out = v < 0 ? -Math.round(-v * m) / m : Math.round(v * m) / m;
  return out === 0 ? 0 : out;
}

function createSheet(cells, options) {
  const naive = !!(options && options.naiveRound);
  const store = new Map();
  Object.keys(cells || {}).forEach((k) => store.set(k.toUpperCase(), cells[k]));
  const cache = new Map();
  const busy = new Set();

  function raw(ref) {
    return store.has(ref) ? store.get(ref) : BLANK;
  }

  function value(ref) {
    const key = ref.toUpperCase();
    if (cache.has(key)) return cache.get(key);
    const c = raw(key);
    let v;
    if (c && typeof c === 'object' && typeof c.formula === 'string') {
      if (busy.has(key)) throw new ExcelError('Circular reference at ' + key);
      busy.add(key);
      try { v = evaluate(c.formula, api); } finally { busy.delete(key); }
    } else if (c === undefined || c === '' || c === null) {
      v = BLANK;
    } else {
      v = c;
    }
    cache.set(key, v);
    return v;
  }

  const api = { naiveRound: naive, value, raw, set: (ref, v) => { store.set(ref.toUpperCase(), v); cache.clear(); }, refs: () => [...store.keys()] };
  return api;
}

function rangeValues(node, sheet) {
  return expandRange(node.from, node.to).map((r) => sheet.value(r));
}

/** Numbers of the arguments of SUM/MAX/MIN: ranges and references skip blanks and text; direct
 * values must be numbers (text there is #VALUE!). */
function numbersOf(args, sheet) {
  const out = [];
  args.forEach((a) => {
    if (a.k === 'range') {
      rangeValues(a, sheet).forEach((v) => { if (typeof v === 'number') out.push(v); });
    } else if (a.k === 'ref') {
      const v = sheet.value(a.v);
      if (typeof v === 'number') out.push(v);
    } else {
      out.push(toNumber(ev(a, sheet)));
    }
  });
  return out;
}

const FUNCTIONS = {
  ROUND(args, sheet) {
    if (args.length !== 2) throw new ExcelError('ROUND takes 2 arguments');
    return (sheet.naiveRound ? naiveRound : excelRound)(ev(args[0], sheet), ev(args[1], sheet));
  },
  SUM(args, sheet) {
    return numbersOf(args, sheet).reduce((s, x) => s + x, 0);
  },
  MAX(args, sheet) {
    const n = numbersOf(args, sheet);
    return n.length ? Math.max(...n) : 0;
  },
  MIN(args, sheet) {
    const n = numbersOf(args, sheet);
    return n.length ? Math.min(...n) : 0;
  },
  ABS(args, sheet) {
    return Math.abs(toNumber(ev(args[0], sheet)));
  },
  IF(args, sheet) {
    if (args.length < 2 || args.length > 3) throw new ExcelError('IF takes 2 or 3 arguments');
    const c = ev(args[0], sheet);
    const truthy = typeof c === 'boolean' ? c : toNumber(c) !== 0;
    if (truthy) return ev(args[1], sheet);
    return args.length === 3 ? ev(args[2], sheet) : false;
  }
};

function ev(node, sheet) {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'bool': return node.v;
    case 'ref': return sheet.value(node.v);
    case 'range': throw new ExcelError('#VALUE!: a range outside a function');
    case 'neg': return -toNumber(ev(node.a, sheet));
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new ExcelError('Unsupported function ' + node.name);
      return fn(node.args, sheet);
    }
    case 'bin': {
      const a = ev(node.a, sheet), b = ev(node.b, sheet);
      switch (node.op) {
        case '+': return toNumber(a) + toNumber(b);
        case '-': return toNumber(a) - toNumber(b);
        case '*': return toNumber(a) * toNumber(b);
        case '/': {
          const d = toNumber(b);
          if (d === 0) throw new ExcelError('#DIV/0!');
          return toNumber(a) / d;
        }
        case '^': return Math.pow(toNumber(a), toNumber(b));
        case '&': return (a === BLANK ? '' : String(a)) + (b === BLANK ? '' : String(b));
        case '=': return compare(a, b) === 0;
        case '<>': return compare(a, b) !== 0;
        case '<': return compare(a, b) < 0;
        case '>': return compare(a, b) > 0;
        case '<=': return compare(a, b) <= 0;
        case '>=': return compare(a, b) >= 0;
        default: throw new ExcelError('Unknown operator ' + node.op);
      }
    }
    default:
      throw new ExcelError('Unknown node ' + node.k);
  }
}

/** Evaluates a formula (with or without a leading '=') against a sheet from createSheet. */
function evaluate(formula, sheet) {
  return ev(parse(formula), sheet || createSheet({}));
}

module.exports = { evaluate, createSheet, parse, tokenize, excelRound, naiveRound, expandRange, splitRef, refName, ExcelError };
