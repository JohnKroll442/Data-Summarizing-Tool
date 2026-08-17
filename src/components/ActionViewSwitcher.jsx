import { ACTION_VIEWS } from '../lib/actionViews'
import './ActionViewSwitcher.css'

/**
 * ActionViewSwitcher — a Fiori-style underline tab strip that spans the full
 * width of its container. Rendered as plain buttons (not UI5 `TabContainer`)
 * because that component keeps its tab items in shadow DOM with no CSS part to
 * make them stretch; a flexbox row of equal-width buttons spans by construction
 * while keeping the underline-on-active look.
 *
 * Presentational: `views` is a list of `{ key, label }`; `activeView` marks the
 * active tab; `onChange(viewKey)` fires when the user picks a different one;
 * `ariaLabel` names the control for assistive tech.
 */
function ActionViewSwitcher({
  activeView,
  onChange,
  views = ACTION_VIEWS,
  ariaLabel = 'Action view',
}) {
  return (
    <div className="action-view-switcher" role="tablist" aria-label={ariaLabel}>
      {views.map((v) => {
        const isActive = v.key === activeView
        return (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={
              'action-view-switcher__tab' + (isActive ? ' is-active' : '')
            }
            onClick={() => {
              if (!isActive) onChange(v.key)
            }}
          >
            {v.label}
          </button>
        )
      })}
    </div>
  )
}

export default ActionViewSwitcher
