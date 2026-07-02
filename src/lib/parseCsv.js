import Papa from 'papaparse'

/**
 * Parse a CSV File into a tidy { headers, rows } shape.
 *
 * - `header: true` — first line becomes object keys
 * - `skipEmptyLines: 'greedy'` — drops blank trailing lines AND lines with
 *   only whitespace/delimiters
 * - `dynamicTyping: true` — coerces numerics/booleans where unambiguous
 * - `transformHeader` — trims whitespace and strips a leading BOM, so
 *   Excel/SAP exports don't end up with a `﻿BROWSERSESSION_ID` key
 * - `delimitersToGuess` — lets Papa pick from comma/tab/semicolon/pipe
 *   when the file isn't strictly comma-separated (raw SAP exports are
 *   often tab-delimited despite the .csv extension)
 * - Line endings are normalized to `\n` before parsing, and Papa's
 *   `newline` is pinned to match. Some SAP exports have mixed CRLF/LF
 *   line endings (first N lines CRLF, remainder LF), which makes Papa's
 *   auto-detect land on `\r\n` and then treat every LF-only row past
 *   the mixing point as a continuation of the previous record — data
 *   ends up in `__parsed_extra` and the row count silently caps out.
 *
 * Rejects with an Error whose `.parseErrors` holds Papa's per-row diagnostics
 * if any row failed to parse cleanly.
 */
export function parseCsvFile(file) {
  return readFileAsText(file).then(
    (raw) =>
      new Promise((resolve, reject) => {
        const text = raw.replace(/\r\n?/g, '\n')
        Papa.parse(text, {
          header: true,
          skipEmptyLines: 'greedy',
          dynamicTyping: true,
          transformHeader: (h) => String(h).replace(/^﻿/, '').trim(),
          delimitersToGuess: [',', '\t', ';', '|'],
          newline: '\n',
          complete: (result) => {
            // Don't bail on parse-error warnings — many SAP exports trip
            // Papa's "TooFewFields" check on the last row without losing data.
            const headers = (result.meta?.fields ?? []).filter(Boolean)
            const rows = result.data ?? []
            const errors = result.errors ?? []
            if (errors.length > 0) {
              // eslint-disable-next-line no-console
              console.warn(
                `[parseCsv] Parsed ${rows.length} rows with ${errors.length} parser warning(s). ` +
                  `Delimiter: ${JSON.stringify(result.meta?.delimiter)}, ` +
                  `newline: ${JSON.stringify(result.meta?.linebreak)}, ` +
                  `aborted: ${result.meta?.aborted}, truncated: ${result.meta?.truncated}. ` +
                  `First error:`,
                errors[0]
              )
            }
            if (rows.length === 0 && errors.length > 0) {
              const err = new Error(
                `CSV produced no rows; first parser error: ${errors[0].message}`
              )
              err.parseErrors = errors
              reject(err)
              return
            }
            resolve({ headers, rows })
          },
          error: (err) => reject(err),
        })
      })
  )
}

import { aggregateBySession } from './sessionAggregate'
import { aggregateByAction } from './actionAggregate'
import { aggregateByWidget } from './widgetAggregate'

// Each view's required fields expressed as (label shown to the user) → (key on
// the mapping object each aggregator returns). Validation runs the aggregator,
// then reports as "missing" any field whose mapping entry came back empty.
// This keeps the dialog aligned with what the aggregators can actually detect
// — no separate alias list to drift out of sync.
const VIEW_REQUIREMENTS = {
  'Session view': {
    aggregate: aggregateBySession,
    fields: [
      { label: 'SESSION_ID', key: 'session' },
      { label: 'USER_NAME',  key: 'user' },
      { label: 'STORY_NAME', key: 'story' },
      { label: 'DURATION',   key: 'duration' },
    ],
  },
  'Action view': {
    aggregate: aggregateByAction,
    fields: [
      { label: 'USER_ACTION',      key: 'actionName' },
      { label: 'ACTION_TIMESTAMP', key: 'actionTimestamp' },
      { label: 'WIDGET_ID',        key: 'widgetId' },
      { label: 'WIDGET_MEASURE',   key: 'measure' },
      { label: 'DURATION',         key: 'duration' },
      { label: 'USER_NAME',        key: 'user' },
    ],
  },
  'Widget view': {
    aggregate: aggregateByWidget,
    fields: [
      { label: 'WIDGET_ID',      key: 'widgetId' },
      { label: 'WIDGET_NAME',    key: 'widgetName' },
      { label: 'WIDGET_MEASURE', key: 'measure' },
      { label: 'DURATION',       key: 'duration' },
    ],
  },
}

export function validateSchema(headers, rows) {
  const availableSet = new Set()
  const missingSet = new Set()
  const affectedViews = []

  for (const [viewName, { aggregate, fields }] of Object.entries(VIEW_REQUIREMENTS)) {
    const { mapping } = aggregate(rows ?? [], headers ?? [])
    let viewMissing = 0
    for (const field of fields) {
      if (mapping?.[field.key]) {
        availableSet.add(field.label)
      } else {
        missingSet.add(field.label)
        viewMissing++
      }
    }
    if (viewMissing > 0) affectedViews.push(viewName)
  }

  return {
    available: Array.from(availableSet),
    missing: Array.from(missingSet),
    affectedViews,
    canProceed: availableSet.size > 0,
  }
}

// Read the File as UTF-8 text. Uses FileReader so we can normalize line
// endings before parsing — Papa's own `File` input path skips this step.
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
