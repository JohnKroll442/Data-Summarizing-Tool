import { useCallback, useRef, useState } from 'react'
import WidgetSummaryTable from '../../components/WidgetSummaryTable'
import WidgetTimingPanel from '../../components/WidgetTimingPanel'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'

/**
 * WidgetView — one row per widget table at the top, with the per-widget timing
 * chart rendering inline below when a widget is selected. Use Raw Data View for
 * the underlying detail rows.
 */
function WidgetView() {
  const { rows, headers } = useCsvData()

  // The per-widget timing chart renders inline in the chart region (no popup).
  // Its selection state lives in the table (which knows the filtered + sorted
  // widget list); the table publishes it up here via onTimingChange. null =
  // nothing selected → no panel.
  const [timingSel, setTimingSel] = useState(null)
  const panelOpen = timingSel != null

  // Scroll the timing panel into view whenever the user clicks a widget name.
  // Uses requestAnimationFrame so the scroll fires after React has committed the
  // panel to the DOM (on first open the div doesn't exist yet). Arrow/picker
  // navigation inside the panel does NOT call this, so stepping through widgets
  // with the arrows won't yank the viewport.
  //
  // Uses a 200 ms ease-out animation instead of the browser's native
  // scrollIntoView({ behavior: 'smooth' }) which can take 400–700 ms. The
  // custom loop gives a snappy, intentional feel while still being smooth.
  // Falls back to an instant jump for users who prefer reduced motion.
  const panelRef = useRef(null)
  const scrollToPanel = useCallback(() => {
    requestAnimationFrame(() => {
      if (!panelRef.current) return

      // Instant jump for reduced-motion preference.
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        panelRef.current.scrollIntoView({ behavior: 'auto', block: 'start' })
        return
      }

      // Compute the absolute Y target so the panel top aligns with the
      // viewport top (same as block: 'start'), with a small 12 px breathing gap.
      const targetY =
        panelRef.current.getBoundingClientRect().top + window.scrollY - 12

      const startY    = window.scrollY
      const distance  = targetY - startY
      const duration  = 200 // ms — fast enough to feel instant, smooth enough to orient
      const startTime = performance.now()

      // Ease-out cubic: fast start, gentle deceleration at the end.
      const easeOut = (t) => 1 - Math.pow(1 - t, 3)

      const step = (now) => {
        const progress = Math.min((now - startTime) / duration, 1)
        window.scrollTo(0, startY + distance * easeOut(progress))
        if (progress < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  }, [])

  return (
    <>
      <HeaderPortal>
        <h2 className="view-heading">Widget View</h2>
      </HeaderPortal>
      <WidgetSummaryTable rows={rows} headers={headers} onTimingChange={setTimingSel} onScrollToChart={scrollToPanel} />

      {timingSel && (
        <div ref={panelRef}>
          <WidgetTimingPanel
            open
            widgetName={timingSel.widgetName}
            widgetRows={timingSel.widgetRows}
            actionRows={timingSel.actionRows}
            items={timingSel.items}
            index={timingSel.index}
            onIndexChange={timingSel.onIndexChange}
            onClose={timingSel.onClose}
          />
        </div>
      )}
    </>
  )
}

export default WidgetView
