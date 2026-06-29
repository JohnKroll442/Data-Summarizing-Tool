import ReactECharts from 'echarts-for-react'
import './EChartCard.css'

/**
 * EChartCard — glassmorphism wrapper around a single ECharts instance.
 *
 * Props:
 *   title:     string
 *   subtitle?: string
 *   option:    ECharts option object (built by one of options/*.js)
 *   height?:   number (default 280)
 *   onRemove?: () => void  — if provided, shows an × button in the header
 *
 * Renders an empty-state hint if the option has no data series.
 */
function EChartCard({ title, subtitle, option, height = 280, onRemove }) {
  const hasData = optionHasData(option)

  return (
    <section className="echart-card">
      <header className="echart-card-header">
        <div className="echart-card-header-text">
          <h3 className="echart-card-title">{title}</h3>
          {subtitle && <p className="echart-card-subtitle">{subtitle}</p>}
        </div>
        {onRemove && (
          <button
            type="button"
            className="echart-card-remove"
            onClick={onRemove}
            aria-label="Remove chart"
            title="Remove chart"
          >
            ✕
          </button>
        )}
      </header>
      {hasData ? (
        <ReactECharts
          option={option}
          style={{ height, width: '100%' }}
          notMerge
          lazyUpdate
        />
      ) : (
        <div className="echart-card-empty" style={{ height }}>
          Not enough data to render this chart.
        </div>
      )}
    </section>
  )
}

// Cheap check — any series with at least one data point counts.
function optionHasData(option) {
  if (!option || !Array.isArray(option.series)) return false
  return option.series.some((s) => {
    if (!s) return false
    if (Array.isArray(s.data) && s.data.length > 0) return true
    if (Array.isArray(s.nodes) && s.nodes.length > 0) return true
    if (Array.isArray(s.links) && s.links.length > 0) return true
    return false
  })
}

export default EChartCard
