import { useMemo, useRef } from 'react'
import { AnalyticalTable } from '@ui5/webcomponents-react/AnalyticalTable'
import './AnalyticalDataTable.css'

/**
 * AnalyticalDataTable — drop-in replacement for DataTable that renders with
 * SAP's Fiori/Horizon-themed `AnalyticalTable`.
 *
 * Accepts the SAME props as DataTable so callers only swap the import:
 *   rows:        Array<Record<string, unknown>>   (already the current page)
 *   columns:     Array<{ key, label?, render?, sortable? }>
 *   sort:        { key, dir: 'asc' | 'desc' } | null
 *   onSortChange:(next) => void   (omit to disable header sorting)
 *   emptyMessage:string
 *   height:      CSS height for the table container (default '65vh')
 *   isRowViewed: (rowOriginal) => boolean   (optional) — rows for which this
 *                returns true get a `viewed-row` class (full-row "already
 *                viewed" tint). Omit to disable highlighting entirely.
 *   rowFlagTier: (rowOriginal) => 'performance' | null   (optional) — rows for
 *                which this returns 'performance' get an `anomaly-row
 *                anomaly-row--performance` class (loud tint). Data-quality
 *                anomalies deliberately return null (no tint — symbol only).
 *   onRowHover:  (rowOriginal | null) => void   (optional) — fired with a row's
 *                original data on mouse-enter and null on leave, so callers can
 *                drive a contextual side panel. Omit to disable.
 *
 * Sorting stays CONTROLLED/EXTERNAL: the table runs in manual-sort mode and
 * only reflects the `sort` prop, so callers keep sorting the full dataset and
 * paginating themselves (behavior identical to DataTable). `scaleWidthMode`
 * "Smart" fits every column to its header text and then hands the leftover
 * page width to the wider columns, so the table stays responsive to the page
 * (all columns fit; it only scrolls horizontally when the window is truly too
 * narrow) instead of overflowing off the right edge the way "Grow" did.
 */
function AnalyticalDataTable({
  rows,
  columns,
  sort = null,
  onSortChange,
  emptyMessage = 'No rows to display.',
  height = '65vh',
  isRowViewed,
  rowFlagTier,
  onRowHover,
}) {
  const resolvedColumns =
    columns && columns.length > 0
      ? columns
      : rows.length > 0
        ? Object.keys(rows[0]).map((key) => ({ key, label: key }))
        : []

  // Keep the latest column defs (with their fresh render closures) reachable
  // from the memoized Cell components below. Callers rebuild `columns` — and
  // their render fns — on every render; the ref lets us use the current ones
  // without forcing the AnalyticalTable to rebuild its columns each time.
  const colsRef = useRef(resolvedColumns)
  colsRef.current = resolvedColumns

  // Keep the latest "viewed" predicate reachable from a STABLE table hook. Like
  // colsRef above, callers rebuild the predicate every render; the ref lets the
  // getRowProps closure read the current one without giving `tableHooks` a new
  // identity (which would force the table to re-init its state each render).
  const isRowViewedRef = useRef(isRowViewed)
  isRowViewedRef.current = isRowViewed

  // Same stable-ref pattern for the anomaly-tint predicate and the hover
  // callback: callers rebuild them every render, the refs keep `tableHooks`
  // identity-stable so the table doesn't re-init its state.
  const rowFlagTierRef = useRef(rowFlagTier)
  rowFlagTierRef.current = rowFlagTier
  const onRowHoverRef = useRef(onRowHover)
  onRowHoverRef.current = onRowHover

  // Whether any per-row feature is active. Fixed for the table's lifetime (the
  // caller either wires these up or not), so it can gate the stable hook below.
  const hasRowFeatures = Boolean(isRowViewed || rowFlagTier || onRowHover)

  // Contribute per-row props: a `viewed-row` / `anomaly-row` className and the
  // hover handlers. react-table CONCATENATES className across every
  // getRowProps contributor (it doesn't overwrite the table's built-in row
  // class), and the row <div> renders in light DOM, so the CSS rules match.
  // undefined when no feature is supplied, leaving other callers unchanged.
  const tableHooks = useMemo(() => {
    if (!hasRowFeatures) return undefined
    return [
      (hooks) => {
        hooks.getRowProps.push((rowProps, { row }) => {
          const classes = []
          if (isRowViewedRef.current?.(row.original)) classes.push('viewed-row')
          const tier = rowFlagTierRef.current?.(row.original)
          if (tier === 'performance') classes.push('anomaly-row', 'anomaly-row--performance')
          const extra = classes.length ? { className: classes.join(' ') } : {}
          if (onRowHoverRef.current) {
            extra.onMouseEnter = () => onRowHoverRef.current?.(row.original)
            extra.onMouseLeave = () => onRowHoverRef.current?.(null)
          }
          return [rowProps, extra]
        })
      },
    ]
    // Stable identity; the refs supply the current predicates on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRowFeatures])

  // Rebuild the table's column definitions only when the column STRUCTURE
  // changes (keys/labels/sortability), not when render-fn identity changes —
  // otherwise the table would reset its internal state every render.
  const signature = resolvedColumns
    .map((c) => `${c.key} ${c.label ?? c.key} ${c.sortable === false ? 0 : 1} ${c.width ?? ''} ${c.minWidth ?? ''} ${c.maxWidth ?? ''}`)
    .join('')

  const tableColumns = useMemo(
    () =>
      resolvedColumns.map((col) => {
        const key = col.key
        return {
          id: key,
          Header: col.label ?? key,
          // Function accessor + explicit id so header names containing "."
          // aren't misread by react-table as nested object paths.
          accessor: (row) => row[key],
          disableSortBy: col.sortable === false,
          // Optional fixed/min/max widths (px). When set, a column keeps at
          // least `minWidth` even in "Smart" scaling, so cells with trailing
          // controls (e.g. the Action name link + Waterfall icon) don't get
          // clipped on narrow screens. Omitted props keep the default behavior.
          ...(col.width != null ? { width: col.width } : {}),
          ...(col.minWidth != null ? { minWidth: col.minWidth } : {}),
          ...(col.maxWidth != null ? { maxWidth: col.maxWidth } : {}),
          Cell: ({ value, row }) => {
            const current = colsRef.current.find((c) => c.key === key)
            return current?.render ? current.render(value, row.original) : formatCell(value)
          },
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  )

  const sortEnabled = typeof onSortChange === 'function'

  // Feed the external `sort` into react-table's controlled state. manualSortBy
  // stops the table from re-sorting the current page itself.
  const reactTableOptions = useMemo(
    () => ({
      manualSortBy: true,
      state: { sortBy: sort ? [{ id: sort.key, desc: sort.dir === 'desc' }] : [] },
    }),
    [sort],
  )

  const handleSort = (e) => {
    if (!sortEnabled) return
    const key = e.detail?.column?.id
    if (!key) return
    const dir = e.detail?.sortDirection
    if (dir === 'asc' || dir === 'desc') onSortChange({ key, dir })
    else onSortChange(null)
  }

  return (
    <div className="analytical-data-table-wrap" style={{ height }}>
      <AnalyticalTable
        columns={tableColumns}
        data={rows}
        sortable={sortEnabled}
        scaleWidthMode="Smart"
        reactTableOptions={reactTableOptions}
        tableHooks={tableHooks}
        onSort={handleSort}
        visibleRowCountMode="Auto"
        minRows={1}
        noDataText={emptyMessage}
      />
    </div>
  )
}

// Match DataTable's cell rendering for columns without a custom render: em dash
// for empty/nullish values, stringify objects, leave primitives as-is.
function formatCell(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export default AnalyticalDataTable
