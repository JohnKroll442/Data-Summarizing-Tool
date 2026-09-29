# Shared Workspace Schema — COE Datasphere Agent Mesh

**Version:** 1.0.0-draft  
**Status:** Design proposal  
**Replaces:** Orchestrator session-state-template.json (hub-and-spoke model)

---

## 1. Design Principles

### 1.1 Why a Shared Workspace

The current architecture is hub-and-spoke: the Orchestrator owns all state, mediates every data handoff, and is the only component that can sequence agents. This creates three problems:

1. **Bottleneck** — Every inter-agent data flow passes through one component. If the Orchestrator's dispatch logic has a bug or omits a field, downstream agents are blind.
2. **Implicit contracts** — What Agent A writes and what Agent B expects are defined in separate SKILL.md files with no shared schema enforcement. This has already caused drift (5 of 6 output templates are missing fields their SKILL.md requires).
3. **No peer access** — The Narrator cannot see Explorer data. The Root Cause Agent cannot ask Explorer for row-level detail. Every cross-agent data need requires Orchestrator intervention.

The shared workspace fixes this by introducing a **single, schema-enforced address space** that every agent reads from and writes to, with explicit permissions per agent.

### 1.2 Core Rules

| Rule | Rationale |
|---|---|
| **One writer per namespace** | Prevents conflicts. If two agents could write to the same namespace, you'd need merge logic. |
| **Many readers per namespace** | Any agent with read permission can pull peer data directly — no Orchestrator relay needed. |
| **Schema-on-write** | When an agent writes to its namespace, the workspace validates the output against the namespace's schema. Malformed writes are rejected. |
| **Immutable-until-replaced** | Once an agent writes a confirmed output, it's immutable until that agent writes a new version. No other agent can mutate it. |
| **Explicit permissions** | Every agent's SKILL.md declares which namespaces it reads and writes. Undeclared access is denied. |

### 1.3 Workspace vs. Orchestrator

The Orchestrator still exists in a mesh, but its role shrinks:

| Hub-and-spoke (current) | Mesh (proposed) |
|---|---|
| Orchestrator owns all state | Workspace owns all state |
| Orchestrator copies data between agents | Agents read directly from peer namespaces |
| Orchestrator decides sequencing | Events trigger agents automatically |
| Orchestrator is the only component that knows the full picture | Any agent with read permissions sees what it needs |

The Orchestrator becomes a **lightweight router**: it classifies intent, decides which agents to activate, and handles conversational follow-ups. It no longer brokers data.

---

## 2. Workspace Topology

```
workspace/
├── source/                          ← Tool payload (read-only)
│   ├── meta                         ← { file_name, generated_at, scope, slow_action_threshold_ms }
│   ├── kpis                         ← kpis[] array
│   ├── anomalies                    ← { counts, total_flagged, total_actions, flagged_actions, flagged_by_type }
│   └── data_summary                 ← { total_actions, total_unique_*, by_user, by_story, by_action }
│
├── agents/                          ← Per-agent output namespaces (one writer each)
│   ├── stats/output                 ← Stats Agent confirmed output
│   ├── anomaly/output               ← Anomaly Agent confirmed output
│   ├── root-cause/output            ← Root Cause Agent confirmed output
│   ├── explorer/output              ← Explorer Agent confirmed output
│   └── narrator/output              ← Narrator synthesis output
│
├── shared/                          ← Canonical domain knowledge (read-only at runtime)
│   ├── anomaly-types                ← Merged anomaly type registry (replaces 2 separate files)
│   ├── root-cause-catalogue         ← Root cause explanations (keyed by type)
│   ├── kpi-schema                   ← KPI key definitions and formatting rules
│   └── action-row-schema            ← Canonical action row shape (used by Root Cause + Explorer)
│
├── session/                         ← Cross-cutting session state
│   ├── notes                        ← Accumulated session_notes from all agents
│   ├── events                       ← Event log (status transitions, triggers)
│   └── state                        ← { phase, intent, agents_run[], human_review_mode }
│
└── api/                             ← External API registry
    └── actions                      ← GET /api/actions endpoint definition + access control
```

---

## 3. Namespace Schemas

### 3.1 `source/*` — Tool Payload (Immutable)

Written once when the tool payload is injected. No agent can modify it.

#### `source/meta`
```json
{
  "file_name": "string",
  "generated_at": "string (ISO-8601)",
  "scope": "string",
  "slow_action_threshold_ms": "integer"
}
```

#### `source/kpis`
```json
[
  {
    "key": "string — one of: total_actions | over_2m | median_duration | p90_duration | p95_duration",
    "label": "string — human-readable, varies with threshold",
    "value": "string — pre-formatted, '—' means null"
  }
]
```
**Invariant:** Exactly 5 items. Keys are stable identifiers; labels are display-only.

#### `source/anomalies`
```json
{
  "total_actions": "integer",
  "total_flagged": {
    "actions": "integer",
    "pct": "float (decimal fraction, e.g. 0.12 = 12%)"
  },
  "counts": {
    "<type_key>": {
      "actions": "integer",
      "pct": "float (decimal fraction)"
    }
  },
  "flagged_actions": [
    {
      "action_key": "string (unique)",
      "session_id": "string",
      "user": "string",
      "story_name": "string",
      "action_name": "string",
      "action_timestamp": "string (ISO-8601)",
      "action_duration_ms": "integer",
      "flags": ["string — anomaly type keys"]
    }
  ],
  "flagged_by_type": {
    "<type_key>": [
      {
        "session_id": "string",
        "user": "string",
        "story_name": "string",
        "action_name": "string",
        "action_timestamp": "string (ISO-8601)",
        "action_duration_ms": "integer"
      }
    ]
  }
}
```
**Invariant:** `counts` always has exactly 10 keys (all type keys present, including zeros).

#### `source/data_summary`
```json
{
  "total_actions": "integer",
  "total_unique_users": "integer",
  "total_unique_stories": "integer",
  "total_unique_action_types": "integer",
  "by_user": [
    { "user": "string", "action_count": "integer", "pct_of_total": "float (e.g. 7.0 = 7%)" }
  ],
  "by_story": [
    { "story_name": "string", "action_count": "integer", "pct_of_total": "float" }
  ],
  "by_action": [
    { "action_name": "string", "action_count": "integer", "pct_of_total": "float" }
  ]
}
```
**Invariant:** All three `by_*[]` arrays are **pre-sorted by `action_count` descending**. Agents must not re-sort.

---

### 3.2 `agents/*` — Agent Output Namespaces

Each namespace has exactly **one writer** (the owning agent) and **zero or more readers** (peer agents with permission).

Every agent output shares a common envelope:

```json
{
  "agent": "string — agent name",
  "status": "string — agent-specific status enum",
  "session_notes": [
    {
      "agent": "string",
      "observation": "string (one sentence)",
      "significance": "high | medium | low"
    }
  ],
  "written_at": "string (ISO-8601) — timestamp of last write",
  "schema_version": "string — version of this output schema"
}
```

**Status enum values by agent:**

| Agent | Statuses |
|---|---|
| stats-agent | `READY_FOR_REVIEW` → `CONFIRMED` \| `HALTED` \| `NO_DATA` |
| anomaly-agent | `READY_FOR_REVIEW` → `CONFIRMED` \| `HALTED` \| `NO_ANOMALIES` |
| root-cause-agent | `AWAITING_USER_DIRECTION` → `CONFIRMED` \| `HALTED` \| `NO_ANOMALIES` |
| explorer-agent | `AWAITING_USER_DIRECTION` → `CONFIRMED` \| `DRILL_REQUESTED` \| `HALTED` \| `NO_DATA` |
| narrator | `AWAITING_USER_DIRECTION` → `COMPLETE` \| `DRILL_REQUESTED` \| `HALTED` \| `BLOCKED` |

#### `agents/stats/output`
```json
{
  "agent": "stats-agent",
  "status": "CONFIRMED",
  "schema_version": "1.0.0",
  "written_at": "ISO-8601",
  "kpis": {
    "total_actions": "string | null",
    "over_threshold": "string | null",
    "median_duration": "string | null",
    "p90_duration": "string | null",
    "p95_duration": "string | null"
  },
  "keys_present": ["string — output key names of non-null fields"],
  "keys_missing": ["string — output key names of null/absent fields"],
  "threshold_label": "string | null — human-readable threshold description",
  "session_notes": []
}
```
**Key rename:** Input `over_2m` → output `over_threshold` (threshold is configurable).

#### `agents/anomaly/output`
```json
{
  "agent": "anomaly-agent",
  "status": "CONFIRMED",
  "schema_version": "1.0.0",
  "written_at": "ISO-8601",
  "total_actions": "integer",
  "total_flagged": {
    "actions": "integer",
    "pct": "integer (converted from decimal to integer %)"
  },
  "active_headline_types": [
    {
      "key": "string — anomaly type key",
      "label": "string — from shared/anomaly-types",
      "actions": "integer",
      "pct": "integer (%)"
    }
  ],
  "active_phase_types": [
    {
      "key": "string",
      "label": "string",
      "actions": "integer",
      "pct": "integer (%)"
    }
  ],
  "excluded_by_user": ["string — type keys removed at user request"],
  "types_checked": 10,
  "types_active": "integer — headline count only",
  "session_notes": []
}
```
**Invariant:** Both `active_*` arrays sorted by `actions` descending.

#### `agents/root-cause/output`
```json
{
  "agent": "root-cause-agent",
  "status": "CONFIRMED",
  "schema_version": "1.0.0",
  "written_at": "ISO-8601",
  "total_actions": "integer",
  "total_flagged": {
    "actions": "integer",
    "pct": "integer (%)"
  },
  "types_explained": "integer — total across all three arrays",
  "root_causes": [
    {
      "type_key": "string",
      "type_label": "string",
      "nature": "performance",
      "actions": "integer",
      "pct": "integer (%)",
      "root_cause": "string — verbatim from shared/root-cause-catalogue",
      "what_to_look_for": "string — verbatim from catalogue"
    }
  ],
  "data_quality_flags": [
    {
      "type_key": "string",
      "type_label": "string",
      "nature": "data_quality",
      "actions": "integer",
      "pct": "integer (%)",
      "root_cause": "string",
      "data_quality_note": "string — verbatim from catalogue"
    }
  ],
  "phase_context": [
    {
      "type_key": "string",
      "type_label": "string",
      "actions": "integer",
      "pct": "integer (%)",
      "root_cause": "string"
    }
  ],
  "excluded_by_user": [],
  "user_requested_drill": "string | null",
  "session_notes": []
}
```

#### `agents/explorer/output`
```json
{
  "agent": "explorer-agent",
  "status": "CONFIRMED",
  "schema_version": "1.0.0",
  "written_at": "ISO-8601",
  "dimension_explored": "string | null — user | story | action",
  "question_answered": "string | null — the user's original question",
  "top_results": [
    {
      "name": "string",
      "action_count": "integer",
      "pct_of_total": "float"
    }
  ],
  "detail_results": [
    {
      "action_name": "string",
      "story_name": "string",
      "user": "string",
      "session_id": "string",
      "action_duration_ms": "integer",
      "action_timestamp": "string (ISO-8601)"
    }
  ],
  "cross_references": [
    {
      "entity": "string — name of user/story/action",
      "dimension": "string — user | story | action",
      "anomaly_types_matched": ["string — type keys"],
      "flagged_action_count": "integer"
    }
  ],
  "session_notes": [],
  "user_requested_drill": "string | null"
}
```
**Note:** `detail_results` was missing from the legacy template. This schema is canonical.

#### `agents/narrator/output`
```json
{
  "agent": "narrator",
  "status": "COMPLETE",
  "schema_version": "1.0.0",
  "written_at": "ISO-8601",
  "meta": {
    "file_name": "string | null",
    "generated_at": "string | null",
    "scope": "string | null"
  },
  "headline": "string | null — one-sentence synthesis",
  "top_types": [
    {
      "key": "string",
      "label": "string",
      "actions": "integer",
      "pct": "integer (%)"
    }
  ],
  "phase_context": [
    {
      "key": "string",
      "label": "string",
      "actions": "integer",
      "pct": "integer (%)"
    }
  ],
  "kpi_summary": {
    "total_actions": "string | null",
    "over_threshold": "string | null",
    "median_duration": "string | null",
    "p90_duration": "string | null",
    "p95_duration": "string | null",
    "threshold_label": "string | null"
  },
  "worst_offender": "object | null — first entry from source/anomalies.flagged_actions",
  "routing_suggestions": [
    {
      "type_key": "string",
      "suggested_agent": "string",
      "reason": "string"
    }
  ],
  "excluded_by_user": [],
  "user_requested_drill": "string | null",
  "session_notes": []
}
```
**Invariant:** `top_types[]` capped at 3 entries.

---

### 3.3 `shared/*` — Canonical Domain Knowledge

These are **read-only at runtime**. Updated only by the skill maintainer, not by agents during a session. They replace the duplicated per-agent reference files.

#### `shared/anomaly-types`

**Replaces:** `anomaly-agent/references/anomaly-type-reference.md` AND the type key list in `root-cause-agent/references/root-cause-catalogue.md`.

```json
{
  "schema_version": "1.0.0",
  "types": {
    "slow_action": {
      "label": "Slow action",
      "group": "headline",
      "nature": "performance",
      "description": "This action took the configured slow-action threshold or longer from start to finish.",
      "counts_toward_flagged": true
    },
    "large_offset": {
      "label": "Large offset",
      "group": "headline",
      "nature": "performance",
      "description": "A widget spent a long time waiting before it started rendering.",
      "counts_toward_flagged": true
    },
    "straggler": {
      "label": "Straggler widget",
      "group": "headline",
      "nature": "performance",
      "description": "One widget took far longer to render than the others in this action.",
      "counts_toward_flagged": true
    },
    "fragmented": {
      "label": "Fragmented",
      "group": "headline",
      "nature": "performance",
      "description": "The slow time is spread across many widgets, with no single culprit.",
      "counts_toward_flagged": true
    },
    "offset_overrun": {
      "label": "Offset > Duration",
      "group": "headline",
      "nature": "data_quality",
      "description": "A widget's pre-render wait exceeds the whole action — the timestamps don't add up.",
      "counts_toward_flagged": true
    },
    "negative_phase": {
      "label": "Negative phase",
      "group": "headline",
      "nature": "data_quality",
      "description": "An inner timing phase outran the one containing it — inconsistent timestamps.",
      "counts_toward_flagged": true
    },
    "component_overrun": {
      "label": "Component overrun",
      "group": "headline",
      "nature": "data_quality",
      "description": "A widget's phases add up to more than the whole action — inconsistent timestamps.",
      "counts_toward_flagged": true
    },
    "frontend_bound": {
      "label": "Frontend",
      "group": "phase",
      "nature": null,
      "description": "Most of the time went into rendering in the browser.",
      "counts_toward_flagged": false
    },
    "network_bound": {
      "label": "Network",
      "group": "phase",
      "nature": null,
      "description": "Most of the time went into waiting on the network.",
      "counts_toward_flagged": false
    },
    "backend_bound": {
      "label": "Backend",
      "group": "phase",
      "nature": null,
      "description": "Most of the time went into waiting on the backend.",
      "counts_toward_flagged": false
    }
  },
  "groups": {
    "headline": "Real anomalies that count toward totalFlagged. Appear in active_headline_types[].",
    "phase": "WHERE time went in already-slow actions. At most one fires per action. Appear in active_phase_types[]. Do NOT count toward totalFlagged."
  },
  "natures": {
    "performance": "Real performance issues worth investigating.",
    "data_quality": "Measurement inconsistencies, not real performance problems. Always present separately with reassurance note."
  },
  "total_type_count": 10
}
```

#### `shared/root-cause-catalogue`

**Replaces:** `root-cause-agent/references/root-cause-catalogue.md`  
**Reads from:** `shared/anomaly-types` for type keys and nature classification.

```json
{
  "schema_version": "1.0.0",
  "root_causes": {
    "slow_action": {
      "nature": "performance",
      "root_cause": "The action's total wall-clock time exceeded the configured threshold. This usually means multiple slow factors added up: a heavy backend query, large data payload, sequential widget loading that could run in parallel, or a single widget blocking the rest.",
      "what_to_look_for": "Check whether a single widget accounts for most of the duration (straggler pattern), or whether the time is spread across many widgets (fragmented pattern). If neither, the bottleneck is likely pre-render — a slow server response before any widget started."
    },
    "large_offset": {
      "nature": "performance",
      "root_cause": "A widget spent a long time waiting before it started rendering. The offset period is the gap between the action starting and the widget receiving its data to render. A large offset usually means the server response was slow, or this widget was waiting for another request to complete first.",
      "what_to_look_for": "Check whether other widgets in the same action have normal offsets. If only one widget has a large offset, it likely depends on a slower backend call. If all widgets have large offsets, the bottleneck is earlier in the request chain — likely the initial server response."
    },
    "straggler": {
      "nature": "performance",
      "root_cause": "One widget rendered significantly slower than all others in the same action. This isolates the problem to a specific component — it fetches more data, performs heavier computation, or depends on a backend call that other widgets do not share.",
      "what_to_look_for": "Identify the specific widget name from the Widget view. Check its render, network, and backend phase times individually. The dominant phase points to where the bottleneck sits: frontend rendering, network latency, or backend processing."
    },
    "fragmented": {
      "nature": "performance",
      "root_cause": "The slow time is distributed across many widgets with no single dominant culprit. This usually means widgets are loading sequentially rather than in parallel, causing cumulative wall-clock time far beyond any individual widget's cost. Resource contention — multiple widgets competing for the same connection pool or thread — can also produce this pattern.",
      "what_to_look_for": "Check whether widget offsets are staggered evenly (sequential loading pattern) or overlapping (parallel but slow). Staggered offsets suggest a serialization issue in the loading logic. Overlapping offsets with uniform slowness suggest resource contention."
    },
    "offset_overrun": {
      "nature": "data_quality",
      "root_cause": "A widget's pre-render wait (offset) was recorded as longer than the entire action duration — which is impossible since the widget runs inside the action. This indicates the action start timestamp and the widget offset timestamp were recorded against different reference points.",
      "what_to_look_for": "Check whether the action start time and widget start time share the same clock source. A common cause is the action timestamp being captured on the server while the widget offset is captured on the client, introducing a clock skew.",
      "data_quality_note": "This is a timestamp reference mismatch, not a real performance problem. The actual rendering likely completed normally."
    },
    "negative_phase": {
      "nature": "data_quality",
      "root_cause": "An exclusive timing phase (render minus network, or network minus backend) measured as negative across all widgets in the action. This means an inner phase was recorded as longer than the outer phase that should contain it — a physical impossibility that indicates the source timestamps are inconsistent.",
      "what_to_look_for": "Compare the raw render, network, and backend timestamps for widgets in this action. Look for mismatched recording points — for example, the network end timestamp being recorded after the render end timestamp.",
      "data_quality_note": "This is a timing instrumentation issue, not a real performance problem. The action may have performed normally. Treat this as a signal to review how phase timestamps are captured in the source system."
    },
    "component_overrun": {
      "nature": "data_quality",
      "root_cause": "A widget's summed phase times (render + network + backend) exceeded the total action duration. Since the widget runs inside the action, this is impossible and indicates the phase timestamps were measured against different reference points or contain overlapping intervals.",
      "what_to_look_for": "Check whether phases are being summed correctly or whether some phases overlap (e.g. network and backend running concurrently but being added as if sequential).",
      "data_quality_note": "This is a phase measurement overlap or reference point mismatch, not a real performance problem."
    },
    "frontend_bound": {
      "root_cause": "The majority of the action's widget busy time was spent in browser rendering. This typically means heavy DOM manipulation, complex layout calculations, large JavaScript bundles executing synchronously, or CSS reflow triggered repeatedly during widget updates."
    },
    "network_bound": {
      "root_cause": "The majority of the action's widget busy time was spent waiting for network responses. This points to slow server response times (high TTFB), large payload sizes that take time to transfer, or network latency between the client and server."
    },
    "backend_bound": {
      "root_cause": "The majority of the action's widget busy time was spent in backend processing. This typically means slow database queries, complex business logic, resource contention on the application server, or missing database indices causing full table scans."
    }
  }
}
```

#### `shared/kpi-schema`

**Replaces:** `stats-agent/references/tool-data-schema.md`

```json
{
  "schema_version": "1.0.0",
  "keys": {
    "total_actions": {
      "description": "Total distinct action instances in the current view",
      "output_key": "total_actions",
      "example_value": "2,070"
    },
    "over_2m": {
      "description": "Actions exceeding the slow-action threshold — count + share",
      "output_key": "over_threshold",
      "rename_reason": "Threshold value varies per dataset; 'over_2m' is misleading when threshold != 2 minutes",
      "example_value": "47 (2%)"
    },
    "median_duration": {
      "description": "p50 of action end-to-end duration",
      "output_key": "median_duration",
      "example_value": "4.6 s"
    },
    "p90_duration": {
      "description": "90th percentile of action end-to-end duration",
      "output_key": "p90_duration",
      "example_value": "22.6 s"
    },
    "p95_duration": {
      "description": "95th percentile of action end-to-end duration",
      "output_key": "p95_duration",
      "example_value": "40.4 s"
    }
  },
  "format_rules": {
    "pass_through": "Values are pre-formatted strings. Do NOT convert, parse, or reformat.",
    "null_indicator": "'—' (em dash) means data unavailable. Treat as null.",
    "label_warning": "Labels vary with threshold setting. Always identify items by key, never by label."
  },
  "scope_note": "KPIs reflect the currently filtered/visible action set, which may differ from the anomaly detection scope."
}
```

#### `shared/action-row-schema`

**New.** Defines the canonical shape for individual action rows, used by Root Cause Agent (Layer 2) and Explorer Agent (detail mode).

```json
{
  "schema_version": "1.0.0",
  "base_fields": {
    "action_name": { "type": "string", "required": true },
    "story_name": { "type": "string", "required": true },
    "user": { "type": "string", "required": true },
    "session_id": { "type": "string", "required": true },
    "action_duration_ms": { "type": "integer", "required": true },
    "action_timestamp": { "type": "string (ISO-8601)", "required": true }
  },
  "extended_fields": {
    "action_key": {
      "type": "string",
      "required": false,
      "present_in": ["source/anomalies.flagged_actions"],
      "description": "Unique action identifier, present only in flagged action arrays"
    },
    "flags": {
      "type": "array<string>",
      "required": false,
      "present_in": ["source/anomalies.flagged_actions"],
      "description": "Anomaly type keys flagged on this action"
    }
  },
  "sources": {
    "source/anomalies.flagged_actions": "base_fields + extended_fields (action_key, flags)",
    "source/anomalies.flagged_by_type.<key>[]": "base_fields only (no action_key, no flags)",
    "api/actions response": "base_fields only"
  }
}
```

---

### 3.4 `session/*` — Cross-Cutting Session State

#### `session/notes`

Accumulates `session_notes` from all agents. Agents **append** to this namespace; they never overwrite peer entries.

```json
[
  {
    "agent": "string",
    "observation": "string (one sentence)",
    "significance": "high | medium | low",
    "written_at": "string (ISO-8601)"
  }
]
```

**Write rule:** Each agent appends its own notes. An agent may only append entries where `agent` matches its own name. The workspace enforces this — an agent cannot forge another agent's name in a note.

#### `session/events`

Ordered log of status transitions and triggers. Written by the workspace itself (not by agents directly) when an agent output status changes.

```json
[
  {
    "event_id": "string (auto-generated)",
    "timestamp": "string (ISO-8601)",
    "source_agent": "string",
    "event_type": "status_change | drill_request | human_review",
    "payload": {
      "from_status": "string | null",
      "to_status": "string",
      "detail": "string | null"
    }
  }
]
```

#### `session/state`

Replaces the Orchestrator's in-memory session state. Owned by the Orchestrator but readable by all agents.

```json
{
  "phase": "idle | classifying | planning | dispatching | collecting | narrating | conversational",
  "intent": "string | null",
  "agents_run": ["string — agent names that have been dispatched"],
  "human_review_mode": "mandatory | optional | disabled"
}
```

---

### 3.5 `api/*` — External API Registry

Defines external data endpoints that agents can call. The workspace enforces that only agents with permission can invoke them.

#### `api/actions`

```json
{
  "endpoint": "GET /api/actions",
  "description": "Fetch row-level action detail from the performance tool",
  "parameters": {
    "user": { "type": "string", "required": false },
    "story": { "type": "string", "required": false },
    "action_name": { "type": "string", "required": false },
    "duration_min_ms": { "type": "integer", "required": false },
    "duration_max_ms": { "type": "integer", "required": false }
  },
  "response_schema": "shared/action-row-schema (base_fields only)",
  "authorized_agents": ["explorer-agent", "root-cause-agent"]
}
```

**Key change:** Root Cause Agent gains API access. Currently it depends on the Orchestrator to pass Layer 2 data from the payload. In the mesh, if the payload doesn't include `flagged_by_type`, Root Cause Agent can fetch the data it needs directly.

---

## 4. Permission Matrix

Each cell shows the access level: **R** (read), **W** (write), **A** (append), **—** (no access).

| Namespace | Orchestrator | Stats Agent | Anomaly Agent | Root Cause Agent | Explorer Agent | Narrator |
|---|---|---|---|---|---|---|
| `source/meta` | R | — | — | — | — | R |
| `source/kpis` | R | R | — | — | — | — |
| `source/anomalies` | R | — | R | R | R | — |
| `source/data_summary` | R | — | — | — | R | — |
| `agents/stats/output` | R | **W** | — | — | — | R |
| `agents/anomaly/output` | R | — | **W** | R | R | R |
| `agents/root-cause/output` | R | — | — | **W** | — | R |
| `agents/explorer/output` | R | — | — | R | **W** | R |
| `agents/narrator/output` | R | — | — | — | — | **W** |
| `shared/anomaly-types` | R | — | R | R | — | R |
| `shared/root-cause-catalogue` | — | — | — | R | — | — |
| `shared/kpi-schema` | — | R | — | — | — | — |
| `shared/action-row-schema` | — | — | — | R | R | — |
| `session/notes` | R | A | A | A | A | R |
| `session/events` | R | R | R | R | R | R |
| `session/state` | **W** | R | R | R | R | R |
| `api/actions` | — | — | — | **call** | **call** | — |

### Permission Legend

| Symbol | Meaning |
|---|---|
| **R** | Read — can query current value at any time |
| **W** | Write — sole owner, can create/replace the value |
| **A** | Append — can add entries (session notes) but not modify/delete existing entries |
| **call** | Can invoke this external API endpoint |
| **—** | No access |

### What Changed from Hub-and-Spoke

| Change | Impact |
|---|---|
| Root Cause Agent can **read** `agents/anomaly/output` directly | No longer depends on Orchestrator to copy anomaly data into dispatch |
| Root Cause Agent can **read** `agents/explorer/output` | Can cross-reference explorer findings when available |
| Root Cause Agent gains `api/actions` **call** permission | Can fetch row-level data independently if payload lacks `flagged_by_type` |
| Explorer Agent can **read** `agents/anomaly/output` directly | Cross-references anomaly data without Orchestrator mediation |
| Narrator can **read** all agent outputs | Synthesizes everything available, not just Stats + Anomaly |
| Narrator can **read** `agents/root-cause/output` and `agents/explorer/output` | Richer synthesis — no longer blind to analysis and exploration results |
| All agents **read** `shared/anomaly-types` | Single source of truth for type keys, labels, groups, natures |
| All agents **append** to `session/notes` | Notes accumulate globally without Orchestrator relay |

---

## 5. Event Model

Events enable agents to **react** to peer outputs instead of waiting for the Orchestrator to dispatch them.

### 5.1 Event Types

| Event | Emitted When | Subscribers |
|---|---|---|
| `anomaly.confirmed` | Anomaly Agent writes status `CONFIRMED` | Root Cause Agent, Narrator |
| `anomaly.no_anomalies` | Anomaly Agent writes status `NO_ANOMALIES` | Narrator (proceeds with empty anomaly data) |
| `stats.confirmed` | Stats Agent writes status `CONFIRMED` | Narrator |
| `stats.no_data` | Stats Agent writes status `NO_DATA` | Narrator (proceeds with empty KPI data) |
| `rootcause.confirmed` | Root Cause Agent writes status `CONFIRMED` | Narrator, Explorer (optional enrichment) |
| `explorer.confirmed` | Explorer Agent writes status `CONFIRMED` | Narrator (optional enrichment) |
| `*.drill_requested` | Any agent writes `user_requested_drill` | Orchestrator (re-routes to target agent) |
| `*.halted` | Any agent writes status `HALTED` | Orchestrator (surfaces to user) |

### 5.2 Trigger Rules

Triggers define **which event combinations activate which agent**. The Orchestrator sets the initial plan (which agents should run), and triggers handle the sequencing automatically.

```
RULE: activate_root_cause
  WHEN: anomaly.confirmed
  AND:  session/state.intent IN [ROOT_CAUSE_ANALYSIS, FULL_ANALYSIS]
  THEN: activate root-cause-agent

RULE: activate_narrator
  WHEN: stats.confirmed OR stats.no_data
  AND:  anomaly.confirmed OR anomaly.no_anomalies
  AND:  session/state.intent IN [FULL_ANALYSIS, WORST_OFFENDER]
  THEN: activate narrator

RULE: enrich_narrator (optional)
  WHEN: narrator.status == AWAITING_USER_DIRECTION
  AND:  rootcause.confirmed OR explorer.confirmed
  THEN: narrator may re-read peer outputs and enrich synthesis

RULE: handle_drill_request
  WHEN: *.drill_requested
  THEN: orchestrator reads user_requested_drill value and routes to target agent
```

### 5.3 Parallel Execution

With events, parallel execution is implicit rather than hardcoded:

- **FULL_ANALYSIS**: Orchestrator activates Stats Agent and Anomaly Agent simultaneously. Each writes to its namespace independently. When both are done, the `activate_narrator` trigger fires.
- **ROOT_CAUSE_ANALYSIS**: Orchestrator activates Anomaly Agent. When `anomaly.confirmed` fires, `activate_root_cause` trigger activates Root Cause Agent automatically.
- **DATA_EXPLORATION**: Orchestrator activates Explorer Agent directly. No event dependencies.

---

## 6. Schema Drift Resolution

The audit found drift between output templates and SKILL.md contracts. The shared workspace resolves all of them:

| Drift | Resolution |
|---|---|
| `stats-output-template.json` missing `session_notes` | `agents/stats/output` schema requires it |
| `anomaly-output-template.json` missing `session_notes` | `agents/anomaly/output` schema requires it |
| `root-cause-output-template.json` missing `session_notes` | `agents/root-cause/output` schema requires it |
| `explorer-output-template.json` missing `detail_results[]` | `agents/explorer/output` schema requires it |
| `narrator-output-template.json` missing `session_notes` | `agents/narrator/output` schema requires it |
| `session-state-template.json` missing `explorer_output`, `session_notes` | Replaced by `session/state` + `session/notes` + direct namespace reads |
| Anomaly types defined in 2 separate files with no shared schema | Replaced by single `shared/anomaly-types` |
| Narrator references `trace-agent` which doesn't exist | `routing_suggestions` must reference agents in `session/state.agents_run` or a live capability registry (future) |

---

## 7. Migration Path

### Phase 1 — Schema Alignment (no architecture change)
1. Fix all 6 output template JSON files to match SKILL.md contracts (add missing fields).
2. Extract `shared/anomaly-types` from the two separate reference files.
3. Add `permissions` block to each agent's SKILL.md frontmatter declaring read/write intent.
4. No runtime behavior changes — the Orchestrator still dispatches. But contracts are now explicit and validated.

### Phase 2 — Direct Reads (partial mesh)
1. Agents read peer outputs directly from the workspace instead of receiving them in dispatch payloads.
2. Root Cause Agent reads `agents/anomaly/output` instead of receiving it from Orchestrator.
3. Explorer Agent reads `agents/anomaly/output` for cross-references instead of receiving `flagged_by_type` from Orchestrator.
4. Narrator reads all available agent outputs instead of a curated bundle.
5. Orchestrator dispatch payloads shrink — they contain only the agent's primary data source, not copies of peer outputs.

### Phase 3 — Event-Driven Sequencing (full mesh)
1. Implement the event model. Agent activation is triggered by peer status changes, not Orchestrator dispatch.
2. Orchestrator sets intent and activates initial agents. After that, triggers handle the rest.
3. Human-in-the-loop becomes configurable via `session/state.human_review_mode`.
4. Add capability registry so `routing_suggestions` only reference live agents.

### Phase 4 — Agent-to-Agent Requests
1. Root Cause Agent can request Explorer Agent to fetch specific row-level data.
2. Implement a request/response channel in the workspace (e.g. `requests/<target_agent>/<request_id>`).
3. This is the final step — true peer-to-peer communication without Orchestrator mediation.
