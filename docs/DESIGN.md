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
               category: 'project'|'test'|'participation'|'paper'|'other' }   // maxScore > 0, weight >= 0
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
  decimals: 2,                        // display only (not a placeholder: it never changes a grade)
  rounding: 'none'|'hundredth'|'integer',
  curve: 0,                           // flat points added to the total
  latePointsPerWeek: 10,              // K4, >= 0
  letterScale: [{ letter: 'A+', min: 97 }, …, { letter: 'F', min: 0 }],  // descending min; last is F with min 0
  passingLetter: 'D-'|'C'             // lowest passing letter (pass rate, ST2); always a letter of the scale
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
`letterScale`, `rounding`, `curve`, `lateWork`, `maxScores`, `projectSplit` (every course: both syllabi
say "approx. 10 + 20"), `termPaperWeight` (only while the course has the `a_paper` assessment, which the
SE6362 template creates), `unexcusedThreshold`, `passingLetter`. Display decimals (K3) is display-only
and deliberately not a placeholder. Notes quote a syllabus only for the SE4351/SE6362 templates; custom
courses get generic notes.
`model.placeholderKeys(course)` returns the keys that apply to that course.
`model.placeholderInfo(course, key)` → `{ key, label, note, confirmed, confirmedAt }` or null;
`model.isConfirmed(course, key)`.
`model.unconfirmedPlaceholders(course)` returns `[{ key, label, note, … }]` still unconfirmed.
Editing a value never auto-confirms; the user clicks "Mark confirmed" (and can undo that).

### 2.3 Helpers

Factories and constants:

- `model.createDefaultState()`, `model.createCourse(template, overrides?)` (unknown template → `'custom'`),
  `model.createStudent(fields)`, `model.createTeam(name, id?)`, `model.createAssessment(fields)`
  (maxScore must be > 0, else 100; weight must be >= 0, else 0).
- `model.TEMPLATES`, `model.FALL_2026_TR`, `model.generateSessions({ start, end, weekdays, exclude })`
  (ids `ses_YYYYMMDD`), `model.defaultSettings(level)`, `model.defaultAttendance(mode, sessions)`,
  `model.defaultLetterScale(level)`, `model.defaultPassingLetter(level)`, `model.ROUNDING_MODES`,
  `model.ATTENDANCE_MODES`, `model.APP_ID`, `model.SCHEMA_VERSION`.
- `model.normalizeLetterScale(list, level)` → cleaned copy: malformed rows dropped, sorted by `min`
  descending, and the invariant "last is F with min 0" enforced (a bottom `F` above 0 moves to 0; a scale
  whose lowest cutoff is above 0 gets `{ letter: 'F', min: 0 }` appended; empty → level default). Settings
  edits of the scale must go through it. `model.passingLetterFor(scale, preferred, level)` → `preferred` if
  in the scale, else the level default if in the scale, else the lowest letter above the bottom one.

Normalize and backup (R4). Files are untrusted: ids must pass `util.isSafeKey` (not `__proto__`,
`constructor`, `prototype`; otherwise a new id is made and data keyed by the bad id is dropped), lookups
use own properties only (`util.hasOwn`), and numbers must be finite with |x| <= `util.MAX_INPUT_ABS` (1e6).
A stored score above that limit becomes invalid text (shown and highlighted, counted as 0).

- `model.normalizeState(raw)` → fills defaults, repairs shapes, throws `Error` with a readable message
  for data that is not a Grade Tracker state; `raw.app` must be `'grade-tracker'`. `model.normalizeCourse(course)`
  likewise (assessment weights < 0 → 0, maxScore <= 0 → 100, latePointsPerWeek < 0 → 0, letter scale via
  `normalizeLetterScale`, duplicate ids made unique, including export preset ids).
- `model.wrapBackup(state, isoNow)` → `{ app:'grade-tracker', kind:'backup', schemaVersion, exportedAt, state }`
- `model.readBackup(obj)` → `{ state, summary: { exportedAt, courses: [{code, title, students}] } }` or throws.
  Accepts the wrapped format (inner state may omit `app`) or a bare state that has `app: 'grade-tracker'`.
- `model.duplicateCourse(course, isoNow)` → deep copy with new course id, `code + ' (copy)'`, history reset
  to one entry noting the source.

Lookups: `model.findTeam(course, teamId)`, `model.findStudent`, `model.findAssessment`, `model.findCourse(state, id)`,
`model.teamMembers(course, teamId)` (storage order), `model.sortedMembers(course, teamId)` (name order),
`model.studentName(s)` → `'Last, First'` (either part may be empty), `model.courseLabel(c)` → `'Code - Title'`,
`model.nextStudentNo(course)` → max(no)+1.

Score entries:

- `model.getEntry(map, ownerId, assessmentId)` → entry or null (own properties only);
  `model.setEntry(map, ownerId, assessmentId, entry|null)` (null deletes; an emptied owner row is removed;
  unsafe keys are ignored).
- `model.entryFromInput(input, prev?)` → ScoreEntry from typed/pasted text. Keeps `weeksLate`/`waived` from
  `prev`, and `override` only when the input is not empty (clearing an override cell hands the member back
  to the team score).
- `model.isBlankEntry(e)` (no value, text, late info or override), `model.hasScore(e)` (a number or invalid
  text; late info alone is not a score).
- `model.entryKey(e)` → comparison key for "same visible score": value or text plus late info that changes
  the score (`weeksLate` > 0, and `waived` with it), e.g. `'n:80|late:1'`. The override flag is ignored.
- `model.majorityEntry(entries)` → most frequent `entryKey`, ties → first in the given order.
- `model.effectiveEntry(course, student, assessment)` → what the student sees (mirrors `calc.resolveEntry`).
- `model.withLate(entry|null, weeksLate, waived)` → copy with late info set (weeks <= 0 removes it; `waived`
  stored only when true). The UI parses weeks with `util.parseCount` (whole numbers only).

Team-graded items (K5). An override is the only way a member's score differs from the team's, and it is
shown with a marker (written agreement needed), so the model never creates an **empty** override on its own:

- `model.setTeamScore(course, teamId, assessmentId, entry)` (blank entry clears the team score).
- `model.setOverride(course, studentId, assessmentId, entry)` → stores the entry with `override: true`
  (an explicit empty override means "no score for this member"); `model.clearOverride(course, studentId,
  assessmentId)` → true when an override was removed (the member follows the team score again).
- `model.setTeamScoreFromMembers(course, assessmentId, rows)` (paste/import of a team-graded column):
  `rows = [{studentId, entry}]`. Per team with rows: only rows holding a score vote (blank cells abstain);
  withdrawn members vote only when no active member of that team has a score in `rows`. Team score = most
  frequent vote by `entryKey` (so late info counts), ties → first in row order; no votes → team score
  cleared. Blank rows and rows equal to the team score follow the team score (own entry and any override
  removed); other rows keep their entry as an override. Team members **not** in `rows` are not written:
  like typing in one member's cell, the new team score reaches every member without an override, and
  `propagatedTo` lists the non-row members whose visible score changed so the grid can report it.
  Rows for students without a team become individual entries.
  Returns `{ overridesCreated, teamsSet, propagatedTo: [studentId] }`.
- `model.convertAssessmentToTeam(course, assessmentId)`: no-op (returns `{ overridesCreated: 0 }`) when the
  item is already team-graded. Otherwise, for each team, the members' individual entries in name order go
  through `setTeamScoreFromMembers`: every entered score is preserved (majority → team score, ties → first
  member by name, the rest → overrides) and members with no score follow the team score. Students without
  a team keep individual entries. Returns `{ overridesCreated }`.
- `model.convertAssessmentToIndividual(course, assessmentId)`: every member's effective entry is copied
  into `scores` (override flags cleared); team entries for that assessment are deleted.
- `model.moveStudentToTeam(course, studentId, newTeamId|null, { keepScores })` (G5 kind `'team-membership'`):
  no-op when the student is already in that team. Without `keepScores`, team-graded scores follow the new
  team: the student's own entries for team-graded items are removed, **overrides included** (an unequal
  split was agreed within the old team), so without a team those items are empty. With `keepScores`, the
  student's current visible team-graded scores are kept wherever the new team's score differs (by
  `entryKey`): as overrides in the new team, or as individual entries when moving to no team; an empty
  score is not kept as an override (the student follows the new team).
- `model.removeTeam(course, teamId, { keepScores })` → moves every member to no team through
  `moveStudentToTeam`, deletes the team and its team scores; returns the moved student ids.
- `model.removeAssessment(course, assessmentId)` → deletes the item and every score for it (individual
  entries, overrides, team scores); returns false when it did not exist. Export presets are left alone:
  the exporter skips columns that reference a missing assessment.

## 3. Calculations (`GT.calc`) — K1–K8

Numbers: arithmetic results pass through `util.fix(x)` (round to `util.FIX_DECIMALS` = 10 decimals) to
remove binary noise. Weighted points use multiply-first: `adjusted * weight / maxScore`. The total adds the
**unrounded** weighted products and applies `fix` once to the sum: rounding each item first drifts on max
scores such as 30 (an exact 80 became 79.9999999999, a C+ instead of B-).

Input parsing (`GT.util`): `parseScoreInput` accepts numbers with |x| <= `util.MAX_INPUT_ABS` (1e6); larger
values are `'invalid'` so totals stay finite. `parseCount` (weeks late, absence counts) accepts whole
numbers >= 0 only (no fractions, no `%`). `roundTo(x, d)` is Excel `ROUND` (half away from zero, negative
`d` allowed, safe for any finite magnitude).

- `calc.parseEntry(entry)` → `{ state: 'empty'|'number'|'invalid', value: number|null, text: string|null }`.
- `calc.resolveEntry(course, student, assessment)` → `{ entry, source, teamId }`:
  - not team-graded → `scores[s][a]`, source `'individual'`.
  - team-graded and student has an existing team: if `scores[s][a].override === true` → that entry,
    source `'override'`; else `teamScores[team][a]`, source `'team'`.
  - team-graded, no team → `scores[s][a]`, source `'individual'`.
  - missing entry → `null` (state `'empty'`).
- `calc.latePenalty(entry, assessment, settings)` → `waived || !weeksLate ? 0 : weeksLate * latePointsPerWeek * maxScore / 100`,
  and 0 when `latePointsPerWeek` or `maxScore` is not positive (never negative).
- `calc.scoreDetail(course, student, assessment)` →
  `{ assessmentId, state, raw, text, source, teamId, override, missing, outOfRange, weeksLate, waived,
     penalty, adjusted, weighted, weightedUnrounded }` where
  - `missing = state !== 'number'` (empty and invalid count as 0; invalid is also flagged),
  - `outOfRange = state === 'number' && (raw < 0 || raw > maxScore)` (value is still used as entered),
  - `adjusted = max(0, raw - penalty)` when a late penalty applies, else `raw`; `null` when missing,
  - `weightedUnrounded = missing || maxScore <= 0 ? 0 : adjusted * weight / maxScore` (used for the sum),
  - `weighted = fix(weightedUnrounded)` (display value).
- `calc.roundTotal(x, mode)` → `none`: x; `hundredth`: `util.roundTo(x, 2)`; `integer`: `util.roundTo(x, 0)`
  (half away from zero, same as Excel `ROUND`).
- `calc.letterFor(total, scale)` → first entry (scale sorted by `min` descending) with `total >= min`,
  compared after `fix`; below every cutoff → the last letter (F).
- `calc.studentResult(course, student)` →
  `{ studentId, active, items: {aid: detail}, weightedSum, curve, totalUnrounded, total, letter,
     incomplete, missingCount, invalidCount, outOfRangeCount, overrideCount, lateCount }`
  - `weightedSum = fix(Σ weightedUnrounded)`, `totalUnrounded = fix(weightedSum + curve)`, `total = roundTotal(totalUnrounded)`.
  - `incomplete = missingCount > 0` counting only assessments with `weight > 0`.
- `calc.computeCourse(course)` → `{ byId: {sid: result + rank, percentile, diffFromAverage},
   activeIds, average, weights: { sum, ok } }`
  - Active = `status === 'active'`. Withdrawn students get `rank = percentile = diffFromAverage = null`.
  - `average` = mean of active `total` (null when none).
  - Rank: competition ranking by `total` descending among active (1, 2, 2, 4).
  - Percentile: `100 * (# active with lower total) / (N − 1)`; N = 1 → 100. Ties share a percentile.
  - `diffFromAverage = fix(total − average)`.
  - A non-finite total (only possible when code sets absurd weights; normalize rejects them) is left out
    of `average`, rank and percentile (those stay null for that student); `activeIds` lists every active student.
- `calc.weightStatus(course)` → `{ sum, ok: |sum − 100| < 1e-9 and no weight < 0 }`.
- `calc.minTotalForLetter(letter, settings)` → smallest `totalUnrounded` (after curve, before rounding)
  that earns `letter`: the cutoff with rounding `'none'`, `ceil(cutoff) − 0.5` with `'integer'`, the cutoff
  rounded up to 0.01 minus 0.005 with `'hundredth'`; null for a letter not in the scale. For cutoffs > 0.
- `calc.neededScore(course, student, assessmentId, letter)` (what-if, ST2) → `{ needed, reachable, alreadyReached }`:
  the on-time score on that item's own scale that reaches `letter` with every other item at its current
  value (empty = 0; the item's own score is ignored), `reachable = needed <= maxScore`,
  `alreadyReached = needed <= 0`; null for an unknown letter/item or an item with weight or max <= 0.
  `needed` is exact to 10 decimals and rounded **up** at the 10th decimal when it is a repeating decimal,
  so entering it reaches the letter; a UI that shows fewer decimals should also round up.

Excel parity (E3, stage 4). To make exported formulas give the app's letters at exact cutoffs, the
exporter mirrors this section: weighted cell `=MAX(0, raw − weeks*ppw*max/100)*weight/max` (no late term
when waived or not late; empty → 0), total `=ROUND(SUM(weighted cells) + curve, 10)` (10 =
`util.FIX_DECIMALS`), then the rounding mode's `ROUND(…, 2|0)` around it, then the letter `LOOKUP` on that.
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
