# Trace Agent — Mesh-Native Design Document

## Overview

The trace-agent is the first agent designed from day one for a mesh ecosystem.
Unlike existing agents (which receive hand-assembled input packages from the
Orchestrator), the trace-agent **reads what it needs from the shared store and
APIs**, **writes its output back to the store**, and **declares its permissions
explicitly** so any agent in the mesh can discover and consume its findings.

---

## 1. Mesh Primitives This Agent Introduces

These three backend capabilities don't exist yet. The trace-agent is the first
consumer, but every agent will eventually use them.

### 1a. Shared Agent Output Store

Two new endpoints on the backend:

```
POST /api/store/{dataset_id}/agent-output/{agent_name}
  body: { <agent's confirmed output JSON> }
  response: { "stored": true, "agent": "trace-agent", "dataset_id": "..." }

GET /api/store/{dataset_id}/agent-output/{agent_name}
  response: { <agent's confirmed output JSON> }   or   404 if not yet run
```

Every agent writes its confirmed output here. Every agent can read any other
agent's output here. The Orchestrator no longer needs to shuttle data.

**Storage shape per dataset:**
```python
_datasets[dataset_id] = {
    "rows":          [...],          # action-level aggRows (existing)
    "widget_rows":   [...],          # widget-level aggregated rows (NEW)
    "agent_outputs": {               # agent confirmed outputs (NEW)
        "stats-agent":      { ... },
        "anomaly-agent":    { ... },
        "root-cause-agent": { ... },
        "trace-agent":      { ... },
    },
    "stored_at": float
}
```

### 1b. Widget Data Endpoint

```
GET /api/widgets?dataset_id=...&action_key=...
```

Returns the pre-computed widget-aggregate rows for a specific action (or all
actions if `action_key` is omitted). This is the trace-agent's primary data
source — the equivalent of Explorer Agent's `GET /api/actions`.

**Query parameters:**
| Param | Required | Description |
|---|---|---|
| `dataset_id` | yes | UUID from POST /api/dataset |
| `action_key` | no | `action_name::action_timestamp` composite key — filter to one action |
| `widget_name` | no | Exact match on widget name — filter across actions |
| `limit` | no | Max rows returned (default 200, max 2000) |

**Response shape:**
```json
{
  "dataset_id": "<uuid>",
  "action_key": "<string or null>",
  "action_context": {
    "action_name": "<string>",
    "story_name": "<string>",
    "user": "<string>",
    "session_id": "<string>",
    "action_duration_ms": 0,
    "action_timestamp": "<ISO-8601>"
  },
  "total_widgets": 5,
  "widgets": [
    {
      "widget_id": "<string>",
      "widget_name": "<string>",
      "render_ms": 4200,
      "network_ms": 1800,
      "backend_ms": 950,
      "offset_ms": 320,
      "total_ms": 6950,
      "render_start": "<timestamp>",
      "render_end": "<timestamp>",
      "network_start": "<timestamp>",
      "network_end": "<timestamp>",
      "backend_start": "<timestamp>",
      "backend_end": "<timestamp>",
      "pct_of_action": 52.5
    }
  ]
}
```

**Field notes (matching widgetAggregate.js):**
- `render_ms` = exclusive (render − network)
- `network_ms` = exclusive (network − backend)
- `backend_ms` = innermost phase, as-is
- `total_ms` = render_ms + network_ms + backend_ms (exclusive sum)
- `offset_ms` = pre-render wait before this widget started
- `pct_of_action` = (total_ms / action_duration_ms) × 100
- Timestamps are passed through from the CSV as-is (no reformatting)
- Negative values are preserved (they signal data quality issues)

### 1c. Frontend Data Flow Change

`POST /api/dataset` (or `POST /api/chat`) must also store widget-aggregate
rows. The frontend already computes them via `aggregateByWidget()` — the
change is including them in the upload payload alongside `agg_rows`:

```js
// In the frontend, when uploading:
POST /api/dataset {
  rows:        aggRows,               // existing (action-level)
  widget_rows: widgetAggRows,         // NEW (from aggregateByWidget)
}
```

The backend stores both and serves them via their respective endpoints.

---

## 2. Permission Model

This is the formal declaration of what the trace-agent can access.
Every mesh-native agent will carry this section in its SKILL.md.

### Data Access Declaration

```
┌─────────────────────────────────────────────────────────────────┐
│ TRACE-AGENT PERMISSIONS                                         │
├─────────────┬───────────┬───────────────────────────────────────┤
│ Direction   │ Domain    │ Source                                │
├─────────────┼───────────┼───────────────────────────────────────┤
│ READ        │ widgets   │ GET /api/widgets (primary data)       │
│ READ        │ anomaly   │ GET /api/store/.../anomaly-agent      │
│ READ        │ rootcause │ GET /api/store/.../root-cause-agent   │
│ READ        │ flagged   │ payload.anomalies.flagged_by_type     │
│ READ        │ flagged   │ payload.anomalies.flagged_actions     │
│ READ        │ meta      │ payload.meta                          │
│ WRITE       │ trace     │ POST /api/store/.../trace-agent       │
├─────────────┼───────────┼───────────────────────────────────────┤
│ CANNOT READ │ kpis      │ Stats Agent's domain                  │
│ CANNOT READ │ summary   │ Explorer Agent's domain               │
│ CANNOT WRITE│ anomaly   │ Anomaly Agent's domain                │
│ CANNOT WRITE│ rootcause │ Root Cause Agent's domain             │
└─────────────┴───────────┴───────────────────────────────────────┘
```

### Mesh Edges (who reads trace-agent's output)

```
trace-agent WRITES trace_output
  → Narrator READS trace_output  (for enriched synthesis)
  → Root Cause Agent READS trace_output  (for widget-specific root causes)
  → Any future agent can discover and read it from the store
```

### Dependency Declaration

```
REQUIRED dependencies (agent will not run without these):
  - dataset_id in payload.meta
  - GET /api/widgets endpoint available

OPTIONAL dependencies (enriches output when available):
  - anomaly-agent output in store  → uses active types to prioritize analysis
  - root-cause-agent output in store  → references root causes in widget findings

INDEPENDENT of (never reads):
  - stats-agent output
  - explorer-agent output
  - narrator output
```

---

## 3. How the Trace-Agent Runs (Mesh Pattern)

### Old pattern (hub-and-spoke — how Root Cause works today):

```
1. Orchestrator classifies intent
2. Orchestrator runs Anomaly Agent, gets output
3. Orchestrator MANUALLY assembles Root Cause input:
     { anomaly_output + flagged_by_type + flagged_actions }
4. Orchestrator dispatches Root Cause with that package
5. Root Cause processes, returns output TO Orchestrator
6. Orchestrator stores output in its private session state
```

### New pattern (mesh — how trace-agent works):

```
1. Orchestrator classifies intent → WIDGET_TRACE
2. Orchestrator dispatches trace-agent with ONLY:
     { dataset_id, question, flagged_by_type, flagged_actions }
3. Trace-agent ITSELF reads from the mesh:
     a. GET /api/store/{dataset_id}/agent-output/anomaly-agent → active types
     b. GET /api/store/{dataset_id}/agent-output/root-cause-agent → root causes
     c. GET /api/widgets?dataset_id=...&action_key=... → widget data
4. Trace-agent processes, produces output
5. Trace-agent WRITES to the mesh:
     POST /api/store/{dataset_id}/agent-output/trace-agent → { trace_output }
6. Trace-agent returns confirmed output (also returned to Orchestrator
   for the current conversation — but the canonical copy is in the store)
```

The critical difference: **step 3 is the agent reading from the mesh, not
the Orchestrator pre-assembling inputs.** The Orchestrator doesn't need to
know what the trace-agent reads or how it uses it.

### Python orchestration (orchestrate.py):

```python
def run_trace_agent(question: str, dataset_id: str, payload: dict) -> dict:
    """Mesh-native agent: reads its own inputs from the store + API."""
    trace_input = {
        "dataset_id":      dataset_id,
        "question":        question,
        "flagged_by_type": payload.get("anomalies", {}).get("flagged_by_type", {}),
        "flagged_actions": payload.get("anomalies", {}).get("flagged_actions", []),
        "meta":            payload.get("meta", {}),
    }
    resp   = call_llm(get_skill("trace_agent"), json.dumps(trace_input, indent=2))
    result = _safe_json(resp, "trace-agent")
    result["_response_text"] = _prose(resp)

    # Mesh write: store the confirmed output for other agents to read
    if dataset_id and result.get("status") == "CONFIRMED":
        _store_agent_output(dataset_id, "trace-agent", result)

    return result
```

Note: `flagged_by_type` and `flagged_actions` still come from the payload
in this first version because the Anomaly Agent doesn't yet write to the
store. As agents migrate, these will come from the store too.

---

## 4. Trace-Agent Capability

### Domain

Widget-level timing analysis within actions. The trace-agent answers
questions that require looking INSIDE a single action at its component
widgets — which widget was slow, which phase dominated, whether widgets
loaded in parallel or sequence, and whether the raw timing numbers add up.

### Can answer

- Which widget was the bottleneck in a specific flagged action
- What the render / network / backend phase breakdown is per widget
- Whether widgets loaded sequentially (staggered offsets) or in parallel
- Whether the raw phase timestamps are consistent (data quality verification)
- Which widget is the repeat offender across multiple flagged actions
- What the dominant phase is for the straggler/slowest widget

### Cannot answer — route elsewhere

- Which anomaly types were detected → Anomaly Agent
- Why anomaly types occur in general → Root Cause Agent
- KPI values or latency percentiles → Stats Agent
- Which users or stories appear most → Explorer Agent
- Combined summaries → Narrator

---

## 5. Operating Modes

### Mode 1 — Single-Action Detail (waterfall)

Triggered by: "show me the widgets for action X" / "what happened in this action"
/ Orchestrator dispatches with a specific action_key

**Data source:** `GET /api/widgets?dataset_id=...&action_key=...`

**Mesh reads (optional enrichment):**
- `GET /api/store/.../anomaly-agent` → which flags does this action carry?
- `GET /api/store/.../root-cause-agent` → what root causes were identified for
  this action's anomaly types?

**Output sections:**

1. **Action context** — one-line summary:
   `[action_name] — [story_name] — [user] — [duration]s — flags: [straggler, backend_bound]`

2. **Widget waterfall table:**

   | Widget | Offset | Render | Network | Backend | Total | % of Action |
   |--------|--------|--------|---------|---------|-------|-------------|
   | Revenue Chart | 320ms | 4.2s | 1.8s | 950ms | 7.0s | 73% |
   | Filter Bar | 100ms | 800ms | 400ms | 200ms | 1.4s | 15% |
   | Title Bar | 50ms | 200ms | 100ms | 50ms | 350ms | 4% |

   Sorted by total_ms descending. Duration values formatted as ms or s.

3. **Loading pattern analysis:**
   - Offsets staggered evenly → "Sequential loading detected — widgets waited
     for earlier ones to complete before starting."
   - Offsets overlapping → "Parallel loading — widgets started concurrently."
   - Mix → "Partially parallel — first N widgets loaded together, then the
     rest were serialized."

4. **Bottleneck identification:**
   "Widget **Revenue Chart** accounts for 73% of this action's duration.
   Its dominant phase is **backend** (950ms of 7.0s total, after exclusive
   split). The root cause catalogue flags this pattern as: [root_cause text
   from store, if available]."

5. **Data quality verification** (only for actions with data quality flags):
   For `negative_phase`:
   "Widget X: render = 5200ms, network = 6100ms → exclusive frontend =
   −900ms. An inner phase outran its container."

   For `offset_overrun`:
   "Widget Y: offset = 145,000ms vs action duration = 132,000ms → offset
   exceeds action by 13s."

   For `component_overrun`:
   "Widget Z: phase sum = 158,000ms vs action duration = 132,000ms →
   overrun by 26s."

### Mode 2 — Cross-Action Aggregation (pattern scan)

Triggered by: "which widget is the straggler across all straggler actions" /
"show me the repeat offenders" / "aggregate the widget patterns"

**Data source:** Multiple calls to `GET /api/widgets?dataset_id=...&action_key=...`
for each action in `flagged_by_type[type_key]`.

**Mesh reads (optional enrichment):**
- `GET /api/store/.../anomaly-agent` → which types to scan across

**Output sections:**

1. **Scope line:**
   "Scanning [N] [type]-flagged actions for widget-level patterns."

2. **Repeat offender table:**

   | Widget | Appearances | Avg Total | Dominant Phase | Worst Action |
   |--------|-------------|-----------|----------------|--------------|
   | Revenue Chart | 8 of 12 | 6.2s | Backend (74%) | action_key_1 |
   | Data Table | 4 of 12 | 3.1s | Frontend (61%) | action_key_2 |

3. **Pattern summary:**
   "**Revenue Chart** is the straggler in 67% of straggler-flagged actions.
   Its backend phase is consistently dominant (avg 74% of widget time).
   This points to a specific backend query or data source this widget
   depends on."

4. **Loading pattern across actions:**
   "Offsets are staggered in 9 of 12 actions → systematic sequential loading,
   not a one-off. vs. Offsets vary across actions → no consistent pattern."

---

## 6. Input Contract

The trace-agent receives a **minimal dispatch package** from the Orchestrator.
It reads everything else from the mesh.

### Dispatch input (from Orchestrator)

```json
{
  "dataset_id": "<uuid>",
  "question": "<user's natural language question>",
  "flagged_by_type": {
    "<type_key>": [
      {
        "user": "<string>",
        "action_name": "<string>",
        "story_name": "<string>",
        "session_id": "<string>",
        "action_duration_ms": 0,
        "action_timestamp": "<ISO-8601>"
      }
    ]
  },
  "flagged_actions": [
    {
      "action_key": "<action_name>::<action_timestamp>",
      "session_id": "<string>",
      "user": "<string>",
      "story_name": "<string>",
      "action_name": "<string>",
      "action_timestamp": "<ISO-8601>",
      "action_duration_ms": 0,
      "anomaly_types": ["straggler", "backend_bound"]
    }
  ],
  "meta": {
    "file_name": "<string>",
    "dataset_id": "<uuid>",
    "slow_action_threshold_ms": 120000
  }
}
```

### Self-resolved mesh inputs (agent reads these itself)

```
anomaly_output  = GET /api/store/{dataset_id}/agent-output/anomaly-agent
                  → Optional. When present, used to prioritize which anomaly
                    types to scan in aggregation mode.

root_cause_output = GET /api/store/{dataset_id}/agent-output/root-cause-agent
                    → Optional. When present, used to reference root cause
                      explanations alongside widget findings.

widget_data     = GET /api/widgets?dataset_id={dataset_id}&action_key={key}
                  → Required. The actual widget-level timing data. One call
                    per action in detail mode; N calls in aggregation mode.
```

### Early-exit checks

1. If `dataset_id` is missing: "I need a dataset to query widget data.
   Please open the tool and submit your question from the embedded panel."
   Return `status: "NO_DATA"`. STOP.

2. If `GET /api/widgets` returns 404 for the dataset: "The dataset has
   expired or hasn't been stored yet. Please reload your data."
   Return `status: "NO_DATA"`. STOP.

3. If the requested action has no widget rows: "No widget-level data
   available for this action. The CSV may not include widget measure
   columns (WIDGET_ID, WIDGET_MEASURE, DURATION)."
   Return `status: "NO_WIDGET_DATA"`. STOP.

---

## 7. Output Contract

All fields required. This is what gets written to the shared store AND
returned to the Orchestrator.

```json
{
  "agent": "trace-agent",
  "status": "AWAITING_USER_DIRECTION",
  "dataset_id": "<uuid>",
  "mode": "detail|aggregation",
  "action_context": {
    "action_key": "<string>",
    "action_name": "<string>",
    "story_name": "<string>",
    "user": "<string>",
    "session_id": "<string>",
    "action_duration_ms": 0,
    "action_timestamp": "<ISO-8601>",
    "anomaly_types": []
  },
  "widgets": [
    {
      "widget_id": "<string>",
      "widget_name": "<string>",
      "render_ms": 0,
      "network_ms": 0,
      "backend_ms": 0,
      "offset_ms": 0,
      "total_ms": 0,
      "pct_of_action": 0.0,
      "dominant_phase": "render|network|backend",
      "dominant_phase_pct": 0.0
    }
  ],
  "bottleneck": {
    "widget_name": "<string>",
    "widget_id": "<string>",
    "total_ms": 0,
    "pct_of_action": 0.0,
    "dominant_phase": "render|network|backend",
    "dominant_phase_ms": 0
  },
  "loading_pattern": "sequential|parallel|mixed",
  "loading_pattern_detail": "<one-sentence explanation>",
  "data_quality_findings": [
    {
      "type": "negative_phase|offset_overrun|component_overrun",
      "widget_name": "<string>",
      "detail": "<human-readable explanation with raw numbers>"
    }
  ],
  "cross_action_summary": {
    "type_key": "<string>",
    "actions_scanned": 0,
    "repeat_offenders": [
      {
        "widget_name": "<string>",
        "appearances": 0,
        "appearance_rate": 0.0,
        "avg_total_ms": 0,
        "dominant_phase": "render|network|backend",
        "dominant_phase_rate": 0.0
      }
    ],
    "consistent_loading_pattern": "sequential|parallel|mixed|varies"
  },
  "mesh_context_used": {
    "anomaly_output_available": false,
    "root_cause_output_available": false,
    "root_cause_referenced": []
  },
  "session_notes": [],
  "excluded_by_user": [],
  "user_requested_drill": null
}
```

**Status values:**
- `AWAITING_USER_DIRECTION` — presented tables, waiting for user response
- `CONFIRMED` — user accepted, output stored in mesh
- `NO_DATA` — dataset_id missing or expired
- `NO_WIDGET_DATA` — action exists but has no widget-level rows
- `HALTED` — user stopped the analysis

**Mode-dependent fields:**
- `mode: "detail"` → `action_context`, `widgets`, `bottleneck`,
  `loading_pattern`, `data_quality_findings` are populated.
  `cross_action_summary` is null.
- `mode: "aggregation"` → `cross_action_summary` is populated.
  `action_context` reflects the worst action. `widgets` contains
  the worst action's widgets as a representative sample.

---

## 8. Presentation Rules

### Step 1 — Resolve mesh context

Before any analysis, attempt to read optional mesh inputs:
```
anomaly_output    = GET /api/store/{dataset_id}/agent-output/anomaly-agent
root_cause_output = GET /api/store/{dataset_id}/agent-output/root-cause-agent
```
Set `mesh_context_used` flags. If unavailable, proceed without — these are
enrichment, not requirements. Do not error or warn about missing mesh context.

### Step 2 — Determine mode

Read the user's question:
- Specific action referenced → detail mode
- "across all [type] actions" / "repeat offenders" / "pattern" → aggregation
- Orchestrator dispatched with a single action_key → detail mode
- Orchestrator dispatched with a type_key → aggregation mode for that type
- Ambiguous → default to the worst flagged action in detail mode

### Step 3 — Fetch widget data

Detail: one `GET /api/widgets` call for the target action.
Aggregation: one call per action in `flagged_by_type[type_key]`, up to 20
actions max (take the slowest 20 by `action_duration_ms`).

### Step 4 — Analyse

**Bottleneck identification:**
For each widget, compute `dominant_phase` = the phase with the largest
exclusive duration. For the action, `bottleneck` = the widget with the
largest `total_ms`.

**Loading pattern:**
Sort widgets by `offset_ms`. If offsets increase monotonically with gaps
≥ the previous widget's total: sequential. If offsets cluster within 500ms
of each other: parallel. Otherwise: mixed.

**Data quality (detail mode only):**
For each widget, check:
- `render_ms < 0` → negative_phase finding
- `network_ms < 0` → negative_phase finding
- `offset_ms > action_duration_ms` → offset_overrun finding
- `total_ms > action_duration_ms` → component_overrun finding

**Cross-action aggregation (aggregation mode):**
Group widgets across actions by `widget_name`. Count appearances. Compute
average `total_ms` and dominant phase frequency. A widget appearing in
>50% of scanned actions is a "repeat offender".

### Step 5 — Present tables (ALWAYS BEFORE JSON)

**SECTION 1 — Heading**
Detail: `### Widget Trace — [action_name]`
Aggregation: `### Widget Patterns — [type_label] ([N] actions scanned)`

**SECTION 2 — Action context (detail mode)**
`[action_name] — [story_name] — [user] — [duration]s`
`Flags: [anomaly_types joined by ", "]`

**SECTION 3 — Waterfall table (detail mode)**
Table columns: Widget | Offset | Render | Network | Backend | Total | % of Action
Sorted by total_ms descending. Durations formatted: <1000ms show as Nms,
≥1000ms show as N.Ns.

**SECTION 3 — Repeat offender table (aggregation mode)**
Table columns: Widget | Appearances | Rate | Avg Total | Dominant Phase | Worst Action

**SECTION 4 — Bottleneck callout**
Bold paragraph: "**[widget_name]** accounts for [pct]% of this action's
duration, dominated by **[phase]** ([phase_ms] of [total_ms])."

**SECTION 5 — Loading pattern**
One sentence: "[sequential|parallel|mixed] loading detected — [detail]."

**SECTION 6 — Data quality (if findings exist)**
**Data quality issues** *(measurement inconsistencies, not performance problems):*
One bullet per finding with raw numbers.

**SECTION 7 — Mesh context (if available)**
If root_cause_output was read: "Root Cause Agent identified this as:
[root_cause text for the relevant type]."
If anomaly_output was read: "Anomaly Agent flagged [N] types —
this trace covers [type_label]."

### Step 6 — Present agent payload

Write: **Agent payload — stored to mesh and passed to next agent:**
Then JSON in a code block labelled json.

### Step 7 — Pause for human review (REQUIRED)

Detail mode:
"Widget trace complete for [action_name] — [bottleneck.widget_name] is the
bottleneck ([pct]%). Want to scan across all [type] actions, drill into
another action, or does this give you what you need?"

Aggregation mode:
"Scanned [N] [type]-flagged actions — [top repeat offender] appears in
[rate]% of them. Want to drill into a specific action, or does this give
you what you need?"

Accepted responses:
- "looks good" / "done" → `status: "CONFIRMED"`, write to mesh store
- "drill into [action]" → switch to detail mode for that action
- "scan across [type]" → switch to aggregation mode for that type
- "show me [widget]'s history" → aggregation filtered to that widget
- "tell me more about [widget]" → expand its phases and timestamps
- "stop" → `status: "HALTED"`

---

## 9. Session Learning

Add ONE note to `session_notes[]` if applicable:

- Bottleneck widget accounts for >80% of action time →
  "Single widget dominates — [widget_name] accounts for [pct]% of the action."
  Significance: high.

- All widgets have similar totals (no widget >2× the median) →
  "No single bottleneck — time is distributed evenly across widgets."
  Significance: medium.

- Loading is sequential AND there are ≥5 widgets →
  "Sequential widget loading with [N] widgets — potential parallelization opportunity."
  Significance: high.

- Data quality findings present alongside performance findings →
  "Widget-level data quality issues detected — some timing values may be unreliable."
  Significance: medium.

- In aggregation mode, one widget appears in >75% of flagged actions →
  "Systematic bottleneck: [widget_name] is the straggler in [rate]% of [type]-flagged actions."
  Significance: high.

At most one note per run.

---

## 10. Reference File: Widget Trace Patterns

Create as `references/widget-trace-patterns.md`:

```markdown
# Widget Trace Patterns

Reference for interpreting widget-level timing data within actions.
The trace-agent reads this file for pattern classification.

## Loading Patterns

### Sequential
Offsets increase monotonically. Each widget starts after the previous
one finishes. Gap between widget N's offset and widget N-1's (offset +
total) is small (<500ms).
Signal: framework or application code loads widgets one at a time.
Impact: total action time ≈ sum of all widget times.

### Parallel
Offsets cluster within a narrow window (<500ms spread). Widgets start
near-simultaneously.
Signal: framework fires all widget requests at once.
Impact: total action time ≈ max(widget times), not sum.

### Mixed
Some widgets start together (cluster), then later widgets start after
the first batch finishes.
Signal: batched loading — the framework loads in waves.

## Phase Dominance

### Frontend-dominated (render_ms is largest exclusive phase)
The widget spends most time in browser rendering. Heavy DOM
manipulation, complex layout, large JS bundles.

### Network-dominated (network_ms is largest exclusive phase)
The widget waits on network responses. Slow TTFB, large payloads,
high latency.

### Backend-dominated (backend_ms is largest exclusive phase)
The widget waits on server processing. Slow queries, complex
business logic, resource contention.

## Data Quality Markers

### Negative exclusive phase
render_ms or network_ms is negative. An inner phase (network or
backend) was measured as longer than the phase that should contain it.
The raw inclusive values are self-consistent but the nesting
relationship is violated.

### Offset overrun
offset_ms > action_duration_ms. The widget's pre-render wait was
recorded as longer than the entire action. Clock skew between action
and widget timestamp sources.

### Component overrun
total_ms > action_duration_ms. The widget's phase sum exceeds the
action. Overlapping phase measurements or inconsistent reference
points.
```

---

## 11. Infrastructure Changes Summary

### Backend (app.py)

| Change | Description |
|--------|-------------|
| Extend `_datasets` shape | Add `widget_rows` and `agent_outputs` to the stored dict |
| `POST /api/dataset` | Accept `widget_rows` in the body alongside `rows` |
| `GET /api/widgets` | New endpoint — serve widget-aggregate rows filtered by action_key |
| `POST /api/store/{dataset_id}/agent-output/{agent}` | New — store agent confirmed output |
| `GET /api/store/{dataset_id}/agent-output/{agent}` | New — read agent confirmed output |

### Backend (orchestrate.py)

| Change | Description |
|--------|-------------|
| `run_trace_agent()` | New function — mesh-native dispatch pattern |
| `_store_agent_output()` | New helper — write to the agent output store |
| Intent classification | Add `WIDGET_TRACE` to the intent set |
| `_DIRECT_AGENT_INTENT_MAP` | Add `"trace_agent": "WIDGET_TRACE"` |

### Frontend (buildAgentPayload.js)

| Change | Description |
|--------|-------------|
| `POST /api/dataset` call | Include `widget_rows` from `aggregateByWidget()` in the upload |

### Skills

| Skill | Change |
|-------|--------|
| Orchestrator | Add `WIDGET_TRACE` intent + dispatch logic |
| Agent capability catalogue | Add trace-agent entry |
| Narrator | Add trace_output to optional mesh reads for enriched synthesis |

---

## 12. Migration Path for Existing Agents

The trace-agent proves the mesh pattern. Once it's working, existing agents
migrate incrementally:

**Phase 1 (now):** Trace-agent is mesh-native. All other agents stay
hub-and-spoke. The Orchestrator still assembles their inputs.

**Phase 2:** Add `POST /api/store/.../agent-output/{agent}` calls to
`orchestrate.py` for every existing agent (Stats, Anomaly, Root Cause,
Explorer, Narrator). Their outputs are now readable by any agent.

**Phase 3:** Modify Root Cause Agent to read anomaly_output from the store
instead of receiving it from the Orchestrator. Its SKILL.md gets a
permissions section.

**Phase 4:** Modify Narrator to read from the store (stats, anomaly,
optionally trace). It becomes mesh-native.

**Phase 5:** Slim the Orchestrator — it only classifies intent and
dispatches with `{ dataset_id, question }`. Agents read everything else.

Each phase is independently deployable and backwards-compatible.