import { useMemo, useState } from 'react'
import EChartCard from './EChartCard'
import ChartPicker from './ChartPicker'
import { getChartType } from './registry'
import { profileColumns } from '../../lib/chartData'
import { useCsvData } from '../../context/useCsvData'
import './ChartGrid.css'

/**
 * ChartGrid — renders the user's added charts for a given view, plus an
 * "Add chart" button that opens the picker modal. All chart state lives in
 * the CSV context so it survives tab switches inside SummaryPage.
 *
 * Props:
 *   viewId: 'session' | 'action' | 'widget'
 *   rows / headers (optional): scoped rows/headers to chart instead of the
 *     full context dataset. Views pass these so charts honor the active
 *     session/action scoping filters. When provided, the column profile is
 *     recomputed from them. For the widget view the caller must pass rows
 *     already augmented with synthetic measure columns.
 */
function ChartGrid({ viewId, rows: rowsProp, headers: headersProp }) {
  const {
    rows: ctxRows, headers: ctxHeaders, columnProfile: ctxProfile,
    widgetChartData,
    chartsByView, addChart, removeChart,
  } = useCsvData()
  const [pickerOpen, setPickerOpen] = useState(false)

  const scoped = rowsProp !== undefined

  // Widget view exposes synthetic per-row measure columns (Total Render /
  // Frontend / Backend / Network) so the picker can offer phase totals that
  // aren't native CSV columns. Other views use raw CSV rows unchanged.
  // When scoped rows are passed in, chart from those (recomputing the profile);
  // the widget-view caller passes rows already augmented with the synthetic
  // measures so the picker still sees the phase-total columns.
  const scopedProfile = useMemo(
    () => (scoped ? profileColumns(rowsProp, headersProp) : null),
    [scoped, rowsProp, headersProp]
  )

  const source = scoped
    ? { rows: rowsProp, headers: headersProp, columnProfile: scopedProfile }
    : viewId === 'widget' && widgetChartData
      ? widgetChartData
      : { rows: ctxRows, headers: ctxHeaders, columnProfile: ctxProfile }

  const charts = chartsByView[viewId] ?? []

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
