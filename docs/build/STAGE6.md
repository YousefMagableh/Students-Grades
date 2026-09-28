# Stage 6 specification: Late-work rule (K4) and polish (D1, V2, V3)

The authoritative requirements are in REQUEST.md and docs/REQUIREMENTS.md: K4, D1, D2, V1–V3, R1, and R2.

## 1. Late-work rule (K4)

The calculation already exists in core:
- `calc.latePenalty`
- the `penalty` and `adjusted` values in `calc.scoreDetail`
- the ScoreEntry fields `weeksLate` and `waived`
- `model.withLate`
- the history kind 'late'

The exporter formula `MAX(0,R-P)/M*W` from stage 4 also exists.

This stage adds the UI and makes the late rule visible everywhere.

### Grid (js/ui/grid.js)

- Add a cell menu item **"Late work…"** through `GT.gridCellMenuExtensions`, or directly in grid.js. It appears on every raw score cell.
  - It opens a dialog showing:
    - the assessment and the student (the student No in the title, the name in a `pii` element)
    - where the entry lives: team score, override, or individual
    - **Weeks late**: a whole number ≥ 0, parsed with `util.parseCount`
    - **Penalty waived (pre-approved)**: a checkbox
    - a live preview: "Raw 85 − 20 (2 weeks × 10 points) = 65 → weighted 6.5"
  - Save goes through transact using `model.withLate`.
  - For a team-graded cell whose student has no override, the late info goes on the **team entry**, because the team submitted late, and it propagates. The dialog says so. For an override or individual cell, the late info goes on that entry.
  - Keyboard: Shift+F10 opens the menu. Add a direct shortcut **Ctrl+L** (Cmd+L on Mac) that opens "Late work…" for the active cell. Prevent the browser default only while the grid is active.
- The raw cell gets a small badge:
  - "L2" means 2 weeks late with the penalty applied (warn tint).
  - "L2✓" means waived (muted), with a strikethrough on the L.
  - The tooltip gives the penalty and the adjusted score.
- The weighted cell uses the adjusted score, which it already does through calc. Its tooltip shows "adjusted after late penalty".
- The legend line gains the late marker.

### Settings (js/ui/settings.js)

- Add a **Late work** card:
  - "Points deducted per week late" (`settings.latePointsPerWeek`, default 10, ≥ 0).
  - The lateWork placeholder badge and its note.
  - An explanation: "Deducted from the raw score before weighting: weeks × points per week, scaled by max ÷ 100 when the max is not 100. Never below 0. Tick 'Penalty waived' for pre-approved late work."
- Add a list of all late entries in the course (student or team, assessment, weeks, waived, penalty), with links that jump to the Grades cell.

### Student detail and students view

Show a late column (weeks and waived) and the penalty.

### Export (js/core/exporter.js)

- Verify that the weighted formula includes the penalty, and that the cell note reads "<n> week(s) late, −P points" or "penalty waived".
- The `late:<aid>` column exports the weeks, with the value "waived" when the penalty is waived.
- Import: the `late:<aid>` target sets weeksLate. A value of "waived" sets waived.

### Sample data (js/core/sample.js)

- Add exactly two late cases per dataset:
  - SE4351-like: one Test 1 entry 1 week late and not waived; one team's Project I 1 week late and waived (pre-approved).
  - SE6362-like: similar.
- Use a new PRNG stream, so existing values stay unchanged.
- Update the sample tests accordingly.

### Tests

The late calc tests already exist. Add:
- a history test for late changes on a team entry, with propagation of the adjusted value
- an exporter formula test with a late entry, with and without waived
- an e2e test: set 1 week late through the dialog; the total drops by weight × 10 / 100; waive it, and the total is restored; undo works; the history has 'late' entries

## 2. Printable summary view: `js/ui/summary.js` + `css/summary.css` (GT.views.summary, tab "Summary")

- A clean, print-first course summary with these parts:
  - **Header:** course code, title, term, and the generated date and time.
  - A line naming what is still unconfirmed, for example: "Letter cutoffs are placeholders (not confirmed)".
  - **Weights table:** assessment, max, weight, and team-graded flag, plus the grade settings (rounding, curve, late rule).
  - **Grade table:** No, Last Name, First Name, Team, one raw column per assessment, Total, Letter, Rank, and Absences (when attendance is on), sorted by name. Withdrawn students are included and marked "W".
  - **Statistics summary:** count, mean, median, SD (sample), min, max, the letter distribution, and the pass rate.
  - **Signature/notes area:** blank lines for the instructor.
- Options, shown on screen and hidden in print:
  - Include withdrawn students (on).
  - Include raw scores (on) and weighted scores (off).
  - **Hide names (use No only)**, for printing or sharing without names.
  - Paper orientation hint: landscape recommended.
  - A **Print** button that calls `window.print()`.
- `@media print` rules:
  - Hide the app chrome (base.css already hides topbar, tabs, banners, and statusbar).
  - Use a white background, 10–11px text, and table borders.
  - Repeat the table header on each page (`thead { display: table-header-group }`).
  - Avoid breaking rows across pages.
  - Privacy blur never applies in print.

## 3. Polish pass (D1)

The previous stages' reviewers may already have covered part of this.

**Responsive:** at a 390px width, every view is usable. The header wraps, tables scroll inside their wrappers, and dialogs fit the screen.

**Keyboard:**
- Every interactive element is reachable, and focus is visible.
- Dialogs trap focus. Esc closes them, and focus returns to the element that opened them.
- Menus support arrow keys.
- The shortcuts dialog lists every shortcut, including Ctrl+L and the attendance keys.

**Accessibility:**
- Buttons have labels.
- Icons are `aria-hidden`.
- Colour is never the only signal: invalid and out-of-range cells also carry icons or text in their tooltips.
- Contrast is at least AA in both themes.

**Empty states** are friendly in every view, with a no-students state and an attendance-off state.

**Help / About dialog**, reachable from the status bar:
- What the app is.
- That it works offline and all data stays in this browser.
- Where the data is stored.
- A backup reminder.
- Version 1.0.0.
- A link to the README (a relative `README.md` link that opens the local file).

**Zero network (R2):** the e2e test asserts zero non-file requests across the whole run, including xlsx export (which lazy-loads ExcelJS from `vendor/`).

**Consistency:** labels, capitalization, and terminology match across views. Use "Class/Project Participation" consistently, "Withdrawn" rather than "Dropped", "Override" (◆), and "Team score".

## 4. README.md (V2): full rewrite

The README must cover:
1. What it is, and privacy: offline, and no data leaves the computer.
2. **How to open it:** download or clone the project, then double-click `index.html`. Chrome, Edge, Firefox, and Safari are supported. Only Chromium is covered by the automated test. No install and no server are needed.
3. **First steps:** switch courses, Load sample data (fake), then delete it and paste the real roster or import from Excel.
4. **Backup and restore:**
   - Why backups matter: browser storage can be cleared by clearing site data or by using another browser, profile, or private window.
   - The last-backup indicator and the 7-day reminder.
   - How to restore.
   - Keep backup files private and out of the repository; the .gitignore covers them.
5. **How each formula works**, with a worked example:
   - The 74.0 example.
   - Weighted, total, curve, and rounding modes, including Excel ROUND parity.
   - Letter grades, with both placeholder scales.
   - The late-work penalty and its scaling.
   - Team propagation and overrides.
   - The incomplete indicator.
   - Rank (competition ranking), percentile (the exact formula), and difference from average.
   - Attendance definitions: held, recorded, rates, streak rules, the threshold, and that nothing ever changes a grade automatically.
   - Statistics definitions: sample SD, QUARTILE.INC, and the bin rules.
   - Pass rate.
6. **Placeholder settings that still need confirmation**, as an exact list with defaults:
   - letter cutoffs for both scales
   - rounding
   - curve
   - late-work exceptions
   - max scores
   - project split (SE 4351: Questionnaire 5 + Presentation and Deliverable 25)
   - Term Paper weight (SE 6362)
   - unexcused-absence threshold
   - passing letter

   Also explain how to confirm each one in the app.
7. **Excel export and import:**
   - the presets
   - the formulas used in the sheet
   - the Settings sheet
   - how to import the old .xls: save it as .xlsx first
   - the column mapping
8. **Keyboard shortcuts.**
9. **Change history:** what is logged, undo semantics, and notes.
10. **Project structure and development:**
    - running `npm test` and `npm run test:e2e`
    - refreshing the vendored ExcelJS with `npm run vendor`
    - the data model docs in docs/
11. **Limitations and what was not verified:** browsers other than Chromium, and real Excel recalculation (formulas were checked with a mini evaluator and the ExcelJS round trip, not in Microsoft Excel itself). Fill in the actual list after the final verification.

Also update docs/DESIGN.md so it matches the final code, and tick off docs/REQUIREMENTS.md with where each requirement is implemented and tested. A short traceability table at the end of REQUIREMENTS.md is enough.

## 5. Final verification (V3)

Run all of the following:
- `npm test`
- `node tests/e2e/smoke.mjs`: covers all stages, with zero network requests
- screenshots of every view in light and dark mode, at 1440 and 390 widths, reviewed
- the print preview of the Summary tab, using `page.pdf()` in Chromium, reviewed

List anything that could not be verified.

## Carry-over from earlier stages

- Stage 3 found a minor problem in the Meeting view for SE 6362 with attendance on and a width of 1280px. The table is 57px wider than the area, so Final letter is cut off and Rank is off-screen until you scroll sideways. Make the meeting column widths fit the available width. Alternatively, pin Final letter and Rank as sticky columns on the right in the meeting view.
