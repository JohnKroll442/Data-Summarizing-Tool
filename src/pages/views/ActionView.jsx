import { useMemo, useState } from 'react'
import ActionSummaryTable from '../../components/ActionSummaryTable'
import ChartGrid from '../../components/charts/ChartGrid'
import ActionWaterfallModal from '../../components/ActionWaterfallModal'
import { useCsvData } from '../../context/useCsvData'
import { applySessionFilter, applySessionMultiFilter } from '../../lib/drillDown'

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
  // The fully filtered + sorted action rows, published up by the table so the
  // waterfall picker navigates exactly what the table shows (every column /
  // search / time / timeline filter applied), not the whole session scope.
  const [filteredActionRows, setFilteredActionRows] = useState([])

  // The picker list for the Action Waterfall modal mirrors the table's filtered
  // + sorted rows, so the modal's "N / total" and its arrow navigation always
  // match the count shown above the table. EVERY filter flows through
  // `filteredActionRows` — the Session/User/Story/Page dropdowns, the Time
  // menu, AND the Activity Timeline range — so all of them stay consistent.
  const waterfallActions = useMemo(
    () =>
      filteredActionRows.map((r) => ({
        name: r.action_name,
        timestamp: r._action_timestamp ?? '',
        label: r._action_timestamp
          ? `${r.action_name} — ${r._action_timestamp}`
          : String(r.action_name),
      })),
    [filteredActionRows],
  )

  const openWaterfallFor = ({ name, timestamp }) => {
    setWaterfallInitialKey(`${name}::${timestamp ?? ''}`)
    setWaterfallOpen(true)
  }

  return (
    <>
      <h2 className="view-heading">Action View</h2>
      <ActionSummaryTable
        rows={rows}
        headers={headers}
        onOpenWaterfall={openWaterfallFor}
        onFilteredActionsChange={setFilteredActionRows}
      />

      <div className="chart-grid-toolbar" style={{ marginTop: '1.25rem' }}>
        <button
          type="button"
          className="chart-grid-add"
          onClick={() => {
            setWaterfallInitialKey(null)
            setWaterfallOpen(true)
          }}
          disabled={filteredActionRows.length === 0}
          title={
            filteredActionRows.length === 0
              ? 'No actions match the current filters'
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
