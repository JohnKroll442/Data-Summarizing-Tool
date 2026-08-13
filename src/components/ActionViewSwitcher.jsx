import { ACTION_VIEWS } from '../lib/actionViews'
import './ActionViewSwitcher.css'

/**
 * SAP Fiori-style tab strip — text tabs sharing an underline baseline, the
 * active one carrying a blue underline. Originally the switcher for the Action
 * view's three panels (Data Table / Story × Action / Offset vs Duration); now
 * also drives the top-level view tabs, so `views` is a prop.
 *
 * Presentational: `views` is a list of `{ key, label }`; `activeView` marks the
 * active tab; `onChange(viewKey)` fires when the user picks a different one;
 * `ariaLabel` names the nav for assistive tech; `stretch` makes the tabs share
 * the full width evenly (used for the top-level view bar) instead of hugging
 * their text at the left.
 */
function ActionViewSwitcher({
  activeView,
  onChange,
  views = ACTION_VIEWS,
  ariaLabel = 'Action view',
  stretch = false,
}) {
  return (
    <nav
      className={`action-view-switcher${stretch ? ' action-view-switcher--stretch' : ''}`}
      aria-label={ariaLabel}
    >
      {views.map((v) => (
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
