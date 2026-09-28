# Stage 4 specification: Export and import (E1–E4)

Authoritative inputs: REQUEST.md, docs/REQUIREMENTS.md (E1–E4), docs/DESIGN.md (§3 "Excel parity").

ExcelJS 4.4.0 is vendored at `vendor/exceljs.min.js`, committed, with its source-map comment removed. Its MIT license is at `vendor/exceljs.LICENSE.txt`.

- In the browser, load it with `GT.ui.loadExcel()`, which lazily inserts a script tag and returns a Promise of ExcelJS.
- In Node tests, load it with `require('../vendor/exceljs.min.js')`.
- Core modules never load ExcelJS themselves. They take the `ExcelJS` object as a parameter, so they stay pure and testable.

## 1. Core: `js/core/exporter.js` (GT.exporter) + `tests/exporter.test.js`

### Column catalog

`columnsFor(course)` returns `[{ key, label, group, available, reason? }]`. The keys:

- `no` → "No"
- `lastName` → "Last Name"
- `firstName` → "First Name"
- `team` → "Team"
- `status` → "Status", with values "Active" or "Withdrawn"
- `notes` → "Notes"
- `raw:<aid>` → the assessment name, for example "Project I"
- `weighted:<aid>` → "<name> <weight>%", for example "Project I 10%", exactly like the TA's old sheet
- `late:<aid>` → "<name>: weeks late" (added in stage 6; include the key now, with `available: true`)
- `total` → "Total"
- `letter` → "Letter Grade"
- `rank` → "Rank"
- `percentile` → "Percentile"
- `diffAvg` → "Diff. from average"
- `incomplete` → "Missing scores" (the count of empty weighted items)
- Attendance columns:
  - `absences` → "Absences" (absent + excused)
  - `unexcused` → "Unexcused"
  - `excused` → "Excused"
  - `absenceRate` → "Absence rate %"
  - `unexcusedRate` → "Unexcused rate %"

  Each attendance column has `available: false` with reason "Attendance is off for this course" when the mode is off. Unavailable columns are skipped at export time, and the UI says so.

### Presets

`builtInPresets(course)` returns:

- `{ id: 'builtin:previous', name: 'Previous sheet layout (default)', columns: [...] }`. The columns are: no, lastName, firstName, all raw:*, all weighted:*, total, letter, absences, status. This mirrors the TA's old sheet (E2) and adds Status.
- `{ id: 'builtin:compact', name: 'Names, total and letter', columns: [no, lastName, firstName, team, total, letter, status] }`.
- `{ id: 'builtin:everything', name: 'Everything', columns: all available }`.

User presets live in `course.exportPresets` as `[{ id, name, columns }]`. Save them through transact with `historyMode: 'none'`. Unknown or missing assessment keys in a preset are skipped silently.

### Row model

`buildSheet(course, results, columnKeys, opts)` is pure. It returns `{ columns: [{ key, label, width, group, tint }], rows: [[cell]], notes }`.

A cell is `{ v, f?, note?, style?: 'withdrawn'|'invalid'|'override' }`:

- `v` is the value. The rules:
  - Numbers stay numbers.
  - An empty score is `null`.
  - Invalid text is exported as `null`, with a note saying "Entered text "abc" is not a number, so it counts as 0". The raw column then has a blank cell, just as the app counts it as 0.
- `f` is an Excel formula without the leading `=`, using A1 references.

Rows are in name order (last name, then first name), with withdrawn students included (S2). `opts.sort` may be 'name' (default) or 'no'.

### Formulas (E3: use real formulas where possible, and they must reproduce the app exactly)

Let `R` be the raw-cell reference of that assessment in the same row, when the raw column is exported. Let `W` be the weight, `M` the maxScore, and `P` the late penalty in points (weeksLate × latePointsPerWeek × M / 100; 0 when waived or not late).

**Weighted**

- With a penalty: `=MAX(0,R-P)/M*W`, for example `=MAX(0,D2-10)/100*10`.
- Without one: `=R/M*W`, for example `=D2/100*10`. This mirrors the spec "raw score / max score × weight".
- A blank R counts as 0, as in the app.
- When the raw column is not exported, write the static value instead of a formula.
- For a team-graded item, the formula still references the student's own raw cell, which holds the effective (team or override) value.

**Total**

`=ROUND(<sum>+<curve>,10)`. Leave out `+<curve>` when the curve is 0.

`<sum>` is built as follows:

- When every weighted cell is exported and they are contiguous, use `SUM(H2:L2)`.
- Otherwise add up one term per assessment with a nonzero weight:
  - the weighted cell reference, if that column is exported;
  - else the raw expression (`R/M*W`, with MAX when late), if the raw column is exported;
  - else the static weighted value.

Then wrap the result for the rounding mode:

- hundredth: `=ROUND(ROUND(...,10),2)`
- integer: `=ROUND(ROUND(...,10),0)`

The 10-decimal ROUND mirrors `util.fix`, so totals sitting exactly at a cutoff get the same letter as in the app.

**Letter**

A nested IF on the total cell T, over the course scale sorted descending:

`=IF(T>=97,"A+",IF(T>=93,"A",…,IF(T>=60,"D-","F")…))`

The last letter is the else branch. This works in every spreadsheet app, and it handles totals below 0.

If the Total column is not exported, write the static letter.

**Static values**

- rank, percentile, diffAvg, incomplete, and the attendance columns are static values.
- Withdrawn students get a blank rank and percentile.

**Notes**

- The header notes are:
  - Weighted headers: "= raw ÷ max × weight".
  - Total: "= sum of weighted + curve (<curve>), rounding: <mode>".
  - Letter: the cutoff list, plus "PLACEHOLDER: not confirmed by the instructor" while letterScale is unconfirmed.
- Override cells get "Per-member override (team score <v>). An unequal split needs the team's written agreement."
- Late cells get "<n> week(s) late, −<P> points" or "late, penalty waived".

### Workbook

`toWorkbook(ExcelJS, course, results, columnKeys, opts)` returns `Promise<ArrayBuffer>`. It uses `buildSheet` to build the workbook:

**Sheet "Grades"**

- The header row is bold, wraps text, and has a grey fill (FFBFBFBF), like the old sheet.
- It is frozen: `views: [{ state: 'frozen', ySplit: 1, xSplit: <number of leading identity columns among no/lastName/firstName/team> }]`.
- There is an autoFilter on the header row.
- Column widths follow content: `clamp(max(header length, longest value) + 2, 5, 40)`. Name columns are at least 14 wide.
- Each assessment's raw and weighted columns are tinted in the header and in the body cells, like the old sheet:
  - 1st assessment: green FFE2EFDA
  - 2nd: orange FFFCE4D6
  - 3rd: blue FFDDEBF7
  - 4th: pink FFF8DCEF
  - 5th: violet FFE9E1F5
  - later: grey FFEDEDED
- Every cell has thin borders.
- Withdrawn rows have a grey font.
- Formula cells are written as `{ formula, result }`, where `result` is the app's value, so viewers that do not recalculate still show correct numbers.
- Set `workbook.calcProperties.fullCalcOnLoad = true`.

**Sheet "Settings"** (opts.includeSettings, default true)

- The course code and title, and the export time.
- The assessments table: name, max, weight, team-graded.
- The rounding mode, curve, late points per week, and the letter scale.
- The list of unconfirmed placeholders, with notes.
- A line "Generated by Grade Tracker (offline). Formulas in the Grades sheet recalculate if you edit raw scores."

**Sheet "Change history"** (opts.includeHistory, default false): `GT.history.toRows`.

### CSV

`toCsv(course, results, columnKeys)` returns a string built with `GT.csv.stringify(rows, { bom: true, eol: '\r\n', guardFormulas: true })`. It has the same columns, with values only and no formulas.

### Data check

This is an improvement: a pre-export check.

`dataCheck(course, results)` returns `{ items: [{ level: 'warn'|'info', text }] }`. It reports:

- empty weighted scores, counted per assessment (active students)
- invalid entries
- out-of-range scores
- overrides
- withdrawn students included
- unconfirmed placeholders (letter cutoffs first)
- a weight sum that is not 100

### Tests

Include a tiny formula evaluator in `tests/helpers/mini-excel.js`. It supports numbers, strings, `+ - * /`, comparison operators, parentheses, and the functions `ROUND` (half away from zero), `SUM` over ranges and lists, `MAX`, and `IF`, plus A1 references within one sheet.

Then test that:

- For the sample data (SE4351 and SE6362), in every rounding mode, with curve 0 and 2.5, and with a few late entries and one waived entry, **every student's Total and Letter formula evaluates to exactly the app's total and letter**.
- Add a test for totals exactly at a cutoff, for example 90.
- The default preset has the old-sheet order.
- Headers read "Project I 10%" and so on.
- Freeze panes and autoFilter are set.
- Widths are within bounds.
- The Status column is present.
- Withdrawn students are included, with a blank rank.
- A column subset with a missing raw column falls back to static values.
- CSV escaping and the formula guard work.
- An ExcelJS round trip in Node (`toWorkbook` → `xlsx.load`) keeps the formulas and results.

## 2. Core: `js/core/importer.js` (GT.importer) + `tests/importer.test.js`

- `rowsFromWorksheet(ws)` returns `string[][]`. It converts cell values as follows:
  - A number becomes its string.
  - A formula gives its result.
  - Rich text is joined.
  - A hyperlink gives its text.
  - A date becomes `YYYY-MM-DD`.
  - An error value becomes ''.
  - null becomes ''.

  Trailing empty rows and columns are trimmed. Everything else is pure (no ExcelJS needed).
- `detectHeaderRow(rows)` returns the index of the first row with at least 2 non-empty, non-numeric cells, or 0.
- `targetsFor(course)` returns `[{ key, label }]` for the mapping selects. The keys are:
  - `ignore`
  - `no`, `lastName`, `firstName`
  - `fullName`, which parses "Last, First" or "First Last"
  - `team`, `status`, `notes`
  - `raw:<aid>`
  - `weighted:<aid>`, labeled "Weighted <name> (converted to raw = value ÷ weight × max)"
  - `absent` (attendance totals, unexcused)
  - `excused` (attendance totals)
  - `absencesTotal`, labeled "Total absences (stored as unexcused)"
- `guessMapping(headerCells, course)` returns an array of target keys. It must map the TA's old sheet headers exactly:

  | Header | Target |
  | --- | --- |
  | "No" | no |
  | "Last Name" | lastName |
  | "First Name" | firstName |
  | "Final Project I" | raw:a_p1 |
  | "Final Project II" | raw:a_p2 |
  | "Test 1" | raw:a_t1 |
  | "Test 2" | raw:a_t2 |
  | "Project I 10%" | weighted:a_p1 |
  | "Project II 20%" | weighted:a_p2 |
  | "Test 1 25%" | weighted:a_t1 |
  | "Test 2 40%" | weighted:a_t2 |
  | "Class Participation 5%" | weighted:a_part |
  | "Total" | ignore |
  | "Letter Grade" | ignore |
  | "No of Absence" | absencesTotal |
  | "" | ignore |

  Also map "Status", "Team", "Notes", "Name" / "Student" (fullName), "Term Paper", and "Participation".

  Matching rules:
  - Normalize the header: lowercase, drop punctuation except `%`, split into tokens.
  - An assessment matches when its name tokens appear in the header as a contiguous run and are not followed by another roman-numeral token. This keeps "project i" from matching "Project II".
  - Category keywords also count: 'participation' matches the participation category, and 'paper' matches the paper category.
  - A `%` token or a trailing number equal to the weight marks the header as weighted.
  - "No" matches only exact "no", "no.", "#", "number", or "student no". It never matches "No of Absence".
- `plan(course, rows, headerIndex, mapping, options)` returns `{ items: [{ rowIndex, action: 'update'|'new'|'skip', reason?, studentId?, name, changes: [{ field, oldValue, newValue }] }], counts: { update, new, skip, changes, overrides, invalid } }`.

  `options` holds:
  - `matchBy: 'name'|'no'` (default 'name': case-insensitive, whitespace-collapsed last+first)
  - `createMissing` (default true)
  - `emptyCells: 'keep'|'clear'` (default 'keep')
  - `overwrite` (default true; false only fills empty scores)
  - `switchAttendanceToTotals` (boolean)

  Values are parsed with `util.parseScoreInput`. Weighted values are converted to raw as value ÷ weight × max, rounded with `util.fix`, for example 9.4 on 10% with max 100 gives 94. Status values:
  - "withdrawn", "w", "dropped", or "inactive" become withdrawn.
  - "active" or empty become active.
- `apply(course, plan)` applies the plan inside the caller's transact:
  - It creates new students with `model.createStudent`, taking `no` from the file or `model.nextStudentNo`.
  - It creates teams by name.
  - It writes individual scores through `model.entryFromInput` semantics.
  - Team-graded raw values are grouped per assessment and passed to `model.setTeamScoreFromMembers`, so members that disagree become overrides.
  - Attendance totals go into `attendance.totals`.
  - With `switchAttendanceToTotals`, it sets `mode = 'totals'`, and `totalsSessionsHeld` is left for the user to fill.
  - It returns a summary.
- Tests:
  - guessMapping on the old-sheet headers.
  - CSV parsing through GT.csv, then plan, then apply.
  - Weighted-to-raw conversion.
  - Team-graded agreement and disagreement.
  - Name matching with odd case and spacing.
  - The no-match plus createMissing path.
  - Status mapping.
  - "keep" versus "clear" for empty cells.
  - `overwrite: false`.
  - Export to xlsx (via exporter and ExcelJS in Node), then `rowsFromWorksheet`, then plan and apply into a fresh empty copy of the course. The result must match the original's effective raw scores.

## 3. UI: `js/ui/exchange.js` + `css/exchange.css` (GT.views.exchange, tab "Import / Export")

Add both files to index.html, plus the `<script>` tags for js/core/exporter.js and js/core/importer.js after csv.js.

### Export card

- **Preset select**: built-in presets plus the user's presets.
- **Column picker**:
  - A list of every column, each with a checkbox and a label.
  - Reorder with up/down buttons (keyboard accessible) and optionally by drag and drop.
  - Unavailable columns are shown disabled, with their reason.
  - Controls: select all, none, and reset to preset.
- "Save as preset…", "Rename", and "Delete preset", for user presets only.
- **Options**:
  - Sort rows by name or by No.
  - Include a Settings sheet (on).
  - Include a Change history sheet (off).
- **Data check** (`GT.exporter.dataCheck`), shown inline above the buttons, with warnings styled. It never blocks the download.
- **Buttons**:
  - "Download Excel (.xlsx)" produces `<CODE>-grades-<stamp>.xlsx`, where `<CODE>` is `GT.ui.slug(course.code)`.
  - "Download CSV" produces `<CODE>-grades-<stamp>.csv`.
- **Status**: show a spinner-ish state while ExcelJS loads, and a clear error if `vendor/exceljs.min.js` is missing.
- **Reminder**: a muted line saying exported files contain confidential grades, and should be kept out of shared or synced folders and out of this repository (the .gitignore already excludes *.xlsx, *.csv, and backup JSON).

### Import card (a stepper)

1. **Choose file**: `.xlsx` or `.csv`. For `.xls` or anything else, explain: "Open it in Excel and use Save As → Excel Workbook (.xlsx), then import that file."
2. **Sheet and header row**:
   - A sheet select (xlsx only).
   - The header row, auto-detected and changeable.
   - A preview of the first 8 rows (names are pii).
3. **Map columns**:
   - One row per source column: header, 3 sample values (pii when the column is mapped to a name), and a target select prefilled by guessMapping.
   - Warn when two columns map to the same target.
   - Options: matchBy, createMissing, emptyCells, overwrite.
   - An attendance-mode switch, offered when an attendance target is mapped and the course is not in totals mode.
4. **Preview**:
   - Counts: update, new, skip, changes, overrides, invalid.
   - A table of the first 50 changes: student (pii), field, old value, new value.
   - The skipped rows, with reasons.
5. **Import**: ONE `GT.store.transact('Import <file name>', mutator, { source: 'import' })`, so the history logs every change. Then a toast and a link to the Grades tab.

Undo (Ctrl+Z) reverts the whole import. Mention this in the confirmation text.

## 4. E2E

Extend tests/e2e/smoke.mjs:

- Export xlsx and csv with the default preset. Catch the download, then parse it in Node:
  - The xlsx through the vendored ExcelJS: check the headers, formulas, freeze, and Status column.
  - The csv: check the BOM and the header.
- Import the exported CSV into a new empty course. The totals must match.
- Import a CSV built from the old-sheet headers (fake names), and check the mapping guesses.
- The whole run makes zero network requests. ExcelJS loads from file://.

## Addendum: changes since this spec was written (stages 2b and 3, DECISIONS.md). These override the sections above where they differ.

1. **Participation is out of 5.** Template a_part has maxScore 5, weight 5 and choices {step 0.5}. The weighted formula is generic (`=L2/5*5`), so nothing special is needed. Keep the header note generic.

2. **Final letters** (DECISIONS 2, docs/DESIGN.md §2.5).
   - Columns:
     - "Letter Grade" (key `letter`) is the **effective** letter.
       - When any student in the course has a final letter, export it as a static value for every student: `calc.studentResult(...).effectiveLetter` (the final letter, or the suggestion when a student has no final letter).
       - Give such a cell the note "Final letter assigned by the instructor" when `letterSource === 'manual'`.
       - When no final letters exist, use the nested-IF formula on Total (as specified above).
     - Add `suggestedLetter` → "Suggested Letter (cutoffs)", which is always the nested-IF formula.
     - Add `finalLetter` → "Final Letter", a static value (empty when not set).
   - The default preset keeps a single "Letter Grade" column (the effective letter).
   - The "Settings" sheet says whether the letters are final (manual) or suggestions, and whether the scores are finalized (date).

3. **Attendance columns** (DECISIONS 6). The keys are `excused` → "Excused (allowed)", `unexcused` → "Unexcused (not allowed)", `absences` → "Total absences", `absenceRate`, and `unexcusedRate`.
   - The default preset replaces the old single "absences" with three columns, in this order: Excused (allowed), Unexcused (not allowed), Total absences. They go after Letter Grade and before Status.
   - All attendance columns are unavailable (skipped, with a reason) when the mode is off.
   - Values come from `GT.attendance.summary` (js/core/attendance.js). The exporter may `require('./attendance.js')` in Node, like the other core modules.

4. **Drop-down items.** An imported value for an item with a list (for example participation) that is not on the list is still imported, because data must never be lost. It is counted in the preview as "not on the list" and highlighted afterwards (`calc.scoreDetail().notOnList`).

5. **Importer mapping.**
   - The previous sheet's "Letter Grade" column maps to a new target, `finalLetter` ("Final letter"). Import it with `model.matchLetter`. Letters not in the scale are skipped and reported. Empty cells follow the emptyCells option.
   - "Class Participation 5%" still maps to `weighted:a_part`: the value ÷ weight × max, which gives the same number when max = weight = 5.
   - "No of Absence" maps to `absencesTotal`.

6. **Finalized courses.**
   - When `model.isFinalized(course)`, the import plan marks every score or participation change as blocked. The reason is "Scores are finalized: unlock them in the Grades tab first".
   - In the UI, the score targets stay selectable but show that notice, and the preview counts them as blocked. Student info (names, No, team, status, notes) and final letters can still be imported.

7. **Export while finalized.** Export is always allowed. The data check says "Scores finalized on <date>" (info) or "Scores not finalized yet" (warn).

8. **Data check** additions:
   - active students without a final letter (info)
   - `orderIssues` count (warn)
   - participation still empty (warn)

9. **Independent formula verification** (review stage). Besides `tests/helpers/mini-excel.js`, a reviewer re-evaluates the exported .xlsx formulas with an independent engine installed only in the scratchpad, for example `npm install --prefix <scratch> hyperformula`. Never add it to the repository. The reviewer then compares the result with the app's totals and letters for the sample data in all rounding modes, with a curve, and with late entries.
