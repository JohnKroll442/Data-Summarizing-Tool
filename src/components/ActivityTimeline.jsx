import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import MultiFilterMenu from './MultiFilterMenu'
import {
  buildActivityTimeline,
  listDimensionFields,
  dimensionOptions,
  granularityLabel,
  bucketSpanMs,
  chooseGranularity,
  INTERVAL_OPTIONS,
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
 *     to a 5-minute (or 1-minute) view. The interval dropdown can force a size.
 *
 * State is local: the shell doesn't unmount on tab switch, so selections
 * persist across views; they reset on file swap.
 */
function ActivityTimeline() {
  const { rows, headers, hasData, activeFileId } = useCsvData()

  const [collapsed, setCollapsed] = useState(false)
  const [interval, setInterval] = useState('auto')
  // Focused window (what the detail shows) in epoch ms; null = full data span.
  const [range, setRange] = useState(null)
  // Navigator's visible context range in epoch ms; null = full data span. The
  // focus sits inside this; keeping view ≈ focus × CONTEXT_FACTOR is what keeps
  // the drag box a usable size while the axis labels zoom down to minutes.
  const [viewRange, setViewRange] = useState(null)
  const [primaryFilter, setPrimaryFilter] = useState({ field: '', values: [] })
  const [secondaryFilter, setSecondaryFilter] = useState({ field: '', values: [] })

  const fields = useMemo(
    () => (hasData ? listDimensionFields(rows, headers) : []),
    [rows, headers, hasData],
  )

  // Reset everything on file swap (shell persists across tabs).
  useEffect(() => {
    setInterval('auto')
    setRange(null)
    setViewRange(null)
    setPrimaryFilter({ field: '', values: [] })
    setSecondaryFilter({ field: '', values: [] })
  }, [activeFileId])

  // Overview: full data span, auto interval — gives the strip its context and
  // the true min/max the window maps onto.
  const overview = useMemo(
    () => (hasData ? buildActivityTimeline(rows, headers, { primaryFilter, secondaryFilter }) : null),
    [rows, headers, hasData, primaryFilter, secondaryFilter],
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

  // Zoom focus in/out around its center (factor <1 = in, >1 = out) and re-frame
  // the navigator context to ≈ CONTEXT_FACTOR × focus, so the drag box resets to
  // a comfortable size and the nav labels zoom down toward minutes. Also snap
  // the bucket size to whatever fits the new focus, so the "Bucket size" shown
  // matches the bars actually drawn.
  const zoomBy = useCallback((factor) => {
    if (!span) return
    const fullSpan = spanMax - spanMin
    const fMin = effRange ? effRange.min : spanMin
    const fMax = effRange ? effRange.max : spanMax
    const center = (fMin + fMax) / 2
    const fw = Math.min(fullSpan, Math.max(MIN_WINDOW_MS, (fMax - fMin) * factor))
    const vw = Math.min(fullSpan, fw * CONTEXT_FACTOR)
    const [flo, fhi] = clampToSpan(center - fw / 2, center + fw / 2)
    const [vlo, vhi] = clampToSpan(center - vw / 2, center + vw / 2)
    setRange({ min: flo, max: fhi })
    setViewRange({ min: vlo, max: vhi })
    setInterval(chooseGranularity(new Date(flo), new Date(fhi)))
  }, [span, effRange, spanMin, spanMax, clampToSpan])

  // Slide the focus left/right by ~80% of its width and re-frame the context
  // around it, so dragging/paging keeps moving into new periods (never blocked).
  const panBy = useCallback((dir) => {
    if (!span || !effRange) return
    const width = effRange.max - effRange.min
    const shift = width * 0.8 * dir
    const [flo, fhi] = clampToSpan(effRange.min + shift, effRange.max + shift)
    const center = (flo + fhi) / 2
    const vw = Math.min(spanMax - spanMin, (fhi - flo) * CONTEXT_FACTOR)
    const [vlo, vhi] = clampToSpan(center - vw / 2, center + vw / 2)
    setRange({ min: flo, max: fhi })
    setViewRange({ min: vlo, max: vhi })
  }, [span, effRange, spanMin, spanMax, clampToSpan])

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

  // Detail: only the focused window, re-bucketed to fit.
  const detail = useMemo(
    () =>
      hasData && effRange
        ? buildActivityTimeline(rows, headers, { interval, range: effRange, primaryFilter, secondaryFilter })
        : overview,
    [rows, headers, hasData, interval, effRange, primaryFilter, secondaryFilter, overview],
  )

  // Navigator bars are built over the CONTEXT range (not the full span), so
  // zooming in makes the strip show finer buckets + minute-level time labels.
  const nav = useMemo(
    () =>
      hasData && effView
        ? buildActivityTimeline(rows, headers, { range: effView, primaryFilter, secondaryFilter })
        : overview,
    [rows, headers, hasData, effView, primaryFilter, secondaryFilter, overview],
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
    () => (detail && !detail.empty ? buildActivityBarsOption(detail.buckets, detail.series) : { series: [] }),
    [detail],
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
      </header>

      {!collapsed && (
        <div className="activity-timeline-body">
          <aside className="activity-timeline-rail">
            <DimensionFilter
              heading="Primary dimension"
              fields={fields}
              rows={rows}
              value={primaryFilter}
              onChange={setPrimaryFilter}
            />
            <DimensionFilter
              heading="Secondary dimension"
              fields={fields}
              rows={rows}
              value={secondaryFilter}
              onChange={setSecondaryFilter}
            />

            <label className="activity-timeline-gran">
              <span>Bucket size</span>
              <select value={interval} onChange={(e) => setInterval(e.target.value)}>
                <option value="auto">Auto (fit window)</option>
                {INTERVAL_OPTIONS.map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
            </label>

            <div className="activity-timeline-zoom">
              <span>Navigate</span>
              <div className="activity-timeline-zoom-btns">
                <button type="button" onClick={() => panBy(-1)} title="Move window earlier">◀</button>
                <button type="button" onClick={() => zoomBy(0.5)} title="Zoom in (narrow the window)">＋</button>
                <button type="button" onClick={() => zoomBy(2)} title="Zoom out (widen the window)">－</button>
                <button type="button" onClick={() => panBy(1)} title="Move window later">▶</button>
              </div>
            </div>
            {zoomed && (
              <button
                type="button"
                className="activity-timeline-reset"
                onClick={() => { setRange(null); setViewRange(null); setInterval('auto') }}
              >
                Reset to full range
              </button>
            )}
          </aside>

          <div className="activity-timeline-charts">
            {overview.empty ? (
              <div className="activity-timeline-empty">
                No timestamps to plot. This file has no parseable time column,
                or the current filters removed every row.
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

function DimensionFilter({ heading, fields, rows, value, onChange }) {
  const field = fields.find((f) => f.id === value.field)
  const options = useMemo(
    () => (field ? dimensionOptions(rows, field.header) : []),
    [rows, field],
  )

  return (
    <div className="activity-timeline-dim">
      <span className="activity-timeline-dim-heading">{heading}</span>
      <select
        className="activity-timeline-dim-field"
        value={value.field}
        onChange={(e) => onChange({ field: e.target.value, values: [] })}
      >
        <option value="">None</option>
        {fields.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
      </select>
      {field && (
        <MultiFilterMenu
          label={field.label}
          options={options}
          selected={value.values}
          onChange={(values) => onChange({ ...value, values })}
        />
      )}
    </div>
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
