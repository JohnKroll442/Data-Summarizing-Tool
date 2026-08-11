import { aggregateBySession } from './sessionAggregate'
import { aggregateByAction } from './actionAggregate'
import { aggregateByWidget } from './widgetAggregate'
import { SLOW_ACTION_MS } from './anomalyDetect'
import { formatCount, formatDurationMs } from './format'

const MISSING = '—'

/**
 * Compute KPI cards for a given view variant. Returns an array of
 * `{ label, value }` objects, or `null` when there are no rows to summarize.
 * Missing columns / no matching data render as an em dash.
 */
export function computeKpis(variant, rows, headers) {
  if (!rows?.length) return null
  const list = headers && headers.length ? headers : deriveHeaders(rows)
  switch (variant) {
    case 'session': return sessionKpis(rows, list)
    case 'action':  return actionKpis(rows, list)
    case 'widget':  return widgetKpis(rows, list)
    default: return null
  }
}

function deriveHeaders(rows) {
  const seen = new Set()
  for (const r of rows) {
    if (!r) continue
    for (const k of Object.keys(r)) seen.add(k)
  }
  return [...seen]
}

function sessionKpis(rows, headers) {
  const { rows: agg, mapping, sessionKey } = aggregateBySession(rows, headers)
  return sessionKpisFromAgg(agg, mapping, { hasSessions: Boolean(sessionKey) })
}

/**
 * Build the four session KPI cards from ALREADY-aggregated session rows (one
 * row per session, as produced by aggregateBySession). Exported so the summary
 * table can feed its filtered/visible rows here — keeping the KPIs in sync with
 * whatever the active filters currently show — without re-aggregating.
 *
 * `hasSessions` distinguishes "0 sessions currently visible" (show 0) from
 * "no session column could be detected" (show em dash); the raw-rows path
 * passes false in the latter case.
 */
export function sessionKpisFromAgg(agg, mapping, { hasSessions = true } = {}) {
  const totalSessions = hasSessions ? agg.length : ''
  const uniqueUsers = mapping.user ? distinct(agg.map((r) => r.user)) : ''
  // p95 of per-session total duration: 95% of sessions finished under this
  // value, so it marks where the slow tail begins — robust to the odd
  // left-open-over-lunch session that skews the max/average.
  const p95Duration = mapping.duration
    ? percentile(agg.map((r) => r.total_action_duration), 0.95)
    : ''
  const maxDuration = mapping.duration
    ? maxOf(agg.map((r) => r.max_action_duration))
    : ''

  return [
    { label: 'Total sessions',       value: fmt(totalSessions, formatCount) },
    { label: 'Unique users',         value: fmt(uniqueUsers, formatCount) },
    { label: 'p95 session duration', value: fmt(p95Duration, formatDurationMs) },
    { label: 'Max session duration', value: fmt(maxDuration, formatDurationMs) },
  ]
}

function actionKpis(rows, headers) {
  const { rows: agg, mapping } = aggregateByAction(rows, headers)
  return actionKpisFromAgg(agg, mapping)
}

/**
 * Build the action KPI cards from ALREADY-aggregated action rows (one row per
 * action, as produced by aggregateByAction). Exported so the summary table can
 * feed its filtered/visible rows here, keeping the KPIs in sync with the active
 * filters without re-aggregating.
 */
export function actionKpisFromAgg(agg, mapping) {
  const totalActions = mapping.actionName ? agg.length : ''
  const uniqueNames = mapping.actionName ? distinct(agg.map((r) => r.action_name)) : ''

  const durations = agg.map((r) => r.action_duration)

  // Median (p50) and p90 sit alongside p95: the median is the typical action,
  // p90/p95 mark where the slow tail begins. All three cover the action's real
  // wall-clock span (action start → last render end), so offset and every widget
  // phase are included.
  const medianDuration = percentile(durations, 0.5)
  const p90Duration = percentile(durations, 0.9)
  const p95Duration = percentile(durations, 0.95)

  // ">30s actions" — how many actions crossed the slow_action threshold (the
  // same 30s cutoff the anomaly detector uses), as a count + share of all
  // actions. Ties the headline number to the slow_action flag / panel row.
  const over30 = durations.reduce((n, v) => {
    const d = Number(v)
    return Number.isFinite(d) && d >= SLOW_ACTION_MS ? n + 1 : n
  }, 0)
  const over30Value = agg.length
    ? `${formatCount(over30)} (${Math.round((over30 / agg.length) * 100)}%)`
    : MISSING

  const perAction = agg.map((r) => ({
    name: r.action_name,
    total: maxOfValues([r.max_frontend, r.max_network, r.max_backend]),
  })).filter((r) => Number.isFinite(r.total))
  let slowest = ''
  if (perAction.length) {
    const top = perAction.reduce((a, b) => (b.total > a.total ? b : a))
    slowest = `${top.name || MISSING} · ${formatDurationMs(top.total)}`
  }

  return [
    { key: 'total_actions',   label: 'Total actions',       value: fmt(totalActions, formatCount) },
    { key: 'unique_names',    label: 'Unique names',         value: fmt(uniqueNames, formatCount) },
    { key: 'over_30s',        label: '>30s actions',         value: over30Value },
    { key: 'median_duration', label: 'Median duration',      value: fmt(medianDuration, formatDurationMs) },
    { key: 'p90_duration',    label: 'p90 duration',         value: fmt(p90Duration, formatDurationMs) },
    { key: 'p95_duration',    label: 'p95 action duration',  value: fmt(p95Duration, formatDurationMs) },
    { key: 'slowest_action',  label: 'Slowest action',       value: slowest || MISSING },
  ]
}

function widgetKpis(rows, headers) {
  const { rows: agg, mapping } = aggregateByWidget(rows, headers)
  return widgetKpisFromAgg(agg, mapping)
}

/**
 * Build the widget KPI cards from ALREADY-aggregated widget rows (one row per
 * widget, as produced by aggregateByWidget). Exported so the summary table can
 * feed its filtered/visible rows here, keeping the KPIs in sync with the active
 * filters without re-aggregating.
 */
export function widgetKpisFromAgg(agg, mapping) {
  // Per-phase p95s side by side (render / network / backend / total) so the
  // phase carrying the worst slow tail stands out at a glance. Averages hide —
  // and can even be distorted by — the sporadic outliers p95 is meant to catch,
  // so the four sit on the same footing for a direct comparison.
  const p95Render  = mapping.measure ? percentile(agg.map((r) => r.render),  0.95) : ''
  const p95Network = mapping.measure ? percentile(agg.map((r) => r.network), 0.95) : ''
  const p95Backend = mapping.measure ? percentile(agg.map((r) => r.backend), 0.95) : ''
  const p95Total   = mapping.measure ? percentile(agg.map((r) => r.total),   0.95) : ''

  return [
    { label: 'p95 render',  value: fmt(p95Render,  formatDurationMs) },
    { label: 'p95 network', value: fmt(p95Network, formatDurationMs) },
    { label: 'p95 backend', value: fmt(p95Backend, formatDurationMs) },
    { label: 'p95 total',   value: fmt(p95Total,   formatDurationMs) },
  ]
}

/* ——— helpers ——— */

/**
 * The p-th percentile (p in 0..1) of the numeric values, via linear
 * interpolation between the two closest ranks — the "inclusive" method used by
 * Excel's PERCENTILE.INC and NumPy's default. Non-finite values are ignored.
 * Returns '' when there's nothing to rank, so it flows through fmt() to an em
 * dash like the other metrics.
 */
export function percentile(values, p) {
  const nums = []
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n)) nums.push(n)
  }
  if (nums.length === 0) return ''
  if (nums.length === 1) return nums[0]
  nums.sort((a, b) => a - b)
  const rank = p * (nums.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return nums[lo]
  return nums[lo] + (nums[hi] - nums[lo]) * (rank - lo)
}

function fmt(v, formatter) {
  if (v === '' || v === null || v === undefined) return MISSING
  if (typeof v === 'number' && !Number.isFinite(v)) return MISSING
  return formatter(v)
}

function distinct(values) {
  const seen = new Set()
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue
    seen.add(String(v))
  }
  return seen.size
}

function maxOf(values) {
  let max = -Infinity
  let found = false
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n)) { if (n > max) max = n; found = true }
  }
  return found ? max : ''
}

function maxOfValues(values) {
  let max = -Infinity
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max === -Infinity ? '' : max
}
