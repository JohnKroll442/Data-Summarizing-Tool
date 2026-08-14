/**
 * The top-level Action views, in switcher order. `key` is persisted in
 * viewUi.action.activeView and drives which panel ActionView renders; `label`
 * is the SegmentedButton item text. The `×` in "Story × Action" is U+00D7.
 */
export const ACTION_VIEWS = [
  { key: 'table', label: 'Data Table' },
  { key: 'heatmap', label: 'Story × Action' },
  { key: 'offset', label: 'Offset vs Duration' },
  { key: 'timeOfDay', label: 'Time-Of-Day-Trend' },
]

/** The view shown when nothing is persisted. */
export const DEFAULT_ACTION_VIEW = 'table'

/** True when `key` is one of the known Action view keys. */
export function isActionViewKey(key) {
  return ACTION_VIEWS.some((v) => v.key === key)
}

/**
 * Resolve a (possibly persisted, undefined, or invalid) value to a valid view
 * key, falling back to DEFAULT_ACTION_VIEW.
 */
export function resolveActiveView(value) {
  return isActionViewKey(value) ? value : DEFAULT_ACTION_VIEW
}
