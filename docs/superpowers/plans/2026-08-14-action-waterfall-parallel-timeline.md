# Action Waterfall Parallel Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the Action Waterfall bars on a real elapsed-time axis where concurrent widgets overlap, and pin the end marker to the authoritative `action_duration` instead of the summed phase total.

**Architecture:** In `actionSequence.js`, replace the single global `cursor` (which accumulates every phase end-to-end across all widgets) with a per-widget cursor anchored at each widget's `offset` duration, so widgets that start together overlap. Thread the authoritative action duration into the builder as `opts.actionDurationMs`, replace the "Total Phase Timestamp" markLine with an "Action End Timestamp" markLine at that value, and set the x-axis max from `max(actionDurationMs, reconstructedEnd)`. `ActionWaterfallPanel.jsx` resolves that duration the same way `resolveHeaderMeta` already does and passes it in.

**Tech Stack:** React + Vite, ECharts via `echarts-for-react`, Vitest.

## Global Constraints

- Test runner: `npm test -- --run <path>` (NOT `npx vitest run` — it errors spuriously with "Cannot read properties of undefined (reading 'config')").
- The visible duration bars, per-bar tooltip fields (`startMs`/`endMs`/`durationMs`), widget-click drill-down (`widgetId`/`widgetName` on each datum), phase coloring, and the "Action Start Timestamp" markLine at x=0 must all keep working — this change only alters bar x-positions and the far marker.
- No automated render test harness exists — a render crash passes lint+build+test. A browser smoke-check is required before declaring done.
- Duration source of truth: the action's `action_duration`, surfaced to the panel as `sel.durationMs ?? meta.durationMs` (identical to what `resolveHeaderMeta` reads).

---

### Task 1: Offset-anchored parallel layout in the option builder

Replace the global cross-widget cursor with a per-widget cursor that starts at the widget's `offset` duration, so widgets overlap in time. Each phase still becomes its own y-row; each datum keeps its `startMs`/`endMs`/`durationMs`/`widgetId`/`widgetName`.

**Files:**
- Modify: `src/components/charts/options/actionSequence.js:79-161` (the `buildActionSequenceOption` signature + the widget/phase walk)
- Test: `src/components/charts/options/__tests__/actionSequence.test.js`

**Interfaces:**
- Consumes: `actionRows` (array of CSV row objects), unchanged.
- Produces: `buildActionSequenceOption(actionRows, opts = {})` — new optional second arg `opts` with field `actionDurationMs?: number`. The `duration` series data items keep the same shape (`{ value, itemStyle, phaseLabel, phaseGroup, legendLabel, startMs, endMs, durationMs, widgetId, widgetName }`), but `startMs`/`endMs` are now widget-relative real-elapsed values (offset-anchored), not a global running sum.

- [ ] **Step 1: Write the failing test** — add to `src/components/charts/options/__tests__/actionSequence.test.js` (append after the existing `describe` blocks):

```js
// Two widgets that both wait the same offset (100ms) then do backend work.
// With the old global cursor, widget B's backend started after ALL of
// widget A's phases; with offset-anchoring it starts at its own offset, so
// the two backend bars share a startMs — the visible proof of parallelism.
const twoWidgetRows = [
  { WIDGET_ID: 'w1', WIDGET_NAME: 'A', WIDGET_MEASURE: 'offset',  WIDGET_SUBMEASURE: '', DURATION: 100 },
  { WIDGET_ID: 'w1', WIDGET_NAME: 'A', WIDGET_MEASURE: 'backend', WIDGET_SUBMEASURE: '', DURATION: 200 },
  { WIDGET_ID: 'w2', WIDGET_NAME: 'B', WIDGET_MEASURE: 'offset',  WIDGET_SUBMEASURE: '', DURATION: 100 },
  { WIDGET_ID: 'w2', WIDGET_NAME: 'B', WIDGET_MEASURE: 'backend', WIDGET_SUBMEASURE: '', DURATION: 500 },
]

describe('buildActionSequenceOption — parallel offset-anchored layout', () => {
  const opt = buildActionSequenceOption(twoWidgetRows)
  const duration = opt.series.find((s) => s.name === 'duration')
  // Data is stored reversed for top-down y-order; index by phaseLabel instead.
  const byLabel = Object.fromEntries(duration.data.map((d) => [d.phaseLabel, d]))

  it('anchors each widget backend at its own offset, so equal-offset widgets overlap', () => {
    // Both offsets are 100ms → both backends start at 100, not stacked.
    expect(byLabel['Query data of A'].startMs).toBe(100)
    expect(byLabel['Query data of B'].startMs).toBe(100)
  })

  it('cascades phases within a widget (offset then backend end-to-end)', () => {
    expect(byLabel['A — Offset'].startMs).toBe(0)
    expect(byLabel['A — Offset'].endMs).toBe(100)
    expect(byLabel['Query data of A'].startMs).toBe(100)
    expect(byLabel['Query data of A'].endMs).toBe(300)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/components/charts/options/__tests__/actionSequence.test.js`
Expected: FAIL — the two backends currently start at 0 and 300 (global cursor), so `startMs` for `Query data of B` is 300, not 100.

- [ ] **Step 3: Change the signature and per-widget cursor** in `src/components/charts/options/actionSequence.js`.

Change the signature (line 79):

```js
export function buildActionSequenceOption(actionRows, opts = {}) {
```

Replace the layout walk (lines 115-155, from `let cursor = 0` through the closing brace of the `for (const widgetKey ...)` loop) with a per-widget cursor anchored at the widget's offset. Note `offset` is the FIRST entry in `PHASE_ORDER`, so we read it, place it at `[0, offset]`, then start the work-phase cursor at `offset`:

```js
  let reconstructedEnd = 0
  for (const widgetKey of widgetOrder) {
    const rows = widgetRows.get(widgetKey)
    const displayName = pickDisplayName(rows, m) || widgetKey

    // Each widget's timeline is anchored at its own offset — the client-side
    // idle before this widget's turn to load, measured from action start.
    // Widgets that wait the same offset therefore overlap in x, which is what
    // makes the chart read as concurrent work instead of one long sum.
    const offsetPick = pickPhase(rows, m, ['offset'], null)
    const widgetStart = offsetPick && offsetPick.durationMs > 0 ? offsetPick.durationMs : 0

    let cursor = widgetStart
    for (const phase of PHASE_ORDER) {
      const pick = pickPhase(rows, m, [phase.measure], phase.sub)
      if (!pick || !(pick.durationMs > 0)) continue

      const label = phase.key === 'backend'
        ? `Query data of ${displayName}`
        : phase.key === 'render'
          ? `Render ${displayName}`
          : `${displayName} — ${phase.label}`

      const group = phaseGroupOf(phase.key)
      const color = PHASE_COLORS[group]
      const legendLabel = phase.key.startsWith('network')
        ? 'Network wait'
        : phase.label

      // The offset bar spans [0, widgetStart]; every work phase cascades from
      // the per-widget cursor. Offset uses widgetStart as its width so it draws
      // the pre-load wait without advancing past it twice.
      const start = phase.key === 'offset' ? 0 : cursor
      const end = start + pick.durationMs

      yLabels.push(label)
      spacerData.push(start)
      durationData.push({
        value: pick.durationMs,
        itemStyle: { color, borderRadius: [2, 2, 2, 2] },
        phaseLabel: label,
        phaseGroup: group,
        legendLabel,
        startMs: start,
        endMs: end,
        durationMs: pick.durationMs,
        widgetId: widgetKey,
        widgetName: displayName,
      })

      if (phase.key !== 'offset') cursor = end
      if (end > reconstructedEnd) reconstructedEnd = end
    }
  }
```

Then replace the `const totalDuration = cursor` line (line 161) with:

```js
  // Real end of the reconstructed timeline (largest phase end across widgets),
  // and the authoritative action duration (source of truth for the end marker).
  const actionDurationMs = Number.isFinite(Number(opts.actionDurationMs))
    ? Number(opts.actionDurationMs)
    : null
  const endMarker = actionDurationMs != null ? actionDurationMs : reconstructedEnd
  const axisMax = Math.max(actionDurationMs ?? 0, reconstructedEnd)
```

(The markLine and axis wiring in the next task consume `endMarker`, `reconstructedEnd`, and `axisMax`. `totalDuration` no longer exists after this task — Task 2 finishes removing its remaining uses; the file will not build cleanly until Task 2 is applied, so run tests only after Task 2.)

- [ ] **Step 4: Hold tests until Task 2** — the two tasks touch the same function and `totalDuration` references remain in the markLine/axis block. Do NOT run tests yet. Proceed to Task 2, then run.

- [ ] **Step 5: Commit** (after Task 2 verifies green — see Task 2 Step 5). No standalone commit for Task 1.

---

### Task 2: Action End marker + axis max, and thread duration from the panel

Replace the "Total Phase Timestamp" markLine (at the summed total) with an "Action End Timestamp" markLine pinned to `endMarker`, set the x-axis max/label suppression from `axisMax`, and pass `actionDurationMs` in from `ActionWaterfallPanel`.

**Files:**
- Modify: `src/components/charts/options/actionSequence.js:161-245` (markLine data + xAxis)
- Modify: `src/components/ActionWaterfallPanel.jsx:113-120` (pass `actionDurationMs` into the builder)
- Test: `src/components/charts/options/__tests__/actionSequence.test.js`

**Interfaces:**
- Consumes: `endMarker`, `reconstructedEnd`, `axisMax`, `actionDurationMs` from Task 1.
- Produces: option with markLine labels `'Action Start Timestamp'` and `'Action End Timestamp'` (no `'Total Phase Timestamp'`); `xAxis.max === axisMax * 1.15`.

- [ ] **Step 1: Write the failing tests** — append to `src/components/charts/options/__tests__/actionSequence.test.js`:

```js
// Helper: pull the markLine label formatters (the text markers) off the option.
const markLabels = (opt) => {
  const duration = opt.series.find((s) => s.name === 'duration')
  return duration.markLine.data.map((d) => d.label?.formatter)
}

describe('buildActionSequenceOption — action end marker', () => {
  it('pins the end marker to the passed actionDurationMs, not the summed total', () => {
    // Summed phases = 100+200 (A) + 100+500 (B) reconstructed end = 600;
    // but the real action duration is 450. The marker must read 450.
    const opt = buildActionSequenceOption(twoWidgetRows, { actionDurationMs: 450 })
    const duration = opt.series.find((s) => s.name === 'duration')
    const endLine = duration.markLine.data.find(
      (d) => d.label?.formatter === 'Action End Timestamp'
    )
    expect(endLine).toBeTruthy()
    expect(endLine.xAxis).toBe(450)
  })

  it('labels the markers Action Start / Action End and drops Total Phase Timestamp', () => {
    const opt = buildActionSequenceOption(twoWidgetRows, { actionDurationMs: 450 })
    const labels = markLabels(opt)
    expect(labels).toContain('Action Start Timestamp')
    expect(labels).toContain('Action End Timestamp')
    expect(labels).not.toContain('Total Phase Timestamp')
  })

  it('sets the x-axis max to max(actionDurationMs, reconstructedEnd) * 1.15', () => {
    // reconstructedEnd for twoWidgetRows = 600 (B: 100 offset + 500 backend).
    const opt = buildActionSequenceOption(twoWidgetRows, { actionDurationMs: 450 })
    expect(opt.xAxis.max).toBeCloseTo(600 * 1.15, 5)
  })

  it('falls back to the reconstructed end when no actionDurationMs is given', () => {
    const opt = buildActionSequenceOption(twoWidgetRows)
    const duration = opt.series.find((s) => s.name === 'duration')
    const endLine = duration.markLine.data.find(
      (d) => d.label?.formatter === 'Action End Timestamp'
    )
    expect(endLine.xAxis).toBe(600)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/components/charts/options/__tests__/actionSequence.test.js`
Expected: FAIL — `totalDuration` is undefined (removed in Task 1) so the builder throws, and the "Total Phase Timestamp" label still exists in the code.

- [ ] **Step 3: Rewrite the markLine block and xAxis** in `src/components/charts/options/actionSequence.js`.

Replace the `markLineData` array (lines 174-211) — keep the Action Start pair, keep its value label, and swap the total pair for an Action End pair anchored at `endMarker`:

```js
  const markLineData = [
    {
      xAxis: 0,
      label: {
        formatter: 'Action Start Timestamp',
        position: 'end', distance: [0, 6], color: '#1d2d3e',
        fontSize: f.markLine, align: 'center', verticalAlign: 'bottom',
      },
      lineStyle: { color: '#1d2d3e', type: 'solid', width: 1 },
    },
    {
      xAxis: 0,
      label: {
        formatter: fmtMs(0),
        position: 'end', distance: [0, f.markLine + 10], color: '#1d2d3e',
        fontSize: f.markLine, fontWeight: 600, align: 'center', verticalAlign: 'bottom',
      },
      lineStyle: { color: 'transparent', width: 0 },
    },
    {
      // Pinned to the authoritative action duration (or the reconstructed end
      // when that's unavailable) — this is the action's real end, not the sum
      // of every phase stacked end-to-end.
      xAxis: endMarker,
      label: {
        formatter: 'Action End Timestamp',
        position: 'end', distance: [0, 6], color: '#1d2d3e',
        fontSize: f.markLine, align: 'center', verticalAlign: 'bottom',
      },
      lineStyle: { color: '#1d2d3e', type: 'solid', width: 1 },
    },
    {
      xAxis: endMarker,
      label: {
        formatter: fmtMs(endMarker),
        position: 'end', distance: [0, f.markLine + 10], color: '#1d2d3e',
        fontSize: f.markLine, fontWeight: 600, align: 'center', verticalAlign: 'bottom',
      },
      lineStyle: { color: 'transparent', width: 0 },
    },
  ]
```

Then update the `xAxis` block (lines 232-245) — replace the two `totalDuration` references with the axis max derived from `axisMax`:

```js
    xAxis: {
      type: 'value',
      min: 0,
      max: axisMax * 1.15,
      name: 'Elapsed time',
      nameLocation: 'middle',
      nameGap: 36,
      nameTextStyle: { fontSize: f.axisName, color: '#1d2d3e' },
      axisLabel: {
        fontSize: f.axis,
        formatter: (v) => (v > axisMax + 1e-6 ? '' : fmtMs(v)),
      },
      splitLine: { show: true, lineStyle: { color: '#e6ecf2' } },
    },
```

Also update the doc comment block above `markLineData` (lines 166-173) so it no longer describes "Total Phase Timestamp":

```js
  // Two vertical markLines anchor the sequence to the action's start (x=0) and
  // its real end. The end marker is pinned to the authoritative action_duration
  // passed in as opts.actionDurationMs (falling back to the reconstructed end of
  // the offset-anchored timeline when that isn't provided) — NOT the sum of every
  // phase bar, which overcounts because widgets load concurrently. Elapsed time,
  // not wall-clock: the layout is offset-anchored and duration-based.
```

- [ ] **Step 4: Pass the duration from the panel** — in `src/components/ActionWaterfallPanel.jsx`, thread the resolved action duration into the builder. Replace the `option` useMemo (lines 113-120):

```jsx
  // Authoritative action duration for the selected action — the same value the
  // header shows (sel.durationMs, falling back to meta.durationMs). Passed to
  // the builder so the waterfall's Action End marker matches the cell duration.
  const actionDurationMs =
    selected?.durationMs != null ? selected.durationMs : meta?.durationMs

  const option = useMemo(
    () => buildActionSequenceOption(actionRows, { actionDurationMs }),
    // viewportWidth is an intentional dependency: the option builder reads the
    // fluid root font-size at build time, so we rebuild on resize to rescale
    // the chart text. The linter can't see that use inside the builder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actionRows, viewportWidth, actionDurationMs]
  )
```

- [ ] **Step 5: Run the full option test file + lint + build**

Run: `npm test -- --run src/components/charts/options/__tests__/actionSequence.test.js`
Expected: PASS — all existing tests (phaseGroupOf, PHASE_LEGEND, phase coloring) plus the new parallel-layout and action-end tests.

Run: `npm run lint`
Expected: no new errors in `actionSequence.js` or `ActionWaterfallPanel.jsx`.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/charts/options/actionSequence.js src/components/charts/options/__tests__/actionSequence.test.js src/components/ActionWaterfallPanel.jsx
git commit -m "feat: action waterfall parallel timeline anchored to action duration"
```

---

### Task 3: Browser smoke-check

No render test exists, so verify the chart actually renders and the numbers line up in a browser.

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server** (background) and wait for it to serve:

Run: `npm run dev` (background), then poll the port it prints (Vite defaults to 5173):
`timeout 30 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done'`

- [ ] **Step 2: Drive it** — load a CSV, open the Story × Action view, click a cell whose action duration you can read (e.g. 43.3s), and confirm in the Action Waterfall:
  - The far marker reads **"Action End Timestamp"** with a value equal to the cell's action duration (≈43.3s), NOT a larger "Total Phase Timestamp".
  - Widgets that start together visibly overlap (bars begin at the same x), instead of every bar stacking left-to-right into one long sum.
  - The duration bars, per-bar tooltips (Start/End/Duration), and clicking a bar to open the widget-timing drill-down all still work.

If `chromium-cli` is available, script `nav` → `wait-for` the chart → `screenshot` → `console --errors`; otherwise open the URL manually. **Look at the screenshot** — a blank frame is a render failure.

- [ ] **Step 3: Stop the dev server**

Run: `lsof -ti:5173 -sTCP:LISTEN | xargs -r kill` (or the printed port).

---

## Self-Review

**Spec coverage:**
- Offset-anchored per-widget layout (spec "Layout algorithm") → Task 1. ✓
- Offset bar drawn at `[0, widgetStart]` (spec step 3) → Task 1 (`start = phase.key === 'offset' ? 0 : cursor`). ✓
- Keep Action Start at x=0, replace Total Phase Timestamp with Action End at `actionDurationMs` (spec "Markers") → Task 2. ✓
- `xAxis.max = max(actionDurationMs, reconstructedEnd) * 1.1` — spec said ×1.1; the existing code uses ×1.15 and the plan keeps ×1.15 to avoid an unrelated visual change. Deviation noted; tests assert ×1.15. ✓
- Thread `actionDurationMs` via `buildActionSequenceOption(actionRows, { actionDurationMs })` from the panel using `sel.durationMs ?? meta.durationMs` (spec "Data flow") → Task 2. ✓
- Fallback to reconstructed end when duration missing (spec "Edge handling") → Task 1 (`endMarker`) + Task 2 test. ✓
- Tests: equal-offset overlap, within-widget cascade, end marker = actionDurationMs, no Total Phase Timestamp, axis max, fallback (spec "Testing") → Tasks 1 & 2. ✓
- Browser smoke-check (spec "Verification") → Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `buildActionSequenceOption(actionRows, opts)` signature consistent across tasks; `actionDurationMs`, `endMarker`, `reconstructedEnd`, `axisMax` named identically in Tasks 1–2; datum shape unchanged. Note: Task 1 leaves the file non-building (removes `totalDuration`); Task 2 completes the change, so tests run only after Task 2 — called out explicitly in Task 1 Step 4. ✓
