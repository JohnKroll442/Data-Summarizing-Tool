# ActionView Three-View Switcher — Design

**Date:** 2026-08-12
**Status:** Approved (design)

## Goal

Replace ActionView's current "chart tabs reveal a panel below the table" layout
with a top-level **SAP UI5 SegmentedButton** switcher offering three
mutually-exclusive, full-screen views:

1. **Data Table** (default)
2. **Story × Action**
3. **Offset vs Duration**

Each view uses the full main column so content is no longer condensed onto one
scrolling page. The heatmap and the offset chart become readable full-screen
canvases instead of panels stacked beneath the table.

## Background — current structure

[src/pages/views/ActionView.jsx](../../../src/pages/views/ActionView.jsx) today:

- Owns all shared state + memoized derivation: `scopedRows`, `anomalies`,
  `bands`, `aggRows`, `storyActionMatrix`, `kpis`, `filteredSummary`,
  `tierByType`, the table's `filteredActionRows`, the rail-filter selections
  (`anomalyTypeFilter`, `durationBucket`), and the waterfall/cell-detail
  selections.
- Renders a `KpiStrip` into the shared page header via `HeaderPortal`.
- Renders a two-column grid: a sticky left **rail**
  (`DurationDistribution` + `AnomalySummaryPanel`) beside a **main** column.
- The main column has a text-tab strip (`.action-chart-tabs`) with two tabs —
  *Offset vs Duration* and *Story × Action Heatmap* — that toggle a
  `.action-chart-placeholder` panel **below** the `ActionSummaryTable` and
  scroll it into view. The heatmap tab renders `ActionStoryHeatmap` +
  `ActionCellDetail`; the offset tab renders a "Chart coming soon" placeholder.
- An inline `ActionWaterfallPanel` opens below the table when a row icon is
  clicked.

## Architecture

**Chosen approach (A):** ActionView remains the single owner of all shared state
and memoized derivation exactly as it is today. A new top-level `activeView`
state selects which of three presentational panels renders. The heavy
computations (matrix, anomalies, KPIs) already run unconditionally and are
memoized, so switching views only swaps rendered output — no data-flow changes.

To keep the coordinator readable (the file is ~370 lines), the three panels are
extracted into focused presentational components. ActionView passes each panel
exactly the props it needs; ActionView keeps ownership of state and callbacks.

### New / changed files

- **Create** `src/components/ActionDataTablePanel.jsx` — the Data Table view:
  the left rail (`DurationDistribution` + `AnomalySummaryPanel`) + the
  `ActionSummaryTable` + the inline `ActionWaterfallPanel`. Purely
  presentational; receives all data + callbacks as props.
- **Create** `src/components/ActionHeatmapPanel.jsx` — the Story × Action view:
  full-width `ActionStoryHeatmap` + the `ActionCellDetail` drill-down beneath
  it. Receives matrix, selection state, and callbacks as props.
- **Create** `src/components/ActionOffsetPanel.jsx` — the Offset vs Duration
  view: a full-width placeholder ("Chart coming soon"). No chart logic yet.
- **Create** `src/components/ActionViewSwitcher.jsx` — a thin wrapper around
  UI5 `SegmentedButton`/`SegmentedButtonItem` that renders the three options
  and reports the chosen view key. Presentational; `activeView` + `onChange`
  are props.
- **Modify** `src/pages/views/ActionView.jsx` — becomes the coordinator: keeps
  all existing state/derivation, adds `activeView`, renders
  `ActionViewSwitcher` + the active panel. Removes the `activeChartTab`
  text-tab state, the `chartPanelRef` scroll-into-view effect, and the old
  inline chart-panel JSX.
- **Modify** `src/pages/views/ActionView.css` — remove `.action-chart-tabs*`
  and `.action-chart-placeholder*`; add layout for the switcher bar and the
  full-width chart panels. Keep the existing `.action-view` rail/main grid for
  the Data Table view only.
- **Create** `src/components/ActionViewSwitcher.css` (and small CSS files for
  the panels as needed) following the existing per-component CSS convention.

### Switcher component contract

UI5 `SegmentedButton` (v2.25.0) is imported per-component:

```js
import { SegmentedButton } from '@ui5/webcomponents-react/SegmentedButton'
import { SegmentedButtonItem } from '@ui5/webcomponents-react/SegmentedButtonItem'
```

- Renders one `SegmentedButtonItem` per view, each carrying `data-view`
  (`'table' | 'heatmap' | 'offset'`) and `selected={activeView === key}`.
- `onSelectionChange` reads
  `event.detail.selectedItems[0]?.dataset.view` and calls `onChange(viewKey)`.
- Item text: "Data Table", "Story × Action", "Offset vs Duration".

### View keys

`'table'` (default) | `'heatmap'` | `'offset'`.

## Data flow

Unchanged and one-directional. ActionView still:

- scopes rows once, runs the memoized detector, owns rail-filter state, and
  passes `byActionKey` / `anomalyTypeFilter` down to the table while hover flows
  back up;
- receives `filteredActionRows` up from the table (published only while the
  Data Table panel is mounted).

The panels are pure recipients. Because the table only mounts on the Data Table
view, `filteredActionRows` reflects the table when it is visible; the KPI strip
(kept in the header on all views per the design) shows the last-published
filtered set — matching today's behavior when the table is on screen. This is
acceptable: the KPIs are a headline summary, and switching to a chart view does
not clear the user's table filters.

## State persistence

`activeView` persists into `viewUi.action` (alongside the existing
`anomalyTypeFilter` and `durationBucket`) so it survives drilling into Widget
view and returning via Back (the nav snapshot captures `viewUi`). It is seeded
from `viewUi.action.activeView ?? 'table'` and written back in the existing
`setViewUi('action', { ... })` effect.

## KPI strip

Stays rendered into `HeaderPortal` on all three views (unchanged). No per-view
gating.

## Layout / CSS

- **Data Table view:** keeps the existing `.action-view` grid
  (260px rail + `minmax(0, 1fr)` main), collapsing to one column under 1100px.
- **Story × Action and Offset views:** render full-width in the main content
  area with no rail. A new container class gives the panel the full page width
  and comfortable padding so the heatmap/offset chart fills the screen.
- The switcher bar sits at the top of the view (where the old text-tab strip
  was), above whichever panel is active.
- Remove `.action-chart-tabs`, `.action-chart-tab*`, and
  `.action-chart-placeholder*` rules. The scroll-into-view behavior for the
  chart panel is removed (no more scrolling down to reveal a chart).

## Removed behavior

- The `activeChartTab` toggle state and the `chartPanelRef` scroll effect.
- The "only one chart shows, click again to collapse, scroll down to it" UX —
  superseded by the full-screen switcher.
- The waterfall panel's own scroll-into-view remains (it lives inside the Data
  Table view and still opens from table row icons).

## Testing

This is a presentational restructure of existing, already-tested logic; the
derivation/lib layer is unchanged, so no new lib tests are required. Testing
focuses on the switcher's view-selection behavior and safe defaults:

- **`ActionViewSwitcher`** (new component test): renders three items; clicking
  an item (or firing `selection-change`) invokes `onChange` with the correct
  view key; the item matching `activeView` is marked selected.
- **Default view:** with no persisted `viewUi.action.activeView`, ActionView
  starts on `'table'`. (Covered via the switcher default + a light render
  assertion if a suitable ActionView test harness exists; otherwise asserted at
  the switcher level.)
- Existing suites (`storyActionMatrix`, `actionSequence`, `sapStatus`,
  `actionWaterfallMeta`) must continue to pass unchanged.

Manual verification: switch among the three views; confirm the heatmap and
offset panels fill the width with no rail; confirm the Data Table view is
unchanged (rail + table + waterfall); confirm the KPI strip persists across all
three; confirm the active view survives a Widget-view drill-down + Back.

## Out of scope (YAGNI)

- Building the real Offset vs Duration chart — stays a placeholder.
- Any change to the table, waterfall, heatmap, or cell-detail internals beyond
  moving them into panels.
- Lazy/deferred computation of per-view data — memoization already covers it.
