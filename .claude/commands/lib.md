---
description: Add or modify a src/lib utility function and its test
argument-hint: <what to add or change, e.g. "add a median() helper to format.js">
---
Lib utilities and their tests live in known locations — go straight there:

- Utilities: `src/lib/*.js`
  - Aggregation: `actionAggregate.js`, `widgetAggregate.js`, `sessionAggregate.js`
  - Formatting: `format.js`
  - Filtering: `durationFilter.js`, `viewFilters.js`, `multiFilter.js`, `timeBuckets.js`
  - KPIs: `kpis.js`
  - Parsing: `parseCsv.js`, `csvCache.js`
  - Charts: `chartColors.js`, `chartData.js`, `defaultCharts.js`
  - Other: `summary.js`, `sortRows.js`, `anomalyDetect.js`, `durationBands.js`, `storyActionMatrix.js`, `actionViews.js`, `actionWaterfallMeta.js`, `syntheticMeasures.js`, `drillDown.js`, `memoize.js`, `exportCsv.js`, `viewedItems.js`, `sapStatus.js`, `activityTimeline.js`
- Tests: `src/lib/__tests__/<same-name>.test.js`

Task: $ARGUMENTS

If no task was given above, ask the user what they need before doing anything else.

1. Identify the specific lib file(s) involved — read only those, not the whole tree.
2. Make the change. Keep the same code style: ES module exports, no TypeScript, same formatting conventions as the surrounding code.
3. Add or update the matching test in `src/lib/__tests__/`. If no test file exists, create one.
4. Run `npm run test:run` and confirm it passes.
