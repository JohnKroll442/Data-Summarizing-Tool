# Root Cause Catalogue

Authoritative root cause explanations for every anomaly type the tool detects.
Derived from the tool's ANOMALY_TYPES definitions (src/lib/anomalyDetect.js)
and the AnomalySummaryPanel BLURBS (src/components/AnomalySummaryPanel.jsx).

The Root Cause Agent reads this file verbatim. Do not paraphrase.

---

## Performance Types

These count toward totalFlagged and represent real performance issues.

### slow_action
- **nature**: performance
- **root_cause**: The action's total wall-clock time exceeded the configured threshold. This usually means multiple slow factors added up: a heavy backend query, large data payload, sequential widget loading that could run in parallel, or a single widget blocking the rest.
- **what_to_look_for**: Check whether a single widget accounts for most of the duration (straggler pattern), or whether the time is spread across many widgets (fragmented pattern). If neither, the bottleneck is likely pre-render — a slow server response before any widget started.

### large_offset
- **nature**: performance
- **root_cause**: A widget spent a long time waiting before it started rendering. The offset period is the gap between the action starting and the widget receiving its data to render. A large offset usually means the server response was slow, or this widget was waiting for another request to complete first.
- **what_to_look_for**: Check whether other widgets in the same action have normal offsets. If only one widget has a large offset, it likely depends on a slower backend call. If all widgets have large offsets, the bottleneck is earlier in the request chain — likely the initial server response.

### straggler
- **nature**: performance
- **root_cause**: One widget rendered significantly slower than all others in the same action. This isolates the problem to a specific component — it fetches more data, performs heavier computation, or depends on a backend call that other widgets do not share.
- **what_to_look_for**: Identify the specific widget name from the Widget view. Check its render, network, and backend phase times individually. The dominant phase points to where the bottleneck sits: frontend rendering, network latency, or backend processing.

### fragmented
- **nature**: performance
- **root_cause**: The slow time is distributed across many widgets with no single dominant culprit. This usually means widgets are loading sequentially rather than in parallel, causing cumulative wall-clock time far beyond any individual widget's cost. Resource contention — multiple widgets competing for the same connection pool or thread — can also produce this pattern.
- **what_to_look_for**: Check whether widget offsets are staggered evenly (sequential loading pattern) or overlapping (parallel but slow). Staggered offsets suggest a serialization issue in the loading logic. Overlapping offsets with uniform slowness suggest resource contention.

---

## Data Quality Types

These count toward totalFlagged but represent measurement inconsistencies,
not real performance problems. Always present these separately from
performance types and include the reassurance note.

### negative_phase
- **nature**: data_quality
- **root_cause**: An exclusive timing phase (render minus network, or network minus backend) measured as negative across all widgets in the action. This means an inner phase was recorded as longer than the outer phase that should contain it — a physical impossibility that indicates the source timestamps are inconsistent.
- **what_to_look_for**: Compare the raw render, network, and backend timestamps for widgets in this action. Look for mismatched recording points — for example, the network end timestamp being recorded after the render end timestamp.
- **data_quality_note**: This is a timing instrumentation issue, not a real performance problem. The action may have performed normally. Treat this as a signal to review how phase timestamps are captured in the source system.

### offset_overrun
- **nature**: data_quality
- **root_cause**: A widget's pre-render wait (offset) was recorded as longer than the entire action duration — which is impossible since the widget runs inside the action. This indicates the action start timestamp and the widget offset timestamp were recorded against different reference points.
- **what_to_look_for**: Check whether the action start time and widget start time share the same clock source. A common cause is the action timestamp being captured on the server while the widget offset is captured on the client, introducing a clock skew.
- **data_quality_note**: This is a timestamp reference mismatch, not a real performance problem. The actual rendering likely completed normally.

### component_overrun
- **nature**: data_quality
- **root_cause**: A widget's summed phase times (render + network + backend) exceeded the total action duration. Since the widget runs inside the action, this is impossible and indicates the phase timestamps were measured against different reference points or contain overlapping intervals.
- **what_to_look_for**: Check whether phases are being summed correctly or whether some phases overlap (e.g. network and backend running concurrently but being added as if sequential).
- **data_quality_note**: This is a phase measurement overlap or reference point mismatch, not a real performance problem.

---

## Phase Attribution Types

These do NOT count toward totalFlagged. They describe WHERE time went
in already-slow actions. At most one fires per action.

### frontend_bound
- **root_cause**: The majority of the action's widget busy time was spent in browser rendering. This typically means heavy DOM manipulation, complex layout calculations, large JavaScript bundles executing synchronously, or CSS reflow triggered repeatedly during widget updates.

### network_bound
- **root_cause**: The majority of the action's widget busy time was spent waiting for network responses. This points to slow server response times (high TTFB), large payload sizes that take time to transfer, or network latency between the client and server.

### backend_bound
- **root_cause**: The majority of the action's widget busy time was spent in backend processing. This typically means slow database queries, complex business logic, resource contention on the application server, or missing database indices causing full table scans.