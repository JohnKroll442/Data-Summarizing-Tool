# Workspace Permissions — Explorer Agent

## Data Access

| Access | Namespace | Description |
|--------|-----------|-------------|
| read | source/data_summary | Full-dataset frequency aggregations (by_user, by_story, by_action) |
| read | agents/anomaly/output | For cross-referencing flagged actions against rankings (optional) |
| write | agents/explorer/output | This agent's confirmed output |
| append | session/notes | Session learning observations |
| read | shared/action-row-schema | Canonical action row shape for API response data |

## External APIs

| Method | Endpoint | Parameters | Access |
|--------|----------|------------|--------|
| GET | /api/actions | user, story, action_name, duration_min_ms, duration_max_ms | read |

## Notes

- Only agent with external API access (GET /api/actions).
- Rankings come from pre-aggregated data_summary arrays (pre-sorted descending, no cap).
- Cross-references flagged_by_type when available — this data comes from the anomaly section of the payload, currently mediated by the Orchestrator. In the mesh model, Explorer reads agents/anomaly/output directly.
- In the mesh model, Root Cause Agent would also gain access to GET /api/actions.
