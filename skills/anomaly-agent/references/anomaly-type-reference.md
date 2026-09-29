# Anomaly Type Reference

Source of truth for all possible type keys, their human-readable labels,
descriptions, and structural grouping.

Derived from ANOMALY_TYPES and BLURBS in the tool's source code
(src/lib/anomalyDetect.js and src/components/AnomalySummaryPanel.jsx).

---

## Headline Types (count toward totalFlagged)

These are real performance anomalies. They appear in `active_headline_types[]`.

| key               | label               | description |
|-------------------|---------------------|-------------|
| slow_action       | Slow action         | This action took the configured slow-action threshold or longer from start to finish. |
| large_offset      | Large offset        | A widget spent a long time waiting before it started rendering. |
| straggler         | Straggler widget    | One widget took far longer to render than the others in this action. |
| fragmented        | Fragmented          | The slow time is spread across many widgets, with no single culprit. |
| offset_overrun    | Offset > Duration   | A widget's pre-render wait exceeds the whole action — the timestamps don't add up. |
| negative_phase    | Negative phase      | An inner timing phase outran the one containing it — inconsistent timestamps. |
| component_overrun | Component overrun   | A widget's phases add up to more than the whole action — inconsistent timestamps. |

## Phase Subgroup Types (do NOT count toward totalFlagged)

These describe WHERE time went in already-slow actions.
They appear in `active_phase_types[]`, never in `active_headline_types[]`.
At most ONE of these fires per action (the dominant phase).

| key            | label      | description |
|----------------|------------|-------------|
| frontend_bound | Frontend   | Most of the time went into rendering in the browser. |
| network_bound  | Network    | Most of the time went into waiting on the network. |
| backend_bound  | Backend    | Most of the time went into waiting on the backend. |

---

## Why the Split Matters

An action flagged ONLY by a phase type (e.g. frontend_bound) is NOT counted
in total_flagged. The tool distinguishes between:
- "This action was anomalous" (headline types)
- "Here is where its time went" (phase types)

The Narrator must respect this split. The Root Cause Agent uses both.

---

## Threshold Note

The slow_action threshold is user-configurable in the tool
(default: 120000ms = 2 minutes). The description above says
"configured slow-action threshold" rather than a fixed value
because the user may have changed it. The payload's
`meta.slow_action_threshold_ms` field holds the active value.