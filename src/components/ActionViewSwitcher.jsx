import { SegmentedButton } from '@ui5/webcomponents-react/SegmentedButton'
import { SegmentedButtonItem } from '@ui5/webcomponents-react/SegmentedButtonItem'
import { ACTION_VIEWS, isActionViewKey } from '../lib/actionViews'
import './ActionViewSwitcher.css'

/**
 * Top-level switcher for the Action view's three panels (Data Table /
 * Story × Action / Offset vs Duration). Presentational: `activeView` marks the
 * pressed segment; `onChange(viewKey)` fires when the user selects another.
 *
 * Each SegmentedButtonItem carries a `data-view` attribute (rendered onto the
 * web component), read back from the selection-change event's selected item.
 */
function ActionViewSwitcher({ activeView, onChange }) {
  const handleSelectionChange = (event) => {
    const key = event.detail?.selectedItems?.[0]?.dataset?.view
    if (isActionViewKey(key) && key !== activeView) onChange(key)
  }

  return (
    <div className="action-view-switcher">
      <SegmentedButton accessibleName="Action view" onSelectionChange={handleSelectionChange}>
        {ACTION_VIEWS.map((v) => (
          <SegmentedButtonItem key={v.key} data-view={v.key} selected={v.key === activeView}>
            {v.label}
          </SegmentedButtonItem>
        ))}
      </SegmentedButton>
    </div>
  )
}

export default ActionViewSwitcher
