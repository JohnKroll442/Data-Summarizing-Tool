import { useCallback, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { Card, CardHeader } from '@ui5/webcomponents-react'
import { isAnomalyFlagged } from '../lib/anomalyDetect'
import { buildStoryAnomalyOption } from './charts/options/storyAnomalyBar'
import { buildActionBoxplotOption } from './charts/options/actionBoxplot'
import { buildActionParetoOption }  from './charts/options/actionPareto'
import './ActionChartsPanel.css'

// CardHeader height in the SAP Horizon theme (title row + top/bottom borders).
// Used to compute how much vertical space the chart body gets inside the card.
const CARD_HEADER_HEIGHT = 52

const DEFAULT_TOP_N        = 10
const DEFAULT_BOX_TOP_N    = 10
const DEFAULT_PARETO_TOP_N = 6

/**
 * Initial layout for every chart card on the canvas.
 * Each entry: { x, y, w, h, minW, minH, zIndex }
 * x/y = px offset from the canvas top-left corner.
 * w/h = px dimensions of the card.
 *
 * Two-column arrangement (col-1 = x:16, col-2 = x:860):
 *   Top row:    Story Anomaly Bar  |  Action Duration Box Plot
 *   Bottom row: Action Pareto      |  (open canvas)
 *
 * Cards are freely draggable / resizable — this is just the starting position.
 */
const INITIAL_LAYOUT = {
  'story-anomaly': { x: 16,  y: 16,  w: 820, h: 460, minW: 320, minH: 220, zIndex: 1 },
  'action-boxplot':{ x: 860, y: 16,  w: 820, h: 500, minW: 320, minH: 280, zIndex: 1 },
  'action-pareto': { x: 16,  y: 492, w: 820, h: 480, minW: 320, minH: 260, zIndex: 1 },
}

// Global z-index counter so the last-touched card always sits on top.
let Z = 10

// ─── ChartCard ────────────────────────────────────────────────────────────────
//
// A freely positionable, resizable card. No external drag/resize library needed.
//
// Drag:   grab the header bar → move card anywhere on the canvas.
// Resize: grab the ◢ handle   → resize from the bottom-right corner.
//
function ChartCard({ id, bounds, title, onBoundsChange, headerSlot, children, canvasRef }) {
  const dragOrigin   = useRef(null)
  const resizeOrigin = useRef(null)

  // ── Drag ────────────────────────────────────────────────────────────────
  const handleDragDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    onBoundsChange(id, { zIndex: ++Z })

    dragOrigin.current = {
      mouseX: e.clientX, mouseY: e.clientY,
      cardX:  bounds.x,  cardY:  bounds.y,
    }

    const onMove = (me) => {
      const o = dragOrigin.current
      if (!o) return
      // Clamp x so the card can never be dragged fully off either edge.
      // The card must keep at least 80 px visible on both the left and right.
      const canvasW  = canvasRef?.current?.offsetWidth ?? Infinity
      const minX     = -(bounds.w - 80)           // can go left but not vanish
      const maxX     = canvasW - 80               // can go right but not vanish
      onBoundsChange(id, {
        x: Math.min(maxX, Math.max(minX, o.cardX + (me.clientX - o.mouseX))),
        y: Math.max(0, o.cardY + (me.clientY - o.mouseY)),
      })
    }
    const onUp = () => {
      dragOrigin.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
  }, [id, bounds.x, bounds.y, onBoundsChange])

  // ── Resize (bottom-right corner) ───────────────────────────────────────
  const handleResizeDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    onBoundsChange(id, { zIndex: ++Z })

    resizeOrigin.current = {
      mouseX: e.clientX, mouseY: e.clientY,
      w: bounds.w, h: bounds.h,
    }

    const onMove = (me) => {
      const o = resizeOrigin.current
      if (!o) return
      onBoundsChange(id, {
        w: Math.max(bounds.minW, o.w + (me.clientX - o.mouseX)),
        h: Math.max(bounds.minH, o.h + (me.clientY - o.mouseY)),
      })
    }
    const onUp = () => {
      resizeOrigin.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
  }, [id, bounds.w, bounds.h, bounds.minW, bounds.minH, onBoundsChange])

  // Chart content height = total card height minus the UI5 CardHeader height.
  // This mirrors how EChartCard passes a fixed pixel height to ReactECharts
  // rather than relying on height:100% through the web-component shadow DOM.
  const chartHeight = Math.max(80, bounds.h - CARD_HEADER_HEIGHT)

  return (
    <div
      className="chart-widget-positioner"
      style={{
        position: 'absolute',
        left: bounds.x, top: bounds.y,
        width: bounds.w, height: bounds.h,
        zIndex: bounds.zIndex,
      }}
      onPointerDown={() => onBoundsChange(id, { zIndex: ++Z })}
    >
      <Card
        className="chart-widget-card"
        header={
          <CardHeader
            titleText={title}
            className="chart-widget-card__header"
            // The entire CardHeader is the drag surface.
            onPointerDown={handleDragDown}
            style={{ cursor: 'grab' }}
            action={
              // Wrap controls in a div whose pointer events stop at this boundary
              // so clicking/typing in the Top-N input never starts a drag.
              headerSlot
                ? <div onPointerDown={(e) => e.stopPropagation()}>{headerSlot}</div>
                : undefined
            }
          />
        }
      >
        {children
          ? <div className="chart-widget__body" style={{ height: chartHeight }}>{children}</div>
          : null
        }
      </Card>

      {/* Resize grip — sits on top of the card's bottom-right corner */}
      <div
        className="chart-widget__resize-handle"
        onPointerDown={handleResizeDown}
        title="Drag to resize"
      />
    </div>
  )
}

// ─── ActionChartsPanel ────────────────────────────────────────────────────────
//
// The "Charts" tab panel for the Action view.
// No external dependencies — uses pointer events for drag and resize.
//
function ActionChartsPanel({ aggRows, byActionKey }) {
  const [topN,          setTopN]          = useState(DEFAULT_TOP_N)
  // String states let the user clear the field before typing a new number.
  // The numeric value used by the chart is derived below via parseInt.
  const [boxTopNStr,    setBoxTopNStr]    = useState(String(DEFAULT_BOX_TOP_N))
  const [paretoTopNStr, setParetoTopNStr] = useState(String(DEFAULT_PARETO_TOP_N))
  const [layout,        setLayout]        = useState(INITIAL_LAYOUT)

  // Derived numeric values — fall back to the defaults when the field is empty
  const boxTopN    = Math.max(3,  parseInt(boxTopNStr,    10) || DEFAULT_BOX_TOP_N)
  const paretoTopN = Math.max(3,  parseInt(paretoTopNStr, 10) || DEFAULT_PARETO_TOP_N)
  const canvasRef = useRef(null)

  const updateBounds = useCallback((id, patch) => {
    setLayout((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }, [])

  // ── Story anomaly data ─────────────────────────────────────────────────
  const storyData = useMemo(() => {
    if (!aggRows?.length) return []
    const map = new Map()
    for (const row of aggRows) {
      const story = row.story_name || '(unknown)'
      if (!map.has(story)) map.set(story, { total: 0, anomalies: 0 })
      const entry = map.get(story)
      entry.total++
      const key = `${row.action_name}::${row._action_timestamp ?? ''}`
      if (isAnomalyFlagged(byActionKey?.get(key))) entry.anomalies++
    }
    return Array.from(map.entries())
      .map(([story, d]) => ({
        story, ...d,
        anomalyRatio: d.total > 0
          ? parseFloat(((d.anomalies / d.total) * 100).toFixed(1))
          : 0,
      }))
      .sort((a, b) => b.anomalies - a.anomalies)
      .slice(0, topN)
  }, [aggRows, byActionKey, topN])

  const anomalyBarOption = useMemo(
    () => buildStoryAnomalyOption(storyData),
    [storyData],
  )

  // ── Box plot: action duration distribution ─────────────────────────────
  const boxplotOption = useMemo(
    () => buildActionBoxplotOption(aggRows, { topN: boxTopN }),
    [aggRows, boxTopN],
  )

  // ── Pareto: which actions own the most total time ─────────────────────
  const paretoOption = useMemo(
    () => buildActionParetoOption(aggRows, { topN: paretoTopN }),
    [aggRows, paretoTopN],
  )

  // Keep the canvas at least 80 px below the lowest card edge so the
  // bottom-right resize handle is always reachable — even when a card fills
  // most of the viewport.
  const canvasHeight = Math.max(
    560,
    ...Object.values(layout).map((c) => c.y + c.h + 80),
  )

  return (
    <section className="action-view-fullscreen charts-panel" aria-label="Charts">
      <div ref={canvasRef} className="charts-canvas" style={{ height: canvasHeight }}>

        {/* ── Story Anomaly Bar ───────────────────────────────────────── */}
        <ChartCard
          id="story-anomaly"
          bounds={layout['story-anomaly']}
          title="Stories by Anomaly Count"
          onBoundsChange={updateBounds}
          canvasRef={canvasRef}
          headerSlot={
            <div className="chart-widget__controls">
              <label className="chart-widget__label" htmlFor="charts-top-n">Top</label>
              <input
                id="charts-top-n"
                type="number"
                className="chart-widget__num-input"
                value={topN}
                min={1}
                max={50}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (Number.isFinite(v) && v > 0) setTopN(v)
                }}
              />
              <span className="chart-widget__label">stories</span>
            </div>
          }
        >
          {storyData.length === 0 ? (
            <div className="chart-widget__empty">
              No story data available for the current scope.
            </div>
          ) : (
            <ReactECharts
              option={anomalyBarOption}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge
            />
          )}
        </ChartCard>

        {/* ── Action Duration Box Plot ────────────────────────────────── */}
        <ChartCard
          id="action-boxplot"
          bounds={layout['action-boxplot']}
          title="Action Duration Distribution (Box Plot)"
          onBoundsChange={updateBounds}
          canvasRef={canvasRef}
          headerSlot={
            <div className="chart-widget__controls">
              <label className="chart-widget__label" htmlFor="boxplot-top-n">Top</label>
              <input
                id="boxplot-top-n"
                type="number"
                className="chart-widget__num-input"
                value={boxTopNStr}
                min={3}
                max={50}
                onChange={(e) => setBoxTopNStr(e.target.value)}
                onBlur={() => {
                  const v = parseInt(boxTopNStr, 10)
                  if (!Number.isFinite(v) || v < 3) setBoxTopNStr(String(DEFAULT_BOX_TOP_N))
                }}
              />
              <span className="chart-widget__label">actions</span>
            </div>
          }
        >
          {!boxplotOption?.series?.length ? (
            <div className="chart-widget__empty">
              Not enough data — each action needs at least 3 recorded instances.
            </div>
          ) : (
            <ReactECharts
              option={boxplotOption}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge
            />
          )}
        </ChartCard>

        {/* ── Action Pareto ───────────────────────────────────────────── */}
        <ChartCard
          id="action-pareto"
          bounds={layout['action-pareto']}
          title="Action Duration Pareto"
          onBoundsChange={updateBounds}
          canvasRef={canvasRef}
          headerSlot={
            <div className="chart-widget__controls">
              <label className="chart-widget__label" htmlFor="pareto-top-n">Top</label>
              <input
                id="pareto-top-n"
                type="number"
                className="chart-widget__num-input"
                value={paretoTopNStr}
                min={3}
                max={50}
                onChange={(e) => setParetoTopNStr(e.target.value)}
                onBlur={() => {
                  const v = parseInt(paretoTopNStr, 10)
                  if (!Number.isFinite(v) || v < 3) setParetoTopNStr(String(DEFAULT_PARETO_TOP_N))
                }}
              />
              <span className="chart-widget__label">actions</span>
            </div>
          }
        >
          {!paretoOption?.series?.length ? (
            <div className="chart-widget__empty">
              No action duration data available for the current scope.
            </div>
          ) : (
            <ReactECharts
              option={paretoOption}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge
            />
          )}
        </ChartCard>

      </div>
    </section>
  )
}

export default ActionChartsPanel
