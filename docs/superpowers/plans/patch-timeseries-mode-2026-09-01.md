---
plan_id: "patch:2026-09-01-001"
description: "Extend existing HeatmapCard component to add a time-series mode without forking; axis swap with mode flag, preserve color threshold/logic."
author: 
replaces: docs/superpowers/plans/2026-09-01-interactive-timeseries-anomaly-heatmaps.md
---

## Context from Parent Plan
- Original plan approved: time-series anomaly heatmap to be universal and replaceable via Story toggle.
- Refinement: *reuse* the existing HeatmapCard component.  **No new chart library or dispatcher**.
- Goal hours: ½ dev day end-to-end if discipline and reuse are honored.

## Scope / Acceptance 
- Add enum `HeatmapMode = 'STORY_ACTION' | 'TIME_SERIES'`
- In **any** existing dataset the card must continue to render **without** regressions when `mode='STORY_ACTION'` (existing path)
- When `mode='TIME_SERIES'`:
  - x-axis role becomes **time bucket dimension** (column sentinel:  `__time_bucket` )
  - y-axis role becomes **entity dimension** (example: suppliers, products)
  - color = anomaly frequency via `classifyAnomalyCount` (already universal)
  - **double-click on a red cell** emits `{ timeBucket, entity }`; parent component subscribes to apply filter
- Database agnosticism: the sentinel column names are injected by data preprocessing – the component does **NOT** hard-code `entity`, `time_bucket`, etc.

## TDD Rule Discipline
- Violations result in immediate re-queue to self-review, not PR.
- Component must keep current default props cascade in place to ensure silent adoption in Storybook screens.

## Verification Evidence
- Existing Storyshots/png snapshots must remain identical under `STORY_ACTION`
- New Storybook story added: `HeatmapCard.TimeSeries` using sample sensor data (inlined fixture).
- Unit test snapshots updated to new mode variant toggles.

## Example Payload Contract (for double-click)
```json
{
  "type": "row-doubleclick",
  "payload": {
    "timeBucket": "2026-08-15",
    "entity": "plant-002"
  }
}
```
Parent component listens on `HeatmapCard` event bus via `onSelect` prop.

## Exit Criteria Checklist
- [ ] `HeatmapMode` enum lives under `types.ts`
- [ ] unit/e2e tests fail first, then green after patch
- [ ] stories updated, CI green
- [ ] PR includes visual regression + plan change diff
