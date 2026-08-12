import { useEffect, useRef, useState } from 'react'
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

  // Scroll the panel into view when a widget is first selected. Keyed on the
  // open boolean only, NOT the selection identity, so stepping through widgets
  // with the picker/arrows doesn't yank the page each time. Respects
  // reduced-motion.
  const panelRef = useRef(null)
  useEffect(() => {
    if (!panelOpen) return
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    panelRef.current?.scrollIntoView({ behavior, block: 'start' })
  }, [panelOpen])

  return (
    <>
      <HeaderPortal>
        <h2 className="view-heading">Widget View</h2>
      </HeaderPortal>
      <WidgetSummaryTable rows={rows} headers={headers} onTimingChange={setTimingSel} />

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
