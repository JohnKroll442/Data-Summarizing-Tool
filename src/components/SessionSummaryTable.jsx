import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import AnalyticalDataTable from './AnalyticalDataTable'
import KpiStrip from './KpiStrip'
import { HeaderPortal } from '../context/HeaderSlot'
import { FilterPills } from './FilterPill'
import BackButton from './BackButton'
import { usePagination, PageSizeSelect, TablePager } from './Pagination'
import MultiFilterMenu from './MultiFilterMenu'
import TimeFilterMenu from './TimeFilterMenu'
import PhaseHoverCell from './PhaseHoverCell'
import DurationFilterMenu from './DurationFilterMenu'
import { aggregateBySession } from '../lib/sessionAggregate'
import { sessionKpisFromAgg } from '../lib/kpis'
import { formatDurationMs, formatTimeRangeLabel } from '../lib/format'
import { sortRows } from '../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../lib/exportCsv'
import { matchesAllMultiFilters, countActiveMultiFilters, facetedOptionsByColumn } from '../lib/multiFilter'
import { matchesTimeFilter, matchesTimeRange, hasTimeSelection, emptyTimeSelections } from '../lib/timeBuckets'
import { matchesDurationFilter } from '../lib/durationFilter'
import { filterAggRows, SESSION_TS } from '../lib/viewFilters'
import { useCsvData } from '../context/useCsvData'
import './SessionSummaryTable.css'

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
  const location = useLocation()
  const { setSessionFilter, setActionFilter, sessionMultiFilter, setSessionMultiFilter, sessionFilterWindow, setSessionFilterWindow, timelineRange, resetTimeline, fileName, timeSelections: timeFilter, setTimeSelections: setTimeFilter, pushNavSnapshot, viewUi, setViewUi, viewedItems, markViewed } = useCsvData()

  const { rows: summaryRows, columns, mapping, sessionKey } = useMemo(
    () => aggregateBySession(rows, headers),
    [rows, headers]
  )

  // Seed the local UI filters from the persisted per-view state so they stay
  // constant across navigation (tab switches, drill + Back) — they only reset
  // on a file swap or an explicit Clear. Fall back to the shared
  // sessionMultiFilter for the Session column when nothing's persisted yet.
  const [search, setSearch] = useState(() => viewUi.session.search)
  const [filters, setFilters] = useState(() => {
    const persisted = viewUi.session.filters
    if (persisted && Object.keys(persisted).length > 0) return persisted
    return sessionMultiFilter.length > 0 ? { session: sessionMultiFilter } : {}
  })
  const [sort, setSort] = useState(() => viewUi.session.sort)
  // Threshold filter for the Total action duration column: { op, ms } or null.
  const [durationFilter, setDurationFilter] = useState(() => viewUi.session.durationFilter)

  // Write UI-filter changes back to the persisted store so they survive this
  // view unmounting. setViewUi is stable and only touches the session slice,
  // so this can't loop: writing back doesn't change these local values.
  useEffect(() => {
    setViewUi('session', { search, filters, sort, durationFilter })
  }, [search, filters, sort, durationFilter, setViewUi])

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
  // OTHER active column filters plus the time filter and the timeline range, so
  // the menus stay in sync with what's visible.
  const optionsByColumn = useMemo(
    () => facetedOptionsByColumn(summaryRows, FILTERABLE_COLUMNS, filters,
      (row) => matchesTimeFilter(row, SESSION_TS, timeFilter)
        && matchesTimeRange(row, SESSION_TS, timelineRange)
        && matchesDurationFilter(row, 'total_action_duration', durationFilter)),
    [summaryRows, filters, timeFilter, timelineRange, durationFilter],
  )

  // Rows the Time filter derives its buckets from — narrowed by the column
  // filters, the duration filter, and the timeline range (but not by time
  // itself) so the time options track the other menus and the selected window.
  const timeFilterRows = useMemo(
    () => summaryRows.filter((row) =>
      matchesAllMultiFilters(row, filters)
        && matchesTimeRange(row, SESSION_TS, timelineRange)
        && matchesDurationFilter(row, 'total_action_duration', durationFilter)),
    [summaryRows, filters, timelineRange, durationFilter],
  )

  const visibleRows = useMemo(
    () => filterAggRows(summaryRows, columns, {
      tsAccessor: SESSION_TS,
      timeFilter,
      timelineRange,
      filters,
      durationKey: 'total_action_duration',
      durationFilter,
      search,
    }),
    [summaryRows, search, filters, columns, timeFilter, timelineRange, durationFilter],
  )

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
    countActiveMultiFilters(filters, search) + (hasTimeSelection(timeFilter) ? 1 : 0) +
    (timelineRange ? 1 : 0) + (durationFilter ? 1 : 0)

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
      <HeaderPortal>
        <KpiStrip variant="session" kpis={kpis} />
      </HeaderPortal>

      {missing.length > 0 && (
        <div className="summary-note">
          Some columns couldn't be auto-matched and show as <code>—</code>:{' '}
          <strong>{missing.join(', ')}</strong>. Rename the relevant CSV
          columns (e.g. <code>USER_NAME</code>, <code>STORY_NAME</code>,{' '}
          <code>DURATION</code>) and re-upload.
        </div>
      )}

      <BackButton />
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
        <DurationFilterMenu
          label="Total duration"
          value={durationFilter}
          onChange={setDurationFilter}
        />
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
              setDurationFilter(null)
              resetTimeline()
            }}
          >
            Clear
          </button>
        )}
      </div>

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

      {sessionFilterWindow && Array.isArray(filters.session) && filters.session.length > 0 && (
        <div className="summary-active-window" role="status">
          <span className="summary-active-window-dot" aria-hidden="true" />
          Showing sessions active <strong>{sessionFilterWindow}</strong>
          <span className="summary-active-window-count">
            · {filters.session.length} session{filters.session.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      <AnalyticalDataTable
        rows={pageRows}
        sort={sort}
        onSortChange={setSort}
        isRowViewed={(row) => Boolean(viewedItems.session[String(row.session)])}
        columns={columns.map((c) => ({
          ...c,
          render: (v, row) => {
            if (v === '' || v === undefined || v === null) return '—'
            if (c.key === 'max_action_duration') return formatDurationMs(v)
            // Total action duration reveals the session's start + end times on
            // hover, matching the Widget view's phase cells (see PhaseHoverCell).
            if (c.key === 'total_action_duration') {
              return (
                <PhaseHoverCell
                  label="Session"
                  start={row.timestamp_range}
                  end={row._timestamp_end}
                >
                  {formatDurationMs(v)}
                </PhaseHoverCell>
              )
            }
            if (c.key === 'session') {
              return (
                <button
                  type="button"
                  className="cell-link"
                  title={`Show actions for session ${row.session}`}
                  onClick={() => {
                    // Record this Session View so Back can return to it.
                    pushNavSnapshot(location.pathname)
                    // Mark this session as viewed so its row stays tinted.
                    markViewed('session', row.session)
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
