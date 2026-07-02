/**
 * Default chart selections seeded into each view on first data load, so
 * users see visualizations immediately instead of an empty "click Add
 * chart" state. Skipped for a view once the user has cleared its charts.
 *
 * Each default returns `{ typeId, config }` matching the chart-type registry.
 * Column resolution mirrors detectMapping in the *Aggregate helpers so
 * casing/underscore variants ("SESSION_ID" vs "session id") all resolve.
 */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_\-.]+/g, '')

function findHeader(headers, exacts, substrings = []) {
  const list = headers ?? []
  for (const h of list) {
    if (exacts.includes(norm(h))) return h
  }
  for (const h of list) {
    const n = norm(h)
    if (substrings.some((s) => n.includes(s))) return h
  }
  return null
}

function findSessionKey(headers) {
  return findHeader(
    headers,
    ['browsersessionid', 'sessionid'],
    ['sessionid'],
  )
}

function findUserKey(headers) {
  return findHeader(headers, ['username'], ['user'])
}

function findActionKey(headers) {
  return findHeader(headers, ['useraction', 'actionname'], ['action'])
}

function findWidgetIdKey(headers) {
  return findHeader(headers, ['widgetid'], ['widgetid'])
}

function findWidgetNameKey(headers) {
  return findHeader(headers, ['widgetname', 'widgettype'], ['widgetname', 'widgettype'])
}

function findDurationKey(headers) {
  return findHeader(headers, ['duration'], ['duration'])
}

function findMeasureKey(headers) {
  return findHeader(headers, ['widgetmeasure'], ['measure'])
}

function findTimestampKey(headers) {
  return findHeader(
    headers,
    ['actiontimestamp', 'widgetrendertimestamp', 'widgettimestamp'],
    ['timestamp', 'time'],
  )
}

export function buildDefaultCharts(viewId, rows, headers) {
  if (!rows || rows.length === 0 || !headers || headers.length === 0) return []

  if (viewId === 'session') return sessionDefaults(headers)
  if (viewId === 'action') return actionDefaults(headers)
  if (viewId === 'widget') return widgetDefaults(headers)
  return []
}

function sessionDefaults(headers) {
  const out = []
  const sessionKey = findSessionKey(headers)
  const userKey = findUserKey(headers)
  const durationKey = findDurationKey(headers)

  if (userKey && sessionKey) {
    out.push({
      typeId: 'bar',
      config: { xKey: userKey, yKey: '' },
    })
  }
  if (durationKey) {
    out.push({
      typeId: 'histogram',
      config: { key: durationKey, binCount: 12 },
    })
  }
  return out
}

function actionDefaults(headers) {
  const out = []
  const actionKey = findActionKey(headers)
  const durationKey = findDurationKey(headers)
  const measureKey = findMeasureKey(headers)

  if (actionKey) {
    out.push({
      typeId: 'bar',
      config: { xKey: actionKey, yKey: '' },
    })
  }
  if (measureKey && durationKey) {
    out.push({
      typeId: 'boxplot',
      config: { groupKey: measureKey, valueKey: durationKey },
    })
  } else if (durationKey) {
    out.push({
      typeId: 'histogram',
      config: { key: durationKey, binCount: 12 },
    })
  }
  return out
}

function widgetDefaults(headers) {
  const out = []
  const widgetIdKey = findWidgetIdKey(headers)
  const widgetNameKey = findWidgetNameKey(headers)
  const durationKey = findDurationKey(headers)
  const measureKey = findMeasureKey(headers)
  const timestampKey = findTimestampKey(headers)

  const groupKey = widgetNameKey || widgetIdKey
  if (groupKey && durationKey) {
    out.push({
      typeId: 'bar',
      config: { xKey: groupKey, yKey: durationKey },
    })
  }
  if (measureKey && durationKey) {
    out.push({
      typeId: 'boxplot',
      config: { groupKey: measureKey, valueKey: durationKey },
    })
  }
  if (timestampKey && durationKey) {
    out.push({
      typeId: 'timeSeries',
      config: { xKey: timestampKey, yKey: durationKey },
    })
  }
  return out
}
