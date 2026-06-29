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
 *
 * Rejects with an Error whose `.parseErrors` holds Papa's per-row diagnostics
 * if any row failed to parse cleanly.
 */
export function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: true,
      transformHeader: (h) => String(h).replace(/^﻿/, '').trim(),
      delimitersToGuess: [',', '\t', ';', '|'],
      complete: (result) => {
        // Don't bail on parse-error warnings — many SAP exports trip
        // Papa's "TooFewFields" check on the last row without losing data.
        const headers = (result.meta?.fields ?? []).filter(Boolean)
        const rows = result.data ?? []
        if (rows.length === 0 && (result.errors?.length ?? 0) > 0) {
          const err = new Error(
            `CSV produced no rows; first parser error: ${result.errors[0].message}`
          )
          err.parseErrors = result.errors
          reject(err)
          return
        }
        resolve({ headers, rows })
      },
      error: (err) => reject(err),
    })
  })
}
