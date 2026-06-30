import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DataTable from './DataTable'
import FilterPill from './FilterPill'
import { aggregateByAction } from '../lib/actionAggregate'
import { applySessionFilter } from '../lib/drillDown'
import { formatDurationMs } from '../lib/format'
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
function ActionSummaryTable({ rows, headers }) {
  const navigate = useNavigate()
  const {
    sessionFilter,
    setSessionFilter,
    setActionFilter,
  } = useCsvData()

  // Scope the input rows to the active session BEFORE aggregating, so
  // counts and maxes only reflect that session's data.
  const scopedRows = useMemo(
    () => applySessionFilter(rows, headers, sessionFilter),
    [rows, headers, sessionFilter]
  )

  const { rows: summaryRows, columns, mapping } = useMemo(
    () => aggregateByAction(scopedRows, headers),
    [scopedRows, headers]
  )

  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({})

  const optionsByColumn = useMemo(() => {
    const out = {}
    for (const col of FILTERABLE_COLUMNS) {
      const set = new Set()
      for (const row of summaryRows) {
        const v = row?.[col]
        if (v === undefined || v === null || v === '') continue
        set.add(String(v))
      }
      out[col] = Array.from(set).sort((a, b) => a.localeCompare(b))
    }
    return out
  }, [summaryRows])

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return summaryRows.filter((row) => {
      for (const [col, val] of Object.entries(filters)) {
        if (!val) continue
        if (String(row[col] ?? '') !== val) return false
      }
      if (!needle) return true
      return columns.some((c) => {
        const v = row[c.key]
        if (v === undefined || v === null || v === '') return false
        return String(v).toLowerCase().includes(needle)
      })
    })
  }, [summaryRows, search, filters, columns])

  const activeFilterCount =
    Object.values(filters).filter(Boolean).length + (search.trim() ? 1 : 0)

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
          {sessionFilter ? (
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
  if (!mapping.user)     missing.push('User')
  if (!mapping.widgetId) missing.push('Widget count (needs a WIDGET_ID column)')
  if (!mapping.measure)  missing.push('Frontend / Network / Backend (needs a WIDGET_MEASURE column)')
  if (!mapping.duration) missing.push('Frontend / Network / Backend durations (needs a DURATION column)')

  return (
    <>
      {pill}
      {missing.length > 0 && (
        <div className="summary-note">
          Some columns couldn't be auto-matched and show as <code>—</code>:{' '}
          <strong>{missing.join(', ')}</strong>.
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
        {FILTERABLE_COLUMNS.map((col) => {
          const opts = optionsByColumn[col] ?? []
          if (opts.length === 0) return null
          return (
            <select
              key={col}
              className="summary-filter-select"
              value={filters[col] ?? ''}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, [col]: e.target.value }))
              }
            >
              <option value="">{COLUMN_LABEL[col]}: any</option>
              {opts.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          )
        })}
        <span className="summary-filter-count">
          {visibleRows.length} of {summaryRows.length}
        </span>
        {activeFilterCount > 0 && (
          <button
            type="button"
            className="summary-filter-clear"
            onClick={() => {
              setSearch('')
              setFilters({})
            }}
          >
            Clear
          </button>
        )}
      </div>

      <DataTable
        rows={visibleRows}
        columns={columns.map((c) => ({
          ...c,
          render: (v, row) => {
            if (v === '' || v === undefined || v === null) return '—'
            if (DURATION_COLUMNS.has(c.key)) return formatDurationMs(v)
            if (c.key === 'action_name') {
              return (
                <button
                  type="button"
                  className="cell-link"
                  title={`Show widgets for "${row.action_name}"`}
                  onClick={() => {
                    setActionFilter({
                      name: row.action_name,
                      timestamp: row._action_timestamp ?? '',
                    })
                    navigate('/summary/widget')
                  }}
                >
                  {String(v)}
                </button>
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

const FILTERABLE_COLUMNS = ['user', 'action_name']
const COLUMN_LABEL = {
  user: 'User',
  action_name: 'Action',
}
const DURATION_COLUMNS = new Set(['max_frontend', 'max_network', 'max_backend'])

export default ActionSummaryTable
