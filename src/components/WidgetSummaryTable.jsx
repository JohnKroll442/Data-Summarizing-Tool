import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import DataTable from './DataTable'
import KpiStrip from './KpiStrip'
import { FilterPills } from './FilterPill'
import { usePagination, PageSizeSelect, TablePager } from './Pagination'
import MultiFilterMenu from './MultiFilterMenu'
import TimeFilterMenu from './TimeFilterMenu'
import SortMenu from './SortMenu'
import WidgetTimingModal from './WidgetTimingModal'
import { aggregateByWidget } from '../lib/widgetAggregate'
import { widgetKpisFromAgg } from '../lib/kpis'
import { RECOGNIZED_MEASURES } from '../lib/actionAggregate'
import {
  applySessionFilter,
  applySessionMultiFilter,
  applyActionFilter,
  applyActionMultiFilter,
  detectSessionKey,
  findActionNameKey,
} from '../lib/drillDown'
import { formatDurationMs, formatCsvTime, formatTimeRangeLabel } from '../lib/format'
import { sortRows } from '../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../lib/exportCsv'
import { matchesAllMultiFilters, countActiveMultiFilters, facetedOptionsByColumn } from '../lib/multiFilter'
import { matchesTimeFilter, matchesTimeRange, hasTimeSelection, emptyTimeSelections } from '../lib/timeBuckets'
import { useCsvData } from '../context/useCsvData'
import './SessionSummaryTable.css'

// Row timestamp field for the Time filter — the earliest phase time available
// on the aggregated widget row (stable ref).
const WIDGET_TS = (row) =>
  row.render_start || row.network_start || row.backend_start ||
  row.render_end || row.network_end || row.backend_end || ''

/**
 * WidgetSummaryTable — one row per distinct widget, columns:
 *   Widget ID · Widget name · Render · Network · Backend
 *
 * Honors BOTH the active sessionFilter and actionFilter from the CSV
 * context. Filtering happens BEFORE aggregation, so the maxes reflect only
 * widgets that ran in the chosen scope. Two pills at the top show the
 * active filters; clicking the × on either clears just that filter.
 */
function WidgetSummaryTable({ rows, headers }) {
  const location = useLocation()
  const {
    sessionFilter,
    setSessionFilter,
    actionFilter,
    setActionFilter,
    sessionMultiFilter,
    setSessionMultiFilter,
    actionMultiFilter,
    setActionMultiFilter,
    timelineRange,
    resetTimeline,
    fileName,
    timeSelections: timeFilter,
    setTimeSelections: setTimeFilter,
    widgetMultiFilter,
    setWidgetMultiFilter,
    widgetFilterWindow,
    setWidgetFilterWindow,
  } = useCsvData()

  // Scope rows BEFORE aggregating. Each multiselect filter, when active, takes
  // over its dimension's row scope (letting the user pick any set of sessions
  // /actions from the whole file); otherwise the single drill-down from the
  // Session/Action views applies. Session and action scoping compose.
  //
  // Split out the session-only scope so the Actions menu can offer just the
  // actions that occur in the selected sessions (Session → Action hierarchy).
  const sessionScopedRows = useMemo(
    () =>
      sessionMultiFilter.length > 0
        ? applySessionMultiFilter(rows, headers, sessionMultiFilter)
        : applySessionFilter(rows, headers, sessionFilter),
    [rows, headers, sessionFilter, sessionMultiFilter],
  )

  const scopedRows = useMemo(
    () =>
      actionMultiFilter.length > 0
        ? applyActionMultiFilter(sessionScopedRows, headers, actionMultiFilter)
        : applyActionFilter(sessionScopedRows, headers, actionFilter),
    [sessionScopedRows, headers, actionFilter, actionMultiFilter],
  )

  // Session ids — ALL sessions in the file, so the user can pick any session
  // regardless of how they drilled in (Sessions is the top-level scope).
  const sessionOptions = useMemo(() => {
    const key = detectSessionKey(headers, rows)
    if (!key) return []
    const set = new Set()
    for (const r of rows) {
      const v = r?.[key]
      if (v === undefined || v === null || v === '') continue
      set.add(String(v))
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [rows, headers])

  // Action names — only those present in the session-scoped rows, so the menu
  // tracks the selected sessions like every other filter. Any already-selected
  // action is kept so a selection never vanishes from its own menu.
  const actionOptions = useMemo(() => {
    const key = findActionNameKey(headers)
    if (!key) return []
    const set = new Set()
    for (const r of sessionScopedRows) {
      const v = r?.[key]
      if (v === undefined || v === null || v === '') continue
      set.add(String(v))
    }
    for (const v of actionMultiFilter) set.add(String(v))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [sessionScopedRows, headers, actionMultiFilter])

  const { rows: summaryRows, columns, mapping } = useMemo(
    () => aggregateByWidget(scopedRows, headers),
    [scopedRows, headers]
  )

  const [search, setSearch] = useState('')
  // A one-shot `summaryFilters` router state (from the Summary tab's top-10
  // rows) seeds the column filters so clicking a widget lands here scoped to
  // just that widget. The shared widgetMultiFilter (a timeline Widgets-bar
  // drill) also seeds the Widget-ID column filter so it shows here too.
  const [filters, setFilters] = useState(() => {
    const nav = location.state?.summaryFilters
    const seed = widgetMultiFilter.length > 0 ? { widget_id: widgetMultiFilter } : {}
    return nav ? { ...seed, ...nav } : seed
  })

  // Keep the Widget-ID column filter in sync when widgetMultiFilter changes from
  // OUTSIDE this table (e.g. clicking a Widgets bar in the Activity Timeline
  // while this view is already mounted). Idempotent; mirrors SessionSummaryTable.
  useEffect(() => {
    setFilters((prev) => {
      const cur = Array.isArray(prev.widget_id) ? prev.widget_id : []
      if (sameStringSet(cur, widgetMultiFilter)) return prev
      const next = { ...prev }
      if (widgetMultiFilter.length > 0) next.widget_id = widgetMultiFilter
      else delete next.widget_id
      return next
    })
  }, [widgetMultiFilter])
  const [sort, setSort] = useState(null)
  // Clicking a widget name opens the per-widget timing modal. We store the
  // index of the selected widget within the filtered + sorted rows (null =
  // closed) so the modal's picker/arrows can flip through exactly the widgets
  // shown in the table.
  const [timingIdx, setTimingIdx] = useState(null)

  // Faceted options: each dropdown lists only values that still apply given the
  // OTHER active column filters plus the time filter. The session/action scope
  // is already baked into summaryRows (rows are filtered before aggregation).
  const optionsByColumn = useMemo(
    () => facetedOptionsByColumn(summaryRows, FILTERABLE_COLUMNS, filters,
      (row) => matchesTimeFilter(row, WIDGET_TS, timeFilter)
        && matchesTimeRange(row, WIDGET_TS, timelineRange)),
    [summaryRows, filters, timeFilter, timelineRange],
  )

  // Rows the Time filter derives its buckets from — narrowed by the column
  // filters and the timeline range (but not by time itself) so the time options
  // track the other menus and the selected timeline window.
  const timeFilterRows = useMemo(
    () => summaryRows.filter((row) =>
      matchesAllMultiFilters(row, filters) && matchesTimeRange(row, WIDGET_TS, timelineRange)),
    [summaryRows, filters, timelineRange],
  )

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return summaryRows.filter((row) => {
      if (!matchesAllMultiFilters(row, filters)) return false
      if (!matchesTimeFilter(row, WIDGET_TS, timeFilter)) return false
      if (!matchesTimeRange(row, WIDGET_TS, timelineRange)) return false
      if (!needle) return true
      return columns.some((c) => {
        const v = row[c.key]
        if (v === undefined || v === null || v === '') return false
        return String(v).toLowerCase().startsWith(needle)
      })
    })
  }, [summaryRows, search, filters, columns, timeFilter, timelineRange])

  const sortedRows = useMemo(() => {
    if (!sort) return visibleRows
    const col = columns.find((c) => c.key === sort.key)
    return sortRows(visibleRows, sort.key, sort.dir, col?.sortType)
  }, [visibleRows, sort, columns])

  // KPIs track the filters: they summarize the widgets currently visible (the
  // session/action scope + every local filter), not the whole file.
  const kpis = useMemo(
    () => widgetKpisFromAgg(visibleRows, mapping),
    [visibleRows, mapping],
  )

  const { pageRows, page, setPage, pageSize, setPageSize, pageCount } =
    usePagination(sortedRows)

  // Resolve one widget summary row into the rows the timing chart needs: the
  // raw rows for that widget, plus the rows for its parent action (to anchor
  // the Action End markLine). Same logic the widget-name click used inline.
  const resolveWidgetTiming = useCallback((summaryRow) => {
    const widgetId = summaryRow.widget_id
    const idKey = mapping.widgetId
    const rowsForWidget = idKey
      ? scopedRows.filter((r) => String(r?.[idKey] ?? '') === String(widgetId))
      : []
    // Identify the parent action from the widget's own rows so the chart's
    // Action Start / End markLines reflect just that action — not the whole
    // session. Try the ACTION_TIMESTAMP column first, else fall back to all
    // scoped rows.
    const actionTsKey = findActionTimestampKey(headers)
    let actionRows = scopedRows
    if (actionTsKey && rowsForWidget.length) {
      const ts = String(rowsForWidget[0]?.[actionTsKey] ?? '')
      if (ts) {
        actionRows = scopedRows.filter((r) => String(r?.[actionTsKey] ?? '') === ts)
      }
    }
    return {
      widgetName: summaryRow.widget_name || String(widgetId),
      widgetRows: rowsForWidget,
      actionRows,
    }
  }, [scopedRows, headers, mapping.widgetId])

  // The navigable widget list for the modal's picker + the resolved rows for
  // the currently-selected widget. Built only while the modal is open, from the
  // filtered + sorted rows, so the picker/arrows navigate exactly what's shown.
  const widgetPickList = useMemo(
    () =>
      timingIdx == null
        ? []
        : sortedRows.map((r) => ({
            key: String(r.widget_id),
            label: r.widget_name || String(r.widget_id),
          })),
    [timingIdx, sortedRows],
  )
  const timingModal = useMemo(() => {
    if (timingIdx == null) return null
    const row = sortedRows[timingIdx]
    return row ? resolveWidgetTiming(row) : null
  }, [timingIdx, sortedRows, resolveWidgetTiming])

  const activeFilterCount =
    countActiveMultiFilters(filters, search) +
    (sessionMultiFilter.length > 0 ? 1 : 0) +
    (actionMultiFilter.length > 0 ? 1 : 0) +
    (hasTimeSelection(timeFilter) ? 1 : 0) +
    (timelineRange ? 1 : 0)

  const unrecognizedMeasure = useMemo(() => {
    if (!mapping.measure) return null
    const seen = new Set()
    for (const r of scopedRows) {
      const v = r?.[mapping.measure]
      if (v === undefined || v === null || v === '') continue
      seen.add(String(v).toLowerCase())
    }
    if (seen.size === 0) return null
    const wanted = new Set(RECOGNIZED_MEASURES)
    for (const v of seen) if (wanted.has(v)) return null
    return Array.from(seen).slice(0, 8).join(', ')
  }, [scopedRows, mapping.measure])

  const updateFilter = (colKey, next) => {
    setFilters((prev) => ({ ...prev, [colKey]: next }))
    if (colKey === 'widget_id') {
      // Mirror hand-edits of the Widget-ID filter back to the shared drill state,
      // and drop the timeline window label since it no longer describes the set.
      setWidgetMultiFilter(next)
      setWidgetFilterWindow(null)
    }
  }

  // Active session / action scope: the multiselect filter when set, otherwise
  // the single-value drill-down from the Session / Action views.
  const sessionPillValues = sessionMultiFilter.length > 0
    ? sessionMultiFilter
    : (sessionFilter ? [sessionFilter] : [])
  const actionPillValues = actionMultiFilter.length > 0
    ? actionMultiFilter
    : (actionFilter ? [actionFilter.name] : [])

  const removeSession = (val) => {
    setSessionMultiFilter(sessionPillValues.filter((v) => v !== val))
    if (sessionFilter === val) {
      setSessionFilter(null)
      setActionFilter(null)
    }
  }
  const removeAction = (val) => {
    setActionMultiFilter(actionPillValues.filter((v) => v !== val))
    if (actionFilter && actionFilter.name === val) setActionFilter(null)
  }

  // Clear a whole scope at once (from a collapsed summary chip).
  const clearAllSessions = () => {
    setSessionMultiFilter([])
    setSessionFilter(null)
  }
  const clearAllActions = () => {
    setActionMultiFilter([])
    setActionFilter(null)
  }

  // One removable pill per active session, then per active action, then per
  // selected value in the local column filters.
  const pillItems = [
    ...sessionPillValues.map((val) => ({
      key: `session:${val}`,
      label: 'Session',
      value: val,
      onClear: () => removeSession(val),
      onClearAll: clearAllSessions,
    })),
    ...actionPillValues.map((val) => ({
      key: `action:${val}`,
      label: 'Action',
      value: val,
      onClear: () => removeAction(val),
      onClearAll: clearAllActions,
    })),
    ...FILTERABLE_COLUMNS.flatMap((col) => {
      const selected = Array.isArray(filters[col.key]) ? filters[col.key] : []
      return selected.map((val) => ({
        key: `${col.key}:${val}`,
        label: col.label,
        value: val,
        onClear: () => updateFilter(col.key, selected.filter((v) => v !== val)),
        onClearAll: () => updateFilter(col.key, []),
      }))
    }),
  ]
  const pills = <FilterPills items={pillItems} />

  if (!mapping.widgetId) {
    return (
      <>
        {pills}
        <div className="summary-note">
          Couldn't find a <code>WIDGET_ID</code> column in your CSV. Detected headers:{' '}
          <code>{headers.length === 0 ? '(none)' : headers.join(', ')}</code>
        </div>
      </>
    )
  }

  if (summaryRows.length === 0) {
    const multiActive = sessionMultiFilter.length > 0 || actionMultiFilter.length > 0
    return (
      <>
        {pills}
        <div className="summary-note">
          {multiActive ? (
            <>
              <strong>No widgets match the selected sessions/actions.</strong>{' '}
              <button
                type="button"
                className="summary-filter-clear"
                onClick={() => {
                  setSessionMultiFilter([])
                  setActionMultiFilter([])
                }}
              >
                Clear session/action filters
              </button>
            </>
          ) : actionFilter || sessionFilter ? (
            <>
              <strong>No widgets found for the active filter{actionFilter && sessionFilter ? 's' : ''}.</strong>{' '}
              Clear the pill{actionFilter && sessionFilter ? 's' : ''} above to broaden the view.
            </>
          ) : (
            <>
              <strong>No widgets could be built.</strong> Detected{' '}
              {scopedRows.length.toLocaleString()} CSV row{scopedRows.length === 1 ? '' : 's'},
              grouping by <code>{mapping.widgetId}</code>. Every row had an
              empty value in {mapping.widgetId}.
            </>
          )}
        </div>
      </>
    )
  }

  const missing = []
  if (!mapping.widgetName)            missing.push('Widget name')
  if (!mapping.measure)               missing.push('Render / Network / Backend (needs a WIDGET_MEASURE column)')
  if (!mapping.duration)              missing.push('Render / Network / Backend durations (needs a DURATION column)')
  const canDerivePhaseTimes = mapping.rowTimestamp && mapping.duration
  if (!canDerivePhaseTimes && (!mapping.renderTimestampStart || !mapping.renderTimestamp)) {
    missing.push('Render start / end times (needs WIDGET_RENDER_TIMESTAMP_START + WIDGET_RENDER_TIMESTAMP)')
  }
  if (!canDerivePhaseTimes && (!mapping.widgetTimestampStart || !mapping.widgetTimestamp)) {
    missing.push('Network/Backend start / end times (needs WIDGET_TIMESTAMP_START + WIDGET_TIMESTAMP)')
  }

  return (
    <>
      {pills}
      <KpiStrip variant="widget" kpis={kpis} />
      {missing.length > 0 && (
        <div className="summary-note">
          Some columns couldn't be auto-matched and show as <code>—</code>:{' '}
          <strong>{missing.join(', ')}</strong>.
        </div>
      )}
      {unrecognizedMeasure && (
        <div className="summary-note">
          <strong>Unrecognized phase tags in <code>{mapping.measure}</code>.</strong>{' '}
          Expected values like <code>render</code> / <code>network</code> /{' '}
          <code>backend</code> / <code>offset</code> but saw:{' '}
          <code>{unrecognizedMeasure}</code>. Render / Network / Backend columns
          will be empty until the values match.
        </div>
      )}

      {timelineRange && (
        <div className="summary-active-window is-centered" role="status">
          Showing rows within the timeline range{' '}
          <strong>{formatTimeRangeLabel(timelineRange.min, timelineRange.max)}</strong>
          <button
            type="button"
            className="summary-active-window-clear"
            onClick={resetTimeline}
            title="Reset the Activity Timeline to its full range"
          >
            Clear
          </button>
        </div>
      )}

      {widgetFilterWindow && Array.isArray(filters.widget_id) && filters.widget_id.length > 0 && (
        <div className="summary-active-window" role="status">
          <span className="summary-active-window-dot" aria-hidden="true" />
          Showing widgets active <strong>{widgetFilterWindow}</strong>
          <span className="summary-active-window-count">
            · {filters.widget_id.length} widget{filters.widget_id.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      <div className="summary-filters">
        <input
          type="search"
          className="summary-filter-search"
          placeholder="Search all widgets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {sessionOptions.length > 0 && (
          <MultiFilterMenu
            label="Sessions"
            options={sessionOptions}
            selected={sessionMultiFilter}
            onChange={setSessionMultiFilter}
          />
        )}
        {actionOptions.length > 0 && (
          <MultiFilterMenu
            label="Actions"
            options={actionOptions}
            selected={actionMultiFilter}
            onChange={setActionMultiFilter}
          />
        )}
        {FILTERABLE_COLUMNS.map((col) => {
          const opts = optionsByColumn[col.key] ?? []
          if (opts.length === 0) return null
          const selected = Array.isArray(filters[col.key]) ? filters[col.key] : []
          return (
            <MultiFilterMenu
              key={col.key}
              label={col.label}
              options={opts}
              selected={selected}
              onChange={(next) => updateFilter(col.key, next)}
            />
          )
        })}
        <TimeFilterMenu
          rows={timeFilterRows}
          getTimestamp={WIDGET_TS}
          value={timeFilter}
          onChange={setTimeFilter}
        />
        <SortMenu columns={columns} sort={sort} onSortChange={setSort} />
        <span className="summary-filter-count">
          {visibleRows.length} of {summaryRows.length}
        </span>
        <PageSizeSelect value={pageSize} onChange={setPageSize} />
        <button
          type="button"
          className="summary-filter-export"
          disabled={sortedRows.length === 0}
          title={sortedRows.length === 0 ? 'No rows to export' : 'Download visible rows as CSV'}
          onClick={() => {
            const csv = rowsToCsv(sortedRows, columns)
            downloadCsv(buildExportFilename(fileName, 'widget'), csv)
          }}
        >
          Export CSV
        </button>
        {activeFilterCount > 0 && (
          <button
            type="button"
            className="summary-filter-clear"
            onClick={() => {
              setSearch('')
              setFilters({})
              setSessionMultiFilter([])
              setActionMultiFilter([])
              setWidgetMultiFilter([])
              setWidgetFilterWindow(null)
              setTimeFilter(emptyTimeSelections())
              resetTimeline()
            }}
          >
            Clear
          </button>
        )}
      </div>

      <DataTable
        rows={pageRows}
        sort={sort}
        onSortChange={setSort}
        columns={columns.map((c) => ({
          ...c,
          render: (v, row) => {
            if (v === '' || v === undefined || v === null) return '—'
            if (DURATION_COLUMNS.has(c.key)) return formatDurationMs(v)
            if (TIME_COLUMNS.has(c.key)) return formatCsvTime(v)
            if (c.key === 'widget_name') {
              return (
                <button
                  type="button"
                  className="cell-link"
                  title={`Open timing chart for "${row.widget_name}"`}
                  onClick={() => {
                    // Open on this widget's position within the filtered +
                    // sorted rows, so the modal's arrows/picker step through
                    // exactly the widgets shown in the table.
                    const idx = sortedRows.findIndex(
                      (r) => String(r.widget_id) === String(row.widget_id)
                    )
                    setTimingIdx(idx >= 0 ? idx : 0)
                  }}
                >
                  {String(v)}
                </button>
              )
            }
            return String(v)
          },
        }))}
        emptyMessage="No widgets match your filters."
      />

      <TablePager page={page} pageCount={pageCount} onPage={setPage} />

      <WidgetTimingModal
        open={timingModal != null}
        onClose={() => setTimingIdx(null)}
        widgetName={timingModal?.widgetName}
        widgetRows={timingModal?.widgetRows ?? []}
        actionRows={timingModal?.actionRows ?? []}
        items={widgetPickList}
        index={timingIdx ?? 0}
        onIndexChange={(next) =>
          setTimingIdx(Math.max(0, Math.min(sortedRows.length - 1, next)))
        }
      />
    </>
  )
}

const FILTERABLE_COLUMNS = [
  { key: 'widget_id',   label: 'Widget ID' },
  { key: 'widget_name', label: 'Widget name' },
]
const DURATION_COLUMNS = new Set(['render', 'network', 'backend', 'offset'])
const TIME_COLUMNS = new Set([
  'render_start', 'render_end',
  'network_start', 'network_end',
  'backend_start', 'backend_end',
])

// Match the same heuristic actionAggregate uses — exact "ACTION_TIMESTAMP"
// (case/punctuation-insensitive) first, then substring fallback, ignoring
// columns that look like end-times.
function findActionTimestampKey(headers) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_\-.]+/g, '')
  for (const h of headers) {
    if (norm(h) === 'actiontimestamp') return h
  }
  for (const h of headers) {
    const n = norm(h)
    if (n.includes('actiontimestamp') && !n.includes('end')) return h
  }
  for (const h of headers) {
    if (norm(h) === 'timestamp') return h
  }
  for (const h of headers) {
    const n = norm(h)
    if (n.includes('timestamp') && !n.includes('end')) return h
  }
  return ''
}

// Order-insensitive equality for two string arrays — used to skip redundant
// filter updates when the shared widget multi-filter already matches the local
// widget_id column filter.
function sameStringSet(a, b) {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((v) => set.has(v))
}

export default WidgetSummaryTable
