import { Navigate, NavLink, Outlet } from 'react-router-dom'
import { useCsvData } from '../context/useCsvData'
import './SummaryPage.css'

/**
 * SummaryPage — shell for the three CSV views.
 *
 * Renders a centered file-name banner at the top, then a tab bar for
 * Session View / Action View / Widget View, and an <Outlet /> for the
 * active view's table. If we land here without parsed data (refresh /
 * direct URL), bounce back to /.
 */
function SummaryPage() {
  const { hasData, fileName } = useCsvData()

  if (!hasData) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="summary-page">
      <div className="summary-file-banner" aria-label="Loaded file">
        <span className="summary-file-name">{fileName}</span>
      </div>

      <nav className="summary-tabs" aria-label="Summary views">
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
