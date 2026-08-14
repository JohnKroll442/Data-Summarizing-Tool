import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import EChartCard from './charts/EChartCard'
import ActionCellDetail from './ActionCellDetail'
import { buildTimeOfDayTrendOption } from './charts/options/timeOfDayTrend'
import { buildTimeOfDayHourScatterOption } from './charts/options/timeOfDayHourScatter'
import { cellKeyOf } from '../lib/storyActionMatrix'
import './ActionTimeOfDayPanel.css'

/**
 * Time-Of-Day-Trend view — a full-screen line chart of p50 / p90 action
 * duration per hourly bucket (with faint action-count bars behind, so activity
 * spikes stand out), built upstream in ActionView via buildTimeOfDayTrend.
 *
 * Two levels of click-to-drill, stacked below the trend so nothing above ever
 * shrinks (mirrors the other Action panels for consistency):
 *   1. Click an hour on the trend line → a scatter of that hour's individual
 *      action instances (minute-of-hour × duration, log Y), colored by action
 *      type with anomaly-flagged runs as red triangles.
 *   2. Click a dot in that scatter → the shared ActionCellDetail (instance list
 *      + waterfall) for that story×action, with the clicked run preselected.
 * Clicking the same hour / dot again (or its ×) closes that level. State is
 * local, so drilling repaints only this panel.
 *
 * Props:
 *   data         { buckets, totalActions, multiDay, hasData } trend result
 *   matrix       storyActionMatrix — its cells Map resolves a dot → the group
 *   rows         session-scoped raw CSV rows (for the waterfall)
 *   headers      CSV headers
 *   byActionKey  Map<"name::ts", flags[]> from detectAnomalies — flags a dot
 *   tierByType   Map<typeKey, 1|2|3> from rankAnomalyTiers
 */
function ActionTimeOfDayPanel({ data, matrix, rows, headers, byActionKey, tierByType }) {
  const { buckets = [], totalActions = 0, multiDay = false } = data ?? {}
  const option = useMemo(
    () => buildTimeOfDayTrendOption({ buckets, multiDay }),
    [buckets, multiDay],
  )

  // Mirror ActionOffsetPanel: measure the card's document-absolute top so the
  // plot fills the viewport down to a small bottom gap (not a fixed height),
  // and recompute on resize / when content above changes size.
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

  // Level 1: the hour drilled into (a bucket key), or null. Click a point to toggle.
  const [selectedKey, setSelectedKey] = useState(null)
  const scatterRef = useRef(null)
  // Level 2: the action instance pinned from the scatter, or null.
  const [pinned, setPinned] = useState(null)
  const detailRef = useRef(null)

  // Drop the drill-downs if their target leaves the current scope (filter change).
  useEffect(() => {
    if (selectedKey && !buckets.some((b) => b.key === selectedKey)) setSelectedKey(null)
  }, [buckets, selectedKey])
  useEffect(() => {
    if (pinned && !matrix?.cells?.has(cellKeyOf(pinned.story, pinned.action))) setPinned(null)
  }, [matrix, pinned])

  const onTrendEvents = useMemo(
    () => ({
      click: (p) => {
        // Two ways to land here: a direct click on a line/bar point (dataIndex
        // is the bucket), or a click anywhere in the hour's full-height markArea
        // click target (bucket index carried in its name). Resolve either.
        let idx = null
        if (p?.componentType === 'markArea') {
          const n = Number(p?.name ?? p?.data?.name)
          idx = Number.isInteger(n) ? n : null
        } else if (typeof p?.dataIndex === 'number') {
          idx = p.dataIndex
        }
        const b = idx != null ? buckets[idx] : null
        if (!b || !b.count) return // empty hours aren't drillable
        setSelectedKey((prev) => {
          const next = prev === b.key ? null : b.key
          setPinned(null) // switching hours closes the instance detail
          return next
        })
      },
    }),
    [buckets],
  )

  const selected = selectedKey ? buckets.find((b) => b.key === selectedKey) ?? null : null

  // Annotate the drilled hour's instances with an anomaly flag so the scatter
  // can pull the flagged outliers into their own red-triangle series.
  const scatter = useMemo(() => {
    if (!selected) return null
    const instances = selected.instances.map((i) => ({
      ...i,
      flagged: (byActionKey?.get(i.actionKey)?.length ?? 0) > 0,
    }))
    return buildTimeOfDayHourScatterOption({ instances, hourLabel: selected.label })
  }, [selected, byActionKey])

  const onScatterEvents = useMemo(() => {
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

  const pinnedCell = pinned
    ? matrix?.cells?.get(cellKeyOf(pinned.story, pinned.action)) ?? null
    : null

  // Scroll each drill-down into view when opened / retargeted.
  useEffect(() => {
    if (!selected || !scatterRef.current) return
    smoothScroll(scatterRef.current)
  }, [selected])
  useEffect(() => {
    if (!pinned || !detailRef.current) return
    smoothScroll(detailRef.current)
  }, [pinned])

  const subtitle =
    `${totalActions} action${totalActions === 1 ? '' : 's'} · ` +
    'p50 / p90 duration by hour · click an hour to drill in'

  return (
    <section className="action-view-fullscreen" aria-label="Time of day trend">
      <div ref={chartWrapRef} className="time-of-day-panel__chart">
        <EChartCard
          title="Time-Of-Day-Trend"
          subtitle={subtitle}
          option={option}
          height={chartHeight}
          onEvents={onTrendEvents}
        />
      </div>

      {selected && scatter && (
        <div ref={scatterRef} className="time-of-day-panel__drill">
          <EChartCard
            title={`Actions in ${selected.label}`}
            subtitle={`${selected.count} action${selected.count === 1 ? '' : 's'} · minute of hour × duration · log axis · click a dot for detail`}
            option={scatter}
            height={360}
            onRemove={() => {
              setSelectedKey(null)
              setPinned(null)
            }}
            onEvents={onScatterEvents}
          />
        </div>
      )}

      {pinned && pinnedCell && (
        <ActionCellDetail
          story={pinned.story}
          action={pinned.action}
          cell={pinnedCell}
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
  return !!a && !!b && a.story === b.story && a.action === b.action && a.timestamp === b.timestamp
}

function smoothScroll(el) {
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

const CHART_MIN_HEIGHT = 360
const CHART_BOTTOM_GAP = 20

export default ActionTimeOfDayPanel
