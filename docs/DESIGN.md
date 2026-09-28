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
- Sample data (`GT.sample.loadInto`) has no final letters, sets `finalized = null`, and gives participation
  list values (3 … 5 in steps of 0.5; other values are unchanged, each assessment keeps its own PRNG stream).

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

Excel parity (E3, stage 4). To make exported formulas give the app's letters at exact cutoffs, the
exporter mirrors this section: weighted cell `=MAX(0, raw − weeks*ppw*max/100)*weight/max` (no late term
when waived or not late; empty → 0), total `=ROUND(SUM(weighted cells) + curve, 10)` (10 =
`util.FIX_DECIMALS`), then the rounding mode's `ROUND(…, 2|0)` around it, then the letter `LOOKUP` on that.
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
  other entry; stored data is read defensively); `history.detailFor(entry, studentId)` → that student's item
  or null; `history.involvesStudent(entry, studentId)` → true when `entry.studentId` is the student or a
  detail names them. The History view's student filter matches with `involvesStudent`.
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
  `save(state)`, `clear()`. IndexedDB DB `grade-tracker`, object store `kv`, keys `state` and `state-prev`.
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
  `GT.store.subscribe(fn)`, `GT.store.flush()` (save now), `GT.store.saveStatus()`,
  `GT.store.annotateHistory(entryId, text)`, `setActiveCourse/addCourse/deleteCourse/moveCourse`.
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
- Shared widgets: `GT.ui.dialog.confirm/prompt/open`, `GT.ui.toast(message, { type })`,
  `GT.ui.download(filename, blobOrText, mime)`, `GT.ui.loadExcel()`, `GT.ui.icon(name)` (inline SVG).

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
    high to low; larger text; participation and Final letter marked "fill in the meeting".
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
