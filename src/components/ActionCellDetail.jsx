import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { List } from '@ui5/webcomponents-react/List'
import { ListItemCustom } from '@ui5/webcomponents-react/ListItemCustom'
import { ObjectStatus } from '@ui5/webcomponents-react/ObjectStatus'
import { Tag } from '@ui5/webcomponents-react/Tag'
import ActionWaterfallPanel from './ActionWaterfallPanel'
import { durationTier } from '../lib/durationBands'
import { formatCsvTime, formatDurationMs } from '../lib/format'
import { objectStatusStateForDurationTier, tagDesignForAnomalyTier } from '../lib/sapStatus'
import './ActionCellDetail.css'

/**
 * ActionCellDetail — the drill-down beneath the Story × Action heatmap. Opens
 * when a grid cell is clicked and shows that story×action's action instances:
 *   - LEFT: the instances (slowest first) as a pickable list — duration, user,
 *     timestamp, and any anomaly tier badges.
 *   - RIGHT: the selected instance's Offset/Backend/Network/Render waterfall,
 *     reusing ActionWaterfallPanel (single-action mode hides its own picker).
 *
 * Props:
 *   story, action  the selected cell's labels
 *   cell           { p95, count, instances } from the matrix
 *   rows, headers   session-scoped raw CSV rows + headers (for the waterfall)
 *   byActionKey    Map<"name::ts", flags[]> from detectAnomalies
 *   tierByType     Map<typeKey, 1|2|3> from rankAnomalyTiers
 *   onClose()      collapse the panel (deselect the cell)
 */
function ActionCellDetail({ story, action, cell, rows, headers, byActionKey, tierByType, onClose }) {
  // Instances slowest-first — mirrors the reference layout (biggest durations
  // at the top of the list).
  const instances = useMemo(() => {
    const list = [...(cell?.instances ?? [])]
    list.sort((a, b) => num(b.action_duration) - num(a.action_duration))
    return list
  }, [cell])

  // The picked instance. Reset to the slowest whenever the cell changes.
  const [selectedIdx, setSelectedIdx] = useState(0)
  useEffect(() => {
    setSelectedIdx(0)
  }, [story, action])

  const selected = instances[selectedIdx] ?? instances[0] ?? null
  const selectedTs = selected?._action_timestamp ?? ''
  const selectedKey = `${action}::${selectedTs}`

  // Single-action list for the waterfall panel — its picker hides at length 1,
  // so the left list below IS the instance picker.
  const waterfallActions = useMemo(
    () => (selected ? [{ name: action, timestamp: selectedTs, label: `${action}` }] : []),
    [action, selectedTs, selected],
  )

  const flagsFor = (inst) => byActionKey?.get(`${action}::${inst?._action_timestamp ?? ''}`) ?? []

  return (
    <section className="cell-detail" aria-label="Action detail">
      <header className="cell-detail__header">
        <div className="cell-detail__title">
          <span className="cell-detail__title-label">Action detail</span>
          <span className="cell-detail__title-crumb" title={`${story} / ${action}`}>
            {story} / {action}
          </span>
        </div>
        <button
          type="button"
          className="cell-detail__close"
          onClick={onClose}
          aria-label="Close action detail"
          title="Close"
        >
          <X size={16} />
        </button>
      </header>

      <div className="cell-detail__body">
        <List
          className="cell-detail__list"
          selectionMode="SingleEnd"
          separators="Inner"
          accessibleName="Action instances"
        >
          {instances.map((inst, i) => {
            const tiers = distinctTiers(flagsFor(inst), tierByType)
            const tier = durationTier(inst.action_duration)
            return (
              <ListItemCustom
                key={`${inst._action_timestamp ?? ''}-${i}`}
                type="Active"
                selected={i === selectedIdx}
                onClick={() => setSelectedIdx(i)}
              >
                <div className="cell-detail__row">
                  <ObjectStatus large state={objectStatusStateForDurationTier(tier)}>
                    {formatDurationMs(inst.action_duration) || '—'}
                  </ObjectStatus>
                  <div className="cell-detail__meta">
                    <span className="cell-detail__user">{inst.user || '—'}</span>
                    <span className="cell-detail__ts">{formatCsvTime(inst._action_timestamp)}</span>
                  </div>
                  {tiers.length > 0 && (
                    <div className="cell-detail__badges">
                      {tiers.map((t) => (
                        <Tag key={t} design={tagDesignForAnomalyTier(t)}>{`T${t}`}</Tag>
                      ))}
                    </div>
                  )}
                </div>
              </ListItemCustom>
            )
          })}
        </List>

        <div className="cell-detail__waterfall">
          {selected ? (
            <ActionWaterfallPanel
              open
              onClose={onClose}
              rows={rows}
              headers={headers}
              actions={waterfallActions}
              initialKey={selectedKey}
            />
          ) : (
            <div className="cell-detail__empty">No action instances to show.</div>
          )}
        </div>
      </div>
    </section>
  )
}

/* ——— helpers ——— */

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : -Infinity
}

// The distinct anomaly tiers (1|2|3) present among an instance's flags, sorted,
// so a badge run reads T1 · T2 without repeating a tier several flags share.
function distinctTiers(flags, tierByType) {
  const set = new Set()
  for (const f of flags) {
    const t = tierByType?.get(f.type)
    if (t === 1 || t === 2 || t === 3) set.add(t)
  }
  return Array.from(set).sort((a, b) => a - b)
}

export default ActionCellDetail
