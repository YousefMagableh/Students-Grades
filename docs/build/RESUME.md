# Resume here: build status and next steps

Paused at the TA's request on 2026-09-28, 3:25 PM Dallas time (20:25 UTC), at a clean stage boundary. Every stage below is committed and pushed on the branch `claude/grade-tracker-offline-app-mhwham`.

## State at pause

- Unit tests: **631 of 631 pass** (`npm test`).
- Browser smoke test: **55 of 55 checks pass** (`npm run test:e2e`). This includes zero network requests from `file://`.

## Done

| Stage | What | Where the spec is |
| --- | --- | --- |
| 1 | Data model, calculations, sample data, unit tests | `docs/DESIGN.md` |
| 2 | Grades grid, students and teams, withdrawn students, change history, settings | `docs/build/STAGE2.md` |
| 2b | Finalize or unlock scores, manual final letters (drop-down, bands), participation out of 5 (drop-down), meeting view, stable sort | `docs/build/STAGE2B.md` |
| 3 | Attendance: per-session, totals-only or off; excused, unexcused and total columns; streak warnings; roll call | `docs/build/STAGE3.md` |
| 4 | Export (.xlsx with real formulas, CSV, column presets, data check) and import (.xlsx or .csv, column mapping, previous-sheet headers) | `docs/build/STAGE4.md`, see its Addendum |

The user's original request is in `docs/build/REQUEST.md`. The decisions made during the build are in `docs/build/DECISIONS.md`, and they override the request where the two differ.

## Still to do

1. **Stage 5: Statistics.** Spec: `docs/build/STAGE5.md`. It covers:
   - the eLearning-style panel, quartiles, pass rate, letter distribution, per-assessment and per-team tables
   - the histogram, top and bottom performers, and the what-if calculator
   - the cutoff planner and the borderline-students list

   Use the effective letters, which are the final letters once they are assigned (DECISIONS 2).
2. **Stage 6: Late-work UI, printable Summary tab, polish, full README, final verification.** Spec: `docs/build/STAGE6.md`.
   - The late-work calculation and the exporter formula already exist. What is missing is the grid "Late work…" dialog (Ctrl+L), the L2 badges, the Settings card, and late sample data.

   The plan was to build stages 5 and 6 in parallel, because their files are separate, and then run one shared review.

## Open items to check first when resuming

- **Stage 4, last fix round:** these two fixes pass all tests but were not independently re-verified, because the pause stopped the final verifier. Re-check both.
  - V4R3-1 (`js/core/importer.js`): a letter typed into "Letter Grade" in an "Everything"-preset export used to be dropped on re-import without a message.
  - V4R3-2 (`js/ui/exchange.js`): the step 3 wording about "marked as final letters".
- **Minor, from stage 3:** in the Meeting view for SE 6362 with attendance turned on, at a width of 1280px, the Final letter column is clipped. It is listed under "Carry-over" at the end of STAGE6.md.

## How to resume in a new session

1. Check out the branch above, then run `npm install` (dev only: it fetches ExcelJS for `npm run vendor`), `npm test`, and `npm run test:e2e`.
2. Read `docs/build/REQUEST.md`, `docs/build/DECISIONS.md` and `docs/DESIGN.md`, then the stage spec you are building.
3. Keep the working rules:
   - Every change goes through `GT.store.transact`.
   - Every rendered name has the `pii` class.
   - Only classic scripts, no ES modules.
   - No network requests.
   - Fake data only.
   - Commit after each stage, with the tests passing.
