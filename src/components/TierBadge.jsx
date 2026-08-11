import { Tag } from '@ui5/webcomponents-react/Tag'
import './TierBadge.css'

// T1 = the most prevalent anomaly (loudest), T3 = the least. Map each rank to a
// UI5 Tag design so the pill's color tracks severity: T1 red, T2 amber, T3 blue.
const TIER_DESIGN = { 1: 'Negative', 2: 'Critical', 3: 'Information' }
const TIER_TITLE = {
  1: 'Tier 1 — highest share of flagged actions',
  2: 'Tier 2 — middle share of flagged actions',
  3: 'Tier 3 — lowest share of flagged actions',
}

/**
 * A mini oval rank badge (UI5 Tag) reading "T1" / "T2" / "T3". Sits to the LEFT
 * of an anomaly in the summary panel and to the left of an action name in the
 * table. `tier` is 1 | 2 | 3; anything else renders nothing so callers can drop
 * it in unconditionally.
 */
function TierBadge({ tier }) {
  if (tier !== 1 && tier !== 2 && tier !== 3) return null
  return (
    <Tag
      className="tier-badge"
      design={TIER_DESIGN[tier]}
      hideStateIcon
      title={TIER_TITLE[tier]}
    >
      {`T${tier}`}
    </Tag>
  )
}

export default TierBadge
