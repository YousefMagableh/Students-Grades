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
js/core/importer.js         reading files, column mapping, import plan + apply (stage 4)
js/ui/exchange.js           Import / Export tab (stage 4)
js/storage.js               IndexedDB → localStorage → memory adapter
js/store.js                 app state, transactions, undo/redo, autosave, subscriptions
js/ui/widgets.js            shared widgets (dialogs, menus, toasts, icons, downloads)
js/ui/grid.js               Grades tab, incl. the Meeting view and the "Late work…" dialog (stages 2, 2b, 6)
js/ui/students.js           Students & Teams tab, student details (stages 2, 6)
js/ui/settings.js           Settings tab, incl. the Late work card (stages 2, 6)
js/ui/history-view.js       History tab (stage 2)
js/ui/attendance.js         Attendance tab, roll call (stage 3)
js/ui/stats.js              Statistics tab (stage 5, section 11)
js/ui/summary.js            printable Summary tab (stage 6, section 12)
js/app.js                   boot: load state, render shell, wire header/nav, shortcuts and Help / About
vendor/exceljs.min.js       vendored ExcelJS 4.4.0 (+ vendor/exceljs.LICENSE.txt), loaded on demand
tests/*.test.js             node --test unit tests (no dependencies); tests/repo.test.js checks the files themselves
                            (local scripts only, CSP, no network APIs, .gitignore, version)
tests/helpers/mini-excel.js tiny spreadsheet formula evaluator used by the export tests and the smoke test
tests/e2e/smoke.mjs         headless Chromium smoke test from file:// (uses globally installed playwright): every
                            stage, light and dark, 390 px, the Summary PDF, and zero network requests
```

## 2. Data model (`GT.model`)

All data is plain JSON (serializable, structured-clonable). IDs are strings with a prefix.

```js
AppState = {
  app: 'grade-tracker',
  schemaVersion: 2,                  // 2 since stage 3 (see 2.3: migration from 1)
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
  finalized: null | { at: iso, note: string },   // STAGE2B: scores locked in the grid (letters stay editable)
  history: HistoryEntry[]             // append-only change log (G5)
}

Assessment = { id: 'a_…', name: 'Project I', maxScore: 100, weight: 10, teamGraded: true,
               category: 'project'|'test'|'participation'|'paper'|'other',   // maxScore > 0, weight >= 0
               choices: null | { step: number } }   // DECISIONS 8: drop-down list max, max − step, …, 0
Team       = { id: 't_…', name: 'Team 1' }
Student    = { id: 's_…', no: 1, lastName: 'Student 01', firstName: 'Alpha',
               teamId: 't_…'|null, status: 'active'|'withdrawn', notes: '',
               finalLetter: string|null }   // STAGE2B: the letter assigned by hand (null = none yet)

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
  letterScale: [{ letter: 'A+', min: 97 }, …, { letter: 'F', min: 0 }],  // descending min; lowest cutoff 0 (F, or the scale's own bottom letter)
  passingLetter: 'D-'|'C'             // lowest passing letter (pass rate, ST2); always a letter of the scale
}

Attendance = {                        // behavior: GT.attendance (section 7)
  mode: 'per-session'|'totals'|'off',
  sessions: [{ id: 'ses_…', date: 'YYYY-MM-DD', label: '' }],   // ascending by date
  records: { [studentId]: { [sessionId]: 'P'|'A'|'E' } },      // missing = not recorded
  totals:  { [studentId]: { absent: number, excused: number } },// totals-only mode
  totalsSessionsHeld: 0,               // denominator for totals-only rates
  unexcusedThreshold: 3,               // T4 placeholder; highlight when unexcused > threshold
  totalAbsenceThreshold: null,         // DECISIONS 3: null = off (default) | whole number >= 0; highlight when total > it
  excusedCountsTowardStreak: false,    // T5; default FALSE since DECISIONS 6 (allowed absences do not count)
  dropStreak: 3, failStreak: 4         // T5 (from syllabus)
}
```

### 2.1 Templates (C1, C2, A1, A4, K6, T1, T2)

`model.createCourse(templateKey)` with `'SE4351'`, `'SE6362'` or `'custom'`:

| | SE4351 | SE6362 | custom |
|---|---|---|---|
| code / title | SE 4351 / Requirements Engineering | SE 6362 / Software Architectural Design | New Course / Untitled course |
| level | undergraduate | graduate | undergraduate |
| assessments | Project I 10 (team), Project II 20 (team), Test 1 25, Test 2 40, Class/Project Participation 5 (max **5**, drop-down step 0.5) | same + Term Paper 0 (category 'paper') | same as SE4351 |
| letter scale | A+ 97, A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 73, C- 70, D+ 67, D 63, D- 60, F 0 | A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 70, F 0 | undergraduate |
| passingLetter | D- | C | D- |
| attendance.mode | per-session, 26 TR sessions 2026-09-03 → 2026-12-08 minus 11-24, 11-26 | off, same session list prefilled | off, no sessions |

Assessment ids are stable per template: `a_p1, a_p2, a_t1, a_t2, a_part, a_paper` (new ones use `util.uid('a')`).

Max scores (DECISIONS 1, 8): every template assessment is out of 100 with free entry (`choices: null`), except
Class/Project Participation (`a_part`, category `'participation'`): `maxScore: 5`, `weight: 5`,
`choices: { step: 0.5 }`, in all three templates. That is the previous TA's sheet (5 = full marks): with
weight 5 the raw score equals the weighted points, and the grid offers 5, 4.5, …, 0.5, 0 plus "(empty)".
Courses saved before this change keep what they have (no migration: grades are never changed silently).

Default state (`model.createDefaultState()`): both template courses with **no students**, SE4351 active.

### 2.2 Placeholders ("needs confirmation" badges)

`model.PLACEHOLDERS` is a catalog `{ key: { label, note(course) } }`. Keys:
`letterScale`, `rounding`, `curve`, `lateWork`, `maxScores`, `projectSplit` (every course: both syllabi
say "approx. 10 + 20"), `termPaperWeight` (only while the course has the `a_paper` assessment, which the
SE6362 template creates), `unexcusedThreshold`, `passingLetter`. Display decimals (K3) is display-only
and deliberately not a placeholder: REQUEST.md names only rounding and curve as "not specified by the
instructor" and lists the placeholders as rounding, late-work exceptions, max scores and project split.
REQUIREMENTS.md K3 says the same. Notes quote a syllabus only for the SE4351/SE6362 templates; custom
courses get generic notes.
`model.placeholderKeys(course)` returns the keys that apply to that course.
`model.placeholderInfo(course, key)` → `{ key, label, note, confirmed, confirmedAt }` or null;
`model.isConfirmed(course, key)`.
`model.unconfirmedPlaceholders(course)` returns `[{ key, label, note, … }]` still unconfirmed.
Editing a value never auto-confirms; the user clicks "Mark confirmed" (and can undo that).
The `maxScores` note says every item defaults to max 100 except Class/Project Participation, which is out of
5 like the previous TA's sheet (5 = full marks), picked from a drop-down list in steps of 0.5.
The `unexcusedThreshold` note also covers the optional total-absence threshold (DECISIONS 3; no separate key):
for the SE4351/SE6362 templates it quotes the syllabus ("total absences should not exceed a certain threshold",
no number given), says the placeholder highlights above 3 unexcused (not allowed) absences, and that the
total-absence threshold (excused + unexcused) needs confirming too and is off until set. Custom courses get the
same note without the syllabus quote.

### 2.3 Helpers

Factories and constants:

- `model.createDefaultState()`, `model.createCourse(template, overrides?)` (unknown template → `'custom'`;
  `finalized: null`), `model.createStudent(fields)` (`finalLetter` null unless a string with visible text is
  given), `model.createTeam(name, id?)`, `model.createAssessment(fields)` (maxScore must be > 0, else 100;
  weight must be >= 0, else 0; `choices` through `normalizeChoices`, default null).
- `model.TEMPLATES`, `model.FALL_2026_TR`, `model.generateSessions({ start, end, weekdays, exclude })`
  (ids `ses_YYYYMMDD`), `model.defaultSettings(level)`, `model.defaultAttendance(mode, sessions)`,
  `model.defaultLetterScale(level)`, `model.defaultPassingLetter(level)`, `model.ROUNDING_MODES`,
  `model.ATTENDANCE_MODES`, `model.APP_ID`, `model.SCHEMA_VERSION`.
- `model.normalizeLetterScale(list, level)` → cleaned copy: malformed rows dropped (no letter, `min` not a
  sane number, or `min` < 0, since a negative cutoff would shadow the failing letter), sorted by `min`
  descending, and the invariant "the lowest cutoff is 0" enforced: a bottom `F` above 0 moves to 0; a scale
  whose lowest cutoff is above 0 gets `{ letter: 'F', min: 0 }` appended; a bottom row already at 0 keeps its
  letter (e.g. Pass/Fail); empty → level default. Settings edits of the scale must go through it (the
  Settings view highlights a negative cutoff instead of saving it, so the row is not silently dropped).
  `model.passingLetterFor(scale, preferred, level)` → `preferred` if in the scale, else the level default if
  in the scale, else the lowest letter above the bottom one.

Normalize and backup (R4). Files are untrusted: ids must pass `util.isSafeKey` (not `__proto__`,
`constructor`, `prototype`; otherwise a new id is made and data keyed by the bad id is dropped), lookups
use own properties only (`util.hasOwn`), and numbers must be finite with |x| <= `util.MAX_INPUT_ABS` (1e6).
A stored score above that limit becomes invalid text (shown and highlighted, counted as 0).

- `model.normalizeState(raw)` → fills defaults, repairs shapes, throws `Error` with a readable message
  for data that is not a Grade Tracker state; `raw.app` must be `'grade-tracker'`. `model.normalizeCourse(course)`
  likewise (assessment weights < 0 → 0, maxScore <= 0 → 100, latePointsPerWeek < 0 → 0, letter scale via
  `normalizeLetterScale`, duplicate ids made unique, including export preset ids). STAGE2B fields:
  `Student.finalLetter` is kept as any string with visible text, **even when it is not a letter of the
  scale** (calc reports `finalLetterValid: false` and the UI warns; it is never dropped), else null;
  `Course.finalized` is kept only as `{ at: non-empty string, note: string }` (a missing note becomes `''`,
  extra keys are dropped), else null; `Assessment.choices` only when `normalizeChoices` accepts it.
  Attendance (stage 3): `excusedCountsTowardStreak` is true only when stored as `true` (missing or anything
  else → false, DECISIONS 6); `totalAbsenceThreshold` through `model.normalizeTotalAbsenceThreshold(x)` → a
  whole number >= 0 (at most 1e6), else null (off). Marks other than 'P'/'A'/'E' are dropped. Courses saved
  saved before stage 3 stored `excusedCountsTowardStreak: true` (the old default, which no screen could
  change), so it was never the TA's choice: **schema 2 migration** — `normalizeState` (so both loading from
  the browser and `readBackup`) sets it to false in every course when the data's `schemaVersion` is below 2
  or missing (`model.migrateToV2(course, isoNow?)` → true when it changed), and logs one history entry per
  changed course (source `'system'`, kind `'settings'`, fieldKey `'attendance.excusedCountsTowardStreak'`,
  `'yes'` → `'no'`, with a note saying how to turn it back on). Warnings only, never a grade. Data with
  schema 2 keeps a stored true (the TA ticked the box). A wrapped backup whose inner state has no
  `schemaVersion` uses the envelope's.
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
  `rows = [{studentId, entry}]`. A row is an **override row** when its member holds an override now or its
  entry has `override: true` (what `entryFromInput(text, prev)` gives for a non-empty cell over an override).
  Override rows never vote (an unequal split never becomes the team's score). Per team with rows: of the
  other rows, only those holding a score vote (blank cells abstain); withdrawn members vote only when no
  active member of that team has a score in them. Team score = most frequent vote by `entryKey` (so late info
  counts), ties → first in row order; no votes → team score cleared; a team whose rows are all override rows
  keeps its team score. An override row pasted back unchanged (same `entryKey` as the member's override, an
  empty override included) is left as it is, so pasting unchanged cells back changes nothing. Other rows
  equal to the team score follow it (own entry and any override removed); other rows with a score keep
  their entry as an override. Blank rows follow the team score (a blank over an override hands the member
  back, like clearing the cell). Team members **not** in `rows` are not written: like typing in one
  member's cell, the new team score reaches every member without an override, and
  `propagatedTo` lists the non-row members whose visible score changed so the grid can report it.
  Rows for students without a team become individual entries.
  Returns `{ overridesCreated, teamsSet, propagatedTo: [studentId] }`: `overridesCreated` counts members
  who had no override before; `teamsSet` counts teams whose team score was written.
- `model.convertAssessmentToTeam(course, assessmentId)`: no-op (returns `{ overridesCreated: 0 }`) when the
  item is already team-graded. Otherwise, for each team, the members' individual entries in name order
  (stored without any stray override flag, so every member votes) go through `setTeamScoreFromMembers`:
  every entered score is preserved (majority → team score, ties → first member by name, the rest →
  overrides) and members with no score follow the team score. Students without a team keep individual
  entries. Returns `{ overridesCreated }`.
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
- `model.moveAssessment(course, assessmentId, ±1)`, `model.splitAssessment(course, assessmentId, [{name, weight}, …])`
  (A5: the original keeps its id and scores as part 1; the other parts are new and empty; weights must sum to
  the original weight, else it throws), `model.renumberByName(course)` (No = 1..N in name order),
  `model.deleteStudent(course, studentId)` (scores, overrides and attendance too; the UI recommends withdrawing).
- `model.removeAssessment(course, assessmentId)` → deletes the item and every score for it (individual
  entries, overrides, team scores); returns false when it did not exist. Export presets are left alone:
  the exporter skips columns that reference a missing assessment.
- `splitAssessment` gives the new parts the original's `choices` too.

### 2.4 Drop-down lists (DECISIONS 8)

`Assessment.choices` is `null` (free numeric entry, the default) or `{ step }`. The list is
`max, max − step, …` while above 0, then `0` (each value through `util.fix`). Examples: max 5 step 0.5 → 11
values `5, 4.5, …, 0.5, 0`; max 5 step 2 → `5, 3, 1, 0`; max 5 step 0.1 → 51 values.

- `model.MAX_CHOICE_STEPS` = 200. `model.normalizeChoices(choices, maxScore)` → `{ step }` when `step` is a
  sane number > 0 and `fix(maxScore / step) <= 200` (max 100 step 0.5 is allowed: 201 values), else null.
  Changing an item's max score can make its stored `choices` invalid; the helpers below then treat the item
  as free entry, and `normalizeCourse` drops the list.
- `model.choiceValues(assessment)` → number[] highest first (`[]` without a valid list; a new array on every
  call); `model.hasChoices(assessment)`; `model.describeChoices(assessment)` → `'0–5 in steps of 0.5'` (`''`
  without a list). The list is built once per assessment object and remembered (a `WeakMap` keyed by the
  assessment, rebuilt when its `maxScore` or `choices.step` changed), so `calc` checking every score against
  a 201-value list costs one lookup per score, not a rebuild.
- `model.isChoiceValue(assessment, value)` → true when `util.fix(value)` is one of the values (so
  4.500000000000001 matches 4.5); false for non-numbers and for items without a list.
- `model.parseChoiceInput(assessment, input)` → strict entry for a drop-down cell (typing, paste, import):
  `{ kind: 'empty' }` for blank text; `{ kind: 'number', value }` when the text is a list value (`'4.50'` and
  `'90%'` of 5 give 4.5); otherwise `{ kind: 'invalid', text, message: 'Choose a value from the list (0–5 in
  steps of 0.5).' }`, which the UI shows and **does not store**. Without a list it is `util.parseScoreInput`.
- Values not on the list (restored, imported) are kept; calc flags them with `notOnList` (section 3).

### 2.5 Final letters and finalizing (STAGE2B, DECISIONS 2)

The letter from the cutoffs is only a **suggestion**; the instructor assigns every final letter by hand,
usually in bands after sorting by total. Once final letters are assigned, **they are the grades**:
statistics, the pass rate, the letter distribution, the export column "Letter Grade" and the summary view
use `effectiveLetter` (section 3).

- `model.finalLetterOf(student)` → the stored letter or null (blank strings count as none).
- `model.scaleLetters(course)` → the scale's letters, highest cutoff first, each once (the drop-down order);
  `model.isScaleLetter(course, letter)` (exact match).
- `model.matchLetter(course, text)` → the scale letter that typed or pasted text means, or null: exact match
  first, else case-insensitive, ignoring spaces, with dash variants read as `-` (`'b+'` → `'B+'`, `'A−'` → `'A-'`).
- `model.setFinalLetter(course, studentId, letter|null)` → true when the stored letter changed. `null`,
  `undefined` or blank text clears it. A letter not in the scale (after `matchLetter`) **throws** an `Error`
  with a readable message listing the scale; the student is unchanged. Unknown student → false.
- `model.setFinalLetters(course, [{ studentId, letter }])` (band assignment, paste) → `{ changed, skipped,
  skippedItems: [{ studentId, letter, reason: 'letter'|'student' }] }`; invalid letters and unknown students
  are skipped, never thrown. Use it inside one `GT.store.transact` for ONE undo step.
- `model.copySuggestedToFinal(course, results, { onlyEmpty = true, activeOnly = true })` → number of letters
  that changed. Copies `results.byId[id].letter` (from `calc.computeCourse`); with `onlyEmpty` a letter already
  set stays (an invalid one included); with `activeOnly` withdrawn students are skipped; suggestions that are
  not scale letters and students without a result are skipped.
- `model.finalize(course, isoNow, note)` → sets and returns `course.finalized = { at, note }` (`at` defaults
  to now; finalizing again replaces both). `model.unfinalize(course)` → `finalized = null`, true when it was
  finalized. `model.isFinalized(course)`; `model.normalizeFinalized(x)`.
- Sample data (`GT.sample.loadInto(course, { lateWork })`) has no final letters, sets `finalized = null`, and
  gives participation list values (3 … 5 in steps of 0.5; other values are unchanged, each assessment keeps
  its own PRNG stream). `{ lateWork: true }` adds the two late-work cases of section 7.5 (the course menu's
  "Load sample data…" passes it); without it the data has no late work, so the default export keeps the old
  sheet's layout (tests load it both ways).

## 3. Calculations (`GT.calc`) — K1–K8

Numbers: arithmetic results pass through `util.fix(x)` (round to `util.FIX_DECIMALS` = 10 decimals) to
remove binary noise. Weighted points use multiply-first: `adjusted * weight / maxScore`. The total adds the
**unrounded** weighted products and applies `fix` once to the sum: rounding each item first drifts on max
scores such as 30 (an exact 80 became 79.9999999999, a C+ instead of B-).

Input parsing (`GT.util`): `parseScoreInput` accepts numbers with |x| <= `util.MAX_INPUT_ABS` (1e6); larger
values are `'invalid'` so totals stay finite. `parseCount` (weeks late, absence counts, thresholds) accepts
whole numbers from 0 to 1e6 only: text must be plain digits (optionally `"2.0"`, spaces around trimmed), so
fractions, `%`, signs, `1,000` and scientific notation (`"1e3"`) are refused. `roundTo(x, d)` is Excel `ROUND` (half away from zero, negative
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
  `{ assessmentId, state, raw, text, source, teamId, override, missing, outOfRange, notOnList, weeksLate,
     waived, penalty, adjusted, weighted, weightedUnrounded }` where
  - `missing = state !== 'number'` (empty and invalid count as 0; invalid is also flagged),
  - `outOfRange = state === 'number' && (raw < 0 || raw > maxScore)` (value is still used as entered),
  - `notOnList = state === 'number'` and the item has a drop-down list and `!model.isChoiceValue(raw)`:
    the value is kept, highlighted ("Not one of the list values") and still counted. Always a boolean.
  - `adjusted = max(0, raw - penalty)` when a late penalty applies, else `raw`; `null` when missing,
  - `weightedUnrounded = missing || maxScore <= 0 ? 0 : adjusted * weight / maxScore` (used for the sum),
  - `weighted = fix(weightedUnrounded)` (display value).
- `calc.roundTotal(x, mode)` → `none`: x; `hundredth`: `util.roundTo(x, 2)`; `integer`: `util.roundTo(x, 0)`
  (half away from zero, same as Excel `ROUND`).
- `calc.letterFor(total, scale)` → first entry (scale sorted by `min` descending) with `total >= min`,
  compared after `fix`; below every cutoff → the last letter (F).
- `calc.letterIndex(scale, letter)` → position in the scale sorted by `min` descending (0 = best letter),
  −1 when the letter is not in the scale. Use it to compare letters (order issues, pass rate).
- `calc.studentResult(course, student)` →
  `{ studentId, active, items: {aid: detail}, weightedSum, curve, totalUnrounded, total, letter,
     finalLetter, finalLetterValid, effectiveLetter, letterSource, letterDiffers, orderIssue,
     incomplete, missingCount, invalidCount, outOfRangeCount, notOnListCount, overrideCount, lateCount }`
  - `weightedSum = fix(Σ weightedUnrounded)`, `totalUnrounded = fix(weightedSum + curve)`, `total = roundTotal(totalUnrounded)`.
  - `incomplete = missingCount > 0` counting only assessments with `weight > 0`.
  - `letter` is the **suggested** letter from the cutoffs (the grid's "Suggested" column).
  - `finalLetter` = `model.finalLetterOf(student)` (null when none). `finalLetterValid` = no final letter, or
    it is a letter of the current scale (false after a scale change removed it; the letter is kept).
  - `effectiveLetter` = `finalLetter` when one is set (valid or not), else `letter`; `letterSource` =
    `'manual'` | `'cutoffs'`; `letterDiffers` = a final letter is set and differs from `letter`.
  - `orderIssue` is false here; `computeCourse` sets it for students in an `orderIssues` pair.
- `calc.computeCourse(course)` → `{ byId: {sid: result + rank, percentile, diffFromAverage, orderIssue},
   activeIds, average, weights: { sum, ok }, orderIssues, letterSummary }`
  - Active = `status === 'active'`. Withdrawn students get `rank = percentile = diffFromAverage = null`.
  - `average` = mean of active `total` (null when none).
  - Rank: competition ranking by `total` descending among active (1, 2, 2, 4).
  - Percentile: `100 * (# active with lower total) / (N − 1)`; N = 1 → 100. Ties share a percentile.
  - `diffFromAverage = fix(total − average)`.
  - A non-finite total (only possible when code sets absurd weights; normalize rejects them) is left out
    of `average`, rank and percentile (those stay null for that student); `activeIds` lists every active student.
  - `orderIssues` = `calc.findOrderIssues(course, studentResults[])`: among **active** students with a finite total
    and a final letter **of the scale**, sorted by total descending (ties by name), every pair where the
    student with the strictly lower total holds a strictly higher final letter (smaller `letterIndex`), as
    `[{ higherTotalId, lowerTotalId }]` in that order. Equal totals (after `fix`) never form a pair; students
    without a final letter, with a letter outside the scale, or withdrawn are not compared.
  - `letterSummary` = `{ active, assigned, unassigned, manualDiffers, invalid }` over active students:
    `assigned` has a final letter, `unassigned` has none (`assigned + unassigned = active`), `manualDiffers`
    has `letterDiffers`, `invalid` has a final letter outside the scale.
  - Once final letters are assigned they are the grades: statistics, pass rate, letter distribution,
    exports ("Letter Grade") and the summary view use `effectiveLetter`.
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

Excel parity (E3, stage 4). To make exported formulas give the app's totals and letters exactly, also at
a cutoff, the exporter mirrors this section: weighted cell `=MAX(0,R-P)/M*W` (P = the late penalty in
points; plain `=R/M*W` when waived or not late; an empty R is 0), total `=ROUND(<sum>+<curve>,10)` (10 =
`util.FIX_DECIMALS`, so the 1e-14 noise of the spreadsheet's own arithmetic disappears as it does in
`util.fix`), then the rounding mode, then a nested `IF` for the letter. Exact formulas: section 8.3.
- `calc.compareByName(a, b)` → last name, then first name, then `no`; case-insensitive, numeric-aware.
- `calc.sortStudents(course, results, key: 'name'|'total'|'no', dir: 'asc'|'desc')` → new array.

## 4. Change history (`GT.history`) — G5

`HistoryEntry = { id, ts, source, kind, studentId, studentName, teamId, teamName, field, fieldKey,
oldValue, newValue, note }` — values are display strings (`''` = empty), names are snapshots. The
"Final letters: n changed" summary also carries `details` (see Final letters below).

- `source`: `'edit'|'paste'|'undo'|'redo'|'import'|'restore'|'sample'|'roster'|'system'`.
- `kind`: `'score'|'team-score'|'propagation'|'override'|'override-removed'|'late'|'final-letter'|'status'|
  'team-membership'|'student'|'settings'|'attendance'|'bulk'`. `history.KIND_LABELS` names each kind
  (`'final-letter'` → "Final letter"); `history.KIND_GROUPS` puts `'final-letter'` in the **grades** group.
- `history.diffCourse(before, after, { ts, source })` → entries for every difference in:
  assessments (name/max/weight/team flag, added/removed), grade settings (curve, rounding, letter cutoffs,
  latePointsPerWeek, passingLetter), students (added/removed/name/no/status/team), team scores, individual
  entries (value/text, weeksLate, waived, override flag), and **effective** team-graded values of each
  student that changed without an individual entry change (kind `'propagation'`, note
  `"From <team> team score"`). Attendance changes (stage 3) are logged per student when a transaction
  changes ≤ 5 marks, otherwise as one `'attendance'` summary entry ("Mark everyone present" on a class
  gives ONE entry, e.g. "57 marks changed"; totals-mode counts are counted separately, e.g. "114 absence totals
  changed" for "Fill totals from per-session marks", or "4 marks and 4 absence totals changed"). Attendance settings are kind `'settings'`, fieldKey
  `'attendance.<field>'`: mode, unexcusedThreshold, **totalAbsenceThreshold** (field "Total-absence threshold",
  values `'off'` for null/missing, else the number), excusedCountsTowardStreak (`'yes'`/`'no'`), dropStreak,
  failStreak, totalsSessionsHeld. Sessions added/changed/removed are `'settings'` entries (more than 10 in one
  transaction: one "Sessions" summary). Marks deleted with a session are not itemized; the session entry
  says how many: note "Session removed with its 59 marks" (the summary adds "; N marks deleted with the
  removed sessions").
  Group order: course details and settings, assessments, placeholders, teams, students, team scores,
  individual entries, propagation, final letters, attendance.
- Final letters (STAGE2B): for students present before and after, a changed `finalLetter` gives kind
  `'final-letter'`, field "Final letter", fieldKey `'student.finalLetter'`, old/new letter (`''` = none), in
  name order. More than `history.LETTER_LIMIT` (10) changes in one transaction give ONE summary entry:
  kind `'final-letter'`, field "Final letters", fieldKey `'finalLetters'`, newValue `"<n> changed"` (shown
  as "Final letters: n changed"), note `"Students No 1, 2, …, 10, …; A ×4, B ×3, cleared ×1"` (up to 10
  students by No, then the count per new letter in scale order). The summary also keeps **every** change in
  `details: [{ studentId, studentName, no, oldValue, newValue }]` (name order; `studentName` is a snapshot,
  `no` a number or null), so a band-assigned letter stays traceable per student. Added or deleted students
  are covered by their own entries, whose notes name the final letter (`"No 5, Team 1. Scores, overrides,
  attendance and the final letter (A) were deleted with the student"`; an added student with a letter,
  e.g. an undone deletion: `"No 5, Team 1, final letter A"`). A scale change never rewrites or logs final
  letters.
- Reading summary details: `history.entryDetails(entry)` → the well-formed `details` items (`[]` for any
  other entry; stored data is read defensively; an item that names its own `field` keeps it);
  `history.detailFor(entry, studentId)` → that student's item or null (a student listed twice, e.g. marked
  again in one roll call, gives one change: the first old value and the last new value);
  `history.involvesStudent(entry, studentId)` → true when `entry.studentId` is the student or a detail
  names them. The History view's student filter matches with `involvesStudent`.
- A roll call is one entry (CODE-6): `GT.store.transact(label, mutator, { mergeKey })` folds per-student
  attendance entries into the course's last entry when that entry has the same `mergeKey`, is less than
  30 minutes old and has no `userNote`. The result replaces it: kind `'attendance'`, field = the transaction
  label (e.g. "Roll call Tue Oct 6"), fieldKey `'attendance'`, newValue `"<n> marks"`, note `"<k> students"`,
  `details: [{ studentId, studentName, no, field, oldValue, newValue }]` (every merged mark, in order; a
  student marked twice is listed twice), a new id, `mergeKey`, `ts` and `source` as usual. The first mark
  is an ordinary entry carrying the `mergeKey`. Undo and redo stay per transaction (per mark); their
  entries carry no key, so a mark after an undo starts a new entry. The History view lists the marks under
  "Show n marks"; `toRows` writes one row per mark with its own field. The attendance roll call passes
  `mergeKey: 'rollcall:' + sessionId + ':' + rollCallOpenedAt`.
- Finalizing (STAGE2B): a change of `course.finalized` gives kind `'settings'`, field "Scores finalized",
  fieldKey `'course.finalized'`, values `'no'` / `'yes (YYYY-MM-DD)'` (local date of `at`); the note says the
  score cells were locked (plus the finalize note) or unlocked. Finalizing again with a new date or note is
  logged too.
- Drop-down lists (DECISIONS 8): a change of `Assessment.choices` gives kind `'settings'`, field
  `"<name>: drop-down list"`, fieldKey `'assessment:<aid>.choices'`, values `'no'` / `'yes (steps of 0.5)'`.
  Added/removed assessments with a list are described as `"… (weight 5%, max 5, drop-down list in steps of 0.5)"`.
- `history.bulkEntry({ ts, source, field, note })` for summary-only transactions (e.g., loading sample data).
- `history.toRows(entries, { studentId })` → `[header, ...rows]` for the CSV export (columns Timestamp,
  Source, Kind, Student, Team, Field, Old value, New value, Note, User note, User note time). A summary with
  `details` is followed by one row per student (Field "Final letter", Note `Part of "Final letters: 12
  changed"`); `studentId` limits those rows to one student.
- Entries may carry `userNote` / `userNoteAt`, a free-text note the TA adds later (e.g. "changed per
  instructor email, Oct 12") via `GT.store.annotateHistory(entryId, text)`. The log is otherwise append-only.

## 5. Store (`GT.store`) and storage (`GT.storage`)

- `GT.storage.init()` → `Promise<{ backend: 'indexeddb'|'localstorage'|'memory' }>`; `load()`,
  `save(state)`, `saveSync(state)`, `clear()`, `isStale()`, `stamp()`. IndexedDB DB `grade-tracker`, object
  store `kv`, keys `state`, `state-prev` and `stamp`; localStorage keys `grade-tracker:state`,
  `grade-tracker:state-prev`, `grade-tracker:stamp` and `grade-tracker:state-base`.
- **Two open tabs (CODE-1 / E2E-1): every save is a compare-and-swap on a save stamp.** Each save writes a
  new unique stamp (time / random tab id / counter) next to the data. `load()` remembers the stored stamp;
  `save()` writes only while the stored stamp is still the one this tab loaded or last wrote, otherwise it
  rejects with a conflict error (`err.conflict === true`) and writes nothing. With IndexedDB the check, the
  data, `state-prev` and the new stamp are one readwrite transaction (atomic); with localStorage the stamp is
  `grade-tracker:stamp`, written first. Data saved by an older version has no stamp (`''`) and is taken over
  by the first save. `clear()` (Delete all data) deletes everything and stores a new stamp, so a stale tab
  can never save deleted data back; restore is a normal save (it replaces the state), so it bumps the stamp
  too. `isStale()` resolves true when the stored stamp is not this tab's.
- Emergency copy: `saveSync(state)` (page hidden or closing) writes the state to `grade-tracker:state` and
  the IndexedDB stamps it continues (the stored one plus those of saves still running) to
  `grade-tracker:state-base`. `load()` prefers that copy only while it is newer (`meta.lastSavedAt`) **and**
  the IndexedDB stamp is one of its bases; a copy written by a stale tab is ignored, and the next IndexedDB
  save removes it. A copy without bases (a localStorage-only session, an older version) wins while it is
  newer, as before. With the localStorage backend `save()` and `saveSync()` are synchronous compare-and-swap
  saves. When IndexedDB fails mid-session the data moves to localStorage with the IndexedDB stamp as its base.
- `GT.store.state` (AppState), `GT.store.course()` (active course), `GT.store.results()` (memoized
  `calc.computeCourse` for the active course, invalidated on change).
- `GT.store.transact(label, mutator, { source = 'edit', courseId, historyMode = 'diff'|'bulk'|'none' })`:
  snapshot (course without history) → `mutator(course)` → history diff appended → undo push → redo clear →
  `updatedAt` → debounced save → notify subscribers.
- `GT.store.undo()`, `redo()`, `canUndo()`, `canRedo()` — per course, in memory, capped at 200 steps.
  Undo/redo append history entries (source `'undo'`/`'redo'`); history itself is never rolled back.
  Each undo step remembers its `historyMode`: undoing or redoing a `'bulk'` step (e.g. loading sample data)
  logs one bulk entry (note `Undo of "<label>"`), not an itemized diff of every student and score.
- `GT.store.setUi(patch)`, `GT.store.setMeta(patch)`, `GT.store.replaceState(state, source)`,
  `GT.store.clearAll(state, source)` (Delete all data: cancels the pending autosave, waits for a running save,
  `GT.storage.clear()`, then `replaceState`), `GT.store.subscribe(fn)`, `GT.store.flush()` (save now),
  `GT.store.flushOnLeave()`, `GT.store.saveStatus()`, `GT.store.annotateHistory(entryId, text)`,
  `setActiveCourse/addCourse/deleteCourse/moveCourse`, `GT.store.undoStepId()` (a unique id of the active
  course's latest undo step; every pushed step, also by undo or redo, gets a new one).
- **Conflict (read-only) state.** A save rejected with a conflict, or `GT.store.checkConflict()` finding the
  tab stale (app.js calls it when another tab broadcasts `saved`, when the page becomes visible again and
  on a back/forward-cache restore), sets `saveStatus().phase === 'conflict'` (notify `{ type: 'conflict' }`).
  Then autosave stops for good; `transact`, `addCourse`, `deleteCourse`, `moveCourse`, `replaceState` and
  `clearAll` throw a conflict error before changing anything; `undo`/`redo` return false (`canUndo` false);
  `annotateHistory` returns false; `flush`/`flushOnLeave` do nothing. UI-only settings (`setUi`, `setMeta`,
  `setActiveCourse`) still change on screen but are not saved. `GT.store.readOnly()` tells views. Only a
  reload (`init`) leaves the state. UI-only changes are saved through the same compare-and-swap, so a theme or
  tab click in a stale tab fails into the conflict instead of writing old data back.
- `GT.store.hasUnsavedData()`: course data changed in this tab that is neither saved nor kept by an emergency
  copy (UI-only settings do not count; while read-only, every change not saved before the conflict counts).
  app.js warns before the page closes when it is true (failed save, saving paused, conflict) or when the
  memory backend holds data. A save error with `err.paused` (unreadable saved data, see app.js) is an error
  phase that is not logged as a failure.
- `ui` keeps per-view preference objects named `<view>Prefs` (e.g. `ui.gridPrefs`); `normalizeState` keeps
  them as shallow plain objects.

## 6. UI conventions

- Views: `GT.views[id] = { id, title, render(el, ctx), destroy?() }`. The app re-renders the active view after
  every store change (views keep their own transient UI state: sort, filters, active cell).
- All text is escaped with `util.escapeHtml`. No inline `on*=` attributes; use `addEventListener`/delegation.
- **Privacy**: every element that shows a student name or student notes has class `pii`. With privacy
  mode on, `.pii` is blurred; clicking a blurred element reveals it for 10 s.
- Keyboard: all actions reachable by keyboard; focus rings visible; dialogs use `<dialog>`.
- Placeholder badge: `<span class="badge badge-warn">needs confirmation</span>` (yellow) wherever a
  placeholder value is shown or edited.
- Sticky header: the topbar and the tabs sit in one sticky `.app-head` block. `app.js` publishes its height
  as the CSS variable `--head-h` on `<html>` (0 on phones, where the header scrolls away). Views offset their
  own page-level sticky elements with `top: calc(var(--head-h) + …)`; `html` has
  `scroll-padding-top: calc(var(--head-h) + 8px)`, so `scrollIntoView` targets land below the header.
  Sticky elements inside a view's own scroll box (table headers) need nothing. Page-level z-index: header 40,
  menus 100, toasts 200; dialogs use the top layer. Keep view z-indexes below 30.
- Cross-view links: `GT.app.navigate('settings', { section })`, `navigate('settings', { placeholder })`,
  `navigate('history', { studentId })`, `navigate('grades', { studentId, assessmentId })`,
  `navigate('attendance', { studentId })` (selects the student's row; totals mode: their Absent input),
  `navigate('attendance', { section: 'settings' | 'warnings' })` (scrolls to that card).
  - `navigate('grades', { focus: { studentId, assessmentId } })` is the same as the flat form: it selects
    that student's raw score cell (or, without a valid `assessmentId`, the student's row in the current
    column), clears the search, shows withdrawn rows again when the student is withdrawn and they are
    hidden, scrolls the cell into view and gives it the keyboard focus. The Settings late-work list uses it.
  - `GT.ui.openLateWork(studentId, assessmentId)` opens the grid's "Late work…" dialog for that score from
    any view (Student details uses it; section 13).
  - `GT.ui.openStudent(id)`, `GT.ui.openFinalize()` (section 6.1).
- Shared widgets: `GT.ui.dialog.confirm/prompt/open`, `GT.ui.toast(message, { type })`,
  `GT.ui.download(filename, blobOrText, mime)`, `GT.ui.loadExcel()`, `GT.ui.icon(name)` (inline SVG).
- App shell (`js/app.js`): `GT.app.VERSION` ('1.0.0', as in package.json), `GT.app.showShortcuts()`,
  `GT.app.showAbout()`, `GT.app.SHORTCUTS` (the list the shortcuts dialog shows; section 14).
  - `GT.app.registerLeaveHook(fn)`: `fn()` runs synchronously (each in try/catch, registering the same
    function twice is a no-op) on `pagehide`, on `visibilitychange` → hidden and on `beforeunload`, BEFORE
    `store.flushOnLeave()`. A view uses it to commit an edit that is still being typed (the grid's open
    editor, a focused Settings input). Views load before app.js, so they register on their first render,
    guarded by `if (GT.app && typeof GT.app.registerLeaveHook === 'function')`.
  - Other tabs (BroadcastChannel `grade-tracker`): messages `{ type: 'hello' | 'here' | 'goodbye' | 'saved',
    id, stamp }`. `saved` (after every successful save, with the new stamp) makes a tab whose stamp differs
    run `store.checkConflict()`; `goodbye` (on `pagehide`) removes that tab from the "also open in another
    tab" banner. In the conflict state a danger banner ("Grade Tracker was changed in another tab…") offers
    **Reload** (no leave prompt) and **Download this tab's data** (a backup of what the tab shows); the status
    bar says "Read-only: changed in another tab". Conflict errors a view does not catch become a toast.
  - Unreadable saved data (`loadProblem`): `GT.storage.save` is wrapped to reject with `err.paused`
    ("Saving is paused until you download the unreadable data and restore it or start fresh"), so the status
    says "Saving paused", the banner says changes made now are not saved, and leaving with changes warns.
  - A stored `ui.activeView` is used only when it names a registered view (`util.hasOwn(GT.views, id)`);
    `normalizeState` keeps it only when it is lowercase letters and not an `Object.prototype` name.
  - On phones the tab strip scrolls sideways; when the active tab changes, app.js scrolls the strip (never
    the page) so that the active tab is fully visible.
- `GT.ui.undoAction(courseId, label)` (widgets.js): the `{ label: 'Undo', fn }` toast action for a change
  just made with `GT.store.transact`. Its Undo acts only while that step is still the latest undo step of its
  course (the course is active, `GT.ui.undoMark(courseId)` is unchanged: label, `undoStepId`, history length,
  last entry id); otherwise it shows the "Not undone…" warning. Students & Teams and Statistics use it.
- `GT.ui.menu(anchor, items, opts)`: an item with `checked: true|false` is a `menuitemradio` with
  `aria-checked` and a check icon when chosen (the theme menu); the chosen item gets the focus when the menu
  opens. `opts.label` names the menu.

### 6.1 Final grades in the UI (STAGE2B, DECISIONS 2, 5–8)

- **Grades grid** (`js/ui/grid.js`):
  - Columns: "Suggested" (read-only `r.letter` from the cutoffs, with the placeholder badge) and "Final
    letter" (drop-down of `model.scaleLetters` plus "(none)"; markers: a dot when `letterDiffers`, a warning
    icon for a student in `orderIssues`, red when `finalLetterValid` is false).
  - Drop-down cells: an assessment with `choices` and the Final letter open a native `<select>` on Enter, F2,
    double-click, Alt+↓ or the ▾ button. Typing a list value (or a letter such as `b+`) stores it directly;
    anything else is refused with a toast and never stored. Paste and Ctrl+Enter fill validate the same way.
    Off-list values that are already stored are kept and shown yellow ("Not one of the list values").
  - Band assignment: with several rows selected, choosing or typing a value applies it to every selected
    active row in ONE transaction (withdrawn rows are skipped and reported); the cursor then waits on the
    row below the band. While sorted by Total (high to low) and not grouped, `tr.band-end` draws a rule
    between consecutive active rows whose final letters differ.
  - Column ⋯ menu on every raw-score header (also Shift+F10 in a cell): "Fill empty cells of active
    students with…", "Set every active student to…", "Clear column…" — each ONE transaction; team-graded
    columns write team scores.
  - Finalize / unlock: "Finalize scores…" shows a data check, then `model.finalize` in one transaction and a
    fresh sort by Total, high to low. Finalized (`model.isFinalized`): score, team, override, name, No and team
    cells (participation included) are read-only and refuse edits with the toast "Scores are finalized.
    Unlock them to edit."; final letters stay editable. The banner's "Unlock scores…" confirms, then
    `model.unfinalize`. Both steps are logged (section 4). `GT.gridCellMenuExtensions` ctx gets `finalized`.
  - Stable row order (DECISIONS 7): rows are a snapshot of student ids, taken again only when the sort,
    search, withdrawn filter, grouping, Meeting view, course or the set of students changes, or on
    "Order changed: re-sort" (`[data-act="resort"]`, shown when the snapshot differs from a fresh sort).
  - Meeting view (`gridPrefs.meeting`, the previous sort in `gridPrefs.meetingPrev`): No, Last, First, the
    raw scores, Total, the absence columns, participation, Suggested, Final letter, Rank; sorted by Total,
    high to low; larger text; participation and Final letter marked "fill in the meeting". It fits a
    1280 px window, also for SE 6362 with attendance on (STAGE6 carry-over):
    - Last Name and First Name are only as wide as the longest name shown needs (`meetingNameWidths`, at
      most `WM.last` / `WM.first`); a withdrawn student's badge is a short "W" (title "Withdrawn"), and
      First Name's sticky offset follows Last Name's width (CSS variable `--sc3-left` on the table).
    - A short item name that ends with a long word ("Term Paper") may wrap; one that ends with a short word
      ("Project I", "Test 1") stays on one line.
    - Final letter and Rank are pinned on the right (`position: sticky`, classes `pr pr2` / `pr pr1`, edge
      line on `pr-first`), so they stay on screen without sideways scrolling whatever the names and the
      window width; `ensureVisible` scrolls a cell out from under them. Phones (≤ 720 px) and print do not
      pin them.
  - Absence columns "Excused (allowed)", "Unexcused (not allowed)", "Total absences" (toggles
    `gridPrefs.cols.attExcused / attUnexcused / attTotal`) appear when attendance is not off (per-session
    and totals modes) and read `GT.attendance.summary(course, studentId)` (section 7), cached per render.
    The Unexcused cell carries a warning icon and a tooltip for a 'fail'/'drop' streak or `overThreshold`;
    the Total cell for `overTotalThreshold`. The cells are read-only ("Absences come from the Attendance
    tab").
- **Cross-view**: `GT.ui.openFinalize()` opens the grid's Finalize dialog from any view (it switches to
  Grades first). Settings has a "Grading status" card (`navigate('settings', { section: 'status' })`) with
  Finalize / Unlock, the final-letter counts and "Copy suggested letters into empty final letters".
- **Settings when finalized**: weights, max scores, rounding, curve and cutoffs show "Scores are finalized:
  changing this changes totals." (cutoffs: "…changes the suggested letters") and confirm with the impact
  before saving. Each assessment has a "Drop-down list" toggle and step (`max / step ≤ 200`; a max score
  that would break the list is refused).
- **Students**: the table has a read-only Final letter column; `GT.ui.openStudent(id)` shows the suggested
  letter, an editable Final letter select (`#sd-final`) and a select for each individually entered item with
  a list (disabled when finalized). Team scores are read-only when finalized.

## 7. Attendance (`GT.attendance`) — T1–T6, X7, DECISIONS 3 and 6

`js/core/attendance.js`, pure and UMD like `calc.js` (depends on `util` and `model`; load it after `model.js`).
Tests: `tests/attendance.test.js`. Marks: **P** Present, **A** Absent = *not allowed, unexcused*,
**E** Excused = *allowed, instructor-approved* (DECISIONS 3). In the UI use the words "Excused (allowed,
instructor-approved)" and "Absent (not allowed, unexcused)".

### 7.1 Definitions (also for the README)

- A session is **held** when at least one student of the course (active or withdrawn) has a mark for it.
  Sessions nobody has marked yet (future sessions, a day the roll was not taken) are ignored completely: they
  are not counted and they do not break streaks. Marks stored for ids that are not students of the course,
  and values other than P/A/E, are ignored.
- A student's **recorded sessions** are the held sessions where that student has a mark (P, A or E).
  A held session where this student has **no** mark is "unknown": not counted, and it **breaks** a streak
  (conservative: no warning is based on a guess).
- `present` = P marks, `absent` = A marks, `excused` = E marks (held sessions only).
- `totalAbsences = absent + excused` (T3). `unexcused = absent` (T3).
- `absenceRate = 100 × totalAbsences / recorded`, `unexcusedRate = 100 × absent / recorded` (through
  `util.fix`); both `null` when `recorded = 0`.
- **Streak**: a maximal run of consecutive held sessions, in date order, where the student's mark counts as
  an absence. 'A' always counts. 'E' counts only when `excusedCountsTowardStreak` is true. The default is
  **false** (DECISIONS 6: at the user's request, allowed absences do not count against the student; the
  original request defaulted to "all absences count"), and then an 'E' **breaks** the run. 'P' and unknown
  also break it; unmarked (not held) sessions are skipped.
- `longestStreak` = the longest run (0 when none). `streaks` lists only runs of length ≥ 2, oldest first.
  `currentStreak` = the run ending at the student's latest recorded session (0 when that mark does not
  count as an absence; held sessions after it where the student is unmarked do not reset it).
- `warning`: `'fail'` when `longestStreak ≥ failStreak` (default 4; text "4 consecutive absences: syllabus
  says F"), else `'drop'` when `longestStreak ≥ dropStreak` (default 3; "3 consecutive absences: syllabus says
  one letter grade drop"), else `null`. The number in the text is the actual `longestStreak`. **Warnings
  only: nothing ever changes a grade** (T5); attendance never feeds participation (T6).
- `overThreshold = unexcused > unexcusedThreshold` (strictly greater, T4).
- `overTotalThreshold = totalAbsences > totalAbsenceThreshold` when that optional setting is a number
  (DECISIONS 3; `null` = off, the default); shown like the unexcused threshold and listed in the warnings as
  kind `'total-threshold'`. Its placeholder text lives in the `unexcusedThreshold` note (section 2.2).

Totals-only mode: `absent` and `excused` come from `attendance.totals[sid]` (missing → 0), `recorded =
held = totalsSessionsHeld`, `present = max(0, recorded − totalAbsences)` (derived), rates use that
denominator (null when 0). Streaks are not available: `longestStreak = currentStreak = null`, `streaks = []`,
`streaksAvailable = false`, `warning = null` (the UI shows "n/a in totals mode"). The thresholds work the
same. `moreAbsencesThanSessions` is true when `totalAbsences > recorded` (so the UI can flag the typo).

Off mode: `summary()` returns `null`. Switching modes never deletes records, totals or sessions.

### 7.2 Reading

- `summary(course, studentId)` → `null` when the mode is `'off'` (or the course has no attendance / an
  unknown mode); else `{ mode, held, recorded, unmarked, present, absent, excused, totalAbsences, unexcused,
  absenceRate, unexcusedRate, longestStreak, currentStreak, streaks: [{ startDate, endDate, length, sessionIds,
  dates }], streaksAvailable, excusedCountsTowardStreak, warning: null|'drop'|'fail', overThreshold,
  overTotalThreshold, moreAbsencesThanSessions }`. `held` = held sessions (per-session) or totalsSessionsHeld;
  `unmarked` = held sessions without a mark for this student (0 in totals mode).
- `heldSessions(course)` → the held session objects, in date order (stable for equal dates).
- `sessionCounts(course, sessionId)` → `{ present, absent, excused, unmarked, marked, presentRate }` over
  **active** students only (`marked = P + A + E`; `presentRate = 100 × present / marked`, null when 0).
- `markCount(course, sessionId)` → marks for that session by every student of the course, withdrawn
  included: exactly what `clearSession` / `removeSession` delete, for "N marks will be lost".
- `courseSummary(course)` → `{ mode, held, total: sessions.length, byStudent: { sid: summary }, warnings }`.
  `byStudent` covers every student (withdrawn included). `warnings` covers **active** students only, one
  item per student and kind: `{ studentId, kind: 'fail'|'drop'|'threshold'|'total-threshold', detail,
  count, limit, streak }`, sorted fail, drop, threshold, total-threshold, then by name (last, first, No).
  `detail` is the readable text (e.g. "6 unexcused absences: above the unexcused-absence threshold (3)",
  "7 absences in total (excused + unexcused): above the total-absence threshold (6)"); `count` is the
  streak length or absence count; `limit` the setting it passed; `streak` the longest run (oldest of equal
  runs; its `dates` give "Oct 1, Oct 6, Oct 8") for fail/drop, else null. Off: `held 0`, `byStudent {}`,
  `warnings []`.
- `totalsFromRecords(course)` → `{ held, totals: { sid: { absent, excused } } }` counted from the marks of
  held sessions (e.g. to prefill the totals-only table).
- `markLabel(m)` → 'Present' | 'Absent' | 'Excused' | ''. `parseMark(input)` → `{ kind: 'mark', mark }`
  (accepts p/a/e in any case and the words present/absent/excused), `{ kind: 'empty' }` or
  `{ kind: 'invalid', text }`. `cycleMark(m)`: blank → P → A → E → blank (Space in the grid).
- `nearestSessionIndex(course, isoDate)` → index in `attendance.sessions` of the earliest session on or
  after `isoDate`, else the latest session; −1 when there are no sessions or the date is invalid ("Jump to
  today" passes the computer's local date).
- `mergeSessions(existing, generated, taken?)` → a NEW list sorted by date (stable). Every existing session
  is kept (id, date, label, so its marks stay); a generated session is added only when no session has its
  date (each date once); an added session whose id is taken (e.g. an existing session moved to another date
  keeps `ses_20260908`) gets `ses_20260908_2`. `taken` (optional; the UI passes the course): the course, or a
  Set / array of ids also in use — with the course, ids used by marks whose session is gone (a restored file
  whose session had a bad date) are skipped too, so those old marks never reappear on a new session. Never
  drops a session; inputs are not changed.
- `sessionIdsInUse(course)` → Set of the session ids in `attendance.sessions` and in `attendance.records`
  (`addSession` and `mergeSessions(…, course)` never reuse them).
- `MARKS` = ['P', 'A', 'E'], `MODES` = ['per-session', 'totals', 'off'].

### 7.3 Changing (call inside `GT.store.transact`; each helper changes the course in place)

- `setMark(course, studentId, sessionId, mark|null)` → true when the stored mark changed. `mark` goes through
  `parseMark` (null/'' clears; an emptied student row is removed); anything else **throws** a readable Error.
  Unknown student or session → false, nothing written.
- `setMarks(course, [{ studentId, sessionId, mark }])` → number changed; invalid items are skipped (a range
  of cells, roll call: ONE transaction, ONE undo step).
- `markAllPresent(course, sessionId, { activeOnly = true })` → number set: 'P' for every student with **no**
  mark for that session (existing marks are never changed; withdrawn skipped unless `activeOnly: false`).
  In one transaction this is ONE history entry.
- `clearSession(course, sessionId)` → marks removed (the session stays and is no longer held).
- `addSession(course, { date, label })` → the new session, inserted in date order, id `ses_YYYYMMDD` (or
  `_2`, `_3` … when that id is used by a session or by stored marks). A second session on a date needs a
  label; sessions on one date need distinct labels (case-insensitive) with at most one unlabeled. Bad dates
  and clashes throw readable Errors.
- `updateSession(course, id, { date?, label? })` → the session (id and marks kept, list re-sorted), or null
  for an unknown id; same date rules.
- `removeSession(course, id)` → marks removed (= `markCount` before); unknown id → 0, nothing changes.
- `setTotals(course, studentId, { absent?, excused? })` → true when changed. Whole numbers >= 0 (numbers,
  or text through `util.parseCount`); anything else throws and nothing changes; a missing field keeps its
  value; unknown student → false; 0 and 0 for a student without a row adds no row.
- `setSessionsHeld(course, n)` (totals-mode denominator, whole number >= 0) and `setMode(course, mode)`
  (throws for an unknown mode; data of the other modes is kept) → true when changed.

### 7.4 The Attendance tab and the other views (`js/ui/attendance.js`, `css/attendance.css`)

- `GT.views.attendance = { id, title, render, destroy, lastRenderMs(), openSessions({ generate? }),
  openRollCall(sessionId|null) }`. Per-viewer preferences: `ui.attendancePrefs = { showWithdrawn, summary }`.
  Every core call is guarded: without `GT.attendance` the tab shows a warning instead of failing.
- Header: course code, mode selector (Per session / Totals only / Off, `setMode` in one transaction; data of
  the other modes is kept). Off: an empty state with "Turn on attendance (per session)" and "Use totals only".
- Per-session grid: sticky No / Last / First (names `pii`), one column per session ("Thu" over "Sep 3", label
  below; sessions nobody marked are lighter). Keys: arrows, `p`/`a`/`e` set and move down, Space cycles
  (`cycleMark`), Delete clears, Shift+arrows or a drag select a range and one key sets it in ONE transaction
  (`setMarks`; withdrawn rows are skipped in a multi-row range). A second click cycles; right-click opens
  Present / Absent / Excused / Clear. Session header menu: "Mark everyone without a mark as Present"
  (`markAllPresent`, one transaction, one history entry), take roll, edit date/label, clear, delete (the
  confirmation states `markCount`). Pinned summary columns on the right: Excused (allowed), Unexcused (not
  allowed), Total absences, Absence rate, Unexcused rate, Longest streak, Syllabus warning (chips "4 in a row:
  F per syllabus", "3 in a row: 1 letter drop"; "(warning only)" is in screen-reader text, the tooltip, the
  header and the Warnings card). Threshold highlights: `.over` with the tooltip "Above the unexcused-absence
  threshold (N)" (Total: the total-absence threshold). Footer: per-session counts over active students.
  The body is one innerHTML string (`lastRenderMs()` measures it).
- Session manager (dialog): list with mark counts, add (a second session on a date needs a label), edit,
  delete, and "Generate…" prefilled with Fall 2026 Tue/Thu (2026-09-03 to 2026-12-08, skipping 11-24 and
  11-26), merged through `mergeSessions(existing, generated, course)`.
- Roll call (dialog): one active student per row with P / A / E buttons; the keys P / A / E mark and advance
  (one transaction per mark); "Mark remaining present" is one `markAllPresent` transaction.
- Totals-only table: Absent (not allowed, unexcused) and Excused (allowed, instructor-approved) inputs checked
  with `util.parseCount` (a refused value shows an inline error, is not saved, and survives re-renders);
  "Sessions held so far" is the denominator; streaks read "n/a in totals mode".
- Settings card: unexcused threshold (placeholder badge, "Mark confirmed"), optional total threshold (empty =
  off), "Excused absences count toward a streak" (off by default; the help says the user changed it), the
  consecutive-absence rule "(from the syllabus)" validated F > drop ≥ 2, and the text "Warnings never change
  grades" / "Attendance does not feed Class/Project Participation".
- Warnings card: `courseSummary().warnings` grouped per active student, with the streak dates, "Show in the
  grid" and "Details".
- Student detail (`GT.ui.openStudent`, js/ui/students.js): an Attendance section (hidden when off) with
  Excused / Unexcused / Total / both rates / Longest streak, the basis ("Out of N recorded sessions", held
  sessions without a mark), the fail/drop warning with its dates, the threshold warnings, the list of absences
  by date (excused vs unexcused, "part of N in a row"), the dates without a mark, and "Open in Attendance".
- Settings → Needs confirmation: the `unexcusedThreshold` item's current value also states the total-absence
  threshold; "Open Attendance" goes to the attendance settings card.

### 7.5 Sample data

The SE 4351 sample (`GT.sample.loadInto`) marks all 26 sessions for every student: mostly present, random
absences that never form a run of 3, exactly one run of 3 and one run of 4 **unexcused** ('A') absences
(framed by presences, active students), one student with 5 scattered unexcused absences, and one active
student with 4 **excused** absences never next to each other and no unexcused ones (note "Sample note:
absences excused by the instructor (medical)"), so the Excused column is not all zeros. The warnings are the
same with either `excusedCountsTowardStreak` setting: one 'drop', one 'fail'. Each case uses its own random
stream, so every other value of the sample stays as it was. SE 6362 (off) gets random marks only.

Late work (`loadInto(course, { lateWork: true })`, its own random stream 'late'; STAGE6 §1): exactly two
cases per dataset, on students without another role:
1. one active student's Test 1, 1 week late, penalty applied (note "Sample note: Test 1 handed in 1 week
   late, not pre-approved");
2. one team's Project I, 1 week late, penalty waived (pre-approved), on the team score, so it reaches every
   member without an override (the team of the override member is avoided).

## 8. Export (`GT.exporter`) — E1–E3

`js/core/exporter.js`, pure and UMD like `calc.js` (depends on `util`, `model`, `calc`; `csv`, `attendance`
and `history` are looked up when first needed, so the script may load before them). It never loads ExcelJS:
`toWorkbook` receives it (`GT.ui.loadExcel()` in the browser, `require('../vendor/exceljs.min.js')` in Node).
Tests: `tests/exporter.test.js` with the formula evaluator `tests/helpers/mini-excel.js`. Exported files hold
confidential grades: the UI says to keep them out of shared or synced folders and out of the repository
(`.gitignore` already excludes `*.xlsx`, `*.csv` and backup JSON).

### 8.1 Columns and presets

`columnsFor(course)` → `[{ key, label, group, available, reason?, assessmentId? }]`, in this (catalog) order:

| Key | Label | Value |
|---|---|---|
| `no`, `lastName`, `firstName`, `team` | No, Last Name, First Name, Team | the student's fields (team name) |
| `raw:<aid>` | the assessment name ("Project I") | the effective raw score (team score or override); empty → blank |
| `weighted:<aid>` | "<name> <weight>%" ("Project I 10%", like the old sheet) | formula (8.3) |
| `late:<aid>` | "<name>: weeks late" | weeks (number), `"2 (waived)"` when waived, blank when on time |
| `total` | Total | formula |
| `letter` | Letter Grade | the **effective** letter (8.3) |
| `suggestedLetter` | Suggested Letter (cutoffs) | always the nested-IF formula |
| `finalLetter` | Final Letter | static; empty when not set |
| `rank`, `percentile`, `diffAvg`, `incomplete` | Rank, Percentile, Diff. from average, Missing scores | static (`calc.computeCourse`); blank rank, percentile and difference for withdrawn students |
| `excused`, `unexcused`, `absences` | Excused (allowed), Unexcused (not allowed), Total absences | static, from `GT.attendance.summary` |
| `absenceRate`, `unexcusedRate` | Absence rate %, Unexcused rate % | static (blank when no session is recorded) |
| `status`, `notes` | Status ("Active" / "Withdrawn"), Notes | static |

Groups: `student`, `raw`, `weighted`, `late`, `result`, `letter`, `attendance`. While attendance is off every
attendance column has `available: false`, reason "Attendance is off for this course".

- `builtInPresets(course)` → `builtin:previous` "Previous sheet layout (default)": No, Last Name, First Name,
  every raw column, every weighted column, the "<name>: weeks late" column of each item with late work (any
  student's effective entry late, waived or not; none for on-time courses, so the old-sheet layout is
  unchanged), Total, Letter Grade, Excused (allowed), Unexcused (not allowed), Total absences, Status (E2 plus
  Status and the three absence columns of DECISIONS 6; the absence columns are skipped while attendance is
  off). Without the weeks-late column an import of the file would lose the penalty and raise the total
  (review V4R1-7); the late columns come after the weighted block, so the Total stays one SUM range;
  `builtin:compact` "Names, total and letter": No, Last Name, First
  Name, Team, Total, Letter Grade, Status; `builtin:everything` "Everything": every available column.
- User presets: `course.exportPresets = [{ id, name, columns }]`; `makePreset(name, columns)` builds one
  (id `xp_…`); the UI saves it with `GT.store.transact(…, { historyMode: 'none' })`. `allPresets(course)` →
  built-ins then the user's (each with `builtIn`).
- `resolveColumns(course, keys)` → `{ columns, skipped: [{ key, label, reason }] }`: unknown keys (an
  assessment deleted since the preset was saved) are skipped silently (`reason: 'unknown'`), unavailable ones
  with their reason, a repeated key once.

### 8.2 The sheet model

`buildSheet(course, results, keys, { sort: 'name' | 'no' })` (pure) →
`{ columns: [{ key, label, width, group, tint, note }], rows: [[cell]], rowMeta: [{ studentId, withdrawn }],
skipped, notes }`. Rows are every student, withdrawn included (S2), in name order (or by No). A cell is
`{ v, f?, note?, style?, exact? }`: `v` the value (numbers stay numbers; an empty score is `null`; invalid
text is `null` with the note `Entered text "abc" is not a number, so it counts as 0`); `f` a formula without
`=` in A1 notation (row 1 is the header); `style` `'invalid'` (invalid or out of range), `'override'` or
`'withdrawn'`; `exact` the full-precision number of a static weighted cell (`v` is the rounded display
value). `notes` lists skipped columns ("Skipped (Attendance is off for this course): …") and says when
Letter Grade holds final letters.

Cell notes: an override "Per-member override (team score 90). An unequal split needs the team's written
agreement."; late work "1 week late, −10 points" or "1 week late, penalty waived" (on the raw cell, else the
weighted cell); out of range "Outside 0–100; counted as entered"; off the drop-down list "Not one of the list
values (0–5 in steps of 0.5); counted as entered"; a manual letter "Final letter assigned by the instructor";
a plain (static) Letter Grade suggestion "Suggestion from the cutoffs: B+" and, on a second line, "No final letter
assigned yet." (review V4R2-1: the importer compares the cell with the letter in its note, 9.1, so a letter
the instructor types over it in the spreadsheet is recognized; typing into a cell keeps its note);
a Total whose formula holds fixed numbers (items with neither column exported) "Fixed numbers in this formula:
Project II 19.4, Class/Project Participation 4; curve +2.5." (the Total header note names those items too).
Late notes use the penalty of 8.3 also for an empty or invalid score ("2 weeks late, −20 points").
Header notes: raw "Out of 100. Team-graded: …"; weighted "= raw ÷ max × weight (Project I ÷ 100 × 10). Late
work: …"; Total "= sum of weighted + curve (2.5), rounding: nearest 0.01. …"; Letter Grade and Suggested
the cutoff list ("A+ ≥ 97, A ≥ 93, …, F below 60") plus "PLACEHOLDER: not confirmed by the instructor" while
the `letterScale` placeholder is unconfirmed.

Widths: `clamp(max(header length, longest value) + 2, 5, 40)` (numbers measured as displayed with the
course's decimals), names at least 14. Tints by assessment position, header and body of its raw, weighted
and weeks-late columns: green `FFE2EFDA`, orange `FFFCE4D6`, blue `FFDDEBF7`, pink `FFF8DCEF`, violet
`FFE9E1F5`, then grey `FFEDEDED`.

### 8.3 Formulas (E3)

R = the raw cell of that assessment in the same row, M = max score, W = weight, P = the late penalty in
points (`calc.latePenalty`: weeks × points per week × M / 100; 0 when waived or on time) — also for an
empty or invalid score: `MAX(0,blank-P)` is 0 like the app, and a score typed into the file later loses P
as it does in the app, where the entry keeps its weeks late. Every literal is written at full precision
(`String(number)`), never rounded.

- **Weighted** (when the raw column is exported): `R/M*W`, or `MAX(0,R-P)/M*W` with a penalty, e.g.
  `D2/100*10`, `MAX(0,F2-10)/100*25`, `H2/5*5`. A blank R is 0, as in the app. Team-graded items use the
  student's own raw cell (it holds the effective value). Without the raw column: the static value (`exact`).
- **Sum**: `SUM(I2:M2)` when the weighted column of every item with a weight is exported and the columns from
  the first to the last of them are all weighted columns (a weight-0 column inside the range adds 0);
  otherwise one term per item with a weight: its weighted cell if exported, else its raw expression if the
  raw column is exported, else the static weighted value at full precision (`19.166666666666668`).
- **Total** (`inner` = sum, plus `+curve` / `-curve` when the curve is not 0):
  - rounding none: `ROUND(inner,10)`
  - nearest whole number: `ROUND(ROUND(inner,10),0)`
  - nearest 0.01: `ROUND(ROUND((inner)*100,8),0)/100` (parentheses left out around a lone `SUM(…)`).
  The 10 decimals mirror `util.fix`: Project I 82, Project II 94, Test 1 81.6, Test 2 94, Participation 5 is
  exactly 90 (A-) in the app, but `R/M*W` adds up to 89.99999999999999 in any spreadsheet, a B+ without the
  ROUND. The 0.01 form equals `ROUND(ROUND(inner,10),2)` in Excel, LibreOffice and Google Sheets, whose ROUND
  works on the decimal value (79.725 → 79.73, like `util.roundTo`); scaling first makes a half cent exactly
  k + 0.5, so engines whose ROUND works on the binary value (HyperFormula: `Math.round(x * 100) / 100` gives
  79.72) agree too. A half is exact in binary, so the whole-number form needs no such care.
- **Suggested letter**: a nested IF over the scale sorted by cutoff, highest first, the lowest letter as the
  else branch (works in every spreadsheet app and for totals below 0), quotes in letters doubled:
  `IF(N2>=97,"A+",IF(N2>=93,"A",…,IF(N2>=60,"D-","F")…))`. Graduate scale:
  `IF(T2>=93,"A",IF(T2>=90,"A-",IF(T2>=87,"B+",IF(T2>=83,"B",IF(T2>=80,"B-",IF(T2>=77,"C+",IF(T2>=70,"C","F")))))))`.
  Without an exported Total column: the static suggested letter.
- **Letter Grade** (DESIGN 2.5): when **any** student of the course has a final letter, it is the static
  `effectiveLetter` for every student (the final letter, else the suggestion), manual ones with the note
  "Final letter assigned by the instructor", suggestions with the note "Suggestion from the cutoffs:
  <letter>" (8.2); when no final letter exists yet, the nested-IF formula (without a Total column: the static
  suggestion with that note). The default preset keeps this single letter column.
- Rank, percentile, difference from the average, missing scores and the attendance columns are static.

Parity is tested (`tests/exporter.test.js`): for the SE4351 and SE6362 samples in every rounding mode, with
curve 0 and 2.5, late entries (1 and 2 weeks, one waived, a late team score and a late override) and with
and without final letters, every Total, Suggested and Letter Grade cell of the built sheet **and** of the real
.xlsx (written, then read back with ExcelJS) evaluates to exactly the app's total, suggested letter and
effective letter; also every cutoff of the scale reached exactly, 89.995 / 89.5 / 89.49 under each rounding
mode, a negative total with a negative curve, and a 300-student random sweep with max scores 30, 7, 45 and 3,
fractional weights, late work and curves 0, 2.5, 1.37 and −3. `mini-excel` evaluates each sheet twice, with
Excel's decimal ROUND and with a naive binary ROUND. Parity is exact to 1e-10: with rounding "none" and
contrived inputs (scores with 5+ decimals and weights such as 1.5625, or late points of 1e-7) a weighted sum
can sit exactly on a tie at the 11th decimal, which `util.fix` and a spreadsheet's `ROUND(…,10)` may break
differently (letters are not affected; realistic data never reaches it).

### 8.4 Files

- `toWorkbook(ExcelJS, course, results, keys, { sort, includeSettings = true, includeHistory = false, now })`
  → `Promise<ArrayBuffer>`. Sheet **Grades**: header row bold, wrapped, grey fill `FFBFBFBF` (tinted over
  assessment columns), with the header notes; frozen `{ state: 'frozen', ySplit: 1, xSplit: <leading
  columns among No / Last Name / First Name / Team> }`; autoFilter over the header; widths from 8.2; thin
  borders on every cell; withdrawn rows in grey italics; invalid cells red, override cells bold; formula
  cells `{ formula, result }` with the app's value as the cached result; weighted, Total, Percentile, Diff.
  from average and the rates shown with the course's display decimals (number format `0.00` for 2, `0`
  for a Total rounded to whole numbers; the values keep full precision); landscape, fit to one page wide,
  header row repeated. `workbook.calcProperties.fullCalcOnLoad = true` (Excel recalculates on opening).
  Sheet **Settings** (`settingsRows(course, results, iso)`): course, term, level, export time in local time
  like the file name ("2026-12-15 19:00 (local time, UTC-06:00)"), student counts;
  the assessments (name, max, weight %, team-graded, drop-down list) and the weight sum; rounding, curve, late
  work, passing letter; whether Letter Grade holds final letters ("Final letters assigned by the instructor
  (n of m active students) …") or suggestions; "Scores finalized: Yes, on YYYY-MM-DD (note)" or "No";
  attendance mode; the letter scale (headed "PLACEHOLDER: …" while unconfirmed); every unconfirmed
  placeholder with its note; "Generated by Grade Tracker (offline). Formulas in the Grades sheet recalculate
  if you edit raw scores." Sheet **Change history** (option): `GT.history.toRows(course.history)`.
- `toCsv(course, results, keys, opts)`: the same columns as values only, `GT.csv.stringify(rows, { bom: true,
  eol: '\r\n', guardFormulas: true })` (text starting with `= + - @` gets a leading apostrophe, and so does
  the part of a text after a `;` or a tab, "x;'=1+1", because Excel in a `;` locale splits a double-clicked
  .csv there even inside quotes; numbers are written as numbers, so a negative difference from the average
  is not guarded). The importer removes these apostrophes again (9.1).
- `XLSX_MIME` for the download.

### 8.5 Data check

`dataCheck(course, results)` → `{ items: [{ level: 'warn' | 'info', text }] }`, shown above the download
buttons; it never blocks a download. In order: "Scores finalized on YYYY-MM-DD." (info) or "Scores not
finalized yet." (warn); weights not adding up to 100 (warn); "The letter-grade cutoffs are placeholders, not
confirmed by the instructor." (warn); per item with a weight, active students without a score ("Test 1: 2
active students without a score (counts as 0).", warn) — for the participation item "Class/Project
Participation is still empty for n active students (counts as 0 until it is set)." (warn); entries that are
not numbers (warn); scores out of range (warn); scores not on the drop-down list (info); final letters: none
yet (info) or n active students without one (info), letters outside the scale (warn); final letters equal
to their suggestion (info, review V4R2-3: "1 final letter equals the suggestion from the cutoffs. A CSV file
cannot show that it is final: imported back, it stays a suggestion. The Excel file marks final letters, and
the "Final Letter" column (in the "Everything" preset) keeps them in both formats."); pairs of final letters
out of order (`orderIssues`, warn); per-member overrides (info); withdrawn students included (info); the
other unconfirmed placeholders (info); "This course has no students yet." (warn).

## 9. Import (`GT.importer`) — E4

`js/core/importer.js`, pure and UMD (depends on `util`, `model`, `calc`; `csv` and `attendance` looked up when
needed). Tests: `tests/importer.test.js`.

### 9.1 Reading

- `readWorkbook(ExcelJS, arrayBuffer, limits?)` → `Promise<[{ name, hidden, rows, formulaColumns,
  finalLetterCells, editedLetterCells, truncatedRows, truncatedColumns }]>`, one per worksheet; a file ExcelJS
  cannot read rejects with "This file could not be read as an Excel workbook (.xlsx). Open it in Excel and use
  Save As → Excel Workbook (.xlsx), then import that file." `finalLetterCells` and `editedLetterCells` are
  `null` unless the workbook was written by Grade Tracker (creator "Grade Tracker", or the Settings sheet's
  "Generated by Grade Tracker" line). Then `finalLetterCells` lists the `[rowIndex, colIndex]` cells that hold
  a letter the instructor chose (pass it to `plan` as an option, 9.3): those whose note starts with "Final
  letter assigned by the instructor", and the letters changed in the spreadsheet after the export
  (`editedLetterCells`, review V4R2-1): a cell whose text is no longer the letter of its "Suggestion from the
  cutoffs: <letter>" note (case, spaces and dash variants ignored; typing into a cell keeps its note), and a
  plain value below row 1 in a column of letter formulas (formulas with a text result) or of such notes, i.e.
  typed or pasted over the formula or over the noted cell. A letter column with such cells is left out of
  `formulaColumns`, so `guessMapping` maps it; its formulas and unchanged suggestions stay suggestions. A
  suggestion left unchanged after a score was changed in the spreadsheet (the recalculated Total no longer
  gives it) is still recognized as the export's suggestion, and so are the file's suggestions when the
  cutoffs changed here since the export: the note, not the total, tells.
- **Limits** (`DEFAULT_LIMITS` = `{ maxRows: 10000, maxCols: 256 }`, or `limits`): rows after `maxRows` and
  columns after `maxCols` are never read (`findRow` / `findCell`, which create nothing), so a stray cell at
  A1048576 or XFD2, or a CSV line of a million commas, cannot exhaust memory; `truncatedRows` /
  `truncatedColumns` say that something not empty was left out. The UI still refuses more than 5,000 rows.
- **Merged cells**: a merged range gives its value to its first column only, so a title merged over A1:P1
  reads as one cell (the others ''), as Excel shows it; the cells below the first one of a vertical span
  keep the value (a team score merged over the members' rows applies to each).
- `rowsFromWorksheet(ws)` → `string[][]` (sheet row 1 = index 0): a number → its string (through `util.fix`,
  so 9.399999999999999 → "9.4"); a formula → its cached result (none → ''); rich text joined; a hyperlink →
  its text; a date → `YYYY-MM-DD`; a boolean → TRUE/FALSE; an error or null → ''. Trailing empty rows and
  columns are trimmed and every row has the same width. `formulaColumnsOf(ws)` → 0-based columns whose
  non-empty cells are at least half formulas.
- `rowsFromCsv(text, limits?)` (`GT.csv.parseTable`: delimiter detected, BOM, quotes, the same limits),
  tidied the same way; `readCsv(text, limits?)` → `{ rows, delimiter, truncatedRows, truncatedColumns }`.
  Each cell as the spreadsheet showed it: the apostrophe a CSV formula guard puts before `= + - @` (Grade
  Tracker's export, 8.4) is removed, at the start and after a `;` or tab, so names and notes come back
  unchanged; in a `;`-separated file (Excel in comma-decimal locales) a cell like "92,5" is 92.5.
- `fileKind(name)` → `'xlsx'` (.xlsx, .xlsm) | `'csv'` (.csv, .tsv, .txt) | `'xls'` | `'other'`;
  `XLS_MESSAGE` = "Open it in Excel and use Save As → Excel Workbook (.xlsx), then import that file."
- `detectHeaderRow(rows, course?)` → among the first 30 rows, the one whose cells `guessMapping` recognizes
  the most (at least 2 different targets; the first on a tie; `course` adds its assessment names), so a
  title row ("Course:", "SE 4351") above the headers is passed over; otherwise the first row with at least
  2 different non-empty cells that are not numbers; else 0.

### 9.2 Targets and the guessed mapping

`targetsFor(course)` → `[{ key, label, group, score?, attendance? }]`: `ignore`; `no`, `lastName`,
`firstName`, `fullName` ("Last, First" or "First Last": with a comma the part before it is the last name,
else the last word), `team`, `status`, `notes`; per assessment `raw:<aid>` "<name> (score out of <max>)",
`weighted:<aid>` "Weighted <name> (converted to raw = value ÷ weight × max)" (not for a weight of 0),
`late:<aid>` "<name>: weeks late"; `finalLetter` "Final letter"; `absent` (unexcused, attendance totals),
`excused`, `absencesTotal` "Total absences (stored as unexcused)". `score: true` marks the score targets
(`isScoreTarget(key)`: raw, weighted, late), `isAttendanceTarget(key)` the attendance ones.

`guessMapping(headerCells, course, { formulaColumns, editedLetterCells }?)` → a target key per column. Rules, in order:

1. Blank → `ignore`. "No" only for exactly `no`, `no.`, `#`, `number`, `student no`, `student no.`,
   `student #`, `student number`, `nr` (never "No of Absence").
2. The header is normalized (lower case, punctuation dropped except `%`, which becomes its own token) and
   compared as a whole: last name / last / surname / family name → `lastName`; first name / first / given
   name → `firstName`; name / student / student name / full name → `fullName`; team / group → `team`;
   status → `status`; notes / note / comments / remarks → `notes`.
3. A token `rate` → `ignore` (absence rates); `unexcused` → `absent`; `excused` → `excused`; `absence(s)` →
   `absencesTotal`; exactly "absent" → `absent`; `suggested` → `ignore`; `letter` → `finalLetter` ("final
   letter" scores higher than "letter grade"); exactly "grade" / "final grade" → `finalLetter` (weakest);
   total / sum / rank / percentile / average / avg / mean / diff / difference / missing / count → `ignore`.
4. An assessment matches when its name tokens appear as a contiguous run that is **not followed by another
   roman-numeral token** (so "project i" never matches "Project II", and an item "Project" does not match
   "Project II"); the longest run wins. Otherwise the category keywords: `participation` → the participation
   item, `paper` → the paper item. Then `late` → `late:<aid>`; a `%` token, or a trailing number equal to the
   item's weight, → `weighted:<aid>` (`ignore` for a weight of 0, or when the header itself says 0%); else
   `raw:<aid>`. `weightFromHeader(text)` → the number before the last `%` ("Project II 20%" → 20, "12,5 %"
   → 12.5) or `null`: `plan` converts with it (9.3).
5. A target claimed by two columns stays with the stronger match (ties: the first column); the other becomes
   `ignore`. With `formulaColumns`, a letter column made of formulas is left `ignore`: it holds suggestions
   from the cutoffs (an exported file without final letters), not final letters. (`readWorkbook` leaves out
   of `formulaColumns` a Grade Tracker letter column in which letters were typed over the formulas, so that
   column is mapped and its typed letters become final letters, 9.1.) With `editedLetterCells` (from
   `readWorkbook`), a column with letters changed after the export is a `finalLetter` column even when its
   header says "suggested", as the weakest candidate: "Suggested Letter (cutoffs)" with a typed letter is
   mapped only when no other letter column is ("Final Letter" and "Letter Grade" win; `plan` then compares
   the other columns, 9.3). Without it (a CSV), "Suggested Letter (cutoffs)" is never mapped.

The previous TA's sheet maps exactly (tested for SE4351 and SE6362):

| Header | Target | Header | Target |
|---|---|---|---|
| No | `no` | Project I 10% | `weighted:a_p1` |
| Last Name | `lastName` | Project II 20% | `weighted:a_p2` |
| First Name | `firstName` | Test 1 25% | `weighted:a_t1` |
| Final Project I | `raw:a_p1` | Test 2 40% | `weighted:a_t2` |
| Final Project II | `raw:a_p2` | Class Participation 5% | `weighted:a_part` (÷ 5 × 5: the same number) |
| Test 1 | `raw:a_t1` | Total | `ignore` |
| Test 2 | `raw:a_t2` | Letter Grade | `finalLetter` (STAGE 4 addendum) |
| (blank) | `ignore` | No of Absence | `absencesTotal` |

Also: Status, Team, Notes, Name / Student (`fullName`), Term Paper (`raw:a_paper`), Participation
(`raw:a_part`), and every header this app exports (Everything preset: "Project I: weeks late" → `late:a_p1`,
"Final Letter" wins over "Letter Grade", "Excused (allowed)", "Unexcused (not allowed)", "Total absences").
`duplicateTargets(mapping)` → `[{ key, columns }]` for the UI warning.

### 9.3 Plan

`plan(course, rows, headerIndex, mapping, options)` never changes `course`. Options: `matchBy: 'name'`
(default) | `'no'`, `createMissing` (true), `emptyCells: 'keep'` (default) | `'clear'`, `overwrite` (true),
`switchAttendanceToTotals` (false; ignored unless an attendance column is mapped), `updateNames` (false:
matching by No never renames a student, see Matching), `finalLetterCells` (from `readWorkbook`, for a
workbook written by Grade Tracker).

- **Mapping checks** (`notes`): a second column for a target is ignored ("… is already read from column …");
  when both the raw and the weighted column of an item are mapped, the raw one wins (the old sheet's weighted
  columns are formulas of the raw ones); `absent` wins over `absencesTotal`; the attendance mode (totals are
  shown only in totals-only mode, or "Attendance switches to totals-only mode…"); finalized scores.
  `errors`: matching by name needs a name column; matching by No needs the No column (then no rows are planned
  and `apply` throws the error).
- **Matching**: by name, case-insensitive with spaces collapsed, on last + first (only the mapped parts);
  a full-name cell matches "First Last" or "Last First" (commas ignored). By No: whole numbers only. Two
  students matching → skipped ("2 students match this name; fix the duplicate first"); a second row for the
  same student → skipped ("Same student as row 5"); a repeated header row, a row without a name ("No name"),
  a row without a match when `createMissing` is off ("No matching student in this course") are skipped;
  empty rows are ignored. Unmatched rows with a name become **new** students (No from the file, else the next
  free No; one new student per name). A row that would be new, has no No and holds only one name cell that is
  a summary word ("Average", "Class Average:", "Max", "Std Dev"…) is skipped as "Summary row ("Average"), not a
  student" (with a single name column, words that are also names — Max, Min, Low — do not count).
- **Matching by No** compares the names: a row whose name (case and spaces ignored; an empty part on either
  side is not compared) differs from the student with that No is skipped ("No 4 is a student with another
  name in this course; skipped …"), because a file may number its rows in another order and its scores would
  land on another student; with `updateNames` the row is imported and the names taken from the file. An
  empty name part is always filled. A row whose No is not in the course but whose name is is skipped too
  ("No 12 is not in this course, but a student with this name is; skipped …"), never added a second time.
- **No stays unique** (as in the Students tab): a file No that another student keeps, or that an earlier row
  of the file takes, is not given; an existing student keeps its No ("No 1 is already used by another student
  in this course; the No is not changed"), a new one gets the next free No ("… given No 60 instead"; "No 5 is
  also given to row 5 of the file; …"), each counted in `duplicateNos` and listed as an issue. Numbers
  swapped or moved around inside the file are fine.
- **Values**: scores through `util.parseScoreInput` (with the max score, so "90%" of 5 is 4.5); weighted values
  converted to raw as `util.fix(value ÷ weight × max)` (9.4 on 10% of 100 → 94), with the weight written in
  the column's header when it differs from the course's (a file older than a change of the weights: "Project
  II 20%" = 17.6 gives 88 while Project II weighs 25%; a note says so; a header of 0% is ignored with a
  note). Text that is not a number is stored as invalid text on a free-entry item (like typing it; counted,
  highlighted, counts as 0) and **skipped** on an item with a drop-down list (DECISIONS 8). A number not on the list is imported and counted
  as `notOnList` (highlighted afterwards, `calc.scoreDetail().notOnList`). Weeks late (`late:<aid>`,
  `parseLate`), case-insensitive, a whole number of weeks only (`util.parseCount`):
  - as exported: "2", "2 (waived)";
  - as typed: "2 waived", "1 week", "1 wk", "2 weeks late", "2 weeks late, penalty waived",
    "2 (penalty waived)";
  - a bare "waived", "(waived)" or "penalty waived" keeps the student's stored weeks late and waives the
    penalty; with no weeks stored it is reported ('"waived" needs the weeks late, for example "1
    (waived)"') and ignored;
  - "0" (or an empty cell with "Empty cells: clear") removes the late work; anything else (fractions, signs,
    text) is reported and ignored. The weeks are compared with the student's effective entry (team score,
    override or own score, `calc.resolveEntry`), like the score itself.
  Status: withdrawn / w / wd / dropped / drop / inactive → withdrawn; active / a / enrolled → active; empty →
  active for a new student (for an existing one it follows `emptyCells`); anything else is reported and
  ignored. Final letters through `model.matchLetter` ("b+" → "B+"); letters not in the scale are skipped
  and reported (`lettersSkipped`). Absence counts through `util.parseCount`; `absencesTotal` is stored as
  unexcused, minus the excused column when that is mapped too, or else minus the excused absences already
  stored, so the student's total absences equal the file's (a total below the excused count is reported and
  ignored; an emptied cell with `clear` sets both to 0).
- **Final letters from a Grade Tracker file**: an exported "Letter Grade" column holds each student's final
  letter or, without one, the suggestion from the cutoffs. When the letter column is headed "Letter Grade"
  (not "Final …") and the sheet has a "Suggested Letter (cutoffs)" column or a "Status" column of only
  "Active" / "Withdrawn", a letter equal to the student's suggestion after the import is not stored as a
  final letter (counted in `lettersAsSuggestion`, with a note), and a letter that is already the student's
  final letter changes nothing; other letters are final letters. With `finalLetterCells` (an .xlsx from Grade
  Tracker) exactly the listed cells are final letters (marked by the instructor, or changed in the
  spreadsheet after the export, 9.1); the others were suggestions and are never stored (an issue when one
  differs from the suggestion here: "The suggestion from the cutoffs in this Grade Tracker file (not a final
  letter); not stored. The suggestion here is B+.", or, when it does not match the file's own total either,
  "Not marked as a final letter in this Grade Tracker file; not stored. It does not match the file's total
  (88.5 gives B+ with this course's cutoffs): a score or the cutoffs changed after the export, or the letter
  was typed in. If the instructor chose it, set it in the Grades tab. The suggestion here is B+."). So importing an export back changes no letter, and a
  withdrawn student's suggestion never becomes a final letter. When the file has its own Total (below), the
  suggestion compared is the one at the file's total (`calc.letterFor` on this course's scale), since that is
  the suggestion the file's letter came from; so a total that differs here (weeks late left out, another
  curve, or a file without score columns such as "Names, total and letter") never turns the old suggestion
  into a final letter, and a final letter that happens to equal the new suggestion is kept.
- **Letters in the other letter columns** (review V4R3-1): a Grade Tracker file can have several letter
  columns (the "Everything" preset: "Letter Grade", "Suggested Letter (cutoffs)" and "Final Letter"), and only
  one is mapped ("Final Letter" wins). The cells of `finalLetterCells` in a column that is not read (letters
  typed in after the export, or marked "Final letter assigned by the instructor") are compared, row by row,
  with the letter the mapped column gives (none when it is empty, a suggestion, or not a letter):
  - the mapped column gives none, and the other columns give one letter → that letter is the final letter
    (under the usual overwrite rule), counted in `lettersFromOtherColumn`, with a note per column ("Column
    "Letter Grade": 1 letter was changed in the spreadsheet after the export. Final letters are read from column
    "Final Letter", which is empty for that student, so the changed letter is imported as the final letter.");
  - the same letter as the mapped column → nothing more (an untouched export imports back without a word);
  - another letter → the mapped column wins; each other letter is an issue ("Column "Letter Grade" gives D, but
    final letters are read from column "Final Letter", which gives C: D is not imported. If the instructor
    chose D, set it in the Grades tab"), counted in `lettersNotImported`, with a note. Two other columns that
    disagree while the mapped one is empty: neither is imported (issue each). So a letter typed over a final
    letter in "Letter Grade" while "Final Letter" keeps the old one is reported, not imported;
  - text that is not a letter of the scale → an issue, counted in `lettersSkipped`;
  - no column mapped to Final letter → each such letter that would change the student's final letter is an
    issue ("… but no column is set to "Final letter"; not imported"), counted in `lettersNotImported`, with a
    note that names the column to set to "Final letter".
  Only the file decides (never the student's current letter), so importing the same file again gives the same
  result.
- **The file's totals** (review V4R1-7): a column headed exactly "Total" that is not mapped (totals are never
  imported; they are computed from the scores) is read as the file's total. When a score column is mapped,
  each imported row whose total here (after the simulated import) differs from the file's is reported as an
  issue (field "Total"), counted in `totalsDiffer`, with a note to check that the file has every score and
  weeks-late column and that the weights, curve and rounding match. The comparison allows half a unit of the
  last decimal the file shows ("85" fits 85.125, "85.13" fits 85.125) against the rounded and the unrounded
  total, so a file from another rounding mode or with rounded display fits; empty or non-numeric totals and
  rows with blocked (finalized) score changes are not compared.
- **Teams** are matched by name (case and spaces ignored), else by form: "2", "Team 02", "Group 2" and
  "team #2" are the existing "Team 2", "B" is "Team B", when exactly one team fits (`resolveTeam`); other
  names create teams (`teamsCreated`, with a note naming them). A team-graded score that becomes empty
  because the student moves to a team without that score is marked `emptiedByMove` and counted in
  `scoresEmptied` (with a note).
- **Empty cells**: `keep` changes nothing; `clear` empties the score (a blank team-graded cell hands the member
  back to the team score), the late info, the notes, the final letter, the team, sets the status to active
  and the absence counts to 0. An empty No or name never clears anything.
- **overwrite: false** fills only empty fields: scores without a score (late info without late info), a
  missing team, empty notes, no final letter, a student without absence totals; the status is left alone.
  Values kept this way are counted in `kept`.
- Names of existing students change only when matching by No (see Matching).
- **Finalized** (`model.isFinalized`): every score change (raw, weighted, weeks late, participation) is listed
  with `blocked: true` and the reason "Scores are finalized: unlock them in the Grades tab first" and not
  applied (a new student is added without scores). Text that is not a number is listed the same way, with
  the issue "Not a number; not imported because the scores are finalized". Student info and final letters are
  imported; a team move keeps the student's visible scores (`keepScores: true`), so totals do not change —
  where the new team's score differs they become per-member overrides, listed (the change row is marked
  `override` even though the value stays) and counted in `overrides`. A new member of a team gets the team
  score; the file's own score for it is then listed as blocked starting from that value (left out when equal).
- **Exact preview**: the plan applies itself to a scratch copy of the course (without history) and lists the
  differences, so team-graded columns, team moves and propagation appear exactly as `apply` does them.

Result: `{ items: [{ rowIndex, action: 'update' | 'new' | 'skip', reason?, studentId?, name, changes: [{
field, oldValue, newValue, kind, blocked?, reason?, override?, invalid?, outOfRange?, notOnList? }], issues:
[{ field, value, message }] }], counts: { update, new, skip, changes, overrides, invalid, blocked, notOnList,
lettersSkipped, lettersAsSuggestion, lettersFromOtherColumn, lettersNotImported, duplicateNos, teamsCreated,
scoresEmptied, kept, unchanged, propagated, totalsDiffer },
propagated: [{ studentId, name, changes }], notes, errors, options, finalized, headerIndex, columns,
attendanceMapped }`. `rowIndex` is the index in `rows` (row number − 1). Change fields: No, Last name, First
name, Team, Status, Notes, "<assessment>", "<assessment>: weeks late", Final letter, Unexcused absences,
Excused absences; a change may carry `emptiedByMove`. `overrides` counts members who get a new override
(team-graded columns and team moves); `propagated` lists students missing from the file whose score changes
through a new team score.

### 9.4 Apply

`apply(course, plan)` changes `course` in place, inside the caller's ONE `GT.store.transact('Import <file
name>', …, { source: 'import' })`, so the history logs every change and Undo reverts the whole import. Order:
students (new ones through `model.createStudent`; No, names, status, notes; team moves through
`model.moveStudentToTeam`, teams created by name), final letters (`model.setFinalLetter`), scores (individual
items through `model.entryFromInput` semantics; each team-graded column through ONE
`model.setTeamScoreFromMembers` call with every row that has a value — unchanged rows too, so they vote and a
single changed member becomes an override instead of moving the whole team), attendance totals
(`GT.attendance.setTotals`), then `setMode('totals')` with `switchAttendanceToTotals` (`totalsSessionsHeld`
is left for the TA). Returns `{ created, updated, skipped, missing, teamsCreated, newTeams, overridesCreated,
scores, letters, attendance, modeSwitched }`.

Round trip (tested for SE4351 and SE6362): `toWorkbook` → ExcelJS `xlsx.load` → `rowsFromWorksheet` →
`guessMapping` → `plan` → `apply` into an empty copy of the course (same assessments and settings, no
students) reproduces with the Everything preset every student's effective raw scores and late work, totals,
effective and final letters, status, No, team, notes and attendance totals (per-session counts become
totals); with the default preset (CSV too, in every rounding mode, with a curve and late work) the effective
raw scores and late work, totals, status and attendance totals, and each student's effective letter (Letter
Grade letters that differ from the suggestion become final letters; through `readWorkbook` with
`finalLetterCells`, exactly the original final letters). Importing the same file again, or an export (CSV or
.xlsx) back into its own course, changes nothing.

### 9.5 The Import / Export tab (`js/ui/exchange.js`, `css/exchange.css`)

`GT.views.exchange` (tab "Import / Export"). Scripts: `exporter.js` and `importer.js` right after `csv.js`
(before `attendance.js`: both look it up when first needed), `exchange.js` after `ui/attendance.js`;
`exchange.css` after `attendance.css`. Without `GT.exporter` / `GT.importer` the card says so instead of
failing. For tests: `GT.views.exchange.exportKeys()` (the keys the download would use now) and
`importState()` → `{ step, fileName, sheetIndex, headerIndex, mapping, options, counts }`.

- **Export card**: preset select (built-ins, then "My presets" from `course.exportPresets`; save / rename /
  delete through `GT.store.transact(…, { historyMode: 'none' })`, so they are undoable but not in History);
  the column list (checkbox, file column letter, assessment tint; reorder with the up/down buttons,
  Alt+↑/↓ or drag and drop; unavailable columns disabled with their reason and, when a preset asks for them,
  listed as skipped); options (row order, Settings sheet, Change history sheet); `dataCheck` items; "Download
  Excel (.xlsx)" (`GT.ui.loadExcel()`, then `toWorkbook` on a copy of the course, a spinner meanwhile; a missing
  `vendor/exceljs.min.js` gives an error that says CSV still works) and "Download CSV"; file names
  `<GT.ui.slug(code)>-grades-<GT.ui.fileStamp()>.xlsx|.csv`; the confidentiality reminder. An edited column
  list that is not saved as a preset lives in memory only.
- **Import card**, a stepper: 1 file (button or drop; `.xlsx`/`.xlsm` read with `readWorkbook`, `.csv`/`.tsv`/
  `.txt` as UTF-8, or Windows-1252 when that shows replacement characters; `.xls`, a renamed non-zip file and
  other types get the Save As advice; at most 25 MB, 5,000 rows, 200 columns); 2 sheet (hidden ones marked)
  and header row (`detectHeaderRow`; options show only "Row N" in privacy mode) with a preview of 8 rows;
  3 the mapping table (`guessMapping(header, course, { formulaColumns })` with the sheet's formula columns,
  so an exported Letter Grade made of formulas stays unmapped), the options, the offer to switch attendance to
  totals (ticked by default only when attendance is off) and plain notes; a target used twice, no way to find
  students, or nothing mapped blocks "Next"; 4 the plan's counts, notes, errors, the first 50 changes (badges:
  new, via team score, blocked, not a number, not on the list, out of range, override), values to check and
  skipped rows. **Import** runs ONE `GT.store.transact('Import <file name>', c => { plan again on the live
  course; apply }, { source: 'import', courseId })`, then a toast with "Open Grades" and a done screen (or
  "Nothing was changed"). Switching course with a file open matches its columns again for the new course.
- Row cells, sample values and change rows that hold names or notes carry `pii`, without a `title` tooltip.
- Preferences: `ui.exchangePrefs = { sort: 'name' | 'no', includeSettings, includeHistory, presets: {
  [courseId]: presetId } }` (the last preset chosen per course; built-ins by id, e.g. `builtin:previous`).

## 10. Statistics (`GT.stats`) — ST1–ST3, STAGE5 section 1 and Addendum

`js/core/stats.js`, pure and UMD like `calc.js` (depends on `util`, `model`, `calc` and `attendance`; loaded
after `attendance.js`). Tests: `tests/stats.test.js`. No DOM, no clock; results pass through `util.fix`.

Conventions for every course function `f(course, results, …)`:
- `results` is `calc.computeCourse(course)`; pass `null` and it is computed. Pass the same object to every
  call of one render (the view computes it once).
- **Active students only** (S2): withdrawn students are left out of every number, list and chart. They show
  only in `statusDistribution().withdrawn` ("Withdrawn (excluded)") and in `perTeam().members` (the roster).
- **Letters are effective letters** (DECISIONS 2, section 2.5): the final letter when one is set, otherwise
  the cutoff suggestion. `{ letters: 'suggested' }` (letterDistribution, passRate, topBottom, borderline,
  simulate) uses the suggestion instead. "n of N final letters assigned" = `results.letterSummary.assigned`
  of `results.letterSummary.active`.
- Totals are `total` (rounded by the course's rounding mode, as in the grid). Only `borderline` reads
  `totalUnrounded`, because `calc.minTotalForLetter` is defined on it.

### 10.1 Numbers

- `describe(values)` → `{ count, min, max, range, mean, median, sd, variance, sdPopulation,
  variancePopulation, q1, q3, iqr }` over the finite numbers in `values` (null, NaN, text are ignored).
  - `sd` / `variance` are the **sample** statistics (n − 1; Excel `STDEV.S` / `VAR.S`), null when count < 2.
    `sdPopulation` / `variancePopulation` divide by n (0 for one value).
  - Quartiles are Excel **QUARTILE.INC** (R type 7): sort ascending, position h = (n − 1)·p counted from 0,
    value = x[⌊h⌋] + (h − ⌊h⌋)·(x[⌊h⌋+1] − x[⌊h⌋]). `median` = Q2. Example: 46 55 62 70 75 81 84 88 93 96 →
    Q1 64, median 78, Q3 87.
  - `mean` = `fix(util.sum(values) / n)`, the same formula as `computeCourse().average`, so the panel's
    Average equals the class average.
  - count 0: `count` is 0 and every other field null.
- `quartileInc(values, k)` (k = 0…4) and `percentileInc(values, p)` (0 ≤ p ≤ 1) → number or null.
- `bins10(values)` → the 12 eLearning bins `[{ label, lo, hi, rule, count }]` in panel order:
  `'Greater than 100'` (v > 100; hi null), `'90 - 100'` (90 ≤ v ≤ 100), `'80 - 89'` … `'0 - 9'`
  (10k ≤ v < 10k + 10, so 89.99 is in `'80 - 89'` and 79.995 in `'70 - 79'`), `'Less than 0'` (v < 0; lo null).
  `rule` is a short phrase per bin ("at least 80 and below 90"); `BINS10_RULE` is the sentence for the panel
  tooltip; `BINS10` lists the bins; `bin10Index(v)` → 0…11 (−1 for a non-number). Counts add up to
  `describe(values).count`.
- `histogram(values, width = 10, lo = 0, hi = 100)` → `[{ lo, hi, label, count, below, above }]`,
  ⌈(hi − lo) / width⌉ bins; each holds lo ≤ v < hi, the **last** lo ≤ v ≤ hi (100 is in 90–100). Values below
  `lo` are counted in the first bin and values above `hi` in the last; `below` / `above` say how many (0 on
  every other bin), so the chart can mark them. `label` is `'90–100'` (en dash). A width that is not above 0
  means 10; hi ≤ lo means hi = lo + width; at most 1,000 bins.

### 10.2 Values for the panel's measure selector

- `activeTotals(course, results)` → active students' `total`, in `course.students` order (non-finite left
  out). The panel is `describe(activeTotals(…))` and `bins10(activeTotals(…))`.
- `assessmentValues(course, results, assessmentId, { percent })` → active students' **raw** numeric scores
  on that item (the effective entry: team score, override or own score; as entered, before a late penalty),
  empty and invalid cells left out. `{ percent: true }` → `v × 100 / maxScore` (the item's own max:
  participation 4.5 of 5 is 90, so it goes in `'90 - 100'`). Unknown item → `[]`. With an assessment as the
  measure, the STATISTICS column uses the raw values and the bins the percent values (label says so).

### 10.3 Course summaries

- `statusDistribution(course, results)` → `{ active, withdrawn, complete, incomplete, invalidEntries,
  overrides }`. complete + incomplete = active (`incomplete` = calc's flag: an empty or invalid score on an
  item with weight > 0). `invalidEntries` and `overrides` count **cells** of active students (invalid text;
  per-member overrides of team scores).
- `letterDistribution(course, results, { letters })` → `[{ letter, min, count, pct, inScale }]`: every
  letter of the scale, highest cutoff first (zero counts included), then one row `{ min: null, inScale:
  false }` per other letter met (a final letter the scale no longer has). `pct` = 100 × count / active
  students (null when there are none).
- `passRate(course, results, { letters })` → `{ passing, total, pct, passingLetter, unknown }`. Passing =
  the letter is `passingLetter` or higher in scale order; `passingLetter` = `model.passingLetterFor(scale,
  settings.passingLetter, course.level)`; `unknown` = letters outside the scale (not passing); `pct` null
  when `total` is 0.
- `perAssessment(course, results)` → one item per assessment, course order: `{ assessmentId, name,
  maxScore, weight, teamGraded, n, missing, invalid, mean, median, min, max, sd, meanPct }` from
  `assessmentValues` (raw). `n` = students with a number; `missing` = without one (empty **or invalid**), so
  n + missing = active students; `invalid` = those holding invalid text. `sd` sample (null when n < 2).
  `meanPct` = mean × 100 / maxScore (participation: 4.3 of 5 → 86); null when n = 0.
- `perTeam(course, results)` → one item per team (`course.teams` order), then `{ teamId: null, name: 'No
  team' }` when at least one **active** student has no team (or a team id that no longer exists):
  `{ teamId, name, members, activeMembers, mean, min, max, teamScores: { aid: number|null }, overrides
  [, avgUnexcused] }`. `members` counts every member (withdrawn included); the rest uses active members.
  mean/min/max of their totals (null when none). `teamScores`: the stored team score of each team-graded
  item (null when empty or invalid; `{}` for No team). `overrides`: override cells of active members.
  `avgUnexcused` is present **only when attendance is not off**: mean `attendance.courseSummary().byStudent
  [sid].unexcused` of the active members (null when none).

### 10.4 Students

- `topBottom(course, results, n = 5, { letters })` → `{ top, bottom }`, items `{ studentId, total, letter,
  rank }` (rank = `computeCourse`'s competition rank, shared on ties). `top` highest first, `bottom`
  **lowest first**; equal totals ordered by name (`calc.compareByName`) in both. The lists overlap when the
  class has fewer than 2n students. Non-finite totals are left out.
- `borderline(course, results, within = 1, { letters })` → students whose `totalUnrounded` is more than 0
  and at most `within` points below `calc.minTotalForLetter(nextLetter)`, by gap ascending then name:
  `{ studentId, total, totalUnrounded, letter, suggestedLetter, nextLetter, cutoff, minTotal, gap,
  finalAtOrAboveNext }`. `nextLetter` is the scale letter just above the band the total is in (from the
  cutoffs, whatever the final letter); `cutoff` its scale min; `minTotal` the unrounded total that earns it
  (rounding `'integer'`: cutoff − 0.5; `'hundredth'`: cutoff − 0.005; the curve is inside
  `totalUnrounded`); `gap = minTotal − totalUnrounded`. `letter` is the effective letter;
  `finalAtOrAboveNext` = a final letter is set that is `nextLetter` or higher (already raised by hand).
  Students in the top band are never listed.
- `gaps(course, results, minGap = 1)` → natural breaks: for neighbouring distinct active totals (ascending)
  with difference ≥ minGap, `{ below, above, gap, mid, countAbove }` (`mid` halfway; `countAbove` = active
  students with a total ≥ `above`), sorted by gap descending, then by `above` descending. Equal totals never
  form a gap.

### 10.5 Cutoff planner

- `simulate(course, results, scale, { letters })` changes nothing. `scale` goes through
  `model.normalizeLetterScale(scale, course.level)` (sorted, bottom letter at 0, F appended when missing,
  the default scale when nothing valid is left) and each active student's `total` through `calc.letterFor`.
  Returns `{ scale, distribution, byId, students, changes, finalChanges }`:
  - `scale`: the normalized scale; `distribution`: as `letterDistribution`, over that scale;
    `byId`: `{ studentId: simulated letter }`;
  - `students`: `[{ studentId, total, suggested, finalLetter, current, simulated, changed }]`, total
    descending then name; `current` = effective letter (or the suggestion with `{ letters: 'suggested' }`);
    `changed = simulated !== current`; `changes` = the rows with `changed`;
  - `finalChanges: { onlyEmpty, all }` = how many stored final letters "Use these as final letters…" would
    change with "Only students without a final letter" / "All active students" (for the confirm dialog).
- `lettersFromScale(course, results, scale, { onlyEmpty = false })` → `[{ studentId, letter }]` for active
  students (course order), the letter `simulate` gives, spelled as the course's scale spells it
  (`model.matchLetter`); letters that are not in the course's scale are left out (a sandbox that only moves
  cutoffs never has any). Pass it to `model.setFinalLetters` inside ONE `GT.store.transact` (one undo step);
  its `changed` equals `finalChanges.onlyEmpty` / `.all`.
- "Apply cutoffs to Settings" writes `simulate(…).scale` (already normalized) into
  `course.settings.letterScale`; this changes only the suggested letters.
- What-if (ST2) is `calc.neededScore(course, student, assessmentId, letter)` (section 3).

## 11. The Statistics tab (`js/ui/stats.js`, `css/stats.css`) — ST1–ST3, STAGE5 section 2 and Addendum

`GT.views.stats` (tab "Statistics"). Every figure comes from `GT.stats` (section 10) and `GT.calc`; the view
only lays them out, and each `GT.stats` call is guarded (a missing or incomplete module shows a "loading"
state, never an error). Active students only; letters are effective letters (toggle on the letter chart).
Read-only and always available, also when the scores are finalized (the header then says "Scores
finalized on <date>"; the statistics stay read-only).

- Sections, in order, with a "Jump to" bar: `#st-overview` (the eLearning-style panel: STATISTICS, STATUS
  DISTRIBUTION, GRADE DISTRIBUTION, the population line "Active students only (n = N)", the Count pill,
  and a "measure" select: Total, or an item's raw score with the bins in percent of its max),
  the summary cards (quartiles with a box plot, pass rate with the `passingLetter` badge, average / median /
  SD), `#st-hist` (histogram, 10- or 5-point bins), `#st-letters` (letter distribution: "Final letters
  (effective)" or "Suggested (cutoffs)", and "n of N final letters assigned"), `#st-assess` (per assessment),
  `#st-perf` (top and bottom 5), `#st-teams` (per team, with "Avg unexcused" when attendance is on),
  `#st-whatif`, `#st-planner`, `#st-border`.
- Test hooks: panel cells carry `data-stat="<describe key>"` with the exact value in `data-v`, the bins
  `data-bin`, the status rows `data-status`; the what-if output `[data-wi-out="needs|reached|unreachable"]`
  with `data-needed`, its every-letter table `[data-wl]`; `GT.views.stats.sandbox()` (a copy of the
  planner scale) and `lastRenderMs()`.
- Charts are inline SVG drawn at the card's measured width and colored only through CSS custom properties
  (light and dark): `role="img"`, `<title>`, `<desc>`, a `<title>` per mark, and "Show as table".
- What-if (ST2): student (active, "No 12 · name" in the option text), assessment (default: the first empty
  item with weight > 0) and target letter; the result is `calc.neededScore` (section 3), "on time", with
  the assumptions in one line and the score needed for every letter.
- Cutoff planner: a dot plot of the active totals (each dot's `<title>` names the student, "No N" only in
  privacy mode), the current cutoffs as lines, the largest gaps shaded (`stats.gaps`), and an editable
  sandbox scale (↑/↓ nudge a cutoff by 0.5, Shift by 0.1; a cutoff that breaks the order is refused,
  marked `aria-invalid` and blocks Apply). Editing it stores nothing: the lines, the simulated distribution
  and the "current → simulated" list follow live (`stats.simulate`). "Apply cutoffs to Settings" writes the
  scale in ONE transaction after a confirm (undo label "Apply cutoffs from the planner"); the letterScale
  placeholder stays unconfirmed. "Use these as final letters…" asks "Only students without a final letter"
  (default) or "All active students", shows how many letters change, and calls `model.setFinalLetters` in
  ONE transaction (undo label "Use planner letters as final letters (students without one)" or "(all
  active students)", one Ctrl+Z). "Reset sandbox" reloads the
  stored scale; a scale changed elsewhere while the sandbox is edited keeps the edits, with a note.
- Borderline: `stats.borderline(…, within)` (default 1; more than 0 and at most 20; Enter saves it).
- Preferences: `ui.statsPrefs = { binWidth: 10|5, letters: 'effective'|'suggested', within, guide }`.
  Transient state (measure, what-if choices, sandbox, table toggles) lives in the module.
- Rendering rebuilds each section's markup as a string and writes a host only when it changed, so autosave
  notifications cost nothing and a focused input keeps its focus and typed text. 59 students render in
  well under 50 ms. Empty states: "No course", and "No statistics yet" for a course without active students
  (links to Students & Teams and "Load sample data…"). Print: the controls are hidden, the charts kept.

## 12. The Summary tab (`js/ui/summary.js`, `css/summary.css`) — D1 printable summary, STAGE6 section 2 and Addendum

`GT.views.summary` (tab "Summary"): a print-first page for the grading meeting.

- Header (course code, title, term, level, the generated date and time, student counts, finalized status);
  one line naming every unconfirmed placeholder ("Placeholders, not yet confirmed with the instructor (†)");
  the assessments and weights; the grade settings (cutoffs, rounding, curve, late rule, passing grade,
  attendance, final letters); the grade table; the statistics (count, mean, median, sample SD, min, max,
  pass rate, letter distribution); a notes and signature area.
- Grade table: No, Last Name, First Name, Team, the raw scores (Class/Project Participation always, the
  others with "Raw scores"), the weighted points (option), Total, the letter, Rank, and Excused,
  Unexcused and Total absences when attendance is not off. Active students by name, then the withdrawn
  ones ("Withdrawn (n)" group), marked **W**, with "—" as rank. The letter column is the effective letter:
  "Letter (suggested)" while no final letter is assigned, else "Final letter", with "—" for active students
  who have none yet. Marks: ◆ per-member override, late work, streak markers in the absence columns.
- Options (screen only, `.no-print`): Include withdrawn students (on), Raw scores (on), Weighted scores
  (off), **Hide names (use No only)** (the name columns are not rendered at all), the landscape hint and
  **Print…** (`window.print()`). Preferences: `ui.summaryPrefs = { withdrawn, raw, weighted, hideNames }`.
- Print: a named page (`@page summary`: Letter landscape, 12 mm margins, "Confidential: student grades" and
  "Page n of N" in the margins) used only when the Summary tab prints; white background and black text also
  in the dark theme, 10 px table text, `thead { display: table-header-group }`, rows never split, privacy
  blur off. While printing, the document title is "<course> grade summary <date>" and "Generated" is fresh.
- Statistics use `GT.stats` when it is loaded (else a small local helper with the same definitions,
  `GT.views.summary.localDescribe`). Empty states: "No course", "No students in this course yet".

## 13. Late work in the UI (K4) — STAGE6 section 1 and Addendum

- Grades grid (`js/ui/grid.js`): "Late work…" in the cell menu of every raw score cell (Shift+F10, the
  menu key or right-click; "Late work (1 week)" when set) and **Ctrl+L** (Cmd+L) on the active cell, also
  while typing a score (it is saved first). The browser's Ctrl+L is blocked only while a grid cell has the
  focus; elsewhere in the grid Ctrl+L explains that late work belongs to a score. `GT.ui.openLateWork(sid,
  aid)` opens the same dialog from any view.
- The dialog (`dialog.late-dialog`): the item and the student (No in the title, the name `pii`), where the
  entry lives (`.late-where`: "Individual score", "Per-member override (◆)", or "<Team> team score … for the
  whole team" for a team-graded cell without an override, where the late info goes on the **team entry**
  and propagates), **Weeks late** (`#late-weeks`, a whole number 0–52, `util.parseCount`, an inline error
  otherwise), **Penalty waived (pre-approved)** (`#late-waived`), and a live preview (`#late-preview`: "Raw
  85 − 20 (2 weeks × 10 points) = 65 → weighted 6.5"; "× max ÷ 100" when the max is not 100). Save is ONE
  `GT.store.transact` with `model.withLate` (history kind 'late'); Esc closes, and the focus returns to
  the cell. Finalized (`model.isFinalized`): read-only, "Scores are finalized. Unlock them to change late
  work." Works on drop-down items (participation) too, without special handling.
- Badges: "L2" (warn tint) = 2 weeks late, penalty applied; "L2✓" (muted, struck-through L) = waived; the
  cell tooltip gives the penalty and the adjusted score, the weighted cell's tooltip says "Adjusted after
  late penalty". A column with late work is widened just enough for its badge. The legend shows both marks.
- Settings: a **Late work** card (`#set-sec-late`): "Points deducted per week late"
  (`settings.latePointsPerWeek`, ≥ 0, one transaction), the lateWork placeholder badge and note, the rule in
  words, and the list of every late entry (student or team, item, weeks, waived, penalty) with links to the
  Grades cell (`navigate('grades', { focus: … })`).
- Students & Teams: a "Late work" column (item · weeks · penalty or "waived"); Student details show the
  weeks and the penalty per item, with a button that opens the dialog (`GT.ui.openLateWork`).
- Export and import: section 8 (`late:<aid>`, the `MAX(0,R-P)/M*W` formula and the cell note) and
  section 9.4 (the accepted spellings).

## 14. Shell polish: Help / About, shortcuts, terminology, empty states — STAGE6 section 3

- **Help / About** (`GT.app.showAbout()`, the status bar's "Help" button): what the app is, that it works
  offline and sends nothing, where the data is stored (the storage backend in use; another browser, profile
  or private window does not see it; clearing site data deletes it), a backup reminder with the last backup
  date (highlighted when none or older than 7 days), version `GT.app.VERSION` (1.0.0) and a relative
  `README.md` link (`a.about-readme`, opens the local file). Buttons: Keyboard shortcuts, Download backup,
  Close.
- **Keyboard shortcuts** (`?`, the status bar's "Shortcuts" button, or Help → Keyboard shortcuts): grouped
  "Everywhere", "Grades grid", "Attendance grid (per session)", "Roll call", "Statistics and Import /
  Export". `GT.app.SHORTCUTS` holds the list; each entry was checked against the key handlers (app.js;
  grid.js `gridKey` and `editorKey`; attendance.js `gridKey` and the roll call; stats.js planner sandbox;
  exchange.js column list). Page shortcuts do not run while a text field has the focus or a dialog is
  open (dialogs keep their own Esc, Enter and, in the session manager, Ctrl+Z).
- **Terminology** used in every view: "Class/Project Participation" (the item's own name in messages),
  "Withdrawn" (never "Dropped"; an imported "dropped" status still means withdrawn), "Override" with ◆
  ("per-member override"), "Team score", "Final letter", "Suggested", "Excused (allowed)" and "Unexcused
  (not allowed)".
- **Empty states**: every tab has one for "no course" and for a course without students; Attendance also
  for "attendance is off" and Statistics for "no active students". The Import / Export tab stays usable
  without students (an export then has only the header row, and it says so).
