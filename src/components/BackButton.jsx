import { useNavigate } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { useCsvData } from '../context/useCsvData'
import './BackButton.css'

/**
 * BackButton — restores the previous view's drill-down filters and routes back.
 *
 * Drill-down scope (session/action/widget filters, timeline range, time
 * selections) lives in CsvDataContext, not the URL — so the browser's back
 * button can't restore it. Each drill site pushes a snapshot before mutating
 * that state; goBack() pops it, re-applies the filters, and returns the path
 * to navigate to. Renders nothing when there's no snapshot to return to.
 *
 * Placed just above each view's scope indicator (the "Showing … active" banner
 * / filter pills) so it sits right where it tells you which session or widget
 * you're currently viewing.
 */
function BackButton() {
  const { canGoBack, goBack } = useCsvData()
  const navigate = useNavigate()

  if (!canGoBack) return null

  const handleBack = () => {
    const path = goBack()
    if (path) navigate(path)
  }

  return (
    <div className="back-button-row">
      <button
        type="button"
        className="back-button"
        onClick={handleBack}
        title="Go back to the previous view"
      >
        <ChevronLeft size={14} aria-hidden="true" /> Back
      </button>
    </div>
  )
}

export default BackButton
