/* Grade Tracker - CSV / TSV parsing and writing (RFC 4180), including the tab-separated text that
 * Excel and Google Sheets put on the clipboard. Pure; runs in the browser (GT.csv) and in Node. */
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;

  var AUTO_DELIMITERS = ['\t', ',', ';'];

  function toText(text) {
    return text === null || text === undefined ? '' : String(text);
  }

  function stripBom(s) {
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  }

  /** Picks the delimiter among tab, comma and semicolon that occurs most often, outside quotes, in
   * the first non-empty line. A tab wins whenever it is present; a comma wins ties; no candidate
   * at all gives a comma. */
  function detectDelimiter(text) {
    var s = stripBom(toText(text));
    var counts = { '\t': 0, ',': 0, ';': 0 };
    var inQuotes = false, fieldStart = true, content = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (s.charAt(i + 1) === '"') i++;
          else inQuotes = false;
        }
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        if (content) break;          // end of the first non-empty line
        fieldStart = true;
        continue;
      }
      if (ch === '"' && fieldStart) { inQuotes = true; content = true; fieldStart = false; continue; }
      if (ch === '\t' || ch === ',' || ch === ';') {
        counts[ch]++;
        content = true;
        fieldStart = true;
        continue;
      }
      if (ch !== ' ') content = true;
      fieldStart = false;
    }
    if (counts['\t'] > 0) return '\t';
    return counts[';'] > counts[','] ? ';' : ',';
  }

  /** Core RFC 4180 reader. A field is quoted only when it starts with a quote and its closing quote
   * is followed by the delimiter, a line break or the end of the text; any other quote (for example
   * 5" or an unterminated "abc) is read as plain text. A text that ends with a line break has no
   * extra empty row (a single trailing empty line is dropped). */
  function parseCore(s, delim) {
    var rows = [], row = [], field = '';
    var quoted = false, fieldStart = true, literalAt = -1;
    var n = s.length, i = 0;
    while (i < n) {
      var ch = s.charAt(i);
      if (fieldStart && ch === '"' && i !== literalAt) {
        var j = i + 1, parts = [], from = j, closed = false;
        while (j < n) {
          if (s.charAt(j) === '"') {
            if (s.charAt(j + 1) === '"') { parts.push(s.slice(from, j + 1)); j += 2; from = j; continue; }
            var next = j + 1 < n ? s.charAt(j + 1) : '';
            closed = next === '' || next === delim || next === '\r' || next === '\n';
            break;
          }
          j++;
        }
        if (closed) {
          parts.push(s.slice(from, j));
          field = parts.join('');
          quoted = true;
          fieldStart = false;
          i = j + 1;
          continue;
        }
        literalAt = i; // malformed quoted field: read it as plain text
        continue;
      }
      fieldStart = false;
      if (ch === delim) {
        row.push(field);
        field = '';
        quoted = false;
        fieldStart = true;
        i++;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        quoted = false;
        fieldStart = true;
        i += ch === '\r' && s.charAt(i + 1) === '\n' ? 2 : 1;
        continue;
      }
      field += ch;
      i++;
    }
    if (row.length || field !== '' || quoted) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function validDelimiter(d) {
    return typeof d === 'string' && d.length === 1 && d !== '"' && d !== '\r' && d !== '\n';
  }

  /** Parses CSV/TSV text into rows of strings.
   * opts.delimiter: 'auto' (default), ',', ';' or '\t'. Handles quoted fields, doubled quotes,
   * line breaks inside quotes, a UTF-8 BOM, and CRLF, LF or CR line endings. */
  function parse(text, opts) {
    var s = stripBom(toText(text));
    var d = opts && opts.delimiter;
    if (d === 'auto' || !validDelimiter(d)) d = detectDelimiter(s);
    return parseCore(s, d);
  }

  /** Parses clipboard text copied from Excel or Google Sheets (tab-separated) into rows of cells.
   * One trailing line break is trimmed. Text without a tab is one cell per line, so a pasted
   * single column works; a single line without a tab is one cell, kept exactly. An empty clipboard
   * gives no rows; a copied empty cell (just a line break) gives one empty cell. */
  function parseClipboard(text) {
    var s = stripBom(toText(text));
    if (s === '') return [];
    if (s.slice(-2) === '\r\n') s = s.slice(0, -2);
    else if (s.slice(-1) === '\n' || s.slice(-1) === '\r') s = s.slice(0, -1);
    if (s.indexOf('\t') !== -1) {
      var rows = parseCore(s, '\t');
      // parseCore drops a trailing empty line; here the one trailing break is already gone, so an
      // empty last line left in the text is a real (empty) row.
      if (/(\r\n|\r|\n)$/.test(s)) rows.push(['']);
      return rows;
    }
    var lines = s.split(/\r\n|\r|\n/);
    if (lines.length === 1) return [[s]];
    if (s.indexOf('"') !== -1) {
      // A quoted cell with line breaks inside (an Excel cell with Alt+Enter) spans several lines.
      var quotedRows = parseCore(s, '\t');
      if (/(\r\n|\r|\n)$/.test(s)) quotedRows.push(['']);
      if (quotedRows.length !== lines.length) return quotedRows;
    }
    return lines.map(function (l) { return [l]; });
  }

  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
    return String(v);
  }

  var FORMULA_START = /^[=+\-@\t\r]/;

  /** Writes rows as CSV (or TSV with delimiter '\t').
   * opts: { delimiter = ',', bom = false, eol = '\r\n', guardFormulas = true }.
   * Fields containing the delimiter, a quote, CR or LF are quoted (quotes doubled). With
   * guardFormulas, a text cell starting with =, +, -, @, tab or CR gets a leading apostrophe so a
   * spreadsheet does not run it as a formula (CSV injection); JS numbers are written as they are.
   * Every row ends with the line ending, so parse(stringify(rows)) gives the rows back. */
  function stringify(rows, opts) {
    var o = opts || {};
    var d = typeof o.delimiter === 'string' && o.delimiter !== '' ? o.delimiter : ',';
    var eol = typeof o.eol === 'string' ? o.eol : '\r\n';
    var guard = o.guardFormulas !== false;
    var list = Array.isArray(rows) ? rows : [];
    var out = list.map(function (row) {
      var cells = Array.isArray(row) ? row : [row];
      return cells.map(function (v) {
        var s = cellText(v);
        if (guard && typeof v === 'string' && FORMULA_START.test(s)) s = "'" + s;
        if (s.indexOf(d) !== -1 || /["\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(d) + eol;
    }).join('');
    return (o.bom ? '﻿' : '') + out;
  }

  var api = {
    parse: parse,
    parseClipboard: parseClipboard,
    stringify: stringify,
    detectDelimiter: detectDelimiter,
    AUTO_DELIMITERS: AUTO_DELIMITERS
  };

  if (isNode) module.exports = api; else (root.GT = root.GT || {}).csv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
