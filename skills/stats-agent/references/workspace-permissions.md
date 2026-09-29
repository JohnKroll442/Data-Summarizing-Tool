# Workspace Permissions — Stats Agent

## Data Access

| Access | Namespace | Description |
|--------|-----------|-------------|
| read | source/kpis | KPI array from tool payload |
| write | agents/stats/output | This agent's confirmed output |
| append | session/notes | Session learning observations |
| read | shared/kpi-schema | Canonical KPI field definitions |

## External APIs

None.

## Notes

- Read-only access to the kpis[] slice of the tool payload.
- Writes only to its own output namespace.
- Cannot read anomaly, explorer, or root cause data.
- The shared/kpi-schema defines the canonical key mapping (over_2m → over_threshold).
