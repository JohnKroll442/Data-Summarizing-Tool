import { useMemo } from 'react'
import { formatDurationMs } from '../lib/format'
import { SAP_BLUE_LIGHT, SAP_BLUE_DARKER } from '../lib/chartColors'
import { cellKeyOf } from '../lib/storyActionMatrix'
import './ActionStoryHeatmap.css'

/**
 * ActionStoryHeatmap — the "Story × Action heatmap" grid for the Action view.
 *
 * A scrollable HTML table: STORY down the rows (sticky first column), ACTION
 * across the top (sticky header row), each cell showing that combination's p95
 * action duration, tinted across the SAP blue scale by magnitude. Combos with
 * no actions show an em dash and aren't clickable; clicking a populated cell
 * calls onSelectCell(story, action) so the parent can open the detail panel.
 *
 * Props:
 *   matrix       { stories, actions, cells, maxP95 } from buildStoryActionMatrix
 *   selectedKey  cellKeyOf(story, action) of the open cell, or null
 *   onSelectCell (story, action) => void
 */
function ActionStoryHeatmap({ matrix, selectedKey, onSelectCell }) {
  const { stories, actions, cells, maxP95 } = matrix ?? {}

  // Pre-parse the two palette endpoints once so each cell's tint is a cheap lerp.
  const [lo, hi] = useMemo(
    () => [parseHex(SAP_BLUE_LIGHT), parseHex(SAP_BLUE_DARKER)],
    [],
  )

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
                  const hasValue = cell.p95 != null
                  const t = hasValue && maxP95 > 0 ? cell.p95 / maxP95 : 0
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
                        title={`${s} · ${a} — p95 ${hasValue ? formatDurationMs(cell.p95) : 'n/a'} · ${cell.count} action${cell.count === 1 ? '' : 's'}`}
                      >
                        {hasValue ? formatDurationMs(cell.p95) : '—'}
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
