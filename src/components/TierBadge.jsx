import './TierBadge.css'

// T1 = the most prevalent anomaly (loudest), T3 = the least. Each rank keeps the
// familiar red → amber → blue severity ordering, but as a muted pill (see
// TierBadge.css) rather than UI5's bright semantic Tag colors, so the badge
// reads as a quiet rank marker instead of an alert.
const TIER_TITLE = {
  1: 'Tier 1 — highest share of flagged actions',
  2: 'Tier 2 — middle share of flagged actions',
  3: 'Tier 3 — lowest share of flagged actions',
}

/**
 * A mini oval rank badge reading "T1" / "T2" / "T3". Sits to the LEFT of an
 * anomaly in the summary panel and to the left of an action name in the table.
 * `tier` is 1 | 2 | 3; anything else renders nothing so callers can drop it in
 * unconditionally. `title` overrides the native tooltip — omit it for the
 * default tier description, or pass null to suppress it (e.g. when a richer
 * hover popover wraps the badge).
 */
function TierBadge({ tier, title }) {
  if (tier !== 1 && tier !== 2 && tier !== 3) return null
  const resolved = title === undefined ? TIER_TITLE[tier] : title
  return (
    <span className={`tier-badge tier-badge--t${tier}`} title={resolved ?? undefined}>
      {`T${tier}`}
    </span>
  )
}

export default TierBadge
