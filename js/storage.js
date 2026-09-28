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

  /** Loads the saved state (a plain object) or null. Falls back to the previous copy if the latest is unreadable. */
  function load() {
    if (backend === 'indexeddb') {
      return idbRequest('readonly', function (s) { return s.get('state'); }).then(function (v) {
        if (v) return typeof v === 'string' ? JSON.parse(v) : v;
        // Data saved earlier via localStorage (e.g. IndexedDB became available later).
        return lsAvailable() ? lsLoad() : null;
      }).catch(function () {
        return idbRequest('readonly', function (s) { return s.get('state-prev'); }).then(function (v) {
          return v ? (typeof v === 'string' ? JSON.parse(v) : v) : null;
        });
      });
    }
    if (backend === 'localstorage') return Promise.resolve(lsLoad());
    return Promise.resolve(memory ? JSON.parse(memory) : null);
  }

  function lsLoad() {
    var raw = null;
    try { raw = root.localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e2) {
      try {
        var prev = root.localStorage.getItem(LS_PREV);
        return prev ? JSON.parse(prev) : null;
      } catch (e3) { return null; }
    }
  }

  /** Saves the whole state. Keeps the previous save as a fallback copy. */
  function save(state) {
    var json = JSON.stringify(state);
    if (backend === 'indexeddb') {
      return idbRequest('readwrite', function (s) {
        var getReq = s.get('state');
        getReq.onsuccess = function () {
          if (getReq.result) s.put(getReq.result, 'state-prev');
          s.put(json, 'state');
        };
        return null;
      }).catch(function (err) {
        // Fall back to localStorage if IndexedDB starts failing (quota, private mode).
        if (lsAvailable()) {
          backend = 'localstorage';
          return lsSave(json);
        }
        throw err;
      });
    }
    if (backend === 'localstorage') return Promise.resolve().then(function () { return lsSave(json); });
    memory = json;
    return Promise.resolve();
  }

  function lsSave(json) {
    var ls = root.localStorage;
    var cur = ls.getItem(LS_KEY);
    try {
      if (cur) ls.setItem(LS_PREV, cur);
    } catch (e) {
      try { ls.removeItem(LS_PREV); } catch (e2) { /* ignore */ }
    }
    ls.setItem(LS_KEY, json); // throws on quota errors -> reported by the store
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
    clear: clear,
    requestPersistence: requestPersistence,
    backend: function () { return backend; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
