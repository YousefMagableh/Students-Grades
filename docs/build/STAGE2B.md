# Stage 2b: Finalize grades and assign final letters manually (requested by the user mid-build)

## The user's workflow (verbatim intent, translated from Arabic)

1. Enter all scores in alphabetical order (sorted by student name).
2. When every score is in, **finalize** the scores.
3. Sort by total, from the highest score to the lowest.
4. Assign the letter grades **manually**, choosing each student's letter from a **drop-down list** of the course's letters:
   - Undergraduate: A+, A, A-, B+, B, B-, C+, C, C-, D+, D, D-, F.
   - Graduate: A, A-, B+, B, B-, C+, C, F.

This matches the previous TA's sheet. There, 83.65 got an A and 83.4 got a B, so the instructor drew the letter lines by looking at the sorted totals rather than using fixed cutoffs. The cutoff-based letter therefore stays as a **suggestion**, and the manually chosen **final letter** is the grade that gets exported.

## Data model (js/core/model.js, normalizeCourse, tests)

- `Student.finalLetter: string | null` is the manually assigned final letter. The default is null.
  - normalizeCourse keeps a value only when it is a letter in the course's current letter scale.
  - If the scale changes later, a final letter that is no longer in the scale is kept, but flagged. `calc` reports `finalLetterValid: false` and the UI shows a warning. It is never silently dropped.
- `Course.finalized: null | { at: iso, note: string }`. When set, scores are locked in the UI (see below).
- New model helpers:
  - `setFinalLetter(course, studentId, letter|null)`
  - `setFinalLetters(course, [{ studentId, letter }])`
  - `copySuggestedToFinal(course, results, { onlyEmpty = true, activeOnly = true })`
  - `finalize(course, isoNow, note)`
  - `unfinalize(course)`

## Calculations (js/core/calc.js)

- `studentResult` keeps `letter` as the **suggested** letter from the cutoffs. It adds:
  - `finalLetter` (the stored value or null)
  - `finalLetterValid`
  - `effectiveLetter`: `finalLetter` if one is set, else `letter`
  - `letterSource`: 'manual' or 'cutoffs'
  - `letterDiffers`: true when a final letter is set and differs from the suggestion
- `computeCourse` adds `orderIssues`. It sorts active students by total, descending, and lists every pair where a student with a strictly lower total holds a strictly higher **final** letter (by scale order) than a student with a higher total, as `[{ higherTotalId, lowerTotalId }]`. Only students with final letters are compared.
  - Also add `letterSummary`: `{ assigned, unassigned (active without a final letter), manualDiffers }`.
- Statistics, the pass rate, the letter distribution, the export column "Letter Grade", and the summary view must use `effectiveLetter`. Document this: once final letters are assigned, they are the grades.

## Grid (js/ui/grid.js)

- The Letter column is renamed **"Suggested"**. It is read-only, is computed from the cutoffs, and keeps the placeholder badge.
- There is a new column **"Final letter"**:
  - Enter, F2, a double-click, or typing a letter opens a native `<select>` holding every letter in the course scale plus "(none)".
  - Typing a letter, such as "b+" or "A-", sets it directly when it matches a scale letter (case-insensitive). The keys commit the same way as score cells.
  - Delete or Backspace clears it.
  - When a range is selected in this column, choosing a letter from the cell menu ("Set final letter for selected rows ▸ A / A- / …") applies it to every selected row in ONE transaction. This works as a fill-down for bands of students when sorted by total.
  - Paste works: letter text is validated, and invalid letters are skipped and reported.
  - Visual markers:
    - A manual letter that differs from the suggestion gets a small dot, with the tooltip "Differs from the cutoff suggestion (B+)".
    - A letter involved in an `orderIssues` pair gets a warning icon, with the tooltip "Higher letter than a student with a higher total".
    - An invalid letter (not in the scale) is shown in red.
- Toolbar:
  - A **"Finalize scores…"** button. It opens a dialog listing a data check:
    - missing scores
    - invalid or out-of-range entries
    - unconfirmed placeholders
    - weights not summing to 100
    - students without a final letter (informational)

    On confirm it calls `model.finalize` in a transact, then switches the sort to Total high–low. Offer the checkbox "Copy the suggested letters into empty final letters" (default off).
  - When the course is finalized, show a banner in the grid: "Scores finalized on <date>. Score cells are locked; final letters stay editable." The banner has an **"Unlock scores…"** button that asks for confirmation and states the unlock is logged in the change history.
  - **"Copy suggested → final"**, which fills only the empty final letters of active students, in ONE transaction.
  - A letter summary chip: "Final letters: 52 of 57 assigned". It is warn-tinted until every active student has one.
- **Locked mode** (finalized):
  - Score cells, team scores, overrides, late work, name, No, and team cells are all read-only. Typing, paste, or Delete on them shows the toast "Scores are finalized. Unlock them to edit."
  - Final letters remain editable.
  - Settings that change totals (weights, max scores, rounding, curve, cutoffs, late points) show a notice: "Scores are finalized: changing this changes totals." They stay editable, because the TA may still need to fix weights, but the notice asks for a confirm.

## History (js/core/history.js)

- A change to `finalLetter` produces kind **'final-letter'**, field "Final letter", with the old and new values.
  - A bulk change of more than 10 letters in one transaction produces one summary entry, "Final letters: n changed", with the note listing up to 10 students by No.
- A change to `finalized` produces kind 'settings', field "Scores finalized", with the values 'no' and 'yes' (plus the date).
- Update `tests/history.test.js`.

## Export and summary (later stages must honor this)

- The exporter's "Letter Grade" column exports `effectiveLetter` as a static value when **any** final letter is set in the course. Otherwise it exports the IF formula.
- A new column, `suggestedLetter` → "Suggested Letter (cutoffs)", holds the IF formula.
- Add a `finalLetter` column → "Final Letter (manual)".
- The default preset keeps "Letter Grade" (effective).
- The statistics letter distribution uses the effective letters. It notes "n manual letters" and can toggle between the suggested and final letters.

## Tests

- **model:** setFinalLetter validation, copySuggestedToFinal, finalize/unfinalize, and normalizeCourse keeping or flagging letters.
- **calc:** effectiveLetter, letterDiffers, orderIssues (with ties, which never form a pair), and letterSummary.
- **history:** the final-letter kinds and the finalize entry.
- **e2e:**
  - Finalize, then sort by total descending.
  - Assign letters through the dropdown and through a range.
  - Locked score cells reject edits.
  - Unlock works.
  - The history holds the entries.

## Additions from the user's later screenshots (the previous TA's real workflow)

The later screenshots show this sequence:

1. The totals exist, but the letters are empty.
2. The "Class Participation 5%" column is filled with the same value for everyone at the end: 5, meaning full marks, typed straight in as points out of 5.
3. One grade is changed on request: Project I goes from 94 to 100, and the total is recalculated.
4. Excel's "Sort Largest to Smallest" is applied to Total.
5. Letters are typed by hand in **bands**: the top 4 get A, the next 3 get B, and the rest get C. In a later version: A for 88.4–91.65, A- for 83.75–86.35, and B+ for 71.9–81.4.

Implement these in addition to the features above:

- **Band assignment:** when a range is selected in the Final letter column, typing a letter or choosing one in the dropdown applies it to **every selected row** in ONE transaction. Shift+Arrow and Shift+Click extend the selection, as in the rest of the grid. This is the main way to assign letters.
- **Column fill:** each raw-score column header gets a small menu (a click on the header's ⋯ button, or Shift+F10 on a header cell) with these items:
  - "Fill empty cells of active students with…"
  - "Set every active student to…" (confirm first)
  - "Clear column…" (confirm first)
  Each item is ONE transaction. Team-graded columns write team scores.
- **Band boundaries:** while the grid is sorted by Total, high to low, draw a thin horizontal rule between consecutive rows whose final letters differ. The bands then read at a glance, like the old sheet. It must be visible in both themes.
- **Participation max score:** the old sheet entered participation as points out of 5 (5 = full). Our default max is 100 (per REQUEST.md), so typing 5 would mean 5/100. The participation column header must show "max 100" clearly. The user is being asked whether the default should be 5; follow the decision recorded in docs/build/DECISIONS.md if it exists.

## Further additions (DECISIONS.md items 5-7)

- **Stable sort (DECISIONS 7):**
  - The grid keeps a row-order snapshot (student ids) that is recomputed only when:
    - the user picks a sort, or clicks "Re-sort";
    - students are added or removed;
    - the search or filter changes;
    - grouping is toggled.
  - Edits to scores, participation or letters never reorder rows.
  - When the snapshot order differs from the current sort order, show a small toolbar button "Order changed: re-sort" (accent). This matters most in the meeting, where participation edits change totals.
- **Meeting view:** a toolbar toggle "Meeting view". It must be keyboard-reachable, and it is persisted in gridPrefs.
  - It shows only these columns: No, Last, First, one raw column per assessment, Total, Excused (allowed), Unexcused (not allowed), Total absences, Participation (editable, max 5), Suggested letter, Final letter (dropdown), and Rank.
  - It hides the weighted columns, percentile and ±avg.
  - It sorts by Total, high to low.
  - It uses a slightly larger row height and font, so a second person can read the screen.
  - The participation cells and the Final letter cells are highlighted as "to fill in the meeting".
- **Absence columns in the grid (DECISIONS 6):**
  - The grid's attendance summary becomes three columns when attendance is not off:
    - "Excused (allowed)"
    - "Unexcused (not allowed)"
    - "Total absences"
  - They come from `GT.attendance.summary` (fields `excused`, `unexcused`, `totalAbsences`).
  - Streak and threshold warnings show as an icon with a tooltip on the Unexcused cell.
  - The columns toggle in the Columns menu (all shown by default).

## Drop-down cells (DECISIONS.md item 8)

- Add an optional assessment property `choices`. It is either `null` (free numeric entry, the default) or `{ step: number }`. With `{ step }`, the cell is a drop-down of the values max, max − step, …, 0, plus "(empty)".
  - The participation assessment (category 'participation') defaults to `choices: { step: 0.5 }` with max 5 in every template.
  - normalizeCourse keeps `choices` only when step > 0 and max/step ≤ 200. Otherwise it drops it.
  - Settings shows a toggle per assessment, "Drop-down list (step …)", so the TA can turn it on or off.
- In the grid, a choices cell opens a native `<select>` on Enter, F2, double-click or Alt+Down.
  - Typing a number that is on the list (for example "4.5") sets it directly.
  - Typing any other value shows the toast "Choose a value from the list (0–5 in steps of 0.5)". Nothing is stored in that case: no invalid text entry for choices cells.
  - Paste into choices cells is validated the same way. Invalid values are skipped and reported in the paste toast.
  - Range selection plus choosing a value applies it to every selected row (ONE transaction), exactly like the final letter.
- Values imported or restored that are not on the list are kept (no data loss). They are shown with the out-of-range/invalid highlight and the tooltip "Not one of the list values".
