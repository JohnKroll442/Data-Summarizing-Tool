import { Link, Navigate, NavLink, Outlet } from 'react-router-dom'
import { useCsvData } from '../context/useCsvData'
import './SummaryPage.css'
import './ComparePage.css'

/**
 * ComparePage — shell for the three comparison views (Session, Action, Widget).
 *
 * Reads the baseline/current selections from context and shows a banner naming
 * both files, a Home link, and a tab bar. If either selection is missing,
 * bounces back to the upload page so the user can pick.
 */
function ComparePage() {
  const { baselineId, currentId, baselinePayload, currentPayload } = useCsvData()

  if (!baselineId || !currentId || !baselinePayload || !currentPayload) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="summary-page">
      <div className="summary-file-banner" aria-label="Comparison files">
        <Link to="/" className="summary-home-link" aria-label="Back to upload page">
          <span aria-hidden="true">←</span> Home
        </Link>
        <span className="summary-file-name compare-banner-label">
          Compare:{' '}
          <strong>{baselinePayload.fileName}</strong>
          {' '}vs.{' '}
          <strong>{currentPayload.fileName}</strong>
        </span>
      </div>

      <nav className="summary-tabs" aria-label="Compare views">
        <NavLink to="session" className="summary-tab">Session</NavLink>
        <NavLink to="action" className="summary-tab">Action</NavLink>
        <NavLink to="widget" className="summary-tab">Widget</NavLink>
      </nav>

      <div className="summary-content">
        <Outlet />
      </div>
    </div>
  )
}

export default ComparePage
