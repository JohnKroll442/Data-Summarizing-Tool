// Which action instance a detail list should open on. The list is sorted
// slowest-first, so index 0 is the slowest. When a specific run's timestamp is
// requested (the Offset scatter passes the hovered dot's _action_timestamp), the
// matching instance is preselected; the heatmap passes nothing and gets 0.
// Pure + framework-free so it can be unit-tested without importing the (UI5-heavy)
// ActionCellDetail component.
export function initialInstanceIndex(instances, ts) {
  if (!ts) return 0
  const i = (instances ?? []).findIndex((inst) => (inst?._action_timestamp ?? '') === ts)
  return i >= 0 ? i : 0
}
