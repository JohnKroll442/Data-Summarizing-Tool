---
description: Make a scoped change to an ECharts chart without re-exploring the tree
argument-hint: <what to change, e.g. "offset chart: add median reference line">
---
Chart code lives in known locations — go straight there, do NOT search the whole tree:

- ECharts option builders: `src/components/charts/options/*.js` (offsetDuration, actionSequence, widgetTiming, activityBars, heatmap, gauge)
- Card / grid wrappers: `src/components/charts/EChartCard.jsx`, `src/components/charts/ChartGrid.jsx`
- Chart registry: `src/components/charts/registry.js`
- Shared colors: `src/lib/chartColors.js`
- Tests: `src/components/charts/options/__tests__/`

Task: $ARGUMENTS

If no task was given above, ask the user what they need before doing anything else.

Identify the specific option builder involved, make the change, update or add its test in the matching `__tests__` file, then run `npm run test:run` for that test. If it's a visual change, smoke-check with the `run` skill (build+lint+test won't catch a render crash).
