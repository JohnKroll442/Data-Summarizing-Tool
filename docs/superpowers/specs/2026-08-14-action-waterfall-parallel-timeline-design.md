# Action Waterfall — real parallel timeline anchored to action duration

Date: 2026-08-14

## Problem

The Action Waterfall (`src/components/charts/options/actionSequence.js`) lays every
`(widget, phase)` bar **end-to-end** using a single global cursor that advances by
each phase's `DURATION`. The far marker — "Total Phase Timestamp" — is therefore the
**sum of every phase across every widget** (e.g. `1m 32s`).

That total overcounts wall-clock time because the phases do **not** run sequentially:
widgets load concurrently (each after its own idle `offset`), so most of the work
overlaps. The action's true runtime is the `action_duration` shown in the drill-down
cell and the Story × Action view (e.g. `43.3s`) — roughly half the summed total.

Users read the `1m 32s` marker as the action's end and are misled.

## Goal

Lay the bars out on a **real elapsed-time axis** so concurrent widgets overlap, and
replace the summed-phase end marker with an **"Action End Timestamp"** pinned to the
authoritative `action_duration`. The waterfall's end must equal the duration the cell /
Story × Action view displays for the same instance.

Non-goals: changing the widget-level drill-down chart (`widgetTiming.js`); changing how
`action_duration` itself is computed; reconstructing sub-phase order more precisely than
the data reliably supports.

## Approach (chosen: A — anchor by `offset`)

Each widget carries an `offset` measure = "client-side idle before the widget's turn to
load," measured from action start. This is the signal that encodes parallelism and is
already trusted by the Offset vs Duration panel (`buildOffsetDurationPoints`). It is
populated even when sub-phase timestamps are missing/zero (a known problem in this CSV
shape, per existing comments in `actionSequence.js` and `widgetTiming.js`), which is why
we prefer it over per-phase start timestamps.

Rejected alternatives:
- **B — real per-phase start timestamps.** Most precise when present, but
  `WIDGET_TIMESTAMP_START` / `WIDGET_RENDER_TIMESTAMP_START` are frequently absent for
  sub-measure rows, collapsing those bars to x=0. Too fragile on this data.
- **C — hybrid (timestamp when present, offset fallback).** Highest fidelity but
  mixed-fidelity layout looks inconsistent and adds complexity not justified now (YAGNI).

## Layout algorithm (`actionSequence.js`)

`t0 = 0` is the action start.

For each widget, in first-seen CSV order:
1. `widgetStart = offset` for that widget (its `offset` phase `DURATION`); `0` if there
   is no offset row.
2. Walk the widget's work phases in canonical order (Backend → Network(Full) →
   Network(waiting) → Network(Content Download) → Render), laying present phases
   (`DURATION > 0`) **end-to-end starting at `widgetStart`** — a per-widget cursor, not a
   global one. Each phase remains its own y-axis row (same as today).
3. Optionally emit the `offset` itself as a faded bar spanning `[0, widgetStart]` on its
   own row, so the pre-load wait stays visible.

Because the cursor resets to `widgetStart` per widget instead of accumulating across
widgets, widgets with small/equal offsets overlap in x — the picture reads as concurrent
work and collapses from the summed total toward the real duration.

Each duration datum keeps `startMs` / `endMs` / `durationMs` (now widget-relative real
elapsed values) for the tooltip and the widget-drill-down click, which is unchanged.

## Markers

- Keep **"Action Start Timestamp"** at `x = 0`.
- Replace the `totalDuration`-positioned **"Total Phase Timestamp"** with **"Action End
  Timestamp"** at `x = actionDurationMs`.
- `xAxis.max = max(actionDurationMs, reconstructedEnd) * 1.1`, where `reconstructedEnd` is
  the largest phase `endMs`. This keeps the end marker inside the plot and avoids clipping
  a widget whose reconstructed end slightly overshoots the real duration.
- Axis tick/label suppression past the end marker mirrors the existing
  `v > totalDuration` guard, using the new max.

## Data flow

`action_duration` for the selected instance is already available to the panel:
`ActionCellDetail` passes `meta.durationMs = selected.action_duration`, and
`ActionWaterfallPanel` renders the header "Total: <durationMs>". It is **not** currently
passed into the option builder.

Change: `buildActionSequenceOption(actionRows, { actionDurationMs })`. `ActionWaterfallPanel`
resolves `actionDurationMs` from the selected action entry (`selected.durationMs`, the same
value `resolveHeaderMeta` reads) and passes it in. When it's missing/invalid, fall back to
the reconstructed end (`max endMs`) so the chart still renders a sensible marker — labeled
"Action End Timestamp" regardless.

## Edge handling

- **Reconstructed end > actionDurationMs** (inconsistent offsets/durations): the overshoot
  bar extends slightly past the Action End marker into the 10% pad rather than being hidden.
  The marker still reports the authoritative duration.
- **Reconstructed end < actionDurationMs**: bars end before the marker; the gap is real
  unaccounted time. Acceptable — the marker is the source of truth.
- **No offset rows at all**: every `widgetStart = 0`; widgets fully overlap from t0. Still
  correct as a lower bound and never worse than today.
- **No `actionDurationMs`**: marker falls back to reconstructed end.

## Testing (`src/components/charts/options/__tests__/actionSequence.test.js`)

- Two widgets with the **same** offset overlap in x: their first work-phase bars share the
  same `startMs` (proves the global cursor is gone).
- A widget's phases still cascade **within** the widget (phase N starts where phase N-1
  ends, offset by `widgetStart`).
- The end markLine value equals the passed `actionDurationMs`; the label reads "Action End
  Timestamp"; "Total Phase Timestamp" no longer appears.
- `xAxis.max` ≈ `max(actionDurationMs, reconstructedEnd) * 1.1`.
- Fallback: with no `actionDurationMs`, the end marker equals the reconstructed end.

## Verification

Unit tests above, plus a manual browser smoke-check (no automated render test harness):
open a Story × Action cell, confirm the waterfall's Action End clock/value matches the
cell's duration and that widgets visibly overlap. (Tests can't catch a render crash or a
layout regression — see the project memory note.)
