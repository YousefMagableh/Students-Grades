# Original request from the user (verbatim)

Build a local-only, offline web app called "Grade Tracker" in this repository. I am a graduate teaching assistant (TA) and I grade two courses this semester. Today I keep grades in Excel. I want a polished, interactive replacement that runs only on my own computer, because student grades are confidential.
HARD CONSTRAINTS

* Static site only: index.html plus local CSS and JS. No backend, no accounts, no required build step. It must work offline by opening index.html.
* Zero network requests at runtime: no CDN links, no web fonts, no analytics, no external images. If a library is needed (for example for Excel export), install it during the build and commit the browser-ready file into a vendor folder.
* Data lives only in the browser on my computer (IndexedDB or localStorage), autosaved. Provide Backup (export JSON), Restore (import JSON), a visible "last backup" indicator with a reminder when the last backup is older than 7 days, and a "Delete all data" button with confirmation.
* Do not deploy or publish anything (no GitHub Pages, no hosting).
* Use fake data only in this repository, with obviously fake names such as "Student 01". Add a .gitignore that excludes *.xlsx, *.csv, and backup *.json files so real exports are never committed by accident. I will load real data locally after I download the project.

COURSES (two, each fully independent: students, scores, attendance, teams, settings)

1. SE 4351 - Requirements Engineering (undergraduate). Sample data: 59 fake students in teams of 7 to 8.
2. SE 6362 - Software Architectural Design (graduate). Sample data: 10 fake students in teams of about 3.
Provide a course switcher and add, rename, duplicate, and delete course. Sample data is created by a "Load sample data" button, not hard-wired.

ASSESSMENTS AND WEIGHTS (per course, editable, recalculated instantly)

* Defaults for both courses, total 100%: Project I 10% (team-graded), Project II 20% (team-graded), Test 1 25%, Test 2 40%, Class/Project Participation 5% (entered manually per student).
* Each assessment has: name, max score (default 100), weight %, and a team-graded flag. Show a visible warning when weights do not sum to 100.
* SE 6362 also gets an optional "Term Paper" assessment with weight 0 (the syllabus describes it but gives no weight).
* The SE 4351 project split is not confirmed with the instructor (the syllabus lists Questionnaires 5 plus Presentation and Deliverable 25 inside the 30% Project). Keep the defaults above and make it easy to split or rename project items later.

CALCULATIONS (like Excel formulas, update on every edit)

* Weighted points = raw score / max score x weight. Total = sum of weighted points.
* An empty score counts as 0 in the total, with a subtle "incomplete" indicator.
* Rounding and curve are not specified by the instructor. Settings: display decimals, rounding mode (none, nearest 0.01, nearest integer), and an optional flat curve added to the total. Defaults: no rounding, no curve.
* Late work: 10 points are deducted per week late (on a 100-point score, scaled proportionally if max differs), unless pre-approved. Per score: optional "weeks late" and a "penalty waived" checkbox. Points per week is a per-course setting. The penalty applies before weighting and never goes below 0.
* Team-graded assessments: I enter the team score once and it propagates to every member, unless I set a per-member override (shown with a marker, since an unequal split needs the team's written agreement).
* Letter grade from the total using the course's letter scale with editable cutoffs:
   * SE 4351 (undergraduate): A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, F.
   * SE 6362 (graduate): only A, A-, B+, B, B-, C+, C, F.
   * The official cutoffs are not known yet. Use clearly labeled placeholders: 97, 93, 90, 87, 83, 80, 77, 73, 70, 67, 63, 60 for the undergraduate scale, and 93, 90, 87, 83, 80, 77, 70 for the graduate scale. Show a yellow "needs confirmation" badge on these and on every other placeholder setting (rounding, late-work exceptions, max scores, project split) until I mark it confirmed.
* Rank and percentile among active students, and difference from the class average.

STUDENTS

* Fields: No, Last Name, First Name, Team, Status (active or withdrawn), notes.
* Withdrawn students are never deleted. They are greyed out, kept in history and exports (with a Status column), and excluded from statistics, rank, percentile, and class average. A filter shows or hides them.
* Quick roster paste: paste a block of names copied from Excel.

GRID (Excel-like, one row per student)

* Edit in place with Tab, Enter, and arrow-key navigation. Paste a block copied from Excel. Undo and redo. Search box.
* Columns: No, Last Name, First Name, Team, raw scores, weighted scores, Total, Letter Grade, Rank, attendance summary.
* Sort by name (last name, then first name) and by grade (total), ascending and descending. Default is by name. Also group by team.
* Validate input: highlight non-numeric and out-of-range scores.
* Change history panel: log every grade edit (student, field, old value, new value, timestamp), including team propagation and overrides, because my professor sometimes asks me to change a grade.

ATTENDANCE (per-course mode: per-session, totals-only, or off)

* SE 4351: per-session. Sessions are Tuesdays and Thursdays from Sep 3 to Dec 8, 2026, excluding Nov 24 and Nov 26 (26 sessions), as an editable list. Mark each student per session as Present, Absent, or Excused (excused means the instructor approved the absence).
* SE 6362: attendance is not tracked this semester, so default to off, but allow turning it on.
* Total absences = absent + excused. Unexcused = absent. Show absence rate and unexcused rate as a percentage of recorded sessions. Highlight students above a configurable unexcused-absence threshold (the syllabus mentions a threshold but does not state it).
* Syllabus rule: 3 consecutive absences mean one letter grade drop, and 4 consecutive absences mean F. Show these as warnings only and never change a grade automatically, because the policy has exceptions. Setting: whether excused absences count toward a streak (default: all absences count).
* Attendance does not feed participation automatically. Participation is entered manually.

STATISTICS (per course, live, active students only)

* In the same style as the university eLearning statistics panel: Count, Minimum, Maximum, Range, Average, Median, Standard Deviation (sample, labeled), Variance, and a grade distribution in 10-point bins (90-100, 80-89, and so on).
* Plus: quartiles, pass rate, letter-grade distribution, per-assessment average, median, min, and max, a histogram, top and bottom performers, a per-team summary, and a what-if calculator (the score needed on a remaining assessment to reach a target letter grade).
* Draw charts with plain SVG or canvas, no libraries.

EXPORT AND IMPORT

* "Download Excel (.xlsx)" for the current course, plus CSV. There is no instructor template yet, so add a column picker with reorderable columns and saved presets. The default preset mirrors my previous sheet: No, Last Name, First Name, raw scores, weighted scores, Total, Letter Grade, absences. Use real Excel formulas for weighted scores, total, and letter grade where possible so the instructor can inspect them. Freeze the header row, set sensible column widths, and include a Status column.
* Import from .xlsx or .csv with column mapping.

DESIGN

* Professional, clean, modern, responsive. Light and dark mode, good typography, keyboard-friendly, and a printable summary view. English interface.
* A "Privacy mode" toggle that blurs student names (click to reveal) for when someone can see my screen.

PROCESS

* First write a short plan. Then build in stages and commit after each. I may run out of budget, so keep this order: (1) data model and calculations with automated tests, (2) grid, teams, withdrawn students, and change history, (3) attendance, (4) export and import, (5) statistics, (6) late-work rule and polish.
* Tests must cover: Project I 90, Project II 85, Test 1 80, Test 2 70, Participation 0 gives a total of 74.0; team propagation with a per-member override; a withdrawn student excluded from average and rank; both letter scales; consecutive-absence detection; and per-session attendance rates.
* Add a README explaining how to open the app, backup and restore, how each formula works, and the list of placeholder settings that still need confirmation. Note that browser storage can be cleared, so backups matter.
* Verify by running the tests and, if possible, by opening the app in a headless browser. If you run out of budget, stop at a stage boundary with everything committed and passing. Report anything you could not verify.

## Context the user attached
- Screenshots of the TA's previous Excel sheet (FinalGradeSE6361SortedbyName.xls): columns No | Last Name | First Name | Final Project I | Final Project II | Test 1 | Test 2 | Project I 10% | Project II 20% | Test 1 25% | Test 2 40% | Class Participation 5% | Total | Letter Grade | (blank) | No of Absence. Sorted by name; No matches name order. Weighted columns are raw x weight (e.g. 94 -> 9.4 for 10%). Colored column groups (green Project I, orange Project II, blue Test 1, pink Test 2).
- Screenshot of the university eLearning statistics panel: three columns "STATISTICS" (Count, Minimum Value, Maximum Value, Range, Average, Median, Standard Deviation, Variance), "STATUS DISTRIBUTION" (Null, In Progress, Needs Grading, Exempt), "GRADE DISTRIBUTION" (Greater than 100, 90 - 100, 80 - 89, 70 - 79, 60 - 69, 50 - 59, 40 - 49, 30 - 39, 20 - 29, 10 - 19, 0 - 9, Less than 0), each a clean two-column list with thin separators, uppercase small headings.
- Syllabus excerpts are in docs/REQUIREMENTS.md (bottom section).
