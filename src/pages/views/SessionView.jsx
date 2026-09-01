import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import SessionSummaryTable from '../../components/SessionSummaryTable'
import ActivityTimeline from '../../components/ActivityTimeline'
import ActionViewSwitcher from '../../components/ActionViewSwitcher'
import { useCsvData } from '../../context/useCsvData'

// Two top-level sub-tabs, mirroring the Action View pattern.
// "Data Table" is the default; "Time-of-Day Trend" shows the shared
// ActivityTimeline in its fully-expanded inline form.
const SESSION_VIEW_TABS = [
  { key: 'table',     label: 'Data Table' },
  { key: 'timeOfDay', label: 'Time-of-Day Trend' },
]

/**
 * SessionView — wraps the session data table and the Time-of-Day timeline
 * behind a two-tab switcher that matches the Action View pattern.
 *
 * Default tab: "Data Table" (SessionSummaryTable, same as before).
 * "Time-of-Day Trend": the shared ActivityTimeline starts fully expanded,
 *   showing the Sessions series by default (driven by the 'session' route).
 *
 * Clicking a Sessions bar inside the timeline calls
 * navigate('/summary/session', { state: { viewTab: 'table' } }), which this
 * component catches via a location-state effect and switches back to the data
 * table with the selected sessions already filtered — so the bar-chart drill
 * always lands on the data table, never the timeline.
 */
function SessionView() {
  const { rows, headers } = useCsvData()
  const location = useLocation()

  // Default to the data table. A location.state.viewTab value (written by
  // ActivityTimeline's Sessions-bar click) overrides this so that clicking a
  // bar while on the timeline sub-tab switches straight back to the table.
  const [activeTab, setActiveTab] = useState('table')

  // React to navigation-state requests — covers both the initial navigation
  // (e.g. arriving from the Sessions bar click) and same-page updates (user
  // is already on /summary/session → ActivityTimeline bar click re-navigates
  // with state to trigger this effect and switch back to the table tab).
  useEffect(() => {
    const requested = location.state?.viewTab
    if (requested === 'table' || requested === 'timeOfDay') {
      setActiveTab(requested)
    }
  }, [location.state])

  return (
    <>
      <ActionViewSwitcher
        views={SESSION_VIEW_TABS}
        activeView={activeTab}
        onChange={setActiveTab}
        ariaLabel="Session view"
      />

      {activeTab === 'table' && (
        <SessionSummaryTable rows={rows} headers={headers} />
      )}

      {activeTab === 'timeOfDay' && (
        // startExpanded: panel mounts open without the embedded-mode
        // Action-drill behaviour. Sessions series is the default because
        // the route is 'session' (ActivityTimeline reads location.pathname).
        <ActivityTimeline startExpanded />
      )}
    </>
  )
}

export default SessionView
