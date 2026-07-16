import { useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import WaterfallIcon from './icons/WaterfallIcon'
import DataTable from './DataTable'
import KpiStrip from './KpiStrip'
import { FilterPills } from './FilterPill'
import { usePagination, PageSizeSelect, TablePager } from './Pagination'
import MultiFilterMenu from './MultiFilterMenu'
import TimeFilterMenu from './TimeFilterMenu'
import SortMenu from './SortMenu'
import { aggregateByAction, RECOGNIZED_MEASURES } from '../lib/actionAggregate'
import { actionKpisFromAgg } from '../lib/kpis'
import { applySessionFilter, applySessionMultiFilter, detectSessionKey } from '../lib/drillDown'
import { formatDurationMs } from '../lib/format'
import { sortRows } from '../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../lib/exportCsv'
import { matchesAllMultiFilters, countActiveMultiFilters, facetedOptionsByColumn } from '../lib/multiFilter'
import { matchesTimeFilter, hasTimeSelection, emptyTimeSelections } from '../lib/timeBuckets'
import { useCsvData } from '../context/useCsvData'
import './SessionSummaryTable.css'

// Row timestamp field for the Time filter (stable ref).
const ACTION_TS = (row) => row._action_timestamp

/**
 * ActionSummaryTable — one row per action, columns:
 *   User · Action name · Widget count · Max frontend · Max network · Max backend
 *
 * Aggregates rows down to one-row-per-action AFTER applying the
 * `sessionFilter` from the CSV context, so clicking a Session ID over on
 * Session View scopes this whole table to that session. A pill above the
 * filter bar shows the active session filter; an × clears it.
 *
 * Clicking the Action name cell sets the `actionFilter` (name + timestamp)
 * and routes to Widget View for the next level of drill-down.
 */
function ActionSummaryTable({ rows, headers, onOpenWaterfall }) {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    sessionFilter,
    setSessionFilter,
    setActionFilter,
    actionMultiFilter,
    setActionMultiFilter,
    sessionMultiFilter,
    setSessionMultiFilter,
    fileName,
  } = useCsvData()

  // Scope the input rows BEFORE aggregating. The multiselect Sessions filter,
  // when active, takes over the row scope (letting the user pick any set of
  // sessions from the whole file); otherwise the single-session drill-down
  // from Session View applies.
  const scopedRows = useMemo(() => {
    if (sessionMultiFilter.length > 0) {
      return applySessionMultiFilter(rows, headers, sessionMultiFilter)
    }
    return applySessionFilter(rows, headers, sessionFilter)
  }, [rows, headers, sessionFilter, sessionMultiFilter])

  // Session ids for the dropdown — ALL sessions in the file, so the user can
  // pick any session regardless of how they drilled in.
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

  const { rows: summaryRows, columns, mapping } = useMemo(
    () => aggregateByAction(scopedRows, headers),
    [scopedRows, headers]
  )

  const [search, setSearch] = useState('')
  // Seed the Action column filter from the shared actionMultiFilter so a
  // selection made elsewhere (drill-down or Widget View) shows here too —
  // matching how the Session column filter carries over. A one-shot
  // `summaryFilters` router state (from the Summary tab's top-10 rows) layers
  // on top, pre-selecting the clicked action + its story.
  const [filters, setFilters] = useState(() => {
    const seed = actionMultiFilter.length > 0 ? { action_name: actionMultiFilter } : {}
    const nav = location.state?.summaryFilters
    return nav ? { ...seed, ...nav } : seed
  })
  const [sort, setSort] = useState(null)
  const [timeFilter, setTimeFilter] = useState(emptyTimeSelections)

  // Faceted options: each dropdown lists only values that still apply given the
  // OTHER active column filters plus the time filter. The session scope is
  // already baked into summaryRows (rows are filtered before aggregation).
  const optionsByColumn = useMemo(
    () => facetedOptionsByColumn(summaryRows, FILTERABLE_COLUMNS, filters,
      (row) => matchesTimeFilter(row, ACTION_TS, timeFilter)),
    [summaryRows, filters, timeFilter],
  )

  // Rows the Time filter derives its buckets from — narrowed by the column
  // filters (but not by time itself) so the time options track the other menus.
  const timeFilterRows = useMemo(
    () => summaryRows.filter((row) => matchesAllMultiFilters(row, filters)),
    [summaryRows, filters],
  )

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return summaryRows.filter((row) => {
      if (!matchesAllMultiFilters(row, filters)) return false
      if (!matchesTimeFilter(row, ACTION_TS, timeFilter)) return false
      if (!needle) return true
      return columns.some((c) => {
        const v = row[c.key]
        if (v === undefined || v === null || v === '') return false
        return String(v).toLowerCase().startsWith(needle)
      })
    })
  }, [summaryRows, search, filters, columns, timeFilter])

  const sortedRows = useMemo(() => {
    if (!sort) return visibleRows
    const col = columns.find((c) => c.key === sort.key)
    return sortRows(visibleRows, sort.key, sort.dir, col?.sortType)
  }, [visibleRows, sort, columns])

  // KPIs track the filters: they summarize the actions currently visible (the
  // session scope + every local filter), not the whole file. `visibleRows` is
  // already the filtered set of aggregated action rows.
  const kpis = useMemo(
    () => actionKpisFromAgg(visibleRows, mapping),
    [visibleRows, mapping],
  )

  const { pageRows, page, setPage, pageSize, setPageSize, pageCount } =
    usePagination(sortedRows)

  const activeFilterCount =
    countActiveMultiFilters(filters, search) +
    (sessionMultiFilter.length > 0 ? 1 : 0) +
    (hasTimeSelection(timeFilter) ? 1 : 0)

  // Sanity-check the WIDGET_MEASURE values themselves. If the column exists
  // but contains none of render/frontend/network/backend/offset, every phase
  // max will be '' — surface that as a distinct warning so the user doesn't
  // think the durations are wrong.
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

  // Drill-down pill — render BEFORE the data-shape error gates so the user
  // can always escape an "0 actions for this session" empty state.

  // Update a local column filter, mirroring the Action column into the shared
  // multi-filter that Widget View reads (matches the drill-down flow).
  const updateFilter = (colKey, next) => {
    setFilters((prev) => ({ ...prev, [colKey]: next }))
    if (colKey === 'action_name') setActionMultiFilter(next)
  }

  // The active session scope: the multiselect Sessions filter when set,
  // otherwise the single-session drill-down from Session View.
  const sessionPillValues = sessionMultiFilter.length > 0
    ? sessionMultiFilter
    : (sessionFilter ? [sessionFilter] : [])

  const removeSession = (val) => {
    const next = sessionPillValues.filter((v) => v !== val)
    setSessionMultiFilter(next)
    // Clear the single drill-down too so scope and pills stay in sync.
    if (sessionFilter === val) setSessionFilter(null)
  }

  // Clear the whole Session scope at once (from the collapsed summary chip).
  const clearAllSessions = () => {
    setSessionMultiFilter([])
    setSessionFilter(null)
  }

  // One removable pill per active session, then one per selected value in the
  // local column filters (User / Action / Story / Page).
  const pillItems = [
    ...sessionPillValues.map((val) => ({
      key: `session:${val}`,
      label: 'Session',
      value: val,
      onClear: () => removeSession(val),
      onClearAll: clearAllSessions,
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
  const pill = <FilterPills items={pillItems} />

  if (!mapping.actionName) {
    return (
      <>
        {pill}
        <div className="summary-note">
          Couldn't find an action column in your CSV (looked for{' '}
          <code>USER_ACTION</code> / <code>ACTION_NAME</code>). Detected headers:{' '}
          <code>{headers.length === 0 ? '(none)' : headers.join(', ')}</code>
        </div>
      </>
    )
  }

  if (summaryRows.length === 0) {
    return (
      <>
        {pill}
        <div className="summary-note">
          {sessionMultiFilter.length > 0 ? (
            <>
              <strong>No actions match the selected sessions.</strong>{' '}
              <button
                type="button"
                className="summary-filter-clear"
                onClick={() => setSessionMultiFilter([])}
              >
                Clear session filter
              </button>
            </>
          ) : sessionFilter ? (
            <>
              <strong>No actions found for this session.</strong> Clear the
              filter above to see actions across every session.
            </>
          ) : (
            <>
              <strong>No actions could be built.</strong> Detected{' '}
              {scopedRows.length.toLocaleString()} CSV row{scopedRows.length === 1 ? '' : 's'},
              grouping by <code>{mapping.actionName}</code>{mapping.actionTimestamp ? <> + <code>{mapping.actionTimestamp}</code></> : null}.
              Every row had an empty value in {mapping.actionName}.
            </>
          )}
        </div>
      </>
    )
  }

  const missing = []
  if (!mapping.user)            missing.push('User')
  if (!mapping.actionTimestamp) missing.push('Action timestamp (without it, two invocations of the same action collapse into one row)')
  if (!mapping.widgetId)        missing.push('Widget count (needs a WIDGET_ID column)')
  if (!mapping.measure)         missing.push('Frontend / Network / Backend (needs a WIDGET_MEASURE column)')
  if (!mapping.duration)        missing.push('Frontend / Network / Backend durations (needs a DURATION column)')

  return (
    <>
      {pill}
      <KpiStrip variant="action" kpis={kpis} />
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
          <code>{unrecognizedMeasure}</code>. Frontend / Network / Backend columns
          will be empty until the values match.
        </div>
      )}

      <div className="summary-filters">
        <input
          type="search"
          className="summary-filter-search"
          placeholder="Search all actions…"
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
          getTimestamp={ACTION_TS}
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
            downloadCsv(buildExportFilename(fileName, 'action'), csv)
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
              setTimeFilter(emptyTimeSelections())
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
            if (c.key === 'action_name') {
              return (
                <div className="cell-link-row">
                  <button
                    type="button"
                    className="cell-link"
                    title={`Show widgets for "${row.action_name}"`}
                    onClick={() => {
                      setActionFilter({
                        name: row.action_name,
                        timestamp: row._action_timestamp ?? '',
                      })
                      // Preselect this action in Widget View's Actions filter
                      // so the dropdown reflects the drill-down ("1 selected").
                      // The Sessions scope carries over automatically.
                      setActionMultiFilter([String(row.action_name)])
                      navigate('/summary/widget')
                    }}
                  >
                    {String(v)}
                  </button>
                  {onOpenWaterfall && (
                    <button
                      type="button"
                      className="cell-icon-btn"
                      title="Open Action Waterfall Chart for this action"
                      aria-label={`Open Action Waterfall Chart for ${row.action_name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenWaterfall({
                          name: row.action_name,
                          timestamp: row._action_timestamp ?? '',
                        })
                      }}
                    >
                      <WaterfallIcon size={24} />
                    </button>
                  )}
                </div>
              )
            }
            return String(v)
          },
        }))}
        emptyMessage="No actions match your filters."
      />

      <TablePager page={page} pageCount={pageCount} onPage={setPage} />
    </>
  )
}

const FILTERABLE_COLUMNS = [
  { key: 'user',        label: 'User' },
  { key: 'action_name', label: 'Action' },
  { key: 'story_name',  label: 'Story' },
  { key: 'story_page',  label: 'Page' },
]
const DURATION_COLUMNS = new Set(['max_frontend', 'max_network', 'max_backend'])

export default ActionSummaryTable
