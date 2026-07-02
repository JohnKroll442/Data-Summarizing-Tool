import { useMemo } from 'react'
import { computeKpis } from '../lib/kpis'
import './KpiStrip.css'

/**
 * Presentational KPI strip shown above the aggregate summary tables.
 * `variant` selects which set of metrics to compute (session/action/widget).
 * Returns null when there are no rows so the caller can render nothing.
 */
function KpiStrip({ variant, rows, headers }) {
  const kpis = useMemo(
    () => computeKpis(variant, rows, headers),
    [variant, rows, headers],
  )
  if (!kpis) return null
  return (
    <div className="kpi-strip" role="group" aria-label={`${variant} KPIs`}>
      {kpis.map((k) => (
        <div className="kpi-card" key={k.label}>
          <div className="kpi-label">{k.label}</div>
          <div className="kpi-value" title={String(k.value)}>{k.value}</div>
        </div>
      ))}
    </div>
  )
}

export default KpiStrip
