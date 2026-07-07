import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DataTable from './DataTable'
import FilterPill from './FilterPill'
import MultiFilterMenu from './MultiFilterMenu'
import SortMenu from './SortMenu'
import WidgetTimingModal from './WidgetTimingModal'
import { aggregateByWidget } from '../lib/widgetAggregate'
import { RECOGNIZED_MEASURES } from '../lib/actionAggregate'
import { applySessionFilter, applyActionFilter } from '../lib/drillDown'
import { formatDurationMs, formatCsvTime } from '../lib/format'
import { sortRows } from '../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../lib/exportCsv'
import { matchesAllMultiFilters, countActiveMultiFilters } from '../lib/multiFilter'
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
  const navigate = useNavigate()
  const {
    sessionFilter,
    setSessionFilter,
    actionFilter,
    setActionFilter,
    fileName,
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
  const [sort, setSort] = useState(null)
  // Clicking a widget name opens the per-widget timing modal. Holds the
  // selected row's widget_id + display name, plus the rows we should pass
  // to the chart builder.
  const [timingModal, setTimingModal] = useState(null)

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

  const activeFilterCount = countActiveMultiFilters(filters, search)

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

  const pills = (
    <>
      {sessionFilter && (
        <FilterPill
          label="Session"
          value={sessionFilter}
          onClear={() => {
            setSessionFilter(null)
            setActionFilter(null)
            navigate('/summary/session')
          }}
        />
      )}
      {actionFilter && (
        <FilterPill
          label="Action"
          value={actionFilter.name}
          onClear={() => {
            setActionFilter(null)
            navigate('/summary/action')
          }}
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

      <div className="summary-filters">
        <input
          type="search"
          className="summary-filter-search"
          placeholder="Search all widgets…"
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
            if (TIME_COLUMNS.has(c.key)) return formatCsvTime(v)
            if (c.key === 'widget_name') {
              return (
                <button
                  type="button"
                  className="cell-link"
                  title={`Open timing chart for "${row.widget_name}"`}
                  onClick={() => {
                    const widgetId = row.widget_id
                    const idKey = mapping.widgetId
                    const rowsForWidget = idKey
                      ? scopedRows.filter(
                          (r) => String(r?.[idKey] ?? '') === String(widgetId)
                        )
                      : []

                    // Identify the parent action from the widget's own rows so
                    // the chart's Action Start / End markLines reflect just
                    // that action — not the whole session. We try the
                    // ACTION_TIMESTAMP column first (works even with no active
                    // action filter), then fall back to scopedRows when no
                    // ACTION_TIMESTAMP column is present.
                    const actionTsKey = findActionTimestampKey(headers)
                    let actionRows = scopedRows
                    if (actionTsKey && rowsForWidget.length) {
                      const ts = String(rowsForWidget[0]?.[actionTsKey] ?? '')
                      if (ts) {
                        actionRows = scopedRows.filter(
                          (r) => String(r?.[actionTsKey] ?? '') === ts
                        )
                      }
                    }

                    setTimingModal({
                      widgetId,
                      widgetName: row.widget_name || String(widgetId),
                      widgetRows: rowsForWidget,
                      actionRows,
                    })
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

      <WidgetTimingModal
        open={!!timingModal}
        onClose={() => setTimingModal(null)}
        widgetName={timingModal?.widgetName}
        widgetRows={timingModal?.widgetRows ?? []}
        actionRows={timingModal?.actionRows ?? []}
      />
    </>
  )
}

const FILTERABLE_COLUMNS = [
  { key: 'widget_id',   label: 'Widget ID' },
  { key: 'widget_name', label: 'Widget name' },
  { key: 'session_id',  label: 'Session' },
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

export default WidgetSummaryTable
