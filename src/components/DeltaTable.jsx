import { useMemo, useState } from 'react'
import './DeltaTable.css'

/**
 * DeltaTable — presentational comparison table for entity-level deltas
 * (widgets, actions, sessions). Renders a sortable main table for matched
 * rows and two smaller sections for "new in current" and
 * "dropped from baseline" entities.
 *
 * The caller drives this only for duration-like metrics, so the coloring
 * heuristic is: higher current than baseline = worse (regression).
 *
 * Props: see file header / task spec.
 */
function DeltaTable({
  title,
  metricLabel,
  formatValue,
  matched = [],
  newInCurrent = [],
  droppedFromBaseline = [],
  regressionThresholdPct = 10,
}) {
  // Default sort state is null (meaning: sort by |deltaPct| desc, biggest
  // changes first). Clicking a header cycles asc → desc → default.
  const [sort, setSort] = useState(null)

  // Filter out rows that would surface as fake improvements/regressions:
  //   baseline === 0 && current > 0  → belongs in "new"
  //   current === 0                  → dropped / not present, skip
  const cleanMatched = useMemo(
    () =>
      matched.filter(
        (r) => !(r.baseline === 0 && r.current > 0) && r.current !== 0
      ),
    [matched]
  )

  const sortedMatched = useMemo(() => {
    const rows = cleanMatched.slice()
    if (!sort) {
      // Default: biggest absolute delta% first, nulls at the end.
      rows.sort((a, b) => {
        const aVal = a.deltaPct === null ? -Infinity : Math.abs(a.deltaPct)
        const bVal = b.deltaPct === null ? -Infinity : Math.abs(b.deltaPct)
        return bVal - aVal
      })
      return rows
    }
    const { key, dir } = sort
    const mult = dir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      // Strings compare lexically, everything else numerically. Nulls last.
      if (key === 'name') {
        return String(av).localeCompare(String(bv)) * mult
      }
      const an = av === null || av === undefined ? null : Number(av)
      const bn = bv === null || bv === undefined ? null : Number(bv)
      if (an === null && bn === null) return 0
      if (an === null) return 1
      if (bn === null) return -1
      return (an - bn) * mult
    })
    return rows
  }, [cleanMatched, sort])

  const sortedNew = useMemo(
    () => newInCurrent.slice().sort((a, b) => b.value - a.value),
    [newInCurrent]
  )
  const sortedDropped = useMemo(
    () => droppedFromBaseline.slice().sort((a, b) => b.value - a.value),
    [droppedFromBaseline]
  )

  const handleSort = (key) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }

  const nothingToShow =
    cleanMatched.length === 0 &&
    sortedNew.length === 0 &&
    sortedDropped.length === 0

  if (nothingToShow) {
    return <p className="delta-empty">No data to compare.</p>
  }

  return (
    <section className="delta-table-section">
      {title && <h3 className="delta-table-title">{title}</h3>}

      {cleanMatched.length > 0 && (
        <div className="delta-table-wrap">
          <table className="delta-table">
            <thead>
              <tr>
                <SortHeader
                  label="Name"
                  colKey="name"
                  sort={sort}
                  onSort={handleSort}
                />
                <SortHeader
                  label={`Baseline ${metricLabel ? `(${metricLabel})` : ''}`.trim()}
                  colKey="baseline"
                  sort={sort}
                  onSort={handleSort}
                  numeric
                />
                <SortHeader
                  label={`Current ${metricLabel ? `(${metricLabel})` : ''}`.trim()}
                  colKey="current"
                  sort={sort}
                  onSort={handleSort}
                  numeric
                />
                <SortHeader
                  label="Δ"
                  colKey="delta"
                  sort={sort}
                  onSort={handleSort}
                  numeric
                />
                <SortHeader
                  label="Δ%"
                  colKey="deltaPct"
                  sort={sort}
                  onSort={handleSort}
                  numeric
                />
              </tr>
            </thead>
            <tbody>
              {sortedMatched.map((row) => {
                const rowClass = classifyRow(row, regressionThresholdPct)
                return (
                  <tr key={row.key} className={rowClass || undefined}>
                    <td className="delta-cell-name" title={row.name}>
                      {row.name}
                    </td>
                    <td className="is-numeric">{formatValue(row.baseline)}</td>
                    <td className="is-numeric">{formatValue(row.current)}</td>
                    <td className="is-numeric">
                      {formatSignedValue(row.delta, formatValue)}
                    </td>
                    <td className="is-numeric">
                      {formatDeltaPct(row.deltaPct)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {sortedNew.length > 0 && (
        <SmallSection
          heading="New in current"
          rows={sortedNew}
          formatValue={formatValue}
          metricLabel={metricLabel}
          variant="new"
        />
      )}

      {sortedDropped.length > 0 && (
        <SmallSection
          heading="Dropped from baseline"
          rows={sortedDropped}
          formatValue={formatValue}
          metricLabel={metricLabel}
          variant="dropped"
        />
      )}
    </section>
  )
}

function SortHeader({ label, colKey, sort, onSort, numeric = false }) {
  const active = sort?.key === colKey
  const dir = active ? sort.dir : null
  const ariaSort = !active ? 'none' : dir === 'asc' ? 'ascending' : 'descending'
  return (
    <th
      aria-sort={ariaSort}
      className={numeric ? 'is-numeric' : undefined}
      scope="col"
    >
      <button
        type="button"
        className={`delta-sort${active ? ' is-active' : ''}`}
        onClick={() => onSort(colKey)}
      >
        <span>{label}</span>
        <span className="delta-sort-indicator" aria-hidden="true">
          {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}
        </span>
      </button>
    </th>
  )
}

function SmallSection({ heading, rows, formatValue, metricLabel, variant }) {
  return (
    <div className={`delta-subsection delta-subsection-${variant}`}>
      <h4 className="delta-subsection-heading">
        {heading}{' '}
        <span className="delta-subsection-count">({rows.length})</span>
      </h4>
      <div className="delta-table-wrap">
        <table className="delta-table delta-table-small">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="is-numeric">
                {metricLabel ? `Value (${metricLabel})` : 'Value'}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="delta-cell-name" title={r.name}>{r.name}</td>
                <td className="is-numeric">{formatValue(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Classify row for regression/improvement highlighting. Caller only feeds
// duration-like metrics, so higher current = regression (bad).
function classifyRow(row, threshold) {
  if (row.deltaPct === null || row.deltaPct === undefined) return ''
  if (Math.abs(row.deltaPct) < threshold) return ''
  if (row.delta > 0) return 'regression'
  if (row.delta < 0) return 'improvement'
  return ''
}

// Format a signed delta using a true minus sign (U+2212) for negatives and
// a plain '+' for positives. Zero renders without a sign.
function formatSignedValue(delta, formatValue) {
  if (delta === 0) return formatValue(0)
  const abs = Math.abs(delta)
  const formatted = formatValue(abs)
  return delta > 0 ? `+${formatted}` : `−${formatted}`
}

function formatDeltaPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—'
  if (pct === 0) return '0.0%'
  const abs = Math.abs(pct).toFixed(1)
  return pct > 0 ? `+${abs}%` : `−${abs}%`
}

export default DeltaTable
