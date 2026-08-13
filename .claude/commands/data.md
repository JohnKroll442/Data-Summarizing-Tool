---
description: Modify CSV parsing, data context, or aggregation logic
argument-hint: <what to change, e.g. "add support for a new optional column in parseCsv">
---
Data pipeline code lives in known locations — go straight there:

- CSV parsing + validation: `src/lib/parseCsv.js` + test: `src/lib/__tests__/parseCsv.test.js`
- CSV cache: `src/lib/csvCache.js`
- Data context (React, holds parsed rows + headers): `src/context/CsvDataContext.jsx`
- Aggregation:
  - `src/lib/actionAggregate.js` + `src/lib/__tests__/actionAggregate.test.js`
  - `src/lib/widgetAggregate.js` + `src/lib/__tests__/widgetAggregate.test.js`
  - `src/lib/sessionAggregate.js` + `src/lib/__tests__/sessionAggregate.test.js`
- Synthetic measures: `src/lib/syntheticMeasures.js` + test: `src/lib/__tests__/syntheticMeasures.test.js`
- Summary rollups: `src/lib/summary.js` + test: `src/lib/__tests__/summary.test.js`
- File upload UI: `src/components/FileUpload.jsx`
- CSV validation dialog: `src/components/CsvValidationDialog.css` (check `src/components/` for matching `.jsx`)

Task: $ARGUMENTS

If no task was given above, ask the user what they need before doing anything else.

1. Read only the specific file(s) affected — for column changes, start with `parseCsv.js`; for derived values, start with the relevant aggregate.
2. Make the change. Column name changes ripple through aggregates → KPIs → views — call out each ripple explicitly before touching them.
3. Add or update the matching test.
4. Run `npm run test:run` and confirm it passes.
