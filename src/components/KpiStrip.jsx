import { useLayoutEffect, useMemo, useRef } from 'react'
import { Text } from '@ui5/webcomponents-react/Text'
import { computeKpis } from '../lib/kpis'
import './KpiStrip.css'

// Smallest we'll shrink a KPI value to before giving up (and letting the CSS
// ellipsis take over). Keeps very long values legible rather than microscopic.
const MIN_KPI_FONT_PX = 12

/**
 * A single KPI value that shrinks its font just enough to keep the full text on
 * one line within its card — so nothing wraps to two lines and nothing is
 * clipped, no matter how long the value (e.g. Action view's "Slowest action").
 * Re-fits whenever the card's width changes (window resize, grid reflow), so it
 * stays responsive to the page. Numeric/short values never shrink.
 */
function KpiValue({ value }) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.parentElement
    if (!el || !box) return

    let lastWidth = -1
    const fit = () => {
      const width = box.clientWidth
      // Only re-fit when the available width actually changed — our own
      // font-size change alters height, not width, so this avoids a loop.
      if (width === lastWidth) return
      lastWidth = width
      el.style.fontSize = '' // reset to the CSS base (respects breakpoints)
      let size = parseFloat(getComputedStyle(el).fontSize)
      while (el.scrollWidth > el.clientWidth + 0.5 && size > MIN_KPI_FONT_PX) {
        size -= 1
        el.style.fontSize = `${size}px`
      }
    }

    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [value])

  return (
    <Text className="kpi-value" ref={ref} title={String(value)}>
      {value}
    </Text>
  )
}

/**
 * Presentational KPI strip shown above the aggregate summary tables.
 * `variant` selects which set of metrics to compute (session/action/widget).
 * Returns null when there are no rows so the caller can render nothing.
 *
 * Pass a pre-computed `kpis` array to render those directly instead of
 * computing from raw rows — used when the caller already has the filtered,
 * aggregated rows (e.g. a summary table feeding its visible rows) and wants
 * the KPIs to track the active filters.
 *
 * A card becomes an interactive filter toggle when its kpi carries an
 * `onClick` (with optional `active` for the pressed state and `hint` for the
 * tooltip) — used by the Widget view to turn each p95 card into a one-click
 * "isolate this phase's slow tail" filter.
 *
 * `columns` pins the grid to that many equal columns, keeping every card on a
 * single row regardless of count (used by the Action view's 7-KPI header strip).
 * When omitted, the responsive CSS grid (4-up → 2-up → 1-up) applies. Values
 * still auto-shrink to fit, so a one-row strip stays legible as it narrows.
 */
function KpiStrip({ variant, rows, headers, kpis: kpisProp, columns }) {
  const kpis = useMemo(
    () => (kpisProp !== undefined ? kpisProp : computeKpis(variant, rows, headers)),
    [kpisProp, variant, rows, headers],
  )
  if (!kpis) return null
  const style = columns
    ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
    : undefined
  return (
    <div className="kpi-strip" role="group" aria-label={`${variant} KPIs`} style={style}>
      {kpis.map((k) => {
        const clickable = typeof k.onClick === 'function'
        const inner = (
          <>
            <Text className="kpi-label">{k.label}</Text>
            <KpiValue value={k.value} />
          </>
        )
        if (!clickable) {
          return (
            <div className="kpi-card" key={k.label}>
              {inner}
            </div>
          )
        }
        return (
          <button
            type="button"
            className={`kpi-card is-clickable${k.active ? ' is-active' : ''}`}
            key={k.label}
            aria-pressed={Boolean(k.active)}
            title={k.hint || undefined}
            onClick={k.onClick}
          >
            {inner}
          </button>
        )
      })}
    </div>
  )
}

export default KpiStrip
