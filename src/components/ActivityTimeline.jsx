import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { ObjectStatus } from '@ui5/webcomponents-react/ObjectStatus'
import {
  buildActivityTimeline,
  granularityLabel,
  bucketSpanMs,
  sessionIdsInWindow,
  widgetIdsInWindow,
  actionKeysInWindow,
} from '../lib/activityTimeline'
import { buildOverviewOption } from './charts/options/activityBars'
import { buildActivityTimelineOption } from './charts/options/activityTimeline'
import { buildTimeOfDayHourScatterOption } from './charts/options/timeOfDayHourScatter'
import EChartCard from './charts/EChartCard'
import ActionCellDetail from './ActionCellDetail'
import { cellKeyOf } from '../lib/storyActionMatrix'
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
const WHEEL_STEP = 0.99
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
 *
 * `embedded` mode (used by the Action View's "Time-Of-Day-Trend" tab): the
 * panel renders expanded inline as a chart tab rather than a collapsible shell
 * strip — it starts open, hides the collapse toggle, and skips the
 * collapse-on-navigation reset so switching Action View tabs keeps it visible.
 * In this mode clicking the Actions bar (or a bucket's hit-area) drills IN PLACE
 * to a scatter of that bucket's individual action instances (time × duration,
 * log Y) instead of navigating away — and clicking a scatter dot opens the
 * shared ActionCellDetail, mirroring the old Time-Of-Day-Trend panel. The drill
 * props (`matrix`, `byActionKey`, `tierByType`, `scopedRows`) are only used in
 * embedded mode; the shell mounts the timeline without them.
 */
function ActivityTimeline({
  embedded = false,
  matrix = null,
  byActionKey = null,
  tierByType = null,
  scopedRows = null,
  // Aggregated action rows (from ActionView) — used in embedded mode so a
  // scatter dot click always opens ActionCellDetail even when the story×action
  // combination isn't in the matrix (e.g. due to a session-scope mismatch).
  actionRows = null,
}) {
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

  // The timeline starts collapsed on every shell view; the user opens it
  // manually (or it auto-expands when a "busiest period" card focuses it). In
  // embedded (tab) mode it starts expanded — it IS the tab's content.
  const [collapsed, setCollapsed] = useState(!embedded)
  // Which /summary/<view> we're on drives the collapse-on-navigation reset.
  const view = location.pathname.split('/').pop()
  // When you move to another summary view, re-collapse the panel — the timeline
  // defaults to closed on every view; manual opens then persist until the next
  // navigation. In embedded (tab) mode we keep it expanded and don't reset on
  // navigation — the Action View tab owns its visibility.
  useEffect(() => {
    if (embedded) return
    setCollapsed(true)
  }, [view, embedded])

  // Default legend visibility per view. Determines which series are shown on
  // first render. User can toggle others on via the legend; selections persist
  // through zoom/pan because we track them in state and inject them back into
  // every option rebuild (preventing notMerge from wiping ECharts' internal state).
  const defaultLegendSelected = useMemo(() => {
    // embedded = Time-Of-Day Trend tab in Action View → show Actions + p50/p90/Spread only
    if (embedded) {
      return { Sessions: false, Actions: true, Widgets: false, p50: true, p90: true, Spread: true }
    }
    if (view === 'session') {
      return { Sessions: true, Actions: false, Widgets: false, p50: true, p90: true, Spread: true }
    }
    if (view === 'widget') {
      return { Sessions: false, Actions: false, Widgets: true, p50: true, p90: true, Spread: true }
    }
    // raw / summary / fallback → show all
    return { Sessions: true, Actions: true, Widgets: true, p50: true, p90: true, Spread: true }
  }, [embedded, view])

  // Tracks user legend toggles so they survive option rebuilds (zoom/pan).
  // Seeded from defaultLegendSelected; resets to defaults when the view changes.
  const [legendSelected, setLegendSelected] = useState(defaultLegendSelected)
  useEffect(() => {
    setLegendSelected(defaultLegendSelected)
  }, [defaultLegendSelected])

  // Embedded drill-down (Time-Of-Day-Trend tab only). Level 1: the bucket key
  // whose action scatter is open below the chart (null = none). Level 2: the
  // action instance pinned from a scatter dot → its ActionCellDetail. Keyed by
  // bucket KEY (not index) so a wheel-zoom re-bucket that drops the bucket
  // closes the drill rather than pointing at the wrong window.
  const [scatterKey, setScatterKey] = useState(null)
  const [pinned, setPinned] = useState(null)
  const scatterRef = useRef(null)
  const cellDetailRef = useRef(null)
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

  // Detail chart built from the bucketed data with all axes and percentile lines.
  // legendSelected is injected on every rebuild so zoom/pan (which triggers a
  // full notMerge option replacement) never wipes the user's series choices.
  const detailOption = useMemo(() => {
    if (!detail || detail.empty) return { series: [] }
    return buildActivityTimelineOption({
      buckets: detail.buckets,
      series: detail.series,
      actionDurations: detail.actionDurations,
      legendSelected,
    })
  }, [detail, legendSelected])

  // ——— Embedded drill-down: bucket → action scatter → instance detail ———
  // Resolve the drilled bucket by KEY against the current buckets (a re-bucket
  // from wheel-zoom may have dropped it → index -1 → scatter closes).
  const scatterIdx = useMemo(() => {
    if (!scatterKey || !detail || detail.empty) return -1
    return detail.buckets.findIndex((b) => b.key === scatterKey)
  }, [scatterKey, detail])
  const scatterBucket = scatterIdx >= 0 ? detail.buckets[scatterIdx] : null

  // The drilled bucket's individual action instances, tagged flagged=true when
  // the anomaly detector flagged that run — the scatter pulls those into its own
  // red-triangle series. byActionKey is only supplied in embedded mode.
  const scatterInstances = useMemo(() => {
    if (!scatterBucket) return []
    const raw = detail.actionDurations?.[scatterIdx]?.instances ?? []
    return raw.map((i) => ({
      ...i,
      flagged: (byActionKey?.get(i.actionKey)?.length ?? 0) > 0,
    }))
  }, [scatterBucket, scatterIdx, detail, byActionKey])

  const scatterOption = useMemo(() => {
    if (!scatterBucket) return null
    return buildTimeOfDayHourScatterOption({
      instances: scatterInstances,
      bucketLabel: scatterBucket.label,
    })
  }, [scatterBucket, scatterInstances])

  // Close the scatter if its bucket leaves the set (scope/zoom change), and drop
  // the pinned instance if the matrix no longer holds its story×action.
  useEffect(() => {
    if (scatterKey && detail && !detail.empty && !detail.buckets.some((b) => b.key === scatterKey)) {
      setScatterKey(null)
      setPinned(null)
    }
  }, [detail, scatterKey])
  // Close the pinned ActionCellDetail when its action is no longer in scope:
  // check actionRows first (most precise), fall back to the matrix when
  // actionRows isn't supplied (shell / non-embedded usage).
  useEffect(() => {
    if (!pinned) return
    if (actionRows?.length > 0) {
      if (!actionRows.some((r) => r.action_name === pinned.action)) setPinned(null)
    } else if (matrix?.cells && !matrix.cells.has(cellKeyOf(pinned.story, pinned.action))) {
      setPinned(null)
    }
  }, [matrix, pinned, actionRows])

  // Click a scatter dot → toggle its ActionCellDetail (clicking the same dot
  // closes it). Only scatter points carry the action/story/timestamp payload.
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

  // Derive the ActionCellDetail cell. Prefer the precomputed matrix cell (it's
  // already story×action scoped with correct field names). Fall back to building
  // one from actionRows filtered by action name — this makes the detail open
  // reliably even when the scatter shows instances outside the current scope
  // (e.g. global rows vs. session-filtered matrix).
  const pinnedCell = useMemo(() => {
    if (!pinned) return null
    // 1) Matrix cell (story × action — exact match)
    const fromMatrix = matrix?.cells?.get(cellKeyOf(pinned.story, pinned.action)) ?? null
    if (fromMatrix) return fromMatrix
    // 2) Build from aggregated action rows (action name only, cross-story)
    if (!actionRows?.length) return null
    const instances = actionRows.filter((r) => r.action_name === pinned.action)
    if (!instances.length) return null
    const nums = instances
      .map((r) => r.action_duration)
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
    return {
      duration: nums.length ? Math.max(...nums) : null,
      count: instances.length,
      instances,
    }
  }, [pinned, matrix, actionRows])

  // Scroll each drill level into view when it opens / retargets (respects
  // reduced-motion). Keyed so it fires on open + retarget but not on close.
  useEffect(() => {
    if (!scatterBucket || !scatterRef.current) return
    smoothScroll(scatterRef.current)
  }, [scatterKey, scatterBucket])
  useEffect(() => {
    if (!pinned || !cellDetailRef.current) return
    smoothScroll(cellDetailRef.current)
  }, [pinned])


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


  // ECharts click handler for drill-down by bucket
  const onDetailClick = useCallback((params) => {
    if (!detail || detail.empty) return

    let bucketIdx = null
    if (params.componentType === 'markArea') {
      bucketIdx = Number(params?.name)
    } else if (typeof params?.dataIndex === 'number') {
      bucketIdx = params.dataIndex
    }

    if (bucketIdx == null) return
    const b = detail.buckets[bucketIdx]
    if (!b) return

    // Embedded (Time-Of-Day-Trend tab): an Actions click — a direct Actions bar
    // click or the bucket-wide hit-area markArea — drills to the in-place
    // scatter below rather than navigating to the Action view. Sessions/Widgets
    // bars still cross-navigate (handled below).
    if (embedded && (params.componentType === 'markArea' || params?.seriesName === 'Actions')) {
      setScatterKey((prev) => (prev === b.key ? null : b.key))
      setPinned(null)
      return
    }

    const start = b.sort
    const end = detail.buckets[bucketIdx + 1]?.sort
      ?? b.sort + bucketSpanMs(detail.granularity)
    const windowLabel = fmtRange({ min: start, max: end })

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
      pushNavSnapshot(location.pathname)
      resetTimeline()
      navigate(`/summary/${view}`)
      setCollapsed(true)
      requestAnimationFrame(() => {
        document
          .getElementById('summary-view-top')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }

    const seriesName = params?.seriesName
    if (seriesName === 'Sessions') {
      const ids = sessionIdsInWindow(rows, headers, start, end)
      if (ids.length === 0) return
      clearDrills()
      setSessionMultiFilter(ids)
      setSessionFilterWindow(windowLabel)
      finish('session')
    } else if (seriesName === 'Widgets') {
      const ids = widgetIdsInWindow(rows, headers, start, end)
      if (ids.length === 0) return
      clearDrills()
      setWidgetMultiFilter(ids)
      setWidgetFilterWindow(windowLabel)
      finish('widget')
    } else if (seriesName === 'Actions') {
      const keys = actionKeysInWindow(rows, headers, start, end)
      if (keys.length === 0) return
      clearDrills()
      setActionInvocationFilter(keys)
      setActionFilterWindow(windowLabel)
      finish('action')
    }
  }, [
    detail, rows, headers, navigate, resetTimeline, embedded,
    setSessionFilter, setActionFilter, setActionMultiFilter, setSessionMultiFilter,
    setSessionFilterWindow, setWidgetMultiFilter, setActionInvocationFilter,
    setWidgetFilterWindow, setActionFilterWindow,
    pushNavSnapshot, location.pathname,
  ])

  // Persist legend toggles through zoom/pan rebuilds. ECharts fires
  // legendselectchanged with the full `selected` map on every click, so we
  // just replace our state with the new snapshot.
  const onLegendSelectChanged = useCallback((params) => {
    if (params?.selected) setLegendSelected({ ...params.selected })
  }, [])

  if (!hasData || !overview) return null

  const zoomed = isZoomed
  const t = detail ?? overview

  return (
    <section
      className={`activity-timeline${embedded ? ' is-embedded' : ''}`}
      ref={rootRef}
    >
      <header className="activity-timeline-header">
        {embedded ? (
          <span className="activity-timeline-title">Activity Timeline</span>
        ) : (
          <button
            type="button"
            className="activity-timeline-toggle"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            <span className="activity-timeline-title">Activity Timeline</span>
          </button>
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
                  <ReactECharts
                    option={detailOption}
                    style={{ height: 400, width: '100%' }}
                    notMerge
                    lazyUpdate
                    onEvents={{ click: onDetailClick, legendselectchanged: onLegendSelectChanged }}
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

      {embedded && scatterBucket && scatterOption && (
        <div className="activity-timeline-drill" ref={scatterRef}>
          <EChartCard
            title={`Actions in ${scatterBucket.fullLabel ?? scatterBucket.label}`}
            subtitle={`${scatterInstances.length} action${scatterInstances.length === 1 ? '' : 's'} · over time × duration · log axis · click a dot for detail`}
            option={scatterOption}
            height={360}
            onRemove={() => { setScatterKey(null); setPinned(null) }}
            onEvents={onScatterEvents}
          />
        </div>
      )}

      {embedded && pinned && pinnedCell && (
        <ActionCellDetail
          story={pinned.story}
          action={pinned.action}
          cell={pinnedCell}
          rows={scopedRows ?? rows}
          headers={headers}
          byActionKey={byActionKey}
          tierByType={tierByType}
          initialInstanceTs={pinned.timestamp}
          onClose={() => setPinned(null)}
          detailRef={cellDetailRef}
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

// Compact "Jun 15, 14:30 → Jul 2, 09:00" window label.
function fmtRange(range) {
  return formatTimeRangeLabel(range.min, range.max)
}

export default ActivityTimeline
