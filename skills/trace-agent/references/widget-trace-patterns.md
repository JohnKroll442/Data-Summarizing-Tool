# Widget Trace Patterns Reference

Authoritative pattern definitions for each anomaly type the trace agent investigates.
Derived from the anomaly detection logic in src/lib/anomalyDetect.js and the
widget aggregation in src/lib/widgetAggregate.js.

The Trace Agent reads this file to know what to show for each anomaly type.

---

## Performance Patterns

### straggler
- **detection rule**: One widget's inclusive render ≥ 5× the action's median widget render, the widget itself ≥ 5s, and ≥ 3 widgets in the action.
- **what_to_show**: Waterfall table highlighting the straggler widget. Show its exclusive render/network/backend split. The dominant phase (largest exclusive slice) = where the bottleneck sits.
- **cross_action**: If the same `widget_name` is the straggler across multiple flagged actions, report it as a repeat offender with the count and dominant phase.

### fragmented
- **detection rule**: Action ≥ 10s, ≥ 3 widgets, and ≥ 50% of wall-clock time is NOT explained by the slowest single widget (overhead = action_duration − max_widget_total).
- **what_to_show**: Waterfall table of ALL widgets with their offsets. Classify the offset pattern:
  - **Staggered**: offsets increase roughly evenly (each widget starts after the previous one finishes) → sequential loading / serialization
  - **Overlapping**: offsets cluster near 0 (widgets start at the same time) → parallel but individually slow / resource contention
  - **Mixed**: some sequential, some parallel
- **cross_action**: Report which actions have the worst overhead percentage.

### large_offset
- **detection rule**: A widget's pre-render offset (wait) ≥ the dataset's terminal duration band lower edge.
- **what_to_show**: Which widget(s) had the large offset. Compare their offsets to other widgets in the same action. If only one widget has a large offset, it likely depends on a slower backend call. If all widgets have large offsets, the bottleneck is earlier in the request chain.
- **cross_action**: Report which `widget_name`s repeatedly have large offsets across flagged actions.

---

## Data Quality Patterns

These are measurement issues, not performance problems. The trace agent VERIFIES
them by showing the raw numbers — confirming the impossibility.

### negative_phase
- **detection rule**: An exclusive phase (render − network OR network − backend) is negative even at its MAX across all widgets in the action.
- **what_to_show**: Raw phase numbers for each widget: render, network, backend, and the computed exclusive values. Highlight which subtraction went negative.
- **verification**: Show the math explicitly:
  - "render (X ms) − network (Y ms) = Z ms (NEGATIVE — inner phase outran container)"
  - This confirms the phase nesting (render ⊇ network ⊇ backend) is violated.

### offset_overrun
- **detection rule**: A widget's offset (pre-render wait) exceeds the total action duration — impossible since the widget runs inside the action.
- **what_to_show**: Widget offset vs action duration side-by-side. Show the overrun amount.
- **verification**: Show the math:
  - "offset (X ms) > action_duration (Y ms) — overrun by Z ms"
  - This confirms the action start and widget start timestamps use different reference points.

### component_overrun
- **detection rule**: A widget's summed phases (render + network + backend exclusive) exceed the total action duration.
- **what_to_show**: Widget phase breakdown (render + network + backend = total) vs action duration.
- **verification**: Show the math:
  - "widget total (X ms) > action_duration (Y ms) — overrun by Z ms"
  - This confirms phase timestamps are measured against different reference points or contain overlapping intervals.

---

## Phase Attribution Context

When investigating any flagged action, the phase breakdown per widget follows
the nesting model: render ⊇ network ⊇ backend.

- **Exclusive render** = render − network (pure client-side rendering)
- **Exclusive network** = network − backend (pure transport / TTFB wait)
- **Backend** = as-is (innermost server processing time)
- **Total** = exclusive render + exclusive network + backend
- **Offset** = pre-render wait (gap between action start and widget receiving data)

A widget's "% of action" = total / action_duration_ms × 100.
The bottleneck widget = the widget with the highest total.
The dominant phase = the largest exclusive slice within the bottleneck widget.