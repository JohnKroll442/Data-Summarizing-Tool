import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DataTable from './DataTable'
import { aggregateBySession } from '../lib/sessionAggregate'
import { formatDurationMs } from '../lib/format'
import { sortRows } from '../lib/sortRows'
import { rowsToCsv, downloadCsv, buildExportFilename } from '../lib/exportCsv'
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
  const { setSessionFilter, setActionFilter, fileName } = useCsvData()

  const { rows: summaryRows, columns, mapping, sessionKey } = useMemo(
    () => aggregateBySession(rows, headers),
    [rows, headers]
  )

  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({})
  const [sort, setSort] = useState(null)

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

  const sortedRows = useMemo(() => {
    if (!sort) return visibleRows
    const col = columns.find((c) => c.key === sort.key)
    return sortRows(visibleRows, sort.key, sort.dir, col?.sortType)
  }, [visibleRows, sort, columns])

  const activeFilterCount =
    Object.values(filters).filter(Boolean).length + (search.trim() ? 1 : 0)

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
      {missing.length > 0 && (
        <div className="summary-note">
          Some columns couldn't be auto-matched and show as <code>—</code>:{' '}
          <strong>{missing.join(', ')}</strong>. Rename the relevant CSV
          columns (e.g. <code>USER_NAME</code>, <code>STORY_NAME</code>,{' '}
          <code>DURATION</code>) and re-upload.
        </div>
      )}

      <div className="summary-filters">
        <input
          type="search"
          className="summary-filter-search"
          placeholder="Search all sessions…"
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
            if (c.key === 'max_action_duration') return formatDurationMs(v)
            if (c.key === 'session') {
              return (
                <button
                  type="button"
                  className="cell-link"
                  title={`Show actions for session ${row.session}`}
                  onClick={() => {
                    setSessionFilter(String(row.session))
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
    </>
  )
}

const FILTERABLE_COLUMNS = ['session', 'user', 'story']
const COLUMN_LABEL = {
  session: 'Session',
  user: 'User',
  story: 'Story',
}

export default SessionSummaryTable
