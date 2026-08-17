import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import ActionViewSwitcher from '../components/ActionViewSwitcher'
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
const COMPARE_TABS = [
  { key: 'session', label: 'Session' },
  { key: 'action', label: 'Action' },
  { key: 'widget', label: 'Widget' },
]

function ComparePage() {
  const { baselineId, currentId, baselinePayload, currentPayload } = useCsvData()
  const location = useLocation()
  const navigate = useNavigate()
  const activeSegment = location.pathname.split('/').pop()

  if (!baselineId || !currentId || !baselinePayload || !currentPayload) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="summary-page">
      <div className="summary-file-banner" aria-label="Comparison files">
        <Link to="/" className="summary-home-link" aria-label="Back to upload page">
          <ArrowLeft size={14} aria-hidden="true" /> Home
        </Link>
        <span className="summary-file-name compare-banner-label">
          Compare:{' '}
          <strong>{baselinePayload.fileName}</strong>
          {' '}vs.{' '}
          <strong>{currentPayload.fileName}</strong>
        </span>
      </div>

      <ActionViewSwitcher
        views={COMPARE_TABS}
        activeView={activeSegment}
        onChange={(key) => navigate(key)}
        ariaLabel="Compare views"
      />

      <div className="summary-content">
        <Outlet />
      </div>
    </div>
  )
}

export default ComparePage
