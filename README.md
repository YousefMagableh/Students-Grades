# Grade Tracker

An offline, local-only grade book for a teaching assistant. It replaces the Excel grade sheet for two courses: SE 4351 Requirements Engineering and SE 6362 Software Architectural Design.

- **Private by design:** there is no server, no account, and no internet use. Grades stay in this browser on this computer.
- **No install:** open `index.html` in Chrome, Edge, Firefox, or Safari.

> This README is being completed stage by stage. The full guide covers formulas, placeholders, export and import, and attendance, and it arrives with the final stage.

## Open the app

1. Download or clone this repository.
2. Double-click `index.html`. It opens in your browser as a normal page. Everything in the page runs from the local files.
3. Optional: make a desktop shortcut to `index.html` so it opens like any other program.

## Back up your data

- Grades are stored in the browser's storage (IndexedDB) and saved automatically.
- Browser storage can be cleared, for example by "clear browsing data", a different browser or profile, or a private window.
  - Use **Backup** (header) or **Data → Download backup** regularly.
  - The header shows when the last backup was made.
  - A reminder appears when the last backup is older than 7 days.
- **Data → Restore from backup** replaces all current data with a backup file.
- Keep backup files private. This repository's `.gitignore` excludes `*.xlsx`, `*.csv`, and backup `*.json` files so real grades are never committed by accident.

## Development

- `npm test` runs the unit tests (Node 22, no dependencies).
- `npm run test:e2e` runs the headless Chromium smoke test. It needs Playwright, and it fails on any network request.
- Design notes are in `docs/DESIGN.md`, and the requirement list is in `docs/REQUIREMENTS.md`.
