import { parseStrictTimestamp } from './timeBuckets'
import { detectWidgetMapping, phasePicks } from './widgetAggregate'
import { findActionNameKey, findActionTimestampKey } from './drillDown'

/**
 * Phase-overlap analysis: did a widget's render and network phases run
 * concurrently (overlapping time windows) or one-after-another (sequential)?
 *
 * This reads the RAW per-phase window columns straight from the uploaded CSV
 * rows — render from WIDGET_RENDER_TIMESTAMP_START → WIDGET_RENDER_TIMESTAMP,
 * network from WIDGET_TIMESTAMP_START → WIDGET_TIMESTAMP on the ttfb row. These
 * are the ONLY independent per-phase starts in the data: the aggregated
 * widget_rows sent to the backend anchor every phase start to ACTION_TIMESTAMP
 * (so render_start == network_start there and overlap can't be seen). That is
 * why this must run frontend-side over the raw rows, mirroring
 * buildPerActionWidgetRows — the result is injected into the agent payload as a
 * compact `phase_overlap` block so the assistant can answer "which actions ran
 * render and network in parallel" without the LLM parsing timestamps itself.
 *
 * Per widget (within one action) the render window [rs, re] and network window
 * [ns, ne] are classified:
 *   nested          — network runs entirely inside render (rs ≤ ns, ne ≤ re):
 *                     the expected case (phases nest render ⊇ network). Parallel.
 *   partial_overlap — the windows overlap but neither contains the other. Parallel.
 *   sequential      — the windows do NOT overlap at all (one finishes before the
 *                     other starts). NOT parallel.
 * `inverted_start` is a separate flag counting widgets where network_start is
 * BEFORE render_start — a recording inconsistency (an inner phase can't begin
 * before the phase that contains it).
 *
 * @param {object[]} rows     raw scoped CSV rows (NOT aggRows / widget_rows)
 * @param {string[]} headers  CSV header names
 * @returns {object} compact summary (JSON-safe)
 */
export function buildPhaseOverlap(rows, headers) {
  const empty = {
    widgets_checked:     0,
    parallel_widgets:    0,
    sequential_widgets:  0,
    pct_parallel:        0,
    inverted_start:      0,
    relationship_counts: { nested: 0, partial_overlap: 0, sequential: 0 },
    avg_overlap_ms:      0,
    max_overlap_ms:      0,
    parallel_examples:   [],
    sequential_examples: [],
    note: 'Render window = WIDGET_RENDER_TIMESTAMP_START→WIDGET_RENDER_TIMESTAMP; network window = WIDGET_TIMESTAMP_START→WIDGET_TIMESTAMP (ttfb). "Parallel" means the two windows overlap in time; "sequential" means they do not. Phases are expected to nest (render ⊇ network), so network normally runs entirely within render.',
  }

  if (!Array.isArray(rows) || rows.length === 0 ||
      !Array.isArray(headers) || headers.length === 0) {
    return empty
  }

  const mapping = detectWidgetMapping(headers)
  const actionNameKey = findActionNameKey(headers)
  const actionTsKey = findActionTimestampKey(headers)
  // Need a widget id, both render window columns, and both network window
  // columns, or there is nothing comparable to measure.
  if (!mapping.widgetId || !actionNameKey ||
      !mapping.renderTimestampStart || !mapping.renderTimestamp ||
      !mapping.widgetTimestampStart || !mapping.widgetTimestamp) {
    return empty
  }

  const ms = (v) => {
    const d = parseStrictTimestamp(v)
    return d ? d.getTime() : null
  }

  // Group raw rows by action key, then by widget id — the same composite key
  // (name::timestamp) used across the tool.
  const actions = new Map()
  for (const r of rows) {
    const name = r?.[actionNameKey]
    if (name === undefined || name === null || name === '') continue
    const ts = actionTsKey ? (r?.[actionTsKey] ?? '') : ''
    const key = `${name}::${ts}`
    if (!actions.has(key)) actions.set(key, [])
    actions.get(key).push(r)
  }

  let checked = 0
  let inverted = 0
  let overlapSum = 0
  let overlapMax = 0
  const counts = { nested: 0, partial_overlap: 0, sequential: 0 }
  const parallel = []
  const sequential = []

  for (const [actionKey, actionRows] of actions) {
    const actionName = actionKey.split('::')[0]
    const widgets = new Map()
    for (const r of actionRows) {
      const wid = r?.[mapping.widgetId]
      if (wid === undefined || wid === null || wid === '') continue
      const k = String(wid)
      if (!widgets.has(k)) widgets.set(k, [])
      widgets.get(k).push(r)
    }

    for (const [wid, widgetRows] of widgets) {
      const { renderPick, networkPick } = phasePicks(widgetRows, mapping)
      if (!renderPick.row || !networkPick.row) continue

      const rs = ms(renderPick.row[mapping.renderTimestampStart])
      const re = ms(renderPick.row[mapping.renderTimestamp])
      const ns = ms(networkPick.row[mapping.widgetTimestampStart])
      const ne = ms(networkPick.row[mapping.widgetTimestamp])
      if (rs === null || re === null || ns === null || ne === null) continue

      checked += 1
      if (ns < rs) inverted += 1

      const overlap = Math.max(0, Math.min(re, ne) - Math.max(rs, ns))
      const widgetName = firstNonEmpty([renderPick.row, networkPick.row], mapping.widgetName)
      const base = {
        action_name:  actionName,
        widget_id:    wid,
        widget_name:  widgetName,
        render_start: String(renderPick.row[mapping.renderTimestampStart] ?? ''),
        render_end:   String(renderPick.row[mapping.renderTimestamp] ?? ''),
        network_start: String(networkPick.row[mapping.widgetTimestampStart] ?? ''),
        network_end:   String(networkPick.row[mapping.widgetTimestamp] ?? ''),
      }

      if (overlap > 0) {
        const relationship = (rs <= ns && ne <= re) ? 'nested' : 'partial_overlap'
        counts[relationship] += 1
        overlapSum += overlap
        if (overlap > overlapMax) overlapMax = overlap
        parallel.push({ ...base, relationship, overlap_ms: overlap })
      } else {
        counts.sequential += 1
        // Gap between the two windows (always ≥ 0 when they don't overlap).
        const gap = Math.max(rs, ns) - Math.min(re, ne)
        sequential.push({ ...base, relationship: 'sequential', gap_ms: Math.max(0, gap) })
      }
    }
  }

  parallel.sort((a, b) => b.overlap_ms - a.overlap_ms)
  sequential.sort((a, b) => (b.gap_ms ?? 0) - (a.gap_ms ?? 0))

  const parallelCount = counts.nested + counts.partial_overlap

  return {
    widgets_checked:     checked,
    parallel_widgets:    parallelCount,
    sequential_widgets:  counts.sequential,
    pct_parallel:        checked > 0 ? Math.round((parallelCount / checked) * 1000) / 10 : 0,
    inverted_start:      inverted,
    relationship_counts: counts,
    avg_overlap_ms:      parallelCount > 0 ? Math.round(overlapSum / parallelCount) : 0,
    max_overlap_ms:      overlapMax,
    parallel_examples:   parallel.slice(0, 12),
    sequential_examples: sequential.slice(0, 12),
    note: empty.note,
  }
}

function firstNonEmpty(rowsList, key) {
  if (!key) return ''
  for (const r of rowsList) {
    const v = r?.[key]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}
