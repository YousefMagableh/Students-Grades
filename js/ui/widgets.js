/* Grade Tracker - shared UI widgets: icons, dialogs, menus, toasts, file helpers, formatting.
 * Browser only. Attaches GT.ui. */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util;
  var ui = GT.ui = GT.ui || {};
  var esc = util.escapeHtml;

  // ------------------------------------------------------------------ icons (inline SVG, stroke = currentColor)

  var ICONS = {
    logo: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M3 3l18 18M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.9 9.9 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    'sort-asc': '<path d="M12 19V5M6 11l6-6 6 6"/>',
    'sort-desc': '<path d="M12 5v14M6 13l6 6 6-6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18h.01"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/>',
    print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h8M7 21v-7h10v7"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    diamond: '<path d="M12 3l9 9-9 9-9-9 9-9z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    note: '<path d="M4 4h16v12l-4 4H4z"/><path d="M16 20v-4h4M8 9h8M8 13h5"/>',
    flag: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>'
  };

  ui.icon = function (name, cls) {
    var body = ICONS[name] || ICONS.info;
    return '<svg class="icon ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  };

  // ------------------------------------------------------------------ DOM helpers

  ui.$ = function (sel, rootEl) { return (rootEl || document).querySelector(sel); };
  ui.$$ = function (sel, rootEl) { return Array.prototype.slice.call((rootEl || document).querySelectorAll(sel)); };

  /** Creates an element from an HTML string (single root). */
  ui.el = function (html) {
    var t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstElementChild;
  };

  ui.isTypingTarget = function (el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };

  // ------------------------------------------------------------------ formatting

  ui.fmt = function (x, decimals) {
    var course = GT.store && GT.store.course && GT.store.course();
    var d = decimals !== undefined ? decimals : (course ? course.settings.decimals : 2);
    return util.formatNumber(x, d);
  };

  /** "just now", "5 min ago", "3 h ago", "2 days ago". */
  ui.relativeTime = function (iso) {
    if (!iso) return 'never';
    var ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return 'unknown';
    var s = Math.round(ms / 1000);
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    return d === 1 ? '1 day ago' : d + ' days ago';
  };

  /** Local date-time "Sep 28, 2026, 2:03 PM" (uses the computer's time zone). */
  ui.dateTime = function (iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return d.toISOString(); }
  };

  /** Local timestamp for file names: 2026-09-28_1403 */
  ui.fileStamp = function () {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  };

  /** Safe file-name fragment from a course code: "SE 4351" -> "SE4351". */
  ui.slug = function (s) {
    return String(s || 'course').replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 40) || 'course';
  };

  /** Yellow "needs confirmation" badge for an unconfirmed placeholder (empty string when confirmed). */
  ui.placeholderBadge = function (course, key, opts) {
    if (!course || GT.model.isConfirmed(course, key)) return '';
    var info = GT.model.placeholderInfo(course, key);
    if (!info) return '';
    var compact = opts && opts.compact;
    return '<span class="badge badge-warn" title="' + esc(info.label + ': ' + info.note) + '">' +
      ui.icon('alert') + (compact ? '<span class="sr-only">needs confirmation</span>' : 'needs confirmation') + '</span>';
  };

  // ------------------------------------------------------------------ toasts

  ui.toast = function (message, opts) {
    var o = opts || {};
    var host = document.getElementById('toasts');
    if (!host) return;
    var type = o.type || 'info';
    var iconName = type === 'success' ? 'check' : type === 'warn' ? 'alert' : type === 'error' ? 'alert' : 'info';
    var el = ui.el('<div class="toast ' + type + '" role="status">' + ui.icon(iconName) +
      '<span class="toast-msg"></span></div>');
    el.querySelector('.toast-msg').textContent = message;
    if (o.action) {
      var b = ui.el('<button class="btn btn-sm" type="button"></button>');
      b.textContent = o.action.label;
      b.addEventListener('click', function () { o.action.fn(); dismiss(); });
      el.appendChild(b);
    }
    host.appendChild(el);
    var timer = setTimeout(dismiss, o.timeout || (type === 'error' ? 8000 : 4000));
    function dismiss() {
      clearTimeout(timer);
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    return dismiss;
  };

  // ------------------------------------------------------------------ undo from a toast

  /** Identifies the current latest undo step of the active course (null if courseId is not active).
   * Labels repeat ("Edit team score", "Withdraw student"), so the mark also holds the step's unique id
   * (GT.store.undoStepId), the course's history length and its last entry id: every later change, undo or
   * redo pushes a new step and appends (or replaces) history entries, so the mark changes. */
  ui.undoMark = function (courseId) {
    var store = GT.store;
    var c = store && store.course ? store.course() : null;
    if (!c || c.id !== courseId) return null;
    var hist = Array.isArray(c.history) ? c.history : [];
    var last = hist.length ? hist[hist.length - 1] : null;
    return JSON.stringify([
      store.undoLabel(),
      typeof store.undoStepId === 'function' ? store.undoStepId() : null,
      hist.length,
      last && last.id ? last.id : null
    ]);
  };

  /** The "Undo" action for a toast ({ label: 'Undo', fn }). Call it right after the GT.store.transact():
   * it undoes that change only while it is still the latest undo step of its course (the course is still
   * active and nothing came after it, not even a newer change with the same label); otherwise it explains
   * why nothing was undone. */
  ui.undoAction = function (courseId, label) {
    var mark = ui.undoMark(courseId);
    return {
      label: 'Undo',
      fn: function () {
        var store = GT.store;
        if (store.readOnly && store.readOnly()) {
          ui.toast('Not undone: Grade Tracker was changed in another tab, so this tab is read-only. Reload to see the latest data.', { type: 'warn' });
          return;
        }
        if (mark && ui.undoMark(courseId) === mark && (!label || store.undoLabel() === label)) store.undo();
        else ui.toast('Not undone: it was already undone, or newer changes came after it. Use Undo (Ctrl+Z) step by step.', { type: 'warn' });
      }
    };
  };

  // ------------------------------------------------------------------ dialogs (native <dialog>)

  var dialog = ui.dialog = {};
  var dialogSeq = 0;

  /** Generic dialog. opts: { title, bodyHtml | body (Element), buttons: [{ text, value, primary, danger, validate }],
   *  wide, xwide, onMount(dlgEl, close), initialFocus (selector) }. Resolves with the clicked button value
   *  (or null on Esc/cancel). A button's validate(dlgEl) may return an error string to keep the dialog open. */
  dialog.open = function (opts) {
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var dlg = document.createElement('dialog');
      dlg.className = 'dlg' + (opts.wide ? ' wide' : '') + (opts.xwide ? ' xwide' : '');
      // Unique title id per dialog (a dialog can open over another), kept so the dialog has an accessible name.
      var titleId = 'dlg-title-' + (++dialogSeq);
      dlg.setAttribute('aria-labelledby', titleId);
      dlg.innerHTML =
        '<form method="dialog" class="dlg-form" novalidate>' +
        '<div class="dlg-head"><h2 id="' + titleId + '"></h2>' +
        '<button type="button" class="btn btn-ghost btn-icon btn-sm" data-dlg-close aria-label="Close">' + ui.icon('x') + '</button></div>' +
        '<div class="dlg-body"></div><div class="dlg-error" role="alert"></div>' +
        '<div class="dlg-foot"></div></form>';
      dlg.querySelector('.dlg-head h2').textContent = opts.title || '';
      var body = dlg.querySelector('.dlg-body');
      if (opts.body) body.appendChild(opts.body); else body.innerHTML = opts.bodyHtml || '';
      var foot = dlg.querySelector('.dlg-foot');
      var errEl = dlg.querySelector('.dlg-error');
      var buttons = opts.buttons || [{ text: 'OK', value: true, primary: true }];
      var settled = false;

      function close(value) {
        if (settled) return;
        settled = true;
        try { dlg.close(); } catch (e) { /* already closed */ }
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        if (prevFocus && prevFocus.focus && document.contains(prevFocus)) {
          try { prevFocus.focus({ preventScroll: true }); } catch (e2) { prevFocus.focus(); }
        }
        resolve(value);
      }

      var primaryBtn = null;
      buttons.forEach(function (b) {
        if (b.spacer) { foot.appendChild(ui.el('<span class="spacer"></span>')); return; }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? (b.primary ? ' btn-danger-solid' : ' btn-danger') : '');
        btn.textContent = b.text;
        btn.addEventListener('click', function () {
          if (b.validate) {
            var err = b.validate(dlg);
            if (err) { errEl.textContent = err; return; }
          }
          close(typeof b.value === 'function' ? b.value(dlg) : b.value);
        });
        if (b.primary) primaryBtn = btn;
        foot.appendChild(btn);
      });

      dlg.querySelector('[data-dlg-close]').addEventListener('click', function () { close(null); });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(null); });
      dlg.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        if (primaryBtn && !primaryBtn.disabled) primaryBtn.click();
      });
      // Enter in a single-line input submits via the primary button.
      dlg.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && primaryBtn) {
          e.preventDefault();
          primaryBtn.click();
        }
      });

      document.body.appendChild(dlg);
      dlg.showModal();
      if (opts.onMount) opts.onMount(dlg, close, errEl);
      var focusEl = (opts.initialFocus && dlg.querySelector(opts.initialFocus)) ||
        dlg.querySelector('.dlg-body input:not([type="hidden"]), .dlg-body select, .dlg-body textarea') || primaryBtn;
      if (focusEl) focusEl.focus();
    });
  };

  /** Confirm dialog. opts: { title, message, messageHtml, confirmText, cancelText, danger, requireText }.
   *  requireText: the user must type this exact text to enable the confirm button. Resolves true/false. */
  dialog.confirm = function (opts) {
    var o = opts || {};
    var html = o.messageHtml || ('<p>' + esc(o.message || '') + '</p>');
    if (o.requireText) {
      html += '<div class="field"><label for="dlg-require">Type <strong>' + esc(o.requireText) +
        '</strong> to confirm</label><input id="dlg-require" type="text" autocomplete="off" spellcheck="false"></div>';
    }
    return dialog.open({
      title: o.title || 'Are you sure?',
      bodyHtml: html,
      buttons: [
        { text: o.cancelText || 'Cancel', value: false },
        {
          text: o.confirmText || 'OK', value: true, primary: true, danger: !!o.danger,
          validate: o.requireText ? function (dlg) {
            var v = dlg.querySelector('#dlg-require').value.trim();
            return v === o.requireText ? null : 'Type ' + o.requireText + ' exactly to continue.';
          } : null
        }
      ],
      initialFocus: o.requireText ? '#dlg-require' : null
    }).then(function (v) { return v === true; });
  };

  /** Form dialog. fields: [{ name, label, type: 'text'|'number'|'select'|'checkbox'|'textarea'|'date',
   *  value, options: [{ value, label }], placeholder, help, min, max, step, required, pii }].
   *  validate(values) -> error string | null. onMount(dlgEl) runs once the dialog is open (a field's
   *  control is [name="<field name>"]). Resolves with a values object or null. */
  dialog.form = function (opts) {
    var o = opts || {};
    var html = (o.introHtml || '') + (o.fields || []).map(function (f, i) {
      var id = 'dlgf-' + i;
      var common = ' id="' + id + '" name="' + esc(f.name) + '"' + (f.pii ? ' class="pii"' : '') +
        (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '');
      var control;
      if (f.type === 'select') {
        control = '<select' + common + '>' + (f.options || []).map(function (op) {
          return '<option value="' + esc(op.value) + '"' + (String(op.value) === String(f.value) ? ' selected' : '') + '>' + esc(op.label) + '</option>';
        }).join('') + '</select>';
      } else if (f.type === 'checkbox') {
        return '<div class="field"><label class="check"><input type="checkbox"' + common + (f.value ? ' checked' : '') + '> ' +
          esc(f.label) + '</label>' + (f.help ? '<div class="help">' + esc(f.help) + '</div>' : '') + '</div>';
      } else if (f.type === 'textarea') {
        control = '<textarea' + common + ' rows="' + (f.rows || 4) + '">' + esc(f.value || '') + '</textarea>';
      } else {
        control = '<input type="' + (f.type || 'text') + '"' + common + ' value="' + esc(f.value === undefined || f.value === null ? '' : f.value) + '"' +
          (f.min !== undefined ? ' min="' + f.min + '"' : '') + (f.max !== undefined ? ' max="' + f.max + '"' : '') +
          (f.step !== undefined ? ' step="' + f.step + '"' : '') + ' autocomplete="off">';
      }
      return '<div class="field"><label for="' + id + '">' + esc(f.label) + (f.badgeHtml || '') + '</label>' + control +
        (f.help ? '<div class="help">' + esc(f.help) + '</div>' : '') + '</div>';
    }).join('');

    function collect(dlg) {
      var out = {};
      (o.fields || []).forEach(function (f, i) {
        var el = dlg.querySelector('#dlgf-' + i);
        if (!el) return;
        if (f.type === 'checkbox') out[f.name] = el.checked;
        else out[f.name] = el.value;
      });
      return out;
    }

    return dialog.open({
      title: o.title,
      bodyHtml: html,
      wide: o.wide,
      onMount: o.onMount ? function (dlg) { o.onMount(dlg); } : null,
      buttons: [
        { text: o.cancelText || 'Cancel', value: null },
        {
          text: o.confirmText || 'Save', primary: true, danger: !!o.danger,
          validate: function (dlg) {
            var vals = collect(dlg);
            for (var i = 0; i < (o.fields || []).length; i++) {
              var f = o.fields[i];
              if (f.required && String(vals[f.name] || '').trim() === '') return f.label + ' is required.';
            }
            return o.validate ? o.validate(vals) : null;
          },
          value: function (dlg) { return collect(dlg); }
        }
      ]
    });
  };

  /** Single text prompt. Resolves with the string or null. */
  dialog.prompt = function (opts) {
    var o = opts || {};
    return dialog.form({
      title: o.title,
      confirmText: o.confirmText || 'OK',
      fields: [{ name: 'value', label: o.label || '', value: o.value || '', placeholder: o.placeholder, help: o.help, required: o.required }],
      validate: o.validate ? function (v) { return o.validate(v.value); } : null
    }).then(function (v) { return v ? v.value : null; });
  };

  // ------------------------------------------------------------------ popover menu

  var openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    var m = openMenu;
    openMenu = null;
    document.removeEventListener('mousedown', m.onDoc, true);
    window.removeEventListener('resize', m.onClose);
    window.removeEventListener('scroll', m.onClose, true);
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    if (m.anchor && m.anchor.setAttribute) m.anchor.setAttribute('aria-expanded', 'false');
    if (m.returnFocus && m.returnFocus.focus && document.contains(m.returnFocus)) m.returnFocus.focus();
  }
  ui.closeMenu = closeMenu;

  /** Opens a menu next to an anchor element, or at { x, y } (context menus).
   *  items: [{ label, icon, onSelect, danger, disabled, hint, checked } | { separator: true } | { heading: 'Text' }].
   *  An item with `checked` (true or false) is one choice of a group (role "menuitemradio", aria-checked,
   *  a check icon when chosen), e.g. the theme menu. opts: { alignRight, returnFocus, label (aria-label) }. */
  ui.menu = function (anchor, items, opts) {
    closeMenu();
    var o = opts || {};
    var el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    if (o.label) el.setAttribute('aria-label', o.label);
    items.forEach(function (it) {
      if (!it) return;
      if (it.separator) { el.appendChild(ui.el('<div class="menu-sep" role="separator"></div>')); return; }
      if (it.heading) { var h = ui.el('<div class="menu-label"></div>'); h.textContent = it.heading; el.appendChild(h); return; }
      var radio = typeof it.checked === 'boolean';
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', radio ? 'menuitemradio' : 'menuitem');
      if (radio) b.setAttribute('aria-checked', it.checked ? 'true' : 'false');
      b.tabIndex = -1;
      if (it.danger) b.className = 'danger';
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      b.innerHTML = (it.icon ? ui.icon(it.icon) : '') + '<span></span>' + (it.hint ? '<span class="menu-hint"></span>' : '') +
        (radio ? '<span class="menu-check">' + ui.icon('check') + '</span>' : '');
      b.querySelector('span').textContent = it.label;
      if (it.hint) b.querySelector('.menu-hint').textContent = it.hint;
      b.addEventListener('click', function () {
        if (it.disabled) return;
        closeMenu();
        if (it.onSelect) it.onSelect();
      });
      el.appendChild(b);
    });
    document.body.appendChild(el);

    var x, y;
    if (anchor && anchor.getBoundingClientRect) {
      var r = anchor.getBoundingClientRect();
      x = o.alignRight ? r.right - el.offsetWidth : r.left;
      y = r.bottom + 4;
      anchor.setAttribute('aria-expanded', 'true');
    } else {
      x = anchor.x; y = anchor.y;
    }
    var w = el.offsetWidth, hgt = el.offsetHeight;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    if (y + hgt > window.innerHeight - 8) y = Math.max(8, (anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect().top - hgt - 4 : window.innerHeight - hgt - 8));
    el.style.left = x + 'px';
    el.style.top = y + 'px';

    var entries = ui.$$('[role="menuitem"], [role="menuitemradio"]', el);
    el.addEventListener('keydown', function (e) {
      var i = entries.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); entries[(i + 1) % entries.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); entries[(i - 1 + entries.length) % entries.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); entries[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); entries[entries.length - 1].focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); }
    });
    var state = {
      el: el, anchor: anchor && anchor.setAttribute ? anchor : null,
      returnFocus: o.returnFocus || (anchor && anchor.focus ? anchor : document.activeElement),
      onDoc: function (e) { if (!el.contains(e.target) && e.target !== anchor && !(anchor && anchor.contains && anchor.contains(e.target))) closeMenu(); },
      onClose: function () { closeMenu(); }
    };
    openMenu = state;
    setTimeout(function () {
      // Closed already (Escape right after opening): adding the listeners now would leave them behind,
      // and they would close the NEXT menu on its first click.
      if (openMenu !== state) return;
      document.addEventListener('mousedown', state.onDoc, true);
      window.addEventListener('resize', state.onClose);
      window.addEventListener('scroll', state.onClose, true);
    }, 0);
    // Focus the chosen item of a radio menu, else the first enabled item.
    var first = entries.filter(function (b) { return b.getAttribute('aria-checked') === 'true'; })[0] ||
      entries.filter(function (b) { return b.getAttribute('aria-disabled') !== 'true'; })[0] || entries[0];
    if (first) first.focus();
    return closeMenu;
  };

  // ------------------------------------------------------------------ files

  /** Triggers a download of a Blob or string. Nothing leaves the computer (blob: URL). */
  ui.download = function (filename, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1500);
  };

  /** Opens the file picker. Resolves with a File or null. */
  ui.pickFile = function (accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.style.display = 'none';
      var done = false;
      input.addEventListener('change', function () {
        done = true;
        var f = input.files && input.files[0] ? input.files[0] : null;
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(f);
      });
      // Resolve null if the picker is dismissed (focus returns without a change event).
      window.addEventListener('focus', function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(function () {
          if (!done) {
            if (input.parentNode) input.parentNode.removeChild(input);
            resolve(null);
          }
        }, 600);
      });
      document.body.appendChild(input);
      input.click();
    });
  };

  ui.readText = function (file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error || new Error('Could not read the file.')); };
      r.readAsText(file);
    });
  };

  ui.readArrayBuffer = function (file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error || new Error('Could not read the file.')); };
      r.readAsArrayBuffer(file);
    });
  };

  var excelPromise = null;
  /** Loads the vendored ExcelJS on demand (local file, no network). Resolves with window.ExcelJS. */
  ui.loadExcel = function () {
    if (root.ExcelJS) return Promise.resolve(root.ExcelJS);
    if (excelPromise) return excelPromise;
    excelPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'vendor/exceljs.min.js';
      s.onload = function () {
        if (root.ExcelJS) resolve(root.ExcelJS);
        else { excelPromise = null; reject(new Error('The Excel library loaded but did not initialize.')); }
      };
      s.onerror = function () {
        excelPromise = null;
        reject(new Error('Could not load vendor/exceljs.min.js. Keep the vendor folder next to index.html.'));
      };
      document.head.appendChild(s);
    });
    return excelPromise;
  };

  // ------------------------------------------------------------------ privacy: click to reveal (D2)

  var REVEAL_MS = 10000;
  ui.initPrivacyReveal = function () {
    document.addEventListener('click', function (e) {
      if (!document.body.classList.contains('privacy-on')) return;
      var el = e.target.closest ? e.target.closest('.pii') : null;
      if (!el || el.classList.contains('revealed')) return;
      el.classList.add('revealed');
      setTimeout(function () { el.classList.remove('revealed'); }, REVEAL_MS);
    }, true);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
