import Papa from 'papaparse'

/**
 * Parse a CSV File into a tidy { headers, rows } shape.
 *
 * - `header: true` — first line becomes object keys
 * - `skipEmptyLines: true` — drops blank trailing lines
 * - `dynamicTyping: true` — coerces numerics/booleans where unambiguous
 *
 * Rejects with an Error whose `.parseErrors` holds Papa's per-row diagnostics
 * if any row failed to parse cleanly.
 */
export function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: (result) => {
        if (result.errors && result.errors.length > 0) {
          const err = new Error(
            `CSV parsing produced ${result.errors.length} error(s); first: ${result.errors[0].message}`
          )
          err.parseErrors = result.errors
          reject(err)
          return
        }
        const headers = result.meta?.fields ?? []
        const rows = result.data ?? []
        resolve({ headers, rows })
      },
      error: (err) => reject(err),
    })
  })
}
