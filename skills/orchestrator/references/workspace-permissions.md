# Workspace Permissions — Orchestrator

## Data Access

| Access | Namespace | Description |
|--------|-----------|-------------|
| read | source/* | Full tool payload (kpis, anomalies, data_summary, meta) |
| read | agents/stats/output | Stats Agent confirmed output |
| read | agents/anomaly/output | Anomaly Agent confirmed output |
| read | agents/root-cause/output | Root Cause Agent confirmed output |
| read | agents/explorer/output | Explorer Agent confirmed output |
| read | agents/narrator/output | Narrator confirmed output |
| write | session/state | Session phase, intent, cached agent outputs |
| read | session/notes | Accumulated session learning notes |
| read | shared/anomaly-types | Canonical anomaly type registry |
| read | shared/kpi-schema | Canonical KPI field definitions |

## External APIs

None.

## Notes

- The Orchestrator is the only agent that reads from ALL agent output namespaces.
- It maintains session state as the single source of conversational memory.
- It does NOT analyse data — it dispatches to specialist agents.
- In the current hub-and-spoke model, it also brokers data between agents. In the mesh model, agents read peer outputs directly and the Orchestrator becomes a lightweight router.
