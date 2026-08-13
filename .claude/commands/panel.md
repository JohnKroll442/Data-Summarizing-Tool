---
description: Add or modify a panel component following existing conventions
argument-hint: <what to add or change, e.g. "add a session latency breakdown panel">
---
Panel components live in known locations — go straight there:

- Existing panels to mirror: `src/components/ActionDataTablePanel.jsx`, `src/components/ActionOffsetPanel.jsx`, `src/components/ActionWaterfallPanel.jsx`, `src/components/ActionHeatmapPanel.jsx`, `src/components/AnomalySummaryPanel.jsx`, `src/components/WidgetTimingPanel.jsx`
- CSS: each panel has a matching `.css` file alongside it
- Charts used inside panels: `src/components/charts/EChartCard.jsx`, `src/components/charts/ChartGrid.jsx`
- Data passed in via props from view pages in `src/pages/views/`

Task: $ARGUMENTS

If no task was given above, ask the user what they need before doing anything else.

1. Identify the closest existing panel to mirror — read that one file before writing anything new.
2. Create the new panel component following the same prop shape, CSS conventions, and export style.
3. Create the matching `.css` file.
4. If the panel contains chart logic, put ECharts option building in `src/components/charts/options/` (new file) with a test in the matching `__tests__/`.
5. Smoke-check with the `run` skill — panel render crashes won't be caught by tests.
