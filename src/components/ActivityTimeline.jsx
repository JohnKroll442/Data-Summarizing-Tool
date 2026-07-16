import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import {
  buildActivityTimeline,
  granularityLabel,
  bucketSpanMs,
} from '../lib/activityTimeline'
import { buildActivityBarsOption, buildOverviewOption } from './charts/options/activityBars'
import { useCsvData } from '../context/useCsvData'
import './ActivityTimeline.css'

// Smallest focus window — the drag box never represents less than 4 minutes,
// so it stays clearly visible and it's obvious where you are.
const MIN_WINDOW_MS = 4 * 60 * 1000
// The navigator shows this many times the focus window as surrounding context,
// so the drag box stays a comfortable, grabbable size at ANY zoom level (a
// minute-wide focus still fills ~1/CONTEXT_FACTOR of the navigator).
const CONTEXT_FACTOR = 3

// Header color key ⇄ detail series. `key` doubles as the swatch modifier class
// (swatch-<key>) and the `hidden` state field; `label` matches the series name
// in buildActivityBarsOption so toggling drives the chart's legend selection.
const LEGEND_ITEMS = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'actions', label: 'Actions' },
  { key: 'widgets', label: 'Widgets active' },
]

/**
 * ActivityTimeline — a shared, collapsible panel mounted in the /summary shell
 * so it appears above every view. Grouped bars show how many sessions /
 * actions / widgets are ACTIVE per time bucket.
 *
 * Navigation is two linked charts:
 *   - Overview: a full-span strip on a real time axis, with alternating day
 *     bands and a draggable window. Drag the middle to pan; drag either handle
 *     to grow/shrink the focused range. Handle labels show the exact day/time.
 *   - Detail: grouped bars for just the focused window, re-bucketed to fit —
 *     so narrowing to a day, then an hour, then 30 minutes drills the bars down
 *     to a 5-minute (or 1-minute) view. The bucket size is chosen automatically
 *     to fit the window and shown read-only ("Viewing") — there's no manual
 *     size control.
 *
 * State is local: the shell doesn't unmount on tab switch, so selections
 * persist across views; they reset on file swap.
 */
function ActivityTimeline() {
  const { rows, headers, hasData, activeFileId } = useCsvData()

  const [collapsed, setCollapsed] = useState(false)
  // Series toggled off via the header color key — hidden ones drop out of the
  // detail bars (the remaining bars re-center) just like the old legend clicks.
  const [hidden, setHidden] = useState({ sessions: false, actions: false, widgets: false })
  const toggleSeries = useCallback(
    (key) => setHidden((h) => ({ ...h, [key]: !h[key] })),
    [],
  )
  // Focused window (what the detail shows) in epoch ms; null = full data span.
  const [range, setRange] = useState(null)
  // Navigator's visible context range in epoch ms; null = full data span. The
  // focus sits inside this; keeping view ≈ focus × CONTEXT_FACTOR is what keeps
  // the drag box a usable size while the axis labels zoom down to minutes.
  const [viewRange, setViewRange] = useState(null)

  // Reset the window on file swap (shell persists across tabs).
  useEffect(() => {
    setRange(null)
    setViewRange(null)
  }, [activeFileId])

  // Overview: full data span, auto interval — gives the strip its context and
  // the true min/max the window maps onto.
  const overview = useMemo(
    () => (hasData ? buildActivityTimeline(rows, headers) : null),
    [rows, headers, hasData],
  )

  const span = overview && !overview.empty ? overview.span : null
  const spanMin = span ? span.min.getTime() : 0
  const spanMax = span ? span.max.getTime() : 0

  // Effective focused window (clamped into the span).
  const effRange = useMemo(() => {
    if (!span) return null
    const min = range ? Math.max(spanMin, range.min) : spanMin
    const max = range ? Math.min(spanMax, range.max) : spanMax
    return max > min ? { min, max } : { min: spanMin, max: spanMax }
  }, [span, range, spanMin, spanMax])

  // Effective navigator context range — clamped to the span and always
  // containing the focus, so the drag box is never off-screen.
  const effView = useMemo(() => {
    if (!span) return null
    let min = viewRange ? Math.max(spanMin, viewRange.min) : spanMin
    let max = viewRange ? Math.min(spanMax, viewRange.max) : spanMax
    if (max <= min) { min = spanMin; max = spanMax }
    if (effRange) { min = Math.min(min, effRange.min); max = Math.max(max, effRange.max) }
    return { min, max }
  }, [span, viewRange, spanMin, spanMax, effRange])

  const clampToSpan = useCallback((lo, hi) => {
    if (lo < spanMin) { hi += spanMin - lo; lo = spanMin }
    if (hi > spanMax) { lo -= hi - spanMax; hi = spanMax }
    return [Math.max(spanMin, lo), Math.min(spanMax, hi)]
  }, [spanMin, spanMax])

  // After a drag settles, re-frame the navigator context around the focus so
  // the drag box stays a comfortable ~1/CONTEXT_FACTOR size and you can keep
  // dragging into new periods. Triggers when the box nears a context edge (so
  // panning isn't blocked) OR when it has become too small a slice of the
  // navigator (so it never looks tiny). Debounced so it doesn't jump mid-drag.
  const reframeTimer = useRef(null)
  useEffect(() => {
    if (!effRange || !effView) return undefined
    const fw = effRange.max - effRange.min
    const vw = effView.max - effView.min
    const targetVw = Math.min(spanMax - spanMin, fw * CONTEXT_FACTOR)
    const nearLeft = effRange.min <= effView.min + vw * 0.04 && effView.min > spanMin
    const nearRight = effRange.max >= effView.max - vw * 0.04 && effView.max < spanMax
    const tooSmall = vw > targetVw * 1.4 // box shrank to a tiny slice of the nav
    if (!nearLeft && !nearRight && !tooSmall) return undefined
    reframeTimer.current = setTimeout(() => {
      const center = (effRange.min + effRange.max) / 2
      const [vlo, vhi] = clampToSpan(center - targetVw / 2, center + targetVw / 2)
      setViewRange({ min: vlo, max: vhi })
    }, 260)
    return () => clearTimeout(reframeTimer.current)
  }, [effRange, effView, spanMin, spanMax, clampToSpan])

  // Detail: only the focused window, auto-bucketed to fit — the bucket size
  // follows the window and is reported read-only in the rail.
  const detail = useMemo(
    () =>
      hasData && effRange
        ? buildActivityTimeline(rows, headers, { range: effRange })
        : overview,
    [rows, headers, hasData, effRange, overview],
  )

  // Navigator bars use the SAME bucket size the detail resolved to (honored
  // verbatim over the wider context range), so the strip visually matches the
  // activity timeline view instead of auto-picking a coarser size.
  const navInterval = detail && !detail.empty ? detail.granularity : undefined
  const nav = useMemo(
    () =>
      hasData && effView
        ? buildActivityTimeline(rows, headers, { interval: navInterval, coarsen: false, range: effView })
        : overview,
    [rows, headers, hasData, navInterval, effView, overview],
  )

  const overviewOption = useMemo(() => {
    if (!nav || nav.empty || !effView || !effRange) return { series: [] }
    // Center each bar within its bucket so bars sit inside the interval.
    const half = bucketSpanMs(nav.granularity) / 2
    const points = nav.buckets.map((b, i) => [
      b.sort + half,
      nav.series.sessions[i] + nav.series.actions[i] + nav.series.widgets[i],
    ])
    return buildOverviewOption(points, effView.min, effView.max, effRange)
  }, [nav, effView, effRange])

  const detailOption = useMemo(
    () => (detail && !detail.empty ? buildActivityBarsOption(detail.buckets, detail.series, hidden) : { series: [] }),
    [detail, hidden],
  )

  // ECharts reports the slider window in epoch ms (fall back to mapping the
  // start/end percentages against the current navigator context range).
  const onOverviewZoom = useCallback((params) => {
    const z = params?.batch?.[0] ?? params
    if (z == null || !effView) return
    let min = z.startValue
    let max = z.endValue
    if (min == null || max == null) {
      if (z.start == null || z.end == null) return
      const total = effView.max - effView.min || 1
      min = effView.min + (z.start / 100) * total
      max = effView.min + (z.end / 100) * total
    }
    if (max - min < MIN_WINDOW_MS) {
      const center = (min + max) / 2
      min = center - MIN_WINDOW_MS / 2
      max = center + MIN_WINDOW_MS / 2
    }
    setRange({ min, max })
  }, [effView])

  if (!hasData || !overview) return null

  const zoomed = !!range || !!viewRange
  const t = detail ?? overview
  const subtitle = t.empty
    ? 'No parseable timestamps in this file'
    : `${granularityLabel(t.granularity)} buckets · ` +
      `${t.totals.sessions} sessions · ${t.totals.actions} actions · ${t.totals.widgets} widgets` +
      (effRange ? ` · ${fmtRange(effRange)}` : '')

  return (
    <section className="activity-timeline">
      <header className="activity-timeline-header">
        <button
          type="button"
          className="activity-timeline-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          <span className="activity-timeline-title">Activity Timeline</span>
        </button>
        <span className="activity-timeline-subtitle">{subtitle}</span>
        {!t.empty && !collapsed && (
          <div className="activity-timeline-legend" role="group" aria-label="Toggle series">
            {LEGEND_ITEMS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`activity-timeline-legend-item${hidden[key] ? ' is-hidden' : ''}`}
                onClick={() => toggleSeries(key)}
                aria-pressed={!hidden[key]}
                title={hidden[key] ? `Show ${label}` : `Hide ${label}`}
              >
                <span className={`activity-timeline-swatch swatch-${key}`} />
                {label}
              </button>
            ))}
          </div>
        )}
      </header>

      {!collapsed && (
        <div className="activity-timeline-body">
          <aside className="activity-timeline-rail">
            <div className="activity-timeline-gran">
              <span>Viewing</span>
              <div className="activity-timeline-viewing">
                <span className="activity-timeline-viewing-range">
                  {effRange ? fmtRange(effRange) : 'Full range'}
                </span>
                {!t.empty && (
                  <span className="activity-timeline-viewing-bucket">
                    {granularityLabel(t.granularity)} buckets
                  </span>
                )}
              </div>
            </div>

            {zoomed && (
              <button
                type="button"
                className="activity-timeline-reset"
                onClick={() => { setRange(null); setViewRange(null) }}
              >
                Reset to full range
              </button>
            )}
          </aside>

          <div className="activity-timeline-charts">
            {overview.empty ? (
              <div className="activity-timeline-empty">
                No timestamps to plot. This file has no parseable time column.
              </div>
            ) : (
              <>
                <ReactECharts
                  option={detailOption}
                  style={{ height: 300, width: '100%' }}
                  notMerge
                  lazyUpdate
                />
                <div className="activity-timeline-overview-label">
                  Drag the window below to focus a day, hour, or minute range
                </div>
                <ReactECharts
                  option={overviewOption}
                  style={{ height: 128, width: '100%' }}
                  notMerge
                  lazyUpdate
                  onEvents={{ dataZoom: onOverviewZoom }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// Compact "Jun 15, 14:30 → Jul 2, 09:00" window label.
function fmtRange(range) {
  const f = (ms) => {
    const d = new Date(ms)
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
    const p = (n) => String(n).padStart(2, '0')
    return `${mon} ${d.getDate()}, ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return `${f(range.min)} → ${f(range.max)}`
}

export default ActivityTimeline
