import { useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { Popover } from '@ui5/webcomponents-react/Popover'
import { Text } from '@ui5/webcomponents-react/Text'
import './AnomalyInfo.css'

/**
 * AnomalyInfo — a small ⓘ icon shown to the LEFT of the tier badge on each
 * anomaly row. Hovering the ICON (and only the icon) reveals a concise,
 * plain-language explanation of what the anomaly means in a UI5 Popover. The
 * hover is scoped to this element, so it's fully independent of the tier badge's
 * own tooltip and the anomaly name next to it.
 *
 * `title` is the anomaly's label; `text` is the concise explanation. Opens to
 * the side (placement="End") so the popover never lands under the cursor.
 */
function AnomalyInfo({ title, text }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)

  return (
    <>
      <span
        ref={ref}
        className="anomaly-info"
        aria-label={`What is "${title}"?`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => e.stopPropagation()}
      >
        <Info className="anomaly-info__icon" size={14} aria-hidden="true" />
      </span>
      {open && ref.current && (
        <Popover
          open
          opener={ref.current}
          placement="End"
          hideArrow={false}
          className="anomaly-info-popover"
          onClose={() => setOpen(false)}
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
