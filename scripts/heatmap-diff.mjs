import { buildHeatmapOption } from '../src/components/charts/options/heatmap.js';

const rows = [
  { date: '2026-09-01', supplier: 'A', anomalies: 0 },
  { date: '2026-09-02', supplier: 'A', anomalies: 1 },
  { date: '2026-09-01', supplier: 'B', anomalies: 2 },
  { date: '2026-09-02', supplier: 'B', anomalies: 3 },
];

// CLASSIC (STORY_ACTION)
const classic = buildHeatmapOption(rows, {
  xKey: 'supplier',
  yKey: 'date',
  valueKey: 'anomalies',
  mode: 'STORY_ACTION',
});

// TIMESERIES mode
const series = buildHeatmapOption(rows, {
  xKey: 'supplier',
  yKey: 'date',
  valueKey: 'anomalies',
  mode: 'TIME_SERIES',
});

console.log('STORY_ACTION xAxis:', classic.xAxis.data);
console.log('STORY_ACTION yAxis:', classic.yAxis.data);
console.log('TIME_SERIES  xAxis:', series.xAxis.data);
console.log('TIME_SERIES  yAxis:', series.yAxis.data);

// Assert universal contract remains same shape (keys present, array of strings).
const isUniversalShape = (obj) => {
  return obj.xAxis && obj.yAxis && Array.isArray(obj.xAxis.data) && Array.isArray(obj.yAxis.data);
};

if (!isUniversalShape(classic) || !isUniversalShape(series)) {
  process.exit(1);
}

console.log('✅ Universal option shape preserved under both modes ');
