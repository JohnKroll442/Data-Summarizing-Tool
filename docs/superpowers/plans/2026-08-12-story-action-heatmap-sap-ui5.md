# Story × Action Heatmap Drill-Down — SAP UI5 Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the drill-down beneath the Story × Action heatmap match the SAP reference screenshot using `@ui5/webcomponents-react` components — a SAP `List` instance list and a rich SAP card header on the waterfall panel — and recolor the waterfall bars by phase so the header's phase legend matches the bars.

**Architecture:** Three cohesive changes. (1) `actionSequence.js` gains a phase→color map and a shared `PHASE_LEGEND`, and colors bars by phase group instead of Local/Remote. (2) `ActionCellDetail` swaps its hand-rolled `<ul>` list for a SAP `List` + `ListItemCustom` with `ObjectStatus` (duration) and `Tag` (tier badges). (3) `ActionWaterfallPanel` replaces its `<h2>` with a SAP header (breadcrumb `Title` · metadata `Text` · phase legend chips · `View` `Button`), fed by an enriched `actions[]` array. Pure mapping/resolver helpers are extracted so the logic is unit-tested; the JSX is verified by lint + build + visual check.

**Tech Stack:** React 19, `@ui5/webcomponents-react` ^2.25.0 (per-component import paths, e.g. `@ui5/webcomponents-react/Button`), ECharts via `echarts-for-react`, Vitest + jsdom for tests, oxlint for lint.

## Global Constraints

- UI5 React components are imported per-component: `import { X } from '@ui5/webcomponents-react/X'` (verbatim style used across the repo).
- Tests run with Vitest: `npm run test:run` (single run) or target one file: `npx vitest run <path>`.
- Lint: `npm run lint` (oxlint). Build: `npm run build` (vite).
- The waterfall panel receives **raw CSV rows** + `headers` and derives its chart internally; story/user/duration for the header come from the caller-supplied `actions[]` entries, NOT from the raw rows.
- Phase palette (SAP-aligned, reproduces the screenshot): `offset #8396a8`, `backend #0070f2`, `network #e35b2a`, `render #0f828f`.
- Legend has exactly four categories: `Offset`, `Backend`, `Network wait`, `Render` (the three network sub-phases collapse into one `network` group).
- No behavior removed: existing callers keep working; the "View" button maps to the existing `onClose`.

---

### Task 1: Phase color map + legend + `phaseGroupOf` in actionSequence

**Files:**
- Modify: `src/components/charts/options/actionSequence.js`
- Test: `src/components/charts/options/__tests__/actionSequence.test.js` (create)

**Interfaces:**
- Produces:
  - `PHASE_COLORS: { offset: string, backend: string, network: string, render: string }`
  - `PHASE_LEGEND: Array<{ key: string, label: string, color: string }>` — four entries, keys `offset|backend|network|render`, labels `Offset|Backend|Network wait|Render`.
  - `phaseGroupOf(phaseKey: string) => 'offset'|'backend'|'network'|'render'` — maps any `PHASE_ORDER` key (incl. `network-full|network-wait|network-cdn`) to its group.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Create `src/components/charts/options/__tests__/actionSequence.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import {
  PHASE_COLORS,
  PHASE_LEGEND,
  phaseGroupOf,
} from '../actionSequence'

describe('phaseGroupOf', () => {
  it('maps base phase keys to their own group', () => {
    expect(phaseGroupOf('offset')).toBe('offset')
    expect(phaseGroupOf('backend')).toBe('backend')
    expect(phaseGroupOf('render')).toBe('render')
  })

  it('collapses every network sub-phase into the network group', () => {
    expect(phaseGroupOf('network-full')).toBe('network')
    expect(phaseGroupOf('network-wait')).toBe('network')
    expect(phaseGroupOf('network-cdn')).toBe('network')
  })
})

describe('PHASE_LEGEND', () => {
  it('has the four screenshot categories with matching colors', () => {
    expect(PHASE_LEGEND.map((p) => p.key)).toEqual([
      'offset',
      'backend',
      'network',
      'render',
    ])
    expect(PHASE_LEGEND.map((p) => p.label)).toEqual([
      'Offset',
      'Backend',
      'Network wait',
      'Render',
    ])
    for (const entry of PHASE_LEGEND) {
      expect(entry.color).toBe(PHASE_COLORS[entry.key])
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/charts/options/__tests__/actionSequence.test.js`
Expected: FAIL — `PHASE_COLORS`/`PHASE_LEGEND`/`phaseGroupOf` are not exported.

- [ ] **Step 3: Add the exports to actionSequence.js**

In `src/components/charts/options/actionSequence.js`, replace the two color consts near the top:

```javascript
const REMOTE = '#e35b2a' // orange — matches the SAP reference "Remote" swatch
const LOCAL  = SAP_BLUE
```

with the phase palette + legend + group helper:

```javascript
// Per-phase colors — the four categories shown in the waterfall header legend.
// The three network sub-phases share the single `network` color.
export const PHASE_COLORS = {
  offset:  '#8396a8', // muted grey-blue
  backend: '#0070f2', // SAP blue
  network: '#e35b2a', // orange
  render:  '#0f828f', // teal — distinct from backend blue
}

// Legend categories, in chart order, labeled to match the SAP reference.
export const PHASE_LEGEND = [
  { key: 'offset',  label: 'Offset',       color: PHASE_COLORS.offset },
  { key: 'backend', label: 'Backend',      color: PHASE_COLORS.backend },
  { key: 'network', label: 'Network wait', color: PHASE_COLORS.network },
  { key: 'render',  label: 'Render',       color: PHASE_COLORS.render },
]

// Map any PHASE_ORDER key to its legend group. network-full/wait/cdn → network.
export function phaseGroupOf(phaseKey) {
  return String(phaseKey).startsWith('network') ? 'network' : String(phaseKey)
}
```

Note: `SAP_BLUE` is still imported and used elsewhere in the file (legend of other charts / nothing here now) — leave the import; if oxlint flags it as unused after Task 1's later steps, remove it in Step 5 of Task 2 wiring. (It is used by `PHASE_COLORS.backend`'s sibling nowhere else in this file after recolor; keep the import only if still referenced — see Step 4.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/charts/options/__tests__/actionSequence.test.js`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/components/charts/options/actionSequence.js src/components/charts/options/__tests__/actionSequence.test.js
git commit -m "feat: add phase color map + legend to actionSequence"
```

---

### Task 2: Recolor waterfall bars by phase; drop Local/Remote legend

**Files:**
- Modify: `src/components/charts/options/actionSequence.js`
- Test: `src/components/charts/options/__tests__/actionSequence.test.js` (extend)

**Interfaces:**
- Consumes: `PHASE_COLORS`, `phaseGroupOf` (Task 1).
- Produces: `buildActionSequenceOption(actionRows)` returns an option whose `duration` series bars are colored by phase group, with NO `legend` key and NO `Local`/`Remote` marker series. Each bar `data` object carries `phaseGroup: 'offset'|'backend'|'network'|'render'` and `legendLabel: string`.

- [ ] **Step 1: Write the failing test**

Extend `src/components/charts/options/__tests__/actionSequence.test.js` with a small synthetic dataset. Add at the top:

```javascript
import { buildActionSequenceOption } from '../actionSequence'

// One widget with an offset, a backend, a network-wait, and a render row.
const sampleRows = [
  { WIDGET_ID: 'w1', WIDGET_NAME: 'Widget A', WIDGET_MEASURE: 'offset',  DURATION: 100 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'Widget A', WIDGET_MEASURE: 'backend', DURATION: 200 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'Widget A', WIDGET_MEASURE: 'network', WIDGET_SUBMEASURE: 'waiting', DURATION: 150 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'Widget A', WIDGET_MEASURE: 'render',  DURATION: 300 },
]
```

and a describe block:

```javascript
describe('buildActionSequenceOption phase coloring', () => {
  it('colors each bar by its phase group and drops the Local/Remote legend', () => {
    const opt = buildActionSequenceOption(sampleRows)
    // No built-in ECharts legend anymore — the header owns the legend.
    expect(opt.legend).toBeUndefined()
    // No invisible Local/Remote marker series.
    const seriesNames = opt.series.map((s) => s.name)
    expect(seriesNames).not.toContain('Local')
    expect(seriesNames).not.toContain('Remote')
    expect(seriesNames).toContain('duration')

    const duration = opt.series.find((s) => s.name === 'duration')
    const colors = duration.data.map((d) => d.itemStyle.color)
    // All four phase colors present among the bars.
    expect(colors).toContain(PHASE_COLORS.offset)
    expect(colors).toContain(PHASE_COLORS.backend)
    expect(colors).toContain(PHASE_COLORS.network)
    expect(colors).toContain(PHASE_COLORS.render)
    // Bars carry their phase group.
    const groups = duration.data.map((d) => d.phaseGroup).sort()
    expect(groups).toEqual(['backend', 'network', 'offset', 'render'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/charts/options/__tests__/actionSequence.test.js`
Expected: FAIL — bars still colored via `LOCAL`/`REMOTE`; `opt.legend` still defined; `Local`/`Remote` marker series still present.

- [ ] **Step 3: Recolor bars and remove the legend + marker series**

In `buildActionSequenceOption`, inside the phase loop, replace:

```javascript
      const color = phase.kind === 'local' ? LOCAL : REMOTE
```

with:

```javascript
      const group = phaseGroupOf(phase.key)
      const color = PHASE_COLORS[group]
      const legendLabel = phase.key.startsWith('network')
        ? 'Network wait'
        : phase.label
```

Then in the `durationData.push({ ... })` object, replace the `kind` field:

```javascript
        kind: phase.kind === 'local' ? 'Local' : 'Remote',
```

with:

```javascript
        phaseGroup: group,
        legendLabel,
```

Update the tooltip `Type:` line — replace:

```javascript
          `Type: ${escape(d.kind)}`,
```

with:

```javascript
          `Type: ${escape(d.legendLabel)}`,
```

Remove the `legend` block from the returned option (delete the entire):

```javascript
    legend: {
      top: 8,
      left: 'center',
      data: [
        { name: 'Local',  icon: 'rect', itemStyle: { color: LOCAL } },
        { name: 'Remote', icon: 'rect', itemStyle: { color: REMOTE } },
      ],
      textStyle: { color: '#1d2d3e', fontSize: f.legend },
    },
```

Remove the two invisible marker series (delete both objects):

```javascript
      {
        name: 'Local',
        type: 'bar',
        stack: 'seq',
        data: [],
        itemStyle: { color: LOCAL },
      },
      {
        name: 'Remote',
        type: 'bar',
        stack: 'seq',
        data: [],
        itemStyle: { color: REMOTE },
      },
```

(The `// Real data lives on the "duration" series...` comment above them goes too.)

Reduce the top gap the legend used — change:

```javascript
    grid: { ...BASE_GRID, left: 288, right: 96, top: 76, bottom: 56 },
```

to:

```javascript
    grid: { ...BASE_GRID, left: 288, right: 96, top: 44, bottom: 56 },
```

If oxlint now reports `SAP_BLUE` as unused (it was only used by `LOCAL`), remove it from the import at the top of the file. `SAP_TEXT_MUTED` is still used by `emptyOption`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/charts/options/__tests__/actionSequence.test.js`
Expected: PASS (all three describe blocks).

Then lint: `npm run lint`
Expected: no new errors in `actionSequence.js`.

- [ ] **Step 5: Commit**

```bash
git add src/components/charts/options/actionSequence.js src/components/charts/options/__tests__/actionSequence.test.js
git commit -m "feat: color waterfall bars by phase, remove Local/Remote legend"
```

---

### Task 3: SAP status/design mapping helpers

**Files:**
- Create: `src/lib/sapStatus.js`
- Test: `src/lib/__tests__/sapStatus.test.js` (create)

**Interfaces:**
- Produces:
  - `objectStatusStateForDurationTier(tier: 'good'|'neutral'|'watch'|'warn'|'bad'|null) => 'Positive'|'Critical'|'Negative'|'None'`
  - `tagDesignForAnomalyTier(tier: 1|2|3|any) => 'Negative'|'Critical'|'Information'|'Neutral'`
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/sapStatus.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import {
  objectStatusStateForDurationTier,
  tagDesignForAnomalyTier,
} from '../sapStatus'

describe('objectStatusStateForDurationTier', () => {
  it('maps duration tiers to ObjectStatus states', () => {
    expect(objectStatusStateForDurationTier('good')).toBe('Positive')
    expect(objectStatusStateForDurationTier('neutral')).toBe('Critical')
    expect(objectStatusStateForDurationTier('watch')).toBe('Critical')
    expect(objectStatusStateForDurationTier('warn')).toBe('Critical')
    expect(objectStatusStateForDurationTier('bad')).toBe('Negative')
  })

  it('falls back to None for null/unknown', () => {
    expect(objectStatusStateForDurationTier(null)).toBe('None')
    expect(objectStatusStateForDurationTier('nope')).toBe('None')
  })
})

describe('tagDesignForAnomalyTier', () => {
  it('maps anomaly tiers 1/2/3 to Tag designs', () => {
    expect(tagDesignForAnomalyTier(1)).toBe('Negative')
    expect(tagDesignForAnomalyTier(2)).toBe('Critical')
    expect(tagDesignForAnomalyTier(3)).toBe('Information')
  })

  it('falls back to Neutral for anything else', () => {
    expect(tagDesignForAnomalyTier(0)).toBe('Neutral')
    expect(tagDesignForAnomalyTier(undefined)).toBe('Neutral')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/sapStatus.test.js`
Expected: FAIL — module `../sapStatus` not found.

- [ ] **Step 3: Write the helpers**

Create `src/lib/sapStatus.js`:

```javascript
/**
 * Small mappings from this app's internal severity tiers to SAP UI5 component
 * props, kept pure + separate so they can be unit-tested and reused.
 */

// Duration health tier (from durationBands.durationTier) → ObjectStatus `state`.
export function objectStatusStateForDurationTier(tier) {
  switch (tier) {
    case 'good':
      return 'Positive'
    case 'neutral':
    case 'watch':
    case 'warn':
      return 'Critical'
    case 'bad':
      return 'Negative'
    default:
      return 'None'
  }
}

// Anomaly rank tier (1 loudest … 3 quietest) → Tag `design`.
export function tagDesignForAnomalyTier(tier) {
  switch (tier) {
    case 1:
      return 'Negative'
    case 2:
      return 'Critical'
    case 3:
      return 'Information'
    default:
      return 'Neutral'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/sapStatus.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sapStatus.js src/lib/__tests__/sapStatus.test.js
git commit -m "feat: add SAP status/design tier mapping helpers"
```

---

### Task 4: `ActionCellDetail` — SAP `List` instance list

**Files:**
- Modify: `src/components/ActionCellDetail.jsx`
- Modify: `src/components/ActionCellDetail.css`

**Interfaces:**
- Consumes: `objectStatusStateForDurationTier`, `tagDesignForAnomalyTier` (Task 3); `durationTier` (`../lib/durationBands`); `formatCsvTime`, `formatDurationMs` (`../lib/format`).
- Produces: unchanged component props/behavior (`selectedIdx` still drives the waterfall); only the list rendering + waterfall `actions` enrichment change (enrichment detailed in Task 5).

- [ ] **Step 1: Update imports in ActionCellDetail.jsx**

At the top of `src/components/ActionCellDetail.jsx`, add the UI5 + helper imports (keep the existing `useEffect/useMemo/useState`, `X` from lucide, `ActionWaterfallPanel`, `durationTier`, `formatCsvTime/formatDurationMs`, css import). Remove the `TierBadge` import (replaced by `Tag`):

```javascript
import { List } from '@ui5/webcomponents-react/List'
import { ListItemCustom } from '@ui5/webcomponents-react/ListItemCustom'
import { ObjectStatus } from '@ui5/webcomponents-react/ObjectStatus'
import { Tag } from '@ui5/webcomponents-react/Tag'
import { objectStatusStateForDurationTier, tagDesignForAnomalyTier } from '../lib/sapStatus'
```

Delete the line:

```javascript
import TierBadge from './TierBadge'
```

- [ ] **Step 2: Replace the `<ul>` list with a SAP `List`**

In the returned JSX, replace the whole `<ul className="cell-detail__list">…</ul>` block:

```jsx
        <ul className="cell-detail__list" aria-label="Action instances">
          {instances.map((inst, i) => {
            const tiers = distinctTiers(flagsFor(inst), tierByType)
            const tier = durationTier(inst.action_duration)
            const active = i === selectedIdx
            return (
              <li key={`${inst._action_timestamp ?? ''}-${i}`}>
                <button
                  type="button"
                  className={`cell-detail__item${active ? ' is-active' : ''}`}
                  onClick={() => setSelectedIdx(i)}
                >
                  <span className={`cell-detail__dur cell-detail__dur--${tier ?? 'neutral'}`}>
                    {formatDurationMs(inst.action_duration) || '—'}
                  </span>
                  <span className="cell-detail__meta">
                    <span className="cell-detail__user">{inst.user || '—'}</span>
                    <span className="cell-detail__ts">{formatCsvTime(inst._action_timestamp)}</span>
                  </span>
                  {tiers.length > 0 && (
                    <span className="cell-detail__badges">
                      {tiers.map((t) => (
                        <TierBadge key={t} tier={t} />
                      ))}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
```

with a SAP `List` (scroll container className kept for CSS):

```jsx
        <List
          className="cell-detail__list"
          selectionMode="SingleEnd"
          separators="Inner"
          accessibleName="Action instances"
        >
          {instances.map((inst, i) => {
            const tiers = distinctTiers(flagsFor(inst), tierByType)
            const tier = durationTier(inst.action_duration)
            return (
              <ListItemCustom
                key={`${inst._action_timestamp ?? ''}-${i}`}
                type="Active"
                selected={i === selectedIdx}
                onClick={() => setSelectedIdx(i)}
              >
                <div className="cell-detail__row">
                  <ObjectStatus large state={objectStatusStateForDurationTier(tier)}>
                    {formatDurationMs(inst.action_duration) || '—'}
                  </ObjectStatus>
                  <div className="cell-detail__meta">
                    <span className="cell-detail__user">{inst.user || '—'}</span>
                    <span className="cell-detail__ts">{formatCsvTime(inst._action_timestamp)}</span>
                  </div>
                  {tiers.length > 0 && (
                    <div className="cell-detail__badges">
                      {tiers.map((t) => (
                        <Tag key={t} design={tagDesignForAnomalyTier(t)}>{`T${t}`}</Tag>
                      ))}
                    </div>
                  )}
                </div>
              </ListItemCustom>
            )
          })}
        </List>
```

(`distinctTiers`, `flagsFor`, `num` helpers and the rest of the component are unchanged.)

- [ ] **Step 3: Update ActionCellDetail.css**

In `src/components/ActionCellDetail.css`, replace the list/item styling. Delete these rules entirely: `.cell-detail__item`, `.cell-detail__item:hover`, `.cell-detail__item:focus-visible`, `.cell-detail__item.is-active`, `.cell-detail__dur`, `.cell-detail__dur--good/neutral/watch/warn/bad`.

Change `.cell-detail__list` from a `<ul>` reset to a scroll container for the `List`:

```css
.cell-detail__list {
  max-height: 32rem;
  overflow-y: auto;
  border-right: 1px solid var(--color-border-subtle);
  background: var(--sap-surface);
}
```

Add a flex row for the custom item content (duration | meta | badges):

```css
.cell-detail__row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  min-width: 0;
}

.cell-detail__row .cell-detail__meta {
  flex: 1 1 auto;
}

.cell-detail__row .cell-detail__badges {
  flex: none;
  margin-top: 0;
}
```

Keep the existing `.cell-detail__meta`, `.cell-detail__user`, `.cell-detail__ts`, `.cell-detail__badges` rules (they still apply), but the `grid-column` values on `__meta`/`__badges` are now inert inside a flex row — leave them; they do no harm. In the `@media (max-width: 60rem)` block, `.cell-detail__list` loses `border-right`/gains `border-bottom` as before — that rule is unchanged and still valid.

- [ ] **Step 4: Verify lint + build**

Run: `npm run lint`
Expected: no new errors in `ActionCellDetail.jsx`.

Run: `npm run build`
Expected: build succeeds (no unresolved imports; `TierBadge` no longer referenced here).

- [ ] **Step 5: Commit**

```bash
git add src/components/ActionCellDetail.jsx src/components/ActionCellDetail.css
git commit -m "feat: render ActionCellDetail instance list with SAP List/ObjectStatus/Tag"
```

---

### Task 5: `ActionWaterfallPanel` — header metadata resolver

**Files:**
- Create: `src/lib/actionWaterfallMeta.js`
- Test: `src/lib/__tests__/actionWaterfallMeta.test.js` (create)

**Interfaces:**
- Produces: `resolveHeaderMeta({ actions, selectedIdx, meta, widgetCount }) => { actionName, story, user, timestamp, durationMs, widgetCount }`.
  - Reads the selected entry `actions[selectedIdx]` (shape `{ name, timestamp, label, story?, user?, durationMs? }`), falling back field-by-field to the optional `meta` prop, then to sensible defaults (`''` for strings, `undefined` for `durationMs`, `0` for `widgetCount`).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/actionWaterfallMeta.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import { resolveHeaderMeta } from '../actionWaterfallMeta'

describe('resolveHeaderMeta', () => {
  it('reads fields off the selected enriched action entry', () => {
    const actions = [
      { name: 'Go to page', timestamp: '10:03:03', story: 'LS_OPEX', user: 'Z_ATAMAN', durationMs: 1200 },
    ]
    const m = resolveHeaderMeta({ actions, selectedIdx: 0, widgetCount: 3 })
    expect(m).toEqual({
      actionName: 'Go to page',
      story: 'LS_OPEX',
      user: 'Z_ATAMAN',
      timestamp: '10:03:03',
      durationMs: 1200,
      widgetCount: 3,
    })
  })

  it('falls back to the meta prop when the entry omits a field', () => {
    const actions = [{ name: 'Go to page', timestamp: '10:03:03' }]
    const m = resolveHeaderMeta({
      actions,
      selectedIdx: 0,
      meta: { story: 'S1', user: 'U1', durationMs: 900 },
      widgetCount: 1,
    })
    expect(m.story).toBe('S1')
    expect(m.user).toBe('U1')
    expect(m.durationMs).toBe(900)
    expect(m.actionName).toBe('Go to page')
    expect(m.timestamp).toBe('10:03:03')
  })

  it('defaults safely when nothing is available', () => {
    const m = resolveHeaderMeta({ actions: [], selectedIdx: 0 })
    expect(m).toEqual({
      actionName: '',
      story: '',
      user: '',
      timestamp: '',
      durationMs: undefined,
      widgetCount: 0,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/actionWaterfallMeta.test.js`
Expected: FAIL — module `../actionWaterfallMeta` not found.

- [ ] **Step 3: Write the resolver**

Create `src/lib/actionWaterfallMeta.js`:

```javascript
/**
 * Resolve the metadata shown in the ActionWaterfallPanel's rich header.
 *
 * The panel selects an action by index; each `actions[]` entry may be enriched
 * by the caller with story/user/durationMs. Fields are read off the selected
 * entry first, then fall back to an optional top-level `meta` prop, then to
 * safe defaults. `widgetCount` is supplied by the panel (derived from its own
 * charted widgets), not from the entry.
 */
export function resolveHeaderMeta({ actions, selectedIdx, meta, widgetCount } = {}) {
  const sel = actions?.[selectedIdx] ?? null
  const str = (a, b) => {
    if (a != null && a !== '') return a
    if (b != null && b !== '') return b
    return ''
  }
  const durationMs =
    sel?.durationMs != null ? sel.durationMs : meta?.durationMs
  return {
    actionName: str(sel?.name, meta?.actionName),
    story: str(sel?.story, meta?.story),
    user: str(sel?.user, meta?.user),
    timestamp: str(sel?.timestamp, meta?.timestamp),
    durationMs,
    widgetCount: Number.isFinite(widgetCount) ? widgetCount : 0,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/actionWaterfallMeta.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actionWaterfallMeta.js src/lib/__tests__/actionWaterfallMeta.test.js
git commit -m "feat: add resolveHeaderMeta for the waterfall panel header"
```

---

### Task 6: `ActionWaterfallPanel` — rich SAP header

**Files:**
- Modify: `src/components/ActionWaterfallPanel.jsx`
- Modify: `src/components/ActionWaterfallPanel.css`

**Interfaces:**
- Consumes: `resolveHeaderMeta` (Task 5); `PHASE_LEGEND` (Task 1); `formatCsvTime`, `formatDurationMs` (`../lib/format`); UI5 `Title`, `Text`, `Button`.
- Produces: `ActionWaterfallPanel` accepts a new optional prop `meta` (see Task 5 shape). The header renders breadcrumb title · metadata line · phase legend · `View` button. The picker/stepper toolbar and body are unchanged.

- [ ] **Step 1: Update imports + signature in ActionWaterfallPanel.jsx**

At the top of `src/components/ActionWaterfallPanel.jsx`, add:

```javascript
import { Title } from '@ui5/webcomponents-react/Title'
import { Text } from '@ui5/webcomponents-react/Text'
import { Button } from '@ui5/webcomponents-react/Button'
import { PHASE_LEGEND, detectMapping } from './charts/options/actionSequence'
import { resolveHeaderMeta } from '../lib/actionWaterfallMeta'
import { formatCsvTime, formatDurationMs } from '../lib/format'
```

Note: `detectMapping` is already imported on the existing line `import { buildActionSequenceOption, detectMapping } from './charts/options/actionSequence'` — merge the new named imports into that existing import instead of duplicating (keep one import line for that module). Add `PHASE_LEGEND` there.

Change the component signature to accept `meta`:

```javascript
function ActionWaterfallPanel({ open, onClose, rows, headers, actions, initialKey, meta }) {
```

- [ ] **Step 2: Compute header meta before the return**

Just before the final `return (` (after `chartHeight` is computed, still inside the component), add:

```javascript
  const headerMeta = resolveHeaderMeta({
    actions,
    selectedIdx,
    meta,
    widgetCount: actionWidgets.length,
  })
  const crumb = [
    headerMeta.actionName,
    headerMeta.story,
    formatCsvTime(headerMeta.timestamp),
    headerMeta.user,
  ]
    .filter(Boolean)
    .join('  ·  ')
  const totalLabel = `Total: ${formatDurationMs(headerMeta.durationMs) || '—'} · ${headerMeta.widgetCount} widget${headerMeta.widgetCount === 1 ? '' : 's'}`
```

- [ ] **Step 3: Replace the `<header>` block**

Replace the existing header:

```jsx
      <header className="action-waterfall-header">
        <h2 id="action-waterfall-title">Action Waterfall Chart</h2>
        <button
          type="button"
          className="action-waterfall-close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </header>
```

with the rich header:

```jsx
      <header className="action-waterfall-rich-header">
        <div className="awf-header__top">
          <Title level="H5" size="H5" className="awf-header__crumb" id="action-waterfall-title">
            {crumb || 'Action Waterfall Chart'}
          </Title>
          <Button design="Transparent" onClick={onClose}>
            View
          </Button>
        </div>
        <Text className="awf-header__meta">{totalLabel}</Text>
        <div className="awf-header__legend" aria-label="Phase legend">
          {PHASE_LEGEND.map((p) => (
            <span className="awf-legend__item" key={p.key}>
              <span className="awf-legend__swatch" style={{ background: p.color }} />
              <Text className="awf-legend__label">{p.label}</Text>
            </span>
          ))}
        </div>
      </header>
```

The `X` import from lucide-react may now be unused in this file — if oxlint flags it, remove `X` from the `import { ChevronLeft, ChevronRight, X } from 'lucide-react'` line (keep `ChevronLeft`, `ChevronRight`, which the stepper still uses).

- [ ] **Step 4: Update ActionWaterfallPanel.css**

In `src/components/ActionWaterfallPanel.css`, remove the old `.action-waterfall-header` and `.action-waterfall-close` (and any `:hover`/`:focus` variants) rules. Add:

```css
.action-waterfall-rich-header {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--sap-surface-alt);
}

.awf-header__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.awf-header__crumb {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.awf-header__meta {
  color: var(--sap-text-muted);
  font-size: var(--text-sm);
}

.awf-header__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  align-items: center;
}

.awf-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.awf-legend__swatch {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 2px;
  flex: none;
}

.awf-legend__label {
  font-size: var(--text-sm);
  color: var(--sap-text);
}
```

- [ ] **Step 5: Verify lint + build, then commit**

Run: `npm run lint`
Expected: no new errors in `ActionWaterfallPanel.jsx`.

Run: `npm run build`
Expected: build succeeds.

```bash
git add src/components/ActionWaterfallPanel.jsx src/components/ActionWaterfallPanel.css
git commit -m "feat: rich SAP header for ActionWaterfallPanel with phase legend"
```

---

### Task 7: Wire `meta`/enriched actions from both call sites

**Files:**
- Modify: `src/components/ActionCellDetail.jsx`
- Modify: `src/pages/views/ActionView.jsx`

**Interfaces:**
- Consumes: `ActionWaterfallPanel`'s `meta` prop + enriched `actions[]` (Task 6); `resolveHeaderMeta` semantics (Task 5).
- Produces: both panels show the rich header populated with story/user/timestamp/duration.

- [ ] **Step 1: ActionCellDetail — enrich the single waterfall action + pass meta**

In `src/components/ActionCellDetail.jsx`, replace the `waterfallActions` memo:

```javascript
  const waterfallActions = useMemo(
    () => (selected ? [{ name: action, timestamp: selectedTs, label: `${action}` }] : []),
    [action, selectedTs, selected],
  )
```

with an enriched entry (story/user/durationMs come from the selected instance + the cell's story):

```javascript
  const waterfallActions = useMemo(
    () =>
      selected
        ? [
            {
              name: action,
              timestamp: selectedTs,
              label: `${action}`,
              story,
              user: selected.user,
              durationMs: selected.action_duration,
            },
          ]
        : [],
    [action, selectedTs, selected, story],
  )
```

Then in the JSX where `ActionWaterfallPanel` is rendered, add the `meta` prop as a belt-and-suspenders fallback (the enriched entry already carries these, but `meta` guarantees the header populates even if the entry shape changes):

```jsx
            <ActionWaterfallPanel
              open
              onClose={onClose}
              rows={rows}
              headers={headers}
              actions={waterfallActions}
              initialKey={selectedKey}
              meta={{
                actionName: action,
                story,
                user: selected?.user,
                timestamp: selectedTs,
                durationMs: selected?.action_duration,
              }}
            />
```

- [ ] **Step 2: ActionView — enrich the below-table waterfall actions**

In `src/pages/views/ActionView.jsx`, update the `waterfallActions` memo (currently maps `bucketedRows` to `{ name, timestamp, label }`) to also carry story/user/durationMs:

```javascript
  const waterfallActions = useMemo(
    () =>
      bucketedRows.map((r) => ({
        name: r.action_name,
        timestamp: r._action_timestamp ?? '',
        label: r._action_timestamp
          ? `${r.action_name} — ${r._action_timestamp}`
          : String(r.action_name),
        story: r.story_name,
        user: r.user,
        durationMs: r.action_duration,
      })),
    [bucketedRows],
  )
```

No change is needed at the `ActionWaterfallPanel` call site in `ActionView.jsx` — the enriched `actions` array is enough for `resolveHeaderMeta` (the panel reads the selected entry). The header stays correct as the user steps through actions with the ‹ › stepper.

- [ ] **Step 3: Verify lint + build**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Full test run**

Run: `npm run test:run`
Expected: all tests pass (existing `storyActionMatrix` + the three new suites).

- [ ] **Step 5: Manual visual check**

Run: `npm run dev`, open the Action view, click the **Story × Action Heatmap** tab, click a populated cell. Confirm against the reference screenshot:
- Left list rows show duration (colored `ObjectStatus`), user, timestamp, and any `T1/T2/T3` tags; the selected row is highlighted.
- Right panel header shows the breadcrumb `<action> · <story> · <time> · <user>`, the `Total: … · N widget(s)` line, the four-chip phase legend (Offset / Backend / Network wait / Render), and a `View` button.
- Waterfall bars are colored by phase and match the legend chips.
- Also open the below-table "Open Waterfall" panel and confirm the same header renders.

- [ ] **Step 6: Commit**

```bash
git add src/components/ActionCellDetail.jsx src/pages/views/ActionView.jsx
git commit -m "feat: feed enriched action metadata into both waterfall panels"
```

---

## Self-Review Notes

- **Spec coverage:** Component 1 (SAP List) → Tasks 3+4. Component 2 (rich header + `meta`) → Tasks 5+6+7. Component 3 (recolor + shared legend) → Tasks 1+2. Data-flow (both entry points) → Task 7. Testing section → new suites in Tasks 1, 2, 3, 5 + manual check in Task 7.
- **Type consistency:** `PHASE_COLORS`/`PHASE_LEGEND`/`phaseGroupOf` (Task 1) consumed by Tasks 2 & 6; `objectStatusStateForDurationTier`/`tagDesignForAnomalyTier` (Task 3) consumed by Task 4; `resolveHeaderMeta` (Task 5) consumed by Task 6; enriched `actions[]` shape `{ name, timestamp, label, story, user, durationMs }` produced in Task 7, consumed by `resolveHeaderMeta` in Task 6.
- **Palette:** flagged as tunable in review; structure does not depend on exact hexes.
