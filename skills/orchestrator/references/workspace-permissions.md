# Workspace Permissions — Orchestrator

## Data Access

All analysis runs through the single `unified-agent` skill (selected per dispatch
via `agent_mode`), not through separate per-agent namespaces. The orchestrator
holds all cached outputs in its own session state.

| Access | Namespace | Description |
|--------|-----------|-------------|
| read | source/* | Full tool payload (kpis, anomalies, data_summary, meta) |
| write | session/state | Session phase, intent, and all cached unified-agent outputs |
| read | session/notes | Accumulated session learning notes |
| read | shared/anomaly-types | Canonical anomaly type registry |
| read | shared/kpi-schema | Canonical KPI field definitions |

Cached output slots on `session_state`:
`stats_output`, `anomaly_output`, `root_cause_output`, `explorer_output`,
`narrator_output`, `trace_output`.

## External APIs

None directly. The `widget_trace` mode may call `GET /api/widgets` in interactive
Joule use; in the backend pipeline its widget data is pre-fetched.

## Notes

- It does NOT analyse data — it classifies intent and dispatches the unified-agent
  in the appropriate mode.
