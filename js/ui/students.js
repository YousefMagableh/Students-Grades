/* Grade Tracker - Students & Teams view (GT.views.students), quick roster paste
 * (GT.ui.openRosterPaste) and the student detail dialog (GT.ui.openStudent).
 * Browser only. Every change goes through GT.store.transact (autosaved, undoable, logged).
 * Privacy: every element that shows a student name or notes carries class "pii"; toasts and menu
 * headings use the student's No instead of the name.
 * Finalized scores (STAGE2B): like the Grades tab, the roster is locked. Adding students (form or roster
 * paste), No / name / team edits, team moves, renumbering, deleting a student and deleting a team that
 * has members or team scores are refused with "Scores are finalized. Unlock them to edit." (and an
 * Unlock action). Notes, withdraw / reinstate, team names and final letters stay editable. The checks
 * sit in the flows themselves (not only on the buttons), so every entry point is covered. */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model, calc = GT.calc;
  var ui = GT.ui = GT.ui || {};
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  var FILTERS = ['all', 'active', 'withdrawn'];
  var SORTS = ['no', 'name', 'team', 'status'];
  var NEW_TEAM = '__new_team__';
  var LOCKED_MSG = 'Scores are finalized. Unlock them to edit.';
  var ADD_LOCKED_MSG = 'Scores are finalized. Unlock them to add students.';
  var KEEP_CURRENT = '__current__';  // <select> value that stands for "keep the stored value" (not on the list)

  var boundEl = null;
  var searchText = '';
  var expandedOverrides = Object.create(null); // teamId -> true: override list open in "Team scores"

  // ------------------------------------------------------------------ small helpers

  function icon(name, cls) { return ui.icon(name, cls); }

  function prefs() {
    var st = GT.store.state;
    var raw = st && st.ui && st.ui.studentsPrefs && typeof st.ui.studentsPrefs === 'object' ? st.ui.studentsPrefs : {};
    return {
      filter: FILTERS.indexOf(raw.filter) !== -1 ? raw.filter : 'all',
      sort: SORTS.indexOf(raw.sort) !== -1 ? raw.sort : 'name',
      dir: raw.dir === 'desc' ? 'desc' : 'asc'
    };
  }

  function setPrefs(patch) {
    var next = prefs();
    Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
    GT.store.setUi({ studentsPrefs: next });
  }

  /** "Student No 12": used in toasts, menu headings and aria-labels instead of the name. */
  function studentRef(s) {
    return s && typeof s.no === 'number' ? 'Student No ' + s.no : 'Student (no number)';
  }

  function nameHtml(s, cls) {
    var n = model.studentName(s);
    return '<span class="pii' + (cls ? ' ' + cls : '') + '">' + (n ? esc(n) : '<em class="faint">(no name)</em>') + '</span>';
  }

  /** "No 12 · Last, First" (the name part is pii). */
  function refNameHtml(s) {
    return '<span class="ref-no">' + (typeof s.no === 'number' ? 'No ' + s.no : 'No number') + '</span> ' + nameHtml(s);
  }

  function teamOf(course, s) {
    return s && s.teamId ? model.findTeam(course, s.teamId) : null;
  }

  function teamGraded(course) {
    return course.assessments.filter(function (a) { return a.teamGraded; });
  }

  function isWithdrawn(s) { return s.status === 'withdrawn'; }

  // ------------------------------------------------------------------ finalized scores, final letters, drop-down lists
  // (STAGE2B, DECISIONS 8). The core helpers are used when present; the fallbacks keep the view working.

  /** True when the course's scores are finalized (score cells locked; final letters stay editable). */
  function isLocked(course) {
    if (!course) return false;
    if (typeof model.isFinalized === 'function') {
      try { return !!model.isFinalized(course); } catch (e) { /* fall back */ }
    }
    return !!(course.finalized && typeof course.finalized === 'object' && typeof course.finalized.at === 'string' && course.finalized.at !== '');
  }

  function finalLetterOf(s) {
    if (typeof model.finalLetterOf === 'function') return model.finalLetterOf(s);
    return s && typeof s.finalLetter === 'string' && s.finalLetter.trim() !== '' ? s.finalLetter : null;
  }

  /** The course's letters, highest cutoff first (the order of the Final letter drop-down). */
  function scaleLetters(course) {
    if (typeof model.scaleLetters === 'function') return model.scaleLetters(course);
    var seen = [];
    (course.settings.letterScale || []).slice().sort(function (a, b) { return b.min - a.min; }).forEach(function (r) {
      if (r && typeof r.letter === 'string' && seen.indexOf(r.letter) === -1) seen.push(r.letter);
    });
    return seen;
  }

  function choiceValues(a) {
    return typeof model.choiceValues === 'function' ? model.choiceValues(a) : [];
  }

  /** A drop-down value as the list shows it: 4.5, 0.25 (up to 6 decimals, no trailing zeros). */
  function choiceText(v) { return util.formatNumber(v, 6); }

  /** Final letter of a result (or the stored one), with its flags: { letter, valid, differs, suggested, orderIssue }. */
  function finalInfo(course, s, r) {
    var fl = r && r.finalLetter !== undefined ? r.finalLetter : finalLetterOf(s);
    var suggested = r ? r.letter : '';
    var valid = r && typeof r.finalLetterValid === 'boolean' ? r.finalLetterValid : (fl === null || scaleLetters(course).indexOf(fl) !== -1);
    var differs = r && typeof r.letterDiffers === 'boolean' ? r.letterDiffers : (fl !== null && fl !== suggested);
    return { letter: fl, valid: valid, differs: differs, suggested: suggested, orderIssue: !!(r && r.orderIssue) };
  }

  /** Raw text as entered: the number, or the invalid text, or ''. */
  function entryText(e) {
    if (!e) return '';
    if (typeof e.value === 'number') return String(e.value);
    return typeof e.text === 'string' ? e.text : '';
  }

  function entryLabel(e) {
    var t = entryText(e);
    var late = e && e.weeksLate > 0 ? ' (' + e.weeksLate + ' wk late' + (e.waived ? ', waived' : '') + ')' : '';
    return (t === '' ? '—' : t) + late;
  }

  function fmt(x) {
    return x === null || x === undefined || !isFinite(x) ? '—' : ui.fmt(x);
  }

  function signed(x) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    if (x === 0) return '0';
    return (x > 0 ? '+' : '−') + ui.fmt(Math.abs(x));
  }

  function ordinal(x) {
    var n = Math.round(x);
    var m100 = n % 100, m10 = n % 10;
    var suf = (m100 >= 11 && m100 <= 13) ? 'th' : m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th';
    return n + suf;
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function truncate(s, n) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function groupClass(course, a) {
    var i = course.assessments.indexOf(a);
    return 'grp-' + Math.min(i + 1, 6);
  }

  /** Compact placeholder badges for an assessment's weight: project split (project items) and
   * Term Paper weight. Empty string once confirmed. */
  function weightBadges(course, a) {
    return (a.category === 'project' ? ui.placeholderBadge(course, 'projectSplit', { compact: true }) : '') +
      (a.id === 'a_paper' ? ui.placeholderBadge(course, 'termPaperWeight', { compact: true }) : '');
  }

  function cssKey(k) {
    if (root.CSS && root.CSS.escape) return root.CSS.escape(k);
    return String(k).replace(/["\\\[\]]/g, '\\$&');
  }

  /** Remembers the focused control (by data-fk) and any typed draft, so a re-render keeps them. */
  function captureFocus(host) {
    var a = document.activeElement;
    if (!a || !host || !host.contains(a)) return null;
    var key = a.getAttribute('data-fk');
    if (!key) return null;
    var info = { key: key };
    if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') {
      info.value = a.value;
      info.dirty = a.value !== a.defaultValue;
      try { info.start = a.selectionStart; info.end = a.selectionEnd; } catch (e) { info.start = null; }
    } else if (a.tagName === 'SELECT' && a.hasAttribute('data-ts-pending')) {
      info.value = a.value;   // a team-score drop-down browsed to with the keyboard, not saved yet
      info.dirty = true;
      info.pending = true;
      info.kbd = tsKbdSel === a;
    }
    return info;
  }

  function restoreFocus(host, info) {
    if (!info) return;
    var t = host.querySelector('[data-fk="' + cssKey(info.key) + '"]');
    if (!t) return;
    if (info.dirty && typeof info.value === 'string') t.value = info.value;
    if (info.pending && isTeamSelect(t) && t.value === info.value && t.value !== savedTeamValue(t)) {
      setTeamPending(t, true);
      if (info.kbd) tsKbdSel = t;
    }
    try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); }
    if (info.start !== null && info.start !== undefined && t.setSelectionRange) {
      try { t.setSelectionRange(info.start, info.end); } catch (e2) { /* not a text input */ }
    }
  }

  /** Expected team size from the course template (informational only). */
  function sizeRange(course) {
    if (course.template === 'SE4351') return { min: 7, max: 8, label: '7–8' };
    if (course.template === 'SE6362') return { min: 2, max: 4, label: 'about 3' };
    return null;
  }

  function findTeamByName(course, name, exceptId) {
    var k = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!k) return null;
    return course.teams.filter(function (t) {
      return t.id !== exceptId && String(t.name || '').replace(/\s+/g, ' ').trim().toLowerCase() === k;
    })[0] || null;
  }

  function suggestTeamName(course) {
    for (var i = 1; i < 1000; i++) if (!findTeamByName(course, 'Team ' + i)) return 'Team ' + i;
    return 'New team';
  }

  function nameKey(last, first) {
    return (String(last || '').replace(/\s+/g, ' ').trim() + '\u0000' + String(first || '').replace(/\s+/g, ' ').trim()).toLowerCase();
  }

  /** Clipboard text -> rows of cells. Uses GT.csv when it is loaded; else lines on newline, cells on tab. */
  function parseRows(text) {
    if (GT.csv && typeof GT.csv.parseClipboard === 'function') {
      try { return GT.csv.parseClipboard(text); } catch (e) { /* fall through */ }
    }
    var s = String(text || '').replace(/\r\n?/g, '\n');
    if (s.slice(-1) === '\n') s = s.slice(0, -1);
    if (s === '') return [];
    return s.split('\n').map(function (line) { return line.split('\t'); });
  }

  /** Identifies the current latest undo step of the active course (null if courseId is not active).
   * Labels repeat ("Edit team score", "Withdraw student"), so the mark also holds the course's history
   * length and last entry id: every later change, undo or redo appends history entries and changes it. */
  function undoMark(courseId) {
    var c = GT.store.course();
    if (!c || c.id !== courseId) return null;
    var hist = Array.isArray(c.history) ? c.history : [];
    var last = hist.length ? hist[hist.length - 1] : null;
    return JSON.stringify([
      GT.store.undoLabel(),
      typeof GT.store.undoStepId === 'function' ? GT.store.undoStepId() : null,
      hist.length,
      last && last.id ? last.id : null
    ]);
  }

  /** Toast "Undo" button. Call it right after the transact: it undoes that change only while it is still
   * the latest undo step of its course, never a newer change that has the same label. */
  function undoAction(courseId, label) {
    var mark = undoMark(courseId);
    return {
      label: 'Undo',
      fn: function () {
        if (mark && undoMark(courseId) === mark && (!label || GT.store.undoLabel() === label)) GT.store.undo();
        else ui.toast('Not undone: it was already undone, or newer changes came after it. Use Undo (Ctrl+Z) step by step.', { type: 'warn' });
      }
    };
  }

  // ------------------------------------------------------------------ moving students between teams

  /** Team-graded items whose visible score would change when the student moves (without keepScores). */
  function scoreConflicts(course, s, targetTeamId, isNewTeam) {
    var target = !isNewTeam && targetTeamId && model.findTeam(course, targetTeamId) ? targetTeamId : null;
    var current = s.teamId && model.findTeam(course, s.teamId) ? s.teamId : null;
    if (!isNewTeam && target === current) return [];
    var out = [];
    teamGraded(course).forEach(function (a) {
      var cur = model.effectiveEntry(course, s, a);
      if (!model.hasScore(cur)) return;
      var next = target ? model.getEntry(course.teamScores, target, a.id) : null;
      if (model.entryKey(cur) !== model.entryKey(next)) out.push({ a: a, cur: cur, next: next });
    });
    return out;
  }

  /** Asks whether moved students keep their current team-graded scores. Resolves with
   * { keepScores } or null (cancelled). Resolves { keepScores: false } without asking when no
   * visible score would change. */
  function askKeepScores(course, students, targetTeamId, targetName, isNewTeam) {
    var affected = [];
    students.forEach(function (s) {
      var c = scoreConflicts(course, s, targetTeamId, isNewTeam);
      if (c.length) affected.push({ s: s, conflicts: c });
    });
    if (!affected.length) return Promise.resolve({ keepScores: false });
    var toTeam = !!(targetTeamId || isNewTeam);
    var items = teamGraded(course).filter(function (a) {
      return affected.some(function (x) { return x.conflicts.some(function (c) { return c.a.id === a.id; }); });
    }).map(function (a) { return a.name; });
    var itemText = items.join(', ');
    var who = affected.length === 1 ? esc(studentRef(affected[0].s)) + ' has' : affected.length + ' of these students have';
    var colHead = toTeam ? esc(targetName) + (isNewTeam ? ' (new team)' : ' team score') : 'Without a team';
    var rows = '';
    affected.slice(0, 15).forEach(function (x, xi, shown) {
      x.conflicts.forEach(function (c, k) {
        rows += '<tr>' + (k === 0 ? '<td rowspan="' + x.conflicts.length + '"' + (xi === shown.length - 1 ? ' class="last-group"' : '') + '>' + refNameHtml(x.s) + '</td>' : '') +
          '<td>' + esc(c.a.name) + '</td><td class="num">' + esc(entryLabel(c.cur)) + '</td><td class="num">' + esc(entryLabel(c.next)) + '</td></tr>';
      });
    });
    var more = affected.length > 15 ? '<p class="muted small">… and ' + (affected.length - 15) + ' more.</p>' : '';
    var intro = toTeam
      ? '<p>' + who + ' ' + esc(itemText) + ' scores that differ from ' + esc(targetName) + '’s team score.</p>' +
        '<p><strong>Keep current scores</strong> saves them as per-member overrides (◆); an unequal split needs the team’s written agreement. ' +
        '<strong>Use the new team’s scores</strong> makes them follow ' + esc(targetName) + '’s team score.</p>'
      : '<p>' + who + ' ' + esc(itemText) + ' scores from their team. Without a team, a team-graded item uses the student’s individual score.</p>' +
        '<p><strong>Keep as individual scores</strong> copies the current scores. <strong>Clear them</strong> leaves those items empty (counted as 0).</p>';
    return ui.dialog.open({
      title: 'Keep current team scores?',
      wide: true,
      bodyHtml: intro + '<div class="table-wrap keep-table-wrap"><table class="table keep-table"><thead><tr><th scope="col">Student</th>' +
        '<th scope="col">Assessment</th><th scope="col" class="num">Current score</th><th scope="col" class="num">' + colHead + '</th></tr></thead><tbody>' +
        rows + '</tbody></table></div>' + more,
      buttons: [
        { text: 'Cancel', value: null },
        { spacer: true },
        { text: toTeam ? 'Use the new team’s scores' : 'Clear them', value: 'use' },
        { text: toTeam ? 'Keep current scores (as overrides)' : 'Keep as individual scores', value: 'keep', primary: true }
      ]
    }).then(function (v) {
      if (v === 'keep') return { keepScores: true };
      if (v === 'use') return { keepScores: false };
      return null;
    });
  }

  /** Moves students to a team (or to no team with null), asking about their team-graded scores first.
   * Refused while the scores are finalized: a move changes team cells and can change totals (a student
   * without a score takes the new team's score), so it is locked like the Team cells of the grid. */
  function moveStudents(ids, targetTeamId, label) {
    var course = GT.store.course();
    if (!course) return Promise.resolve(null);
    if (refuseLocked(course)) return Promise.resolve(null);
    var target = targetTeamId ? model.findTeam(course, targetTeamId) : null;
    var list = ids.map(function (id) { return model.findStudent(course, id); }).filter(function (s) {
      if (!s) return false;
      var cur = teamOf(course, s);
      return (cur ? cur.id : null) !== (target ? target.id : null);
    });
    if (!list.length) return Promise.resolve(null);
    var courseId = course.id;
    return askKeepScores(course, list, target ? target.id : null, target ? target.name : '', false).then(function (ans) {
      if (!ans) return null;
      var sids = list.map(function (s) { return s.id; });
      GT.store.transact(label, function (c) {
        sids.forEach(function (sid) { model.moveStudentToTeam(c, sid, target ? target.id : null, { keepScores: ans.keepScores }); });
      }, { courseId: courseId });
      var msg = (sids.length === 1 ? studentRef(list[0]) : plural(sids.length, 'student')) +
        (target ? ' moved to ' + target.name : ' now ' + (sids.length === 1 ? 'has' : 'have') + ' no team') +
        (ans.keepScores ? (target ? ' (scores kept as overrides ◆)' : ' (scores kept as individual scores)') : '') + '.';
      ui.toast(msg, { type: 'success', action: undoAction(courseId, label) });
      return { moved: sids.length, keepScores: ans.keepScores };
    });
  }

  // ------------------------------------------------------------------ add / edit student

  function fieldHtml(id, label, control, cls) {
    return '<div class="field' + (cls ? ' ' + cls : '') + '"><label for="' + id + '">' + label + '</label>' + control + '</div>';
  }

  function readStudentForm(dlg, studentId) {
    var course = GT.store.course();
    var noText = dlg.querySelector('#sf-no').value.trim();
    var no = null;
    if (noText !== '') {
      if (!/^\d+$/.test(noText) || Number(noText) < 1 || Number(noText) > 1e6) return { error: 'No must be a whole number of 1 or more, or empty.' };
      no = Number(noText);
      var clash = course.students.filter(function (x) { return x.id !== studentId && x.no === no; })[0];
      if (clash) return { error: 'No ' + no + ' is already used by another student. Pick another number (or use “Renumber by name” later).' };
    }
    var last = dlg.querySelector('#sf-last').value.replace(/\s+/g, ' ').trim();
    var first = dlg.querySelector('#sf-first').value.replace(/\s+/g, ' ').trim();
    if (!last && !first) return { error: 'Enter a last name or a first name.' };
    var teamVal = dlg.querySelector('#sf-team').value;
    var newTeamName = '';
    var teamId = teamVal && teamVal !== NEW_TEAM ? teamVal : null;
    if (teamVal === NEW_TEAM) {
      newTeamName = dlg.querySelector('#sf-newteam').value.replace(/\s+/g, ' ').trim();
      if (!newTeamName) return { error: 'Enter a name for the new team.' };
      var existing = findTeamByName(course, newTeamName);
      if (existing) { teamId = existing.id; newTeamName = ''; }
    }
    return {
      no: no, lastName: last, firstName: first, teamId: teamId, newTeamName: newTeamName,
      notes: dlg.querySelector('#sf-notes').value
    };
  }

  /** Opens the add (studentId null) or edit dialog. Resolves with the student id, or null.
   * Finalized scores: adding is refused; editing opens with No, names and team read-only (notes only). */
  function openStudentForm(studentId) {
    var course = GT.store.course();
    if (!course) return Promise.resolve(null);
    var s = studentId ? model.findStudent(course, studentId) : null;
    if (studentId && !s) { ui.toast('That student no longer exists.', { type: 'warn' }); return Promise.resolve(null); }
    var isNew = !s;
    if (isNew && refuseLocked(course, ADD_LOCKED_MSG)) return Promise.resolve(null);
    var locked = !isNew && isLocked(course);
    var ro = locked ? ' readonly aria-readonly="true" title="' + esc(LOCKED_MSG) + '"' : '';
    var no = s ? s.no : model.nextStudentNo(course);
    var curTeam = s ? teamOf(course, s) : null;
    var options = '<option value="">(no team)</option>' + course.teams.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (curTeam && curTeam.id === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>';
    }).join('') + '<option value="' + NEW_TEAM + '">New team…</option>';
    var html =
      (locked ? '<div class="callout callout-warn st-lock-note">' + icon('lock') + '<span><strong>Scores are finalized.</strong> ' +
        'No, name and team are locked; the notes stay editable. Unlock the scores (Grades tab or Settings › Grading status) to change them.</span></div>' : '') +
      '<div class="sf-grid">' +
      fieldHtml('sf-no', 'No', '<input id="sf-no" type="text" inputmode="numeric" autocomplete="off" value="' + esc(no === null || no === undefined ? '' : no) + '"' + ro + '>', 'sf-no-field') +
      fieldHtml('sf-last', 'Last name', '<input id="sf-last" type="text" class="pii" autocomplete="off" spellcheck="false" value="' + esc(s ? s.lastName : '') + '"' + ro + '>') +
      fieldHtml('sf-first', 'First name', '<input id="sf-first" type="text" class="pii" autocomplete="off" spellcheck="false" value="' + esc(s ? s.firstName : '') + '"' + ro + '>') +
      '</div>' +
      fieldHtml('sf-team', 'Team', '<select id="sf-team"' + (locked ? ' disabled title="' + esc(LOCKED_MSG) + '"' : '') + '>' + options + '</select>' +
        (s && !locked && teamGraded(course).length ? '<div class="help">Changing the team asks whether to keep this student’s current team-graded scores.</div>' : '')) +
      '<div class="field" id="sf-newteam-field" hidden><label for="sf-newteam">New team name</label>' +
      '<input id="sf-newteam" type="text" autocomplete="off" value="' + esc(suggestTeamName(course)) + '"></div>' +
      fieldHtml('sf-notes', 'Notes', '<textarea id="sf-notes" class="pii" rows="3" spellcheck="true">' + esc(s ? s.notes : '') + '</textarea>' +
        '<div class="help">Private notes. They stay in this browser and in your backups.</div>');
    var result = null;
    return ui.dialog.open({
      title: isNew ? 'Add student' : 'Edit ' + studentRef(s),
      bodyHtml: html,
      buttons: [
        { text: 'Cancel', value: null },
        {
          text: isNew ? 'Add student' : locked ? 'Save notes' : 'Save', primary: true,
          validate: function (dlg) {
            // Locked: only the notes are read (No, names and team are read-only and never saved).
            if (locked) { result = { notesOnly: true, notes: dlg.querySelector('#sf-notes').value }; return null; }
            var r = readStudentForm(dlg, studentId);
            if (r.error) return r.error;
            result = r;
            return null;
          },
          value: function () { return result; }
        }
      ],
      initialFocus: locked ? '#sf-notes' : '#sf-last',
      onMount: function (dlg) {
        var sel = dlg.querySelector('#sf-team');
        var nf = dlg.querySelector('#sf-newteam-field');
        sel.addEventListener('change', function () {
          nf.hidden = sel.value !== NEW_TEAM;
          if (!nf.hidden) { var inp = dlg.querySelector('#sf-newteam'); inp.focus(); inp.select(); }
        });
      }
    }).then(function (v) {
      if (!v) return null;
      return applyStudentForm(course.id, studentId, v);
    });
  }

  function applyStudentForm(courseId, studentId, v) {
    var course = model.findCourse(GT.store.state, courseId);
    if (!course) return Promise.resolve(null);
    if (v.notesOnly || isLocked(course)) return applyNotesOnly(course, studentId, v);
    if (!studentId) {
      var newId = GT.store.transact('Add student', function (c) {
        var tid = v.teamId && model.findTeam(c, v.teamId) ? v.teamId : null;
        if (v.newTeamName) { var t = model.createTeam(v.newTeamName); c.teams.push(t); tid = t.id; }
        var st = model.createStudent({ no: v.no, lastName: v.lastName, firstName: v.firstName, teamId: tid, notes: v.notes });
        c.students.push(st);
        return st.id;
      }, { courseId: courseId });
      ui.toast((v.no !== null ? 'Student No ' + v.no : 'Student') + ' added.', { type: 'success', action: undoAction(courseId, 'Add student') });
      return Promise.resolve(newId);
    }
    var s = model.findStudent(course, studentId);
    if (!s) return Promise.resolve(null);
    var cur = teamOf(course, s);
    var teamChanging = !!v.newTeamName || (cur ? cur.id : null) !== (v.teamId || null);
    var targetName = v.newTeamName || (v.teamId ? (model.findTeam(course, v.teamId) || {}).name : '');
    var ask = teamChanging
      ? askKeepScores(course, [s], v.teamId, targetName, !!v.newTeamName)
      : Promise.resolve({ keepScores: false });
    return ask.then(function (ans) {
      if (!ans) { ui.toast('Nothing was changed.'); return null; }
      GT.store.transact('Edit student', function (c) {
        var x = model.findStudent(c, studentId);
        if (!x) return;
        x.no = v.no;
        x.lastName = v.lastName;
        x.firstName = v.firstName;
        x.notes = v.notes;
        if (teamChanging) {
          var tid = v.teamId || null;
          if (v.newTeamName) { var t = model.createTeam(v.newTeamName); c.teams.push(t); tid = t.id; }
          model.moveStudentToTeam(c, studentId, tid, { keepScores: ans.keepScores });
        }
      }, { courseId: courseId });
      return studentId;
    });
  }

  /** Finalized scores (or a form opened read-only): saves the notes only. No, names and team are never
   * saved while the scores are finalized. */
  function applyNotesOnly(course, studentId, v) {
    var s = studentId ? model.findStudent(course, studentId) : null;
    if (!s) { lockedToast(ADD_LOCKED_MSG); return Promise.resolve(null); }
    if (!v.notesOnly) lockedToast(); // an editable form reached a locked course: its No, names and team are not saved
    if (sameNotes(s.notes, v.notes)) return Promise.resolve(studentId);
    GT.store.transact('Edit notes', function (c) {
      var x = model.findStudent(c, studentId);
      if (x) x.notes = v.notes;
    }, { courseId: course.id });
    return Promise.resolve(studentId);
  }

  // ------------------------------------------------------------------ withdraw, reinstate, delete, renumber

  function toggleStatus(studentId) {
    var course = GT.store.course();
    var s = course && model.findStudent(course, studentId);
    if (!s) return Promise.resolve(false);
    var courseId = course.id;
    var withdrawing = !isWithdrawn(s);
    var who = '<strong>' + esc(studentRef(s)) + '</strong> (' + nameHtml(s) + ')';
    var html = withdrawing
      ? '<p>Withdraw ' + who + '?</p>' +
        '<p>Withdrawn students are never deleted. They stay in the change history and in exports (with a Status column) and are shown greyed out. ' +
        'They are <strong>excluded</strong> from statistics, rank, percentile and the class average.</p>' +
        '<p class="muted">You can reinstate the student at any time, or undo with Ctrl+Z.</p>'
      : '<p>Reinstate ' + who + ' as an active student?</p>' +
        '<p>The student counts again in statistics, rank, percentile and the class average.</p>';
    return ui.dialog.confirm({
      title: withdrawing ? 'Withdraw student' : 'Reinstate student',
      messageHtml: html,
      confirmText: withdrawing ? 'Withdraw' : 'Reinstate'
    }).then(function (ok) {
      if (!ok) return false;
      setStatus(courseId, studentId, withdrawing ? 'withdrawn' : 'active');
      return true;
    });
  }

  function setStatus(courseId, studentId, status) {
    var course = model.findCourse(GT.store.state, courseId);
    var s = course && model.findStudent(course, studentId);
    if (!s) return;
    var label = status === 'withdrawn' ? 'Withdraw student' : 'Reinstate student';
    GT.store.transact(label, function (c) {
      var x = model.findStudent(c, studentId);
      if (x) x.status = status;
    }, { courseId: courseId });
    ui.toast(studentRef(s) + (status === 'withdrawn' ? ' withdrawn: excluded from statistics, rank and average.' : ' reinstated.'),
      { type: 'success', action: undoAction(courseId, label) });
  }

  function deleteFlow(studentId) {
    var course = GT.store.course();
    var s = course && model.findStudent(course, studentId);
    if (!s) return Promise.resolve(false);
    // Deleting removes finalized scores: refused while locked (withdrawing stays possible).
    if (refuseLocked(course, 'Scores are finalized. Unlock them to delete a student, or withdraw the student instead.')) return Promise.resolve(false);
    var courseId = course.id;
    var req = typeof s.no === 'number' ? String(s.no) : 'DELETE';
    var scoreCount = util.hasOwn(course.scores, s.id) ? Object.keys(course.scores[s.id]).length : 0;
    var att = course.attendance || {};
    var marks = att.records && util.hasOwn(att.records, s.id) ? Object.keys(att.records[s.id]).length : 0;
    var html =
      '<div class="callout callout-danger"><strong>This permanently deletes ' + esc(studentRef(s)) + '</strong> (' + nameHtml(s) + ') ' +
      'with their scores (' + plural(scoreCount, 'entry', 'entries') + '), per-member overrides, attendance records (' + plural(marks, 'mark') + ') and absence totals. ' +
      'The change history keeps only a note that the student was deleted.</div>' +
      '<p class="del-advice">If the student dropped the course, <strong>withdraw</strong> them instead: withdrawn students stay in history and exports and are excluded from statistics.</p>' +
      '<div class="field"><label for="del-confirm">Type ' + (req === 'DELETE' ? '<strong>DELETE</strong>' : 'the student’s No, <strong>' + esc(req) + '</strong>,') +
      ' to confirm</label><input id="del-confirm" type="text" autocomplete="off" spellcheck="false" inputmode="' + (req === 'DELETE' ? 'text' : 'numeric') + '"></div>';
    var buttons = [];
    if (!isWithdrawn(s)) buttons.push({ text: 'Withdraw instead', value: 'withdraw' });
    buttons.push({ spacer: true }, { text: 'Cancel', value: null }, {
      text: 'Delete permanently', value: 'delete', primary: true, danger: true,
      validate: function (dlg) {
        var v = dlg.querySelector('#del-confirm').value.trim();
        return v === req ? null : 'Type ' + req + ' exactly to delete this student.';
      }
    });
    return ui.dialog.open({
      title: 'Delete student permanently',
      bodyHtml: html,
      buttons: buttons,
      initialFocus: '#del-confirm'
    }).then(function (v) {
      if (v === 'withdraw') { setStatus(courseId, studentId, 'withdrawn'); return false; }
      if (v !== 'delete') return false;
      GT.store.transact('Delete student permanently', function (c) { model.deleteStudent(c, studentId); }, { courseId: courseId });
      ui.toast(studentRef(s) + ' deleted permanently.', { type: 'success', action: undoAction(courseId, 'Delete student permanently') });
      return true;
    });
  }

  function renumberFlow() {
    var course = GT.store.course();
    if (!course || !course.students.length) return Promise.resolve(false);
    if (refuseLocked(course)) return Promise.resolve(false);
    var n = course.students.length;
    var courseId = course.id;
    return ui.dialog.confirm({
      title: 'Renumber by name',
      messageHtml: '<p>Assign No 1–' + n + ' in name order (last name, then first name), active and withdrawn students together?</p>' +
        '<p class="muted">The current numbers are replaced. You can undo this with Ctrl+Z.</p>',
      confirmText: 'Renumber'
    }).then(function (ok) {
      if (!ok) return false;
      var now = model.findCourse(GT.store.state, courseId);
      if (!now || refuseLocked(now)) return false;
      GT.store.transact('Renumber by name', function (c) { model.renumberByName(c); }, { courseId: courseId });
      ui.toast('Renumbered ' + plural(n, 'student') + ' in name order.', { type: 'success', action: undoAction(courseId, 'Renumber by name') });
      return true;
    });
  }

  // ------------------------------------------------------------------ teams

  function validateTeamName(course, v, exceptId) {
    var name = String(v || '').replace(/\s+/g, ' ').trim();
    if (!name) return 'Enter a team name.';
    if (name.length > 80) return 'Keep the team name under 80 characters.';
    if (findTeamByName(course, name, exceptId)) return 'A team named “' + name + '” already exists.';
    return null;
  }

  function newTeamFlow() {
    var course = GT.store.course();
    if (!course) return;
    var courseId = course.id;
    ui.dialog.prompt({
      title: 'New team', label: 'Team name', value: suggestTeamName(course), confirmText: 'Create team',
      validate: function (v) { return validateTeamName(GT.store.course(), v); }
    }).then(function (name) {
      if (name === null) return;
      var clean = name.replace(/\s+/g, ' ').trim();
      GT.store.transact('Create team', function (c) { c.teams.push(model.createTeam(clean)); }, { courseId: courseId });
      ui.toast('Team “' + clean + '” created. Add members to it.', { type: 'success' });
    });
  }

  function createTeamsFlow() {
    var course = GT.store.course();
    if (!course) return;
    var courseId = course.id;
    var range = sizeRange(course);
    var active = course.students.filter(function (s) { return !isWithdrawn(s); }).length;
    var fit = range && active ? Math.max(1, Math.round(active / ((range.min + range.max) / 2))) : 0;
    var suggestion = fit ? Math.max(1, fit - course.teams.length) : 4;
    var intro = '<p>Creates empty teams named Team 1 … Team N. Names that are already in use are skipped.</p>' +
      (fit ? '<p class="muted">' + esc(course.code) + ' teams usually have ' + esc(range.label) + ' members: about ' +
        fit + ' teams fit ' + active + ' active students' + (course.teams.length ? ' (' + plural(course.teams.length, 'team') + ' exist already)' : '') + '.</p>' : '') +
      '<p class="muted">Add members to each team afterwards (Add members in each team box).</p>';
    ui.dialog.form({
      title: 'Create teams',
      introHtml: intro,
      fields: [{ name: 'count', label: 'Number of teams', type: 'number', value: suggestion, min: 1, max: 50, step: 1 }],
      confirmText: 'Create teams',
      validate: function (v) {
        var n = util.parseCount(v.count);
        return n === null || n < 1 || n > 50 ? 'Enter a whole number from 1 to 50.' : null;
      }
    }).then(function (v) {
      if (!v) return;
      var n = util.parseCount(v.count);
      var names = [];
      var label = 'Create ' + plural(n, 'team');
      GT.store.transact(label, function (c) {
        names = [];
        for (var k = 1; names.length < n && k < 10000; k++) {
          var nm = 'Team ' + k;
          if (!findTeamByName(c, nm)) { c.teams.push(model.createTeam(nm)); names.push(nm); }
        }
      }, { courseId: courseId });
      ui.toast('Created ' + plural(names.length, 'team') + (names.length ? ': ' + names[0] + (names.length > 1 ? ' … ' + names[names.length - 1] : '') : '') + '.',
        { type: 'success', action: undoAction(courseId, label) });
    });
  }

  function renameTeamFlow(teamId) {
    var course = GT.store.course();
    var t = course && model.findTeam(course, teamId);
    if (!t) return;
    var courseId = course.id;
    ui.dialog.prompt({
      title: 'Rename team', label: 'Team name', value: t.name, confirmText: 'Rename',
      validate: function (v) { return validateTeamName(GT.store.course(), v, teamId); }
    }).then(function (name) {
      if (name === null) return;
      var clean = name.replace(/\s+/g, ' ').trim();
      if (clean === t.name) return;
      GT.store.transact('Rename team', function (c) {
        var x = model.findTeam(c, teamId);
        if (x) x.name = clean;
      }, { courseId: courseId });
    });
  }

  function deleteTeamFlow(teamId) {
    var course = GT.store.course();
    var t = course && model.findTeam(course, teamId);
    if (!t) return;
    var courseId = course.id;
    var members = model.teamMembers(course, teamId);
    // Finalized: a team with members or team scores is locked (its members' team and scores would change).
    if (isLocked(course) && (members.length || hasTeamEntries(course, teamId))) {
      lockedToast('Scores are finalized. Unlock them to delete a team that has members or team scores.');
      return;
    }
    var scored = teamGraded(course).map(function (a) {
      return { a: a, e: model.getEntry(course.teamScores, teamId, a.id) };
    }).filter(function (x) { return model.hasScore(x.e); });
    var itemNames = teamGraded(course).map(function (a) { return a.name; }).join(', ');
    var html = '<p>Delete <strong>' + esc(t.name) + '</strong>? ' +
      (members.length ? 'Its ' + plural(members.length, 'member') + ' move to “No team”.' : 'It has no members.') + '</p>';
    if (scored.length) {
      html += '<div class="callout callout-warn">Team scores of ' + esc(t.name) + ': ' + scored.map(function (x) {
        return esc(x.a.name) + ' <strong class="num">' + esc(entryLabel(x.e)) + '</strong>';
      }).join(' · ') + '. They are deleted with the team.</div>';
    }
    if (members.length && teamGraded(course).length) {
      html += '<div class="field del-team-keep"><label class="check"><input type="checkbox" id="dt-keep"' + (scored.length ? ' checked' : '') + '> ' +
        'Keep each member’s current ' + esc(itemNames) + ' scores as individual scores</label>' +
        '<div class="help">Unchecked: members without a team have empty ' + esc(itemNames) + ' scores (counted as 0) until you enter them.</div></div>';
    }
    ui.dialog.open({
      title: 'Delete team',
      bodyHtml: html,
      buttons: [
        { text: 'Cancel', value: null },
        {
          text: 'Delete team', primary: true, danger: true,
          value: function (dlg) { var k = dlg.querySelector('#dt-keep'); return { keep: !!(k && k.checked) }; }
        }
      ]
    }).then(function (v) {
      if (!v) return;
      delete expandedOverrides[teamId];
      GT.store.transact('Delete team', function (c) { model.removeTeam(c, teamId, { keepScores: v.keep }); }, { courseId: courseId });
      ui.toast(t.name + ' deleted' + (members.length ? ': ' + plural(members.length, 'student') + ' now ' + (members.length === 1 ? 'has' : 'have') + ' no team' : '') + '.',
        { type: 'success', action: undoAction(courseId, 'Delete team') });
    });
  }

  function addMembersFlow(teamId) {
    var course = GT.store.course();
    var t = course && model.findTeam(course, teamId);
    if (!t) return;
    if (refuseLocked(course)) return;
    var candidates = calc.sortStudents(course, null, 'name', 'asc').filter(function (s) { return s.teamId !== teamId; });
    if (!candidates.length) { ui.toast(course.students.length ? 'Every student is already in ' + t.name + '.' : 'Add students first.'); return; }
    var items = candidates.map(function (s) {
      var cur = teamOf(course, s);
      return '<label class="check am-item' + (isWithdrawn(s) ? ' is-withdrawn' : '') + '"><input type="checkbox" value="' + esc(s.id) + '">' +
        '<span class="am-no num">' + (typeof s.no === 'number' ? s.no : '–') + '</span>' + nameHtml(s, 'am-name') +
        '<span class="am-team">' + (cur ? esc(cur.name) : 'No team') + '</span>' +
        (isWithdrawn(s) ? '<span class="badge">Withdrawn</span>' : '') + '</label>';
    }).join('');
    var body = ui.el('<div class="am">' +
      '<div class="am-tools"><div class="search">' + icon('search') + '<input type="search" id="am-search" placeholder="Filter by name, No or team" aria-label="Filter students" autocomplete="off"></div>' +
      '<label class="check"><input type="checkbox" id="am-unassigned"> Only students without a team</label></div>' +
      '<div class="am-list" role="group" aria-label="Students not in ' + esc(t.name) + '">' + items + '</div>' +
      '<div class="am-count muted small" aria-live="polite">0 selected</div></div>');
    function update() {
      var q = body.querySelector('#am-search').value.trim().toLowerCase();
      var onlyNone = body.querySelector('#am-unassigned').checked;
      ui.$$('.am-item', body).forEach(function (lab) {
        var text = lab.textContent.toLowerCase();
        var noTeam = lab.querySelector('.am-team').textContent === 'No team';
        lab.hidden = (q && q.split(/\s+/).some(function (w) { return text.indexOf(w) === -1; })) || (onlyNone && !noTeam);
      });
      var n = ui.$$('.am-item input:checked', body).length;
      body.querySelector('.am-count').textContent = n + ' selected';
    }
    ui.dialog.open({
      title: 'Add members to ' + t.name,
      body: body,
      buttons: [
        { text: 'Cancel', value: null },
        {
          text: 'Add selected', primary: true,
          validate: function (dlg) { return ui.$$('.am-item input:checked', dlg).length ? null : 'Select at least one student.'; },
          value: function (dlg) { return ui.$$('.am-item input:checked', dlg).map(function (i) { return i.value; }); }
        }
      ],
      initialFocus: '#am-search',
      onMount: function () {
        body.addEventListener('input', update);
        body.addEventListener('change', update);
        body.querySelector('#am-search').addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); }
        });
      }
    }).then(function (ids) {
      if (!ids || !ids.length) return;
      moveStudents(ids, teamId, 'Add members to ' + t.name);
    });
  }

  function moveMenu(anchor, studentId) {
    var course = GT.store.course();
    var s = course && model.findStudent(course, studentId);
    if (!s) return;
    if (refuseLocked(course)) return;
    var cur = teamOf(course, s);
    var items = [{ heading: 'Move ' + studentRef(s) + ' to' }];
    if (!course.teams.length) items.push({ label: 'No teams yet', disabled: true });
    course.teams.forEach(function (t) {
      var here = cur && cur.id === t.id;
      var n = model.teamMembers(course, t.id).filter(function (x) { return !isWithdrawn(x); }).length;
      items.push({
        label: t.name, icon: 'users', disabled: here, hint: here ? 'current' : String(n),
        onSelect: function () { moveStudents([studentId], t.id, 'Move student to ' + t.name); }
      });
    });
    items.push({ separator: true });
    items.push({ label: 'No team', icon: 'x', disabled: !cur, onSelect: function () { moveStudents([studentId], null, 'Remove student from team'); } });
    ui.menu(anchor, items, { alignRight: true });
  }

  function rowMenu(anchor, studentId) {
    var course = GT.store.course();
    var s = course && model.findStudent(course, studentId);
    if (!s) return;
    var w = isWithdrawn(s);
    var locked = isLocked(course);
    // Finalized: the locked items stay in the menu (marked "locked"); choosing one says why, with Unlock.
    ui.menu(anchor, [
      { heading: studentRef(s) },
      { label: 'Details', icon: 'user', onSelect: function () { ui.openStudent(studentId); } },
      { label: locked ? 'Edit notes…' : 'Edit…', icon: 'edit', onSelect: function () { openStudentForm(studentId); } },
      { label: 'Move to team…', icon: 'users', hint: locked ? 'locked' : '', onSelect: function () { moveMenu(anchor, studentId); } },
      { label: w ? 'Reinstate…' : 'Withdraw…', icon: w ? 'undo' : 'flag', onSelect: function () { toggleStatus(studentId); } },
      { separator: true },
      { label: 'Delete permanently…', icon: 'trash', danger: true, hint: locked ? 'locked' : '', onSelect: function () { deleteFlow(studentId); } }
    ], { alignRight: true });
  }

  // ------------------------------------------------------------------ team scores

  // A team score is a text field, or a <select> for an item with a drop-down list (DECISIONS 8). A pick
  // from the opened list (mouse, or Enter in the list) saves at once. Browsing a closed list with the
  // keyboard (arrows, Home/End, PageUp/PageDown, typing) only shows the value ("pending") until Enter or
  // leaving the list, so one choice is one History entry and one undo step, as in the student details
  // dialog. Esc shows the saved value again.
  var TS_BROWSE_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Home: 1, End: 1, PageUp: 1, PageDown: 1 };
  var tsKbdSel = null; // the team-score drop-down whose last value change came from keyboard browsing

  function isTeamControl(t) {
    return !!t && !!t.classList && (t.classList.contains('ts-input') || t.classList.contains('ts-select'));
  }

  function isTeamSelect(t) {
    return !!t && t.tagName === 'SELECT' && !!t.classList && t.classList.contains('ts-select');
  }

  /** The saved value of a team-score control: the rendered text, or the rendered choice of a drop-down. */
  function savedTeamValue(ctrl) {
    if (ctrl.tagName !== 'SELECT') return ctrl.defaultValue;
    for (var i = 0; i < ctrl.options.length; i++) if (ctrl.options[i].defaultSelected) return ctrl.options[i].value;
    return ctrl.options.length ? ctrl.options[0].value : '';
  }

  function setTeamPending(sel, on) {
    var cell = sel.parentNode;
    var hint = cell && cell.querySelector ? cell.querySelector('.ts-pending-hint') : null;
    if (on) {
      sel.setAttribute('data-ts-pending', '1');
      sel.classList.add('is-pending');
      if (!hint && cell) {
        hint = document.createElement('div');
        hint.className = 'ts-pending-hint no-print';
        hint.setAttribute('role', 'status');
        hint.textContent = 'Enter to save · Esc to cancel';
        cell.appendChild(hint);
      }
    } else {
      sel.removeAttribute('data-ts-pending');
      sel.classList.remove('is-pending');
      if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    }
  }

  /** Shows the saved value again (Esc, a refused value, or finalized scores). */
  function resetTeamControl(ctrl) {
    if (ctrl.tagName === 'SELECT') setTeamPending(ctrl, false);
    ctrl.value = savedTeamValue(ctrl);
  }

  function commitTeamScore(input) {
    var course = GT.store.course();
    if (!course) return;
    if (isTeamSelect(input)) setTeamPending(input, false);
    if (isLocked(course)) {
      if (input.value !== savedTeamValue(input)) { resetTeamControl(input); lockedToast(); }
      return;
    }
    if (input.value === savedTeamValue(input)) return; // unchanged (also "93.3 (not on the list)": kept as it is)
    var tid = input.getAttribute('data-tid'), aid = input.getAttribute('data-aid');
    var t = model.findTeam(course, tid), a = model.findAssessment(course, aid);
    if (!t || !a) return;
    if (input.value === KEEP_CURRENT) return;
    // DECISIONS 8: an item with a drop-down list takes only its values. Anything else (a value forced
    // into the list, or text typed before the list was turned on) is refused and never stored as text.
    var pc = choiceValues(a).length && typeof model.parseChoiceInput === 'function' ? model.parseChoiceInput(a, input.value) : null;
    if (pc && pc.kind === 'invalid') {
      resetTeamControl(input);
      ui.toast((pc.message || 'Choose a value from the list.') + ' Nothing was saved.', { type: 'warn', timeout: 6000 });
      return;
    }
    var prev = model.getEntry(course.teamScores, tid, aid);
    var next = model.entryFromInput(pc && pc.kind === 'number' ? String(pc.value) : input.value, prev, a.maxScore);
    var same = model.isBlankEntry(prev) ? model.isBlankEntry(next)
      : (model.entryKey(prev) === model.entryKey(next) && entryText(prev) === entryText(next) && !model.isBlankEntry(next));
    if (same) return;
    var members = model.teamMembers(course, tid);
    var overrides = members.filter(function (s) {
      var own = model.getEntry(course.scores, s.id, aid);
      return own && own.override === true;
    }).length;
    GT.store.transact('Edit team score', function (c) { model.setTeamScore(c, tid, aid, next); }, { courseId: course.id });
    var follow = members.length - overrides;
    var p = calc.parseEntry(next);
    var msg = a.name + ' for ' + t.name + (p.state === 'empty' ? ' cleared' : ' set to ' + entryText(next)) + ': ' +
      plural(follow, 'member') + ' ' + (follow === 1 ? 'follows' : 'follow') + ' it' +
      (overrides ? ', ' + overrides + ' keep' + (overrides === 1 ? 's' : '') + ' a per-member override ◆' : '') + '.';
    ui.toast(msg, { type: p.state === 'invalid' ? 'warn' : 'success', action: undoAction(course.id, 'Edit team score') });
  }

  var lockedToastAt = 0;
  /** "Scores are finalized. Unlock them to edit." (or msg) with an Unlock action, at most once a second
   * (key repeats). */
  function lockedToast(msg) {
    var now = Date.now();
    if (now - lockedToastAt < 1000) return;
    lockedToastAt = now;
    ui.toast(msg || LOCKED_MSG, { type: 'info', timeout: 6000, action: { label: 'Unlock…', fn: unlockScores } });
  }

  /** True, after the locked toast, when the course's scores are finalized: every flow that changes the
   * roster (No, names, teams, adding or deleting students) calls it before doing anything. */
  function refuseLocked(course, msg) {
    if (!isLocked(course)) return false;
    lockedToast(msg);
    return true;
  }

  /** aria-disabled + tooltip for a control whose flow is refused while the scores are finalized. It stays
   * clickable, so the click explains why (with the Unlock action), as in the Grades tab. */
  function lockAttr(locked, msg) {
    return locked ? ' aria-disabled="true" title="' + esc(msg || LOCKED_MSG) + '"' : '';
  }

  /** True when a team has any stored team-score entry (a score, or late-work details). */
  function hasTeamEntries(course, teamId) {
    var ts = course.teamScores;
    return !!(ts && util.hasOwn(ts, teamId) && ts[teamId] && Object.keys(ts[teamId]).length);
  }

  /** "Unlock scores?" (as in the Grades tab and Settings): logged in History, final letters unchanged. */
  function unlockScores() {
    var course = GT.store.course();
    if (!course || !isLocked(course)) return;
    var courseId = course.id;
    var at = course.finalized && course.finalized.at;
    ui.dialog.confirm({
      title: 'Unlock scores?',
      messageHtml: '<p>' + (at ? 'Scores were finalized on <strong>' + esc(ui.dateTime(at)) + '</strong>. ' : '') +
        'Unlocking makes scores, numbers, names and teams editable again. Final letters are not changed.</p>' +
        '<p class="muted small">The unlock is logged in the change history (“Scores finalized: yes → no”). You can finalize again from the Grades tab at any time.</p>',
      confirmText: 'Unlock scores'
    }).then(function (ok) {
      if (!ok) return;
      var now = GT.store.course();
      if (!now || now.id !== courseId || !isLocked(now)) return;
      GT.store.transact('Unlock scores', function (c) {
        if (typeof model.unfinalize === 'function') model.unfinalize(c);
        else c.finalized = null;
      }, { courseId: courseId });
      ui.toast('Scores unlocked: they can be edited again. The unlock is logged in History.', { type: 'success', timeout: 6000 });
    });
  }

  function removeOverride(studentId, aid) {
    var course = GT.store.course();
    var s = course && model.findStudent(course, studentId);
    var a = course && model.findAssessment(course, aid);
    if (!s || !a) return;
    if (isLocked(course)) { lockedToast(); return; }
    GT.store.transact('Remove override', function (c) { model.clearOverride(c, studentId, aid); }, { courseId: course.id });
    var t = teamOf(course, s);
    var te = t ? model.getEntry(course.teamScores, t.id, aid) : null;
    ui.toast('Override removed: ' + studentRef(s) + ' now uses the ' + a.name + ' team score (' + entryLabel(te) + ').',
      { type: 'success', action: undoAction(course.id, 'Remove override') });
  }

  // ------------------------------------------------------------------ view rendering

  function matches(course, s, q) {
    var t = teamOf(course, s);
    var hay = [s.lastName, s.firstName, s.firstName + ' ' + s.lastName, model.studentName(s),
      typeof s.no === 'number' ? String(s.no) : '', t ? t.name : 'no team', s.notes, s.status].join(' | ').toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  function sortedStudents(course, results, p) {
    var list;
    if (p.sort === 'no') list = calc.sortStudents(course, results, 'no', p.dir);
    else if (p.sort === 'name') list = calc.sortStudents(course, results, 'name', p.dir);
    else {
      var sign = p.dir === 'desc' ? -1 : 1;
      list = course.students.slice().sort(function (a, b) {
        var c = 0;
        if (p.sort === 'team') {
          var ta = teamOf(course, a), tb = teamOf(course, b);
          if (!ta !== !tb) c = ta ? -1 : 1;
          else if (ta && tb) c = util.compareText(ta.name, tb.name);
        } else {
          c = (isWithdrawn(a) ? 1 : 0) - (isWithdrawn(b) ? 1 : 0);
        }
        return c !== 0 ? sign * c : calc.compareByName(a, b);
      });
    }
    return list;
  }

  function headerHtml(course) {
    var n = course.students.length;
    var wd = course.students.filter(isWithdrawn).length;
    return '<div class="page-header"><div><h1>Students &amp; Teams</h1><div class="sub">' + esc(model.courseLabel(course)) + ' · ' +
      plural(n - wd, 'active student') + ' · ' + wd + ' withdrawn · ' + plural(course.teams.length, 'team') + '</div></div></div>';
  }

  function sortTh(key, label, p, cls) {
    var active = p.sort === key;
    var dir = active ? (p.dir === 'desc' ? 'descending' : 'ascending') : 'none';
    return '<th scope="col"' + (cls ? ' class="' + cls + '"' : '') + ' aria-sort="' + dir + '"><button type="button" class="st-sort' + (active ? ' is-active' : '') +
      '" data-act="sort" data-sort="' + key + '" data-fk="sort:' + key + '">' + esc(label) +
      (active ? icon(p.dir === 'desc' ? 'sort-desc' : 'sort-asc', 'icon-sm') : '') + '</button></th>';
  }

  /** Read-only Final letter cell of the students table (letters are assigned in the Grades tab or the details). */
  function finalCellHtml(course, s, r) {
    var f = finalInfo(course, s, r);
    if (f.letter === null) return '<td class="st-final"><span class="faint" title="No final letter yet">—</span></td>';
    var title = !f.valid ? 'Not a letter of the current scale: choose another letter'
      : f.differs ? 'Differs from the cutoff suggestion (' + f.suggested + ')' : 'Same as the cutoff suggestion';
    return '<td class="st-final"><span class="st-letter' + (f.valid ? '' : ' is-invalid') + '" title="' + esc(title) + '">' + esc(f.letter) +
      (f.valid && f.differs ? '<span class="st-letter-dot" aria-hidden="true"></span>' : '') + '</span>' +
      (!f.valid || f.differs ? '<span class="sr-only"> (' + esc(title) + ')</span>' : '') + '</td>';
  }

  function studentRowHtml(course, s, results, locked) {
    var w = isWithdrawn(s);
    var t = teamOf(course, s);
    var ref = esc(studentRef(s));
    var id = esc(s.id);
    var r = results && results.byId ? results.byId[s.id] : null;
    return '<tr data-sid="' + id + '"' + (w ? ' class="row-withdrawn"' : '') + '>' +
      '<td class="num st-no">' + (typeof s.no === 'number' ? s.no : '<span class="faint">–</span>') + '</td>' +
      '<td class="pii st-last">' + esc(s.lastName) + '</td>' +
      '<td class="pii st-first">' + esc(s.firstName) + '</td>' +
      '<td class="st-team">' + (t ? esc(t.name) : '<span class="faint">No team</span>') + '</td>' +
      '<td class="st-status">' + (w ? '<span class="badge">Withdrawn</span>' : '<span class="muted">Active</span>') + '</td>' +
      finalCellHtml(course, s, r) +
      '<td class="st-notes">' + (s.notes ? '<span class="pii st-notes-text">' + esc(truncate(s.notes, 90)) + '</span>' : '') + '</td>' +
      '<td class="st-actions">' +
      '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="details" data-id="' + id + '" data-fk="details:' + id + '" aria-label="Details for ' + ref + '" title="Details">' + icon('user') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="edit" data-id="' + id + '" data-fk="edit:' + id + '" aria-label="' + (locked ? 'Edit notes of ' : 'Edit ') + ref + '" title="' +
        (locked ? 'Edit notes (No, name and team are locked: scores are finalized)' : 'Edit') + '">' + icon('edit') + '</button>' +
      '<button type="button" class="btn btn-sm st-status-btn" data-act="status" data-id="' + id + '" data-fk="status:' + id + '" aria-label="' + (w ? 'Reinstate ' : 'Withdraw ') + ref + '">' + (w ? 'Reinstate' : 'Withdraw') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="row-menu" data-id="' + id + '" data-fk="menu:' + id + '" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ' + ref + '" title="More actions">' + icon('dots') + '</button>' +
      '</td></tr>';
  }

  function studentsCardHtml(course, results) {
    var p = prefs();
    var all = course.students;
    var nWithdrawn = all.filter(isWithdrawn).length;
    var nActive = all.length - nWithdrawn;
    var list = sortedStudents(course, results, p).filter(function (s) {
      return p.filter === 'all' || (p.filter === 'withdrawn') === isWithdrawn(s);
    });
    var q = searchText.trim().toLowerCase();
    if (q) list = list.filter(function (s) { return matches(course, s, q); });

    var locked = isLocked(course);
    var h = '<section class="card st-card" aria-labelledby="st-students-h">' +
      '<div class="card-header"><h2 id="st-students-h">Students <span class="badge">' + all.length + '</span></h2>' +
      '<div class="toolbar">' +
      '<button type="button" class="btn btn-primary btn-sm" data-act="add" data-fk="add"' + lockAttr(locked, ADD_LOCKED_MSG) + '>' + icon('plus') + 'Add student</button>' +
      '<button type="button" class="btn btn-sm" data-act="paste" data-fk="paste"' + lockAttr(locked, ADD_LOCKED_MSG) + '>' + icon('copy') + 'Paste roster</button>' +
      '<button type="button" class="btn btn-sm" data-act="renumber" data-fk="renumber"' + (all.length ? '' : ' disabled') +
        (locked ? lockAttr(true) : ' title="Assign No 1..N in name order"') + '>' + icon('sort-asc') + 'Renumber by name</button>' +
      '</div></div>';
    if (locked && all.length) {
      h += '<div class="st-lock-bar"><div class="callout callout-warn st-lock-note">' + icon('lock') + '<span><strong>Scores are finalized' +
        (course.finalized && course.finalized.at ? ' on ' + esc(ui.dateTime(course.finalized.at)) : '') + '.</strong> ' +
        'No, names and teams are locked, and students cannot be added or deleted. Notes, withdrawals and final letters stay editable.</span>' +
        '<button type="button" class="btn btn-sm" data-act="unlock" data-fk="unlock">' + icon('lock') + 'Unlock scores…</button></div></div>';
    }

    if (!all.length) {
      return h + '<div class="empty-state"><h2>No students in ' + esc(course.code) + ' yet</h2>' +
        '<p>Paste the class roster from Excel, add students one by one, or load fake sample data to try the app.</p>' +
        '<div class="actions">' +
        '<button type="button" class="btn btn-primary" data-act="paste" data-fk="empty-paste"' + lockAttr(locked, ADD_LOCKED_MSG) + '>' + icon('copy') + 'Paste roster</button>' +
        '<button type="button" class="btn" data-act="add" data-fk="empty-add"' + lockAttr(locked, ADD_LOCKED_MSG) + '>' + icon('plus') + 'Add student</button>' +
        (GT.app && GT.app.actions && GT.app.actions.loadSample ? '<button type="button" class="btn" data-act="load-sample" data-fk="empty-sample">' + icon('layers') + 'Load sample data</button>' : '') +
        '</div></div></section>';
    }

    var seg = FILTERS.map(function (f) {
      var label = f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Withdrawn';
      var n = f === 'all' ? all.length : f === 'active' ? nActive : nWithdrawn;
      return '<button type="button" data-act="filter" data-filter="' + f + '" data-fk="filter:' + f + '" aria-pressed="' + (p.filter === f) + '">' +
        label + ' <span class="st-count">' + n + '</span></button>';
    }).join('');

    h += '<div class="toolbar st-toolbar">' +
      '<div class="search">' + icon('search') + '<input type="search" data-role="search" data-fk="search" placeholder="Search name, No, team, notes" aria-label="Search students" autocomplete="off" spellcheck="false" value="' + esc(searchText) + '"></div>' +
      '<div class="segmented" role="group" aria-label="Show students">' + seg + '</div>' +
      '<span class="spacer"></span>' +
      '<span class="muted small" aria-live="polite">Showing ' + list.length + ' of ' + all.length + '</span>' +
      '</div>';

    if (!list.length) {
      h += '<div class="st-none muted">No students match' + (q ? ' “' + esc(searchText.trim()) + '”' : ' this filter') + '.' +
        (q ? ' <button type="button" class="btn btn-sm btn-ghost" data-act="clear-search" data-fk="clear-search">Clear search</button>' : '') + '</div>';
      return h + '</section>';
    }

    h += '<div class="table-wrap st-table-wrap"><table class="table st-table"><thead><tr>' +
      sortTh('no', 'No', p, 'num') + sortTh('name', 'Last name', p) + '<th scope="col">First name</th>' +
      sortTh('team', 'Team', p) + sortTh('status', 'Status', p) +
      '<th scope="col" class="st-final-h" title="Assigned in the Grades tab or in the student details">Final letter</th><th scope="col">Notes</th>' +
      '<th scope="col" class="st-actions-h"><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
      list.map(function (s) { return studentRowHtml(course, s, results, locked); }).join('') +
      '</tbody></table></div>';
    return h + '</section>';
  }

  function memberHtml(s, team, locked) {
    var w = isWithdrawn(s);
    var ref = esc(studentRef(s));
    var id = esc(s.id);
    return '<li class="member' + (w ? ' is-withdrawn' : '') + '">' +
      '<span class="member-no">' + (typeof s.no === 'number' ? s.no : '–') + '</span>' + nameHtml(s, 'member-name') +
      (w ? '<span class="badge">Withdrawn</span>' : '') +
      '<span class="member-actions">' +
      '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="details" data-id="' + id + '" data-fk="m-details:' + id + '" aria-label="Details for ' + ref + '" title="Details">' + icon('user') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="member-move" data-id="' + id + '" data-fk="m-move:' + id + '"' +
        (locked ? lockAttr(true) : ' aria-haspopup="menu" aria-expanded="false" title="Move to team…"') + ' aria-label="Move ' + ref + ' to another team">' + icon('chevron-right') + '</button>' +
      (team ? '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="member-remove" data-id="' + id + '" data-fk="m-remove:' + id + '" aria-label="Remove ' + ref + ' from ' + esc(team.name) + '"' +
        (locked ? lockAttr(true) : ' title="Remove from team"') + '>' + icon('x') + '</button>' : '') +
      '</span></li>';
  }

  function teamBoxHtml(course, t, range, locked) {
    var members = model.sortedMembers(course, t.id);
    var active = members.filter(function (s) { return !isWithdrawn(s); }).length;
    var wd = members.length - active;
    var id = esc(t.id);
    var hint = '';
    if (range && active > 0 && (active < range.min || active > range.max)) {
      hint = '<p class="team-hint">' + icon('info', 'icon-sm') + ' ' + (active < range.min ? 'Smaller' : 'Larger') + ' than the usual ' +
        esc(range.label) + ' per team in ' + esc(course.code) + ' (informational).</p>';
    }
    return '<div class="team-box" data-tid="' + id + '">' +
      '<div class="team-box-head"><div class="team-box-title"><h3>' + esc(t.name) + '</h3>' +
      '<span class="team-count">' + plural(active, 'active member') + (wd ? ' · ' + wd + ' withdrawn' : '') + '</span></div>' +
      '<span class="team-box-actions">' +
      '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="team-rename" data-id="' + id + '" data-fk="t-rename:' + id + '" aria-label="Rename ' + esc(t.name) + '" title="Rename">' + icon('edit') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="team-delete" data-id="' + id + '" data-fk="t-delete:' + id + '" aria-label="Delete ' + esc(t.name) + '"' +
        (locked && (members.length || hasTeamEntries(course, t.id)) ? lockAttr(true, 'Scores are finalized. Unlock them to delete a team that has members or team scores.') : ' title="Delete team"') + '>' + icon('trash') + '</button>' +
      '</span></div>' + hint +
      (members.length ? '<ul class="member-list">' + members.map(function (s) { return memberHtml(s, t, locked); }).join('') + '</ul>'
        : '<p class="team-empty muted">No members yet.</p>') +
      '<div class="team-box-foot"><button type="button" class="btn btn-sm btn-ghost" data-act="team-add" data-id="' + id + '" data-fk="t-add:' + id + '"' + lockAttr(locked) + '>' + icon('plus') + 'Add members</button></div>' +
      '</div>';
  }

  function teamsCardHtml(course) {
    var range = sizeRange(course);
    var locked = isLocked(course);
    var noTeam = calc.sortStudents(course, null, 'name', 'asc').filter(function (s) { return !teamOf(course, s); });
    var h = '<section class="card teams-card" aria-labelledby="st-teams-h">' +
      '<div class="card-header"><h2 id="st-teams-h">Teams <span class="badge">' + course.teams.length + '</span></h2>' +
      '<div class="toolbar">' +
      '<button type="button" class="btn btn-sm" data-act="team-new" data-fk="team-new">' + icon('plus') + 'New team</button>' +
      '<button type="button" class="btn btn-sm" data-act="teams-create" data-fk="teams-create">' + icon('users') + 'Create teams…</button>' +
      '</div></div><div class="card-body">';
    if (locked && course.teams.length) {
      h += '<p class="muted small teams-note">' + icon('lock', 'icon-sm') + ' Scores are finalized: team members are locked. Team names can still be changed.</p>';
    }
    if (range) {
      h += '<p class="muted small teams-note">' + icon('info', 'icon-sm') + ' Teams in ' + esc(course.code) + ' usually have ' + esc(range.label) +
        ' members. Sizes outside that range get a note; it is informational only.</p>';
    }
    if (!course.teams.length) {
      h += '<p class="muted">No teams yet. Create them one at a time with <strong>New team</strong>, or several at once with <strong>Create teams…</strong>. ' +
        'Team-graded assessments (' + esc(teamGraded(course).map(function (a) { return a.name; }).join(', ') || 'none') + ') use one score per team.</p>';
    }
    h += '<div class="team-grid">' + course.teams.map(function (t) { return teamBoxHtml(course, t, range, locked); }).join('');
    if (course.students.length) {
      h += '<div class="team-box no-team"><div class="team-box-head"><div class="team-box-title"><h3>No team</h3>' +
        '<span class="team-count">' + plural(noTeam.length, 'student') + '</span></div></div>' +
        (noTeam.length ? '<ul class="member-list">' + noTeam.map(function (s) { return memberHtml(s, null, locked); }).join('') + '</ul>'
          : '<p class="team-empty muted">Every student is in a team.</p>') + '</div>';
    }
    return h + '</div></div></section>';
  }

  /** Team score of an item with a drop-down list (DECISIONS 8): a <select> of "(empty)" and the list values,
   * so no typo can be stored. A stored value that is not on the list (imported, or entered before the list
   * was turned on) stays selected as "93.3 (not on the list)" (or "abc (not a number)") and is kept until
   * another value is chosen. */
  function teamChoiceHtml(t, a, e, p, values, locked) {
    var raw = entryText(e);
    var cur = p.state === 'number' ? util.fix(p.value) : null;
    var onList = cur !== null && values.indexOf(cur) !== -1;
    var offList = p.state === 'number' && !onList;
    var title = p.state === 'invalid' ? 'Not a number: counted as 0' : offList ? 'Not one of the list values' : '';
    if (locked) title = (title ? title + '. ' : '') + LOCKED_MSG;
    var opts = '<option value=""' + (p.state === 'empty' ? ' selected' : '') + '>(empty)</option>' +
      (offList ? '<option value="' + KEEP_CURRENT + '" selected>' + esc(raw) + ' (not on the list)</option>' : '') +
      (p.state === 'invalid' ? '<option value="' + KEEP_CURRENT + '" selected>' + esc(raw) + ' (not a number)</option>' : '') +
      values.map(function (v) {
        return '<option value="' + esc(String(v)) + '"' + (onList && v === cur ? ' selected' : '') + '>' + esc(choiceText(v)) + '</option>';
      }).join('');
    return '<select class="ts-select' + (p.state === 'invalid' ? ' is-invalid' : offList ? ' is-range' : '') + '"' +
      ' data-tid="' + esc(t.id) + '" data-aid="' + esc(a.id) + '" data-fk="ts:' + esc(t.id) + ':' + esc(a.id) + '"' +
      ' aria-label="' + esc(a.name + ' team score for ' + t.name + ', out of ' + choiceText(a.maxScore)) + '"' +
      (title ? ' title="' + esc(title) + '"' : '') + (locked ? ' disabled' : '') + '>' + opts + '</select>';
  }

  function teamScoresCardHtml(course) {
    var tg = teamGraded(course);
    var h = '<section class="card ts-card" aria-labelledby="st-ts-h"><div class="card-header"><h2 id="st-ts-h">Team scores</h2>' +
      '<span class="muted small">Entered once per team: every member gets it, except members with a per-member override (◆).</span></div>';
    if (!tg.length) {
      return h + '<div class="card-body muted">No team-graded assessments. Mark an assessment as team-graded in Settings.</div></section>';
    }
    if (!course.teams.length) {
      return h + '<div class="card-body muted">No teams yet. Create teams above, then enter each team’s score here.</div></section>';
    }
    var locked = isLocked(course);
    var hasList = tg.some(function (a) { return choiceValues(a).length > 0; });
    var cols = 3 + tg.length;
    var head = '<tr><th scope="col">Team</th><th scope="col" class="num">Members</th>' + tg.map(function (a) {
      return '<th scope="col" class="ts-h ' + groupClass(course, a) + '">' + esc(a.name) + ' ' + ui.placeholderBadge(course, 'maxScores', { compact: true }) +
        '<span class="ts-sub">max ' + esc(a.maxScore) + ' · ' + esc(a.weight) + '% ' + weightBadges(course, a) + '</span></th>';
    }).join('') + '<th scope="col">Overrides</th></tr>';
    var body = course.teams.map(function (t) {
      var members = model.sortedMembers(course, t.id);
      var active = members.filter(function (s) { return !isWithdrawn(s); }).length;
      var overrides = [];
      tg.forEach(function (a) {
        members.forEach(function (s) {
          var own = model.getEntry(course.scores, s.id, a.id);
          if (own && own.override === true) overrides.push({ s: s, a: a, own: own });
        });
      });
      var tid = esc(t.id);
      var cells = tg.map(function (a) {
        var e = model.getEntry(course.teamScores, t.id, a.id);
        var p = calc.parseEntry(e);
        var invalid = p.state === 'invalid';
        var range = p.state === 'number' && (p.value < 0 || p.value > a.maxScore);
        var title = invalid ? 'Not a number: counted as 0' : range ? 'Outside 0–' + a.maxScore : '';
        if (locked) title = (title ? title + '. ' : '') + LOCKED_MSG;
        var nOv = overrides.filter(function (o) { return o.a.id === a.id; }).length;
        var values = choiceValues(a);
        var ctrl = values.length ? teamChoiceHtml(t, a, e, p, values, locked)
          : '<input type="text" inputmode="decimal" class="ts-input' +
          (invalid ? ' is-invalid' : range ? ' is-range' : '') + '" data-tid="' + tid + '" data-aid="' + esc(a.id) + '" data-fk="ts:' + tid + ':' + esc(a.id) + '"' +
          ' value="' + esc(entryText(e)) + '" aria-label="' + esc(a.name + ' team score for ' + t.name) + '"' + (title ? ' title="' + esc(title) + '"' : '') +
          (locked ? ' readonly aria-readonly="true"' : '') + ' autocomplete="off" spellcheck="false">';
        return '<td class="ts-cell ' + groupClass(course, a) + '">' + ctrl +
          (e && e.weeksLate > 0 ? ' <span class="badge badge-info" title="Late work">' + e.weeksLate + ' wk late' + (e.waived ? ', waived' : '') + '</span>' : '') +
          (nOv ? ' <span class="ts-ov-mark" title="' + plural(nOv, 'member has', 'members have') + ' a per-member override">◆' + nOv + '</span>' : '') +
          '</td>';
      }).join('');
      var open = !!expandedOverrides[t.id] && overrides.length > 0;
      var ovCell = overrides.length
        ? '<button type="button" class="badge badge-accent ts-ov-btn" data-act="ov-toggle" data-id="' + tid + '" data-fk="ov:' + tid + '" aria-expanded="' + open + '">' +
          plural(overrides.length, 'override') + ' ◆' + icon(open ? 'chevron-down' : 'chevron-right', 'icon-sm') + '</button>'
        : '<span class="faint">—</span>';
      var row = '<tr data-tid="' + tid + '"><th scope="row" class="ts-team">' + esc(t.name) + '</th><td class="num">' + active +
        (members.length > active ? ' <span class="faint small">+' + (members.length - active) + ' wd</span>' : '') + '</td>' + cells + '<td>' + ovCell + '</td></tr>';
      if (open) {
        row += '<tr class="ts-ov-row"><td colspan="' + cols + '"><ul class="ov-list">' + overrides.map(function (o) {
          var te = model.getEntry(course.teamScores, t.id, o.a.id);
          return '<li><span class="ov-diamond" aria-hidden="true">◆</span><strong>' + esc(o.a.name) + '</strong>' +
            '<span class="ov-who">' + refNameHtml(o.s) + '</span>' +
            '<span>override <strong class="num">' + esc(entryLabel(o.own)) + '</strong> <span class="muted">(team score ' + esc(entryLabel(te)) + ')</span></span>' +
            '<button type="button" class="btn btn-sm" data-act="ov-remove" data-id="' + esc(o.s.id) + '" data-aid="' + esc(o.a.id) + '" data-fk="ovr:' + esc(o.s.id) + ':' + esc(o.a.id) + '"' +
            ' aria-label="Remove ' + esc(o.a.name) + ' override for ' + esc(studentRef(o.s)) + '">Remove override</button></li>';
        }).join('') + '</ul><p class="muted small ov-help">An unequal split needs the team’s written agreement. Removing an override makes the student use the team score again.</p></td></tr>';
      }
      return row;
    }).join('');
    var lockNote = locked
      ? '<div class="callout callout-warn st-lock-note">' + icon('lock') + '<span><strong>Scores are finalized.</strong> Team scores and per-member overrides are locked; ' +
        'unlock them in Settings (Grading status) or in the Grades tab to change them.</span></div>'
      : '';
    return h + '<div class="card-body ts-body">' + lockNote + '<div class="table-wrap"><table class="table ts-table' + (locked ? ' is-locked' : '') + '"><thead>' + head + '</thead><tbody>' + body +
      '</tbody></table></div><p class="muted small ts-legend">' + (locked ? 'Locked while the scores are finalized. ' : 'Type a score and press Enter (or leave the field) to save. ' +
        (hasList ? 'Items with a drop-down list take only its values: pick one from the list (after browsing with the arrow keys, Enter saves and Esc cancels). ' : '')) +
      'Red = not a number (counted as 0), yellow = outside 0 to max' + (hasList ? ' or not on the list' : '') + '. ' +
      'Each change is logged in History for every member it reaches.</p></div></section>';
  }

  function render(el, ctx) {
    if (el !== boundEl) { bindView(el); boundEl = el; }
    var course = ctx && ctx.course ? ctx.course : GT.store.course();
    var focus = captureFocus(el);
    if (!course) {
      el.innerHTML = '<div class="empty-state"><h2>No course</h2><p>Add a course from the course menu next to the course name.</p></div>';
      el.gtStudentsHtml = null;
      return;
    }
    var results = ctx && ctx.results ? ctx.results : GT.store.results();
    var html = headerHtml(course) + studentsCardHtml(course, results) + teamsCardHtml(course) + teamScoresCardHtml(course);
    // Autosave notifications re-render with identical markup: keep the DOM (focus, typed drafts) as it is.
    if (el.gtStudentsHtml === html && el.childNodes.length) return;
    el.innerHTML = html;
    el.gtStudentsHtml = html;
    restoreFocus(el, focus);
  }

  function rerender() {
    if (boundEl && document.body.contains(boundEl)) render(boundEl, { course: GT.store.course(), results: GT.store.results() });
  }

  function onClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !boundEl || !boundEl.contains(b) || b.disabled) return;
    var act = b.getAttribute('data-act');
    var id = b.getAttribute('data-id');
    switch (act) {
      case 'add': openStudentForm(null); break;
      case 'paste': ui.openRosterPaste(); break;
      case 'renumber': renumberFlow(); break;
      case 'unlock': unlockScores(); break;
      case 'load-sample': if (GT.app && GT.app.actions && GT.app.actions.loadSample) GT.app.actions.loadSample(); break;
      case 'filter': setPrefs({ filter: b.getAttribute('data-filter') }); break;
      case 'sort': {
        var key = b.getAttribute('data-sort');
        var p = prefs();
        setPrefs(p.sort === key ? { dir: p.dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: 'asc' });
        break;
      }
      case 'clear-search': searchText = ''; rerender(); focusSearch(); break;
      case 'details': ui.openStudent(id); break;
      case 'edit': openStudentForm(id); break;
      case 'status': toggleStatus(id); break;
      case 'row-menu': rowMenu(b, id); break;
      case 'team-new': newTeamFlow(); break;
      case 'teams-create': createTeamsFlow(); break;
      case 'team-add': addMembersFlow(id); break;
      case 'team-rename': renameTeamFlow(id); break;
      case 'team-delete': deleteTeamFlow(id); break;
      case 'member-move': moveMenu(b, id); break;
      case 'member-remove': moveStudents([id], null, 'Remove student from team'); break;
      case 'ov-toggle': expandedOverrides[id] = !expandedOverrides[id]; rerender(); break;
      case 'ov-remove': removeOverride(id, b.getAttribute('data-aid')); break;
      default: break;
    }
  }

  function focusSearch() {
    var s = boundEl && boundEl.querySelector('[data-role="search"]');
    if (s) { s.focus(); s.select(); }
  }

  function onInput(e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-role') === 'search') {
      searchText = t.value;
      rerender();
    }
  }

  function onChange(e) {
    var t = e.target;
    if (isTeamSelect(t)) {
      setTeamPending(t, true);
      if (tsKbdSel !== t) commitTeamScore(t);
    } else if (t.classList && t.classList.contains('ts-input')) commitTeamScore(t);
  }

  function moveTeamScoreFocus(input, delta) {
    var aid = cssKey(input.getAttribute('data-aid'));
    var all = ui.$$('.ts-input[data-aid="' + aid + '"], .ts-select[data-aid="' + aid + '"]', boundEl);
    var i = all.indexOf(input);
    var next = i === -1 ? null : all[i + delta];
    if (next) {
      next.focus();
      if (next.tagName === 'INPUT') next.select();
    }
  }

  function onTeamSelectKeydown(e) {
    var t = e.target;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTeamScore(t);
      moveTeamScoreFocus(t, e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Escape') {
      if (t.hasAttribute('data-ts-pending')) { e.preventDefault(); e.stopPropagation(); resetTeamControl(t); }
      return;
    }
    if (e.key === 'Tab' || e.ctrlKey || e.metaKey) return;
    // Alt+Up/Down, F4 and Space open the list: a pick there saves at once, like a mouse pick.
    var browse = !e.altKey && (TS_BROWSE_KEYS[e.key] === 1 || (e.key.length === 1 && e.key !== ' '));
    tsKbdSel = browse ? t : null;
  }

  function onKeydown(e) {
    var t = e.target;
    if (isTeamSelect(t)) { onTeamSelectKeydown(e); return; }
    if (t.classList && t.classList.contains('ts-input')) {
      if (t.readOnly && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Delete' || e.key === 'Backspace')) {
        lockedToast();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTeamScore(t);
        moveTeamScoreFocus(t, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        t.value = t.defaultValue;
        t.select();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
        e.preventDefault();
        commitTeamScore(t);
        moveTeamScoreFocus(t, e.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    if (t.getAttribute && t.getAttribute('data-role') === 'search' && e.key === 'Escape' && t.value) {
      e.preventDefault();
      searchText = '';
      t.value = '';
      rerender();
    }
  }

  function onContextMenu(e) {
    var row = e.target.closest ? e.target.closest('.st-table tbody tr[data-sid]') : null;
    if (!row || ui.isTypingTarget(e.target)) return;
    e.preventDefault();
    var btn = row.querySelector('[data-act="row-menu"]');
    if (btn) rowMenu(btn, row.getAttribute('data-sid'));
  }

  function bindView(el) {
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('paste', function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains('ts-input') && t.readOnly) lockedToast();
    });
    // A team-score drop-down browsed to with the keyboard is saved when the focus leaves it.
    el.addEventListener('focusout', function (e) {
      var t = e.target;
      if (!isTeamSelect(t)) return;
      if (tsKbdSel === t) tsKbdSel = null;
      if (t.hasAttribute('data-ts-pending') && document.body.contains(t)) commitTeamScore(t);
    });
    el.addEventListener('mousedown', function (e) {
      if (isTeamSelect(e.target)) tsKbdSel = null;
    }, true);
  }

  // Document-level listeners, added once; they act only while this view is on screen.
  document.addEventListener('keydown', function (e) {
    if (!boundEl || !document.body.contains(boundEl)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || ui.isTypingTarget(e.target)) return;
    var s = boundEl.querySelector('[data-role="search"]');
    if (s) { e.preventDefault(); s.focus(); s.select(); }
  });
  // Never leave the student-print mode on for a later print of another page.
  root.addEventListener('beforeprint', function () {
    if (document.body.classList.contains('print-student') && !document.querySelector('dialog.student-dlg[open]')) {
      document.body.classList.remove('print-student');
    }
  });

  GT.views.students = {
    id: 'students',
    title: 'Students & Teams',
    render: render,
    destroy: function () {
      if (ui.closeMenu) ui.closeMenu();
      // Leaving the view (e.g. Alt+2) removes it before a focusout or change can save: save a team score
      // that was typed, or browsed to in a drop-down, now, like leaving the field does.
      if (boundEl && document.body.contains(boundEl)) {
        ui.$$('.ts-input, .ts-select[data-ts-pending]', boundEl).forEach(function (c) {
          if (c.value === savedTeamValue(c)) return;
          try { commitTeamScore(c); } catch (e) { if (root.console) console.error(e); }
        });
      }
      tsKbdSel = null;
    }
  };

  // ------------------------------------------------------------------ roster paste (S3)

  var ROLE_LABELS = { no: 'No', last: 'Last name', first: 'First name', full: 'Full name (Last, First or First Last)', team: 'Team', ignore: 'Ignore' };
  var ROLE_ORDER = ['no', 'last', 'first', 'full', 'team', 'ignore'];
  var HEADER_RE = /(^| )(last|first|name|names|no|nr|number|surname|lastname|firstname|fullname|givenname|studentname|forename)( |$)|^#$/;

  function cleanCell(c) {
    return String(c === null || c === undefined ? '' : c).replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseRosterText(text) {
    var rows = parseRows(text).map(function (r) { return r.map(cleanCell); });
    while (rows.length && rows[rows.length - 1].every(function (c) { return c === ''; })) rows.pop();
    return rows;
  }

  function columnCount(rows) {
    var n = 0;
    rows.forEach(function (r) {
      for (var j = r.length - 1; j >= 0; j--) {
        if (r[j] !== '') { if (j + 1 > n) n = j + 1; break; }
      }
    });
    return n;
  }

  function firstNonEmpty(rows) {
    for (var i = 0; i < rows.length; i++) if (rows[i].some(function (c) { return c !== ''; })) return i;
    return -1;
  }

  function headerKey(c) { return String(c || '').toLowerCase().replace(/[^a-z#]+/g, ' ').trim(); }

  function isHeaderRow(row) {
    return row.some(function (c) { return c !== '' && HEADER_RE.test(headerKey(c)); });
  }

  function roleFromHeader(c) {
    var k = headerKey(c);
    if (!k) return 'ignore';
    if (/team|group/.test(k)) return 'team';
    if (/last|surname|family/.test(k)) return 'last';
    if (/first|given|forename/.test(k)) return 'first';
    if (k === '#' || /(^| )(no|nr|number|num)$/.test(k)) return 'no';
    if (/name/.test(k)) return 'full';
    return 'ignore';
  }

  function detectMapping(rows, headerIdx, ncols) {
    var n = Math.max(ncols, 1);
    var mapping = [];
    var j;
    if (headerIdx !== -1) {
      var used = {};
      for (j = 0; j < n; j++) {
        var role = roleFromHeader(rows[headerIdx][j] || '');
        if (role !== 'ignore' && used[role]) role = 'ignore';
        used[role] = true;
        mapping.push(role);
      }
      if (used.last || used.first || used.full) return mapping;
    }
    var col0 = rows.filter(function (r, i) { return i !== headerIdx; }).map(function (r) { return r[0] || ''; }).filter(Boolean);
    var col0Int = col0.length > 0 && col0.every(function (c) { return /^\d+$/.test(c); });
    var base;
    if (n === 1) base = ['full'];
    else if (n === 2) base = col0Int ? ['no', 'full'] : ['last', 'first'];
    else base = col0Int ? ['no', 'last', 'first', 'team'] : ['last', 'first', 'team'];
    mapping = [];
    for (j = 0; j < n; j++) mapping.push(base[j] || 'ignore');
    return mapping;
  }

  /** "Last, First" -> last/first; otherwise "First Middle Last" -> the last word is the last name. */
  function splitFullName(v) {
    var s = cleanCell(v);
    var i = s.indexOf(',');
    if (i !== -1) return { last: s.slice(0, i).trim(), first: s.slice(i + 1).trim() };
    var words = s.split(' ').filter(Boolean);
    if (words.length <= 1) return { last: s, first: '' };
    var last = words.pop();
    return { last: last, first: words.join(' ') };
  }

  function extractRow(row, mapping) {
    var out = { noText: '', lastName: '', firstName: '', teamName: '' };
    var full = '';
    mapping.forEach(function (role, j) {
      var v = row[j] || '';
      if (!v) return;
      if (role === 'no' && !out.noText) out.noText = v;
      else if (role === 'last' && !out.lastName) out.lastName = v;
      else if (role === 'first' && !out.firstName) out.firstName = v;
      else if (role === 'full' && !full) full = v;
      else if (role === 'team' && !out.teamName) out.teamName = v;
    });
    if (full) {
      var sp = splitFullName(full);
      if (!out.lastName) out.lastName = sp.last;
      if (!out.firstName) out.firstName = sp.first;
    }
    return out;
  }

  /** What a roster paste would do to `course`: per-row status (new, duplicate, empty, header), the No each
   * new student gets, and the teams to create. Pure with respect to the course. */
  function planRoster(course, rows, mapping, headerIdx) {
    var existing = Object.create(null);
    var used = Object.create(null);
    var maxNo = 0;
    course.students.forEach(function (s) {
      existing[nameKey(s.lastName, s.firstName)] = true;
      if (typeof s.no === 'number') { used[s.no] = true; if (s.no > maxNo) maxNo = s.no; }
    });
    var seen = Object.create(null);
    var items = rows.map(function (r, i) {
      if (i === headerIdx) return { index: i, status: 'header', cells: r };
      var x = extractRow(r, mapping);
      var item = { index: i, status: 'new', noText: x.noText, lastName: x.lastName, firstName: x.firstName, teamName: x.teamName, no: null, note: '' };
      if (!x.lastName && !x.firstName) { item.status = 'empty'; return item; }
      var k = nameKey(x.lastName, x.firstName);
      if (existing[k]) { item.status = 'duplicate'; item.note = 'Already in ' + course.code; }
      else if (seen[k]) { item.status = 'duplicate'; item.note = 'Repeated in the pasted rows'; }
      else seen[k] = true;
      return item;
    });
    var fresh = items.filter(function (it) { return it.status === 'new'; });
    var maxGiven = maxNo;
    fresh.forEach(function (it) {
      if (!it.noText) return;
      if (/^\d+$/.test(it.noText) && Number(it.noText) >= 1 && Number(it.noText) <= 1e6) {
        var n = Number(it.noText);
        if (used[n]) { it.note = 'No ' + n + ' is taken'; return; }
        used[n] = true;
        it.no = n;
        if (n > maxGiven) maxGiven = n;
      } else {
        it.note = 'No “' + it.noText + '” is not a whole number';
      }
    });
    var next = maxGiven + 1;
    fresh.forEach(function (it) {
      if (it.no !== null) return;
      while (used[next]) next++;
      it.no = next;
      it.noAssigned = true;
      used[next] = true;
      next++;
    });
    var newTeams = [];
    var newTeamKeys = Object.create(null);
    fresh.forEach(function (it) {
      if (!it.teamName) return;
      var t = findTeamByName(course, it.teamName);
      if (t) { it.teamId = t.id; it.teamLabel = t.name; return; }
      var key = it.teamName.toLowerCase();
      if (!newTeamKeys[key]) { newTeamKeys[key] = it.teamName; newTeams.push(it.teamName); }
      it.teamNew = true;
      it.teamLabel = newTeamKeys[key];
    });
    var counts = { added: fresh.length, duplicates: 0, empty: 0, header: headerIdx !== -1 ? 1 : 0, teams: newTeams.length };
    items.forEach(function (it) {
      if (it.status === 'duplicate') counts.duplicates++;
      if (it.status === 'empty') counts.empty++;
    });
    return { items: items, newTeams: newTeams, counts: counts };
  }

  function mappingHtml(state) {
    if (!state.rows.length) return '';
    var n = Math.max(state.ncols, 1);
    var sampleRow = null;
    for (var i = 0; i < state.rows.length; i++) {
      if (i !== state.headerIdx && state.rows[i].some(function (c) { return c !== ''; })) { sampleRow = state.rows[i]; break; }
    }
    var cols = '';
    for (var j = 0; j < n; j++) {
      var headCell = state.headerIdx !== -1 ? (state.rows[state.headerIdx][j] || '') : '';
      cols += '<div class="rp-col"><label for="rp-col-' + j + '">Column ' + (j + 1) + (headCell ? ': <span class="rp-colname">' + esc(headCell) + '</span>' : '') + '</label>' +
        '<select id="rp-col-' + j + '" data-col="' + j + '" data-fk="col:' + j + '">' + ROLE_ORDER.map(function (r) {
          return '<option value="' + r + '"' + (state.mapping[j] === r ? ' selected' : '') + '>' + esc(ROLE_LABELS[r]) + '</option>';
        }).join('') + '</select>' +
        '<span class="rp-sample pii">' + esc(sampleRow ? (sampleRow[j] || '—') : '—') + '</span></div>';
    }
    var hasName = state.mapping.some(function (r) { return r === 'last' || r === 'first' || r === 'full'; });
    return '<div class="rp-map-head"><span class="section-label">Columns</span>' +
      '<label class="check rp-header"><input type="checkbox" id="rp-header" data-fk="header"' + (state.headerOn ? ' checked' : '') + '> First row is a header (skipped)</label></div>' +
      '<div class="rp-cols">' + cols + '</div>' +
      (hasName ? '' : '<div class="callout callout-warn">Map at least one column to Last name, First name or Full name.</div>');
  }

  function previewHtml(plan, hasText) {
    if (!hasText) return '<p class="muted rp-empty">The preview appears here as soon as you paste.</p>';
    var c = plan.counts;
    var chips = '<span class="chip ok">' + icon('check', 'icon-sm') + plural(c.added, 'new student') + '</span>' +
      (c.duplicates ? '<span class="chip warn">' + plural(c.duplicates, 'duplicate') + ' skipped</span>' : '') +
      (c.empty ? '<span class="chip">' + plural(c.empty, 'empty row') + ' skipped</span>' : '') +
      (c.header ? '<span class="chip">header row skipped</span>' : '') +
      (plan.newTeams.length ? '<span class="chip">New ' + (plan.newTeams.length === 1 ? 'team' : 'teams') + ': ' + esc(plan.newTeams.join(', ')) + '</span>' : '');
    var shown = plan.items.slice(0, 500);
    var rows = shown.map(function (it) {
      var rowNo = '<td class="num faint">' + (it.index + 1) + '</td>';
      if (it.status === 'header') {
        return '<tr class="rp-skip">' + rowNo + '<td colspan="4" class="muted">' + esc(it.cells.filter(Boolean).join(' · ')) + '</td><td><span class="badge">header · skipped</span></td></tr>';
      }
      if (it.status === 'empty') {
        return '<tr class="rp-skip">' + rowNo + '<td colspan="4" class="muted">(no name)</td><td><span class="badge">empty · skipped</span></td></tr>';
      }
      var dup = it.status === 'duplicate';
      var noCell = dup ? '<span class="faint">' + esc(it.noText || '') + '</span>'
        : esc(it.no) + (it.noAssigned ? ' <span class="faint small">(next free)</span>' : '') + (it.note && !dup ? '<div class="rp-note">' + esc(it.note) + '</div>' : '');
      var teamCell = it.teamName ? esc(it.teamLabel || it.teamName) + (it.teamNew && !dup ? ' <span class="badge badge-info">new team</span>' : '') : '<span class="faint">—</span>';
      var status = dup ? '<span class="badge badge-warn">duplicate · skipped</span><div class="rp-note">' + esc(it.note) + '</div>' : '<span class="badge badge-success">new</span>';
      return '<tr class="' + (dup ? 'rp-skip' : 'rp-new') + '">' + rowNo + '<td class="num">' + noCell + '</td>' +
        '<td class="pii">' + esc(it.lastName) + '</td><td class="pii">' + esc(it.firstName) + '</td><td>' + teamCell + '</td><td>' + status + '</td></tr>';
    }).join('');
    return '<div class="rp-summary" role="status">' + chips + '</div>' +
      '<div class="table-wrap rp-table-wrap"><table class="table rp-table"><thead><tr><th scope="col" class="num">Row</th><th scope="col" class="num">No</th>' +
      '<th scope="col">Last name</th><th scope="col">First name</th><th scope="col">Team</th><th scope="col">Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (plan.items.length > shown.length ? '<p class="muted small">Showing the first ' + shown.length + ' of ' + plan.items.length + ' rows.</p>' : '');
  }

  /** Quick roster paste (S3): a dialog with a textarea, live preview and column mapping.
   * Resolves with the number of students added (0 when cancelled, or refused while the scores are finalized). */
  ui.openRosterPaste = function (opts) {
    var course = GT.store && GT.store.course();
    if (!course) { ui.toast('Add a course first.', { type: 'warn' }); return Promise.resolve(0); }
    if (refuseLocked(course, ADD_LOCKED_MSG)) return Promise.resolve(0);
    var courseId = course.id;
    var state = { rows: [], ncols: 0, mapping: ['full'], mappingAuto: true, headerIdx: -1, headerAuto: true, headerOn: false };
    var body = ui.el('<div class="rp">' +
      '<div class="field"><label for="rp-text">Paste names copied from Excel (one student per row)</label>' +
      '<textarea id="rp-text" class="pii rp-text" rows="8" spellcheck="false" autocomplete="off" placeholder="Student 01, Alpha&#10;Student 02, Bravo&#10;… or copy the No, Last name, First name and Team columns from Excel"></textarea>' +
      '<div class="help">One column (“Last, First” or “First Last”), two columns (Last name, First name), or No / Last / First / Team. ' +
      'A header row is detected and skipped. Names already in the course are skipped; new team names are created.</div></div>' +
      '<div class="rp-detect muted small" aria-live="polite"></div>' +
      '<div class="rp-map"></div>' +
      '<div class="rp-preview"></div></div>');
    var dlgEl = null;
    var textEl = body.querySelector('#rp-text');
    if (opts && typeof opts.text === 'string') textEl.value = opts.text;

    function recompute() {
      state.rows = parseRosterText(textEl.value);
      var ncols = columnCount(state.rows);
      var first = firstNonEmpty(state.rows);
      if (state.headerAuto) state.headerOn = first !== -1 && isHeaderRow(state.rows[first]);
      state.headerIdx = state.headerOn && first !== -1 ? first : -1;
      state.ncols = ncols;
      if (state.mappingAuto || state.mapping.length !== Math.max(ncols, 1)) {
        state.mapping = detectMapping(state.rows, state.headerIdx, ncols);
        state.mappingAuto = true;
      }
      paint();
    }

    function paint() {
      var c = model.findCourse(GT.store.state, courseId);
      if (!c) return;
      var focus = captureFocus(body);
      var plan = planRoster(c, state.rows, state.mapping, state.headerIdx);
      var hasText = state.rows.length > 0;
      body.querySelector('.rp-detect').textContent = hasText
        ? 'Detected ' + plural(Math.max(state.ncols, 1), 'column') + ': ' + state.mapping.map(function (r) { return ROLE_LABELS[r].replace(/ \(.*\)$/, ''); }).join(', ') +
          (state.headerIdx !== -1 ? '; header row skipped' : '') + '. Change the mapping below if needed.'
        : '';
      body.querySelector('.rp-map').innerHTML = mappingHtml(state);
      body.querySelector('.rp-preview').innerHTML = previewHtml(plan, hasText);
      restoreFocus(body, focus);
      if (dlgEl) {
        var btn = dlgEl.querySelector('.dlg-foot .btn-primary');
        if (btn) {
          btn.textContent = plan.counts.added ? 'Add ' + plural(plan.counts.added, 'student') : 'Add students';
          btn.disabled = plan.counts.added === 0;
        }
        var err = dlgEl.querySelector('.dlg-error');
        if (err) err.textContent = '';
      }
    }

    return ui.dialog.open({
      title: 'Paste roster',
      wide: true,
      body: body,
      buttons: [
        { text: 'Cancel', value: null },
        {
          text: 'Add students', primary: true, value: 'add',
          validate: function () {
            var c = model.findCourse(GT.store.state, courseId);
            var plan = c ? planRoster(c, state.rows, state.mapping, state.headerIdx) : null;
            return plan && plan.counts.added ? null : 'Nothing to add: paste at least one new name.';
          }
        }
      ],
      initialFocus: '#rp-text',
      onMount: function (dlg) {
        dlgEl = dlg;
        dlg.classList.add('roster-dlg');
        textEl.addEventListener('input', recompute);
        body.addEventListener('change', function (e) {
          var t = e.target;
          if (t.id === 'rp-header') {
            state.headerAuto = false;
            state.headerOn = t.checked;
            recompute();
          } else if (t.hasAttribute && t.hasAttribute('data-col')) {
            state.mapping[Number(t.getAttribute('data-col'))] = t.value;
            state.mappingAuto = false;
            paint();
          }
        });
        recompute();
      }
    }).then(function (v) {
      if (v !== 'add') return 0;
      var c0 = model.findCourse(GT.store.state, courseId);
      if (!c0 || refuseLocked(c0, ADD_LOCKED_MSG)) return 0;
      var counts = GT.store.transact('Paste roster', function (c) {
        var plan = planRoster(c, state.rows, state.mapping, state.headerIdx);
        var teamIds = Object.create(null);
        plan.newTeams.forEach(function (name) {
          var t = model.createTeam(name);
          c.teams.push(t);
          teamIds[name.toLowerCase()] = t.id;
        });
        plan.items.forEach(function (it) {
          if (it.status !== 'new') return;
          var tid = it.teamId || (it.teamName ? teamIds[it.teamName.toLowerCase()] : null) || null;
          c.students.push(model.createStudent({ no: it.no, lastName: it.lastName, firstName: it.firstName, teamId: tid }));
        });
        return plan.counts;
      }, { source: 'roster', courseId: courseId });
      if (counts && counts.added) {
        ui.toast('Added ' + plural(counts.added, 'student') +
          (counts.teams ? ' and ' + plural(counts.teams, 'new team') : '') +
          (counts.duplicates ? '. ' + plural(counts.duplicates, 'duplicate') + ' skipped' : '') + '.',
          { type: 'success', action: undoAction(courseId, 'Paste roster') });
      }
      return counts ? counts.added : 0;
    });
  };

  // ------------------------------------------------------------------ student detail dialog

  function tile(label, valueHtml, sub, attrs) {
    return '<div class="sd-tile"' + (attrs || '') + '><div class="sd-tile-label">' + esc(label) + '</div><div class="sd-tile-value">' + valueHtml + '</div>' +
      (sub ? '<div class="sd-tile-sub">' + sub + '</div>' : '') + '</div>';
  }

  // Attendance section of the student detail (stage 3, T3-T5, X7). Numbers come from GT.attendance.summary,
  // the same numbers as the Grades and Attendance tabs. Words: "Excused (allowed, instructor-approved)" and
  // "Absent (not allowed, unexcused)" (DECISIONS 3). Nothing is shown when attendance is off.

  function attDate(iso, withYear) {
    if (!util.isIsoDate(iso)) return String(iso || '');
    var md = util.MONTH_SHORT[parseInt(iso.slice(5, 7), 10) - 1] + ' ' + parseInt(iso.slice(8, 10), 10);
    return util.WEEKDAY_SHORT[util.weekday(iso)] + ' ' + md + (withYear ? ', ' + iso.slice(0, 4) : '');
  }

  function attShortDate(iso) {
    if (!util.isIsoDate(iso)) return String(iso || '');
    return util.MONTH_SHORT[parseInt(iso.slice(5, 7), 10) - 1] + ' ' + parseInt(iso.slice(8, 10), 10);
  }

  function attNum(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

  function attPct(x) { return typeof x === 'number' && isFinite(x) ? util.formatPercent(x, 1) : '—'; }

  /** The student's held sessions in date order with their mark ('P' | 'A' | 'E' | ''). */
  function attMarksByDate(course, sid) {
    var held = [];
    try { held = GT.attendance.heldSessions(course) || []; } catch (e) { held = []; }
    var rec = course.attendance && util.isPlainObject(course.attendance.records) ? course.attendance.records : {};
    var row = util.hasOwn(rec, sid) && util.isPlainObject(rec[sid]) ? rec[sid] : {};
    return held.map(function (ses) {
      var m = util.hasOwn(row, ses.id) ? row[ses.id] : '';
      return { ses: ses, mark: m === 'P' || m === 'A' || m === 'E' ? m : '' };
    });
  }

  function attTile(label, value, cls, title) {
    return '<div class="sd-att-tile' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<div class="sd-att-label">' + label + '</div><div class="sd-att-value">' + value + '</div></div>';
  }

  /** s: the student (optional). A withdrawn student keeps the numbers and the absences by date but gets no
   * warning (no F/drop or threshold callout, no highlight): warnings cover active students only (STAGE3 §1),
   * the same rule as the Attendance tab and the Grades grid. */
  function attendanceHtml(course, sid, s) {
    var A = GT.attendance;
    if (!A || typeof A.summary !== 'function') return '';
    if (!course.attendance || course.attendance.mode === 'off') return '';
    var a;
    try { a = A.summary(course, sid); } catch (e) { return ''; }
    if (!a) return '';
    var att = course.attendance;
    var totals = a.mode === 'totals';
    var rec = attNum(a.recorded);
    var thr = typeof att.unexcusedThreshold === 'number' ? att.unexcusedThreshold : null;
    var tthr = typeof att.totalAbsenceThreshold === 'number' ? att.totalAbsenceThreshold : null;
    var drop = typeof att.dropStreak === 'number' ? att.dropStreak : 3;
    var countE = att.excusedCountsTowardStreak === true;
    var wd = !!(s && s.status === 'withdrawn');
    var warning = wd ? null : a.warning;
    var over = !wd && !!a.overThreshold;
    var overT = !wd && !!a.overTotalThreshold;

    var head = '<div class="sd-hist-head"><h4 class="section-label">Attendance <span class="muted">(' + (totals ? 'totals only' : 'per session') + ')</span></h4>' +
      (GT.views && GT.views.attendance ? '<button type="button" class="btn btn-sm btn-ghost no-print" data-sd="attendance" data-fk="sd-attendance">' +
        'Open in Attendance' + icon('chevron-right') + '</button>' : '') + '</div>';

    var tiles = '<div class="sd-att-tiles">' +
      attTile('Excused <span class="sd-att-sub">(allowed)</span>', String(attNum(a.excused)), 'sd-att-exc', 'Excused absences: allowed, approved by the instructor') +
      attTile('Unexcused <span class="sd-att-sub">(not allowed)</span>',
        (over ? icon('alert', 'icon-sm') + ' ' : '') + attNum(a.unexcused), 'sd-att-unx' + (over ? ' is-over' : ''),
        'Unexcused absences: not allowed' + (over && thr !== null ? '. Above the unexcused-absence threshold (' + thr + ')' : '')) +
      attTile('Total absences', (overT ? icon('alert', 'icon-sm') + ' ' : '') + attNum(a.totalAbsences), 'sd-att-tot' + (overT ? ' is-over' : ''),
        'Excused + unexcused' + (overT && tthr !== null ? '. Above the total-absence threshold (' + tthr + ')' : '')) +
      attTile('Absence rate', attPct(a.absenceRate), 'sd-att-arate', 'Total absences as a percentage of the recorded sessions') +
      attTile('Unexcused rate', attPct(a.unexcusedRate), 'sd-att-urate', 'Unexcused absences as a percentage of the recorded sessions') +
      attTile('Longest streak', totals ? '<span class="sd-att-na">n/a</span>' : String(attNum(a.longestStreak)), 'sd-att-streak',
        totals ? 'n/a in totals mode: streaks need the date of each absence' : 'Most absences in a row') +
      '</div>';

    var basis;
    if (totals) {
      basis = 'Out of ' + plural(rec, 'session') + ' held so far (typed in the Attendance tab). Absence dates are not recorded in totals mode, so streak warnings are n/a.';
    } else {
      var unmarked = attNum(a.unmarked);
      basis = 'Out of ' + plural(rec, 'recorded session') + (unmarked ? ' (' + attNum(a.held) + ' held; ' + plural(unmarked, 'session') + ' without a mark for this student)' : '') + '. ' +
        (countE ? 'Excused absences count toward a streak (course setting).' : 'Only unexcused absences make a streak; an excused absence breaks it (course setting).');
    }

    // Warnings (T4, T5): never change the grade.
    var warn = '';
    var runs = Array.isArray(a.streaks) ? a.streaks : [];
    var warnRuns = runs.filter(function (r) { return r && attNum(r.length) >= drop; });
    var runText = warnRuns.map(function (r) {
      var dates = Array.isArray(r.dates) && r.dates.length ? r.dates : [r.startDate, r.endDate];
      return dates.map(attShortDate).join(', ');
    }).join('; ');
    if (warning === 'fail' || warning === 'drop') {
      warn += '<div class="callout ' + (warning === 'fail' ? 'callout-danger' : 'callout-warn') + ' sd-att-warn" data-att-warn="' + warning + '">' + icon('alert') +
        '<span><strong>' + attNum(a.longestStreak) + ' absences in a row' + (runText ? ' (' + esc(runText) + ')' : '') + ':</strong> the syllabus says ' +
        (warning === 'fail' ? 'F' : 'one letter grade drop') + '. Warning only: the grade is not changed automatically.</span></div>';
    }
    if (over) {
      warn += '<div class="callout callout-warn sd-att-warn" data-att-warn="threshold">' + icon('alert') + '<span>' + plural(attNum(a.unexcused), 'unexcused absence') +
        ': above the unexcused-absence threshold' + (thr !== null ? ' (' + thr + ')' : '') + '.</span></div>';
    }
    if (overT) {
      warn += '<div class="callout callout-warn sd-att-warn" data-att-warn="total-threshold">' + icon('alert') + '<span>' + plural(attNum(a.totalAbsences), 'absence') +
        ' in total (excused + unexcused): above the total-absence threshold' + (tthr !== null ? ' (' + tthr + ')' : '') + '.</span></div>';
    }
    if (wd && (a.warning || a.overThreshold || a.overTotalThreshold)) {
      warn += '<p class="small muted sd-att-wd" data-att-warn="withdrawn">Withdrawn: no attendance warning (warnings cover active students only).</p>';
    }
    if (a.moreAbsencesThanSessions) {
      warn += '<div class="callout callout-warn sd-att-warn" data-att-warn="too-many">' + icon('alert') +
        '<span>More absences than sessions held (' + rec + '). Check the numbers in the Attendance tab.</span></div>';
    }

    // Absences by date (per-session mode): excused vs unexcused, and which ones form a warning run.
    var list = '';
    if (!totals) {
      var inRun = {};
      warnRuns.forEach(function (r) { (r.sessionIds || []).forEach(function (id) { inRun[id] = r.length; }); });
      var byDate = attMarksByDate(course, sid);
      var absences = byDate.filter(function (x) { return x.mark === 'A' || x.mark === 'E'; });
      var missing = byDate.filter(function (x) { return !x.mark; });
      if (absences.length) {
        list = '<div class="table-wrap sd-att-wrap"><table class="table sd-att-list"><thead><tr><th scope="col">Date</th><th scope="col">Absence</th><th scope="col">Note</th></tr></thead><tbody>' +
          absences.map(function (x) {
            var s = x.ses;
            var kind = x.mark === 'A'
              ? '<span class="sd-att-mark ma">A</span> Absent <span class="muted">(not allowed, unexcused)</span>'
              : '<span class="sd-att-mark me">E</span> Excused <span class="muted">(allowed, instructor-approved)</span>';
            var note = [];
            if (s.label) note.push(esc(s.label));
            if (inRun[s.id]) note.push('<span class="badge' + (wd ? '' : ' badge-warn') + '">part of ' + inRun[s.id] + ' in a row</span>');
            return '<tr data-att-date="' + esc(s.date) + '" data-att-mark="' + x.mark + '"><td class="nowrap">' + esc(attDate(s.date, true)) + '</td><td>' + kind + '</td>' +
              '<td>' + note.join(' ') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      } else {
        list = '<p class="muted sd-att-none">' + icon('check', 'icon-sm') + ' No absences recorded' + (rec ? '' : ' yet') + '.</p>';
      }
      if (missing.length) {
        list += '<p class="small muted sd-att-missing">No mark for this student on: ' +
          esc(missing.slice(0, 12).map(function (x) { return attShortDate(x.ses.date); }).join(', ') + (missing.length > 12 ? ', …' : '')) +
          ' (not counted, and a streak stops there).</p>';
      }
    }

    return '<section class="sd-section sd-att-section">' + head + tiles + '<p class="small muted sd-att-basis">' + esc(basis) + '</p>' + warn + list + '</section>';
  }

  /** True when a history entry concerns the student: its own entries, and summary entries that list the
   * student in their details (a band of more than 10 final letters is one "Final letters: n changed"). */
  function historyInvolves(h, sid) {
    if (!h) return false;
    if (GT.history && typeof GT.history.involvesStudent === 'function') {
      try { return !!GT.history.involvesStudent(h, sid); } catch (e) { /* fall back */ }
    }
    return h.studentId === sid;
  }

  /** The entry as this student's row: a summary entry becomes the student's own change, taken from its
   * details (field "Final letter", old → new), with the note 'Part of "Final letters: 12 changed"'. */
  function historyRowFor(h, sid) {
    if (h.studentId === sid || !GT.history || typeof GT.history.detailFor !== 'function') return h;
    var d = null;
    try { d = GT.history.detailFor(h, sid); } catch (e) { d = null; }
    if (!d) return h;
    var summary = (h.field || 'Change') + (h.newValue ? ': ' + h.newValue : '');
    return {
      ts: h.ts, kind: h.kind, source: h.source, userNote: h.userNote,
      field: h.fieldKey === 'finalLetters' ? 'Final letter' : h.field,
      fieldKey: h.fieldKey === 'finalLetters' ? 'student.finalLetter' : h.fieldKey,
      oldValue: d.oldValue, newValue: d.newValue,
      note: 'Part of "' + summary + '"'
    };
  }

  function historyHtml(course, sid) {
    var list = (course.history || []).filter(function (h) { return historyInvolves(h, sid); });
    var total = list.length;
    list = list.slice(-100).reverse().map(function (h) { return historyRowFor(h, sid); });
    if (!list.length) return '<section class="sd-section"><h4 class="section-label">Change history</h4><p class="muted">No changes recorded for this student yet.</p></section>';
    var labels = GT.history && GT.history.KIND_LABELS ? GT.history.KIND_LABELS : {};
    var piiKeys = { 'student.lastName': true, 'student.firstName': true, 'student.notes': true };
    var rows = list.map(function (h) {
      var p = piiKeys[h.fieldKey] || h.field === 'Last Name' || h.field === 'First Name' || h.field === 'Notes';
      var cls = p ? ' class="pii"' : '';
      var note = [h.note, h.userNote ? 'Your note: ' + h.userNote : ''].filter(Boolean).join(' · ');
      return '<tr><td class="nowrap"><time datetime="' + esc(h.ts) + '">' + esc(ui.dateTime(h.ts)) + '</time></td>' +
        '<td>' + esc(h.field) + '</td>' +
        '<td class="sd-change"><span' + cls + '>' + (h.oldValue === '' || h.oldValue === undefined ? '<span class="faint">(empty)</span>' : esc(h.oldValue)) + '</span> → ' +
        '<span' + cls + '>' + (h.newValue === '' || h.newValue === undefined ? '<span class="faint">(empty)</span>' : esc(h.newValue)) + '</span></td>' +
        '<td><span class="badge">' + esc(labels[h.kind] || h.kind) + '</span></td>' +
        '<td><span class="badge">' + esc(h.source) + '</span></td>' +
        '<td class="sd-note small">' + (note ? '<span' + (h.userNote ? ' class="pii"' : '') + '>' + esc(note) + '</span>' : '') + '</td></tr>';
    }).join('');
    var canOpen = !!(GT.views && GT.views.history && GT.app && typeof GT.app.navigate === 'function');
    return '<section class="sd-section"><div class="sd-hist-head"><h4 class="section-label">Change history <span class="muted">(' +
      (total > 100 ? 'newest 100 of ' + total : plural(total, 'change')) + ', newest first)</span></h4>' +
      (canOpen ? '<button type="button" class="btn btn-sm btn-ghost no-print" data-sd="history" data-field="sd-history">' +
        ui.icon('history') + 'Open in History</button>' : '') + '</div>' +
      '<div class="table-wrap sd-hist-wrap"><table class="table sd-hist"><thead><tr><th scope="col">When</th><th scope="col">Field</th><th scope="col">Old → New</th>' +
      '<th scope="col">Kind</th><th scope="col">Source</th><th scope="col">Note</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
  }

  /** The Final letter tile of the detail dialog: a drop-down of the scale's letters plus "(none)". */
  function finalTileHtml(course, s, f, canSet) {
    var letters = scaleLetters(course);
    var opts = '<option value=""' + (f.letter === null ? ' selected' : '') + '>(none)</option>' +
      (f.letter !== null && !f.valid ? '<option value="' + KEEP_CURRENT + '" selected>' + esc(f.letter) + ' (not in the scale)</option>' : '') +
      letters.map(function (l) {
        return '<option value="' + esc(l) + '"' + (f.valid && l === f.letter ? ' selected' : '') + '>' + esc(l) + '</option>';
      }).join('');
    var sel = '<select id="sd-final" class="sd-final-select' + (f.valid ? '' : ' is-invalid') + '" data-fk="sd-final"' +
      ' aria-label="' + esc('Final letter for ' + studentRef(s)) + '" aria-describedby="sd-final-sub"' + (canSet ? '' : ' disabled') + '>' + opts + '</select>';
    var sub = [];
    if (f.letter === null) sub.push('Not assigned yet' + (f.suggested ? ' · suggestion ' + esc(f.suggested) : ''));
    else if (!f.valid) sub.push('<span class="sd-final-bad">' + icon('alert', 'icon-sm') + ' Not a letter of the current scale: choose another letter</span>');
    else if (f.differs) sub.push('<span class="sd-differs"><span class="sd-dot" aria-hidden="true"></span>Differs from the cutoff suggestion (' + esc(f.suggested) + ')</span>');
    else sub.push('Same as the cutoff suggestion');
    if (f.orderIssue) sub.push('<span class="sd-order">' + icon('alert', 'icon-sm') + ' Higher letter than a student with a higher total</span>');
    if (isWithdrawn(s)) sub.push('withdrawn: not counted in statistics');
    return '<div class="sd-tile sd-final-tile"><div class="sd-tile-label"><label for="sd-final">Final letter</label></div>' +
      '<div class="sd-tile-value">' + sel + '</div><div class="sd-tile-sub" id="sd-final-sub">' + sub.join('<br>') + '</div></div>';
  }

  /** Raw-score cell of the detail dialog. An individually entered score with a drop-down list is a <select>
   * ("(empty)" plus the list values; a stored value that is not on the list stays selected and flagged). */
  function rawCellHtml(course, s, a, d, res, locked) {
    var raw = entryText(res.entry);
    var values = res.source === 'individual' ? choiceValues(a) : [];
    var cls = 'num sd-raw' + (d.state === 'invalid' ? ' is-invalid' : (d.outOfRange || d.notOnList) ? ' is-range' : '');
    if (!values.length) return '<td class="' + cls + '">' + (raw === '' ? '<span class="faint">–</span>' : esc(raw)) + '</td>';
    var cur = d.state === 'number' ? util.fix(d.raw) : null;
    var onList = cur !== null && values.indexOf(cur) !== -1;
    var opts = '<option value=""' + (d.state === 'empty' ? ' selected' : '') + '>(empty)</option>' +
      (d.state === 'number' && !onList ? '<option value="' + KEEP_CURRENT + '" selected>' + esc(raw) + ' (not on the list)</option>' : '') +
      (d.state === 'invalid' ? '<option value="' + KEEP_CURRENT + '" selected>' + esc(raw) + ' (not a number)</option>' : '') +
      values.map(function (v) {
        return '<option value="' + esc(String(v)) + '"' + (onList && v === cur ? ' selected' : '') + '>' + esc(choiceText(v)) + '</option>';
      }).join('');
    return '<td class="' + cls + ' sd-raw-choice"><select class="sd-choice' + (d.state === 'invalid' ? ' is-invalid' : (d.notOnList || d.outOfRange) ? ' is-range' : '') + '"' +
      ' data-sd-choice="' + esc(a.id) + '" data-fk="sd-choice:' + esc(a.id) + '"' +
      ' aria-label="' + esc(a.name + ' score for ' + studentRef(s) + ', out of ' + choiceText(a.maxScore)) + '"' +
      (locked ? ' disabled title="' + esc(LOCKED_MSG) + '"' : '') + '>' + opts + '</select></td>';
  }

  function studentDetailHtml(course, results, sid) {
    var s = model.findStudent(course, sid);
    if (!s) {
      return '<div class="empty-state"><h2>Student not found</h2><p>This student was deleted, or the course changed.</p></div>';
    }
    var r = results && results.byId[sid] ? results.byId[sid] : calc.studentResult(course, s);
    var t = teamOf(course, s);
    var w = isWithdrawn(s);
    var name = model.studentName(s);
    var ranked = results ? results.activeIds.length : 0;
    var locked = isLocked(course);

    var h = '<div class="sd-head"><div class="sd-id">' +
      '<h3 class="sd-name pii">' + (name ? esc(name) : '(no name)') + '</h3>' +
      '<div class="sd-meta"><span class="badge">No ' + (typeof s.no === 'number' ? s.no : '–') + '</span>' +
      '<span class="badge badge-info">' + icon('users') + esc(t ? t.name : 'No team') + '</span>' +
      (w ? '<span class="badge">Withdrawn</span>' : '<span class="muted sd-status">Active</span>') +
      '<span class="badge">' + esc(model.courseLabel(course)) + '</span></div></div>' +
      '<div class="sd-actions no-print">' +
      '<button type="button" class="btn btn-sm" data-sd="edit" data-fk="sd-edit"' +
        (locked ? ' title="Scores are finalized: No, name and team are locked. Notes stay editable."' : '') + '>' + icon('edit') + (locked ? 'Edit notes' : 'Edit') + '</button>' +
      '<button type="button" class="btn btn-sm" data-sd="status" data-fk="sd-status">' + icon(w ? 'undo' : 'flag') + (w ? 'Reinstate…' : 'Withdraw…') + '</button>' +
      '<button type="button" class="btn btn-sm" data-sd="print" data-fk="sd-print">' + icon('print') + 'Print</button>' +
      '</div></div>';
    if (w) {
      h += '<div class="callout sd-wd">Withdrawn: kept in history and exports, excluded from statistics, rank, percentile and the class average.</div>';
    }
    if (locked) {
      h += '<div class="callout callout-warn sd-lock">' + icon('lock') + '<span><strong>Scores finalized' +
        (course.finalized.at ? ' on ' + esc(ui.dateTime(course.finalized.at)) : '') + '.</strong> Scores, No, name and team are locked; the final letter and the notes stay editable.</span></div>';
    }
    var fi = finalInfo(course, s, r);

    var incompleteSub = r.incomplete
      ? '<span class="sd-incomplete">' + icon('info', 'icon-sm') + ' ' + plural(r.missingCount, 'weighted score') + ' empty or not a number (counted as 0)</span>'
      : (r.curve ? 'includes curve ' + esc(signed(r.curve)) : 'all weighted scores entered');
    h += '<div class="sd-summary">' +
      tile('Total', '<span data-sd-total>' + esc(fmt(r.total)) + '</span>', incompleteSub) +
      tile('Suggested letter', '<span data-sd-letter>' + esc(r.letter || '—') + '</span> ' + ui.placeholderBadge(course, 'letterScale', { compact: true }),
        'from the cutoffs' + (w ? ' · shown for reference' : '')) +
      finalTileHtml(course, s, fi, typeof model.setFinalLetter === 'function') +
      tile('Rank', '<span data-sd-rank>' + (r.rank ? r.rank + ' of ' + ranked : '—') + '</span>', w ? 'withdrawn: not ranked' : 'among active students') +
      tile('Percentile', '<span data-sd-percentile>' + (r.percentile !== null && r.percentile !== undefined ? ordinal(r.percentile) : '—') + '</span>', w ? 'withdrawn: excluded' : '') +
      tile('vs class average', '<span data-sd-diff>' + esc(signed(r.diffFromAverage)) + '</span>',
        'class average ' + esc(fmt(results ? results.average : null)) + ' (active students)') +
      '</div>';

    var rowsHtml = course.assessments.map(function (a) {
      var d = r.items[a.id] || calc.scoreDetail(course, s, a);
      var res = calc.resolveEntry(course, s, a);
      var source;
      if (d.source === 'team') source = icon('users', 'icon-sm') + ' Team <span class="muted">(' + esc(t ? t.name : '') + ')</span>';
      else if (d.source === 'override') {
        var te = t ? model.getEntry(course.teamScores, t.id, a.id) : null;
        source = '<span class="ov-diamond" aria-hidden="true">◆</span> Override <span class="muted">(team score ' + esc(entryLabel(te)) + ')</span>';
      } else source = 'Individual' + (a.teamGraded ? ' <span class="muted">(no team)</span>' : '');
      var flags = [];
      if (d.state === 'invalid') flags.push('<span class="badge badge-danger">Not a number · counted as 0</span>');
      if (d.outOfRange) flags.push('<span class="badge badge-warn">Outside 0–' + esc(a.maxScore) + '</span>');
      if (d.notOnList && !d.outOfRange) flags.push('<span class="badge badge-warn">Not one of the list values</span>');
      if (choiceValues(a).length && res.source !== 'individual') {
        flags.push('<span class="badge">Drop-down list: edit in Grades' + (res.source === 'team' ? ' or Team scores' : '') + '</span>');
      }
      if (d.state === 'empty') flags.push('<span class="badge">Empty' + ((a.weight || 0) > 0 ? ' · counted as 0' : '') + '</span>');
      if (d.weeksLate > 0) flags.push('<span class="badge badge-info">' + d.weeksLate + ' wk late' + (d.waived ? ', waived' : (d.penalty ? ' · −' + esc(fmt(d.penalty)) : '')) + '</span>');
      return '<tr><th scope="row"><span class="sd-swatch ' + groupClass(course, a) + '" aria-hidden="true"></span>' + esc(a.name) + '</th>' +
        '<td class="num">' + esc(a.maxScore) + '</td><td class="num sd-weight">' + weightBadges(course, a) + ' ' + esc(a.weight) + '%</td>' +
        rawCellHtml(course, s, a, d, res, locked) +
        '<td>' + source + '</td><td class="num">' + esc(fmt(d.weighted)) + '</td><td class="sd-flags">' + flags.join(' ') + '</td></tr>';
    }).join('');
    var roundingNote = course.settings.rounding === 'integer' ? 'rounded to a whole number' : course.settings.rounding === 'hundredth' ? 'rounded to 0.01' : '';
    h += '<section class="sd-section"><h4 class="section-label">Scores</h4><div class="table-wrap"><table class="table sd-scores"><thead><tr>' +
      '<th scope="col">Assessment</th><th scope="col" class="num">Max ' + ui.placeholderBadge(course, 'maxScores', { compact: true }) + '</th><th scope="col" class="num">Weight</th>' +
      '<th scope="col" class="num">Raw (as entered)</th><th scope="col">Source</th><th scope="col" class="num">Weighted</th><th scope="col">Flags</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody><tfoot>' +
      '<tr><th scope="row" colspan="5">Sum of weighted scores</th><td class="num">' + esc(fmt(r.weightedSum)) + '</td><td></td></tr>' +
      (r.curve ? '<tr><th scope="row" colspan="5">Curve ' + ui.placeholderBadge(course, 'curve', { compact: true }) + '</th><td class="num">' + esc(signed(r.curve)) + '</td><td></td></tr>' : '') +
      '<tr class="sd-total-row"><th scope="row" colspan="5">Total' + (roundingNote ? ' <span class="muted small">(' + roundingNote + ')</span> ' +
        ui.placeholderBadge(course, 'rounding', { compact: true }) : '') + '</th>' +
      '<td class="num"><strong>' + esc(fmt(r.total)) + '</strong></td><td>' + (fi.letter !== null
        ? '<span class="badge ' + (fi.valid ? 'badge-accent' : 'badge-danger') + '" title="Final letter (assigned by hand)">' + esc(fi.letter) + ' · final</span>'
        : (r.letter ? '<span class="badge" title="Suggested letter from the cutoffs; no final letter yet">' + esc(r.letter) + ' · suggested</span>' : '')) + '</td></tr>' +
      '</tfoot></table></div></section>';

    h += attendanceHtml(course, sid, s);

    h += '<section class="sd-section"><h4 class="section-label"><label for="sd-notes">Notes</label></h4>' +
      '<textarea id="sd-notes" class="pii sd-notes" data-fk="sd-notes" rows="3" aria-label="Notes for ' + esc(studentRef(s)) + '">' + esc(s.notes) + '</textarea>' +
      '<div class="help faint small no-print">Saved when you leave the field.</div></section>';

    h += historyHtml(course, sid);
    return h;
  }

  function sameNotes(a, b) {
    return String(a || '').replace(/\r\n?/g, '\n') === String(b || '').replace(/\r\n?/g, '\n');
  }

  function printStudent() {
    var body = document.body;
    function done() {
      body.classList.remove('print-student');
      root.removeEventListener('afterprint', done);
    }
    body.classList.add('print-student');
    root.addEventListener('afterprint', done);
    try { root.print(); } catch (e) { done(); }
  }

  /** Student detail dialog: identity, totals, scores with sources and flags, attendance, notes,
   * this student's change history, and a Print button. Stays live while open. */
  ui.openStudent = function (studentId) {
    var course = GT.store && GT.store.course();
    if (!course || !model.findStudent(course, studentId)) {
      ui.toast('That student could not be found.', { type: 'warn' });
      return Promise.resolve(null);
    }
    var courseId = course.id;
    var body = document.createElement('div');
    body.className = 'sd';
    var queued = false;
    var closed = false;
    var lastHtml = null;
    var closeDialog = null;
    var repainting = false; // true while paint() replaces the content

    function currentCourse() { return model.findCourse(GT.store.state, courseId); }

    function paint() {
      if (closed) return;
      var c = currentCourse();
      var html = c ? studentDetailHtml(c, GT.store.results(courseId), studentId)
        : '<div class="empty-state"><h2>Course not found</h2></div>';
      if (html === lastHtml) return; // unchanged (e.g. an autosave notification): keep focus and typed notes
      var focus = captureFocus(body);
      // Drop-downs browsed to with the keyboard and not saved yet keep their shown value across a re-render.
      var pending = ui.$$('[data-sd-pending]', body).map(function (x) { return { fk: x.getAttribute('data-fk'), value: x.value }; });
      repainting = true; // removing a focused drop-down can fire focusout: that is not "leaving the list"
      try {
        body.innerHTML = html;
      } finally {
        repainting = false;
      }
      lastHtml = html;
      restoreFocus(body, focus);
      pending.forEach(function (p) {
        var x = p.fk ? body.querySelector('[data-fk="' + cssKey(p.fk) + '"]') : null;
        if (!x || x.disabled) return;
        x.value = p.value;
        if (x.value === p.value) setPending(x, true);
      });
    }

    function schedule() {
      if (queued || closed) return;
      queued = true;
      (root.requestAnimationFrame || setTimeout)(function () { queued = false; paint(); });
    }

    function saveNotes(value) {
      var c = currentCourse();
      var s = c && model.findStudent(c, studentId);
      if (!s || sameNotes(s.notes, value)) return;
      GT.store.transact('Edit notes', function (cc) {
        var x = model.findStudent(cc, studentId);
        if (x) x.notes = value;
      }, { courseId: courseId });
    }

    body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-sd]') : null;
      if (!b) return;
      var act = b.getAttribute('data-sd');
      var active = GT.store.course();
      if (act === 'print') { printStudent(); return; }
      if (!active || active.id !== courseId) { ui.toast('Switch back to ' + (currentCourse() || {}).code + ' to edit this student.', { type: 'warn' }); return; }
      if (act === 'edit') openStudentForm(studentId);
      else if (act === 'status') toggleStatus(studentId);
      else if (act === 'history' && GT.app && GT.app.navigate) {
        // Show the full, filterable log for this student (the dialog lists only the newest 100).
        if (closeDialog) closeDialog(null);
        GT.app.navigate('history', { studentId: studentId });
      } else if (act === 'attendance' && GT.app && GT.app.navigate) {
        // The student's row in the Attendance tab (per session: the grid, at their longest streak).
        if (closeDialog) closeDialog(null);
        GT.app.navigate('attendance', { studentId: studentId });
      }
    });
    /** Final letter from the drop-down (letters stay editable when the scores are finalized). */
    function saveFinalLetter(sel) {
      var c = currentCourse();
      var s = c && model.findStudent(c, studentId);
      if (!s || sel.value === KEEP_CURRENT) return;
      if (typeof model.setFinalLetter !== 'function') { ui.toast('Final letters are not available.', { type: 'warn' }); return; }
      var next = sel.value === '' ? null : sel.value;
      if (finalLetterOf(s) === next) return;
      try {
        GT.store.transact(next ? 'Set final letter' : 'Clear final letter', function (cc) {
          model.setFinalLetter(cc, studentId, next);
        }, { courseId: courseId });
      } catch (err) {
        ui.toast(err && err.message ? err.message : String(err), { type: 'error' });
        lastHtml = null;
        paint();
      }
    }

    /** A score picked from an item's drop-down list (individually entered scores only; locked when finalized). */
    function saveChoice(sel) {
      var aid = sel.getAttribute('data-sd-choice');
      var c = currentCourse();
      var s = c && model.findStudent(c, studentId);
      var a = c && model.findAssessment(c, aid);
      if (!s || !a || sel.value === KEEP_CURRENT) return;
      function refresh() { lastHtml = null; paint(); }
      if (isLocked(c)) { ui.toast(LOCKED_MSG, { type: 'info' }); refresh(); return; }
      var res = calc.resolveEntry(c, s, a);
      if (res.source !== 'individual') { refresh(); return; }
      var p = sel.value === '' ? { kind: 'empty' } : (typeof model.parseChoiceInput === 'function' ? model.parseChoiceInput(a, sel.value) : util.parseScoreInput(sel.value));
      if (p.kind === 'invalid') { ui.toast(p.message || 'Choose a value from the list.', { type: 'warn' }); refresh(); return; }
      var prev = model.getEntry(c.scores, studentId, aid);
      var next = model.entryFromInput(p.kind === 'number' ? String(p.value) : '', prev, a.maxScore);
      if (model.entryKey(prev) === model.entryKey(next) && entryText(prev) === entryText(next)) return;
      try {
        GT.store.transact('Edit ' + a.name + ' score', function (cc) {
          model.setEntry(cc.scores, studentId, aid, model.isBlankEntry(next) ? null : next);
        }, { courseId: courseId });
      } catch (err) {
        ui.toast(err && err.message ? err.message : String(err), { type: 'error' });
        refresh();
      }
    }

    // Drop-downs (Final letter, list scores). A pick from the opened list (mouse, or Enter in the list)
    // saves at once. Browsing a closed list with the keyboard (arrows, Home/End, PageUp/PageDown, typing a
    // letter) changes its value, and Chromium fires "change" on every key: those values are only shown
    // ("Enter to save") until Enter, leaving the list (Tab, a click elsewhere) or closing the dialog, so one
    // choice is one History entry and one undo step, as in the grid. Esc puts back the saved value.
    var kbdSel = null; // the drop-down whose last value change came from keyboard browsing

    function isDetailSelect(t) {
      return !!t && t.tagName === 'SELECT' && (t.id === 'sd-final' || t.hasAttribute('data-sd-choice'));
    }

    function pendingHint(sel, on) {
      var hint = body.querySelector('.sd-pending-hint');
      if (!on) { if (hint && hint.parentNode) hint.parentNode.removeChild(hint); return; }
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'sd-pending-hint no-print';
        hint.setAttribute('role', 'status');
        hint.textContent = 'Enter to save · Esc to cancel';
      }
      if (sel.nextElementSibling !== hint) sel.insertAdjacentElement('afterend', hint);
    }

    function setPending(sel, on) {
      if (on) {
        sel.setAttribute('data-sd-pending', '1');
        sel.classList.add('is-pending');
      } else {
        sel.removeAttribute('data-sd-pending');
        sel.classList.remove('is-pending');
      }
      pendingHint(sel, on);
    }

    /** Saves a drop-down's shown value if it has not been saved yet (one transaction). */
    function commitSelect(sel) {
      if (!sel || !sel.hasAttribute('data-sd-pending')) return;
      setPending(sel, false);
      if (sel.id === 'sd-final') saveFinalLetter(sel); else saveChoice(sel);
    }

    /** Esc on a drop-down with an unsaved value: show the saved value again. */
    function revertSelect(sel) {
      setPending(sel, false);
      lastHtml = null;
      paint();
    }

    var BROWSE_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Home: 1, End: 1, PageUp: 1, PageDown: 1 };
    body.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!isDetailSelect(t)) return;
      var pending = t.hasAttribute('data-sd-pending');
      if (e.key === 'Enter') {
        if (pending) { e.preventDefault(); commitSelect(t); }
        return;
      }
      if (e.key === 'Escape') {
        if (pending) { e.preventDefault(); e.stopPropagation(); revertSelect(t); }
        return;
      }
      if (e.key === 'Tab' || e.ctrlKey || e.metaKey) return;
      // Alt+Up/Down, F4 and Space open the list: a pick there saves at once, like a mouse pick.
      var browse = !e.altKey && (BROWSE_KEYS[e.key] === 1 || (e.key.length === 1 && e.key !== ' '));
      kbdSel = browse ? t : null;
    });
    body.addEventListener('mousedown', function (e) {
      if (isDetailSelect(e.target)) kbdSel = null;
    }, true);
    body.addEventListener('focusout', function (e) {
      if (repainting || !isDetailSelect(e.target)) return;
      commitSelect(e.target);
      if (kbdSel === e.target) kbdSel = null;
    });

    body.addEventListener('change', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'sd-notes') saveNotes(t.value);
      else if (isDetailSelect(t)) {
        setPending(t, true);
        if (kbdSel !== t) commitSelect(t);
      }
    });

    paint();
    var unsub = GT.store.subscribe(schedule);
    return ui.dialog.open({
      title: 'Student details',
      xwide: true,
      body: body,
      buttons: [{ text: 'Close', value: null, primary: true }],
      initialFocus: '.dlg-foot .btn-primary',
      onMount: function (dlg, close) { dlg.classList.add('student-dlg'); closeDialog = close; }
    }).then(function () {
      var notes = body.querySelector('#sd-notes');
      ui.$$('[data-sd-pending]', body).forEach(commitSelect); // a letter or score browsed to but not saved yet
      closed = true;
      unsub();
      document.body.classList.remove('print-student');
      if (notes) saveNotes(notes.value);
      return null;
    });
  };

  /** Add (null) or edit dialog for a student; exported for other views. */
  ui.editStudent = openStudentForm;

  // Exposed for tests and other views.
  GT.students = {
    planRoster: planRoster,
    parseRosterText: parseRosterText,
    detectMapping: detectMapping,
    isHeaderRow: isHeaderRow,
    splitFullName: splitFullName,
    scoreConflicts: scoreConflicts,
    moveStudents: moveStudents
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
