import { useMemo, useState } from 'react'
import ActionSummaryTable from '../../components/ActionSummaryTable'
import ChartGrid from '../../components/charts/ChartGrid'
import ActionWaterfallModal from '../../components/ActionWaterfallModal'
import { useCsvData } from '../../context/useCsvData'
import { applySessionFilter, applySessionMultiFilter } from '../../lib/drillDown'
import { aggregateByAction } from '../../lib/actionAggregate'

/**
 * ActionView — one row per action table at the top, followed by user-added
 * charts. Use Raw Data View for the underlying detail rows.
 */
function ActionView() {
  const { rows, headers, sessionFilter, sessionMultiFilter } = useCsvData()

  // Scope KPIs + charts to match the table. The multiselect Sessions filter,
  // when active, takes over the row scope; otherwise the single-session
  // drill-down from Session View applies.
  const scopedRows = useMemo(() => {
    if (sessionMultiFilter.length > 0) {
      return applySessionMultiFilter(rows, headers, sessionMultiFilter)
    }
    return applySessionFilter(rows, headers, sessionFilter)
  }, [rows, headers, sessionFilter, sessionMultiFilter])

  const [waterfallOpen, setWaterfallOpen] = useState(false)
  const [waterfallInitialKey, setWaterfallInitialKey] = useState(null)

  // Build the picker list for the Action Waterfall modal from the same
  // aggregation the summary table uses. Deferred until the modal is actually
  // opened so we don't run a second full aggregateByAction pass on every
  // Action View navigation (the table already runs one).
  const waterfallActions = useMemo(() => {
    if (!waterfallOpen) return []
    const { rows: summaryRows } = aggregateByAction(scopedRows, headers)
    return summaryRows.map((r) => ({
      name: r.action_name,
      timestamp: r._action_timestamp ?? '',
      label: r._action_timestamp
        ? `${r.action_name} — ${r._action_timestamp}`
        : String(r.action_name),
    }))
  }, [waterfallOpen, scopedRows, headers])

  const openWaterfallFor = ({ name, timestamp }) => {
    setWaterfallInitialKey(`${name}::${timestamp ?? ''}`)
    setWaterfallOpen(true)
  }

  return (
    <>
      <h2 className="view-heading">Action View</h2>
      <p className="view-subheading">
        One row per action — search or filter to narrow the list.
      </p>
      <ActionSummaryTable
        rows={rows}
        headers={headers}
        onOpenWaterfall={openWaterfallFor}
      />

      <div className="chart-grid-toolbar" style={{ marginTop: '1.25rem' }}>
        <button
          type="button"
          className="chart-grid-add"
          onClick={() => {
            setWaterfallInitialKey(null)
            setWaterfallOpen(true)
          }}
          disabled={scopedRows.length === 0}
          title={
            scopedRows.length === 0
              ? 'No actions available to chart'
              : 'Open the Action Waterfall Chart'
          }
        >
          Action Waterfall Chart
        </button>
      </div>

      <h3 className="view-section-heading">Charts</h3>
      <ChartGrid viewId="action" rows={scopedRows} headers={headers} />

      <ActionWaterfallModal
        open={waterfallOpen}
        onClose={() => setWaterfallOpen(false)}
        rows={scopedRows}
        headers={headers}
        actions={waterfallActions}
        initialKey={waterfallInitialKey}
      />
    </>
  )
}

export default ActionView
