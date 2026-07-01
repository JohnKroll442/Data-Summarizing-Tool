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
