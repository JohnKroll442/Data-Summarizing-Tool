import { useRef, useState } from 'react'
import { Popover } from '@ui5/webcomponents-react/Popover'
import { Text } from '@ui5/webcomponents-react/Text'
import { formatCsvTime } from '../lib/format'
import './PhaseHoverCell.css'

/**
 * PhaseHoverCell — a duration cell that reveals its phase's start / end
 * timestamps in a small UI5 Popover on hover. Used by the Widget view for the
 * Render / Network / Backend columns after the dedicated start/end COLUMNS were
 * removed: the timings now live behind a hover instead of eating table width.
 *
 * `children` is the already-formatted duration text; `label` names the phase
 * ("Render"); `start` / `end` are the raw CSV timestamp values (formatted here
 * via formatCsvTime, shown as "—" when absent). The Popover is only mounted
 * while hovering, so a page full of rows doesn't carry hundreds of idle popups.
 */
function PhaseHoverCell({ label, start, end, children }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  const startText = formatCsvTime(start) || '—'
  const endText = formatCsvTime(end) || '—'

  return (
    <>
      <span
        ref={ref}
        className="phase-hover-cell"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {children}
      </span>
      {open && ref.current && (
        <Popover
          open
          opener={ref.current}
          placement="Top"
          hideArrow={false}
          className="phase-hover-popover"
          onClose={() => setOpen(false)}
        >
          <div className="phase-hover-popover-body">
            <Text className="phase-hover-popover-title">{label}</Text>
            <div className="phase-hover-popover-row">
              <span className="phase-hover-popover-key">Start</span>
              <Text>{startText}</Text>
            </div>
            <div className="phase-hover-popover-row">
              <span className="phase-hover-popover-key">End</span>
              <Text>{endText}</Text>
            </div>
          </div>
        </Popover>
      )}
    </>
  )
}

export default PhaseHoverCell
