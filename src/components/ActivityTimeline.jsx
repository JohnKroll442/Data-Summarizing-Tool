import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { ColumnChart } from '@ui5/webcomponents-react-charts/ColumnChart'
import { ObjectStatus } from '@ui5/webcomponents-react/ObjectStatus'
import {
  buildActivityTimeline,
  granularityLabel,
  bucketSpanMs,
  sessionIdsInWindow,
  widgetIdsInWindow,
  actionKeysInWindow,
} from '../lib/activityTimeline'
// Only the overview navigator still uses ECharts (its slider option lives here);
// the detail bars below are a UI5 ColumnChart. Leave this import intact.
import { buildOverviewOption } from './charts/options/activityBars'
import { SAP_BLUE, SAP_GOLD, SAP_SUCCESS } from '../lib/chartColors'
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

// Per wheel-notch zoom factor. Gentle (2%) so it feels smooth and unhurried;
// rapid scrolls coalesce per animation frame so trackpads glide instead of
// jumping. Nudge toward 1.0 to make zoom less sensitive, away to speed it up.
const WHEEL_STEP = 0.95
// How long after the page last scrolled we treat it as "still in motion" and
// leave the wheel to the page instead of zooming the timeline. Keeps a scroll
// that happens to pass over the chart from being hijacked into a zoom; zoom
// only re-engages once the page has come to rest for this long.
const SCROLL_SETTLE_MS = 250
// Pixels of movement before a mouse-down becomes a pan (vs. a bar click).
const DRAG_THRESHOLD = 4

// Clamp [lo,hi] into [min,max], preserving width by sliding at the edges.
function clampToSpanPure(lo, hi, min, max) {
  if (lo < min) { hi += min - lo; lo = min }
  if (hi > max) { lo -= hi - max; hi = max }
  return [Math.max(min, lo), Math.min(max, hi)]
}

// The UI5 ColumnChart (Recharts under the hood) doesn't expose ECharts' pixel
// conversion, so for wheel-zoom / drag-pan we read the plot rectangle straight
// off the rendered SVG to map cursor-x → timestamp. The cartesian grid spans the
// plot area; fall back to the chart surface, then the container. Returns null if
// nothing measurable is mounted yet — every caller null-checks, so it can't crash.
function getPlotRect(container) {
  if (!container) return null
  const el =
    container.querySelector('.recharts-cartesian-grid') ??
    container.querySelector('.recharts-surface') ??
    container
  const rect = el.getBoundingClientRect()
  return rect.width > 0 ? rect : null
}

// Detail column-chart measures — one vertical column per activity metric.
// `accessor` matches BOTH the dataset key and the `hidden` state field, so
// filtering this list by `hidden` drops a series' columns and re-centers the
// rest (same effect the old ECharts legend toggle had). Colors mirror the
// header color key. `hideDataLabel` keeps the count numbers off the columns.
const DETAIL_MEASURES = [
  { accessor: 'sessions', label: 'Sessions', color: SAP_BLUE, hideDataLabel: true },
  { accessor: 'actions', label: 'Actions', color: SAP_GOLD, hideDataLabel: true },
  { accessor: 'widgets', label: 'Widgets active', color: SAP_SUCCESS, hideDataLabel: true },
]

// Header color key ⇄ detail series. `key` doubles as the swatch modifier class
// (swatch-<key>) and the `hidden` state field; toggling it filters DETAIL_MEASURES
// so the series' columns drop out (and the rest re-center).
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
    pushNavSnapshot,
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
  // timelineRange, so there's no update loop. Published live (every frame) so
  // the KPIs and table stay in lock-step with the window as you scroll/drag.
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

  // Detail bars as a UI5 ColumnChart: one row per bucket, one numeric column
  // per metric. `sort`/`index` ride along in each row so a column click can
  // recover the bucket's time window for drill-down.
  const detailDataset = useMemo(() => {
    if (!detail || detail.empty) return []
    const { buckets, series } = detail
    return buckets.map((b, i) => ({
      label: b.label,
      sessions: series.sessions[i] ?? 0,
      actions: series.actions[i] ?? 0,
      widgets: series.widgets[i] ?? 0,
      sort: b.sort,
      index: i,
    }))
  }, [detail])

  // Hidden series drop out of the columns (the rest re-center) — same effect as
  // the old legend toggle, driven by the header color key.
  const detailMeasures = useMemo(
    () => DETAIL_MEASURES.filter((m) => !hidden[m.accessor]),
    [hidden],
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
  // Timestamp (performance.now) of the last page scroll, so the wheel handler
  // can tell an intentional zoom (page at rest, pointer over the chart) from an
  // accidental one (the page is mid-scroll and the cursor just passed over it).
  const lastPageScroll = useRef(0)
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
    // If the page is still scrolling, let this notch scroll the page too rather
    // than zooming the timeline the cursor happened to pass over. The gesture
    // keeps the page moving, which keeps refreshing lastPageScroll, so zoom
    // stays suppressed for the whole scroll; it re-engages once the page rests.
    if (performance.now() - lastPageScroll.current < SCROLL_SETTLE_MS) return
    e.preventDefault()
    // Anchor = the timestamp under the cursor, from its x-position across the
    // plot area (falls back to the window center when geometry isn't ready).
    let anchor = (s.effRange.min + s.effRange.max) / 2
    const plot = getPlotRect(detailWrapRef.current)
    if (plot) {
      const frac = Math.max(0, Math.min(1, (e.clientX - plot.left) / plot.width))
      anchor = s.effRange.min + frac * (s.effRange.max - s.effRange.min)
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
    // ms-per-pixel from the plot width: buckets span the focused window evenly,
    // so the window width over the plot width tracks the cursor 1:1.
    const plot = getPlotRect(detailWrapRef.current)
    const plotW = plot?.width || detailWrapRef.current?.getBoundingClientRect().width || 1
    const msPerPx = (s.effRange.max - s.effRange.min) / plotW
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

  // Track page-scroll activity. Capture phase catches scrolls from any element
  // (inner scroll containers don't bubble scroll to window), so the wheel
  // handler above knows whether the page is currently moving.
  useEffect(() => {
    const onScroll = () => { lastPageScroll.current = performance.now() }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [])

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


  // Click a column → drill into that series' view, scoped to exactly the
  // entities the clicked bucket counted (over its [start, end) window), so the
  // count you land on matches the bar. All three series are actionable: Sessions
  // → sessions active in the window, Widgets → widgets active, Actions → actions
  // that fired in it. We resetTimeline() so the still-active zoom doesn't
  // re-filter the drilled set by a different rule. The shared context filters
  // both seed a fresh table mount and sync an already-mounted one.
  //
  // `hit` is the UI5 ColumnChart onDataPointClick detail:
  // { value, dataKey, payload, dataIndex } — dataKey is the measure accessor
  // ('sessions' | 'actions' | 'widgets'), dataIndex the bucket.
  const onDetailClick = useCallback((hit) => {
    // Ignore the click that fires at the end of a drag-pan.
    if (didPanRef.current) { didPanRef.current = false; return }
    if (!detail || detail.empty) return
    const dataKey = hit?.dataKey
    const dataIndex = hit?.dataIndex
    if (dataKey == null || dataIndex == null) return
    const b = detail.buckets[dataIndex]
    if (!b) return
    const start = b.sort
    const end = detail.buckets[dataIndex + 1]?.sort
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
      // Record the view we're leaving (route + pre-drill filters) so Back can
      // restore it. The clearDrills()/setters above are queued but not yet
      // applied, so the snapshot still reflects the pre-drill state.
      pushNavSnapshot(location.pathname)
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

    if (dataKey === 'sessions') {
      const ids = sessionIdsInWindow(rows, headers, start, end)
      if (ids.length === 0) return
      clearDrills()
      setSessionMultiFilter(ids)
      setSessionFilterWindow(windowLabel)
      finish('session')
    } else if (dataKey === 'widgets') {
      const ids = widgetIdsInWindow(rows, headers, start, end)
      if (ids.length === 0) return
      clearDrills()
      setWidgetMultiFilter(ids)
      setWidgetFilterWindow(windowLabel)
      finish('widget')
    } else if (dataKey === 'actions') {
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
    pushNavSnapshot, location.pathname,
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
                <ObjectStatus
                  className="activity-timeline-viewing-range"
                  state="Information"
                >
                  {effRange ? fmtRange(effRange) : 'Full range'}
                </ObjectStatus>
                {!t.empty && (
                  <ObjectStatus className="activity-timeline-viewing-bucket">
                    {granularityLabel(t.granularity)} buckets
                  </ObjectStatus>
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
                <div className="activity-timeline-detail" ref={detailWrapRef}>
                  <ColumnChart
                    dataset={detailDataset}
                    dimensions={[{ accessor: 'label' }]}
                    measures={detailMeasures}
                    onDataPointClick={(e) => onDetailClick(e.detail)}
                    noLegend
                    noAnimation
                    style={{ height: 300, width: '100%' }}
                    chartConfig={{
                      margin: { top: 8, right: 16, bottom: 8, left: 8 },
                      // Integer count ticks on a linear axis.
                      yAxisConfig: { allowDecimals: false },
                    }}
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
