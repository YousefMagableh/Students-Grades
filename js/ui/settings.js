/* Grade Tracker - Settings view (GT.views.settings).
 * Sections: grading status (finalized scores, final letters), needs confirmation (placeholders), course
 * details, assessments and weights (with the per-item drop-down list), grade calculation, letter scale,
 * and data & privacy. Browser only.
 *
 * Every course change goes through GT.store.transact (autosaved, undoable, logged in History).
 * Text inputs commit on Enter or when they lose focus; invalid input shows an inline error next to the
 * field and is not saved. A re-render replaces only the sections whose markup changed, and restores
 * focus (and any typed draft) by the field's data-field key.
 *
 * Finalized scores (STAGE2B): the controls that change totals (weights, max scores, rounding, curve) or
 * the suggested letters (cutoffs) show "Scores are finalized: changing this changes totals." and ask
 * before saving every change, with a preview of how many students are affected (also when none is
 * right now). A letter-scale change that would leave assigned final letters outside the scale asks
 * too, finalized or not. */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model, calc = GT.calc;
  var ui = GT.ui = GT.ui || {};
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  var SECTIONS = [
    { id: 'status', title: 'Grading status', icon: 'lock' },
    { id: 'confirm', title: 'Needs confirmation', icon: 'flag' },
    { id: 'course', title: 'Course details', icon: 'file' },
    { id: 'assessments', title: 'Assessments and weights', icon: 'layers' },
    { id: 'calc', title: 'Grade calculation', icon: 'settings' },
    { id: 'letters', title: 'Letter scale', icon: 'chart' },
    { id: 'data', title: 'Data & privacy', icon: 'database' }
  ];

  var LOCK_TOTALS = 'Scores are finalized: changing this changes totals.';
  var LOCK_LETTERS = 'Scores are finalized: changing this changes the suggested letters (final letters are not changed).';
  /** Drop-down step offered when the list is turned on: 0.5, or the first of these that fits the max score. */
  var STEP_CANDIDATES = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

  var CATEGORIES = [
    { value: 'project', label: 'Project' },
    { value: 'test', label: 'Test' },
    { value: 'participation', label: 'Participation' },
    { value: 'paper', label: 'Paper' },
    { value: 'other', label: 'Other' }
  ];

  var ROUNDING = [
    { value: 'none', label: 'None', long: 'No rounding' },
    { value: 'hundredth', label: 'Nearest 0.01', long: 'Nearest 0.01' },
    { value: 'integer', label: 'Nearest integer', long: 'Nearest integer' }
  ];

  /** Where each placeholder is edited in this view: section, the element carrying data-ph-anchor,
   * and what to focus inside it. lateWork and unexcusedThreshold are edited elsewhere (later views). */
  var PH_TARGET = {
    letterScale: { sec: 'letters', focus: '[data-role="ls-min"]' },
    passingLetter: { sec: 'letters', focus: 'select' },
    rounding: { sec: 'calc', focus: 'button[aria-pressed="true"]' },
    curve: { sec: 'calc', focus: 'input' },
    maxScores: { sec: 'assessments', focus: '[data-role="max-input"]' },
    projectSplit: { sec: 'assessments', focus: 'tr[data-cat="project"] button[data-act="split"], button[data-act="split"]' },
    termPaperWeight: { sec: 'assessments', focus: '[data-role="weight-input"]' }
  };

  var MAX_NAME = 80;
  var MAX_LETTER = 6;
  var CURVE_LIMIT = 100;
  var MAX_PARTS = 4;

  // ------------------------------------------------------------------ module state

  var boundEl = null;
  var courseId = null;
  var errors = Object.create(null);   // data-field key -> { text, msg, base } (unsaved invalid input)
  var pendingFocus = null;            // data-field key to focus after the next render
  var doneOpen = false;               // "Confirmed (n)" list expanded
  var rendering = false;
  var pointerDown = false, deferred = false, pointerTimer = null;
  var globalsBound = false;
  var lastParams = null;
  // courseId + '\n' + assessmentId -> { studentId: { teamId, key, prev } }: students who had no score when the
  // item was made team-graded here and received their team's score (key = entryKey of that score,
  // prev = their own entry before, null or late info only). Lets "Make individually graded" undo that fill.
  var teamFill = Object.create(null);
  var guarding = Object.create(null);  // data-field key -> true while its "scores are finalized" question is open
  var guardChain = Promise.resolve();  // those questions open one at a time

  // ------------------------------------------------------------------ small helpers

  function icon(name, cls) { return ui.icon(name, cls); }

  /** Numbers as entered (weights, cutoffs, max scores): up to 6 decimals, trailing zeros trimmed. */
  function num(x) { return util.formatNumber(x, 6); }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function badge(course, key, compact) {
    return ui.placeholderBadge ? ui.placeholderBadge(course, key, compact ? { compact: true } : null) : '';
  }

  function isUnconfirmed(course, key) {
    return model.placeholderKeys(course).indexOf(key) !== -1 && !model.isConfirmed(course, key);
  }

  function phNote(course, key) {
    var i = model.placeholderInfo(course, key);
    return i ? i.note : '';
  }

  function cssEsc(s) {
    if (root.CSS && root.CSS.escape) return root.CSS.escape(s);
    return String(s).replace(/["\\\]\[]/g, '\\$&');
  }

  function byField(host, key) {
    return host ? host.querySelector('[data-field="' + cssEsc(key) + '"]') : null;
  }

  function domId(key) { return 'sf-' + String(key).replace(/[^A-Za-z0-9_-]/g, '_'); }

  /** "kind:id:prop" -> parts. The id may itself contain ':' (it sits between the first and last ':'). */
  function splitKey(key) {
    var i = key.indexOf(':'), j = key.lastIndexOf(':');
    if (i === -1) return { kind: key, id: '', prop: '' };
    return { kind: key.slice(0, i), id: i === j ? '' : key.slice(i + 1, j), prop: key.slice(j + 1) };
  }

  function sortedScale(course) {
    return (course.settings.letterScale || []).slice().sort(function (a, b) { return b.min - a.min; });
  }

  function findLetter(list, letter) {
    for (var i = 0; i < list.length; i++) if (list[i].letter === letter) return list[i];
    return null;
  }

  /** Re-applies the letter-scale invariants after an edit (sorted, bottom row at 0, passing letter in the scale). */
  function normalizeScale(c) {
    c.settings.letterScale = model.normalizeLetterScale(c.settings.letterScale, c.level);
    c.settings.passingLetter = model.passingLetterFor(c.settings.letterScale, c.settings.passingLetter, c.level);
  }

  function nameTaken(course, name, exceptId) {
    var k = name.toLowerCase();
    return course.assessments.some(function (a) { return a.id !== exceptId && String(a.name || '').trim().toLowerCase() === k; });
  }

  function cleanText(t) { return String(t === null || t === undefined ? '' : t).replace(/\s+/g, ' ').trim(); }

  function actions() { return (GT.app && GT.app.actions) || {}; }

  function toastError(err) {
    ui.toast(err && err.message ? err.message : String(err), { type: 'error' });
  }

  /** Scores entered for an assessment: students who see a score, team scores, overrides. */
  function asmtStats(course, a) {
    var scored = 0, overrides = 0, teamScores = 0;
    course.students.forEach(function (s) {
      var e = model.effectiveEntry(course, s, a);
      if (model.hasScore(e)) scored++;
      if (a.teamGraded && s.teamId && model.findTeam(course, s.teamId)) {
        var own = model.getEntry(course.scores, s.id, a.id);
        if (own && own.override === true) overrides++;
      }
    });
    if (a.teamGraded) {
      course.teams.forEach(function (t) { if (model.hasScore(model.getEntry(course.teamScores, t.id, a.id))) teamScores++; });
    }
    return { scored: scored, overrides: overrides, teamScores: teamScores };
  }

  /** Decimal places of a number as num() shows it (0 to 6). */
  function decimalsOf(x) {
    var s = num(x);
    var i = s.indexOf('.');
    return i === -1 ? 0 : s.length - i - 1;
  }

  function fillKey(course, aid) { return course.id + '\n' + aid; }

  /** Members of a team-graded item who still show only the team score they received when it was made
   * team-graded here (same team, same score, no entry of their own since). Returns [{ studentId, prev }]. */
  function teamFillCandidates(course, a) {
    var rec = teamFill[fillKey(course, a.id)];
    if (!rec || !a.teamGraded) return [];
    var out = [];
    course.students.forEach(function (s) {
      var r = util.hasOwn(rec, s.id) ? rec[s.id] : null;
      if (!r || s.teamId !== r.teamId || !model.findTeam(course, s.teamId)) return;
      if (model.getEntry(course.scores, s.id, a.id)) return; // an override or entry of their own since
      var e = model.effectiveEntry(course, s, a);
      if (model.hasScore(e) && model.entryKey(e) === r.key) out.push({ studentId: s.id, prev: r.prev });
    });
    return out;
  }

  /** Letter ranges for a scale sorted high to low: "93–100", "90–92.99", …, "0–59.99".
   * A range ends one step below the cutoff above, in the finest decimals of the two cutoffs
   * (at least 0.01): with B+ at 89.995, B is "83–89.994" and B+ is "89.995–89.999". */
  function rangeTexts(scale) {
    return scale.map(function (r, i) {
      if (i === 0) return r.min >= 100 ? num(r.min) + ' and above' : num(r.min) + '–100';
      var above = scale[i - 1].min;
      var d = Math.max(2, decimalsOf(r.min), decimalsOf(above));
      var hi = util.roundTo(above - Math.pow(10, -d), d);
      return hi > r.min ? num(r.min) + '–' + num(hi) : num(r.min);
    });
  }

  function strictlyDecreasing(scale) {
    for (var i = 1; i < scale.length; i++) if (!(scale[i].min < scale[i - 1].min)) return false;
    return true;
  }

  // ------------------------------------------------------------------ finalized scores, final letters (STAGE2B)
  // The core helpers are used when present; the fallbacks keep this view working without them.

  function isLocked(course) {
    if (!course) return false;
    if (typeof model.isFinalized === 'function') {
      try { return !!model.isFinalized(course); } catch (e) { /* fall back */ }
    }
    return !!(util.isPlainObject(course.finalized) && typeof course.finalized.at === 'string' && course.finalized.at !== '');
  }

  function finalizedInfo(course) {
    return isLocked(course) ? course.finalized : null;
  }

  function finalLetterOf(s) {
    if (typeof model.finalLetterOf === 'function') return model.finalLetterOf(s);
    return s && typeof s.finalLetter === 'string' && s.finalLetter.trim() !== '' ? s.finalLetter : null;
  }

  function scaleLetters(course) {
    if (typeof model.scaleLetters === 'function') return model.scaleLetters(course);
    return sortedScale(course).map(function (r) { return r.letter; });
  }

  /** Inline notice shown on a control that changes totals (or the suggested letters) once scores are finalized. */
  function lockNoteHtml(course, kind, extra) {
    if (!isLocked(course)) return '';
    return '<div class="set-lock-note" role="note">' + icon('lock') + '<span>' + esc(kind === 'letters' ? LOCK_LETTERS : LOCK_TOTALS) +
      (extra ? ' ' + esc(extra) : '') + '</span></div>';
  }

  /** Callout for dialogs whose change affects totals, when the scores are finalized ('' otherwise). */
  function lockCalloutHtml(course, text) {
    var f = finalizedInfo(course);
    if (!f) return '';
    return '<div class="callout callout-warn set-lock-callout">' + icon('lock') + '<div><strong>Scores are finalized</strong>' +
      (f.at ? ' (' + esc(ui.dateTime(f.at)) + ')' : '') + '. ' + esc(text || 'Changing this changes totals.') + '</div></div>';
  }

  function sameNum(a, b) {
    var fa = typeof a === 'number' && isFinite(a), fb = typeof b === 'number' && isFinite(b);
    return fa && fb ? util.fix(a) === util.fix(b) : fa === fb;
  }

  /** What a change would do, worked out on a copy of the course: { active, totals, letters, finals, lost,
   * lostLetters, error }. totals / letters: active students whose total / suggested letter changes;
   * finals: those of them who already have a final letter; lost: students (any status) whose final letter
   * is in the scale now and would not be after the change. */
  function impactOf(course, apply) {
    var out = { active: 0, totals: 0, letters: 0, finals: 0, lost: 0, lostLetters: [], error: null };
    var before, after;
    try {
      var copy = util.clone(Object.assign({}, course, { history: [] }));
      apply(copy);
      before = GT.store.course() === course ? GT.store.results() : calc.computeCourse(course);
      after = calc.computeCourse(copy);
    } catch (err) {
      out.error = err;
      return out;
    }
    course.students.forEach(function (s) {
      var b = before.byId[s.id], a = after.byId[s.id];
      if (!b || !a) return;
      if (b.finalLetter !== null && b.finalLetter !== undefined && b.finalLetterValid !== false && a.finalLetterValid === false) {
        out.lost++;
        if (out.lostLetters.indexOf(b.finalLetter) === -1) out.lostLetters.push(b.finalLetter);
      }
      if (s.status === 'withdrawn') return;
      out.active++;
      var t = !sameNum(b.total, a.total), l = b.letter !== a.letter;
      if (t) out.totals++;
      if (l) out.letters++;
      if ((t || l) && a.finalLetter !== null && a.finalLetter !== undefined) out.finals++;
    });
    return out;
  }

  /** Dialog text for an impact: the finalized callout plus what changes. kind 'totals' | 'letters'. */
  function impactHtml(course, im, kind) {
    var h = lockCalloutHtml(course, kind === 'letters' ? 'Changing this changes the suggested letters.' : 'Changing this changes totals.');
    var li = [];
    if (im.active && isLocked(course) && !im.error && !im.totals && !im.letters) {
      // Finalized: asked anyway (a later score or scale change could make it matter), so say it is harmless now.
      li.push('<li>' + (kind === 'letters' ? 'No suggested letter changes' : 'No total or suggested letter changes') + ' right now (' +
        plural(im.active, 'active student') + ' checked).</li>');
    } else if (im.active && isLocked(course)) {
      if (kind !== 'letters') li.push('<li>Totals change for <strong>' + im.totals + ' of ' + plural(im.active, 'active student') + '</strong>.</li>');
      li.push('<li>The suggested letter changes for <strong>' + im.letters + (kind === 'letters' ? ' of ' + plural(im.active, 'active student') : '') + '</strong>.</li>');
      if (im.finals) {
        li.push('<li><strong>' + plural(im.finals, 'student') + ' with a final letter ' + (im.finals === 1 ? 'is' : 'are') + ' affected.</strong> ' +
          'Final letters are never changed automatically: check them after this change.</li>');
      }
    }
    if (im.lost) {
      li.push('<li><strong>' + plural(im.lost, 'student has', 'students have') + ' the final letter ' + esc(im.lostLetters.join(', ')) + '</strong>, which would no longer be ' +
        'in the scale. ' + (im.lost === 1 ? 'It is kept' : 'They are kept') + ' and shown in red in the grid until you choose another letter.</li>');
    }
    if (li.length) h += '<ul class="set-dlg-list">' + li.join('') + '</ul>';
    return h + '<p class="muted">The change is logged in History and can be undone (Ctrl+Z).' + (isLocked(course) ? ' The scores stay finalized.' : '') + '</p>';
  }

  /** Runs o.run() now, unless the change needs a question first: the scores are finalized (every change
   * of a setting that affects totals or suggested letters asks, even when no student's total or letter
   * changes right now; the dialog then says so), or final letters would leave the scale. Then it asks
   * (one question at a time, after the current event) and runs o.run() or o.cancel().
   * o: { label, kind: 'totals'|'letters', apply(courseCopy), run(), cancel?(), confirmText? } */
  function guardChange(o) {
    var course = GT.store.course();
    if (!course) return;
    var locked = isLocked(course);
    var im = locked || o.kind === 'letters' ? impactOf(course, o.apply) : null;
    var ask = locked || (!!im && !im.error && im.lost > 0);
    if (!ask) { o.run(); return; }
    function cancel() { if (o.cancel) o.cancel(); }
    guardChain = guardChain.then(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 0); });
    }).then(function () {
      return ui.dialog.open({
        title: locked ? 'Change finalized scores?' : 'Final letters would leave the scale',
        bodyHtml: '<p class="set-dlg-change">' + esc(o.label) + '</p>' + impactHtml(course, im, o.kind),
        buttons: [
          { text: 'Cancel', value: false },
          { text: o.confirmText || 'Change anyway', value: true, primary: true }
        ],
        initialFocus: '.dlg-foot .btn:not(.btn-primary)'
      });
    }).then(function (ok) {
      if (ok) o.run(); else cancel();
    }, function (err) {
      cancel();
      toastError(err);
    }).then(null, toastError);
  }

  // ------------------------------------------------------------------ drop-down lists (DECISIONS 8)

  function choiceList(a) {
    return typeof model.choiceValues === 'function' ? model.choiceValues(a) : [];
  }

  /** The step to offer when a list is turned on: 0.5 when it fits the max score, else the first larger one that does. */
  function defaultStep(max) {
    var limit = model.MAX_CHOICE_STEPS || 200;
    if (!(max > 0)) return 0.5;
    for (var i = 0; i < STEP_CANDIDATES.length; i++) {
      var st = STEP_CANDIDATES[i];
      if (st <= max && util.fix(max / st) <= limit) return st;
    }
    return max < 0.5 ? util.fix(max / 10) : max;
  }

  /** "5, 4.5, 4 … 0 · 11 values" */
  function choicePreview(values) {
    if (!values.length) return '';
    var shown = values.length <= 6 ? values.map(num).join(', ')
      : values.slice(0, 3).map(num).join(', ') + ' … ' + num(values[values.length - 1]);
    return shown + ' · ' + plural(values.length, 'value');
  }

  /** Students whose current score for `a` is a number that is not on a list with this step. */
  function offListCount(course, a, step) {
    var test = { id: a.id, maxScore: a.maxScore, choices: { step: step } };
    if (typeof model.isChoiceValue !== 'function') return 0;
    var n = 0;
    course.students.forEach(function (s) {
      var e = model.effectiveEntry(course, s, a);
      if (e && typeof e.value === 'number' && !model.isChoiceValue(test, e.value)) n++;
    });
    return n;
  }

  // ------------------------------------------------------------------ inputs

  function fieldError(key, stored) {
    var e = errors[key];
    if (!e) return null;
    if (e.base !== stored) { delete errors[key]; return null; } // the saved value changed since (undo, other edit)
    return e;
  }

  /** Text input bound to a data-field key. It shows the unsaved invalid text and its error when there is one.
   * o: { id, label (aria-label), role, aid, numeric, maxlength, placeholder, cls } */
  function inputHtml(key, stored, o) {
    o = o || {};
    var err = fieldError(key, stored);
    var id = o.id || domId(key);
    return '<input type="text" id="' + esc(id) + '" class="' + esc((o.cls || '') + (err ? ' is-invalid' : '')) + '" data-field="' + esc(key) + '"' +
      (o.role ? ' data-role="' + esc(o.role) + '"' : '') +
      (o.aid ? ' data-aid="' + esc(o.aid) + '"' : '') +
      (o.numeric ? ' inputmode="decimal"' : '') +
      (o.maxlength ? ' maxlength="' + o.maxlength + '"' : '') +
      (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') +
      (o.label ? ' aria-label="' + esc(o.label) + '"' : '') +
      (err ? ' aria-invalid="true" aria-describedby="' + esc(id) + '-err"' : '') +
      ' value="' + esc(err ? err.text : stored) + '" autocomplete="off" spellcheck="false">' +
      (err ? '<div class="set-error" id="' + esc(id) + '-err" role="alert">' + icon('alert') + '<span>' + esc(err.msg) + '</span></div>' : '');
  }

  function textField(key, label, stored, o) {
    o = o || {};
    var id = domId(key);
    return '<div class="field set-field">' +
      '<label for="' + esc(id) + '">' + esc(label) + (o.badge || '') + '</label>' +
      (o.suffix ? '<div class="set-input-suffix">' : '') +
      inputHtml(key, stored, { id: id, numeric: o.numeric, placeholder: o.placeholder, cls: o.cls, maxlength: o.maxlength }) +
      (o.suffix ? '<span class="muted">' + esc(o.suffix) + '</span></div>' : '') +
      (o.help ? '<div class="help">' + o.help + '</div>' : '') + '</div>';
  }

  function selectHtml(key, value, options, o) {
    o = o || {};
    return '<select id="' + esc(o.id || domId(key)) + '" data-field="' + esc(key) + '"' + (o.label ? ' aria-label="' + esc(o.label) + '"' : '') +
      (o.cls ? ' class="' + esc(o.cls) + '"' : '') + '>' +
      options.map(function (op) {
        return '<option value="' + esc(op.value) + '"' + (String(op.value) === String(value) ? ' selected' : '') + '>' + esc(op.label) + '</option>';
      }).join('') + '</select>';
  }

  function selectField(key, label, value, options, o) {
    o = o || {};
    var id = domId(key);
    return '<div class="field set-field"' + (o.anchor ? ' data-ph-anchor="' + esc(o.anchor) + '"' : '') + '>' +
      '<label for="' + esc(id) + '">' + esc(label) + (o.badge || '') + '</label>' +
      selectHtml(key, value, options, { id: id }) +
      (o.help ? '<div class="help">' + o.help + '</div>' : '') + '</div>';
  }

  // ------------------------------------------------------------------ field handlers (text inputs)
  // Each handler: { stored: string shown when there is no error, parse(text) -> { value } | { error },
  //                 same(value) -> bool, label(value) -> undo/transaction label, apply(course, value) }.

  function handlerFor(course, key) {
    var k = splitKey(key);
    if (k.kind === 'course') return courseHandler(course, k.prop);
    if (k.kind === 'a') {
      var a = model.findAssessment(course, k.id);
      return a ? assessmentHandler(course, a, k.prop) : null;
    }
    if (k.kind === 'calc' && k.prop === 'curve') return curveHandler(course);
    if (k.kind === 'ls') return letterHandler(course, parseInt(k.id, 10), k.prop);
    return null;
  }

  function courseHandler(course, prop) {
    var names = { code: 'course code', title: 'course title', term: 'term' };
    if (!util.hasOwn(names, prop)) return null;
    var stored = typeof course[prop] === 'string' ? course[prop] : '';
    return {
      stored: stored,
      parse: function (t) {
        var v = cleanText(t);
        if (prop === 'code' && !v) return { error: 'Enter a course code, for example SE 4351.' };
        if (v.length > 120) return { error: 'Keep it under 120 characters.' };
        return { value: v };
      },
      same: function (v) { return v === stored; },
      label: function () { return 'Edit ' + names[prop]; },
      apply: function (c, v) { c[prop] = v; }
    };
  }

  function assessmentHandler(course, a, prop) {
    var aid = a.id;
    if (prop === 'name') {
      return {
        stored: a.name,
        parse: function (t) {
          var v = cleanText(t);
          if (!v) return { error: 'Enter a name.' };
          if (v.length > MAX_NAME) return { error: 'Keep the name under ' + MAX_NAME + ' characters.' };
          if (nameTaken(course, v, aid)) return { error: 'Another assessment is already named "' + v + '".' };
          return { value: v };
        },
        same: function (v) { return v === a.name; },
        label: function (v) { return 'Rename ' + a.name + ' to ' + v; },
        apply: function (c, v) { var x = model.findAssessment(c, aid); if (x) x.name = v; }
      };
    }
    if (prop === 'max') {
      var listStep = choiceList(a).length ? a.choices.step : null;
      var limit = model.MAX_CHOICE_STEPS || 200;
      return {
        stored: String(a.maxScore),
        totals: 'totals',
        parse: function (t) {
          var p = util.parseScoreInput(t);
          if (p.kind !== 'number' || !(p.value > 0)) return { error: 'Max score must be a number above 0, for example 100.' };
          if (listStep && (util.fix(p.value / listStep) > limit || listStep > p.value)) {
            return {
              error: 'With the drop-down list in steps of ' + num(listStep) + ', the max score must be between ' + num(listStep) + ' and ' +
                num(util.fix(listStep * limit)) + '. Change the step first, or turn the list off.'
            };
          }
          return { value: p.value };
        },
        same: function (v) { return v === a.maxScore; },
        label: function (v) { return 'Change max score of ' + a.name + ' to ' + num(v); },
        apply: function (c, v) { var x = model.findAssessment(c, aid); if (x) x.maxScore = v; }
      };
    }
    if (prop === 'weight') {
      return {
        stored: String(a.weight),
        totals: 'totals',
        parse: function (t) {
          var p = util.parseScoreInput(t);
          if (p.kind !== 'number' || p.value < 0) return { error: 'Weight must be a number, 0 or more (for example 25).' };
          return { value: p.value };
        },
        same: function (v) { return v === a.weight; },
        label: function (v) { return 'Change weight of ' + a.name + ' to ' + num(v) + '%'; },
        apply: function (c, v) { var x = model.findAssessment(c, aid); if (x) x.weight = v; }
      };
    }
    if (prop === 'step') {
      if (!choiceList(a).length) return null;
      var cur = a.choices.step;
      var maxSteps = model.MAX_CHOICE_STEPS || 200;
      return {
        stored: String(cur),
        parse: function (t) {
          var p = util.parseScoreInput(t);
          if (p.kind !== 'number' || !(p.value > 0)) return { error: 'The step must be a number above 0, for example 0.5.' };
          if (p.value > a.maxScore) return { error: 'The step must be at most the max score (' + num(a.maxScore) + ').' };
          if (util.fix(a.maxScore / p.value) > maxSteps) {
            return { error: 'Too many values: with max ' + num(a.maxScore) + ' the step must be at least ' + num(util.fix(a.maxScore / maxSteps)) + ' (at most ' + maxSteps + ' steps).' };
          }
          return { value: p.value };
        },
        same: function (v) { return v === cur; },
        label: function (v) { return 'Set the ' + a.name + ' drop-down list to steps of ' + num(v); },
        apply: function (c, v) { var x = model.findAssessment(c, aid); if (x) x.choices = { step: v }; }
      };
    }
    return null;
  }

  function curveHandler(course) {
    var cur = course.settings.curve || 0;
    return {
      stored: String(cur),
      totals: 'totals',
      parse: function (t) {
        var p = util.parseScoreInput(t);
        if (p.kind === 'empty') return { value: 0 };
        if (p.kind !== 'number' || Math.abs(p.value) > CURVE_LIMIT) {
          return { error: 'Enter points between -' + CURVE_LIMIT + ' and ' + CURVE_LIMIT + ' (0 = no curve).' };
        }
        return { value: p.value };
      },
      same: function (v) { return v === cur; },
      label: function (v) { return v ? 'Set curve to ' + num(v) + ' points' : 'Remove curve'; },
      apply: function (c, v) { c.settings.curve = v; }
    };
  }

  function letterHandler(course, i, prop) {
    var scale = sortedScale(course);
    var row = scale[i];
    if (!row || i === scale.length - 1) return null; // the bottom row (0) is fixed
    if (prop === 'letter') {
      return {
        stored: row.letter,
        totals: 'letters',
        parse: function (t) {
          var v = String(t).trim();
          if (!v) return { error: 'Enter a letter.' };
          if (v.length > MAX_LETTER) return { error: 'Use at most ' + MAX_LETTER + ' characters.' };
          var dup = scale.some(function (r, k) { return k !== i && r.letter.toLowerCase() === v.toLowerCase(); });
          if (dup) return { error: v + ' is already in the scale.' };
          return { value: v };
        },
        same: function (v) { return v === row.letter; },
        label: function (v) { return 'Rename letter ' + row.letter + ' to ' + v; },
        apply: function (c, v) {
          var r = findLetter(c.settings.letterScale, row.letter);
          if (!r) return;
          r.letter = v;
          if (c.settings.passingLetter === row.letter) c.settings.passingLetter = v;
          normalizeScale(c);
        }
      };
    }
    if (prop === 'min') {
      var above = i > 0 ? scale[i - 1] : null;
      var below = scale[i + 1];
      var between = above
        ? 'Enter a cutoff below ' + num(above.min) + ' (' + above.letter + ') and above ' + num(below.min) + ' (' + below.letter + ').'
        : 'Enter a cutoff above ' + num(below.min) + ' (' + below.letter + ').';
      return {
        stored: String(row.min),
        totals: 'letters',
        parse: function (t) {
          var p = util.parseScoreInput(t);
          if (p.kind !== 'number') return { error: 'Enter a number, for example 90.' };
          if (p.value <= 0) return { error: 'Only the lowest letter starts at 0. ' + between };
          if ((above && p.value >= above.min) || p.value <= below.min) {
            return { error: 'Cutoffs must decrease from top to bottom. ' + between };
          }
          return { value: p.value };
        },
        same: function (v) { return v === row.min; },
        label: function (v) { return 'Change cutoff for ' + row.letter + ' to ' + num(v); },
        apply: function (c, v) {
          var r = findLetter(c.settings.letterScale, row.letter);
          if (!r) return;
          r.min = v;
          normalizeScale(c);
        }
      };
    }
    return null;
  }

  // ------------------------------------------------------------------ render: header, table of contents

  function cardHead(sec, title, subHtml, rightHtml) {
    var s = SECTIONS.filter(function (x) { return x.id === sec; })[0];
    return '<div class="card-header"><div class="set-card-title">' +
      '<h2 id="set-h-' + sec + '" tabindex="-1" data-field="h:' + sec + '">' + icon(s ? s.icon : 'settings') + '<span>' + esc(title) + '</span></h2>' +
      (subHtml ? '<p class="set-card-sub">' + subHtml + '</p>' : '') + '</div>' +
      (rightHtml ? '<div class="set-card-actions">' + rightHtml + '</div>' : '') + '</div>';
  }

  function headHtml(course) {
    return '<div class="page-header set-head"><div><h1>Settings</h1><div class="sub">' +
      esc(model.courseLabel(course)) + (course.term ? ' · ' + esc(course.term) : '') +
      ' · Changes are saved automatically and can be undone (Ctrl+Z).</div></div></div>';
  }

  function tocHtml(course) {
    var pending = model.unconfirmedPlaceholders(course).length;
    var w = calc.weightStatus(course);
    return '<div class="section-label">On this page</div><ul>' + SECTIONS.map(function (s) {
      var extra = '';
      if (s.id === 'confirm' && pending) {
        extra = '<span class="set-toc-count" title="' + pending + ' placeholder settings need confirmation">' + pending + '</span>';
      }
      if (s.id === 'assessments' && !w.ok) {
        extra = '<span class="set-toc-warn" title="Weights add up to ' + esc(num(w.sum)) + '%, not 100%">' + icon('alert', 'icon-sm') +
          '<span class="sr-only">Weights do not add up to 100%</span></span>';
      }
      if (s.id === 'status' && isLocked(course)) {
        extra = '<span class="set-toc-lock" title="Scores are finalized">' + icon('check', 'icon-sm') + '<span class="sr-only">Scores are finalized</span></span>';
      }
      return '<li><button type="button" class="set-toc-link" data-act="goto-sec" data-sec="' + s.id + '" data-field="toc:' + s.id + '">' +
        icon(s.icon) + '<span class="set-toc-text">' + esc(s.title) + '</span>' + extra + '</button></li>';
    }).join('') + '</ul>';
  }

  // ------------------------------------------------------------------ render: 0. grading status (STAGE2B)

  /** Final-letter counts over active students: from calc's letterSummary when present, else counted here. */
  function letterCounts(course, results) {
    var active = course.students.filter(function (s) { return s.status !== 'withdrawn'; });
    var byLetter = Object.create(null);
    var out = { active: active.length, assigned: 0, unassigned: 0, manualDiffers: 0, invalid: 0, fillable: 0, orderIssues: 0, byLetter: byLetter };
    var letters = scaleLetters(course);
    active.forEach(function (s) {
      var r = results && results.byId ? results.byId[s.id] : null;
      var fl = finalLetterOf(s);
      if (fl === null) {
        out.unassigned++;
        if (r && letters.indexOf(r.letter) !== -1) out.fillable++;
        return;
      }
      out.assigned++;
      byLetter[fl] = (byLetter[fl] || 0) + 1;
      if (r && r.letterDiffers) out.manualDiffers++;
      if (letters.indexOf(fl) === -1) out.invalid++;
    });
    var sm = results && results.letterSummary;
    if (sm && typeof sm.assigned === 'number') {
      out.assigned = sm.assigned;
      out.unassigned = sm.unassigned;
      if (typeof sm.manualDiffers === 'number') out.manualDiffers = sm.manualDiffers;
      if (typeof sm.invalid === 'number') out.invalid = sm.invalid;
    }
    out.orderIssues = results && Array.isArray(results.orderIssues) ? results.orderIssues.length : 0;
    return out;
  }

  function statusHtml(course, results) {
    var f = finalizedInfo(course);
    var lc = letterCounts(course, results);
    var canCopy = typeof model.copySuggestedToFinal === 'function';
    var canUnlock = typeof model.unfinalize === 'function' || !!f;
    var right = f
      ? '<span class="badge badge-success">' + icon('lock') + 'Scores finalized</span>'
      : '<span class="badge">' + icon('edit') + 'Scores editable</span>';
    var h = cardHead('status', 'Grading status',
      'Enter every score, finalize the scores, then assign each final letter in the Grades tab (sorted by total). ' +
      'The letter from the cutoffs is only a suggestion; once assigned, the final letters are the grades.', right);
    h += '<div class="card-body"><div class="set-status-grid">';

    // Scores: finalized or not.
    h += '<div class="set-status-tile' + (f ? ' is-locked' : '') + '"><div class="set-status-label">Scores</div>';
    if (f) {
      h += '<div class="set-status-value">' + icon('lock') + '<span>Finalized</span></div>' +
        '<div class="set-status-sub">on ' + esc(ui.dateTime(f.at)) + (f.note ? ' · <span class="set-status-note">' + esc(f.note) + '</span>' : '') + '</div>' +
        '<p class="set-status-help">Score cells are locked in the Grades tab; final letters stay editable. ' +
        'Weights, max scores, rounding, curve and cutoffs ask before saving.</p>' +
        '<div class="set-status-actions"><button type="button" class="btn btn-sm" data-act="unlock" data-field="status:unlock"' + (canUnlock ? '' : ' disabled') + '>' +
        icon('lock') + 'Unlock scores…</button></div>';
    } else {
      var canFinalize = typeof ui.openFinalize === 'function';
      h += '<div class="set-status-value"><span>Not finalized</span></div>' +
        '<div class="set-status-sub">Scores can be edited.</div>' +
        '<p class="set-status-help">When every score is in, use <strong>Finalize scores…</strong> in the Grades tab: it checks for missing ' +
        'or invalid scores first, then locks the score cells.</p>' +
        '<div class="set-status-actions">' + (canFinalize
          ? '<button type="button" class="btn btn-sm" data-act="finalize" data-field="status:finalize">' + icon('lock') + 'Finalize scores…</button>'
          : '<button type="button" class="btn btn-sm" data-act="open-view" data-view="grades" data-field="status:grades">' + icon('grid') + 'Open Grades</button>') +
        '</div>';
    }
    h += '</div>';

    // Final letters.
    var all = lc.active > 0 && lc.unassigned === 0;
    var pct = lc.active ? Math.round(100 * lc.assigned / lc.active) : 0;
    h += '<div class="set-status-tile"><div class="set-status-label">Final letters</div>';
    if (!lc.active) {
      h += '<div class="set-status-value"><span>No active students</span></div><div class="set-status-sub">Add students first.</div>';
    } else {
      h += '<div class="set-status-value' + (all ? ' is-ok' : '') + '">' + (all ? icon('check') : '') +
        '<span><span class="num">' + lc.assigned + '</span> of <span class="num">' + lc.active + '</span> assigned</span></div>' +
        '<div class="set-meter' + (all ? ' is-ok' : '') + '" role="img" aria-label="' + esc(pct + '% of active students have a final letter') + '">' +
        '<span class="set-meter-bar" style="width:' + pct + '%"></span></div>';
      var notes = [];
      notes.push(lc.unassigned
        ? '<li class="is-warn">' + icon('alert', 'icon-sm') + '<span>' + plural(lc.unassigned, 'active student') + ' without a final letter</span></li>'
        : '<li class="is-ok">' + icon('check', 'icon-sm') + '<span>Every active student has a final letter</span></li>');
      if (lc.manualDiffers) notes.push('<li>' + icon('info', 'icon-sm') + '<span>' + lc.manualDiffers + ' differ' + (lc.manualDiffers === 1 ? 's' : '') + ' from the cutoff suggestion</span></li>');
      if (lc.invalid) notes.push('<li class="is-bad">' + icon('alert', 'icon-sm') + '<span>' + plural(lc.invalid, 'final letter') + ' not in the current scale (shown in red): choose another letter</span></li>');
      if (lc.orderIssues) {
        notes.push('<li class="is-warn">' + icon('alert', 'icon-sm') + '<span>' + plural(lc.orderIssues, 'order issue') + ': a student with a lower total has a higher letter than one with a higher total</span></li>');
      }
      h += '<ul class="set-status-list">' + notes.join('') + '</ul>';
      var used = scaleLetters(course).filter(function (l) { return lc.byLetter[l]; });
      Object.keys(lc.byLetter).forEach(function (l) { if (used.indexOf(l) === -1) used.push(l); });
      if (used.length) {
        h += '<div class="set-letter-chips" aria-label="Final letters assigned">' + used.map(function (l) {
          return '<span class="chip">' + esc(l) + ' <span class="num">×' + lc.byLetter[l] + '</span></span>';
        }).join('') + '</div>';
      }
      h += '<div class="set-status-actions">' +
        '<button type="button" class="btn btn-sm" data-act="copy-suggested" data-field="status:copy"' + (canCopy && lc.fillable ? '' : ' disabled') + '>' +
        icon('copy') + 'Copy suggested letters into empty final letters' + (lc.fillable ? ' (' + lc.fillable + ')' : '') + '</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-act="open-view" data-view="grades" data-field="status:assign">' + icon('grid') + 'Assign in Grades</button></div>' +
        '<p class="set-status-help">Copying fills only the empty final letters of active students, in one step you can undo. ' +
        'Letters already chosen are not changed.</p>';
    }
    h += '</div></div>';
    return h + '</div>';
  }

  // ------------------------------------------------------------------ render: 1. needs confirmation

  function phCurrent(course, key) {
    var s = course.settings;
    switch (key) {
      case 'letterScale':
        return sortedScale(course).map(function (r) { return r.letter + ' ' + num(r.min); }).join(' · ');
      case 'rounding': {
        var r = ROUNDING.filter(function (x) { return x.value === s.rounding; })[0];
        return r ? r.long : String(s.rounding);
      }
      case 'curve':
        return s.curve ? (s.curve > 0 ? '+' : '') + num(s.curve) + ' points added to every total' : 'No curve (0 points)';
      case 'lateWork':
        return num(s.latePointsPerWeek) + ' points per week late on a 100-point score (scaled for other max scores), unless the penalty is waived';
      case 'maxScores':
        return course.assessments.map(function (a) { return a.name + ' ' + num(a.maxScore); }).join(' · ') || 'No assessments';
      case 'projectSplit': {
        var pr = course.assessments.filter(function (a) { return a.category === 'project'; });
        return pr.length ? pr.map(function (a) { return a.name + ' ' + num(a.weight) + '%' + (a.teamGraded ? ' (team)' : ''); }).join(' · ') : 'No project items';
      }
      case 'termPaperWeight': {
        var p = model.findAssessment(course, 'a_paper');
        return p ? p.name + ' ' + num(p.weight) + '%' : 'No term paper item';
      }
      case 'unexcusedThreshold': {
        // The placeholder also covers the optional total-absence threshold (DECISIONS 3).
        var att = course.attendance || {};
        var tt = typeof att.totalAbsenceThreshold === 'number' ? att.totalAbsenceThreshold : null;
        return 'Highlight students with more than ' + num(typeof att.unexcusedThreshold === 'number' ? att.unexcusedThreshold : 3) + ' unexcused absences' +
          ' · Total-absence threshold: ' + (tt === null ? 'off' : 'more than ' + num(tt) + ' absences in total') +
          (att.mode === 'off' || !att.mode ? ' · Attendance is off for this course' : '');
      }
      case 'passingLetter':
        return s.passingLetter + ' or better counts as passing';
      default:
        return '';
    }
  }

  function phItemHtml(course, p) {
    var t = PH_TARGET[p.key];
    var go = '';
    if (t) {
      go = '<button type="button" class="btn btn-sm btn-ghost" data-act="ph-goto" data-key="' + esc(p.key) + '" data-field="ph:' + esc(p.key) + ':goto">' +
        'Show setting' + icon('chevron-right') + '</button>';
    } else if (p.key === 'unexcusedThreshold' && GT.views.attendance) {
      go = '<button type="button" class="btn btn-sm btn-ghost" data-act="open-view" data-view="attendance" data-section="settings" data-field="ph:' + esc(p.key) + ':goto">' +
        'Open Attendance' + icon('chevron-right') + '</button>';
    }
    return '<li class="set-ph-item" data-ph="' + esc(p.key) + '">' +
      '<div class="set-ph-main"><div class="set-ph-title"><strong>' + esc(p.label) + '</strong>' + badge(course, p.key) + '</div>' +
      '<div class="set-ph-note">' + esc(p.note) + '</div>' +
      '<div class="set-ph-current"><span class="muted">Current value:</span> ' + esc(phCurrent(course, p.key)) + '</div></div>' +
      '<div class="set-ph-actions">' + go +
      '<button type="button" class="btn btn-sm" data-act="ph-confirm" data-key="' + esc(p.key) + '" data-field="ph:' + esc(p.key) + ':confirm">' +
      icon('check') + 'Mark confirmed</button></div></li>';
  }

  function doneItemHtml(course, p) {
    return '<li class="set-ph-item is-done" data-ph="' + esc(p.key) + '">' +
      '<div class="set-ph-main"><div class="set-ph-title">' + icon('check', 'set-ok-icon') + '<strong>' + esc(p.label) + '</strong>' +
      (p.confirmedAt ? '<span class="muted small">confirmed ' + esc(ui.dateTime(p.confirmedAt)) + '</span>' : '') + '</div>' +
      '<div class="set-ph-current"><span class="muted">Value:</span> ' + esc(phCurrent(course, p.key)) + '</div></div>' +
      '<div class="set-ph-actions"><button type="button" class="btn btn-sm" data-act="ph-unconfirm" data-key="' + esc(p.key) + '" data-field="ph:' + esc(p.key) + ':unconfirm">' +
      icon('undo') + 'Undo confirmation</button></div></li>';
  }

  function confirmHtml(course) {
    var infos = model.placeholderKeys(course).map(function (k) { return model.placeholderInfo(course, k); }).filter(Boolean);
    var pending = infos.filter(function (p) { return !p.confirmed; });
    var done = infos.filter(function (p) { return p.confirmed; });
    var right = pending.length
      ? '<span class="badge badge-warn">' + icon('alert') + esc(pending.length + ' to confirm') + '</span>'
      : '<span class="badge badge-success">' + icon('check') + 'All confirmed</span>';
    var h = cardHead('confirm', 'Needs confirmation',
      'Placeholder settings the instructor has not confirmed yet. They are used in every calculation as shown. ' +
      'Editing a value does not confirm it: each keeps a yellow badge until you mark it confirmed here.', right);
    h += '<div class="card-body">';
    if (pending.length) {
      h += '<ul class="set-ph-list">' + pending.map(function (p) { return phItemHtml(course, p); }).join('') + '</ul>';
    } else {
      h += '<div class="set-all-done">' + icon('check') + '<span>Every placeholder setting of this course is confirmed.</span></div>';
    }
    if (done.length) {
      h += '<details class="set-ph-done"' + (doneOpen ? ' open' : '') + '><summary data-field="ph:done:summary">' + icon('chevron-right', 'set-caret') +
        'Confirmed (' + done.length + ')</summary><ul class="set-ph-list">' +
        done.map(function (p) { return doneItemHtml(course, p); }).join('') + '</ul></details>';
    }
    return h + '</div>';
  }

  // ------------------------------------------------------------------ render: 2. course details

  function courseHtml(course) {
    var tpl = course.template === 'SE4351' ? 'Created from the SE 4351 template'
      : course.template === 'SE6362' ? 'Created from the SE 6362 template' : 'Custom course';
    var h = cardHead('course', 'Course details', 'Shown in the course switcher, exports and backups. Each course keeps its own students, scores, attendance, teams and settings.');
    h += '<div class="card-body"><div class="set-form-grid">' +
      textField('course:code', 'Course code', course.code || '', { placeholder: 'e.g. SE 4351', maxlength: 120 }) +
      textField('course:title', 'Course title', course.title || '', { placeholder: 'e.g. Requirements Engineering', maxlength: 120 }) +
      textField('course:term', 'Term', course.term || '', { placeholder: 'e.g. Fall 2026', maxlength: 120 }) +
      selectField('course:level', 'Level', course.level, [
        { value: 'undergraduate', label: 'Undergraduate' },
        { value: 'graduate', label: 'Graduate' }
      ], { help: 'Changing the level keeps the current letter scale. Use "Reset to default for this level" under Letter scale to switch scales.' }) +
      '</div><div class="set-course-actions">' +
      '<button type="button" class="btn btn-sm" data-act="dup-course" data-field="course:dup"' + (actions().duplicateCourse ? '' : ' disabled') + '>' + icon('copy') + 'Duplicate course</button>' +
      '<button type="button" class="btn btn-sm btn-danger" data-act="del-course" data-field="course:del"' + (actions().deleteCourse ? '' : ' disabled') + '>' + icon('trash') + 'Delete course…</button>' +
      '<span class="muted small">' + esc(tpl) + (course.createdAt ? ' · created ' + esc(ui.dateTime(course.createdAt)) : '') + '</span>' +
      '</div></div>';
    return h;
  }

  // ------------------------------------------------------------------ render: 3. assessments and weights

  function asmtRowHtml(course, a, i, n) {
    var st = asmtStats(course, a);
    var aid = a.id;
    var k = 'a:' + aid + ':';
    var grp = Math.min(i + 1, 6);
    var isPaper = a.id === 'a_paper' && isUnconfirmed(course, 'termPaperWeight');
    var sub = st.scored ? plural(st.scored, 'student') + ' scored' : 'No scores yet';
    if (a.teamGraded) {
      sub += ' · ' + plural(st.teamScores, 'team score');
      if (st.overrides) sub += ' · ' + st.overrides + ' override' + (st.overrides === 1 ? '' : 's') + ' ◆';
    }
    return '<tr data-aid="' + esc(aid) + '" data-cat="' + esc(a.category || 'other') + '"' + (a.id === 'a_paper' ? ' data-ph-anchor="termPaperWeight"' : '') + '>' +
      '<td class="set-order"><span class="set-swatch g' + grp + '" aria-hidden="true"></span>' +
      '<button type="button" class="btn btn-icon btn-sm btn-ghost" data-act="move" data-dir="-1" data-aid="' + esc(aid) + '" data-field="' + esc(k + 'up') + '"' +
      ' aria-label="Move ' + esc(a.name) + ' up" title="Move up"' + (i === 0 ? ' disabled' : '') + '>' + icon('sort-asc') + '</button>' +
      '<button type="button" class="btn btn-icon btn-sm btn-ghost" data-act="move" data-dir="1" data-aid="' + esc(aid) + '" data-field="' + esc(k + 'down') + '"' +
      ' aria-label="Move ' + esc(a.name) + ' down" title="Move down"' + (i === n - 1 ? ' disabled' : '') + '>' + icon('sort-desc') + '</button></td>' +
      '<td class="set-name-cell">' + inputHtml(k + 'name', a.name, { label: 'Name of ' + a.name, cls: 'set-in-name', maxlength: MAX_NAME + 20 }) +
      '<div class="set-sub">' + esc(sub) + '</div>' +
      (isPaper ? '<div class="set-row-note">' + badge(course, 'termPaperWeight') + '<span>' + esc(phNote(course, 'termPaperWeight')) + '</span></div>' : '') + '</td>' +
      '<td class="num">' + inputHtml(k + 'max', String(a.maxScore), { label: 'Max score of ' + a.name, cls: 'set-in-num', numeric: true, role: 'max-input', aid: aid }) + '</td>' +
      '<td class="num set-weight-cell"><div class="set-input-suffix">' + inputHtml(k + 'weight', String(a.weight), { label: 'Weight of ' + a.name + ' in percent', cls: 'set-in-num', numeric: true, role: 'weight-input', aid: aid }) +
      '<span class="muted">%</span></div></td>' +
      '<td class="set-center"><input type="checkbox" data-field="' + esc(k + 'team') + '" aria-label="' + esc(a.name + ' is team-graded') + '"' + (a.teamGraded ? ' checked' : '') + '></td>' +
      choicesCellHtml(a) +
      '<td>' + selectHtml(k + 'cat', a.category || 'other', CATEGORIES.some(function (c) { return c.value === a.category; }) ? CATEGORIES
        : CATEGORIES.concat([{ value: a.category, label: a.category }]), { label: 'Category of ' + a.name, cls: 'set-sel' }) + '</td>' +
      '<td class="set-row-actions">' +
      '<button type="button" class="btn btn-sm" data-act="split" data-aid="' + esc(aid) + '" data-field="' + esc(k + 'split') + '" title="Split ' + esc(a.name) + ' into 2 to 4 parts">Split…</button>' +
      '<button type="button" class="btn btn-sm btn-icon btn-ghost set-del" data-act="del-asmt" data-aid="' + esc(aid) + '" data-field="' + esc(k + 'del') + '"' +
      ' aria-label="Delete ' + esc(a.name) + '" title="Delete ' + esc(a.name) + '">' + icon('trash') + '</button></td></tr>';
  }

  /** "Drop-down list" cell: a checkbox, and when the list is on, its step and a preview of the values. */
  function choicesCellHtml(a) {
    var values = choiceList(a);
    var on = values.length > 0;
    var k = 'a:' + a.id + ':';
    var supported = typeof model.choiceValues === 'function';
    var h = '<td class="set-choices-cell"><label class="check set-choices-toggle"><input type="checkbox" data-field="' + esc(k + 'choices') + '"' +
      ' aria-label="' + esc('Pick ' + a.name + ' scores from a drop-down list') + '"' + (on ? ' checked' : '') + (supported ? '' : ' disabled') + '>' +
      '<span>' + (on ? 'On' : 'Off') + '</span></label>';
    if (on) {
      var id = domId(k + 'step');
      h += '<div class="set-input-suffix set-step-row"><label class="muted small" for="' + esc(id) + '">Step</label>' +
        inputHtml(k + 'step', String(a.choices.step), { id: id, label: 'Step of the ' + a.name + ' drop-down list', cls: 'set-in-num set-in-step', numeric: true, role: 'step-input', aid: a.id }) +
        '</div><div class="set-sub" data-role="step-preview" data-aid="' + esc(a.id) + '">' + esc(choicePreview(values)) + '</div>';
    }
    return h + '</td>';
  }

  function weightSumHtml(sum, ok, pending, bad) {
    var good = ok && !bad;
    var msg = 'Total weight: ' + num(sum) + '%';
    if (!ok) msg += ' — should be 100%. Totals use the weights as entered.';
    if (bad) msg += (ok ? ' (saved values).' : '') + ' A highlighted weight is not a number, so its saved value is counted.';
    else if (pending) msg += ' (Not saved yet: press Enter or leave the field.)';
    return '<span class="set-weight-icon">' + icon(good ? 'check' : 'alert') + '</span><span class="set-weight-text">' + esc(msg) + '</span>';
  }

  function assessmentsHtml(course) {
    var w = calc.weightStatus(course);
    var n = course.assessments.length;
    var right = badge(course, 'projectSplit') +
      '<button type="button" class="btn btn-sm btn-primary" data-act="add-asmt" data-field="asmt:add">' + icon('plus') + 'Add assessment</button>';
    var h = cardHead('assessments', 'Assessments and weights',
      'Recalculated instantly. Weighted points = raw ÷ max × weight; the weights should add up to 100%.', right);
    h += '<div class="card-body">';
    h += lockNoteHtml(course, 'totals', 'Max scores and weights, adding, deleting or splitting items, and team grading ask before saving.');
    if (isUnconfirmed(course, 'projectSplit')) {
      h += '<div class="callout callout-warn set-ph-callout" data-ph-anchor="projectSplit"><div class="set-ph-title"><strong>Project split</strong>' + badge(course, 'projectSplit') + '</div>' +
        '<div>' + esc(phNote(course, 'projectSplit')) + '</div><div class="muted small">Use <strong>Split…</strong> on a project row to divide it into parts, or rename items in place.</div></div>';
    }
    var lockMark = isLocked(course)
      ? ' <span class="set-lock-mark" title="' + esc(LOCK_TOTALS) + '">' + icon('lock', 'icon-sm') + '<span class="sr-only">' + esc(LOCK_TOTALS) + '</span></span>' : '';
    h += '<div class="table-wrap set-asmt-wrap" data-ph-anchor="maxScores"><table class="table set-asmt-table">' +
      '<thead><tr><th scope="col">Order</th><th scope="col">Name</th>' +
      '<th scope="col" class="num">Max score ' + badge(course, 'maxScores', true) + lockMark + '</th>' +
      '<th scope="col" class="num">Weight' + lockMark + '</th><th scope="col" class="set-center">Team-graded</th>' +
      '<th scope="col" title="Scores are picked from a list: max, max − step, …, 0">Drop-down list</th><th scope="col">Category</th>' +
      '<th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>';
    h += n ? course.assessments.map(function (a, i) { return asmtRowHtml(course, a, i, n); }).join('')
      : '<tr><td colspan="8" class="muted">No assessments yet. Add one to start grading.</td></tr>';
    h += '</tbody><tfoot><tr><td></td><th scope="row">Total weight</th><td></td>' +
      '<td class="num"><strong data-role="weight-foot" class="' + (w.ok ? 'set-ok' : 'set-warn') + '">' + esc(num(w.sum)) + '%</strong></td><td colspan="4"></td></tr></tfoot></table></div>';
    h += '<div class="set-weight-sum ' + (w.ok ? 'is-ok' : 'is-warn') + '" data-role="weight-sum" role="status" aria-live="polite">' + weightSumHtml(w.sum, w.ok, false, false) + '</div>';
    var notes = [];
    if (isUnconfirmed(course, 'maxScores')) {
      notes.push('<li>' + badge(course, 'maxScores') + '<span><strong>Max scores:</strong> ' + esc(phNote(course, 'maxScores')) + '</span></li>');
    }
    if (model.findAssessment(course, 'a_paper') && isUnconfirmed(course, 'termPaperWeight')) {
      notes.push('<li>' + badge(course, 'termPaperWeight') + '<span><strong>Term Paper weight:</strong> ' + esc(phNote(course, 'termPaperWeight')) + '</span></li>');
    }
    if (notes.length) h += '<ul class="set-notes">' + notes.join('') + '</ul>';
    h += '<p class="muted small set-help">A team-graded item gets one score per team, entered once and shared by every member. ' +
      'A different score for one member is a per-member override (◆), which needs the team\'s written agreement. ' +
      'Switching the team-graded setting keeps every entered score.</p>' +
      '<p class="muted small set-help"><strong>Drop-down list:</strong> the Grades tab offers the values max, max − step, …, 0 plus "(empty)", ' +
      'so no typos are possible (Class/Project Participation: 5, 4.5, …, 0). Typing a value from the list still works; anything else is refused. ' +
      'Scores entered before that are not on the list are kept and highlighted.</p>';
    return h + '</div>';
  }

  // ------------------------------------------------------------------ render: 4. grade calculation

  function calcHtml(course, results) {
    var s = course.settings;
    var dec = [0, 1, 2, 3, 4];
    if (dec.indexOf(s.decimals) === -1) dec.push(s.decimals);
    var h = cardHead('calc', 'Grade calculation', 'How the total is built from the weighted scores.');
    h += '<div class="card-body"><div class="set-calc-grid">';
    h += selectField('calc:decimals', 'Display decimals', s.decimals, dec.map(function (d) { return { value: d, label: String(d) }; }),
      { help: 'Display only: calculations keep full precision, so this never changes a grade. With 2, 81.025 shows as 81.03.' });
    var roundBadge = badge(course, 'rounding');
    h += '<div class="field set-field" data-ph-anchor="rounding"><span class="label" id="set-lbl-rounding">Rounding of the total' + roundBadge + '</span>' +
      '<div class="segmented" role="group" aria-labelledby="set-lbl-rounding">' + ROUNDING.map(function (r) {
        return '<button type="button" data-act="rounding" data-value="' + r.value + '" data-field="calc:rounding:' + r.value + '" aria-pressed="' + (s.rounding === r.value ? 'true' : 'false') + '">' + esc(r.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="help">Applied after the curve and before the letter grade. Nearest integer rounds halves away from zero, like Excel ROUND: 89.5 becomes 90.' +
      (roundBadge ? ' ' + esc(phNote(course, 'rounding')) : '') + '</div>' + lockNoteHtml(course, 'totals') + '</div>';
    var curveBadge = badge(course, 'curve');
    h += '<div data-ph-anchor="curve">' + textField('calc:curve', 'Curve (points added to every total)', String(s.curve || 0), {
      numeric: true, badge: curveBadge, cls: 'set-in-num', suffix: 'points',
      help: 'A flat number of points added to each total, for example 2. Use 0 for no curve.' + (curveBadge ? ' ' + esc(phNote(course, 'curve')) : '')
    }) + lockNoteHtml(course, 'totals') + '</div>';
    h += '</div>';
    h += '<div class="callout set-formula"><strong>How totals are calculated.</strong> Weighted = raw ÷ max × weight. ' +
      'Total = sum of weighted + curve, then rounded (if set). Empty scores count as 0. The letter grade comes from the rounded total.</div>';
    var active = results ? results.activeIds.map(function (id) { return results.byId[id]; }).filter(function (r) { return r && isFinite(r.total); }) : [];
    if (active.length) {
      var hi = Math.max.apply(null, active.map(function (r) { return r.total; }));
      var lo = Math.min.apply(null, active.map(function (r) { return r.total; }));
      h += '<p class="set-effect" data-role="calc-effect">' + icon('info', 'icon-sm') + ' Right now: class average <strong class="num">' + esc(ui.fmt(results.average)) + '</strong> ' +
        '(' + plural(active.length, 'active student') + ') · highest <span class="num">' + esc(ui.fmt(hi)) + '</span> · lowest <span class="num">' + esc(ui.fmt(lo)) + '</span></p>';
    } else {
      h += '<p class="set-effect muted" data-role="calc-effect">' + icon('info', 'icon-sm') + ' No active students yet: totals appear once students are added.</p>';
    }
    return h + '</div>';
  }

  // ------------------------------------------------------------------ render: 5. letter scale

  function lettersHtml(course, results) {
    var scale = sortedScale(course);
    var n = scale.length;
    var counts = {}, finals = {};
    if (results) {
      results.activeIds.forEach(function (id) {
        var r = results.byId[id];
        if (r && r.letter) counts[r.letter] = (counts[r.letter] || 0) + 1;
        var fl = r && typeof r.finalLetter === 'string' ? r.finalLetter : null;
        if (fl) finals[fl] = (finals[fl] || 0) + 1;
      });
    }
    var ranges = rangeTexts(scale);
    var passing = course.settings.passingLetter;
    var right = badge(course, 'letterScale') +
      '<button type="button" class="btn btn-sm" data-act="add-letter" data-field="ls:add">' + icon('plus') + 'Add letter</button>' +
      '<button type="button" class="btn btn-sm" data-act="reset-letters" data-field="ls:reset">' + icon('undo') + 'Reset to default for this level</button>';
    var h = cardHead('letters', 'Letter scale', 'A student gets the highest letter whose minimum total they reach. Ranges apply to the total after the curve and rounding.', right);
    h += '<div class="card-body">';
    h += lockNoteHtml(course, 'letters');
    if (isUnconfirmed(course, 'letterScale')) {
      h += '<div class="callout callout-warn set-ph-callout"><div class="set-ph-title"><strong>Letter-grade cutoffs</strong>' + badge(course, 'letterScale') + '</div><div>' +
        esc(phNote(course, 'letterScale')) + '</div></div>';
    }
    h += '<p class="muted small set-ls-intro">The cutoffs give each student a <strong>suggested</strong> letter. The final letter is chosen by hand in the ' +
      'Grades tab (a drop-down of these letters); the cutoffs never change a final letter.</p>';
    h += '<div class="table-wrap set-ls-wrap" data-ph-anchor="letterScale"><table class="table set-ls-table"><thead><tr>' +
      '<th scope="col">Letter</th><th scope="col" class="num">Minimum total</th><th scope="col">Range</th>' +
      '<th scope="col" class="num" title="Active students whose suggested letter (from the cutoffs) this is">Suggested</th>' +
      '<th scope="col" class="num" title="Active students who have this final letter">Final</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>';
    h += scale.map(function (r, i) {
      var bottom = i === n - 1;
      var k = 'ls:' + i + ':';
      var passMark = r.letter === passing ? ' <span class="badge badge-info" title="Lowest passing letter (pass rate)">lowest pass</span>' : '';
      return '<tr data-letter="' + esc(r.letter) + '"' + (bottom ? ' class="set-ls-bottom"' : '') + '>' +
        '<td>' + (bottom
          ? '<strong class="set-ls-fixed">' + esc(r.letter) + '</strong>'
          : inputHtml(k + 'letter', r.letter, { label: 'Letter ' + (i + 1), cls: 'set-in-letter', maxlength: MAX_LETTER, role: 'ls-letter' })) + '</td>' +
        '<td class="num">' + (bottom
          ? '<span class="set-ls-fixed num">0</span> <span class="muted small">(lowest, fixed)</span>'
          : inputHtml(k + 'min', String(r.min), { label: 'Minimum total for ' + r.letter, cls: 'set-in-num', numeric: true, role: 'ls-min' })) + '</td>' +
        '<td><span class="num" data-role="ls-range" data-i="' + i + '">' + esc(ranges[i]) + '</span>' + passMark + '</td>' +
        '<td class="num">' + (counts[r.letter] || 0) + '</td>' +
        '<td class="num">' + (finals[r.letter] || 0) + '</td>' +
        '<td class="set-row-actions">' + (bottom ? '' :
          '<button type="button" class="btn btn-sm btn-icon btn-ghost set-del" data-act="del-letter" data-letter="' + esc(r.letter) + '" data-field="' + esc(k + 'del') + '"' +
          ' aria-label="Remove letter ' + esc(r.letter) + '" title="Remove ' + esc(r.letter) + '"' + (n <= 2 ? ' disabled' : '') + '>' + icon('trash') + '</button>') + '</td></tr>';
    }).join('');
    h += '</tbody></table></div>';
    h += '<p class="set-preview" data-role="ls-preview">' + previewHtml(scale, ranges, false, true) + '</p>';
    var passOpts = scale.slice(0, Math.max(1, n - 1)).map(function (r) { return { value: r.letter, label: r.letter }; });
    var passBadge = badge(course, 'passingLetter');
    h += '<div class="set-form-grid set-pass">' + selectField('ls:passing', 'Passing letter (lowest letter that passes)', passing, passOpts, {
      badge: passBadge, anchor: 'passingLetter',
      help: 'The pass rate in Statistics counts active students at or above this letter.' + (passBadge ? ' ' + esc(phNote(course, 'passingLetter')) : '')
    }) + '</div>';
    return h + '</div>';
  }

  function previewHtml(scale, ranges, pending, valid) {
    if (!valid) {
      return '<span class="set-warn">' + icon('alert', 'icon-sm') + ' Cutoffs must decrease from top to bottom. Fix the highlighted values; nothing was saved.</span>';
    }
    return '<span class="muted">Ranges:</span> ' + esc(scale.map(function (r, i) { return r.letter + ' ' + ranges[i]; }).join(', ')) +
      (pending ? ' <span class="set-warn">(preview of unsaved changes: press Enter or leave the field to save)</span>' : '');
  }

  // ------------------------------------------------------------------ render: 6. data & privacy

  function dataHtml() {
    var st = GT.store.state;
    var s = GT.store.saveStatus ? GT.store.saveStatus() : { backend: 'memory', phase: 'idle' };
    var backend = s.backend === 'indexeddb' ? 'IndexedDB' : s.backend === 'localstorage' ? 'localStorage' : 'Memory only';
    var phase = s.phase === 'saving' || s.phase === 'pending' ? 'Saving…'
      : s.phase === 'error' ? 'Save failed: ' + (s.error || 'unknown error')
        : s.at ? 'Autosaved ' + new Date(s.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Autosave on';
    var last = st.meta && st.meta.lastBackupAt;
    var age = last ? util.daysBetween(last, new Date().toISOString()) : null;
    var stale = age === null || age > 7;
    var h = cardHead('data', 'Data & privacy', 'Everything stays in this browser on this computer. Nothing is sent anywhere.');
    h += '<div class="card-body"><dl class="dl set-dl">' +
      '<dt>Storage</dt><dd>' + icon('database', 'icon-sm') + ' <strong>' + esc(backend) + '</strong> in this browser' +
      (s.backend === 'memory' ? ' <span class="badge badge-danger">not saved when the tab closes</span>' : '') +
      ' <span class="muted">· ' + esc(phase) + '</span></dd>' +
      '<dt>Last backup</dt><dd>' + (last
        ? esc(ui.dateTime(last)) + ' <span class="muted">(' + esc(ui.relativeTime(last)) + ')</span>' +
          (stale ? ' <span class="badge badge-warn">' + icon('alert') + 'older than 7 days</span>' : '')
        : '<strong>No backup yet</strong> <span class="badge badge-warn">' + icon('alert') + 'download one</span>') + '</dd>' +
      '</dl>';
    h += '<div class="callout callout-warn set-storage-note"><strong>Browser storage can be cleared.</strong> Clearing site data or browsing history, ' +
      'a private window, another browser or browser profile, or a cleanup tool can remove everything stored here, so backups matter. ' +
      'Download a backup regularly (the app reminds you after 7 days) and keep it in a private folder: it contains student names and grades.</div>';
    h += '<div class="set-data-actions">' +
      '<button type="button" class="btn btn-primary" data-act="backup" data-field="data:backup">' + icon('download') + 'Download backup</button>' +
      '<button type="button" class="btn" data-act="restore" data-field="data:restore">' + icon('upload') + 'Restore from backup…</button>' +
      '<button type="button" class="btn btn-danger" data-act="delete-all" data-field="data:delete">' + icon('trash') + 'Delete all data…</button></div>';
    h += '<hr><div class="set-privacy"><label class="check"><input type="checkbox" data-field="data:privacy"' + (st.ui && st.ui.privacy ? ' checked' : '') + '> ' +
      '<strong>Privacy mode</strong></label><div class="help">Blurs student names and notes, for when someone can see your screen. Click a blurred name to reveal it for 10 seconds. ' +
      'Also available from the Privacy button in the header.</div></div>';
    return h + '</div>';
  }

  // ------------------------------------------------------------------ render

  function skeleton() {
    return '<div data-sec-host="head"></div><div class="set-layout">' +
      '<nav class="set-toc" aria-label="Settings sections" data-sec-host="toc"></nav><div class="set-main">' +
      SECTIONS.map(function (s) {
        return '<section class="card set-card" id="set-sec-' + s.id + '" data-sec-host="' + s.id + '" aria-labelledby="set-h-' + s.id + '"></section>';
      }).join('') + '</div></div>';
  }

  function captureFocus(host) {
    var a = document.activeElement;
    if (!a || !host.contains(a)) return null;
    var key = a.getAttribute('data-field');
    if (!key) return null;
    var info = { key: key, el: a };
    if (a.tagName === 'INPUT' && a.type === 'text') {
      info.value = a.value;
      info.dirty = a.value !== a.defaultValue;
      try { info.start = a.selectionStart; info.end = a.selectionEnd; } catch (e) { info.start = null; }
    }
    return info;
  }

  function focusEl(t, preventScroll) {
    try { t.focus({ preventScroll: !!preventScroll }); } catch (e) { t.focus(); }
  }

  function restoreFocus(host, info) {
    if (!info) return;
    if (info.el && document.activeElement === info.el && host.contains(info.el)) return; // untouched section
    var t = byField(host, info.key);
    if (!t) return;
    if (info.dirty && t.tagName === 'INPUT') t.value = info.value;
    focusEl(t, true);
    if (info.start !== null && info.start !== undefined && t.setSelectionRange && t.type === 'text') {
      try { t.setSelectionRange(info.start, info.end); } catch (e) { /* ignore */ }
    }
  }

  function render(el, ctx) {
    ctx = ctx || {};
    if (el !== boundEl) {
      bind(el);
      boundEl = el;
      el.gtSec = null;
    }
    // Do not rebuild buttons under a pressed mouse button, or the click would be lost.
    if (pointerDown && el.gtSec && !ctx.switched) { deferred = true; return; }
    deferred = false;
    var course = ctx.course || GT.store.course();
    if (!course) {
      el.innerHTML = '<div class="empty-state"><h2>No course</h2><p>Add a course from the course menu next to the course name.</p></div>';
      el.gtSec = null;
      courseId = null;
      return;
    }
    var otherCourse = course.id !== courseId;
    if (otherCourse) {
      errors = Object.create(null);
      courseId = course.id;
      el.gtSec = null;
    }
    var results = ctx.results || GT.store.results();
    // Text typed for another course (switched, restored or replaced meanwhile) is never carried over:
    // it would be saved into this course on the next blur.
    var focus = otherCourse ? null : captureFocus(el);
    rendering = true;
    try {
      if (!el.gtSec) { el.innerHTML = skeleton(); el.gtSec = {}; }
      var parts = {
        head: headHtml(course),
        toc: tocHtml(course),
        status: statusHtml(course, results),
        confirm: confirmHtml(course),
        course: courseHtml(course),
        assessments: assessmentsHtml(course),
        calc: calcHtml(course, results),
        letters: lettersHtml(course, results),
        data: dataHtml()
      };
      Object.keys(parts).forEach(function (k) {
        if (el.gtSec[k] === parts[k]) return;
        var host = el.querySelector('[data-sec-host="' + k + '"]');
        if (!host) return;
        host.innerHTML = parts[k];
        el.gtSec[k] = parts[k];
      });
    } finally {
      rendering = false;
    }
    if (pendingFocus) {
      var t = byField(el, pendingFocus);
      pendingFocus = null;
      if (t && !t.disabled) focusEl(t, false); else restoreFocus(el, focus);
    } else {
      restoreFocus(el, focus);
    }
    updateLiveWeights(el);
    updateLivePreview(el);
    updateLiveSteps(el);
    if (ctx.params && ctx.params !== lastParams) {
      lastParams = ctx.params;
      if (ctx.params.section) setTimeout(function () { gotoSection(ctx.params.section); }, 0);
      else if (ctx.params.placeholder) setTimeout(function () { gotoPlaceholder(ctx.params.placeholder); }, 0);
    }
  }

  function rerender() {
    if (boundEl && document.body.contains(boundEl)) {
      render(boundEl, { course: GT.store.course(), results: GT.store.results(), params: lastParams });
    }
  }

  /** Re-render after the current event: a commit triggered by focusout must not replace the control
   * that is about to receive focus (Tab) or be clicked (the render then waits for the pointer). */
  var rerenderTimer = null;
  function rerenderSoon() {
    if (rerenderTimer) return;
    rerenderTimer = setTimeout(function () { rerenderTimer = null; rerender(); }, 0);
  }

  // ------------------------------------------------------------------ live feedback while typing

  function updateLiveWeights(host) {
    var course = GT.store.course();
    var line = host && host.querySelector('[data-role="weight-sum"]');
    if (!course || !line) return;
    var sum = 0, pending = false, bad = false, negative = false;
    course.assessments.forEach(function (a) {
      var w = a.weight || 0;
      var inp = byField(host, 'a:' + a.id + ':weight');
      if (inp) {
        var p = util.parseScoreInput(inp.value);
        if (p.kind === 'number' && p.value >= 0) {
          if (p.value !== a.weight) pending = true;
          w = p.value;
        } else {
          bad = true;
        }
      }
      if (w < 0) negative = true;
      sum += w;
    });
    sum = util.fix(sum);
    var ok = Math.abs(sum - 100) < 1e-9 && !negative;
    line.innerHTML = weightSumHtml(sum, ok, pending, bad);
    line.className = 'set-weight-sum ' + (ok && !bad ? 'is-ok' : 'is-warn');
    var foot = host.querySelector('[data-role="weight-foot"]');
    if (foot) {
      foot.textContent = num(sum) + '%';
      foot.className = ok ? 'set-ok' : 'set-warn';
    }
  }

  function updateLivePreview(host) {
    var course = GT.store.course();
    var prev = host && host.querySelector('[data-role="ls-preview"]');
    if (!course || !prev) return;
    var scale = sortedScale(course).map(function (r) { return { letter: r.letter, min: r.min }; });
    var pending = false;
    scale.forEach(function (r, i) {
      var mi = byField(host, 'ls:' + i + ':min');
      if (mi) {
        var p = util.parseScoreInput(mi.value);
        if (p.kind === 'number') { if (p.value !== r.min) pending = true; r.min = p.value; }
        else pending = true;
      }
      var li = byField(host, 'ls:' + i + ':letter');
      if (li) {
        var v = li.value.trim();
        if (v && v !== r.letter) { pending = true; r.letter = v; }
      }
    });
    var valid = strictlyDecreasing(scale) && scale.every(function (r, i) { return i === scale.length - 1 || r.min > 0; });
    var ranges = rangeTexts(scale);
    prev.innerHTML = previewHtml(scale, ranges, pending, valid);
    if (valid) {
      scale.forEach(function (r, i) {
        var cell = host.querySelector('[data-role="ls-range"][data-i="' + i + '"]');
        if (cell) cell.textContent = ranges[i];
      });
    }
  }

  function updateLiveSteps(host) {
    if (!host) return;
    ui.$$('input[data-role="step-input"]', host).forEach(updateStepPreview);
  }

  // ------------------------------------------------------------------ commit and revert

  function commitInput(t) {
    var key = t.getAttribute('data-field');
    if (key && guarding[key]) return; // its "scores are finalized" question is open
    var course = GT.store.course();
    var h = course && key ? handlerFor(course, key) : null;
    if (!h) return;
    var r = h.parse(t.value);
    if (r.error) {
      errors[key] = { text: t.value, msg: r.error, base: h.stored };
      rerenderSoon();
      return;
    }
    var had = !!errors[key];
    delete errors[key];
    var value = r.value;
    var shown = typeof value === 'number' ? String(value) : value;
    if (h.same(value)) {
      t.value = h.stored;
      t.defaultValue = h.stored;
      if (had) rerenderSoon();
      else { updateLiveWeights(boundEl); updateLivePreview(boundEl); updateLiveSteps(boundEl); }
      return;
    }
    function save() {
      var el = document.body.contains(t) ? t : byField(boundEl, key);
      if (el) el.value = shown;
      try {
        GT.store.transact(h.label(value), function (c) { h.apply(c, value); });
      } catch (err) {
        errors[key] = { text: shown, msg: err && err.message ? err.message : String(err), base: h.stored };
        rerenderSoon();
      }
    }
    if (!h.totals) { save(); return; }
    guarding[key] = true;
    guardChange({
      label: h.label(value),
      kind: h.totals,
      apply: function (c) { h.apply(c, value); },
      run: function () { delete guarding[key]; save(); },
      cancel: function () {
        delete guarding[key];
        var el = byField(boundEl, key);
        if (el) revertInput(el);
      }
    });
  }

  function revertInput(t) {
    var key = t.getAttribute('data-field');
    var course = GT.store.course();
    var h = course && key ? handlerFor(course, key) : null;
    var had = !!errors[key];
    delete errors[key];
    var v = h ? h.stored : t.defaultValue;
    t.value = v;
    t.defaultValue = v;
    if (had) rerenderSoon();
    else { updateLiveWeights(boundEl); updateLivePreview(boundEl); updateLiveSteps(boundEl); }
  }

  // ------------------------------------------------------------------ actions: placeholders

  function setConfirmed(key, on) {
    var course = GT.store.course();
    var info = course && model.placeholderInfo(course, key);
    if (!info) return;
    if (on) {
      var pending = model.unconfirmedPlaceholders(course).map(function (p) { return p.key; });
      var i = pending.indexOf(key);
      var next = pending[i + 1] || pending[i - 1];
      pendingFocus = next ? 'ph:' + next + ':confirm' : 'h:confirm';
    } else {
      pendingFocus = 'ph:' + key + ':confirm';
    }
    GT.store.transact((on ? 'Mark confirmed: ' : 'Undo confirmation: ') + info.label, function (c) {
      if (!util.isPlainObject(c.placeholders)) c.placeholders = {};
      c.placeholders[key] = on ? { confirmed: true, confirmedAt: util.nowIso() } : { confirmed: false, confirmedAt: null };
    });
    ui.toast(on ? info.label + ' marked confirmed.' : info.label + ' needs confirmation again.', { type: on ? 'success' : 'info' });
  }

  // ------------------------------------------------------------------ actions: grading status (STAGE2B)

  function unlockScores() {
    var course = GT.store.course();
    var f = finalizedInfo(course);
    if (!f) return;
    var courseId = course.id;
    ui.dialog.confirm({
      title: 'Unlock scores?',
      messageHtml: '<p>Scores were finalized on <strong>' + esc(ui.dateTime(f.at)) + '</strong>. Unlocking makes the score cells editable again in the Grades tab.</p>' +
        '<ul class="set-dlg-list"><li>Final letters stay as they are.</li>' +
        '<li>The unlock is logged in the change history (Scores finalized: yes → no).</li>' +
        '<li>Finalize again from the Grades tab when the changes are done.</li></ul>',
      confirmText: 'Unlock scores'
    }).then(function (ok) {
      if (!ok) { refocusIfLost('status:unlock'); return; }
      var cur = GT.store.course();
      if (!cur || cur.id !== courseId || !isLocked(cur)) return;
      pendingFocus = typeof ui.openFinalize === 'function' ? 'status:finalize' : 'status:grades';
      try {
        GT.store.transact('Unlock scores', function (c) {
          if (typeof model.unfinalize === 'function') model.unfinalize(c); else c.finalized = null;
        }, { courseId: courseId });
      } catch (err) { toastError(err); return; }
      ui.toast('Scores unlocked: score cells can be edited again. The unlock is logged in History.', { type: 'success', timeout: 6000 });
    });
  }

  function copySuggested() {
    var course = GT.store.course();
    if (!course || typeof model.copySuggestedToFinal !== 'function') return;
    var courseId = course.id;
    var n = letterCounts(course, GT.store.results()).fillable;
    if (!n) { ui.toast('Every active student with a suggested letter already has a final letter.'); return; }
    var unconfirmed = isUnconfirmed(course, 'letterScale');
    ui.dialog.confirm({
      title: 'Copy suggested letters?',
      messageHtml: '<p>Fill the empty final letters of <strong>' + plural(n, 'active student') + '</strong> with their suggested letter from the cutoffs.</p>' +
        '<ul class="set-dlg-list"><li>Final letters already chosen are not changed.</li><li>Withdrawn students are skipped.</li>' +
        '<li>One step: undo it with Ctrl+Z. Each letter can still be changed afterwards.</li></ul>' +
        (unconfirmed ? '<div class="callout callout-warn">The cutoffs are placeholders that still need confirmation, so check every copied letter.</div>' : ''),
      confirmText: 'Copy ' + plural(n, 'letter')
    }).then(function (ok) {
      if (!ok) { refocusIfLost('status:copy'); return; }
      var changed = 0;
      pendingFocus = 'status:assign';
      try {
        GT.store.transact('Copy suggested letters into empty final letters', function (c) {
          changed = model.copySuggestedToFinal(c, calc.computeCourse(c), { onlyEmpty: true, activeOnly: true });
        }, { courseId: courseId });
      } catch (err) { toastError(err); return; }
      ui.toast(changed ? plural(changed, 'final letter') + ' filled from the suggestions. Press Ctrl+Z to undo.' : 'No final letter was changed.',
        { type: changed ? 'success' : 'info' });
    });
  }

  // ------------------------------------------------------------------ actions: drop-down lists (DECISIONS 8)

  function toggleChoices(aid, cb) {
    var course = GT.store.course();
    var a = course && model.findAssessment(course, aid);
    if (!a || typeof model.choiceValues !== 'function') return;
    var on = cb.checked;
    var has = choiceList(a).length > 0;
    if (on === has) return;
    pendingFocus = 'a:' + aid + ':choices';
    if (on) {
      var step = defaultStep(a.maxScore);
      var off = offListCount(course, a, step);
      try {
        GT.store.transact('Use a drop-down list for ' + a.name, function (c) {
          var x = model.findAssessment(c, aid);
          if (x) x.choices = { step: step };
        });
      } catch (err) { toastError(err); return; }
      var now = model.findAssessment(GT.store.course(), aid);
      var desc = now && typeof model.describeChoices === 'function' ? model.describeChoices(now) : '';
      ui.toast(a.name + ' scores are now picked from a list' + (desc ? ' (' + desc + ')' : '') + '. Change the step next to the checkbox if needed.' +
        (off ? ' ' + plural(off, 'score is', 'scores are') + ' not on the list: kept, and highlighted in the grid.' : ''),
        { type: off ? 'warn' : 'success', timeout: 7000 });
    } else {
      try {
        GT.store.transact('Stop using a drop-down list for ' + a.name, function (c) {
          var x = model.findAssessment(c, aid);
          if (x) x.choices = null;
        });
      } catch (err2) { toastError(err2); return; }
      ui.toast(a.name + ' scores are typed freely again. Every score is kept.', { type: 'success' });
    }
  }

  function updateStepPreview(input) {
    var course = GT.store.course();
    var aid = input.getAttribute('data-aid');
    var a = course && model.findAssessment(course, aid);
    var out = boundEl && boundEl.querySelector('[data-role="step-preview"][data-aid="' + cssEsc(aid) + '"]');
    if (!a || !out) return;
    var p = util.parseScoreInput(input.value);
    var test = { id: a.id, maxScore: a.maxScore, choices: p.kind === 'number' ? { step: p.value } : null };
    var values = p.kind === 'number' && p.value <= a.maxScore ? choiceList(test) : [];
    var saved = a.choices && a.choices.step;
    out.textContent = values.length ? choicePreview(values) + (p.value !== saved ? ' (not saved yet)' : '') : 'Not a valid step';
  }

  /** After a dialog closes without a change, put focus back on the control that opened it
   * (the dialog restores focus itself unless a re-render replaced that control meanwhile). */
  function refocusIfLost(key) {
    setTimeout(function () {
      var ae = document.activeElement;
      if (ae && ae !== document.body) return;
      var t = byField(boundEl, key);
      if (t && !t.disabled) focusEl(t, true);
    }, 0);
  }

  function flash(elm) {
    if (!elm) return;
    elm.classList.remove('set-flash');
    void elm.offsetWidth; // restart the animation
    elm.classList.add('set-flash');
    setTimeout(function () { elm.classList.remove('set-flash'); }, 1700);
  }

  function gotoSection(sec) {
    if (!boundEl) return;
    var card = boundEl.querySelector('[data-sec-host="' + cssEsc(sec) + '"]');
    if (!card) return;
    card.scrollIntoView({ block: 'start' });
    var hd = card.querySelector('h2');
    if (hd) focusEl(hd, true);
  }

  function gotoPlaceholder(key) {
    var t = PH_TARGET[key];
    if (!t || !boundEl) return;
    var anchor = boundEl.querySelector('[data-ph-anchor="' + cssEsc(key) + '"]') ||
      boundEl.querySelector('[data-sec-host="' + t.sec + '"]');
    if (!anchor) return;
    anchor.scrollIntoView({ block: 'center' });
    flash(anchor);
    var sec = boundEl.querySelector('[data-sec-host="' + t.sec + '"]');
    var f = null;
    [anchor, sec].some(function (scope) {
      if (!scope) return false;
      t.focus.split(',').some(function (sel) { f = scope.querySelector(sel.trim()); return !!f; });
      return !!f;
    });
    if (!f) f = anchor.querySelector('input, select, button');
    if (f) focusEl(f, true);
  }

  // ------------------------------------------------------------------ actions: course

  function setLevel(v) {
    var course = GT.store.course();
    if (!course || (v !== 'undergraduate' && v !== 'graduate') || v === course.level) return;
    GT.store.transact('Change course level to ' + v, function (c) { c.level = v; });
    var def = model.defaultLetterScale(v);
    var cur = sortedScale(GT.store.course());
    var same = def.length === cur.length && def.every(function (r, i) { return r.letter === cur[i].letter && r.min === cur[i].min; });
    if (!same) {
      ui.toast('The letter scale did not change. Use "Reset to default for this level" under Letter scale to use the ' + v + ' scale.', { type: 'info', timeout: 7000 });
    }
  }

  // ------------------------------------------------------------------ actions: assessments

  function moveAsmt(aid, delta) {
    var course = GT.store.course();
    var a = course && model.findAssessment(course, aid);
    if (!a) return;
    var i = course.assessments.indexOf(a);
    var j = i + delta;
    if (j < 0 || j >= course.assessments.length) return;
    var edge = (delta < 0 && j === 0) || (delta > 0 && j === course.assessments.length - 1);
    pendingFocus = 'a:' + aid + ':' + ((delta < 0) !== edge ? 'up' : 'down');
    GT.store.transact('Move ' + a.name + (delta < 0 ? ' up' : ' down'), function (c) { model.moveAssessment(c, aid, delta); });
  }

  function setCategory(aid, v) {
    var course = GT.store.course();
    var a = course && model.findAssessment(course, aid);
    if (!a || a.category === v) return;
    var label = (CATEGORIES.filter(function (c) { return c.value === v; })[0] || { label: v }).label;
    GT.store.transact('Change category of ' + a.name + ' to ' + label, function (c) {
      var x = model.findAssessment(c, aid);
      if (x) x.category = v;
    });
  }

  function toggleTeamGraded(aid, cb) {
    var course = GT.store.course();
    var a = course && model.findAssessment(course, aid);
    if (!a) return;
    var toTeam = cb.checked;
    cb.checked = !!a.teamGraded; // keep showing the saved state until the change is confirmed
    if (toTeam === !!a.teamGraded) return;
    var stats = asmtStats(course, a);
    var body;
    if (toTeam) {
      var clone = util.clone(course);
      var res = model.convertAssessmentToTeam(clone, aid);
      var ca = model.findAssessment(clone, aid);
      var gain = 0, noTeam = 0;
      course.students.forEach(function (s) {
        var before = model.effectiveEntry(course, s, a);
        var cs = model.findStudent(clone, s.id);
        var after = model.effectiveEntry(clone, cs, ca);
        if (!model.hasScore(before) && model.hasScore(after)) gain++;
        if (!(s.teamId && model.findTeam(course, s.teamId)) && model.hasScore(before)) noTeam++;
      });
      body = '<p>Each team gets one <strong>' + esc(a.name) + '</strong> score, entered once and shared by its members.</p><ul class="set-dlg-list">' +
        '<li>For each team, the most common score among its members becomes the team score.</li>' +
        (res.overridesCreated
          ? '<li><strong>' + plural(res.overridesCreated, 'student') + '</strong> with a different score keep it as a per-member override (◆). An unequal split needs the team\'s written agreement.</li>'
          : '<li>No per-member overrides are needed: members of each team have the same score or none.</li>') +
        (gain ? '<li><strong>' + plural(gain, 'student') + ' without a score</strong> will receive their team\'s score.</li>' : '') +
        (noTeam ? '<li>' + plural(noTeam, 'student') + ' without a team keep their individual scores.</li>' : '') +
        '</ul>' +
        (course.teams.length ? '' : '<div class="callout callout-warn">This course has no teams yet, so every student keeps an individual score until you create teams.</div>') +
        '<p class="muted">' + plural(stats.scored, 'student') + ' currently have a score for ' + esc(a.name) + '. Every entered score is kept, and you can undo this (Ctrl+Z).</p>';
    }
    // Students who got their team's score only because the item was made team-graded here: offer to
    // leave them without a score again, so switching back does not invent a grade.
    var refill = toTeam ? [] : teamFillCandidates(course, a);
    if (!toTeam) {
      body = '<p>Each student\'s current <strong>' + esc(a.name) + '</strong> score (their team score, or their override) becomes their own individual score. ' +
        'Team scores for ' + esc(a.name) + ' are removed.</p><ul class="set-dlg-list">' +
        '<li>Totals and letters do not change' + (refill.length ? ' for students who keep a score' : '') + '.</li>' +
        (stats.overrides ? '<li>The ◆ marker goes away for ' + plural(stats.overrides, 'override') + '; those students keep their scores.</li>' : '') +
        '<li>From now on, scores are entered per student.</li></ul>' +
        (refill.length
          ? '<div class="field set-dlg-choice"><label class="check"><input type="checkbox" data-role="refill-clear" checked>' +
            '<span>Leave <strong>' + plural(refill.length, 'student') + '</strong> without a ' + esc(a.name) + ' score, as before</span></label>' +
            '<div class="help">' + (refill.length === 1 ? 'This student' : 'These students') + ' had no ' + esc(a.name) + ' score when it was made team-graded ' +
            'and only received their team\'s score then. Clear the check to give them that score as their own.</div></div>'
          : '') +
        '<p class="muted">You can undo this (Ctrl+Z).</p>';
    }
    if (isLocked(course)) {
      // Finalized: say whether this changes any total (making it team-graded can give scoreless members their team's score).
      var imT = impactOf(course, function (c) {
        if (toTeam) model.convertAssessmentToTeam(c, aid); else model.convertAssessmentToIndividual(c, aid);
      });
      body += !imT.error && (imT.totals || imT.letters) ? impactHtml(course, imT, 'totals')
        : lockCalloutHtml(course, 'This switch does not change any total' + (refill.length ? ' unless you leave students without a score' : '') + '.');
    }
    var title = toTeam ? 'Make ' + a.name + ' team-graded?' : 'Make ' + a.name + ' individually graded?';
    var confirmText = toTeam ? 'Make team-graded' : 'Make individually graded';
    var ask = refill.length
      ? ui.dialog.open({
        title: title,
        bodyHtml: body,
        buttons: [
          { text: 'Cancel', value: null },
          {
            text: confirmText, primary: true,
            value: function (dlg) { var box = dlg.querySelector('[data-role="refill-clear"]'); return { clear: !!(box && box.checked) }; }
          }
        ],
        initialFocus: '.dlg-foot .btn-primary'
      })
      : ui.dialog.confirm({ title: title, messageHtml: body, confirmText: confirmText }).then(function (ok) { return ok ? { clear: false } : null; });
    ask.then(function (choice) {
      if (!choice) { refocusIfLost('a:' + aid + ':team'); return; }
      pendingFocus = 'a:' + aid + ':team';
      var out = null;
      var noScore = toTeam ? scorelessEntries(GT.store.course(), aid) : null;
      try {
        GT.store.transact(toTeam ? 'Make ' + a.name + ' team-graded' : 'Make ' + a.name + ' individually graded', function (c) {
          if (toTeam) { out = model.convertAssessmentToTeam(c, aid); return; }
          model.convertAssessmentToIndividual(c, aid);
          if (choice.clear) {
            refill.forEach(function (r) { model.setEntry(c.scores, r.studentId, aid, r.prev ? util.clone(r.prev) : null); });
          }
        });
      } catch (err) { toastError(err); return; }
      if (toTeam) {
        rememberTeamFill(GT.store.course(), aid, noScore);
        var nOv = out && out.overridesCreated ? out.overridesCreated : 0;
        ui.toast(a.name + ' is now team-graded.' + (nOv ? ' ' + plural(nOv, 'differing score was', 'differing scores were') + ' kept as per-member overrides (◆).' : ''), { type: 'success' });
      } else if (choice.clear) {
        ui.toast(a.name + ' is now graded individually. ' + plural(refill.length, 'student is', 'students are') +
          ' without a score again, as before; everyone else kept their score.', { type: 'success', timeout: 6000 });
      } else {
        ui.toast(a.name + ' is now graded individually. Every student kept their score.', { type: 'success' });
      }
    });
  }

  /** Students without a score for an (individually graded) assessment: studentId -> their own entry (null, or late info only). */
  function scorelessEntries(course, aid) {
    var out = Object.create(null);
    var a = course && model.findAssessment(course, aid);
    if (!a) return out;
    course.students.forEach(function (s) {
      if (model.hasScore(model.effectiveEntry(course, s, a))) return;
      var own = model.getEntry(course.scores, s.id, aid);
      out[s.id] = own ? util.clone(own) : null;
    });
    return out;
  }

  /** After making an item team-graded: remembers which of the students in `noScore` now show their team's score. */
  function rememberTeamFill(course, aid, noScore) {
    var a = course && model.findAssessment(course, aid);
    if (!a) return;
    var rec = Object.create(null), n = 0;
    if (a.teamGraded) {
      course.students.forEach(function (s) {
        if (!util.hasOwn(noScore, s.id) || !s.teamId || !model.findTeam(course, s.teamId)) return;
        if (model.getEntry(course.scores, s.id, aid)) return;
        var e = model.effectiveEntry(course, s, a);
        if (!model.hasScore(e)) return;
        rec[s.id] = { teamId: s.teamId, key: model.entryKey(e), prev: noScore[s.id] };
        n++;
      });
    }
    if (n) teamFill[fillKey(course, aid)] = rec;
    else delete teamFill[fillKey(course, aid)];
  }

  function addAssessment() {
    var course = GT.store.course();
    if (!course) return;
    var w = calc.weightStatus(course);
    var canList = typeof model.choiceValues === 'function';
    ui.dialog.form({
      title: 'Add assessment',
      confirmText: 'Add assessment',
      introHtml: lockCalloutHtml(course, 'A new item starts empty, so one with a weight above 0 changes totals.'),
      fields: [
        { name: 'name', label: 'Name', value: '', placeholder: 'e.g. Quiz 1', required: true },
        { name: 'maxScore', label: 'Max score', value: '100', help: 'The highest possible raw score, for example 100 or 30.' },
        { name: 'weight', label: 'Weight %', value: '0', help: 'The weights now add up to ' + num(w.sum) + '%. A new item with a weight above 0 means lowering other weights.' },
        { name: 'category', label: 'Category', type: 'select', value: 'other', options: CATEGORIES },
        { name: 'teamGraded', label: 'Team-graded (one score per team, shared by its members)', type: 'checkbox', value: false }
      ].concat(canList ? [{
        name: 'choices', label: 'Pick scores from a drop-down list (max, max − 0.5, …, 0)', type: 'checkbox', value: false,
        help: 'No typos possible. Above a max of 100 the step starts larger (at most 200 steps); change the step in the table afterwards.'
      }] : []),
      validate: function (v) {
        var name = cleanText(v.name);
        if (!name) return 'Enter a name.';
        if (name.length > MAX_NAME) return 'Keep the name under ' + MAX_NAME + ' characters.';
        var cur = GT.store.course();
        if (nameTaken(cur, name, null)) return 'Another assessment is already named "' + name + '".';
        var m = util.parseScoreInput(v.maxScore);
        if (m.kind !== 'number' || !(m.value > 0)) return 'Max score must be a number above 0.';
        var wt = util.parseScoreInput(v.weight);
        if (wt.kind !== 'number' || wt.value < 0) return 'Weight must be a number, 0 or more.';
        return null;
      }
    }).then(function (v) {
      if (!v) return;
      var name = cleanText(v.name);
      var cat = CATEGORIES.some(function (c) { return c.value === v.category; }) ? v.category : 'other';
      var newId = null;
      try {
        GT.store.transact('Add assessment ' + name, function (c) {
          var max = util.parseScoreInput(v.maxScore).value;
          var na = model.createAssessment({
            name: name,
            maxScore: max,
            weight: util.parseScoreInput(v.weight).value,
            teamGraded: !!v.teamGraded,
            category: cat,
            choices: v.choices ? { step: defaultStep(max) } : null
          });
          c.assessments.push(na);
          newId = na.id;
        });
      } catch (err) { toastError(err); return; }
      if (newId) pendingFocus = 'a:' + newId + ':weight';
      ui.toast(name + ' added.', { type: 'success' });
    });
  }

  function deleteAssessment(aid) {
    var course = GT.store.course();
    var a = course && model.findAssessment(course, aid);
    if (!a) return;
    var st = asmtStats(course, a);
    var w = calc.weightStatus(course);
    var after = util.fix(w.sum - (a.weight || 0));
    var html = '<p>' + (st.scored
      ? '<strong>' + plural(st.scored, 'student has', 'students have') + ' a score</strong> for ' + esc(a.name) +
        (a.teamGraded && st.teamScores ? ' (from ' + plural(st.teamScores, 'team score') + ')' : '') + '. These scores are deleted with it.'
      : 'No student has a score for ' + esc(a.name) + ' yet.') + '</p>' +
      '<p class="muted">' + esc(a.name) + ' is worth ' + esc(num(a.weight)) + '%. Without it the weights add up to ' + esc(num(after)) + '%. ' +
      'You can undo this right away (Ctrl+Z), and the deletion is logged in History.</p>';
    if (isLocked(course)) {
      var im = impactOf(course, function (c) { model.removeAssessment(c, aid); });
      if (!im.error && (im.totals || im.letters)) html += impactHtml(course, im, 'totals');
      else html += lockCalloutHtml(course, 'Deleting ' + a.name + ' does not change any total.');
    }
    ui.dialog.confirm({
      title: 'Delete ' + a.name + '?',
      messageHtml: html,
      confirmText: 'Delete assessment',
      danger: true
    }).then(function (ok) {
      if (!ok) { refocusIfLost('a:' + aid + ':del'); return; }
      var cur = GT.store.course();
      var list = cur.assessments;
      var i = -1;
      list.forEach(function (x, k) { if (x.id === aid) i = k; });
      var next = list[i + 1] || list[i - 1];
      pendingFocus = next ? 'a:' + next.id + ':del' : 'asmt:add';
      try {
        GT.store.transact('Delete assessment ' + a.name, function (c) { model.removeAssessment(c, aid); });
      } catch (err) { toastError(err); return; }
      ui.toast(a.name + ' deleted' + (st.scored ? ' with its scores' : '') + '. Press Ctrl+Z to undo.', { type: 'success' });
    });
  }

  /** Split prefill. SE 4351 projects follow the syllabus (Questionnaire 2 x 2.5 inside the 30% Project).
   * Part 1 keeps the existing scores, so when the project already has scores the main part
   * (presentation + deliverable) goes first: those scores stay with it instead of becoming
   * questionnaire scores. */
  function splitPrefill(course, a, hasScores) {
    if (course.template === 'SE4351' && (a.id === 'a_p1' || a.id === 'a_p2') && a.weight > 2.5) {
      var roman = a.id === 'a_p1' ? 'I' : 'II';
      var q = { name: 'Questionnaire ' + roman, weight: '2.5' };
      var main = { name: a.name + ' (presentation + deliverable)', weight: String(util.fix(a.weight - 2.5)) };
      return hasScores ? [main, q] : [q, main];
    }
    var half = util.roundTo((a.weight || 0) / 2, 2);
    return [
      { name: a.name + ' (part 1)', weight: String(half) },
      { name: a.name + ' (part 2)', weight: String(util.fix((a.weight || 0) - half)) }
    ];
  }

  function openSplit(aid) {
    var course = GT.store.course();
    var a = course && model.findAssessment(course, aid);
    if (!a) return;
    var st = asmtStats(course, a);
    var parts = splitPrefill(course, a, st.scored > 0 || st.teamScores > 0);
    var body = document.createElement('div');
    body.className = 'set-split';
    var phHtml = isUnconfirmed(course, 'projectSplit')
      ? '<div class="callout callout-warn set-ph-callout"><div class="set-ph-title"><strong>Project split</strong>' + badge(course, 'projectSplit') + '</div><div>' +
        esc(phNote(course, 'projectSplit')) + '</div></div>'
      : '';
    body.innerHTML = lockCalloutHtml(course, 'The new parts start empty, so splitting ' + a.name + ' changes totals.') + phHtml +
      '<p>Split <strong>' + esc(a.name) + '</strong> (' + esc(num(a.weight)) + '%, max ' + esc(num(a.maxScore)) + (a.teamGraded ? ', team-graded' : '') +
      ') into 2 to ' + MAX_PARTS + ' parts. The part weights must add up to <strong>' + esc(num(a.weight)) + '%</strong>.</p>' +
      '<ul class="set-dlg-list muted">' +
      '<li>Part 1 keeps the existing ' + esc(a.name) + ' scores' + (st.scored ? ' (' + plural(st.scored, 'student') + ')' : '') + ': it is renamed and reweighted.' +
      (st.scored ? ' Put the part those scores belong to first.' : '') + '</li>' +
      '<li>The other parts start empty, with max score ' + esc(num(a.maxScore)) + (a.teamGraded ? ', team-graded,' : '') + ' and the same category.</li></ul>' +
      '<div class="set-split-grid" role="group" aria-label="Parts"><span class="set-split-hd"></span><span class="set-split-hd">Name</span><span class="set-split-hd">Weight %</span><span class="set-split-hd"></span>' +
      '<div class="set-split-rows"></div></div>' +
      '<div class="set-split-tools"><button type="button" class="btn btn-sm" data-split="add">' + icon('plus') + 'Add part</button></div>' +
      '<div class="set-split-sum" role="status" aria-live="polite"></div>';

    var rowsHost = body.querySelector('.set-split-rows');
    var sumEl = body.querySelector('.set-split-sum');
    var addBtn = body.querySelector('[data-split="add"]');
    var primary = null;

    function sync() {
      ui.$$('.set-split-row', rowsHost).forEach(function (row, i) {
        parts[i] = { name: row.querySelector('.set-split-name').value, weight: row.querySelector('.set-split-weight').value };
      });
    }

    function drawRows(focusIdx) {
      rowsHost.innerHTML = parts.map(function (p, i) {
        return '<div class="set-split-row">' +
          '<span class="set-split-no">' + (i + 1) + (i === 0 ? '<span class="badge badge-info" title="Keeps the existing scores">keeps scores</span>' : '') + '</span>' +
          '<input type="text" class="set-split-name" aria-label="Part ' + (i + 1) + ' name" value="' + esc(p.name) + '" maxlength="' + (MAX_NAME + 20) + '" autocomplete="off">' +
          '<input type="text" class="set-split-weight set-in-num" inputmode="decimal" aria-label="Part ' + (i + 1) + ' weight in percent" value="' + esc(p.weight) + '" autocomplete="off">' +
          (i >= 1 && parts.length > 2
            ? '<button type="button" class="btn btn-sm btn-icon btn-ghost" data-split="remove" data-i="' + i + '" aria-label="Remove part ' + (i + 1) + '">' + icon('x') + '</button>'
            : '<span></span>') + '</div>';
      }).join('');
      addBtn.disabled = parts.length >= MAX_PARTS;
      if (focusIdx !== undefined) {
        var r = rowsHost.querySelectorAll('.set-split-name')[focusIdx];
        if (r) { r.focus(); r.select(); }
      }
      check();
    }

    function check() {
      sync();
      var cur = GT.store.course();
      var total = 0, err = null, badIdx = {};
      var seen = {};
      var out = parts.map(function (p, i) {
        var name = cleanText(p.name);
        var w = util.parseScoreInput(p.weight);
        if (!name) { err = err || 'Part ' + (i + 1) + ' needs a name.'; badIdx[i] = 'name'; }
        else if (seen[name.toLowerCase()]) { err = err || 'Two parts are named "' + name + '".'; badIdx[i] = 'name'; }
        else if (cur && nameTaken(cur, name, aid)) { err = err || 'Another assessment is already named "' + name + '".'; badIdx[i] = 'name'; }
        seen[name.toLowerCase()] = true;
        if (w.kind !== 'number' || w.value < 0) { err = err || 'The weight of part ' + (i + 1) + ' must be a number, 0 or more.'; badIdx[i] = badIdx[i] ? 'both' : 'weight'; }
        else total += w.value;
        return { name: name, weight: w.kind === 'number' ? w.value : NaN };
      });
      total = util.fix(total);
      var target = a.weight || 0;
      var diff = util.fix(target - total);
      var sumOk = Math.abs(diff) < 1e-9;
      ui.$$('.set-split-row', rowsHost).forEach(function (row, i) {
        var b = badIdx[i];
        row.querySelector('.set-split-name').classList.toggle('is-invalid', b === 'name' || b === 'both');
        row.querySelector('.set-split-weight').classList.toggle('is-invalid', b === 'weight' || b === 'both' || (!sumOk && !err));
      });
      var parsed = out.filter(function (p) { return isFinite(p.weight); }).map(function (p) { return num(p.weight); });
      if (!err && sumOk) {
        sumEl.className = 'set-split-sum is-ok';
        sumEl.innerHTML = icon('check') + '<span>' + esc(parsed.join(' + ') + ' = ' + num(total) + '%, matching ' + a.name + ' (' + num(target) + '%).') + '</span>';
      } else {
        sumEl.className = 'set-split-sum is-warn';
        var msg = err ? err + ' ' : '';
        msg += 'Parts add up to ' + num(total) + '% of ' + num(target) + '%' +
          (sumOk ? '.' : diff > 0 ? ' (' + num(diff) + '% short).' : ' (' + num(-diff) + '% over).');
        sumEl.innerHTML = icon('alert') + '<span>' + esc(msg) + '</span>';
      }
      if (primary) primary.disabled = !!err || !sumOk;
      return { ok: !err && sumOk, error: err || (sumOk ? null : 'The part weights must add up to ' + num(target) + '%.'), parts: out };
    }

    body.addEventListener('input', function () { check(); });
    body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-split]') : null;
      if (!b) return;
      sync();
      if (b.getAttribute('data-split') === 'add' && parts.length < MAX_PARTS) {
        parts.push({ name: a.name + ' (part ' + (parts.length + 1) + ')', weight: '0' });
        drawRows(parts.length - 1);
      } else if (b.getAttribute('data-split') === 'remove') {
        var i = parseInt(b.getAttribute('data-i'), 10);
        if (parts.length > 2 && i >= 1) {
          parts.splice(i, 1);
          drawRows(Math.min(i, parts.length - 1));
        }
      }
    });

    ui.dialog.open({
      title: 'Split ' + a.name,
      body: body,
      wide: true,
      buttons: [
        { text: 'Cancel', value: null },
        {
          text: 'Split into parts', primary: true,
          validate: function () { var r = check(); return r.ok ? null : r.error; },
          value: function () { return check().parts; }
        }
      ],
      onMount: function (dlg) {
        primary = dlg.querySelector('.dlg-foot .btn-primary');
        drawRows();
      },
      initialFocus: '.set-split-name'
    }).then(function (res) {
      if (!res) { refocusIfLost('a:' + aid + ':split'); return; }
      pendingFocus = 'a:' + aid + ':split';
      try {
        GT.store.transact('Split ' + a.name + ' into ' + res.length + ' parts', function (c) {
          model.splitAssessment(c, aid, res.map(function (p) { return { name: p.name, weight: p.weight }; }));
        });
      } catch (err) { toastError(err); return; }
      ui.toast('Split ' + a.name + ' into ' + res.map(function (p) { return p.name + ' (' + num(p.weight) + '%)'; }).join(' and ') + '.', { type: 'success', timeout: 6000 });
    });
  }

  // ------------------------------------------------------------------ actions: grade calculation and letters

  function setDecimals(v) {
    var d = parseInt(v, 10);
    var course = GT.store.course();
    if (!course || !isFinite(d) || d < 0 || d > 6 || d === course.settings.decimals) return;
    GT.store.transact('Show ' + d + ' decimal' + (d === 1 ? '' : 's'), function (c) { c.settings.decimals = d; });
  }

  function setRounding(v) {
    var course = GT.store.course();
    var r = ROUNDING.filter(function (x) { return x.value === v; })[0];
    if (!course || !r || course.settings.rounding === v) return;
    guardChange({
      label: 'Set rounding: ' + r.long,
      kind: 'totals',
      apply: function (c) { c.settings.rounding = v; },
      run: function () { GT.store.transact('Set rounding: ' + r.long, function (c) { c.settings.rounding = v; }); },
      cancel: function () { refocusIfLost('calc:rounding:' + v); }
    });
  }

  function setPassing(v) {
    var course = GT.store.course();
    if (!course || v === course.settings.passingLetter) return;
    if (!sortedScale(course).some(function (r) { return r.letter === v; })) return;
    GT.store.transact('Set passing letter to ' + v, function (c) { c.settings.passingLetter = v; });
  }

  function addLetter() {
    var course = GT.store.course();
    if (!course) return;
    ui.dialog.form({
      title: 'Add letter',
      confirmText: 'Add letter',
      fields: [
        { name: 'letter', label: 'Letter', value: '', placeholder: 'e.g. A+', required: true },
        { name: 'min', label: 'Minimum total', value: '', placeholder: 'e.g. 97', help: 'Must be above 0 and different from the other cutoffs. The scale is re-sorted from highest to lowest.' }
      ],
      validate: function (v) {
        var cur = GT.store.course();
        var scale = sortedScale(cur);
        var letter = String(v.letter || '').trim();
        if (!letter) return 'Enter a letter.';
        if (letter.length > MAX_LETTER) return 'Use at most ' + MAX_LETTER + ' characters.';
        if (scale.some(function (r) { return r.letter.toLowerCase() === letter.toLowerCase(); })) return letter + ' is already in the scale.';
        var p = util.parseScoreInput(v.min);
        if (p.kind !== 'number' || p.value <= 0) return 'The minimum total must be a number above 0.';
        if (scale.some(function (r) { return r.min === p.value; })) return 'Another letter already starts at ' + num(p.value) + '.';
        return null;
      }
    }).then(function (v) {
      if (!v) return;
      var letter = String(v.letter).trim();
      var min = util.parseScoreInput(v.min).value;
      function apply(c) {
        c.settings.letterScale = c.settings.letterScale.concat([{ letter: letter, min: min }]);
        normalizeScale(c);
      }
      guardChange({
        label: 'Add letter ' + letter + ' from ' + num(min),
        kind: 'letters',
        apply: apply,
        run: function () {
          try {
            GT.store.transact('Add letter ' + letter, apply);
          } catch (err) { toastError(err); return; }
          ui.toast('Letter ' + letter + ' added from ' + num(min) + '.', { type: 'success' });
        },
        cancel: function () { refocusIfLost('ls:add'); }
      });
    });
  }

  function deleteLetter(letter) {
    var course = GT.store.course();
    if (!course) return;
    var scale = sortedScale(course);
    if (scale.length <= 2) return;
    var i = -1;
    scale.forEach(function (r, k) { if (r.letter === letter) i = k; });
    if (i === -1 || i === scale.length - 1) return;
    var passBefore = course.settings.passingLetter;
    var nextIdx = i < scale.length - 2 ? i : i - 1;
    function apply(c) {
      c.settings.letterScale = c.settings.letterScale.filter(function (r) { return r.letter !== letter; });
      normalizeScale(c);
    }
    guardChange({
      label: 'Remove letter ' + letter,
      kind: 'letters',
      apply: apply,
      confirmText: 'Remove ' + letter,
      run: function () {
        pendingFocus = nextIdx >= 0 && scale.length - 1 > 2 ? 'ls:' + nextIdx + ':del' : 'ls:add';
        try {
          GT.store.transact('Remove letter ' + letter, apply);
        } catch (err) { toastError(err); return; }
        var passAfter = GT.store.course().settings.passingLetter;
        ui.toast('Letter ' + letter + ' removed.' + (passAfter !== passBefore ? ' The passing letter is now ' + passAfter + '.' : '') + ' Press Ctrl+Z to undo.', { type: 'success' });
      },
      cancel: function () { refocusIfLost('ls:' + i + ':del'); }
    });
  }

  function resetLetters() {
    var course = GT.store.course();
    if (!course) return;
    var def = model.defaultLetterScale(course.level);
    var pass = model.defaultPassingLetter(course.level);
    var passNow = course.settings.passingLetter;
    var im = impactOf(course, function (c) {
      c.settings.letterScale = model.defaultLetterScale(c.level);
      c.settings.passingLetter = model.defaultPassingLetter(c.level);
      normalizeScale(c);
    });
    var effect = !im.error && (isLocked(course) || im.lost) ? impactHtml(course, im, 'letters')
      : '<p class="muted">You can undo this (Ctrl+Z).</p>';
    ui.dialog.confirm({
      title: 'Reset the letter scale?',
      messageHtml: '<p>Replace the current cutoffs with the default ' + esc(course.level) + ' scale:</p>' +
        '<p class="set-dlg-scale">' + esc(def.map(function (r) { return r.letter + ' ' + num(r.min); }).join(' · ')) + '</p>' +
        '<p>The passing letter ' + (passNow === pass ? 'stays at the default, <strong>' + esc(pass) + '</strong>.'
          : 'goes back to the default, <strong>' + esc(pass) + '</strong> (now ' + esc(passNow) + ').') + '</p>' +
        '<p class="muted">These defaults are placeholders too.</p>' + effect,
      confirmText: 'Reset letter scale'
    }).then(function (ok) {
      if (!ok) return;
      GT.store.transact('Reset letter scale to the ' + course.level + ' default', function (c) {
        c.settings.letterScale = model.defaultLetterScale(c.level);
        c.settings.passingLetter = model.defaultPassingLetter(c.level);
        normalizeScale(c);
      });
      var passAfter = GT.store.course().settings.passingLetter;
      ui.toast('Letter scale reset to the ' + course.level + ' default.' +
        (passAfter !== passNow ? ' The passing letter is now ' + passAfter + '.' : ''), { type: 'success' });
    });
  }

  // ------------------------------------------------------------------ events

  function onClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !boundEl || !boundEl.contains(b) || b.disabled) return;
    var act = b.getAttribute('data-act');
    var aid = b.getAttribute('data-aid');
    var key = b.getAttribute('data-key');
    var a = actions();
    switch (act) {
      case 'goto-sec': gotoSection(b.getAttribute('data-sec')); break;
      case 'ph-confirm': setConfirmed(key, true); break;
      case 'ph-unconfirm': setConfirmed(key, false); break;
      case 'ph-goto': gotoPlaceholder(key); break;
      case 'open-view':
        if (GT.app && GT.app.navigate) {
          var sec = b.getAttribute('data-section');
          GT.app.navigate(b.getAttribute('data-view'), sec ? { section: sec } : undefined);
        }
        break;
      case 'dup-course': if (a.duplicateCourse) a.duplicateCourse(); break;
      case 'del-course': if (a.deleteCourse) a.deleteCourse(); break;
      case 'add-asmt': addAssessment(); break;
      case 'move': moveAsmt(aid, parseInt(b.getAttribute('data-dir'), 10)); break;
      case 'split': openSplit(aid); break;
      case 'del-asmt': deleteAssessment(aid); break;
      case 'rounding': setRounding(b.getAttribute('data-value')); break;
      case 'add-letter': addLetter(); break;
      case 'del-letter': deleteLetter(b.getAttribute('data-letter')); break;
      case 'reset-letters': resetLetters(); break;
      case 'unlock': unlockScores(); break;
      case 'finalize': if (typeof ui.openFinalize === 'function') ui.openFinalize(); break;
      case 'copy-suggested': copySuggested(); break;
      case 'backup': if (a.backup) a.backup(); break;
      case 'restore': if (a.restore) a.restore(); break;
      case 'delete-all': if (a.deleteAll) a.deleteAll(); break;
      default: break;
    }
  }

  function onChange(e) {
    var t = e.target;
    var key = t.getAttribute ? t.getAttribute('data-field') : null;
    if (!key) return;
    if (t.tagName === 'INPUT' && t.type === 'text') return; // text inputs commit on Enter or focusout
    var k = splitKey(key);
    if (t.type === 'checkbox') {
      if (k.kind === 'a' && k.prop === 'team') toggleTeamGraded(k.id, t);
      else if (k.kind === 'a' && k.prop === 'choices') toggleChoices(k.id, t);
      else if (key === 'data:privacy') GT.store.setUi({ privacy: !!t.checked });
      return;
    }
    if (t.tagName === 'SELECT') {
      if (key === 'course:level') setLevel(t.value);
      else if (k.kind === 'a' && k.prop === 'cat') setCategory(k.id, t.value);
      else if (key === 'calc:decimals') setDecimals(t.value);
      else if (key === 'ls:passing') setPassing(t.value);
    }
  }

  function isFieldInput(t) {
    return t && t.tagName === 'INPUT' && t.type === 'text' && t.hasAttribute('data-field');
  }

  function onKeydown(e) {
    var t = e.target;
    if (!isFieldInput(t)) return;
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      commitInput(t);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      revertInput(t);
    }
  }

  function onFocusOut(e) {
    var t = e.target;
    if (rendering || !isFieldInput(t) || !document.body.contains(t)) return;
    var key = t.getAttribute('data-field');
    if (t.value === t.defaultValue && !(errors[key] && errors[key].text !== t.value)) return;
    commitInput(t);
  }

  function onInput(e) {
    var role = e.target && e.target.getAttribute ? e.target.getAttribute('data-role') : null;
    if (role === 'weight-input') updateLiveWeights(boundEl);
    else if (role === 'ls-min' || role === 'ls-letter') updateLivePreview(boundEl);
    else if (role === 'step-input') updateStepPreview(e.target);
  }

  function onToggle(e) {
    if (e.target && e.target.classList && e.target.classList.contains('set-ph-done')) doneOpen = e.target.open;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    pointerDown = true;
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(releasePointer, 1500);
  }

  function releasePointer() {
    if (!pointerDown) return;
    pointerDown = false;
    clearTimeout(pointerTimer);
    if (deferred) {
      deferred = false;
      setTimeout(rerender, 0); // after the click event of this press
    }
  }

  function bind(el) {
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('input', onInput);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('toggle', onToggle, true);
    if (!globalsBound) {
      globalsBound = true;
      document.addEventListener('pointerup', releasePointer, true);
      document.addEventListener('pointercancel', releasePointer, true);
    }
  }

  function destroy() {
    errors = Object.create(null);
    guarding = Object.create(null);
    pendingFocus = null;
    pointerDown = false;
    deferred = false;
    lastParams = null;
    clearTimeout(pointerTimer);
  }

  GT.views.settings = {
    id: 'settings',
    title: 'Settings',
    render: render,
    destroy: destroy
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
