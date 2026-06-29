import { useMemo, useState } from 'react'
import DataTable from './DataTable'
import FilterPill from './FilterPill'
import { aggregateByWidget } from '../lib/widgetAggregate'
import { applySessionFilter, applyActionFilter } from '../lib/drillDown'
import { formatDurationMs } from '../lib/format'
import { useCsvData } from '../context/useCsvData'
import './SessionSummaryTable.css'

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
  const {
    sessionFilter,
    setSessionFilter,
    actionFilter,
    setActionFilter,
  } = useCsvData()

  // Apply session filter first (broader), then action filter (narrower).
  const scopedRows = useMemo(() => {
    const afterSession = applySessionFilter(rows, headers, sessionFilter)
    return applyActionFilter(afterSession, headers, actionFilter)
  }, [rows, headers, sessionFilter, actionFilter])

  const { rows: summaryRows, columns, mapping } = useMemo(
    () => aggregateByWidget(scopedRows, headers),
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

  const pills = (
    <>
      {sessionFilter && (
        <FilterPill
          label="Session"
          value={sessionFilter}
          onClear={() => setSessionFilter(null)}
        />
      )}
      {actionFilter && (
        <FilterPill
          label="Action"
          value={actionFilter.name}
          onClear={() => setActionFilter(null)}
        />
      )}
    </>
  )

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
    return (
      <>
        {pills}
        <div className="summary-note">
          {actionFilter || sessionFilter ? (
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
  if (!mapping.widgetName) missing.push('Widget name')
  if (!mapping.measure)    missing.push('Render / Network / Backend (needs a WIDGET_MEASURE column)')
  if (!mapping.duration)   missing.push('Render / Network / Backend durations (needs a DURATION column)')

  return (
    <>
      {pills}
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
          placeholder="Search all widgets…"
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
          render: (v) => {
            if (v === '' || v === undefined || v === null) return '—'
            if (DURATION_COLUMNS.has(c.key)) return formatDurationMs(v)
            return String(v)
          },
        }))}
        emptyMessage="No widgets match your filters."
      />
    </>
  )
}

const FILTERABLE_COLUMNS = ['widget_name']
const COLUMN_LABEL = { widget_name: 'Widget name' }
const DURATION_COLUMNS = new Set(['render', 'network', 'backend'])

export default WidgetSummaryTable
