/**
 * Small mappings from this app's internal severity tiers to SAP UI5 component
 * props, kept pure + separate so they can be unit-tested and reused.
 */

// Duration health tier (from durationBands.durationTier) → ObjectStatus `state`.
export function objectStatusStateForDurationTier(tier) {
  switch (tier) {
    case 'good':
      return 'Positive'
    case 'neutral':
    case 'watch':
    case 'warn':
      return 'Critical'
    case 'bad':
      return 'Negative'
    default:
      return 'None'
  }
}

// Anomaly rank tier (1 loudest … 3 quietest) → Tag `design`.
export function tagDesignForAnomalyTier(tier) {
  switch (tier) {
    case 1:
      return 'Negative'
    case 2:
      return 'Critical'
    case 3:
      return 'Information'
    default:
      return 'Neutral'
  }
}
