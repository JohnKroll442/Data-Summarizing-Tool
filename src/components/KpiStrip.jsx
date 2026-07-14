import { useMemo } from 'react'
import { computeKpis } from '../lib/kpis'
import './KpiStrip.css'

/**
 * Presentational KPI strip shown above the aggregate summary tables.
 * `variant` selects which set of metrics to compute (session/action/widget).
 * Returns null when there are no rows so the caller can render nothing.
 *
 * Pass a pre-computed `kpis` array to render those directly instead of
 * computing from raw rows — used when the caller already has the filtered,
 * aggregated rows (e.g. a summary table feeding its visible rows) and wants
 * the KPIs to track the active filters.
 */
function KpiStrip({ variant, rows, headers, kpis: kpisProp }) {
  const kpis = useMemo(
    () => (kpisProp !== undefined ? kpisProp : computeKpis(variant, rows, headers)),
    [kpisProp, variant, rows, headers],
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
