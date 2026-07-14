import { useMemo, useState } from 'react'
import EChartCard from './EChartCard'
import ChartPicker from './ChartPicker'
import { getChartType } from './registry'
import { profileColumns } from '../../lib/chartData'
import { augmentRowsWithSyntheticMeasures, SYNTHETIC_MEASURES } from '../../lib/syntheticMeasures'
import { useCsvData } from '../../context/useCsvData'
import './ChartGrid.css'

const SYNTHETIC_KEYS = new Set(SYNTHETIC_MEASURES.map((s) => s.key))

/**
 * ChartGrid — renders the user's added charts for a given view, plus an
 * "Add chart" button that opens the picker modal. All chart state lives in
 * the CSV context so it survives tab switches inside SummaryPage.
 *
 * Props:
 *   viewId: 'session' | 'action' | 'widget'
 *   rows / headers (optional): scoped rows/headers to chart instead of the
 *     full context dataset. Views pass these so charts honor the active
 *     session/action scoping filters. The synthetic per-row "Total" measure
 *     columns are added here, lazily — see below.
 */
function ChartGrid({ viewId, rows: rowsProp, headers: headersProp }) {
  const {
    rows: ctxRows, headers: ctxHeaders,
    chartsByView, addChart, removeChart,
  } = useCsvData()
  const [pickerOpen, setPickerOpen] = useState(false)

  const scoped = rowsProp !== undefined
  const baseRows = scoped ? rowsProp : ctxRows
  const baseHeaders = scoped ? headersProp : ctxHeaders

  const charts = useMemo(() => chartsByView[viewId] ?? [], [chartsByView, viewId])

  // Do any existing charts actually plot a synthetic "Total X" measure?
  const chartsNeedSynthetic = useMemo(
    () =>
      charts.some((c) =>
        Object.values(c.config || {}).some((v) =>
          Array.isArray(v) ? v.some((x) => SYNTHETIC_KEYS.has(x)) : SYNTHETIC_KEYS.has(v)
        )
      ),
    [charts]
  )

  // Synthetic measure columns (Total Render / Frontend / Backend / Network)
  // are only needed when the picker is open (to offer them) or when a rendered
  // chart plots one. Augmenting is O(rows), so on the hot navigation path —
  // where nothing needs them — we skip it and chart straight off the raw rows.
  const needAugment = pickerOpen || chartsNeedSynthetic
  const { rows, headers } = useMemo(
    () =>
      needAugment
        ? augmentRowsWithSyntheticMeasures(baseRows, baseHeaders)
        : { rows: baseRows, headers: baseHeaders },
    [needAugment, baseRows, baseHeaders]
  )

  // The column profile is consumed only by the picker, and computing it scans
  // every cell (Number()/Date.parse). Compute it lazily, only when open.
  const columnProfile = useMemo(
    () => (pickerOpen ? profileColumns(rows, headers) : null),
    [pickerOpen, rows, headers]
  )

  const source = { rows, headers, columnProfile }

  const handleAdd = (typeId, config) => {
    addChart(viewId, typeId, config)
    setPickerOpen(false)
  }

  return (
    <>
      <div className="chart-grid-toolbar">
        <button
          type="button"
          className="chart-grid-add"
          onClick={() => setPickerOpen(true)}
        >
          <span className="chart-grid-add-icon" aria-hidden="true">＋</span>
          Add chart
        </button>
        {charts.length > 0 && (
          <span className="chart-grid-count">
            {charts.length} {charts.length === 1 ? 'chart' : 'charts'}
          </span>
        )}
      </div>

      {charts.length === 0 ? (
        <div className="chart-grid-empty">
          No charts yet. Click <strong>Add chart</strong> to pick a chart type
          and the dimensions / measures to plot from your CSV.
        </div>
      ) : (
        <div className="view-charts">
          {charts.map((chart) => {
            const type = getChartType(chart.typeId)
            if (!type) return null
            const option = type.build(source.rows, chart.config)
            const subtitle = describeConfig(type, chart.config)
            return (
              <EChartCard
                key={chart.uid}
                title={type.label}
                subtitle={subtitle}
                option={option}
                onRemove={() => removeChart(viewId, chart.uid)}
              />
            )
          })}
        </div>
      )}

      <ChartPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAdd={handleAdd}
        headers={source.headers}
        profile={source.columnProfile}
        rows={source.rows}
      />
    </>
  )
}

// Build a "xKey: foo, yKey: bar" style subtitle from the saved config.
function describeConfig(type, config) {
  return type.fields
    .map((f) => {
      const v = config[f.key]
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return null
      const value = Array.isArray(v) ? v.join(', ') : String(v)
      return `${f.label}: ${value}`
    })
    .filter(Boolean)
    .join(' · ')
}

export default ChartGrid
