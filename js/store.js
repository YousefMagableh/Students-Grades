/* Grade Tracker - application state: transactions, change history, undo/redo, autosave, subscriptions.
 * See docs/DESIGN.md section 5. Browser only. Attaches GT.store.
 *
 * Rule: every change to course data goes through store.transact(), so that it is autosaved,
 * undoable, and logged in the course's change history. */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model, calc = GT.calc;

  var UNDO_LIMIT = 200;
  var SAVE_DELAY = 400;

  var state = null;
  var listeners = [];
  var undoStacks = {};
  var redoStacks = {};
  var version = 0;
  var resultsCache = { key: null, value: null };
  var status = { phase: 'idle', at: null, error: null, backend: 'memory' };

  // ------------------------------------------------------------------ basics

  function init(loaded, backend) {
    state = loaded;
    status.backend = backend || 'memory';
    version++;
  }

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

  /** Applies mutator(course) as one undoable, logged, autosaved change.
   * opts: { source = 'edit', courseId, historyMode = 'diff' | 'bulk' | 'none', note, undoable = true }.
   * Returns the mutator's return value. If the mutator throws, the course is restored and the error rethrown. */
  function transact(label, mutator, opts) {
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
    Array.prototype.push.apply(c.history, entries);
    if (o.undoable !== false) {
      var u = stack(undoStacks, c.id);
      u.push({ label: label, snapshot: before, mode: mode });
      if (u.length > UNDO_LIMIT) u.shift();
      redoStacks[c.id] = [];
    }
    c.updatedAt = ts;
    scheduleSave();
    notify({ type: 'transact', label: label, source: source, entries: entries, courseId: c.id });
    return ret;
  }

  function stepHistory(fromStack, toStack, source) {
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
    stack(toStack, c.id).push({ label: step.label, snapshot: current, mode: step.mode });
    c.updatedAt = ts;
    scheduleSave();
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
  function canUndo() { return !!peek(undoStacks); }
  function canRedo() { return !!peek(redoStacks); }
  function undoLabel() { return peek(undoStacks); }
  function redoLabel() { return peek(redoStacks); }

  /** Adds a note to an existing history entry (e.g. "changed per instructor email, Oct 12"). */
  function annotateHistory(entryId, text) {
    var c = course();
    if (!c) return;
    var e = (c.history || []).filter(function (h) { return h.id === entryId; })[0];
    if (!e) return;
    e.userNote = String(text || '');
    e.userNoteAt = util.nowIso();
    scheduleSave();
    notify({ type: 'annotate' });
  }

  // ------------------------------------------------------------------ app-level (not undoable)

  function setUi(patch) {
    Object.keys(patch).forEach(function (k) { state.ui[k] = patch[k]; });
    scheduleSave();
    notify({ type: 'ui', patch: patch });
  }

  function setMeta(patch) {
    Object.keys(patch).forEach(function (k) { state.meta[k] = patch[k]; });
    scheduleSave();
    notify({ type: 'meta', patch: patch });
  }

  function setActiveCourse(id) {
    if (!model.findCourse(state, id)) return;
    state.activeCourseId = id;
    scheduleSave();
    notify({ type: 'course-switch', courseId: id });
  }

  function addCourse(c) {
    state.courses.push(c);
    state.activeCourseId = c.id;
    scheduleSave();
    notify({ type: 'course-add', courseId: c.id });
    return c;
  }

  function deleteCourse(id) {
    var idx = -1;
    state.courses.forEach(function (c, i) { if (c.id === id) idx = i; });
    if (idx === -1) return;
    state.courses.splice(idx, 1);
    delete undoStacks[id];
    delete redoStacks[id];
    if (state.activeCourseId === id) {
      state.activeCourseId = state.courses.length ? state.courses[Math.max(0, idx - 1)].id : null;
    }
    scheduleSave();
    notify({ type: 'course-delete', courseId: id });
  }

  function moveCourse(id, delta) {
    var i = -1;
    state.courses.forEach(function (c, k) { if (c.id === id) i = k; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= state.courses.length) return;
    var tmp = state.courses[i];
    state.courses[i] = state.courses[j];
    state.courses[j] = tmp;
    scheduleSave();
    notify({ type: 'course-order' });
  }

  /** Replaces all data (restore from backup, delete all). Clears undo/redo. */
  function replaceState(newState, source) {
    state = newState;
    undoStacks = {};
    redoStacks = {};
    resultsCache = { key: null, value: null };
    scheduleSave();
    notify({ type: 'replace', source: source || 'restore' });
  }

  // ------------------------------------------------------------------ autosave

  var saveTimer = null;
  var saving = null;
  var dirtyWhileSaving = false;
  var changeSeq = 0;     // counts changes that need saving
  var savedSeq = 0;      // changeSeq included in the last successful save
  var emergencySeq = 0;  // changeSeq included in the last emergency copy (flushOnLeave)
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

  function scheduleSave() {
    changeSeq++;
    status.phase = 'pending';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; doSave(); }, SAVE_DELAY);
  }

  function doSave() {
    if (!state) return Promise.resolve();
    if (saving) { dirtyWhileSaving = true; return saving; }
    status.phase = 'saving';
    var seq = changeSeq;
    var ts = saveStamp();
    state.meta.lastSavedAt = ts;
    saving = GT.storage.save(state).then(function () {
      if (seq > savedSeq) savedSeq = seq;
      // A change made while this save ran (timer pending or flushed) is not saved yet.
      status.phase = saveTimer || dirtyWhileSaving ? 'pending' : 'saved';
      status.at = ts;
      status.error = null;
      status.backend = GT.storage.backend();
    }).catch(function (err) {
      status.phase = 'error';
      status.error = err && err.message ? err.message : String(err);
      if (root.console) console.error('Save failed', err);
    }).then(function () {
      saving = null;
      notify({ type: 'saved' });
      if (dirtyWhileSaving) { dirtyWhileSaving = false; return doSave(); }
    });
    return saving;
  }

  /** Saves immediately if anything is unsaved (e.g. before the page is hidden). A failed save is retried. */
  function flush() {
    var hadTimer = !!saveTimer;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (hadTimer || status.phase === 'pending' || status.phase === 'error' || dirtyWhileSaving) return doSave();
    return saving || Promise.resolve();
  }

  /** For a page that is being hidden, closed, reloaded or left: flush() alone starts an asynchronous
   * IndexedDB save that does not commit when the page unloads first, so a change made in the last moments
   * (less than the autosave delay, or while a save ran) would be lost. Unsaved changes are therefore first
   * written synchronously as an emergency copy (GT.storage.saveSync), which storage.load() prefers while it
   * is newer, and then saved normally. Returns true when an emergency copy was written. */
  function flushOnLeave() {
    var wrote = false;
    if (state && changeSeq > savedSeq && changeSeq > emergencySeq &&
        GT.storage && typeof GT.storage.saveSync === 'function') {
      var seq = changeSeq;
      state.meta.lastSavedAt = saveStamp(); // newer than any save that may still be running
      try { wrote = GT.storage.saveSync(state) === true; } catch (e) { wrote = false; }
      if (wrote) emergencySeq = seq;
    }
    flush();
    return wrote;
  }

  /** Saves now even if nothing changed (e.g. the first save of a new, empty profile). */
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return doSave();
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
    annotateHistory: annotateHistory,
    setUi: setUi,
    setMeta: setMeta,
    setActiveCourse: setActiveCourse,
    addCourse: addCourse,
    deleteCourse: deleteCourse,
    moveCourse: moveCourse,
    replaceState: replaceState,
    flush: flush,
    flushOnLeave: flushOnLeave,
    saveNow: saveNow,
    saveStatus: saveStatus,
    version: function () { return version; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
