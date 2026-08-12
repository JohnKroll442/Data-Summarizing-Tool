import { ACTION_VIEWS } from '../lib/actionViews'
import './ActionViewSwitcher.css'

/**
 * Top-level switcher for the Action view's three panels (Data Table /
 * Story × Action / Offset vs Duration), rendered as a SAP Fiori-style tab
 * strip — text tabs sharing an underline baseline, the active one carrying a
 * blue underline (the same design used before the Data Table view was added).
 * Presentational: `activeView` marks the active tab; `onChange(viewKey)` fires
 * when the user picks a different one.
 */
function ActionViewSwitcher({ activeView, onChange }) {
  return (
    <nav className="action-view-switcher" aria-label="Action view">
      {ACTION_VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          className={`action-view-switcher__tab${v.key === activeView ? ' is-active' : ''}`}
          aria-pressed={v.key === activeView}
          onClick={() => {
            if (v.key !== activeView) onChange(v.key)
          }}
        >
          {v.label}
        </button>
      ))}
    </nav>
  )
}

export default ActionViewSwitcher
