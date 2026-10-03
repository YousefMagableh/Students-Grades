'use strict';
/* Tests for js/storage.js (DESIGN.md section 5): the compare-and-swap on the save stamp that keeps two
 * open tabs from overwriting each other, the emergency copy written when a page goes away, and delete-all.
 * storage.js is a browser classic script; here each "tab" runs it in its own vm context, and the tabs share
 * one fake IndexedDB and one fake localStorage (in memory, same semantics as far as storage.js uses them:
 * transactions run one at a time in creation order, a transaction's writes commit together or, when it
 * aborts, not at all). The last group runs the real store.js on top. Fake data only. */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('../js/core/util.js');
const model = require('../js/core/model.js');
const calc = require('../js/core/calc.js');
const history = require('../js/core/history.js');

const STORAGE_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');

// ---------------------------------------------------------------- fakes

/** An in-memory IndexedDB with one database: enough of the API for storage.js. */
function fakeIndexedDB() {
  const data = new Map();
  let created = false;
  let chain = Promise.resolve();
  const failures = []; // queued errors: the next readwrite transaction that writes fails with it (quota)

  function transaction(_name, mode) {
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
    const pending = [];
    const writes = [];
    let aborted = false;
    const view = () => {
      const m = new Map(data);
      writes.forEach(([op, k, v]) => { if (op === 'put') m.set(k, v); else m.clear(); });
      return m;
    };
    const request = (fn) => {
      const r = { onsuccess: null, result: undefined };
      pending.push(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); });
      return r;
    };
    tx.objectStore = () => ({
      get: (k) => request(() => view().get(k)),
      put: (v, k) => request(() => { if (mode !== 'readwrite') throw new Error('readonly'); writes.push(['put', k, v]); }),
      clear: () => request(() => { writes.push(['clear']); })
    });
    tx.abort = () => { aborted = true; };
    chain = chain.then(() => new Promise((resolve) => {
      setTimeout(() => {
        while (pending.length && !aborted) pending.shift()();
        if (!aborted && writes.length && failures.length) {
          tx.error = failures.shift();
          if (tx.onerror) tx.onerror();
          resolve();
          return;
        }
        if (aborted) { if (tx.onabort) tx.onabort(); resolve(); return; }
        writes.forEach(([op, k, v]) => { if (op === 'put') data.set(k, v); else data.clear(); });
        if (tx.oncomplete) tx.oncomplete();
        resolve();
      }, 0);
    }));
    return tx;
  }

  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => { created = true; },
    transaction
  };
  return {
    data,
    failNextWrite(err) { failures.push(err); },
    open() {
      const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        if (!created && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}

/** A shared localStorage (Storage-like) over one Map. */
function fakeLocalStorage(map) {
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] || null
  };
}

/** A browser profile: one IndexedDB (unless idb is false) and one localStorage, shared by its tabs. */
function profile(opts = {}) {
  return { idb: opts.idb === false ? undefined : fakeIndexedDB(), ls: new Map() };
}

/** Opens a "tab": storage.js (and, with withStore, store.js) in a new vm context of the profile. */
async function openTab(prof, withStore) {
  const ctx = {
    console, setTimeout, clearTimeout, navigator: {},
    localStorage: fakeLocalStorage(prof.ls),
    GT: { util, model, calc, history }
  };
  if (prof.idb) ctx.indexedDB = prof.idb;
  vm.createContext(ctx);
  vm.runInContext(STORAGE_SRC, ctx, { filename: 'storage.js' });
  if (withStore) vm.runInContext(STORE_SRC, ctx, { filename: 'store.js' });
  const info = await ctx.GT.storage.init();
  const loaded = await ctx.GT.storage.load();
  return { GT: ctx.GT, storage: ctx.GT.storage, store: ctx.GT.store, info, loaded };
}

function doc(label, extra) {
  return Object.assign({ app: 'grade-tracker', label, meta: { lastSavedAt: new Date().toISOString() } }, extra || {});
}
async function storedLabel(prof) {
  const t = await openTab(prof);
  return t.loaded ? t.loaded.label : null;
}
async function rejectsWithConflict(p) {
  await assert.rejects(p, (e) => e.conflict === true && /another tab/.test(e.message));
}

// ---------------------------------------------------------------- IndexedDB backend

describe('IndexedDB: a save is a compare-and-swap on the save stamp', () => {
  test('a stale tab cannot overwrite what another tab saved; nothing of it is written', async () => {
    const prof = profile();
    const a = await openTab(prof);
    assert.equal(a.info.backend, 'indexeddb');
    assert.equal(a.loaded, null);
    await a.storage.save(doc('v1'));
    const b = await openTab(prof);
    assert.equal(b.loaded.label, 'v1');
    assert.equal(b.storage.stamp(), a.storage.stamp());
    await b.storage.save(doc('B edit'));
    assert.equal(await a.storage.isStale(), true);
    assert.equal(await b.storage.isStale(), false);
    const prevBefore = prof.idb.data.get('state-prev');
    await rejectsWithConflict(a.storage.save(doc('A stale edit')));
    assert.equal(await storedLabel(prof), 'B edit');
    assert.equal(prof.idb.data.get('state-prev'), prevBefore, 'the fallback copy is untouched too');
    // B keeps saving normally; A stays rejected (it never learns a newer stamp by failing).
    await b.storage.save(doc('B again'));
    await rejectsWithConflict(a.storage.save(doc('A retry')));
    assert.equal(await storedLabel(prof), 'B again');
  });

  test('each save keeps the previous one as state-prev and stores a new, unique stamp', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('one'));
    const s1 = prof.idb.data.get('stamp');
    await a.storage.save(doc('two'));
    const s2 = prof.idb.data.get('stamp');
    assert.ok(s1 && s2 && s1 !== s2);
    assert.equal(a.storage.stamp(), s2);
    assert.equal(JSON.parse(prof.idb.data.get('state-prev')).label, 'one');
    assert.equal(JSON.parse(prof.idb.data.get('state')).label, 'two');
  });

  test('data saved by an older version (no stamp yet) is taken over by the first save', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('x'));
    prof.idb.data.set('state', JSON.stringify(doc('old version')));
    prof.idb.data.delete('stamp');
    const b = await openTab(prof);
    assert.equal(b.loaded.label, 'old version');
    assert.equal(b.storage.stamp(), '');
    await b.storage.save(doc('new version'));
    assert.equal(await storedLabel(prof), 'new version');
  });

  test('delete all stores a new stamp: a stale tab cannot bring the deleted data back', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('59 students'));
    const b = await openTab(prof);
    await a.storage.clear();
    assert.equal(prof.idb.data.has('state'), false);
    assert.ok(prof.idb.data.get('stamp'), 'a stamp remains');
    await rejectsWithConflict(b.storage.save(doc('59 students, theme changed')));
    assert.equal(await storedLabel(prof), null);
    await a.storage.save(doc('empty courses'));
    assert.equal(await storedLabel(prof), 'empty courses');
    await rejectsWithConflict(b.storage.save(doc('59 students again')));
    assert.equal(await storedLabel(prof), 'empty courses');
  });

  test('isStale is false for the tab that saved last and true for the others', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('a'));
    const b = await openTab(prof);
    assert.equal(await a.storage.isStale(), false);
    assert.equal(await b.storage.isStale(), false);
    await a.storage.save(doc('a2'));
    assert.equal(await a.storage.isStale(), false);
    assert.equal(await b.storage.isStale(), true);
  });
});

describe('IndexedDB: the emergency copy (saveSync) when a page goes away', () => {
  test('wins on the next load while it continues the stored data, then the next save removes it', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('saved'));
    assert.equal(a.storage.saveSync(doc('last moment')), true);
    const base = JSON.parse(prof.ls.get('grade-tracker:state-base'));
    assert.deepEqual(base, [a.storage.stamp()]);
    const b = await openTab(prof);
    assert.equal(b.loaded.label, 'last moment');
    await b.storage.save(doc('saved by b'));
    assert.equal(prof.ls.has('grade-tracker:state'), false);
    assert.equal(prof.ls.has('grade-tracker:state-base'), false);
    assert.equal((await openTab(prof)).loaded.label, 'saved by b');
  });

  test('a save still running when the copy is written may commit: its stamp is a valid base too', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('saved'));
    const running = a.storage.save(Object.assign(doc('older, still saving'), { meta: { lastSavedAt: '2026-01-01T00:00:00.000Z' } }));
    assert.equal(a.storage.saveSync(doc('newest')), true);
    assert.equal(JSON.parse(prof.ls.get('grade-tracker:state-base')).length, 2);
    await running; // it commits (the page did not go away fast enough to stop it)
    assert.equal((await openTab(prof)).loaded.label, 'newest');
  });

  test('a copy written by a stale tab is ignored: the other tab\'s saved data wins', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('v1'));
    const b = await openTab(prof);
    await b.storage.save(doc('B saved'));
    assert.equal(a.storage.saveSync(doc('A unsaved (stale)')), true);
    const c = await openTab(prof);
    assert.equal(c.loaded.label, 'B saved');
    await c.storage.save(doc('C saved'));
    assert.equal(prof.ls.has('grade-tracker:state'), false, 'the stale copy is removed by the next save');
  });

  test('a copy without bases (localStorage-only session, older version) still wins while it is newer', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('idb', { meta: { lastSavedAt: '2026-10-01T00:00:00.000Z' } }));
    prof.ls.set('grade-tracker:state', JSON.stringify(doc('ls newer', { meta: { lastSavedAt: '2026-10-02T00:00:00.000Z' } })));
    assert.equal((await openTab(prof)).loaded.label, 'ls newer');
    prof.ls.set('grade-tracker:state', JSON.stringify(doc('ls older', { meta: { lastSavedAt: '2026-09-30T00:00:00.000Z' } })));
    assert.equal((await openTab(prof)).loaded.label, 'idb');
  });
});

describe('IndexedDB failing mid-session: localStorage takes over', () => {
  test('the data goes to localStorage, continues the IndexedDB stamp, and a stale copy loses later', async () => {
    const prof = profile();
    const a = await openTab(prof);
    await a.storage.save(doc('in idb'));
    prof.idb.failNextWrite(new Error('QuotaExceededError'));
    await a.storage.save(doc('in ls'));
    assert.equal(a.storage.backend(), 'localstorage');
    assert.equal(JSON.parse(prof.ls.get('grade-tracker:state')).label, 'in ls');
    assert.deepEqual(JSON.parse(prof.ls.get('grade-tracker:state-base')), [prof.idb.data.get('stamp')]);
    // Next session, IndexedDB works again: the localStorage data continues it and is newer, so it wins.
    const b = await openTab(prof);
    assert.equal(b.info.backend, 'indexeddb');
    assert.equal(b.loaded.label, 'in ls');
    await b.storage.save(doc('back in idb'));
    // The tab that fell back is now stale in its own (localStorage) domain as well.
    assert.equal(prof.ls.has('grade-tracker:state'), false);
  });
});

// ---------------------------------------------------------------- localStorage backend

describe('localStorage backend: the same compare-and-swap on grade-tracker:stamp', () => {
  test('a stale tab is rejected by save and by saveSync; delete all stores a new stamp', async () => {
    const prof = profile({ idb: false });
    const a = await openTab(prof);
    assert.equal(a.info.backend, 'localstorage');
    await a.storage.save(doc('v1'));
    const b = await openTab(prof);
    assert.equal(b.loaded.label, 'v1');
    await b.storage.save(doc('B'));
    await rejectsWithConflict(a.storage.save(doc('A stale')));
    assert.throws(() => a.storage.saveSync(doc('A stale, leaving')), (e) => e.conflict === true);
    assert.equal(await storedLabel(prof), 'B');
    assert.equal(await a.storage.isStale(), true);
    // saveSync is a full save here (the up-to-date tab).
    assert.equal(b.storage.saveSync(doc('B leaving')), true);
    assert.equal(await storedLabel(prof), 'B leaving');
    // Delete all from B; a tab that loaded before cannot write the old data back.
    const c = await openTab(prof);
    await b.storage.clear();
    assert.equal(prof.ls.has('grade-tracker:state'), false);
    await rejectsWithConflict(c.storage.save(doc('resurrected')));
    await b.storage.save(doc('fresh'));
    assert.equal(await storedLabel(prof), 'fresh');
  });

  test('a save is synchronous: the data is stored before save() returns', () => {
    const prof = profile({ idb: false });
    return openTab(prof).then((a) => {
      a.storage.save(doc('now'));
      assert.equal(JSON.parse(prof.ls.get('grade-tracker:state')).label, 'now');
    });
  });
});

// ---------------------------------------------------------------- store.js + storage.js, two tabs

describe('two tabs with the real store: the stale one goes read-only and never overwrites', () => {
  async function bootTab(prof) {
    const t = await openTab(prof, true);
    const st = t.loaded ? model.normalizeState(t.loaded) : model.createDefaultState();
    t.store.init(st, t.info.backend);
    if (!t.loaded) await t.store.saveNow();
    return t;
  }
  function score(c, i) { const e = model.getEntry(c.scores, c.students[i].id, 'a_t1'); return e ? e.value : null; }

  test('an edit in the stale tab: conflict, read-only, the newer data stays; a UI click does the same', async () => {
    const prof = profile();
    const a = await bootTab(prof);
    a.store.transact('Load sample data', (c) => { for (let i = 0; i < 3; i++) c.students.push(model.createStudent({ no: i + 1, lastName: 'Student 0' + (i + 1) })); }, { historyMode: 'bulk' });
    await a.store.flush();
    const b = await bootTab(prof);
    b.store.transact('B edit', (c) => model.setEntry(c.scores, c.students[1].id, 'a_t1', { value: 22 }));
    await b.store.flush();
    assert.equal(b.store.saveStatus().phase, 'saved');
    // A (stale) edits: the save is refused, A becomes read-only.
    a.store.transact('A edit', (c) => model.setEntry(c.scores, c.students[0].id, 'a_t1', { value: 11 }));
    await a.store.flush();
    assert.equal(a.store.saveStatus().phase, 'conflict');
    assert.equal(a.store.readOnly(), true);
    assert.equal(a.store.hasUnsavedData(), true);
    assert.throws(() => a.store.transact('A again', (c) => { c.title = 'x'; }), (e) => e.conflict === true);
    const fresh = await bootTab(prof);
    assert.equal(score(fresh.store.course(), 1), 22);
    assert.equal(score(fresh.store.course(), 0), null, 'the stale edit was never written');
    assert.ok(fresh.store.course().history.some((h) => h.newValue === '22'));

    // A UI-only change in another stale tab (C loaded before B's second save) fails the same way.
    const c = await bootTab(prof);
    b.store.transact('B edit 2', (co) => model.setEntry(co.scores, co.students[2].id, 'a_t1', { value: 33 }));
    await b.store.flush();
    c.store.setUi({ privacy: true });
    await c.store.flush();
    assert.equal(c.store.saveStatus().phase, 'conflict');
    const after = await bootTab(prof);
    assert.equal(score(after.store.course(), 2), 33);
    assert.equal(after.store.state.ui.privacy, false);
  });

  test('checkConflict (another tab said it saved) makes a stale tab read-only before it tries to save', async () => {
    const prof = profile();
    const a = await bootTab(prof);
    const b = await bootTab(prof);
    assert.equal(await a.store.checkConflict(), false);
    b.store.setUi({ theme: 'dark' });
    await b.store.flush();
    assert.equal(await a.store.checkConflict(), true);
    assert.equal(a.store.saveStatus().phase, 'conflict');
    assert.equal(await b.store.checkConflict(), false);
  });

  test('delete all in one tab, then any action in the other: the deleted data does not come back', async () => {
    const prof = profile();
    const a = await bootTab(prof);
    a.store.transact('Load', (c) => { c.students.push(model.createStudent({ no: 1, lastName: 'Student 01' })); }, { historyMode: 'bulk' });
    await a.store.flush();
    const b = await bootTab(prof);
    assert.equal(b.store.course().students.length, 1);
    await a.store.clearAll(model.createDefaultState(), 'delete-all');
    await a.store.flush();
    b.store.setUi({ theme: 'dark' });
    await b.store.flush();
    assert.equal(b.store.saveStatus().phase, 'conflict');
    const fresh = await bootTab(prof);
    assert.equal(fresh.store.course().students.length, 0);
    assert.equal(fresh.store.state.ui.theme, 'system');
  });
});
