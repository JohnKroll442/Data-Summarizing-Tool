# Agent Capability Catalogue

This catalogue describes what each agent can answer and what data it requires.
The Orchestrator reads this in Phase 0 to reason about which agent to dispatch.
Do NOT use keyword matching — reason about the user's information need.

---

## Stats Agent

**Owns:** `kpis[]` array from the payload.

**Can answer:**
- How many total actions are in the dataset
- How many actions crossed the slow-action threshold
- What the median, p90, and p95 action durations are
- What threshold is currently configured

**Cannot answer:** anomaly types, root causes, user rankings, story frequency

**Dispatch input:** `{ "kpis": payload.kpis }`

---

## Anomaly Agent

**Owns:** `anomalies.counts` and `total_flagged` from the payload.

**Can answer:**
- Which anomaly types were active in this dataset
- How many actions were flagged for each type
- What percentage of actions had anomalies
- What each anomaly type means
- Whether types are performance issues or data quality issues

**Cannot answer:** root causes, user rankings, KPI percentiles, row-level detail

**Dispatch input:** `{ "anomalies": { "counts": payload.anomalies.counts, "total_flagged": payload.anomalies.total_flagged, "total_actions": payload.anomalies.total_actions } }`

---

## Root Cause Agent

**Owns:** Explanation of active anomaly types + row-level flagged action data.

**Can answer:**
- Why specific anomaly types occur
- What causes each active anomaly type
- What to investigate to confirm a root cause
- Whether anomalies are performance issues or data quality artifacts
- Which users, sessions, and timestamps are behind each anomaly type
- Whether a specific user appears across multiple anomaly types

**Cannot answer:** anomaly counts, KPI values, full-dataset user rankings

**Dispatch input:**
```json
{
  "active_headline_types": "<from anomaly_output>",
  "active_phase_types": "<from anomaly_output>",
  "total_flagged": "<from anomaly_output>",
  "total_actions": "<from anomaly_output>",
  "flagged_by_type": "<payload.anomalies.flagged_by_type>",
  "flagged_actions": "<payload.anomalies.flagged_actions>"
}
```

---

## Explorer Agent

**Owns:** `data_summary` section of the payload — full-dataset frequency data,
plus row-level detail via the tool's API endpoint.

**Operates in two modes:**

**Ranking mode** — reads `by_user[]`, `by_story[]`, `by_action[]` from `data_summary`.
All entities are included (no top-N cap). Arrays are pre-sorted by `action_count` descending.

**Detail mode** — calls `GET /api/actions` with filter params to fetch row data:
- `user=<user>` — filter by user
- `story=<story_name>` — filter by story
- `action_name=<action>` — filter by action name
- `duration_min_ms=<ms>` / `duration_max_ms=<ms>` — duration range filter
- Returns: `[{ action_name, story_name, user, session_id, action_duration_ms, action_timestamp }]`

**Can answer:**
- Which user appears most frequently across ALL actions (not just flagged)
- Which story has the most actions
- Which action name occurs most often
- Complete rankings for all users, stories, or action types
- Dataset-level counts and percentages by user, story, or action type
- All actions performed by a specific user (detail mode)
- All actions in a specific story (detail mode)
- Actions exceeding a duration threshold (detail mode)
- Whether the most active user also appears in flagged actions (cross-reference)

**Cannot answer:** anomaly analysis, root causes, KPI percentiles

**Dispatch input:**
```json
{
  "data_summary": {
    "total_actions": 0,
    "total_unique_users": 0,
    "total_unique_stories": 0,
    "total_unique_action_types": 0,
    "by_user":   [ { "user": "<string>", "action_count": 0, "pct_of_total": 0.0 } ],
    "by_story":  [ { "story_name": "<string>", "action_count": 0, "pct_of_total": 0.0 } ],
    "by_action": [ { "action_name": "<string>", "action_count": 0, "pct_of_total": 0.0 } ]
  },
  "flagged_by_type": "<payload.anomalies.flagged_by_type>",
  "question": "<user's exact question>"
}
```

---

## Narrator

**Owns:** Synthesis of Stats Agent and Anomaly Agent confirmed outputs.

**Can answer:**
- Combined headline statement about the dataset
- Top anomaly types in priority order (max 3)
- KPI snapshot alongside anomaly findings
- Worst-performing flagged action
- Which agents to route to next (routing suggestions)
- Learning observations from upstream agents (session notes)

**Cannot answer:** new analysis, root causes, user rankings, any finding not produced by upstream agents

**Dispatch input:** Stats + Anomaly confirmed outputs + meta + top_flagged_action

---

## Trace Agent (mesh-native)

**Owns:** Widget-level timing data via `GET /api/widgets`.

**Mesh reads:** anomaly-agent output, root-cause-agent output (both optional, from store).

**Operates in two modes:**

**Detail mode** — investigates a single flagged action's widgets.
- Shows waterfall table: each widget's offset, render, network, backend, total
- Identifies bottleneck widget and dominant phase
- Classifies loading pattern (sequential vs parallel)
- Verifies data quality with raw numbers

**Aggregation mode** — scans across all flagged actions of a type.
- Finds repeat offender widgets
- Reports cross-action patterns

**Can answer:**
- Which widget was the bottleneck in a flagged action
- What phase (render/network/backend) dominated a widget's time
- Whether widgets loaded sequentially or in parallel
- Whether data quality anomaly numbers actually add up (raw verification)
- Which widget names are repeat offenders across multiple flagged actions

**Cannot answer:** root causes (Root Cause Agent), anomaly counts (Anomaly Agent), KPIs (Stats Agent), user rankings (Explorer Agent)

**Dispatch input:**
```json
{
  "dataset_id": "<from payload.meta.dataset_id>",
  "question": "<user's question>",
  "flagged_by_type": "<payload.anomalies.flagged_by_type>",
  "flagged_actions": "<payload.anomalies.flagged_actions>"
}
```

---

## Routing Decision Examples

| User says | Reasoning | Route to |
|---|---|---|
| "what are the root causes" | Needs explanation of WHY — analysis required | Root Cause Agent |
| "which user appeared most in the data" | Needs full-dataset frequency ranking | Explorer Agent (ranking mode) |
| "show me all DVIJAYAN's actions" | Needs row-level detail for a specific user | Explorer Agent (detail mode) |
| "actions in story X" | Needs filtered row data for a story | Explorer Agent (detail mode) |
| "actions over 5 minutes" | Needs duration-filtered rows | Explorer Agent (detail mode) |
| "how many actions were flagged" | Needs anomaly count data | Anomaly Agent |
| "what is the p95 duration" | Needs latency percentile | Stats Agent |
| "give me everything" | Needs combined summary | FULL_ANALYSIS → Narrator |
| "what about the straggler users" | Needs row-level user data for a specific type | Root Cause Agent (Step 8) |
| "what was the worst action" | Can be answered from session state if Narrator ran | CONVERSATIONAL |
| "which widget was slowest" | Needs widget-level timing data | Trace Agent (detail mode) |
| "show me the widget breakdown" | Needs per-widget phase timing | Trace Agent (detail mode) |
| "what happened inside this action" | Needs widget waterfall for a specific action | Trace Agent (detail mode) |
| "is the same widget always slow" | Needs cross-action widget patterns | Trace Agent (aggregation mode) |
| "verify the data quality numbers" | Needs raw timestamp math verification | Trace Agent (detail mode) |
