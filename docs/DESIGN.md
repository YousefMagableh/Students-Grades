# Grade Tracker — design and module contract

This document is the contract every module follows. Requirement IDs (R1, K4, G5 …) refer to
`docs/REQUIREMENTS.md`.

## 1. Runtime constraints

- Opened from disk (`file://`). **No ES modules** (Chrome blocks module scripts on `file://`).
  Every file is a classic script loaded by a `<script>` tag in `index.html`, in dependency order.
- One global namespace: `window.GT`. Core modules attach `GT.util`, `GT.model`, `GT.calc`, …;
  UI modules attach under `GT.ui.*` (shared widgets) and `GT.views.*` (tab views).
- No network: no `fetch`, no XHR, no remote URLs anywhere. `index.html` carries a CSP meta tag with
  `connect-src 'none'; font-src 'none'; img-src data: blob:; object-src 'none'; frame-src 'none';
  worker-src 'none'; form-action 'none'; base-uri 'none'`. Fonts are system font stacks only.
- ExcelJS (`vendor/exceljs.min.js`, MIT, v4.4.0) is loaded on demand by inserting a classic
  `<script src="vendor/exceljs.min.js">` element (`GT.ui.loadExcel()` returns a Promise of `window.ExcelJS`).
- Browsers: current Chrome/Edge/Firefox/Safari. Only Chromium is exercised by the automated e2e test.

### 1.1 Core module pattern (runs in browser and Node)

```js
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var util = isNode ? require('./util.js') : root.GT.util;   // dependencies
  var api = { /* … */ };
  if (isNode) module.exports = api; else (root.GT = root.GT || {}).calc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

Core modules (`js/core/*.js`) never touch `window`, `document`, `localStorage`, `Date.now()` for
logic that tests depend on (timestamps are passed in or taken from `util.nowIso()`), or the DOM.
ES2017 syntax is fine (const/let, arrow functions, template strings, spread). No optional chaining
requirements beyond what Node 22 and current browsers support (optional chaining is fine).

### 1.2 File layout

```
index.html                  shell markup, CSP, script tags
css/base.css                design tokens (light/dark), typography, components
css/<view>.css              per-view styles
js/core/util.js             numbers, rounding, ids, dates, names, escaping
js/core/model.js            schema, defaults, templates, placeholders, normalize/migrate, backup validation
js/core/calc.js             grade calculations (K1–K8), ranking
js/core/history.js          change-log diffing (G5)
js/core/sample.js           deterministic fake sample data (C1, C2, C4)
js/core/attendance.js       sessions, rates, streaks (stage 3)
js/core/stats.js            statistics (stage 5)
js/core/csv.js              CSV/TSV parse + serialize (stage 4; TSV paste parsing used from stage 2)
js/core/exporter.js         column catalog, presets, export row + formula model (stage 4)
js/core/importer.js         column mapping + apply import (stage 4)
js/storage.js               IndexedDB → localStorage → memory adapter
js/store.js                 app state, transactions, undo/redo, autosave, subscriptions
js/ui/*.js                  widgets and views
js/app.js                   boot: load state, render shell, wire header/nav
vendor/exceljs.min.js       vendored library (+ vendor/exceljs.LICENSE)
tests/*.test.js             node --test unit tests (no dependencies)
tests/e2e/smoke.mjs         headless Chromium smoke test (uses globally installed playwright)
```

## 2. Data model (`GT.model`)

All data is plain JSON (serializable, structured-clonable). IDs are strings with a prefix.

```js
AppState = {
  app: 'grade-tracker',
  schemaVersion: 1,
  courses: Course[],                 // display order
  activeCourseId: string|null,
  ui: { theme: 'system'|'light'|'dark', privacy: boolean, activeView: string },
  meta: { createdAt: iso, lastSavedAt: iso|null, lastBackupAt: iso|null }
}

Course = {
  id: 'c_…', template: 'SE4351'|'SE6362'|'custom',
  code: 'SE 4351', title: 'Requirements Engineering',
  level: 'undergraduate'|'graduate', term: 'Fall 2026',
  createdAt: iso, updatedAt: iso,
  assessments: Assessment[],          // display order
  teams: Team[],                      // display order
  students: Student[],                // storage order (display order comes from sorting)
  scores:     { [studentId]: { [assessmentId]: ScoreEntry } },   // individual entries + overrides
  teamScores: { [teamId]:    { [assessmentId]: ScoreEntry } },   // team-graded entries
  attendance: Attendance,
  settings: Settings,
  placeholders: { [key]: { confirmed: boolean, confirmedAt: iso|null } },
  exportPresets: ExportPreset[],      // user presets (built-in default preset is generated, stage 4)
  history: HistoryEntry[]             // append-only change log (G5)
}

Assessment = { id: 'a_…', name: 'Project I', maxScore: 100, weight: 10, teamGraded: true,
               category: 'project'|'test'|'participation'|'paper'|'other' }
Team       = { id: 't_…', name: 'Team 1' }
Student    = { id: 's_…', no: 1, lastName: 'Student 01', firstName: 'Alpha',
               teamId: 't_…'|null, status: 'active'|'withdrawn', notes: '' }

ScoreEntry = {
  value: number|null,      // numeric score as entered (null = empty or invalid)
  text?: string,           // present only when the entered text was not a number (invalid, G4)
  weeksLate?: number,      // K4, default 0 (stage 6)
  waived?: boolean,        // K4, default false (stage 6)
  override?: boolean       // only in course.scores for team-graded assessments (K5)
}

Settings = {
  decimals: 2,                        // display only
  rounding: 'none'|'hundredth'|'integer',
  curve: 0,                           // flat points added to the total
  latePointsPerWeek: 10,              // K4
  letterScale: [{ letter: 'A+', min: 97 }, …, { letter: 'F', min: 0 }],  // descending min; last is F with min 0
  passingLetter: 'D-'|'C'             // lowest passing letter (pass rate, ST2)
}

Attendance = {                        // stage 3 fills in behavior; shape exists from stage 1
  mode: 'per-session'|'totals'|'off',
  sessions: [{ id: 'ses_…', date: 'YYYY-MM-DD', label: '' }],   // ascending by date
  records: { [studentId]: { [sessionId]: 'P'|'A'|'E' } },      // missing = not recorded
  totals:  { [studentId]: { absent: number, excused: number } },// totals-only mode
  totalsSessionsHeld: 0,               // denominator for totals-only rates
  unexcusedThreshold: 3,               // T4 placeholder; highlight when unexcused > threshold
  excusedCountsTowardStreak: true,     // T5
  dropStreak: 3, failStreak: 4         // T5 (from syllabus)
}
```

### 2.1 Templates (C1, C2, A1, A4, K6, T1, T2)

`model.createCourse(templateKey)` with `'SE4351'`, `'SE6362'` or `'custom'`:

| | SE4351 | SE6362 | custom |
|---|---|---|---|
| code / title | SE 4351 / Requirements Engineering | SE 6362 / Software Architectural Design | New Course / Untitled course |
| level | undergraduate | graduate | undergraduate |
| assessments | Project I 10 (team), Project II 20 (team), Test 1 25, Test 2 40, Class/Project Participation 5 | same + Term Paper 0 (category 'paper') | same as SE4351 |
| letter scale | A+ 97, A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 73, C- 70, D+ 67, D 63, D- 60, F 0 | A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 70, F 0 | undergraduate |
| passingLetter | D- | C | D- |
| attendance.mode | per-session, 26 TR sessions 2026-09-03 → 2026-12-08 minus 11-24, 11-26 | off, same session list prefilled | off, no sessions |

Assessment ids are stable per template: `a_p1, a_p2, a_t1, a_t2, a_part, a_paper` (new ones use `util.uid('a')`).

Default state (`model.createDefaultState()`): both template courses with **no students**, SE4351 active.

### 2.2 Placeholders ("needs confirmation" badges)

`model.PLACEHOLDERS` is a catalog `{ key: { label, note(course) } }`. Keys:
`letterScale`, `rounding`, `curve`, `lateWork`, `maxScores`, `projectSplit`, `termPaperWeight`
(SE6362 template only), `unexcusedThreshold`, `passingLetter`.
`model.placeholderKeys(course)` returns the keys that apply to that course.
`model.unconfirmedPlaceholders(course)` returns `[{ key, label, note }]` still unconfirmed.
Editing a value never auto-confirms; the user clicks "Mark confirmed" (and can undo that).

### 2.3 Helpers

- `model.createDefaultState()`, `model.createCourse(template, overrides?)`, `model.createStudent(fields)`,
  `model.createTeam(name)`, `model.createAssessment(fields)`
- `model.normalizeState(raw)` → fills defaults, repairs shapes, throws `Error` with a readable message
  for data that is not a Grade Tracker state. `model.normalizeCourse(course)` likewise.
- `model.wrapBackup(state, isoNow)` → `{ app:'grade-tracker', kind:'backup', schemaVersion, exportedAt, state }`
- `model.readBackup(obj)` → `{ state, summary: { exportedAt, courses: [{code, title, students}] } }` or throws.
- `model.duplicateCourse(course, isoNow)` → deep copy with new course id, `code + ' (copy)'`, history reset
  to one entry noting the source.
- `model.studentName(s)` → `'Last, First'` (either part may be empty).
- `model.findTeam(course, teamId)`, `model.findStudent`, `model.findAssessment`.
- `model.nextStudentNo(course)` → max(no)+1.
- `model.convertAssessmentToTeam(course, assessmentId)`: for each team, team score := most common member
  value (ties → the value seen first when members are sorted by name); members whose value differs keep it
  as an override. Members with no team keep individual entries.
- `model.convertAssessmentToIndividual(course, assessmentId)`: every member's effective entry is copied
  into `scores` (override flags cleared); team entries for that assessment are deleted.
- `model.setTeamScoreFromMembers(course, assessmentId, rows)` (used by paste/import of team-graded columns):
  `rows = [{studentId, entry}]`; per team: if all rows of a team agree → team score; else team score = most
  frequent value and differing members become overrides. Returns `{ overridesCreated: n }`.

## 3. Calculations (`GT.calc`) — K1–K8

Numbers: all arithmetic results pass through `util.fix(x)` (round to 10 decimals) to remove binary noise.
Weighted points use multiply-first: `adjusted * weight / maxScore`.

- `calc.parseEntry(entry)` → `{ state: 'empty'|'number'|'invalid', value: number|null, text: string|null }`.
- `calc.resolveEntry(course, student, assessment)` → `{ entry, source, teamId }`:
  - not team-graded → `scores[s][a]`, source `'individual'`.
  - team-graded and student has an existing team: if `scores[s][a].override === true` → that entry,
    source `'override'`; else `teamScores[team][a]`, source `'team'`.
  - team-graded, no team → `scores[s][a]`, source `'individual'`.
  - missing entry → `null` (state `'empty'`).
- `calc.latePenalty(entry, assessment, settings)` → `waived || !weeksLate ? 0 : weeksLate * latePointsPerWeek * maxScore / 100`.
- `calc.scoreDetail(course, student, assessment)` →
  `{ assessmentId, state, raw, text, source, teamId, override, missing, outOfRange, weeksLate, waived,
     penalty, adjusted, weighted }` where
  - `missing = state !== 'number'` (empty and invalid count as 0; invalid is also flagged),
  - `outOfRange = state === 'number' && (raw < 0 || raw > maxScore)` (value is still used as entered),
  - `adjusted = max(0, raw - penalty)` when a late penalty applies, else `raw`; `null` when missing,
  - `weighted = missing || maxScore <= 0 ? 0 : fix(adjusted * weight / maxScore)`.
- `calc.roundTotal(x, mode)` → `none`: x; `hundredth`: `util.roundTo(x, 2)`; `integer`: `util.roundTo(x, 0)`
  (half away from zero, same as Excel `ROUND`).
- `calc.letterFor(total, scale)` → first entry (scale sorted by `min` descending) with `total >= min`,
  compared after `fix`; below every cutoff → the last letter (F).
- `calc.studentResult(course, student)` →
  `{ studentId, active, items: {aid: detail}, weightedSum, curve, totalUnrounded, total, letter,
     incomplete, missingCount, invalidCount, outOfRangeCount, overrideCount, lateCount }`
  - `weightedSum = fix(Σ weighted)`, `totalUnrounded = fix(weightedSum + curve)`, `total = roundTotal(totalUnrounded)`.
  - `incomplete = missingCount > 0` counting only assessments with `weight > 0`.
- `calc.computeCourse(course)` → `{ byId: {sid: result + rank, percentile, diffFromAverage},
   activeIds, average, weights: { sum, ok } }`
  - Active = `status === 'active'`. Withdrawn students get `rank = percentile = diffFromAverage = null`.
  - `average` = mean of active `total` (null when none).
  - Rank: competition ranking by `total` descending among active (1, 2, 2, 4).
  - Percentile: `100 * (# active with lower total) / (N − 1)`; N = 1 → 100. Ties share a percentile.
  - `diffFromAverage = fix(total − average)`.
- `calc.weightStatus(course)` → `{ sum, ok: |sum − 100| < 1e-9 }`.
- `calc.compareByName(a, b)` → last name, then first name, then `no`; case-insensitive, numeric-aware.
- `calc.sortStudents(course, results, key: 'name'|'total'|'no', dir: 'asc'|'desc')` → new array.

## 4. Change history (`GT.history`) — G5

`HistoryEntry = { id, ts, source, kind, studentId, studentName, teamId, teamName, field, fieldKey,
oldValue, newValue, note }` — values are display strings (`''` = empty), names are snapshots.

- `source`: `'edit'|'paste'|'undo'|'redo'|'import'|'restore'|'sample'|'roster'|'system'`.
- `kind`: `'score'|'team-score'|'propagation'|'override'|'override-removed'|'late'|'status'|
  'team-membership'|'student'|'settings'|'attendance'|'bulk'`.
- `history.diffCourse(before, after, { ts, source })` → entries for every difference in:
  assessments (name/max/weight/team flag, added/removed), grade settings (curve, rounding, letter cutoffs,
  latePointsPerWeek, passingLetter), students (added/removed/name/no/status/team), team scores, individual
  entries (value/text, weeksLate, waived, override flag), and **effective** team-graded values of each
  student that changed without an individual entry change (kind `'propagation'`, note
  `"From <team> team score"`). Attendance changes (stage 3) are logged per student when a transaction
  changes ≤ 5 marks, otherwise as one `'attendance'` summary entry.
- `history.bulkEntry({ ts, source, field, note })` for summary-only transactions (e.g., loading sample data).

## 5. Store (`GT.store`) and storage (`GT.storage`)

- `GT.storage.init()` → `Promise<{ backend: 'indexeddb'|'localstorage'|'memory' }>`; `load()`,
  `save(state)`, `clear()`. IndexedDB DB `grade-tracker`, object store `kv`, keys `state` and `state-prev`.
- `GT.store.state` (AppState), `GT.store.course()` (active course), `GT.store.results()` (memoized
  `calc.computeCourse` for the active course, invalidated on change).
- `GT.store.transact(label, mutator, { source = 'edit', courseId, historyMode = 'diff'|'bulk'|'none' })`:
  snapshot (course without history) → `mutator(course)` → history diff appended → undo push → redo clear →
  `updatedAt` → debounced save → notify subscribers.
- `GT.store.undo()`, `redo()`, `canUndo()`, `canRedo()` — per course, in memory, capped at 200 steps.
  Undo/redo append history entries (source `'undo'`/`'redo'`); history itself is never rolled back.
- `GT.store.setUi(patch)`, `GT.store.setMeta(patch)`, `GT.store.replaceState(state, source)`,
  `GT.store.subscribe(fn)`, `GT.store.flush()` (save now), `GT.store.saveStatus()`.

## 6. UI conventions

- Views: `GT.views[id] = { id, title, render(el, ctx), destroy?() }`. The app re-renders the active view after
  every store change (views keep their own transient UI state: sort, filters, active cell).
- All text is escaped with `util.escapeHtml`. No inline `on*=` attributes; use `addEventListener`/delegation.
- **Privacy**: every element that shows a student name or student notes has class `pii`. With privacy
  mode on, `.pii` is blurred; clicking a blurred element reveals it for 10 s.
- Keyboard: all actions reachable by keyboard; focus rings visible; dialogs use `<dialog>`.
- Placeholder badge: `<span class="badge badge-warn">needs confirmation</span>` (yellow) wherever a
  placeholder value is shown or edited.
- Shared widgets: `GT.ui.dialog.confirm/prompt/open`, `GT.ui.toast(message, { type })`,
  `GT.ui.download(filename, blobOrText, mime)`, `GT.ui.loadExcel()`, `GT.ui.icon(name)` (inline SVG).
