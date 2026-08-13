import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { List } from '@ui5/webcomponents-react/List'
import { ListItemCustom } from '@ui5/webcomponents-react/ListItemCustom'
import { ObjectStatus } from '@ui5/webcomponents-react/ObjectStatus'
import { Popover } from '@ui5/webcomponents-react/Popover'
import { Text } from '@ui5/webcomponents-react/Text'
import ActionWaterfallPanel from './ActionWaterfallPanel'
import TierBadge from './TierBadge'
import { ANOMALY_TYPES } from '../lib/anomalyDetect'
import { durationTier } from '../lib/durationBands'
import { formatCsvTime, formatDurationMs } from '../lib/format'
import { objectStatusStateForDurationTier } from '../lib/sapStatus'
import './ActionCellDetail.css'

// Anomaly metadata by key, for turning an instance's flags into readable
// label + description in the tier badge's hover popover.
const TYPE_BY_KEY = new Map(ANOMALY_TYPES.map((t) => [t.key, t]))

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
function ActionCellDetail({ story, action, cell, rows, headers, byActionKey, tierByType, onClose, detailRef }) {
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
    () =>
      selected
        ? [
            {
              name: action,
              timestamp: selectedTs,
              label: `${action}`,
              story,
              user: selected.user,
              durationMs: selected.action_duration,
            },
          ]
        : [],
    [action, selectedTs, selected, story],
  )

  const flagsFor = (inst) => byActionKey?.get(`${action}::${inst?._action_timestamp ?? ''}`) ?? []

  return (
    <section className="cell-detail" aria-label="Action detail" ref={detailRef}>
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
            const flags = flagsFor(inst)
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
                  <InstanceTierBadge action={action} flags={flags} tierByType={tierByType} />
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
              meta={{
                actionName: action,
                story,
                user: selected?.user,
                timestamp: selectedTs,
                durationMs: selected?.action_duration,
              }}
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

/* ——— tier badge with hover detail ——— */

// The most-severe anomaly tier (1|2|3) among an instance's flags — the lowest
// (loudest) rank, mirroring the data table's rowTier. null → no ranked flag,
// so no badge shows (exactly like a table row with no ranked anomaly).
function mostSevereTier(flags, tierByType) {
  if (!tierByType || tierByType.size === 0 || !flags?.length) return null
  let best = null
  for (const f of flags) {
    const t = tierByType.get(f.type)
    if (t === 1 || t === 2 || t === 3) best = best == null ? t : Math.min(best, t)
  }
  return best
}

// A single TierBadge — the exact muted pill the data table uses — with a hover
// Popover that names the action and lists THIS instance's anomalies (type +
// detail). The T1/T2/T3 rank re-ranks per view, so the badge alone is
// ambiguous; the popover shows the concrete errors behind it. The Popover
// mounts only while hovering (like AnomalyBadge / PhaseHoverCell) so a long
// instance list doesn't carry a popup per row. `title={null}` suppresses
// TierBadge's own native tooltip so it doesn't collide with the popover.
function InstanceTierBadge({ action, flags, tierByType }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  const tier = mostSevereTier(flags, tierByType)
  if (tier == null) return null
  const anomalies = (flags ?? [])
    .map((f) => ({ flag: f, type: TYPE_BY_KEY.get(f.type) }))
    .filter((a) => a.type)
  return (
    <span
      ref={ref}
      className="cell-detail__tier"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <TierBadge tier={tier} title={null} />
      {open && ref.current && (
        <Popover
          open
          opener={ref.current}
          placement="Top"
          className="cell-detail__tier-popover"
          onClose={() => setOpen(false)}
          preventInitialFocus
          preventFocusRestore
        >
          <div className="cell-detail__tier-pop">
            <Text className="cell-detail__tier-pop-action" title={action}>
              {action}
            </Text>
            <ul className="cell-detail__tier-pop-list">
              {anomalies.map(({ flag, type }) => (
                <li key={flag.type} className="cell-detail__tier-pop-item">
                  <span className="cell-detail__tier-pop-label">{type.label}</span>
                  <span className="cell-detail__tier-pop-detail">
                    {flag.detail || type.description}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Popover>
      )}
    </span>
  )
}

export default ActionCellDetail
