# Activity Timeline Enhancement Plan
## Migrate Time-Of-Day Trend Features into Activity Timeline

## Overview
This plan outlines migrating key visualization features from the Time-Of-Day Trend panel into the Activity Timeline for a unified user experience. The Activity Timeline should incorporate:
1. **x-axis time labels** (currently in Time-Of-Day trend)
2. **Left y-axis: Duration** (currently in Time-Of-Day trend)
3. **Secondary y-axis: Action counts** (new placement, currently hidden on right side of trend)
4. **p50/p90 percentile lines + legends** (currently in trend chart)
5. **Click interactions** to filter table by clicked action

## Current State Analysis

### Time-Of-Day Trend Components
- X-axis: Time bucket labels (minute/hour/day/week/month granularity)
- Left Y-axis: Duration scale (0ms to max duration)
- Secondary Y-axis: Action count scale (0 to max actions) - **REMOVED IN PREV ACTIVITY**
- Series: p50 line, p90 line, spread area
- Click action: Filter to specific time bucket
- Legend: Actions, p50, p90, Spread
- Tooltip: Shows p50, p90, ratio, action count for hovered bucket

### Activity Timeline Current Components
- X-axis: Action instances positioned along timeline
- Left Y-axis: Action name labels (vertical text)
- BARS: Horizontal action bars showing duration
- Legend/Stats: Action count summary

## Migration Plan

### Phase 1: Analysis & Infrastructure Prep
- [ ] Understand ActivityTimeline component structure
- [ ] Verify data sources in ActivityTimeline (/lib/activityTimeline.js and components)
- [ ] Ensure action duration values available per instance
- [ ] Check compatibility with drill-down filtering
- [ ] Review existing activity table filtering logic

### Phase 2: Feature Migration - Primary Changes

#### 1. X-Axis → Time Labels Integration
**Location:** ActivityTimeline component and chart options
**Changes:**
- Add time-based x-axis instead of simple sequential x-axis
- Implement bucket logic matching timeOfDayTrend buckets
- Format labels: "HH:mm" or "MM/DD HH:mm" based on span
- Add clean time grid lines aligned with buckets

**Files to modify:**
- `src/components/ActivityTimeline.jsx` - Add time x-axis configuration
- `src/lib/activityTimeline.js` - Update data preparation if needed
- `src/components/charts/options/activityTimeline.js` - Update chart config

#### 2. Left Y-Axis: Duration Scale Integration
**Location:** ActivityTimeline chart options
**Changes:**
- Add second y-axis (primary) for duration metrics
- Configure format: convert ms → "HH:mm:ss.SSS"
- Set granular tick marks at: 1s, 2s, 5s, 10s, 20s, 30s, 40s, 1m
- Match Time-Of-Day trend scale settings
- Apply SAP design token colors

**Implementation:**
```js
yAxis: [
  {
    id: 'duration',
    type: 'value',
    name: 'Duration',
    nameLocation: 'middle',
    nameGap: 52,
    min: 0,
    axisLabel: { 
      formatter: (v) => formatDuration(v),
      color: SAP_TEXT_MUTED, 
      fontSize: chartFontSizes().axis
    },
    splitLine: { lineStyle: { color: '#e6ecf2' } }
  }
]
```

#### 3. Secondary Y-Axis: Action Count Labels
**Location:** ActivityTimeline chart options
**Changes:**
- Add third y-axis (opposite side) for action counts
- Position on right side
- Remove "Actions" name label to save space
- Keep tick marks for 5/10/15... label density
- Match existing inactive color: SAP_TEXT_MUTED
- Set tiny font size (11px) to minimize clutter

**Implementation:**
```js
yAxis: [
  { /* duration axis */ },
  { /* action name labels (horizontal text) - existing left axis */ },
  {
    type: 'value',
    position: 'right',
    min: 0,
    axisLabel: { 
      color: SAP_TEXT_MUTED, 
      fontSize: 11,
      showMinLabel: false,
      showMaxLabel: false
    },
    axisLine: { show: false },
    splitLine: { show: false }
  }
]
```

#### 4. p50 and p90 Percentile Integration
**Location:** ActivityTimeline chart options/series
**Changes:**
- Remove separate action bars (horizontal rows)
- Replace with vertical action duration bars per timestamp
- Add p50 horizontal line overlay
- Add p90 horizontal line overlay
- Create vertical line tick marks for each action instance
- Legend: p50, p90 labels + color swatches

**Implementation:**
```js
series: [
  {
    name: 'p50',
    type: 'line',
    data: timeBuckets.map(b => ({time: b.timestamp, value: b.p50})),
    color: SAP_BLUE,
    lineStyle: { width: 2 },
    symbol: 'none',
    smooth: false
  },
  {
    name: 'p90',
    type: 'line',
    data: timeBuckets.map(b => ({time: b.timestamp, value: b.p90})),
    color: SAP_GOLD,
    lineStyle: { width: 2 },
    symbol: 'none',
    smooth: false
  },
  {
    // Filterable action bars - per instance duration
    type: 'bar',
    barWidth: 6,
    itemStyle: { color: SAP_BLUE_LIGHT },
    data: rawActions.map(a => ({ time: a.timestamp, value: a.duration, action: a.name })),
    markArea: {...hitAreas} // Enable clicks on individual bars
  }
]
```

### Phase 3: Click Interaction Integration

#### Click-to-Filter Actions Implementation
**Location:** ActivityTimeline panel component
**Changes:**
1. Add click handler to chart
2. Capture click positional data
3. Translate to nearest action bar
4. Extract action name from clicked data
5. Filter activity table by:
   - action_name = clicked action
   - timestamp range = clicked bar's timestamp area

**Implementation:**
```jsx
// In ActivityTimeline.jsx
const onEvents = useMemo(() => ({
  click: (params) => {
    if (params.componentType === 'markArea' || params.seriesName === 'Action bars') {
      const actionName = params.data.action || params.name;
      applyActionFilter({ action: actionName });
    }
  }
}), []);

return (
  <EChartCard options={{...options, onEvents}} />
);
```

### Phase 4: Timeline Logic Changes

1. **Data Transformation:**
- Group raw actions into time buckets (same logic as timeOfDayTrend)
- Calculate p50 and p90 from aggregated buckets
- Keep instance list for scatter/click interactions

2. **Key Integration Points:**
- `src/lib/activityTimeline.js` - `buildActivityTrend()` method
- `src/components/charts/options/activityTimeline.js` - Chart options builder
- ActivityTimeline chart interaction handlers

**Updated Data Flow:**
```
Input: raw action instances (storyName, actionName, duration, timestamp)
→ Group by time bucket (minute/hour granularity matching trend)
→ For each bucket: calculate p50, p90 per action
→ Store bucket timestamp + aggregated stats
```

### Phase 5: UI/UX Integration

- Remove "Time-Of-Day Trend" tab from ActionView
- Update tab navigation in ActionView to include "Activity Timeline" only
- Remove old TimeOfDayPanel component usage
- Update summary stats display: "2047 actions - p50/p90 per hour"
- Ensure tooltip remains informative with all tracked metrics

### Phase 6: Testing & Validation

**Unit Tests:**
- Verify p50/p90 calculations match timeOfDayTrend
- Test click interaction directs to correct action filter
- Validate axis scaling and label positioning
- Confirm color tokens match SAP design system

**Integration:**
- Activity table receives correct filter from clicked actions
- Duration axis auto-scales with min/max of visible data
- Legend correctly toggles lines/bars
- Responsive design adapts to different screen sizes

### Phase 7: Implementation Priority Order

1. **Week 1:** Infrastructure - data grouping similar to timeOfDayTrend
2. **Week 2:** Chart axes - add duration + count axes, remove old action bars
3. **Week 3:** Lines - integrate p50/p90 lines with proper scaling
4. **Week 4:** Interaction - click handlers + table filtering
5. **Week 5:** UI integration - tab removal, summary updates
6. **Week 6:** Testing + bug fixes

### Technical Dependencies

1. **Chart Library:** ECharts (must support custom axes and markAreas)
2. **Data Format:** Consistent with existing CSV headers (_action_timestamp, action_duration, action_name, story_name)
3. **Action Table:** `useCsvData()` context + `applyActionFilter()` function
4. **Design Tokens:** Import from `src/lib/chartColors.js` for SA colors

### Risk Mitigation

**Risk:** Chart performance degradation from dense action bars
**Mitigation:** 
- Implement time bucket aggregation (like trend uses)
- Virtual scrolling or progressive loading for >1000 instances
- Debounced re-rendering

**Risk:** Click accuracy on dense bars
**Mitigation:**
- Use markArea with full-height click targets
- Apply overscaling buffer + z-index priority

**Risk:** Timeline vs Trend duplicate workload
**Mitigation:** Reuse existing bucketing logic from `buildTimeOfDayTrend()`


### Success Criteria

- [ ] Action bars click → filter activity table correctly
- [ ] p50/p90 lines render with legends
- [ ] Left axis: duration scale in ms
- [ ] Right axis: action count ticks (minimal)
- [ ] Responsive on desktop/mobile
- [ ] Tab transition smooth (timeline replaces trend)
- [ ] All existing workflows preserved
- [ ] No breaking changes to data sources or APIs
- [ ] Matches design token specifications exactly

### Recommended Next Steps

1. Review `src/components/ActionTimeOfDayPanel.jsx` for implemented data structures
2. Compare with `src/lib/timeOfDayTrend.js` bucket logic
3. Map exact API used for click filtering in other panels (`onActionClick`)
4. Validate testing coverage for existing timeline component
5. Pin exact style tokens to replace hardcoded colors

### Timeline Implementation Details Reference

**Current Activity Timeline Structure:**
- Components: `ActivityTimelineView`, `ActivityDataTablePanel`
- Chart options: `src/components/charts/options/activityTimeline.js`
- Data: Aggregated per action_name currently
- X-axis: Index-based positioning (0 to N)
- Y-axis: Horizontal action list text labels

**Required Changes:**
- Convert x-axis → time-based
- Add yAxis[0]: duration scale
- Add yAxis[2]: right-side action count ticks
- Replace data series with aggregated buckets + lines
- Add markArea click targets on action instances