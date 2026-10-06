# Workspace Permissions — Anomaly Agent

## Data Access

| Access | Namespace | Description |
|--------|-----------|-------------|
| read | source/anomalies | Anomalies section of tool payload (counts, total_flagged, total_actions) |
| write | agents/anomaly/output | This agent's confirmed output |
| append | session/notes | Session learning observations |
| read | references/anomaly-type-reference.md | Canonical anomaly type registry (labels, descriptions, grouping) — local, auto-inlined |

## External APIs

None.

## Notes

- Read-only access to the anomalies section of the tool payload.
- Writes only to its own output namespace.
- Cannot read KPI, explorer, or root cause data.
- The canonical source for type keys, labels, descriptions, and group classification is the local `references/anomaly-type-reference.md`, which is auto-inlined into this agent's prompt. There is no separate `shared/anomaly-types` registry — do not look for or defer to one.
