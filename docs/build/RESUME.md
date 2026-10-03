# Build status: complete

All six stages are built and verified on the branch `claude/grade-tracker-offline-app-mhwham`. The final integration pass ran on 2026-10-03.

## Final state

- Unit tests: **695 of 695 pass** (`npm test`). This includes the new `tests/repo.test.js`, which runs static checks for R1, R2, R8 and the version.
- Browser smoke test: **79 of 79 checks pass** (`npm run test:e2e`, headless Chromium from `file://`). It passed three runs in a row.
  - The run makes zero non-file network requests, and that includes the .xlsx export, which loads ExcelJS from `vendor/`.
  - The run raises no page errors and no console errors.

## Done

| Stage | What | Where the spec is |
| --- | --- | --- |
| 1 | Data model, calculations, sample data, unit tests | `docs/DESIGN.md` |
| 2 | Grades grid, students and teams, withdrawn students, change history, settings | `docs/build/STAGE2.md` |
| 2b | Finalize or unlock scores, manual final letters, participation out of 5, meeting view, stable sort | `docs/build/STAGE2B.md` |
| 3 | Attendance: per-session, totals-only or off; excused, unexcused and total columns; streak warnings; roll call | `docs/build/STAGE3.md` |
| 4 | Export (.xlsx with real formulas, CSV, presets, data check) and import (column mapping, previous-sheet headers) | `docs/build/STAGE4.md` |
| 5 | Statistics tab: eLearning panel, charts, per-assessment and per-team tables, what-if, cutoff planner, borderline list | `docs/build/STAGE5.md` |
| 6 | Late-work UI (Ctrl+L, badges, Settings card, Students column), printable Summary tab, polish, Help / About | `docs/build/STAGE6.md` |

The traceability table at the end of `docs/REQUIREMENTS.md` maps every requirement (R1–V3 and X1–X8) to the code that implements it and the test that covers it.

## Integration pass (2026-10-03)

- **Stage-4 open items, re-verified in the browser.**
  - V4R3-1: a letter typed into "Letter Grade" in an "Everything" export is imported, or reported when "Final Letter" disagrees. The core fix was correct. The three UI edits from its handoff were never applied, and are now in `js/ui/exchange.js`:
    - labels for the `lettersFromOtherColumn` and `lettersNotImported` counts;
    - `editedLetterCells` passed to `guessMapping`;
    - a step-3 note about letters typed into a letter column that is not read.
  - V4R3-2: the step-3 wording counts marked and typed letters apart. It was already correct.
  - Both now have smoke regressions.
- **Meeting view carry-over.** SE 6362 with attendance on was 78 px too wide at 1280 px. It now fits:
  - the name columns fit the names;
  - a withdrawn student shows a short "W" badge;
  - "Term Paper" may wrap.

  Final letter and Rank are also pinned on the right (sticky), so they stay visible with long names or a narrow window. Phones and print do not pin them.
- **Help / About** dialog, opened from the status bar. The shortcuts dialog was rewritten from the real key handlers and is now grouped by where each shortcut works.
- **Terminology**: "Overrides (◆)" in Statistics, "Per-member override" in Summary, "Class/Project Participation" in the grid messages, and no "dropped".
- **Bug fixed**: "Add course" with the SE 6362 template used to create an undergraduate course, because Level kept its default. The template now sets the level.
- **Docs**: `docs/DESIGN.md` now has sections 11–14, covering the Statistics view, the Summary view, the late-work UI, and the shell polish. Its sample-data, navigate `focus`, import and meeting-view sections are updated too.

## Still open

1. **Not verified, so list these in the README's limitations:**
   - Browsers other than Chromium. Only headless Chromium is automated.
   - Real Microsoft Excel recalculation. The formulas were checked with the mini evaluator in `tests/helpers/mini-excel.js` and the ExcelJS round trip, not in Excel itself. `fullCalcOnLoad` is set.
   - A real print dialog and a physical printer. The Summary was checked with Chromium's `page.pdf()` (Letter, landscape) and print-media emulation.
   - Screen readers, and a measured WCAG contrast audit. Roles, labels and focus handling are in place, but no assistive technology or contrast tool was run.
   - How long browser storage lasts. It depends on the browser's eviction policy. The app asks for persistent storage and reminds the TA to back up.

## How to work on it

1. Check out the branch above.
2. Run `npm install` (dev only: it fetches ExcelJS for `npm run vendor`).
3. Run `npm test` and `npm run test:e2e`.
4. Read `docs/build/REQUEST.md`, `docs/build/DECISIONS.md` and `docs/DESIGN.md`.
5. Keep the working rules:
   - Every change goes through `GT.store.transact`.
   - Every rendered name has the `pii` class.
   - Only classic scripts, no ES modules.
   - No network requests.
   - Fake data only.
