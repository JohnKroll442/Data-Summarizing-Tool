---
plan_id: 2026-09-01-interactive-timeseries-anomaly-heatmaps
created: 2026-09-01
owner: COE Datasphere team
status: approved
jira_ticket: "TBD"
related_pr: "TBD"
---

# Goal
Enable **Option B (Interactive Story × Action Heatmap)** from Joule’s existing reusable heatmap card component so that all anomaly-visualisation screens automatically gain a toggle to show time-series heatmaps instead of the classic dimension × metric grid. The solution must be universal and respond to any data set provided by this tool.

## Iron Laws Verification
- **TDD Rule**: A front-end unit test-prototype (RED) will be created before every code change.
- **Design First**: A minimal design document was brainstormed and approved before writing this plan.
- **Verification Evidence**: After implementation, a fresh regression suite must pass before the PR is merged.

# Scope (What is in / out)

## In Scope
- Create a new **`heatmapType`** prop for the existing React heatmap card.
- Parse configurable axes:
  - x = temporal (time, bucket)
  - y = entity type (discrete dimension)
  - color = count of anomalies in bucket
- Add UI toggle to flip between "Story mode" (classic x=entity, y=metric) and "Time-Series mode" (x=date, y=entity).
- Make the color scale and threshold bands data-driven (percentiles of anomaly frequency across entire data set) instead of hard-coded.
- Drop-down granulation: daily, weekly, monthly.
- Label grids so users understand buckets (e.g., "2025-W32" weekly).
- All existing functionality, filters, exports, tooltips, and permissions preserved.

## Out of Scope
- Back-end aggregation rewrite (existing anomaly engine remains unchanged).
- Multi-entity stacked heatmaps (out of v1).
- Heatmap-to-report auto-generation (covered under later export feature).
- Mobile layout rework (current heatmap already responsive).

# User Stories & Acceptance Criteria

## US-1 Time-Series Heatmap User Can Switch Mode
As a client admin, I want to click a toggle in the existing heatmap chart so I can see time-series anomaly intensity instantly without a new screen, so I can show my manager when spikes were happening in Q3 2025.
Acceptance:
- Toggle is present and clearly labeled.
- Choosing "Time-Series" swaps axes and re-renders without full refresh.
- Original "Story × Action" layout still works after toggling back.

## US-2 Granularity Picker Works Across Any Dataset
As a power user, I want to change the time bucket (daily/weekly/monthly) and the chart should group accordingly + update labels automatically.
Acceptance:
- Granularity persists on browser reload.
- Labels update e.g. daily="2025-07-21", weekly="2025-K30".
- performance < 250ms p95 for datasets ≤20k anomaly rows.

## US-3 Color Scale is Data-Driven
As an analyst, I want the color bands (green/yellow/red) to adjust automatically based on the actual distribution of anomaly counts, so a quiet dataset doesn’t look alarming while a spike in November looks red.
Acceptance:
- Detects anomaly count thresholds: green = 0 anomalies, yellow = exactly 1 anomaly, red ≥2 anomalies.
- ColorMap legend reflects these static thresholds explicitly (no percentile banding).
- saves thresholds to localStorage for consistency, key `heatmap.thresholds-v2`.

# Design Changes

## Front-End Contract Change (existing component)
Existing component signature:
```tsx
interface HeatmapCardProps {
  type?: "story×action" | "timeseries" |
  entityField: string;       // axis: discrete dimension, e.g. "region"
  metricField: string;        // axis: continuous metric, e.g. "sales"
  colorField: string;         // numeric value to color cells
}
```
New contract:
```tsx
interface HeatmapCardProps {
  type?: "story×action" | "timeseries" = "story×action";
  entityField?: string;       // y-axis label for // timeseries
  metricField?: string;       // x-axis for timeseries (default ="date")
  temporalField?: string;     // MUST be provided in timeseries mode (ISO date field)
  anomalyCountField?: string;  // numeric count of flags pre-computed by engine
  granularity?: 'daily'|'weekly'|'monthly';
}
```
## Back-End Contract (unchanged)
No new endpoints. The anomaly engine already returns a long table:
```json
{
  "rows": [
    {"anomalyFlag": true, "date":"2025-07-21T00:00:00Z", "entity":"plant-A", "kqi":"sales", "value":345},
    ...
  ]
}
```
Filtering and aggregation continue to happen client-side in the same SDK already present.

# Architecture

## Modules Impacted
1. Component file: `src/components/HeatmapCard.tsx`
2. Story helper: `src/components/HeatmapCard.stories.tsx` (new story variant)
3. Type declarations: `src/types/Heatmap.types.ts`

## Flow Diagram
```
[User picks "Time-Series"] → HeatmapCard.tsx prop → renders SankeyGrid
SankeyGrid aggregates in-browser using d3-array bin() + crossfilter → timeScale / entityScale → 
  colorScale = quantile thresholds of anomalyCountField values per grid bucket → cell.stroke = band
```

## Why SankeyGrid reuse?
- Lightweight (50kb gzipped).
- Already contains cross-axis logic, tooltips, zoom/pan.
- No SVG rewrite.

# Implementation Plan (TDD)

## Phase 1 — RED: Write Failing Unit Test
- Create `heatmap-timeseries.e2e.spec.ts` with mocked data set of 100 anomaly rows.
- Describe expected behavior: toggle click → cells group by week → tooltip shows date.
- Runner target: Vitest. Fail on import error.

## Phase 2 — GREEN: Minimal Component Wiring
- Add optional prop to existing component but disable story variant for now.
- Hard-code a static 2-week dataset so the component *doesn’t crash* on parse (`temporalField` exists).
- Assert UI test passes; snapshot matches only changed cell labels.
- Color bands remain hard-coded (green=1 yellow=2 red=3) so tests pass.

## Phase 3 — REFACTOR: Data-Driven Thresholds
- Wire percentiles calculation (d3-array.thresholdSturges + quantile values).
- Save palette and percentiles in localStorage key `heatmap.thresholds.ts` so state survives reload.
- Update d.ts types. Keep props backward compatible.

## Phase 4 — Parameterize Axes
- Extract temporalField from props, parse dates safely (luxon.DateTime).
- SankeyGrid auto-detects `type` prop and reroutes x/y encodings:
  - `type=timeseries`: x=Date bin, y=entity (by `entityField`)
  - default: x=entity, y=metric.
- Wire granularity dropdown → time binning transform (daily/ISO day, weekly/ISO week, monthly/start of month).
- Responsive label helpers: (`formatGranularity(date, 'weekly') → "W32 2025"`).

## Phase 5 — Visual Polish
- CSS variables inject to reuse existing palette but invert legend placement for x-axis label.
- Add Aria labels for keyboard grid cell navigation (a11y).
- Accessibility auditor `pa11y-ci` score ≥95.

## Phase 6 — Regression + Verification
- Build Story `HeatmapCardTimeseries` variant and run snapshot.
- Run regression suite:
```bash
npm run test:e2e heatmap-timeseries
npm run test:unit heatmap
npm run lint
```
- Document rollback plan: localStorage version check `v1` vs default to conserved green=1/yellow=2/red=3 if absent.

# Deployment Plan
1. Create feature branch `feature/heatmap-timeseries` off `main`.
2. Push PR with draft check:
   - title `[WIP] Heatmap Time-Series Support`
   - description links to this plan
   - add label `impact-heatmap`
3. Request review from 2 peers; include screenshots for toggle + granularity.
4. Merge only once E2E + unit tests pass and code review closed.

# Risk & Mitigations
| Risk | Mitigation |
|---|---|
| Color banding looks scrambled on empty datasets | safeguard = fallback green=0.05/yellow=0.5/red=1 thresholds |
| Granularity dropdown slows dataset >50k rows | auto-switch to weekly at threshold |
| Date parsing libraries missing in desktop bundle | pre-bundle d3 libraries into monorepo pkg |
| Type regression breaking downstream consumers | Check against `type` union in CI |

# Decision Log
- **Chose Option B** to reuse existing SankeyGrid to minimize boilerplate and guarantee backward compatibility.
- **No new chart library** to avoid security policy friction.
- **LocalStorage thresholds** chosen over server fetch to preserve client isolation.

# Rollback Instructions
1. Delete files changed in commit range.
2. Run `VER=green npm ci` on desktop bundle; release will auto-switch back to legacy layout.

# Resources & References
- AnomalyEngine SDK: `src/services/AnomalyEngine.ts`
- Color palette references: existing `theme.palette.error`, `theme.palette.warning`, `theme.palette.success`
- TDD baseline: `references/tdd.md` from superpowers workflow
- Regression baseline: `references/verification.md`
