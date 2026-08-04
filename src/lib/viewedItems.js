/**
 * Pure helpers for the "already viewed" tracking used by the summary tables.
 * Kept as plain functions (no React) so the reducer logic can be unit-tested
 * directly and reused by CsvDataContext.
 *
 * Shape: one plain object map per view, `{ [id]: true }`. Object maps (not
 * Sets) so every mutation returns a NEW reference — React consumers re-render,
 * and an unchanged update returns the SAME reference so nothing re-renders
 * needlessly.
 */

// Fresh, empty viewed state — one map per view. Also used to reset on file swap.
export function emptyViewedItems() {
  return { session: {}, action: {}, widget: {} }
}

// Mark `id` viewed under `view`. Returns `prev` unchanged when the id is already
// present or the input is invalid (so callers can skip a re-render), otherwise a
// new state object with a new map for that view. Ids are stringified so numeric
// and string keys don't diverge.
export function addViewed(prev, view, id) {
  if (!view || id == null || !prev?.[view]) return prev
  const key = String(id)
  if (prev[view][key]) return prev
  return { ...prev, [view]: { ...prev[view], [key]: true } }
}
