/* Grade Tracker - application state: transactions, change history, undo/redo, autosave, subscriptions.
 * See docs/DESIGN.md section 5. Browser only. Attaches GT.store.
 *
 * Rule: every change to course data goes through store.transact(), so that it is autosaved,
 * undoable, and logged in the course's change history.
 *
 * Two open tabs: GT.storage.save() is a compare-and-swap on a save stamp. When another tab has saved
 * since this tab loaded, the save fails with a conflict and the store goes read-only ("conflict"):
 * autosave stops, transact() and the other data changes throw a conflict error (err.conflict), and
 * undo/redo do nothing. UI-only settings (theme, privacy, tab) still change on screen but are not saved.
 * Only a reload leaves this state (app.js shows the banner with Reload). */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model, calc = GT.calc;

  var UNDO_LIMIT = 200;
  var SAVE_DELAY = 400;
  var MERGE_MS = 30 * 60 * 1000;   // opts.mergeKey folds into the last entry while it is younger than this
  var CONFLICT_MESSAGE = 'This tab is out of date: Grade Tracker was changed in another tab. Reload to see the latest data.';

  var state = null;
  var listeners = [];
  var undoStacks = {};
  var redoStacks = {};
  var version = 0;
  var resultsCache = { key: null, value: null };
  var status = { phase: 'idle', at: null, error: null, backend: 'memory' };
  var conflict = false;   // another tab saved newer data: read-only until reload
  var stepSeq = 0;        // gives every undo/redo step a unique id (undoStepId)

  // ------------------------------------------------------------------ basics

  /** Starts with the loaded state (boot): nothing is unsaved yet, and the tab is not read-only. */
  function init(loaded, backend) {
    state = loaded;
    status.backend = backend || 'memory';
    status.phase = 'idle';
    status.error = null;
    conflict = false;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saving = null;
    dirtyWhileSaving = false;
    savedSeq = emergencySeq = changeSeq;
    savedDataSeq = emergencyDataSeq = dataSeq;
    version++;
  }

  function conflictError() {
    var e = new Error(CONFLICT_MESSAGE);
    e.name = 'ConflictError';
    e.conflict = true;
    return e;
  }

  /** True while this tab is out of date (another tab saved newer data): nothing can be changed or saved. */
  function readOnly() { return conflict; }

  /** Throws a conflict error while the store is read-only (before anything is changed). */
  function guard() { if (conflict) throw conflictError(); }

  function getState() { return state; }

  function course(id) {
    if (!state) return null;
    var cid = id || state.activeCourseId;
    return model.findCourse(state, cid) || state.courses[0] || null;
  }

  /** The course named by an explicit id (null if it no longer exists), else the active course.
   * An explicit id never falls back to another course, so a change cannot land in the wrong one. */
  function targetCourse(id) {
    if (!id) return course();
    return state ? model.findCourse(state, id) || null : null;
  }

  /** Memoized calc.computeCourse for a course (active course by default; null for an unknown id). */
  function results(id) {
    var c = targetCourse(id);
    if (!c) return null;
    var key = c.id + ':' + version;
    if (resultsCache.key !== key) resultsCache = { key: key, value: calc.computeCourse(c) };
    return resultsCache.value;
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  function notify(info) {
    version++;
    listeners.slice().forEach(function (fn) {
      try { fn(info || {}); } catch (e) { if (root.console) console.error(e); }
    });
  }

  // ------------------------------------------------------------------ snapshots (course without its history)

  function snapshot(c) {
    var copy = {};
    Object.keys(c).forEach(function (k) {
      if (k !== 'history') copy[k] = util.clone(c[k]);
    });
    return copy;
  }

  function restore(c, snap) {
    Object.keys(c).forEach(function (k) {
      if (k !== 'history' && k !== 'id' && !(k in snap)) delete c[k];
    });
    Object.keys(snap).forEach(function (k) {
      if (k !== 'history' && k !== 'id') c[k] = snap[k];
    });
  }

  function stack(map, id) {
    if (!map[id]) map[id] = [];
    return map[id];
  }

  function diffEntries(before, after, ts, source) {
    if (!GT.history || !GT.history.diffCourse) return [];
    try {
      return GT.history.diffCourse(before, after, { ts: ts, source: source }) || [];
    } catch (e) {
      if (root.console) console.error('history diff failed', e);
      return [];
    }
  }

  // ------------------------------------------------------------------ transactions

  // ------------------------------------------------------------------ merged history entries (opts.mergeKey)

  /** A per-student attendance entry (one mark), the kind a roll call logs. */
  function isMarkEntry(e) {
    return !!e && e.kind === 'attendance' && typeof e.studentId === 'string' && e.studentId !== '';
  }

  function detailOf(e, c) {
    var s = model.findStudent ? model.findStudent(c, e.studentId) : null;
    return {
      studentId: e.studentId,
      studentName: e.studentName === null || e.studentName === undefined ? '' : String(e.studentName),
      no: s && typeof s.no === 'number' && isFinite(s.no) ? s.no : null,
      field: e.field === null || e.field === undefined ? '' : String(e.field),
      oldValue: e.oldValue === null || e.oldValue === undefined ? '' : String(e.oldValue),
      newValue: e.newValue === null || e.newValue === undefined ? '' : String(e.newValue)
    };
  }

  /** opts.mergeKey (roll call): when the course's last history entry has the same mergeKey, is less than
   * MERGE_MS old and carries no note of the TA, the new per-student attendance entries are folded into it:
   * the result is ONE summary entry (field = the transaction label, newValue "<n> marks", details = every
   * merged change in order). Returns that entry, or null when the entries are appended as usual. */
  function mergedEntry(c, entries, label, key, ts, source) {
    var hist = Array.isArray(c.history) ? c.history : [];
    var last = hist.length ? hist[hist.length - 1] : null;
    if (!last || last.mergeKey !== key || last.userNote) return null;
    var age = Date.parse(ts) - Date.parse(last.ts);
    if (!(age >= 0 && age < MERGE_MS)) return null;
    if (!entries.length || !entries.every(isMarkEntry)) return null;
    var prior;
    if (Array.isArray(last.details)) prior = last.details.slice();
    else if (isMarkEntry(last)) prior = [detailOf(last, c)];
    else return null;
    var details = prior.concat(entries.map(function (e) { return detailOf(e, c); }));
    var who = Object.create(null), n = 0;
    details.forEach(function (d) { if (d && !who[d.studentId]) { who[d.studentId] = true; n++; } });
    return {
      id: util.uid('h'), ts: ts, source: source, kind: 'attendance',
      studentId: null, studentName: null, teamId: null, teamName: null,
      field: label, fieldKey: 'attendance', oldValue: '', newValue: details.length + ' marks',
      note: n + (n === 1 ? ' student' : ' students'),
      details: details, mergeKey: key
    };
  }

  // ------------------------------------------------------------------ transactions

  /** Applies mutator(course) as one undoable, logged, autosaved change.
   * opts: { source = 'edit', courseId, historyMode = 'diff' | 'bulk' | 'none', note, undoable = true,
   * mergeKey } (mergeKey: see mergedEntry; undo and redo stay per transaction).
   * Returns the mutator's return value. If the mutator throws, the course is restored and the error rethrown.
   * While the store is read-only (conflict) it throws a conflict error and changes nothing. */
  function transact(label, mutator, opts) {
    guard();
    var o = opts || {};
    var c = targetCourse(o.courseId);
    if (!c) throw new Error(o.courseId ? 'Course not found (it may have been deleted).' : 'No course selected.');
    var before = snapshot(c);
    var ret;
    try {
      ret = mutator(c);
    } catch (e) {
      restore(c, before);
      throw e;
    }
    var ts = util.nowIso();
    var source = o.source || 'edit';
    var mode = o.historyMode || 'diff';
    var entries = [];
    if (mode === 'diff') entries = diffEntries(before, c, ts, source);
    var changed = entries.length > 0 || JSON.stringify(before) !== JSON.stringify(snapshot(c));
    if (!changed) return ret;
    if (mode === 'bulk' && GT.history && GT.history.bulkEntry) {
      entries = [GT.history.bulkEntry({ ts: ts, source: source, field: label, note: o.note || '' })];
    } else if (o.note) {
      entries.forEach(function (e) { e.note = e.note ? e.note + ' | ' + o.note : o.note; });
    }
    if (!Array.isArray(c.history)) c.history = [];
    var merged = null;
    if (typeof o.mergeKey === 'string' && o.mergeKey !== '' && entries.length) {
      merged = mergedEntry(c, entries, label, o.mergeKey, ts, source);
      if (merged) {
        c.history[c.history.length - 1] = merged;
        entries = [merged];
      } else {
        entries.forEach(function (e) { e.mergeKey = o.mergeKey; });
      }
    }
    if (!merged) Array.prototype.push.apply(c.history, entries);
    if (o.undoable !== false) {
      var u = stack(undoStacks, c.id);
      u.push({ label: label, snapshot: before, mode: mode, id: ++stepSeq });
      if (u.length > UNDO_LIMIT) u.shift();
      redoStacks[c.id] = [];
    }
    c.updatedAt = ts;
    scheduleSave(true);
    notify({ type: 'transact', label: label, source: source, entries: entries, courseId: c.id, merged: !!merged });
    return ret;
  }

  function stepHistory(fromStack, toStack, source) {
    if (conflict) return false;
    var c = course();
    if (!c) return false;
    var from = stack(fromStack, c.id);
    if (!from.length) return false;
    var step = from.pop();
    var current = snapshot(c);
    restore(c, step.snapshot);
    var ts = util.nowIso();
    var note = (source === 'undo' ? 'Undo of "' : 'Redo of "') + step.label + '"';
    var entries;
    if (step.mode === 'bulk' && GT.history && GT.history.bulkEntry) {
      // A bulk change (e.g. loading sample data) is logged as one entry, so undoing it does too.
      entries = [GT.history.bulkEntry({ ts: ts, source: source, field: step.label, note: note })];
    } else {
      entries = diffEntries(current, c, ts, source);
      entries.forEach(function (e) { e.note = e.note ? e.note + ' | ' + note : note; });
    }
    if (!Array.isArray(c.history)) c.history = [];
    Array.prototype.push.apply(c.history, entries);
    stack(toStack, c.id).push({ label: step.label, snapshot: current, mode: step.mode, id: ++stepSeq });
    c.updatedAt = ts;
    scheduleSave(true);
    notify({ type: source, label: step.label, entries: entries, courseId: c.id });
    return true;
  }

  function undo() { return stepHistory(undoStacks, redoStacks, 'undo'); }
  function redo() { return stepHistory(redoStacks, undoStacks, 'redo'); }

  function peek(map) {
    var c = course();
    if (!c) return null;
    var s = map[c.id];
    return s && s.length ? s[s.length - 1].label : null;
  }
  function canUndo() { return !conflict && !!peek(undoStacks); }
  function canRedo() { return !conflict && !!peek(redoStacks); }
  function undoLabel() { return peek(undoStacks); }
  function redoLabel() { return peek(redoStacks); }

  /** A unique id of the active course's latest undo step (null when there is none). A new id is given
   * every time a step is pushed (a change, an undo or a redo), so it tells two steps with the same label apart. */
  function undoStepId() {
    var c = course();
    var s = c ? undoStacks[c.id] : null;
    return s && s.length ? s[s.length - 1].id : null;
  }

  /** Adds a note to an existing history entry (e.g. "changed per instructor email, Oct 12").
   * Returns true when the note was set (false for an unknown entry, or while read-only). */
  function annotateHistory(entryId, text) {
    if (conflict) return false;
    var c = course();
    if (!c) return false;
    var e = (c.history || []).filter(function (h) { return h.id === entryId; })[0];
    if (!e) return false;
    e.userNote = String(text || '');
    e.userNoteAt = util.nowIso();
    scheduleSave(true);
    notify({ type: 'annotate' });
    return true;
  }

  // ------------------------------------------------------------------ app-level (not undoable)

  /** UI-only settings (theme, privacy, active tab, view preferences). Saved like everything else (so a
   * stale tab fails into a conflict instead of overwriting newer data); while read-only they change on
   * screen only. */
  function setUi(patch) {
    Object.keys(patch).forEach(function (k) { state.ui[k] = patch[k]; });
    scheduleSave(false);
    notify({ type: 'ui', patch: patch });
  }

  function setMeta(patch) {
    Object.keys(patch).forEach(function (k) { state.meta[k] = patch[k]; });
    scheduleSave(false);
    notify({ type: 'meta', patch: patch });
  }

  function setActiveCourse(id) {
    if (!model.findCourse(state, id)) return;
    state.activeCourseId = id;
    scheduleSave(false);
    notify({ type: 'course-switch', courseId: id });
  }

  function addCourse(c) {
    guard();
    state.courses.push(c);
    state.activeCourseId = c.id;
    scheduleSave(true);
    notify({ type: 'course-add', courseId: c.id });
    return c;
  }

  function deleteCourse(id) {
    guard();
    var idx = -1;
    state.courses.forEach(function (c, i) { if (c.id === id) idx = i; });
    if (idx === -1) return;
    state.courses.splice(idx, 1);
    delete undoStacks[id];
    delete redoStacks[id];
    if (state.activeCourseId === id) {
      state.activeCourseId = state.courses.length ? state.courses[Math.max(0, idx - 1)].id : null;
    }
    scheduleSave(true);
    notify({ type: 'course-delete', courseId: id });
  }

  function moveCourse(id, delta) {
    guard();
    var i = -1;
    state.courses.forEach(function (c, k) { if (c.id === id) i = k; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= state.courses.length) return;
    var tmp = state.courses[i];
    state.courses[i] = state.courses[j];
    state.courses[j] = tmp;
    scheduleSave(true);
    notify({ type: 'course-order' });
  }

  /** Replaces all data (restore from backup, delete all). Clears undo/redo. The save that follows is a
   * normal compare-and-swap save, so a tab that is out of date cannot restore over newer data either. */
  function replaceState(newState, source) {
    guard();
    state = newState;
    undoStacks = {};
    redoStacks = {};
    resultsCache = { key: null, value: null };
    scheduleSave(true);
    notify({ type: 'replace', source: source || 'restore' });
  }

  /** Delete all data: cancels the pending autosave, waits for a running save, deletes every stored copy
   * (GT.storage.clear, which also stores a new save stamp, so another tab that still shows the old data
   * can never save it back) and then replaces the state with newState. Resolves when done. */
  function clearAll(newState, source) {
    guard();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    dirtyWhileSaving = false;
    return (saving || Promise.resolve()).then(function () {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      return GT.storage && GT.storage.clear ? GT.storage.clear() : null;
    }).then(function () {
      conflict = false; // the stored data is now this tab's (a new stamp), whatever happened before
      if (status.phase === 'conflict') { status.phase = 'idle'; status.error = null; }
      replaceState(newState, source || 'delete-all');
    });
  }

  // ------------------------------------------------------------------ autosave

  var saveTimer = null;
  var saving = null;
  var dirtyWhileSaving = false;
  var changeSeq = 0;     // counts changes that need saving
  var savedSeq = 0;      // changeSeq included in the last successful save
  var emergencySeq = 0;  // changeSeq included in the last emergency copy (flushOnLeave)
  var dataSeq = 0;           // counts changes to course data (not UI-only settings)
  var savedDataSeq = 0;      // dataSeq included in the last successful save
  var emergencyDataSeq = 0;  // dataSeq included in the last emergency copy
  var lastStamp = '';

  /** meta.lastSavedAt for a save: now, but always later than the previous one, so storage.load() can tell
   * which of two copies is newer even when both were taken in the same millisecond. */
  function saveStamp() {
    var ts = util.nowIso();
    if (lastStamp && ts <= lastStamp) {
      var t = Date.parse(lastStamp);
      ts = isFinite(t) ? new Date(t + 1).toISOString() : ts;
    }
    lastStamp = ts;
    return ts;
  }

  function storageStamp() {
    return GT.storage && typeof GT.storage.stamp === 'function' ? GT.storage.stamp() : null;
  }

  /** Read-only from now on: another tab saved newer data. Autosave stops; nothing more is saved. */
  function enterConflict() {
    if (conflict) return;
    conflict = true;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    dirtyWhileSaving = false;
    status.phase = 'conflict';
    status.error = CONFLICT_MESSAGE;
    notify({ type: 'conflict' });
  }

  /** data: true for a change to course data (transact, undo, notes, courses, replace), false for UI-only. */
  function scheduleSave(data) {
    if (conflict) return; // read-only: shown on screen, never saved
    changeSeq++;
    if (data) dataSeq++;
    status.phase = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; doSave(); }, SAVE_DELAY);
  }

  function doSave() {
    if (!state || conflict) return Promise.resolve();
    if (saving) { dirtyWhileSaving = true; return saving; }
    status.phase = 'saving';
    var seq = changeSeq, dseq = dataSeq;
    var ts = saveStamp();
    var ok = false;
    state.meta.lastSavedAt = ts;
    var started;
    try { started = GT.storage.save(state); } catch (e) { started = Promise.reject(e); }
    saving = Promise.resolve(started).then(function () {
      ok = true;
      if (seq > savedSeq) savedSeq = seq;
      if (dseq > savedDataSeq) savedDataSeq = dseq;
      // A change made while this save ran (timer pending or flushed) is not saved yet.
      status.phase = saveTimer || dirtyWhileSaving ? 'pending' : 'saved';
      status.at = ts;
      status.error = null;
      status.backend = GT.storage.backend();
    }).catch(function (err) {
      if (err && err.conflict) { enterConflict(); return; }
      status.phase = 'error';
      status.error = err && err.message ? err.message : String(err);
      // Saving paused on purpose (unreadable saved data, app.js) is shown in a banner, not logged.
      if (root.console && !(err && err.paused)) console.error('Save failed', err);
    }).then(function () {
      saving = null;
      notify({ type: 'saved', ok: ok, stamp: ok ? storageStamp() : null });
      if (dirtyWhileSaving && !conflict) { dirtyWhileSaving = false; return doSave(); }
      dirtyWhileSaving = false;
    });
    return saving;
  }

  /** Saves immediately if anything is unsaved (e.g. before the page is hidden). A failed save is retried. */
  function flush() {
    if (conflict) return saving || Promise.resolve();
    var hadTimer = !!saveTimer;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (hadTimer || status.phase === 'pending' || status.phase === 'error' || dirtyWhileSaving) return doSave();
    return saving || Promise.resolve();
  }

  /** For a page that is being hidden, closed, reloaded or left: flush() alone starts an asynchronous
   * IndexedDB save that does not commit when the page unloads first, so a change made in the last moments
   * (less than the autosave delay, or while a save ran) would be lost. Unsaved changes are therefore first
   * written synchronously as an emergency copy (GT.storage.saveSync), which storage.load() prefers while it
   * is newer, and then saved normally. With the localStorage backend saveSync is a full save, so nothing is
   * left to do. Returns true when a copy was written. Does nothing while read-only. */
  function flushOnLeave() {
    if (conflict) return false;
    var wrote = false;
    if (state && changeSeq > savedSeq && changeSeq > emergencySeq &&
        GT.storage && typeof GT.storage.saveSync === 'function') {
      var seq = changeSeq, dseq = dataSeq;
      var ts = saveStamp(); // newer than any save that may still be running
      state.meta.lastSavedAt = ts;
      try {
        wrote = GT.storage.saveSync(state) === true;
      } catch (e) {
        wrote = false;
        if (e && e.conflict) { enterConflict(); return false; }
      }
      if (wrote) {
        emergencySeq = seq;
        emergencyDataSeq = dseq;
        if (GT.storage.backend && GT.storage.backend() === 'localstorage' && !saving) {
          // A complete save: nothing is pending any more.
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
          savedSeq = Math.max(savedSeq, seq);
          savedDataSeq = Math.max(savedDataSeq, dseq);
          status.phase = 'saved';
          status.at = ts;
          status.error = null;
          notify({ type: 'saved', ok: true, stamp: storageStamp() });
          return true;
        }
      }
    }
    flush();
    return wrote;
  }

  /** Saves now even if nothing changed (e.g. the first save of a new, empty profile). */
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return doSave();
  }

  /** True when changes to course data made in this tab would be lost if it closed now: not saved, and not
   * kept by an emergency copy (one taken when the page started to go away). While read-only, every change
   * that was not saved before the conflict counts (its emergency copy is ignored on load). */
  function hasUnsavedData() {
    if (dataSeq <= savedDataSeq) return false;
    return conflict || dataSeq > emergencyDataSeq;
  }

  /** Checks storage now (another tab said it saved): enters the read-only state when another tab has
   * saved since this tab loaded or last saved. Resolves true when read-only. */
  function checkConflict() {
    if (conflict) return Promise.resolve(true);
    if (!GT.storage || typeof GT.storage.isStale !== 'function') return Promise.resolve(false);
    return (saving || Promise.resolve()).then(function () {
      return GT.storage.isStale();
    }).then(function (stale) {
      if (stale && !saving) enterConflict();
      return conflict;
    }, function () { return conflict; });
  }

  function saveStatus() {
    return { phase: status.phase, at: status.at, error: status.error, backend: status.backend };
  }

  GT.store = {
    init: init,
    get state() { return state; },
    getState: getState,
    course: course,
    results: results,
    subscribe: subscribe,
    notify: notify,
    transact: transact,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    undoLabel: undoLabel,
    redoLabel: redoLabel,
    undoStepId: undoStepId,
    annotateHistory: annotateHistory,
    setUi: setUi,
    setMeta: setMeta,
    setActiveCourse: setActiveCourse,
    addCourse: addCourse,
    deleteCourse: deleteCourse,
    moveCourse: moveCourse,
    replaceState: replaceState,
    clearAll: clearAll,
    flush: flush,
    flushOnLeave: flushOnLeave,
    saveNow: saveNow,
    saveStatus: saveStatus,
    hasUnsavedData: hasUnsavedData,
    checkConflict: checkConflict,
    readOnly: readOnly,
    CONFLICT_MESSAGE: CONFLICT_MESSAGE,
    version: function () { return version; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
