import './KpiDeltaStrip.css'

/**
 * Presentational KPI comparison strip. Shows baseline -> current values
 * with a color-coded delta indicator. Rendered above each comparison view
 * (session / action / widget).
 *
 * Props:
 *   kpis: Array<{
 *     label, baseline, current,
 *     delta, deltaPct, direction, kind
 *   }>
 *
 * Returns null when the list is empty or undefined.
 */
function KpiDeltaStrip({ kpis }) {
  if (!kpis || kpis.length === 0) return null

  return (
    <div className="kpi-delta-strip" role="group" aria-label="KPI comparison">
      {kpis.map((k) => (
        <div className="kpi-delta-card" key={k.label}>
          <div className="kpi-delta-label">{k.label}</div>

          <div className="kpi-delta-values">
            <span
              className="kpi-delta-baseline"
              title={String(k.baseline)}
            >
              {k.baseline}
            </span>
            <span className="kpi-delta-arrow" aria-hidden="true">
              {'→'}
            </span>
            <span
              className="kpi-delta-current"
              title={String(k.current)}
            >
              {k.current}
            </span>
          </div>

          {k.kind !== 'text' && (
            <div className="kpi-delta-indicator">
              {renderDelta(k)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function renderDelta(k) {
  const { kind, direction, deltaPct } = k

  // No meaningful change or unknown -> muted em-dash.
  if (direction === 'flat' || deltaPct === null || deltaPct === undefined) {
    return <span className="kpi-delta-muted">{'—'}</span>
  }

  const glyph = direction === 'up' ? '▲' : '▼'
  const formatted = formatPct(deltaPct)

  let colorClass = 'kpi-delta-neutral'
  if (kind === 'duration') {
    // For durations: up = worse (bad), down = better (good).
    colorClass = direction === 'up' ? 'kpi-delta-bad' : 'kpi-delta-good'
  }

  return (
    <span className={colorClass}>
      <span className="kpi-delta-glyph" aria-hidden="true">{glyph}</span>
      <span className="kpi-delta-pct">{formatted}</span>
    </span>
  )
}

// Format the percentage with a leading + or true minus sign (U+2212).
function formatPct(pct) {
  const rounded = Math.abs(pct).toFixed(1)
  if (pct > 0) return `+${rounded}%`
  if (pct < 0) return `−${rounded}%`
  return `${rounded}%`
}

export default KpiDeltaStrip
