# Grade Tracker: requirements baseline

This is the requirement set the app was built against. Items marked **placeholder** are not confirmed by the instructor. The app shows a yellow "needs confirmation" badge on each one until it is marked confirmed.

## Hard constraints

- R1. Static site only: `index.html` plus local CSS and JS. No backend, no accounts, no required build step. Works offline by opening `index.html`.
- R2. Zero network requests at runtime: no CDN links, no web fonts, no analytics, no external images. Libraries are vendored into `vendor/`.
- R3. Data lives only in the browser (IndexedDB or localStorage) and is autosaved.
- R4. Backup (export JSON) and Restore (import JSON).
- R5. A visible "last backup" indicator, with a reminder when the last backup is older than 7 days.
- R6. A "Delete all data" button with confirmation.
- R7. Nothing is deployed or published.
- R8. Only fake data is committed (for example, "Student 01"). `.gitignore` excludes `*.xlsx`, `*.csv`, and backup `*.json`.

## Courses

Each course is fully independent: students, scores, attendance, teams, and settings.

- C1. SE 4351, Requirements Engineering (undergraduate). Sample data: 59 fake students in teams of 7 to 8.
- C2. SE 6362, Software Architectural Design (graduate). Sample data: 10 fake students in teams of about 3.
- C3. Course switcher, plus add, rename, duplicate, and delete course.
- C4. Sample data is created only by a "Load sample data" button.

## Assessments and weights

These are per course, editable, and recalculated instantly.

- A1. Defaults for both courses, totalling 100%:
  - Project I 10% (team-graded)
  - Project II 20% (team-graded)
  - Test 1 25%
  - Test 2 40%
  - Class/Project Participation 5% (entered manually per student)
- A2. Each assessment has a name, a max score (default 100), a weight %, and a team-graded flag.
- A3. A visible warning appears when the weights do not sum to 100.
- A4. SE 6362 also has an optional "Term Paper" assessment with weight 0 (**placeholder**).
- A5. SE 4351 project split (**placeholder**). The syllabus lists Questionnaire (2 x 2.5 = 5) plus Presentation and Deliverable (25) inside the 30% Project. The defaults above are kept, and project items are easy to split or rename.

## Calculations

These work like Excel formulas and update on every edit.

- K1. Weighted points = raw / max x weight. Total = sum of weighted points.
- K2. An empty score counts as 0, with a subtle "incomplete" indicator.
- K3. Settings:
  - Display decimals (display only; it never changes a calculated value).
  - Rounding mode (**placeholder**): none, nearest 0.01, or nearest integer. Default: none.
  - Optional flat curve added to the total (**placeholder**). Default: 0.
- K4. Late work: 10 points per week late on a 100-point score, scaled proportionally when the max differs, unless pre-approved.
  - Each score has an optional "weeks late" value and a "penalty waived" checkbox.
  - Points per week is a per-course setting.
  - The penalty applies before weighting and never takes the score below 0.
  - Late-work exceptions are a **placeholder**.
- K5. Team-graded assessments: the team score is entered once and propagates to every member. A per-member override is allowed and shown with a marker, because an unequal split needs the team's written agreement.
- K6. Letter grade from the total, using the course letter scale with editable cutoffs (**placeholders**):
  - SE 4351: A+ 97, A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 73, C- 70, D+ 67, D 63, D- 60, F.
  - SE 6362: A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 70, F.
- K7. Rank and percentile among active students, and the difference from the class average.
- K8. Max scores (default 100) are **placeholders**.

## Students

- S1. Fields: No, Last Name, First Name, Team, Status (active or withdrawn), and notes.
- S2. Withdrawn students are never deleted. They are:
  - greyed out,
  - kept in history and exports (with a Status column),
  - excluded from statistics, rank, percentile, and the class average.
  - A filter shows or hides them.
- S3. Quick roster paste: a block of names copied from Excel.

## Grid

- G1. Edit in place with Tab, Enter, and the arrow keys. Paste a block copied from Excel. Undo and redo. Search box.
- G2. Columns: No, Last Name, First Name, Team, raw scores, weighted scores, Total, Letter Grade, Rank, and an attendance summary.
- G3. Sort by name (last name, then first name) or by total, ascending or descending. Name is the default. Group by team.
- G4. Non-numeric and out-of-range scores are highlighted.
- G5. Change history panel: every grade edit is logged (student, field, old value, new value, timestamp), including team propagation and overrides.

## Attendance

The mode is set per course: per-session, totals-only, or off.

- T1. SE 4351 is per-session. Sessions fall on Tuesdays and Thursdays from 2026-09-03 to 2026-12-08, excluding 2026-11-24 and 2026-11-26 (26 sessions), as an editable list. Each student is marked Present, Absent, or Excused per session.
- T2. SE 6362 defaults to off, and it can be turned on.
- T3. Absence counts and rates:
  - Total absences = absent + excused.
  - Unexcused = absent.
  - Absence rate and unexcused rate are percentages of recorded sessions.
- T4. Students above a configurable unexcused-absence threshold (**placeholder**) are highlighted.
- T5. Consecutive-absence rule from the syllabus: 3 in a row means a one-letter drop, and 4 in a row means F. These are warnings only; grades never change automatically.
  - Setting: whether excused absences count toward a streak. Default: no: only unexcused absences make a streak (changed at the user's request, DECISIONS 6 / X7; the original request said yes).
- T6. Attendance never feeds participation automatically.

## Statistics

Per course, live, active students only.

- ST1. eLearning-style panel: Count, Minimum, Maximum, Range, Average, Median, Standard Deviation (sample, labelled), Variance, and a 10-point bin grade distribution.
- ST2. Also:
  - quartiles
  - pass rate
  - letter-grade distribution
  - per-assessment average, median, min, and max
  - a histogram
  - top and bottom performers
  - a per-team summary
  - a what-if calculator (the score needed on a remaining assessment to reach a target letter)
- ST3. Charts are plain SVG or canvas, with no libraries.

## Export and import

- E1. "Download Excel (.xlsx)" and CSV for the current course.
- E2. A column picker with reorderable columns and saved presets. The default preset: No, Last Name, First Name, raw scores, weighted scores, Total, Letter Grade, absences, and Status.
- E3. The .xlsx uses real Excel formulas for weighted scores, total, and letter grade where possible. The header row is frozen, column widths are sensible, and a Status column is included.
- E4. Import from .xlsx or .csv, with column mapping.

## Design

- D1. Professional, clean, modern, and responsive. Light and dark mode, good typography, keyboard-friendly, and a printable summary view. English interface.
- D2. Privacy mode blurs student names (click to reveal).

## Documentation and verification

- V1. Automated tests cover:
  - the 74.0 example
  - team propagation with an override
  - a withdrawn student excluded from the average and rank
  - both letter scales
  - consecutive-absence detection
  - per-session attendance rates
- V2. The README covers:
  - how to open the app
  - backup and restore
  - every formula
  - the placeholder list
  - a warning that browser storage can be cleared
- V3. Verified by the tests and a headless browser.

## Syllabus excerpts used (grading policy only)

- SE 4351 grading:
  - Project (approx. 10 + 20) 30%, which the syllabus breaks down as Questionnaire (2 x 2.5) 5 plus Presentation + Deliverable 25.
  - Test 1 25%, Test 2 40%, Class-Project Participation 5%.
- SE 6362 grading: Project (approx. 10 + 20) 30%, Test 1 25%, Test 2 40%, Class/Project Participation 5%. A term paper is described, but it has no weight.
- Late work:
  - SE 4351: "10 points deducted for each week passed, if without pre-approval".
  - SE 6362: "10 points deducted for each week passed".
- Attendance, in both syllabi: three consecutive absences lead to one letter grade drop, and four consecutive absences lead to an F. SE 6362 adds "except for medical/family policies". Total absences should not exceed "a certain threshold", and the syllabi do not give the number.
- Teams: all students in a team get the same mark unless they unanimously agree in writing to an unequal division. Teams are about 7 to 8 students (SE 4351) or about 3 (SE 6362).

## Added during the build (decisions by the TA, 2026-09-28)

- X1. Class/Project Participation is entered out of 5 (5 = full marks), as in the previous TA's sheet. Its default max is 5 and its weight 5%. Every other item defaults to a max of 100.
- X2. Final letters are assigned manually by the instructor, usually in bands after sorting by total. The cutoff letter is shown only as a suggestion. The final letter is the grade used in exports and statistics.
- X3. Scores can be finalized (locked) before the letters are assigned. Unlocking is possible and is logged.
- X4. The final letter and participation are chosen from drop-down lists. Invalid typed values are refused.
- X5. Sorting never moves rows while you edit. A "re-sort" button appears when the order is out of date.
- X6. A meeting view shows only what the grading meeting needs.
- X7. Attendance shows separate columns for excused absences (allowed), unexcused absences (not allowed), and total absences. Unexcused absences drive the warnings, and by default excused absences do not count toward a consecutive-absence streak.
- X8. Real student names are never sent to the assistant or committed. They are pasted or imported locally.

## Traceability (build complete, 2026-10-03)

Where each requirement is implemented and which automated test covers it.

- Unit tests are `tests/<name>.test.js` (run with `npm test`); the name in quotes is the `describe` or `test` title.
- "smoke" means a check of `tests/e2e/smoke.mjs`, the headless Chromium run from `file://` (run with `npm run test:e2e`). The quoted text is the start of the check's name.
- "DESIGN §n" is a section of `docs/DESIGN.md`.

| ID | Requirement (short) | Implemented in | Covered by |
| --- | --- | --- | --- |
| R1 | Static site, opens from `index.html`, no build step | `index.html` with classic scripts `js/**`, styles `css/*` (DESIGN §1) | repo.test.js "R1: index.html loads only local classic scripts…"; smoke "boot with empty storage…" (the run itself opens `file://`) |
| R2 | Zero network requests | CSP in `index.html`; system fonts; ExcelJS vendored in `vendor/`, loaded on demand by `GT.ui.loadExcel` (`js/ui/widgets.js`) | repo.test.js "R2: a Content-Security-Policy blocks connections…"; smoke "zero network requests other than file:, data: and blob: across the whole run…", "Export: the default preset downloads an .xlsx…" |
| R3 | Data only in the browser, autosaved | `js/storage.js` (IndexedDB → localStorage → memory), `js/store.js` autosave and `flushOnLeave` (DESIGN §5) | store.test.js "annotateHistory and autosave"; smoke "a fresh profile is saved at boot…", "data persists in IndexedDB across a reload", "an edit made while a save is running…", "a mark made just before a reload is kept…", "localStorage backend: a state larger than half the quota still saves", "a newer localStorage copy…", "unreadable saved data shows the banner…" |
| R4 | Backup (JSON) and Restore | `js/app.js` doBackup / doRestore; `model.wrapBackup` / `readBackup` | model.test.js "backup files (R4)", "restore requires the Grade Tracker marker…", "restore never pollutes Object.prototype…"; smoke "backup download and restore round trip" |
| R5 | Last-backup indicator, reminder after 7 days | `js/app.js` Backup chip (renderHeader) and banner (renderBanners); Help / About | smoke "the last-backup indicator turns into a reminder…", "backup download and restore round trip", "Help / About from the status bar…" |
| R6 | Delete all data, with confirmation | `js/app.js` doDeleteAll (typed DELETE) | smoke "delete all data (typed confirmation)…" |
| R7 | Nothing deployed or published | No hosting or deploy configuration in the repository | Not testable: process rule, kept |
| R8 | Fake data only; `.gitignore` for exports and backups | `js/core/sample.js` ("Student 01" + NATO first names); `.gitignore` | repo.test.js "R8: .gitignore keeps spreadsheets, CSV files and backups out…"; sample.test.js "names are obviously fake…" |
| C1 | SE 4351 template; sample of 59 students in teams of 7–8 | `model.js` templates (DESIGN §2.1); `sample.js` | model.test.js "default state (C1, C2, C4)"; sample.test.js "SE4351: 59 students in 8 teams of 7 to 8"; smoke "load sample data from the course menu: 59 students in SE 4351" |
| C2 | SE 6362 template; sample of 10 students in teams of about 3 | as C1 | model.test.js "default state (C1, C2, C4)"; sample.test.js "SE6362: 10 students in 3 teams of about 3" |
| C3 | Course switcher; add, rename, duplicate, delete | `js/app.js` course select and course menu; `store.addCourse` / `deleteCourse`; `model.duplicateCourse` | model.test.js "duplicateCourse (C3)"; smoke "course menu (C3): add a course from the SE 6362 template…" |
| C4 | Sample data only from "Load sample data" | `js/app.js` doLoadSample → `sample.loadInto(course, { lateWork: true })` | model.test.js "default state (C1, C2, C4)"; smoke "boot with empty storage: two empty courses…", "load sample data from the course menu…" |
| A1 | Default assessments and weights (total 100%) | `model.js` templates | model.test.js "assessment defaults (A1, A2, A4)"; calc.test.js "74.0 example (V1)…" |
| A2 | Name, max score, weight, team-graded flag, editable | Assessment model; Settings "Assessments and weights" (`js/ui/settings.js`) | model.test.js "assessment defaults (A1, A2, A4)", "convertAssessmentToTeam / convertAssessmentToIndividual…"; history.test.js "course details, settings, assessments and placeholders" |
| A3 | Warning when weights ≠ 100 | `calc.weightStatus`; app banner; Settings live sum | calc.test.js "weightStatus (A3)"; smoke "a weight change in Settings shows the weights banner…" |
| A4 | SE 6362 Term Paper, weight 0 (placeholder) | SE6362 template; placeholder `termPaperWeight` | model.test.js "assessment defaults (A1, A2, A4)", "placeholders ("needs confirmation")"; smoke "Meeting view at 1280 px, SE 6362 with attendance on…" |
| A5 | SE 4351 project split (placeholder), easy to split or rename | placeholder `projectSplit`; Settings "Split…" and rename | model.test.js "placeholders ("needs confirmation")", "placeholder notes and scoping…" |
| K1 | Weighted = raw ÷ max × weight; Total = sum | `calc.scoreDetail` / `studentResult` (DESIGN §3); exporter formulas | calc.test.js "weighted points (K1)", "totals with non-100 max scores are exact…"; exporter.test.js "formula parity…"; smoke "grid shows 59 rows and every Total equals GT.store.results()" |
| K2 | Empty counts as 0, with an "incomplete" mark | `calc`; grid ○ marker | calc.test.js "empty, invalid and out-of-range entries (K2, G4)" |
| K3 | Display decimals, rounding mode, curve | Settings "Grade calculation"; `calc`, `util.roundTo` | calc.test.js "rounding and curve (K3)"; util.test.js "util.roundTo (half away from zero, like Excel ROUND)"; model.test.js "settings defaults (K3, K4, K6)"; stats.test.js "borderline… in each rounding mode" |
| K4 | Late work: weeks late, waived, points per week, before weighting, never below 0 | `calc.latePenalty`; grid "Late work…" dialog and Ctrl+L, Settings "Late work" card, Students column (DESIGN §13); exporter `MAX(0,R-P)/M*W` | calc.test.js "late penalty (K4)"; model.test.js "late-work info counts as part of a team score…"; exporter.test.js; importer.test.js "values"; smoke "Late work (Ctrl+L): 1 week late lowers the total…", "Late work: on a team-graded cell…", "Late work: in a finalized course…" |
| K5 | Team score propagates; per-member override with a marker | `model.setTeamScore`, `calc.resolveEntry`; grid ◆; Students "Team scores" | calc.test.js "team propagation with a per-member override (K5)"; history.test.js "team scores and propagation"; smoke "team score edit propagates to every member…" |
| K6 | Letter scales with editable placeholder cutoffs | `model` default scales; `calc.letterFor`; Settings cutoffs; Statistics cutoff planner | calc.test.js "letter scales (K6)"; model.test.js "settings defaults (K3, K4, K6)", "letter scale invariant…"; smoke "Statistics: cutoff planner sandbox edits…" |
| K7 | Rank, percentile, difference from average (active students) | `calc.computeCourse` | calc.test.js "rank, percentile and difference from average (K7)", "withdrawn student excluded from average and rank (S2, K7)"; smoke "withdrawing a student removes them from rank…" |
| K8 | Max scores are placeholders | placeholder `maxScores` | model.test.js "placeholders ("needs confirmation")"; smoke "marking a placeholder confirmed updates the Settings tab count" |
| S1 | Student fields: No, names, Team, Status, notes | Student model; Students & Teams tab, Student details | model.test.js "stage 2 model helpers"; history.test.js "students" |
| S2 | Withdrawn kept, greyed, excluded from statistics, rank, average; filter | `calc`, `GT.stats`, grid filter, exports (Status), Summary (W) | calc.test.js "withdrawn student excluded…"; stats.test.js "withdrawn students are excluded everywhere (S2)"; smoke "withdrawing a student…", "Statistics: a withdrawn student's scores change nothing…", "Summary: totals, letters and ranks… withdrawn students come last, marked W" |
| S3 | Quick roster paste from Excel | `GT.ui.openRosterPaste` (`js/ui/students.js`), `csv.parseClipboard` | csv.test.js "parseClipboard (Excel / Sheets TSV)"; smoke "Paste roster (S3)…" |
| G1 | Edit in place (Tab, Enter, arrows), paste a block, undo/redo, search | `js/ui/grid.js`; `store.undo/redo` | store.test.js "undo and redo"; smoke "keyboard edit of a Test 1 cell…", "paste of a 3x2 TSV block from Excel…", "undo and redo (keyboard and toolbar)…", "Grades search box and "Group by team" (G1, G3)…" |
| G2 | Grid columns | `grid.js` buildColumns (DESIGN §6.1) | smoke "grid shows 59 rows…", "Grades grid: Excused, Unexcused and Total absences…", "the effective Letter Grade is the final letter…" |
| G3 | Sort by name or total, both directions; group by team | `calc.sortStudents`; grid sort and grouping | calc.test.js "sortStudents (G3)"; smoke "rows keep their place after an edit under a sort…", "Grades search box and "Group by team"…" |
| G4 | Non-numeric and out-of-range scores highlighted | `calc` parse states; grid classes and tooltips | calc.test.js "empty, invalid and out-of-range entries (K2, G4)"; smoke "paste of a 3x2 TSV block…" (text highlighted) |
| G5 | Change history of every edit | `js/core/history.js`; History tab | history.test.js (every suite); store.test.js "transact logs change history"; smoke "keyboard edit… logs a history entry", "History shows final-letter entries…", "Late work (Ctrl+L)… History has "late" entries" |
| T1 | SE 4351 per session: 26 Tuesday/Thursday sessions, P / A / E | `js/core/attendance.js`; Attendance tab, roll call | attendance.test.js "templates and modes (T1, T2)"; smoke "Attendance: SE 4351 has 26 sessions…", "Attendance: Roll call marks the current student…" |
| T2 | SE 6362 off by default, can be turned on | as T1 | attendance.test.js "templates and modes (T1, T2)"; smoke "Attendance: SE 6362 starts off…", "every tab shows a friendly empty state…" |
| T3 | Total, unexcused, rates of recorded sessions | `attendance.summary` (DESIGN §7.1) | attendance.test.js "held sessions and per-session rates (T3)"; smoke "Grades grid: Excused, Unexcused and Total absences…" |
| T4 | Unexcused threshold (placeholder) highlights | attendance thresholds; grid, Attendance | attendance.test.js "thresholds (T4, DECISIONS 3)"; smoke "Settings: the unexcused-threshold placeholder…" |
| T5 | 3 / 4 consecutive absences: warnings only | `attendance` streaks | attendance.test.js "consecutive-absence detection (T5, DECISIONS 6)"; smoke "Attendance: a 3-run gives the drop warning, a 4-run the fail warning; grades never change" |
| T6 | Attendance never feeds participation | No link in code (`calc` does not read attendance) | smoke "Attendance: a 3-run gives the drop warning… grades never change" |
| ST1 | eLearning panel: count … variance, 10-point bins | `stats.describe`, `stats.bins10`; Statistics `#st-overview` (DESIGN §10, §11) | stats.test.js "describe: known vectors…", "bins10: the eLearning GRADE DISTRIBUTION bins"; smoke "Statistics: the eLearning panel equals GT.stats.describe…", "Statistics: a withdrawn student's scores change nothing…" |
| ST2 | Quartiles, pass rate, letter distribution, per-assessment, histogram, top/bottom, per-team, what-if | `js/core/stats.js`; `js/ui/stats.js` | stats.test.js (every suite); calc.test.js "what-if helpers…"; smoke "Statistics: the what-if result chosen in the UI equals calc.neededScore…" |
| ST3 | Charts in plain SVG, no libraries | `js/ui/stats.js` inline SVG | smoke "Statistics: every chart is inline SVG (no library)…"; repo.test.js "R1…" (no other script) |
| E1 | Download Excel (.xlsx) and CSV | `js/core/exporter.js`; Import / Export tab (`js/ui/exchange.js`) | exporter.test.js "toWorkbook (ExcelJS in Node)", "toCsv"; smoke "Export: the default preset downloads an .xlsx…", "Export after final letters…" |
| E2 | Column picker, reorderable, saved presets; previous-sheet default | exporter presets; export card | exporter.test.js "presets", "columnsFor: the column catalog"; smoke "Export: the default preset…", "Import (review V4R3-1)…" (the "Everything" preset) |
| E3 | Real formulas, frozen header, widths, Status column | exporter sheet model (DESIGN §8) | exporter.test.js "formula parity…", "formula text", "totals exactly at a cutoff", "buildSheet rows and cells"; smoke "Export: the default preset… real formulas… a frozen header and a filter…" |
| E4 | Import .xlsx / .csv with column mapping | `js/core/importer.js`; import card (DESIGN §9) | importer.test.js (every suite, incl. "letters changed in the other letter columns of an export (review V4R3-1)"); smoke "Import: the exported CSV…", "Import: a CSV with the previous TA's headers…", "Import into a finalized course…", "Import (review V4R3-1)…", "Import (review V4R3-2)…" |
| D1 | Clean, responsive, light and dark, keyboard-friendly, printable summary | `css/*`; every view; Summary tab (DESIGN §12); shortcuts and Help / About (DESIGN §14) | smoke "every tab renders in light and dark mode, and at 390 px…", "dark theme applies from the theme menu", "the shortcuts list ("?")…", "keyboard focus stays on the tabs…", "every tab shows a friendly empty state…", "Help / About…", "Summary: page.pdf (Letter, landscape)…" |
| D2 | Privacy mode blurs names (click to reveal) | `.pii` class; `body.privacy-on` | smoke "privacy mode blurs every student name (.pii)…", "Summary: page.pdf… never blurs names", "Summary: "Hide names (use No only)"…" |
| V1 | Required automated tests | `tests/calc.test.js`, `tests/attendance.test.js` | calc.test.js "74.0 example (V1)…", "team propagation with a per-member override (K5)", "withdrawn student excluded from average and rank (S2, K7)", "letter scales (K6)"; attendance.test.js "consecutive-absence detection…", "held sessions and per-session rates (T3)" |
| V2 | README: opening, backup and restore, formulas, placeholder list, storage warning | `README.md` | Manual review. smoke "Help / About…" checks that the README link resolves to the file next to `index.html`. |
| V3 | Verified by tests and a headless browser | `npm test`, `tests/e2e/smoke.mjs` | Both suites (see `docs/build/RESUME.md` for the counts) |
| X1 | Participation out of 5 (max 5, 5%) | templates (`choices: { step: 0.5 }`); grid drop-down | model.test.js "drop-down lists: choices, choiceValues, isChoiceValue (DECISIONS 8)"; history.test.js "drop-down lists and participation out of 5…"; smoke "participation is a drop-down list out of 5…" |
| X2 | Final letters assigned by hand; the final letter is the grade | `model.setFinalLetter(s)`; `calc` effectiveLetter; grid, Statistics, Summary, exporter | calc.test.js "final letters: effectiveLetter…"; model.test.js "final letters (STAGE2B)"; smoke "sorted by total high–low, a range of rows gets its final letter…", "Export after final letters…", "Statistics: "Use these as final letters…"…", "Summary: the letter column says…" |
| X3 | Scores can be finalized and unlocked (logged) | `model.finalize` / `unfinalize`; grid banner; Settings "Grading status" | history.test.js "finalizing the scores (STAGE2B)"; smoke "Finalize scores locks score cells…", "Unlock scores asks first…", "Import into a finalized course…", "Late work: in a finalized course…" |
| X4 | Final letter and participation from drop-downs; invalid typing refused | `model.parseChoiceInput`; grid drop-down cells | model.test.js "parseChoiceInput: strict drop-down entry (DECISIONS 8)"; smoke "typing or pasting a value that is not on the participation list is rejected…", "a mouse pick in a drop-down list saves at once…" |
| X5 | Sorting never moves rows while editing; "re-sort" button | grid row-order snapshot | smoke "rows keep their place after an edit under a sort…" |
| X6 | Meeting view | grid Meeting view (DESIGN §6.1) | smoke "Meeting view shows only the meeting columns…", "Meeting view at 1280 px: the absence columns…", "Meeting view at 1280 px, SE 6362 with attendance on…" |
| X7 | Excused, Unexcused, Total absence columns; unexcused drive warnings; excused not in a streak by default | `attendance.js`; grid absence columns | attendance.test.js "consecutive-absence detection (T5, DECISIONS 6)"; model.test.js "schema 2 migration…"; smoke "Grades grid: Excused, Unexcused and Total absences…", "Attendance: excused (allowed) absences do not make a streak by default…" |
| X8 | Real names never sent or committed | Process rule; fake sample data; `.gitignore` | repo.test.js "R8…"; sample.test.js "names are obviously fake…" |
