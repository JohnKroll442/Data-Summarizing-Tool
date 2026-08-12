import { useRef, useState, useEffect } from 'react'
import { Info } from 'lucide-react'
import { Popover } from '@ui5/webcomponents-react/Popover'
import { Text } from '@ui5/webcomponents-react/Text'
import './AnomalyInfo.css'

/**
 * AnomalyInfo — a small ⓘ icon shown to the LEFT of the tier badge on each
 * anomaly row. Hovering the ICON (and only the icon) reveals a concise,
 * plain-language explanation in a UI5 Popover. The hover is scoped to this
 * element, so it's independent of the tier badge's tooltip and the anomaly name.
 *
 * Opening is immediate on mouse-enter; closing is deferred by a short grace
 * period so a quick pass over the icon, or moving the cursor from the icon onto
 * the popover, doesn't make it flicker shut. The popover keeps itself open while
 * hovered for the same reason. Opens to the side (placement="End") so it never
 * lands under the cursor.
 *
 * `title` is the anomaly's label; `text` is the concise explanation.
 */
function AnomalyInfo({ title, text }) {
  const ref = useRef(null)
  const closeTimer = useRef(null)
  const [open, setOpen] = useState(false)

  const show = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setOpen(true)
  }
  const hide = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }

  // Clear any pending close timer on unmount so it can't fire into a dead component.
  useEffect(() => () => closeTimer.current && clearTimeout(closeTimer.current), [])

  return (
    <>
      <span
        ref={ref}
        className="anomaly-info"
        aria-label={`What is "${title}"?`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={(e) => e.stopPropagation()}
      >
        <Info className="anomaly-info__icon" size={16} aria-hidden="true" />
      </span>
      {open && ref.current && (
        <Popover
          open
          opener={ref.current}
          placement="End"
          hideArrow={false}
          className="anomaly-info-popover"
          onClose={() => setOpen(false)}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <div className="anomaly-info-popover-body">
            <Text className="anomaly-info-popover-title">{title}</Text>
            <Text className="anomaly-info-popover-text">{text}</Text>
          </div>
        </Popover>
      )}
    </>
  )
}

export default AnomalyInfo
