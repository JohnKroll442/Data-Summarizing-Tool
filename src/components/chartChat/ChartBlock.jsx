/**
 * ChartBlock — renders a `​```chart` directive found in an AI answer.
 *
 * Flow: parse the fenced JSON → resolve it against the data in ChartDataContext
 * (resolveChartDirective) → render the resulting ECharts option in an
 * EChartCard. Anything that can't be resolved (bad JSON, unknown chart type,
 * missing action, …) degrades to <ChartUnavailable>, and a render-time
 * exception from the builder / ECharts is caught by the local error boundary —
 * a chart must never take down the surrounding chat message.
 */

import { Component } from 'react'
import EChartCard from '../charts/EChartCard'
import ChartUnavailable from './ChartUnavailable'
import { useChartData } from './ChartDataContext'
import { resolveChartDirective } from './resolveChartDirective'

// Class component — error boundaries have no hook equivalent. Catches
// exceptions thrown while rendering the resolved chart (the repo has no render
// tests, so this is the compensating guard for a builder/ECharts crash).
class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed) return <ChartUnavailable reason="render_error" />
    return this.props.children
  }
}

function ChartBlock({ raw }) {
  const ctx = useChartData()

  let directive
  try {
    directive = JSON.parse(raw)
  } catch (_) {
    return <ChartUnavailable reason="malformed" />
  }

  const result = resolveChartDirective(directive, ctx)
  if (!result.ok) return <ChartUnavailable reason={result.reason} detail={result.detail} />

  return (
    <div className="ai-chat-chart">
      <ChartErrorBoundary>
        <EChartCard title={result.title} option={result.option} height={result.height} />
      </ChartErrorBoundary>
    </div>
  )
}

export default ChartBlock
