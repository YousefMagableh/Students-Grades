# Stage 5 specification: Statistics (ST1–ST3), plus the cutoff planner and borderline list

The authoritative sources are REQUEST.md, docs/REQUIREMENTS.md (ST1–ST3), and the eLearning statistics panel screenshot, which REQUEST.md describes under "Context the user attached". Statistics use **active students only** (S2).

The user saw that the previous TA's letters did not follow the placeholder cutoffs: 83.4 was graded B while 83.65 was graded A. The instructor probably drew the lines from the class distribution. The user agreed to extra improvements, so this stage also adds a **cutoff planner** and a **borderline students** list.

## 1. Core: `js/core/stats.js` (GT.stats) + `tests/stats.test.js`

All functions are pure. They use `util.fix` for results and ignore `null` and non-finite values.

- `describe(values)` returns `{ count, min, max, range, mean, median, sd, variance, sdPopulation, variancePopulation, q1, q3, iqr }`.
  - `sd` and `variance` are the **sample** statistics (n − 1). Both are null when count < 2.
  - Every field is null when count = 0.
  - Quartiles use Excel's QUARTILE.INC method (linear interpolation, R type 7). The median equals QUARTILE.INC(…, 2).
- `bins10(values)` returns 12 bins in this exact order and with these exact labels, as on the eLearning panel:
  - 'Greater than 100'
  - '90 - 100'
  - '80 - 89'
  - '70 - 79'
  - '60 - 69'
  - '50 - 59'
  - '40 - 49'
  - '30 - 39'
  - '20 - 29'
  - '10 - 19'
  - '0 - 9'
  - 'Less than 0'

  Each bin is `{ label, lo, hi, count }`. The bin rules:
  - v > 100 goes to 'Greater than 100'.
  - 90 ≤ v ≤ 100 goes to '90 - 100'.
  - For k = 8 down to 0, 10k ≤ v < 10k + 10 goes to '10k - (10k+9)', so 89.99 lands in '80 - 89'.
  - v < 0 goes to 'Less than 0'.

  Document the rule in the UI tooltip.
- `histogram(values, width = 10, lo = 0, hi = 100)` returns generic bins for the chart. Values above hi go into the last bin, and values below lo go into the first. The flags say so.
- `statusDistribution(course, results)` returns `{ active, withdrawn, complete, incomplete, invalidEntries, overrides }`. This mirrors the "STATUS DISTRIBUTION" column. complete and incomplete count active students.
- `letterDistribution(course, results)` returns `[{ letter, min, count, pct }]` in scale order (active students only).
- `passRate(course, results)` returns `{ passing, total, pct, passingLetter }`. A student passes when their letter is at or above `settings.passingLetter` in the scale order. Use `model.passingLetterFor` for the fallback.
- `perAssessment(course, results)` returns one entry per assessment: `{ assessmentId, name, maxScore, weight, n, missing, invalid, mean, median, min, max, sd, meanPct }`. It uses numeric raw values of active students (the effective entry, so team scores count once per member). `meanPct` is mean ÷ max × 100.
- `perTeam(course, results)` returns one entry per team, plus `{ teamId: null, name: 'No team' }` when needed: `{ teamId, name, members, activeMembers, mean, min, max, teamScores: { aid: value }, overrides }`.
- `topBottom(course, results, n = 5)` returns `{ top: [...], bottom: [...] }`. Each item is `{ studentId, total, letter, rank }`. Ties are broken by name, and only active students are included.
- `borderline(course, results, within = 1)` returns active students whose `totalUnrounded` is within `within` points **below** the next higher letter's `calc.minTotalForLetter`. The result is `[{ studentId, total, letter, nextLetter, gap }]`, sorted by gap.
- `gaps(course, results, minGap = 1)` returns the natural breaks: consecutive sorted active totals whose difference is ≥ minGap, as `[{ below, above, gap }]`, sorted by gap descending.
- `simulate(course, results, scale)` returns the letter distribution and each student's letter under a hypothetical scale, without saving anything. It runs the scale through `model.normalizeLetterScale` and uses `calc.letterFor` with the student's `total`.
- What-if uses the existing `calc.neededScore(course, student, assessmentId, letter)`.

Tests cover:
- Known vectors for describe:
  - [46, 96, 75, …]
  - n = 1, where sd is null
  - QUARTILE.INC checked against hand-computed values
- bins10 edge values: 100, 90, 89.99, 0, −0.5, 100.5.
- The status, letter, and pass-rate counts, with withdrawn students excluded.
- perAssessment with an override and a team score.
- perTeam.
- topBottom ties.
- borderline in each rounding mode.
- gaps.
- simulate.

## 2. UI: `js/ui/stats.js` + `css/stats.css` (GT.views.stats, tab "Statistics")

Add both files to index.html, plus js/core/stats.js after attendance.js.

Charts are hand-written inline SVG, with no libraries (ST3). Color them with the CSS variables from css/base.css so that light and dark mode both work. Each chart needs:
- `role="img"`
- a `<title>` and a `<desc>`
- per-bar `<title>` tooltips
- a visually hidden data table, or a "Show as table" toggle

If a `dataviz` skill is available to you, load it before writing the chart code, and follow its palette and mark guidance, adapted to these CSS variables.

Layout, from top to bottom:

1. **eLearning-style panel** (ST1)
   - A card with three columns: "STATISTICS", "STATUS DISTRIBUTION", and "GRADE DISTRIBUTION". Headings are uppercase, small, and bold.
   - Each column is a clean two-column list with thin separators, as in the screenshot.
   - The Count value is shown as a small dark pill.
   - STATISTICS rows: Count, Minimum Value, Maximum Value, Range, Average, Median, Standard Deviation (sample, n − 1), and Variance (sample).
   - STATUS DISTRIBUTION rows: Active, Withdrawn (excluded), Complete, Incomplete (≥ 1 empty score), Invalid entries, and Overrides.
   - GRADE DISTRIBUTION: the 12 bins.
   - A **measure selector** above the panel offers "Total" (default) or any assessment's raw score. For an assessment, the bins use percent of max, and the label says so.
   - The panel shows the population it covers: "Active students only (n = 57)".
2. **Summary cards row**
   - Quartiles (Q1, median, Q3, IQR) with a small SVG box plot.
   - Pass rate, with the passingLetter placeholder badge.
   - Class average, median, and SD.
3. **Histogram**: SVG bars over the 10-point bins, with count labels and an axis. A toggle switches to 5-point bins.
4. **Letter-grade distribution**: SVG bar chart in scale order. Show counts and percentages, and add the letterScale placeholder badge with its note.
5. **Per-assessment table**: n / missing, mean, median, min, max, SD, and mean % for each assessment. Include a small inline bar for mean %.
6. **Top and bottom performers**: two small lists, top 5 and bottom 5, with rank, name (pii), total, and letter.
7. **Per-team summary**: a table of members, average total, min–max, team-graded team scores, and overrides, plus a horizontal bar chart of team averages.
8. **What-if calculator** (ST2)
   - Inputs: a student select (active students, pii in the option text is fine; privacy blur does not apply inside native selects, so show "No 12" followed by the name), an assessment select (default: the first empty one with weight > 0), and a target letter select.
   - Output: "Needs X / max on <assessment> (on time)". Say "Already reached with a 0" or "Not reachable (would need X > max)" when those apply.
   - Explain the assumptions in one line: the other scores stay as they are, and empty ones count as 0.
   - Also show a small table giving the score needed for every letter.
9. **Cutoff planner** (improvement)
   - A strip or dot plot of every active total along a 0–100 axis. It zooms to the data range with padding, and each dot has a `<title>` holding the name and total.
   - Vertical lines mark the current cutoffs, with letter labels.
   - The largest gaps (from `stats.gaps`) are shaded.
   - An editable **sandbox** copy of the scale sits beside it. Editing it updates, live, the lines, the simulated distribution, and the list of students whose letter would change (current → simulated).
   - "Apply to Settings" writes the sandbox scale into `course.settings.letterScale` in one transact, with a confirm. The letterScale placeholder stays unconfirmed until the user confirms it in Settings. Say so.
   - "Reset sandbox" restores the current scale.
10. **Borderline students** (improvement): students within N points (default 1, editable) below the next letter, showing the gap. Names are pii.

Empty states: when a course has no active students, show a friendly empty state.

Performance: recompute only on render. With 59 students, a render takes under 50 ms.

Print: the Statistics view should print cleanly. Add `@media print` rules in stats.css.

## 3. E2E

Extend tests/e2e/smoke.mjs:
- The statistics panel values equal `GT.stats.describe` of the active totals.
- A withdrawn student changes nothing in the panel.
- The bin counts sum to Count.
- The what-if result for one student reached through the UI equals `calc.neededScore`.
- Sandbox edits do not change the stored scale until "Apply" is clicked.
