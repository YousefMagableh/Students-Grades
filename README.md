# Grade Tracker

An offline, local-only grade book for a teaching assistant. It replaces the Excel grade sheet for two courses: SE 4351 Requirements Engineering and SE 6362 Software Architectural Design.

- **Private by design:** there is no server, no account, and no internet use. Grades stay in this browser on this computer.
- **No install:** open `index.html` in Chrome, Edge, Firefox, or Safari.

> **Status (paused 2026-09-28):** grades, teams, final letters, attendance, and Excel/CSV export and import are done and tested.
> Still to come: the Statistics tab, the late-work dialog, the printable Summary tab, and the full guide to formulas and placeholders.
> See `docs/build/RESUME.md`.

## Open the app

1. Download the project once. On GitHub, open this repository, choose the branch that holds the app, press
   **Code → Download ZIP**, and unzip it into a folder that stays on your computer (for example
   `Documents\Grade Tracker`). Do not put it in a synced folder such as OneDrive or Dropbox.
2. Double-click `index.html`. It opens in your browser (Chrome or Edge) as a normal page. Everything runs
   from the files in that folder, with no internet connection needed.
3. Optional, on Windows: right-click `index.html` → **Send to → Desktop (create shortcut)** (on Windows 11, choose
   **Show more options** first). The app then opens
   from the desktop like any other program.

Always open the same `index.html` in the same browser: the data is saved in that browser.

## Back up your data

- Grades are stored in the browser's storage (IndexedDB) and saved automatically.
- Browser storage can be cleared, for example by "clear browsing data", a different browser or profile, or a private window.
  - Use **Backup** (header) or **Data → Download backup** regularly.
  - The header shows when the last backup was made.
  - A reminder appears when the last backup is older than 7 days.
- **Data → Restore from backup** replaces all current data with a backup file.
- Keep backup files private. This repository's `.gitignore` excludes `*.xlsx`, `*.csv`, and backup `*.json` files so real grades are never committed by accident.

## First steps

1. Pick a course in the switcher at the top left (**SE 4351** or **SE 6362**). The **⋯** button next to it adds,
   edits, duplicates or deletes a course. Each course has its own students, scores, attendance, teams and
   settings.
2. To try the app first, use **⋯ → Load sample data**. It creates fake students ("Student 01", "Student 02",
   …). When you are done trying, delete the course or load your real roster over it.
3. Add the real students in one of two ways, on your own computer:
   - **Paste roster** (Grades or Students & Teams tab): copy the name columns in Excel and paste them. A
     preview shows how each line will be read before anything is added.
   - **Import / Export → Import**: read the whole previous sheet (.xlsx or .csv). See *Export and import* below.
4. Create the teams in **Students & Teams**, then enter scores in **Grades**.

Real student data never leaves your computer. Do not paste it into chats, email it to yourself, or put
exported files inside this project folder.

## Entering grades

The **Grades** tab works like a spreadsheet: one row per student.

- Click a cell and type: the value replaces what was there. **Enter** saves and moves down, **Tab** moves
  right, the arrow keys move around, **Esc** cancels, **F2** edits without clearing.
- **Paste from Excel**: copy a block of cells in Excel, click the first cell here and press **Ctrl+V**.
- **Undo / Redo**: **Ctrl+Z** and **Ctrl+Y** (or the arrows at the top). One paste or one band of letters is
  one step.
- **Red** cell: the text is not a number (it counts as 0 until fixed). **Yellow** cell: the number is below
  0 or above the item's max (it is used as typed, so check it).
- **Search**, **Sort** (by name or by total, both directions), **Group by team**, **Show withdrawn**, and the
  **Columns** menu are in the toolbar.
- **Team scores**: typing in a team-graded cell (Project I or II) sets the score for the whole team. Use the
  cell menu (right-click, or **Shift+F10**) → **Override for this student only…** for an agreed unequal split.
- **Late work**: select a score and press **Ctrl+L** (or use the cell menu → **Late work…**). Enter the weeks
  late and tick **Penalty waived (pre-approved)** if it was approved. The cell then shows **L2** (2 weeks
  late, penalty applied) or **L2✓** (waived). For a team score, the late information applies to the team.
  Points per week (10 by default) are set in **Settings → Late work**, which also lists every late entry.
- **Withdrawn students**: **Students & Teams → Withdraw**. They are kept (greyed out), never deleted, and
  left out of the class average, rank, percentile and statistics.

## Final grades: finalize, then assign letters

The letter from the cutoffs is only a **suggestion** (the "Suggested" column). The instructor picks every
student's **Final letter** by hand, usually in bands after sorting by total. Once final letters are
assigned, they are the grades (the export uses them, and so will the statistics, added in a later stage).

1. Enter every score. **Class/Project Participation** is out of 5 (5 = full marks, worth 5% of the total)
   and is picked from a drop-down list: 5, 4.5, 4 … 0. Typing a value from the list also works; anything else
   is refused, so no typo can be stored. Each assessment's list can be turned on or off in **Settings**.
2. Optional: **Meeting view** (Grades tab) shows only the scores, Total, absences, participation, the
   suggested and final letters and the rank, in larger text, sorted by total. Final letter and Rank stay pinned at the right edge.
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

## Statistics

The **Statistics** tab updates live and counts **active students only** (withdrawn students are left out).

- **Class statistics** in the same layout as the university eLearning panel: Count, Minimum, Maximum, Range,
  Average, Median, Standard Deviation (sample), Variance, a status list and the grade distribution in 10-point
  bins. **Show statistics for** switches between the Total and any single assessment.
- **What do these words mean?** explains each term in plain words, using the class's own numbers.
- Quartiles with a box plot, the pass rate, a histogram, the letter-grade distribution (final letters, or the
  suggestions from the cutoffs), each assessment's average / median / min / max, the top and bottom five, and a
  summary per team.
- **What-if calculator**: pick a student, an assessment that is still empty, and a target letter. It shows the
  score needed on that assessment (on time), with every other score left as it is.
- **Cutoff planner** (for the grading meeting): every student's total is a dot on a line, with the cutoffs
  drawn over it and the largest gaps between students shaded. Change cutoffs in the *sandbox* and see who
  would change letter. Nothing is saved until you press **Apply cutoffs to Settings** (changes the suggested
  letters) or **Use these as final letters…** (writes the final letters, for students without one or for all;
  Ctrl+Z undoes it).
- **Borderline students**: who is within one point (adjustable) of the next letter.

## Printable summary

The **Summary** tab is a one-page-per-section report for the grading meeting: course details, weights and
settings (placeholders are marked †), the grade table sorted by name (withdrawn students last, marked W),
absences, the statistics, and lines for notes and signatures. Options above it choose whether to include
withdrawn students, raw and weighted scores, and **Hide names (use No only)** for a copy without names.
Press **Print…** and choose *Landscape* (or *Save as PDF*). Empty scores print as blank cells so participation can be written in
by hand during the meeting.

## How the numbers are calculated

Everything recalculates the moment a score changes, just like the formulas in the old Excel sheet. No
formula is ever typed by hand.

| What | Formula |
| --- | --- |
| Weighted points | score ÷ max score × weight. Example: Project I 94 out of 100, weight 10% → 9.4 |
| Late penalty | weeks late × points per week (10) × max ÷ 100, taken off the score **before** weighting; never below 0; none when *penalty waived* is ticked |
| Total | sum of the weighted points + curve (0 by default), then rounding (none by default) |
| Empty score | counts as 0; the Total shows a small *incomplete* mark until every weighted item has a score |
| Suggested letter | the highest letter whose cutoff the Total reaches (cutoffs in Settings) |
| Final letter | chosen by hand from a drop-down; once set, it is the grade used in exports, statistics and the summary |
| Rank | among active students by Total, highest first; equal totals share a rank (1, 2, 2, 4) |
| Percentile | share of the other active students with a lower Total: 100 × lower ÷ (active − 1) |
| Difference from average | Total − the class average of active students |

**Worked example** (the check the tests use): Project I 90, Project II 85, Test 1 80, Test 2 70,
Participation 0 → 90÷100×10 + 85÷100×20 + 80÷100×25 + 70÷100×40 + 0÷5×5 = 9 + 17 + 20 + 28 + 0 = **74.0**.

More details:

- **Rounding modes**: none, nearest 0.01, nearest whole number. Halves round away from zero, exactly like
  Excel's `ROUND`, so 81.025 becomes 81.03. Display decimals only change what is shown, never the value.
- **Team-graded items** (Project I and II): type the team score once in any member's cell and every member
  gets it. A **per-member override** (cell menu → *Override for this student only…*) gives one student a
  different score and shows a ◆ marker, because an unequal split needs the team's written agreement.
- **Withdrawn students** stay in the list (greyed out), in History and in exports with Status "Withdrawn", but
  they are left out of the class average, rank, percentile and every statistic.
- **Statistics** use active students only: standard deviation and variance are the *sample* versions
  (n − 1); quartiles use the same method as Excel's `QUARTILE.INC`; the grade distribution bins are those of
  the university eLearning panel (90 - 100, 80 - 89 … where 89.99 counts in 80 - 89). The **pass rate** counts
  students whose letter is at or above the passing letter set in Settings.

## Settings that still need confirmation

These defaults are **placeholders**. Each shows a yellow *needs confirmation* badge until you press **Mark
confirmed** in **Settings → Needs confirmation** (the Settings tab shows how many are left). Changing a value
never confirms it by itself.

| Setting | Default now |
| --- | --- |
| Letter-grade cutoffs, undergraduate (SE 4351) | A+ 97, A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 73, C- 70, D+ 67, D 63, D- 60, below 60 F |
| Letter-grade cutoffs, graduate (SE 6362) | A 93, A- 90, B+ 87, B 83, B- 80, C+ 77, C 70, below 70 F |
| Rounding of the total | none |
| Curve | 0 points |
| Late-work exceptions | 10 points per week; what counts as pre-approved is decided case by case (*penalty waived*) |
| Max scores | 100 for every item, except Class/Project Participation out of 5 |
| Project split | Project I 10% + Project II 20% (SE 4351's syllabus lists Questionnaire 5 + Presentation and Deliverable 25 inside the 30%; use **Split…** in Settings once confirmed) |
| Term Paper weight (SE 6362) | 0% |
| Unexcused-absence threshold | highlight above 3 (the optional total-absence threshold is off) |
| Passing grade for the pass rate | D- (undergraduate), C (graduate) |

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

## Change history

**History** lists every change to grades and settings, newest first: the student, the field, the old value,
the new value and the time. It includes team scores reaching each member, overrides, late work, final
letters, finalizing, imports and attendance. The log is **append-only**: Undo adds a new entry and never
erases an old one.

When the instructor asks for a grade change, make the change, then open **History** and use **Add note** on
that entry (for example "per instructor email, Oct 12"). Filters (grades, students, settings, attendance,
student, text, dates) and **Export CSV** are at the top.

## Privacy

- **Privacy** (top right) blurs every student name on screen; click a name to show it for 10 seconds. Use it
  when someone can see your screen. Printing is never blurred; use *Hide names* on the Summary tab instead.
- The page blocks all network connections (a Content-Security-Policy in `index.html`), so nothing can be
  sent anywhere, even by mistake.

## Keyboard shortcuts

Press **?** in the app (or **Help** in the status bar at the bottom) for the full list, grouped by where each
shortcut works. The main ones:

| Keys | Action |
| --- | --- |
| Arrows, Tab, Enter | move between cells; Enter saves and moves down |
| F2 / Esc | edit a cell without clearing it / cancel |
| Ctrl+C, Ctrl+V | copy and paste blocks of cells (works with Excel) |
| Ctrl+Z, Ctrl+Y | undo, redo |
| Shift+F10 or the menu key | cell menu (override, late work, details) |
| Ctrl+L | late work for the selected score |
| Alt+↓ | open the drop-down list of a cell (final letter, participation) |
| P, A, E, Space | attendance: Present, Absent, Excused, cycle |
| / | search students |
| Alt+1 … Alt+8 | switch tabs |

On a Mac, use Cmd instead of Ctrl.

## If something goes wrong

- **The app shows an empty course after I restored my computer or cleared my browser**: browser storage was
  cleared. Use **Data → Restore from backup** with your latest backup file.
- **A banner says saving is not possible**: the browser is in a private window or blocks storage. Open
  `index.html` in a normal window, and download a backup before closing the tab.
- **"Grade Tracker is also open in another tab"**: close one of them; two tabs overwrite each other's changes.
- **Excel export says the library could not be loaded**: keep the `vendor` folder next to `index.html`.
- **An old `.xls` file cannot be imported**: open it in Excel and use *Save As → Excel Workbook (.xlsx)*.

## For developers

- No build step. `index.html` loads classic scripts in order. `js/core/` holds the pure logic (model,
  calculations, history, attendance, statistics, export and import), which also runs in Node. `js/ui/` holds
  the views, `js/store.js` the state, undo and autosave, and `js/storage.js` IndexedDB and localStorage.
- `npm test` runs the unit tests (Node 22, no dependencies).
- `npm run test:e2e` runs the headless Chromium smoke test against `index.html` from disk. It needs Playwright,
  and it fails on any network request.
- `npm install && npm run vendor` refreshes `vendor/exceljs.min.js` (ExcelJS 4.4.0, MIT).
- `docs/DESIGN.md` is the module contract, `docs/REQUIREMENTS.md` the requirements with a traceability table,
  and `docs/build/` the original request, the decisions made during the build and the stage specifications.

## Limitations and what was not verified

- The automated browser tests run in **Chromium** only. The app uses standard web features and should work in
  current Edge, Firefox and Safari, but they were not tested here.
- The Excel formulas were checked with two independent formula evaluators and an ExcelJS round trip, not in
  Microsoft Excel itself. Excel recalculates them when the file opens.
- Printing was checked by generating PDFs in Chromium; the browser's own print dialog was not tested.
- UT Dallas's official grade scales could not be checked from the build environment. The letters come from the
  course request and stay editable in Settings.
