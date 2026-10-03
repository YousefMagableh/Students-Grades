/* Grade Tracker - local persistence (R3). IndexedDB first, then localStorage, then memory only.
 * Nothing is sent anywhere; data stays in this browser profile on this computer. Attaches GT.storage.
 *
 * Save stamps (two open tabs, docs/DESIGN.md section 5): every save writes a new, unique stamp next to the
 * data, and a save is a compare-and-swap. It only writes when the stored stamp is still the one this tab
 * loaded or last wrote; otherwise another tab has saved since, and the save fails with a conflict error
 * (err.conflict === true) instead of overwriting that newer data. With IndexedDB the stamp is the 'stamp'
 * key, read and written in the same readwrite transaction as the data, so the check is atomic. With
 * localStorage it is the 'grade-tracker:stamp' key. Deleting all data writes a new stamp too, so a stale
 * tab can never bring deleted data back. */
(function (root) {
  'use strict';
  var GT = root.GT;

  var DB_NAME = 'grade-tracker';
  var STORE = 'kv';
  var LS_KEY = 'grade-tracker:state';
  var LS_PREV = 'grade-tracker:state-prev';
  var LS_STAMP = 'grade-tracker:stamp';       // stamp of the localStorage data (localStorage backend)
  var LS_BASE = 'grade-tracker:state-base';   // IndexedDB stamps a localStorage copy continues (JSON array)
  var CONFLICT_MESSAGE = 'Grade Tracker was changed in another tab, so this tab is out of date and was not saved. ' +
    'Reload to see the latest data.';

  var backend = 'memory';
  var db = null;
  var memory = null;
  var loadNote = null;     // set by load() when the latest copy was unreadable and an older copy was loaded
  // With IndexedDB, a localStorage copy may exist next to it: left over from an earlier session (IndexedDB
  // failed then) or written by saveSync() as an emergency copy when the page was hidden or closed. It is
  // removed by the first IndexedDB save that includes everything in it (a save started after it was written).
  var lsCopy = true;       // such a copy may exist
  var lsCopySeq = 0;       // saveSeq when it was written (0: an earlier session, so any IndexedDB save covers it)
  var saveSeq = 0;         // counts save() and saveSync() calls, in the order their data was taken
  var known = '';          // stamp of the data this tab loaded or last wrote ('' = none stored)
  var inflight = [];       // stamps of IndexedDB saves still running (an emergency copy also continues them)
  var fallbackBase = null; // after IndexedDB failed mid-session: the IndexedDB stamp the localStorage data continues
  var tabId = Math.random().toString(36).slice(2, 10);
  var stampCount = 0;

  /** A new stamp, unique across tabs: time, this tab's random id and a counter. */
  function newStamp() {
    return new Date().toISOString() + '/' + tabId + '/' + (++stampCount);
  }

  function conflictError() {
    var e = new Error(CONFLICT_MESSAGE);
    e.name = 'ConflictError';
    e.conflict = true;
    return e;
  }

  function stampOf(v) { return typeof v === 'string' ? v : ''; }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('IndexedDB is not available.')); return; }
      var req;
      try { req = root.indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed.')); };
      req.onblocked = function () { reject(new Error('IndexedDB is blocked by another tab.')); };
    });
  }

  /** Runs fn(store, tx) in one transaction; resolves with the result of the request fn returns (if any). */
  function idbRequest(mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
      var store = tx.objectStore(STORE);
      var result;
      var req = fn(store, tx);
      if (req) req.onsuccess = function () { result = req.result; };
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed.')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted.')); };
    });
  }

  /** Reads several keys in ONE transaction (a consistent snapshot). Resolves with their values. */
  function idbGetMany(keys) {
    var out = [];
    return idbRequest('readonly', function (s) {
      keys.forEach(function (k, i) {
        var r = s.get(k);
        r.onsuccess = function () { out[i] = r.result; };
      });
      return null;
    }).then(function () { return out; });
  }

  function lsAvailable() {
    try {
      var k = '__gt_probe__';
      root.localStorage.setItem(k, '1');
      root.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  function lsGet(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsRemoveCopy() {
    try {
      root.localStorage.removeItem(LS_KEY);
      root.localStorage.removeItem(LS_PREV);
      root.localStorage.removeItem(LS_BASE);
    } catch (e) { /* ignore */ }
  }

  /** Picks the best working backend. Resolves { backend }. */
  function init() {
    return openDb().then(function (d) {
      db = d;
      // Probe a write: some browsers expose IndexedDB on file:// but fail on use.
      return idbRequest('readwrite', function (s) { return s.put(Date.now(), '__probe__'); });
    }).then(function () {
      backend = 'indexeddb';
      return { backend: backend };
    }).catch(function () {
      db = null;
      backend = lsAvailable() ? 'localstorage' : 'memory';
      return { backend: backend };
    });
  }

  /** Parses one stored copy: null when empty, { value } when readable, { raw, message } when not. */
  function readCopy(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') return { value: v };
    try { return { value: JSON.parse(v) }; } catch (e) {
      return { raw: v, message: e && e.message ? e.message : String(e) };
    }
  }

  /** Picks what to load from the latest and the previous copy (raw stored values).
   * Returns null (nothing saved), { state, note } (note set when the latest copy was unreadable and the
   * previous one is used) or { unreadable: { raw, message } } when no copy can be read. */
  function choose(latestRaw, prevRaw) {
    var latest = readCopy(latestRaw);
    if (!latest) return null;
    if ('value' in latest) return { state: latest.value, note: null };
    var prev = readCopy(prevRaw);
    var bad = { raw: latest.raw, message: latest.message };
    if (prev && 'value' in prev) return { state: prev.value, note: bad };
    return { unreadable: bad };
  }

  function savedAt(st) {
    return st && st.meta && typeof st.meta.lastSavedAt === 'string' ? st.meta.lastSavedAt : '';
  }

  /** Turns a choice into load()'s result and remembers its note (see loadNote()). */
  function finish(c) {
    loadNote = c && c.note ? c.note : null;
    if (!c) return null;
    if (c.unreadable) return { unreadable: true, raw: c.unreadable.raw, message: c.unreadable.message };
    return c.state;
  }

  function lsChoose() {
    if (!lsAvailable()) return null;
    var latest = null, prev = null;
    try { latest = root.localStorage.getItem(LS_KEY); prev = root.localStorage.getItem(LS_PREV); } catch (e) { return null; }
    return choose(latest, prev);
  }

  /** The IndexedDB stamps the localStorage copy continues: null when it names none (a copy from a
   * localStorage-only session, or from an older version), else an array (empty when unreadable). */
  function lsBases() {
    var raw = lsGet(LS_BASE);
    if (raw === null) return null;
    try {
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (e) { return []; }
  }

  /** Loads the saved state. Resolves null (nothing saved), the state (a plain object), or
   * { unreadable: true, raw, message } when saved text exists but cannot be read (the caller must not
   * overwrite it). If only the latest copy is unreadable, the previous copy is loaded and loadNote()
   * describes the unreadable one. With IndexedDB, a newer localStorage copy (an emergency copy written when
   * the page went away, or a copy from a session where IndexedDB failed) wins over the IndexedDB copy, but
   * only while it continues the IndexedDB data: an emergency copy based on data that another tab has
   * replaced since is stale and ignored. Remembers the stored stamp for the next save's check. */
  function load() {
    loadNote = null;
    if (backend === 'indexeddb') {
      return idbGetMany(['state', 'state-prev', 'stamp']).then(function (r) {
        known = stampOf(r[2]);
        var fromIdb = choose(r[0], r[1]);
        var fromLs = lsChoose();
        var bases = lsBases();
        if (fromLs && fromLs.state && (bases === null || bases.indexOf(known) !== -1)) {
          if (!fromIdb) return finish(fromLs);
          if (fromIdb.unreadable) return finish({ state: fromLs.state, note: fromIdb.unreadable });
          if (savedAt(fromLs.state) > savedAt(fromIdb.state)) return finish({ state: fromLs.state, note: fromLs.note || fromIdb.note });
        }
        return finish(fromIdb);
      });
    }
    if (backend === 'localstorage') {
      known = stampOf(lsGet(LS_STAMP));
      return Promise.resolve(finish(lsChoose()));
    }
    return Promise.resolve(memory ? JSON.parse(memory) : null);
  }

  /** Saves the whole state (compare-and-swap on the save stamp). Keeps the previous save as a fallback
   * copy. Rejects with a conflict error (err.conflict) when another tab has saved since this tab loaded
   * or last saved; nothing is written then. */
  function save(state) {
    var json = JSON.stringify(state);
    var seq = ++saveSeq;
    var stamp = newStamp();
    if (backend === 'indexeddb') {
      var conflict = false;
      inflight.push(stamp);
      var settle = function () { inflight = inflight.filter(function (s) { return s !== stamp; }); };
      return idbRequest('readwrite', function (s, tx) {
        var getStamp = s.get('stamp');
        getStamp.onsuccess = function () {
          if (stampOf(getStamp.result) !== known) {
            conflict = true;
            try { tx.abort(); } catch (e) { /* already finishing */ }
            return;
          }
          var getReq = s.get('state');
          getReq.onsuccess = function () {
            if (getReq.result) s.put(getReq.result, 'state-prev');
            s.put(json, 'state');
            s.put(stamp, 'stamp');
          };
        };
        return null;
      }).then(function () {
        settle();
        known = stamp;
        // IndexedDB now holds everything the localStorage copy has: drop that copy so it cannot win later.
        // A copy written after this save took its data (saveSync while the save ran) is newer: keep it.
        if (lsCopy && seq > lsCopySeq) {
          lsCopy = false;
          lsRemoveCopy();
        }
      }, function (err) {
        settle();
        if (conflict) throw conflictError();
        // Fall back to localStorage if IndexedDB starts failing (quota, private mode). The stamp check
        // above passed, so this tab was up to date; its localStorage data continues the IndexedDB stamp.
        if (lsAvailable()) {
          backend = 'localstorage';
          fallbackBase = known;
          known = stampOf(lsGet(LS_STAMP));
          // An emergency copy written after this save took its data is newer: do not overwrite it.
          if (lsCopy && lsCopySeq > seq) return;
          lsWrite(json, stamp);
          return;
        }
        throw err;
      });
    }
    if (backend === 'localstorage') {
      // Synchronous, so the data is stored before this returns (also when the page is going away).
      try { lsWrite(json, stamp); } catch (e) { return Promise.reject(e); }
      return Promise.resolve();
    }
    memory = json;
    return Promise.resolve();
  }

  /** Emergency copy for a page that is being hidden or closed. An IndexedDB save is asynchronous and does
   * not commit if the page unloads first, so the state is also written synchronously to localStorage,
   * with the IndexedDB stamps it continues (the stored one and those of saves still running). load()
   * prefers this copy while it is newer (meta.lastSavedAt) and the IndexedDB stamp is still one of them,
   * and the next IndexedDB save that includes it removes it. With the localStorage backend this is a
   * normal (compare-and-swap) save, done synchronously. The memory backend keeps nothing. Returns true when
   * written, false when not (a full localStorage just means no copy); throws only a conflict error. */
  function saveSync(state) {
    if (backend === 'localstorage') {
      try {
        lsWrite(JSON.stringify(state), newStamp());
        return true;
      } catch (e) {
        if (e && e.conflict) throw e;
        return false;
      }
    }
    if (backend !== 'indexeddb') return false;
    try {
      var json = JSON.stringify(state);
      var ls = root.localStorage;
      // IndexedDB keeps the previous version; one copy here is enough (and halves the space needed).
      try { ls.removeItem(LS_PREV); } catch (e) { /* ignore */ }
      // The bases first: a copy must never be stored without them (it would then win as a legacy copy).
      ls.setItem(LS_BASE, JSON.stringify([known].concat(inflight)));
      try {
        ls.setItem(LS_KEY, json);
      } catch (e3) {
        lsRemoveCopy(); // an older copy must not stay behind with the new bases
        throw e3;
      }
    } catch (e2) {
      return false;
    }
    lsCopy = true;
    lsCopySeq = ++saveSeq;
    return true;
  }

  /** localStorage save (compare-and-swap on LS_STAMP). Throws a conflict error, or a quota error. */
  function lsWrite(json, stamp) {
    var ls = root.localStorage;
    if (stampOf(ls.getItem(LS_STAMP)) !== known) throw conflictError();
    // The stamp first: even if the data below does not fit, other tabs learn that it moved on.
    ls.setItem(LS_STAMP, stamp);
    known = stamp;
    var cur = ls.getItem(LS_KEY);
    try {
      if (cur) ls.setItem(LS_PREV, cur);
    } catch (e) {
      try { ls.removeItem(LS_PREV); } catch (e2) { /* ignore */ }
    }
    try {
      ls.setItem(LS_KEY, json);
    } catch (e3) {
      // Old copy + new copy may not fit although the new one alone does: drop the backup copy, retry once.
      try { ls.removeItem(LS_PREV); } catch (e4) { /* ignore */ }
      ls.setItem(LS_KEY, json); // throws on quota errors -> reported by the store
    }
    try {
      if (fallbackBase !== null) ls.setItem(LS_BASE, JSON.stringify([fallbackBase]));
      else ls.removeItem(LS_BASE);
    } catch (e5) { /* ignore */ }
  }

  /** Deletes every copy of the data kept by this app in this browser, and stores a new stamp, so a tab
   * that still shows the old data cannot save it back (its next save is a conflict). */
  function clear() {
    memory = null;
    var stamp = newStamp();
    var tasks = [];
    try {
      lsRemoveCopy();
      if (backend === 'localstorage') root.localStorage.setItem(LS_STAMP, stamp);
      else root.localStorage.removeItem(LS_STAMP);
    } catch (e) { /* ignore */ }
    if (backend !== 'indexeddb') known = stamp;
    if (db) {
      tasks.push(idbRequest('readwrite', function (s) {
        s.clear();
        return s.put(stamp, 'stamp');
      }).then(function () {
        if (backend === 'indexeddb') known = stamp;
      }).catch(function () { /* ignore */ }));
    }
    lsCopy = false;
    return Promise.all(tasks);
  }

  /** Resolves true when another tab has saved since this tab loaded or last saved (the stored stamp is
   * not this tab's). Never rejects (false when it cannot tell). */
  function isStale() {
    if (backend === 'indexeddb') {
      return idbGetMany(['stamp']).then(function (r) { return stampOf(r[0]) !== known; }, function () { return false; });
    }
    if (backend === 'localstorage') return Promise.resolve(stampOf(lsGet(LS_STAMP)) !== known);
    return Promise.resolve(false);
  }

  /** Asks the browser not to evict our storage under pressure (best effort; may be unsupported on file://). */
  function requestPersistence() {
    try {
      if (root.navigator && navigator.storage && navigator.storage.persist) {
        return navigator.storage.persisted().then(function (p) {
          return p ? true : navigator.storage.persist();
        }).catch(function () { return false; });
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(false);
  }

  GT.storage = {
    init: init,
    load: load,
    save: save,
    saveSync: saveSync,
    clear: clear,
    isStale: isStale,
    requestPersistence: requestPersistence,
    backend: function () { return backend; },
    /** The stamp of the data this tab loaded or last saved ('' when none was stored). */
    stamp: function () { return known; },
    /** After load(): { raw, message } for a latest copy that could not be read while an older one was loaded, else null. */
    loadNote: function () { return loadNote; },
    CONFLICT_MESSAGE: CONFLICT_MESSAGE
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
