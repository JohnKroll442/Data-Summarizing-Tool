# Workspace Permissions — Root Cause Agent

## Data Access

| Access | Namespace | Description |
|--------|-----------|-------------|
| read | agents/anomaly/output | Confirmed Anomaly Agent output (Layer 1 input) |
| read | source/anomalies.flagged_by_type | Per-type flagged action rows (Layer 2) |
| read | source/anomalies.flagged_actions | All flagged action rows with flags array (Layer 2) |
| write | agents/root-cause/output | This agent's confirmed output |
| append | session/notes | Session learning observations |
| read | shared/anomaly-types | Canonical anomaly type registry (nature, root_cause, what_to_look_for) |
| read | shared/action-row-schema | Canonical action row shape for Layer 2 data |

## External APIs

None currently. Future mesh: GET /api/actions for direct row-level drill.

## Notes

- First agent in the workflow to consume another agent's output (reads agents/anomaly/output).
- Layer 2 data (flagged_by_type, flagged_actions) is optional — enables Step 8 row-level queries.
- The shared/anomaly-types registry replaces the local root-cause-catalogue.md as the canonical source for root causes, nature classification, and what_to_look_for.
- Currently does NOT have API access. In the mesh model, it would gain GET /api/actions to fetch row-level data directly without Orchestrator mediation.
