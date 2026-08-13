---
description: Modify filter logic (duration, time, multi-filter, view filters) or filter UI menus
argument-hint: <what to change, e.g. "add a percentile-based duration filter option">
---
Filter code lives in known locations — go straight there:

- Duration filter logic: `src/lib/durationFilter.js`
- Duration filter menu: `src/components/DurationFilterMenu.jsx`
- Time filter menu: `src/components/TimeFilterMenu.jsx`
- Multi-filter logic: `src/lib/multiFilter.js`
- Multi-filter menu: `src/components/MultiFilterMenu.jsx`
- View-level filter composition: `src/lib/viewFilters.js`
- Time bucketing: `src/lib/timeBuckets.js`
- Filter pill (UI): `src/components/FilterPill.jsx`
- Tests: `src/lib/__tests__/durationFilter.test.js`, `viewFilters.test.js`, `timeBuckets.test.js`

Task: $ARGUMENTS

If no task was given above, ask the user what they need before doing anything else.

1. Identify which filter layer is involved (duration bands, time ranges, multi-select, or view-level composition) — read only the relevant file(s).
2. Make the change, keeping the same predicate/callback style as surrounding code.
3. Add or update the matching test.
4. Run `npm run test:run` and confirm it passes.
5. If the change affects a menu UI, smoke-check with the `run` skill.
