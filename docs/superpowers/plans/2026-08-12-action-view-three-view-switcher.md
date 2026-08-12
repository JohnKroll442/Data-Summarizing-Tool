# ActionView Three-View Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ActionView's stacked "chart tabs reveal a panel below the table" layout with a top-level SAP UI5 SegmentedButton switcher selecting one of three full-screen views — Data Table (default), Story × Action, Offset vs Duration.

**Architecture:** ActionView remains the sole owner of all shared state and memoized derivation. A new `activeView` state selects which of three extracted presentational panels renders. Switching views only swaps rendered output; the one-directional data flow is unchanged. A thin `ActionViewSwitcher` wraps UI5 `SegmentedButton`. View keys and default resolution live in a pure, tested `src/lib/actionViews.js`.

**Tech Stack:** React 19, Vite, `@ui5/webcomponents-react` ^2.25.0 (per-component import paths), Vitest (node env, `*.test.js` only), oxlint.

**Spec:** `docs/superpowers/specs/2026-08-12-action-view-three-view-switcher-design.md`

## Global Constraints

- **UI5 imports are per-component:** `import { X } from '@ui5/webcomponents-react/X'` — never barrel imports. Confirmed repo convention.
- **View keys:** exactly `'table'` (default) | `'heatmap'` | `'offset'`.
- **SegmentedButton item labels:** exactly `Data Table`, `Story × Action`, `Offset vs Duration` (that `×` is U+00D7 MULTIPLICATION SIGN, matching the existing heatmap tab).
- **Test harness reality:** Vitest runs `environment: 'node'`, includes only `src/**/*.test.js`. There is NO React Testing Library / jsdom render harness. Do NOT add one. All new automated tests are pure-logic `.test.js` files placed in `src/lib/__tests__/`.
- **KPI strip** stays rendered into `HeaderPortal` on all three views — no per-view gating.
- **Data flow is one-directional and unchanged:** ActionView scopes rows once, runs the memoized detector, owns all filter/selection state, and passes data + callbacks DOWN to panels; the table publishes `filteredActionRows` UP and hover flows UP. Panels are purely presentational.
- Preserve the existing `viewUi.action` persistence pattern (nav-snapshot survives Widget-view drill + Back).
- DRY, YAGNI, TDD, frequent commits. Do NOT build the real Offset vs Duration chart — it stays a placeholder.

## File Structure

- **Create** `src/lib/actionViews.js` — view registry + `resolveActiveView`. Pure, tested.
- **Create** `src/lib/__tests__/actionViews.test.js` — tests for the registry + resolver.
- **Create** `src/components/ActionViewSwitcher.jsx` — UI5 SegmentedButton wrapper. Presentational.
- **Create** `src/components/ActionViewSwitcher.css`.
- **Create** `src/components/ActionDataTablePanel.jsx` — Data Table view (rail + table + inline waterfall). Presentational.
- **Create** `src/components/ActionHeatmapPanel.jsx` — Story × Action view (full-width heatmap + cell detail). Presentational.
- **Create** `src/components/ActionOffsetPanel.jsx` — Offset vs Duration placeholder. Presentational.
- **Create** `src/components/ActionOffsetPanel.css`.
- **Modify** `src/pages/views/ActionView.jsx` — coordinator: add `activeView`, render switcher + active panel, remove the old text-tab/scroll code and inline chart JSX.
- **Modify** `src/pages/views/ActionView.css` — remove `.action-chart-tabs*` + `.action-chart-placeholder*`; add `.action-view-shell`, `.action-view-fullscreen` (shared full-width panel), keep `.action-view` grid for the Data Table panel.

---

### Task 1: View registry + resolver (`src/lib/actionViews.js`)

**Files:**
- Create: `src/lib/actionViews.js`
- Test: `src/lib/__tests__/actionViews.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ACTION_VIEWS: Array<{ key: 'table'|'heatmap'|'offset', label: string }>` (in switcher order).
  - `DEFAULT_ACTION_VIEW: 'table'`.
  - `isActionViewKey(key): boolean`.
  - `resolveActiveView(value): 'table'|'heatmap'|'offset'` — returns `value` if a valid key, else `DEFAULT_ACTION_VIEW`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/actionViews.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import {
  ACTION_VIEWS,
  DEFAULT_ACTION_VIEW,
  isActionViewKey,
  resolveActiveView,
} from '../actionViews'

describe('actionViews', () => {
  it('lists the three views in switcher order with exact labels', () => {
    expect(ACTION_VIEWS.map((v) => v.key)).toEqual(['table', 'heatmap', 'offset'])
    expect(ACTION_VIEWS.map((v) => v.label)).toEqual([
      'Data Table',
      'Story × Action',
      'Offset vs Duration',
    ])
  })

  it('defaults to the table view', () => {
    expect(DEFAULT_ACTION_VIEW).toBe('table')
  })

  it('isActionViewKey recognizes only known keys', () => {
    expect(isActionViewKey('table')).toBe(true)
    expect(isActionViewKey('heatmap')).toBe(true)
    expect(isActionViewKey('offset')).toBe(true)
    expect(isActionViewKey('bogus')).toBe(false)
    expect(isActionViewKey(undefined)).toBe(false)
  })

  it('resolveActiveView returns valid keys and falls back to the default', () => {
    expect(resolveActiveView('heatmap')).toBe('heatmap')
    expect(resolveActiveView('offset')).toBe('offset')
    expect(resolveActiveView(undefined)).toBe('table')
    expect(resolveActiveView(null)).toBe('table')
    expect(resolveActiveView('bogus')).toBe('table')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/actionViews.test.js`
Expected: FAIL — module `../actionViews` not found.

- [ ] **Step 3: Write the module**

Create `src/lib/actionViews.js`:

```javascript
/**
 * The three top-level Action views, in switcher order. `key` is persisted in
 * viewUi.action.activeView and drives which panel ActionView renders; `label`
 * is the SegmentedButton item text. The `×` in "Story × Action" is U+00D7.
 */
export const ACTION_VIEWS = [
  { key: 'table', label: 'Data Table' },
  { key: 'heatmap', label: 'Story × Action' },
  { key: 'offset', label: 'Offset vs Duration' },
]

/** The view shown when nothing is persisted. */
export const DEFAULT_ACTION_VIEW = 'table'

/** True when `key` is one of the known Action view keys. */
export function isActionViewKey(key) {
  return ACTION_VIEWS.some((v) => v.key === key)
}

/**
 * Resolve a (possibly persisted, undefined, or invalid) value to a valid view
 * key, falling back to DEFAULT_ACTION_VIEW.
 */
export function resolveActiveView(value) {
  return isActionViewKey(value) ? value : DEFAULT_ACTION_VIEW
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/actionViews.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/actionViews.js src/lib/__tests__/actionViews.test.js
git commit -m "feat: add ActionView view registry + resolveActiveView"
```

---

### Task 2: `ActionViewSwitcher` component

**Files:**
- Create: `src/components/ActionViewSwitcher.jsx`
- Create: `src/components/ActionViewSwitcher.css`

**Interfaces:**
- Consumes: `ACTION_VIEWS`, `isActionViewKey` (Task 1); UI5 `SegmentedButton`, `SegmentedButtonItem`.
- Produces: `<ActionViewSwitcher activeView onChange />` — `activeView` is the selected view key; `onChange(viewKey)` fires when the user picks a different segment.

- [ ] **Step 1: Write the component**

Create `src/components/ActionViewSwitcher.jsx`:

```jsx
import { SegmentedButton } from '@ui5/webcomponents-react/SegmentedButton'
import { SegmentedButtonItem } from '@ui5/webcomponents-react/SegmentedButtonItem'
import { ACTION_VIEWS, isActionViewKey } from '../lib/actionViews'
import './ActionViewSwitcher.css'

/**
 * Top-level switcher for the Action view's three panels (Data Table /
 * Story × Action / Offset vs Duration). Presentational: `activeView` marks the
 * pressed segment; `onChange(viewKey)` fires when the user selects another.
 *
 * Each SegmentedButtonItem carries a `data-view` attribute (rendered onto the
 * web component), read back from the selection-change event's selected item.
 */
function ActionViewSwitcher({ activeView, onChange }) {
  const handleSelectionChange = (event) => {
    const key = event.detail?.selectedItems?.[0]?.dataset?.view
    if (isActionViewKey(key) && key !== activeView) onChange(key)
  }

  return (
    <div className="action-view-switcher">
      <SegmentedButton accessibleName="Action view" onSelectionChange={handleSelectionChange}>
        {ACTION_VIEWS.map((v) => (
          <SegmentedButtonItem key={v.key} data-view={v.key} selected={v.key === activeView}>
            {v.label}
          </SegmentedButtonItem>
        ))}
      </SegmentedButton>
    </div>
  )
}

export default ActionViewSwitcher
```

- [ ] **Step 2: Write the CSS**

Create `src/components/ActionViewSwitcher.css`:

```css
/* Top-level Action view switcher bar — spacing above whichever panel renders. */
.action-view-switcher {
  margin-bottom: 1rem;
}
```

- [ ] **Step 3: Verify lint + build**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run build`
Expected: build succeeds (imports resolve; `@ui5/webcomponents-react/SegmentedButton` and `/SegmentedButtonItem` are valid export subpaths in 2.25.0).

- [ ] **Step 4: Commit**

```bash
git add src/components/ActionViewSwitcher.jsx src/components/ActionViewSwitcher.css
git commit -m "feat: add ActionViewSwitcher (UI5 SegmentedButton)"
```

**Testing note:** No component render test — the repo has no jsdom/RTL harness (node env, `*.test.js` only). The switcher's only logic (valid-key guard + default resolution) is covered by Task 1's `actionViews.test.js`. Verification here is lint + build + the Task 6 manual check.

---

### Task 3: `ActionDataTablePanel` (extract the Data Table view)

**Files:**
- Create: `src/components/ActionDataTablePanel.jsx`

**Interfaces:**
- Consumes: `ActionSummaryTable`, `ActionWaterfallPanel`, `DurationDistribution`, `AnomalySummaryPanel` (existing components, unchanged); the `.action-view` / `.action-view__rail` / `.action-view__main` classes from `ActionView.css` (global, imported by ActionView).
- Produces: `<ActionDataTablePanel {...} />` — a presentational panel rendering the rail + table + inline waterfall. Props (all owned by ActionView) listed below; ActionView (Task 6) passes exactly these.

- [ ] **Step 1: Create the panel**

Create `src/components/ActionDataTablePanel.jsx` (this is a faithful move of ActionView's current rail + main JSX — no behavior change):

```jsx
import ActionSummaryTable from './ActionSummaryTable'
import ActionWaterfallPanel from './ActionWaterfallPanel'
import DurationDistribution from './DurationDistribution'
import AnomalySummaryPanel from './AnomalySummaryPanel'

/**
 * Data Table view — the Action view's default panel: a sticky left rail
 * (duration histogram + anomaly summary) beside the one-row-per-action table,
 * with the inline waterfall panel opening below the table. Purely
 * presentational; ActionView owns all state and passes it down.
 */
function ActionDataTablePanel({
  // rail — duration histogram
  durations,
  bands,
  hoveredDuration,
  durationBucket,
  onSelectBucket,
  // rail — anomaly summary
  anomalyCounts,
  totalFlagged,
  totalActions,
  hoveredFlags,
  anomalyTypeFilter,
  onSelectAnomalyType,
  tierByType,
  // table
  rows,
  headers,
  onOpenWaterfall,
  onFilteredActionsChange,
  byActionKey,
  onHoverAction,
  onClearAnomalyFilter,
  durationBucketFilter,
  onClearDurationBucket,
  // inline waterfall
  waterfallOpen,
  waterfallActions,
  waterfallInitialKey,
  scopedRows,
  onCloseWaterfall,
  panelRef,
}) {
  return (
    <div className="action-view">
      <aside className="action-view__rail" aria-label="Action anomaly summary">
        <DurationDistribution
          durations={durations}
          bands={bands}
          highlightDuration={hoveredDuration}
          activeBucketKey={durationBucket}
          onSelectBucket={onSelectBucket}
        />
        <AnomalySummaryPanel
          counts={anomalyCounts}
          totalFlagged={totalFlagged}
          totalActions={totalActions}
          hoveredFlags={hoveredFlags}
          activeType={anomalyTypeFilter}
          onSelectType={onSelectAnomalyType}
          tierByType={tierByType}
        />
      </aside>

      <div className="action-view__main">
        <ActionSummaryTable
          rows={rows}
          headers={headers}
          onOpenWaterfall={onOpenWaterfall}
          onFilteredActionsChange={onFilteredActionsChange}
          byActionKey={byActionKey}
          anomalyTypeFilter={anomalyTypeFilter}
          onHoverAction={onHoverAction}
          onClearAnomalyFilter={onClearAnomalyFilter}
          durationBucketFilter={durationBucketFilter}
          onClearDurationBucket={onClearDurationBucket}
          bands={bands}
          tierByType={tierByType}
        />

        {waterfallOpen && (
          <div ref={panelRef}>
            <ActionWaterfallPanel
              open={waterfallOpen}
              onClose={onCloseWaterfall}
              rows={scopedRows}
              headers={headers}
              actions={waterfallActions}
              initialKey={waterfallInitialKey}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default ActionDataTablePanel
```

- [ ] **Step 2: Verify lint + build**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run build`
Expected: build succeeds. (The component is not yet rendered anywhere — Task 6 wires it. Unused-until-wired is expected.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ActionDataTablePanel.jsx
git commit -m "feat: extract ActionDataTablePanel (rail + table + waterfall)"
```

---

### Task 4: `ActionHeatmapPanel` (extract the Story × Action view)

**Files:**
- Create: `src/components/ActionHeatmapPanel.jsx`

**Interfaces:**
- Consumes: `ActionStoryHeatmap`, `ActionCellDetail` (existing, unchanged); the shared `.action-view-fullscreen` class added to `ActionView.css` in Task 6.
- Produces: `<ActionHeatmapPanel {...} />` — full-width heatmap + in-place cell drill-down. `onSelectCell(story, action)` is called on cell click (ActionView owns the toggle logic).

- [ ] **Step 1: Create the panel**

Create `src/components/ActionHeatmapPanel.jsx`:

```jsx
import ActionStoryHeatmap from './ActionStoryHeatmap'
import ActionCellDetail from './ActionCellDetail'

/**
 * Story × Action view — a full-width p95 heatmap with an in-place cell
 * drill-down beneath it. Presentational; ActionView owns the matrix, the
 * selection, and the cell-toggle logic (passed as onSelectCell).
 */
function ActionHeatmapPanel({
  matrix,
  selectedKey,
  selectedCell,
  selectedCellData,
  onSelectCell,
  scopedRows,
  headers,
  byActionKey,
  tierByType,
  onCloseDetail,
}) {
  return (
    <section className="action-view-fullscreen" aria-label="Story by action heatmap">
      <ActionStoryHeatmap matrix={matrix} selectedKey={selectedKey} onSelectCell={onSelectCell} />
      {selectedCell && selectedCellData && (
        <ActionCellDetail
          story={selectedCell.story}
          action={selectedCell.action}
          cell={selectedCellData}
          rows={scopedRows}
          headers={headers}
          byActionKey={byActionKey}
          tierByType={tierByType}
          onClose={onCloseDetail}
        />
      )}
    </section>
  )
}

export default ActionHeatmapPanel
```

- [ ] **Step 2: Verify lint + build**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run build`
Expected: build succeeds. (Not yet rendered — Task 6 wires it. `.action-view-fullscreen` is styled in Task 6; a missing CSS class does not fail the build.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ActionHeatmapPanel.jsx
git commit -m "feat: extract ActionHeatmapPanel (full-width heatmap + cell detail)"
```

---

### Task 5: `ActionOffsetPanel` (placeholder view)

**Files:**
- Create: `src/components/ActionOffsetPanel.jsx`
- Create: `src/components/ActionOffsetPanel.css`

**Interfaces:**
- Consumes: the shared `.action-view-fullscreen` class (Task 6 CSS).
- Produces: `<ActionOffsetPanel />` — a full-width placeholder. No props, no chart logic (out of scope).

- [ ] **Step 1: Create the panel**

Create `src/components/ActionOffsetPanel.jsx`:

```jsx
import './ActionOffsetPanel.css'

/**
 * Offset vs Duration view — a full-width placeholder for the future scatter
 * chart. Intentionally has no chart logic yet (out of scope for this work).
 */
function ActionOffsetPanel() {
  return (
    <section className="action-view-fullscreen" aria-label="Offset vs duration">
      <div className="action-offset__title">Offset vs Duration</div>
      <div className="action-offset__empty">Chart coming soon</div>
    </section>
  )
}

export default ActionOffsetPanel
```

- [ ] **Step 2: Create the CSS** (ported from the old `.action-chart-placeholder__empty`/`__title`, taller now that it owns the screen)

Create `src/components/ActionOffsetPanel.css`:

```css
.action-offset__title {
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
  color: var(--sap-text);
}

.action-offset__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 16rem;
  border: 1px dashed var(--sap-border);
  border-radius: var(--radius-md);
  background: var(--sap-surface-alt);
  color: var(--sap-text-muted);
  font-size: var(--text-sm);
}
```

- [ ] **Step 3: Verify lint + build**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/ActionOffsetPanel.jsx src/components/ActionOffsetPanel.css
git commit -m "feat: add ActionOffsetPanel placeholder view"
```

---

### Task 6: Rewire `ActionView.jsx` + `ActionView.css` (integration)

**Files:**
- Modify: `src/pages/views/ActionView.jsx`
- Modify: `src/pages/views/ActionView.css`

**Interfaces:**
- Consumes: `resolveActiveView` (Task 1); `ActionViewSwitcher` (Task 2); `ActionDataTablePanel` (Task 3); `ActionHeatmapPanel` (Task 4); `ActionOffsetPanel` (Task 5).
- Produces: the assembled Action view — KPI strip in the header on all views; a switcher bar; the active panel rendered full-screen. No new outward interface.

- [ ] **Step 1: Swap imports**

In `src/pages/views/ActionView.jsx`, replace the child-component imports (lines 2-8) so ActionView no longer imports the components now living inside panels, and imports the new pieces instead. Change:

```javascript
import ActionSummaryTable from '../../components/ActionSummaryTable'
import ActionWaterfallPanel from '../../components/ActionWaterfallPanel'
import KpiStrip from '../../components/KpiStrip'
import DurationDistribution from '../../components/DurationDistribution'
import AnomalySummaryPanel from '../../components/AnomalySummaryPanel'
import ActionStoryHeatmap from '../../components/ActionStoryHeatmap'
import ActionCellDetail from '../../components/ActionCellDetail'
```

to:

```javascript
import KpiStrip from '../../components/KpiStrip'
import ActionViewSwitcher from '../../components/ActionViewSwitcher'
import ActionDataTablePanel from '../../components/ActionDataTablePanel'
import ActionHeatmapPanel from '../../components/ActionHeatmapPanel'
import ActionOffsetPanel from '../../components/ActionOffsetPanel'
```

Then add to the lib imports (near line 16, after the `storyActionMatrix` import):

```javascript
import { resolveActiveView } from '../../lib/actionViews'
```

- [ ] **Step 2: Add `activeView` state, seeded from persistence**

Replace the `activeChartTab` state block (lines 243-253):

```javascript
  const [activeChartTab, setActiveChartTab] = useState(null)
  const chartPanelRef = useRef(null)
  const toggleChart = (key) =>
    setActiveChartTab((prev) => (prev === key ? null : key))
  useEffect(() => {
    if (!activeChartTab) return
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    chartPanelRef.current?.scrollIntoView({ behavior, block: 'start' })
  }, [activeChartTab])
```

with:

```javascript
  // Which of the three top-level views is active. Seeded from (and persisted
  // to) viewUi.action so it survives drilling to Widget view + Back.
  const [activeView, setActiveView] = useState(
    () => resolveActiveView(viewUi.action.activeView),
  )
```

- [ ] **Step 3: Persist `activeView` alongside the existing rail selections**

Update the persistence effect (currently lines 129-131) to include `activeView`:

```javascript
  useEffect(() => {
    setViewUi('action', { anomalyTypeFilter, durationBucket, activeView })
  }, [anomalyTypeFilter, durationBucket, activeView, setViewUi])
```

- [ ] **Step 4: Add the cell-toggle handler** (moved out of the inline JSX)

Just before the `return (` (after the existing `openWaterfallFor` / waterfall scroll effect, near line 237), add:

```javascript
  // Toggle the heatmap cell drill-down: clicking the open cell closes it.
  const handleSelectCell = (story, action) =>
    setSelectedCell((prev) =>
      prev && prev.story === story && prev.action === action ? null : { story, action },
    )
```

- [ ] **Step 5: Replace the returned JSX**

Replace the entire `return ( ... )` (currently lines 255-367) with:

```jsx
  return (
    <>
      <HeaderPortal>
        <KpiStrip variant="action" kpis={kpis} columns={kpis.length} />
      </HeaderPortal>

      <div className="action-view-shell">
        <ActionViewSwitcher activeView={activeView} onChange={setActiveView} />

        {activeView === 'table' && (
          <ActionDataTablePanel
            durations={durations}
            bands={bands}
            hoveredDuration={hoveredDuration}
            durationBucket={durationBucket}
            onSelectBucket={selectDurationBucket}
            anomalyCounts={filteredSummary.counts}
            totalFlagged={filteredSummary.totalFlagged}
            totalActions={filteredSummary.totalActions}
            hoveredFlags={hoveredFlags}
            anomalyTypeFilter={anomalyTypeFilter}
            onSelectAnomalyType={selectAnomalyType}
            tierByType={tierByType}
            rows={rows}
            headers={headers}
            onOpenWaterfall={openWaterfallFor}
            onFilteredActionsChange={setFilteredActionRows}
            byActionKey={anomalies.byActionKey}
            onHoverAction={setHoveredActionKey}
            onClearAnomalyFilter={() => setAnomalyTypeFilter(null)}
            durationBucketFilter={durationBucketFilter}
            onClearDurationBucket={() => setDurationBucket(null)}
            waterfallOpen={waterfallOpen}
            waterfallActions={waterfallActions}
            waterfallInitialKey={waterfallInitialKey}
            scopedRows={scopedRows}
            onCloseWaterfall={() => setWaterfallOpen(false)}
            panelRef={panelRef}
          />
        )}

        {activeView === 'heatmap' && (
          <ActionHeatmapPanel
            matrix={storyActionMatrix}
            selectedKey={selectedCellKey}
            selectedCell={selectedCell}
            selectedCellData={selectedCellData}
            onSelectCell={handleSelectCell}
            scopedRows={scopedRows}
            headers={headers}
            byActionKey={anomalies.byActionKey}
            tierByType={tierByType}
            onCloseDetail={() => setSelectedCell(null)}
          />
        )}

        {activeView === 'offset' && <ActionOffsetPanel />}
      </div>
    </>
  )
```

- [ ] **Step 6: Remove now-unused `useRef` if applicable**

`panelRef` still uses `useRef` (kept for the waterfall scroll). `chartPanelRef` was removed in Step 2. Confirm `useRef` is still imported (it is — `panelRef` needs it). Run `npm run lint` and remove any import oxlint now flags as unused (e.g., if any of `useEffect`/`useMemo`/`useRef`/`useState` became unused — they should all still be used).

- [ ] **Step 7: Update `ActionView.css`**

In `src/pages/views/ActionView.css`:

1. **Remove** the chart-tab strip and placeholder rules — everything from the `/* Chart-shortcut header tabs ... */` comment (line 35) through the end of the file: `.action-chart-tabs`, `.action-chart-tab`, `.action-chart-tab:hover`, `.action-chart-tab.is-active`, `.action-chart-tab:focus-visible`, `.action-chart-placeholder`, `.action-chart-placeholder__title`, `.action-chart-placeholder__empty`.

2. **Keep** the `.action-view` grid + `.action-view__rail` + `.action-view__main` + the `@media (max-width: 1100px)` block (lines 1-33) — the Data Table panel uses them unchanged.

3. **Add** at the end of the file:

```css
/* The Action view shell wraps the top switcher bar and whichever panel is
   active. The switcher owns its own bottom spacing. */
.action-view-shell {
  min-width: 0;
}

/* Full-width canvas for the Story × Action and Offset vs Duration views — no
   rail, so the chart fills the page for readability. */
.action-view-fullscreen {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
```

- [ ] **Step 8: Verify lint + build**

Run: `npm run lint`
Expected: no errors (no unused imports/vars left behind).

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 9: Full test run**

Run: `npm run test:run`
Expected: all suites pass — the prior 316 plus the 4 new `actionViews` tests (320 total), none broken.

- [ ] **Step 10: Manual visual check**

Run: `npm run dev`, open the Action view. Confirm:
- A SegmentedButton with **Data Table / Story × Action / Offset vs Duration**; **Data Table** selected on load.
- **Data Table**: unchanged — left rail (histogram + anomaly summary) + table; row filters, hover, anomaly/bucket click-to-filter, and the inline waterfall (row icon) all still work.
- **Story × Action**: full-width heatmap with no rail; clicking a cell opens the drill-down beneath; clicking the same cell (or its close) collapses it.
- **Offset vs Duration**: full-width "Chart coming soon" placeholder.
- **KPI strip** stays in the header on all three views.
- Switch to Story × Action, drill into a Widget (from the table view's flow if applicable) and Back — the view selection is restored. Simpler check: switch to a view, reload via in-app nav that preserves `viewUi`, confirm it persists.

- [ ] **Step 11: Commit**

```bash
git add src/pages/views/ActionView.jsx src/pages/views/ActionView.css
git commit -m "feat: switch ActionView to three full-screen views via SegmentedButton"
```

---

## Self-Review

**Spec coverage:**
- Switcher (SegmentedButton, three views) → Tasks 1 + 2 + 6. ✅
- Data Table view (rail + table + waterfall) → Task 3, wired in 6. ✅
- Story × Action full-screen (heatmap + cell detail, no rail) → Task 4 + `.action-view-fullscreen` in 6. ✅
- Offset placeholder full-screen → Task 5. ✅
- `activeView` persistence in `viewUi.action` + default `'table'` → Tasks 1 + 6. ✅
- KPI strip on all views → Task 6 Step 5 (in `HeaderPortal`, ungated). ✅
- Remove old text-tab strip + scroll-into-view + placeholder CSS → Task 6 Steps 2 + 7. ✅

**Placeholder scan:** The only "placeholder" is the intentional Offset view (per spec/YAGNI). No TBD/TODO/vague steps; every code step shows complete code. ✅

**Type consistency:** View keys `'table'|'heatmap'|'offset'` used identically in Tasks 1, 2, 6. Panel prop names in Task 3/4 match exactly what Task 6 passes (rail: `anomalyCounts`/`onSelectAnomalyType`/`onSelectBucket`; heatmap: `onSelectCell`/`onCloseDetail`/`selectedCellData`). `resolveActiveView`, `isActionViewKey`, `ACTION_VIEWS` names consistent between Task 1 producer and Task 2/6 consumers. ✅

**Testing reality:** All automated tests are pure `.test.js` (Task 1) matching the node-env harness; component tasks verified by lint + build + the Task 6 manual check. No RTL/jsdom introduced. ✅
