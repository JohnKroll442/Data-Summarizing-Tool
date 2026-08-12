/**
 * Resolve the metadata shown in the ActionWaterfallPanel's rich header.
 *
 * The panel selects an action by index; each `actions[]` entry may be enriched
 * by the caller with story/user/durationMs. Fields are read off the selected
 * entry first, then fall back to an optional top-level `meta` prop, then to
 * safe defaults. `widgetCount` is supplied by the panel (derived from its own
 * charted widgets), not from the entry.
 */
export function resolveHeaderMeta({ actions, selectedIdx, meta, widgetCount } = {}) {
  const sel = actions?.[selectedIdx] ?? null
  const str = (a, b) => {
    if (a != null && a !== '') return a
    if (b != null && b !== '') return b
    return ''
  }
  const durationMs =
    sel?.durationMs != null ? sel.durationMs : meta?.durationMs
  return {
    actionName: str(sel?.name, meta?.actionName),
    story: str(sel?.story, meta?.story),
    user: str(sel?.user, meta?.user),
    timestamp: str(sel?.timestamp, meta?.timestamp),
    durationMs,
    widgetCount: Number.isFinite(widgetCount) ? widgetCount : 0,
  }
}
