---
description: Modify KPI calculations or the KPI strip display
argument-hint: <what to change, e.g. "add p95 duration KPI for action view">
---
KPI code lives in known locations — go straight there:

- Calculations: `src/lib/kpis.js` — `computeKpis(variant, rows, headers)` dispatches to `sessionKpis`, `actionKpis`, `widgetKpis`
- Strip display (single dataset): `src/components/KpiStrip.jsx` + `src/components/KpiStrip.css` (implied path)
- Delta strip display (compare): `src/components/KpiDeltaStrip.css` (check `src/components/` for the matching `.jsx`)
- Test: `src/lib/__tests__/kpis.test.js`
- Supporting aggregates (read if you need column names): `src/lib/actionAggregate.js`, `widgetAggregate.js`, `sessionAggregate.js`
- Format helpers: `src/lib/format.js` — `formatCount`, `formatDurationMs`

Task: $ARGUMENTS

If no task was given above, ask the user what they need before doing anything else.

1. Read `src/lib/kpis.js` first to understand the variant dispatch pattern.
2. Make the change. Each KPI is a `{ label, value }` object; missing data renders as `'—'`.
3. Update `src/lib/__tests__/kpis.test.js`.
4. Run `npm run test:run` and confirm it passes.
5. If it's a display change (strip layout, formatting), smoke-check with the `run` skill.
