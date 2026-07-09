import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import WaterfallIcon from './icons/WaterfallIcon'
import DataTable from './DataTable'
import FilterPill from './FilterPill'
import MultiFilterMenu from './MultiFilterMenu'
import SortMenu from './SortMenu'
import { aggregateByAction, RECOGNIZED_MEASURES } from '../lib/actionAggregate'
import { applySessionFilter, applySessionMultiFilter, detectSessionKey } from '../lib/drillDown'
import { formatDurationMs } from '../lib/format'
import { sortRows } from '../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../lib/exportCsv'
import { matchesAllMultiFilters, countActiveMultiFilters } from '../lib/multiFilter'
import { useCsvData } from '../context/useCsvData'
import './SessionSummaryTable.css'

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
  const {
    sessionFilter,
    setSessionFilter,
    setActionFilter,
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
  const [filters, setFilters] = useState({})
  const [sort, setSort] = useState(null)

  const optionsByColumn = useMemo(() => {
    const out = {}
    for (const col of FILTERABLE_COLUMNS) {
      const set = new Set()
      for (const row of summaryRows) {
        const v = row?.[col.key]
        if (v === undefined || v === null || v === '') continue
        set.add(String(v))
      }
      out[col.key] = Array.from(set).sort((a, b) => a.localeCompare(b))
    }
    return out
  }, [summaryRows])

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return summaryRows.filter((row) => {
      if (!matchesAllMultiFilters(row, filters)) return false
      if (!needle) return true
      return columns.some((c) => {
        const v = row[c.key]
        if (v === undefined || v === null || v === '') return false
        return String(v).toLowerCase().includes(needle)
      })
    })
  }, [summaryRows, search, filters, columns])

  const sortedRows = useMemo(() => {
    if (!sort) return visibleRows
    const col = columns.find((c) => c.key === sort.key)
    return sortRows(visibleRows, sort.key, sort.dir, col?.sortType)
  }, [visibleRows, sort, columns])

  const activeFilterCount =
    countActiveMultiFilters(filters, search) + (sessionMultiFilter.length > 0 ? 1 : 0)

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
  const pill = sessionFilter ? (
    <FilterPill
      label="Session"
      value={sessionFilter}
      onClear={() => {
        setSessionFilter(null)
        navigate('/summary/session')
      }}
    />
  ) : null

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
              onChange={(next) =>
                setFilters((prev) => ({ ...prev, [col.key]: next }))
              }
            />
          )
        })}
        <SortMenu columns={columns} sort={sort} onSortChange={setSort} />
        <span className="summary-filter-count">
          {visibleRows.length} of {summaryRows.length}
        </span>
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
            }}
          >
            Clear
          </button>
        )}
      </div>

      <DataTable
        rows={sortedRows}
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
