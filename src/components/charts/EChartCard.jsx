import ReactECharts from 'echarts-for-react'
import { Card, CardHeader, Button } from '@ui5/webcomponents-react'
import './EChartCard.css'

/**
 * EChartCard — UI5 Card wrapper around a single ECharts instance.
 *
 * Props:
 *   title:     string
 *   subtitle?: string
 *   option:    ECharts option object (built by one of options/*.js)
 *   height?:   number (default 280)
 *   onRemove?: () => void  — if provided, shows an × button in the header
 *   onEvents?: object      — ECharts event map forwarded to ReactECharts
 *                            (e.g. { click, mouseover, mouseout })
 *
 * Renders an empty-state hint if the option has no data series.
 */
function EChartCard({ title, subtitle, option, height = 280, onRemove, onEvents }) {
  const hasData = optionHasData(option)

  return (
    <Card
      className="echart-card"
      header={
        <CardHeader
          titleText={title}
          subtitleText={subtitle || ''}
          action={
            onRemove ? (
              <Button
                design="Transparent"
                icon="decline"
                onClick={onRemove}
                aria-label="Remove chart"
                tooltip="Remove chart"
              />
            ) : undefined
          }
        />
      }
    >
      {hasData ? (
        <ReactECharts
          option={option}
          style={{ height, width: '100%' }}
          onEvents={onEvents}
        />
      ) : (
        <div className="echart-card-empty" style={{ height }}>
          Not enough data to render this chart.
        </div>
      )}
    </Card>
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
