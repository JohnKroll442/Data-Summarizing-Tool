import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { Button, Select, Option } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/nav-back.js'
import '@ui5/webcomponents-icons/dist/action-settings.js'
import { useCsvData } from '../context/useCsvData'
import { HeaderSlotProvider } from '../context/HeaderSlot'
import ActivityTimeline from '../components/ActivityTimeline'
import ActionViewSwitcher from '../components/ActionViewSwitcher'
import ThresholdSettingsDialog from '../components/ThresholdSettingsDialog'
import './SummaryPage.css'

// The four CSV views plus the roll-up Summary, in tab order. `key` matches
// the nested route segment under /summary (see App.jsx).
const VIEW_TABS = [
  { key: 'raw', label: 'Raw Data View' },
  { key: 'session', label: 'Session View' },
  { key: 'action', label: 'Action View' },
  { key: 'widget', label: 'Widget View' },
  { key: 'summary', label: 'Summary' },
]

/**
 * SummaryPage — shell for the four CSV views (Raw, Session, Action, Widget).
 *
 * Renders the file-name banner (or a recent-files switcher when more than
 * one file has been uploaded this session), the tab bar, and an <Outlet />
 * for the active view's content. If we land here without parsed data
 * (refresh / direct URL), bounce back to /.
 */
function SummaryPage() {
  const { hasData, recentFiles, activeFileId, selectRecentFile } = useCsvData()
  const location = useLocation()
  const navigate = useNavigate()
  // The active view portals its heading + KPI strip into this node so they sit
  // above the timeline. A ref callback (not useRef) so the first render that
  // has the node re-runs the provider and the portals find their target.
  const [headerSlot, setHeaderSlot] = useState(null)
  const [thresholdDialogOpen, setThresholdDialogOpen] = useState(false)

  if (!hasData) {
    return <Navigate to="/" replace />
  }

  const canSwitch = recentFiles.length > 1
  const activeSegment = location.pathname.split('/').pop()

  return (
    <div className="summary-page">
      <ThresholdSettingsDialog
        open={thresholdDialogOpen}
        onClose={() => setThresholdDialogOpen(false)}
      />

      {/* File-switcher row — only visible when more than one file is loaded */}
      {canSwitch && (
        <div className="summary-file-switcher">
          <Select
            value={activeFileId}
            accessibleName="Switch loaded file"
            onChange={(e) => {
              const id = e.detail.selectedOption.getAttribute('value')
              if (id && id !== activeFileId) selectRecentFile(id)
            }}
          >
            {recentFiles.map((file) => (
              <Option key={file.id} value={file.id}>
                {file.fileName}
              </Option>
            ))}
          </Select>
        </div>
      )}

      <ActionViewSwitcher
        views={VIEW_TABS}
        activeView={activeSegment}
        onChange={(seg) => navigate(seg)}
        ariaLabel="Summary views"
        startContent={
          <Button
            icon="nav-back"
            design="Transparent"
            className="summary-home-btn"
            tooltip="Back to upload page"
            onClick={() => navigate('/')}
            style={{'--sapButton_Lite_Textcolor': '#000000'}}
          >
            Home
          </Button>
        }
        endContent={
          <Button
            icon="action-settings"
            className="summary-settings-btn"
            design="Transparent"
            tooltip="Threshold settings"
            onClick={() => setThresholdDialogOpen(true)}
          />
        }
      />

      <div className="summary-content">
        {/* Heading + KPIs portal in here, so they sit above the timeline. */}
        <div className="summary-header-slot" ref={setHeaderSlot} />
        {/* The shared timeline sits above every view EXCEPT the Action View,
            which hosts it inside its own "Time-Of-Day-Trend" tab instead. */}
        {activeSegment !== 'action' && <ActivityTimeline />}
        {/* Scroll anchor: the Sessions-bar click in ActivityTimeline collapses
            the timeline and scrolls this into view so the filtered table is
            front and center. */}
        <div id="summary-view-top">
          <HeaderSlotProvider value={headerSlot}>
            <Outlet />
          </HeaderSlotProvider>
        </div>
      </div>
    </div>
  )
}

export default SummaryPage
