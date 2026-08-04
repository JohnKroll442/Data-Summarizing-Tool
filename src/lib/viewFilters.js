/**
 * Shared view-filter pipeline.
 *
 * The Session / Action / Widget summary tables each turn their aggregated rows
 * into a "visible" set by running the same sequence of predicates (multi-select
 * column filters → time-bucket filter → timeline-window filter → duration
 * threshold → action-invocation filter → free-text search). `filterAggRows`
 * captures that sequence once so the tables and the Summary tab agree exactly.
 *
 * The Summary tab is never mounted at the same time as the view tables (they
 * share one <Outlet />), so it can't read a live table. Instead it re-derives
 * each view's visible entity set from persisted context state and intersects
 * them into a raw-row scope (`computeSummaryScope`) — a Session filter drops
 * that session's actions and widgets from the Summary, an Action filter drops
 * that action's widgets, etc.
 */

import { aggregateBySession } from './sessionAggregate'
import { aggregateByAction } from './actionAggregate'
import { aggregateByWidget } from './widgetAggregate'
import {
  detectSessionKey,
  applySessionFilter,
  applySessionMultiFilter,
  applyActionFilter,
  applyActionMultiFilter,
} from './drillDown'
import { matchesAllMultiFilters } from './multiFilter'
import { matchesTimeFilter, matchesTimeRange } from './timeBuckets'
import { matchesDurationFilter } from './durationFilter'

// Row → timestamp accessors, one per view. Stable module refs so callers can
// pass them straight into the time-bucket menus without recomputing.
export const SESSION_TS = (row) => row.timestamp_range
export const ACTION_TS = (row) => row._action_timestamp
export const WIDGET_TS = (row) =>
  row.render_start || row.network_start || row.backend_start ||
  row.render_end || row.network_end || row.backend_end || ''

/**
 * Filter a set of aggregated rows down to the visible set, applying the same
 * predicates (in the same order) every summary table uses. Options:
 *   tsAccessor       (row) => timestamp — for the time filters
 *   timeFilter       hierarchical time-bucket selections
 *   timelineRange    { min, max } | null — the Activity Timeline window
 *   filters          { [colKey]: string[] } multi-select column filters
 *   durationKey      aggregated column to threshold, or null to skip
 *   durationFilter   { minMs, maxMs } | null
 *   invocationFilter string[] of _action_timestamp (Action view only) or null
 *   search           free-text; matches when any display column startsWith it
 *   columns          display columns the search scans
 */
export function filterAggRows(aggRows, columns, {
  tsAccessor,
  timeFilter,
  timelineRange,
  filters = {},
  durationKey = null,
  durationFilter = null,
  invocationFilter = null,
  search = '',
} = {}) {
  const needle = String(search ?? '').trim().toLowerCase()
  const cols = columns ?? []
  return (aggRows ?? []).filter((row) => {
    if (!matchesAllMultiFilters(row, filters)) return false
    if (tsAccessor && !matchesTimeFilter(row, tsAccessor, timeFilter)) return false
    if (tsAccessor && !matchesTimeRange(row, tsAccessor, timelineRange)) return false
    if (durationKey && !matchesDurationFilter(row, durationKey, durationFilter ?? null)) return false
    if (Array.isArray(invocationFilter) && invocationFilter.length > 0 &&
        !invocationFilter.includes(String(row._action_timestamp))) return false
    if (!needle) return true
    return cols.some((c) => {
      const v = row[c.key]
      if (v === undefined || v === null || v === '') return false
      return String(v).toLowerCase().startsWith(needle)
    })
  })
}

/* ——— per-view re-derivation (used by the Summary tab) ——— */

// Build the effective multi-select column filters for a view from persisted
// per-view UI state, overlaying the global multi-select as the given column so
// a filter set outside the table (e.g. a timeline drill before the table ever
// mounted) is still reflected. Mirrors each table's seed/sync behavior.
function effectiveFilters(uiFilters, column, globalMulti) {
  const filters = { ...(uiFilters ?? {}) }
  if (Array.isArray(globalMulti) && globalMulti.length > 0) filters[column] = globalMulti
  else delete filters[column]
  return filters
}

function ui(state, view) {
  return state?.viewUi?.[view] ?? {}
}

/** Session view: no pre-aggregation scoping — aggregate all rows, then filter.
 * `includeDuration=false` skips the duration threshold — used when building the
 * Summary's membership gate, where the duration bound is applied per-ranking by
 * value instead of by session membership (see `computeSummaryScope`). */
export function visibleSessionRows(rows, headers, state, { includeDuration = true } = {}) {
  const agg = aggregateBySession(rows, headers)
  const u = ui(state, 'session')
  const visibleRows = filterAggRows(agg.rows, agg.columns, {
    tsAccessor: SESSION_TS,
    timeFilter: state.timeSelections,
    timelineRange: state.timelineRange,
    filters: effectiveFilters(u.filters, 'session', state.sessionMultiFilter),
    durationKey: 'total_action_duration',
    durationFilter: includeDuration ? (u.durationFilter ?? null) : null,
    search: u.search ?? '',
  })
  return { aggRows: agg.rows, visibleRows, mapping: agg.mapping, columns: agg.columns }
}

/** Action view: scope raw rows to the selected session(s), then aggregate.
 * `includeDuration` behaves as in `visibleSessionRows`. */
export function visibleActionRows(rows, headers, state, { includeDuration = true } = {}) {
  const scoped = state.sessionMultiFilter?.length > 0
    ? applySessionMultiFilter(rows, headers, state.sessionMultiFilter)
    : applySessionFilter(rows, headers, state.sessionFilter)
  const agg = aggregateByAction(scoped, headers)
  const u = ui(state, 'action')
  const visibleRows = filterAggRows(agg.rows, agg.columns, {
    tsAccessor: ACTION_TS,
    timeFilter: state.timeSelections,
    timelineRange: state.timelineRange,
    filters: effectiveFilters(u.filters, 'action_name', state.actionMultiFilter),
    durationKey: 'action_duration',
    durationFilter: includeDuration ? (u.durationFilter ?? null) : null,
    invocationFilter: state.actionInvocationFilter,
    search: u.search ?? '',
  })
  return { aggRows: agg.rows, visibleRows, mapping: agg.mapping, columns: agg.columns }
}

/** Widget view: scope raw rows by session then action, then aggregate. */
export function visibleWidgetRows(rows, headers, state) {
  const sessionScoped = state.sessionMultiFilter?.length > 0
    ? applySessionMultiFilter(rows, headers, state.sessionMultiFilter)
    : applySessionFilter(rows, headers, state.sessionFilter)
  const scoped = state.actionMultiFilter?.length > 0
    ? applyActionMultiFilter(sessionScoped, headers, state.actionMultiFilter)
    : applyActionFilter(sessionScoped, headers, state.actionFilter)
  const agg = aggregateByWidget(scoped, headers)
  const u = ui(state, 'widget')
  const visibleRows = filterAggRows(agg.rows, agg.columns, {
    tsAccessor: WIDGET_TS,
    timeFilter: state.timeSelections,
    timelineRange: state.timelineRange,
    filters: effectiveFilters(u.filters, 'widget_id', state.widgetMultiFilter),
    search: u.search ?? '',
  })
  return { aggRows: agg.rows, visibleRows, mapping: agg.mapping, columns: agg.columns }
}

// Composite action key matching aggregateByAction's grouping (name + timestamp).
const aggActionKey = (r) => `${r.action_name ?? ''}::${r._action_timestamp ?? ''}`

/**
 * Intersect all three views' visible entity sets into a raw-row scope for the
 * Summary tab. Returns `{ scopedRows }` (plus the id sets, for tests).
 *
 * Only NON-duration filters contribute a membership gate here. The duration
 * threshold is deliberately excluded (`includeDuration: false`) because the
 * Summary applies it per-ranking by each entity's own value (see
 * `activeDurationBounds` + `computeRankings`): a "> 2 min" bound must be able to
 * surface a long-network widget even when its session's action time is short,
 * which a session-membership gate would wrongly drop.
 *
 * A view contributes a gate only when its visible set is smaller than the
 * FULL (unscoped) aggregation for that entity — i.e. the view actually narrowed
 * something. That auto-handles "no active filter" (equal counts → no gate) and
 * "entity not detectable in this CSV" (both empty → no gate), so an unfiltered
 * or inapplicable view never zeroes the Summary. When no view narrows,
 * `scopedRows` is the original `rows` (referential identity) and the Summary
 * behaves exactly as before.
 */
export function computeSummaryScope(rows, headers, state) {
  if (!rows?.length || !headers?.length) return { scopedRows: rows ?? [] }

  const s = visibleSessionRows(rows, headers, state, { includeDuration: false })
  const a = visibleActionRows(rows, headers, state, { includeDuration: false })
  const w = visibleWidgetRows(rows, headers, state)

  // Baselines are the UNSCOPED aggregations, so drill-scoping (session/action
  // multi-filters applied before aggregation) also registers as narrowing.
  const sessionBaseline = s.aggRows.length // session view has no pre-scope
  const actionBaseline = aggregateByAction(rows, headers).rows.length
  const widgetBaseline = aggregateByWidget(rows, headers).rows.length

  const sessionIds = s.visibleRows.length < sessionBaseline
    ? new Set(s.visibleRows.map((r) => String(r.session)))
    : null
  const actionKeys = a.visibleRows.length < actionBaseline
    ? new Set(a.visibleRows.map(aggActionKey))
    : null
  const widgetIds = w.visibleRows.length < widgetBaseline
    ? new Set(w.visibleRows.map((r) => String(r.widget_id)))
    : null

  if (!sessionIds && !actionKeys && !widgetIds) return { scopedRows: rows }

  const sKey = detectSessionKey(headers, rows)
  const nameKey = a.mapping?.actionName
  const tsKey = a.mapping?.actionTimestamp
  const wKey = w.mapping?.widgetId

  const scopedRows = rows.filter((r) => {
    if (sessionIds && !sessionIds.has(String(r?.[sKey] ?? ''))) return false
    if (actionKeys) {
      const key = `${r?.[nameKey] ?? ''}::${tsKey ? (r?.[tsKey] ?? '') : ''}`
      if (!actionKeys.has(key)) return false
    }
    if (widgetIds && !widgetIds.has(String(r?.[wKey] ?? ''))) return false
    return true
  })

  return { scopedRows, sessionIds, actionKeys, widgetIds }
}

/**
 * The effective duration threshold the Summary rankings should honor, gathered
 * from every view that carries one (Session's "Total action duration", Action's
 * "Action duration"; Widget View has no duration UI). Returns a single
 * `{ minMs, maxMs }` — the INTERSECTION of the active bounds (tightest lower and
 * upper), so an entity must satisfy every set threshold — or `null` when none is
 * active. Applied per-ranking against each entity's own ranked value, so a
 * "< 2 min" bound hides any widget/action whose displayed time exceeds 2 min and
 * a "> 2 min" bound surfaces exactly the long (ttfb/incomplete) ones.
 */
export function activeDurationBounds(state) {
  const fs = [state?.viewUi?.session?.durationFilter, state?.viewUi?.action?.durationFilter]
    .filter(Boolean)
  let minMs = null
  let maxMs = null
  for (const f of fs) {
    if (f.minMs != null) minMs = minMs == null ? f.minMs : Math.max(minMs, f.minMs)
    if (f.maxMs != null) maxMs = maxMs == null ? f.maxMs : Math.min(maxMs, f.maxMs)
  }
  if (minMs == null && maxMs == null) return null
  return { minMs, maxMs }
}
