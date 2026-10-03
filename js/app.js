/* Grade Tracker - boot, app shell (header, tabs, banners, status bar), course management and data actions.
 * Browser only. Views register themselves in GT.views (see docs/DESIGN.md section 6). */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model, ui = GT.ui, store = GT.store;
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  /** Tab order. Views that are not loaded (not registered) are skipped. */
  var VIEW_ORDER = [
    { id: 'grades', title: 'Grades', icon: 'grid' },
    { id: 'students', title: 'Students & Teams', icon: 'users' },
    { id: 'attendance', title: 'Attendance', icon: 'calendar' },
    { id: 'stats', title: 'Statistics', icon: 'chart' },
    { id: 'settings', title: 'Settings', icon: 'settings' },
    { id: 'history', title: 'History', icon: 'history' },
    { id: 'exchange', title: 'Import / Export', icon: 'file' },
    { id: 'summary', title: 'Summary', icon: 'print' }
  ];

  var BACKUP_REMINDER_DAYS = 7;
  var VERSION = '1.0.0';     // also in package.json
  var app = GT.app = {};
  app.VERSION = VERSION;
  var viewContainer = null;
  var currentViewId = null;
  var viewParams = {};
  var renderQueued = false;
  var dismissed = {};
  var otherTabs = Object.create(null); // ids of the other open tabs that said hello (BroadcastChannel)
  var tabId = util.uid('tab');
  var channel = null;
  var leaveHooks = [];    // GT.app.registerLeaveHook: commit pending edits before the page goes away
  var reloading = false;  // the conflict banner's Reload: no "leave the page?" prompt
  var lastActiveTab = null;
  var loadProblem = null; // { raw, message } when saved data could not be read (saving is blocked)
  var recovered = null;   // { raw, message } when the latest autosave was unreadable and an older copy was loaded
  var regionHtml = {};    // last markup written to each shell region (see setRegionHtml)
  var persisted = false;

  // ------------------------------------------------------------------ helpers

  /** A registered view (own property only: a stored "constructor" or "toString" is never a view). */
  function viewOf(id) {
    return typeof id === 'string' && util.hasOwn(GT.views, id) && GT.views[id] && typeof GT.views[id].render === 'function'
      ? GT.views[id] : null;
  }

  function activeViews() {
    return VIEW_ORDER.filter(function (v) { return !!viewOf(v.id); });
  }

  function otherTabOpen() { return Object.keys(otherTabs).length > 0; }

  /** While another tab has saved newer data, nothing can be changed here: says so and returns true. */
  function refuseReadOnly() {
    if (!(store.readOnly && store.readOnly())) return false;
    conflictToast();
    return true;
  }

  var lastConflictToast = 0;
  function conflictToast() {
    var now = Date.now();
    if (now - lastConflictToast < 1500) return;
    lastConflictToast = now;
    ui.toast('Not saved: Grade Tracker was changed in another tab, so this tab is read-only. Reload to see the latest data.', { type: 'warn' });
  }

  function hasAnyData() {
    return store.state.courses.some(function (c) { return c.students.length > 0; });
  }

  function backupAgeDays() {
    var last = store.state.meta.lastBackupAt;
    if (!last) return null;
    return util.daysBetween(last, new Date().toISOString());
  }

  app.navigate = function (viewId, params) {
    if (!viewOf(viewId)) return;
    viewParams = params || {};
    if (store.state.ui.activeView !== viewId) store.setUi({ activeView: viewId });
    else requestRender();
  };

  app.params = function () { return viewParams; };

  /** Selector that finds the "same" control after its region is rebuilt, from its data-* identity. */
  function focusSelector(el) {
    var sel = el.tagName.toLowerCase(), any = false;
    ['data-view', 'data-act', 'data-key', 'data-src'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (v !== null) { sel += '[' + a + '="' + v.replace(/["\\]/g, '\\$&') + '"]'; any = true; }
    });
    return any ? sel : null;
  }

  /** Writes a shell region (tabs, banners, status bar) only when its markup changed: the store notifies on
   * every edit and again after every autosave. When it does change, keyboard focus moves to the matching
   * control in the new markup (or the region's first control, or the view), so it never drops to <body>. */
  function setRegionHtml(host, html) {
    if (regionHtml[host.id] === html) return;
    var ae = document.activeElement;
    var had = !!ae && ae !== host && host.contains(ae);
    var sel = had ? focusSelector(ae) : null;
    host.innerHTML = html;
    regionHtml[host.id] = html;
    if (!had) return;
    var next = (sel && host.querySelector(sel)) || host.querySelector('[aria-selected="true"], button') || document.getElementById('view');
    if (next) { try { next.focus({ preventScroll: true }); } catch (e) { next.focus(); } }
  }

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    (root.requestAnimationFrame || setTimeout)(function () {
      renderQueued = false;
      renderAll();
    });
  }
  app.render = requestRender;

  // ------------------------------------------------------------------ header

  function renderHeader() {
    var st = store.state;
    var c = store.course();
    var sel = document.getElementById('course-select');
    sel.innerHTML = st.courses.map(function (co) {
      return '<option value="' + esc(co.id) + '"' + (c && co.id === c.id ? ' selected' : '') + '>' + esc(model.courseLabel(co)) + '</option>';
    }).join('');
    sel.disabled = st.courses.length === 0;

    var undoBtn = document.getElementById('btn-undo');
    var redoBtn = document.getElementById('btn-redo');
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    undoBtn.title = store.canUndo() ? 'Undo "' + store.undoLabel() + '" (Ctrl+Z)' : 'Nothing to undo';
    redoBtn.title = store.canRedo() ? 'Redo "' + store.redoLabel() + '" (Ctrl+Y)' : 'Nothing to redo';

    var priv = document.getElementById('btn-privacy');
    priv.setAttribute('aria-pressed', st.ui.privacy ? 'true' : 'false');
    priv.innerHTML = ui.icon(st.ui.privacy ? 'eye-off' : 'eye') + '<span class="label">Privacy</span>';
    priv.title = st.ui.privacy ? 'Privacy mode is on: names are blurred (click a name to reveal it)' : 'Blur student names (privacy mode)';
    priv.setAttribute('aria-label', 'Privacy'); // the text label is hidden on phones
    document.body.classList.toggle('privacy-on', !!st.ui.privacy);

    var themeBtn = document.getElementById('btn-theme');
    var themeIcon = st.ui.theme === 'dark' ? 'moon' : st.ui.theme === 'light' ? 'sun' : 'monitor';
    themeBtn.innerHTML = ui.icon(themeIcon);
    themeBtn.title = 'Theme: ' + st.ui.theme;
    themeBtn.setAttribute('aria-label', 'Theme: ' + st.ui.theme);
    document.documentElement.setAttribute('data-theme', st.ui.theme);

    var chip = document.getElementById('backup-chip');
    var age = backupAgeDays();
    var stale = hasAnyData() && (age === null || age > BACKUP_REMINDER_DAYS);
    chip.className = 'btn btn-sm ' + (stale ? 'btn-backup-stale' : 'btn-ghost');
    var chipText = st.meta.lastBackupAt ? 'Backup: ' + ui.relativeTime(st.meta.lastBackupAt) : 'No backup yet';
    chip.innerHTML = ui.icon(stale ? 'alert' : 'save') + '<span class="label">' + (st.meta.lastBackupAt
      ? '<span class="label-prefix">Backup: </span>' + esc(ui.relativeTime(st.meta.lastBackupAt)) : 'No backup yet') + '</span>';
    chip.setAttribute('aria-label', chipText);
    chip.title = st.meta.lastBackupAt
      ? 'Last backup: ' + ui.dateTime(st.meta.lastBackupAt) + '. Click to download a new backup.'
      : 'No backup has been downloaded yet. Click to download one.';
  }

  function renderTabs() {
    var nav = document.getElementById('tabs');
    var active = store.state.ui.activeView;
    var views = activeViews();
    if (!views.some(function (v) { return v.id === active; }) && views.length) active = views[0].id;
    var c = store.course();
    var pending = c ? model.unconfirmedPlaceholders(c).length : 0;
    setRegionHtml(nav, views.map(function (v) {
      var count = v.id === 'settings' && pending ? '<span class="count" title="' + pending + ' placeholder settings need confirmation">' + pending + '</span>' : '';
      return '<button class="tab" role="tab" type="button" id="tab-' + v.id + '" data-view="' + v.id + '" aria-controls="view" aria-selected="' +
        (v.id === active ? 'true' : 'false') + '" tabindex="' + (v.id === active ? '0' : '-1') + '">' + ui.icon(v.icon) + '<span>' + esc(v.title) + '</span>' + count + '</button>';
    }).join(''));
    if (active !== lastActiveTab) {
      lastActiveTab = active;
      revealActiveTab(nav);
    }
    return active;
  }

  /** On a narrow screen the tab strip scrolls sideways: keep the active tab fully in view. Only the strip
   * scrolls (never the page, as scrollIntoView could). */
  function revealActiveTab(nav) {
    var t = nav.querySelector('.tab[aria-selected="true"]');
    if (!t || nav.scrollWidth <= nav.clientWidth) return;
    var nr = nav.getBoundingClientRect(), tr = t.getBoundingClientRect();
    if (tr.left < nr.left) nav.scrollLeft -= Math.ceil(nr.left - tr.left) + 8;
    else if (tr.right > nr.right) nav.scrollLeft += Math.ceil(tr.right - nr.right) + 8;
  }

  // ------------------------------------------------------------------ banners

  function renderBanners() {
    var host = document.getElementById('banners');
    var out = [];
    var st = store.state;
    var status = store.saveStatus();
    var c = store.course();

    if (status.phase === 'conflict') {
      out.push(banner('danger', 'alert',
        '<strong>Grade Tracker was changed in another tab.</strong> This tab is out of date, so it is read-only and nothing here is saved. ' +
        'Reload to see the latest data (download a backup of this tab first if you want to keep its changes).',
        '<button class="btn btn-sm btn-primary" data-act="reload">Reload</button>' +
        '<button class="btn btn-sm" data-act="backup" title="Downloads a backup file of the data this tab shows">Download this tab\u2019s data</button>'));
    }
    if (loadProblem) {
      out.push(banner('danger', 'alert',
        '<strong>Saved data could not be read</strong> (' + esc(loadProblem.message) + '). Nothing has been overwritten, and changes you make now are not saved. ' +
        'Download it, then restore it or start fresh.',
        '<button class="btn btn-sm" data-act="download-raw">Download saved data</button><button class="btn btn-sm btn-danger" data-act="start-fresh">Start fresh</button>'));
    }
    if (recovered && !dismissed.recovered) {
      out.push(banner('warn', 'alert',
        '<strong>The latest autosave could not be read</strong> (' + esc(recovered.message) + '). The previous saved copy was loaded instead, so your most recent change may be missing. Check it, and keep the unreadable copy if you may need it.',
        '<button class="btn btn-sm" data-act="download-raw" data-src="recovered">Download unreadable copy</button><button class="btn btn-sm btn-ghost" data-act="dismiss" data-key="recovered">Dismiss</button>'));
    }
    if (status.backend === 'memory') {
      out.push(banner('danger', 'alert',
        '<strong>This browser does not allow saving here.</strong> Changes are kept only until this tab closes. Download a backup to keep your work.',
        '<button class="btn btn-sm" data-act="backup">Download backup</button>'));
    } else if (status.phase === 'error' && !loadProblem) {
      out.push(banner('danger', 'alert', '<strong>Could not save to browser storage:</strong> ' + esc(status.error || 'unknown error') + '. Download a backup now.',
        '<button class="btn btn-sm" data-act="backup">Download backup</button>'));
    }
    if (otherTabOpen() && !dismissed.tabs && status.phase !== 'conflict') {
      out.push(banner('warn', 'info', 'Grade Tracker is also open in another tab or window. Work in one of them: once the other tab saves a change, ' +
        'this one becomes read-only until you reload it.',
        '<button class="btn btn-sm btn-ghost" data-act="dismiss" data-key="tabs">Dismiss</button>'));
    }
    var age = backupAgeDays();
    if (hasAnyData() && !dismissed.backup && (age === null || age > BACKUP_REMINDER_DAYS)) {
      var msg = age === null
        ? '<strong>No backup yet.</strong> Browser storage can be cleared (for example by clearing site data), so download a backup regularly.'
        : '<strong>Your last backup was ' + esc(ui.relativeTime(st.meta.lastBackupAt)) + '.</strong> Download a new backup to protect recent changes.';
      out.push(banner('warn', 'save', msg,
        '<button class="btn btn-sm btn-primary" data-act="backup">Back up now</button><button class="btn btn-sm btn-ghost" data-act="dismiss" data-key="backup">Later</button>'));
    }
    if (c) {
      var w = GT.calc.weightStatus(c);
      if (!w.ok) {
        out.push(banner('warn', 'alert',
          '<strong>Weights in ' + esc(c.code) + ' add up to ' + esc(util.formatNumber(w.sum, 2)) + '%, not 100%.</strong> Totals use the weights as entered.',
          GT.views.settings ? '<button class="btn btn-sm" data-act="goto" data-view="settings" data-section="assessments">Fix in Settings</button>' : ''));
      }
    }
    setRegionHtml(host, out.join(''));
  }

  function banner(kind, icon, html, actions) {
    return '<div class="banner banner-' + kind + '" role="' + (kind === 'danger' ? 'alert' : 'status') + '">' + ui.icon(icon) +
      '<div class="banner-text">' + html + '</div>' + (actions ? '<div class="row">' + actions + '</div>' : '') + '</div>';
  }

  // ------------------------------------------------------------------ status bar

  function renderStatus() {
    var el = document.getElementById('statusbar');
    var s = store.saveStatus();
    var backendLabel = s.backend === 'indexeddb' ? 'IndexedDB' : s.backend === 'localstorage' ? 'localStorage' : 'memory only (not saved)';
    var dot = s.phase === 'error' || s.phase === 'conflict' || s.backend === 'memory' || loadProblem ? 'error'
      : (s.phase === 'pending' || s.phase === 'saving') ? 'warn' : '';
    var saved = s.phase === 'conflict' ? 'Read-only: changed in another tab'
      : loadProblem ? 'Saving paused'
        : s.phase === 'saving' || s.phase === 'pending' ? 'Saving…'
          : s.phase === 'error' ? 'Save failed'
            : s.at ? 'Autosaved ' + new Date(s.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Autosave on';
    // The Shortcuts button is written once and kept, so autosave updates never take its focus away.
    var info = el.querySelector('.sb-info');
    if (!info) {
      el.innerHTML = '<span class="sb-info" id="statusbar-info"></span><span class="spacer"></span><span class="sb-actions">' +
        '<button class="btn btn-ghost btn-sm" data-act="about" type="button" title="About Grade Tracker: offline use, where your data is stored, backups">' +
        ui.icon('info') + ' Help</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="shortcuts" type="button" title="Keyboard shortcuts (?)">' + ui.icon('keyboard') + ' Shortcuts</button></span>';
      info = el.querySelector('.sb-info');
    }
    setRegionHtml(info,
      '<span><span class="dot ' + dot + '"></span>' + esc(saved) + '</span>' +
      '<span>' + ui.icon('database', 'icon-sm') + ' Stored in this browser (' + esc(backendLabel) + ')' + (persisted ? ', persistent' : '') + '</span>' +
      '<span>' + ui.icon('lock', 'icon-sm') + ' Offline: no data leaves this computer</span>');
  }

  // ------------------------------------------------------------------ view

  function renderView(activeId) {
    var host = document.getElementById('view');
    var view = viewOf(activeId);
    if (!view) {
      host.innerHTML = '<div class="empty-state"><h2>Nothing here yet</h2></div>';
      currentViewId = null;
      return;
    }
    var switched = activeId !== currentViewId || !viewContainer || !host.contains(viewContainer);
    if (switched) {
      var prevView = currentViewId ? viewOf(currentViewId) : null;
      if (prevView && typeof prevView.destroy === 'function') {
        try { prevView.destroy(); } catch (e) { console.error(e); }
      }
      host.innerHTML = '';
      viewContainer = document.createElement('div');
      viewContainer.className = 'view-root view-' + activeId;
      viewContainer.setAttribute('data-view', activeId);
      host.appendChild(viewContainer);
      currentViewId = activeId;
    }
    var ctx = {
      store: store,
      course: store.course(),
      results: store.results(),
      params: viewParams,
      navigate: app.navigate,
      switched: switched
    };
    try {
      view.render(viewContainer, ctx);
    } catch (e) {
      console.error(e);
      viewContainer.innerHTML = '<div class="callout callout-danger"><strong>This view failed to render.</strong> ' + esc(e && e.message) +
        '<br>Your data is safe. Try another tab, reload the page, or download a backup.</div>';
    }
  }

  function renderAll() {
    renderHeader();
    var active = renderTabs();
    renderBanners();
    renderView(active);
    renderStatus();
  }

  // ------------------------------------------------------------------ data actions

  function doBackup() {
    var wrapped = model.wrapBackup(store.state, new Date().toISOString());
    var json = JSON.stringify(wrapped, null, 1);
    ui.download('grade-tracker-backup-' + ui.fileStamp() + '.json', json, 'application/json');
    store.setMeta({ lastBackupAt: wrapped.exportedAt });
    ui.toast('Backup downloaded. Keep it somewhere safe (not in a shared or public folder).', { type: 'success' });
  }

  function doRestore() {
    if (refuseReadOnly()) return;
    ui.pickFile('.json,application/json').then(function (file) {
      if (!file) return null;
      return ui.readText(file).then(function (text) {
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) { throw new Error('This file is not valid JSON.'); }
        return model.readBackup(parsed);
      }).then(function (res) {
        var sum = res.summary;
        var list = sum.courses.map(function (c) {
          return '<li><strong>' + esc(c.code) + '</strong> ' + esc(c.title) + ': ' + c.students + ' students</li>';
        }).join('');
        return ui.dialog.open({
          title: 'Restore from backup?',
          bodyHtml: '<p>File: <strong>' + esc(file.name) + '</strong>' + (sum.exportedAt ? ' (exported ' + esc(ui.dateTime(sum.exportedAt)) + ')' : '') + '</p>' +
            '<ul>' + (list || '<li>No courses</li>') + '</ul>' +
            '<div class="callout callout-warn">Restoring <strong>replaces all current data</strong> in this browser (every course). This cannot be undone.</div>' +
            (hasAnyData() ? '<p style="margin-top:10px"><label class="check"><input type="checkbox" id="rs-backup-first" checked> Download a backup of the current data first</label></p>' : ''),
          buttons: [
            { text: 'Cancel', value: null },
            { text: 'Restore', primary: true, danger: true, value: function (dlg) { var cb = dlg.querySelector('#rs-backup-first'); return { backupFirst: !!(cb && cb.checked) }; } }
          ]
        }).then(function (choice) {
          if (!choice) return;
          if (refuseReadOnly()) return;
          if (choice.backupFirst) doBackup();
          var st = res.state;
          var ts = new Date().toISOString();
          st.meta.lastBackupAt = sum.exportedAt || ts;
          st.courses.forEach(function (c) {
            c.history.push({
              id: util.uid('h'), ts: ts, source: 'restore', kind: 'bulk', studentId: null, studentName: null,
              teamId: null, teamName: null, field: 'Course data', fieldKey: 'restore', oldValue: '', newValue: '',
              note: 'Restored from backup file ' + file.name + (sum.exportedAt ? ' (exported ' + sum.exportedAt + ')' : '')
            });
          });
          loadProblem = null;
          store.replaceState(st, 'restore');
          ui.toast('Backup restored.', { type: 'success' });
        });
      });
    }).catch(function (err) {
      ui.dialog.open({ title: 'Could not restore', bodyHtml: '<p>' + esc(err && err.message ? err.message : String(err)) + '</p>', buttons: [{ text: 'OK', value: true, primary: true }] });
    });
  }

  function doDeleteAll() {
    if (refuseReadOnly()) return;
    ui.dialog.open({
      title: 'Delete all data?',
      bodyHtml: '<p>This permanently deletes <strong>every course, student, score, attendance record and change history</strong> stored by Grade Tracker in this browser.</p>' +
        '<p>It cannot be undone. Download a backup first if you might need the data again.</p>' +
        '<div class="field"><label for="del-confirm">Type <strong>DELETE</strong> to confirm</label><input id="del-confirm" type="text" autocomplete="off" spellcheck="false"></div>',
      buttons: [
        { text: 'Download backup first', value: 'backup' },
        { spacer: true },
        { text: 'Cancel', value: null },
        {
          text: 'Delete all data', value: 'delete', primary: true, danger: true,
          validate: function (dlg) { return dlg.querySelector('#del-confirm').value.trim() === 'DELETE' ? null : 'Type DELETE exactly to continue.'; }
        }
      ],
      initialFocus: '#del-confirm'
    }).then(function (v) {
      if (v === 'backup') { doBackup(); return; }
      if (v !== 'delete') return;
      if (refuseReadOnly()) return;
      var fresh = model.createDefaultState();
      fresh.ui.theme = store.state.ui.theme;
      // Deletes every stored copy and stores a new save stamp: another open tab that still shows the old
      // data becomes read-only on its next save instead of bringing it back.
      store.clearAll(fresh, 'delete-all').then(function () {
        loadProblem = null;
        requestRender();
        ui.toast('All data deleted. Two empty courses were created.', { type: 'success' });
      }, function (err) {
        if (err && err.conflict) conflictToast();
        else ui.toast('Could not delete the data: ' + (err && err.message ? err.message : String(err)), { type: 'error' });
      });
    });
  }

  function courseForm(title, c, isNew) {
    var fields = [];
    if (isNew) {
      fields.push({
        name: 'template', label: 'Start from', type: 'select', value: 'custom',
        options: [
          { value: 'SE4351', label: 'SE 4351 template (undergraduate defaults, TR sessions)' },
          { value: 'SE6362', label: 'SE 6362 template (graduate defaults, with Term Paper)' },
          { value: 'custom', label: 'Blank course (default weights)' }
        ],
        help: 'Templates copy the default assessments, weights and letter scale. Students are never copied.'
      });
    }
    fields.push(
      { name: 'code', label: 'Course code', value: c ? c.code : '', placeholder: 'e.g. SE 4351', required: true },
      { name: 'title', label: 'Course title', value: c ? c.title : '', placeholder: 'e.g. Requirements Engineering' },
      { name: 'term', label: 'Term', value: c ? c.term : 'Fall 2026' },
      {
        name: 'level', label: 'Level', type: 'select', value: c ? c.level : 'undergraduate',
        options: [{ value: 'undergraduate', label: 'Undergraduate' }, { value: 'graduate', label: 'Graduate' }],
        help: isNew ? 'Sets the default letter scale. Picking a template sets its level (SE 4351: undergraduate, SE 6362: graduate).'
          : 'Changing the level does not change the letter scale; edit cutoffs in Settings.'
      }
    );
    return ui.dialog.form({
      title: title, fields: fields, confirmText: isNew ? 'Create course' : 'Save',
      // A template brings its own level: "SE 6362 template (graduate defaults)" must not stay undergraduate
      // just because Level still shows its default. The level can still be changed afterwards.
      onMount: isNew ? function (dlg) {
        var tpl = dlg.querySelector('[name="template"]'), level = dlg.querySelector('[name="level"]');
        if (!tpl || !level) return;
        tpl.addEventListener('change', function () {
          if (tpl.value === 'SE4351') level.value = 'undergraduate';
          else if (tpl.value === 'SE6362') level.value = 'graduate';
        });
      } : null
    });
  }

  function doAddCourse() {
    if (refuseReadOnly()) return;
    courseForm('Add course', null, true).then(function (v) {
      if (!v || refuseReadOnly()) return;
      var tpl = v.template || 'custom';
      var overrides = { code: v.code.trim(), title: v.title.trim(), term: v.term.trim() };
      if (tpl === 'custom') overrides.level = v.level;
      var c = model.createCourse(tpl, overrides);
      if (tpl !== 'custom' && v.level !== c.level) {
        c.level = v.level;
        c.settings.letterScale = model.defaultLetterScale(v.level);
        c.settings.passingLetter = model.defaultPassingLetter(v.level);
      }
      store.addCourse(c);
      ui.toast('Course ' + c.code + ' created.', { type: 'success' });
    });
  }

  function doEditCourse() {
    var c = store.course();
    if (!c || refuseReadOnly()) return;
    courseForm('Edit course details', c, false).then(function (v) {
      if (!v || refuseReadOnly()) return;
      store.transact('Edit course details', function (co) {
        co.code = v.code.trim();
        co.title = v.title.trim();
        co.term = v.term.trim();
        co.level = v.level;
      });
    });
  }

  function doDuplicateCourse() {
    var c = store.course();
    if (!c || refuseReadOnly()) return;
    var copy = model.duplicateCourse(c, new Date().toISOString());
    store.addCourse(copy);
    ui.toast('Duplicated as ' + copy.code + '. You are now viewing the copy.', { type: 'success' });
  }

  function doDeleteCourse() {
    var c = store.course();
    if (!c || refuseReadOnly()) return;
    ui.dialog.confirm({
      title: 'Delete course ' + c.code + '?',
      messageHtml: '<p>This permanently deletes the course <strong>' + esc(model.courseLabel(c)) + '</strong> with its ' + c.students.length +
        ' students, scores, attendance and change history. Other courses are not affected.</p><p>Download a backup first if you might need it again.</p>',
      confirmText: 'Delete course', danger: true, requireText: c.code
    }).then(function (ok) {
      if (!ok || refuseReadOnly()) return;
      store.deleteCourse(c.id);
      ui.toast('Course deleted.', { type: 'success' });
    });
  }

  function doLoadSample() {
    var c = store.course();
    if (!c || !GT.sample || refuseReadOnly()) return;
    var prof = GT.sample.profileFor(c);
    var hasData = c.students.length > 0;
    ui.dialog.confirm({
      title: 'Load sample data into ' + c.code + '?',
      messageHtml: '<p>Creates ' + prof.studentCount + ' fake students ("Student 01", "Student 02", …) in ' + prof.teamSizes.length +
        ' teams, with sample scores' + (c.attendance.sessions.length ? ' and attendance' : '') + '.</p>' +
        (hasData ? '<div class="callout callout-warn"><strong>This replaces the ' + c.students.length + ' students, teams, scores and attendance records in this course.</strong> Settings and weights are kept. You can undo it (Ctrl+Z).</div>' : '<p class="muted">Settings and weights are kept.</p>'),
      confirmText: hasData ? 'Replace with sample data' : 'Load sample data', danger: hasData
    }).then(function (ok) {
      if (!ok || refuseReadOnly()) return;
      store.transact('Load sample data', function (co) { GT.sample.loadInto(co, { lateWork: true }); },
        { source: 'sample', historyMode: 'bulk', note: 'Replaced students, teams, scores and attendance with fake sample data' });
      ui.toast('Sample data loaded.', { type: 'success' });
    });
  }

  app.actions = {
    backup: doBackup,
    restore: doRestore,
    deleteAll: doDeleteAll,
    addCourse: doAddCourse,
    editCourse: doEditCourse,
    duplicateCourse: doDuplicateCourse,
    deleteCourse: doDeleteCourse,
    loadSample: doLoadSample
  };

  function openCourseMenu(anchor) {
    var c = store.course();
    ui.menu(anchor, [
      { heading: c ? c.code : 'Course' },
      { label: 'Add course…', icon: 'plus', onSelect: doAddCourse },
      { label: 'Edit course details…', icon: 'edit', onSelect: doEditCourse, disabled: !c },
      { label: 'Duplicate course', icon: 'copy', onSelect: doDuplicateCourse, disabled: !c },
      { label: 'Load sample data…', icon: 'layers', onSelect: doLoadSample, disabled: !c || !GT.sample },
      { separator: true },
      { label: 'Delete course…', icon: 'trash', onSelect: doDeleteCourse, danger: true, disabled: !c }
    ]);
  }

  function openDataMenu(anchor) {
    var last = store.state.meta.lastBackupAt;
    ui.menu(anchor, [
      { heading: last ? 'Last backup ' + ui.relativeTime(last) : 'No backup yet' },
      { label: 'Download backup', icon: 'download', onSelect: doBackup },
      { label: 'Restore from backup…', icon: 'upload', onSelect: doRestore },
      { separator: true },
      { label: 'Delete all data…', icon: 'trash', onSelect: doDeleteAll, danger: true }
    ], { alignRight: true });
  }

  function openThemeMenu(anchor) {
    function set(t) { return function () { store.setUi({ theme: t }); }; }
    var cur = store.state.ui.theme;
    // One choice of three: menuitemradio items with aria-checked (the current theme shows a check icon).
    ui.menu(anchor, [
      { label: 'System', icon: 'monitor', checked: cur === 'system', onSelect: set('system') },
      { label: 'Light', icon: 'sun', checked: cur === 'light', onSelect: set('light') },
      { label: 'Dark', icon: 'moon', checked: cur === 'dark', onSelect: set('dark') }
    ], { alignRight: true, label: 'Theme' });
  }

  /** Every keyboard shortcut, by where it works. Each entry is checked against the key handlers:
   * app.js (everywhere), js/ui/grid.js (gridKey, editorKey), js/ui/attendance.js (gridKey, roll call),
   * js/ui/stats.js (planner sandbox) and js/ui/exchange.js (column list). Keys joined by " / " are
   * alternatives; "+" joins keys pressed together. */
  var SHORTCUTS = [
    { group: 'Everywhere', rows: [
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo (Ctrl+Shift+Z also redoes)'],
      ['Alt+1 … Alt+8', 'Switch tabs: Grades, Students & Teams, Attendance, Statistics, Settings, History, Import / Export, Summary'],
      ['← / →', 'Previous / next tab, when a tab has the focus (Home / End: first / last tab)'],
      ['/', 'Jump to the search box (Grades, Students & Teams, Attendance, History)'],
      ['?', 'Show this list'],
      ['Esc', 'Close a dialog or menu']
    ] },
    { group: 'Grades grid', rows: [
      ['Arrow keys', 'Move between cells'],
      ['Tab / Shift+Tab', 'Next / previous cell (Esc, then Tab, leaves the grid)'],
      ['Enter', 'Edit the cell; while editing, save and move down (Shift+Enter: up)'],
      ['F2', 'Edit the cell without clearing it'],
      ['Type a number', 'Start editing and replace the value'],
      ['Shift+Arrow / Shift+Click', 'Select a range of cells'],
      ['Shift+Space / Ctrl+Space', 'Select the row / the column'],
      ['Ctrl+A', 'Select all cells'],
      ['Ctrl+Enter', 'Fill the selected cells with the typed value'],
      ['Home / End', 'First / last column'],
      ['Ctrl+Home / Ctrl+End', 'First / last cell'],
      ['PageUp / PageDown', 'Move 10 rows'],
      ['Ctrl+Arrow', 'Jump to the edge of the grid'],
      ['Delete / Backspace', 'Clear the selected cells'],
      ['Alt+↓', 'Open a drop-down list (Final letter, Class/Project Participation, Team); while typing in such a cell, Alt+↓ / Alt+↑ opens the list'],
      ['Shift+Arrow, then Enter', 'Give every selected row the same final letter or list value'],
      ['Esc', 'Cancel editing, or clear the selected range'],
      ['Ctrl+C / Ctrl+V', 'Copy / paste a block (works with Excel)'],
      ['Shift+F10 / Menu key', 'Cell and column actions (Override, fill or clear a column, Late work…, final letters)'],
      ['Ctrl+L', 'Late work of the active score cell (weeks late, penalty waived); while typing a score, it is saved first']
    ] },
    { group: 'Attendance grid (per session)', rows: [
      ['P / A / E', 'Present / Absent (not allowed) / Excused (allowed); the next student is selected. With several cells selected, marks them all'],
      ['Space', 'Change the mark of one cell: Present, Absent, Excused, no mark'],
      ['Delete / Backspace', 'Clear the mark of the selected cells'],
      ['Arrow keys / Tab / Enter', 'Move (Ctrl+Arrow, Home / End and PageUp / PageDown too)'],
      ['Shift+Arrow / Shift+Click', 'Select a range of cells'],
      ['Shift+F10 / Menu key', 'Cell actions (a mark, clear, mark everyone without a mark as Present, session options, student details)']
    ] },
    { group: 'Roll call', rows: [
      ['P / A / E', 'Mark the current student and go to the next one'],
      ['Delete / Backspace', 'Clear the current student’s mark'],
      ['↑ / ↓', 'Previous / next student'],
      ['← / →', 'Move between the Present, Absent and Excused buttons']
    ] },
    { group: 'Statistics and Import / Export', rows: [
      ['↑ / ↓', 'In a cutoff of the planner’s sandbox: raise / lower it by 0.5 (with Shift: 0.1)'],
      ['Alt+↑ / Alt+↓', 'In the export column list: move the column up / down']
    ] }
  ];

  function showShortcuts() {
    var kbds = function (keys) {
      return keys.split(' / ').map(function (k) { return '<kbd>' + esc(k) + '</kbd>'; }).join(' / ');
    };
    ui.dialog.open({
      title: 'Keyboard shortcuts',
      wide: true,
      bodyHtml: SHORTCUTS.map(function (g) {
        return '<h3 class="shortcut-h">' + esc(g.group) + '</h3><div class="shortcut-list">' + g.rows.map(function (r) {
          return '<div>' + kbds(r[0]) + '</div><div>' + esc(r[1]) + '</div>';
        }).join('') + '</div>';
      }).join('') + '<p class="muted small" style="margin-top:12px">On a Mac, use Cmd instead of Ctrl, and Option instead of Alt. ' +
        'Page shortcuts do not run while you type in a text field or while a dialog is open.</p>',
      buttons: [{ text: 'Close', value: true, primary: true }]
    });
  }
  app.SHORTCUTS = SHORTCUTS;

  /** Help / About (STAGE6 §3): what the app is, offline use, where the data is stored, a backup reminder,
   * the version and a relative link to README.md (opens the local file next to index.html). */
  function showAbout() {
    var s = store.saveStatus();
    var backend = s.backend === 'indexeddb' ? 'IndexedDB (the browser’s built-in database)'
      : s.backend === 'localstorage' ? 'localStorage (the browser’s small key-value store)' : 'memory only: nothing is saved when this tab closes';
    var last = store.state.meta.lastBackupAt;
    var age = backupAgeDays();
    var stale = age === null || age > BACKUP_REMINDER_DAYS;
    ui.dialog.open({
      title: 'About Grade Tracker',
      wide: true,
      bodyHtml: '<div class="about">' +
        '<p class="about-version"><strong>Grade Tracker</strong> <span class="badge">Version ' + esc(VERSION) + '</span></p>' +
        '<p>A grade book for teaching assistants that replaces the grading spreadsheet. For each course it keeps the students and teams, ' +
          'scores and team scores, weighted totals and letter grades, attendance, statistics, a printable summary, an Excel export and a change history.</p>' +
        '<h3>' + ui.icon('lock', 'icon-sm') + ' Offline and private</h3>' +
        '<p>It runs from this folder, without a server, an account or an internet connection, and it never sends anything anywhere: ' +
          'no student data leaves this computer.</p>' +
        '<h3>' + ui.icon('database', 'icon-sm') + ' Where your data is stored</h3>' +
        '<p>Only in this browser, on this computer: <strong>' + esc(backend) + '</strong>' + (persisted ? ', marked persistent' : '') + '. ' +
          'Another browser, another browser profile or a private window does not see it, and clearing this browser’s site data or browsing data deletes it.</p>' +
        '<h3>' + ui.icon('save', 'icon-sm') + ' Back up regularly</h3>' +
        '<p' + (stale ? ' class="about-stale"' : '') + '>' + (last ? 'Last backup: <strong>' + esc(ui.relativeTime(last)) + '</strong> (' + esc(ui.dateTime(last)) + ').'
          : '<strong>No backup yet.</strong>') + ' Download a backup (the Backup button at the top, or Data → Download backup) at least once a week: ' +
          'a reminder appears after ' + BACKUP_REMINDER_DAYS + ' days. Keep backup files private, never in a shared or public folder. ' +
          'Data → Restore from backup brings a backup back.</p>' +
        '<h3>' + ui.icon('file', 'icon-sm') + ' More help</h3>' +
        '<p>The <a href="README.md" target="_blank" rel="noopener" class="about-readme">README.md</a> file in this folder explains how to open the app, ' +
          'backup and restore, how every formula works, the placeholder settings that still need confirmation, and Excel export and import. ' +
          'Press <kbd>?</kbd> for the keyboard shortcuts.</p>' +
        '</div>',
      buttons: [
        { text: 'Keyboard shortcuts', value: 'shortcuts' },
        { text: 'Download backup', value: 'backup' },
        { spacer: true },
        { text: 'Close', value: true, primary: true }
      ]
    }).then(function (v) {
      if (v === 'shortcuts') showShortcuts();
      else if (v === 'backup') doBackup();
    });
  }
  app.showAbout = showAbout;
  app.showShortcuts = showShortcuts;

  // ------------------------------------------------------------------ events

  function bindShell() {
    document.getElementById('course-select').addEventListener('change', function (e) {
      store.setActiveCourse(e.target.value);
    });
    document.getElementById('btn-course-menu').addEventListener('click', function (e) { openCourseMenu(e.currentTarget); });
    document.getElementById('btn-data-menu').addEventListener('click', function (e) { openDataMenu(e.currentTarget); });
    document.getElementById('backup-chip').addEventListener('click', doBackup);
    document.getElementById('btn-theme').addEventListener('click', function (e) { openThemeMenu(e.currentTarget); });
    document.getElementById('btn-privacy').addEventListener('click', function () {
      store.setUi({ privacy: !store.state.ui.privacy });
    });
    document.getElementById('btn-undo').addEventListener('click', function () { if (!refuseReadOnly()) store.undo(); });
    document.getElementById('btn-redo').addEventListener('click', function () { if (!refuseReadOnly()) store.redo(); });

    var tabs = document.getElementById('tabs');
    tabs.addEventListener('click', function (e) {
      var t = e.target.closest('[data-view]');
      if (t) app.navigate(t.getAttribute('data-view'));
    });
    tabs.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
      var list = ui.$$('.tab', tabs);
      var i = list.indexOf(document.activeElement);
      if (i === -1) return;
      e.preventDefault();
      var j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
      app.navigate(list[j].getAttribute('data-view'));
      setTimeout(function () { var el = document.getElementById('tab-' + list[j].getAttribute('data-view')); if (el) el.focus(); }, 30);
    });

    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!a || !(a.closest('#banners') || a.closest('#statusbar'))) return;
      var act = a.getAttribute('data-act');
      if (act === 'backup') doBackup();
      else if (act === 'reload') { reloading = true; root.location.reload(); }
      else if (act === 'dismiss') { dismissed[a.getAttribute('data-key')] = true; requestRender(); }
      else if (act === 'goto') {
        var sec = a.getAttribute('data-section');
        app.navigate(a.getAttribute('data-view'), sec ? { section: sec } : undefined);
      }
      else if (act === 'shortcuts') showShortcuts();
      else if (act === 'about') showAbout();
      else if (act === 'download-raw') {
        var src = a.getAttribute('data-src') === 'recovered' ? recovered : loadProblem;
        if (!src) return;
        // Unreadable text is saved exactly as stored; a readable but invalid state as JSON.
        var rawText = typeof src.raw === 'string' ? src.raw : JSON.stringify(src.raw);
        ui.download('grade-tracker-unreadable-backup-' + ui.fileStamp() + '.json', rawText, 'application/json');
      } else if (act === 'start-fresh') {
        ui.dialog.confirm({
          title: 'Start fresh?', message: 'The unreadable saved data will be overwritten. Download it first if you have not.',
          confirmText: 'Start fresh', danger: true, requireText: 'DELETE'
        }).then(function (ok) {
          if (!ok || refuseReadOnly()) return;
          loadProblem = null;
          store.replaceState(model.createDefaultState(), 'start-fresh');
        });
      }
    });

    document.addEventListener('keydown', function (e) {
      if (document.querySelector('dialog[open]')) return;
      var typing = ui.isTypingTarget(e.target);
      var mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && !typing) {
        var k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); if (!refuseReadOnly()) store.undo(); return; }
        if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); if (!refuseReadOnly()) store.redo(); return; }
      }
      if (e.altKey && !mod && /^Digit[1-8]$/.test(e.code)) {
        var views = activeViews();
        var idx = parseInt(e.code.slice(5), 10) - 1;
        if (views[idx]) { e.preventDefault(); app.navigate(views[idx].id); }
        return;
      }
      if (!typing && !mod && !e.altKey && e.key === '?') { e.preventDefault(); showShortcuts(); }
    });

    // Leaving the page (reload, close, navigate, switch tab): first the views commit what is being typed
    // (leave hooks: an open grid editor, a focused Settings input), then flushOnLeave() saves; an IndexedDB
    // save started now may not commit before the page unloads, so it also writes unsaved changes
    // synchronously (store.js).
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') leave();
      else store.checkConflict(); // a message from another tab may have been missed meanwhile
    });
    root.addEventListener('pagehide', function () {
      leave();
      post('goodbye');
    });
    root.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      // Back from the browser's page cache: other tabs may have saved meanwhile.
      post('hello');
      store.checkConflict();
    });
    root.addEventListener('beforeunload', function (e) {
      leave();
      if (reloading || !leaveWouldLoseData()) return;
      e.preventDefault();
      e.returnValue = '';
    });

    // A conflict error that a view did not catch (it calls store.transact directly) becomes a toast.
    root.addEventListener('error', function (e) {
      if (e && e.error && e.error.conflict) { conflictToast(); e.preventDefault(); }
    });
    root.addEventListener('unhandledrejection', function (e) {
      if (e && e.reason && e.reason.conflict) { conflictToast(); e.preventDefault(); }
    });

    // Relative times ("5 min ago") refresh once a minute.
    setInterval(function () { renderHeader(); }, 60000);
  }

  // ------------------------------------------------------------------ leaving the page

  /** Registers fn() to run when the page is hidden, closed, reloaded or left, before the save: it commits
   * an edit that is still being typed (synchronously). Registering the same function again does nothing. */
  app.registerLeaveHook = function (fn) {
    if (typeof fn === 'function' && leaveHooks.indexOf(fn) === -1) leaveHooks.push(fn);
  };

  function runLeaveHooks() {
    leaveHooks.slice().forEach(function (fn) {
      try { fn(); } catch (e) { if (!(e && e.conflict)) console.error(e); }
    });
  }

  function leave() {
    runLeaveHooks();
    store.flushOnLeave();
  }

  /** True when closing now would lose changes: the memory backend (nothing is stored) with data, or
   * course data that is neither saved nor kept by the emergency copy (a failed save, saving paused while
   * the saved data is unreadable, or this tab is read-only after another tab saved). */
  function leaveWouldLoseData() {
    if (store.saveStatus().backend === 'memory') return hasAnyData();
    return store.hasUnsavedData();
  }

  // ------------------------------------------------------------------ other tabs (BroadcastChannel)
  // Messages: { type: 'hello' | 'here' | 'goodbye' | 'saved', id, stamp }. 'saved' carries the new save
  // stamp: a tab whose data is older checks storage and becomes read-only. 'goodbye' (on pagehide) removes
  // the tab from the "also open in another tab" banner.

  function post(type, extra) {
    if (!channel) return;
    var msg = { type: type, id: tabId };
    if (extra) Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
    try { channel.postMessage(msg); } catch (e) { /* closed */ }
  }

  function watchOtherTabs() {
    store.subscribe(function (info) {
      if (info && info.type === 'saved' && info.ok) post('saved', { stamp: info.stamp });
    });
    if (!root.BroadcastChannel) return;
    try {
      channel = new BroadcastChannel('grade-tracker');
      channel.onmessage = function (ev) {
        var m = ev.data;
        if (!m || typeof m !== 'object' || typeof m.type !== 'string' || typeof m.id !== 'string' || m.id === tabId) return;
        var had = otherTabOpen();
        if (m.type === 'goodbye') delete otherTabs[m.id];
        else otherTabs[m.id] = true;
        if (m.type === 'hello') post('here');
        if (m.type === 'saved' && (typeof m.stamp !== 'string' || m.stamp !== (GT.storage.stamp ? GT.storage.stamp() : null))) {
          store.checkConflict();
        }
        if (had !== otherTabOpen()) requestRender();
      };
      post('hello');
    } catch (e) { channel = null; /* not supported on this origin */ }
  }

  // ------------------------------------------------------------------ sticky header height

  /** Publishes the height of the sticky header (topbar + tabs) as --head-h on <html>, so views can
   * offset their own sticky elements and scroll targets. 0 when the header does not stick (phones). */
  function watchHeadHeight() {
    var head = document.querySelector('.app-head');
    if (!head) return;
    var last = null;
    function update() {
      var sticky = root.getComputedStyle(head).position === 'sticky';
      var h = sticky ? Math.ceil(head.getBoundingClientRect().height) : 0;
      if (h === last) return;
      last = h;
      document.documentElement.style.setProperty('--head-h', h + 'px');
    }
    update();
    if (root.ResizeObserver) new ResizeObserver(update).observe(head);
    root.addEventListener('resize', update);
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    ui.initPrivacyReveal();
    watchHeadHeight();
    GT.storage.init().then(function (info) {
      return GT.storage.load().then(function (raw) {
        var state;
        if (raw && raw.unreadable === true && typeof raw.raw === 'string') {
          // Saved text exists but is not valid JSON: keep it untouched until the user decides.
          loadProblem = { raw: raw.raw, message: 'the stored text is damaged: ' + raw.message };
          state = model.createDefaultState();
        } else if (raw) {
          try {
            state = model.normalizeState(raw);
          } catch (err) {
            loadProblem = { raw: raw, message: err && err.message ? err.message : String(err) };
            state = model.createDefaultState();
          }
        } else {
          state = model.createDefaultState();
        }
        recovered = GT.storage.loadNote ? GT.storage.loadNote() : null;
        store.init(state, info.backend);
        if (loadProblem) {
          // Do not overwrite unreadable saved data: keep it until the user decides. A save fails (the
          // status says "Saving paused"), so nothing claims to be saved and leaving the page warns.
          GT.storage.save = (function (orig) {
            return function (st) {
              if (!loadProblem) return orig(st);
              var err = new Error('Saving is paused until you download the unreadable data and restore it or start fresh');
              err.paused = true;
              return Promise.reject(err);
            };
          })(GT.storage.save);
          if (GT.storage.saveSync) {
            GT.storage.saveSync = (function (orig) {
              return function (st) { return loadProblem ? false : orig(st); };
            })(GT.storage.saveSync);
          }
        }
        store.subscribe(function () { requestRender(); });
        bindShell();
        watchOtherTabs();
        renderAll();
        if (!raw) store.saveNow(); // first run: save the new empty courses right away
        if (info.backend !== 'memory') {
          GT.storage.requestPersistence().then(function (p) { persisted = !!p; renderStatus(); });
        }
      });
    }).catch(function (err) {
      console.error(err);
      document.getElementById('view').innerHTML = '<div class="callout callout-danger"><strong>Grade Tracker could not start.</strong> ' + esc(err && err.message) + '</div>';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
