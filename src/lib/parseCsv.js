import Papa from 'papaparse'

/**
 * Parse a CSV File into a tidy { headers, rows } shape.
 *
 * Parsing runs in a Web Worker and streams the File in chunks
 * (`worker: true` + `chunk`), so:
 *   - the whole file is never held in memory as one string (Papa reads it in
 *     slices) — no giant readAsText copy and no second normalized copy, and
 *   - the CPU-heavy parse happens off the main thread, so the UI stays
 *     responsive and we can report progress instead of freezing the tab.
 *
 * Config notes:
 * - `header: true` — first line becomes object keys. Papa strips a leading
 *   BOM off header names itself (stripBom), so `﻿BROWSERSESSION_ID` is cleaned
 *   even though we can't pass a `transformHeader` function to a worker
 *   (functions can't be structured-cloned across the worker boundary).
 * - `skipEmptyLines: 'greedy'` — drops blank lines and delimiter-only lines.
 * - `dynamicTyping: true` — coerces numerics/booleans where unambiguous.
 * - `delimitersToGuess` — lets Papa pick comma/tab/semicolon/pipe (raw SAP
 *   exports are often tab-delimited despite the .csv extension).
 * - `newline: '\n'` — pin the record delimiter to `\n`. Some SAP exports have
 *   MIXED CRLF/LF endings (first N lines CRLF, remainder LF); Papa's
 *   auto-detect would lock onto `\r\n` and then merge every later LF-only row
 *   into the previous record (silent row loss). Forcing `\n` makes every row
 *   split correctly regardless of ending. The only side effect is a trailing
 *   `\r` on the LAST column of CRLF rows, which we strip in the chunk handler
 *   (a cheap in-place fix — no full-array copy).
 *
 * @param {File} file
 * @param {{ onProgress?: (fraction: number) => void }} [opts]
 * @returns {Promise<{ headers: string[], rows: object[] }>}
 * Rejects with an Error whose `.parseErrors` holds Papa's diagnostics if the
 * file produced no rows at all.
 */
export function parseCsvFile(file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const rows = []
    let headers = []
    // Header-normalization state, computed once from the header row. We clean
    // header names ourselves — strip a leading BOM, drop a trailing `\r` (see
    // the `newline: '\n'` note), and trim surrounding whitespace — then re-home
    // any changed column onto its clean key IN PLACE per row (rename, not
    // clone), so a clean-header file costs nothing.
    let renames = []
    let firstError = null
    let errorCount = 0
    const totalBytes = file?.size || 0

    const cleanName = (h) =>
      String(h).replace(/^﻿/, '').replace(/\r$/, '').trim()

    Papa.parse(file, {
      // Stream the File in chunks on the MAIN thread. We intentionally do NOT
      // use `worker: true`: PapaParse's worker runs from a `blob:` URL that a
      // deployment's Content-Security-Policy can block, and Papa attaches no
      // error handler to that worker — so a blocked worker hangs forever at
      // "Parsing… 0%" instead of failing (seen on the Cloud Foundry PROD
      // deploy). Chunk streaming still reads the file in slices (no whole-file
      // string copy) and yields between chunks to keep the UI responsive, and
      // it works regardless of CSP.
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: true,
      delimitersToGuess: [',', '\t', ';', '|'],
      newline: '\n',
      chunkSize: 5 * 1024 * 1024,
      chunk: (results) => {
        const errors = results.errors
        if (errors && errors.length) {
          errorCount += errors.length
          if (!firstError) firstError = errors[0]
        }

        // Capture + normalize headers once, from the first chunk that has them.
        if (headers.length === 0 && results.meta?.fields) {
          const fields = results.meta.fields.filter(Boolean)
          headers = fields.map(cleanName)
          renames = []
          for (let i = 0; i < fields.length; i++) {
            if (fields[i] !== headers[i]) {
              renames.push([fields[i], headers[i]])
            }
          }
        }

        const data = results.data || []
        if (renames.length) {
          for (let i = 0; i < data.length; i++) {
            const row = data[i]
            for (let j = 0; j < renames.length; j++) {
              const raw = renames[j][0]
              const clean = renames[j][1]
              const v = row[raw]
              // Only the last column can carry a trailing `\r` (it sits before
              // the `\n`); strip it from string values, then drop the raw key.
              row[clean] = typeof v === 'string' && v.endsWith('\r') ? v.slice(0, -1) : v
              delete row[raw]
            }
          }
        }

        for (let i = 0; i < data.length; i++) rows.push(data[i])

        if (onProgress && totalBytes) {
          const cursor = results.meta?.cursor || 0
          onProgress(Math.min(1, cursor / totalBytes))
        }
      },
      complete: () => {
        if (rows.length === 0 && firstError) {
          const err = new Error(
            `CSV produced no rows; first parser error: ${firstError.message}`
          )
          err.parseErrors = [firstError]
          reject(err)
          return
        }
        if (errorCount > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[parseCsv] Parsed ${rows.length} rows with ${errorCount} parser warning(s). First error:`,
            firstError
          )
        }
        if (onProgress) onProgress(1)
        resolve({ headers, rows })
      },
      error: (err) => reject(err),
    })
  })
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
