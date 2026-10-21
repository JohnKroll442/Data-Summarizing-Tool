import { parseStrictTimestamp } from './timeBuckets'

/**
 * Raw recording-point ordering check across widget phase END timestamps.
 *
 * The three phases NEST — render ⊇ network ⊇ backend — so the moment each phase
 * finishes must obey the same containment in time:
 *
 *     backend_end  ≤  network_end  ≤  render_end
 *
 * (The innermost phase, backend, completes first; the outermost, render, last.)
 * When a recording point violates that order — e.g. the network phase's end is
 * stamped AFTER the render phase's end — the source timestamps were captured
 * against inconsistent clocks or recording points. The magnitude of the overrun
 * (in ms) is the apparent skew.
 *
 * Why END timestamps only: in the common SAP export the phase STARTS are all
 * anchored to the single ACTION_TIMESTAMP (see widgetAggregate.phaseStart), so
 * render_start == network_start == backend_start and a start-based comparison is
 * meaningless. The ends come from genuinely distinct columns
 * (WIDGET_RENDER_TIMESTAMP vs WIDGET_TIMESTAMP) — the real independent points.
 *
 * Input: the per-action widget rows from buildPerActionWidgetRows() — each row
 * carries action_key, widget_id, widget_name, session_id and the six phase
 * start/end values. Non-timestamp sentinels (e.g. the literal "ttfb") fail to
 * parse and are skipped, so only comparable end-pairs are judged.
 *
 * This result is attached to the agent payload (NOT the Action View anomaly
 * list) so the AI can answer timestamp-ordering questions without surfacing a
 * new badge in the UI.
 *
 * @param {object[]} perActionWidgetRows  rows from buildPerActionWidgetRows()
 * @returns {object} compact summary (JSON-safe)
 */
export function buildTimestampIntegrity(perActionWidgetRows) {
  const empty = {
    widgets_checked:    0,
    widgets_disordered: 0,
    pct_disordered:     0,
    by_violation: {
      network_after_render:  { count: 0, avg_overrun_ms: 0, max_overrun_ms: 0 },
      backend_after_network: { count: 0, avg_overrun_ms: 0, max_overrun_ms: 0 },
    },
    worst_offenders: [],
    note: 'Expected recording-point order: backend_end ≤ network_end ≤ render_end (phases nest render ⊇ network ⊇ backend). A violation means an inner phase was stamped as finishing after the phase that contains it — inconsistent source clocks/recording points. Overrun ms = the apparent skew.',
  }
  if (!Array.isArray(perActionWidgetRows) || perActionWidgetRows.length === 0) {
    return empty
  }

  const ms = (v) => {
    const d = parseStrictTimestamp(v)
    return d ? d.getTime() : null
  }

  let checked = 0
  const disordered = []
  const netStats = { count: 0, totalMs: 0, maxMs: 0 }
  const backStats = { count: 0, totalMs: 0, maxMs: 0 }

  for (const w of perActionWidgetRows) {
    const renderEnd  = ms(w.render_end)
    const networkEnd = ms(w.network_end)
    const backendEnd = ms(w.backend_end)

    // A widget is "checked" if at least one of the two containment pairs has
    // both ends parseable; widgets with only one phase contribute nothing.
    const canCompareNet  = networkEnd !== null && renderEnd  !== null
    const canCompareBack = backendEnd !== null && networkEnd !== null
    if (!canCompareNet && !canCompareBack) continue
    checked += 1

    const violations = []
    if (canCompareNet && networkEnd > renderEnd) {
      const overrun = networkEnd - renderEnd
      netStats.count += 1
      netStats.totalMs += overrun
      if (overrun > netStats.maxMs) netStats.maxMs = overrun
      violations.push({ kind: 'network_after_render', overrun_ms: overrun })
    }
    if (canCompareBack && backendEnd > networkEnd) {
      const overrun = backendEnd - networkEnd
      backStats.count += 1
      backStats.totalMs += overrun
      if (overrun > backStats.maxMs) backStats.maxMs = overrun
      violations.push({ kind: 'backend_after_network', overrun_ms: overrun })
    }

    if (violations.length) {
      // Rank this widget by its single worst overrun.
      const worst = violations.reduce((a, b) => (b.overrun_ms > a.overrun_ms ? b : a))
      disordered.push({
        action_key:  w.action_key  ?? '',
        widget_id:   w.widget_id    ?? '',
        widget_name: w.widget_name  ?? '',
        session_id:  w.session_id   ?? '',
        violation:   worst.kind,
        overrun_ms:  worst.overrun_ms,
        all_violations: violations.map((v) => v.kind),
        render_end:  String(w.render_end  ?? ''),
        network_end: String(w.network_end ?? ''),
        backend_end: String(w.backend_end ?? ''),
      })
    }
  }

  disordered.sort((a, b) => b.overrun_ms - a.overrun_ms)

  const avg = (s) => (s.count > 0 ? Math.round(s.totalMs / s.count) : 0)

  return {
    widgets_checked:    checked,
    widgets_disordered: disordered.length,
    pct_disordered:     checked > 0 ? Math.round((disordered.length / checked) * 1000) / 10 : 0,
    by_violation: {
      network_after_render:  { count: netStats.count,  avg_overrun_ms: avg(netStats),  max_overrun_ms: netStats.maxMs },
      backend_after_network: { count: backStats.count, avg_overrun_ms: avg(backStats), max_overrun_ms: backStats.maxMs },
    },
    worst_offenders: disordered.slice(0, 15),
    note: empty.note,
  }
}
