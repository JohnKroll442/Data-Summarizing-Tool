import { Link, Navigate, NavLink, Outlet } from 'react-router-dom'
import { useCsvData } from '../context/useCsvData'
import './SummaryPage.css'

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

  if (!hasData) {
    return <Navigate to="/" replace />
  }

  const canSwitch = recentFiles.length > 1

  return (
    <div className="summary-page">
      <div className="summary-file-banner" aria-label="Loaded file">
        <Link to="/" className="summary-home-link" aria-label="Back to upload page">
          <span aria-hidden="true">←</span> Home
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
        <NavLink to="raw" className="summary-tab">Raw Data View</NavLink>
        <NavLink to="session" className="summary-tab">Session View</NavLink>
        <NavLink to="action" className="summary-tab">Action View</NavLink>
        <NavLink to="widget" className="summary-tab">Widget View</NavLink>
      </nav>

      <div className="summary-content">
        <Outlet />
      </div>
    </div>
  )
}

export default SummaryPage
