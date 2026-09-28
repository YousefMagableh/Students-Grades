/* Grade Tracker - shared helpers (numbers, rounding, ids, dates, names, escaping).
 * Pure functions; runs in the browser (GT.util) and in Node (require). */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;

  /** Removes binary floating-point noise: 0.1 + 0.2 -> 0.3, 81.02499999999999 -> 81.025. */
  function fix(x) {
    if (x === null || x === undefined || typeof x !== 'number' || !isFinite(x)) return x;
    var r = Number(x.toFixed(10));
    return r === 0 ? 0 : r; // normalize -0
  }

  /** Round half away from zero to `decimals` places, like Excel ROUND. Exact on decimal inputs:
   * roundTo(81.025, 2) === 81.03 (plain Math.round(x * 100) / 100 gives 81.02). */
  function roundTo(x, decimals) {
    if (x === null || x === undefined || !isFinite(x)) return x;
    var d = decimals || 0;
    var v = fix(x);
    var sign = v < 0 ? -1 : 1;
    var abs = Math.abs(v);
    var s = String(abs);
    var out;
    if (s.indexOf('e') === -1) {
      // Shift the decimal point in the string representation, so 81.025 -> 8102.5 exactly.
      var shifted = Math.round(Number(s + 'e' + d));
      out = sign * Number(shifted + 'e-' + d);
    } else {
      var p = Math.pow(10, d);
      out = sign * (Math.round(abs * p) / p);
    }
    return out === 0 ? 0 : out;
  }

  var NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

  /** Parses a user-typed or pasted score. Accepts "88", " 88.5 ", "+7", "-3", ".5", "88%",
   * the unicode minus sign, and a trailing "%" (dropped). Commas are NOT accepted
   * (ambiguous between decimal and thousands separators), so "88,5" is invalid.
   * Returns { kind: 'empty' } | { kind: 'number', value } | { kind: 'invalid', text }. */
  function parseScoreInput(input) {
    if (input === null || input === undefined) return { kind: 'empty' };
    if (typeof input === 'number') {
      return isFinite(input) ? { kind: 'number', value: fix(input) } : { kind: 'invalid', text: String(input) };
    }
    var raw = String(input);
    var s = raw.replace(/ /g, ' ').trim();
    if (s === '') return { kind: 'empty' };
    s = s.replace(/^−/, '-');
    if (s.charAt(s.length - 1) === '%') s = s.slice(0, -1).trim();
    if (NUMBER_RE.test(s)) {
      var v = Number(s);
      if (isFinite(v)) return { kind: 'number', value: fix(v) };
    }
    return { kind: 'invalid', text: raw.trim() };
  }

  /** Parses a non-negative integer-ish field (weeks late, counts). Returns null when invalid/empty. */
  function parseCount(input) {
    var p = parseScoreInput(input);
    if (p.kind !== 'number' || p.value < 0) return null;
    return p.value;
  }

  /** Formats a number for display with at most `decimals` places, trimming trailing zeros
   * (81.35 with 2 -> "81.35", 74 with 2 -> "74", 81.025 with 2 -> "81.03").
   * Pass { fixed: true } to keep trailing zeros ("74.00"). null/undefined -> ''. */
  function formatNumber(x, decimals, opts) {
    if (x === null || x === undefined || x === '' || !isFinite(x)) return '';
    var d = decimals === undefined || decimals === null ? 2 : decimals;
    var r = roundTo(x, d);
    if (opts && opts.fixed) return r.toFixed(d);
    return String(r);
  }

  /** Formats a 0..100 percentage: formatPercent(12.5, 1) -> "12.5%". */
  function formatPercent(x, decimals) {
    if (x === null || x === undefined || !isFinite(x)) return '';
    return formatNumber(x, decimals === undefined ? 1 : decimals) + '%';
  }

  var idCounter = 0;
  /** Short unique id with a prefix: uid('s') -> "s_k3j9x2ab". */
  function uid(prefix) {
    var rand = '';
    var cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      var buf = new Uint32Array(2);
      cryptoObj.getRandomValues(buf);
      rand = buf[0].toString(36) + buf[1].toString(36);
    } else {
      rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    idCounter = (idCounter + 1) % 1679616;
    return (prefix || 'id') + '_' + rand.slice(0, 8) + idCounter.toString(36);
  }

  /** Deep clone of plain JSON data. */
  function clone(obj) {
    if (obj === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  }

  function isPlainObject(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  var COLLATOR = (typeof Intl !== 'undefined' && Intl.Collator)
    ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
    : null;

  /** Case-insensitive, numeric-aware string compare ("Student 2" < "Student 10"). */
  function compareText(a, b) {
    var x = a === null || a === undefined ? '' : String(a);
    var y = b === null || b === undefined ? '' : String(b);
    if (COLLATOR) return COLLATOR.compare(x, y);
    x = x.toLowerCase(); y = y.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- Dates (ISO "YYYY-MM-DD", computed in UTC so the local time zone never shifts a day) ----

  var ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function isIsoDate(s) {
    if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function dateToIso(d) {
    return d.toISOString().slice(0, 10);
  }

  function isoToDate(s) {
    return new Date(s + 'T00:00:00Z');
  }

  function addDays(iso, n) {
    var d = isoToDate(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return dateToIso(d);
  }

  /** 0 = Sunday … 6 = Saturday. */
  function weekday(iso) {
    return isoToDate(iso).getUTCDay();
  }

  var WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "2026-09-03" -> "Thu Sep 3". */
  function formatDateShort(iso) {
    if (!isIsoDate(iso)) return iso || '';
    var d = isoToDate(iso);
    return WEEKDAY_SHORT[d.getUTCDay()] + ' ' + MONTH_SHORT[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  /** Whole days between two ISO timestamps/dates (b - a), fractional allowed. */
  function daysBetween(aIso, bIso) {
    var a = new Date(aIso).getTime();
    var b = new Date(bIso).getTime();
    if (isNaN(a) || isNaN(b)) return null;
    return (b - a) / 86400000;
  }

  function sum(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return fix(s);
  }

  function debounce(fn, ms) {
    var t = null;
    var wrapped = function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
    wrapped.cancel = function () { if (t) clearTimeout(t); t = null; };
    wrapped.pending = function () { return t !== null; };
    return wrapped;
  }

  var api = {
    fix: fix,
    roundTo: roundTo,
    parseScoreInput: parseScoreInput,
    parseCount: parseCount,
    formatNumber: formatNumber,
    formatPercent: formatPercent,
    uid: uid,
    clone: clone,
    isPlainObject: isPlainObject,
    nowIso: nowIso,
    compareText: compareText,
    escapeHtml: escapeHtml,
    isIsoDate: isIsoDate,
    addDays: addDays,
    weekday: weekday,
    formatDateShort: formatDateShort,
    daysBetween: daysBetween,
    sum: sum,
    debounce: debounce,
    WEEKDAY_SHORT: WEEKDAY_SHORT,
    MONTH_SHORT: MONTH_SHORT
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).util = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
