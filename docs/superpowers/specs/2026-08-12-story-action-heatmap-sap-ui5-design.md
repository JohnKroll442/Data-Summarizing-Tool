# Story × Action Heatmap Drill-Down — SAP UI5 Redesign

**Date:** 2026-08-12
**Status:** Design — awaiting review

## Goal

Make the drill-down beneath the Story × Action heatmap match the SAP Analytics
Cloud reference screenshot, using the `@ui5/webcomponents-react` components the
project already uses elsewhere. Two areas change:

1. **`ActionCellDetail`** — the left instance list becomes a SAP `List`.
2. **`ActionWaterfallPanel`** — the plain `<h2>` header becomes a rich SAP card
   header (breadcrumb title · metadata line · phase legend · "View" button).

A supporting change recolors the waterfall chart so its bars — and the new
header legend — are keyed by **phase** (Offset / Backend / Network / Render)
instead of the current two-way Local/Remote split.

## Reference

The screenshot shows, at the bottom of the heatmap:

- **Left list:** rows of `<duration>` + `<user>` + `<timestamp>`, some with a
  small type tag (e.g. "TYPE").
- **Right panel header:** a breadcrumb-style title
  `Go to page - LS_OPEX_DT_PM_STORY - 10:03:03 - Z_ATAMAN`, a metadata line
  `Total: 0.0m · 1 widget(s)`, a phase legend `Offset · Backend · Network wait ·
  Render`, and a `View` button top-right — above the waterfall bars.

## Approach

Approach A (chosen): pure SAP UI5 React components. `List` + `ListItemCustom` +
`ObjectStatus` + `Tag` for the list; `Title` + `Text` + legend chips + `Button`
for the header. Backwards compatible — no behavior removed.

## Component 1 — `ActionCellDetail` left list

**File:** `src/components/ActionCellDetail.jsx` (+ `.css`)

Replace the `<ul>/<li>/<button>` list with:

```
<List selectionMode="SingleEnd" separators="Inner"
      onSelectionChange={…set selectedIdx from selected item…}>
  {instances.map((inst, i) => (
    <ListItemCustom key=… selected={i === selectedIdx} type="Active"
                    onClick={() => setSelectedIdx(i)}>
      <div className="cell-detail__row">
        <ObjectStatus large state={stateFor(inst)}>{formatDurationMs(dur)}</ObjectStatus>
        <div className="cell-detail__meta">
          <span className="cell-detail__user">{inst.user || '—'}</span>
          <span className="cell-detail__ts">{formatCsvTime(inst._action_timestamp)}</span>
        </div>
        <div className="cell-detail__badges">
          {tiers.map(t => <Tag key={t} design={tagDesignFor(t)}>{`T${t}`}</Tag>)}
        </div>
      </div>
    </ListItemCustom>
  ))}
</List>
```

- **Selection:** keep the existing `selectedIdx` state as the source of truth.
  Drive it from `ListItemCustom`'s `onClick` (simplest, matches current
  behavior). `selected={i === selectedIdx}` gives the SAP highlight.
- **Duration → `ObjectStatus` state** (`durationTier` from `durationBands`):
  - `good` → `"Positive"`
  - `neutral` / `watch` / `warn` → `"Critical"`
  - `bad` → `"Negative"`
  - `null`/unknown → `"None"`
- **Tier badges → `Tag`** (replacing `TierBadge` inside this list only):
  - T1 → `design="Negative"`, T2 → `design="Critical"`, T3 → `design="Information"`
  - text `T1` / `T2` / `T3` (matches the `distinctTiers` output)
- **CSS:** remove `cell-detail__list`, `cell-detail__item`, `cell-detail__dur`
  and its tier color modifiers, `cell-detail__user`/`__ts`/`__badges`/`__meta`
  layout that targeted the old `<button>` grid. Add a small `cell-detail__row`
  flexbox (duration | meta column | badges) inside the custom item. The list
  scroll container (`max-height`, `overflow-y`) moves onto the `List` (via
  `className` + CSS) or a wrapping `<div>`.

The left pane keeps its `min-max(15rem, 20rem)` grid column; only the internals
change.

## Component 2 — `ActionWaterfallPanel` rich header

**File:** `src/components/ActionWaterfallPanel.jsx` (+ `.css`)

### New prop

Add one optional prop, `meta`, so the header can show story/user/duration that
aren't reliably present on the raw CSV rows the panel already receives:

```
meta?: {
  story?: string,       // e.g. "LS_OPEX_DT_PM_STORY"
  user?: string,        // e.g. "Z_ATAMAN"
  actionName?: string,  // e.g. "Go to page"  (falls back to `selected.name`)
  timestamp?: string,   // raw action timestamp (formatted via formatCsvTime)
  durationMs?: number,  // action duration for the "Total: …" line
}
```

`widgetCount` is NOT passed — the panel already derives `actionWidgets`
internally, so the "N widget(s)" count comes from `actionWidgets.length`.

Backwards compatible: when `meta` is absent, `actionName` falls back to
`selected?.name`, and the story/user/timestamp/total fields are simply omitted
from the header (title collapses to just the action name), so any current caller
keeps working.

### Callers pass `meta`

- **`ActionCellDetail`** (`src/components/ActionCellDetail.jsx`): passes
  `meta={{ story, actionName: action, user: selected?.user,
  timestamp: selectedTs, durationMs: selected?.action_duration }}`.
- **`ActionView`** standalone panel (`src/pages/views/ActionView.jsx`): the
  `waterfallActions` list is built from `bucketedRows` (aggregated rows that DO
  carry `story_name`, `user`, `action_duration`). Enrich each entry with those
  fields, and pass `meta` for the currently-selected action. (The panel selects
  by index; the parent can pass the whole enriched `actions` array and the panel
  reads `meta` off the selected entry — OR the parent passes a top-level `meta`
  for the initial selection. **Decision:** enrich each `actions[]` entry with
  `{ story, user, durationMs }`, and the panel builds its header `meta` from
  `actions[selectedIdx]`, falling back to the `meta` prop. This keeps the header
  correct as the user steps through actions with the ‹ › stepper.)

### Header markup

Replace the current `<header className="action-waterfall-header">` block with:

```
<header className="action-waterfall-rich-header">
  <div className="awf-header__top">
    <Title level="H5" size="H5" className="awf-header__crumb">
      {[actionName, story, formatCsvTime(timestamp), user].filter(Boolean).join('  ·  ')}
    </Title>
    <Button design="Transparent" onClick={onClose}>View</Button>
  </div>
  <Text className="awf-header__meta">
    {`Total: ${formatDurationMs(durationMs) || '—'} · ${widgetCount} widget${widgetCount === 1 ? '' : 's'}`}
  </Text>
  <div className="awf-header__legend">
    {PHASE_LEGEND.map(p => (
      <span className="awf-legend__item" key={p.key}>
        <span className="awf-legend__swatch" style={{ background: p.color }} />
        <Text className="awf-legend__label">{p.label}</Text>
      </span>
    ))}
  </div>
</header>
```

- The existing close **X** button is replaced by the `View` button (top-right),
  which calls the same `onClose`. (No new navigation behavior — the screenshot's
  "View" control maps to the existing close action.)
- The action picker/stepper toolbar (`<select>` + ‹ ›, shown only when
  `actions.length > 1`) stays **below** the header, unchanged.
- `PHASE_LEGEND` is a static array shared with the chart (see Component 3) so the
  swatch colors and the bar colors are guaranteed to match.

### CSS

Add `.action-waterfall-rich-header` (flex column, gap), `.awf-header__top`
(space-between row), `.awf-header__crumb`, `.awf-header__meta` (muted),
`.awf-header__legend` (inline flex, wrap), `.awf-legend__item`,
`.awf-legend__swatch` (0.75rem square, border-radius 2px), `.awf-legend__label`.
Remove the old `.action-waterfall-header` / `.action-waterfall-close` rules (or
repurpose the close styles for the `View` button if `Button` needs no override).

## Component 3 — recolor the waterfall chart by phase

**File:** `src/components/charts/options/actionSequence.js`

Today every bar is colored `LOCAL` (blue) or `REMOTE` (orange) by
`phase.kind`. Change to a per-phase color so the four legend categories match
the bars.

### Phase → color map

Add a single source of truth (exported so the header legend imports it):

```
export const PHASE_COLORS = {
  offset:  '#8396a8',  // muted grey-blue
  backend: '#0070f2',  // SAP_BLUE
  network: '#e35b2a',  // orange (existing REMOTE)
  render:  '#0f828f',  // teal — distinct from backend blue
}
```

- The three network sub-phases (`network-full`, `network-wait`, `network-cdn`)
  all use `PHASE_COLORS.network`.
- The legend shown in the header collapses these to **four** categories, labeled
  to match the screenshot: `Offset`, `Backend`, `Network wait`, `Render`.

```
export const PHASE_LEGEND = [
  { key: 'offset',  label: 'Offset',       color: PHASE_COLORS.offset },
  { key: 'backend', label: 'Backend',      color: PHASE_COLORS.backend },
  { key: 'network', label: 'Network wait', color: PHASE_COLORS.network },
  { key: 'render',  label: 'Render',       color: PHASE_COLORS.render },
]
```

> **Palette note:** these hexes reproduce the screenshot's apparent colors
> (grey / blue / orange / teal-blue) using SAP-aligned values. They can be tuned
> during review without affecting the structure.

### Chart changes

- In `buildActionSequenceOption`, set each bar's color from a phase→color lookup
  keyed by the phase group (`offset` / `backend` / `network` / `render`) rather
  than `phase.kind === 'local' ? LOCAL : REMOTE`. Add a `group` field to
  `PHASE_ORDER` entries (or derive it: `phase.key.startsWith('network') →
  'network'`, else `phase.key`).
- The bar's `data` object currently carries `kind: 'Local' | 'Remote'` (used in
  the tooltip). Change to `phaseGroup` + keep a human label; the tooltip's
  `Type:` line shows the phase label (e.g. "Network wait") instead of
  Local/Remote.
- **Remove the ECharts built-in `legend`** (the `legend: { … data: [Local,
  Remote] }` block) — the header legend replaces it. This also frees the vertical
  space the chart used at `top: 8` / `grid.top: 76`; reduce `grid.top`
  accordingly (e.g. to ~40) so the bars don't leave a gap where the legend was.
- The two invisible marker series (`name: 'Local'` / `name: 'Remote'`, added only
  so the old legend had toggleable entries) can be **removed** — with no legend
  they serve no purpose. Keep the `spacer` and `duration` series.

## Data flow summary

```
ActionView
  aggRows (story_name, user, action_duration, _action_timestamp)
   ├─ buildStoryActionMatrix → cells[].instances  (aggregated rows)
   │
   ├─ heatmap cell click → selectedCell {story, action}
   │    └─ ActionCellDetail(story, action, cell.instances, …)
   │         ├─ SAP List of instances (Component 1)
   │         └─ ActionWaterfallPanel(meta from story/action/selected instance)
   │              └─ rich header (Component 2) + phase-colored chart (Component 3)
   │
   └─ "Open Waterfall" below table
        └─ ActionWaterfallPanel(actions enriched with story/user/durationMs)
             └─ same rich header + phase-colored chart
```

## Testing

- **`storyActionMatrix.test.js`** already exists and is unaffected (matrix logic
  unchanged).
- Add a focused unit test for the phase→color/legend mapping in
  `actionSequence.js` if a testable pure helper is extracted (e.g. a
  `phaseGroupOf(key)` and the `PHASE_LEGEND`/`PHASE_COLORS` export). Assert
  network sub-phases map to the `network` group/color and the legend has the four
  expected categories.
- Manual/visual check against the reference screenshot for both entry points
  (heatmap cell drill-down and the below-table "Open Waterfall").

## Out of scope

- No change to the heatmap grid itself (`ActionStoryHeatmap`).
- No new navigation behind the "View" button (maps to existing `onClose`).
- No change to `WidgetTimingPanel` (the drill-into-a-widget mode).
- No change to how durations/tiers are computed.
