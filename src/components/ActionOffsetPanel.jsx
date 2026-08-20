import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import EChartCard from './charts/EChartCard'
import ActionCellDetail from './ActionCellDetail'
import { buildOffsetDurationOption } from './charts/options/offsetDuration'
import { cellKeyOf } from '../lib/storyActionMatrix'
import { formatDurationMs } from '../lib/format'
import { scrollFast } from '../lib/scrollFast'
import './ActionOffsetPanel.css'

/**
 * Offset vs Duration view — a full-screen log–log scatter, one dot per action
 * instance: X = action duration, Y = max widget offset (pre-render wait). A
 * dashed offset = duration diagonal makes overruns (dots above the line) pop
 * without reading a number. Data is built upstream in ActionView via
 * buildOffsetDurationPoints.
 *
 * Click a dot to open its story×action group's detail below the chart, with
 * that run preselected in the instance list + waterfall. Click again or the
 * detail's × to close. State is local so clicking repaints only this panel,
 * not all of ActionView.
 *
 * Props:
 *   data        { points, largeOffsetMs, counts:{ ok, large, overrun } }
 *   matrix      storyActionMatrix — its cells Map resolves a dot → the group
 *   rows        session-scoped raw CSV rows (for the waterfall)
 *   headers     CSV headers
 *   byActionKey Map<"name::ts", flags[]> from detectAnomalies
 *   tierByType  Map<typeKey, 1|2|3> from rankAnomalyTiers
 */
function ActionOffsetPanel({ data, matrix, rows, headers, byActionKey, tierByType }) {
  const { points = [], largeOffsetMs, counts = { ok: 0, large: 0, overrun: 0 } } = data ?? {}
  const option = useMemo(() => buildOffsetDurationOption({ points }), [points])

  // The chart fills the viewport from its own top edge down to a small gap above
  // the bottom, instead of a fixed height that leaves whitespace below on tall
  // screens. We measure the card's document-absolute top (scroll-independent) so
  // the height stays put as the page scrolls, and recompute on window resize and
  // whenever content ABOVE the chart changes size (a ResizeObserver on <body>
  // catches the timeline collapsing, KPI wraps, etc.). echarts-for-react's
  // size-sensor auto-resizes the canvas when this height changes. The detail
  // panel sits BELOW the chart, so opening it never shrinks the plot.
  const chartWrapRef = useRef(null)
  const [chartHeight, setChartHeight] = useState(520)

  const measureHeight = useMemo(() => {
    return () => {
      const el = chartWrapRef.current
      if (!el || typeof window === 'undefined') return
      const chartEl = el.firstElementChild?.lastElementChild ?? el
      const top = chartEl.getBoundingClientRect().top + window.scrollY
      const avail = window.innerHeight - top - CHART_BOTTOM_GAP
      const next = Math.max(CHART_MIN_HEIGHT, Math.round(avail))
      setChartHeight((prev) => (Math.abs(next - prev) > 1 ? next : prev))
    }
  }, [])

  useLayoutEffect(() => {
    measureHeight()
    window.addEventListener('resize', measureHeight)
    let ro
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measureHeight)
      ro.observe(document.body)
    }
    return () => {
      window.removeEventListener('resize', measureHeight)
      ro?.disconnect()
    }
  }, [measureHeight])

  // Single pin state — only click-to-pin, no hover preview.
  const [pinned, setPinned] = useState(null)
  const detailRef = useRef(null)

  // Drop a pin when its group leaves the plotted scope (filter change).
  useEffect(() => {
    if (pinned && !matrix?.cells?.has(cellKeyOf(pinned.story, pinned.action))) setPinned(null)
  }, [matrix, pinned])

  // Scroll the detail into view when pinned.
  useEffect(() => {
    if (!pinned || !detailRef.current) return
    scrollFast(detailRef.current)
  }, [pinned])

  const onEvents = useMemo(() => {
    const pointOf = (p) => {
      const d = p?.data
      if (p?.seriesType !== 'scatter' || !d || d.action == null) return null
      return { story: d.story ?? '', action: d.action, timestamp: d.timestamp ?? '' }
    }
    return {
      click: (p) => {
        const sel = pointOf(p)
        if (!sel) return
        setPinned((prev) => (samePoint(prev, sel) ? null : sel))
      },
    }
  }, [])

  const selectedCell = pinned
    ? matrix?.cells?.get(cellKeyOf(pinned.story, pinned.action)) ?? null
    : null

  const bandNote =
    Number.isFinite(largeOffsetMs) && largeOffsetMs !== Infinity
      ? ` · large offset ≥ ${formatDurationMs(largeOffsetMs)}`
      : ''
  const subtitle =
    `${points.length} action${points.length === 1 ? '' : 's'} · ` +
    `${counts.overrun} overrun${counts.overrun === 1 ? '' : 's'} above the offset = duration line` +
    `${bandNote} · log axes · click a dot to view detail`

  return (
    <section className="action-view-fullscreen" aria-label="Offset vs duration">
      <div ref={chartWrapRef} className="offset-panel__chart">
        <EChartCard
          title="Offset vs Duration"
          subtitle={subtitle}
          option={option}
          height={chartHeight}
          onEvents={onEvents}
        />
      </div>
      {pinned && selectedCell && (
        <ActionCellDetail
          story={pinned.story}
          action={pinned.action}
          cell={selectedCell}
          rows={rows}
          headers={headers}
          byActionKey={byActionKey}
          tierByType={tierByType}
          initialInstanceTs={pinned.timestamp}
          onClose={() => setPinned(null)}
          detailRef={detailRef}
        />
      )}
    </section>
  )
}

function samePoint(a, b) {
  return (
    !!a &&
    !!b &&
    a.story === b.story &&
    a.action === b.action &&
    a.timestamp === b.timestamp
  )
}

const CHART_MIN_HEIGHT = 360
const CHART_BOTTOM_GAP = 20

export default ActionOffsetPanel
