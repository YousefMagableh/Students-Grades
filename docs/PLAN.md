# Grade Tracker: build plan

Goal: an offline, local-only grade book for the two courses I TA (SE 4351 and SE 6362), replacing the Excel sheet.

## Architecture

- Static files only: `index.html`, `css/`, `js/`, `vendor/`. It opens straight from disk (`file://`), with no server and no build step.
- Classic `<script>` tags and one global namespace (`GT`). ES modules are blocked on `file://` in Chrome, so none are used.
- `js/core/*` holds the pure logic (model, calculations, attendance, statistics, history, CSV, export model). It has no DOM access and runs in both the browser and Node, so it is unit-tested with `node --test` and needs no dependencies.
- `js/ui/*` holds the views: grades grid, students and teams, attendance, statistics, settings, history, import/export, and a printable summary.
- Storage is IndexedDB, with a localStorage fallback. It autosaves, and supports JSON backup and restore.
- Excel support comes from ExcelJS 4.4.0, vendored in `vendor/` and loaded only when needed. Charts are hand-written SVG.
- A Content-Security-Policy meta tag blocks all network connections, remote images, and fonts.

## Stages

Each stage ends with a commit and a push, and the tests must pass.

1. Data model and calculations, with automated tests.
2. App shell, storage, backup and restore, courses, the grid, teams, withdrawn students, change history, and settings.
3. Attendance.
4. Export and import (.xlsx and .csv).
5. Statistics.
6. Late-work rule, polish, printable summary, README, and headless-browser verification.

## Verification

- Unit tests for every stage (`npm test`).
- A headless Chromium smoke test (`npm run test:e2e`). It opens `index.html` from disk and fails on any network request.
