import { useCallback, useRef, useState } from 'react'
import WidgetSummaryTable from '../../components/WidgetSummaryTable'
import WidgetTimingPanel from '../../components/WidgetTimingPanel'
import { useCsvData } from '../../context/useCsvData'
import { HeaderPortal } from '../../context/HeaderSlot'
import { scrollFast } from '../../lib/scrollFast'

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
  // Wrap scrollFast in rAF so it fires after React has committed the panel
  // to the DOM (on first open the div doesn't exist yet).
  const scrollToPanel = useCallback(() => {
    requestAnimationFrame(() => scrollFast(panelRef.current))
  }, [])

  return (
    <>
      <HeaderPortal>
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
