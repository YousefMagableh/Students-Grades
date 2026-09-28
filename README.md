# Grade Tracker

An offline, local-only grade book for a teaching assistant. It replaces the Excel grade sheet for two courses: SE 4351 Requirements Engineering and SE 6362 Software Architectural Design.

- **Private by design:** there is no server, no account, and no internet use. Grades stay in this browser on this computer.
- **No install:** open `index.html` in Chrome, Edge, Firefox, or Safari.

> This README is being completed stage by stage. The full guide to formulas, placeholders and statistics arrives with the final stage.

## Open the app

1. Download or clone this repository.
2. Double-click `index.html`. It opens in your browser as a normal page. Everything in the page runs from the local files.
3. Optional: make a desktop shortcut to `index.html` so it opens like any other program.

## Back up your data

- Grades are stored in the browser's storage (IndexedDB) and saved automatically.
- Browser storage can be cleared, for example by "clear browsing data", a different browser or profile, or a private window.
  - Use **Backup** (header) or **Data → Download backup** regularly.
  - The header shows when the last backup was made.
  - A reminder appears when the last backup is older than 7 days.
- **Data → Restore from backup** replaces all current data with a backup file.
- Keep backup files private. This repository's `.gitignore` excludes `*.xlsx`, `*.csv`, and backup `*.json` files so real grades are never committed by accident.

## Final grades: finalize, then assign letters

The letter from the cutoffs is only a **suggestion** (the "Suggested" column). The instructor picks every
student's **Final letter** by hand, usually in bands after sorting by total. Once final letters are
assigned, they are the grades (the export uses them, and so will the statistics, added in a later stage).

1. Enter every score. **Class/Project Participation** is out of 5 (5 = full marks, worth 5% of the total)
   and is picked from a drop-down list: 5, 4.5, 4 … 0. Typing a value from the list also works; anything else
   is refused, so no typo can be stored. Each assessment's list can be turned on or off in **Settings**.
2. Optional: **Meeting view** (Grades tab) shows only the scores, Total, absences, participation, the
   suggested and final letters and the rank, in larger text, sorted by total.
3. **Finalize scores…** (Grades tab, or Settings → Grading status) checks for missing or invalid scores,
   then locks the score cells so they cannot change by accident, and sorts by total, high to low.
   Participation is a score too: set it before finalizing, or unlock first.
4. Assign the letters in the **Final letter** column: click the first row of a band, Shift+click the last
   one, press Enter and choose the letter (or type it, for example `b+`). Every selected student gets it in
   one step (Ctrl+Z undoes the whole band). While sorted by total, a thin line marks where the letter changes.
   - A dot marks a final letter that differs from the suggestion; a warning icon marks a letter that is
     out of order with the totals (a lower total with a higher letter).
   - **Copy suggested → final** fills the empty final letters from the cutoffs in one step.
5. **Unlock scores…** on the banner makes the score cells editable again. Finalizing and unlocking are both
   logged in **History**, like every final-letter change.

Rows never jump while you edit: a sort is applied once, like in Excel. When the values no longer match
the order, **Order changed: re-sort** appears in the toolbar. Each score column's ⋯ menu can fill the empty
cells, set every active student to one value, or clear the column, each in one step you can undo.

## Attendance

Open the **Attendance** tab. Each course has its own mode, chosen at the top of the tab:

- **Per session** (SE 4351): mark each student **P** Present, **A** Absent (*not allowed, unexcused*) or
  **E** Excused (*allowed, instructor-approved*) for each class meeting.
- **Totals only**: type each student's number of unexcused and excused absences, and how many sessions were
  held so far. Only whole numbers (0 or more) are accepted.
- **Off** (SE 6362 by default): nothing is tracked. **Turn on attendance** switches it on at any time.
  Changing the mode never deletes anything: switching back shows the earlier marks again.

Taking roll in class:

- **Take roll…** shows one student per row with big P / A / E buttons. Press `P`, `A` or `E` on the keyboard
  and the next student is selected. **Mark remaining present** gives everyone still without a mark a P.
- In the grid, click a session's date for **Mark everyone without a mark as Present** (usually after marking
  the absent students), clear the session, edit its date or label, or delete it.
- In a cell: type `P`, `A` or `E` (the cursor moves down), Space cycles, Delete clears. Shift+arrows select
  several cells, and one key sets all of them. Everything can be undone with Ctrl+Z.
- **Sessions…** adds, edits and deletes class dates. **Generate…** fills a semester (for example every
  Tuesday and Thursday, skipping holidays) and never removes a session or its marks.

How the numbers are counted:

- A session counts as **held** once at least one student has a mark in it. Sessions nobody has marked yet
  (future dates, or a day the roll was not taken) are ignored.
- A student's **recorded sessions** are the held sessions where that student has a mark. A held session
  where the student has no mark is not counted (the student detail lists those dates).
- **Total absences** = unexcused + excused. **Absence rate** = total absences ÷ recorded sessions, and
  **unexcused rate** = unexcused absences ÷ recorded sessions.
- **Consecutive absences** (from the syllabus): 3 in a row means one letter grade drop, 4 in a row means F.
  Only **unexcused** absences make a run: an excused (allowed) absence breaks it. This is the default because
  you asked for it (allowed absences should not count against the student); the original request counted
  every absence. To count excused absences too, tick **Excused absences count toward a streak** in the
  Attendance settings. A present mark, or a held session without a mark, also breaks a run.
- **Unexcused-absence threshold**: students with **more than** this many unexcused absences are highlighted.
  The syllabus mentions a threshold without the number, so the value (3 for now) is marked *needs
  confirmation*.
- **Total-absence threshold** (optional, off by default): highlights students with more than this many
  absences in total (excused + unexcused). It also needs confirming.
- In totals-only mode the dates are unknown, so the consecutive-absence warnings are *n/a*.

The warnings are **warnings only**: nothing ever changes a grade automatically, because the policy has
exceptions (for example medical or family reasons). Attendance also never fills in Class/Project
Participation; the instructor sets it in the Grades tab.

Where the absences show up:

- **Grades tab**: three columns next to every student, *Excused (allowed)*, *Unexcused (not allowed)* and
  *Total absences*, also in the **Meeting view**. A warning icon on the Unexcused cell marks a streak or the
  threshold; hover it for the reason. The **Columns** menu hides or shows each one. They are hidden while
  attendance is off.
- **Student details** (the person icon beside a student's No in the Grades tab, right-click → *Open student
  details*, or *Details* in Students & Teams): the counts and rates, the warnings with their dates, and
  every absence by date, excused or unexcused.
- **Attendance tab**: the summary columns at the right of the grid, and a **Warnings** list with a button that
  jumps to the student's row.

## Export and import

Open the **Import / Export** tab. Files are made and read on this computer only; nothing is uploaded.

**Export** (for the instructor):

1. Choose a **preset**. The default, *Previous sheet layout*, has the columns of the previous TA's sheet:
   No, Last Name, First Name, the scores, the weighted scores ("Project I 10%" …), Total, Letter Grade, then
   Excused (allowed), Unexcused (not allowed), Total absences, and Status (withdrawn students are included and
   marked). *Names, total and letter* and *Everything* are also built in.
2. Tick, untick or reorder columns (arrow buttons, Alt+↑/↓, or drag). Columns that do not apply, such as
   absences while attendance is off, are greyed out with the reason. **Save as preset…** keeps your choice
   for this course (Rename and Delete work on your own presets; Ctrl+Z undoes them).
3. Choose the row order (by name or by No) and the extra sheets of the Excel file: *Settings* (weights,
   letter cutoffs, what is still to be confirmed; on by default) and *Change history* (off).
4. Read the **data check** (empty scores, participation not set yet, final letters missing, placeholders…).
   It never blocks the download.
5. **Download Excel (.xlsx)** or **Download CSV**. Files are named like `SE4351-grades-2026-12-10_1403.xlsx`.

In the Excel file the weighted scores, the Total and the letter are **real formulas**, so the instructor can
click a cell and see how it is calculated: weighted = score ÷ max × weight (with `MAX(0, score − penalty)` for
late work), Total = the sum of the weighted cells plus the curve, wrapped in `ROUND(…,10)` so a total exactly
on a cutoff gets the same letter as in the app (with the chosen rounding on top), and the letter a nested `IF`
over the cutoffs. Once any final letter is assigned, *Letter Grade* holds each student's final letter (or the
suggestion when a student has none) as a plain value; add *Suggested Letter (cutoffs)* for the formula. The
header row is frozen, has a filter, and the column groups are tinted like the old sheet. The CSV file has the
same columns, values only.

> **Exported files contain confidential grades.** Keep them on this computer, out of shared or synced folders
> (OneDrive, Google Drive, Dropbox, iCloud) and out of this project folder. Delete copies you no longer need.

**Import** (from an .xlsx or .csv file, for example the previous TA's sheet):

1. **Choose file.** Old `.xls` files cannot be read: open them in Excel and use *Save As → Excel Workbook
   (.xlsx)*, then import that file.
2. **Check the sheet**: the sheet and the header row are found automatically; a preview shows the first rows.
3. **Match columns**: every column is matched automatically (the previous TA's headers map exactly: "Final
   Project I" → Project I, "Project I 10%" → weighted Project I, converted back to a score, "No of Absence" →
   unexcused absences…). Change anything that is wrong, or set it to *Do not import*. Options: find students by
   name or by No, add missing students, keep or clear values for empty cells, replace scores already entered.
   - *Letter Grade* is imported as each student's **final letter**. If those letters were only suggestions,
     set the column to *Do not import*. (In an Excel file from Grade Tracker without final letters, the letter
     column holds formulas and is left out automatically.) Letters not in the course's scale are skipped.
   - When an absence column is matched and the course does not use *Totals only* attendance, the import
     offers to switch to it (ticked when attendance is off). Enter the number of sessions held afterwards in
     the Attendance tab to get the rates.
   - While the scores are **finalized**, score columns are shown but not imported (unlock them in the Grades
     tab first). Student details and final letters are still imported.
4. **Preview**: counts (updated, new, skipped, changes, overrides, blocked…), the first 50 changes, values to
   check and skipped rows with the reason. Nothing changes before you press **Import**.

The import is **one step**: a single Undo (Ctrl+Z) reverts all of it, and every change is logged in History.

## Development

- `npm test` runs the unit tests (Node 22, no dependencies).
- `npm run test:e2e` runs the headless Chromium smoke test. It needs Playwright, and it fails on any network request.
- Design notes are in `docs/DESIGN.md`, and the requirement list is in `docs/REQUIREMENTS.md`.
