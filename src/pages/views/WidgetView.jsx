import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import WidgetSummaryTable from '../../components/WidgetSummaryTable'
import WidgetTimingPanel from '../../components/WidgetTimingPanel'
import ActivityTimeline from '../../components/ActivityTimeline'
import ActionViewSwitcher from '../../components/ActionViewSwitcher'
import { useCsvData } from '../../context/useCsvData'
import { scrollFast } from '../../lib/scrollFast'

// Two top-level sub-tabs, mirroring the Action View and Session View patterns.
// "Data Table" is the default; "Time-of-Day Trend" shows the shared
// ActivityTimeline in its fully-expanded inline form.
const WIDGET_VIEW_TABS = [
  { key: 'table',     label: 'Data Table' },
  { key: 'timeOfDay', label: 'Time-of-Day Trend' },
]

/**
 * WidgetView — one row per widget table at the top, with the per-widget timing
 * chart rendering inline below when a widget is selected, all behind a two-tab
 * switcher that matches the Action View / Session View pattern.
 *
 * Default tab: "Data Table" (WidgetSummaryTable + WidgetTimingPanel, same as
 *   before). Use Raw Data View for the underlying detail rows.
 * "Time-of-Day Trend": the shared ActivityTimeline starts fully expanded,
 *   showing the Widgets series by default (driven by the 'widget' route).
 *
 * Clicking a Widgets bar inside the timeline calls
 * navigate('/summary/widget', { state: { viewTab: 'table' } }), which this
 * component catches via a location-state effect and switches back to the data
 * table with the selected widgets already filtered — so the bar-chart drill
 * always lands on the data table, never the timeline.
 */
function WidgetView() {
  const { rows, headers } = useCsvData()
  const location = useLocation()

  // Default to the data table. A location.state.viewTab value (written by
  // ActivityTimeline's Widgets-bar click) overrides this so that clicking a
  // bar while on the timeline sub-tab switches straight back to the table.
  const [activeTab, setActiveTab] = useState('table')

  // React to navigation-state requests — covers both the initial navigation
  // (e.g. arriving from the Widgets bar click) and same-page updates (user
  // is already on /summary/widget → ActivityTimeline bar click re-navigates
  // with state to trigger this effect and switch back to the table tab).
  useEffect(() => {
    const requested = location.state?.viewTab
    if (requested === 'table' || requested === 'timeOfDay') {
      setActiveTab(requested)
    }
  }, [location.state])

  // ——— Data Table tab: per-widget timing panel ———
  // The per-widget timing chart renders inline in the chart region (no popup).
  // Its selection state lives in the table (which knows the filtered + sorted
  // widget list); the table publishes it up here via onTimingChange. null =
  // nothing selected → no panel.
  const [timingSel, setTimingSel] = useState(null)

  // Scroll the timing panel into view whenever the user clicks a widget name.
  // Uses requestAnimationFrame so the scroll fires after React has committed the
  // panel to the DOM (on first open the div doesn't exist yet). Arrow/picker
  // navigation inside the panel does NOT call this, so stepping through widgets
  // with the arrows won't yank the viewport.
  const panelRef = useRef(null)
  const scrollToPanel = useCallback(() => {
    requestAnimationFrame(() => scrollFast(panelRef.current))
  }, [])

  return (
    <>
      <ActionViewSwitcher
        views={WIDGET_VIEW_TABS}
        activeView={activeTab}
        onChange={setActiveTab}
        ariaLabel="Widget view"
      />

      {activeTab === 'table' && (
        <>
          <WidgetSummaryTable
            rows={rows}
            headers={headers}
            onTimingChange={setTimingSel}
            onScrollToChart={scrollToPanel}
          />

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
      )}

      {activeTab === 'timeOfDay' && (
        // startExpanded: panel mounts open without the embedded-mode
        // Action-drill behaviour. Widgets series is the default because
        // the route is 'widget' (ActivityTimeline reads location.pathname).
        <ActivityTimeline startExpanded />
      )}
    </>
  )
}

export default WidgetView
