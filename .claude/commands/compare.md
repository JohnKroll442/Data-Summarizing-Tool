---
description: Work on the Compare page (widget / action / session comparison views)
argument-hint: <what to change, e.g. "add delta highlighting to ActionCompare table">
---
Compare page code lives in known locations — go straight there:

- Entry / layout: `src/pages/ComparePage.jsx`
- Per-entity compare views: `src/pages/compare/ActionCompare.jsx`, `src/pages/compare/WidgetCompare.jsx`, `src/pages/compare/SessionCompare.jsx`
- Compare lib logic: `src/lib/compare.js` + test: `src/lib/__tests__/compare.test.js`
- KPI delta strip: `src/components/KpiDeltaStrip.css` (check `src/components/` for matching `.jsx`)
- Delta table: `src/components/DeltaTable.jsx` + `src/components/DeltaTable.css`
- Shared data context: `src/context/CsvDataContext.jsx`

Task: $ARGUMENTS

If no task was given above, ask the user what they need before doing anything else.

1. Read only the specific compare file(s) affected — not all three unless the change spans all.
2. Make the change. Keep parity between the three compare views unless the task is deliberately asymmetric.
3. If logic moves into `src/lib/compare.js`, add or update `src/lib/__tests__/compare.test.js`.
4. Run `npm run test:run` to confirm, then smoke-check with the `run` skill (compare views are data-driven and won't crash in tests).
