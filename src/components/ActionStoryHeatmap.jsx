import { useMemo } from 'react'
import { formatDurationMs } from '../lib/format'
import { SAP_BLUE_LIGHT, SAP_BLUE_DARKER } from '../lib/chartColors'
import { cellKeyOf } from '../lib/storyActionMatrix'
import './ActionStoryHeatmap.css'

/**
 * ActionStoryHeatmap — the "Story × Action heatmap" grid for the Action view.
 *
 * A scrollable HTML table: STORY down the rows (sticky first column), ACTION
 * across the top (sticky header row), each cell showing that combination's
 * longest (max) action duration, tinted across the SAP blue scale by magnitude.
 * Combos with no actions show an em dash and aren't clickable; clicking a
 * populated cell calls onSelectCell(story, action) so the parent can open the
 * detail panel.
 *
 * Props:
 *   matrix       { stories, actions, cells, maxDuration } from buildStoryActionMatrix
 *   selectedKey  cellKeyOf(story, action) of the open cell, or null
 *   onSelectCell (story, action) => void
 */
function ActionStoryHeatmap({ matrix, selectedKey, onSelectCell }) {
  const { stories, actions, cells } = matrix ?? {}

  // Pre-parse the two palette endpoints once so each cell's tint is a cheap lerp.
  const [lo, hi] = useMemo(
    () => [parseHex(SAP_BLUE_LIGHT), parseHex(SAP_BLUE_DARKER)],
    [],
  )

  // Durations span several orders of magnitude — from milliseconds to the
  // 112-minute outlier. A linear tint (duration / maxDuration) therefore
  // crushes almost everything to the palest blue: a 3-minute cell and a
  // 10-second cell both land at ~2% of the max and read as the same color. A
  // LOG scale spreads that range across the whole ramp — equal color steps
  // mean equal *ratios* of duration, which is how latency is actually reasoned
  // about. `norm(duration)` returns the 0..1 tint position, mapping the
  // smallest positive duration to the light end and the largest to the dark end.
  const norm = useMemo(() => makeLogNorm(cells), [cells])

  if (!stories?.length || !actions?.length) {
    return (
      <div className="story-heatmap story-heatmap--empty">
        Not enough data to build a Story × Action heatmap.
      </div>
    )
  }

  return (
    <div className="story-heatmap">
      <div className="story-heatmap__scroll">
        <table className="story-heatmap__table">
          <thead>
            <tr>
              <th className="story-heatmap__corner" scope="col">
                Story \ Action
              </th>
              {actions.map((a) => (
                <th key={a} className="story-heatmap__col-head" scope="col" title={a}>
                  <span className="story-heatmap__col-head-text">{a}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stories.map((s) => (
              <tr key={s}>
                <th className="story-heatmap__row-head" scope="row" title={s}>
                  <span className="story-heatmap__row-head-text">{s}</span>
                </th>
                {actions.map((a) => {
                  const key = cellKeyOf(s, a)
                  const cell = cells.get(key)
                  if (!cell) {
                    return (
                      <td key={a} className="story-heatmap__cell story-heatmap__cell--empty">
                        <span className="story-heatmap__dash">—</span>
                      </td>
                    )
                  }
                  const hasValue = cell.duration != null
                  const t = hasValue ? norm(cell.duration) : 0
                  const style = hasValue
                    ? { backgroundColor: lerpColor(lo, hi, t), color: t > 0.6 ? '#fff' : undefined }
                    : undefined
                  const selected = selectedKey === key
                  return (
                    <td key={a} className="story-heatmap__cell">
                      <button
                        type="button"
                        className={`story-heatmap__btn${selected ? ' is-selected' : ''}`}
                        style={style}
                        onClick={() => onSelectCell?.(s, a)}
                        title={`${s} · ${a} — ${hasValue ? formatDurationMs(cell.duration) : 'n/a'} · ${cell.count} action${cell.count === 1 ? '' : 's'}`}
                      >
                        {hasValue ? formatDurationMs(cell.duration) : '—'}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ——— color helpers ——— */

// Build a log-scale normalizer over the populated cells' durations: the
// smallest positive duration maps to 0 (lightest) and the largest to 1
// (darkest), interpolated on a natural-log axis so a wide ms→minutes spread
// stays visually separable. Returns a flat mapping when there's no spread (0 or
// 1 distinct value) so a degenerate matrix can't divide by zero.
function makeLogNorm(cells) {
  let min = Infinity
  let max = 0
  if (cells) {
    for (const cell of cells.values()) {
      const v = cell?.duration
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
  }
  if (!(max > 0) || max === min) {
    // No data, or every cell shares one value — paint them uniformly.
    return () => (max > 0 ? 1 : 0)
  }
  const loLog = Math.log(min)
  const span = Math.log(max) - loLog
  return (v) => {
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) return 0
    return Math.max(0, Math.min(1, (Math.log(v) - loLog) / span))
  }
}

// "#rrggbb" → [r, g, b]. Falls back to mid-grey on an unparseable value so a
// missing CSS variable never throws mid-render.
function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return [128, 128, 128]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Linear interpolation between two [r,g,b] endpoints at t in [0,1].
function lerpColor(a, b, t) {
  const c = Math.max(0, Math.min(1, t))
  const r = Math.round(a[0] + (b[0] - a[0]) * c)
  const g = Math.round(a[1] + (b[1] - a[1]) * c)
  const bl = Math.round(a[2] + (b[2] - a[2]) * c)
  return `rgb(${r}, ${g}, ${bl})`
}

export default ActionStoryHeatmap
