# Tool Data Schema Reference

## KPI Keys (actionKpisFromAgg)

The `kpis[]` array is produced by `actionKpisFromAgg()` in `src/lib/kpis.js`.
Each item has three fields: `key` (stable identifier), `label` (display string,
may vary with threshold settings), and `value` (pre-formatted string).

| key              | description                                                         | example value |
|------------------|---------------------------------------------------------------------|---------------|
| total_actions    | Total distinct action instances in the current view                 | "2,070"        |
| over_2m          | Actions exceeding the slow-action threshold — count + share         | "47 (2%)"      |
| median_duration  | p50 of action end-to-end duration (start to last render end)        | "4.6 s"        |
| p90_duration     | 90th percentile of action end-to-end duration                       | "22.6 s"       |
| p95_duration     | 95th percentile of action end-to-end duration                       | "40.4 s"       |

## Important: label vs key

The `label` on the `over_2m` item reflects the currently configured
slow-action threshold and will read ">30s actions", ">1m actions",
">2m actions", etc. depending on the user's setting.

Always use `key` to identify items — never `label`.

## Value format

Values are pre-formatted strings produced by `formatDurationMs()` and
`formatCount()` in `src/lib/format.js`.

Do NOT convert, parse, or reformat them. Pass them through exactly as received.

A value of `"—"` (em dash) means the data was unavailable for that metric.
Treat it the same as null in the output.

## Scope note

KPIs reflect the currently filtered/visible action set (bucketedRows in
ActionView.jsx), not necessarily the full dataset. The anomaly counts in
the payload reflect the full scoped dataset. These denominators may differ
when the user has an active duration bucket or column filter applied.