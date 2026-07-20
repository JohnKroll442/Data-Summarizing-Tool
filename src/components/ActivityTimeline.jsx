import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import {
  buildActivityTimeline,
  granularityLabel,
  bucketSpanMs,
  sessionIdsInWindow,
  widgetIdsInWindow,
  actionKeysInWindow,
} from '../lib/activityTimeline'
import { buildActivityBarsOption, buildOverviewOption } from './charts/options/activityBars'
import { formatTimeRangeLabel } from '../lib/format'
import { useCsvData } from '../context/useCsvData'
import './ActivityTimeline.css'

// Smallest focus window — the drag box never represents less than 4 minutes,
// so it stays clearly visible and it's obvious where you are.
const MIN_WINDOW_MS = 4 * 60 * 1000
// The navigator shows this many times the focus window as surrounding context,
// so the drag box stays a comfortable, grabbable size at ANY zoom level (a
// minute-wide focus still fills ~1/CONTEXT_FACTOR of the navigator).
const CONTEXT_FACTOR = 3

// Per wheel-notch zoom factor. Gentle (10%) so it feels smooth; rapid scrolls
// coalesce per animation frame so trackpads glide instead of jumping.
const WHEEL_STEP = 0.9
// Pixels of movement before a mouse-down becomes a pan (vs. a bar click).
const DRAG_THRESHOLD = 4

// Clamp [lo,hi] into [min,max], preserving width by sliding at the edges.
function clampToSpanPure(lo, hi, min, max) {
  if (lo < min) { hi += min - lo; lo = min }
  if (hi > max) { lo -= hi - max; hi = max }
  return [Math.max(min, lo), Math.min(max, hi)]
}

// Header color key ⇄ detail series. `key` doubles as the swatch modifier class
// (swatch-<key>) and the `hidden` state field; `label` matches the series name
// in buildActivityBarsOption so toggling drives the chart's legend selection.
const LEGEND_ITEMS = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'actions', label: 'Actions' },
  { key: 'widgets', label: 'Widgets active' },
]

// Which series the detail bars show by default when you land on each view. The
// active view's own series is on; the others start hidden but the header key
// buttons can toggle them back in. Summary and Raw start with none shown and
// collapsed. Keyed by the last path segment of /summary/<view>.
const VIEW_SERIES_DEFAULTS = {
  session: { sessions: false, actions: true, widgets: true },
  action: { sessions: true, actions: false, widgets: true },
  widget: { sessions: true, actions: true, widgets: false },
  summary: { sessions: true, actions: true, widgets: true },
  raw: { sessions: true, actions: true, widgets: true },
}

// Views where the timeline defaults to collapsed with no series shown.
const COLLAPSED_VIEWS = new Set(['summary', 'raw'])

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
  const {
    rows,
    headers,
    hasData,
    activeFileId,
    setSessionFilter,
    setSessionMultiFilter,
    setActionFilter,
    setActionMultiFilter,
    setSessionFilterWindow,
    setWidgetMultiFilter,
    setActionInvocationFilter,
    setWidgetFilterWindow,
    setActionFilterWindow,
    timelineFocus,
    setTimelineRange,
    resetTimeline,
    timelineResetNonce,
  } = useCsvData()
  const navigate = useNavigate()
  const location = useLocation()
  const rootRef = useRef(null)

  const [collapsed, setCollapsed] = useState(
    () => COLLAPSED_VIEWS.has(location.pathname.split('/').pop()),
  )
  // Which /summary/<view> we're on drives the detail bars' default series.
  const view = location.pathname.split('/').pop()
  // Series toggled off via the header color key — hidden ones drop out of the
  // detail bars (the remaining bars re-center) just like the old legend clicks.
  // Seeded from the current view's default so the first paint already matches.
  const [hidden, setHidden] = useState(
    () => VIEW_SERIES_DEFAULTS[location.pathname.split('/').pop()]
      ?? { sessions: false, actions: false, widgets: false },
  )
  // When you move to another summary view, reset the bars to that view's
  // default (its own series on, the others off) and set its default open/closed
  // state — Summary and Raw start collapsed with none shown, the entity views
  // start open. Manual toggles then persist until the next navigation.
  useEffect(() => {
    const def = VIEW_SERIES_DEFAULTS[view]
    if (def) {
      setHidden(def)
      setCollapsed(COLLAPSED_VIEWS.has(view))
    }
  }, [view])
  // Log y-axis makes small bars readable next to a dominant spike; off by
  // default since a linear axis reads more naturally for exact counts.
  const [logScale, setLogScale] = useState(false)
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

  const clampToSpan = useCallback(
    (lo, hi) => clampToSpanPure(lo, hi, spanMin, spanMax),
    [spanMin, spanMax],
  )

  // Publish the focused window to the shared context so the summary tables scope
  // themselves to what the timeline shows. Only while actually zoomed — at full
  // range we publish null (no constraint). effRange/zoomed don't depend on
  // timelineRange, so there's no update loop.
  const isZoomed = !!range || !!viewRange
  useEffect(() => {
    if (!span) return
    if (isZoomed && effRange) setTimelineRange({ min: effRange.min, max: effRange.max })
    else setTimelineRange(null)
  }, [isZoomed, effRange, span, setTimelineRange])

  // A table's Clear (or the range banner's clear) bumps timelineResetNonce to ask
  // us to drop the zoom. Resetting range/viewRange flips isZoomed false, which
  // clears timelineRange via the effect above. Skip the initial mount.
  const skipFirstReset = useRef(true)
  useEffect(() => {
    if (skipFirstReset.current) { skipFirstReset.current = false; return }
    setRange(null)
    setViewRange(null)
  }, [timelineResetNonce])

  // Focus the timeline on a window requested from elsewhere (a "busiest day /
  // 7 days / month" card on the Summary view). Sets the focus + navigator
  // context, expands the panel if collapsed, and scrolls it into view.
  useEffect(() => {
    if (!timelineFocus || !span) return
    const [flo, fhi] = clampToSpan(timelineFocus.min, timelineFocus.max)
    if (fhi <= flo) return
    setRange({ min: flo, max: fhi })
    const vw = Math.min(spanMax - spanMin, (fhi - flo) * CONTEXT_FACTOR)
    const c = (flo + fhi) / 2
    const [vlo, vhi] = clampToSpan(c - vw / 2, c + vw / 2)
    setViewRange({ min: vlo, max: vhi })
    setCollapsed(false)
    requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [timelineFocus, span, spanMin, spanMax, clampToSpan])

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

  // Overview navigator is a slim range slider (no bars), so it just needs the
  // context span (axis extent) and the focused window (handle positions).
  const overviewOption = useMemo(() => {
    if (!effView || !effRange) return { series: [] }
    return buildOverviewOption(effView.min, effView.max, effRange)
  }, [effView, effRange])

  const detailOption = useMemo(
    () => (detail && !detail.empty ? buildActivityBarsOption(detail.buckets, detail.series, hidden, logScale) : { series: [] }),
    [detail, hidden, logScale],
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

  // ——— Wheel zoom + drag-pan on the detail chart ———
  // Wheel zooms the focused window in/out around the timestamp under the
  // pointer (auto-refining bucket size: day → hour → 5-min → 1-min); click-drag
  // pans the window through time. Both mutate effRange, so they feel like one
  // continuous navigation and stay in sync with the overview strip. Handlers
  // are stable and read live state from a ref, so DOM listeners attach once.
  const detailChartRef = useRef(null)
  const detailWrapRef = useRef(null)
  const stateRef = useRef({})
  stateRef.current = { collapsed, effRange, spanMin, spanMax, hasSpan: !!span, detail }
  // Set while dragging so the click that fires on mouse-up doesn't also trigger
  // the Sessions-bar drill-down.
  const didPanRef = useRef(false)

  // rAF-coalesced wheel zoom: many wheel/trackpad events in one frame combine
  // into one smooth step rather than a stack of jumps.
  const wheelAccum = useRef(1)
  const wheelAnchor = useRef(null)
  const wheelPending = useRef(false)
  const applyWheelZoom = useCallback(() => {
    wheelPending.current = false
    const s = stateRef.current
    const factor = Math.min(2, Math.max(0.5, wheelAccum.current))
    wheelAccum.current = 1
    if (!s.effRange || !s.hasSpan) return
    const width = s.effRange.max - s.effRange.min
    const fullSpan = s.spanMax - s.spanMin
    const newWidth = Math.min(fullSpan, Math.max(MIN_WINDOW_MS, width * factor))
    if (Math.abs(newWidth - width) < 1) return // at the min/max already
    let anchor = wheelAnchor.current ?? (s.effRange.min + s.effRange.max) / 2
    anchor = Math.max(s.effRange.min, Math.min(s.effRange.max, anchor))
    const frac = width > 0 ? (anchor - s.effRange.min) / width : 0.5
    const [flo, fhi] = clampToSpanPure(anchor - frac * newWidth, anchor + (1 - frac) * newWidth, s.spanMin, s.spanMax)
    setRange({ min: flo, max: fhi })
    const vw = Math.min(fullSpan, newWidth * CONTEXT_FACTOR)
    const c = (flo + fhi) / 2
    const [vlo, vhi] = clampToSpanPure(c - vw / 2, c + vw / 2, s.spanMin, s.spanMax)
    setViewRange({ min: vlo, max: vhi })
  }, [])

  const onDetailWheel = useCallback((e) => {
    const s = stateRef.current
    if (s.collapsed || !s.hasSpan || !s.effRange || !s.detail || s.detail.empty) return
    e.preventDefault()
    // Anchor = the timestamp under the cursor (falls back to window center).
    let anchor = (s.effRange.min + s.effRange.max) / 2
    const inst = detailChartRef.current?.getEchartsInstance?.()
    const n = s.detail.buckets.length
    if (inst && n > 0) {
      const rect = inst.getDom().getBoundingClientRect()
      let idx = inst.convertFromPixel({ xAxisIndex: 0 }, e.clientX - rect.left)
      if (Array.isArray(idx)) idx = idx[0]
      if (Number.isFinite(idx)) {
        idx = Math.max(0, Math.min(n - 1, idx))
        const i = Math.floor(idx)
        anchor = s.detail.buckets[i].sort + (idx - i) * bucketSpanMs(s.detail.granularity)
      }
    }
    wheelAnchor.current = anchor
    wheelAccum.current *= e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP
    if (!wheelPending.current) {
      wheelPending.current = true
      requestAnimationFrame(applyWheelZoom)
    }
  }, [applyWheelZoom])

  // Drag-to-pan: shift the focus window through time (grab-style — drag right
  // reveals earlier data). ms-per-pixel is measured from the chart geometry at
  // grab time so the content tracks the cursor 1:1.
  const dragRef = useRef(null)
  const onDetailPointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return
      d.moved = true
      didPanRef.current = true
    }
    const shift = -dx * d.msPerPx
    const [flo, fhi] = clampToSpanPure(d.startMin + shift, d.startMax + shift, d.spanMin, d.spanMax)
    setRange({ min: flo, max: fhi })
    const fullSpan = d.spanMax - d.spanMin
    const vw = Math.min(fullSpan, (fhi - flo) * CONTEXT_FACTOR)
    const c = (flo + fhi) / 2
    const [vlo, vhi] = clampToSpanPure(c - vw / 2, c + vw / 2, d.spanMin, d.spanMax)
    setViewRange({ min: vlo, max: vhi })
  }, [])
  const onDetailPointerUp = useCallback(() => {
    dragRef.current = null
    window.removeEventListener('pointermove', onDetailPointerMove)
    window.removeEventListener('pointerup', onDetailPointerUp)
  }, [onDetailPointerMove])
  const onDetailPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    const s = stateRef.current
    if (s.collapsed || !s.hasSpan || !s.effRange || !s.detail || s.detail.empty) return
    const inst = detailChartRef.current?.getEchartsInstance?.()
    if (!inst) return
    const buckets = s.detail.buckets
    const n = buckets.length
    const rect = inst.getDom().getBoundingClientRect()
    let msPerPx
    if (n >= 2) {
      const px0 = inst.convertToPixel({ xAxisIndex: 0 }, 0)
      const pxN = inst.convertToPixel({ xAxisIndex: 0 }, n - 1)
      const dpx = pxN - px0
      if (Number.isFinite(dpx) && Math.abs(dpx) > 1) {
        msPerPx = (buckets[n - 1].sort - buckets[0].sort) / dpx
      }
    }
    if (!Number.isFinite(msPerPx) || msPerPx <= 0) {
      msPerPx = (s.effRange.max - s.effRange.min) / (rect.width || 1)
    }
    didPanRef.current = false
    dragRef.current = {
      startX: e.clientX,
      startMin: s.effRange.min,
      startMax: s.effRange.max,
      spanMin: s.spanMin,
      spanMax: s.spanMax,
      msPerPx,
      moved: false,
    }
    window.addEventListener('pointermove', onDetailPointerMove)
    window.addEventListener('pointerup', onDetailPointerUp)
  }, [onDetailPointerMove, onDetailPointerUp])

  // Attach wheel (non-passive so preventDefault stops the page scrolling) and
  // pointer-down natively; re-run when the chart mounts/unmounts.
  useEffect(() => {
    const el = detailWrapRef.current
    if (!el) return undefined
    el.addEventListener('wheel', onDetailWheel, { passive: false })
    el.addEventListener('pointerdown', onDetailPointerDown)
    return () => {
      el.removeEventListener('wheel', onDetailWheel)
      el.removeEventListener('pointerdown', onDetailPointerDown)
    }
  }, [collapsed, overview, onDetailWheel, onDetailPointerDown])


  // Click a bar → drill into that series' view, scoped to exactly the entities
  // the clicked bucket counted (over its [start, end) window), so the count you
  // land on matches the bar. All three series are actionable: Sessions →
  // sessions active in the window, Widgets → widgets active, Actions → actions
  // that fired in it. We resetTimeline() so the still-active zoom doesn't
  // re-filter the drilled set by a different rule. The shared context filters
  // both seed a fresh table mount and sync an already-mounted one.
  const onDetailClick = useCallback((params) => {
    // Ignore the click that fires at the end of a drag-pan.
    if (didPanRef.current) { didPanRef.current = false; return }
    if (params?.componentType !== 'series') return
    if (!detail || detail.empty) return
    const b = detail.buckets[params.dataIndex]
    if (!b) return
    const start = b.sort
    const end = detail.buckets[params.dataIndex + 1]?.sort
      ?? b.sort + bucketSpanMs(detail.granularity)
    const windowLabel = fmtRange({ min: start, max: end })

    // Clear every drill scope so the target view shows exactly this bucket, and
    // drop the timeline zoom so it can't further narrow the drilled set.
    const clearDrills = () => {
      setSessionFilter(null)
      setActionFilter(null)
      setSessionMultiFilter([])
      setActionMultiFilter([])
      setSessionFilterWindow(null)
      setWidgetMultiFilter([])
      setActionInvocationFilter([])
      setWidgetFilterWindow(null)
      setActionFilterWindow(null)
    }
    const finish = (view) => {
      resetTimeline()
      navigate(`/summary/${view}`)
      // Minimize the timeline and jump to the freshly-filtered table. rAF runs
      // after React commits the collapse + navigation.
      setCollapsed(true)
      requestAnimationFrame(() => {
        document
          .getElementById('summary-view-top')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }

    if (params.seriesName === 'Sessions') {
      const ids = sessionIdsInWindow(rows, headers, start, end)
      if (ids.length === 0) return
      clearDrills()
      setSessionMultiFilter(ids)
      setSessionFilterWindow(windowLabel)
      finish('session')
    } else if (params.seriesName === 'Widgets active') {
      const ids = widgetIdsInWindow(rows, headers, start, end)
      if (ids.length === 0) return
      clearDrills()
      setWidgetMultiFilter(ids)
      setWidgetFilterWindow(windowLabel)
      finish('widget')
    } else if (params.seriesName === 'Actions') {
      const keys = actionKeysInWindow(rows, headers, start, end)
      if (keys.length === 0) return
      clearDrills()
      setActionInvocationFilter(keys)
      setActionFilterWindow(windowLabel)
      finish('action')
    }
  }, [
    detail, rows, headers, navigate, resetTimeline,
    setSessionFilter, setActionFilter, setActionMultiFilter, setSessionMultiFilter,
    setSessionFilterWindow, setWidgetMultiFilter, setActionInvocationFilter,
    setWidgetFilterWindow, setActionFilterWindow,
  ])

  if (!hasData || !overview) return null

  const zoomed = isZoomed
  const t = detail ?? overview
  const subtitle = t.empty
    ? 'No parseable timestamps in this file'
    : `${granularityLabel(t.granularity)} buckets · ` +
      `${t.totals.sessions} sessions · ${t.totals.actions} actions · ${t.totals.widgets} widgets` +
      (effRange ? ` · ${fmtRange(effRange)}` : '')

  return (
    <section className="activity-timeline" ref={rootRef}>
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

            <button
              type="button"
              className={`activity-timeline-scale${logScale ? ' is-active' : ''}`}
              onClick={() => setLogScale((v) => !v)}
              aria-pressed={logScale}
              title="Log scale makes small bars visible next to a large spike"
            >
              Log scale
            </button>

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
                <div className="activity-timeline-detail" ref={detailWrapRef}>
                  <ReactECharts
                    ref={detailChartRef}
                    option={detailOption}
                    style={{ height: 300, width: '100%' }}
                    notMerge
                    lazyUpdate
                    onEvents={{ click: onDetailClick }}
                  />
                </div>
                <ReactECharts
                  option={overviewOption}
                  style={{ height: 40, width: '100%', marginTop: -16 }}
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
  return formatTimeRangeLabel(range.min, range.max)
}

export default ActivityTimeline
