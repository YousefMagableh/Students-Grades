# Stage 3 specification: Attendance (T1–T6)

Authoritative inputs are REQUEST.md, docs/REQUIREMENTS.md (T1–T6), and docs/DESIGN.md. The data shape `course.attendance` already exists (DESIGN §2). History logging for attendance already exists in js/core/history.js (STAGE2.md §2, "Attendance").

## 1. Core: `js/core/attendance.js` (GT.attendance), pure and UMD, plus `tests/attendance.test.js`

Definitions. These are also documented for the README.

- A session is **held** when at least one student (active or withdrawn) has a mark for it.
  - Sessions nobody has marked yet (future sessions, or a day roll was not taken) are ignored completely. They are not counted and they do not break streaks.
- A student's **recorded sessions** are the held sessions where that student has a mark: P, A, or E.
- A held session where this student has **no** mark is "unknown". It is not counted, and it **breaks** a streak (conservative: no warning based on guesses).
- `absent` = number of A marks.
- `excused` = number of E marks.
- `present` = number of P marks.
- `totalAbsences = absent + excused` (T3).
- `unexcused = absent` (T3).
- `absenceRate = 100 × totalAbsences / recorded` and `unexcusedRate = 100 × absent / recorded`. Both are `null` when recorded = 0.
- **Streak:** a maximal run of consecutive held sessions, in date order, where the student's mark counts as an absence.
  - 'A' always counts.
  - 'E' counts only when `excusedCountsTowardStreak` is true.
  - The default is **false** (DECISIONS.md item 6: at the user's request, allowed absences do not count against the student). When it is false, an 'E' **breaks** the streak.
  - Change the model default in js/core/model.js (`defaultAttendance` and normalizeCourse), and update the tests that assumed true.
  - 'P' and unknown also break it.
- `warning`:
  - `'fail'` when longestStreak ≥ failStreak (4). Text: "4 consecutive absences: syllabus says F".
  - `'drop'` when longestStreak ≥ dropStreak (3). Text: "3 consecutive absences: syllabus says one letter grade drop".
  - Otherwise `null`.
  - These are warnings only. **Nothing ever changes a grade** (T5).
- `overThreshold = unexcused > unexcusedThreshold` (T4, "above" the threshold).
- The user also asked for a limit on **total** absences, meaning allowed (excused) plus not-allowed (unexcused). Add the optional setting `attendance.totalAbsenceThreshold`: null means off, which is the default.
  - `overTotalThreshold = totalAbsences > totalAbsenceThreshold` when the setting is set.
  - It is shown like the unexcused threshold (highlighted, and listed in warnings as kind 'total-threshold').
  - It gets the same placeholder note as the unexcused threshold, because the syllabus mentions "a certain threshold" for total absences.
  - Add the setting to model.normalizeCourse (a non-negative whole number or null) and to the history diff (kind 'settings').
  - In the UI, use the words "Excused (allowed, instructor-approved)" and "Absent (not allowed, unexcused)".

Totals-only mode:

- `absent` and `excused` come from `attendance.totals[sid]`, and `recorded = totalsSessionsHeld`.
- Rates use that denominator, and are null when it is 0.
- Streaks and warnings are `null`, with `streaksAvailable: false`.

Off mode: `summary()` returns `null`.

API:

- `summary(course, studentId)` returns:
  `{ mode, recorded, present, absent, excused, totalAbsences, unexcused, absenceRate, unexcusedRate, longestStreak, currentStreak, streaks: [{ startDate, endDate, length, sessionIds }], streaksAvailable, warning, overThreshold }`.
  - `streaks` lists only runs of length ≥ 2, oldest first.
  - `currentStreak` is the run ending at the student's latest recorded session (0 if that session was not an absence).
- `heldSessions(course)` returns the sessions with at least one mark, in date order.
- `sessionCounts(course, sessionId)` returns `{ present, absent, excused, unmarked }`. It counts **active** students only.
- `courseSummary(course)` returns:
  `{ mode, held, total: sessions.length, byStudent: { sid: summary }, warnings: [{ studentId, kind: 'fail'|'drop'|'threshold', detail }] }`.
  Warnings cover active students only, sorted fail, then drop, then threshold, then name.
- `markLabel(m)` maps 'P' to 'Present', 'A' to 'Absent', 'E' to 'Excused', and anything else to ''.
- `nearestSessionIndex(course, isoDate)` returns the index of the session on or after isoDate, else the last session. It is used to jump to "today".
- `mergeSessions(existing, generated)` returns a new list sorted by date.
  - It keeps every existing session (id, label, and therefore its marks).
  - It adds generated dates that are not already present.
  - It never drops a session.

Mandatory tests (the user listed them): **consecutive-absence detection** and **per-session attendance rates**. Cover at least these:

- The 3-run gives 'drop' and the 4-run gives 'fail'.
- With excusedCountsTowardStreak false (the new default), an 'E' inside a run breaks it. With it set to true, the 'E' counts toward the run.
- A session nobody marked is skipped: it does not break the run and is not counted.
- A held session where this student is unmarked breaks the run and is not counted.
- Rates: 26 sessions, 20 held, a student with 18 P, 1 A, and 1 E gives recorded 20, totalAbsences 2, unexcused 1, absenceRate 10, unexcusedRate 5.
- Threshold: strictly greater than.
- Totals mode rates and null streaks.
- Off mode gives null.
- mergeSessions.
- nearestSessionIndex.
- Withdrawn students are excluded from sessionCounts and from warnings.

Also test that the Fall 2026 TR template gives 26 sessions (already covered in model tests; assert again here via `model.createCourse('SE4351').attendance.sessions`).

## 2. UI: `js/ui/attendance.js` + `css/attendance.css` (GT.views.attendance)

Add both files to index.html. Put the script after `js/ui/history-view.js` and before `js/app.js`, and put the stylesheet after css/history.css.

**Header.** The course code, then "Attendance". A mode selector (segmented) offers Per-session, Totals only, and Off.

- Include a one-line explanation of each mode.
- Changing the mode keeps all recorded data (records and totals). Switching back shows it again.
- SE 6362 starts Off. Show an empty state explaining that attendance is not tracked for this course this semester, with a "Turn on attendance (per session)" button.

### Per-session mode

1. **Toolbar**
   - Search.
   - Show-withdrawn toggle.
   - A "Jump to today" button, which scrolls to `nearestSessionIndex(today)`. Use the computer's local date.
   - "Sessions…", which opens the session manager.
   - A legend: P Present, A Absent, E Excused (instructor-approved), and blank for not recorded.

2. **Marking grid**
   - One row per student, in name order.
   - Sticky columns: No, Last, First. Names are pii.
   - One column per session. The header shows e.g. "Thu" over "Sep 3". A session nobody has marked is visually lighter.
   - Cell content is P, A, or E, colored:
     - P: neutral/success, subtle.
     - A: danger-soft background.
     - E: info-soft background.
   - Keyboard:
     - The arrow keys move between cells.
     - Typing `p`, `a`, or `e` sets the mark and moves down.
     - Space cycles blank → P → A → E → blank.
     - Delete/Backspace clears.
     - Shift+arrows selects a range, and P/A/E/Delete then apply to the whole range in ONE transaction.
   - Mouse: a click selects and a second click cycles; a right-click opens a menu with Present, Absent, Excused, and Clear.
   - Each session column header has a menu:
     - "Mark everyone without a mark as Present". This is ONE transaction, and it is the usual roll-call workflow.
     - "Clear this session".
     - "Edit date/label".
     - "Delete session". Confirm first, stating how many marks will be lost.
   - Right side sticky summary columns:
     - Absences (A+E)
     - Unexcused (A)
     - Excused
     - Absence rate
     - Unexcused rate
     - Longest streak
   - Warning chips per row:
     - `fail`: danger chip "4 in a row: F per syllabus (warning only)".
     - `drop`: warn chip "3 in a row: 1 letter drop (warning only)".
     - `overThreshold`: the row's Unexcused cell is highlighted, with the tooltip "Above the unexcused-absence threshold (N)".
   - Footer row: per-session counts for active students (P/A/E/unmarked).
   - Withdrawn rows are muted.
   - Performance: 59 × 26 cells must render in under 30 ms. Use one innerHTML string for the body, and delegated events.
   - Keep the active cell and scroll position across re-renders.

3. **Session manager** (dialog)
   - The list of sessions: date, weekday, label, and mark count.
   - Add a session (date input). Duplicate dates are allowed only with a label.
   - Edit the date or label.
   - Delete. Confirm first, with the mark count.
   - "Generate…" takes start, end, weekday checkboxes, and excluded dates (a comma- or line-separated list). It **merges** via `mergeSessions`, so existing sessions and their marks are never removed. It prefills the Fall 2026 TR pattern:
     - 2026-09-03 to 2026-12-08
     - Tue and Thu
     - excluding 2026-11-24 and 2026-11-26
   - Everything goes through transact.

4. **Roll call** (an improvement for use in class)
   - A "Take roll…" button picks a session (default: the nearest to today) and shows a large, keyboard-friendly list: one student per row with big P/A/E buttons.
   - Keys P/A/E set the mark and advance to the next student.
   - "Mark remaining present" sets everyone still unmarked to P.
   - Names are pii.
   - Each change is a transact, or batch one per student.

### Totals-only mode

- A table with columns No, Name, Absent (unexcused), Excused, Total absences, Absence rate, Unexcused rate.
- Absent and Excused are editable whole numbers ≥ 0, using `util.parseCount`. Invalid input is rejected with an inline error.
- A course-level "Sessions held so far" number is the denominator.
- The threshold highlight works the same as in per-session mode. Streak warnings show "n/a in totals mode".

### Settings card (all modes except off)

- **Unexcused-absence threshold** (whole number). Show the `unexcusedThreshold` placeholder badge with its note ("the syllabus mentions a threshold but does not state it").
- **Excused absences count toward a streak** (checkbox, default OFF per DECISIONS.md item 6; the original request defaulted to on, so the help text says the user changed it).
- **Consecutive-absence rule**: a drop at N (default 3) and F at M (default 4). Label it "from the syllabus", with no placeholder badge. Validate M > N ≥ 2.
- The explanatory text:
  - Warnings never change grades, because the policy has exceptions (e.g. medical or family reasons).
  - Attendance does not feed Class/Project Participation, which is entered manually in the Grades tab.

### Warnings card

- Lists every active student with a fail, drop, or threshold warning, from `courseSummary().warnings`.
- Each row shows the streak dates (e.g. "Oct 1, Oct 6, Oct 8") and a button that jumps to that student's row in the grid.
- Names are pii.

## 3. Integration with other views

These are small edits to files owned by other stages:

- **Grid** (js/ui/grid.js)
  - The attendance summary column already calls `GT.attendance.summary`. Verify that it now renders "3 (1 unexc.)" plus the warning icon and tooltip text.
  - Verify that it hides when the mode is off.
  - Verify that its column toggle works.
- **Student detail** (`GT.ui.openStudent` in js/ui/students.js): an attendance section with the summary numbers, streak dates, warnings, and the list of absences by date.
- **app.js VIEW_ORDER** already includes `attendance`.
- **History** already logs attendance (≤ 5 marks per transaction are logged per mark; more are summarized). Verify it works with "mark everyone present", which must produce 1 summary entry.

## 4. E2E

Extend tests/e2e/smoke.mjs with the following checks:

- SE 4351 has 26 sessions.
- Mark a 3-run and a 4-run for a student and see the drop and fail warnings.
- Warnings do not change the letter grade: `GT.store.results()` is unchanged.
- Rates equal the core summary.
- "Mark everyone present" logs one history entry.
- Switching the mode to totals and back keeps the records.
- SE 6362 starts off, and turning it on works.
