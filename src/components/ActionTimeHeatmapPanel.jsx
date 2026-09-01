import { useMemo } from 'react'
import EChartCard from './charts/EChartCard'
import { buildHeatmapOption } from './charts/options/heatmap'
import { parseTimestamp, bucketOf } from '../lib/timeBuckets'

/**
 * ActionTimeHeatmapPanel — Story × Date heatmap, coloured by action-instance
 * count (darker = more actions fired for that story on that day).
 *
 * Data derivation:
 *   Each aggRow carries `_action_timestamp` (a raw timestamp string) and
 *   `story_name`. We derive a sortable `_date_bucket` (YYYY-MM-DD) from the
 *   timestamp, drop rows with no parseable timestamp, then call
 *   buildHeatmapOption in its default STORY_ACTION mode with:
 *     xKey = '_date_bucket'  → horizontal axis (time, left → right)
 *     yKey = 'story_name'    → vertical axis (entities, top → bottom)
 *   This sidesteps the TIME_SERIES axis-swap path in heatmap.js, which
 *   contains a matching-loop bug (inner filter still references the original
 *   xKey/yKey after the axis keys are swapped, so every cell scores zero).
 *   Passing pre-derived columns directly to default mode is correct and
 *   stable.
 *
 * Props:
 *   aggRows   one-row-per-action-instance array from aggregateByAction
 */
function ActionTimeHeatmapPanel({ aggRows }) {
  // Derive a YYYY-MM-DD date bucket for each row.
  // Rows without a parseable timestamp are dropped — they have no position
  // on the time axis.
  const enrichedRows = useMemo(() => {
    if (!aggRows?.length) return []
    return aggRows
      .map((r) => {
        const ts = parseTimestamp(r._action_timestamp)
        if (!ts) return null
        return { ...r, _date_bucket: bucketOf(ts, 'day').key }
      })
      .filter(Boolean)
  }, [aggRows])

  // buildHeatmapOption in default STORY_ACTION mode — no mode prop.
  // xKey/_date_bucket goes on the x-axis (columns = dates),
  // yKey/story_name goes on the y-axis (rows = stories).
  // No valueKey → colour encodes count of action instances per cell.
  const option = useMemo(
    () => buildHeatmapOption(enrichedRows, { xKey: '_date_bucket', yKey: 'story_name' }),
    [enrichedRows],
  )

  const dayCount = useMemo(
    () => new Set(enrichedRows.map((r) => r._date_bucket)).size,
    [enrichedRows],
  )
  const storyCount = useMemo(
    () => new Set(enrichedRows.map((r) => r.story_name)).size,
    [enrichedRows],
  )

  const subtitle = enrichedRows.length
    ? `${storyCount} stor${storyCount === 1 ? 'y' : 'ies'} · ${dayCount} day${dayCount === 1 ? '' : 's'} · colour = action count`
    : ''

  return (
    <section className="action-view-fullscreen" aria-label="Time heatmap">
      <EChartCard
        title="Story × Date — Action Count"
        subtitle={subtitle}
        option={option}
        height={520}
      />
    </section>
  )
}

export default ActionTimeHeatmapPanel
