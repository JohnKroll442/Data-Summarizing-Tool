import { aggregateBySession } from './sessionAggregate'
import { aggregateByAction } from './actionAggregate'
import { aggregateByWidget } from './widgetAggregate'
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
  const avgActions = agg.length ? mean(agg.map((r) => r.action_count)) : ''
  const maxDuration = mapping.duration
    ? maxOf(agg.map((r) => r.max_action_duration))
    : ''

  return [
    { label: 'Total sessions',       value: fmt(totalSessions, formatCount) },
    { label: 'Unique users',         value: fmt(uniqueUsers, formatCount) },
    { label: 'Avg actions / session', value: fmt(avgActions, (n) => n.toFixed(1)) },
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

  // Per-action total duration = max(frontend, network, backend) for that row.
  // Avg / slowest are computed across those per-action totals.
  const perAction = agg.map((r) => ({
    name: r.action_name,
    total: maxOfValues([r.max_frontend, r.max_network, r.max_backend]),
  })).filter((r) => Number.isFinite(r.total))

  const avgDuration = mapping.duration && perAction.length
    ? perAction.reduce((s, r) => s + r.total, 0) / perAction.length
    : ''
  let slowest = ''
  if (mapping.duration && perAction.length) {
    const top = perAction.reduce((a, b) => (b.total > a.total ? b : a))
    slowest = `${top.name || MISSING} · ${formatDurationMs(top.total)}`
  }

  return [
    { label: 'Total actions',   value: fmt(totalActions, formatCount) },
    { label: 'Unique names',    value: fmt(uniqueNames, formatCount) },
    { label: 'Avg duration',    value: fmt(avgDuration, formatDurationMs) },
    { label: 'Slowest action',  value: slowest || MISSING },
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
  const totalWidgets = mapping.widgetId ? agg.length : ''
  const avgRender  = mapping.measure ? mean(agg.map((r) => r.render))  : ''
  const avgNetwork = mapping.measure ? mean(agg.map((r) => r.network)) : ''
  const avgBackend = mapping.measure ? mean(agg.map((r) => r.backend)) : ''

  return [
    { label: 'Total widgets',      value: fmt(totalWidgets, formatCount) },
    { label: 'Avg render time',    value: fmt(avgRender,  formatDurationMs) },
    { label: 'Avg network time',   value: fmt(avgNetwork, formatDurationMs) },
    { label: 'Avg backend time',   value: fmt(avgBackend, formatDurationMs) },
  ]
}

/* ——— helpers ——— */

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

function mean(values) {
  let sum = 0
  let n = 0
  for (const v of values) {
    const num = Number(v)
    if (Number.isFinite(num)) { sum += num; n++ }
  }
  return n ? sum / n : ''
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
