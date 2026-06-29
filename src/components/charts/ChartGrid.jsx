import { useState } from 'react'
import EChartCard from './EChartCard'
import ChartPicker from './ChartPicker'
import { getChartType } from './registry'
import { useCsvData } from '../../context/useCsvData'
import './ChartGrid.css'

/**
 * ChartGrid — renders the user's added charts for a given view, plus an
 * "Add chart" button that opens the picker modal. All chart state lives in
 * the CSV context so it survives tab switches inside SummaryPage.
 *
 * Props:
 *   viewId: 'session' | 'action' | 'widget'
 */
function ChartGrid({ viewId }) {
  const { rows, headers, columnProfile, chartsByView, addChart, removeChart } = useCsvData()
  const [pickerOpen, setPickerOpen] = useState(false)

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
            const option = type.build(rows, chart.config)
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
        headers={headers}
        profile={columnProfile}
        rows={rows}
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
