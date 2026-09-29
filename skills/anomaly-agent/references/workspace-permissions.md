# Workspace Permissions — Anomaly Agent

## Data Access

| Access | Namespace | Description |
|--------|-----------|-------------|
| read | source/anomalies | Anomalies section of tool payload (counts, total_flagged, total_actions) |
| write | agents/anomaly/output | This agent's confirmed output |
| append | session/notes | Session learning observations |
| read | shared/anomaly-types | Canonical anomaly type registry (labels, descriptions, grouping) |

## External APIs

None.

## Notes

- Read-only access to the anomalies section of the tool payload.
- Writes only to its own output namespace.
- Cannot read KPI, explorer, or root cause data.
- The shared/anomaly-types registry replaces the local anomaly-type-reference.md as the canonical source for type keys, labels, descriptions, and group classification.
