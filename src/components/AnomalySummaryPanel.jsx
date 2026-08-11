import { ANOMALY_TYPES } from '../lib/anomalyDetect'
import TierBadge from './TierBadge'
import './AnomalySummaryPanel.css'

const TOTAL_KEY = '__total__'
const PERF = ANOMALY_TYPES.filter((t) => t.tier === 'performance')

// Sub-headers for the indented subgroups inside a tier. The phase-attribution
// flags (frontend/network/backend-bound) are a breakdown of WHERE a slow
// action's time went, so they read as a subcategory beneath the loud flags.
const SUBGROUP_LABELS = {
  phase: 'Dominant phase',
}

/**
 * The Anomaly Summary panel for the Action view's left rail.
 *
 * Two modes, one component:
 *  - GLOBAL (default): tiered list of every anomaly type with "N (X%)" of all
 *    actions flagged for it, plus a Total row (actions with ANY flag). Clicking
 *    a type (or Total) filters the Action table to those actions; clicking the
 *    active row again clears the filter.
 *  - CONTEXTUAL: when `hoveredFlags` is set (a row is hovered/selected), the
 *    panel shows just that action's flags instead of the global counts.
 *
 * Props:
 *   counts        { [type]: { actions, pct } }  from detectAnomalies
 *   totalFlagged  { actions, pct }              union (any flag)
 *   totalActions  number                        denominator, for context
 *   hoveredFlags  flags[] | null                the hovered action's flags
 *   activeType    type key | '__total__' | null the active click-to-filter
 *   onSelectType  (key | '__total__') => void   toggle a filter
 *   tierByType    Map<typeKey, 1|2|3> | null    rank badges (from rankAnomalyTiers)
 */
function AnomalySummaryPanel({
  counts,
  totalFlagged,
  totalActions,
  hoveredFlags,
  activeType,
  onSelectType,
  tierByType,
}) {
  if (hoveredFlags) {
    return (
      <section className="anomaly-panel" aria-label="Anomalies for this action">
        <div className="anomaly-panel__title">This action</div>
        {hoveredFlags.length === 0 ? (
          <div className="anomaly-panel__empty">No anomalies detected</div>
        ) : (
          <ul className="anomaly-panel__list">
            {hoveredFlags.map((f) => {
              const t = ANOMALY_TYPES.find((x) => x.key === f.type)
              if (!t) return null
              return (
                <li className="anomaly-panel__ctx-row" key={f.type}>
                  <span className="anomaly-panel__label">{t.label}</span>
                  <span className="anomaly-panel__detail" title={f.detail}>{f.detail}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    )
  }

  const renderRow = (t) => {
    const c = counts?.[t.key] ?? { actions: 0, pct: 0 }
    const active = activeType === t.key
    return (
      <li key={t.key}>
        <button
          type="button"
          className={`anomaly-panel__row${active ? ' is-active' : ''}`}
          aria-pressed={active}
          onClick={() => onSelectType?.(t.key)}
        >
          <span className="anomaly-panel__label">
            <TierBadge tier={tierByType?.get(t.key)} />
            {t.label}
            {t.provisional && <span className="anomaly-panel__tag">needs validation</span>}
          </span>
          <span className="anomaly-panel__count">{fmtCount(c)}</span>
        </button>
      </li>
    )
  }

  // Render a tier's types sorted by count (highest % first, same denominator).
  // Top-level flags come first; the phase-attribution subgroup is folded into an
  // indented block BELOW them, and its members are sorted highest-first too.
  const renderTier = (types) => {
    const count = (t) => counts?.[t.key]?.actions ?? 0
    // Stable sort keeps ANOMALY_TYPES order as the tie-break (e.g. all-zero).
    const byCount = (a, b) => count(b) - count(a)

    const out = types.filter((t) => !t.subgroup).sort(byCount).map(renderRow)

    // Group the remaining (subgrouped) types, preserving first-seen subgroup
    // order, and render each block after all top-level rows.
    const seen = []
    const bySub = new Map()
    for (const t of types) {
      if (!t.subgroup) continue
      if (!bySub.has(t.subgroup)) { bySub.set(t.subgroup, []); seen.push(t.subgroup) }
      bySub.get(t.subgroup).push(t)
    }
    for (const sg of seen) {
      const run = bySub.get(sg).slice().sort(byCount)
      out.push(
        <li key={`sg-${sg}`} className="anomaly-panel__subgroup">
          <div className="anomaly-panel__subgroup-label">{SUBGROUP_LABELS[sg] ?? sg}</div>
          <ul className="anomaly-panel__sublist">{run.map(renderRow)}</ul>
        </li>,
      )
    }
    return out
  }

  const totalActive = activeType === TOTAL_KEY
  return (
    <section className="anomaly-panel" aria-label="Anomaly summary">
      <div className="anomaly-panel__title">Anomaly summary</div>

      <ul className="anomaly-panel__list">{renderTier(PERF)}</ul>

      <ul className="anomaly-panel__list">
        <li>
          <button
            type="button"
            className={`anomaly-panel__row anomaly-panel__row--total${totalActive ? ' is-active' : ''}`}
            aria-pressed={totalActive}
            onClick={() => onSelectType?.(TOTAL_KEY)}
          >
            <span className="anomaly-panel__label">Any anomaly</span>
            <span className="anomaly-panel__count">{fmtCount(totalFlagged)}</span>
          </button>
        </li>
      </ul>

      {Number.isFinite(totalActions) && (
        <div className="anomaly-panel__footnote">{fmtInt(totalActions)} actions in view</div>
      )}
    </section>
  )
}

function fmtCount(c) {
  const actions = c?.actions ?? 0
  const pct = Math.round((c?.pct ?? 0) * 100)
  return `${fmtInt(actions)} (${pct}%)`
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString()
}

export default AnomalySummaryPanel
