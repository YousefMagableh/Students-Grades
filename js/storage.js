/* Grade Tracker - local persistence (R3). IndexedDB first, then localStorage, then memory only.
 * Nothing is sent anywhere; data stays in this browser profile on this computer. Attaches GT.storage. */
(function (root) {
  'use strict';
  var GT = root.GT;

  var DB_NAME = 'grade-tracker';
  var STORE = 'kv';
  var LS_KEY = 'grade-tracker:state';
  var LS_PREV = 'grade-tracker:state-prev';

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

  function idbRequest(mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
      var store = tx.objectStore(STORE);
      var result;
      var req = fn(store);
      if (req) req.onsuccess = function () { result = req.result; };
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed.')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted.')); };
    });
  }

  function lsAvailable() {
    try {
      var k = '__gt_probe__';
      root.localStorage.setItem(k, '1');
      root.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
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

  function idbGet(key) {
    return idbRequest('readonly', function (s) { return s.get(key); });
  }

  /** Loads the saved state. Resolves null (nothing saved), the state (a plain object), or
   * { unreadable: true, raw, message } when saved text exists but cannot be read (the caller must not
   * overwrite it). If only the latest copy is unreadable, the previous copy is loaded and loadNote()
   * describes the unreadable one. With IndexedDB, a newer localStorage copy (written after an IndexedDB
   * failure in an earlier session) wins over the IndexedDB copy. */
  function load() {
    loadNote = null;
    if (backend === 'indexeddb') {
      return Promise.all([idbGet('state'), idbGet('state-prev')]).then(function (r) {
        var fromIdb = choose(r[0], r[1]);
        var fromLs = lsChoose();
        if (fromLs && fromLs.state) {
          if (!fromIdb) return finish(fromLs);
          if (fromIdb.unreadable) return finish({ state: fromLs.state, note: fromIdb.unreadable });
          if (savedAt(fromLs.state) > savedAt(fromIdb.state)) return finish({ state: fromLs.state, note: fromLs.note || fromIdb.note });
        }
        return finish(fromIdb);
      });
    }
    if (backend === 'localstorage') return Promise.resolve(finish(lsChoose()));
    return Promise.resolve(memory ? JSON.parse(memory) : null);
  }

  /** Saves the whole state. Keeps the previous save as a fallback copy. */
  function save(state) {
    var json = JSON.stringify(state);
    var seq = ++saveSeq;
    if (backend === 'indexeddb') {
      return idbRequest('readwrite', function (s) {
        var getReq = s.get('state');
        getReq.onsuccess = function () {
          if (getReq.result) s.put(getReq.result, 'state-prev');
          s.put(json, 'state');
        };
        return null;
      }).then(function () {
        // IndexedDB now holds everything the localStorage copy has: drop that copy so it cannot win later.
        // A copy written after this save took its data (saveSync while the save ran) is newer: keep it.
        if (lsCopy && seq > lsCopySeq) {
          lsCopy = false;
          try { root.localStorage.removeItem(LS_KEY); root.localStorage.removeItem(LS_PREV); } catch (e) { /* ignore */ }
        }
      }).catch(function (err) {
        // Fall back to localStorage if IndexedDB starts failing (quota, private mode).
        if (lsAvailable()) {
          backend = 'localstorage';
          // An emergency copy written after this save took its data is newer: do not overwrite it.
          if (lsCopy && lsCopySeq > seq) return;
          return lsSave(json);
        }
        throw err;
      });
    }
    if (backend === 'localstorage') return Promise.resolve().then(function () { return lsSave(json); });
    memory = json;
    return Promise.resolve();
  }

  /** Emergency copy for a page that is being hidden or closed. An IndexedDB save is asynchronous and does
   * not commit if the page unloads first, so the state is also written synchronously to localStorage.
   * load() prefers this copy while it is newer (meta.lastSavedAt) than the IndexedDB copy, and the next
   * IndexedDB save that includes it removes it. Only for the IndexedDB backend: a localStorage save already
   * completes before the page goes away, and the memory backend keeps nothing. Returns true when written;
   * never throws (a full localStorage just means no emergency copy). */
  function saveSync(state) {
    if (backend !== 'indexeddb') return false;
    try {
      var json = JSON.stringify(state);
      var ls = root.localStorage;
      // IndexedDB keeps the previous version; one copy here is enough (and halves the space needed).
      try { ls.removeItem(LS_PREV); } catch (e) { /* ignore */ }
      ls.setItem(LS_KEY, json);
    } catch (e2) {
      return false;
    }
    lsCopy = true;
    lsCopySeq = ++saveSeq;
    return true;
  }

  function lsSave(json) {
    var ls = root.localStorage;
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
  }

  /** Deletes every copy of the data kept by this app in this browser. */
  function clear() {
    memory = null;
    var tasks = [];
    try { root.localStorage.removeItem(LS_KEY); root.localStorage.removeItem(LS_PREV); } catch (e) { /* ignore */ }
    if (db) {
      tasks.push(idbRequest('readwrite', function (s) { return s.clear(); }).catch(function () { /* ignore */ }));
    }
    return Promise.all(tasks);
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
    requestPersistence: requestPersistence,
    backend: function () { return backend; },
    /** After load(): { raw, message } for a latest copy that could not be read while an older one was loaded, else null. */
    loadNote: function () { return loadNote; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
