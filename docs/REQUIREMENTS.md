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
  - Setting: whether excused absences count toward a streak. Default: yes.
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
