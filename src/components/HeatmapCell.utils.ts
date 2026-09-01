// Static, universal thresholds as per user (Superpowers plan).
// Used by any dataset without hard-coding.

export const anomalyThresholds = Object.freeze({
  green: 0,
  yellow: 1,
  red: 2,
} as const);

export type AnomalyBand = keyof typeof anomalyThresholds;

export const classifyAnomalyCount = (
  count: number,
): AnomalyBand =>
  count < anomalyThresholds.yellow
    ? 'green'
    : count >= anomalyThresholds.red
      ? 'red'
      : 'yellow';
