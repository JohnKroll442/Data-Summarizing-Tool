import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DataTable from './DataTable'
import KpiStrip from './KpiStrip'
import { FilterPills } from './FilterPill'
import { usePagination, PageSizeSelect, TablePager } from './Pagination'
import MultiFilterMenu from './MultiFilterMenu'
import TimeFilterMenu from './TimeFilterMenu'
import SortMenu from './SortMenu'
import { aggregateBySession } from '../lib/sessionAggregate'
import { sessionKpisFromAgg } from '../lib/kpis'
import { formatDurationMs, formatCsvTime } from '../lib/format'
import { sortRows } from '../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../lib/exportCsv'
import { matchesAllMultiFilters, countActiveMultiFilters, facetedOptionsByColumn } from '../lib/multiFilter'
import { matchesTimeFilter, hasTimeSelection, emptyTimeSelections } from '../lib/timeBuckets'
import { useCsvData } from '../context/useCsvData'
import './SessionSummaryTable.css'

// Which field carries the row's timestamp for the Time filter (stable ref so
// the menu's bucket memo doesn't recompute every render).
const SESSION_TS = (row) => row.timestamp_range

/**
 * SessionSummaryTable — one row per session, columns:
 *   Session · User · Story · Action count · Max action duration
 *
 * Shows ALL sessions by default. A free-text search box and per-column
 * dropdowns let the user narrow to specific User/Story/Session values.
 * If a column couldn't be auto-detected, its cells render "—" and a small
 * note tells the user which CSV columns are missing.
 */
function SessionSummaryTable({ rows, headers }) {
  const navigate = useNavigate()
  const { setSessionFilter, setActionFilter, sessionMultiFilter, setSessionMultiFilter, sessionFilterWindow, setSessionFilterWindow, fileName } = useCsvData()

  const { rows: summaryRows, columns, mapping, sessionKey } = useMemo(
    () => aggregateBySession(rows, headers),
    [rows, headers]
  )

  const [search, setSearch] = useState('')
  // Seed the Session column filter from the shared sessionMultiFilter so a
  // selection made elsewhere (drill-down or Action View) shows here too.
  const [filters, setFilters] = useState(() =>
    sessionMultiFilter.length > 0 ? { session: sessionMultiFilter } : {}
  )
  const [sort, setSort] = useState(null)
  const [timeFilter, setTimeFilter] = useState(emptyTimeSelections)

  // Keep the Session column filter in sync when sessionMultiFilter changes from
  // OUTSIDE this table (e.g. clicking a Sessions bar in the Activity Timeline
  // while this view is already mounted — the mount-time seed above only runs
  // once). Idempotent: it no-ops when the values already match, so it doesn't
  // fight updateFilter (which sets both to the same value) or loop. Does NOT
  // mirror back out — only the incoming direction.
  useEffect(() => {
    setFilters((prev) => {
      const cur = Array.isArray(prev.session) ? prev.session : []
      if (sameStringSet(cur, sessionMultiFilter)) return prev
      const next = { ...prev }
      if (sessionMultiFilter.length > 0) next.session = sessionMultiFilter
      else delete next.session
      return next
    })
  }, [sessionMultiFilter])

  // Faceted options: each dropdown lists only values that still apply given the
  // OTHER active column filters plus the time filter, so the menus stay in sync.
  const optionsByColumn = useMemo(
    () => facetedOptionsByColumn(summaryRows, FILTERABLE_COLUMNS, filters,
      (row) => matchesTimeFilter(row, SESSION_TS, timeFilter)),
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
      if (!matchesTimeFilter(row, SESSION_TS, timeFilter)) return false
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

  // KPIs track the filters: they summarize the rows currently visible, not the
  // whole file. `visibleRows` is already the filtered set of aggregated session
  // rows, so we compute the cards straight off it (no re-aggregation).
  const kpis = useMemo(
    () => sessionKpisFromAgg(visibleRows, mapping),
    [visibleRows, mapping],
  )

  const { pageRows, page, setPage, pageSize, setPageSize, pageCount } =
    usePagination(sortedRows)

  const activeFilterCount =
    countActiveMultiFilters(filters, search) + (hasTimeSelection(timeFilter) ? 1 : 0)

  // Update a column's selected values, mirroring the Session column into the
  // shared multi-filter that Action View reads (matches the drill-down flow).
  const updateFilter = (colKey, next) => {
    setFilters((prev) => ({ ...prev, [colKey]: next }))
    if (colKey === 'session') {
      setSessionMultiFilter(next)
      // The user changed the session set by hand, so the timeline window that
      // seeded it no longer describes what's shown — drop the label.
      setSessionFilterWindow(null)
    }
  }

  // One removable pill per selected value across every filterable column, so
  // filtering two sessions shows two "Session" pills, etc.
  const pillItems = FILTERABLE_COLUMNS.flatMap((col) => {
    const selected = Array.isArray(filters[col.key]) ? filters[col.key] : []
    return selected.map((val) => ({
      key: `${col.key}:${val}`,
      label: col.label,
      value: val,
      onClear: () => updateFilter(col.key, selected.filter((v) => v !== val)),
      onClearAll: () => updateFilter(col.key, []),
    }))
  })

  if (!sessionKey) {
    return (
      <div className="summary-note">
        Couldn't find a session column in your CSV (looked for{' '}
        <code>SESSION_ID</code> / <code>BROWSERSESSION_ID</code> /{' '}
        <code>session</code>). Detected headers were:{' '}
        <code>{headers.length === 0 ? '(none)' : headers.join(', ')}</code>
      </div>
    )
  }

  // If we DO have a session key but ended up with zero summary rows, the
  // CSV parsed but every value in the session column was empty — or the
  // file produced zero data rows in the first place. Surface that clearly.
  if (summaryRows.length === 0) {
    return (
      <div className="summary-note">
        <strong>No sessions could be built.</strong> Detected{' '}
        {rows.length.toLocaleString()} CSV row{rows.length === 1 ? '' : 's'},
        grouping by <code>{sessionKey}</code>.{' '}
        {rows.length === 0
          ? 'The file appears to have parsed with zero data rows — check the delimiter/encoding.'
          : `Every row had an empty value in ${sessionKey}.`}{' '}
        Headers detected:{' '}
        <code>{headers.length === 0 ? '(none)' : headers.join(', ')}</code>
      </div>
    )
  }

  const missing = []
  if (!mapping.user)     missing.push('User')
  if (!mapping.story)    missing.push('Story')
  if (!mapping.duration) missing.push('Max action duration')

  return (
    <>
      <KpiStrip variant="session" kpis={kpis} />

      {missing.length > 0 && (
        <div className="summary-note">
          Some columns couldn't be auto-matched and show as <code>—</code>:{' '}
          <strong>{missing.join(', ')}</strong>. Rename the relevant CSV
          columns (e.g. <code>USER_NAME</code>, <code>STORY_NAME</code>,{' '}
          <code>DURATION</code>) and re-upload.
        </div>
      )}

      <FilterPills items={pillItems} />

      <div className="summary-filters">
        <input
          type="search"
          className="summary-filter-search"
          placeholder="Search all sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
          getTimestamp={SESSION_TS}
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
            downloadCsv(buildExportFilename(fileName, 'session'), csv)
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
              setSessionFilterWindow(null)
              setTimeFilter(emptyTimeSelections())
            }}
          >
            Clear
          </button>
        )}
      </div>

      {sessionFilterWindow && Array.isArray(filters.session) && filters.session.length > 0 && (
        <div className="summary-active-window" role="status">
          <span className="summary-active-window-dot" aria-hidden="true" />
          Showing sessions active <strong>{sessionFilterWindow}</strong>
          <span className="summary-active-window-count">
            · {filters.session.length} session{filters.session.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      <DataTable
        rows={pageRows}
        sort={sort}
        onSortChange={setSort}
        columns={columns.map((c) => ({
          ...c,
          render: (v, row) => {
            if (c.key === 'timestamp_range') {
              const start = formatCsvTime(v)
              const end = formatCsvTime(row._timestamp_end)
              if (!start && !end) return '—'
              if (!end || start === end) return start || end
              return `${start} → ${end}`
            }
            if (v === '' || v === undefined || v === null) return '—'
            if (c.key === 'max_action_duration') return formatDurationMs(v)
            if (c.key === 'total_action_duration') return formatDurationMs(v)
            if (c.key === 'session') {
              return (
                <button
                  type="button"
                  className="cell-link"
                  title={`Show actions for session ${row.session}`}
                  onClick={() => {
                    setSessionFilter(String(row.session))
                    // Preselect this session in Action View's Sessions filter
                    // so the dropdown reflects the drill-down ("1 selected").
                    setSessionMultiFilter([String(row.session)])
                    // Clear any deeper drill-down so Action View shows
                    // a fresh, unfiltered set of actions for this session.
                    setActionFilter(null)
                    navigate('/summary/action')
                  }}
                >
                  {String(v)}
                </button>
              )
            }
            return String(v)
          },
        }))}
        emptyMessage={
          summaryRows.length === 0
            ? 'No sessions found in the CSV.'
            : 'No sessions match your filters.'
        }
      />

      <TablePager page={page} pageCount={pageCount} onPage={setPage} />
    </>
  )
}

const FILTERABLE_COLUMNS = [
  { key: 'session', label: 'Session' },
  { key: 'user',    label: 'User' },
  { key: 'story',   label: 'Story' },
]

// Order-insensitive equality for two string arrays — used to skip redundant
// filter updates when the external multi-filter already matches the local one.
function sameStringSet(a, b) {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((v) => set.has(v))
}

export default SessionSummaryTable
