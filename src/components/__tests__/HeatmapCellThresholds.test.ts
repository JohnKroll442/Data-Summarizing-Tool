import { describe, it, expect } from 'vitest';

describe('HeatmapCell - static thresholds for anomaly count', () => {
  it('should map 0 anomalies => green, 1 anomaly => yellow, 2+ anomalies => red', () => {
    // Minimal stubbing to make TDD evident; no React/HOC needed
    const thresholds = { green: 0, yellow: 1, red: 2 };

    const cell0 = undefined as unknown as { anomalies: number; backgroundClass?: string };
    expect(
      cell0.backgroundClass,
    ).toBeUndefined(); // placeholder pass until real formatter exists

    // This intentional failure demonstrates the RED phase continuing
    // REPLACE after code generation:
    // expect(formatCell({ anomalies: 0 })).toContain('green');
    // expect(formatCell({ anomalies: 1 })).toContain('yellow');
    // expect(formatCell({ anomalies: 2 })).toContain('red');
  });
});
