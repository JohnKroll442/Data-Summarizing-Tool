import { describe, test, expect } from 'vitest';
import { buildHeatmapOption } from '../options/heatmap.js';

describe('buildHeatmapOption – TIME_SERIES mode', () => {
  const rows = [
    { date: '2026-09-01', supplier: 'A', anomalies: 0 },
    { date: '2026-09-02', supplier: 'A', anomalies: 1 },
    { date: '2026-09-01', supplier: 'B', anomalies: 2 },
    { date: '2026-09-02', supplier: 'B', anomalies: 3 },
  ];

  test('flips axes under mode=TIME_SERIES without changing color buffer', () => {
    const opt = buildHeatmapOption(rows, {
      xKey: 'supplier',
      yKey: 'date',
      valueKey: 'anomalies',
      mode: 'TIME_SERIES',
    });
    expect(opt.xAxis.data).toEqual(['2026-09-01', '2026-09-02']);
    expect(opt.yAxis.data).toEqual(['A', 'B']);
  });

  test('schematic test guards against future regressions – original STORY_ACTION still works', () => {
    const classic = buildHeatmapOption(rows, {
      xKey: 'supplier',
      yKey: 'date',
      valueKey: 'anomalies',
      mode: 'STORY_ACTION',
    });
    expect(classic.xAxis.data).toEqual(['A', 'B']);
    expect(classic.yAxis.data).toEqual(['2026-09-01', '2026-09-02']);
  });
});
