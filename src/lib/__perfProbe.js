/* TEMPORARY DEBUG PROBE — remove before commit.
 * Distinguishes the candidate root causes for the "hover buffers/shakes only
 * after opening+closing the Action Waterfall" report:
 *   [instances]  live ECharts instances still mounted (leak if >0 after close)
 *   [rAF/idle]   animation frames scheduled while the mouse is idle (runaway loop)
 *   [RO]         ResizeObserver callbacks/sec (layout thrash)
 *   [jank]       long frames (>50ms) and whether they only happen while moving
 */
;(() => {
  if (typeof window === 'undefined') return

  // --- live ECharts instance count (echarts tags its container with this attr) ---
  const liveCharts = () => document.querySelectorAll('[_echarts_instance_]').length

  // --- count rAF callbacks so we can see a runaway render loop while idle ---
  let rafCount = 0
  const realRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) =>
    realRaf((t) => { rafCount++; return cb(t) })

  // --- count ResizeObserver callbacks (size-sensor / UI5 auto-layout) ---
  let roCount = 0
  const RealRO = window.ResizeObserver
  if (RealRO) {
    window.ResizeObserver = class extends RealRO {
      constructor(cb) {
        super((...a) => { roCount += a[0]?.length || 1; return cb(...a) })
      }
    }
  }

  // --- track mouse idle so we can tell "idle loop" from "cost per hover" ---
  let lastMove = 0
  window.addEventListener('mousemove', () => { lastMove = performance.now() }, true)

  // --- long-frame (jank) detector ---
  let jankMoving = 0
  let jankIdle = 0
  let prev = performance.now()
  const frame = (now) => {
    const dt = now - prev
    prev = now
    if (dt > 50) {
      const moving = now - lastMove < 120
      if (moving) jankMoving++
      else jankIdle++
    }
    realRaf(frame)
  }
  realRaf(frame)

  // --- 1s report ---
  setInterval(() => {
    const idleMs = Math.round(performance.now() - lastMove)
    // eslint-disable-next-line no-console
    console.log(
      `[probe] charts=${liveCharts()} rAF/s=${rafCount} RO/s=${roCount} ` +
      `jank(moving=${jankMoving}, idle=${jankIdle}) mouseIdle=${idleMs}ms`
    )
    rafCount = 0
    roCount = 0
    jankMoving = 0
    jankIdle = 0
  }, 1000)

  // eslint-disable-next-line no-console
  console.log('[probe] active — watch charts= after you close the waterfall, and rAF/s while idle')
})()
