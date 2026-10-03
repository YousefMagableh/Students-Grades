/* Grade Tracker - Statistics tab (GT.views.stats), stage 5: ST1-ST3 plus the cutoff planner and the
 * borderline list (docs/build/STAGE5.md and its Addendum).
 *
 * Every figure comes from GT.stats (js/core/stats.js) and GT.calc; this file only lays them out. Each
 * GT.stats call is guarded, so the view never crashes while that module is missing or incomplete: it
 * shows a friendly "loading" state instead. Active students only (S2): withdrawn students appear only as
 * "Withdrawn (excluded)". Letters are the effective letters (the final letter when one is set, else the
 * cutoff suggestion; DECISIONS 2), with a toggle on the letter chart.
 *
 * Charts are hand-written inline SVG drawn at the measured width of their card and colored only through
 * CSS custom properties (css/stats.css maps them onto the css/base.css tokens), so light and dark both
 * work. Each has role="img", <title>, <desc>, a <title> per mark, and a "Show as table" toggle (or a
 * table right next to it). Terms are explained in plain words for a TA who never used Excel.
 *
 * Rendering: one skeleton of section hosts; every render rebuilds each section's markup as a string and
 * writes a host only when its markup changed (setHtmlKeep), so the store's frequent notifications
 * (autosave) cost nothing and the focused control keeps its focus, caret and typed text. Transient state
 * (measure, what-if choices, the planner sandbox, table toggles) lives in this module; simple preferences
 * (bin width, letter mode, borderline distance, guide open) in GT.store.state.ui.statsPrefs.
 * Course data changes only through GT.store.transact: "Apply cutoffs to Settings" and "Use these as
 * final letters…" (model.setFinalLetters), each ONE undoable step. Student names carry class "pii". */
(function (root) {
  'use strict';
  var GT = root.GT;
  var util = GT.util, model = GT.model, calc = GT.calc;
  var ui = GT.ui = GT.ui || {};
  var esc = util.escapeHtml;
  GT.views = GT.views || {};

  // ------------------------------------------------------------------ constants

  var DASH = '—';
  var MINUS = '−';
  var BIN_RULE_FALLBACK = '"90 - 100" includes both 90 and 100. Every other row starts at its first number and stops just ' +
    'below the next ten, so 89.99 counts in "80 - 89". Values above 100 (a curve) and below 0 have their own rows.';
  var TOP_N = 5;
  var MAX_GAPS = 6;
  var SECTIONS = [
    { id: 'st-overview', label: 'Overview' },
    { id: 'st-hist', label: 'Charts' },
    { id: 'st-assess', label: 'Assessments' },
    { id: 'st-perf', label: 'Top & bottom' },
    { id: 'st-teams', label: 'Teams' },
    { id: 'st-whatif', label: 'What-if' },
    { id: 'st-planner', label: 'Cutoff planner' },
    { id: 'st-border', label: 'Borderline' }
  ];

  // ------------------------------------------------------------------ module state

  var boundEl = null;        // the container the listeners are bound to
  var dom = null;            // section hosts of the current skeleton
  var shellKind = null;      // 'main' | 'loading' | 'empty' | 'nocourse'
  var lastCourseId = null;
  var lastParams = null;
  var measure = 'total';     // 'total' or an assessment id (panel measure selector)
  var tables = {};           // chart id -> true while "Show as table" is on
  var wi = { sid: null, aid: null, letter: null, aidAuto: true, letterAuto: true }; // what-if choices
  var sb = null;             // planner sandbox: { courseId, base, baseKey, rows, text, err, note }
  var withinText = null;     // borderline distance typed but not valid yet
  var lastRenderMs = 0;
  var globalBound = false;
  var resizeTimer = null;

  // ------------------------------------------------------------------ small helpers

  function icon(name, cls) { return ui.icon(name, cls); }
  function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
  function logErr(e) { if (root.console) console.error(e); }
  function finite(x) { return typeof x === 'number' && isFinite(x); }
  function hasOwn(o, k) { return util.hasOwn(o, k); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function decimalsOf(course) {
    var d = course && course.settings ? course.settings.decimals : 2;
    return typeof d === 'number' && d >= 0 && d <= 6 ? Math.floor(d) : 2;
  }
  function fmt(x, d) { return finite(x) ? util.formatNumber(x, d) : ''; }
  function fmtOr(x, d) { return finite(x) ? util.formatNumber(x, d) : DASH; }
  function pctOr(x, d) { return finite(x) ? util.formatPercent(x, d === undefined ? 1 : d) : DASH; }
  /** Rounds up to `d` decimals, so a "score needed" is never shown a hair too low. */
  function ceilTo(x, d) { var f = Math.pow(10, d); return util.fix(Math.ceil(util.fix(x * f)) / f); }
  function r1(v) { return Math.round(v * 10) / 10; }
  function sel(on) { return on ? ' selected' : ''; }
  function nameOf(s) { return s ? model.studentName(s) : ''; }
  function noOf(s) { return s && s.no !== null && s.no !== undefined && s.no !== '' ? String(s.no) : ''; }
  function privacyOn() { return !!(GT.store && GT.store.state && GT.store.state.ui && GT.store.state.ui.privacy); }
  /** Who a chart tooltip names: the student's name, or only their No while privacy mode is on. */
  function tipName(s) {
    if (!s) return 'Student';
    if (privacyOn()) return noOf(s) ? 'No ' + noOf(s) : 'Student';
    return nameOf(s) || (noOf(s) ? 'No ' + noOf(s) : 'Student');
  }
  function dateOnly(iso) {
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return String(iso || '');
    try { return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return dt.toISOString().slice(0, 10); }
  }
  function cssEsc(s) {
    return root.CSS && root.CSS.escape ? root.CSS.escape(s) : String(s).replace(/["\\\]\[]/g, '\\$&');
  }

  // ------------------------------------------------------------------ the core module (guarded)

  function statsFn(name) {
    var s = GT.stats;
    return s && typeof s[name] === 'function' ? s[name] : null;
  }
  function ready() { return !!statsFn('describe'); }
  /** Calls a GT.stats function; a missing function or an exception gives `dflt` (logged), never a crash. */
  function call(name, args, dflt) {
    var f = statsFn(name);
    if (!f) return dflt;
    try {
      var v = f.apply(GT.stats, args);
      return v === undefined || v === null ? dflt : v;
    } catch (e) { logErr(e); return dflt; }
  }
  function binRule() { return GT.stats && typeof GT.stats.BINS10_RULE === 'string' ? GT.stats.BINS10_RULE : BIN_RULE_FALLBACK; }

  // ------------------------------------------------------------------ preferences (ui.statsPrefs)

  function prefs() {
    var st = GT.store && GT.store.state;
    var p = st && st.ui && util.isPlainObject(st.ui.statsPrefs) ? st.ui.statsPrefs : {};
    return {
      binWidth: p.binWidth === 5 ? 5 : 10,
      letters: p.letters === 'suggested' ? 'suggested' : 'effective',
      within: finite(p.within) && p.within > 0 && p.within <= 20 ? p.within : 1,
      guide: p.guide !== false
    };
  }
  function setPrefs(patch) {
    var p = prefs();
    Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    GT.store.setUi({ statsPrefs: p });
  }
  function rerender() { if (GT.app && GT.app.render) GT.app.render(); }

  // ------------------------------------------------------------------ render

  function render(el, ctx) {
    var t0 = now();
    if (el !== boundEl) bindContainer(el);
    bindGlobal();
    var course = ctx.course;
    var results = ctx.results;
    if (!course || !results) {
      setShell(el, 'nocourse', '<div class="empty-state"><h2>No course</h2><p>Add a course from the course menu.</p></div>');
      return;
    }
    if (course.id !== lastCourseId) {
      lastCourseId = course.id;
      measure = 'total';
      wi = { sid: null, aid: null, letter: null, aidAuto: true, letterAuto: true };
      sb = null;
      withinText = null;
    }
    if (!ready()) {
      setShell(el, 'loading', '<div class="empty-state st-loading" role="status">' + icon('chart', 'st-empty-ico') +
        '<h2>Statistics are loading…</h2><p>The statistics module (<span class="mono">js/core/stats.js</span>) is not ready yet. ' +
        'If this message stays, keep the <span class="mono">js</span> folder next to <span class="mono">index.html</span> and reload the page. Your data is safe.</p></div>');
      return;
    }
    var activeN = (results.activeIds || []).length;
    if (!activeN) {
      setShell(el, 'empty', emptyHtml(course));
      return;
    }
    if (shellKind !== 'main' || !dom || !el.contains(dom.overview)) buildMain(el);
    syncSandbox(course);
    var params = ctx.params && ctx.params !== lastParams ? ctx.params : null;
    if (params) lastParams = params;
    try {
      var W = measureWidths();
      var d = compute(course, results);
      syncWhatIf(d);
      setHtmlKeep(dom.head, headHtml(d));
      setHtmlKeep(dom.overview, overviewHtml(d));
      setHtmlKeep(dom.summary, summaryHtml(d, W));
      setHtmlKeep(dom.hist, histCardHtml(d, W.half));
      setHtmlKeep(dom.letters, lettersCardHtml(d, W.half));
      setHtmlKeep(dom.assess, assessHtml(d));
      setHtmlKeep(dom.perf, perfHtml(d));
      setHtmlKeep(dom.teams, teamsHtml(d, W.full));
      setHtmlKeep(dom.whatif, whatIfHtml(d));
      renderPlanner(d, W.plot);
      setHtmlKeep(dom.border, borderHtml(d));
    } catch (e) {
      logErr(e);
      setShell(el, 'error', '<div class="callout callout-danger"><strong>Statistics could not be shown.</strong> ' + esc(e && e.message) +
        '<br>Your data is safe. Try another tab or reload the page.</div>');
      return;
    }
    if (params && params.section) {
      var id = params.section.indexOf('st-') === 0 ? params.section : 'st-' + params.section;
      setTimeout(function () { jumpTo(id); }, 0);
    }
    lastRenderMs = now() - t0;
  }

  function destroy() {
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
  }

  function setShell(el, kind, html) {
    dom = null;
    shellKind = kind;
    if (el.__stHtml === html) return;
    el.innerHTML = html;
    el.__stHtml = html;
  }

  function emptyHtml(course) {
    var n = course.students.length;
    var msg = n
      ? 'All ' + plural(n, 'student') + ' in ' + esc(course.code || 'this course') + ' are withdrawn. Withdrawn students are kept in the records but left out of every statistic.'
      : 'Statistics need at least one active student. Add students in <strong>Students &amp; Teams</strong>, or load the fake sample data to try this tab.';
    return '<div class="empty-state st-empty">' + icon('chart', 'st-empty-ico') +
      '<h2>No statistics yet</h2><p>' + msg + '</p><div class="actions">' +
      '<button type="button" class="btn btn-primary" data-act="goto-students" data-k="act:students">' + icon('users') + 'Go to Students &amp; Teams</button>' +
      (!n && GT.app && GT.app.actions && GT.app.actions.loadSample ? '<button type="button" class="btn" data-act="load-sample" data-k="act:sample">' + icon('layers') + 'Load sample data…</button>' : '') +
      '</div></div>';
  }

  // ------------------------------------------------------------------ skeleton

  function bindContainer(el) {
    boundEl = el;
    dom = null;
    shellKind = null;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('toggle', onToggle, true);
  }

  function bindGlobal() {
    if (globalBound) return;
    globalBound = true;
    root.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        if (isActiveView() && shellKind === 'main') rerender();
      }, 150);
    });
  }

  function isActiveView() {
    return !!(boundEl && document.body.contains(boundEl) && GT.store && GT.store.state && GT.store.state.ui.activeView === 'stats');
  }

  function buildMain(el) {
    var jump = SECTIONS.map(function (s) {
      return '<button type="button" class="st-jump-btn" data-act="jump" data-to="' + s.id + '" data-k="jump:' + s.id + '">' + esc(s.label) + '</button>';
    }).join('');
    var html =
      '<div class="st-head-host"></div>' +
      '<nav class="st-jump no-print" aria-label="Statistics sections"><span class="st-jump-label">Jump to</span>' + jump + '</nav>' +
      '<section class="card st-panel" id="st-overview" aria-labelledby="st-h-overview"></section>' +
      '<div class="st-kpis" id="st-summary"></div>' +
      '<div class="st-two">' +
        '<section class="card st-card" id="st-hist" aria-labelledby="st-h-hist"></section>' +
        '<section class="card st-card" id="st-letters" aria-labelledby="st-h-letters"></section>' +
      '</div>' +
      '<section class="card st-card" id="st-assess" aria-labelledby="st-h-assess"></section>' +
      '<section class="card st-card" id="st-perf" aria-labelledby="st-h-perf"></section>' +
      '<section class="card st-card" id="st-teams" aria-labelledby="st-h-teams"></section>' +
      '<section class="card st-card" id="st-whatif" aria-labelledby="st-h-whatif"></section>' +
      '<section class="card st-card st-planner" id="st-planner" aria-labelledby="st-h-planner">' +
        '<div class="st-pl-head"></div>' +
        '<div class="card-body st-pl-body">' +
          '<div class="st-pl-main"><div class="st-pl-sum" aria-live="polite"></div><div class="st-pl-plot"></div><div class="st-pl-changes"></div></div>' +
          '<div class="st-pl-side"></div>' +
        '</div>' +
      '</section>' +
      '<section class="card st-card" id="st-border" aria-labelledby="st-h-border"></section>';
    el.innerHTML = html;
    el.__stHtml = null;
    shellKind = 'main';
    dom = {
      root: el,
      head: el.querySelector('.st-head-host'),
      overview: el.querySelector('#st-overview'),
      summary: el.querySelector('#st-summary'),
      hist: el.querySelector('#st-hist'),
      letters: el.querySelector('#st-letters'),
      assess: el.querySelector('#st-assess'),
      perf: el.querySelector('#st-perf'),
      teams: el.querySelector('#st-teams'),
      whatif: el.querySelector('#st-whatif'),
      plHead: el.querySelector('.st-pl-head'),
      plSum: el.querySelector('.st-pl-sum'),
      plPlot: el.querySelector('.st-pl-plot'),
      plChanges: el.querySelector('.st-pl-changes'),
      plSide: el.querySelector('.st-pl-side'),
      border: el.querySelector('#st-border')
    };
  }

  /** Chart widths in px, read once per render before anything is written (one layout, no thrashing). */
  function measureWidths() {
    function inner(host, pad, dflt) {
      var w = host ? host.clientWidth : 0;
      return w > 0 ? Math.max(220, Math.floor(w - pad)) : dflt;
    }
    return {
      half: inner(dom.hist, 34, 560),
      full: inner(dom.teams, 34, 900),
      kpi: kpiWidth(),
      plot: inner(dom.plPlot, 0, 700)
    };
  }
  function kpiWidth() {
    var card = dom.summary && dom.summary.querySelector('.st-kpi');
    var w = card ? card.clientWidth : 0;
    if (w > 0) return Math.max(200, Math.floor(w - 34));
    var all = dom.summary ? dom.summary.clientWidth : 0;
    return all > 0 ? Math.max(200, Math.floor((all > 900 ? all / 3 : all) - 34)) : 300;
  }

  /** Replaces a host's markup only when it changed; the focused control (matched by data-k) keeps focus,
   * its caret and any value typed but not saved yet. */
  function setHtmlKeep(host, html) {
    if (!host || host.__stHtml === html) return;
    var ae = document.activeElement;
    var had = ae && ae !== host && host.contains(ae) ? ae : null;
    var key = had && had.getAttribute('data-k') ? '[data-k="' + cssEsc(had.getAttribute('data-k')) + '"]' : null;
    var typed = had && (had.tagName === 'INPUT' || had.tagName === 'TEXTAREA') && had.type !== 'checkbox' && had.type !== 'radio' &&
      had.value !== had.defaultValue ? had.value : null;
    var start = null, end = null;
    try { start = had ? had.selectionStart : null; end = had ? had.selectionEnd : null; } catch (e) { start = end = null; }
    var scrollers = keepScroll(host);
    host.innerHTML = html;
    host.__stHtml = html;
    restoreScroll(host, scrollers);
    if (!had) return;
    var next = key ? host.querySelector(key) : null;
    if (!next) next = host.querySelector('button:not([disabled]), select, input:not([disabled])');
    if (!next) return;
    if (typed !== null && 'value' in next) next.value = typed;
    try { next.focus({ preventScroll: true }); } catch (e2) { next.focus(); }
    if (start !== null && typeof next.setSelectionRange === 'function') {
      try { next.setSelectionRange(start, end); } catch (e3) { /* not a text field */ }
    }
  }
  /** Horizontal scroll of the table boxes in a host (kept across a rewrite of that host). */
  function keepScroll(host) {
    var out = [];
    var list = host.querySelectorAll('[data-scroll]');
    for (var i = 0; i < list.length; i++) if (list[i].scrollLeft || list[i].scrollTop) out.push([list[i].getAttribute('data-scroll'), list[i].scrollLeft, list[i].scrollTop]);
    return out;
  }
  function restoreScroll(host, list) {
    list.forEach(function (x) {
      var el = host.querySelector('[data-scroll="' + cssEsc(x[0]) + '"]');
      if (el) { el.scrollLeft = x[1]; el.scrollTop = x[2]; }
    });
  }

  // ------------------------------------------------------------------ data for one render

  function activeResults(course, results) {
    var out = [];
    (results.activeIds || []).forEach(function (id) {
      var r = results.byId[id];
      if (r && r.active !== false) out.push(r);
    });
    return out;
  }

  function compute(course, results) {
    var p = prefs();
    var d = { course: course, results: results, p: p, D: decimalsOf(course) };
    d.students = {};
    course.students.forEach(function (s) { d.students[s.id] = s; });
    d.active = activeResults(course, results);
    d.nActive = d.active.length;
    d.nWithdrawn = course.students.filter(function (s) { return s.status === 'withdrawn'; }).length;
    d.totals = call('activeTotals', [course, results], null);
    if (!Array.isArray(d.totals)) d.totals = d.active.map(function (r) { return r.total; }).filter(finite);
    d.tDesc = describe(d.totals);
    d.m = measureData(course, results, d);
    d.mDesc = d.m.kind === 'total' ? d.tDesc : describe(d.m.values);
    d.mBins = call('bins10', [d.m.binValues], []);
    d.status = call('statusDistribution', [course, results], null);
    d.letters = call('letterDistribution', [course, results, { letters: p.letters }], []);
    d.pass = call('passRate', [course, results], null);
    d.hist = call('histogram', [d.totals, p.binWidth, 0, 100], []);
    d.perA = call('perAssessment', [course, results], []);
    d.tb = call('topBottom', [course, results, TOP_N], null);
    d.teams = call('perTeam', [course, results], []);
    d.border = call('borderline', [course, results, p.within], []);
    d.gaps = call('gaps', [course, results, 1], []);
    d.scaleLetters = model.scaleLetters(course);
    d.passingLetter = d.pass && d.pass.passingLetter ? d.pass.passingLetter : course.settings.passingLetter;
    return d;
  }

  function describe(values) {
    var x = call('describe', [values], null);
    return util.isPlainObject(x) ? x : { count: values.length };
  }

  /** The panel's measure: the total, or one assessment's raw scores (bins in percent of its max). */
  function measureData(course, results, d) {
    var a = measure !== 'total' ? model.findAssessment(course, measure) : null;
    if (!a) {
      measure = 'total';
      return { kind: 'total', a: null, values: d.totals, binValues: d.totals, n: d.totals.length, of: d.nActive };
    }
    var vals = call('assessmentValues', [course, results, a.id], null);
    var pcts = call('assessmentValues', [course, results, a.id, { percent: true }], null);
    if (!Array.isArray(vals) || !Array.isArray(pcts)) {
      vals = []; pcts = [];
      d.active.forEach(function (r) {
        var it = r.items && r.items[a.id];
        if (it && it.state === 'number' && finite(it.raw)) {
          vals.push(it.raw);
          if (a.maxScore > 0) pcts.push(util.fix(it.raw * 100 / a.maxScore));
        }
      });
    }
    return { kind: 'assessment', a: a, values: vals, binValues: pcts, n: vals.length, of: d.nActive };
  }

  // ------------------------------------------------------------------ header

  function headHtml(d) {
    var c = d.course;
    var fin = model.isFinalized(c)
      ? '<span class="badge badge-info st-fin">' + icon('lock') + 'Scores finalized on ' + esc(dateOnly(c.finalized.at)) + '</span>' : '';
    var sub = 'Active students only (n = ' + d.nActive + ')' +
      (d.nWithdrawn ? ' · ' + plural(d.nWithdrawn, 'withdrawn student') + ' left out' : '') +
      ' · Updates as soon as a score changes';
    return '<div class="page-header st-head"><div class="st-head-text">' +
      '<h1 class="st-title"><span class="st-code">' + esc(c.code || 'Course') + '</span> Statistics</h1>' +
      '<div class="sub">' + esc(sub) + (fin ? ' ' + fin : '') + '</div>' +
      (fin ? '<div class="sub st-ro">Scores are locked, so these figures will not change. Statistics are read-only; the planner below can still try cutoffs.</div>' : '') +
      '</div><div class="st-head-actions no-print">' +
      '<button type="button" class="btn btn-sm" data-act="print" data-k="act:print" title="Print this page (the controls are left out)">' + icon('print') + 'Print</button>' +
      '</div></div>';
  }

  // ------------------------------------------------------------------ 1. eLearning-style panel (ST1)

  var STAT_ROWS = [
    { k: 'count', label: 'Count', help: 'How many students are counted. Withdrawn students are always left out.' },
    { k: 'min', label: 'Minimum Value', help: 'The lowest value in the class.' },
    { k: 'max', label: 'Maximum Value', help: 'The highest value in the class.' },
    { k: 'range', label: 'Range', help: 'Highest minus lowest: how far apart the two ends of the class are.' },
    { k: 'mean', label: 'Average', help: 'Add up every value and divide by the count. A few very low values pull it down.' },
    { k: 'median', label: 'Median', help: 'The middle student when everyone is lined up from lowest to highest. One very low score does not pull it down.' },
    { k: 'sd', label: 'Standard Deviation', qual: 'sample, n ' + MINUS + ' 1', help: 'How spread out the values are: small means most students are close to the average. Same as Excel STDEV.S.' },
    { k: 'variance', label: 'Variance', qual: 'sample', help: 'The standard deviation multiplied by itself. Same as Excel VAR.S.' }
  ];
  var STATUS_ROWS = [
    { k: 'active', label: 'Active', help: 'Students counted in every statistic.' },
    { k: 'withdrawn', label: 'Withdrawn (excluded)', help: 'Kept in the records and exports, but left out of every statistic.' },
    { k: 'complete', label: 'Complete', help: 'Active students with every weighted score entered.' },
    { k: 'incomplete', label: 'Incomplete (≥ 1 empty score)', help: 'Active students with at least one empty score. An empty score counts as 0 in the total.' },
    { k: 'invalidEntries', label: 'Invalid entries', help: 'Scores typed as text that is not a number. They count as 0 until fixed in the Grades tab.' },
    { k: 'overrides', label: 'Overrides', help: 'Team-graded scores changed for one member (an unequal split needs the team\'s written agreement).' }
  ];

  function overviewHtml(d) {
    var c = d.course, m = d.m, s = d.mDesc, D = d.D;
    var isT = m.kind === 'total';
    var opts = '<option value="total"' + sel(isT) + '>Total (out of 100)</option>' +
      c.assessments.map(function (a) {
        return '<option value="' + esc(a.id) + '"' + sel(!isT && m.a.id === a.id) + '>' + esc(a.name) + ' (raw score out of ' + esc(fmt(a.maxScore, D)) + ')</option>';
      }).join('');
    var pop = isT ? 'Active students only (n = ' + m.n + ')' : 'Active students with a score on ' + m.a.name + ' (n = ' + m.n + ' of ' + m.of + ')';
    var head = '<div class="card-header st-panel-head"><div class="st-panel-title"><h2 id="st-h-overview">Class statistics</h2>' +
      '<span class="st-pop">' + esc(pop) + '</span></div>' +
      '<div class="st-measure"><label for="st-measure">Show statistics for</label>' +
      '<select id="st-measure" data-k="measure">' + opts + '</select></div></div>';

    var unit = isT ? 'Totals, points out of 100' : 'Raw scores out of ' + fmt(m.a.maxScore, D);
    var statRows = STAT_ROWS.map(function (r) {
      var v = s[r.k];
      var cell = r.k === 'count'
        ? '<span class="st-pill">' + esc(String(finite(v) ? v : 0)) + '</span>'
        : (finite(v) ? esc(fmt(v, D)) : '<span class="st-na" title="' + (r.k === 'sd' || r.k === 'variance' ? 'Needs at least 2 values' : 'No values') + '">' + DASH + '</span>');
      return '<tr title="' + esc(r.help) + '"><th scope="row">' + esc(r.label) + (r.qual ? ' <span class="st-qual">(' + esc(r.qual) + ')</span>' : '') + '</th>' +
        '<td class="num" data-stat="' + r.k + '"' + (finite(v) ? ' data-v="' + v + '"' : '') + '>' + cell + '</td></tr>';
    }).join('');

    var st = d.status || {};
    var statusRows = STATUS_ROWS.map(function (r) {
      var v = st[r.k];
      var warn = (r.k === 'invalidEntries' || r.k === 'incomplete') && v > 0;
      return '<tr title="' + esc(r.help) + '"><th scope="row">' + esc(r.label) + '</th><td class="num' + (warn ? ' st-warnv' : '') + '" data-status="' + r.k + '">' +
        (finite(v) ? esc(String(v)) : DASH) + '</td></tr>';
    }).join('');

    var rule = binRule();
    var bins = Array.isArray(d.mBins) ? d.mBins : [];
    var binRows = bins.map(function (b, i) {
      var n = finite(b.count) ? b.count : 0;
      return '<tr title="' + esc(b.rule ? 'Counts values ' + b.rule + '.' : rule) + '"><th scope="row">' + esc(b.label) + '</th>' +
        '<td class="num' + (n ? '' : ' st-zero') + '" data-bin="' + i + '">' + n + '</td></tr>';
    }).join('');
    var binNote = isT ? 'Totals in 10-point bands' : 'Percent of the max (' + fmt(m.a.maxScore, D) + ' = 100%), 10-point bands';

    var cols = '<div class="st-cols">' +
      '<div class="st-col"><h3 class="st-col-h" id="st-col-stats">Statistics</h3><p class="st-col-sub">' + esc(unit) + '</p>' +
        '<table class="st-list" aria-labelledby="st-col-stats"><tbody>' + statRows + '</tbody></table></div>' +
      '<div class="st-col"><h3 class="st-col-h" id="st-col-status">Status distribution</h3><p class="st-col-sub">Students in the course</p>' +
        '<table class="st-list" aria-labelledby="st-col-status"><tbody>' + statusRows + '</tbody></table></div>' +
      '<div class="st-col"><h3 class="st-col-h" id="st-col-grades">Grade distribution <span class="st-info" tabindex="0" role="note" title="' + esc(rule) + '" aria-label="' + esc('How the rows work: ' + rule) + '">' + icon('info', 'icon-sm') + '</span></h3>' +
        '<p class="st-col-sub">' + esc(binNote) + '</p>' +
        '<table class="st-list" aria-labelledby="st-col-grades"><tbody>' + binRows + '</tbody></table></div>' +
      '</div>';

    var empty = !m.n ? '<div class="callout st-callout">' + icon('info') + ' No scores entered yet for <strong>' + esc(m.a ? m.a.name : 'this measure') +
      '</strong>, so there is nothing to describe. Pick another measure above.</div>' : '';
    return head + '<div class="card-body st-panel-body">' + empty + cols + '</div>' + guideHtml(d);
  }

  /** "What do these words mean?": plain words, with this class's own numbers as the examples. */
  function guideHtml(d) {
    var s = d.mDesc, D = d.D, m = d.m, isT = m.kind === 'total';
    var one = isT ? 'total' : 'score', many = isT ? 'totals' : 'scores';
    var forWhat = isT ? '' : ' on ' + m.a.name;
    function v(x) { return finite(x) ? '<strong class="num">' + esc(fmt(x, D)) + '</strong>' : DASH; }
    var items = [];
    items.push(['Count', 'How many students are counted' + esc(isT ? '' : ' (students with a score' + forWhat + ')') +
      '. Withdrawn students are always left out. Here: ' + v(s.count) + '.']);
    items.push(['Minimum, maximum and range', 'The lowest (' + v(s.min) + ') and highest (' + v(s.max) + ') ' + one +
      ', and the distance between them (' + v(s.range) + ').']);
    var compare = '';
    if (finite(s.mean) && finite(s.median) && s.count > 1) {
      var diff = util.fix(s.median - s.mean);
      if (diff >= 1) compare = ' Here the median is ' + v(diff) + ' points above the average: a few low ' + many + ' pull the average down.';
      else if (diff <= -1) compare = ' Here the median is ' + v(-diff) + ' points below the average: a few high ' + many + ' pull the average up.';
      else compare = ' Here they are close, so no small group of ' + many + ' is pulling the average away.';
    }
    items.push(['Average (' + fmt(s.mean, D) + ')', 'Add up every ' + one + ' and divide by the count. A few very low (or very high) ' + many + ' pull it down (or up).']);
    items.push(['Median (' + fmt(s.median, D) + ')', 'The middle student\'s ' + one + ' when everyone is lined up from lowest to highest: half the class is at or above it. ' +
      'One very low score does not pull it down, so it often describes the typical student better than the average.' + compare]);
    var spread = '';
    if (finite(s.sd) && finite(s.mean)) {
      var lo = s.mean - s.sd, hi = s.mean + s.sd;
      var inside = m.values.filter(function (x) { return finite(x) && x >= lo - 1e-9 && x <= hi + 1e-9; }).length;
      spread = ' Here ' + v(inside) + ' of ' + v(s.count) + ' students are within one standard deviation (' + v(s.sd) + ' points) of the average, between ' +
        v(lo) + ' and ' + v(hi) + '.';
    }
    items.push(['Standard deviation (' + (finite(s.sd) ? fmt(s.sd, D) : 'needs 2 students') + ')', 'How spread out the ' + many + ' are, in points. Small: most students are close to the average. ' +
      'Large: the ' + many + ' are spread out.' + spread + ' This is the "sample" version (n ' + MINUS + ' 1), the same as Excel\'s STDEV.S.']);
    items.push(['Variance', 'The standard deviation multiplied by itself, in "squared points". It is used in formulas; the standard deviation is easier to read. Sample version, like Excel\'s VAR.S.']);
    items.push(['Quartiles (Q1, Q3, IQR)', 'Q1 (' + v(s.q1) + '): a quarter of the class is at or below it. Q3 (' + v(s.q3) + '): three quarters are at or below it. ' +
      'IQR = Q3 ' + MINUS + ' Q1 (' + v(s.iqr) + '): the spread of the middle half of the class; like the median, a few extreme ' + many + ' do not change it. Same method as Excel\'s QUARTILE.INC.']);
    items.push(['Grade distribution', esc(binRule()) + (isT ? '' : ' For an assessment, each score is first turned into a percent of its max (4.5 out of 5 is 90%).')]);
    items.push(['Pass rate', 'The share of active students whose letter is ' + esc(d.passingLetter || 'the passing letter') + ' or better. It uses the final letter where one is assigned, otherwise the suggested letter from the cutoffs.']);
    var body = items.map(function (it) {
      return '<div class="st-guide-item"><dt>' + esc(it[0]) + '</dt><dd>' + it[1] + '</dd></div>';
    }).join('');
    return '<details class="st-guide no-print"' + (d.p.guide ? ' open' : '') + ' data-k="guide">' +
      '<summary data-k="guide-sum">' + icon('info') + '<span>What do these words mean?</span><span class="st-guide-hint">Plain-words guide, using this class\'s numbers</span></summary>' +
      '<dl class="st-guide-list">' + body + '</dl></details>';
  }

  // ------------------------------------------------------------------ 2. summary cards

  function summaryHtml(d, W) {
    var t = d.tDesc, D = d.D, c = d.course;
    function qc(label, x, help) {
      return '<div class="st-q" title="' + esc(help) + '"><span class="st-q-l">' + esc(label) + '</span><span class="st-q-v">' + esc(fmtOr(x, D)) + '</span></div>';
    }
    var quart = '<section class="card st-kpi" aria-labelledby="st-h-q"><div class="st-kpi-head"><h2 class="st-kpi-title" id="st-h-q">Quartiles</h2><span class="st-kpi-note">Totals</span></div>' +
      '<div class="st-quart">' +
        qc('Q1', t.q1, 'A quarter of the class is at or below this total.') +
        qc('Median', t.median, 'Half the class is at or below this total.') +
        qc('Q3', t.q3, 'Three quarters of the class are at or below this total.') +
        qc('IQR', t.iqr, 'Q3 minus Q1: the spread of the middle half of the class.') +
      '</div>' + boxSvg(t, W.kpi, D) +
      '<p class="st-cap">The box holds the middle half of the class (Q1 to Q3), the line inside it is the median, and the whiskers reach the lowest and highest totals.</p></section>';

    var p = d.pass || {};
    var pct = finite(p.pct) ? p.pct : null;
    var passL = p.passingLetter || c.settings.passingLetter;
    var badge = ui.placeholderBadge(c, 'passingLetter');
    var pass = '<section class="card st-kpi" aria-labelledby="st-h-pass"><div class="st-kpi-head"><h2 class="st-kpi-title" id="st-h-pass">Pass rate</h2>' + badge + '</div>' +
      '<div class="st-big" data-stat="passPct"' + (pct !== null ? ' data-v="' + pct + '"' : '') + '>' + esc(pctOr(pct, 1)) + '</div>' +
      '<div class="st-kpi-sub">' + (finite(p.passing) ? '<strong>' + p.passing + '</strong> of ' + plural(p.total || 0, 'active student') + ' have <strong>' + esc(passL || '?') + '</strong> or better' : DASH) + '</div>' +
      '<div class="st-meter" role="img" aria-label="' + esc('Pass rate ' + pctOr(pct, 1)) + '"><span style="width:' + (pct !== null ? Math.max(0, Math.min(100, pct)) : 0) + '%"></span></div>' +
      '<p class="st-cap">Uses the final letter where one is assigned, otherwise the suggested letter from the cutoffs.' +
      (p.unknown ? ' ' + plural(p.unknown, 'student has', 'students have') + ' a final letter that is not in the scale (counted as not passing).' : '') + '</p>' +
      '<button type="button" class="btn btn-sm btn-ghost st-link no-print" data-act="goto-settings" data-ph="passingLetter" data-k="act:pass-settings">' + icon('settings') + 'Change the passing grade in Settings</button></section>';

    var spread = finite(t.sd) ? 'Most totals sit within about ' + fmt(t.sd, D) + ' points of the average.' : 'The spread needs at least 2 students.';
    var avg = '<section class="card st-kpi" aria-labelledby="st-h-avg"><div class="st-kpi-head"><h2 class="st-kpi-title" id="st-h-avg">Class average</h2><span class="st-kpi-note">Totals</span></div>' +
      '<div class="st-big" data-stat="avgBig">' + esc(fmtOr(t.mean, D)) + '</div>' +
      '<div class="st-kpi-sub">out of 100, over ' + plural(t.count || 0, 'active student') + '</div>' +
      '<div class="st-pair">' +
        '<div class="st-q" title="The middle student\'s total: one very low score does not pull it down."><span class="st-q-l">Median</span><span class="st-q-v">' + esc(fmtOr(t.median, D)) + '</span></div>' +
        '<div class="st-q" title="How spread out the totals are (sample, n − 1)."><span class="st-q-l">Standard deviation</span><span class="st-q-v">' + esc(fmtOr(t.sd, D)) + '</span></div>' +
      '</div><p class="st-cap">' + esc(spread) + '</p></section>';
    return quart + pass + avg;
  }

  // ------------------------------------------------------------------ SVG helpers

  function svgOpen(cls, W, H, id, title, desc) {
    return '<svg class="st-svg ' + cls + '" role="img" aria-labelledby="' + id + '-t ' + id + '-d" viewBox="0 0 ' + W + ' ' + H +
      '" width="' + W + '" height="' + H + '" preserveAspectRatio="xMinYMin meet" focusable="false">' +
      '<title id="' + id + '-t">' + esc(title) + '</title><desc id="' + id + '-d">' + esc(desc) + '</desc>';
  }
  /** Column with a 4px rounded top, square at the baseline (x, y = top-left; h > 0). */
  function colPath(x, y, w, h) {
    var r = Math.min(4, w / 2, h);
    return 'M' + r1(x) + ',' + r1(y + h) + 'V' + r1(y + r) + 'Q' + r1(x) + ',' + r1(y) + ' ' + r1(x + r) + ',' + r1(y) +
      'H' + r1(x + w - r) + 'Q' + r1(x + w) + ',' + r1(y) + ' ' + r1(x + w) + ',' + r1(y + r) + 'V' + r1(y + h) + 'Z';
  }
  /** Bar from the left baseline with a 4px rounded right end. */
  function barPath(x, y, w, h) {
    var r = Math.min(4, h / 2, w);
    return 'M' + r1(x) + ',' + r1(y) + 'H' + r1(x + w - r) + 'Q' + r1(x + w) + ',' + r1(y) + ' ' + r1(x + w) + ',' + r1(y + r) +
      'V' + r1(y + h - r) + 'Q' + r1(x + w) + ',' + r1(y + h) + ' ' + r1(x + w - r) + ',' + r1(y + h) + 'H' + r1(x) + 'Z';
  }
  function countTicks(max) {
    var steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) if (max / steps[i] <= 5) { step = steps[i]; break; }
    var top = Math.max(step, Math.ceil(max / step) * step);
    var ticks = [];
    for (var v = 0; v <= top; v += step) ticks.push(v);
    return { top: top, ticks: ticks };
  }
  function valueStep(span, px, minPx) {
    var steps = [0.5, 1, 2, 5, 10, 20, 25, 50];
    for (var i = 0; i < steps.length; i++) if (px * steps[i] / span >= minPx) return steps[i];
    return 100;
  }
  function textW(s, size) { return String(s).length * (size || 11) * 0.62; }
  function tableToggle(chart, label) {
    var on = !!tables[chart];
    return '<button type="button" class="btn btn-sm btn-ghost st-tbl-btn no-print" data-act="table" data-chart="' + chart + '" aria-pressed="' + (on ? 'true' : 'false') +
      '" data-k="tbl:' + chart + '" title="' + esc(on ? 'Show the chart again' : 'Show the same numbers as a table (' + label + ')') + '">' +
      icon(on ? 'chart' : 'grid') + (on ? 'Show as chart' : 'Show as table') + '</button>';
  }
  function cardHead(id, title, subHtml, rightHtml) {
    return '<div class="card-header st-card-head"><div class="st-card-title"><h2 id="' + id + '">' + esc(title) + '</h2>' +
      (subHtml ? '<p class="st-card-sub">' + subHtml + '</p>' : '') + '</div>' +
      (rightHtml ? '<div class="st-card-tools">' + rightHtml + '</div>' : '') + '</div>';
  }

  // ------------------------------------------------------------------ box plot

  function boxSvg(t, W, D) {
    if (!finite(t.min) || !finite(t.q1) || !finite(t.q3)) return '<p class="st-cap muted">The box plot needs at least one total.</p>';
    var H = 74, ml = 8, mr = 8;
    var lo = Math.max(0, Math.floor(t.min / 10) * 10), hi = Math.ceil(t.max / 10) * 10;
    if (hi - lo < 20) { hi = Math.min(Math.max(hi, lo + 20), Math.max(100, hi)); if (hi - lo < 20) lo = Math.max(0, hi - 20); }
    if (hi === lo) hi = lo + 10;
    var pw = W - ml - mr;
    var x = function (v) { return ml + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * pw; };
    var y0 = 10, bh = 26, ym = y0 + bh / 2, axisY = 50;
    var step = valueStep(hi - lo, pw, 34);
    var out = svgOpen('st-box', W, H, 'st-svg-box', 'Box plot of the totals',
      'Lowest ' + fmt(t.min, D) + ', Q1 ' + fmt(t.q1, D) + ', median ' + fmt(t.median, D) + ', Q3 ' + fmt(t.q3, D) + ', highest ' + fmt(t.max, D) + '.');
    out += '<g class="st-axis"><line class="st-base" x1="' + ml + '" x2="' + r1(ml + pw) + '" y1="' + axisY + '" y2="' + axisY + '"/>';
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      out += '<line class="st-tickm" x1="' + r1(x(v)) + '" x2="' + r1(x(v)) + '" y1="' + axisY + '" y2="' + (axisY + 4) + '"/>' +
        '<text class="st-tick" x="' + r1(x(v)) + '" y="' + (axisY + 16) + '" text-anchor="middle">' + esc(fmt(v, 1)) + '</text>';
    }
    out += '</g>';
    out += '<g class="st-mark"><title>' + esc('Lowest total ' + fmt(t.min, D) + ' to Q1 ' + fmt(t.q1, D)) + '</title>' +
      '<line class="st-whisk" x1="' + r1(x(t.min)) + '" x2="' + r1(x(t.q1)) + '" y1="' + ym + '" y2="' + ym + '"/>' +
      '<line class="st-whisk" x1="' + r1(x(t.min)) + '" x2="' + r1(x(t.min)) + '" y1="' + (ym - 7) + '" y2="' + (ym + 7) + '"/></g>';
    out += '<g class="st-mark"><title>' + esc('Q3 ' + fmt(t.q3, D) + ' to highest total ' + fmt(t.max, D)) + '</title>' +
      '<line class="st-whisk" x1="' + r1(x(t.q3)) + '" x2="' + r1(x(t.max)) + '" y1="' + ym + '" y2="' + ym + '"/>' +
      '<line class="st-whisk" x1="' + r1(x(t.max)) + '" x2="' + r1(x(t.max)) + '" y1="' + (ym - 7) + '" y2="' + (ym + 7) + '"/></g>';
    var bw = Math.max(2, x(t.q3) - x(t.q1));
    out += '<g class="st-mark"><title>' + esc('Middle half of the class: ' + fmt(t.q1, D) + ' to ' + fmt(t.q3, D) + ' (IQR ' + fmt(t.iqr, D) + ')') + '</title>' +
      '<rect class="st-boxr" x="' + r1(x(t.q1)) + '" y="' + y0 + '" width="' + r1(bw) + '" height="' + bh + '" rx="4"/></g>';
    out += '<g class="st-mark"><title>' + esc('Median ' + fmt(t.median, D)) + '</title>' +
      '<line class="st-med" x1="' + r1(x(t.median)) + '" x2="' + r1(x(t.median)) + '" y1="' + (y0 - 2) + '" y2="' + (y0 + bh + 2) + '"/></g>';
    return out + '</svg>';
  }

  // ------------------------------------------------------------------ 3. histogram

  function histLabel(b, last) {
    var lo = fmt(b.lo, 2), hi = fmt(b.hi, 2);
    return last ? lo + ' to ' + hi : lo + ' to under ' + hi;
  }

  function histCardHtml(d, W) {
    var p = d.p;
    var seg = '<div class="segmented no-print" role="group" aria-label="Bar width">' +
      '<button type="button" data-act="bins" data-v="10" aria-pressed="' + (p.binWidth === 10) + '" data-k="bins:10">10-point</button>' +
      '<button type="button" data-act="bins" data-v="5" aria-pressed="' + (p.binWidth === 5) + '" data-k="bins:5">5-point</button></div>';
    var head = cardHead('st-h-hist', 'Distribution of totals', 'How many students fall in each ' + p.binWidth + '-point range', seg + tableToggle('hist', 'ranges and counts'));
    var bins = Array.isArray(d.hist) ? d.hist : [];
    var n = d.totals.length;
    var body;
    if (!bins.length) body = '<p class="muted">Not available.</p>';
    else if (tables.hist) {
      body = '<div class="table-wrap st-twrap" data-scroll="hist"><table class="table st-table"><caption class="sr-only">Totals per range</caption><thead><tr><th scope="col">Range of totals</th><th scope="col" class="num">Students</th><th scope="col" class="num">Share</th></tr></thead><tbody>' +
        bins.map(function (b, i) {
          return '<tr><th scope="row" class="st-rh">' + esc(histLabel(b, i === bins.length - 1)) + outsideNote(b) + '</th><td class="num">' + b.count + '</td><td class="num">' + esc(pctOr(n ? 100 * b.count / n : null, 1)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else body = histSvg(bins, d, W);
    return head + '<div class="card-body">' + body +
      '<p class="st-cap">Each bar counts the active students whose total is in that range; the lines mark the average and the median. ' +
      'Totals above 100 (a curve) are counted in the last bar.</p></div>';
  }
  function outsideNote(b) {
    var t = [];
    if (b.above) t.push(plural(b.above, 'total') + ' above ' + fmt(b.hi, 2));
    if (b.below) t.push(plural(b.below, 'total') + ' below ' + fmt(b.lo, 2));
    return t.length ? ' <span class="st-qual">(includes ' + esc(t.join(', ')) + ')</span>' : '';
  }

  function histSvg(bins, d, W) {
    var D = d.D, t = d.tDesc, n = d.totals.length;
    var H = 236, mt = 34, mr = 10, mb = 26, ml = 30;
    var pw = W - ml - mr, ph = H - mt - mb;
    var nb = bins.length;
    var lo = bins[0].lo, hi = bins[nb - 1].hi;
    var maxC = 0;
    bins.forEach(function (b) { if (b.count > maxC) maxC = b.count; });
    var ct = countTicks(Math.max(1, maxC));
    var band = pw / nb;
    var bw = Math.max(2, Math.min(24, band - 4));
    var y = function (c) { return mt + ph - c / ct.top * ph; };
    var xv = function (v) { return ml + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * pw; };
    var desc = bins.filter(function (b) { return b.count; }).map(function (b, i) { return histLabel(b, b === bins[nb - 1]) + ': ' + b.count; }).join('; ');
    var out = svgOpen('st-hist-svg', W, H, 'st-svg-hist', 'Histogram of the totals in ' + (hi - lo) / nb + '-point ranges',
      'Students per range of totals (' + n + ' active students). ' + (desc || 'No totals.') + ' Average ' + fmt(t.mean, D) + ', median ' + fmt(t.median, D) + '.');
    out += '<g class="st-grid">';
    ct.ticks.forEach(function (v) {
      out += '<line x1="' + ml + '" x2="' + r1(ml + pw) + '" y1="' + r1(y(v)) + '" y2="' + r1(y(v)) + '"' + (v === 0 ? ' class="st-base"' : '') + '/>' +
        '<text class="st-tick" x="' + (ml - 6) + '" y="' + r1(y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    });
    out += '</g>';
    bins.forEach(function (b, i) {
      var cx = ml + band * i + band / 2;
      var h = b.count / ct.top * ph;
      var share = n ? util.formatPercent(100 * b.count / n, 1) : '';
      var tip = histLabel(b, i === nb - 1) + ': ' + plural(b.count, 'student') + (share ? ' (' + share + ')' : '') +
        (b.above ? ', including ' + b.above + ' above ' + fmt(b.hi, 2) : '') + (b.below ? ', including ' + b.below + ' below ' + fmt(b.lo, 2) : '');
      out += '<g class="st-mark"><title>' + esc(tip) + '</title>' +
        '<rect class="st-hit" x="' + r1(ml + band * i) + '" y="' + mt + '" width="' + r1(band) + '" height="' + ph + '"/>' +
        (b.count ? '<path class="st-bar" d="' + colPath(cx - bw / 2, mt + ph - h, bw, h) + '"/>' +
          '<text class="st-val" x="' + r1(cx) + '" y="' + r1(mt + ph - h - 5) + '" text-anchor="middle">' + b.count + '</text>' : '') + '</g>';
    });
    // x axis: bin edges
    var every = band < 26 ? Math.ceil(26 / band) : 1;
    out += '<g class="st-axis">';
    for (var i = 0; i <= nb; i++) {
      if (i % every && i !== nb) continue;
      var v = i < nb ? bins[i].lo : bins[nb - 1].hi;
      var xx = ml + band * i;
      out += '<text class="st-tick" x="' + r1(xx) + '" y="' + (mt + ph + 16) + '" text-anchor="middle">' + esc(fmt(v, 1)) + '</text>';
    }
    out += '</g>';
    // average and median lines, labeled on opposite sides so they never collide
    if (finite(t.mean) && finite(t.median)) {
      var meanLeft = t.mean <= t.median;
      out += refLine(xv(t.mean), mt, mt + ph, 'Average ' + fmt(t.mean, D), meanLeft ? 'end' : 'start', ml, ml + pw, 'st-ref st-ref-mean');
      out += refLine(xv(t.median), mt, mt + ph, 'Median ' + fmt(t.median, D), meanLeft ? 'start' : 'end', ml, ml + pw, 'st-ref st-ref-med');
    }
    return out + '</svg>';
  }
  function refLine(x, y1, y2, label, anchor, minX, maxX, cls) {
    var w = textW(label, 11);
    if (anchor === 'end' && x - 4 - w < minX - 6) anchor = 'start';
    if (anchor === 'start' && x + 4 + w > maxX + 8) anchor = 'end';
    var tx = anchor === 'end' ? x - 4 : x + 4;
    return '<g class="' + cls + '"><title>' + esc(label) + '</title><line x1="' + r1(x) + '" x2="' + r1(x) + '" y1="' + (y1 - 14) + '" y2="' + y2 + '"/>' +
      '<text class="st-ref-t" x="' + r1(tx) + '" y="' + (y1 - 18) + '" text-anchor="' + anchor + '">' + esc(label) + '</text></g>';
  }

  // ------------------------------------------------------------------ 4. letter distribution

  function lettersCardHtml(d, W) {
    var c = d.course, p = d.p, sum = d.results.letterSummary || {};
    var seg = '<div class="segmented no-print" role="group" aria-label="Which letters">' +
      '<button type="button" data-act="letters" data-v="effective" aria-pressed="' + (p.letters === 'effective') + '" data-k="letters:effective" title="The final letter where one is assigned, otherwise the suggested letter">Final letters (effective)</button>' +
      '<button type="button" data-act="letters" data-v="suggested" aria-pressed="' + (p.letters === 'suggested') + '" data-k="letters:suggested" title="The letter from the cutoffs in Settings, for every student">Suggested (cutoffs)</button></div>';
    var assigned = finite(sum.assigned) ? sum.assigned : 0, act = finite(sum.active) ? sum.active : d.nActive;
    var sub = '<span class="st-assigned" data-stat="assigned">' + assigned + ' of ' + act + ' final letters assigned</span>' +
      (p.letters === 'effective' ? (assigned < act ? ' · the others show their suggested letter' : '') : ' · showing the cutoff suggestions for everyone') +
      ' ' + ui.placeholderBadge(c, 'letterScale');
    var head = cardHead('st-h-letters', 'Letter grades', sub, seg + tableToggle('letters', 'letters and counts'));
    var rows = Array.isArray(d.letters) ? d.letters : [];
    var passIdx = d.scaleLetters.indexOf(d.passingLetter);
    var body;
    if (!rows.length) body = '<p class="muted">Not available.</p>';
    else if (tables.letters) {
      body = '<div class="table-wrap st-twrap" data-scroll="letters"><table class="table st-table"><caption class="sr-only">Students per letter</caption><thead><tr><th scope="col">Letter</th><th scope="col" class="num">Cutoff</th><th scope="col" class="num">Students</th><th scope="col" class="num">Share</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><th scope="row" class="st-rh">' + esc(r.letter) + (r.inScale === false ? ' <span class="st-qual">(not in the scale)</span>' : '') + '</th><td class="num">' + esc(fmtOr(r.min, d.D)) + '</td><td class="num">' + r.count + '</td><td class="num">' + esc(pctOr(r.pct, 1)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else body = lettersSvg(rows, passIdx, d, W);
    var note = ui.placeholderBadge(c, 'letterScale') ? '<p class="st-cap st-ph-note">' + icon('alert', 'icon-sm') + ' ' + esc(model.placeholderInfo(c, 'letterScale').note) + '</p>' : '';
    var invalid = sum.invalid ? '<p class="st-cap">' + icon('alert', 'icon-sm') + ' ' + plural(sum.invalid, 'final letter is', 'final letters are') + ' not in the current scale (shown at the end).</p>' : '';
    return head + '<div class="card-body">' + body + legendLetters(d) + invalid + note + '</div>';
  }
  function legendLetters(d) {
    if (tables.letters) return '';
    return '<div class="st-legend" aria-hidden="true"><span><i class="st-sw st-sw-bar"></i>' + esc(d.passingLetter || 'Passing letter') + ' or better (passing)</span>' +
      '<span><i class="st-sw st-sw-fail"></i>Below ' + esc(d.passingLetter || 'the passing letter') + '</span></div>';
  }

  function lettersSvg(rows, passIdx, d, W) {
    var H = 250, mt = 22, mr = 8, mb = 44, ml = 30;
    var pw = W - ml - mr, ph = H - mt - mb;
    var n = rows.length;
    var maxC = 0;
    rows.forEach(function (r) { if (r.count > maxC) maxC = r.count; });
    var ct = countTicks(Math.max(1, maxC));
    var band = pw / n;
    var bw = Math.max(2, Math.min(24, band - 6));
    var y = function (c) { return mt + ph - c / ct.top * ph; };
    var showPct = band >= 34;
    var desc = rows.map(function (r) { return r.letter + ' ' + r.count; }).join(', ');
    var out = svgOpen('st-letters-svg', W, H, 'st-svg-letters', 'Students per letter grade (' + (d.p.letters === 'suggested' ? 'suggested letters' : 'final letters where assigned') + ')',
      'In scale order, highest first: ' + desc + '.');
    out += '<g class="st-grid">';
    ct.ticks.forEach(function (v) {
      out += '<line x1="' + ml + '" x2="' + r1(ml + pw) + '" y1="' + r1(y(v)) + '" y2="' + r1(y(v)) + '"' + (v === 0 ? ' class="st-base"' : '') + '/>' +
        '<text class="st-tick" x="' + (ml - 6) + '" y="' + r1(y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    });
    out += '</g>';
    rows.forEach(function (r, i) {
      var cx = ml + band * i + band / 2;
      var h = r.count / ct.top * ph;
      var li = d.scaleLetters.indexOf(r.letter);
      var cls = r.inScale === false || li === -1 ? 'st-bar st-bar-other' : (passIdx !== -1 && li > passIdx ? 'st-bar st-bar-fail' : 'st-bar');
      var tip = r.letter + ': ' + plural(r.count, 'student') + ' (' + pctOr(r.pct, 1) + ')' + (finite(r.min) ? ', cutoff ' + fmt(r.min, d.D) : ', not in the scale');
      out += '<g class="st-mark"><title>' + esc(tip) + '</title>' +
        '<rect class="st-hit" x="' + r1(ml + band * i) + '" y="' + mt + '" width="' + r1(band) + '" height="' + (ph + mb) + '"/>' +
        (r.count ? '<path class="' + cls + '" d="' + colPath(cx - bw / 2, mt + ph - h, bw, h) + '"/>' +
          '<text class="st-val" x="' + r1(cx) + '" y="' + r1(mt + ph - h - 5) + '" text-anchor="middle">' + r.count + '</text>' : '') +
        '<text class="st-xl" x="' + r1(cx) + '" y="' + (mt + ph + 17) + '" text-anchor="middle">' + esc(r.letter) + '</text>' +
        (showPct && r.count ? '<text class="st-tick" x="' + r1(cx) + '" y="' + (mt + ph + 32) + '" text-anchor="middle">' + esc(pctOr(r.pct, 0)) + '</text>' : '') +
        '</g>';
    });
    return out + '</svg>';
  }

  // ------------------------------------------------------------------ 5. per assessment

  function assessHtml(d) {
    var D = d.D, list = Array.isArray(d.perA) ? d.perA : [];
    var head = cardHead('st-h-assess', 'Each assessment', 'Raw scores of active students. Team-graded scores count once for every member; empty scores are left out here (in the total they count as 0).');
    if (!list.length) return head + '<div class="card-body"><p class="muted">No assessments.</p></div>';
    var rows = list.map(function (x) {
      var mp = finite(x.meanPct) ? Math.max(0, Math.min(100, x.meanPct)) : null;
      var of = x.n + (finite(x.missing) ? x.missing : 0);
      return '<tr data-aid="' + esc(x.assessmentId) + '"><th scope="row" class="st-rh"><span class="st-aname">' + esc(x.name) + '</span>' +
        (x.teamGraded ? ' <span class="badge" title="Team-graded: one score per team, copied to every member">team</span>' : '') + '</th>' +
        '<td class="num">' + esc(fmt(x.weight, 2)) + '%</td><td class="num">' + esc(fmt(x.maxScore, D)) + '</td>' +
        '<td class="num st-nowrap">' + x.n + ' of ' + of + (x.missing ? ' <span class="st-qual" title="Active students without a score">(' + x.missing + ' empty)</span>' : '') +
          (x.invalid ? ' <span class="badge badge-warn" title="Text that is not a number; fix it in the Grades tab">' + plural(x.invalid, 'invalid') + '</span>' : '') + '</td>' +
        '<td class="num">' + esc(fmtOr(x.mean, D)) + '</td><td class="num">' + esc(fmtOr(x.median, D)) + '</td>' +
        '<td class="num">' + esc(fmtOr(x.min, D)) + '</td><td class="num">' + esc(fmtOr(x.max, D)) + '</td><td class="num">' + esc(fmtOr(x.sd, D)) + '</td>' +
        '<td class="st-mp">' + (mp !== null ? '<span class="st-ibar" aria-hidden="true"><span style="width:' + r1(mp) + '%"></span></span>' : '') +
          '<span class="num">' + esc(pctOr(x.meanPct, 1)) + '</span></td></tr>';
    }).join('');
    return head + '<div class="card-body st-flush"><div class="table-wrap st-twrap st-noborder" data-scroll="assess"><table class="table st-table st-assess-table">' +
      '<caption class="sr-only">Statistics for each assessment</caption><thead><tr>' +
      '<th scope="col">Assessment</th><th scope="col" class="num">Weight</th><th scope="col" class="num">Max</th>' +
      '<th scope="col" class="num" title="Active students with a score, out of all active students">Entered</th>' +
      '<th scope="col" class="num">Average</th><th scope="col" class="num">Median</th><th scope="col" class="num">Min</th><th scope="col" class="num">Max</th>' +
      '<th scope="col" class="num" title="Standard deviation (sample, n − 1): how spread out the scores are">SD</th>' +
      '<th scope="col" title="The average as a percent of the max score">Average %</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  // ------------------------------------------------------------------ 6. top and bottom

  function perfHtml(d) {
    var tb = d.tb || { top: [], bottom: [] };
    var head = cardHead('st-h-perf', 'Top and bottom performers', 'The ' + TOP_N + ' highest and ' + TOP_N + ' lowest totals among active students. Equal totals share a rank and are listed by name.');
    function list(items, title, id) {
      var rows = (items || []).map(function (it) {
        var s = d.students[it.studentId];
        return '<tr><td class="num st-rank">#' + esc(String(it.rank === null || it.rank === undefined ? '' : it.rank)) + '</td>' +
          '<td><span class="pii st-name">' + esc(nameOf(s)) + '</span>' + (noOf(s) ? ' <span class="st-qual">No ' + esc(noOf(s)) + '</span>' : '') + '</td>' +
          '<td class="num">' + esc(fmtOr(it.total, d.D)) + '</td><td class="st-lt"><span class="st-letter">' + esc(it.letter || DASH) + '</span></td></tr>';
      }).join('');
      return '<div class="st-perf-col"><h3 class="st-sub-h" id="' + id + '">' + esc(title) + '</h3><div class="table-wrap st-twrap"><table class="table st-table st-mini" aria-labelledby="' + id + '">' +
        '<thead><tr><th scope="col" class="num">Rank</th><th scope="col">Name</th><th scope="col" class="num">Total</th><th scope="col">Letter</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="4" class="muted">Nobody</td></tr>') + '</tbody></table></div></div>';
    }
    return head + '<div class="card-body st-perf">' + list(tb.top, 'Top ' + TOP_N + ' (highest first)', 'st-h-top') + list(tb.bottom, 'Bottom ' + TOP_N + ' (lowest first)', 'st-h-bottom') + '</div>';
  }

  // ------------------------------------------------------------------ 7. per team

  function teamsHtml(d, W) {
    var c = d.course, D = d.D, list = Array.isArray(d.teams) ? d.teams : [];
    var head = cardHead('st-h-teams', 'Teams', 'Active members only. The average is of the members\' totals.');
    if (!list.length) return head + '<div class="card-body"><p class="muted">This course has no teams. Add them in Students &amp; Teams.</p></div>';
    var teamA = c.assessments.filter(function (a) { return a.teamGraded; });
    var attOn = list.some(function (t) { return hasOwn(t, 'avgUnexcused'); });
    var withMean = list.filter(function (t) { return finite(t.mean); });
    var chart = withMean.length ? teamSvg(withMean, d, W) : '';
    var rows = list.map(function (t) {
      return '<tr><th scope="row" class="st-rh">' + esc(t.name) + '</th>' +
        '<td class="num">' + t.activeMembers + (t.members !== t.activeMembers ? ' <span class="st-qual" title="Members including withdrawn students">of ' + t.members + '</span>' : '') + '</td>' +
        '<td class="num"><strong>' + esc(fmtOr(t.mean, D)) + '</strong></td>' +
        '<td class="num st-nowrap">' + (finite(t.min) ? esc(fmt(t.min, D)) + ' – ' + esc(fmt(t.max, D)) : DASH) + '</td>' +
        teamA.map(function (a) {
          var v = t.teamScores && hasOwn(t.teamScores, a.id) ? t.teamScores[a.id] : undefined;
          return '<td class="num">' + (t.teamId === null ? '<span class="st-qual">n/a</span>' : finite(v) ? esc(fmt(v, D)) : '<span class="st-qual" title="No team score entered">empty</span>') + '</td>';
        }).join('') +
        '<td class="num">' + (t.overrides ? '<span class="badge badge-warn" title="Members whose team score was changed for them">' + t.overrides + '</span>' : '0') + '</td>' +
        (attOn ? '<td class="num">' + esc(fmtOr(t.avgUnexcused, 1)) + '</td>' : '') + '</tr>';
    }).join('');
    var table = '<div class="table-wrap st-twrap" data-scroll="teams"><table class="table st-table"><caption class="sr-only">Summary per team</caption><thead><tr>' +
      '<th scope="col">Team</th><th scope="col" class="num">Members</th><th scope="col" class="num">Average total</th><th scope="col" class="num">Lowest – highest</th>' +
      teamA.map(function (a) { return '<th scope="col" class="num" title="The team score entered once for the whole team">' + esc(a.name) + ' <span class="st-qual">(team score)</span></th>'; }).join('') +
      '<th scope="col" class="num" title="Per-member overrides of team-graded scores">Overrides</th>' +
      (attOn ? '<th scope="col" class="num" title="Average number of unexcused (not allowed) absences per active member">Avg unexcused absences</th>' : '') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    return head + '<div class="card-body st-teams-body">' + chart + table + '</div>';
  }

  function teamSvg(list, d, W) {
    var D = d.D, avg = d.tDesc.mean;
    var longest = 0;
    list.forEach(function (t) { longest = Math.max(longest, textW(t.name, 12)); });
    var lw = Math.min(140, Math.max(56, Math.ceil(longest) + 10));
    var rowH = 28, bh = 14, mt = 24, mb = 24, mr = 46;
    var H = mt + list.length * rowH + mb;
    var pw = Math.max(80, W - lw - mr);
    var maxV = 100;
    list.forEach(function (t) { if (t.mean > maxV) maxV = Math.ceil(t.mean / 10) * 10; });
    var x = function (v) { return lw + Math.max(0, Math.min(maxV, v)) / maxV * pw; };
    var out = svgOpen('st-team-svg', W, H, 'st-svg-teams', 'Average total per team',
      list.map(function (t) { return t.name + ' ' + fmt(t.mean, D); }).join(', ') + (finite(avg) ? '. Class average ' + fmt(avg, D) + '.' : '.') + ' The table below has the same numbers.');
    var step = valueStep(maxV, pw, 44);
    out += '<g class="st-grid">';
    for (var v = 0; v <= maxV + 1e-9; v += step) {
      out += '<line x1="' + r1(x(v)) + '" x2="' + r1(x(v)) + '" y1="' + mt + '" y2="' + (H - mb) + '"' + (v === 0 ? ' class="st-base"' : '') + '/>' +
        '<text class="st-tick" x="' + r1(x(v)) + '" y="' + (H - mb + 15) + '" text-anchor="middle">' + v + '</text>';
    }
    out += '</g>';
    list.forEach(function (t, i) {
      var yy = mt + i * rowH + (rowH - bh) / 2;
      var w = Math.max(1, x(t.mean) - lw);
      var tip = t.name + ': average ' + fmt(t.mean, D) + ' (' + plural(t.activeMembers, 'active member') + ', lowest ' + fmt(t.min, D) + ', highest ' + fmt(t.max, D) + ')';
      out += '<g class="st-mark"><title>' + esc(tip) + '</title>' +
        '<rect class="st-hit" x="0" y="' + r1(mt + i * rowH) + '" width="' + W + '" height="' + rowH + '"/>' +
        '<text class="st-yl" x="' + (lw - 8) + '" y="' + r1(yy + bh / 2 + 4) + '" text-anchor="end">' + esc(t.name) + '</text>' +
        '<path class="st-bar" d="' + barPath(lw, yy, w, bh) + '"/>' +
        '<text class="st-val" x="' + r1(lw + w + 5) + '" y="' + r1(yy + bh / 2 + 4) + '">' + esc(fmt(t.mean, 1)) + '</text></g>';
    });
    if (finite(avg)) {
      var ax = x(avg);
      out += '<g class="st-ref st-ref-mean"><title>' + esc('Class average ' + fmt(avg, D)) + '</title><line x1="' + r1(ax) + '" x2="' + r1(ax) + '" y1="' + (mt - 6) + '" y2="' + (H - mb) + '"/>' +
        '<text class="st-ref-t" x="' + r1(ax) + '" y="' + (mt - 10) + '" text-anchor="middle">Class average ' + esc(fmt(avg, 1)) + '</text></g>';
    }
    return out + '</svg>';
  }

  // ------------------------------------------------------------------ 8. what-if (ST2)

  function weightedAssessments(course) {
    return course.assessments.filter(function (a) { return (a.weight || 0) > 0 && a.maxScore > 0; });
  }
  function activeByName(d) {
    var list = d.active.map(function (r) { return d.students[r.studentId]; }).filter(Boolean);
    return list.sort(calc.compareByName);
  }
  function defaultAid(d, sid) {
    var list = weightedAssessments(d.course);
    var r = d.results.byId[sid];
    for (var i = 0; i < list.length; i++) {
      var it = r && r.items ? r.items[list[i].id] : null;
      if (!it || it.missing) return list[i].id;
    }
    return list.length ? list[list.length - 1].id : null;
  }
  function defaultLetter(d, sid) {
    var letters = d.scaleLetters, r = d.results.byId[sid];
    var i = r ? letters.indexOf(r.letter) : -1;
    if (i > 0) return letters[i - 1];
    return letters[0] || null;
  }
  function syncWhatIf(d) {
    var students = activeByName(d);
    if (!students.length) return;
    if (!wi.sid || !students.some(function (s) { return s.id === wi.sid; })) {
      wi.sid = students[0].id; wi.aidAuto = true; wi.letterAuto = true;
    }
    var wa = weightedAssessments(d.course);
    if (wi.aidAuto || !wa.some(function (a) { return a.id === wi.aid; })) { wi.aid = defaultAid(d, wi.sid); }
    if (wi.letterAuto || d.scaleLetters.indexOf(wi.letter) === -1) { wi.letter = defaultLetter(d, wi.sid); }
  }

  function whatIfHtml(d) {
    var c = d.course, D = d.D;
    var head = cardHead('st-h-whatif', 'What-if calculator', 'The score a student needs on one assessment to reach a letter grade.');
    var students = activeByName(d), wa = weightedAssessments(c);
    if (!students.length || !wa.length || !d.scaleLetters.length) {
      return head + '<div class="card-body"><p class="muted">' + (!wa.length ? 'No assessment has a weight above 0.' : 'No letter scale.') + '</p></div>';
    }
    var s = d.students[wi.sid], a = model.findAssessment(c, wi.aid), letter = wi.letter;
    var r = d.results.byId[wi.sid];
    var sOpts = students.map(function (x) {
      return '<option value="' + esc(x.id) + '"' + sel(x.id === wi.sid) + '>' + esc((noOf(x) ? 'No ' + noOf(x) + ' · ' : '') + nameOf(x)) + '</option>';
    }).join('');
    var aOpts = wa.map(function (x) {
      var it = r && r.items ? r.items[x.id] : null;
      return '<option value="' + esc(x.id) + '"' + sel(x.id === wi.aid) + '>' + esc(x.name + (it && it.missing ? ' (empty)' : '')) + '</option>';
    }).join('');
    var lOpts = d.scaleLetters.map(function (l) { return '<option value="' + esc(l) + '"' + sel(l === letter) + '>' + esc(l) + '</option>'; }).join('');
    var form = '<div class="st-wi-form">' +
      '<div class="field st-wi-student"><label for="st-wi-s">Student</label><select id="st-wi-s" data-k="wi:sid" data-wi="sid">' + sOpts + '</select></div>' +
      '<div class="field"><label for="st-wi-a">Assessment</label><select id="st-wi-a" data-k="wi:aid" data-wi="aid">' + aOpts + '</select></div>' +
      '<div class="field"><label for="st-wi-l">Target letter</label><select id="st-wi-l" data-k="wi:letter" data-wi="letter">' + lOpts + '</select></div></div>';

    var res = s && a && letter ? calc.neededScore(c, s, a.id, letter) : null;
    var it = r && r.items && a ? r.items[a.id] : null;
    var nowLine = '<p class="st-wi-now">Now: total <strong>' + esc(fmtOr(r ? r.total : null, D)) + '</strong>, suggested letter <strong>' + esc(r ? r.letter || DASH : DASH) + '</strong>' +
      (r && r.finalLetter ? ', final letter <strong>' + esc(r.finalLetter) + '</strong>' : '') +
      (a ? '. Current ' + esc(a.name) + ' score: ' + (it && it.state === 'number' ? '<strong>' + esc(fmt(it.raw, D)) + '</strong> / ' + esc(fmt(a.maxScore, D)) + ' (replaced by the calculation)' : '<strong>empty</strong>') : '') + '.</p>';
    var out;
    if (!res) {
      out = '<div class="st-wi-out st-wi-na" data-wi-out="na">This cannot be calculated for that assessment.</div>';
    } else {
      var shown = ceilTo(res.needed, Math.max(D, 1));
      var listHint = '';
      if (a && model.hasChoices(a) && res.reachable && !res.alreadyReached) {
        var vals = model.choiceValues(a).slice().sort(function (x, y) { return x - y; });
        var pick = vals.filter(function (v) { return v >= res.needed - 1e-9; })[0];
        if (finite(pick)) listHint = ' On the drop-down list: <strong>' + esc(fmt(pick, D)) + '</strong> or more.';
      }
      if (res.alreadyReached) {
        out = '<div class="st-wi-out st-wi-ok" data-wi-out="reached" data-needed="' + res.needed + '">' + icon('check') +
          '<span><strong>Already reached with a 0</strong> on ' + esc(a.name) + ': even a 0 keeps ' + esc(letter) + '.</span></div>';
      } else if (!res.reachable) {
        out = '<div class="st-wi-out st-wi-no" data-wi-out="unreachable" data-needed="' + res.needed + '">' + icon('x') +
          '<span><strong>Not reachable</strong> (would need ' + esc(fmt(shown, Math.max(D, 1))) + ' &gt; ' + esc(fmt(a.maxScore, D)) + ', the max on ' + esc(a.name) + ').</span></div>';
      } else {
        out = '<div class="st-wi-out" data-wi-out="needs" data-needed="' + res.needed + '">' + icon('flag') +
          '<span>Needs <strong class="st-wi-num">' + esc(fmt(shown, Math.max(D, 1))) + '</strong> / ' + esc(fmt(a.maxScore, D)) + ' on ' + esc(a.name) + ' (on time) for ' + esc(letter) + '.' + listHint + '</span></div>';
      }
    }
    var assume = '<p class="st-cap">Assumes the other scores stay as they are (empty ones count as 0), the score is handed in on time (no late penalty), and the current rounding and curve. Nothing is saved.</p>';
    var table = '';
    if (s && a) {
      var trs = d.scaleLetters.map(function (l) {
        var x = calc.neededScore(c, s, a.id, l);
        var min = calc.minTotalForLetter(l, c.settings);
        var cut = (c.settings.letterScale || []).filter(function (row) { return row.letter === l; })[0];
        var txt, cls = '';
        if (!x) { txt = DASH; }
        else if (x.alreadyReached) { txt = 'Reached even with 0'; cls = 'st-ok'; }
        else if (!x.reachable) { txt = 'Not reachable (' + fmt(ceilTo(x.needed, Math.max(D, 1)), Math.max(D, 1)) + ')'; cls = 'st-no'; }
        else txt = fmt(ceilTo(x.needed, Math.max(D, 1)), Math.max(D, 1)) + ' / ' + fmt(a.maxScore, D);
        return '<tr' + (l === letter ? ' class="st-cur"' : '') + '><th scope="row" class="st-rh"><span class="st-letter">' + esc(l) + '</span></th>' +
          '<td class="num">' + esc(cut ? fmt(cut.min, D) : fmtOr(min, D)) + '</td><td class="num ' + cls + '" data-wl="' + esc(l) + '"' + (x ? ' data-needed="' + x.needed + '"' : '') + '>' + esc(txt) + '</td></tr>';
      }).join('');
      table = '<div class="st-wi-table"><h3 class="st-sub-h" id="st-h-wi-all">Score needed on ' + esc(a.name) + ' for every letter</h3>' +
        '<div class="table-wrap st-twrap" data-scroll="wi"><table class="table st-table st-mini" aria-labelledby="st-h-wi-all"><thead><tr><th scope="col">Letter</th><th scope="col" class="num">Total needed</th><th scope="col" class="num">Score needed</th></tr></thead><tbody>' +
        trs + '</tbody></table></div></div>';
    }
    return head + '<div class="card-body st-wi"><div class="st-wi-main">' + form + nowLine + out + assume + '</div>' + table + '</div>';
  }

  // ------------------------------------------------------------------ 9. cutoff planner

  function storedScale(course) {
    return model.normalizeLetterScale(course.settings.letterScale, course.level).map(function (x) { return { letter: x.letter, min: x.min }; });
  }
  function scaleKey(rows) { return JSON.stringify(rows.map(function (x) { return [x.letter, x.min]; })); }
  function freshSandbox(course) {
    var base = storedScale(course);
    return { courseId: course.id, base: base, baseKey: scaleKey(base), rows: base.map(function (x) { return { letter: x.letter, min: x.min }; }), text: {}, err: {}, note: null };
  }
  /** Keeps the sandbox in step with the stored scale: a sandbox nobody edited follows it; edits survive a
   * change made elsewhere (with a note) unless the letters themselves changed. */
  function syncSandbox(course) {
    if (!sb || sb.courseId !== course.id) { sb = freshSandbox(course); return; }
    var cur = storedScale(course);
    var key = scaleKey(cur);
    if (key === sb.baseKey) return;
    var edited = sandboxChanged() || Object.keys(sb.err).length > 0;
    var sameLetters = cur.length === sb.rows.length && cur.every(function (x, i) { return x.letter === sb.rows[i].letter; });
    if (!edited || !sameLetters) {
      sb = freshSandbox(course);
      if (edited) sb.note = 'The letters in Settings changed, so the sandbox was reset to the new scale.';
      return;
    }
    sb.base = cur;
    sb.baseKey = key;
    sb.note = 'The cutoffs in Settings changed while you were editing. Your sandbox edits are kept; "Reset sandbox" loads the new cutoffs.';
  }
  function sandboxChanged() {
    return sb.rows.some(function (x, i) { return !sb.base[i] || x.min !== sb.base[i].min || x.letter !== sb.base[i].letter; });
  }
  function sandboxErrors() { return Object.keys(sb.err).length; }
  function sbValue(i) { return hasOwn(sb.text, i) ? sb.text[i] : fmt(sb.rows[i].min, 4); }
  function sbParse(i, text) {
    var rows = sb.rows;
    var p = util.parseScoreInput(text);
    if (p.kind !== 'number') return { error: 'Enter a number, for example 90.' };
    var v = p.value;
    if (v <= 0) return { error: 'Must be above 0 (only the lowest letter starts at 0).' };
    var above = i > 0 ? rows[i - 1] : null, below = rows[i + 1];
    if (above && v >= above.min) return { error: 'Must be below ' + above.letter + ' (' + fmt(above.min, 4) + ').' };
    if (below && v <= below.min) return { error: 'Must be above ' + below.letter + ' (' + fmt(below.min, 4) + ').' };
    return { value: v };
  }
  function sbSet(i, text) {
    sb.text[i] = text;
    var res = sbParse(i, text);
    if (res.error) sb.err[i] = res.error;
    else { delete sb.err[i]; sb.rows[i].min = res.value; }
    // A neighbour refused because of this row may be fine now.
    Object.keys(sb.err).forEach(function (k) {
      var j = +k;
      if (j === i) return;
      var r2 = sbParse(j, sb.text[j]);
      if (!r2.error) { delete sb.err[j]; sb.rows[j].min = r2.value; }
    });
    // Text that says exactly the stored value needs no override.
    if (!sb.err[i] && util.parseScoreInput(text).value === sb.rows[i].min && String(text).trim() === fmt(sb.rows[i].min, 4)) delete sb.text[i];
  }

  function plannerData(course, results) {
    var simRes = call('simulate', [course, results, sb.rows], null);
    var sim = simRes && Array.isArray(simRes.students) ? simRes : null;
    var nowDist = call('letterDistribution', [course, results], []);
    var nowCount = {}, sbCount = {};
    (nowDist || []).forEach(function (x) { nowCount[x.letter] = x.count; });
    ((sim && sim.distribution) || []).forEach(function (x) { sbCount[x.letter] = x.count; });
    var changedCutoffs = sb.rows.filter(function (x, i) { return sb.base[i] && x.min !== sb.base[i].min; }).map(function (x) {
      var i = sb.rows.indexOf(x);
      return { letter: x.letter, from: sb.base[i].min, to: x.min };
    });
    return {
      sim: sim,
      students: sim ? sim.students : [],
      changes: sim ? sim.changes || [] : [],
      finalChanges: sim && sim.finalChanges ? sim.finalChanges : { onlyEmpty: 0, all: 0 },
      nowCount: nowCount,
      sbCount: sbCount,
      changedCutoffs: changedCutoffs,
      errors: sandboxErrors()
    };
  }

  function renderPlanner(d, W) {
    var pd = plannerData(d.course, d.results);
    setHtmlKeep(dom.plHead, plannerHeadHtml(d));
    setHtmlKeep(dom.plSum, plannerSumHtml(d, pd));
    setHtmlKeep(dom.plPlot, plannerPlotHtml(d, pd, W));
    setHtmlKeep(dom.plChanges, plannerChangesHtml(d, pd));
    setHtmlKeep(dom.plSide, plannerSideHtml(d, pd));
  }

  /** Live update while a sandbox cutoff is typed: only the planner is redrawn. */
  function liveUpdatePlanner() {
    var course = GT.store.course(), results = GT.store.results();
    if (!course || !results || !dom || shellKind !== 'main' || !sb) return;
    var d = compute(course, results);
    var W = dom.plPlot.clientWidth > 0 ? Math.max(220, dom.plPlot.clientWidth) : 700;
    renderPlanner(d, W);
  }

  function plannerHeadHtml(d) {
    var c = d.course;
    return cardHead('st-h-planner', 'Cutoff planner',
      'Try letter cutoffs on a copy of the scale (the sandbox) and see who would get which letter. Nothing is saved until you click a button below. ' +
      'The planner uses each student\'s total, the same value as the suggested letter.', ui.placeholderBadge(c, 'letterScale'));
  }

  function plannerSumHtml(d, pd) {
    var parts = [];
    if (sb.note) parts.push('<div class="callout st-callout">' + icon('info') + ' ' + esc(sb.note) + '</div>');
    var line;
    if (pd.errors) line = '<span class="st-pl-state st-pl-err">' + icon('alert') + 'Fix the highlighted cutoff to see the result.</span>';
    else if (!pd.changedCutoffs.length) line = '<span class="st-pl-state">' + icon('info') + 'The sandbox matches the cutoffs in Settings. Change a cutoff on the right to try it out.</span>';
    else {
      line = '<span class="st-pl-state st-pl-chg">' + icon('edit') + '<strong>' + plural(pd.changedCutoffs.length, 'cutoff') + ' changed</strong> · ' +
        '<strong data-stat="plChanges">' + plural(pd.changes.length, 'student') + '</strong> would get a different letter than now</span>';
    }
    parts.push('<p class="st-pl-line">' + line + '</p>');
    return parts.join('');
  }

  function plannerPlotHtml(d, pd, W) {
    var students = pd.students.filter(function (x) { return finite(x.total); });
    if (!students.length) return '<p class="muted">No totals to plot.</p>';
    var toggle = '<div class="st-pl-tools">' + tableToggle('strip', 'every student with the letter now and in the sandbox') + '</div>';
    if (tables.strip) {
      var rows = students.map(function (x, i) {
        var s = d.students[x.studentId];
        return '<tr' + (x.changed ? ' class="st-chg"' : '') + '><td class="num">' + (i + 1) + '</td><td class="num">' + esc(noOf(s)) + '</td><td><span class="pii">' + esc(nameOf(s)) + '</span></td>' +
          '<td class="num">' + esc(fmt(x.total, d.D)) + '</td><td>' + esc(x.current || DASH) + (x.finalLetter ? ' <span class="st-qual">final</span>' : '') + '</td><td><strong>' + esc(x.simulated || DASH) + '</strong></td></tr>';
      }).join('');
      return toggle + '<div class="table-wrap st-twrap st-tall" data-scroll="strip"><table class="table st-table"><caption class="sr-only">Every active student, highest total first</caption><thead><tr>' +
        '<th scope="col" class="num">#</th><th scope="col" class="num">No</th><th scope="col">Name</th><th scope="col" class="num">Total</th><th scope="col">Letter now</th><th scope="col">Sandbox</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }
    return toggle + stripSvg(d, pd, students, W) + stripLegend(pd) + gapChips(d);
  }

  function stripLegend(pd) {
    return '<div class="st-legend" aria-hidden="true">' +
      '<span><i class="st-sw st-sw-dot"></i>One student</span>' +
      '<span><i class="st-sw st-sw-ring"></i>Letter would change</span>' +
      '<span><i class="st-sw st-sw-line"></i>Cutoff in Settings</span>' +
      (pd.changedCutoffs.length ? '<span><i class="st-sw st-sw-dash"></i>Sandbox cutoff</span>' : '') +
      '<span><i class="st-sw st-sw-gap"></i>Gap of 1 point or more with nobody in it</span></div>';
  }

  function gapChips(d) {
    var g = (Array.isArray(d.gaps) ? d.gaps : []).slice(0, 5);
    if (!g.length) return '<p class="st-cap">No gap of 1 point or more between neighbouring totals.</p>';
    return '<div class="st-gaps"><span class="st-gaps-l">Largest gaps between neighbouring totals:</span>' + g.map(function (x) {
      return '<span class="chip" title="' + esc('Nobody has a total between ' + fmt(x.below, d.D) + ' and ' + fmt(x.above, d.D) + '. A cutoff placed here (for example ' + fmt(x.mid, d.D) + ') splits the class cleanly' + (finite(x.countAbove) ? ': ' + x.countAbove + ' students above it.' : '.')) + '">' +
        esc(fmt(x.below, d.D)) + ' → ' + esc(fmt(x.above, d.D)) + ' <strong>(' + esc(fmt(x.gap, d.D)) + ')</strong></span>';
    }).join('') + '<span class="st-cap">A cutoff placed inside a gap separates students cleanly: nobody is just below it.</span></div>';
  }

  function stripSvg(d, pd, students, W) {
    var D = d.D;
    var vals = students.map(function (x) { return x.total; });
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var lo = Math.max(0, Math.floor(mn) - 2), hi = Math.ceil(mx) + 2;
    if (hi - lo < 12) { var extra = 12 - (hi - lo); lo = Math.max(0, lo - Math.ceil(extra / 2)); hi = lo + Math.max(12, hi - lo); }
    var ml = 12, mr = 14, pw = W - ml - mr;
    var x = function (v) { return ml + (v - lo) / (hi - lo) * pw; };
    var R = 4.5, rowH = 2 * R + 2;
    // Beeswarm: dots that would overlap stack up and down from the centre line.
    var sorted = students.slice().sort(function (a, b) { return a.total - b.total; });
    var lastAt = {}, maxLv = 0;
    sorted.forEach(function (p) {
      var px = x(p.total);
      for (var k = 0; k < 400; k++) {
        var lv = k === 0 ? 0 : (k % 2 ? (k + 1) / 2 : -k / 2);
        if (lastAt[lv] === undefined || px - lastAt[lv] >= 2 * R + 1) { lastAt[lv] = px; p.__lv = lv; p.__x = px; break; }
      }
      if (Math.abs(p.__lv) > maxLv) maxLv = Math.abs(p.__lv);
    });
    var mt = 40, plotH = Math.max(70, (2 * maxLv + 1) * rowH + 20);
    var y0 = mt + plotH / 2, axisY = mt + plotH;
    var hasSb = pd.changedCutoffs.length > 0 && !pd.errors;
    var H = axisY + (hasSb ? 44 : 26);
    var out = svgOpen('st-strip-svg', W, H, 'st-svg-strip', 'Every active student\'s total with the letter cutoffs',
      students.length + ' dots, one per active student, from ' + fmt(mn, D) + ' to ' + fmt(mx, D) + '. Vertical lines mark the cutoffs' +
      (hasSb ? '; dashed lines the sandbox cutoffs' : '') + '. Shaded areas are the largest gaps between neighbouring totals.');
    // gaps
    (Array.isArray(d.gaps) ? d.gaps : []).slice(0, MAX_GAPS).forEach(function (g) {
      if (g.above < lo || g.below > hi) return;
      var x1 = x(Math.max(lo, g.below)), x2 = x(Math.min(hi, g.above));
      out += '<g class="st-gapg"><title>' + esc('Gap: nobody between ' + fmt(g.below, D) + ' and ' + fmt(g.above, D) + ' (' + fmt(g.gap, D) + ' points)') + '</title>' +
        '<rect class="st-gap" x="' + r1(x1) + '" y="' + mt + '" width="' + r1(Math.max(1, x2 - x1)) + '" height="' + plotH + '"/></g>';
    });
    // axis
    var step = valueStep(hi - lo, pw, 40);
    out += '<g class="st-axis"><line class="st-base" x1="' + ml + '" x2="' + r1(ml + pw) + '" y1="' + axisY + '" y2="' + axisY + '"/>';
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      out += '<line class="st-tickm" x1="' + r1(x(v)) + '" x2="' + r1(x(v)) + '" y1="' + axisY + '" y2="' + (axisY + 4) + '"/>' +
        '<text class="st-tick" x="' + r1(x(v)) + '" y="' + (axisY + 16) + '" text-anchor="middle">' + esc(fmt(v, 1)) + '</text>';
    }
    out += '</g>';
    // current cutoffs (solid) with letter labels above, in two rows when they crowd
    var ends = [-Infinity, -Infinity];
    sb.base.forEach(function (row, i) {
      if (i === sb.base.length - 1 || row.min < lo || row.min > hi) return;
      var lx = x(row.min);
      var w = textW(row.letter, 11) + 2;
      var lr = lx + 3 >= ends[0] + 3 ? 0 : (lx + 3 >= ends[1] + 3 ? 1 : -1);
      if (lr !== -1) ends[lr] = lx + 3 + w;
      out += '<g class="st-cut"><title>' + esc(row.letter + ' starts at ' + fmt(row.min, D) + ' (cutoff in Settings)') + '</title>' +
        '<line x1="' + r1(lx) + '" x2="' + r1(lx) + '" y1="' + (lr === 1 ? mt - 22 : mt - 10) + '" y2="' + axisY + '"/>' +
        (lr !== -1 ? '<text class="st-cut-t" x="' + r1(lx + 3) + '" y="' + (lr === 1 ? mt - 24 : mt - 12) + '">' + esc(row.letter) + '</text>' : '') + '</g>';
    });
    // sandbox cutoffs that differ (dashed), labelled under the axis
    if (hasSb) {
      var sEnd = -Infinity;
      sb.rows.forEach(function (row, i) {
        if (i === sb.rows.length - 1 || !sb.base[i] || row.min === sb.base[i].min || row.min < lo || row.min > hi) return;
        var lx = x(row.min);
        var label = row.letter + ' ' + fmt(row.min, D);
        var w = textW(label, 11);
        var showL = lx - w / 2 > sEnd + 4;
        if (showL) sEnd = lx + w / 2;
        out += '<g class="st-sbcut"><title>' + esc(row.letter + ' would start at ' + fmt(row.min, D) + ' (sandbox; now ' + fmt(sb.base[i].min, D) + ')') + '</title>' +
          '<line x1="' + r1(lx) + '" x2="' + r1(lx) + '" y1="' + (mt - 4) + '" y2="' + (axisY + 22) + '"/>' +
          (showL ? '<text class="st-sbcut-t" x="' + r1(lx) + '" y="' + (axisY + 36) + '" text-anchor="middle">' + esc(label) + '</text>' : '') + '</g>';
      });
    }
    // dots
    sorted.forEach(function (p) {
      var s = d.students[p.studentId];
      var cy = y0 - p.__lv * rowH;
      var tip = tipName(s) + ': ' + fmt(p.total, D) + ' — now ' + (p.current || DASH) + (p.finalLetter ? ' (final)' : '') +
        (p.changed ? ', sandbox ' + (p.simulated || DASH) : '');
      out += '<g class="st-dot' + (p.changed ? ' st-dot-chg' : '') + '"><title>' + esc(tip) + '</title>' +
        '<circle class="st-hit" cx="' + r1(p.__x) + '" cy="' + r1(cy) + '" r="9"/>' +
        (p.changed ? '<circle class="st-ring" cx="' + r1(p.__x) + '" cy="' + r1(cy) + '" r="' + (R + 2.5) + '"/>' : '') +
        '<circle class="st-dotc" cx="' + r1(p.__x) + '" cy="' + r1(cy) + '" r="' + R + '"/></g>';
    });
    return out + '</svg>';
  }

  function plannerChangesHtml(d, pd) {
    if (pd.errors) return '';
    var list = pd.changes;
    if (!list.length) return '';
    var rows = list.map(function (x) {
      var s = d.students[x.studentId];
      return '<tr><td class="num">' + esc(noOf(s)) + '</td><td><span class="pii">' + esc(nameOf(s)) + '</span></td><td class="num">' + esc(fmt(x.total, d.D)) + '</td>' +
        '<td class="st-nowrap"><span class="st-letter">' + esc(x.current || DASH) + '</span>' + (x.finalLetter ? ' <span class="st-qual">final</span>' : '') +
        ' → <span class="st-letter st-letter-new">' + esc(x.simulated || DASH) + '</span></td></tr>';
    }).join('');
    return '<h3 class="st-sub-h" id="st-h-plchg">Students whose letter would change (' + list.length + ')</h3>' +
      '<div class="table-wrap st-twrap st-tall" data-scroll="plchg"><table class="table st-table st-mini" aria-labelledby="st-h-plchg"><thead><tr><th scope="col" class="num">No</th><th scope="col">Name</th><th scope="col" class="num">Total</th><th scope="col">Now → sandbox</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function plannerSideHtml(d, pd) {
    var D = d.D;
    var rows = sb.rows.map(function (x, i) {
      var last = i === sb.rows.length - 1;
      var base = sb.base[i] ? sb.base[i].min : null;
      var err = sb.err[i];
      var changed = !err && base !== null && x.min !== base;
      var input = last
        ? '<span class="st-fixed" title="The lowest letter always starts at 0">0 <span class="st-qual">(fixed)</span></span>'
        : '<input type="text" inputmode="decimal" class="st-sbin' + (err ? ' is-invalid' : '') + (changed ? ' st-sbin-chg' : '') + '" value="' + esc(sbValue(i)) + '" data-sb="' + i + '" data-k="sb:' + i + '"' +
          ' aria-label="' + esc('Sandbox cutoff for ' + x.letter) + '"' + (err ? ' aria-invalid="true" aria-describedby="st-sberr-' + i + '"' : '') + ' autocomplete="off" spellcheck="false">' +
          (err ? '<span class="st-sberr" id="st-sberr-' + i + '" role="alert">' + esc(err) + '</span>' : '');
      var nowN = hasOwn(pd.nowCount, x.letter) ? pd.nowCount[x.letter] : 0;
      var sbN = pd.errors ? null : (hasOwn(pd.sbCount, x.letter) ? pd.sbCount[x.letter] : 0);
      var delta = sbN === null ? '' : sbN - nowN;
      return '<tr' + (changed ? ' class="st-chg"' : '') + '><th scope="row" class="st-rh"><span class="st-letter">' + esc(x.letter) + '</span></th>' +
        '<td class="num">' + esc(fmtOr(base, D)) + '</td><td class="st-sbcell">' + input + '</td>' +
        '<td class="num st-nowrap" data-sbcnt="' + i + '">' + nowN + ' → <strong>' + (sbN === null ? '?' : sbN) + '</strong>' +
          (delta ? ' <span class="st-delta ' + (delta > 0 ? 'up' : 'down') + '">' + (delta > 0 ? '+' : MINUS) + Math.abs(delta) + '</span>' : '') + '</td></tr>';
    }).join('');
    var canApply = !pd.errors && pd.changedCutoffs.length > 0;
    var canFinal = !pd.errors && pd.students.length > 0;
    var fc = pd.finalChanges;
    return '<h3 class="st-sub-h" id="st-h-sb">Sandbox scale</h3>' +
      '<p class="st-cap">Type a new cutoff (the lowest total for that letter). <kbd>↑</kbd>/<kbd>↓</kbd> move it by 0.5 (with <kbd>Shift</kbd>: 0.1).</p>' +
      '<div class="table-wrap st-twrap" data-scroll="sb"><table class="table st-table st-sbtable" aria-labelledby="st-h-sb"><thead><tr><th scope="col">Letter</th><th scope="col" class="num">Now</th><th scope="col">Sandbox</th><th scope="col" class="num" title="Students with this letter now → with the sandbox cutoffs">Students</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      '<div class="st-sb-actions no-print">' +
        '<button type="button" class="btn btn-sm" data-act="sb-reset" data-k="act:sb-reset"' + (sandboxChanged() || sandboxErrors() || sb.note ? '' : ' disabled') + '>' + icon('undo') + 'Reset sandbox</button>' +
        '<button type="button" class="btn btn-sm" data-act="sb-apply" data-k="act:sb-apply"' + (canApply ? '' : ' disabled') + ' title="Save the sandbox cutoffs as the course\'s cutoffs. This changes only the suggested letters.">' + icon('settings') + 'Apply cutoffs to Settings…</button>' +
        '<button type="button" class="btn btn-sm btn-primary" data-act="sb-final" data-k="act:sb-final"' + (canFinal ? '' : ' disabled') + ' title="Write each student\'s sandbox letter into their final letter (one undo step)">' + icon('check') + 'Use these as final letters…</button>' +
      '</div>' +
      '<p class="st-cap">"Apply cutoffs" changes only the <strong>suggested</strong> letters; the cutoffs stay marked "needs confirmation" until you confirm them in Settings. ' +
      '"Use these as final letters" fills final letters (' + plural(fc.onlyEmpty || 0, 'student') + ' without one' + (fc.all !== fc.onlyEmpty ? ', or ' + (fc.all || 0) + ' changes for everyone' : '') + '). Both can be undone with Ctrl+Z.</p>';
  }

  // ------------------------------------------------------------------ planner actions

  function applyCutoffs() {
    var course = GT.store.course(), results = GT.store.results();
    if (!course || !sb || sandboxErrors() || !sandboxChanged()) return;
    var courseId = course.id;
    var rows = sb.rows.map(function (x) { return { letter: x.letter, min: x.min }; });
    var sug = call('simulate', [course, results, rows, { letters: 'suggested' }], null);
    var nSug = sug && Array.isArray(sug.changes) ? sug.changes.length : null;
    var list = sb.rows.map(function (x, i) {
      if (!sb.base[i] || x.min === sb.base[i].min) return '';
      return '<li><strong>' + esc(x.letter) + '</strong>: ' + esc(fmt(sb.base[i].min, 4)) + ' → <strong>' + esc(fmt(x.min, 4)) + '</strong></li>';
    }).join('');
    var fin = model.isFinalized(course) ? '<div class="callout">' + icon('lock') + ' Scores are finalized: this changes the suggested letters only, never a score.</div>' : '';
    ui.dialog.confirm({
      title: 'Apply these cutoffs to Settings?',
      messageHtml: '<p>The course\'s letter cutoffs become:</p><ul class="st-dlg-list">' + list + '</ul>' +
        (nSug !== null ? '<p><strong>' + plural(nSug, 'student') + '</strong> get a different <strong>suggested</strong> letter. Final letters already chosen are not changed.</p>' : '') +
        '<div class="callout callout-warn">The cutoffs stay marked <strong>needs confirmation</strong> until you confirm them in Settings.</div>' + fin +
        '<p class="muted small">One step: undo it with Ctrl+Z.</p>',
      confirmText: 'Apply cutoffs'
    }).then(function (ok) {
      if (!ok) return;
      try {
        GT.store.transact('Apply cutoffs from the planner', function (c) {
          var simC = call('simulate', [c, null, rows], null);
          c.settings.letterScale = simC && Array.isArray(simC.scale) && simC.scale.length
            ? simC.scale.map(function (x) { return { letter: x.letter, min: x.min }; })
            : model.normalizeLetterScale(rows, c.level);
          c.settings.passingLetter = model.passingLetterFor(c.settings.letterScale, c.settings.passingLetter, c.level);
        }, { courseId: courseId });
      } catch (e) { ui.toast('Not saved: ' + (e && e.message ? e.message : String(e)), { type: 'error' }); return; }
      sb = null; // the next render copies the new stored scale
      ui.toast('Cutoffs applied. The suggested letters use them now.', { type: 'success', action: { label: 'Undo', fn: function () { GT.store.undo(); } } });
    });
  }

  function useAsFinal() {
    var course = GT.store.course(), results = GT.store.results();
    if (!course || !results || !sb || sandboxErrors()) return;
    var courseId = course.id;
    var rows = sb.rows.map(function (x) { return { letter: x.letter, min: x.min }; });
    var sim = call('simulate', [course, results, rows], null);
    var fc = sim && sim.finalChanges ? sim.finalChanges : null;
    var onlyEmptyItems = call('lettersFromScale', [course, results, rows, { onlyEmpty: true }], []);
    var allItems = call('lettersFromScale', [course, results, rows], []);
    var byId = {};
    course.students.forEach(function (s) { byId[s.id] = s; });
    function changing(items) { return items.filter(function (it) { return model.finalLetterOf(byId[it.studentId]) !== it.letter; }).length; }
    var nEmpty = fc ? fc.onlyEmpty : changing(onlyEmptyItems);
    var nAll = fc ? fc.all : changing(allItems);
    var replaced = nAll - nEmpty;
    var unconfirmed = !model.isConfirmed(course, 'letterScale');
    function label(n) { return n ? 'Set ' + plural(n, 'final letter') : 'Nothing to change'; }
    var html = '<p>Write the letter each active student gets with the <strong>sandbox cutoffs</strong> into their <strong>final letter</strong>. You can still change any letter afterwards.</p>' +
      '<fieldset class="st-choices"><legend class="sr-only">Which students</legend>' +
      '<label class="st-choice"><input type="radio" name="st-uf" value="empty" checked data-n="' + nEmpty + '"><span><strong>Only students without a final letter</strong> (recommended)' +
        '<span class="st-choice-help">' + plural(nEmpty, 'student') + ' get a final letter. Letters already chosen stay as they are.</span></span></label>' +
      '<label class="st-choice"><input type="radio" name="st-uf" value="all" data-n="' + nAll + '"><span><strong>All active students</strong>' +
        '<span class="st-choice-help">' + plural(nAll, 'final letter') + ' would change' + (replaced ? ', including <strong>' + replaced + '</strong> already chosen by hand, which would be replaced' : '') + '.</span></span></label>' +
      '</fieldset><p class="muted small">Withdrawn students are skipped. This is one step: Ctrl+Z (or Undo) reverses it.</p>' +
      (unconfirmed ? '<div class="callout callout-warn">The cutoffs are placeholders that still need confirmation, so check the letters with the instructor.</div>' : '');
    ui.dialog.open({
      title: 'Use these as final letters?',
      bodyHtml: html,
      buttons: [
        { text: 'Cancel', value: null },
        {
          text: label(nEmpty), primary: true,
          validate: function (dlg) {
            var r = dlg.querySelector('input[name="st-uf"]:checked');
            return r && +r.getAttribute('data-n') > 0 ? null : 'No final letter would change with this choice.';
          },
          value: function (dlg) { var r = dlg.querySelector('input[name="st-uf"]:checked'); return r ? r.value : 'empty'; }
        }
      ],
      onMount: function (dlg) {
        var btn = dlg.querySelector('.dlg-foot .btn-primary');
        dlg.addEventListener('change', function (e) {
          if (e.target && e.target.name === 'st-uf' && btn) btn.textContent = label(+e.target.getAttribute('data-n'));
        });
      },
      initialFocus: 'input[name="st-uf"]:checked'
    }).then(function (choice) {
      if (choice !== 'empty' && choice !== 'all') return;
      var out = null;
      try {
        GT.store.transact(choice === 'empty' ? 'Use planner letters as final letters (students without one)' : 'Use planner letters as final letters (all active students)', function (c) {
          var items = GT.stats.lettersFromScale(c, calc.computeCourse(c), rows, { onlyEmpty: choice === 'empty' });
          out = model.setFinalLetters(c, items);
        }, { courseId: courseId });
      } catch (e) { ui.toast('Not saved: ' + (e && e.message ? e.message : String(e)), { type: 'error' }); return; }
      var n = out ? out.changed : 0;
      ui.toast(n ? plural(n, 'final letter') + ' set from the planner. Press Ctrl+Z to undo.' : 'No final letter was changed.',
        { type: n ? 'success' : 'info', timeout: 7000, action: n ? { label: 'Undo', fn: function () { GT.store.undo(); } } : null });
    });
  }

  // ------------------------------------------------------------------ 10. borderline

  function borderHtml(d) {
    var D = d.D, list = Array.isArray(d.border) ? d.border : [];
    var shown = withinText !== null ? withinText : fmt(d.p.within, 2);
    var bad = withinText !== null;
    var tools = '<div class="st-within"><label for="st-within">Within</label><input id="st-within" type="text" inputmode="decimal" class="st-within-in' + (bad ? ' is-invalid' : '') +
      '" value="' + esc(shown) + '" data-k="within" autocomplete="off" spellcheck="false" aria-describedby="st-within-help"' + (bad ? ' aria-invalid="true"' : '') + '>' +
      '<span id="st-within-help">points below the next letter</span></div>';
    var head = cardHead('st-h-border', 'Borderline students', 'Students just below the next letter\'s cutoff, where a small regrade or one participation step could change the letter.', tools);
    var err = bad ? '<p class="st-sberr" role="alert">Enter a number above 0 and up to 20, for example 1 or 0.5.</p>' : '';
    if (!list.length) {
      return head + '<div class="card-body">' + err + '<p class="muted st-none">' + icon('check') + ' No active student is within ' + esc(fmt(d.p.within, 2)) + ' ' + (d.p.within === 1 ? 'point' : 'points') + ' below the next letter.</p></div>';
    }
    var rows = list.map(function (x) {
      var s = d.students[x.studentId];
      return '<tr><td class="num">' + esc(noOf(s)) + '</td><td><span class="pii">' + esc(nameOf(s)) + '</span></td>' +
        '<td class="num">' + esc(fmt(x.total, D)) + (finite(x.totalUnrounded) && x.totalUnrounded !== x.total ? ' <span class="st-qual" title="Before rounding">(' + esc(fmt(x.totalUnrounded, 4)) + ')</span>' : '') + '</td>' +
        '<td><span class="st-letter">' + esc(x.letter || DASH) + '</span>' + (x.finalAtOrAboveNext ? ' <span class="badge badge-success" title="A final letter at or above the next letter is already set">raised</span>' : '') + '</td>' +
        '<td><span class="st-letter">' + esc(x.nextLetter || DASH) + '</span>' + (finite(x.cutoff) ? ' <span class="st-qual">from ' + esc(fmt(x.cutoff, D)) + '</span>' : '') + '</td>' +
        '<td class="num"><strong>+' + esc(fmt(ceilTo(x.gap, Math.max(D, 2)), Math.max(D, 2))) + '</strong></td></tr>';
    }).join('');
    return head + '<div class="card-body">' + err + '<div class="table-wrap st-twrap" data-scroll="border"><table class="table st-table"><caption class="sr-only">Borderline students, closest first</caption><thead><tr>' +
      '<th scope="col" class="num">No</th><th scope="col">Name</th><th scope="col" class="num">Total</th><th scope="col">Letter now</th><th scope="col">Next letter</th>' +
      '<th scope="col" class="num" title="Points still needed to reach the next letter (with the course\'s rounding)">Points short</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="st-cap">"Points short" counts from the total before rounding, so the course\'s rounding mode is taken into account.</p></div>';
  }

  // ------------------------------------------------------------------ events

  function jumpTo(id) {
    var t = boundEl && boundEl.querySelector('#' + cssEsc(id));
    if (!t) return;
    try { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { t.scrollIntoView(); }
    var h = t.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e2) { h.focus(); } }
  }

  function onClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !boundEl.contains(b) || b.disabled) return;
    var act = b.getAttribute('data-act');
    if (act === 'print') { root.print(); return; }
    if (act === 'jump') { jumpTo(b.getAttribute('data-to')); return; }
    if (act === 'goto-students') { if (GT.app) GT.app.navigate('students'); return; }
    if (act === 'load-sample') { if (GT.app && GT.app.actions && GT.app.actions.loadSample) GT.app.actions.loadSample(); return; }
    if (act === 'goto-settings') { if (GT.app) GT.app.navigate('settings', { placeholder: b.getAttribute('data-ph') }); return; }
    if (act === 'bins') { setPrefs({ binWidth: b.getAttribute('data-v') === '5' ? 5 : 10 }); return; }
    if (act === 'letters') { setPrefs({ letters: b.getAttribute('data-v') === 'suggested' ? 'suggested' : 'effective' }); return; }
    if (act === 'table') { var ch = b.getAttribute('data-chart'); tables[ch] = !tables[ch]; rerender(); return; }
    if (act === 'sb-reset') { var c = GT.store.course(); if (c) { sb = freshSandbox(c); liveUpdatePlanner(); } return; }
    if (act === 'sb-apply') { applyCutoffs(); return; }
    if (act === 'sb-final') { useAsFinal(); return; }
  }

  function onChange(e) {
    var t = e.target;
    if (t.id === 'st-measure') { measure = t.value || 'total'; rerender(); return; }
    var w = t.getAttribute && t.getAttribute('data-wi');
    if (w) {
      if (w === 'sid') { wi.sid = t.value; wi.aidAuto = true; wi.letterAuto = true; }
      else if (w === 'aid') { wi.aid = t.value; wi.aidAuto = false; }
      else if (w === 'letter') { wi.letter = t.value; wi.letterAuto = false; }
      rerender();
      return;
    }
    if (t.id === 'st-within') { commitWithin(t); return; }
  }

  function onInput(e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-sb') && sb) {
      sbSet(+t.getAttribute('data-sb'), t.value);
      liveUpdatePlanner();
    }
  }

  function onKeyDown(e) {
    var t = e.target;
    if (t.hasAttribute && t.hasAttribute('data-sb') && sb && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      var i = +t.getAttribute('data-sb');
      var step = e.shiftKey ? 0.1 : 0.5;
      var base = sb.err[i] ? util.parseScoreInput(t.value) : { kind: 'number', value: sb.rows[i].min };
      var cur = base.kind === 'number' ? base.value : sb.rows[i].min;
      var next = util.fix(cur + (e.key === 'ArrowUp' ? step : -step));
      if (next <= 0) return;
      t.value = fmt(next, 4);
      sbSet(i, t.value);
      liveUpdatePlanner();
      return;
    }
    if (t.id === 'st-within' && e.key === 'Enter') { e.preventDefault(); commitWithin(t); }
  }

  function commitWithin(t) {
    var p = util.parseScoreInput(t.value);
    if (p.kind !== 'number' || !(p.value > 0) || p.value > 20) { withinText = t.value; rerender(); return; }
    withinText = null;
    if (p.value === prefs().within) { rerender(); return; }
    setPrefs({ within: p.value });
  }

  function onToggle(e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('st-guide')) return;
    if (t.open !== prefs().guide) setPrefs({ guide: t.open });
  }

  // ------------------------------------------------------------------ register

  GT.views.stats = {
    id: 'stats',
    title: 'Statistics',
    render: render,
    destroy: destroy,
    /** Diagnostics for tests: duration of the last full render in ms. */
    lastRenderMs: function () { return lastRenderMs; },
    /** For tests: the planner sandbox scale (a copy), or null. */
    sandbox: function () { return sb ? sb.rows.map(function (x) { return { letter: x.letter, min: x.min }; }) : null; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
