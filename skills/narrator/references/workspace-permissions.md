# Workspace Permissions — Narrator

## Data Access

| Access | Namespace | Description |
|--------|-----------|-------------|
| read | agents/stats/output | Confirmed Stats Agent output (or null) |
| read | agents/anomaly/output | Confirmed Anomaly Agent output (or null) |
| read | source/meta | File name, timestamp, scope from payload |
| read | source/anomalies.flagged_actions[0] | Single worst flagged action |
| read | session/notes | All upstream session notes (carried through, not modified) |
| write | agents/narrator/output | This agent's confirmed output |
| read | shared/anomaly-types | Canonical anomaly type registry |

## External APIs

None.

## Notes

- Synthesises Stats + Anomaly outputs. Does NOT currently read Root Cause or Explorer outputs (mesh gap — see roadmap).
- Carries through upstream session_notes — does NOT add its own.
- Requires both upstream agents to be CONFIRMED, NO_DATA, or NO_ANOMALIES before running.
- Caps top_types[] at 3 in output. This is a lossy synthesis for datasets with 4+ active types.
- routing_suggestions[] references trace-agent which does not yet exist. A live capability registry (Phase 3) would prevent dead references.
