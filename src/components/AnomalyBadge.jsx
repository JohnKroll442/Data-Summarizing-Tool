import { useRef, useState } from 'react'
import { Popover } from '@ui5/webcomponents-react/Popover'
import { Text } from '@ui5/webcomponents-react/Text'
import { ANOMALY_TYPES } from '../lib/anomalyDetect'
import './AnomalyBadge.css'

const TYPE_BY_KEY = new Map(ANOMALY_TYPES.map((t) => [t.key, t]))

/**
 * A single anomaly marker with a hover Popover explaining it — a small dot in
 * the type's accent color (no emoji, so the table reads clean). `flag` is one
 * `{ type, value, detail }` from the detector; `detail` (the eyeball-verifiable
 * "X vs Y" string) shows in the popover.
 *
 * The Popover is only mounted while hovering (mirrors PhaseHoverCell), so a
 * table full of flagged rows doesn't carry hundreds of idle popups.
 */
function AnomalyBadge({ flag }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  const type = TYPE_BY_KEY.get(flag?.type)
  if (!type) return null

  return (
    <>
      <span
        ref={ref}
        className="anomaly-badge"
        style={{ backgroundColor: type.color }}
        role="img"
        aria-label={type.label}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      />
      {open && ref.current && (
        <Popover
          open
          opener={ref.current}
          placement="Top"
          className="anomaly-badge-popover"
          onClose={() => setOpen(false)}
        >
          <div className="anomaly-badge-popover-body">
            <Text className="anomaly-badge-popover-title">
              {type.label}
              {type.provisional && <span className="anomaly-badge-provisional">needs validation</span>}
            </Text>
            <Text className="anomaly-badge-popover-detail">{flag.detail || type.description}</Text>
          </div>
        </Popover>
      )}
    </>
  )
}

/**
 * Render every flag on an action as a row of badges, performance symbols first
 * (the detector already sorts flags in ANOMALY_TYPES order). Returns null when
 * there are no flags so the caller can drop it in unconditionally.
 */
export function AnomalyBadges({ flags }) {
  if (!flags?.length) return null
  return (
    <span className="anomaly-badges">
      {flags.map((f) => (
        <AnomalyBadge key={f.type} flag={f} />
      ))}
    </span>
  )
}

export default AnomalyBadge
