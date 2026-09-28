# Decisions made by the user during the build

1. (2026-09-28) Class/Project Participation is entered out of 5, as in the previous TA's sheet, where 5 means full marks. Its default maxScore is **5** in both templates (SE4351, SE6362) and in custom courses. The weight stays 5%, so the raw score equals the weighted points. Every other assessment keeps a default max of 100. The maxScores placeholder note must mention this.
2. (2026-09-28) Final letter grades are assigned manually from a drop-down, in bands, after the scores are finalized and sorted by total. The cutoff letter is only a suggestion. See STAGE2B.md.
3. (2026-09-28) Attendance: Excused means allowed (approved by the instructor), and Absent means not allowed (unexcused). Add an optional threshold on total absences next to the unexcused threshold. See STAGE3.md.
4. (2026-09-28) Real student names are never sent to the assistant or committed. The TA pastes or imports them locally.
5. (2026-09-28) Workflow clarification. The TA fills every score before the grading meeting and leaves Class/Project Participation EMPTY. In the meeting, the instructor sets participation for each student, mostly from that student's absences, and decides every final letter. The app replaces Excel for a user who has never used Excel, so everything must be simple and calculate automatically: weighted columns, total, rank and statistics update instantly on every edit, as the colleague's Excel formulas did.
6. (2026-09-28) Absences must sit in front of every student in the Grades grid, as SEPARATE columns:
   - "Excused (allowed)"
   - "Unexcused (not allowed)"
   - "Total" (both together, shown for information and hideable)
   Unexcused absences drive the threshold highlight. The user thinks allowed absences should not count against the student. The consecutive-absence streak therefore counts **unexcused only by default** (`excusedCountsTowardStreak` defaults to **false**), and the toggle stays in the settings. This changes the original default ("all absences count") at the user's request. Say so in the UI help and the README.
7. (2026-09-28) Meeting use. Sorting by total must NOT make rows jump while you edit (the Excel behaviour: a sort is applied once). The row order is a snapshot taken when the user sorts. Edits never reorder rows. When the order no longer matches the values, show a small "Order changed: re-sort" button. Name sort follows the same rule.
8. (2026-09-28) The final letter and the participation score are both chosen from **drop-down lists** in the grid, so no typos are possible:
   - Letters: the course's scale letters plus "(none)".
   - Participation: max 5, with the choices 5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0, and "(empty)".
   Typing a valid value into the cell still works as a shortcut (it selects the matching option). An invalid typed value is rejected with a clear message and is not stored as text. The user asked for the system to be "100% effective, with no errors or breakage": validation must be strict and never crash.
