import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { ToggleButton } from '@ui5/webcomponents-react/ToggleButton'
import { useCsvData } from '../context/useCsvData'
import { HeaderSlotProvider } from '../context/HeaderSlot'
import ActivityTimeline from '../components/ActivityTimeline'
import './SummaryPage.css'

// The four CSV views plus the roll-up Summary, in tab order. `path` matches
// the nested route segment under /summary (see App.jsx).
const VIEW_TABS = [
  { path: 'raw', label: 'Raw Data View' },
  { path: 'session', label: 'Session View' },
  { path: 'action', label: 'Action View' },
  { path: 'widget', label: 'Widget View' },
  { path: 'summary', label: 'Summary' },
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
  const { hasData, fileName, recentFiles, activeFileId, selectRecentFile } = useCsvData()
  const location = useLocation()
  const navigate = useNavigate()
  // The active view portals its heading + KPI strip into this node so they sit
  // above the timeline. A ref callback (not useRef) so the first render that
  // has the node re-runs the provider and the portals find their target.
  const [headerSlot, setHeaderSlot] = useState(null)

  if (!hasData) {
    return <Navigate to="/" replace />
  }

  const canSwitch = recentFiles.length > 1
  const activeSegment = location.pathname.split('/').pop()

  return (
    <div className="summary-page">
      <div className="summary-file-banner" aria-label="Loaded file">
        <Link to="/" className="summary-home-link" aria-label="Back to upload page">
          <ArrowLeft size={14} aria-hidden="true" /> Home
        </Link>
        {canSwitch ? (
          <select
            className="summary-file-select"
            value={activeFileId}
            aria-label="Switch loaded file"
            onChange={(e) => {
              if (e.target.value && e.target.value !== activeFileId) {
                selectRecentFile(e.target.value)
              }
            }}
          >
            {recentFiles.map((file) => (
              <option key={file.id} value={file.id}>
                {file.fileName}
              </option>
            ))}
          </select>
        ) : (
          <span className="summary-file-name">{fileName}</span>
        )}
      </div>

      <nav className="summary-tabs" aria-label="Summary views">
        {VIEW_TABS.map((tab) => (
          <ToggleButton
            key={tab.path}
            className="summary-tab"
            pressed={activeSegment === tab.path}
            onClick={(e) => {
              navigate(tab.path)
              // For mouse clicks, drop focus so UI5's focus ring doesn't linger
              // (matches the clean look you get after clicking elsewhere). Keep
              // it for keyboard activation so those users retain a focus cue.
              if (e.detail?.originalEvent instanceof MouseEvent) {
                e.currentTarget.blur()
              }
            }}
          >
            {tab.label}
          </ToggleButton>
        ))}
      </nav>

      <div className="summary-content">
        {/* Heading + KPIs portal in here, so they sit above the timeline. */}
        <div className="summary-header-slot" ref={setHeaderSlot} />
        <ActivityTimeline />
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
