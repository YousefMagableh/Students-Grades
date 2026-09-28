# Stage 2 specification: grid, teams, withdrawn students, change history, settings

Authoritative inputs: REQUEST.md (the user's request), docs/REQUIREMENTS.md, docs/DESIGN.md.
This file adds the concrete stage-2 design. Where it is more specific than DESIGN.md, follow this file.

## 0. What already exists (read these before writing code)

- `index.html`: the shell markup, CSP, and script/link tags. Scripts are classic scripts loaded in this order:
  util, model, calc, history, sample, csv, storage, store, ui/widgets, ui/grid, ui/students, ui/settings, ui/history-view, app.
  Per-view stylesheets: css/grid.css, css/students.css, css/settings.css, css/history.css (base tokens and components are in css/base.css).
- `js/core/util.js`, `js/core/model.js`, `js/core/calc.js`, and `js/core/sample.js` (stage 1, tested).
- `js/storage.js`: IndexedDB, then localStorage, then memory.
- `js/store.js`: `GT.store`, covering transact, undo/redo, autosave, subscribe, results(), setUi, annotateHistory.
  **Every course-data change must go through `GT.store.transact(label, mutator, opts)`.** The mutator mutates the course object it receives. Do not keep references to course sub-objects across renders; re-read `ctx.course` on every render.
- `js/ui/widgets.js`: `GT.ui` provides:
  - icon(name)
  - el(html)
  - $ and $$
  - toast
  - dialog.open, dialog.confirm, dialog.form, dialog.prompt
  - menu(anchor or {x, y}, items, opts)
  - closeMenu
  - download
  - pickFile
  - readText
  - readArrayBuffer
  - loadExcel
  - fmt(x)
  - relativeTime
  - dateTime
  - fileStamp
  - slug
  - placeholderBadge(course, key, {compact})
  - isTypingTarget
  - initPrivacyReveal
  Read it to learn the exact signatures.
- `js/app.js`: the boot sequence, header, tabs, banners, status bar, course menu, data menu (backup, restore, delete all), theme, privacy, and global shortcuts. It covers:
  - Ctrl/Cmd+Z and Ctrl/Cmd+Y (or Ctrl+Shift+Z) for undo/redo, when focus is not in an input, textarea, or select.
  - Alt+1..8 to switch tabs.
  - `?` to show the shortcuts list.
  - `GT.app.navigate(viewId, params)`, `GT.app.params()`, and `GT.app.render()`.
  - `GT.app.actions`: backup, restore, deleteAll, addCourse, editCourse, duplicateCourse, deleteCourse, loadSample.
  The app renders the active view as follows:
  - It calls `GT.views[id].render(el, ctx)` after every store change, where `ctx = { store, course, results, params, navigate, switched }`.
  - `el` is a fresh container each time the user switches to the view (`ctx.switched === true`). Bind delegated listeners on `el` once per container: keep a module variable `boundEl`, and bind when `el !== boundEl`.
  - The optional `destroy()` is called when the user leaves the view.
  - Global document-level listeners must be added once and must check that the view is active: `document.body.contains(boundEl)`.

## 1. Conventions every UI file follows

- Plain ES2017 inside an IIFE: `(function (root) { 'use strict'; var GT = root.GT; ... })(typeof globalThis !== 'undefined' ? globalThis : this);`
- No inline `on*=` attributes. Escape every dynamic string with `GT.util.escapeHtml`.
- No network: no fetch, no external URLs, no new libraries.
- **Privacy:** every element that renders a student name (last name, first name, "Last, First", or a name inside a history row, dialog title, toast, or menu heading) or student notes must carry class `pii`. For inputs that hold names, add class `pii` to the input. For toasts and menu headings that would contain a name, use the student's No instead ("Student No 12"), because toasts and menus cannot be blurred reliably.
- Use the shared components in css/base.css:
  - .btn, .btn-primary, .btn-sm, .btn-icon, .btn-ghost, .btn-danger
  - .segmented
  - .card, .card-header, .card-body
  - .badge, .badge-warn, .badge-danger, .badge-success, .badge-info
  - .chip
  - .toolbar
  - .table-wrap, table.table
  - .field, .check
  - .callout
  - .empty-state
  - .page-header
  - .section-label
  - .muted
  - .num
  - .kbd
  - .search
  Put view-specific styles only in your own css file.
  Use CSS custom properties from base.css for all colors, so light and dark themes both work: --bg, --bg-elev, --border, --text, --text-muted, --accent, --group-1..6, --cell-invalid-bg, --cell-range-bg, --withdrawn-text, --warn-bg, and so on. Never hard-code colors.
- **Placeholder badge:** wherever a placeholder value is shown or edited (letter cutoffs, rounding, curve, max scores, project split, term paper weight, unexcused threshold, passing letter, late work), render `GT.ui.placeholderBadge(course, key)`. The compact variant goes in tight spots such as the Letter column header.
- Numbers display with `GT.ui.fmt(x)`, which uses `course.settings.decimals` and trims trailing zeros. Raw scores always show as entered.
- Keyboard: everything must be reachable by keyboard, and focus must stay visible.
- Persisted view preferences go in `GT.store.state.ui` through `GT.store.setUi({...})`, under a key named `<view>Prefs`: `gridPrefs`, `studentsPrefs`, `settingsPrefs`, `historyPrefs`. `model.normalizeState` keeps these keys as shallow plain objects.
  - Example: `gridPrefs = { sort: 'name'|'total', dir: 'asc'|'desc', group: false, showWithdrawn: true, cols: { weighted: true, percentile: true, diff: true, attendance: true } }`.
  - Always merge with defaults when you read them.
- Model helpers already exist in js/core/model.js and are documented in docs/DESIGN.md 2.3. Use them instead of re-implementing:
  - setTeamScore, setOverride, clearOverride, entryFromInput, isBlankEntry, hasScore, entryKey, withLate
  - setTeamScoreFromMembers (returns { overridesCreated, teamsSet, propagatedTo })
  - moveStudentToTeam(course, sid, teamId|null, { keepScores })
  - removeTeam(course, tid, { keepScores })
  - convertAssessmentToTeam, convertAssessmentToIndividual
  - removeAssessment, moveAssessment, splitAssessment
  - renumberByName, deleteStudent
  - normalizeLetterScale, passingLetterFor
  - createStudent, createTeam, createAssessment, nextStudentNo
  - studentName, courseLabel, placeholderInfo, unconfirmedPlaceholders, isConfirmed
  calc also provides minTotalForLetter and neededScore, for later stages.

## 1b. File ownership during the parallel build

Each builder edits ONLY its own files:

| Owner | Files it may edit |
| --- | --- |
| core | js/core/history.js, js/core/csv.js, tests/history.test.js, tests/csv.test.js, tests/store.test.js, and js/core/model.js (only if something is truly missing, with tests) |
| grid | js/ui/grid.js, css/grid.css |
| students | js/ui/students.js, css/students.css |
| settings | js/ui/settings.js, css/settings.css |
| history-view | js/ui/history-view.js, css/history.css |

Shared shell files (index.html, js/app.js, js/store.js, js/storage.js, js/ui/widgets.js, css/base.css) must NOT be edited by builders. If you need a change there, describe it precisely in your result under `shellChangesNeeded`, and code defensively so your view works without it.

Other builders' files may not exist yet while you work, because the builders run at the same time. Guard every cross-module call, for example `if (GT.csv) ...` and `if (GT.ui.openStudent) ...`. Use the documented APIs.

## 2. `js/core/history.js` (GT.history), core and pure, plus tests

Implements docs/DESIGN.md section 4 in full. It is used by store.transact, undo, and redo.

- `diffCourse(before, after, { ts, source })` returns `HistoryEntry[]`.
  - `before` and `after` are course objects (history excluded).
  - Every entry has this shape: `{ id: util.uid('h'), ts, source, kind, studentId, studentName, teamId, teamName, field, fieldKey, oldValue, newValue, note }`.
  - Values are display strings. Empty is `''`. Numbers appear exactly as entered (`String(value)`). Invalid text appears as `"<text>" (not a number)`. Booleans appear as 'yes'/'no'.
  - Names are snapshots: 'Last, First' from `after`, or from `before` if the student was removed.
  - Deterministic order: course details and settings, then assessments, then placeholders, then teams, then students (added, removed, fields, status, team), then team scores, then individual entries, then propagation, then attendance.
  - Within each group, follow assessment order and then student name order.
- Course details: code, title, term, level. Kind 'settings'.
- Settings: decimals, rounding, curve, latePointsPerWeek, passingLetter. Kind 'settings'.
  - Letter scale changes are logged per letter, as field `Cutoff <letter>` with old and new min. A letter that was added or removed is also logged.
- Assessments: added (newValue like `Project III (weight 10%, max 100, team-graded)`), removed, name, maxScore, weight, teamGraded (`yes`/`no`), and category. Kind 'settings'.
- Placeholders: a change to the `confirmed` flag is logged as kind 'settings', field `Confirmation: <label>`, with values `needs confirmation` and `confirmed`.
- Teams: created, renamed, and deleted are logged as kind 'team-membership' with studentId null.
- Students:
  - Added: kind 'student', field 'Student', newValue 'Added'.
  - Removed: kind 'student', field 'Student', newValue 'Deleted permanently'.
  - No, last name, first name: kind 'student'.
  - Notes: kind 'student'. Truncate values to 200 characters.
  - Status: kind 'status'.
  - Team: kind 'team-membership', with team names as the values ('' for no team).
- Team scores: a change to `teamScores[t][a]` value or text is logged as kind 'team-score' with teamId and teamName set and studentId null. The note is `Team score for <n> members`.
  - A change to weeksLate on a team entry is kind 'late', field `<Assessment>: weeks late`.
  - A change to waived on a team entry is kind 'late', field `<Assessment>: penalty waived`.
- Individual entries `scores[s][a]`:
  - Override flag false to true: kind 'override'. old = the value the student saw before (the team score), new = the override value. The note is `Per-member override: an unequal split needs the team's written agreement`.
  - Override flag true to false (or the entry was removed): kind 'override-removed'. old = override value, new = the value seen now. The note is `Now uses the team score`.
  - Override kept but value changed: kind 'override'. The note is `Override value changed`.
  - Other value or text changes: kind 'score'.
  - weeksLate and waived changes: kind 'late', using the same field names as above.
  - Skip entries of assessments that were removed. The assessment removal entry covers them.
- Propagation: for every student in `after` and every team-graded assessment in `after`, compare the display value of `calc.scoreDetail(before...)` against `calc.scoreDetail(after...)` for the effective entry.
  - Use `model.effectiveEntry` or `calc.resolveEntry` on the two course objects. The student may be absent in `before`, and then it is skipped.
  - When the value differs, and this diff has no 'score', 'override', or 'override-removed' entry for that student and assessment, add kind 'propagation'.
  - The note is `From <team> team score`. If the student's team changed, use `Moved to <team>: uses its team score`. If the student now has no team, use `No team: uses the individual score`.
- Attendance (also covers stage 3, so stage 3 does not have to touch this file):
  - Changes to mode, unexcusedThreshold, excusedCountsTowardStreak, dropStreak, failStreak, and totalsSessionsHeld are kind 'settings'.
  - Sessions added, removed, or changed (date or label) are kind 'settings', field `Session <date>`.
  - `records` changes (per student per session) and `totals` changes (absent/excused per student) work as follows. If the transaction changes 5 or fewer marks in total, write one entry per mark: kind 'attendance', field `Attendance <YYYY-MM-DD>` with values P/A/E/'' shown as Present/Absent/Excused/''. Totals appear as field 'Absences (totals)' or 'Excused (totals)'.
  - Otherwise write ONE summary entry: kind 'attendance', studentId null, field 'Attendance', newValue `<n> marks changed`, note listing the affected session dates (at most 10, then "…").
- `bulkEntry({ ts, source, field, note })` returns a kind 'bulk' entry.
- `displayValue(entry, assessment?)` returns the display string used above. Export it.
- `toRows(entries)` returns `[header, ...rows]` for CSV export. Columns: Timestamp (ISO), Source, Kind, Student, Team, Field, Old value, New value, Note, User note.
- HistoryEntry may later carry `userNote` and `userNoteAt`, set by `GT.store.annotateHistory`. Keep them in `toRows`.
- tests/history.test.js covers every kind above:
  - A team score change produces 1 team-score entry plus propagation entries for members without override, and none for the override member.
  - Override set and removed.
  - Moving a student to another team.
  - Withdrawing a student.
  - Weight change.
  - Letter cutoff change.
  - Placeholder confirmation.
  - Attendance with 3 changes (per-mark entries) and with 20 changes (1 summary entry).
  - Adding or removing a student.
  - Invalid text displayed.
  - Deterministic order.

## 3. `js/core/csv.js` (GT.csv), core and pure, plus tests

- `parse(text, { delimiter: 'auto'|','|';'|'\t' })` returns `string[][]`.
  - RFC 4180: quoted fields, doubled quotes, and newlines inside quotes.
  - Strips a UTF-8 BOM. Handles CRLF, LF, and CR.
  - Drops a single trailing empty line.
  - 'auto' picks the delimiter among `\t`, `,`, and `;` that occurs most in the first non-empty line outside quotes. It prefers tab when it is present.
- `parseClipboard(text)` returns `string[][]`: the TSV that Excel or Sheets puts on the clipboard.
  - Uses `parse(text, { delimiter: '\t' })` when the text contains a tab. Otherwise each line is a single cell, so one-column pastes work.
  - Trims one trailing newline.
  - A single line with no tab yields `[[text]]`.
- `stringify(rows, { delimiter = ',', bom = false, eol = '\r\n', guardFormulas = true })` returns a string.
  - Quotes fields containing the delimiter, a quote, CR, or LF.
  - With guardFormulas, a string cell that starts with `=`, `+`, `-`, `@`, tab, or CR gets a leading apostrophe (CSV-injection guard). Plain numbers that are JS numbers are not touched.
- tests/csv.test.js: quoted newlines, BOM, delimiter detection, Excel-style clipboard block (3×4 with empty cells), round trip, formula guard.

## 4. Grades grid: `js/ui/grid.js` + `css/grid.css` (registers GT.views.grades)

**Header area**
- `page-header` with the course code and title.
- Subtitle: "<n> active · <m> withdrawn · class average <avg> (active students)", plus a weights chip when the sum is not 100.

**Toolbar**
- Search input (`.search`). It filters rows by last name, first name, No, or team name, case-insensitive. The `/` key focuses it when not typing. Esc clears it.
- Sort control with four options:
  - "Name A–Z" (default)
  - "Name Z–A"
  - "Total high–low"
  - "Total low–high"
  Name sort means last name, then first name (`calc.sortStudents` with 'name').
- Toggle "Group by team".
- Toggle "Show withdrawn" (default on). Withdrawn rows are shown greyed.
- A "Columns" menu with checkboxes for these columns, all default on:
  - Weighted scores
  - Percentile
  - Difference from average
  - Attendance (only offered when attendance mode is not 'off')
- Buttons "Add student" and "Paste roster" (the latter calls `GT.ui.openRosterPaste()` from students.js when it exists).
- A legend line: empty cell = counted as 0, red = not a number, yellow = outside 0 to max, ◆ = per-member override, team icon = team score.

**Columns, in order**
- Identity columns, sticky on the left when scrolling horizontally:
  - No
  - Last Name
  - First Name
  - Team
- Raw score for each assessment, in assessment order.
  - Header: the assessment name, and a second line in small muted text: "max 100 · 10% · team" (team only when team-graded).
  - The header background uses the group tint: the n-th assessment takes `--group-n` (1..5), and later ones take `--group-6`. The tint repeats faintly on body cells of that column.
- Weighted score for each assessment.
  - Header: "<name> <weight>%", for example "Project I 10%" as in the TA's old sheet.
  - Read-only, with the same tint.
- Total: read-only and bold. An "incomplete" indicator appears when `result.incomplete`: a small hollow-circle icon plus a tooltip, "2 weighted scores are empty and count as 0".
- Letter:
  - Read-only.
  - Header carries the compact placeholder badge when letterScale is unconfirmed.
  - Withdrawn rows show the letter muted.
- Rank:
  - Read-only.
  - "—" for withdrawn.
  - "1 of 57" style in the tooltip.
- Percentile: read-only, for example "85th". This is optional.
- ±Avg: read-only, signed, for example "+3.2". This is optional.
- Attendance summary:
  - Read-only. Shown only when the course attendance mode is not 'off' and `GT.attendance` exists (stage 3 adds it).
  - Call `GT.attendance.summary(course, student.id)`, which returns `{ totalAbsences, unexcused, excused, recorded, absenceRate, unexcusedRate, longestStreak, warning: null|'drop'|'fail', overThreshold }`.
  - Display "3 (1 unexc.)", with a warning icon when warning is set or overThreshold is true.
  - Until stage 3, hide this column.

**Footer row**
- "Class average (active)": the average of numeric raw entries per assessment (active students only), plus weighted and Total averages.

**Row states**
- Withdrawn rows use `.row-withdrawn`: muted text, and a "Withdrawn" badge after the first name.
- Rows are still editable.

**Cell visuals for raw scores**
- Empty: shows a faint "–".
- Invalid text: shows the text on a red background (`--cell-invalid-bg`), with the tooltip "Not a number: counted as 0".
- Out of range: shows the value on a yellow background (`--cell-range-bg`), with the tooltip "Outside 0–<max>".
- Team source: a small team icon, faint. The tooltip reads "Team score (<team name>)".
- Override: a ◆ marker in accent color. The tooltip reads "Per-member override. Team score: <v>. An unequal split needs the team's written agreement."
- Team-graded but the student has no team: tooltip "No team: individual score".

**Selection and navigation**
- One active cell, plus an optional rectangular range. Shift+Arrow and Shift+Click extend the range. Mouse drag selects a range.
- Arrow keys move between cells. Tab and Shift+Tab move right and left, wrapping to the next or previous row.
- Home and End go to the first and last column. Ctrl+Home and Ctrl+End go to the first and last cell.
- PageUp and PageDown move 10 rows.
- Read-only cells can be selected but not edited.

**Editing (Excel semantics)**
- Typing a printable character starts "enter mode": the editor replaces the value, and the arrow keys commit and move.
- Enter, F2, or a double-click starts "edit mode": the editor keeps the value, and the arrow keys move the caret.
- In the editor:
  - Enter commits and moves down.
  - Shift+Enter commits and moves up.
  - Tab commits and moves right. Shift+Tab commits and moves left.
  - Esc cancels.
  - Clicking elsewhere commits.
- The editor is an `<input>` overlaid in the cell, with an aria-label like "Test 1 for Student No 5".

**Commit rules**
- Commit uses one `store.transact` call with a label like `Edit Test 1`. The value goes through `model.entryFromInput`, keeping the late info and override flag of the previous entry. A blank entry (per `model.isBlankEntry`) removes the entry.
- Non-team assessment: writes `course.scores[sid][aid]`.
- Team-graded assessment, student in an existing team, no override: writes **the team score** `course.teamScores[teamId][aid]`, which propagates to all members. The first time per session, a toast explains: "Team score updated for all <n> members of <team>. To give one student a different score, use the cell menu → Override."
- Team-graded cell that already has an override: edits the override value (keeps `override: true`).
- Team-graded assessment, student without a team: writes the individual entry.
- No, Last Name, First Name: text. No must be a positive integer or empty. Last and first names are trimmed.
- Team cell:
  - Editing opens a `<select>` listing (no team), the teams, and "New team…".
  - Changing the team calls `model.moveStudentToTeam`.
  - When the student has team-graded scores that would change, a `dialog.open` first asks: "Keep this student's current Project I/II scores (as overrides)?" or "Use the new team's scores".
- Delete or Backspace on the selection clears every editable cell in it, in one transaction. Name cells are not cleared by Delete; show a toast instead.

**Clipboard**
- Ctrl/Cmd+C copies the selection as TSV: raw text as entered for raw columns, displayed values for computed columns. Use `navigator.clipboard.writeText` when it is available. Otherwise use a `copy` event handler with `e.clipboardData.setData`.
- Paste listens to the `paste` event on the grid while a cell is active and not editing.
  - Parse the data with `GT.csv.parseClipboard`.
  - The block is applied from the active cell (top-left) across visible rows (current sort, filter, and grouping; team header rows are skipped) and visible columns.
  - Read-only (computed) columns are skipped, and their values ignored. A toast reports it.
  - If the clipboard holds a single value and the selection is a range, fill the whole range.
  - Rows past the end are dropped, with a warning.
  - All changes happen in ONE transaction with source 'paste'.
  - Team-graded columns: collect `{studentId, entry}` for every pasted row of that assessment, and call `model.setTeamScoreFromMembers(course, aid, rows)`.
  - Report in a toast: "Pasted 42 cells. 3 team-graded values differed from their team's score and were saved as per-member overrides (◆)."
  - Invalid values are stored as text (and highlighted), not rejected.

**Cell menu**
- Opens with right-click, Shift+F10, or the ContextMenu key. Uses `GT.ui.menu`. Items:
  - Team-graded cell, student has a team, no override: "Override for this student only…". It opens `dialog.form` with the value prefilled with the team score and a help text about the written agreement, then writes `scores[sid][aid] = {value, override: true}`.
  - Override cell: "Remove override (use team score <v>)" and "Edit team score…" (prompt).
  - "Clear score"
  - "Copy"
  - "Open student details" (`GT.ui.openStudent(studentId)`, if defined)
  - Leave a clearly marked extension point for stage 6: `GT.gridCellMenuExtensions = []`. Each extension is a function `(ctx) -> items[]`, and its items are appended.

**Group by team**
- Team header rows (not selectable as cells) read: "<Team name> · <n> members · team average <x>".
- Each team-graded assessment column shows the team score in the header row.
- Clicking that team score opens a prompt to edit the team score directly.
- Students without a team go under "No team".
- Sort applies within groups.

**Other behavior**
- After sort, filter, or re-render, keep the active cell on the same student and column when it is still visible. Restore focus to it when the grid had focus before the re-render.
- Empty course (no students): an `.empty-state` card with buttons for:
  - "Load sample data" (`GT.app.actions.loadSample`)
  - "Paste roster" (`GT.ui.openRosterPaste`)
  - "Add student"
  - "Import from Excel/CSV" (`navigate('exchange')` if that view exists)
- "Add student" appends a student with `model.nextStudentNo`. It selects the new row's Last Name cell and starts editing it.
- A small "details" button (icon `user`) in the No cell opens `GT.ui.openStudent(id)`. It is visible on row hover or focus, and is keyboard reachable via the cell menu.
- Accessibility:
  - `role="grid"` on the table, `aria-rowcount`, and `aria-colcount`.
  - Cells get `role="gridcell"`, and `aria-readonly="true"` on computed cells.
  - Only the active cell has `tabindex="0"`, which makes it a roving tabindex. Tab inside the grid moves between cells, so Tab from the last cell moves on to the next row.
- Performance: 59 rows × ~22 columns must re-render in under 30 ms. Build the tbody with one innerHTML string.

## 5. Students & Teams: `js/ui/students.js` + `css/students.css` (registers GT.views.students)

**Students card**
- A table with these columns:
  - No
  - Last name
  - First name
  - Team
  - Status
  - Notes (truncated)
  - Actions: Edit, Withdraw/Reinstate, Details, and Delete in the ⋯ menu
- Filter: All / Active / Withdrawn.
- Search box.
- Buttons:
  - "Add student": `dialog.form` with no, lastName, firstName, team select, and notes.
  - "Paste roster"
  - "Renumber by name": assigns No 1..N in name order, active and withdrawn together. Confirm first, and it can be undone.
- Withdraw: confirm dialog explaining that the student stays in history and exports but is excluded from statistics, rank, percentile, and the class average. Reinstate is the reverse.
- Delete permanently:
  - Strong warning, recommending Withdraw instead.
  - Requires typing the student's No.
  - Removes the student's scores, override entries, attendance records, and totals.
  - Logged by the history diff.

**Roster paste: `GT.ui.openRosterPaste()`**
- Exported for the grid to call.
- A wide dialog with a textarea: "Paste names copied from Excel (one student per row)".
- Parses with `GT.csv.parseClipboard`, and shows a live preview table of parsed rows (No, Last name, First name, Team) with per-row status: new, duplicate (same last and first name as an existing student, which is skipped), or empty (skipped).
- Column detection:
  - 1 column: "Last, First" when it contains a comma. Otherwise "First Last", where the last word is the last name.
  - 2 columns: Last, First.
  - 3 or more columns: a first column that is all integers is No. Then Last, First, and optional Team.
  - The first row is a header row when it contains words like "last", "first", "name", or "no". Skip it.
- Mapping selects let the user fix the detected columns: No, Last, First, Team, Ignore.
- Team names that do not exist are created.
- On confirm, ONE transaction with source 'roster' adds the students (No = the given value, or the next number).

**Teams card**
- One section per team: name, member count, and the member list (names are pii).
- Actions: rename, delete (members become "no team", after a confirm that mentions team scores), add members (a multi-select dialog of students not in the team), and remove a member.
- "Create teams…": a helper that auto-creates N empty teams named "Team 1..N".
- Unassigned students are listed under "No team".
- Team-size hint: the course template expects 7–8 per team (SE4351) or about 3 (SE6362). Show a muted note when a team is outside that range. It is informational only.

**Team scores card**
- A table with one row per team and one column per team-graded assessment, holding the team score.
- Editable in place. A simple numeric input commits on change or Enter, through transact.
- Override count badge per team ("1 override ◆", with names in a tooltip or an expandable list) and a "Remove override" action per override.

**`GT.ui.openStudent(studentId)`**
- Exported. Opens the student detail dialog (xwide). It holds:
  - Header: name (pii), No, team, and status.
  - Actions: edit, withdraw/reinstate.
  - Scores table: assessment, raw as entered, source (individual / team / ◆ override), weighted, flags (invalid, out of range, empty).
  - Total, letter, rank "x of N", percentile, and difference from the class average.
  - Attendance summary, when `GT.attendance` exists.
  - Notes: an editable textarea. It saves on blur through transact.
  - This student's history entries (newest first, up to 100).
  - A Print button that prints just this dialog. Add a print stylesheet in students.css that hides the rest.

## 6. Settings: `js/ui/settings.js` + `css/settings.css` (registers GT.views.settings)

Sections as cards, with a small in-page table of contents at the top.

**1. Needs confirmation**
- Lists `model.unconfirmedPlaceholders(course)`: label, note, a "Mark confirmed" button, and a link to the section.
- Confirmed items appear collapsed below, each with an "Undo confirmation" action.
- Confirming sets `course.placeholders[key] = { confirmed: true, confirmedAt: iso }` through transact.
- The tab badge count comes from app.js automatically.

**2. Course details**
- code, title, term, level (the same fields as the course menu), and a "Duplicate / Delete course" shortcut.

**3. Assessments and weights**
- An editable table. Columns:
  - Order (up and down buttons)
  - Name
  - Max score (with the maxScores badge)
  - Weight %
  - Team-graded (checkbox)
  - Category (select)
  - Actions
- A live "Total weight: 100%" line, green when it equals 100 and warn-colored when it does not.
- Changing the team-graded flag calls `model.convertAssessmentToTeam` or `model.convertAssessmentToIndividual` inside the transaction, after a confirm explaining what happens to existing scores.
- Add assessment.
- Delete assessment: confirm, mentioning how many students have scores. Scores for it are removed.
- **Split…:** for requirement A5 (the SE 4351 project split is unconfirmed). It splits one assessment into 2–4 parts:
  - The user enters part names and weights, which must sum to the original weight. A live check shows it.
  - The original becomes part 1: it keeps its id and scores, and is renamed and reweighted.
  - New parts are created empty with the same max and team flag.
  - Example prefill for Project I: "Questionnaire I" 2.5 plus "Project I (presentation + deliverable)" 7.5.
  - Show the projectSplit badge and its note here.
- Term Paper row (SE6362) shows the termPaperWeight badge.

**4. Grade calculation**
- Display decimals (0–4).
- Rounding mode, as a segmented control: none / nearest 0.01 / nearest integer. Badge: rounding.
- Curve: flat points added to the total, numeric. Badge: curve.
- Explain the formulas in one short paragraph: "Weighted = raw ÷ max × weight. Total = sum of weighted + curve, then rounded (if set). Empty scores count as 0."

**5. Letter scale**
- A table of letter and minimum total, editable. Badge: letterScale.
- Validation: mins strictly decreasing from top to bottom, the last row is F with min 0 (not editable), no duplicate letters.
- "Reset to default for this level".
- A live preview line: "A 93–100, A- 90–92.99, …".
- Passing letter: a select. Badge: passingLetter.

**6. Data & privacy**
- The storage backend in use.
- Last backup time.
- Buttons: Download backup, Restore, Delete all data (via `GT.app.actions`).
- The explanation that browser storage can be cleared (for example, clearing site data, private windows, or another browser profile), so backups matter.
- Privacy mode toggle.

**Behavior**
- All edits go through transact with meaningful labels.
- Numeric inputs commit on change (blur or Enter). Invalid input shows an inline error and is not saved.
- Do not re-render while an input has focus in a way that loses the typed text. Commit on change, and let the re-render restore focus to the same field by `data-field` key.

## 7. History: `js/ui/history-view.js` + `css/history.css` (registers GT.views.history)

- Newest first. Columns:
  - When: local date-time, with the ISO timestamp in the title
  - Student (pii) or Team
  - Field
  - Old → New
  - Kind (badge)
  - Source (badge: edit, paste, undo, …)
  - Note
  - Your note
- Filters:
  - Kind group: All / Grades (score, team-score, propagation, override, override-removed, late) / Students & teams / Settings / Attendance / Other
  - Source
  - Student select
  - Free-text search
  - Date range (from/to)
- "Add note" on any row calls `GT.store.annotateHistory(entryId, text)`. The dialog is prefilled with the existing note. This lets the TA record why a grade changed ("per instructor email, Oct 12").
- Export the visible entries as CSV: `GT.csv.stringify(GT.history.toRows(entries), { bom: true })`, downloaded as `grade-history-<code>-<stamp>.csv`.
- Render at most 300 rows, with a "Show more" button.
- Count line: "Showing 120 of 845 changes".
- Explain at the top, in one muted line, that the log is append-only: undo adds new entries and never erases old ones.

## 8. Store and model additions

- `GT.store.annotateHistory(entryId, text)` already exists. It sets `userNote` and `userNoteAt` on the entry.
- If you need new model helpers (for example `model.renumberByName(course)`, `model.deleteStudent(course, id)`, `model.deleteTeam(course, id)`, `model.splitAssessment(course, aid, parts)`), add them to js/core/model.js with unit tests in tests/model.test.js. Only the owner listed in the workflow may edit model.js; others must implement locally in their view file or report the need.
